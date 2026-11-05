import { model } from "../extensions/models/torlink.ts";

Deno.test("real HTTP validates bearer auth, JSON responses and redirect rejection", async () => {
  let mode = "ok";
  const requests: string[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (req) => {
      requests.push(new URL(req.url).pathname);
      if (
        req.headers.get("authorization") !== "Bearer fixture"
      ) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (mode === "redirect") {
        return Response.redirect(
          new URL("/unexpected", req.url),
          307,
        );
      }
      if (mode === "html") return new Response("not JSON");
      return Response.json({
        interface: null,
        address: null,
        online: true,
        peerPort: null,
        incoming: 0,
      });
    },
  );
  const resources: unknown[] = [];
  const context = {
    signal: new AbortController().signal,
    globalArgs: model.globalArguments.parse({
      baseUrl: `http://127.0.0.1:${server.addr.port}`,
      token: "fixture",
    }),
    logger: { info() {}, warning() {} },
    readResource: () => Promise.resolve(null),
    writeResource: (
      _spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      resources.push(data);
      return Promise.resolve({ name });
    },
  };
  try {
    await model.methods.network.execute({}, context);
    for (const invalid of ["redirect", "html"]) {
      mode = invalid;
      let failed = false;
      try {
        await model.methods.network.execute({}, context);
      } catch {
        failed = true;
      }
      if (!failed) throw new Error(`${mode} was accepted`);
    }
    if (resources.length !== 1 || requests.includes("/unexpected")) {
      throw new Error("Invalid response persisted or redirect followed");
    }
  } finally {
    await server.shutdown();
  }
});
