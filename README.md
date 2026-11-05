# `@funsaized/torlink`

Typed Swamp automation for Torlink: search, deterministic selection, additions,
state snapshots, waits, seeding policy and network configuration.

## Requirements

- Swamp `20261105.030003.0` or newer (tested runtime and read-method locking).
- Node.js 22 or newer for the local Torlink CLI.
- Torlink 1.x, at least 1.8.0 for basic search/download/control.
- Torlink 1.10.0+ for uploads, per-torrent seed time, network methods and search
  timeout/interface options. The contract suite targets 1.10.0.
- A running `torlnk serve` for HTTP methods. `search` runs locally,
  independently of that daemon. `select` only consumes supplied stored results.

## Install and configuration

```sh
swamp extension pull @funsaized/torlink
swamp model create @funsaized/torlink torlink
swamp model edit torlink
```

| Global argument       | Default                 | Purpose                                                                   |
| --------------------- | ----------------------- | ------------------------------------------------------------------------- |
| `binary`              | `torlnk`                | Local executable used for search and CLI health                           |
| `baseUrl`             | `http://127.0.0.1:9161` | Torlink HTTP API                                                          |
| `token`               | unset                   | Bearer credential; use `${{ vault.get("credentials", "torlink-token") }}` |
| `allowInsecureRemote` | `false`                 | Explicit exception for remote HTTP                                        |
| `concurrency`         | `4`                     | Maximum concurrent subprocesses/requests in each batch; range 1–16        |

Remote APIs require a token and HTTPS unless the HTTP exception is explicit.
Redirects are rejected. Tokens are sensitive and excluded from resources/logs.
Search-result magnets remain in search resources for downstream use; they may
contain private tracker details, so protect datastore access accordingly. Add
inputs and uploaded metadata are excluded from operation resources.

## Methods

| Method             | Inputs and behavior                                                                                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`           | Checks liveness, authenticated `/downloads` access, CLI availability and version compatibility independently. `strictVersions: true` requires equal versions. `requireCli: false` supports HTTP-only installations. Persists diagnostics before failing. |
| `search`           | `queries: [{key, query, category}]`; optional `timeoutSeconds` and `interface`. Retains successful queries and per-query errors if another query fails.                                                                                                  |
| `select`           | Takes stored `queries`, ordered `sources`, `minSeeders`, `minSizeBytes`, `maxSizeBytes`. Chooses highest seeders, then source priority, then ascending normalized info hash. Records policy and rationale; fails if any query has no eligible result.    |
| `add`              | `inputs: [{key, input, seedTime?}]` for magnets/hex/base32 hashes, or `{key, torrent, seedTime?}` for base64 `.torrent` bytes. Exactly one input form per item. Returns normalized `id` for both additions and duplicates.                               |
| `sync`             | Saves current downloads/seeds/network and marks torrents missing from the prior snapshot `absent`. Preserves per-torrent `seedTimeMs`/`seedUntil`.                                                                                                       |
| `wait`             | `ids`, `until: seeding\|seed-stopped\|absent`, `timeoutSeconds`, optional `pollSeconds` (30). Retains completed results on cancellation and stores last observed status.                                                                                 |
| `control`          | `ids`, `action`; supports pause, resume, start-seed, stop-seed, remove, delete and seed-time.                                                                                                                                                            |
| `network`          | Reads daemon interface binding and readiness.                                                                                                                                                                                                            |
| `configureNetwork` | Patches `interface`, `peerPort`, `dhtPort`. Omission keeps a setting; `null` clears it.                                                                                                                                                                  |

Batches accept at most 100 items. HTTP requests have a 30-second cap; waits
clamp that to their remaining deadline. CLI search has a process deadline five
seconds beyond its search timeout (45 seconds by default). No automatic mutation
retries occur: inspect operation results after an ambiguous transport failure.

`health`, `wait`, `network` and `select` declare read method kinds. On the
required Swamp runtime, waiting does not hold the behavior's mutation lock, so
`control` can run concurrently. `sync` retains serialization for reconciliation.

`remove` retains files. `delete` requires `confirmDeleteFiles: true`; removal of
an already absent ID succeeds. For `seed-time`, `seedTime` is required: integer
seconds or strings such as `"30d"`, `"2h"`, `"90m"`. `0` disables the limit;
`""` clears the override. Limits reported by Torlink are per-torrent overrides;
the daemon-wide default is not included in `seedTimeMs`/`seedUntil`.

```sh
swamp model method run torlink add \
  --input inputs:json='[{"key":"example","input":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","seedTime":"2h"}]'
swamp model method run torlink network
swamp model method run torlink search \
  --input queries:json='[{"key":"example","query":"Example","category":"movies"}]' \
  --input timeoutSeconds=30 --input interface=wg0
```

The search interface applies to the **local CLI**. A daemon configured through
`configureNetwork` may be on another host and does not configure local search.
`health.capabilities` is a conservative version-based declaration, not a probe
of every optional endpoint; backports are not inferred.

## Reference workflow

The package includes `torlink-download`, created with Swamp's workflow CLI:

```text
search → select → add → wait → sync
```

It uses the behavior named `torlink`. Configure that definition first, and
reserve it for this pipeline to avoid unrelated runs replacing its `*-current`
data. The workflow caps step concurrency at one; it does not provide a global
lock across separate workflow runs. `sync` runs after a completed wait,
including a failed wait, to retain final evidence. Selection stores IDs and
rationale; addition uses the selected ID, so this example uses Torlink's default
trackers. For private trackers, pass the corresponding stored search magnet
instead.

```sh
swamp workflow validate torlink-download
swamp workflow run torlink-download \
  --input query='Example' \
  --input sources:json='["yts"]' \
  --input maxSizeBytes=4000000000
```

Only download content you are authorized to download. A source/seeder/size
policy selects mechanically; it does not establish that a result is the intended
content.

## Data and recovery

| Resource    | Instance             | Lifetime / retained versions |
| ----------- | -------------------- | ---------------------------- |
| `instance`  | `instance-current`   | 1 hour / 24                  |
| `network`   | `network-current`    | 1 hour / 24                  |
| `search`    | `search-current`     | 30 days / 100                |
| `selection` | `selection-current`  | 30 days / 100                |
| `snapshot`  | `snapshot-current`   | 7 days / 100                 |
| `torrent`   | `torrent-<infoHash>` | infinite / 100               |
| `operation` | `operation-<method>` | 30 days / 100                |

```text
data.latest("torlink", "operation-add").attributes.results.map(r, r.id)
data.latest("torlink", "snapshot-current").attributes.torrents
```

Batch methods persist per-item outcomes before failing, including malformed
search responses. Retry only unsuccessful items using their stable caller keys.
A wait reports the state observed during its polls, not a guarantee that state
remains unchanged afterward. A failed HTTP health check stores diagnostics in
`instance-current`; invalid global URL configuration can fail before a write.

## Development

```sh
deno fmt --check extensions/models tests
deno lint extensions/models tests/*.ts
deno check extensions/models/torlink.ts extensions/models/torlink_test.ts tests/contract_test.ts
deno test --allow-run --allow-read --allow-write extensions/models/torlink_test.ts
TORLINK_SOURCE=/absolute/path/to/torlink deno test \
  --allow-run --allow-read --allow-write --allow-env=TORLINK_SOURCE tests/contract_test.ts
deno test --allow-net=127.0.0.1 tests/http_test.ts
bash tests/smoke.sh
```

Unit tests mock HTTP at the fetch boundary and need no listener permission. The
contract test requires an installed Torlink checkout (`npm ci`) and executes its
real API router with a fake queue; it opens no sockets or torrent transfers. CI
pins the Torlink source commit. The smoke script requires a Swamp login and
checks actual extension loading, workflow validation, selection execution and
stored output in a temporary repository. It does not contact a torrent daemon.
