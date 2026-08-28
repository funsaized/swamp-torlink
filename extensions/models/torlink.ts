/** Typed Torlink search, download, seed, and control operations. @module */
import { z } from "npm:zod@4";

const MODEL_VERSION = "2026.08.28.1";
const MAX_CLI_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_CLI_STDERR_BYTES = 64 * 1024;
const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const MAX_ERROR_CHARS = 2048;
const HTTP_TIMEOUT_MS = 30_000;
const INFO_HASH = /^[0-9a-f]{40}$/i;

const SearchCategorySchema = z.enum(["all", "games", "movies", "tv", "anime"]);
const DownloadStatusSchema = z.enum([
  "downloading",
  "queued",
  "paused",
  "completed",
  "failed",
]);
const SeedStatusSchema = z.enum(["seeding", "paused", "missing"]);
const TorrentStatusSchema = z.enum([
  "downloading",
  "queued",
  "paused",
  "completed",
  "failed",
  "seeding",
  "missing",
  "absent",
]);
const ControlActionSchema = z.enum([
  "pause",
  "resume",
  "start-seed",
  "stop-seed",
  "remove",
  "delete",
]);

const GlobalArgumentsSchema = z.object({
  binary: z.string().min(1).default("torlnk"),
  baseUrl: z.string().url().default("http://127.0.0.1:9161"),
  token: z.string().min(1).optional().meta({ sensitive: true }),
  allowInsecureRemote: z.boolean().default(false),
});

const SourceOutcomeInputSchema = z.object({
  ok: z.boolean(),
  count: z.number().int().nonnegative(),
  error: z.string().nullable(),
  code: z.string().nullable(),
});

const SourceOutcomeSchema = z.object({
  ok: z.boolean(),
  count: z.number().int().nonnegative(),
  error: z.string().max(MAX_ERROR_CHARS).nullable(),
  code: z.string().max(100).nullable(),
});

const SearchResultSchema = z.object({
  infoHash: z.string().regex(INFO_HASH),
  name: z.string().max(4096),
  source: z.string().min(1).max(100),
  sizeBytes: z.number().int().nonnegative(),
  seeders: z.number().int().nonnegative(),
  leechers: z.number().int().nonnegative(),
  numFiles: z.number().int().nonnegative().optional(),
  added: z.number().int().nonnegative().optional(),
  magnet: z.string().min(1).max(65_536),
});

const HeadlessSearchSchema = z.object({
  query: z.string(),
  category: SearchCategorySchema,
  count: z.number().int().nonnegative(),
  sources: z.record(z.string(), SourceOutcomeInputSchema),
  results: z.array(SearchResultSchema),
});

const SearchQueryResultSchema = z.object({
  key: z.string().min(1).max(200),
  query: z.string().min(1).max(500),
  category: SearchCategorySchema,
  ok: z.boolean(),
  count: z.number().int().nonnegative(),
  sources: z.record(z.string(), SourceOutcomeSchema),
  results: z.array(SearchResultSchema),
});

const SearchResourceSchema = z.object({
  searchedAt: z.iso.datetime(),
  queries: z.array(SearchQueryResultSchema),
});

const InstanceSchema = z.object({
  ok: z.literal(true),
  cliVersion: z.string().min(1).max(100),
  serverVersion: z.string().min(1).max(100),
  baseUrl: z.string().url(),
  checkedAt: z.iso.datetime(),
});

const DownloadSchema = z.object({
  id: z.string().regex(INFO_HASH),
  name: z.string().max(4096),
  status: DownloadStatusSchema,
  progress: z.number().min(0).max(100),
  peers: z.number().int().nonnegative(),
  speed: z.number().nonnegative(),
});

const SeedSchema = z.object({
  id: z.string().regex(INFO_HASH),
  name: z.string().max(4096),
  status: SeedStatusSchema,
  peers: z.number().int().nonnegative(),
  uploaded: z.number().nonnegative(),
});

const StatusResponseSchema = z.object({
  downloads: z.array(DownloadSchema),
  seeds: z.array(SeedSchema),
});

const TorrentResourceSchema = z.object({
  infoHash: z.string().regex(INFO_HASH),
  name: z.string().max(4096).nullable(),
  status: TorrentStatusSchema,
  progress: z.number().min(0).max(100).nullable(),
  peers: z.number().int().nonnegative(),
  speed: z.number().nonnegative().nullable(),
  uploaded: z.number().nonnegative().nullable(),
  observedAt: z.iso.datetime(),
  absentSince: z.iso.datetime().nullable(),
});

const SnapshotSchema = z.object({
  capturedAt: z.iso.datetime(),
  torrents: z.array(TorrentResourceSchema),
});

const OperationResultSchema = z.object({
  key: z.string().max(200).nullable(),
  id: z.string().regex(INFO_HASH).nullable(),
  action: ControlActionSchema.nullable(),
  outcome: z.enum([
    "succeeded",
    "all-sources-failed",
    "added",
    "duplicate",
    "invalid",
    "synchronized",
    "reached",
    "failed",
    "timeout",
    "cancelled",
    "applied",
    "absent",
    "error",
  ]),
  ok: z.boolean(),
  error: z.string().max(MAX_ERROR_CHARS).nullable(),
});

const OperationSchema = z.object({
  method: z.enum(["search", "add", "sync", "wait", "control"]),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  ok: z.boolean(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(OperationResultSchema),
});

const SearchArgsSchema = z.object({
  queries: uniqueKeys(
    z.array(z.object({
      key: z.string().min(1).max(200),
      query: z.string().trim().min(1).max(500),
      category: SearchCategorySchema.default("all"),
    })).min(1).max(100),
  ),
});

const AddArgsSchema = z.object({
  inputs: uniqueKeys(
    z.array(z.object({
      key: z.string().min(1).max(200),
      input: z.string().trim().min(1).max(65_536),
    })).min(1).max(100),
  ),
});

const IdsSchema = z.array(
  z.string().regex(INFO_HASH).transform((id) => id.toLowerCase()),
)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, "ids must be unique");

const WaitArgsSchema = z.object({
  ids: IdsSchema,
  until: z.enum(["seeding", "seed-stopped", "absent"]),
  pollSeconds: z.number().int().min(1).max(3600).default(30),
  timeoutSeconds: z.number().int().min(1).max(604_800),
});

const ControlArgsSchema = z.object({
  ids: IdsSchema,
  action: ControlActionSchema,
  confirmDeleteFiles: z.boolean().default(false),
});

const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string().min(1).max(100),
});

const AddResponseSchema = z.object({
  ok: z.literal(true),
  outcome: z.enum(["added", "duplicate"]),
});

const ControlResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string().regex(INFO_HASH),
  action: ControlActionSchema,
});

const ErrorResponseSchema = z.object({ error: z.string() });

type GlobalArguments = z.infer<typeof GlobalArgumentsSchema>;
type SearchArgs = z.infer<typeof SearchArgsSchema>;
type WaitArgs = z.infer<typeof WaitArgsSchema>;
type StatusResponse = z.infer<typeof StatusResponseSchema>;
type TorrentResource = z.infer<typeof TorrentResourceSchema>;
type OperationResult = z.infer<typeof OperationResultSchema>;
type Handle = { name: string };
type Context = {
  signal: AbortSignal;
  globalArgs: GlobalArguments;
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<Handle>;
  readResource(
    name: string,
    version?: number,
  ): Promise<Record<string, unknown> | null>;
  logger: {
    info(message: string, properties?: Record<string, unknown>): void;
    warning(message: string, properties?: Record<string, unknown>): void;
  };
};

type CliResult = { code: number; stdout: string; stderr: string };
type HttpResult = { status: number; data: unknown };
type WaitResult = {
  id: string;
  outcome: "reached" | "failed" | "timeout" | "cancelled";
  observedStatus: string | null;
  error: string | null;
};
type WaitDependencies = {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
};
type LiveStatus = { kind: "download" | "seed"; status: string };

function uniqueKeys<T extends z.ZodType<{ key: string }[]>>(schema: T): T {
  return schema.refine(
    (items) => new Set(items.map(({ key }) => key)).size === items.length,
    "keys must be unique",
  ) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeError(error: unknown, token?: string): string {
  const redacted = token
    ? errorMessage(error).replaceAll(token, "[REDACTED]")
    : errorMessage(error);
  return redacted.slice(0, MAX_ERROR_CHARS);
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" ||
    normalized === "[::1]" || normalized === "::1";
}

function validateBaseUrl(
  value: string,
  allowInsecureRemote: boolean,
  token?: string,
): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("baseUrl must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("baseUrl must not contain a query or fragment");
  }
  if (
    url.protocol === "http:" && !isLoopback(url.hostname) &&
    !allowInsecureRemote
  ) {
    throw new Error(
      "plain HTTP is allowed only for loopback unless allowInsecureRemote is true",
    );
  }
  if (!isLoopback(url.hostname) && !token) {
    throw new Error("token is required for a non-loopback Torlink API");
  }
  return url;
}

function joinChunks(chunks: Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  label: string,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error(`${label} exceeded ${limit} bytes`);
      }
      chunks.push(value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(joinChunks(chunks, size));
}

async function runCli(
  command: string,
  args: string[],
  signal: AbortSignal,
): Promise<CliResult> {
  if (signal.aborted) {
    throw new Error("Torlink CLI command cancelled before launch");
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  let child: Deno.ChildProcess | undefined;
  try {
    child = new Deno.Command(command, {
      args,
      signal: controller.signal,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const [status, stdout, stderr] = await Promise.all([
      child.status,
      readBounded(child.stdout, MAX_CLI_STDOUT_BYTES, "Torlink stdout"),
      readBounded(child.stderr, MAX_CLI_STDERR_BYTES, "Torlink stderr"),
    ]);
    return { code: status.code, stdout, stderr };
  } catch (error) {
    controller.abort();
    if (child) await child.status.catch(() => undefined);
    if (signal.aborted) throw new Error("Torlink CLI command cancelled");
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function parseJson<T>(schema: z.ZodType<T>, text: string, label: string): T {
  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${safeError(error)}`);
  }
}

function baseUrl(globalArgs: GlobalArguments): string {
  return validateBaseUrl(
    globalArgs.baseUrl,
    globalArgs.allowInsecureRemote,
    globalArgs.token,
  )
    .toString().replace(/\/$/, "");
}

async function httpJson(
  globalArgs: GlobalArguments,
  path: string,
  method: "GET" | "POST",
  body: unknown,
  signal: AbortSignal,
): Promise<HttpResult> {
  if (signal.aborted) {
    throw new Error("Torlink HTTP request cancelled before launch");
  }
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new Error(`Torlink HTTP request timed out after ${HTTP_TIMEOUT_MS}ms`),
    );
  }, HTTP_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (globalArgs.token) headers.Authorization = `Bearer ${globalArgs.token}`;
    const response = await fetch(`${baseUrl(globalArgs)}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type")?.toLowerCase() ??
      "";
    if (!contentType.includes("application/json")) {
      await response.body?.cancel();
      throw new Error(
        `Torlink ${path} returned non-JSON content type '${
          contentType || "missing"
        }'`,
      );
    }
    const text = response.body
      ? await readBounded(
        response.body,
        MAX_HTTP_BODY_BYTES,
        `Torlink ${path} response`,
      )
      : "";
    return {
      status: response.status,
      data: parseJson(z.unknown(), text, `Torlink ${path}`),
    };
  } catch (error) {
    if (signal.aborted) throw new Error("Torlink HTTP request cancelled");
    if (timedOut) {
      throw new Error(
        `Torlink HTTP request timed out after ${HTTP_TIMEOUT_MS}ms`,
      );
    }
    throw new Error(safeError(error, globalArgs.token));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function httpError(
  label: string,
  response: HttpResult,
  token?: string,
): string {
  const parsed = ErrorResponseSchema.safeParse(response.data);
  const detail = parsed.success
    ? parsed.data.error
    : JSON.stringify(response.data);
  return safeError(
    `${label} failed with HTTP ${response.status}: ${detail}`,
    token,
  );
}

function operation(
  method: z.infer<typeof OperationSchema>["method"],
  startedAt: string,
  results: OperationResult[],
): z.infer<typeof OperationSchema> {
  const succeeded = results.filter(({ ok }) => ok).length;
  return {
    method,
    startedAt,
    completedAt: new Date().toISOString(),
    ok: succeeded === results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

function searchCommandArgs(
  query: string,
  category: z.infer<typeof SearchCategorySchema>,
): string[] {
  return category === "all"
    ? ["search", query]
    : ["search", query, "--category", category];
}

function normalizeSearch(
  item: SearchArgs["queries"][number],
  cli: CliResult,
): z.infer<typeof SearchQueryResultSchema> {
  if (cli.code !== 0 && cli.code !== 1) {
    throw new Error(
      `Torlink search exited ${cli.code}: ${safeError(cli.stderr)}`,
    );
  }
  const parsed = parseJson(HeadlessSearchSchema, cli.stdout, "Torlink search");
  if (parsed.query !== item.query || parsed.category !== item.category) {
    throw new Error(
      "Torlink search response did not match the requested query and category",
    );
  }
  const sources = Object.fromEntries(
    Object.entries(parsed.sources).map(([id, value]) => [id, {
      ...value,
      error: value.error === null ? null : safeError(value.error),
      code: value.code?.slice(0, 100) ?? null,
    }]),
  );
  const ok = Object.values(sources).some((source) => source.ok);
  if ((cli.code === 0) !== ok) {
    throw new Error(
      "Torlink search exit code disagreed with its source outcomes",
    );
  }
  if (parsed.count !== parsed.results.length) {
    throw new Error("Torlink search count did not match its results");
  }
  return {
    key: item.key,
    query: item.query,
    category: item.category,
    ok,
    count: parsed.count,
    sources,
    results: parsed.results,
  };
}

function currentTorrents(
  status: StatusResponse,
  observedAt: string,
): TorrentResource[] {
  const torrents = new Map<string, TorrentResource>();
  for (const download of status.downloads) {
    const infoHash = download.id.toLowerCase();
    torrents.set(infoHash, {
      infoHash,
      name: download.name,
      status: download.status,
      progress: download.progress,
      peers: download.peers,
      speed: download.speed,
      uploaded: null,
      observedAt,
      absentSince: null,
    });
  }
  for (const seed of status.seeds) {
    const infoHash = seed.id.toLowerCase();
    torrents.set(infoHash, {
      infoHash,
      name: seed.name,
      status: seed.status,
      progress: null,
      peers: seed.peers,
      speed: null,
      uploaded: seed.uploaded,
      observedAt,
      absentSince: null,
    });
  }
  return [...torrents.values()];
}

function liveStatuses(response: StatusResponse): Map<string, LiveStatus> {
  const statuses = new Map<string, LiveStatus>();
  for (const { id, status } of response.downloads) {
    statuses.set(id.toLowerCase(), { kind: "download", status });
  }
  for (const { id, status } of response.seeds) {
    statuses.set(id.toLowerCase(), { kind: "seed", status });
  }
  return statuses;
}

function evaluateWait(
  until: WaitArgs["until"],
  state: LiveStatus | undefined,
): { done: boolean; failed: boolean; error: string | null } {
  if (until === "absent") {
    return { done: state === undefined, failed: false, error: null };
  }
  if (
    until === "seeding" && state?.kind === "seed" && state.status === "seeding"
  ) {
    return { done: true, failed: false, error: null };
  }
  if (
    until === "seed-stopped" && state?.kind === "seed" &&
    state.status === "paused"
  ) {
    return { done: true, failed: false, error: null };
  }
  if (state?.status === "failed" || state?.status === "missing") {
    return {
      done: true,
      failed: true,
      error: `Torrent entered terminal status '${state.status}'`,
    };
  }
  return { done: false, failed: false, error: null };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Wait cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

async function waitForTargets(
  args: WaitArgs,
  load: () => Promise<StatusResponse>,
  signal: AbortSignal,
  dependencies: WaitDependencies = { now: Date.now, sleep: abortableSleep },
): Promise<WaitResult[]> {
  const deadline = dependencies.now() + args.timeoutSeconds * 1000;
  const final = new Map<string, WaitResult>();
  let lastPollError: string | null = null;
  while (final.size < args.ids.length) {
    if (signal.aborted) throw new Error("Wait cancelled");
    try {
      const statuses = liveStatuses(await load());
      lastPollError = null;
      for (const id of args.ids) {
        if (final.has(id)) continue;
        const live = statuses.get(id);
        const state = evaluateWait(args.until, live);
        if (state.done) {
          final.set(id, {
            id,
            outcome: state.failed ? "failed" : "reached",
            observedStatus: live?.status ?? null,
            error: state.error,
          });
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      lastPollError = safeError(error);
    }
    if (final.size === args.ids.length) break;
    const remaining = deadline - dependencies.now();
    if (remaining <= 0) break;
    await dependencies.sleep(
      Math.min(args.pollSeconds * 1000, remaining),
      signal,
    );
  }
  for (const id of args.ids) {
    if (!final.has(id)) {
      final.set(id, {
        id,
        outcome: "timeout",
        observedStatus: null,
        error: lastPollError ?? `Timed out after ${args.timeoutSeconds}s`,
      });
    }
  }
  return args.ids.map((id) => final.get(id)!);
}

/** Torlink model definition. */
export const model = {
  type: "@funsaized/torlink",
  version: MODEL_VERSION,
  globalArguments: GlobalArgumentsSchema,
  checks: {
    "safe-base-url": {
      description:
        "Require HTTPS for non-loopback Torlink API connections unless explicitly allowed.",
      labels: ["policy"],
      execute: (context: { globalArgs: GlobalArguments }) => {
        try {
          validateBaseUrl(
            context.globalArgs.baseUrl,
            context.globalArgs.allowInsecureRemote,
            context.globalArgs.token,
          );
          return { pass: true };
        } catch (error) {
          return { pass: false, errors: [errorMessage(error)] };
        }
      },
    },
  },
  resources: {
    instance: {
      description: "Torlink CLI and server health.",
      schema: InstanceSchema,
      lifetime: "1h",
      garbageCollection: 24,
    },
    search: {
      description:
        "Latest batch of headless Torlink search results and source outcomes.",
      schema: SearchResourceSchema,
      lifetime: "30d",
      garbageCollection: 100,
    },
    snapshot: {
      description: "Current Torlink download and seed snapshot.",
      schema: SnapshotSchema,
      lifetime: "7d",
      garbageCollection: 100,
    },
    torrent: {
      description: "Observed lifecycle state for one torrent info hash.",
      schema: TorrentResourceSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    operation: {
      description: "Latest batch outcome for a Torlink model method.",
      schema: OperationSchema,
      lifetime: "30d",
      garbageCollection: 100,
    },
  },
  methods: {
    health: {
      description: "Verify the Torlink CLI version and server health endpoint.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Context) => {
        context.logger.info("Checking Torlink CLI and server health");
        const cli = await runCli(
          context.globalArgs.binary,
          ["--version"],
          context.signal,
        );
        if (cli.code !== 0) {
          throw new Error(
            `Torlink --version exited ${cli.code}: ${safeError(cli.stderr)}`,
          );
        }
        const match = cli.stdout.trim().match(/^torlink v(.+)$/);
        if (!match) {
          throw new Error("Torlink --version returned an unexpected value");
        }
        const response = await httpJson(
          context.globalArgs,
          "/health",
          "GET",
          undefined,
          context.signal,
        );
        if (response.status !== 200) {
          throw new Error(
            httpError("Torlink health", response, context.globalArgs.token),
          );
        }
        const health = HealthResponseSchema.parse(response.data);
        const cliVersion = match[1]!;
        if (cliVersion !== health.version) {
          throw new Error(
            `Torlink CLI ${cliVersion} does not match server ${health.version}`,
          );
        }
        const handle = await context.writeResource(
          "instance",
          "instance-current",
          {
            ok: true,
            cliVersion,
            serverVersion: health.version,
            baseUrl: baseUrl(context.globalArgs),
            checkedAt: new Date().toISOString(),
          },
        );
        context.logger.info("Torlink health check completed", {
          version: cliVersion,
        });
        return { dataHandles: [handle] };
      },
    },
    search: {
      description:
        "Run one or more headless Torlink searches in a single model method.",
      arguments: SearchArgsSchema,
      execute: async (args: SearchArgs, context: Context) => {
        const startedAt = new Date().toISOString();
        context.logger.info("Searching Torlink for {count} queries", {
          count: args.queries.length,
        });
        const queries = await Promise.all(
          args.queries.map(async (item) =>
            normalizeSearch(
              item,
              await runCli(
                context.globalArgs.binary,
                searchCommandArgs(item.query, item.category),
                context.signal,
              ),
            )
          ),
        );
        const searchHandle = await context.writeResource(
          "search",
          "search-current",
          {
            searchedAt: new Date().toISOString(),
            queries,
          },
        );
        const results: OperationResult[] = queries.map((query) => ({
          key: query.key,
          id: null,
          action: null,
          outcome: query.ok ? "succeeded" : "all-sources-failed",
          ok: query.ok,
          error: query.ok ? null : "All selected Torlink sources failed",
        }));
        const summary = operation("search", startedAt, results);
        const operationHandle = await context.writeResource(
          "operation",
          "operation-search",
          summary,
        );
        context.logger.info("Torlink search completed", {
          succeeded: summary.succeeded,
          failed: summary.failed,
        });
        if (!summary.ok) {
          throw new Error(
            `${summary.failed} Torlink search queries had no responding sources`,
          );
        }
        return { dataHandles: [searchHandle, operationHandle] };
      },
    },
    add: {
      description:
        "Add one or more magnets or info hashes in a single model method.",
      arguments: AddArgsSchema,
      execute: async (
        args: z.infer<typeof AddArgsSchema>,
        context: Context,
      ) => {
        const startedAt = new Date().toISOString();
        context.logger.info("Adding {count} torrents to Torlink", {
          count: args.inputs.length,
        });
        const results: OperationResult[] = await Promise.all(
          args.inputs.map(async (item) => {
            try {
              const response = await httpJson(
                context.globalArgs,
                "/add",
                "POST",
                { magnet: item.input },
                context.signal,
              );
              const parsed = AddResponseSchema.safeParse(response.data);
              if (response.status === 200 && parsed.success) {
                return {
                  key: item.key,
                  id: null,
                  action: null,
                  outcome: parsed.data.outcome,
                  ok: true,
                  error: null,
                };
              }
              const invalid = ErrorResponseSchema.safeParse(response.data);
              if (
                response.status === 400 && invalid.success &&
                invalid.data.error === "invalid magnet or info hash"
              ) {
                return {
                  key: item.key,
                  id: null,
                  action: null,
                  outcome: "invalid",
                  ok: false,
                  error: invalid.data.error,
                };
              }
              return {
                key: item.key,
                id: null,
                action: null,
                outcome: "error",
                ok: false,
                error: httpError(
                  "Torlink add",
                  response,
                  context.globalArgs.token,
                ),
              };
            } catch (error) {
              return {
                key: item.key,
                id: null,
                action: null,
                outcome: "error",
                ok: false,
                error: safeError(error, context.globalArgs.token),
              };
            }
          }),
        );
        const summary = operation("add", startedAt, results);
        const handle = await context.writeResource(
          "operation",
          "operation-add",
          summary,
        );
        context.logger.info("Torlink add completed", {
          succeeded: summary.succeeded,
          failed: summary.failed,
        });
        if (!summary.ok) {
          throw new Error(`${summary.failed} Torlink inputs failed to add`);
        }
        return { dataHandles: [handle] };
      },
    },
    sync: {
      description:
        "Snapshot downloads and seeds and mark disappeared prior torrents absent.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Context) => {
        const startedAt = new Date().toISOString();
        context.logger.info("Synchronizing Torlink torrent state");
        const response = await httpJson(
          context.globalArgs,
          "/downloads",
          "GET",
          undefined,
          context.signal,
        );
        if (response.status !== 200) {
          throw new Error(
            httpError("Torlink sync", response, context.globalArgs.token),
          );
        }
        const capturedAt = new Date().toISOString();
        const current = currentTorrents(
          StatusResponseSchema.parse(response.data),
          capturedAt,
        );
        const previousRaw = await context.readResource("snapshot-current");
        const previous = previousRaw ? SnapshotSchema.parse(previousRaw) : null;
        const currentIds = new Set(current.map(({ infoHash }) => infoHash));
        const absent = (previous?.torrents ?? [])
          .filter(({ infoHash }) => !currentIds.has(infoHash))
          .map((torrent): TorrentResource => ({
            ...torrent,
            status: "absent",
            progress: null,
            peers: 0,
            speed: null,
            uploaded: null,
            observedAt: capturedAt,
            absentSince: torrent.absentSince ?? capturedAt,
          }));
        const handles: Handle[] = [];
        for (const torrent of [...current, ...absent]) {
          handles.push(
            await context.writeResource(
              "torrent",
              `torrent-${torrent.infoHash}`,
              torrent,
            ),
          );
        }
        handles.push(
          await context.writeResource("snapshot", "snapshot-current", {
            capturedAt,
            torrents: current,
          }),
        );
        const summary = operation("sync", startedAt, [{
          key: null,
          id: null,
          action: null,
          outcome: "synchronized",
          ok: true,
          error: null,
        }]);
        handles.push(
          await context.writeResource("operation", "operation-sync", summary),
        );
        context.logger.info("Torlink sync completed", {
          current: current.length,
          absent: absent.length,
        });
        return { dataHandles: handles };
      },
    },
    wait: {
      description:
        "Poll Torlink until multiple torrent IDs reach a target lifecycle state.",
      arguments: WaitArgsSchema,
      execute: async (args: WaitArgs, context: Context) => {
        const startedAt = new Date().toISOString();
        context.logger.info("Waiting for {count} Torlink torrents", {
          count: args.ids.length,
          until: args.until,
        });
        let waited: WaitResult[];
        try {
          waited = await waitForTargets(
            args,
            async () => {
              const response = await httpJson(
                context.globalArgs,
                "/downloads",
                "GET",
                undefined,
                context.signal,
              );
              if (response.status !== 200) {
                throw new Error(
                  httpError("Torlink wait", response, context.globalArgs.token),
                );
              }
              return StatusResponseSchema.parse(response.data);
            },
            context.signal,
          );
        } catch (error) {
          waited = args.ids.map((id) => ({
            id,
            outcome: context.signal.aborted ? "cancelled" : "failed",
            observedStatus: null,
            error: safeError(error, context.globalArgs.token),
          }));
        }
        const results: OperationResult[] = waited.map((result) => ({
          key: null,
          id: result.id,
          action: null,
          outcome: result.outcome,
          ok: result.outcome === "reached",
          error: result.error,
        }));
        const summary = operation("wait", startedAt, results);
        const handle = await context.writeResource(
          "operation",
          "operation-wait",
          summary,
        );
        context.logger.info("Torlink wait completed", {
          succeeded: summary.succeeded,
          failed: summary.failed,
        });
        if (!summary.ok) {
          throw new Error(
            `${summary.failed} Torlink torrents did not reach '${args.until}'`,
          );
        }
        return { dataHandles: [handle] };
      },
    },
    control: {
      description: "Apply one control action to multiple Torlink torrent IDs.",
      arguments: ControlArgsSchema,
      execute: async (
        args: z.infer<typeof ControlArgsSchema>,
        context: Context,
      ) => {
        if (args.action === "delete" && !args.confirmDeleteFiles) {
          throw new Error(
            "confirmDeleteFiles=true is required for the delete action",
          );
        }
        const startedAt = new Date().toISOString();
        context.logger.info("Applying Torlink action to {count} torrents", {
          action: args.action,
          count: args.ids.length,
        });
        const results: OperationResult[] = await Promise.all(
          args.ids.map(async (id) => {
            try {
              const response = await httpJson(
                context.globalArgs,
                "/control",
                "POST",
                {
                  id,
                  action: args.action,
                  deleteFiles: args.action === "delete",
                },
                context.signal,
              );
              const parsed = ControlResponseSchema.safeParse(response.data);
              if (
                response.status === 200 && parsed.success &&
                parsed.data.id.toLowerCase() === id &&
                parsed.data.action === args.action
              ) {
                return {
                  key: null,
                  id,
                  action: args.action,
                  outcome: "applied",
                  ok: true,
                  error: null,
                };
              }
              if (
                response.status === 404 &&
                (args.action === "remove" || args.action === "delete")
              ) {
                return {
                  key: null,
                  id,
                  action: args.action,
                  outcome: "absent",
                  ok: true,
                  error: null,
                };
              }
              return {
                key: null,
                id,
                action: args.action,
                outcome: "error",
                ok: false,
                error: httpError(
                  "Torlink control",
                  response,
                  context.globalArgs.token,
                ),
              };
            } catch (error) {
              return {
                key: null,
                id,
                action: args.action,
                outcome: "error",
                ok: false,
                error: safeError(error, context.globalArgs.token),
              };
            }
          }),
        );
        const summary = operation("control", startedAt, results);
        const handle = await context.writeResource(
          "operation",
          "operation-control",
          summary,
        );
        context.logger.info("Torlink control completed", {
          succeeded: summary.succeeded,
          failed: summary.failed,
        });
        if (!summary.ok) {
          throw new Error(`${summary.failed} Torlink control actions failed`);
        }
        return { dataHandles: [handle] };
      },
    },
  },
};

/** Pure and dependency-injected helpers used by the unit tests. */
export const testing = {
  schemas: {
    globalArguments: GlobalArgumentsSchema,
    instance: InstanceSchema,
    search: SearchResourceSchema,
    snapshot: SnapshotSchema,
    torrent: TorrentResourceSchema,
    operation: OperationSchema,
  },
  searchCommandArgs,
  normalizeSearch,
  currentTorrents,
  evaluateWait,
  waitForTargets,
  validateBaseUrl,
};
