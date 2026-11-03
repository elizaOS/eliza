import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyMarks,
  type BookState,
  considerEntry,
  createBook,
  type OpenPosition,
  openPaper,
} from "./book.ts";
import { answerChat } from "./chat.ts";
import type { CoinSnapshot, Evaluation } from "./evaluate.ts";
import { decideExit, markOutSol } from "./exits.ts";
import { dailyLossTripped } from "./filters.ts";
import {
  createTradingKeystore,
  decryptSecret,
  type KeystoreFile,
  readKeystore,
} from "./keystore.ts";
import { LIMITS, type Limits } from "./limits.ts";
import { fetchMarkPrice, loadCoinSnapshot, type RpcClient, rpcEndpoints } from "./market-data.ts";
import { netTimeoutMs, redactSecrets, tail4, withTimeout } from "./net.ts";
import { realizedFromExit, summarizePnl } from "./pnl.ts";
import { liveTradeBlocked, proTradeView, recordLiveTrade } from "./pro-allowance.ts";
import { liveTradingEnabled } from "./safety-gate.ts";
import {
  crashRecoveryAllowed,
  healthScore,
  IncidentLog,
  type RepairProposal,
} from "./self-repair.ts";
import {
  applyPreset,
  DEFAULT_SETTINGS,
  limitsFromSettings,
  type PresetName,
  parseSettings,
  type UserSettings,
} from "./user-settings.ts";

export interface LogRow {
  t: string;
  kind: string;
  text: string;
}

export interface Popup {
  id: string;
  type: string;
  title: string;
  subtitle: string;
}

export class AgentEngine {
  book: BookState;
  settings: UserSettings = { ...DEFAULT_SETTINGS };
  buysPaused = false;
  dataDir: string;
  logs: LogRow[] = [];
  pops: Popup[] = [];
  killsByRule: Record<string, number> = {};
  killsByAgent: Record<string, number> = { Scout: 0, Filter: 0, Analyst: 0, Copier: 0, Risk: 0 };
  lastActions: Record<string, string> = {
    Scout: "idle",
    Filter: "idle",
    Analyst: "idle",
    Copier: "idle",
    Risk: "idle",
  };
  signalsTotal = 0;
  ticker: Array<{ symbol: string; change1h: number }> = [];
  equityHistory: Array<{ t: number; equitySol: number; equityUsd: number }> = [];
  watchPubkey: string | null = null;
  walletMode: "none" | "watch" | "locked" | "unlocked" = "none";
  private secret: string | null = null;
  private keystore: KeystoreFile | null = null;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private queue: string[] = [];
  private startedAt = new Date().toISOString();
  private lossStreak = 0;
  private inflight = 0;
  private lastTickStart = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  pendingSettings: UserSettings | null = null;
  readonly repairLog = new IncidentLog();
  repairProposal: RepairProposal | null = null;
  repairTimeoutMs = 8_000;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? process.env.VALHALLA_DATA_DIR ?? path.join(process.cwd(), "data");
    this.book = createBook({ now: Date.now() });
  }

  async load(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await readFile(path.join(this.dataDir, "settings.json"), "utf8");
      const parsed = parseSettings(JSON.parse(raw) as unknown, DEFAULT_SETTINGS);
      if (!("ok" in parsed)) this.settings = parsed;
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
    try {
      const watch = await readFile(path.join(this.dataDir, "watch-pubkey.txt"), "utf8");
      const text = watch.trim();
      if (text) {
        this.watchPubkey = text;
        this.walletMode = "watch";
      }
    } catch {
      // No watch address yet.
    }
    this.keystore = await readKeystore(this.dataDir);
    if (this.keystore) this.walletMode = "locked";
    await this.loadLocalEnv();
    this.log(
      "boot",
      "Valhalla desk ready. Read-only until you unlock a bot wallet and confirm live trading."
    );
    this.audit("boot", "desk ready");
  }

  private async loadLocalEnv(): Promise<void> {
    try {
      const raw = await readFile(path.join(this.dataDir, "local.env"), "utf8");
      for (const line of raw.split("\n")) {
        const match =
          /^(GOOGLE_GENERATIVE_AI_API_KEY|HELIUS_API_KEY|BIRDEYE_API_KEY|VALHALLA_ACCESS_CODE|TELEGRAM_BOT_TOKEN|VALHALLA_BRAIN_URL|VALHALLA_BRAIN_KEY)=(.*)$/.exec(
            line.trim()
          );
        if (!match) continue;
        const key = match[1];
        if (!key || process.env[key]) continue;
        process.env[key] = match[2] ?? "";
      }
    } catch {
      // No saved keys yet.
    }
  }

  audit(action: string, detail: string): void {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      action,
      detail: redactSecrets(detail),
    });
    void appendFile(path.join(this.dataDir, "audit.jsonl"), `${line}\n`).catch(() => undefined);
  }

  publicEnv(): Record<string, string | undefined> {
    return {
      GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      VALHALLA_GEMINI_MODEL: process.env.VALHALLA_GEMINI_MODEL || "gemini-2.5-flash",
      VALHALLA_LIVE_TRADING: process.env.VALHALLA_LIVE_TRADING,
      HELIUS_API_KEY: process.env.HELIUS_API_KEY,
      BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY || process.env.BIRDEYE,
      VALHALLA_PUBKEY: this.activePubkey() ?? undefined,
    };
  }

  activePubkey(): string | null {
    if (this.keystore) return this.keystore.publicKey;
    return this.watchPubkey;
  }

  limits(): Limits {
    return limitsFromSettings(this.settings);
  }

  envBlocksLive(): boolean {
    return process.env.VALHALLA_LIVE_TRADING === "false";
  }

  liveReady(): boolean {
    return (
      !this.envBlocksLive() &&
      this.settings.preset !== undefined &&
      this.walletMode === "unlocked" &&
      this.secret != null &&
      liveTradingEnabled({ VALHALLA_LIVE_TRADING: this.liveArmed ? "true" : "false" })
    );
  }

  liveArmed = false;

  log(kind: string, text: string): void {
    const row: LogRow = {
      t: new Date().toISOString(),
      kind,
      text: redactSecrets(text).slice(0, 400),
    };
    this.logs.unshift(row);
    if (this.logs.length > 200) this.logs.length = 200;
    void appendFile(
      path.join(this.dataDir, "agent.log"),
      `${row.t} ${row.kind} ${row.text}\n`
    ).catch(() => undefined);
  }

  statusLine(): string {
    const mode = this.liveReady() ? "live swaps on" : "read-only";
    const run = this.book.running ? "running" : "stopped";
    const pause = this.buysPaused ? " new buys paused" : "";
    return `Desk is ${run}, ${mode}${pause}. Wallet ${tail4(this.activePubkey())}. ${this.book.positions.length} open.`;
  }

  pnlLine(): string {
    const pnl = summarizePnl(this.book.closed);
    return `Realized ${pnl.pnlSol.toFixed(4)} SOL over ${pnl.trades} closes (${pnl.wins} wins, ${pnl.losses} losses).`;
  }

  positionsLine(): string {
    if (!this.book.positions.length) return "No open positions.";
    return this.book.positions
      .map((pos) => {
        const pct = pos.entryPriceUsd > 0 ? pos.markPriceUsd / pos.entryPriceUsd - 1 : 0;
        return `${pos.symbol} ${tail4(pos.mint)} ${pos.lane} ${(pct * 100).toFixed(1)}%`;
      })
      .join("; ");
  }

  startLoop(): string {
    this.book.running = true;
    if (!this.loopTimer) {
      this.loopTimer = setInterval(() => {
        void this.tick().catch((err: unknown) => {
          this.log("loop", err instanceof Error ? err.message : "tick failed");
        });
      }, 15_000);
      this.watchdog = setInterval(() => this.recoverStall(), 5_000);
    }
    this.log("loop", "Trading loop started.");
    return this.liveReady()
      ? "Trading loop started. Live swaps are on for this unlocked bot wallet."
      : "Trading loop started in read-only mode. No chain writes.";
  }

  stopLoop(): string {
    this.book.running = false;
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.log("loop", "Trading loop stopped.");
    return "Trading loop stopped. Open exits are not forced.";
  }

  setPause(paused: boolean): string {
    this.buysPaused = paused;
    this.log("risk", paused ? "New buys paused." : "New buys allowed.");
    return paused ? "New buys are paused. Stops still run." : "New buys are allowed.";
  }

  async saveSettings(
    input: unknown,
    confirmNow = false
  ): Promise<{ ok: boolean; message: string; settings: UserSettings; pending: boolean }> {
    const parsed = parseSettings(input, this.settings);
    if ("ok" in parsed) {
      return {
        ok: false,
        message: parsed.errors.join(" "),
        settings: this.settings,
        pending: false,
      };
    }
    if (this.book.positions.length > 0 && !confirmNow) {
      this.pendingSettings = parsed;
      this.audit("settings", "queued until the book is flat");
      return {
        ok: true,
        pending: true,
        settings: this.settings,
        message:
          "Open positions are still on. The new settings apply at the next idle moment, or confirm to apply now.",
      };
    }
    this.settings = parsed;
    this.pendingSettings = null;
    await this.writeSettings();
    this.audit("settings", `applied preset ${parsed.preset}`);
    this.log("settings", `Saved preset ${this.settings.preset}. Safety checks stay on.`);
    return {
      ok: true,
      pending: false,
      message: "Settings saved. Rug and manipulation checks stay on.",
      settings: this.settings,
    };
  }

  private applyPendingSettings(): void {
    if (!this.pendingSettings || this.book.positions.length > 0) return;
    this.settings = this.pendingSettings;
    this.pendingSettings = null;
    void this.writeSettings();
    this.audit("settings", "applied queued settings on an empty book");
    this.log("settings", "Queued settings are now active.");
  }

  private async writeSettings(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(
      path.join(this.dataDir, "settings.json"),
      JSON.stringify(this.settings, null, 2)
    );
  }

  async setApiKey(name: string, value: string): Promise<string> {
    const allowed = new Set([
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "HELIUS_API_KEY",
      "BIRDEYE_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "VALHALLA_BRAIN_URL",
      "VALHALLA_BRAIN_KEY",
    ]);
    if (!allowed.has(name)) throw new Error("That key is not editable here.");
    const trimmed = value.trim();
    if (trimmed.length < 8) throw new Error("Key looks too short.");
    process.env[name] = trimmed;
    const file = path.join(this.dataDir, "local.env");
    const prior = await readFile(file, "utf8").catch(() => "");
    const lines = prior.split("\n").filter((line) => line && !line.startsWith(`${name}=`));
    lines.push(`${name}=${trimmed}`);
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600 });
    this.audit("keys", `updated ${name}`);
    return "Saved. The key stays on this PC and is not shown again.";
  }

  keysPresent(): { google: boolean; helius: boolean; birdeye: boolean } {
    return {
      google: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
      helius: Boolean(process.env.HELIUS_API_KEY),
      birdeye: Boolean(process.env.BIRDEYE_API_KEY || process.env.BIRDEYE),
    };
  }

  async changePassword(password: string): Promise<string> {
    if (!this.secret || !this.keystore) throw new Error("Unlock the bot wallet first.");
    await createTradingKeystore(this.dataDir, password, this.secret);
    this.keystore = await readKeystore(this.dataDir);
    this.audit("wallet", "password changed");
    return "Password changed. The key stays encrypted on this PC.";
  }

  async exportBackup(includeEncryptedWallet: boolean): Promise<Record<string, unknown>> {
    const keystore = includeEncryptedWallet ? await readKeystore(this.dataDir) : null;
    this.audit(
      "backup",
      includeEncryptedWallet ? "exported settings and encrypted wallet" : "exported settings"
    );
    return {
      kind: "valhalla-backup",
      version: 1,
      settings: this.settings,
      watchPubkey: this.watchPubkey,
      keystore,
    };
  }

  async restoreBackup(body: unknown): Promise<string> {
    const src = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (src.kind !== "valhalla-backup") throw new Error("That file is not a Valhalla backup.");
    const saved = await this.saveSettings(src.settings, false);
    if (!saved.ok) throw new Error(saved.message);
    const keystore = src.keystore;
    if (keystore && typeof keystore === "object") {
      const file = keystore as { version?: number; publicKey?: string; ciphertext?: string };
      if (file.version !== 1 || !file.publicKey || !file.ciphertext)
        throw new Error("Encrypted wallet backup is not valid.");
      const { writeKeystore } = await import("./keystore.ts");
      await writeKeystore(this.dataDir, keystore as never);
      this.keystore = await readKeystore(this.dataDir);
      this.secret = null;
      this.walletMode = "locked";
      this.liveArmed = false;
    }
    this.audit("restore", "restored a backup");
    return "Backup restored. Unlock the wallet with its password.";
  }

  async drain(): Promise<void> {
    this.buysPaused = true;
    const start = Date.now();
    while (this.inflight > 0 && Date.now() - start < 8_000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.stopLoop();
    this.audit("shutdown", `drain inflight=${this.inflight}`);
  }

  private recoverStall(): void {
    if (!this.book.running || !this.ticking) return;
    if (Date.now() - this.lastTickStart < 30_000) return;
    const before = this.healthNow().score;
    const allowed = crashRecoveryAllowed(this.book.positions.length, this.inflight);
    if (!allowed.ok) {
      this.log("watchdog", allowed.reason);
      this.repairLog.add({
        title: allowed.reason,
        before,
        after: before,
        layer: 1,
        applied: false,
      });
      return;
    }
    this.ticking = false;
    this.log("watchdog", "Recovered a stalled loop. No positions were open.");
    this.audit("watchdog", "recovered stalled loop");
    this.repairLog.add({
      title: "Watchdog recovered a stalled loop.",
      before,
      after: this.healthNow().score,
      layer: 1,
      applied: true,
    });
  }

  /**
   * Phone request for the safe watchdog recovery.
   * The loop is restarted only when no position is open.
   */
  healthNow(now = Date.now()): { score: number; label: "healthy" | "degraded" | "critical" } {
    const beat = this.heartbeat(now);
    return healthScore({
      stalled: beat.stalled,
      breakerOpen: false,
      unknownBalance: false,
      mismatch: false,
      providerFails: 0,
    });
  }

  recoverFromPhone(now = Date.now()): { restarted: boolean; message: string } {
    const allowed = crashRecoveryAllowed(this.book.positions.length, this.inflight);
    if (!allowed.ok) {
      this.log("watchdog", "Recovery refused. Open positions stay put.");
      this.audit("watchdog", "phone recovery refused while positions are open");
      return {
        restarted: false,
        message: allowed.reason,
      };
    }
    const age = this.lastTickStart > 0 ? now - this.lastTickStart : Number.POSITIVE_INFINITY;
    const stalled = this.book.running && this.ticking && age >= 30_000;
    const stopped = !this.loopTimer || !this.book.running;
    if (!stalled && !stopped) {
      return {
        restarted: false,
        message: "The loop is running. No positions were open, so it was left as it is.",
      };
    }
    this.ticking = false;
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const message = this.startLoop();
    this.log("watchdog", "Recovered the loop. No positions were open.");
    this.audit("watchdog", "recovered stalled loop");
    return {
      restarted: true,
      message: `Recovered the loop. No positions were open. ${message}`,
    };
  }

  heartbeat(now = Date.now()): {
    online: true;
    stalled: boolean;
    running: boolean;
    openPositions: number;
    lastTickMs: number | null;
    ageMs: number | null;
  } {
    const lastTickMs = this.lastTickStart > 0 ? this.lastTickStart : null;
    const ageMs = lastTickMs == null ? null : now - lastTickMs;
    return {
      online: true,
      stalled: Boolean(this.book.running && this.ticking && ageMs != null && ageMs >= 30_000),
      running: this.book.running,
      openPositions: this.book.positions.length,
      lastTickMs,
      ageMs,
    };
  }

  /** Test hook. Marks the current tick as stuck. */
  markStuckTickForTests(ageMs: number): void {
    this.book.running = true;
    this.ticking = true;
    this.lastTickStart = Date.now() - ageMs;
    this.loopTimer = this.loopTimer ?? setInterval(() => undefined, 60_000);
  }

  private async track<T>(work: Promise<T>): Promise<T> {
    this.inflight += 1;
    try {
      return await work;
    } finally {
      this.inflight -= 1;
    }
  }

  async usePreset(name: PresetName): Promise<UserSettings> {
    const next = applyPreset(name, this.settings);
    await this.saveSettings(next, this.book.positions.length === 0);
    return this.settings;
  }

  startedIso(): string {
    return this.startedAt;
  }

  needsSetup(): boolean {
    return !this.keystore;
  }

  async setWatch(address: string): Promise<string> {
    const trimmed = address.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed))
      throw new Error("That is not a Solana address.");
    this.watchPubkey = trimmed;
    if (!this.keystore) this.walletMode = "watch";
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(path.join(this.dataDir, "watch-pubkey.txt"), `${trimmed}\n`, { mode: 0o600 });
    this.log("wallet", `Watch-only address ${tail4(trimmed)}. No trading from this address.`);
    return `Watching ${tail4(trimmed)}. This address cannot trade.`;
  }

  async importOrCreate(
    password: string,
    secret?: string
  ): Promise<{ message: string; backupOnce: string | null; publicKey: string }> {
    const created = await createTradingKeystore(this.dataDir, password, secret);
    this.keystore = await readKeystore(this.dataDir);
    this.secret = secret ? secret.trim() : created.backupOnce;
    this.walletMode = "unlocked";
    this.armLock();
    const message = secret
      ? `Bot wallet ${tail4(created.publicKey)} saved. The key is encrypted and will not be shown again.`
      : `New bot wallet ${tail4(created.publicKey)}. Copy the backup now. It is shown once. Use a small wallet, not your main wallet.`;
    this.log("wallet", secret ? "Imported a bot wallet." : "Generated a bot wallet.");
    return { message, backupOnce: created.backupOnce, publicKey: created.publicKey };
  }

  async unlock(password: string): Promise<string> {
    const file = this.keystore ?? (await readKeystore(this.dataDir));
    if (!file) throw new Error("No trading wallet yet.");
    this.secret = await decryptSecret(file, password);
    this.keystore = file;
    this.walletMode = "unlocked";
    this.armLock();
    this.log("wallet", "Wallet unlocked in memory.");
    return `Unlocked ${tail4(file.publicKey)}.`;
  }

  lock(): string {
    this.secret = null;
    this.liveArmed = false;
    this.walletMode = this.keystore ? "locked" : this.watchPubkey ? "watch" : "none";
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = null;
    this.log("wallet", "Wallet locked. The key is not in memory.");
    return "Locked. Live trading is off.";
  }

  private armLock(): void {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    const ms = this.settings.autoLockMin * 60_000;
    this.lockTimer = setTimeout(() => this.lock(), ms);
  }

  confirmLive(confirm: string): string {
    if (this.envBlocksLive())
      return "VALHALLA_LIVE_TRADING=false in .env. The desk stays read-only.";
    if (confirm.trim() !== "CONFIRM LIVE") return "Type CONFIRM LIVE to allow swaps.";
    if (this.walletMode !== "unlocked" || !this.secret)
      return "Unlock the bot wallet first. A watch-only address cannot trade.";
    this.liveArmed = true;
    this.log("risk", "Live swaps armed for the unlocked bot wallet.");
    return "Live swaps are armed. The desk still cannot send SOL to another address.";
  }

  disarmLive(): string {
    this.liveArmed = false;
    this.log("risk", "Live swaps disarmed. Read-only.");
    return "Read-only. Stops still run on paper marks.";
  }

  async evaluateProvided(snapshot: CoinSnapshot): Promise<string> {
    const { evaluation, slotsLeft } = considerEntry(this.book, snapshot, this.limits());
    this.lastActions.Filter = evaluation.ok ? `pass ${tail4(snapshot.mint)}` : evaluation.reason;
    if (!evaluation.ok) {
      this.killsByRule[evaluation.reason] = (this.killsByRule[evaluation.reason] ?? 0) + 1;
      this.audit("filter", evaluation.reason);
      return `Blocked ${tail4(snapshot.mint)}: ${evaluation.reason}`;
    }
    if (!this.book.running)
      return `Pass ${tail4(snapshot.mint)} ${evaluation.lane} ${evaluation.sizeSol} SOL. Loop is stopped, so nothing was bought.`;
    if (this.buysPaused) return `Pass ${tail4(snapshot.mint)}. New buys are paused.`;
    if (!slotsLeft) return `Pass ${tail4(snapshot.mint)}. No open slot.`;
    return this.openFromEvaluation(snapshot, evaluation);
  }

  async queueMint(mint: string): Promise<string> {
    const trimmed = mint.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) return "Give a Solana mint address.";
    this.signalsTotal += 1;
    this.lastActions.Scout = `queued ${tail4(trimmed)}`;
    const line = await this.evaluateQueued(trimmed);
    this.log("queue", line);
    return line;
  }

  private async evaluateQueued(mint: string): Promise<string> {
    let snapshot: CoinSnapshot;
    try {
      snapshot = await withTimeout(
        loadCoinSnapshot(mint, { rpc: this.rpc() }),
        netTimeoutMs(),
        "coin scan"
      );
    } catch (err) {
      this.killsByAgent.Scout += 1;
      const message = err instanceof Error ? err.message : "scan failed";
      return `Scan ${tail4(mint)} failed: ${redactSecrets(message)}`;
    }
    if (snapshot.symbol) {
      this.ticker.unshift({ symbol: snapshot.symbol, change1h: snapshot.change1hPct ?? 0 });
      this.ticker = this.ticker.slice(0, 12);
    }
    const { evaluation, slotsLeft } = considerEntry(this.book, snapshot, this.limits());
    this.lastActions.Filter = evaluation.ok ? `pass ${tail4(mint)}` : evaluation.reason;
    this.lastActions.Analyst = evaluation.ok
      ? `${evaluation.lane} ${evaluation.sizeSol} SOL`
      : "blocked";
    if (!evaluation.ok) {
      this.killsByRule[evaluation.reason] = (this.killsByRule[evaluation.reason] ?? 0) + 1;
      this.killsByAgent.Filter += 1;
      return `Blocked ${tail4(mint)}: ${evaluation.reason}`;
    }
    if (!this.book.running)
      return `Pass ${tail4(mint)} ${evaluation.lane} ${evaluation.sizeSol} SOL. Loop is stopped, so nothing was bought.`;
    if (this.buysPaused) return `Pass ${tail4(mint)}. New buys are paused.`;
    if (!slotsLeft) return `Pass ${tail4(mint)}. No open slot.`;
    if (this.pastRunTimer()) return `Pass ${tail4(mint)}. Run timer has ended.`;
    return this.openFromEvaluation(snapshot, evaluation);
  }

  private async openFromEvaluation(
    snapshot: CoinSnapshot,
    evaluation: Evaluation
  ): Promise<string> {
    if (this.liveReady()) {
      const allowance = await proTradeView(this.dataDir);
      if (liveTradeBlocked(allowance)) {
        return "Free Pro trades are used up. Go Pro for more live trades. Paper mode still runs. Not a promise of profit.";
      }
      const { executeLiveSwap } = await import("./live-swap.ts");
      const fill = await this.track(
        withTimeout(
          executeLiveSwap({
            env: this.swapEnv(),
            side: "buy",
            mint: snapshot.mint,
            sol: evaluation.sizeSol,
            sendRaw: (raw) => this.sendRaw(raw),
          }),
          netTimeoutMs(),
          "live buy"
        )
      );
      const position = openPaper(this.book, snapshot, evaluation);
      position.paper = false;
      position.signature = fill.signature;
      position.rawAmount = fill.outAmount;
      await recordLiveTrade(this.dataDir, fill.signature);
      this.lastActions.Copier = `bought ${tail4(snapshot.mint)}`;
      this.note(`BUY ${snapshot.symbol ?? tail4(snapshot.mint)}`, tail4(fill.signature));
      return `Live buy ${tail4(snapshot.mint)} ${evaluation.sizeSol} SOL. Tx ${tail4(fill.signature)}.`;
    }
    openPaper(this.book, snapshot, evaluation);
    this.lastActions.Copier = `paper ${tail4(snapshot.mint)}`;
    this.note(`PAPER ${snapshot.symbol ?? tail4(snapshot.mint)}`, `${evaluation.sizeSol} SOL`);
    return `Paper fill ${tail4(snapshot.mint)} ${evaluation.lane} ${evaluation.sizeSol} SOL.`;
  }

  async sellOne(id: string): Promise<string> {
    const pos = this.book.positions.find((row) => row.id === id);
    if (!pos) return "That position is not open.";
    await this.exitPosition(pos, "manual sell");
    return `Sell sent for ${pos.symbol} ${tail4(pos.mint)}.`;
  }

  async sellAll(confirm: string): Promise<string> {
    if (confirm.trim() !== "SELL ALL") return "Type SELL ALL to close every open position.";
    const rows = [...this.book.positions];
    for (const pos of rows) await this.exitPosition(pos, "sell all");
    this.buysPaused = true;
    return `Closed ${rows.length} position(s). New buys are paused.`;
  }

  private async exitPosition(pos: OpenPosition, reason: string): Promise<void> {
    if (!pos.paper) {
      if (!this.liveReady())
        throw new Error("Unlock the bot wallet and confirm live trading before an on-chain sell.");
      const { executeLiveSwap } = await import("./live-swap.ts");
      const fill = await this.track(
        withTimeout(
          executeLiveSwap({
            env: this.swapEnv(),
            side: "sell",
            mint: pos.mint,
            rawAmount: pos.rawAmount,
            sendRaw: (raw) => this.sendRaw(raw),
          }),
          netTimeoutMs(),
          "live sell"
        )
      );
      pos.signature = fill.signature;
      await recordLiveTrade(this.dataDir, fill.signature);
    }
    this.bookClose(pos, reason);
    this.lastActions.Risk = `${reason} ${tail4(pos.mint)}`;
  }

  private bookClose(pos: OpenPosition, reason: string): void {
    const out = markOutSol(pos, pos.markPriceUsd, this.limits()) ?? pos.costSol;
    const realized = realizedFromExit(out, pos.costSol, this.book.solUsd);
    this.book.closed.unshift({
      mint: pos.mint,
      lane: pos.lane,
      costSol: pos.costSol,
      exitSol: out,
      solUsd: this.book.solUsd,
      closedAt: Date.now(),
      reason,
    });
    this.book.freeSol += out;
    this.book.positions = this.book.positions.filter((row) => row.id !== pos.id);
    if (realized.pnlSol < 0) {
      this.lossStreak += 1;
      if (this.lossStreak >= 3) {
        this.buysPaused = true;
        this.lossStreak = 0;
        this.audit("breaker", "3 losses in a row. New buys paused.");
        this.log("breaker", "3 losses in a row. New buys paused. Stops stay on.");
      }
    } else if (realized.pnlSol > 0) {
      this.lossStreak = 0;
    }
    if (this.book.positions.length === 0) this.applyPendingSettings();
    this.book.cooldowns[pos.mint] = Date.now() + this.limits().rebuyCooldownMs;
    this.note(reason, `${pos.symbol} ${realized.pnlSol.toFixed(4)} SOL`);
    this.log("exit", `${reason} ${tail4(pos.mint)} ${realized.pnlSol.toFixed(4)} SOL`);
  }

  private note(title: string, subtitle: string): void {
    if (!this.settings.alerts) return;
    this.pops.unshift({
      id: `${Date.now()}-${title}`,
      type: title,
      title,
      subtitle: redactSecrets(subtitle),
    });
    if (this.pops.length > 20) this.pops.length = 20;
  }

  private pastRunTimer(): boolean {
    if (!this.settings.runUntil) return false;
    return Date.now() >= Date.parse(this.settings.runUntil);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.lastTickStart = Date.now();
    try {
      if (dailyLossTripped(this.book.equitySol, this.book.dayStartEquitySol, this.limits())) {
        this.buysPaused = true;
        this.log("risk", "Daily loss limit hit. New buys paused.");
      }
      if (this.book.positions.length === 0) this.applyPendingSettings();
      if (this.pastRunTimer() && this.book.positions.length) {
        await this.sellAll("SELL ALL");
        this.stopLoop();
        this.log("timer", "Run timer ended. Positions closed and the loop stopped.");
        return;
      }
      if (!this.book.running || this.book.positions.length === 0) return;
      for (const pos of this.book.positions) {
        try {
          const price = await withTimeout(
            fetchMarkPrice(pos.mint, this.publicEnv()),
            netTimeoutMs(),
            "mark"
          );
          if (price && price > 0) {
            pos.markPriceUsd = price;
            pos.markAt = Date.now();
            if (price > pos.peakPriceUsd) pos.peakPriceUsd = price;
          }
        } catch (err) {
          this.log("mark", err instanceof Error ? err.message : "mark timeout");
        }
      }
      const limits = this.limits();
      const live = this.book.positions.filter((pos) => !pos.paper);
      this.book.positions = this.book.positions.filter((pos) => pos.paper);
      applyMarks(
        this.book,
        this.book.positions.map((pos) => ({
          mint: pos.mint,
          priceUsd: pos.markPriceUsd,
          quoteOk: false,
        })),
        Date.now(),
        limits
      );
      for (const pos of live) {
        const decision = decideExit(
          pos,
          { now: Date.now(), sessionStartedAt: this.book.sessionStartedAt, quoteOk: false },
          limits
        );
        if (decision.action === "hold") {
          this.book.positions.push(pos);
          continue;
        }
        try {
          await this.exitPosition(pos, decision.reason);
        } catch (err) {
          this.book.positions.push(pos);
          this.log("exit", err instanceof Error ? err.message : "live exit skipped");
        }
      }
      this.equityHistory.push({
        t: Date.now(),
        equitySol: this.book.equitySol,
        equityUsd: this.book.equitySol * this.book.solUsd,
      });
      if (this.equityHistory.length > 240) this.equityHistory.shift();
      this.lastActions.Risk = "stops checked";
    } finally {
      this.ticking = false;
    }
  }

  async balanceSol(): Promise<number | null> {
    const owner = this.activePubkey();
    if (!owner) return null;
    try {
      const result = await withTimeout(
        this.rpc().call("getBalance", [owner]),
        netTimeoutMs(),
        "balance"
      );
      const value = (result as { value?: number } | null)?.value;
      return typeof value === "number" ? value / 1e9 : null;
    } catch (err) {
      this.log("rpc", err instanceof Error ? err.message : "balance timeout");
      return null;
    }
  }

  async chat(text: string): Promise<string> {
    return answerChat(this, text);
  }

  private swapEnv(): Record<string, string | undefined> {
    return {
      ...this.publicEnv(),
      VALHALLA_LIVE_TRADING: "true",
      VALHALLA_WALLET_SECRET_KEY: this.secret ?? "",
      VALHALLA_PUBKEY: this.keystore?.publicKey,
    };
  }

  private rpc(): RpcClient {
    const urls = rpcEndpoints(this.publicEnv());
    return {
      async call(method, params) {
        let last = "rpc failed";
        for (const url of urls) {
          const response = await withTimeout(
            fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            }),
            netTimeoutMs(),
            method
          );
          const body = (await response.json()) as {
            result?: unknown;
            error?: { message?: string };
          };
          if (!body.error) return body.result;
          last = body.error.message ?? last;
        }
        throw new Error(redactSecrets(last));
      },
    };
  }

  private async sendRaw(base64: string): Promise<string> {
    let last = "send failed";
    for (const url of rpcEndpoints(this.publicEnv())) {
      const response = await withTimeout(
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "sendTransaction",
            params: [base64, { encoding: "base64" }],
          }),
        }),
        netTimeoutMs(),
        "sendTransaction"
      );
      const body = (await response.json()) as { result?: string; error?: { message?: string } };
      if (body.result) return body.result;
      last = body.error?.message ?? last;
    }
    throw new Error(redactSecrets(last));
  }
}

let singleton: AgentEngine | null = null;

export function getEngine(): AgentEngine {
  if (!singleton) singleton = new AgentEngine();
  return singleton;
}

export function engineForTests(dataDir: string): AgentEngine {
  return new AgentEngine(dataDir);
}
