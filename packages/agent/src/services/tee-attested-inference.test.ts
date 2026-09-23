/**
 * Exercises actual TLS sockets, certificates, exporters, guest Unix sockets and
 * pinned subprocess appraisal. Quote responses are explicitly synthetic fixtures;
 * these tests prove transport ownership, not platform hardware cryptography.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import {
  connect as connectTcp,
  createServer as createTcpServer,
  type Server as TcpServer,
} from "node:net";
import { join } from "node:path";
import {
  connect,
  createServer as createTlsServer,
  type Server,
} from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AttestedInferenceClientConfig,
  type AttestedInferenceServerConfig,
  createAttestedInferenceFetch,
  createAttestedInferenceServer,
} from "./tee-attested-inference.ts";
import type { DstackVerifierConfig } from "./tee-dstack-evidence.ts";
import { createDstackAttestedInferenceServer } from "./tee-dstack-tls-identity.ts";

let dir: string;
let guest: HttpServer;
let server: Server;
let intermediary: Server | TcpServer | undefined;
let key: string;
let cert: string;
let port: number;
let received: string[];
let responseStatus: number;
let quotes: string[];
let corrupt: boolean;
let replay: boolean;
let audit: AttestedInferenceClientConfig["beforeDispatch"];
let config: DstackVerifierConfig;
let issueKey: string | undefined;
let issueStatus: number;
let issueRequests: Record<string, unknown>[];
const policy = { routeId: "private-inference", revision: "release-1" };
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const listen = (s: Server | TcpServer) =>
  new Promise<number>((resolve) =>
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      if (address && typeof address !== "string") resolve(address.port);
    }),
  );
const close = (s: Server | TcpServer | HttpServer) =>
  new Promise<void>((resolve, reject) =>
    s.close((error) => (error ? reject(error) : resolve())),
  );

beforeEach(async () => {
  dir = await mkdtemp("/tmp/etls-");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  key = await readFile(join(dir, "key.pem"), "utf8");
  cert = await readFile(join(dir, "cert.pem"), "utf8");
  issueKey = undefined;
  issueStatus = 200;
  issueRequests = [];
  responseStatus = 200;
  received = [];
  quotes = [];
  corrupt = false;
  replay = false;
  intermediary = undefined;
  audit = async () => {};
  const script = `#!${process.execPath}\nconst fs=require('node:fs'); const data=JSON.parse(fs.readFileSync(process.argv.at(-1),'utf8')); process.stdout.write(Buffer.from(data.attestation,'hex').toString('utf8'));`;
  await writeFile(join(dir, "verifier"), script, { mode: 0o700 });
  await writeFile(join(dir, "config.toml"), "# synthetic quote verifier\n");
  config = {
    verifierPath: join(dir, "verifier"),
    verifierSha256: digest(script),
    verifierConfigPath: join(dir, "config.toml"),
    verifierConfigSha256: digest("# synthetic quote verifier\n"),
    appId: "11".repeat(20),
    composeHash: "22".repeat(32),
    osImageHash: "33".repeat(32),
    variant: "dstack-tdx",
    timeoutMs: 10000,
  };
  guest = createHttpServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const input = JSON.parse(Buffer.concat(parts).toString());
    if (req.url === "/v1/IssueCert") {
      issueRequests.push(input);
      res.statusCode = issueStatus;
      res.end(
        JSON.stringify({ key: issueKey ?? key, certificate_chain: [cert] }),
      );
      return;
    }
    const attestation = Buffer.from(
      JSON.stringify({
        is_valid: true,
        details: {
          quote_verified: true,
          event_log_verified: true,
          os_image_hash_verified: true,
          tee_variant: "dstack-tdx",
          report_data: (corrupt ? "aa".repeat(32) : input.report_data).padEnd(
            128,
            "0",
          ),
          tcb_status: "UpToDate",
          advisory_ids: [],
          os_image_is_dev: false,
          acpi_tables_verified: true,
          app_info: {
            app_id: config.appId,
            compose_hash: config.composeHash,
            os_image_hash: config.osImageHash,
            mr_aggregated: "44".repeat(32),
          },
        },
      }),
    ).toString("hex");
    quotes.push(attestation);
    res.end(JSON.stringify({ attestation: replay ? quotes[0] : attestation }));
  });
  await new Promise<void>((resolve) =>
    guest.listen(join(dir, "guest.sock"), resolve),
  );
  server = await createDstackAttestedInferenceServer({
    dnsName: "localhost",
    guestSocketPath: join(dir, "guest.sock"),
    policy,
    timeoutMs: 10000,
    handle: async (request) => {
      received.push(
        request.headers.get("authorization") ?? "missing",
        await request.text(),
      );
      return new Response("complete response", { status: responseStatus });
    },
  });
  port = await listen(server);
});
afterEach(async () => {
  if (intermediary) await close(intermediary);
  await close(server);
  await close(guest);
  await rm(dir, { recursive: true, force: true });
});
function transport(
  options: {
    port?: number;
    ca?: string;
    maxPayloadBytes?: number;
    policy?: typeof policy;
  } = {},
) {
  return createAttestedInferenceFetch({
    origin: `https://localhost:${options.port ?? port}`,
    ca: options.ca ?? cert,
    policy: options.policy ?? policy,
    verifier: config,
    maxPayloadBytes: options.maxPayloadBytes,
    beforeDispatch: async (context) => audit(context),
  });
}
function invoke(
  fetcher = transport(),
  targetPort = port,
  signal?: AbortSignal,
) {
  return fetcher(`https://localhost:${targetPort}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer private-secret" },
    body: "complete private prompt",
    signal,
  });
}

describe("attested inference TLS admission", () => {
  it("obtains its listener key only from private guest IssueCert without a caller key", async () => {
    expect(issueRequests).toHaveLength(1);
    expect(issueRequests[0]).not.toHaveProperty("key");
    expect(issueRequests[0]).not.toHaveProperty("public_key");
    expect(await (await invoke()).text()).toBe("complete response");
  });
  it("rejects a certificate response whose key does not match", async () => {
    issueKey = generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    await expect(
      createDstackAttestedInferenceServer({
        dnsName: "localhost",
        guestSocketPath: join(dir, "guest.sock"),
        policy,
        handle: async () => new Response("unexpected"),
      }),
    ).rejects.toThrow();
  });
  it("does not create a listener when private certificate issuance fails", async () => {
    issueStatus = 503;
    await expect(
      createDstackAttestedInferenceServer({
        dnsName: "localhost",
        guestSocketPath: join(dir, "guest.sock"),
        policy,
        handle: async () => new Response("unexpected"),
      }),
    ).rejects.toThrow();
  });
  it("withholds credentials and complete prompt until verified proof and durable audit", async () => {
    let finish!: () => void;
    let entered!: () => void;
    const enteredAudit = new Promise<void>((resolve) => {
      entered = resolve;
    });
    audit = () => {
      entered();
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    const result = invoke();
    await enteredAudit;
    expect(quotes).toHaveLength(1);
    expect(received).toEqual([]);
    finish();
    expect(await (await result).text()).toBe("complete response");
    expect(received).toEqual([
      "Bearer private-secret",
      "complete private prompt",
    ]);
  });
  it("binds the durable audit callback to proof and connection digests without plaintext", async () => {
    let receipt:
      | Parameters<AttestedInferenceClientConfig["beforeDispatch"]>[0]
      | undefined;
    audit = async (context) => {
      receipt = context;
    };
    await invoke();
    expect(receipt?.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt?.connectionBindingDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain("private-secret");
    expect(JSON.stringify(receipt)).not.toContain("private prompt");
  });
  it("snapshots approved remote identity instead of following caller mutation", async () => {
    const fetcher = transport();
    config.composeHash = "99".repeat(32);
    await expect(invoke(fetcher)).rejects.toThrow();
    expect(received).toEqual([]);
  });
  it("aborts a stalled audit without exposing credentials", async () => {
    const controller = new AbortController();
    audit = async () => {
      controller.abort();
      await new Promise<void>(() => undefined);
    };
    await expect(
      invoke(transport(), port, controller.signal),
    ).rejects.toThrow();
    expect(received).toEqual([]);
  });
  it("rechecks release expiry after the durable audit completes", async () => {
    const expires = Date.now() + 2000;
    config.releaseValidity = {
      notBefore: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(expires).toISOString(),
    };
    let entered = false;
    audit = async () => {
      entered = true;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, expires - Date.now()) + 25),
      );
    };
    await expect(invoke()).rejects.toThrow();
    expect(entered).toBe(true);
    expect(received).toEqual([]);
  });
  it("refuses TLS verification bypass before any network traffic", async () => {
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      await expect(invoke()).rejects.toThrow();
      expect(quotes).toEqual([]);
      expect(received).toEqual([]);
    } finally {
      if (previous === undefined)
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  });
  it("rejects redirects without a second dispatch", async () => {
    responseStatus = 302;
    await expect(invoke()).rejects.toMatchObject({
      context: { dispatchState: "possibly-sent" },
    });
    expect(quotes).toHaveLength(1);
    expect(received).toHaveLength(2);
  });
  it("keeps the measured handler, quote socket and limit despite caller mutation", async () => {
    const settings: AttestedInferenceServerConfig = {
      key,
      cert,
      guestSocketPath: join(dir, "guest.sock"),
      policy,
      maxPayloadBytes: 1024,
      handle: async (request) => new Response(await request.text()),
    };
    intermediary = createAttestedInferenceServer(settings);
    const otherPort = await listen(intermediary);
    settings.handle = async () => {
      throw new Error("replacement handler must not run");
    };
    settings.guestSocketPath = join(dir, "replaced.sock");
    settings.maxPayloadBytes = 1;
    expect(
      await (await invoke(transport({ port: otherPort }), otherPort)).text(),
    ).toBe("complete private prompt");
  });
  it("observes and cancels a late handler response after the client disconnects", async () => {
    let entered!: () => void;
    let finish!: (value: Response) => void;
    let cancelled!: () => void;
    const handling = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    intermediary = createAttestedInferenceServer({
      key,
      cert,
      guestSocketPath: join(dir, "guest.sock"),
      policy,
      handle: async () => {
        entered();
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      },
    });
    const otherPort = await listen(intermediary);
    const controller = new AbortController();
    const outcome = invoke(
      transport({ port: otherPort }),
      otherPort,
      controller.signal,
    );
    const rejected = expect(outcome).rejects.toMatchObject({
      context: { dispatchState: "possibly-sent" },
    });
    await handling;
    controller.abort();
    await rejected;
    finish(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled();
          },
        }),
      ),
    );
    await cancellation;
  });
  it("never exposes a public arbitrary report-data quote endpoint", async () => {
    const socket = connect({
      host: "localhost",
      port,
      servername: "localhost",
      ca: cert,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      ALPNProtocols: ["eliza-attested-inference/1"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("close", () => resolve());
        socket.once("secureConnect", () => {
          const body = Buffer.from(
            JSON.stringify({
              nonce: "ab".repeat(32),
              policy,
              report_data: "cd".repeat(32),
            }),
          );
          const length = Buffer.alloc(4);
          length.writeUInt32BE(body.length);
          socket.write(Buffer.concat([length, body]));
        });
      });
      expect(quotes).toEqual([]);
      expect(received).toEqual([]);
    } finally {
      socket.destroy();
    }
  });
  it("carries end-to-end TLS over a snapshotted Unix forwarder without changing logical origin", async () => {
    let connections = 0;
    const wire: Buffer[] = [];
    const serverNames: string[] = [];
    server.on("secureConnection", (socket) => {
      if ("servername" in socket && typeof socket.servername === "string")
        serverNames.push(socket.servername);
    });
    intermediary = createTcpServer((outer) => {
      connections++;
      const inner = connectTcp({ host: "127.0.0.1", port });
      outer.on("data", (chunk) => wire.push(Buffer.from(chunk)));
      outer.pipe(inner).pipe(outer);
      outer.on("error", () => inner.destroy());
      inner.on("error", () => outer.destroy());
      outer.on("close", () => inner.destroy());
    });
    const path = join(dir, "forwarder.sock");
    const relay = intermediary;
    await new Promise<void>((resolve) => relay.listen(path, resolve));
    const settings: AttestedInferenceClientConfig = {
      origin: "https://localhost:65534",
      unixSocketPath: path,
      ca: cert,
      policy,
      verifier: config,
      beforeDispatch: async (context) => audit(context),
    };
    const fetcher = createAttestedInferenceFetch(settings);
    settings.unixSocketPath = join(dir, "substituted.sock");
    const init = {
      method: "POST",
      headers: { authorization: "Bearer private-secret" },
      body: "complete private prompt",
      unixSocketPath: join(dir, "request-controlled.sock"),
    };
    expect(
      await (
        await fetcher("https://localhost:65534/v1/chat/completions", init)
      ).text(),
    ).toBe("complete response");
    expect(connections).toBe(1);
    expect(serverNames).toEqual(["localhost"]);
    expect(quotes).toHaveLength(1);
    expect(received).toEqual([
      "Bearer private-secret",
      "complete private prompt",
    ]);
    expect(Buffer.concat(wire).includes(Buffer.from("private-secret"))).toBe(
      false,
    );
    expect(Buffer.concat(wire).includes(Buffer.from("private prompt"))).toBe(
      false,
    );
  });
  it("validates the approved DNS identity even when the Unix relay connects a trusted wrong peer", async () => {
    let connections = 0;
    intermediary = createTcpServer((outer) => {
      connections++;
      const inner = connectTcp({ host: "127.0.0.1", port });
      outer.pipe(inner).pipe(outer);
      outer.on("error", () => inner.destroy());
      inner.on("error", () => outer.destroy());
      outer.on("close", () => inner.destroy());
    });
    const path = join(dir, "wrong-peer.sock");
    const relay = intermediary;
    await new Promise<void>((resolve) => relay.listen(path, resolve));
    const fetcher = createAttestedInferenceFetch({
      origin: "https://wrong-peer.invalid",
      unixSocketPath: path,
      ca: cert,
      policy,
      verifier: config,
      beforeDispatch: async () => {
        throw new Error("audit must not run");
      },
    });
    await expect(
      fetcher("https://wrong-peer.invalid/v1/chat/completions", {
        method: "POST",
        body: "private prompt",
      }),
    ).rejects.toMatchObject({ context: { dispatchState: "not-sent" } });
    expect(connections).toBe(1);
    expect(quotes).toEqual([]);
    expect(received).toEqual([]);
  });
  it("rejects a different request origin before dialing the approved Unix relay", async () => {
    let connections = 0;
    intermediary = createTcpServer((socket) => {
      connections++;
      socket.destroy();
    });
    const path = join(dir, "origin-guard.sock");
    const relay = intermediary;
    await new Promise<void>((resolve) => relay.listen(path, resolve));
    const fetcher = createAttestedInferenceFetch({
      origin: "https://localhost",
      unixSocketPath: path,
      ca: cert,
      policy,
      verifier: config,
      beforeDispatch: async () => undefined,
    });
    await expect(
      fetcher("https://different.invalid/v1/chat/completions", {
        method: "POST",
        body: "private prompt",
      }),
    ).rejects.toThrow();
    expect(connections).toBe(0);
    expect(quotes).toEqual([]);
    expect(received).toEqual([]);
  });
  it("never falls back to reachable TCP when the configured Unix socket is unavailable", async () => {
    const fetcher = createAttestedInferenceFetch({
      origin: `https://localhost:${port}`,
      unixSocketPath: join(dir, "unavailable.sock"),
      ca: cert,
      policy,
      verifier: config,
      beforeDispatch: async () => undefined,
    });
    await expect(invoke(fetcher)).rejects.toThrow();
    expect(quotes).toEqual([]);
    expect(received).toEqual([]);
  });
  it("observes a refused real Unix connection as not-sent without TCP fallback", async () => {
    const path = join(dir, "stale-forwarder.sock");
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {createServer} from "node:net"; createServer(()=>{}).listen(${JSON.stringify(path)},()=>process.stdout.write("ready"));`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () =>
          reject(new Error("Unix relay exited before readiness")),
        );
        child.stdout.once("data", () => resolve());
      });
      child.kill("SIGKILL");
      await closed;
      expect((await lstat(path)).isSocket()).toBe(true);
      const fetcher = createAttestedInferenceFetch({
        origin: `https://localhost:${port}`,
        unixSocketPath: path,
        ca: cert,
        policy,
        verifier: config,
        beforeDispatch: async () => {
          throw new Error("Audit must not run");
        },
      });
      await expect(invoke(fetcher)).rejects.toMatchObject({
        code: "TEE_INFERENCE_TRANSPORT_REJECTED",
        context: { dispatchState: "not-sent" },
      });
      expect(quotes).toEqual([]);
      expect(received).toEqual([]);
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  });
  it.each(["relative.sock", "/tmp/invalid\0socket"])(
    "rejects invalid constructor dial target %s",
    (path) => {
      expect(() =>
        createAttestedInferenceFetch({
          origin: "https://localhost",
          unixSocketPath: path,
          ca: cert,
          policy,
          verifier: config,
          beforeDispatch: async () => undefined,
        }),
      ).toThrow();
    },
  );
  it("rejects changed report data before application dispatch", async () => {
    corrupt = true;
    await expect(invoke()).rejects.toMatchObject({
      context: { dispatchState: "not-sent" },
    });
    expect(received).toEqual([]);
  });
  it("rejects proof replay from a previous real TLS session", async () => {
    await invoke();
    received = [];
    replay = true;
    await expect(invoke()).rejects.toThrow();
    expect(received).toEqual([]);
  });
  it("rejects a changed route revision", async () => {
    await expect(
      invoke(transport({ policy: { ...policy, revision: "other" } })),
    ).rejects.toThrow();
    expect(received).toEqual([]);
  });
  it("rejects an untrusted certificate before quoting or sending secrets", async () => {
    await expect(invoke(transport({ ca: "" }))).rejects.toThrow();
    expect(quotes).toEqual([]);
    expect(received).toEqual([]);
  });
  it("fails closed when durable audit fails", async () => {
    audit = async () => {
      throw new Error("durable commit failed");
    };
    await expect(invoke()).rejects.toThrow();
    expect(received).toEqual([]);
  });
  it("rejects complete oversized requests before connection and never truncates", async () => {
    await expect(invoke(transport({ maxPayloadBytes: 4 }))).rejects.toThrow();
    expect(quotes).toEqual([]);
    expect(received).toEqual([]);
  });
  it("checks cancellation again after durable audit before bytes", async () => {
    const controller = new AbortController();
    audit = async () => {
      controller.abort();
    };
    await expect(
      invoke(transport(), port, controller.signal),
    ).rejects.toThrow();
    expect(received).toEqual([]);
  });
  it("rejects TLS termination and re-encryption despite a valid service quote", async () => {
    const intercepted: Buffer[] = [];
    intermediary = createTlsServer(
      {
        key,
        cert,
        minVersion: "TLSv1.3",
        ALPNProtocols: ["eliza-attested-inference/1"],
      },
      (outer) => {
        const inner = connect({
          host: "localhost",
          port,
          ca: cert,
          servername: "localhost",
          rejectUnauthorized: true,
          minVersion: "TLSv1.3",
          ALPNProtocols: ["eliza-attested-inference/1"],
        });
        outer.on("data", (chunk) => intercepted.push(Buffer.from(chunk)));
        outer.pipe(inner).pipe(outer);
        outer.on("error", () => inner.destroy());
        inner.on("error", () => outer.destroy());
        outer.on("close", () => inner.destroy());
      },
    );
    const proxyPort = await listen(intermediary);
    await expect(
      invoke(transport({ port: proxyPort }), proxyPort),
    ).rejects.toThrow();
    expect(quotes).toHaveLength(1);
    expect(received).toEqual([]);
    expect(Buffer.concat(intercepted).toString()).not.toContain(
      "private-secret",
    );
    expect(Buffer.concat(intercepted).toString()).not.toContain(
      "private prompt",
    );
  });
  it("allows transparent TCP relay because TLS still terminates in the measured server", async () => {
    intermediary = createTcpServer((outer) => {
      const inner = connectTcp({ host: "127.0.0.1", port });
      outer.pipe(inner).pipe(outer);
      outer.on("error", () => inner.destroy());
      inner.on("error", () => outer.destroy());
      outer.on("close", () => inner.destroy());
    });
    const proxyPort = await listen(intermediary);
    expect(
      await (await invoke(transport({ port: proxyPort }), proxyPort)).text(),
    ).toBe("complete response");
    expect(received).toEqual([
      "Bearer private-secret",
      "complete private prompt",
    ]);
  });
});
