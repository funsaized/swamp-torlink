import { model } from "../extensions/models/torlink.ts";

Deno.test("wrapper accepts the real Torlink 1.10 router contract", async () => {
  const root = Deno.env.get("TORLINK_SOURCE");
  if (!root) {
    throw new Error("Set TORLINK_SOURCE to an installed Torlink 1.10 checkout");
  }
  const output = await new Deno.Command("node", {
    args: [
      "--import",
      `${root}/node_modules/tsx/dist/loader.mjs`,
      "tests/torlink-router.mts",
      root,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  const fixture = JSON.parse(new TextDecoder().decode(output.stdout));
  if (fixture.responses.unauthorized.status !== 401) {
    throw new Error("Auth contract changed");
  }
  if (fixture.added[0].seedTimeMs !== 30 * 86400000) {
    throw new Error("Seed duration contract changed");
  }
  const original = globalThis.fetch;
  let next = "add";
  globalThis.fetch = () => {
    const response = fixture.responses[next];
    return Promise.resolve(
      new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const writes: Array<{ name: string; data: Record<string, unknown> }> = [];
  const context = {
    signal: new AbortController().signal,
    globalArgs: model.globalArguments.parse({ token: "fixture" }),
    logger: { info() {}, warning() {} },
    readResource: () => Promise.resolve(null),
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      const resource = model.resources[spec as keyof typeof model.resources];
      resource.schema.parse(data);
      writes.push({ name, data });
      return Promise.resolve({ name });
    },
  };
  try {
    for (
      const [key, input] of [["add", "a".repeat(40)], [
        "duplicate",
        "a".repeat(40),
      ], ["base32", "A".repeat(32)]]
    ) {
      next = key;
      await model.methods.add.execute({ inputs: [{ key, input }] }, context);
    }
    next = "upload";
    await model.methods.add.execute({
      inputs: [{ key: "upload", torrent: fixture.torrent, seedTime: 0 }],
    }, context);
    next = "control";
    await model.methods.control.execute({
      ids: ["a".repeat(40)],
      action: "seed-time",
      seedTime: "2h",
      confirmDeleteFiles: false,
    }, context);
    next = "network";
    await model.methods.network.execute({}, context);
    next = "configure";
    await model.methods.configureNetwork.execute({
      interface: "wg0",
      peerPort: 51413,
      dhtPort: null,
    }, context);
    next = "status";
    await model.methods.sync.execute({}, context);
    const snapshot = writes.find((w) => w.name === "snapshot-current")!;
    if (!(snapshot.data.network as { online: boolean }).online) {
      throw new Error("Network state lost");
    }
    const torrent = (snapshot.data.torrents as Array<
      { infoHash: string; seedUntil?: number }
    >).find((t) => t.infoHash === "a".repeat(40));
    if (torrent?.seedUntil !== 7201000) throw new Error("Seed expiry lost");
  } finally {
    globalThis.fetch = original;
  }
});
