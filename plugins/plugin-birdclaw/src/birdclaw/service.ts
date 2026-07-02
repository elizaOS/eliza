/**
 * `BIRDCLAW_SERVICE` — the one place the plugin talks to the birdclaw CLI.
 *
 * birdclaw (https://birdclaw.sh) is a local-first Twitter/X workspace: a
 * single SQLite database (default `~/.birdclaw/`) holding archived tweets,
 * mentions, DMs, likes, and bookmarks, with optional live sync through the
 * `xurl`/`bird` transports. Its stable integration surface is the CLI's
 * `--json` envelopes on stdout, which this service wraps with typed methods.
 *
 * Everything degrades explicitly: when the binary is missing, `status()`
 * reports `installed: false` with the resolution message, data methods throw
 * a typed `BirdclawCliError("not-installed")`, and the view renders a setup
 * screen instead of an error wall.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import type {
  BirdclawCounts,
  BirdclawDigestPeriod,
  BirdclawDigestResult,
  BirdclawInboxItem,
  BirdclawInboxKind,
  BirdclawResource,
  BirdclawStatusInfo,
  BirdclawSyncCollection,
  BirdclawSyncResult,
  BirdclawTransport,
  BirdclawTweet,
} from "../types.ts";
import {
  BirdclawCliError,
  type BirdclawExec,
  defaultBirdclawExec,
  runBirdclawJson,
  runBirdclawText,
} from "./cli.ts";

/** Read a setting first (per-agent), then the process env (deployment default). */
function getStr(
  runtime: IAgentRuntime | undefined,
  key: string,
): string | undefined {
  const fromSetting = runtime?.getSetting?.(key);
  if (typeof fromSetting === "string" && fromSetting.trim().length > 0) {
    return fromSetting.trim();
  }
  const fromEnv = process.env[key];
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : undefined;
}

/** Clamp a result limit into a sane [1, max] window. */
export function clampLimit(
  value: number | undefined,
  fallback: number,
  max = 100,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

export interface BirdclawSearchOptions {
  query?: string;
  resource?: BirdclawResource;
  liked?: boolean;
  bookmarked?: boolean;
  limit?: number;
}

export interface BirdclawInboxOptions {
  kind?: BirdclawInboxKind;
  limit?: number;
}

/** Build the `search tweets` argv for the given options (pure; unit-tested). */
export function buildSearchArgs(options: BirdclawSearchOptions): string[] {
  const args = ["search", "tweets"];
  const query = options.query?.trim();
  if (query) args.push(query);
  args.push("--resource", options.resource ?? "home");
  if (options.liked) args.push("--liked");
  if (options.bookmarked) args.push("--bookmarked");
  args.push("--limit", String(clampLimit(options.limit, 20)), "--json");
  return args;
}

/** Build the `inbox` argv for the given options (pure; unit-tested). */
export function buildInboxArgs(options: BirdclawInboxOptions): string[] {
  return [
    "inbox",
    "--kind",
    options.kind ?? "mixed",
    "--limit",
    String(clampLimit(options.limit, 20)),
    "--json",
  ];
}

// ---------------------------------------------------------------------------
// Wire parsing — narrow unknown JSON to the flat display DTOs, skipping (and
// counting) malformed rows instead of crashing on schema drift upstream.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function parseTweetRow(value: unknown): BirdclawTweet | null {
  const row = asRecord(value);
  if (!row) return null;
  const id = str(row.id);
  const text = str(row.text);
  const createdAt = str(row.createdAt);
  if (!id || !text || !createdAt) return null;
  const author = asRecord(row.author);
  return {
    id,
    text,
    createdAt,
    authorHandle: author ? str(author.handle) : null,
    authorName: author ? str(author.displayName) : null,
    likeCount: num(row.likeCount),
    liked: bool(row.liked) ?? false,
    bookmarked: bool(row.bookmarked) ?? false,
    isReplied: bool(row.isReplied),
    kind: str(row.kind),
  };
}

export function parseTweets(payload: unknown): BirdclawTweet[] {
  if (!Array.isArray(payload)) {
    throw new BirdclawCliError(
      "bad-json",
      "birdclaw search envelope was not an array of tweets",
    );
  }
  const tweets: BirdclawTweet[] = [];
  let skipped = 0;
  for (const row of payload) {
    const tweet = parseTweetRow(row);
    if (tweet) tweets.push(tweet);
    else skipped += 1;
  }
  if (skipped > 0) {
    logger.warn(`[BirdclawService] skipped ${skipped} malformed tweet row(s)`);
  }
  return tweets;
}

export function parseInboxItemRow(value: unknown): BirdclawInboxItem | null {
  const row = asRecord(value);
  if (!row) return null;
  const id = str(row.id);
  const text = str(row.text);
  const createdAt = str(row.createdAt);
  if (!id || !text || !createdAt) return null;
  const participant = asRecord(row.participant);
  return {
    id,
    kind: str(row.entityKind) ?? "item",
    title: str(row.title) ?? text.slice(0, 80),
    text,
    createdAt,
    needsReply: bool(row.needsReply) ?? false,
    score: num(row.score),
    participantHandle: participant ? str(participant.handle) : null,
  };
}

export function parseInboxItems(payload: unknown): BirdclawInboxItem[] {
  const envelope = asRecord(payload);
  const rows = envelope ? envelope.items : null;
  if (!Array.isArray(rows)) {
    throw new BirdclawCliError(
      "bad-json",
      "birdclaw inbox envelope had no items array",
    );
  }
  const items: BirdclawInboxItem[] = [];
  let skipped = 0;
  for (const row of rows) {
    const item = parseInboxItemRow(row);
    if (item) items.push(item);
    else skipped += 1;
  }
  if (skipped > 0) {
    logger.warn(`[BirdclawService] skipped ${skipped} malformed inbox row(s)`);
  }
  return items;
}

export function parseCounts(value: unknown): BirdclawCounts | null {
  const stats = asRecord(value);
  if (!stats) return null;
  const home = num(stats.home);
  const mentions = num(stats.mentions);
  const dms = num(stats.dms);
  const needsReply = num(stats.needsReply);
  const inbox = num(stats.inbox);
  if (
    home === null ||
    mentions === null ||
    dms === null ||
    needsReply === null ||
    inbox === null
  ) {
    return null;
  }
  return { home, mentions, dms, needsReply, inbox };
}

export function parseTransport(value: unknown): BirdclawTransport | null {
  const transport = asRecord(value);
  if (!transport) return null;
  const installed = bool(transport.installed);
  const availableTransport = str(transport.availableTransport);
  const statusText = str(transport.statusText);
  if (installed === null || !availableTransport || !statusText) return null;
  return { installed, availableTransport, statusText };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** How long a binary probe result stays fresh before re-probing. */
const AVAILABILITY_TTL_MS = 30_000;

/** Read commands finish in well under this on a local SQLite DB. */
const READ_TIMEOUT_MS = 30_000;

/** Live syncs page a remote API; give them room but never hang a route. */
const SYNC_TIMEOUT_MS = 120_000;

/** Digest calls OpenAI over the archive; slowest command we expose. */
const DIGEST_TIMEOUT_MS = 120_000;

/** Search results with embedded profiles/media metadata can be chunky. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

interface AvailabilityProbe {
  installed: boolean;
  version: string | null;
  message: string | null;
  probedAt: number;
}

export interface BirdclawServiceOptions {
  exec?: BirdclawExec;
  /** Override the probe/read/sync clock (tests). */
  now?: () => number;
}

export class BirdclawService extends Service {
  public static serviceType = "BIRDCLAW_SERVICE";

  private readonly exec: BirdclawExec;
  private readonly now: () => number;
  private probe: AvailabilityProbe | null = null;
  private probeInFlight: Promise<AvailabilityProbe> | null = null;

  constructor(runtime?: IAgentRuntime, options?: BirdclawServiceOptions) {
    super(runtime);
    this.exec = options?.exec ?? defaultBirdclawExec;
    this.now = options?.now ?? Date.now;
  }

  static async start(runtime: IAgentRuntime): Promise<BirdclawService> {
    const instance = new BirdclawService(runtime);
    const status = await instance.status();
    logger.info(
      `[BirdclawService] started (bin=${instance.binPath()}, installed=${status.installed}${
        status.version ? `, version=${status.version}` : ""
      })`,
    );
    return instance;
  }

  get capabilityDescription(): string {
    return "Local-first Twitter/X memory (birdclaw): search the archived timeline, mentions, likes, and bookmarks; trigger live syncs; build digests.";
  }

  /** The binary this service will spawn: `BIRDCLAW_BIN` or `birdclaw` on PATH. */
  binPath(): string {
    return getStr(this.runtime, "BIRDCLAW_BIN") ?? "birdclaw";
  }

  /** The data root passed to the CLI, when configured (else the CLI's own default). */
  homePath(): string | undefined {
    return getStr(this.runtime, "BIRDCLAW_HOME");
  }

  /**
   * Environment for spawned birdclaw processes: a minimal allowlist rather
   * than the full agent env (the agent process carries provider keys the CLI
   * has no business seeing). `OPENAI_API_KEY` is forwarded only from the
   * dedicated `BIRDCLAW_OPENAI_API_KEY` knob, for birdclaw's AI features.
   */
  private spawnEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.HOME) env.HOME = process.env.HOME;
    const home = this.homePath();
    if (home) env.BIRDCLAW_HOME = home;
    const openaiKey = getStr(this.runtime, "BIRDCLAW_OPENAI_API_KEY");
    if (openaiKey) env.OPENAI_API_KEY = openaiKey;
    return env;
  }

  private execOptions(timeoutMs: number) {
    return {
      env: this.spawnEnv(),
      timeoutMs,
      maxBufferBytes: MAX_BUFFER_BYTES,
    };
  }

  /**
   * Probe the binary (`--version`), memoized for {@link AVAILABILITY_TTL_MS}
   * so per-message action validation never spawns a process storm. Concurrent
   * callers share one in-flight probe.
   */
  private async ensureProbe(): Promise<AvailabilityProbe> {
    const cached = this.probe;
    if (cached && this.now() - cached.probedAt < AVAILABILITY_TTL_MS) {
      return cached;
    }
    if (this.probeInFlight) return this.probeInFlight;
    this.probeInFlight = (async (): Promise<AvailabilityProbe> => {
      try {
        const version = await runBirdclawText(
          this.exec,
          this.binPath(),
          ["--version"],
          this.execOptions(READ_TIMEOUT_MS),
        );
        return {
          installed: true,
          version: version || null,
          message: null,
          probedAt: this.now(),
        };
      } catch (err) {
        const message =
          err instanceof BirdclawCliError && err.kind === "not-installed"
            ? `birdclaw is not installed (looked for "${this.binPath()}"). Install it with: brew install steipete/tap/birdclaw`
            : err instanceof Error
              ? err.message
              : String(err);
        return {
          installed: false,
          version: null,
          message,
          probedAt: this.now(),
        };
      } finally {
        this.probeInFlight = null;
      }
    })();
    const probe = await this.probeInFlight;
    this.probe = probe;
    return probe;
  }

  /** Cheap cached availability check for action `validate`. */
  async isAvailable(): Promise<boolean> {
    return (await this.ensureProbe()).installed;
  }

  /** Install + dataset status (binary probe, then `db stats --json`). */
  async status(): Promise<BirdclawStatusInfo> {
    const probe = await this.ensureProbe();
    if (!probe.installed) {
      return {
        installed: false,
        version: null,
        home: this.homePath() ?? null,
        counts: null,
        transport: null,
        message: probe.message,
      };
    }
    try {
      const payload = await runBirdclawJson(
        this.exec,
        this.binPath(),
        ["db", "stats", "--json"],
        this.execOptions(READ_TIMEOUT_MS),
      );
      const envelope = asRecord(payload);
      const paths = envelope ? asRecord(envelope.paths) : null;
      return {
        installed: true,
        version: probe.version,
        home: (paths ? str(paths.rootDir) : null) ?? this.homePath() ?? null,
        counts: envelope ? parseCounts(envelope.stats) : null,
        transport: envelope ? parseTransport(envelope.transport) : null,
        message: null,
      };
    } catch (err) {
      // Binary present but the data root is unusable (permissions, corrupt
      // DB, unwritable disk). Report installed with the failure message so the
      // view can show a real diagnosis instead of the install screen.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[BirdclawService] db stats failed: ${message}`);
      return {
        installed: true,
        version: probe.version,
        home: this.homePath() ?? null,
        counts: null,
        transport: null,
        message,
      };
    }
  }

  /** Full-text search / listing over the archived tweets. */
  async searchTweets(options: BirdclawSearchOptions): Promise<BirdclawTweet[]> {
    const payload = await runBirdclawJson(
      this.exec,
      this.binPath(),
      buildSearchArgs(options),
      this.execOptions(READ_TIMEOUT_MS),
    );
    return parseTweets(payload);
  }

  /** Ranked mention/DM triage rows. */
  async inbox(options: BirdclawInboxOptions): Promise<BirdclawInboxItem[]> {
    const payload = await runBirdclawJson(
      this.exec,
      this.binPath(),
      buildInboxArgs(options),
      this.execOptions(READ_TIMEOUT_MS),
    );
    return parseInboxItems(payload);
  }

  /** Refresh one live collection into the local store (`sync <collection>`). */
  async sync(collection: BirdclawSyncCollection): Promise<BirdclawSyncResult> {
    const payload = await runBirdclawJson(
      this.exec,
      this.binPath(),
      ["sync", collection, "--json"],
      this.execOptions(SYNC_TIMEOUT_MS),
    );
    return { collection, ok: true, summary: summarizeSyncPayload(payload) };
  }

  /** AI digest over the archive (requires birdclaw's OpenAI key). */
  async digest(period: BirdclawDigestPeriod): Promise<BirdclawDigestResult> {
    const { stdout } = await this.exec(
      this.binPath(),
      ["digest", period, "--json"],
      this.execOptions(DIGEST_TIMEOUT_MS),
    );
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      throw new BirdclawCliError(
        "failed",
        "birdclaw digest produced no output",
      );
    }
    // The digest envelope is still settling upstream ("expect schema churn");
    // accept either a JSON envelope with a text-ish field or raw markdown.
    try {
      const parsed = asRecord(JSON.parse(trimmed) as unknown);
      const text =
        (parsed &&
          (str(parsed.digest) ?? str(parsed.text) ?? str(parsed.report))) ??
        trimmed;
      return { period, text };
    } catch {
      return { period, text: trimmed };
    }
  }

  async stop(): Promise<void> {
    this.probe = null;
    logger.info("[BirdclawService] stopped");
  }
}

/**
 * Reduce an arbitrary sync envelope to one human line. Sync envelopes vary by
 * collection and transport; surface the numeric facts they all carry.
 */
export function summarizeSyncPayload(payload: unknown): string {
  const envelope = asRecord(payload);
  if (!envelope) return "sync completed";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(envelope)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      parts.push(`${key}=${value}`);
    }
    if (parts.length >= 6) break;
  }
  return parts.length > 0
    ? `sync completed (${parts.join(", ")})`
    : "sync completed";
}
