import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAdReport } from "./ad-report.ts";
import { adsenseSnippet, adsTxt } from "./adsense.ts";
import { type BrainFeature, brainFor, isBrainProvider, tightenOnly } from "./brain.ts";
import { companionResponse, isLoopback, phoneMayCall } from "./companion.ts";
import {
  connectionView,
  connectLink,
  csvFor,
  disconnectLink,
  setAlertToggles,
  testLink,
} from "./connection-routes.ts";
import { decisionLines, metaView, pnlView, stateView, walletDots } from "./desk-view.ts";
import type { AgentEngine } from "./engine.ts";
import { LicenseStore } from "./license.ts";
import { fetchLiveSol, publicRpcUrl } from "./live-balance.ts";
import { tail4 } from "./net.ts";
import { AFFILIATE_LABEL, contextForReport, contextForScore, offersFor } from "./offers.ts";
import { pollTelegramTools } from "./outside-read.ts";
import { comparisonRows, PLAN_PRICES, paywallCopy, TRIAL_MS, tierFor } from "./plan.ts";
import { confirmRepair, proposeFix } from "./self-repair.ts";
import { proTradeView } from "./pro-allowance.ts";
import { signalScore } from "./signal-score.ts";
import {
  checkDesktopUpdate,
  DESK_VERSION,
  fetchVersionManifest,
  stageVerifiedDownload,
  UPDATE_PROMPT,
  WHATS_NEW,
} from "./updates.ts";

function resolvePublicDir(): string {
  if (process.env.VALHALLA_PUBLIC_DIR) return path.resolve(process.env.VALHALLA_PUBLIC_DIR);
  const fromSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  if (existsSync(fromSource)) return fromSource;
  return path.resolve(path.dirname(process.execPath), "public");
}

const PUBLIC_DIR = resolvePublicDir();
const HOST = "127.0.0.1";

const sessions = new Set<string>();

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function token(): string {
  return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 20_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const payload = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function cookie(req: IncomingMessage): string {
  const raw = req.headers.cookie ?? "";
  const hit = /valhalla_session=([^;]+)/.exec(raw);
  return hit?.[1] ?? "";
}

export interface DashboardOptions {
  port?: number;
  host?: string;
  password?: string;
  accessCode?: string;
  openBrowser?: boolean;
}

function bindHost(raw: string | undefined): string {
  const host = (raw ?? "").trim();
  if (!host || !/^[A-Za-z0-9.:-]+$/.test(host)) return "127.0.0.1";
  return host;
}

async function deskPaid(engine: AgentEngine): Promise<boolean> {
  const store = new LicenseStore(engine.dataDir);
  const record = await store.read();
  const graceMs = store.config.offlineGraceDays * 24 * 60 * 60 * 1000;
  const pro = Boolean(
    record && record.status === "active" && Date.now() - record.validatedAt <= graceMs
  );
  return tierFor({ pro, trialStartedAt: null, now: Date.now() }) !== "free";
}

export function startDashboard(
  engine: AgentEngine,
  options: DashboardOptions = {}
): Promise<{ port: number; close: () => Promise<void> }> {
  const port = options.port ?? Number(process.env.VALHALLA_DASHBOARD_PORT || 8787);
  const password = options.password ?? process.env.VALHALLA_DASHBOARD_PASSWORD ?? "";
  const accessCode = options.accessCode ?? process.env.VALHALLA_ACCESS_CODE ?? "";
  const host = bindHost(options.host ?? process.env.VALHALLA_BIND);
  const server = createServer((req, res) => {
    void handle(engine, req, res, password, accessCode).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "error";
      engine.log("desk", message);
      if (!res.headersSent)
        send(res, 500, { ok: false, error: "The desk hit an error. See the log panel." });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      let offset = 0;
      let polling = false;
      const toolsTimer = setInterval(() => {
        const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
        if (!token || polling) return;
        polling = true;
        pollTelegramTools(token, offset)
          .then((next) => {
            offset = next;
          })
          .catch(() => undefined)
          .finally(() => {
            polling = false;
          });
      }, 20_000);
      resolve({
        port: bound,
        close: () =>
          new Promise((done) => {
            clearInterval(toolsTimer);
            server.close(() => done());
          }),
      });
    });
  });
}

async function handle(
  engine: AgentEngine,
  req: IncomingMessage,
  res: ServerResponse,
  password: string,
  accessCode: string
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const pathname = url.pathname;
  if (pathname.includes("..") || /send|withdraw|transfer|sweep/i.test(pathname)) {
    send(res, 404, { ok: false, error: "This desk has no send or withdraw path." });
    return;
  }
  if (req.method === "GET" && pathname === "/ads.txt") {
    const body = adsTxt();
    if (!body) {
      send(res, 404, "not found", "text/plain");
      return;
    }
    send(res, 200, body, "text/plain");
    return;
  }
  if (pathname.startsWith("/api/companion/")) {
    const result = await companionResponse(engine, req, pathname, accessCode);
    send(res, result.status, result.body);
    return;
  }
  const remote = req.socket.remoteAddress;
  if (!isLoopback(remote) && pathname.startsWith("/api/") && !phoneMayCall(pathname)) {
    send(res, 404, { ok: false, error: "The phone has no send or withdraw path." });
    return;
  }
  if (req.method === "POST" && pathname === "/api/login") {
    const body = (await readBody(req)) as { password?: string; accessCode?: string };
    if (password && !same(body.password ?? "", password)) {
      send(res, 401, { ok: false, error: "Wrong desk password." });
      return;
    }
    if (accessCode && !same(body.accessCode ?? "", accessCode)) {
      send(res, 401, { ok: false, error: "Wrong access code." });
      return;
    }
    const session = token();
    sessions.add(session);
    res.setHeader("set-cookie", `valhalla_session=${session}; HttpOnly; Path=/; SameSite=Strict`);
    send(res, 200, { ok: true });
    return;
  }
  const gated = Boolean(password || accessCode);
  if (gated && pathname.startsWith("/api/") && !sessions.has(cookie(req))) {
    send(res, 401, { ok: false, error: "Sign in on this PC first.", login: true });
    return;
  }
  if (req.method === "GET" && pathname === "/api/ads/report") {
    send(res, 200, await loadAdReport(process.env));
    return;
  }
  if (req.method === "GET" && pathname === "/api/live-balance") {
    const address = url.searchParams.get("address") || engine.watchPubkey || "";
    try {
      const live = await fetchLiveSol(address, publicRpcUrl(engine.publicEnv()));
      send(res, 200, { ok: true, sol: live.sol, at: Date.now(), short: tail4(address) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "balance failed";
      send(res, 200, { ok: false, error: message });
    }
    return;
  }
  if (req.method === "GET" && pathname === "/api/offers") {
    const placement = url.searchParams.get("placement") || "tools";
    const paid = await deskPaid(engine);
    send(res, 200, {
      ok: true,
      label: AFFILIATE_LABEL,
      advice: "Not trading advice.",
      offers: offersFor(placement, paid),
      score: paid ? "" : contextForScore(20, false),
      report: contextForReport(paid),
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/offers/click") {
    const body = (await readBody(req)) as { id?: string; placement?: string };
    const id = String(body.id ?? "");
    const placement = String(body.placement ?? "");
    if (!/^[a-z0-9-]{1,40}$/.test(id) || !/^[a-z0-9-]{1,40}$/.test(placement)) {
      send(res, 400, { ok: false, error: "Offer id required." });
      return;
    }
    const brain = process.env.VALHALLA_BRAIN_URL?.replace(/\/$/, "");
    if (brain) {
      await fetch(`${brain}/v1/offers/click`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, placement }),
      }).catch(() => undefined);
    }
    send(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && pathname === "/api/pro-trades") {
    const view = await proTradeView(engine.dataDir);
    send(res, 200, { ok: true, ...view, lifetime: false });
    return;
  }
  if (req.method === "GET" && pathname === "/api/plan") {
    const store = new LicenseStore(engine.dataDir);
    const record = await store.read();
    const graceMs = store.config.offlineGraceDays * 24 * 60 * 60 * 1000;
    const pro = record
      ? record.status === "active" && Date.now() - record.validatedAt <= graceMs
      : false;
    const tier = tierFor({ pro, trialStartedAt: null, now: Date.now() });
    send(res, 200, {
      ok: true,
      tier,
      prices: PLAN_PRICES,
      paywall: paywallCopy(PLAN_PRICES),
      rows: comparisonRows(),
      ads: tier === "free",
      trialDays: TRIAL_MS / 86400000,
    });
    return;
  }
  if (req.method === "GET" && pathname === "/api/license") {
    const store = new LicenseStore(engine.dataDir);
    const record = await store.read();
    const graceMs = store.config.offlineGraceDays * 24 * 60 * 60 * 1000;
    const pro = record
      ? record.status === "active" && Date.now() - record.validatedAt <= graceMs
      : false;
    send(res, 200, store.view(record, pro));
    return;
  }
  if (req.method === "GET" && pathname === "/api/update") {
    const info = await checkDesktopUpdate(DESK_VERSION).catch(() => ({
      update: false,
      latest: DESK_VERSION,
      notes: WHATS_NEW.join(" "),
      prompt: UPDATE_PROMPT,
    }));
    send(res, 200, { ok: true, version: DESK_VERSION, ...info });
    return;
  }
  if (req.method === "GET" && pathname === "/api/whats-new") {
    const update = await checkDesktopUpdate(DESK_VERSION).catch(() => ({
      update: false,
      latest: DESK_VERSION,
      notes: WHATS_NEW.join(" "),
      prompt: UPDATE_PROMPT,
    }));
    send(res, 200, { ok: true, version: DESK_VERSION, notes: WHATS_NEW, ...update });
    return;
  }
  if (req.method === "GET" && pathname === "/api/signal") {
    const mint = url.searchParams.get("mint") ?? "";
    const result = await signalScore(mint, {
      url: process.env.VALHALLA_BRAIN_URL,
      key: process.env.VALHALLA_BRAIN_KEY,
    });
    const paid = await deskPaid(engine);
    send(res, 200, { ok: true, mint, ...result, offer: contextForScore(result.score, paid) });
    return;
  }
  if (req.method === "GET" && pathname === "/api/brain") {
    send(res, 200, { ok: true, ...brainFor(engine.dataDir).view() });
    return;
  }
  if (req.method === "GET" && pathname === "/api/self-repair") {
    const proposal = proposeFix(engine.logs.map((row) => row.text));
    engine.repairProposal = proposal;
    send(res, 200, {
      ok: true,
      health: engine.healthNow(),
      events: engine.repairLog.events,
      proposal,
    });
    return;
  }
  if (req.method === "GET" && pathname === "/api/connections") {
    send(res, 200, { ok: true, connections: connectionView(engine) });
    return;
  }
  if (req.method === "GET" && pathname === "/api/pnl.csv") {
    send(res, 200, csvFor(engine), "text/csv");
    return;
  }
  if (req.method === "GET" && pathname === "/api/state") {
    send(res, 200, stateView(engine));
    return;
  }
  if (req.method === "GET" && pathname === "/api/meta") {
    send(res, 200, {
      ...metaView(engine),
      accessRequired: Boolean(accessCode),
      passwordRequired: Boolean(password),
    });
    return;
  }
  if (req.method === "GET" && pathname === "/api/pnl") {
    send(res, 200, pnlView(engine));
    return;
  }
  if (req.method === "GET" && pathname === "/api/wallets") {
    send(res, 200, walletDots());
    return;
  }
  if (req.method === "GET" && pathname === "/api/decisions") {
    send(res, 200, { lines: decisionLines(engine) });
    return;
  }
  if (req.method === "GET" && pathname === "/api/log") {
    send(res, 200, { rows: engine.logs.slice(0, 100) });
    return;
  }
  if (req.method === "GET" && pathname === "/api/qr") {
    const address = engine.activePubkey();
    if (!address) {
      send(res, 200, { svg: "", address: "" });
      return;
    }
    send(res, 200, { svg: await qrSvg(address), address, short: tail4(address) });
    return;
  }
  if (req.method === "POST") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const result = await post(engine, pathname, body);
    send(res, result.status, result.body);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "method not allowed", "text/plain");
    return;
  }
  const file = pathname === "/" ? "/index.html" : pathname === "/night" ? "/night.html" : pathname;
  const full = path.resolve(PUBLIC_DIR, `.${file}`);
  if (!full.startsWith(PUBLIC_DIR)) {
    send(res, 403, "no", "text/plain");
    return;
  }
  const type = full.endsWith(".css")
    ? "text/css"
    : full.endsWith(".js")
      ? "text/javascript"
      : full.endsWith(".jpg")
        ? "image/jpeg"
        : "text/html";
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  if (full.endsWith(".html")) {
    try {
      let html = await readFile(full, "utf8");
      if (full.endsWith(`${path.sep}index.html`)) {
        html = html.replace("<!-- valhalla-adsense -->", adsenseSnippet());
      }
      res.end(html);
    } catch {
      if (!res.headersSent) send(res, 404, "not found", "text/plain");
      else res.end();
    }
    return;
  }
  createReadStream(full)
    .on("error", () => {
      if (!res.headersSent) send(res, 404, "not found", "text/plain");
      else res.end();
    })
    .pipe(res);
}

async function post(
  engine: AgentEngine,
  pathname: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  try {
    switch (pathname) {
      case "/api/start":
        return { status: 200, body: { ok: true, message: engine.startLoop() } };
      case "/api/stop":
        return { status: 200, body: { ok: true, message: engine.stopLoop() } };
      case "/api/pause":
        return { status: 200, body: { ok: true, message: engine.setPause(true) } };
      case "/api/resume":
        return { status: 200, body: { ok: true, message: engine.setPause(false) } };
      case "/api/queue":
        return {
          status: 200,
          body: { ok: true, message: await engine.queueMint(String(body.mint ?? "")) },
        };
      case "/api/watch":
        return {
          status: 200,
          body: { ok: true, message: await engine.setWatch(String(body.address ?? "")) },
        };
      case "/api/wallet/create": {
        const created = await engine.importOrCreate(String(body.password ?? ""));
        return {
          status: 200,
          body: {
            ok: true,
            message: created.message,
            backupOnce: created.backupOnce,
            publicKey: created.publicKey,
          },
        };
      }
      case "/api/wallet/import": {
        const created = await engine.importOrCreate(
          String(body.password ?? ""),
          String(body.secret ?? "")
        );
        return {
          status: 200,
          body: {
            ok: true,
            message: created.message,
            backupOnce: null,
            publicKey: created.publicKey,
          },
        };
      }
      case "/api/wallet/unlock":
        return {
          status: 200,
          body: { ok: true, message: await engine.unlock(String(body.password ?? "")) },
        };
      case "/api/wallet/lock":
        return { status: 200, body: { ok: true, message: engine.lock() } };
      case "/api/wallet/password":
        return {
          status: 200,
          body: { ok: true, message: await engine.changePassword(String(body.password ?? "")) },
        };
      case "/api/live":
        return {
          status: 200,
          body: {
            ok: true,
            message:
              body.enabled === false
                ? engine.disarmLive()
                : engine.confirmLive(String(body.confirm ?? "")),
          },
        };
      case "/api/sell":
        return {
          status: 200,
          body: { ok: true, message: await engine.sellOne(String(body.id ?? "")) },
        };
      case "/api/sell-all":
        return {
          status: 200,
          body: { ok: true, message: await engine.sellAll(String(body.confirm ?? "")) },
        };
      case "/api/settings":
        return {
          status: 200,
          body: await engine.saveSettings(body.settings ?? body, body.confirmNow === true),
        };
      case "/api/preset":
        return {
          status: 200,
          body: {
            ok: true,
            settings: await engine.usePreset(body.preset as "safe" | "balanced" | "aggressive"),
          },
        };
      case "/api/brain/provider": {
        const provider = String(body.provider ?? "");
        if (!isBrainProvider(provider))
          return { status: 400, body: { ok: false, error: "Unknown provider." } };
        const feature = String(body.feature ?? "chat") as BrainFeature;
        await brainFor(engine.dataDir).saveKey(
          provider,
          String(body.secret ?? ""),
          String(body.password ?? "")
        );
        if (typeof body.model === "string") brainFor(engine.dataDir).setModel(feature, body.model);
        return { status: 200, body: { ok: true, ...brainFor(engine.dataDir).view() } };
      }
      case "/api/brain/ask": {
        const answer = await brainFor(engine.dataDir).complete("chat", String(body.text ?? ""));
        return { status: 200, body: { ok: true, message: answer } };
      }
      case "/api/license/activate": {
        const store = new LicenseStore(engine.dataDir);
        const result = await store.activate(
          String(body.key ?? ""),
          String(body.instanceName ?? "valhalla-desk")
        );
        return { status: result.ok === false ? 400 : 200, body: result };
      }
      case "/api/license/validate": {
        const store = new LicenseStore(engine.dataDir);
        return { status: 200, body: await store.validate() };
      }
      case "/api/brain/tune": {
        const licensed = new LicenseStore(engine.dataDir);
        const current = await licensed.validate();
        if (current.pro !== true) {
          return {
            status: 402,
            body: {
              ok: false,
              message: `Pro unlocks the strategy tuner. Price ${licensed.config.PRO_PRICE}. This is not a promise of profit.`,
            },
          };
        }
        const store = brainFor(engine.dataDir);
        const proposed = { ticketMaxSol: Math.max(0.0125, engine.settings.ticketMaxSol * 0.8) };
        const judged = tightenOnly(engine.settings, proposed);
        if (body.confirm !== true) {
          store.pending = judged.ok ? judged.settings : null;
          return {
            status: 200,
            body: { ok: false, message: judged.reason, settings: judged.settings },
          };
        }
        if (!judged.ok || !store.pending)
          return { status: 400, body: { ok: false, message: judged.reason } };
        store.history.push(engine.settings);
        const saved = await engine.saveSettings(store.pending, false);
        store.pending = null;
        return {
          status: 200,
          body: { ok: saved.ok, message: saved.message, settings: saved.settings },
        };
      }
      case "/api/brain/rollback": {
        const store = brainFor(engine.dataDir);
        const previous = store.history.pop();
        if (!previous)
          return { status: 400, body: { ok: false, message: "Nothing to roll back." } };
        const saved = await engine.saveSettings(previous, false);
        return {
          status: 200,
          body: { ok: saved.ok, message: "Rolled back.", settings: saved.settings },
        };
      }
      case "/api/self-repair/confirm": {
        const proposal = engine.repairProposal ?? proposeFix(engine.logs.map((row) => row.text));
        const before = engine.healthNow().score;
        const result = confirmRepair(
          proposal,
          body.confirm === true,
          engine.book.positions.length,
          0
        );
        if (result.applied && proposal.timeoutMs) engine.repairTimeoutMs = proposal.timeoutMs;
        engine.repairLog.add({
          title: result.reason,
          before,
          after: engine.healthNow().score,
          layer: 2,
          applied: result.applied,
        });
        return { status: 200, body: { ok: result.applied, message: result.reason } };
      }
      case "/api/connections/connect":
        return {
          status: 200,
          body: await connectLink(
            engine,
            String(body.id ?? ""),
            String(body.secret ?? ""),
            String(body.password ?? "")
          ),
        };
      case "/api/connections/test":
        return { status: 200, body: await testLink(engine, String(body.id ?? "")) };
      case "/api/connections/disconnect":
        return { status: 200, body: await disconnectLink(engine, String(body.id ?? "")) };
      case "/api/connections/alerts":
        return { status: 200, body: { ok: true, toggles: setAlertToggles(engine, body as never) } };
      case "/api/chat":
        return {
          status: 200,
          body: { ok: true, message: await engine.chat(String(body.text ?? "")) },
        };
      case "/api/update/install": {
        const manifest = await fetchVersionManifest();
        const asset = manifest?.windows;
        if (
          !asset?.sha256 ||
          !asset.url.startsWith("https://github.com/TokenJunction/eliza-valhalla/")
        ) {
          return {
            status: 409,
            body: { ok: false, error: "No signed Windows update is published." },
          };
        }
        const dest = path.join(engine.dataDir, "update", "Valhalla-Setup-x64.exe");
        const ok = await stageVerifiedDownload(asset, dest);
        if (!ok)
          return {
            status: 400,
            body: { ok: false, error: "The update hash did not match. Nothing was started." },
          };
        spawn(dest, [], { detached: true, stdio: "ignore" }).unref();
        setTimeout(() => process.exit(0), 400);
        return { status: 200, body: { ok: true, prompt: UPDATE_PROMPT } };
      }
      case "/api/keys":
        return {
          status: 200,
          body: {
            ok: true,
            message: await engine.setApiKey(String(body.name ?? ""), String(body.value ?? "")),
          },
        };
      case "/api/backup":
        return {
          status: 200,
          body: await engine.exportBackup(body.includeEncryptedWallet === true),
        };
      case "/api/restore":
        return {
          status: 200,
          body: { ok: true, message: await engine.restoreBackup(body.backup ?? body) },
        };
      default:
        return { status: 404, body: { ok: false, error: "Unknown action." } };
    }
  } catch (err) {
    return {
      status: 400,
      body: { ok: false, error: err instanceof Error ? err.message : "request failed" },
    };
  }
}

async function qrSvg(text: string): Promise<string> {
  try {
    const QR = await import("qrcode");
    return QR.toString(text, {
      type: "svg",
      margin: 1,
      color: { dark: "#f2ead8", light: "#050507" },
    });
  } catch {
    return "";
  }
}

export const DASHBOARD_HOST = HOST;
