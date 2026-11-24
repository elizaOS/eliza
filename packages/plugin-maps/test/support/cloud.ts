// spec/maps/cloudConnection.md, "Story: Keep Cloud Maps on the account that requested it"
import { type Clock, Effect } from "effect";
import { CloudError } from "@elizaos/cloud";
import { parseLaunch, startAgent, type AgentPlugin, type CloudLinkReply, type CloudLinkRequest, type RunningAgent } from "@elizaos/agent-host";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { promisify } from "node:util";
import type { MapsCloud } from "@elizaos/plugin-maps-client";
import { gate, type Gate } from "./gates.ts";

export const offer = {
  available: true as const, providerId: "google", connectionId: "conn_0123456789abcdef", revision: "2026-11", attribution: "Google Maps Platform via Eliza Cloud",
  sources: { data: "Google", search: "Google", routing: "Google" },
  disclosure: { recipients: [{ role: "gateway" as const, name: "Eliza Cloud", operator: "Eliza Labs" }], cloudRecords: "operation-and-result-code" as const },
  regions: [{ id: "world", name: "World", bounds: [-180, -90, 180, 90] as const }],
  capabilities: { map: false, search: true as const, placeDetails: true as const, geocode: true as const, reverseGeocode: true as const, placeLookup: true, modes: ["drive", "walk"] as const, alternatives: true, traffic: "live" as const, transit: "none" as const, offline: { map: false as const, search: false as const, routing: false as const } },
};

export const cloudFailure = (failure: CloudError["failure"]) => new CloudError({ failure, cause: "" });

export function heldCloud(answerCapabilities: boolean) {
  const capabilities: Gate<typeof offer, CloudError>[] = [];
  const searches: Gate<readonly unknown[], CloudError>[] = [];
  const run = <A>(held: Gate<A, CloudError>) => Effect.runPromise(Effect.result(held.wait)).then((result) => {
    if (result._tag === "Failure") throw result.failure;
    return result.success;
  });
  const client = {
    mapsCapabilities: () => {
      if (answerCapabilities) return Promise.resolve(offer);
      const held = gate<typeof offer, CloudError>();
      capabilities.push(held);
      return run(held);
    },
    mapsPlacesSearch: () => {
      const held = gate<readonly unknown[], CloudError>();
      searches.push(held);
      return run(held).then((places) => ({ providerId: "google", attribution: "Google", places }));
    },
  } as unknown as MapsCloud;
  return { client, capabilities, searches };
}

export function manualClock() {
  const time = { now: 0 };
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => time.now,
    currentTimeMillis: Effect.sync(() => time.now),
    currentTimeNanosUnsafe: () => BigInt(time.now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(time.now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(time.now) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(time.now) * 1_000_000n),
    sleep: () => Effect.never,
  };
  return { time, clock };
}

type ChatReply = { readonly content: string; readonly tool_calls?: readonly { readonly id: string; readonly type: "function"; readonly function: { readonly name: string; readonly arguments: string } }[] };

export function mapsToolCall(name: string, args: Record<string, string>): ChatReply {
  return { content: "", tool_calls: [{ id: randomBytes(8).toString("hex"), type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}

const key = "maps-test-cloud-key";
const execute = promisify(execFile);

async function listen(server: ReturnType<typeof createNetServer>): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No local test port");
  return address.port;
}

async function testCertificate(directory: string) {
  const config = join(directory, "leaf.cnf");
  const keyFile = join(directory, "leaf.key");
  const certFile = join(directory, "leaf.pem");
  await writeFile(config, [
    "[req]", "prompt = no", "distinguished_name = subject", "x509_extensions = ext",
    "[subject]", `CN = maps-test-${randomBytes(8).toString("hex")}`,
    "[ext]", "basicConstraints = critical, CA:TRUE", "keyUsage = critical, digitalSignature, keyCertSign",
    "extendedKeyUsage = serverAuth", "subjectAltName = DNS:localhost, IP:127.0.0.1",
  ].join("\n"));
  await execute("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-config", config, "-keyout", keyFile, "-out", certFile]);
  return { key: await readFile(keyFile, "utf8"), cert: await readFile(certFile, "utf8") };
}

export async function mapsChat(
  plugin: AgentPlugin,
  maps: (request: CloudLinkRequest) => Promise<CloudLinkReply>,
) {
  const directory = await mkdtemp(join(tmpdir(), "maps-chat-"));
  const authorities = getCACertificates("default");
  const prompts: unknown[] = [];
  const answers: ChatReply[] = [];
  const token = randomBytes(32).toString("base64url");
  let server: ReturnType<typeof createServer> | undefined;
  let running: RunningAgent | undefined;
  const close = async () => {
    try {
      await running?.stop();
    } finally {
      server?.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
      setDefaultCACertificates(authorities);
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    const cert = await testCertificate(directory);
    setDefaultCACertificates([...authorities, cert.cert]);
    server = createServer(cert, async (request, response) => {
      const answer = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      try {
        if (request.headers.authorization !== `Bearer ${key}`) return answer(401, { error: "authentication_required" });
        const { method, url: path } = request;
        if (path === undefined || (method !== "GET" && method !== "POST")) return answer(404, { error: "not_found" });
        if (path.endsWith("/models")) return answer(200, { object: "list", data: [{ id: "small" }, { id: "large" }] });
        request.setEncoding("utf8");
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const body: unknown = raw === "" ? undefined : JSON.parse(raw);
        if (path.endsWith("/chat/completions")) {
          prompts.push(body);
          const message = answers.shift();
          if (message === undefined) return answer(500, { error: "unscripted_completion" });
          return answer(200, { choices: [{ message, finish_reason: message.tool_calls === undefined ? "stop" : "tool_calls" }] });
        }
        const idempotencyKey = request.headers["idempotency-key"];
        const result = await maps({ method, path, ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}), ...(body === undefined ? {} : { body }) });
        if (result.kind === "changes-off") return answer(404, { error: "not_found" });
        return answer(result.status, result.body);
      } catch {
        answer(500, { error: "invalid_test_request" });
      }
    });
    const cloudPort = await listen(server);
    const portProbe = createNetServer();
    const port = await listen(portProbe);
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));
    const parsed = await Effect.runPromise(parseLaunch(JSON.stringify({
      schema: 1, character: { name: "Eliza", system: "Help the owner use Maps." },
      policy: { actions: { allowed: ["REPLY", "IGNORE", "NONE", "MAPS_PLACE", "MAPS_NAVIGATION_START"] }, plugins: { load: [plugin.name] } },
      model: { backend: "cloud", cloudBaseUrl: `https://localhost:${cloudPort}`, smallModel: "small", largeModel: "large", imageModel: "small" },
      account: { userId: "maps-owner", organizationId: "maps-test" }, embeddings: "none", persistMemory: false, callerRole: "owner",
    }), JSON.stringify({ version: 1, token, epoch: 1, credential: { version: 1, value: key } })));
    running = await Effect.runPromise(startAgent({ ...parsed, binding: { kind: "http", port }, stateDirectory: directory, bundled: new Map([[plugin.name, plugin]]) }));
    const post = async (path: string, body: object) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const answer: unknown = await response.json();
      return { status: response.status, body: answer };
    };
    const script = (...messages: ChatReply[]) => { answers.push(...messages); };
    return { post, script, prompts, close };
  } catch (cause) {
    await close();
    throw cause;
  }
}
