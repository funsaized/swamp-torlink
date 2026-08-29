# `@funsaized/torlink`

A Swamp model for deterministic Torlink automation. It uses Torlink's headless
CLI for search and its loopback HTTP API for health, download state, additions,
waiting, and control.

## Requirements

- Swamp `20260825.172854.0` or newer.
- Node.js 22 or newer.
- A `torlnk` build containing the `search` command merged in
  [baairon/torlink#180](https://github.com/baairon/torlink/pull/180) at commit
  `8b1df42` or a later release.
- `torlnk serve` for methods other than CLI search.

Only download content you are authorized to download.

## Install

```sh
swamp extension pull @funsaized/torlink
swamp model create @funsaized/torlink torlink
swamp model edit torlink
```

Global arguments:

| Argument | Default | Purpose |
| --- | --- | --- |
| `binary` | `torlnk` | Torlink executable used by `health` and `search` |
| `baseUrl` | `http://localhost:9161` | Torlink serve API |
| `token` | unset | Bearer token required for non-loopback APIs; use a vault expression |
| `allowInsecureRemote` | `false` | Explicit exception for non-loopback HTTP |

Plain HTTP is rejected for non-loopback hosts unless
`allowInsecureRemote: true` is explicitly configured. Prefer HTTPS for every
remote API. Tokens are marked sensitive and are never written to model data or
logs.

## Methods

| Method | Purpose |
| --- | --- |
| `health` | Verify matching CLI and server versions |
| `search` | Batch headless searches with per-source outcomes |
| `add` | Batch magnets or info hashes through `/add` |
| `sync` | Snapshot downloads/seeds and mark disappeared torrents `absent` |
| `wait` | Poll multiple IDs for `seeding`, `seed-stopped`, or `absent` |
| `control` | Apply one action to multiple torrent IDs |

Batch inputs use caller-defined keys so results can be joined without storing
magnet values:

```sh
swamp model method run torlink search \
  --input queries:json='[{"key":"movie-1","query":"Example Movie 2026","category":"movies"}]'

swamp model method run torlink add \
  --input inputs:json='[{"key":"movie-1","input":"magnet:?xt=urn:btih:EXAMPLE"}]'
```

Control actions are `pause`, `resume`, `start-seed`, `stop-seed`, `remove`, and
`delete`. `remove` retains payload files. `delete` is rejected unless
`confirmDeleteFiles: true` is supplied.

## Data

| Resource | Instance | Lifetime |
| --- | --- | --- |
| `instance` | `instance-current` | 1 hour |
| `search` | `search-current` | 30 days |
| `snapshot` | `snapshot-current` | 7 days |
| `torrent` | `torrent-<infoHash>` | infinite |
| `operation` | `operation-<method>` | 30 days |

Reference current data with CEL, for example:

```text
data.latest("torlink", "snapshot-current").attributes.torrents
data.latest("torlink", "operation-search").attributes.ok
```

Expected per-item failures are persisted in the operation resource before the
method fails, allowing workflow recovery and reports to use structured evidence.
Bearer tokens and `add` inputs are not persisted. Search-result magnets remain
in `search-current` so downstream CEL expressions can pass a selected result to
`add` without repeating the search.

## Development

Use the Deno path reported by `swamp doctor extensions --json`:

```sh
deno fmt --check extensions/models/torlink.ts extensions/models/torlink_test.ts
deno lint extensions/models/torlink.ts extensions/models/torlink_test.ts
deno check extensions/models/torlink.ts extensions/models/torlink_test.ts
deno test --allow-run --allow-read --allow-write --allow-net=127.0.0.1 \
  extensions/models/torlink_test.ts
```
