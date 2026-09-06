/**
 * Wire-fidelity e2e for the direct WeChat plugin against a local Tencent wire
 * server (review PRR_kwDOMT5cIs8AAAABLXCB7Q, #29751 / #24371).
 *
 * The harness drives the REAL plugin path end-to-end: `wechatPlugin.init()`
 * resolves configuration, registers the ConnectorAccountProvider (status
 * observed through `getConnectorAccountManager().listAccounts("wechat")`) and
 * the MessageConnector (driven through its registered `sendHandler`), boots the
 * real WechatChannel (real public callback HTTP server, real SHA-1
 * verification, real AES-256-CBC decrypt with framing-receiver + inner-receiver
 * + AgentID binding), and runs the real TokenManager/WechatApiClient outbound
 * stack against the fixed platform hosts. The runtime is a real PGLite-backed
 * AgentRuntime from `@elizaos/core/testing` with a deterministic
 * RESPONSE_HANDLER provider. The only redirected seam is the network
 * transport: `globalThis.fetch` rewrites the hardcoded `api.weixin.qq.com` /
 * `qyapi.weixin.qq.com` hosts to a local wire server that INDEPENDENTLY
 * implements the Tencent side (its own node:crypto SHA-1 signing and
 * AES-256-CBC 32-byte PKCS#7 framing — it imports no plugin crypto) and
 * records every outbound request verbatim (original URL, method, headers,
 * body) for exact fidelity assertions. No plugin module is mocked; the
 * runtime's messageService.handleMessage is wrapped only to COUNT pipeline
 * invocations, never to alter behavior.
 *
 * Scope note: this harness drives the plugin entrypoint directly with an
 * explicit config object plus the matching character-settings wiring the
 * plugin's account provider reads; it does NOT exercise host boot or the
 * host's connector-config propagation (the elizaOS host connector projection
 * currently covers Slack only), so it is plugin-level wire evidence, not
 * host-boot evidence.
 */

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { createServer as netServer } from "node:net";
import {
  getConnectorAccountManager,
  logger,
  ModelType,
  stringToUuid,
} from "@elizaos/core";
import {
  createTestRuntimeWithModelProvider,
  type ModelProviderTestRuntime,
} from "@elizaos/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import wechatPluginDefault from "../src/index";

// ---------------------------------------------------------------------------
// Independent Tencent-side wire crypto (deliberately NOT imported from the
// plugin: the platform signs/encrypts with its own implementation and the
// plugin must accept it).
// ---------------------------------------------------------------------------

const AES_BLOCK = 32;

function sha1Of(...parts: string[]): string {
  return createHash("sha1")
    .update([...parts].sort().join(""), "utf8")
    .digest("hex");
}

function decodeKey(encodingAESKey: string): Buffer {
  const key = Buffer.from(`${encodingAESKey}=`, "base64");
  if (key.length < 32) throw new Error("bad key length");
  return key.subarray(0, 32);
}

function pkcs7Pad32(data: Buffer): Buffer {
  const pad = AES_BLOCK - (data.length % AES_BLOCK);
  return Buffer.concat([data, Buffer.alloc(pad, pad)]);
}

/** Tencent-side encrypt: random(16) + len(4) + message + receiver, PKCS#7-32. */
function platformEncrypt(
  plaintext: string,
  receiverId: string,
  encodingAESKey: string,
): string {
  const key = decodeKey(encodingAESKey);
  const message = Buffer.from(plaintext, "utf8");
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(message.length, 0);
  const padded = pkcs7Pad32(
    Buffer.concat([
      randomBytes(16),
      lengthBuf,
      message,
      Buffer.from(receiverId, "utf8"),
    ]),
  );
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString(
    "base64",
  );
}

function buildXml(root: string, fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([k, v]) => `<${k}><![CDATA[${v}]]></${k}>`)
    .join("\n");
  return `<${root}>\n${body}\n</${root}>`;
}

// ---------------------------------------------------------------------------
// Outbound request record: captured by the fetch redirect BEFORE rewriting,
// so fidelity assertions run against exactly what production emitted.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  originalUrl: string;
  method: string;
  contentType: string | undefined;
  bodyText: string | undefined;
}

interface WireSendReceipt {
  url: string;
  accessToken: string;
  body: unknown;
  at: number;
}

interface WireServer {
  url: string;
  close(): Promise<void>;
  sends: WireSendReceipt[];
  oaTokenCalls: Array<{ body: unknown }>;
  wecomTokenCalls: Array<{ corpid: string; corpsecret: string }>;
  /** OA tokens the endpoint will issue, in order (rotation support). */
  oaTokenIssueQueue: string[];
  /** Content-matched rejections: reply content -> errcode. */
  rejectContent: Map<string, number>;
  /** Platform-side credential rotation: honor (and issue) only `token` now. */
  rotateOaToken(token: string): void;
}

function startWireServer(): Promise<WireServer> {
  const sends: WireSendReceipt[] = [];
  const oaTokenCalls: Array<{ body: unknown }> = [];
  const wecomTokenCalls: Array<{ corpid: string; corpsecret: string }> = [];
  const oaTokenIssueQueue = ["OA_E2E_TOKEN_1", "OA_E2E_TOKEN_2"];
  const rejectContent = new Map<string, number>();
  /** The token the platform currently honors for OA sends. */
  let currentOaToken = "OA_E2E_TOKEN_1";

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "";
      let parsedBody: unknown;
      try {
        parsedBody = bodyText ? JSON.parse(bodyText) : undefined;
      } catch {
        parsedBody = undefined;
      }
      res.setHeader("Content-Type", "application/json");
      const json = (status: number, payload: unknown) => {
        res.writeHead(status);
        res.end(JSON.stringify(payload));
      };

      if (url.startsWith("/cgi-bin/stable_token")) {
        oaTokenCalls.push({ body: parsedBody });
        const b = parsedBody as
          | { appid?: unknown; secret?: unknown }
          | undefined;
        if (b?.appid === "wx-e2e-appid" && b?.secret === "oa-e2e-secret") {
          const next = oaTokenIssueQueue.shift();
          if (next) currentOaToken = next;
          return json(200, { access_token: currentOaToken, expires_in: 7200 });
        }
        return json(200, { errcode: 40001, errmsg: "invalid credential" });
      }

      if (url.startsWith("/cgi-bin/gettoken")) {
        const u = new URL(url, "http://wire");
        const corpid = u.searchParams.get("corpid") ?? "";
        const corpsecret = u.searchParams.get("corpsecret") ?? "";
        wecomTokenCalls.push({ corpid, corpsecret });
        if (corpid === "ww-e2e-corp" && corpsecret === "wecom-e2e-secret") {
          return json(200, {
            access_token: "WECOM_E2E_TOKEN_1",
            expires_in: 7200,
          });
        }
        return json(200, { errcode: 40001, errmsg: "invalid credential" });
      }

      if (
        url.startsWith("/cgi-bin/message/custom/send") ||
        url.startsWith("/cgi-bin/message/send")
      ) {
        const u = new URL(url, "http://wire");
        const accessToken = u.searchParams.get("access_token") ?? "";
        sends.push({ url, accessToken, body: parsedBody, at: Date.now() });
        const expectedToken = url.startsWith("/cgi-bin/message/custom/send")
          ? currentOaToken
          : "WECOM_E2E_TOKEN_1";
        if (accessToken !== expectedToken) {
          return json(200, { errcode: 40001, errmsg: "invalid access token" });
        }
        const body = parsedBody as { text?: { content?: string } } | undefined;
        const rejectCode = body?.text?.content
          ? rejectContent.get(body.text.content)
          : undefined;
        if (rejectCode !== undefined) {
          return json(200, { errcode: rejectCode, errmsg: "api forbidden" });
        }
        return json(200, { errcode: 0, errmsg: "ok" });
      }

      return json(404, { errcode: -1, errmsg: "unknown path" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        sends,
        oaTokenCalls,
        wecomTokenCalls,
        oaTokenIssueQueue,
        rejectContent,
        rotateOaToken: (token: string) => {
          currentOaToken = token;
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Structured-log capture (the plugin logs through the @elizaos/core logger).
// ---------------------------------------------------------------------------

type LogSink = { level: string; args: unknown[] }[];

function captureLogsOn(target: unknown, sink: LogSink): () => void {
  const levels = ["log", "info", "warn", "error", "debug"] as const;
  const originals = new Map<string, unknown>();
  const record = target as Record<string, unknown>;
  for (const level of levels) {
    const original = record[level];
    if (typeof original === "function") {
      originals.set(level, original);
      record[level] = (...args: unknown[]) => {
        sink.push({ level, args });
        (original as (...a: unknown[]) => void)(...args);
      };
    }
  }
  return () => {
    for (const [level, original] of originals) {
      record[level] = original;
    }
  };
}

function capturePluginLogs(sink: LogSink): () => void {
  return captureLogsOn(logger, sink);
}

function sinkText(sink: LogSink): string[] {
  return sink.map((entry) => {
    const text = entry.args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    return `[${entry.level}] ${text}`;
  });
}

// ---------------------------------------------------------------------------
// Harness: real runtime + real plugin init() with the transport redirected.
// ---------------------------------------------------------------------------

const OA_TOKEN_SECRET = "oa-token-secret-e2e";
const WECOM_TOKEN_SECRET = "wecom-token-secret-e2e";
const WECOM_AES_KEY = Buffer.from("fedcba9876543210fedcba9876543210")
  .toString("base64")
  .replace(/=+$/, "")
  .slice(0, 43)
  .padEnd(43, "A");
const DEFAULT_REPLY = "Wire-e2e reply from the deterministic provider.";

const REAL_FETCH = globalThis.fetch;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = netServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

interface Harness {
  runtime: ModelProviderTestRuntime;
  wire: WireServer;
  requests: RecordedRequest[];
  logs: LogSink;
  callbackPort: number;
  pipelineCalls: { handleMessage: number };
  restoreFetch(): void;
  stop(): Promise<void>;
}

async function startHarness(
  options: { officialSecret?: string; replyText?: string } = {},
): Promise<Harness> {
  const wire = await startWireServer();
  const requests: RecordedRequest[] = [];
  const logs: LogSink = [];

  const wireUrl = wire.url;
  const redirectedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(input);
    if (
      urlStr.startsWith("https://api.weixin.qq.com") ||
      urlStr.startsWith("https://qyapi.weixin.qq.com")
    ) {
      const redirected = urlStr
        .replace("https://api.weixin.qq.com", wireUrl)
        .replace("https://qyapi.weixin.qq.com", wireUrl);
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({
        originalUrl: urlStr,
        method: init?.method ?? "GET",
        contentType: headers?.["Content-Type"],
        bodyText: typeof init?.body === "string" ? init.body : undefined,
      });
      return REAL_FETCH(redirected, init as never);
    }
    return REAL_FETCH(input, init as never);
  }) as typeof fetch;
  (globalThis as { fetch: typeof fetch }).fetch = redirectedFetch;

  const restorePluginLogs = capturePluginLogs(logs);

  const runtime = await createTestRuntimeWithModelProvider({
    fixtures: [
      {
        name: "wechat-reply",
        match: { modelType: ModelType.RESPONSE_HANDLER },
        response: {
          contexts: ["simple"],
          intents: [],
          replyText: options.replyText ?? DEFAULT_REPLY,
          candidateActionNames: [],
        },
      },
    ],
  });

  // Runtime-side pipeline counter (observation only — behavior untouched):
  // proves negative scenarios never reached the model/message pipeline.
  const pipelineCalls = { handleMessage: 0 };
  const ms = runtime.runtime.messageService;
  if (ms) {
    const original = ms.handleMessage.bind(ms);
    ms.handleMessage = (async (...args: unknown[]) => {
      pipelineCalls.handleMessage += 1;
      return (original as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as typeof ms.handleMessage;
  }

  // The runtime's own namespaced logger carries error-report output
  // (reportError → [AGENT] ... wechat:callback-delivery ...); wrap it too.
  const restoreRuntimeLogs = captureLogsOn(runtime.runtime.logger, logs);

  const callbackPort = await freePort();

  const config = {
    connectors: {
      wechat: {
        callbackPort,
        account: {
          mode: "official-account",
          appId: "wx-e2e-appid",
          appSecret: options.officialSecret ?? "oa-e2e-secret",
          token: OA_TOKEN_SECRET,
          messageSecurityMode: "plaintext",
          callbackId: "gh_e2e_oa",
        },
        accounts: {
          "wecom-main": {
            mode: "wecom",
            corpId: "ww-e2e-corp",
            corpSecret: "wecom-e2e-secret",
            agentId: 1000002,
            token: WECOM_TOKEN_SECRET,
            encodingAESKey: WECOM_AES_KEY,
            callbackId: "ww-e2e-corp",
          },
        },
      },
    },
  };

  // Production hosts surface connector config through character settings;
  // the account provider reads runtime.character.settings.connectors.wechat.
  // The plugin's provider reads connector config from character settings;
  // this harness drives the plugin entrypoint DIRECTLY (host boot and host
  // config propagation are out of scope — this is not a host-boot test).
  (
    runtime.runtime.character as unknown as {
      settings: Record<string, unknown>;
    }
  ).settings = {
    ...(runtime.runtime.character.settings ?? {}),
    connectors: { wechat: config.connectors.wechat },
  };

  // The REAL plugin entrypoint: config resolution, ConnectorAccountProvider
  // registration, MessageConnector registration, channel lifecycle.
  await wechatPluginDefault.init(config as never, runtime.runtime);

  return {
    runtime,
    wire,
    requests,
    logs,
    callbackPort,
    pipelineCalls,
    restoreFetch: () => {
      (globalThis as { fetch: typeof fetch }).fetch = REAL_FETCH;
    },
    stop: async () => {
      await wechatPluginDefault.dispose();
      await runtime.cleanup();
      await wire.close();
      restoreRuntimeLogs();
      restorePluginLogs();
      (globalThis as { fetch: typeof fetch }).fetch = REAL_FETCH;
    },
  };
}

// ---------------------------------------------------------------------------
// Callback delivery helpers (real HTTP to the plugin's bound port).
// ---------------------------------------------------------------------------

function httpPost(
  port: number,
  path: string,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path, method: "POST" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function deliverPlaintext(
  port: number,
  options: {
    xml: string;
    timestamp?: string;
    nonce?: string;
    signatureOverride?: string;
    route?: string;
  },
): Promise<{ status: number; body: string }> {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? randomBytes(6).toString("hex");
  const signature =
    options.signatureOverride ?? sha1Of(OA_TOKEN_SECRET, timestamp, nonce);
  const route = options.route ?? "default";
  return httpPost(
    port,
    `/webhook/wechat/${route}?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`,
    options.xml,
  );
}

async function deliverEncrypted(
  port: number,
  options: {
    xml: string;
    framingReceiver: string;
    timestamp?: string;
    nonce?: string;
    outerAgentId?: number;
    signOverride?: string;
    route?: string;
  },
): Promise<{ status: number; body: string }> {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? randomBytes(6).toString("hex");
  const encrypt = platformEncrypt(
    options.xml,
    options.framingReceiver,
    WECOM_AES_KEY,
  );
  const signature =
    options.signOverride ??
    sha1Of(WECOM_TOKEN_SECRET, timestamp, nonce, encrypt);
  const envelope = buildXml("xml", {
    ToUserName: options.framingReceiver,
    Encrypt: encrypt,
    ...(options.outerAgentId !== undefined
      ? { AgentID: String(options.outerAgentId) }
      : {}),
  });
  const route = options.route ?? "wecom-main";
  return httpPost(
    port,
    `/webhook/wechat/${route}?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`,
    envelope,
  );
}

function oaXml(sender: string, content: string, msgId: string): string {
  return buildXml("xml", {
    ToUserName: "gh_e2e_oa",
    FromUserName: sender,
    CreateTime: String(Math.floor(Date.now() / 1000)),
    MsgType: "text",
    Content: content,
    MsgId: msgId,
  });
}

function wecomXml(
  sender: string,
  content: string,
  msgId: string,
  agentId?: string,
): string {
  return buildXml("xml", {
    ToUserName: "ww-e2e-corp",
    FromUserName: sender,
    CreateTime: String(Math.floor(Date.now() / 1000)),
    MsgType: "text",
    Content: content,
    MsgId: msgId,
    ...(agentId !== undefined ? { AgentID: agentId } : {}),
  });
}

async function roomMemories(
  h: Harness,
  accountId: string,
  sender: string,
): Promise<number> {
  const roomId = stringToUuid(`wechat:room:${accountId}:${sender}`) as never;
  const mems = await h.runtime.runtime.getMemories({
    tableName: "messages",
    roomId,
    limit: 100,
  });
  return mems.length;
}

/** Account status observed through the provider registered by plugin init(). */
async function accountStatus(
  h: Harness,
  accountId: string,
): Promise<string | undefined> {
  const manager = getConnectorAccountManager(h.runtime.runtime);
  const accounts = await manager.listAccounts("wechat");
  return accounts.find((a) => a.id === accountId)?.status;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    if (c) await c();
  }
});

function track(h: Harness): Harness {
  cleanups.push(h.stop);
  return h;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("wechat wire-fidelity e2e (local Tencent wire server, real plugin init)", () => {
  it("1. OA plaintext inbound: verified callback → observed target → memory → reply receipt with exact request fidelity", async () => {
    const h = track(await startHarness());

    // Plugin registration really happened through init().
    const connectors = h.runtime.runtime.getMessageConnectors();
    const wechat = connectors.find((c) => c.source === "wechat");
    expect(wechat, "MessageConnector registered by plugin init").toBeDefined();
    expect(wechat?.capabilities).toEqual(
      expect.arrayContaining([
        "send_message",
        "resolve_targets",
        "chat_context",
      ]),
    );

    const res = await deliverPlaintext(h.callbackPort, {
      xml: oaXml("oE2EUser1", "hello from the wire harness", "9001"),
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("success");

    await waitFor(() => h.wire.sends.length > 0, 20_000, "send posted to wire");
    expect(h.pipelineCalls.handleMessage).toBe(1);

    // Exact outbound request fidelity: production emitted this exact URL,
    // method, content type, and body against the hardcoded platform host.
    const tokenReq = h.requests.find(
      (r) => r.originalUrl === "https://api.weixin.qq.com/cgi-bin/stable_token",
    );
    expect(
      tokenReq,
      "token request hit the hardcoded production host",
    ).toBeDefined();
    expect(tokenReq?.method).toBe("POST");
    expect(tokenReq?.contentType).toBe("application/json");
    expect(JSON.parse(tokenReq?.bodyText ?? "{}")).toEqual({
      grant_type: "client_credential",
      appid: "wx-e2e-appid",
      secret: "oa-e2e-secret",
      force_refresh: false,
    });

    const sendReq = h.requests.find((r) =>
      r.originalUrl.startsWith(
        "https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=",
      ),
    );
    expect(
      sendReq,
      "send hit the hardcoded production host+path",
    ).toBeDefined();
    expect(sendReq?.method).toBe("POST");
    expect(sendReq?.contentType).toBe("application/json");
    expect(sendReq?.originalUrl).toBe(
      "https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=OA_E2E_TOKEN_1",
    );
    expect(JSON.parse(sendReq?.bodyText ?? "{}")).toEqual({
      touser: "oE2EUser1",
      msgtype: "text",
      text: { content: DEFAULT_REPLY },
    });

    // Memory mutation through the real pipeline (inbound + reply persisted).
    expect(
      await roomMemories(h, "default", "oE2EUser1"),
    ).toBeGreaterThanOrEqual(2);

    // Provider status is observational and connected after the send receipt.
    expect(await accountStatus(h, "default")).toBe("connected");
  }, 120_000);

  it("2. WeCom encrypted inbound (AES envelope + AgentID binding) → reply via message/send with exact fidelity", async () => {
    const h = track(await startHarness());

    const res = await deliverEncrypted(h.callbackPort, {
      xml: wecomXml("WecomE2EUser", "encrypted path hello", "9002", "1000002"),
      framingReceiver: "ww-e2e-corp",
      outerAgentId: 1000002,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("success");

    await waitFor(() => h.wire.sends.length > 0, 20_000, "send posted to wire");
    expect(h.pipelineCalls.handleMessage).toBe(1);

    const tokenReq = h.requests.find((r) =>
      r.originalUrl.startsWith("https://qyapi.weixin.qq.com/cgi-bin/gettoken?"),
    );
    expect(
      tokenReq,
      "WeCom token request hit the hardcoded production host",
    ).toBeDefined();
    expect(tokenReq?.method).toBe("GET");
    expect(tokenReq?.originalUrl).toBe(
      "https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=ww-e2e-corp&corpsecret=wecom-e2e-secret",
    );

    const sendReq = h.requests.find((r) =>
      r.originalUrl.startsWith(
        "https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=",
      ),
    );
    expect(sendReq).toBeDefined();
    expect(sendReq?.method).toBe("POST");
    expect(sendReq?.contentType).toBe("application/json");
    expect(sendReq?.originalUrl).toBe(
      "https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=WECOM_E2E_TOKEN_1",
    );
    expect(JSON.parse(sendReq?.bodyText ?? "{}")).toEqual({
      touser: "WecomE2EUser",
      msgtype: "text",
      agentid: 1000002,
      text: { content: DEFAULT_REPLY },
    });

    expect(
      await roomMemories(h, "wecom-main", "WecomE2EUser"),
    ).toBeGreaterThanOrEqual(2);
    expect(await accountStatus(h, "wecom-main")).toBe("connected");
  }, 120_000);

  it("3. invalid signature rejected BEFORE pipeline/memory/model mutation", async () => {
    const h = track(await startHarness());

    const res = await deliverPlaintext(h.callbackPort, {
      xml: oaXml("oAttacker", "forged", "9003"),
      signatureOverride: "0".repeat(40),
    });
    expect(res.status).toBe(403);

    await sleep(1000);
    expect(h.pipelineCalls.handleMessage, "no runtime turn").toBe(0);
    expect(h.wire.sends.length, "no outbound send").toBe(0);
    expect(
      await roomMemories(h, "default", "oAttacker"),
      "no memory mutation",
    ).toBe(0);
  }, 120_000);

  it("4a. WeCom framing-receiver mismatch rejected (ciphertext encrypted for another corp)", async () => {
    const h = track(await startHarness());
    const res = await deliverEncrypted(h.callbackPort, {
      xml: wecomXml("WecomSpy", "framing mismatch", "9010", "1000002"),
      framingReceiver: "ww-OTHER-corp",
      outerAgentId: 1000002,
    });
    expect(res.status).toBe(403);
    await sleep(1000);
    expect(h.pipelineCalls.handleMessage).toBe(0);
    expect(h.wire.sends.length).toBe(0);
    expect(await roomMemories(h, "wecom-main", "WecomSpy")).toBe(0);
  }, 120_000);

  it("4b. WeCom inner-receiver mismatch rejected (ToUserName bound to another identity)", async () => {
    const h = track(await startHarness());
    const evil = buildXml("xml", {
      ToUserName: "gh_someone_else",
      FromUserName: "WecomSpy2",
      CreateTime: String(Math.floor(Date.now() / 1000)),
      MsgType: "text",
      Content: "inner receiver mismatch",
      MsgId: "9011",
      AgentID: "1000002",
    });
    const res = await deliverEncrypted(h.callbackPort, {
      xml: evil,
      framingReceiver: "ww-e2e-corp",
      outerAgentId: 1000002,
    });
    expect(res.status).toBe(403);
    await sleep(1000);
    expect(h.pipelineCalls.handleMessage).toBe(0);
    expect(h.wire.sends.length).toBe(0);
    expect(await roomMemories(h, "wecom-main", "WecomSpy2")).toBe(0);
  }, 120_000);

  it("4c. WeCom AgentID mismatch rejected (cross-agent replay under same corp creds)", async () => {
    const h = track(await startHarness());
    const res = await deliverEncrypted(h.callbackPort, {
      xml: wecomXml("WecomSpy3", "cross-agent replay", "9004", "1000099"),
      framingReceiver: "ww-e2e-corp",
      outerAgentId: 1000002,
    });
    expect(res.status).toBe(403);
    await sleep(1000);
    expect(h.pipelineCalls.handleMessage).toBe(0);
    expect(h.wire.sends.length).toBe(0);
    expect(await roomMemories(h, "wecom-main", "WecomSpy3")).toBe(0);
  }, 120_000);

  it("5. stale signature (outside the freshness window) rejected", async () => {
    const h = track(await startHarness());
    const stale = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const res = await deliverPlaintext(h.callbackPort, {
      xml: oaXml("oStaleUser", "stale delivery", "9012"),
      timestamp: stale,
    });
    expect(res.status).toBe(403);
    await sleep(1000);
    expect(h.pipelineCalls.handleMessage).toBe(0);
    expect(h.wire.sends.length).toBe(0);
    expect(await roomMemories(h, "default", "oStaleUser")).toBe(0);

    // The rejection surfaced through the structured logger at the boundary.
    expect(
      sinkText(h.logs).some((l) =>
        l.includes("Rejecting stale callback signature"),
      ),
      "structured stale-rejection warn captured",
    ).toBe(true);
  }, 120_000);

  it("6. non-zero receipt: platform-rejected send → 500 boundary + error status via provider", async () => {
    const h = track(await startHarness({ replyText: "REJECTED_REPLY" }));
    h.wire.rejectContent.set("REJECTED_REPLY", 45003);

    const res = await deliverPlaintext(h.callbackPort, {
      xml: oaXml("oE2EUser5", "trigger reply", "9005"),
    });
    // A failed reply send is a failed delivery: the boundary answers 500 so
    // the platform retries (a failure is never dressed up as success).
    expect(res.status).toBe(500);
    await waitFor(
      () =>
        h.wire.sends.some(
          (s) => (s.body as { touser?: string })?.touser === "oE2EUser5",
        ),
      20_000,
      "rejected send captured",
    );
    expect(
      h.wire.sends.filter(
        (s) => (s.body as { touser?: string })?.touser === "oE2EUser5",
      ).length,
    ).toBe(1);

    // The provider surfaces the degraded transport as an explicit error
    // status (observationalStatus: degraded → "error").
    expect(await accountStatus(h, "default")).toBe("error");

    // Structured log captured at the boundary: the failed delivery surfaces
    // through the runtime's error-report scope, not just any wechat line.
    expect(
      sinkText(h.logs).some(
        (l) =>
          l.includes("wechat:callback-delivery") ||
          l.includes("delivery to the first-party endpoint failed"),
      ),
      "structured delivery-error log captured",
    ).toBe(true);
  }, 120_000);

  it("7. invalid-token receipt → exactly one forced refresh → retry carries the ROTATED token", async () => {
    const h = track(await startHarness());

    // Baseline after startup probes: exactly one OA token call.
    expect(h.wire.oaTokenCalls.length).toBe(1);

    // Rotate: the platform now issues and honors only OA_E2E_TOKEN_2, so the
    // cached OA_E2E_TOKEN_1 send is rejected 40001 and the client must
    // recover + retry.
    h.wire.rotateOaToken("OA_E2E_TOKEN_2");

    const res = await deliverPlaintext(h.callbackPort, {
      xml: oaXml("oE2EUser6", "trigger reply", "9006"),
    });
    expect(res.status).toBe(200);

    await waitFor(
      () =>
        h.wire.sends.filter(
          (s) => (s.body as { touser?: string })?.touser === "oE2EUser6",
        ).length >= 2,
      20_000,
      "retry send captured",
    );

    // Exactly ONE additional OA token fetch (the forced recovery refresh).
    expect(h.wire.oaTokenCalls.length, "exactly one forced refresh").toBe(2);

    const user6Sends = h.wire.sends.filter(
      (s) => (s.body as { touser?: string })?.touser === "oE2EUser6",
    );
    expect(user6Sends.map((s) => s.accessToken)).toEqual([
      "OA_E2E_TOKEN_1",
      "OA_E2E_TOKEN_2",
    ]);

    expect(await accountStatus(h, "default")).toBe("connected");
  }, 120_000);

  it("8. substituted-body replay under a captured signature triple: exactly one delivery, structured warn", async () => {
    const h = track(await startHarness());

    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "fixed-nonce-7";
    const signature = sha1Of(OA_TOKEN_SECRET, timestamp, nonce);
    const path = `/webhook/wechat/default?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`;

    const first = await httpPost(
      h.callbackPort,
      path,
      oaXml("oE2EUser7", "original", "9007"),
    );
    expect(first.status).toBe(200);
    await waitFor(
      () =>
        h.wire.sends.some(
          (s) => (s.body as { touser?: string })?.touser === "oE2EUser7",
        ),
      20_000,
      "reply sent",
    );

    const replay = await httpPost(
      h.callbackPort,
      path,
      oaXml("oE2EUser7", "substituted", "9008"),
    );
    expect(replay.status).toBe(403);

    await sleep(1500);
    // EXACTLY one delivery: one pipeline turn, one send.
    expect(h.pipelineCalls.handleMessage).toBe(1);
    expect(
      h.wire.sends.filter(
        (s) => (s.body as { touser?: string })?.touser === "oE2EUser7",
      ).length,
    ).toBe(1);

    // The rejection surfaced through the structured logger at the boundary.
    expect(
      sinkText(h.logs).some((l) =>
        l.includes("Rejecting replayed callback body"),
      ),
      "structured replay-rejection warn captured",
    ).toBe(true);
  }, 120_000);

  it("9. startup probe with rejected credentials: unavailable status, fail-closed send, no wire send", async () => {
    const h = track(await startHarness({ officialSecret: "wrong-secret" }));

    expect(await accountStatus(h, "default")).toBe("error");

    // A connector send through the runtime's public connector transport (the
    // path every agent-initiated outbound message takes) must fail closed with
    // the typed error and never reach the wire.
    const connector = h.runtime.runtime
      .getMessageConnectors()
      .find((c) => c.source === "wechat");
    expect(connector, "connector registered").toBeDefined();
    const before = h.wire.sends.length;
    await expect(
      h.runtime.runtime.sendMessageToTarget(
        {
          source: "wechat",
          channelId: "oE2EUser8",
          roomId: stringToUuid("wechat:room:default:oE2EUser8"),
          metadata: { accountId: "default" },
        } as never,
        { text: "should fail closed" } as never,
      ),
    ).rejects.toThrow(/unavailable|WECHAT|handler/i);
    expect(h.wire.sends.length, "no wire send while fail-closed").toBe(before);
  }, 120_000);
});
