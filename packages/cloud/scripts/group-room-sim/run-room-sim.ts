/**
 * Five-room synthetic group-chat simulation driver: replays one homepage demo
 * room (packages/homepage/src/lib/landing-demo.ts, read at runtime through
 * ./rooms-spec.ts) against a running cloud stack by POSTing synthetic Blooio
 * v4 webhooks, reads Eliza's outbound group sends back from the mock
 * provider's capture surface, and scores BEHAVIORAL assertions. It is a
 * live-model evaluation, never a CI gate; the homepage lines are not expected
 * verbatim. README.md carries the env contract, the boot recipe and how to
 * read results/<room>.{json,md}.
 *
 * Choreography (mirrors packages/cloud/api/internal/eliza-app/personal-shared/
 * messages/route.ts): owner DMs /group and the link code is parsed from the
 * reply; a non-owner member speaks in the still-unlinked group and a bounded
 * no-send window must stay empty; the owner posts "Eliza link CODE" (and
 * "Eliza ambient on" when the script has Eliza interject unprompted); then
 * the human lines replay in script order, polling for replies only where the
 * script has an Eliza step next and holding a silence window everywhere else.
 *
 * Anti-gaming invariants: echoed human text (exact / containment /
 * token-Jaccard >= 0.8) fails the run and earns no fact or speaker credit;
 * only outbound, non-human capture entries are ever scored; link/ambient acks
 * are scanned for forbidden claims; FACTS_MIN and MIN_RESPONSES floor at 1.
 * Captures carry no provider timestamps, so a reply landing after its window
 * closes is attributed to the next poll (windows default long enough that a
 * reply-to-everything bot still blows past UNSOLICITED_MAX).
 */

import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FACT_PATTERNS, ROOM_KEY_FACTS } from "./room-facts";
import {
  buildRoomsSpec,
  forbiddenHits,
  OWNER_SENDER,
  type RoomSpec,
  type RoomsSpec,
} from "./rooms-spec";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");

export const DEFAULT_OWNER_HANDLE = "+15550000001";
export const DEFAULT_ELIZA_HANDLE = "+15550009999";
/** Neutral text for the pre-link probe: no Eliza mention/command, and no
 * overlap with any room's fact vocabulary. */
export const PRE_LINK_PROBE_TEXT = "hey did everyone make it in here";

// ── Result types ───────────────────────────────────────────────────────────

export interface StepRecord {
  human?: string; // sender name for human steps
  eliza?: boolean;
  position?: number;
  expected?: boolean; // eliza: was this an expected speaking point
  silent?: boolean; // eliza expected point with no reply inside the wait
  unsolicited?: boolean; // eliza send in a scripted-silence window / trailing
  echoOf?: string; // human message this output near-copies, if any
  text: string;
  matchedFacts?: string[];
  forbiddenHits?: string[];
}

export interface CaptureEntry {
  text: string;
  chat: string;
}

export interface Thresholds {
  waitMs: number;
  pollMs: number;
  paceMs: number;
  silenceMs: number;
  unsolicitedMax: number;
  factsMin: number;
  minResponses: number;
}

export interface Plan {
  room: RoomSpec;
  roomOrdinal: number;
  ownerHandle: string;
  elizaHandle: string;
  /** Cast name -> synthetic phone handle (owner included as OWNER_SENDER). */
  handleFor: Map<string, string>;
  humanHandles: Set<string>;
  groupChatId: string;
  dmChatId: string;
  probe: { sender: string; text: string };
  /** True when some scripted Eliza point is not preceded by a mention. */
  ambient: boolean;
  /** Forbidden-claim categories the room's scripted capabilities allow. */
  allowedCategories: Set<string>;
  /** Human positions after which the script has NO Eliza step next. */
  silentWindowPositions: number[];
}

export interface Assertions {
  respondedAtExpectedPoints: {
    pass: boolean;
    respondedPoints: number;
    expectedPoints: number;
    minRequired: number;
  };
  silentUntilLinked: {
    pass: boolean;
    probe: { sender: string; text: string; windowMs: number };
    preLinkSends: number;
  };
  restraintAtUnscriptedPoints: {
    pass: boolean;
    unsolicitedSends: number;
    maxAllowed: number;
    windowMs: number;
  };
  noEchoedHumanText: { pass: boolean; echoes: number; samples: string[] };
  keyFactsReferenced: {
    pass: boolean;
    matched: string[];
    factfulExpectedPoints: number;
    minRequired: number;
    available: number;
  };
  distinctExpectedReplies: {
    pass: boolean;
    replies: number;
    distinct: number;
  };
  noDetectedUnsupportedFirstPersonClaims: {
    pass: boolean;
    hits: string[];
    allowedCategories: string[];
  };
  speakerAwareness: { pass: boolean; members: readonly string[] };
}

export interface RunResult {
  room: string;
  roomName: string;
  ambient: boolean;
  steps: StepRecord[];
  assertions: Assertions;
  verdict: "PASS" | "FAIL";
}

/** The I/O seam of a run: the real one speaks HTTP, tests script a bot. */
export interface RunIo {
  /** POST one synthetic Blooio delivery (raw JSON body) to the webhook. */
  postWebhook(body: string): Promise<void>;
  /** Read the whole outbound capture: a JSON array or {messages:[...]}. */
  readCapture(): Promise<unknown>;
  log(line: string): void;
}

/** Fatal harness condition (bad env, unreachable stack, no link code). The
 * CLI reports it and exits 2; a FAIL verdict is a different, exit-1 outcome. */
export class RoomSimError extends Error {}

function fail(msg: string, cause?: unknown): never {
  throw new RoomSimError(msg, cause === undefined ? undefined : { cause });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function intEnv(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const v = env[name];
  if (!v) return dflt;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) {
    fail(`${name} must be a non-negative integer, got: ${v}`);
  }
  return n;
}

// ── Echo detection ─────────────────────────────────────────────────────────

function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenSet(s: string): Set<string> {
  return new Set(normText(s).split(" ").filter(Boolean));
}

/** Remove common credential forms before capture text reaches logs/artifacts. */
export function redactCredentials(text: string): string {
  return text
    .replace(
      /\b(bearer|basic)\s+[a-z0-9._~+/=-]+/gi,
      (_match, scheme: string) => `${scheme} [REDACTED]`,
    )
    .replace(
      /([?&](?:api[_-]?key|token|secret|signature|password)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:sk|key|token|secret)[-_][a-z0-9_-]{12,}\b/gi, "[REDACTED]");
}

/**
 * Returns the human message this output near-copies, or null. An echo is an
 * exact normalized match, containment of a >=4-token human line, or a
 * token-Jaccard >= 0.8 against a >=3-token human line. Legitimate replies
 * that merely reference the same nouns score far below these thresholds.
 */
export function echoOfHuman(
  text: string,
  humanTexts: readonly string[],
): string | null {
  const no = normText(text);
  if (!no) return null;
  const to = tokenSet(text);
  for (const h of humanTexts) {
    const nh = normText(h);
    if (!nh) continue;
    if (no === nh) return h;
    const th = tokenSet(h);
    if (th.size >= 4 && no.includes(nh)) return h;
    if (th.size >= 3) {
      let inter = 0;
      for (const t of th) if (to.has(t)) inter += 1;
      const union = to.size + th.size - inter;
      if (union > 0 && inter / union >= 0.8) return h;
    }
  }
  return null;
}

// ── Scoring (pure) ─────────────────────────────────────────────────────────

function matchFacts(
  roomId: RoomSpec["id"],
  text: string,
  expectedText?: string,
): string[] {
  return FACT_PATTERNS[roomId]
    .filter((fact) => {
      const matches = (candidate: string) =>
        fact.re.test(candidate) &&
        (fact.required ?? []).every((required) => required.test(candidate));
      return (
        matches(text) && (expectedText === undefined || matches(expectedText))
      );
    })
    .map((f) => f.label);
}

/**
 * Score one Eliza group output against the human messages sent SO FAR. Echoed
 * human text earns no fact credit; forbidden claims always count.
 */
export function scoreElizaOutput(
  roomId: RoomSpec["id"],
  allowedCategories: ReadonlySet<string>,
  humanTextsSent: readonly string[],
  text: string,
  expectedText?: string,
): StepRecord {
  const echo = echoOfHuman(text, humanTextsSent);
  return {
    eliza: true,
    text,
    ...(echo ? { echoOf: echo } : {}),
    matchedFacts: echo ? [] : matchFacts(roomId, text, expectedText),
    forbiddenHits: forbiddenHits(allowedCategories, text),
  };
}

export interface AssertionInputs {
  room: RoomSpec;
  steps: readonly StepRecord[];
  respondedPoints: number;
  preLinkSends: number;
  unsolicitedSends: number;
  /** Forbidden-claim hits found in the link/ambient acks. */
  ackForbidden: readonly string[];
  probe: { sender: string; text: string };
  allowedCategories: ReadonlySet<string>;
  thresholds: Thresholds;
}

/**
 * Totals come from the step records, which scored each output at record
 * time, so echo classification only compares an output against human
 * messages that had already been sent, never against later ones. All
 * matchers run ONLY over Eliza group outputs; echoed human text earns no
 * fact or speaker credit.
 */
export function computeAssertions(input: AssertionInputs): Assertions {
  const { room, thresholds } = input;
  const allFacts = new Set<string>();
  const allForbidden: string[] = [...input.ackForbidden];
  const echoes: string[] = [];
  const nonEchoOutputs: string[] = [];
  const factfulExpectedPoints = new Set<number>();
  const expectedReplies: string[] = [];
  for (const s of input.steps) {
    if (!s.eliza || s.silent || s.matchedFacts === undefined) continue; // humans, acks, DM
    if (s.echoOf) {
      echoes.push(s.text);
    } else {
      nonEchoOutputs.push(s.text);
      for (const f of s.matchedFacts) allFacts.add(f);
      if (s.expected && s.position !== undefined) {
        expectedReplies.push(normText(s.text));
        if (s.matchedFacts.length > 0) factfulExpectedPoints.add(s.position);
      }
    }
    allForbidden.push(...(s.forbiddenHits ?? []));
  }

  return {
    respondedAtExpectedPoints: {
      pass: input.respondedPoints >= thresholds.minResponses,
      respondedPoints: input.respondedPoints,
      expectedPoints: room.elizaPositions.length,
      minRequired: thresholds.minResponses,
    },
    silentUntilLinked: {
      pass: input.preLinkSends === 0,
      probe: { ...input.probe, windowMs: thresholds.silenceMs },
      preLinkSends: input.preLinkSends,
    },
    restraintAtUnscriptedPoints: {
      pass: input.unsolicitedSends <= thresholds.unsolicitedMax,
      unsolicitedSends: input.unsolicitedSends,
      maxAllowed: thresholds.unsolicitedMax,
      windowMs: thresholds.silenceMs,
    },
    noEchoedHumanText: {
      pass: echoes.length === 0,
      echoes: echoes.length,
      samples: echoes.slice(0, 3),
    },
    keyFactsReferenced: {
      pass:
        allFacts.size >= thresholds.factsMin &&
        factfulExpectedPoints.size >= thresholds.factsMin,
      matched: [...allFacts],
      factfulExpectedPoints: factfulExpectedPoints.size,
      minRequired: thresholds.factsMin,
      available: FACT_PATTERNS[room.id].length,
    },
    distinctExpectedReplies: {
      pass: new Set(expectedReplies).size === expectedReplies.length,
      replies: expectedReplies.length,
      distinct: new Set(expectedReplies).size,
    },
    noDetectedUnsupportedFirstPersonClaims: {
      pass: allForbidden.length === 0,
      hits: allForbidden,
      allowedCategories: [...input.allowedCategories],
    },
    speakerAwareness: {
      pass: nonEchoOutputs.some((t) =>
        room.members.some((m) => new RegExp(`\\b${m}\\b`, "i").test(t)),
      ),
      members: room.members,
    },
  };
}

function verdictOf(assertions: Assertions): RunResult["verdict"] {
  return Object.values(assertions).every((a) => a.pass) ? "PASS" : "FAIL";
}

// ── Plan ───────────────────────────────────────────────────────────────────

export function buildPlan(
  spec: RoomsSpec,
  roomId: string,
  env: NodeJS.ProcessEnv,
): Plan {
  const room = spec.rooms.find((r) => r.id === roomId);
  if (!room) {
    fail(
      `unknown room "${roomId}"; valid: ${spec.rooms.map((r) => r.id).join(", ")}`,
    );
  }
  if (!FACT_PATTERNS[room.id]) {
    fail(`no fact patterns defined for room ${room.id}`);
  }

  const ownerHandle = env.OWNER_HANDLE ?? DEFAULT_OWNER_HANDLE;
  const elizaHandle = env.ELIZA_HANDLE ?? DEFAULT_ELIZA_HANDLE;
  const roomOrdinal = spec.rooms.findIndex((r) => r.id === room.id);
  const handleFor = new Map<string, string>();
  handleFor.set(OWNER_SENDER, ownerHandle);
  room.members.forEach((name, i) => {
    handleFor.set(name, `+1555000${1000 + roomOrdinal * 100 + i + 1}`);
  });
  const humanHandles = new Set(handleFor.values());
  if (humanHandles.size !== handleFor.size) {
    fail("handle collision between cast members");
  }
  if (humanHandles.has(elizaHandle)) {
    fail("ELIZA_HANDLE collides with a human handle");
  }

  // RUN_TAG suffixes the chat ids so a re-run against a stack whose DB
  // persisted an earlier binding gets a fresh, unlinked group (a group chat
  // id bound to one owner refuses "Eliza link" from any other owner).
  const runTag = (env.RUN_TAG ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  const suffix = runTag ? `_${runTag}` : "";

  // Ambient decision: unprompted interjection = some eliza position whose
  // preceding human message never mentions her by name.
  const humansByPos = new Map(room.humanMessages.map((m) => [m.position, m]));
  const ambient = room.elizaPositions.some((p) => {
    const prev = humansByPos.get(p - 1);
    return prev ? !/\beliza\b/i.test(prev.text) : true;
  });

  const elizaSet = new Set(room.elizaPositions);
  const allowedCategories = new Set<string>();
  for (const step of room.elizaSteps) {
    for (const cat of spec.allowedClaimsByCapability[step.capability] ?? []) {
      allowedCategories.add(cat);
    }
  }

  return {
    room,
    roomOrdinal,
    ownerHandle,
    elizaHandle,
    handleFor,
    humanHandles,
    groupChatId: `chat_sim_${room.id}${suffix}`,
    dmChatId: `chat_sim_dm_${room.id}${suffix}`,
    // A NON-owner member speaks in the unlinked group.
    probe: { sender: room.members[0], text: PRE_LINK_PROBE_TEXT },
    ambient,
    allowedCategories,
    silentWindowPositions: Array.from(
      { length: room.stepCount },
      (_, p) => p,
    ).filter((p) => humansByPos.has(p) && !elizaSet.has(p + 1)),
  };
}

export function dryRunReport(plan: Plan): Record<string, unknown> {
  return {
    dryRun: true,
    room: plan.room.id,
    roomName: plan.room.roomName,
    handles: Object.fromEntries(plan.handleFor),
    elizaHandle: plan.elizaHandle,
    groupChatId: plan.groupChatId,
    dmChatId: plan.dmChatId,
    ambient: plan.ambient,
    preLinkProbe: plan.probe,
    humanMessages: plan.room.humanMessages.length,
    expectedElizaPoints: plan.room.elizaPositions.length,
    silentWindows: plan.silentWindowPositions.length,
    allowedForbiddenCategories: [...plan.allowedCategories],
    factPatterns: FACT_PATTERNS[plan.room.id].map((f) => f.label),
    note: "spec loaded and plan built; no network calls made",
  };
}

export function readThresholds(
  env: NodeJS.ProcessEnv,
  room: RoomSpec,
): Thresholds {
  return {
    waitMs: intEnv(env, "WAIT_MS", 45_000),
    pollMs: intEnv(env, "POLL_MS", 1_500),
    paceMs: intEnv(env, "PACE_MS", 1_200),
    silenceMs: intEnv(env, "SILENCE_MS", 8_000),
    unsolicitedMax: intEnv(env, "UNSOLICITED_MAX", 2),
    // Floored at 1: these thresholds must not be zeroed into no-op assertions.
    factsMin: Math.max(1, intEnv(env, "FACTS_MIN", 2)),
    minResponses: Math.max(
      1,
      intEnv(env, "MIN_RESPONSES", Math.ceil(room.elizaPositions.length / 2)),
    ),
  };
}

// ── Webhook envelope ───────────────────────────────────────────────────────

export function v4Envelope(opts: {
  sender: string;
  text: string;
  chatId: string;
  isGroup: boolean;
  roomName: string;
  elizaHandle: string;
  seq: number;
}): string {
  const id = `sim_${Date.now()}_${opts.seq}`;
  // recipient is the RECEIVING (Eliza) number: the adapter maps it to
  // internal_id; it must match channel_address, never the sender's own phone.
  return JSON.stringify({
    id: `evt_${id}`,
    type: "message.received",
    created_at: Date.now(),
    data: {
      id: `msg_${id}`,
      message_id: `msg_${id}`,
      chat_id: opts.chatId,
      channel_id: "ch_sim",
      channel_type: "blooio",
      direction: "inbound",
      sender: opts.sender,
      recipient: opts.elizaHandle,
      channel_address: opts.elizaHandle,
      text: opts.text,
      protocol: "imessage",
      is_group: opts.isGroup,
      group: opts.isGroup ? { name: opts.roomName } : null,
      attachments: [],
    },
  });
}

// ── Signing ────────────────────────────────────────────────────────────────

export async function signatureFor(
  body: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const signing = env.SIGNING?.trim() ?? "";
  if (!signing || signing === "none") return null;

  if (signing.startsWith("cmd:")) {
    const cmd = signing.slice(4);
    const proc = Bun.spawn(["sh", "-c", cmd], {
      env: { ...env, BODY: body },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      fail(`SIGNING cmd exited ${code}: ${err.trim()}`);
    }
    return out.trim();
  }

  let secret = signing;
  if (signing.startsWith("env:")) {
    const varName = signing.slice(4);
    const v = env[varName];
    if (!v) fail(`SIGNING=env:${varName} but ${varName} is unset`);
    secret = v;
  }
  const t = Math.floor(Date.now() / 1000);
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${body}`)
    .digest("hex");
  return `t=${t},v1=${hmac}`;
}

// ── HTTP transport (the real RunIo) ────────────────────────────────────────

function createHttpIo(env: NodeJS.ProcessEnv): RunIo {
  const baseUrl = env.BASE_URL;
  const captureSrc = env.OUTBOUND_CAPTURE;
  if (!baseUrl) fail("BASE_URL is required (webhook endpoint)");
  if (!captureSrc) {
    fail("OUTBOUND_CAPTURE is required (mock provider outbound sends)");
  }

  return {
    async postWebhook(body) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      const sig = await signatureFor(body, env);
      if (sig) headers["x-blooio-signature"] = sig;

      let res: Response;
      try {
        res = await fetch(baseUrl, { method: "POST", headers, body });
      } catch (err) {
        // error-policy:J2 context-adding rethrow: name the endpoint, keep the cause
        fail(
          `could not reach BASE_URL (${baseUrl}): ${err instanceof Error ? err.message : String(err)}. ` +
            "If this was a dry-run against a stub endpoint, that is the expected clean exit.",
          err,
        );
      }
      if (!res.ok) {
        let text: string;
        try {
          text = await res.text();
        } catch (error) {
          // error-policy:J1 boundary translation: preserve an unreadable error
          // body as the cause while still reporting the authoritative status.
          fail(`webhook POST rejected: ${res.status} (unreadable body)`, error);
        }
        fail(
          `webhook POST rejected: ${res.status} ${redactCredentials(text).slice(0, 300)}`,
        );
      }
    },

    async readCapture() {
      if (/^https?:\/\//i.test(captureSrc)) {
        let res: Response;
        try {
          res = await fetch(captureSrc);
        } catch (err) {
          // error-policy:J2 context-adding rethrow: name the capture source, keep the cause
          fail(
            `could not reach OUTBOUND_CAPTURE (${captureSrc}): ${err instanceof Error ? err.message : String(err)}`,
            err,
          );
        }
        if (!res.ok) fail(`OUTBOUND_CAPTURE GET returned ${res.status}`);
        // error-policy:J3 untrusted-input sanitizing: a non-JSON capture body
        // becomes an explicit typed failure, never an empty capture.
        return await res
          .json()
          .catch((err) => fail("OUTBOUND_CAPTURE returned invalid JSON", err));
      }
      if (!existsSync(captureSrc)) return []; // mock provider may not have written yet
      const text = readFileSync(captureSrc, "utf8").trim();
      if (!text) return [];
      try {
        return JSON.parse(text);
      } catch {
        // error-policy:J3 untrusted-input sanitizing: not one JSON document,
        // so parse as JSONL; a line that is neither throws from here.
        return text
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l));
      }
    },

    log(line) {
      console.error(`[run-room-sim] ${line}`);
    },
  };
}

// ── Outbound capture normalization (pure) ──────────────────────────────────

/**
 * Normalize one raw capture entry. Returns null for anything that is not a
 * scoreable Eliza output; `untagged` marks entries dropped for carrying no
 * chat attribution (a diagnostic the /group phase reports).
 */
function normalizeCaptureEntry(
  raw: unknown,
  humanHandles: ReadonlySet<string>,
): { entry: CaptureEntry | null; untagged: boolean } {
  if (raw == null) return { entry: null, untagged: false };
  if (typeof raw === "string") {
    return { entry: null, untagged: true }; // bare strings carry no chat attribution
  }
  if (typeof raw !== "object") return { entry: null, untagged: false };
  const r = raw as Record<string, unknown>;
  if (r.direction === "inbound") return { entry: null, untagged: false }; // only Eliza OUTPUTS are scored
  const from = [r.sender, r.from].find((v) => typeof v === "string") as
    | string
    | undefined;
  if (from && humanHandles.has(from)) return { entry: null, untagged: false }; // a human, not Eliza
  const text = [r.text, r.body, r.message].find((v) => typeof v === "string") as
    | string
    | undefined;
  if (!text) return { entry: null, untagged: false };
  const chat = [r.chat_id, r.chatId, r.chat, r.to].find(
    (v) => typeof v === "string",
  ) as string | undefined;
  if (!chat) {
    return { entry: null, untagged: true }; // without chat attribution DM/group scoring is unsound
  }
  return { entry: { text: redactCredentials(text), chat }, untagged: false };
}

export function normalizeCapturePayload(
  payload: unknown,
  humanHandles: ReadonlySet<string>,
): { entries: CaptureEntry[]; untaggedDropped: number } {
  const list = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { messages?: unknown[] }).messages)
      ? (payload as { messages: unknown[] }).messages
      : fail(
          "OUTBOUND_CAPTURE payload is neither an array nor {messages:[...]}",
        );
  const entries: CaptureEntry[] = [];
  let untaggedDropped = 0;
  for (const raw of list) {
    const { entry, untagged } = normalizeCaptureEntry(raw, humanHandles);
    if (untagged) untaggedDropped += 1;
    if (entry) entries.push(entry);
  }
  return { entries, untaggedDropped };
}

function entriesForChat(
  entries: readonly CaptureEntry[],
  chatId: string,
): CaptureEntry[] {
  return entries.filter((e) => e.chat === chatId);
}

// ── Link code parsing ──────────────────────────────────────────────────────

/**
 * The product's /group DM reply embeds the literal command
 * "Eliza link <CODE>" where CODE is exactly 8 chars of the group-claim
 * alphabet 23456789ABCDEFGHJKLMNPQRSTUVWXYZ, and the group-side matcher is
 * anchored on that exact shape, so parse that first; looser fallbacks only
 * run when the primary shape is absent.
 */
export function parseLinkCode(
  texts: readonly string[],
  override?: string,
): string | null {
  const joined = texts.join("\n");
  if (override) {
    const m = joined.match(new RegExp(override, "i"));
    if (m) return (m[1] ?? m[0]).trim().toUpperCase();
    return null;
  }
  const product = joined.match(
    /(?:eliza\s+link|\/eliza_link(?:@[a-z0-9_]{5,32})?)\s+([2-9A-HJ-NP-Z]{8})\b/i,
  );
  if (product?.[1]) return product[1].toUpperCase();
  const near = joined.match(/(?:code|link)\W{0,12}([2-9A-HJ-NP-Z]{8})\b/i);
  if (near?.[1]) return near[1].toUpperCase();
  const caps = joined.match(/\b([2-9A-HJ-NP-Z]{8})\b/);
  return caps?.[1]?.toUpperCase() ?? null;
}

// ── The run ────────────────────────────────────────────────────────────────

export interface RunOptions {
  linkCodeRegex?: string;
}

export async function runRoom(
  plan: Plan,
  thresholds: Thresholds,
  io: RunIo,
  options: RunOptions = {},
): Promise<RunResult> {
  const { room, groupChatId, dmChatId, probe, ambient, allowedCategories } =
    plan;
  const { waitMs, pollMs, paceMs, silenceMs } = thresholds;

  /** Diagnostics: entries dropped on the latest read for missing chat
   * attribution. */
  let untaggedDropped = 0;
  const readEntries = async (): Promise<CaptureEntry[]> => {
    const normalized = normalizeCapturePayload(
      await io.readCapture(),
      plan.humanHandles,
    );
    untaggedDropped = normalized.untaggedDropped;
    return normalized.entries;
  };
  const chatEntries = async (chatId: string) =>
    entriesForChat(await readEntries(), chatId);

  /** Poll for new entries in a chat beyond `seen`, up to waitMs; returns as
   * soon as something arrives (plus one settle interval for multi-part
   * sends). */
  const pollNew = async (chatId: string, seen: number): Promise<string[]> => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const all = await chatEntries(chatId);
      if (all.length > seen) {
        // settle: one extra poll interval so multi-part sends are captured
        await sleep(pollMs);
        const settled = await chatEntries(chatId);
        return settled.slice(seen).map((e) => e.text);
      }
      if (Date.now() >= deadline) return [];
      await sleep(pollMs);
    }
  };

  /** Hold a bounded no-send window: wait the FULL windowMs, then report every
   * new entry that arrived (plus one settle read). Used for silence checks;
   * unlike pollNew it never returns early, so a late reply inside the window
   * is still caught. */
  const collectDuring = async (
    chatId: string,
    seen: number,
    windowMs: number,
  ): Promise<string[]> => {
    await sleep(windowMs);
    const first = await chatEntries(chatId);
    if (first.length <= seen) return [];
    await sleep(pollMs);
    const settled = await chatEntries(chatId);
    return settled.slice(seen).map((e) => e.text);
  };

  const steps: StepRecord[] = [];
  const humanTextsSent: string[] = [];
  const expectedTextAt = new Map(
    room.elizaSteps.map((step) => [step.position, step.text]),
  );
  const scoreEliza = (text: string, position?: number): StepRecord =>
    scoreElizaOutput(
      room.id,
      allowedCategories,
      humanTextsSent,
      text,
      position === undefined ? undefined : expectedTextAt.get(position),
    );

  let seq = 0;
  const send = async (
    senderName: string,
    text: string,
    chatId: string,
    isGroup: boolean,
  ) => {
    const sender = plan.handleFor.get(senderName);
    if (!sender) fail(`no handle for sender ${senderName}`);
    if (isGroup) humanTextsSent.push(text);
    seq += 1;
    await io.postWebhook(
      v4Envelope({
        sender,
        text,
        chatId,
        isGroup,
        roomName: room.roomName,
        elizaHandle: plan.elizaHandle,
        seq,
      }),
    );
  };

  io.log(`room=${room.id} ambient=${ambient} owner=${plan.ownerHandle}`);

  // Stale-capture baseline: group entries that exist before this run sends
  // anything are prior-run residue, never counted for or against this run.
  let groupSeen = (await chatEntries(groupChatId)).length;
  if (groupSeen > 0) {
    io.log(
      `warning: ${groupSeen} pre-existing group capture entries treated as stale baseline`,
    );
  }

  // Phase 1: owner DM "/group" -> parse link code from DM reply.
  const dmSeen = (await chatEntries(dmChatId)).length;
  await send(OWNER_SENDER, "/group", dmChatId, false);
  steps.push({ human: OWNER_SENDER, text: "/group (DM)" });
  const dmReplies = await pollNew(dmChatId, dmSeen);
  if (dmReplies.length === 0) {
    fail(
      "no DM reply to /group within the wait window" +
        (untaggedDropped > 0
          ? ` (${untaggedDropped} capture entries were dropped for missing chat attribution; the mock capture must tag each send with its chat id)`
          : ""),
    );
  }
  for (const t of dmReplies) steps.push({ eliza: true, text: `(DM) ${t}` });
  const code = parseLinkCode(dmReplies, options.linkCodeRegex);
  if (!code) {
    fail(
      `could not parse a link code from the /group DM reply: ${JSON.stringify(dmReplies)}`,
    );
  }
  io.log(`link code parsed: ${code}`);

  // Phase 2: PRE-LINK SILENCE PROBE: a member speaks in the unlinked group,
  // then a bounded no-send window. Any group send before the link command is
  // posted is a violation.
  await send(probe.sender, probe.text, groupChatId, true);
  steps.push({ human: probe.sender, text: `${probe.text} (pre-link probe)` });
  const preLinkSends = await collectDuring(groupChatId, groupSeen, silenceMs);
  groupSeen += preLinkSends.length;
  for (const t of preLinkSends) {
    steps.push({
      ...scoreEliza(t),
      unsolicited: true,
      text: `(PRE-LINK) ${t}`,
    });
  }

  // Phase 3: owner links the group (and enables ambient where warranted).
  await send(OWNER_SENDER, `Eliza link ${code}`, groupChatId, true);
  steps.push({ human: OWNER_SENDER, text: `Eliza link ${code}` });
  const ackForbidden: string[] = [];
  const linkAck = await pollNew(groupChatId, groupSeen);
  for (const t of linkAck) {
    ackForbidden.push(...forbiddenHits(allowedCategories, t));
    steps.push({ eliza: true, text: `(link ack) ${t}` });
  }
  groupSeen += linkAck.length;

  if (ambient) {
    await send(OWNER_SENDER, "Eliza ambient on", groupChatId, true);
    steps.push({ human: OWNER_SENDER, text: "Eliza ambient on" });
    const ambAck = await pollNew(groupChatId, groupSeen);
    for (const t of ambAck) {
      ackForbidden.push(...forbiddenHits(allowedCategories, t));
      steps.push({ eliza: true, text: `(ambient ack) ${t}` });
    }
    groupSeen += ambAck.length;
  }

  // Phase 4: replay the script in position order. Poll (bounded) at each
  // scripted Eliza point; hold a bounded silence window after every other
  // human message; sends arriving there are unsolicited.
  const humansByPos = new Map(room.humanMessages.map((m) => [m.position, m]));
  const elizaSet = new Set(room.elizaPositions);
  let respondedPoints = 0;
  const unsolicitedSends: string[] = [];

  for (let pos = 0; pos < room.stepCount; pos++) {
    const human = humansByPos.get(pos);
    if (human) {
      await send(human.sender, human.text, groupChatId, true);
      steps.push({ human: human.sender, position: pos, text: human.text });
      if (elizaSet.has(pos + 1)) {
        await sleep(paceMs);
      } else {
        // Scripted silence: the homepage script has no Eliza step next, so a
        // send arriving in this bounded window is unsolicited.
        const stray = await collectDuring(groupChatId, groupSeen, silenceMs);
        groupSeen += stray.length;
        for (const t of stray) {
          unsolicitedSends.push(t);
          steps.push({ ...scoreEliza(t), position: pos, unsolicited: true });
        }
      }
      continue;
    }
    if (elizaSet.has(pos)) {
      const replies = await pollNew(groupChatId, groupSeen);
      groupSeen += replies.length;
      if (replies.length > 0) {
        respondedPoints += 1;
        for (const t of replies) {
          steps.push({ ...scoreEliza(t, pos), position: pos, expected: true });
        }
      } else {
        steps.push({
          eliza: true,
          position: pos,
          expected: true,
          silent: true,
          text: "",
        });
      }
    }
  }

  // Final sweep: trailing sends after the last point are unsolicited too.
  const trailing = await collectDuring(
    groupChatId,
    groupSeen,
    Math.min(waitMs, 10_000),
  );
  for (const t of trailing) {
    unsolicitedSends.push(t);
    steps.push({ ...scoreEliza(t), expected: false, unsolicited: true });
  }

  const assertions = computeAssertions({
    room,
    steps,
    respondedPoints,
    preLinkSends: preLinkSends.length,
    unsolicitedSends: unsolicitedSends.length,
    ackForbidden,
    probe,
    allowedCategories,
    thresholds,
  });

  return {
    room: room.id,
    roomName: room.roomName,
    ambient,
    steps,
    assertions,
    verdict: verdictOf(assertions),
  };
}

// ── Reporting ──────────────────────────────────────────────────────────────

export function renderMarkdown(result: RunResult): string {
  const a = result.assertions;
  const md: string[] = [
    `# Room sim transcript: ${result.roomName} (${result.room})`,
    "",
    `- Verdict: **${result.verdict}**`,
    `- Ambient mode: ${result.ambient ? "on" : "off (mention-only)"}`,
    `- Expected Eliza points responded: ${a.respondedAtExpectedPoints.respondedPoints}/${a.respondedAtExpectedPoints.expectedPoints}`,
    `- Pre-link probe sends: ${a.silentUntilLinked.preLinkSends} (must be 0)`,
    `- Unsolicited sends (silent windows + trailing): ${a.restraintAtUnscriptedPoints.unsolicitedSends} (max ${a.restraintAtUnscriptedPoints.maxAllowed})`,
    `- Echoed-human outputs: ${a.noEchoedHumanText.echoes} (must be 0)`,
    `- Correctly related key facts at expected beats: ${a.keyFactsReferenced.matched.length} across ${a.keyFactsReferenced.factfulExpectedPoints} beats (min ${a.keyFactsReferenced.minRequired} each): ${a.keyFactsReferenced.matched.join("; ") || "none"}`,
    `- Repeated expected replies: ${a.distinctExpectedReplies.replies - a.distinctExpectedReplies.distinct}`,
    `- Detected unsupported first-person claim hits (incl. acks): ${a.noDetectedUnsupportedFirstPersonClaims.hits.length ? a.noDetectedUnsupportedFirstPersonClaims.hits.join(", ") : "none"}`,
    "",
    "## Transcript",
    "",
  ];
  for (const s of result.steps) {
    if (s.human) {
      md.push(`**${s.human}:** ${s.text}`);
    } else if (s.silent) {
      md.push(
        `**Eliza:** _(silent: expected speaking point at position ${s.position})_`,
      );
    } else {
      const notes: string[] = [];
      if (s.unsolicited) notes.push("UNSOLICITED");
      if (s.echoOf) notes.push(`ECHO of: ${JSON.stringify(s.echoOf)}`);
      if (s.matchedFacts?.length) {
        notes.push(`facts: ${s.matchedFacts.join(", ")}`);
      }
      if (s.forbiddenHits?.length) {
        notes.push(`FORBIDDEN: ${s.forbiddenHits.join(", ")}`);
      }
      md.push(
        `**Eliza:** ${s.text}${notes.length ? `  \n  _[${notes.join(" | ")}]_` : ""}`,
      );
    }
    md.push("");
  }
  md.push(
    "## Assertions",
    "",
    "```json",
    JSON.stringify(result.assertions, null, 2),
    "```",
    "",
  );
  return md.join("\n");
}

function writeResults(
  resultsDir: string,
  result: RunResult,
): { jsonPath: string; mdPath: string } {
  mkdirSync(resultsDir, { recursive: true });
  const jsonPath = join(resultsDir, `${result.room}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  const mdPath = join(resultsDir, `${result.room}.md`);
  writeFileSync(mdPath, renderMarkdown(result));
  return { jsonPath, mdPath };
}

/** The derived spec plus the hand-written facts, for review and diffing. */
function printableSpec(spec: RoomsSpec): Record<string, unknown> {
  return {
    source: "packages/homepage/src/lib/landing-demo.ts (read at runtime)",
    rotationOrder: spec.rotationOrder,
    capabilities: spec.capabilities,
    forbiddenClaimCategories: spec.forbiddenClaimCategories,
    allowedClaimsByCapability: spec.allowedClaimsByCapability,
    rooms: spec.rooms.map((room) => ({
      ...room,
      keyFacts: ROOM_KEY_FACTS[room.id],
      factPatterns: FACT_PATTERNS[room.id].map((f) => ({
        label: f.label,
        pattern: f.re.source,
        required: (f.required ?? []).map((required) => required.source),
      })),
    })),
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────

const USAGE =
  "usage: bun run cloud:group-room-sim -- --room <household|co-parenting|friends|trip|community> [--dry-run] | --print-spec";

async function main(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const spec = buildRoomsSpec();
  if (args.includes("--print-spec")) {
    console.log(JSON.stringify(printableSpec(spec), null, 2));
    return 0;
  }
  const roomIdx = args.indexOf("--room");
  const roomId = roomIdx >= 0 ? args[roomIdx + 1] : undefined;
  if (!roomId) fail(USAGE);

  const plan = buildPlan(spec, roomId, env);
  if (args.includes("--dry-run")) {
    console.log(JSON.stringify(dryRunReport(plan), null, 2));
    return 0;
  }

  const io = createHttpIo(env);
  const thresholds = readThresholds(env, plan.room);
  const result = await runRoom(plan, thresholds, io, {
    linkCodeRegex: env.LINK_CODE_REGEX,
  });
  const { jsonPath, mdPath } = writeResults(RESULTS_DIR, result);
  io.log(`wrote ${jsonPath} and ${mdPath}`);
  console.log(
    JSON.stringify(
      {
        room: result.room,
        verdict: result.verdict,
        assertions: result.assertions,
      },
      null,
      2,
    ),
  );
  return result.verdict === "PASS" ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (err: unknown) => {
      // error-policy:J1 boundary translation: any harness failure is reported
      // on stderr and exits 2, distinct from a FAIL verdict (exit 1). Typed
      // failures print their message; anything else keeps its stack.
      const detail =
        err instanceof RoomSimError
          ? err.message
          : err instanceof Error
            ? (err.stack ?? err.message)
            : String(err);
      console.error(`[run-room-sim] ${detail}`);
      process.exit(2);
    },
  );
}
