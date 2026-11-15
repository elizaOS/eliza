/** Boots the agent router against local agent servers and checks the proxy hop. */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  type AddressInfo,
  connect,
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";
import { gzipSync } from "node:zlib";
import {
  __agentRouterTestHooks,
  type StartedAgentRouter,
  startAgentRouter,
} from "./agent-router.ts";

const AGENT_ID = "11111111-2222-4333-8444-555555555555";
const AGENT_HOST = `${AGENT_ID}.cloud.eliza.app`;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function portOf(server: Server | NetServer): number {
  return (server.address() as AddressInfo).port;
}

async function listen(server: Server | NetServer): Promise<number> {
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return portOf(server);
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function agentHandler(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/sse") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let n = 0;
    const timer = setInterval(() => {
      res.write(`data: ${n}\n\n`);
      if (++n === 4) {
        clearInterval(timer);
        res.end();
      }
    }, 100);
    return;
  }
  if (path === "/hang") return;
  if (path === "/body") {
    void readBody(req).then(
      (body) => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            length: body.length,
            contentLength: req.headers["content-length"] ?? null,
            sha256: createHash("sha256").update(body).digest("hex"),
          }),
        );
      },
      () => {},
    ); // the router aborts an over-cap upload mid-stream
    return;
  }
  if (path === "/gzip") {
    res.writeHead(200, {
      "content-type": "text/plain",
      "content-encoding": "gzip",
    });
    res.end(gzipSync("compressed hello"));
    return;
  }
  if (path === "/cookies") {
    res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
    res.end("ok");
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ url: req.url, host: req.headers.host }));
}

// Unmasks one small client text frame and returns it as a server frame.
function echoFrame(frame: Buffer): Buffer {
  const length = frame[1] & 0x7f;
  const mask = frame.subarray(2, 6);
  const payload = Buffer.from(frame.subarray(6, 6 + length));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from([0x81, length]), payload]);
}

function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.setTimeout(5_000, () => {
      socket.destroy();
      resolve(data);
    });
  });
}

function statusOf(response: string): number {
  return Number.parseInt(response.split(" ")[1] ?? "0", 10);
}

describe("agent router", () => {
  let agent: Server;
  let canary: Server;
  let agentPort: number;
  let canaryPort: number;
  let canaryHits = 0;
  let router: StartedAgentRouter;
  let routerPort: number;
  let previousBaseDomain: string | undefined;

  const agentFetch = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${routerPort}${path}`, {
      ...init,
      headers: { "x-forwarded-host": AGENT_HOST, ...init.headers },
    });

  beforeAll(async () => {
    previousBaseDomain = process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;
    delete process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;
    agent = createServer(agentHandler);
    agentPort = await listen(agent);
    canary = createServer((_req, res) => {
      canaryHits++;
      res.end("canary");
    });
    canaryPort = await listen(canary);
    router = await startAgentRouter({
      config: { port: 0, bindHost: "127.0.0.1" },
      warmRoutingDependencies: async () => {},
      findAgentSandboxRoutingById: async (id) =>
        id === AGENT_ID
          ? {
              status: "running",
              bridge_url: `http://127.0.0.1:${agentPort}`,
              bridge_port: agentPort,
              headscale_ip: "127.0.0.1",
              web_ui_port: agentPort,
            }
          : undefined,
      proxyHeadersTimeoutMs: 200,
      maxBodyBytes: MAX_BODY_BYTES,
    });
    await router.warmupSettled;
    routerPort = portOf(router.server);
  });

  afterAll(async () => {
    router.stopWarmup();
    await close(router.server);
    await close(agent);
    await close(canary);
    if (previousBaseDomain === undefined) {
      delete process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;
    } else {
      process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = previousBaseDomain;
    }
  });

  it("answers malformed request targets and hosts without crashing", async () => {
    const cases = [
      "GET // HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      "GET /// HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      "GET //?a HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      "GET //a:b HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      "GET / HTTP/1.1\r\nHost: a^b\r\nConnection: close\r\n\r\n",
      "GET / HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n",
      "GET http://evil.test/ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      "OPTIONS * HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    ];
    for (const request of cases) {
      const status = statusOf(await rawRequest(routerPort, request));
      expect([400, 404]).toContain(status);
    }
    const health = await fetch(`http://127.0.0.1:${routerPort}/healthz`);
    expect(health.status).toBe(200);
  });

  it("keeps authority-looking paths on the routed agent target", async () => {
    for (const path of [
      `//a//127.0.0.1:${canaryPort}/p`,
      `/.//127.0.0.1:${canaryPort}/x`,
    ]) {
      const response = await rawRequest(
        routerPort,
        `GET ${path} HTTP/1.1\r\nHost: ${AGENT_HOST}\r\nConnection: close\r\n\r\n`,
      );
      expect(statusOf(response)).toBe(200);
      const body = JSON.parse(
        response.slice(response.indexOf("{"), response.lastIndexOf("}") + 1),
      );
      expect(body.host).toBe(`127.0.0.1:${agentPort}`);
      expect(body.url).toContain(`127.0.0.1:${canaryPort}/`);
    }
    expect(canaryHits).toBe(0);
  });

  it("proxies a plain request with path and query", async () => {
    const response = await agentFetch("/hello?a=1");
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      url: "/hello?a=1",
      host: `127.0.0.1:${agentPort}`,
    });
  });

  it("does not cut a stream that outlives the headers budget", async () => {
    const response = await agentFetch("/sse");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      "data: 0\n\ndata: 1\n\ndata: 2\n\ndata: 3\n\n",
    );
  });

  it("returns 504 agent_timeout when the agent never sends headers", async () => {
    const response = await agentFetch("/hang");
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: "agent_timeout" });
  });

  it("streams a 1 MiB POST body intact", async () => {
    const body = Buffer.alloc(1024 * 1024, 7);
    const response = await agentFetch("/body", { method: "POST", body });
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      length: body.length,
      contentLength: `${body.length}`,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
  });

  it("streams a chunked POST body and caps it without a content-length", async () => {
    const chunked = (size: number) =>
      rawRequest(
        routerPort,
        `POST /body HTTP/1.1\r\nHost: ${AGENT_HOST}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${size.toString(16)}\r\n${"a".repeat(size)}\r\n0\r\n\r\n`,
      );
    const small = await chunked(1024);
    expect(statusOf(small)).toBe(200);
    expect(small).toContain(
      createHash("sha256").update("a".repeat(1024)).digest("hex"),
    );
    expect(statusOf(await chunked(MAX_BODY_BYTES + 1))).toBe(413);
  });

  it("rejects a body over the cap with 413", async () => {
    const response = await agentFetch("/body", {
      method: "POST",
      body: Buffer.alloc(MAX_BODY_BYTES + 1, 1),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      code: "request_body_too_large",
    });
  });

  it("drops the upstream encoding after fetch decodes the body", async () => {
    const response = await agentFetch("/gzip");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe("compressed hello");
  });

  it("forwards every Set-Cookie header", async () => {
    const response = await agentFetch("/cookies");
    expect(response.headers.getSetCookie()).toEqual([
      "a=1; Path=/",
      "b=2; Path=/",
    ]);
  });
});

describe("agent router WebSocket relay", () => {
  it("relays an upgrade to the routed agent and echoes a frame", async () => {
    // Agent: completes the handshake by hand and echoes small text frames.
    let agentRequestHead = "";
    const agent = createNetServer((sock) => {
      let buffered = Buffer.alloc(0);
      let upgraded = false;
      sock.on("data", (chunk: Buffer) => {
        if (upgraded) {
          sock.write(echoFrame(chunk));
          return;
        }
        buffered = Buffer.concat([buffered, chunk]);
        const end = buffered.indexOf("\r\n\r\n");
        if (end < 0) return;
        agentRequestHead = buffered.subarray(0, end).toString("utf8");
        const key = /sec-websocket-key: (.+)/i.exec(agentRequestHead)?.[1];
        const accept = createHash("sha1")
          .update(`${key?.trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        upgraded = true;
        sock.write(
          `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
        );
        const rest = buffered.subarray(end + 4);
        if (rest.length > 0) sock.write(echoFrame(rest));
      });
    });
    const agentPort = await listen(agent);
    // Front: hands each raw connection to the router's upgrade relay.
    const front = createNetServer((sock) => {
      const req = {
        url: "/ws?x=1",
        method: "GET",
        headers: {
          host: "control-plane.internal",
          "x-forwarded-host": AGENT_HOST,
          upgrade: "websocket",
          connection: "Upgrade",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
        },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage;
      void __agentRouterTestHooks.relayAgentUpgrade(
        req,
        sock,
        Buffer.alloc(0),
        async () => ({
          status: "running",
          bridge_url: `http://127.0.0.1:${agentPort}`,
          bridge_port: agentPort,
          headscale_ip: "127.0.0.1",
          web_ui_port: agentPort,
        }),
      );
    });
    const frontPort = await listen(front);
    try {
      const client = connect(frontPort, "127.0.0.1");
      let received = Buffer.alloc(0);
      client.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
      });
      const waitFor = async (predicate: () => boolean) => {
        for (let i = 0; i < 200 && !predicate(); i++) await sleep(10);
      };
      await waitFor(() => received.includes("\r\n\r\n"));
      const response = received.toString("utf8");
      expect(response.startsWith("HTTP/1.1 101")).toBe(true);
      expect(agentRequestHead.split("\r\n")[0]).toBe("GET /ws?x=1 HTTP/1.1");
      expect(agentRequestHead).toMatch(/^upgrade: websocket$/m);
      expect(agentRequestHead).toMatch(/^connection: upgrade$/m);
      expect(agentRequestHead).toMatch(
        new RegExp(`^host: 127\\.0\\.0\\.1:${agentPort}$`, "m"),
      );

      const handshakeLength = received.indexOf("\r\n\r\n") + 4;
      const mask = Buffer.from([1, 2, 3, 4]);
      const payload = Buffer.from("ping");
      const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      client.write(
        Buffer.concat([
          Buffer.from([0x81, 0x80 | payload.length]),
          mask,
          masked,
        ]),
      );
      await waitFor(() => received.length >= handshakeLength + 6);
      expect([...received.subarray(handshakeLength)]).toEqual([
        0x81,
        4,
        ...payload,
      ]);
      client.destroy();
    } finally {
      await new Promise<void>((resolve) => front.close(() => resolve()));
      await new Promise<void>((resolve) => agent.close(() => resolve()));
    }
  });
});

describe("agent router warmup", () => {
  it("retries a failed warmup until ready while /healthz stays up", async () => {
    let calls = 0;
    const router = await startAgentRouter({
      config: { port: 0, bindHost: "127.0.0.1" },
      warmRoutingDependencies: async () => {
        calls++;
        if (calls <= 2) throw new Error("database unavailable");
      },
      warmupRetryDelayMs: 10,
      onWarmupError: () => {},
    });
    const base = `http://127.0.0.1:${portOf(router.server)}`;
    try {
      await router.warmupSettled;
      expect(router.readiness.status).toBe("failed");
      expect((await fetch(`${base}/readyz`)).status).toBe(503);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      for (let i = 0; i < 100 && router.readiness.status !== "ready"; i++) {
        await sleep(10);
      }
      expect(calls).toBe(3);
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
    } finally {
      router.stopWarmup();
      await close(router.server);
    }
  });

  it("counts a late success from a timed-out attempt", async () => {
    const router = await startAgentRouter({
      config: { port: 0, bindHost: "127.0.0.1" },
      warmRoutingDependencies: async () => {
        await sleep(60);
      },
      warmupTimeoutMs: 10,
      warmupRetryDelayMs: 60_000,
      onWarmupError: () => {},
    });
    try {
      await router.warmupSettled;
      expect(router.readiness.status).toBe("failed");
      await sleep(100);
      expect(router.readiness.status).toBe("ready");
    } finally {
      router.stopWarmup();
      await close(router.server);
    }
  });
});
