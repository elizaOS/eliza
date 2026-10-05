/** Owns the legacy fixed-port entrypoints using the canonical service handlers. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import ports from "./compatibility-ports.json";
import { type MockEnvironmentName, startMocks } from "./start-mocks.ts";

const directory = testOutputPath("mock-services");
const recordPath = path.join(directory, "control.json");
const token = randomBytes(32).toString("hex");
const bindings: Partial<Record<MockEnvironmentName, number>> = {};
for (const entry of ports)
  bindings[entry.service as MockEnvironmentName] ??= entry.port;
const mocks = await startMocks({
  envs: Object.keys(bindings) as MockEnvironmentName[],
  ports: bindings,
  deterministicSeed: "mockoon-compatibility",
});
const aliases: http.Server[] = [];
let control: http.Server | undefined;
let closePromise: Promise<void> | undefined;
function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
function close(): Promise<void> {
  closePromise ??= (async () => {
    const results = await Promise.allSettled([
      mocks.stop(),
      ...aliases.map(closeServer),
      ...(control ? [closeServer(control)] : []),
    ]);
    try {
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      if (record.token === token) await unlink(recordPath);
    } catch (error) {
      // error-policy:J3 A failed startup may never have published its owned record.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Mock service shutdown failed",
      );
  })();
  return closePromise;
}
try {
  for (const entry of ports) {
    const service = entry.service as MockEnvironmentName;
    if (entry.port === bindings[service]) continue;
    const proxy = http.createServer((request, response) => {
      const upstream = http.request(
        new URL(request.url ?? "/", mocks.baseUrls[service]),
        { method: request.method, headers: request.headers },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.pipe(response);
        },
      );
      upstream.on("error", () => {
        response.writeHead(502);
        response.end();
      });
      request.on("aborted", () => upstream.destroy());
      request.pipe(upstream);
    });
    aliases.push(proxy);
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(entry.port, "127.0.0.1", resolve);
    });
  }
  control = http.createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (request.url === "/health" && request.method === "GET") {
      response.end("ready");
      return;
    }
    if (request.url !== "/stop" || request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.once("finish", () => {
      void close().then(
        () => process.exit(0),
        (error) => {
          console.error(error);
          process.exit(1);
        },
      );
    });
    response.end("stopping");
  });
  const listener = control;
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = control.address();
  if (!address || typeof address === "string")
    throw new Error("Control listener has no address");
  await mkdir(directory, { recursive: true });
  await writeFile(
    recordPath,
    JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${address.port}`,
      token,
    }),
    { flag: "wx", mode: 0o600 },
  );
  process.send?.({ ready: true, services: Object.keys(bindings), recordPath });
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      void close().then(
        () => process.exit(0),
        (error) => {
          console.error(error);
          process.exit(1);
        },
      );
    });
} catch (error) {
  // error-policy:J6 Failed startup must release every listener that already bound.
  try {
    await close();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      "Mock startup and cleanup failed",
    );
  }
  throw error;
}
