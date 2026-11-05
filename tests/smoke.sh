#!/usr/bin/env bash
# Run the actual Swamp loader, CEL workflow validator and pure selection method.
# Uses the caller's existing Swamp login; never connects to a torrent daemon.
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
smoke_dir=$(mktemp -d)
trap 'rm -rf -- "$smoke_dir"' EXIT
cp "$repo_dir/.swamp.yaml" "$smoke_dir/.swamp.yaml"
cp -R "$repo_dir/extensions" "$repo_dir/workflows" "$smoke_dir/"
swamp help model create >/dev/null
swamp model create @funsaized/torlink torlink --repo-dir "$smoke_dir" --json
swamp help workflow validate >/dev/null
swamp workflow validate @funsaized/torlink-download --repo-dir "$smoke_dir" --json
swamp help model method run >/dev/null
swamp model method run torlink select --repo-dir "$smoke_dir" --stdin --json <<'JSON'
{"queries":[{"key":"fixture","query":"fixture","category":"all","ok":true,"count":1,"sources":{},"results":[{"infoHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"Fixture","source":"fixture","sizeBytes":1024,"seeders":1,"leechers":0,"magnet":"magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}],"sources":["fixture"],"minSeeders":1,"minSizeBytes":1,"maxSizeBytes":2048}
JSON
swamp help data query >/dev/null
swamp data query 'model("torlink") && name == "selection-current"' --repo-dir "$smoke_dir" --select content --json
