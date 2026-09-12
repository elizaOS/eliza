/**
 * Self-validating evidence capture for #29751 review response: executes every
 * wire-fidelity scenario against the real plugin path (wechatPlugin.init on a
 * real PGLite runtime, transport redirected to a local Tencent wire server),
 * ASSERTS each expected outcome (any mismatch fails the run), and emits a
 * structured, redacted transcript including captured plugin logs. Exit code 0
 * only when every assertion passes. The executing head is read from git, never
 * hardcoded.
 */

import { execSync } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { createServer as netServer } from "node:net";
import {
  getConnectorAccountManager,
  logger,
  ModelType,
  stringToUuid,
} from "@elizaos/core";
import { createTestRuntimeWithModelProvider } from "@elizaos/core/testing";
import wechatPluginDefault from "../src/index";

const log: string[] = [];
function emit(line: string) {
  log.push(line);
  console.log(line);
}
function assert(cond: boolean, what: string) {
  if (!cond) {
    emit(`ASSERTION FAILED: ${what}`);
    throw new Error(`ASSERTION FAILED: ${what}`);
  }
  emit(`  ok: ${what}`);
}
function equal<T>(actual: T, expected: T, what: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${what} (actual=${a} expected=${e})`);
}

// Fixed literal command, no user input interpolated — execSync is safe here.
const HEAD = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
const OUTPUT_PATH =
  process.env.WECHAT_E2E_OUTPUT ?? "./wechat-e2e-evidence.txt";
const GIT_STATUS = execSync("git status --short", { encoding: "utf8" }).trim();

const AES_BLOCK = 32;
function sha1Of(...parts: string[]) {
  return createHash("sha1")
    .update([...parts].sort().join(""), "utf8")
    .digest("hex");
}
function decodeKey(k: string) {
  return Buffer.from(`${k}=`, "base64").subarray(0, 32);
}
function platformEncrypt(
  plaintext: string,
  receiverId: string,
  aesKey: string,
) {
  const key = decodeKey(aesKey);
  const message = Buffer.from(plaintext, "utf8");
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(message.length, 0);
  const pad =
    AES_BLOCK -
    (Buffer.concat([
      randomBytes(16),
      lengthBuf,
      message,
      Buffer.from(receiverId),
    ]).length %
      AES_BLOCK);
  const padded = Buffer.concat([
    randomBytes(16),
    lengthBuf,
    message,
    Buffer.from(receiverId),
    Buffer.alloc(pad, pad),
  ]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString(
    "base64",
  );
}
function buildXml(root: string, fields: Record<string, string>) {
  return `<${root}>\n${Object.entries(fields)
    .map(([k, v]) => `<${k}><![CDATA[${v}]]></${k}>`)
    .join("\n")}\n</${root}>`;
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(predicate: () => boolean, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const OA_TOKEN_SECRET = "oa-token-secret-e2e";
const WECOM_TOKEN_SECRET = "wecom-token-secret-e2e";
const WECOM_AES_KEY = Buffer.from("fedcba9876543210fedcba9876543210")
  .toString("base64")
  .replace(/=+$/, "")
  .slice(0, 43)
  .padEnd(43, "A");
const DEFAULT_REPLY = "Wire-e2e reply from the deterministic provider.";

const REAL_FETCH = globalThis.fetch;

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

interface Send {
  url: string;
  accessToken: string;
  body: any;
}
interface Rec {
  originalUrl: string;
  method: string;
  contentType?: string;
  bodyText?: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = netServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function startHarness(
  opts: { officialSecret?: string; replyText?: string } = {},
) {
  const sends: Send[] = [];
  const oaTokenCalls: any[] = [];
  const requests: Rec[] = [];
  const logs: { level: string; args: unknown[] }[] = [];
  const rejectContent = new Map<string, number>();
  const oaTokenIssueQueue = ["OA_E2E_TOKEN_1", "OA_E2E_TOKEN_2"];
  let currentOaToken = "OA_E2E_TOKEN_1";

  const wire = await new Promise<{ url: string; close(): Promise<void> }>(
    (resolve) => {
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const url = req.url ?? "";
          const bodyText = Buffer.concat(chunks).toString("utf8");
          let parsed: any;
          try {
            parsed = bodyText ? JSON.parse(bodyText) : undefined;
          } catch {
            parsed = undefined;
          }
          res.setHeader("Content-Type", "application/json");
          const json = (status: number, payload: unknown) => {
            res.writeHead(status);
            res.end(JSON.stringify(payload));
          };
          if (url.startsWith("/cgi-bin/stable_token")) {
            oaTokenCalls.push({ body: parsed });
            if (
              parsed?.appid === "wx-e2e-appid" &&
              parsed?.secret === "oa-e2e-secret"
            ) {
              const next = oaTokenIssueQueue.shift();
              if (next) currentOaToken = next;
              return json(200, {
                access_token: currentOaToken,
                expires_in: 7200,
              });
            }
            return json(200, { errcode: 40001, errmsg: "invalid credential" });
          }
          if (url.startsWith("/cgi-bin/gettoken")) {
            const u = new URL(url, "http://wire");
            if (
              u.searchParams.get("corpid") === "ww-e2e-corp" &&
              u.searchParams.get("corpsecret") === "wecom-e2e-secret"
            ) {
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
            sends.push({ url, accessToken, body: parsed });
            const expected = url.includes("custom")
              ? currentOaToken
              : "WECOM_E2E_TOKEN_1";
            if (accessToken !== expected)
              return json(200, {
                errcode: 40001,
                errmsg: "invalid access token",
              });
            const rc = parsed?.text?.content
              ? rejectContent.get(parsed.text.content)
              : undefined;
            if (rc !== undefined)
              return json(200, { errcode: rc, errmsg: "api forbidden" });
            return json(200, { errcode: 0, errmsg: "ok" });
          }
          return json(404, { errcode: -1 });
        });
      });
      server.listen(0, "127.0.0.1", () =>
        resolve({
          url: `http://127.0.0.1:${(server.address() as any).port}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        }),
      );
    },
  );

  const wireUrl = wire.url;
  (globalThis as any).fetch = ((input: any, init?: any) => {
    const urlStr = String(input);
    if (
      urlStr.startsWith("https://api.weixin.qq.com") ||
      urlStr.startsWith("https://qyapi.weixin.qq.com")
    ) {
      const redirected = urlStr
        .replace("https://api.weixin.qq.com", wireUrl)
        .replace("https://qyapi.weixin.qq.com", wireUrl);
      requests.push({
        originalUrl: urlStr,
        method: init?.method ?? "GET",
        contentType: init?.headers?.["Content-Type"],
        bodyText: typeof init?.body === "string" ? init.body : undefined,
      });
      return REAL_FETCH(redirected, init);
    }
    return REAL_FETCH(input, init);
  }) as typeof fetch;

  // Structured plugin-log capture
  const originals = new Map<string, unknown>();
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const target = logger as unknown as Record<string, unknown>;
    const original = target[level];
    if (typeof original === "function") {
      originals.set(level, original);
      target[level] = (...args: unknown[]) => {
        logs.push({ level, args });
        (original as (...a: unknown[]) => void)(...args);
      };
    }
  }
  const restoreLogs = () => {
    for (const [level, original] of originals)
      (logger as unknown as Record<string, unknown>)[level] = original;
  };

  const runtime = await createTestRuntimeWithModelProvider({
    fixtures: [
      {
        name: "wechat-reply",
        match: { modelType: ModelType.RESPONSE_HANDLER },
        response: {
          contexts: ["simple"],
          intents: [],
          replyText: opts.replyText ?? DEFAULT_REPLY,
          candidateActionNames: [],
        },
      },
    ],
  });

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
  // (reportError → [AGENT] ... wechat:callback-delivery ...); wrap it too so
  // delivery-error boundary evidence lands in the shared sink.
  const runtimeLogOriginals = new Map<string, unknown>();
  const runtimeLogger = runtime.runtime.logger as unknown as Record<
    string,
    unknown
  >;
  if (runtimeLogger && typeof runtimeLogger === "object") {
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      const original = runtimeLogger[level];
      if (typeof original === "function") {
        runtimeLogOriginals.set(level, original);
        runtimeLogger[level] = (...args: unknown[]) => {
          logs.push({ level, args });
          (original as (...a: unknown[]) => void)(...args);
        };
      }
    }
  }
  const restoreRuntimeLogs = () => {
    for (const [level, original] of runtimeLogOriginals)
      runtimeLogger[level] = original;
  };

  const callbackPort = await freePort();
  // Production hosts surface connector config through character settings; the
  // account provider reads runtime.character.settings.connectors.wechat.
  (
    runtime.runtime.character as unknown as {
      settings: Record<string, unknown>;
    }
  ).settings = {
    ...(runtime.runtime.character.settings ?? {}),
    connectors: {
      wechat: {
        account: {
          mode: "official-account",
          appId: "wx-e2e-appid",
          appSecret: opts.officialSecret ?? "oa-e2e-secret",
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
  await wechatPluginDefault.init(
    {
      connectors: {
        wechat: {
          callbackPort,
          account: {
            mode: "official-account",
            appId: "wx-e2e-appid",
            appSecret: opts.officialSecret ?? "oa-e2e-secret",
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
    } as never,
    runtime.runtime,
  );

  return {
    runtime,
    wire,
    sends,
    oaTokenCalls,
    requests,
    logs,
    rejectContent,
    pipelineCalls,
    callbackPort,
    oaTokenIssueQueue,
    rotateOaToken: (t: string) => {
      currentOaToken = t;
    },
    logsText: () =>
      logs.map(
        (e) =>
          `[${e.level}] ${e.args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`,
      ),
    stop: async () => {
      await wechatPluginDefault.dispose();
      await runtime.cleanup();
      await wire.close();
      restoreRuntimeLogs();
      restoreLogs();
      (globalThis as any).fetch = REAL_FETCH;
    },
  };
}

async function accountStatus(
  h: Awaited<ReturnType<typeof startHarness>>,
  accountId: string,
) {
  const manager = getConnectorAccountManager(h.runtime.runtime);
  return (await manager.listAccounts("wechat")).find((a) => a.id === accountId)
    ?.status;
}
async function roomMemories(
  h: Awaited<ReturnType<typeof startHarness>>,
  accountId: string,
  sender: string,
) {
  const roomId = stringToUuid(`wechat:room:${accountId}:${sender}`) as never;
  return (
    await h.runtime.runtime.getMemories({
      tableName: "messages",
      roomId,
      limit: 100,
    })
  ).length;
}
function oaXml(sender: string, content: string, msgId: string) {
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
) {
  return buildXml("xml", {
    ToUserName: "ww-e2e-corp",
    FromUserName: sender,
    CreateTime: String(Math.floor(Date.now() / 1000)),
    MsgType: "text",
    Content: content,
    MsgId: msgId,
    ...(agentId ? { AgentID: agentId } : {}),
  });
}
async function deliverPlaintext(
  port: number,
  xml: string,
  o: { sig?: string; ts?: string } = {},
) {
  const ts = o.ts ?? String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(6).toString("hex");
  const sig = o.sig ?? sha1Of(OA_TOKEN_SECRET, ts, nonce);
  return httpPost(
    port,
    `/webhook/wechat/default?signature=${sig}&timestamp=${ts}&nonce=${nonce}`,
    xml,
  );
}
async function deliverEncrypted(
  port: number,
  xml: string,
  o: { framingReceiver: string; outerAgentId?: number },
) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(6).toString("hex");
  const enc = platformEncrypt(xml, o.framingReceiver, WECOM_AES_KEY);
  const sig = sha1Of(WECOM_TOKEN_SECRET, ts, nonce, enc);
  const envelope = buildXml("xml", {
    ToUserName: o.framingReceiver,
    Encrypt: enc,
    ...(o.outerAgentId !== undefined
      ? { AgentID: String(o.outerAgentId) }
      : {}),
  });
  return httpPost(
    port,
    `/webhook/wechat/wecom-main?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`,
    envelope,
  );
}

async function main() {
  emit("=== #29751 wire-fidelity evidence capture (self-validating) ===");
  emit(`date: ${new Date().toISOString()}`);
  emit(`executing head: ${HEAD} (git rev-parse HEAD, never hardcoded)`);
  const PR_HEAD =
    process.env.WECHAT_E2E_PR_HEAD ??
    "d94707eb59f27cbbf1de986271b74872151db1d7";
  emit(`PR head under review (unchanged by this evidence): ${PR_HEAD}`);
  emit(`git status: ${GIT_STATUS || "clean"}`);
  emit(
    "mode: REAL wechatPlugin.init on a real PGLite AgentRuntime; transport redirected from",
  );
  emit(
    "      fixed api.weixin.qq.com / qyapi.weixin.qq.com to a local independent wire server.",
  );
  emit(
    "limitation (stated plainly): NO authorized Tencent credentials exist on this machine, so",
  );
  emit(
    "      no callback/token/receipt was delivered by Tencent infrastructure. This validates",
  );
  emit(
    "      local wire compatibility and the production plugin path up to transport redirection;",
  );
  emit(
    "      it does NOT validate Tencent account configuration, public callback reachability,",
  );
  emit("      TLS, live credential authorization, or actual Tencent delivery.");

  // ---- Scenario 1
  emit(
    "\n--- [1] OA plaintext inbound → observed target → memory → reply receipt ---",
  );
  const h1 = await startHarness();
  const connectors = h1.runtime.runtime.getMessageConnectors();
  assert(
    connectors.some((c) => c.source === "wechat"),
    "MessageConnector registered by plugin init",
  );
  const r1 = await deliverPlaintext(
    h1.callbackPort,
    oaXml("oE2EUser1", "hello from the wire harness", "9001"),
  );
  equal(
    { status: r1.status, body: r1.body },
    { status: 200, body: "success" },
    "callback accepted",
  );
  await waitFor(() => h1.sends.length > 0, 20_000, "send posted");
  equal(h1.pipelineCalls.handleMessage, 1, "exactly one runtime pipeline turn");
  const tokenReq = h1.requests.find(
    (r) => r.originalUrl === "https://api.weixin.qq.com/cgi-bin/stable_token",
  );
  assert(!!tokenReq, "token request hit the exact hardcoded production URL");
  equal(
    {
      method: tokenReq?.method,
      contentType: tokenReq?.contentType,
      body: JSON.parse(tokenReq?.bodyText ?? "{}"),
    },
    {
      method: "POST",
      contentType: "application/json",
      body: {
        grant_type: "client_credential",
        appid: "wx-e2e-appid",
        secret: "oa-e2e-secret",
        force_refresh: false,
      },
    },
    "exact token request fidelity",
  );
  const sendReq = h1.requests.find((r) =>
    r.originalUrl.startsWith(
      "https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=",
    ),
  );
  equal(
    { method: sendReq?.method, contentType: sendReq?.contentType },
    { method: "POST", contentType: "application/json" },
    "OA send method/content-type",
  );
  equal(
    sendReq?.originalUrl,
    "https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=OA_E2E_TOKEN_1",
    "exact send URL",
  );
  equal(
    JSON.parse(sendReq?.bodyText ?? "{}"),
    { touser: "oE2EUser1", msgtype: "text", text: { content: DEFAULT_REPLY } },
    "exact OA send body",
  );
  assert(
    (await roomMemories(h1, "default", "oE2EUser1")) >= 2,
    "inbound + reply memories persisted (real PGLite)",
  );
  equal(
    await accountStatus(h1, "default"),
    "connected",
    "provider status connected after send receipt",
  );
  emit(
    `structured-log sample: ${
      h1
        .logsText()
        .filter((l) => l.includes("wechat"))
        .slice(0, 3)
        .join(" | ") || "(plugin logged via [wechat] prefixes)"
    }`,
  );

  // ---- Scenario 2
  emit(
    "\n--- [2] WeCom encrypted inbound (AES envelope + AgentID binding) → reply via message/send ---",
  );
  const r2 = await deliverEncrypted(
    h1.callbackPort,
    wecomXml("WecomE2EUser", "encrypted path hello", "9002", "1000002"),
    { framingReceiver: "ww-e2e-corp", outerAgentId: 1000002 },
  );
  equal(
    { status: r2.status, body: r2.body },
    { status: 200, body: "success" },
    "encrypted callback accepted",
  );
  await waitFor(
    () =>
      h1.sends.some(
        (s) => s.url.includes("message/send") || s.body?.agentid === 1000002,
      ),
    20_000,
    "wecom send posted",
  );
  const wecomSend = h1.sends.find((s) => s.body?.agentid === 1000002);
  equal(
    { token: wecomSend?.accessToken, body: wecomSend?.body },
    {
      token: "WECOM_E2E_TOKEN_1",
      body: {
        touser: "WecomE2EUser",
        msgtype: "text",
        agentid: 1000002,
        text: { content: DEFAULT_REPLY },
      },
    },
    "exact WeCom send receipt",
  );
  const wecomSendReq = h1.requests.find((r) =>
    r.originalUrl.startsWith(
      "https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=",
    ),
  );
  equal(
    { method: wecomSendReq?.method, contentType: wecomSendReq?.contentType },
    { method: "POST", contentType: "application/json" },
    "WeCom send method/content-type",
  );
  const wecomTokenReq = h1.requests.find((r) =>
    r.originalUrl.startsWith("https://qyapi.weixin.qq.com/cgi-bin/gettoken?"),
  );
  equal(
    { method: wecomTokenReq?.method },
    { method: "GET" },
    "WeCom token method",
  );
  equal(
    wecomTokenReq?.originalUrl,
    "https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=ww-e2e-corp&corpsecret=wecom-e2e-secret",
    "exact WeCom token URL",
  );
  assert(
    (await roomMemories(h1, "wecom-main", "WecomE2EUser")) >= 2,
    "wecom memories persisted",
  );
  equal(
    await accountStatus(h1, "wecom-main"),
    "connected",
    "wecom provider status connected",
  );
  await h1.stop();

  // ---- Scenario 3
  emit(
    "\n--- [3] invalid signature rejected BEFORE pipeline/memory/model mutation ---",
  );
  const h3 = await startHarness();
  const r3 = await deliverPlaintext(
    h3.callbackPort,
    oaXml("oAttacker", "forged", "9003"),
    { sig: "0".repeat(40) },
  );
  equal(r3.status, 403, "forged signature → 403");
  await sleep(1000);
  equal(h3.pipelineCalls.handleMessage, 0, "no runtime turn");
  equal(h3.sends.length, 0, "no outbound send");
  equal(
    await roomMemories(h3, "default", "oAttacker"),
    0,
    "no memory mutation",
  );
  await h3.stop();

  // ---- Scenario 4a
  emit("\n--- [4a] WeCom framing-receiver mismatch rejected ---");
  const h4 = await startHarness();
  const r4a = await deliverEncrypted(
    h4.callbackPort,
    wecomXml("WecomSpy", "framing mismatch", "9010", "1000002"),
    { framingReceiver: "ww-OTHER-corp", outerAgentId: 1000002 },
  );
  equal(r4a.status, 403, "wrong framing receiver → 403");
  equal(
    await roomMemories(h4, "wecom-main", "WecomSpy"),
    0,
    "no memory mutation (framing)",
  );

  // ---- Scenario 4b
  emit("--- [4b] WeCom inner-receiver mismatch rejected ---");
  const evilInner = buildXml("xml", {
    ToUserName: "gh_someone_else",
    FromUserName: "WecomSpy2",
    CreateTime: String(Math.floor(Date.now() / 1000)),
    MsgType: "text",
    Content: "inner receiver mismatch",
    MsgId: "9011",
    AgentID: "1000002",
  });
  const r4b = await deliverEncrypted(h4.callbackPort, evilInner, {
    framingReceiver: "ww-e2e-corp",
    outerAgentId: 1000002,
  });
  equal(r4b.status, 403, "wrong inner receiver → 403");
  equal(
    await roomMemories(h4, "wecom-main", "WecomSpy2"),
    0,
    "no memory mutation (inner)",
  );

  // ---- Scenario 4c
  emit("--- [4c] WeCom AgentID mismatch rejected ---");
  const r4c = await deliverEncrypted(
    h4.callbackPort,
    wecomXml("WecomSpy3", "cross-agent replay", "9004", "1000099"),
    { framingReceiver: "ww-e2e-corp", outerAgentId: 1000002 },
  );
  equal(r4c.status, 403, "wrong AgentID → 403");
  equal(
    await roomMemories(h4, "wecom-main", "WecomSpy3"),
    0,
    "no memory mutation (agent)",
  );
  await sleep(1000);
  equal(
    h4.pipelineCalls.handleMessage,
    0,
    "no runtime turn for any mismatch class",
  );
  equal(h4.sends.length, 0, "no outbound send for any mismatch class");
  await h4.stop();

  // ---- Scenario 5
  emit("\n--- [5] stale signature (outside freshness window) rejected ---");
  const h5 = await startHarness();
  const r5 = await deliverPlaintext(
    h5.callbackPort,
    oaXml("oStaleUser", "stale delivery", "9012"),
    { ts: String(Math.floor(Date.now() / 1000) - 6 * 60) },
  );
  equal(r5.status, 403, "stale timestamp → 403");
  await sleep(1000);
  equal(h5.pipelineCalls.handleMessage, 0, "no runtime turn");
  equal(h5.sends.length, 0, "no outbound send (stale)");
  equal(
    await roomMemories(h5, "default", "oStaleUser"),
    0,
    "no memory mutation (stale)",
  );
  assert(
    h5.logsText().some((l) => l.includes("Rejecting stale callback signature")),
    "structured stale-rejection warn captured",
  );
  emit(
    `raw structured warn line: ${h5
      .logsText()
      .find((l) => l.includes("Rejecting stale callback signature"))
      ?.slice(0, 220)}`,
  );
  await h5.stop();

  // ---- Scenario 6
  emit(
    "\n--- [6] non-zero receipt: rejected send → 500 boundary + error provider status ---",
  );
  const h6 = await startHarness({ replyText: "REJECTED_REPLY" });
  h6.rejectContent.set("REJECTED_REPLY", 45003);
  const r6 = await deliverPlaintext(
    h6.callbackPort,
    oaXml("oE2EUser5", "trigger reply", "9005"),
  );
  equal(
    r6.status,
    500,
    "failed reply send → 500 boundary (failure surfaced, not masked)",
  );
  await waitFor(
    () => h6.sends.some((s) => s.body?.touser === "oE2EUser5"),
    20_000,
    "rejected send captured",
  );
  equal(
    h6.sends.filter((s) => s.body?.touser === "oE2EUser5").length,
    1,
    "exactly one rejected send attempt",
  );
  equal(
    await accountStatus(h6, "default"),
    "error",
    "provider status error after degraded transport",
  );
  const wechatLogs6 = h6.logsText().filter((l) => l.includes("wechat"));
  assert(
    wechatLogs6.some(
      (l) =>
        l.includes("wechat:callback-delivery") ||
        l.includes("delivery to the first-party endpoint failed"),
    ),
    `structured delivery-error log captured (${wechatLogs6
      .filter((l) => l.includes("delivery"))
      .slice(0, 2)
      .join(" | ")})`,
  );
  emit(
    `raw structured delivery-error line: ${
      wechatLogs6
        .find(
          (l) =>
            l.includes("wechat:callback-delivery") ||
            l.includes("delivery to the first-party endpoint failed"),
        )
        ?.slice(0, 220) ?? "(none)"
    }`,
  );
  await h6.stop();

  // ---- Scenario 7
  emit(
    "\n--- [7] invalid-token receipt → exactly one forced refresh → retry carries rotated token ---",
  );
  const h7 = await startHarness();
  equal(
    h7.oaTokenCalls.length,
    1,
    "baseline: one OA token call after startup probes",
  );
  // Rotate: the platform now issues and honors only TOKEN_2, so the cached
  // TOKEN_1 send is rejected 40001 → forced refresh → retry with TOKEN_2.
  h7.rotateOaToken("OA_E2E_TOKEN_2");
  const r7 = await deliverPlaintext(
    h7.callbackPort,
    oaXml("oE2EUser6", "trigger reply", "9006"),
  );
  equal(r7.status, 200, "callback accepted");
  await waitFor(
    () => h7.sends.filter((s) => s.body?.touser === "oE2EUser6").length >= 2,
    20_000,
    "retry send captured",
  );
  equal(h7.oaTokenCalls.length, 2, "exactly one forced refresh fetch");
  equal(
    h7.sends
      .filter((s) => s.body?.touser === "oE2EUser6")
      .map((s) => s.accessToken),
    ["OA_E2E_TOKEN_1", "OA_E2E_TOKEN_2"],
    "retry carried the ROTATED token",
  );
  equal(
    await accountStatus(h7, "default"),
    "connected",
    "provider status connected after recovery",
  );
  await h7.stop();

  // ---- Scenario 8
  emit("\n--- [8] substituted-body replay under captured signature triple ---");
  const h8 = await startHarness();
  const ts8 = String(Math.floor(Date.now() / 1000));
  const nonce8 = "fixed-nonce-7";
  const sig8 = sha1Of(OA_TOKEN_SECRET, ts8, nonce8);
  const path8 = `/webhook/wechat/default?signature=${sig8}&timestamp=${ts8}&nonce=${nonce8}`;
  const r8a = await httpPost(
    h8.callbackPort,
    path8,
    oaXml("oE2EUser7", "original", "9007"),
  );
  equal(r8a.status, 200, "original delivery accepted");
  await waitFor(
    () => h8.sends.some((s) => s.body?.touser === "oE2EUser7"),
    20_000,
    "reply sent",
  );
  const r8b = await httpPost(
    h8.callbackPort,
    path8,
    oaXml("oE2EUser7", "substituted", "9008"),
  );
  equal(r8b.status, 403, "substituted replay → 403");
  await sleep(1500);
  equal(h8.pipelineCalls.handleMessage, 1, "exactly one pipeline turn");
  equal(
    h8.sends.filter((s) => s.body?.touser === "oE2EUser7").length,
    1,
    "exactly one send",
  );
  assert(
    h8.logsText().some((l) => l.includes("Rejecting replayed callback body")),
    "structured replay warn captured",
  );
  emit(
    `raw structured warn line: ${h8
      .logsText()
      .find((l) => l.includes("Rejecting replayed callback body"))
      ?.slice(0, 220)}`,
  );
  await h8.stop();

  // ---- Scenario 9
  emit(
    "\n--- [9] startup probe with rejected credentials: error status, fail-closed send ---",
  );
  const h9 = await startHarness({ officialSecret: "wrong-secret" });
  equal(
    await accountStatus(h9, "default"),
    "error",
    "provider status error after failed startup probe",
  );
  const connector = h9.runtime.runtime
    .getMessageConnectors()
    .find((c) => c.source === "wechat");
  assert(!!connector, "connector registered");
  const before9 = h9.sends.length;
  let failed9 = false;
  try {
    await h9.runtime.runtime.sendMessageToTarget(
      {
        source: "wechat",
        channelId: "oE2EUser8",
        roomId: stringToUuid("wechat:room:default:oE2EUser8"),
        metadata: { accountId: "default" },
      } as never,
      { text: "should fail closed" } as never,
    );
  } catch (e) {
    failed9 = true;
    emit(`  fail-closed error: ${(e as Error).message.slice(0, 80)}`);
  }
  assert(
    failed9,
    "send through the public connector transport fails closed with typed error",
  );
  equal(h9.sends.length, before9, "no wire send while fail-closed");
  await h9.stop();

  emit("\n=== ALL SCENARIOS PASSED (self-validating capture) ===");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(OUTPUT_PATH, log.join("\n"));
  process.exit(0);
}

main().catch(async (err) => {
  console.error(
    "EVIDENCE CAPTURE FAILED:",
    err instanceof Error ? err.message : err,
  );
  const { writeFileSync } = await import("node:fs");
  writeFileSync(OUTPUT_PATH, log.join("\n"));
  process.exit(1);
});
