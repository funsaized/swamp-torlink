// Exercise the real Torlink router without starting WebTorrent or opening sockets.
import { pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = process.argv[2];
const { handleApi } = await import(
  pathToFileURL(join(root, "src/daemon/serve.ts")).href
);
const id = "a".repeat(40);
const items = new Map();
const history = [{ id, completedAt: 1000, seedTimeMs: 2000 }];
let network = {
  interface: null,
  address: null,
  online: true,
  peerPort: null,
  incoming: 0,
};
const added = [];
const queue = {
  has: (hash) => items.has(hash),
  add: (item) => {
    added.push(item);
    items.set(item.id, {
      ...item,
      status: "downloading",
      progress: 0,
      peers: 0,
      speed: 0,
    });
  },
  getItems: () => [...items.values()],
  getHistory: () => history,
  getSeeds:
    () => [{ id, name: "Fixture", status: "seeding", peers: 0, uploaded: 0 }],
  networkStatus: () => network,
  reconfigureNetwork: (patch) => {
    network = {
      ...network,
      interface: patch.interface ?? null,
      peerPort: patch.peerPort ?? null,
    };
    return { ok: true, status: network };
  },
  setSeedTime: (hash, ms) => {
    if (hash !== id) return false;
    history[0].seedTimeMs = ms;
    return true;
  },
};
const dir = await mkdtemp(join(tmpdir(), "torlink-contract-"));
const runtime = { queue, downloadDir: dir };
const responses = {};
async function request(key, method, path, body, token = "Bearer fixture") {
  responses[key] = await handleApi(
    runtime,
    "fixture",
    method,
    path,
    token,
    body === undefined ? "" : JSON.stringify(body),
  );
}
try {
  await request("health", "GET", "/health", undefined, undefined);
  await request("unauthorized", "GET", "/downloads", undefined, "Bearer wrong");
  await request("add", "POST", "/add", { magnet: id, seedTime: "30d" });
  await request("duplicate", "POST", "/add", { magnet: id });
  await request("base32", "POST", "/add", { magnet: "A".repeat(32) });
  const torrent = Buffer.from(
    "d4:infod6:lengthi1e4:name7:fixture12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaaee",
  ).toString("base64");
  await request("upload", "POST", "/add", { torrent, seedTime: 0 });
  await request("control", "POST", "/control", {
    id,
    action: "seed-time",
    seedTime: "2h",
  });
  await request("network", "GET", "/network");
  await request("configure", "POST", "/network", {
    interface: "wg0",
    peerPort: 51413,
    dhtPort: null,
  });
  await request("status", "GET", "/downloads");
  process.stdout.write(JSON.stringify({ responses, added, torrent }));
} finally {
  await rm(dir, { recursive: true, force: true });
}
