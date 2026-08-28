/// <reference lib="deno.ns" />
import { model, testing } from "./torlink.ts";

const ID_A = "a".repeat(40);
const ID_B = "b".repeat(40);
const ID_C = "c".repeat(40);

type Resource = {
  specName: string;
  name: string;
  data: Record<string, unknown>;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message = "Values differ",
): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  assert(left === right, `${message}: expected ${right}, got ${left}`);
}

async function rejects(
  fn: () => Promise<unknown>,
  includes: string,
): Promise<void> {
  let message = "";
  try {
    await fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(
    message.includes(includes),
    `Expected '${includes}', got '${message}'`,
  );
}

function testContext(
  overrides: Partial<{
    binary: string;
    baseUrl: string;
    token: string | undefined;
    allowInsecureRemote: boolean;
    signal: AbortSignal;
    storedResources: Record<string, Record<string, unknown>>;
  }> = {},
) {
  const resources: Resource[] = [];
  const stored = overrides.storedResources ?? {};
  const context = {
    signal: overrides.signal ?? new AbortController().signal,
    globalArgs: {
      binary: overrides.binary ?? "torlnk",
      baseUrl: overrides.baseUrl ?? "http://127.0.0.1:9161",
      token: overrides.token,
      allowInsecureRemote: overrides.allowInsecureRemote ?? false,
    },
    writeResource(
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) {
      resources.push({ specName, name, data: structuredClone(data) });
      return Promise.resolve({ name });
    },
    readResource(name: string) {
      return Promise.resolve(
        stored[name] ? structuredClone(stored[name]) : null,
      );
    },
    logger: { info() {}, warning() {} },
  };
  return { context, resources };
}

function assertResourcesConform(resources: Resource[]): void {
  for (const resource of resources) {
    switch (resource.specName) {
      case "instance":
        testing.schemas.instance.parse(resource.data);
        break;
      case "search":
        testing.schemas.search.parse(resource.data);
        break;
      case "snapshot":
        testing.schemas.snapshot.parse(resource.data);
        break;
      case "torrent":
        testing.schemas.torrent.parse(resource.data);
        break;
      case "operation":
        testing.schemas.operation.parse(resource.data);
        break;
      default:
        throw new Error(`Unknown resource spec ${resource.specName}`);
    }
  }
}

async function fakeBinary(
  script: string,
): Promise<{ root: string; path: string }> {
  const root = await Deno.makeTempDir({ prefix: "swamp-torlink-" });
  const path = `${root}/torlnk`;
  await Deno.writeTextFile(path, `#!/bin/sh\nset -eu\n${script}\n`);
  await Deno.chmod(path, 0o755);
  return { root, path };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function server(
  handler: (request: Request) => Response | Promise<Response>,
) {
  const controller = new AbortController();
  let resolvePort!: (port: number) => void;
  const listening = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  const instance = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: controller.signal,
    onListen: ({ port }) => resolvePort(port),
  }, handler);
  const port = await listening;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      controller.abort();
      await instance.finished;
    },
  };
}

function searchDocument(query: string, category = "all", sourceOk = true) {
  return {
    query,
    category,
    count: sourceOk ? 1 : 0,
    sources: {
      yts: {
        ok: sourceOk,
        count: sourceOk ? 1 : 0,
        error: sourceOk ? null : "offline",
        code: sourceOk ? null : "no response",
      },
    },
    results: sourceOk
      ? [{
        infoHash: ID_A,
        name: "Example Movie",
        source: "yts",
        sizeBytes: 1024,
        seeders: 10,
        leechers: 1,
        numFiles: 1,
        added: 1,
        magnet: `magnet:?xt=urn:btih:${ID_A}`,
      }]
      : [],
  };
}

Deno.test("base URL policy allows loopback and rejects insecure remote HTTP", () => {
  testing.validateBaseUrl("http://127.0.0.1:9161", false);
  testing.validateBaseUrl("http://example.com", true, "secret");
  testing.validateBaseUrl("https://example.com", false, "secret");
  let error = "";
  try {
    testing.validateBaseUrl("http://example.com", false);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  assert(error.includes("plain HTTP"), "Remote HTTP was not rejected");
  for (
    const baseUrl of [
      "http://127.0.0.1:9161",
      "http://localhost:9161",
      "http://[::1]:9161",
    ]
  ) {
    assert(
      testing.validateBaseUrl(baseUrl, false) instanceof URL,
      `${baseUrl} was not accepted as loopback`,
    );
  }
  error = "";
  try {
    testing.validateBaseUrl("https://example.com", false);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  assert(
    error.includes("token is required"),
    "Remote API without a token was accepted",
  );
  const check = model.checks["safe-base-url"];
  assert(
    check.execute({
      globalArgs: {
        binary: "torlnk",
        baseUrl: "https://example.com",
        token: "secret",
        allowInsecureRemote: false,
      },
    }).pass,
    "Remote API with a token failed preflight",
  );
});

Deno.test("search passes the query as one argv value without a shell", async () => {
  const root = await Deno.makeTempDir({ prefix: "swamp-torlink-argv-" });
  const capture = `${root}/args`;
  const marker = `${root}/interpreted`;
  const query = `movie; touch ${marker}`;
  const fixture = await fakeBinary(
    `printf '%s\\n' "$@" > '${capture}'\nprintf '%s\\n' '${
      JSON.stringify(searchDocument(query, "movies"))
    }'`,
  );
  try {
    const { context, resources } = testContext({ binary: fixture.path });
    await model.methods.search.execute({
      queries: [{ key: "movie", query, category: "movies" }],
    }, context);
    assertEquals(
      (await Deno.readTextFile(capture)).trim().split("\n"),
      ["search", query, "--category", "movies"],
    );
    await rejects(() => Deno.stat(marker), "No such file");
    assertResourcesConform(resources);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("search handles multiple queries and partial source failures", async () => {
  const fixture = await fakeBinary(
    `query="$2"\nprintf '{"query":"%s","category":"all","count":0,"sources":{"yts":{"ok":true,"count":0,"error":null,"code":null},"tpb-movies":{"ok":false,"count":0,"error":"offline","code":"no response"}},"results":[]}\\n' "$query"`,
  );
  try {
    const { context, resources } = testContext({ binary: fixture.path });
    await model.methods.search.execute({
      queries: [
        { key: "one", query: "one", category: "all" },
        { key: "two", query: "two", category: "all" },
      ],
    }, context);
    const search = resources.find(({ specName }) => specName === "search");
    assert(
      (search?.data.queries as unknown[]).length === 2,
      "Multiple query results were not persisted",
    );
    assertResourcesConform(resources);
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("search rejects malformed CLI JSON before writing resources", async () => {
  const fixture = await fakeBinary("printf 'not-json\\n'");
  try {
    const { context, resources } = testContext({ binary: fixture.path });
    await rejects(
      () =>
        model.methods.search.execute({
          queries: [{ key: "bad", query: "bad", category: "all" }],
        }, context),
      "invalid JSON",
    );
    assert(resources.length === 0, "Malformed search output wrote resources");
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("search persists all-source diagnostics before failing the method", async () => {
  const fixture = await fakeBinary(
    `printf '%s\\n' '${
      JSON.stringify(searchDocument("offline", "games", false))
    }'\nexit 1`,
  );
  try {
    const { context, resources } = testContext({ binary: fixture.path });
    await rejects(
      () =>
        model.methods.search.execute({
          queries: [{ key: "offline", query: "offline", category: "games" }],
        }, context),
      "no responding sources",
    );
    const operation = resources.find(({ name }) => name === "operation-search");
    assert(
      operation?.data.ok === false &&
        (operation.data.results as Array<{ outcome: string }>)[0]?.outcome ===
          "all-sources-failed",
      "All-source failure was not persisted",
    );
    const search = resources.find(({ name }) => name === "search-current");
    const query = (search?.data.queries as Array<{
      sources: Record<string, { error: string }>;
    }>)[0];
    assert(
      query?.sources.yts?.error === "offline",
      "Source diagnostics were lost",
    );
    assertResourcesConform(resources);
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("health validates CLI and HTTP versions with bearer authorization", async () => {
  const token = "test-bearer-token";
  const fixture = await fakeBinary("printf 'torlink v1.7.0\\n'");
  const api = await server((request) => {
    assert(
      request.headers.get("authorization") === `Bearer ${token}`,
      "Bearer token missing",
    );
    return json({ ok: true, version: "1.7.0" });
  });
  try {
    const { context, resources } = testContext({
      binary: fixture.path,
      baseUrl: api.baseUrl,
      token,
    });
    await model.methods.health.execute({}, context);
    assertResourcesConform(resources);
    assert(
      !JSON.stringify(resources).includes(token),
      "Token leaked into health resources",
    );
  } finally {
    await api.close();
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("add records added, duplicate, invalid, and redacted mixed outcomes", async () => {
  const token = "test-secret-token";
  const api = await server(async (request) => {
    const { magnet } = await request.json();
    if (magnet === "bad") {
      return json({ error: "invalid magnet or info hash" }, 400);
    }
    if (magnet === "duplicate") return json({ ok: true, outcome: "duplicate" });
    if (magnet === "unauthorized") return json({ error: `bad ${token}` }, 401);
    return json({ ok: true, outcome: "added" });
  });
  try {
    const { context, resources } = testContext({ baseUrl: api.baseUrl, token });
    await rejects(
      () =>
        model.methods.add.execute({
          inputs: [
            { key: "added", input: `magnet:?xt=urn:btih:${ID_A}` },
            { key: "duplicate", input: "duplicate" },
            { key: "invalid", input: "bad" },
            { key: "unauthorized", input: "unauthorized" },
          ],
        }, context),
      "2 Torlink inputs failed",
    );
    const persisted = JSON.stringify(resources);
    const operation = resources.find(({ name }) => name === "operation-add");
    const invalid = (operation?.data.results as Array<{
      key: string;
      outcome: string;
    }>).find(({ key }) => key === "invalid");
    assert(invalid?.outcome === "invalid", "Invalid input was misclassified");
    assert(!persisted.includes(token), "Token leaked into add resources");
    assert(
      !persisted.includes(`magnet:?xt=urn:btih:${ID_A}`),
      "Magnet leaked into operation resources",
    );
    assertResourcesConform(resources);
  } finally {
    await api.close();
  }
});

Deno.test("sync unifies downloads and seeds and marks disappeared IDs absent", async () => {
  const api = await server(() =>
    json({
      downloads: [
        {
          id: ID_A,
          name: "Downloading",
          status: "downloading",
          progress: 25,
          peers: 2,
          speed: 100,
        },
        {
          id: "d".repeat(40),
          name: "Completed transition",
          status: "completed",
          progress: 100,
          peers: 0,
          speed: 0,
        },
      ],
      seeds: [{
        id: ID_B,
        name: "Seeding",
        status: "seeding",
        peers: 1,
        uploaded: 500,
      }],
    })
  );
  const previous = {
    capturedAt: new Date(0).toISOString(),
    torrents: [{
      infoHash: ID_C,
      name: "Gone",
      status: "paused",
      progress: null,
      peers: 0,
      speed: null,
      uploaded: 10,
      observedAt: new Date(0).toISOString(),
      absentSince: null,
    }],
  };
  try {
    const { context, resources } = testContext({
      baseUrl: api.baseUrl,
      storedResources: { "snapshot-current": previous },
    });
    await model.methods.sync.execute({}, context);
    const states = Object.fromEntries(
      resources.filter(({ specName }) => specName === "torrent")
        .map(({ data }) => [data.infoHash, data.status]),
    );
    assertEquals(states, {
      [ID_A]: "downloading",
      ["d".repeat(40)]: "completed",
      [ID_B]: "seeding",
      [ID_C]: "absent",
    });
    assertResourcesConform(resources);
  } finally {
    await api.close();
  }
});

Deno.test("wait handles success, terminal failure, timeout, and cancellation", async () => {
  let now = 0;
  let calls = 0;
  const dependencies = {
    now: () => now,
    sleep: () => {
      now += 1000;
      return Promise.resolve();
    },
  };
  const success = await testing.waitForTargets(
    { ids: [ID_A], until: "seeding", pollSeconds: 1, timeoutSeconds: 5 },
    () =>
      Promise.resolve(
        calls++ === 0 ? { downloads: [], seeds: [] } : {
          downloads: [],
          seeds: [{
            id: ID_A,
            name: "Ready",
            status: "seeding",
            peers: 0,
            uploaded: 0,
          }],
        },
      ),
    new AbortController().signal,
    dependencies,
  );
  assert(success[0]?.outcome === "reached", "Wait did not reach seeding");

  const failed = await testing.waitForTargets(
    { ids: [ID_A], until: "seeding", pollSeconds: 1, timeoutSeconds: 1 },
    () =>
      Promise.resolve({
        downloads: [{
          id: ID_A,
          name: "Failed",
          status: "failed",
          progress: 10,
          peers: 0,
          speed: 0,
        }],
        seeds: [],
      }),
    new AbortController().signal,
    dependencies,
  );
  assert(failed[0]?.outcome === "failed", "Terminal failure was not detected");

  now = 0;
  const pausedDownload = await testing.waitForTargets(
    { ids: [ID_A], until: "seed-stopped", pollSeconds: 1, timeoutSeconds: 1 },
    () =>
      Promise.resolve({
        downloads: [{
          id: ID_A,
          name: "Paused download",
          status: "paused",
          progress: 50,
          peers: 0,
          speed: 0,
        }],
        seeds: [],
      }),
    new AbortController().signal,
    dependencies,
  );
  assert(
    pausedDownload[0]?.outcome === "timeout",
    "Paused download satisfied seed-stopped",
  );

  now = 0;
  const pausedSeed = await testing.waitForTargets(
    { ids: [ID_A], until: "seed-stopped", pollSeconds: 1, timeoutSeconds: 1 },
    () =>
      Promise.resolve({
        downloads: [],
        seeds: [{
          id: ID_A,
          name: "Paused seed",
          status: "paused",
          peers: 0,
          uploaded: 0,
        }],
      }),
    new AbortController().signal,
    dependencies,
  );
  assert(
    pausedSeed[0]?.outcome === "reached",
    "Paused seed did not satisfy seed-stopped",
  );

  now = 0;
  const timeout = await testing.waitForTargets(
    { ids: [ID_A], until: "absent", pollSeconds: 1, timeoutSeconds: 1 },
    () =>
      Promise.resolve({
        downloads: [{
          id: ID_A,
          name: "Still here",
          status: "paused",
          progress: 10,
          peers: 0,
          speed: 0,
        }],
        seeds: [],
      }),
    new AbortController().signal,
    dependencies,
  );
  assert(timeout[0]?.outcome === "timeout", "Timeout was not reported");

  const controller = new AbortController();
  controller.abort();
  await rejects(
    () =>
      testing.waitForTargets(
        { ids: [ID_A], until: "seeding", pollSeconds: 1, timeoutSeconds: 1 },
        () => Promise.resolve({ downloads: [], seeds: [] }),
        controller.signal,
        dependencies,
      ),
    "cancelled",
  );
});

Deno.test("wait method records cancellation before failing", async () => {
  const controller = new AbortController();
  controller.abort();
  const { context, resources } = testContext({ signal: controller.signal });
  await rejects(
    () =>
      model.methods.wait.execute({
        ids: [ID_A],
        until: "seeding",
        pollSeconds: 1,
        timeoutSeconds: 1,
      }, context),
    "did not reach",
  );
  const operation = resources.find(({ name }) => name === "operation-wait");
  const results = operation?.data.results as Array<{ outcome: string }>;
  assert(
    results[0]?.outcome === "cancelled",
    "Wait cancellation was not persisted",
  );
  assertResourcesConform(resources);
});

Deno.test("control supports every action and requires confirmation for payload deletion", async () => {
  const requests: Array<{ action: string; deleteFiles: boolean }> = [];
  const api = await server(async (request) => {
    const body = await request.json();
    requests.push({ action: body.action, deleteFiles: body.deleteFiles });
    return json({ ok: true, id: body.id, action: body.action });
  });
  try {
    for (
      const action of [
        "pause",
        "resume",
        "start-seed",
        "stop-seed",
        "remove",
        "delete",
      ] as const
    ) {
      const { context, resources } = testContext({ baseUrl: api.baseUrl });
      await model.methods.control.execute({
        ids: [ID_A],
        action,
        confirmDeleteFiles: action === "delete",
      }, context);
      assertResourcesConform(resources);
    }
    assert(
      requests.find(({ action }) => action === "delete")?.deleteFiles === true,
      "Delete did not request file deletion",
    );
    assert(
      requests.find(({ action }) => action === "remove")?.deleteFiles === false,
      "Remove requested file deletion",
    );

    const { context, resources } = testContext({ baseUrl: api.baseUrl });
    await rejects(
      () =>
        model.methods.control.execute({
          ids: [ID_A],
          action: "delete",
          confirmDeleteFiles: false,
        }, context),
      "confirmDeleteFiles=true",
    );
    assert(resources.length === 0, "Unconfirmed delete wrote resources");
  } finally {
    await api.close();
  }
});

Deno.test("remove treats an already absent torrent as idempotent success", async () => {
  const api = await server(() => json({ error: "no such torrent" }, 404));
  try {
    const { context, resources } = testContext({ baseUrl: api.baseUrl });
    await model.methods.control.execute({
      ids: [ID_A],
      action: "remove",
      confirmDeleteFiles: false,
    }, context);
    const operation = resources.find(({ specName }) =>
      specName === "operation"
    );
    const results = operation?.data.results as Array<{ outcome: string }>;
    assert(
      results[0]?.outcome === "absent",
      "Absent remove was not idempotent",
    );
    assertResourcesConform(resources);
  } finally {
    await api.close();
  }
});
