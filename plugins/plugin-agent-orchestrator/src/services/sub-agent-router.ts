import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { Service, ServiceType } from "@elizaos/core";
import type { AcpService } from "./acp-service.js";
import {
  accountMetaFromSessionMetadata,
  type CodingAccountFailureKind,
  classifyAccountFailure,
  getCodingAccountBridge,
  reportCodingAccountFailure,
} from "./coding-account-selection.js";
import {
  dispatchParentAgentDirective,
  extractParentAgentDirective,
  parentAgentMarkerIndex,
} from "./parent-agent-dispatch.js";
import {
  createRouterLoopState,
  type RouterLoopState,
  routerLoopTransition,
} from "./router-loop-guard.js";
import {
  collectScreenshotPaths,
  deliverScreenshots,
} from "./screenshot-delivery.js";
import { SsrfBlockedError, safeFetch } from "./ssrf-guard.js";
import type { SessionEventName, SessionInfo } from "./types.js";
import {
  captureChangeSet,
  summarizeChangeSet,
  verifyChangedFilesOnDisk,
  type WorkspaceArtifactVerification,
  type WorkspaceChangeSet,
} from "./workspace-diff.js";

// IAgentRuntime extension: some runtimes expose sendMessageToTarget for
// connector-aware reply routing. This is not part of the core interface.
type RuntimeWithSendTarget = IAgentRuntime & {
  sendMessageToTarget?: (
    target: { source: string; roomId?: UUID; accountId?: string },
    content: Content,
  ) => Promise<Memory | undefined>;
};

const ACPX_ROUTER_SOURCE = "sub_agent";
const SUB_AGENT_ENTITY_NAMESPACE = "acpx:sub-agent";
const QUESTION_FOR_TASK_CREATOR = "QUESTION_FOR_TASK_CREATOR";
const AGENT_COORDINATION = "AGENT_COORDINATION";
const SWARM_ROLE_ORDER = ["task", "worktree", "origin"] as const;

// Matches an http(s) URL embedded in free text. Excludes whitespace,
// quotes, brackets, parens, backticks AND `*` — so a markdown-bolded link
// (`**https://...**`) doesn't capture the trailing `**` into the URL.
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`)\]*]+/g;

// Unicode dash code points weak models substitute for an ASCII hyphen:
// hyphen U+2010, non-breaking hyphen U+2011, figure dash U+2012, en dash
// U+2013, em dash U+2014, horizontal bar U+2015, minus sign U+2212.
const UNICODE_DASHES_RE = /[\u2010-\u2015\u2212]/g;
// A URL (mentioned by a sub-agent, or a page sub-resource) that did not
// verify as reachable. Shared by the verification pass and the retry path.
interface DeadUrl {
  url: string;
  status: string;
  /** Set when this URL was discovered as a sub-resource of another page. */
  via?: string;
}

export interface RouteUrlMapping {
  urlPrefix: string;
  localPath: string;
  requireFresh?: boolean;
}

export interface RouteUrlVerification {
  workdir: string;
  sessionStartedAtMs: number;
  mappings: RouteUrlMapping[];
}

function collectVerifiableUrlCandidates(
  text: string,
  ignoredUrls?: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const match of text.matchAll(URL_IN_TEXT_RE)) {
    const raw = match[0];
    const index = match.index;
    const suffix =
      index >= 0 ? text.slice(index + raw.length, index + raw.length + 4) : "";
    // Route instructions and docs often contain URL templates such as
    // `https://host/apps/<slug>/`. The regexp stops before `<slug>`, so the
    // raw match looks like a real collection URL (`/apps/`). Do not verify
    // the template stem as if the sub-agent claimed that directory is live.
    if (suffix.startsWith("<") || suffix.startsWith("&lt;")) continue;

    const url = raw.replace(/[.,;:]+$/, "");
    // Raw `curl -i` output includes CDN reporting endpoints in `report-to`
    // headers. They are not part of the built app, and letting them into the
    // bounded verifier list crowds out real page/assets.
    if (isTelemetryReportUrl(url)) continue;
    if (ignoredUrls?.has(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    candidates.push(url);
  }
  return candidates;
}

function extractVerifiableUrls(
  text: string,
  limit = 5,
  referenceText?: string,
  ignoredUrls?: ReadonlySet<string>,
): string[] {
  const candidates = [
    ...collectVerifiableUrlCandidates(text, ignoredUrls),
    ...(referenceText
      ? collectVerifiableUrlCandidates(referenceText, ignoredUrls)
      : []),
  ].filter((url, index, all) => all.indexOf(url) === index);
  const filtered = candidates.filter((url) => {
    const prefix = url.endsWith("/") ? url : `${url}/`;
    return !candidates.some(
      (other) => other !== url && other.startsWith(prefix),
    );
  });
  const referenceUrls = referenceText
    ? new Set(collectVerifiableUrlCandidates(referenceText, ignoredUrls))
    : undefined;
  const routeFocused = referenceUrls?.size
    ? filterToReferencedAppRoute(filtered, referenceUrls)
    : filtered;
  const aliasFiltered = referenceUrls?.size
    ? filterModelIntroducedUrlAliases(routeFocused, referenceUrls)
    : routeFocused;
  return aliasFiltered.slice(0, limit);
}

// The augmented initial task (taskWithResolvedRoute) appends the user's verbatim
// request after this marker, prefixed by all the injected route/swarm hints.
// We slice the user portion out so intent/URL detection never keys on the
// injected route hint text (which literally contains the word "URL" and a
// route-prefix URL).
const USER_TASK_MARKER = "--- User Task ---";

function userTaskSlice(referenceText: string | undefined): string {
  if (!referenceText) return "";
  const idx = referenceText.lastIndexOf(USER_TASK_MARKER);
  return idx >= 0
    ? referenceText.slice(idx + USER_TASK_MARKER.length)
    : referenceText;
}

function shouldVerifyCompletionUrls(
  text: string,
  referenceText?: string,
  routeVerification?: RouteUrlVerification,
): boolean {
  const completionUrls = collectVerifiableUrlCandidates(text);
  // Use ONLY the user's verbatim task for intent/URL detection — never the
  // injected route/swarm hints that the augmented initial task is wrapped in.
  const userTask = userTaskSlice(referenceText);
  const userTaskUrls = userTask ? collectVerifiableUrlCandidates(userTask) : [];
  if (completionUrls.length === 0 && userTaskUrls.length === 0) {
    return false;
  }

  // An INPUT/consume request ("summarize / read / fetch / open / scrape this
  // URL ...") names a SOURCE URL to read. On its own that does NOT make a URL a
  // deliverable. It only suppresses the artifact-SHAPED-URL heuristic (branch 2),
  // NOT an EXPLICIT deploy/share request (branch 1): a task can both read a
  // source AND deploy an output (e.g. "read https://x, deploy a summary page,
  // and give me the live URL") — that must still verify the claimed deployment.
  const consumesUrl = userTask ? taskConsumesUrl(userTask) : false;

  // 1) The USER explicitly requested a reachable/hosted/deployed/SHARED artifact
  //    (deploy/host/live/serve/verify, OR "give/provide/share me the url/link")
  //    -> verify whatever URL the completion claims. Holds in routed AND
  //    un-routed sessions (e.g. "deploy to Vercel and give me the live URL", or
  //    "create a landing page and give me the url"). This explicit intent is
  //    authoritative and is NOT suppressed by also consuming a source URL.
  if (
    userTask &&
    (taskRequestsReachableArtifact(userTask) ||
      taskRequestsProvidedUrl(userTask))
  ) {
    return true;
  }

  // 2) The USER named a concrete DELIVERABLE-shaped URL (a routed hosted-app
  //    URL like `.../apps/<slug>/`, or one that targets the session's route
  //    mapping) -> the user pointed at a specific reachable artifact target, so
  //    verifying it is correct. We key on the deliverable SHAPE, not on the
  //    completion echoing it (the completion narration is often composed/
  //    stripped before it reaches here, so an echo requirement would miss real
  //    builds). Crucially this EXCLUDES arbitrary INPUT/source URLs such as
  //    "summarize https://example.com/docs" or "fetch this API and report":
  //    those are plain third-party URLs, not artifact-shaped, so they never
  //    trigger a verify/retry.
  //    EXCLUDES a consume request that names an `/apps/`-shaped SOURCE URL
  //    ("summarize https://example.com/apps/foo/"): when the task consumes a
  //    URL, an artifact-shaped path is still just a source, so it must not
  //    verify.
  const userNamedDeliverableUrl =
    !consumesUrl &&
    userTaskUrls.some(
      (ru) =>
        isRoutedArtifactUrl(ru, routeVerification) ||
        routeVerification?.mappings.some((m) => ru.startsWith(m.urlPrefix)),
    );
  if (userNamedDeliverableUrl) {
    return true;
  }

  // 3) The task set up an explicit deployment ROUTE and a completion URL targets
  //    that mapping -> a real hosted deliverable, verify it. An incidental URL
  //    in narration that does not match the mapping (e.g. an `/apps/<slug>/` URL
  //    grepped from skill code) is ignored.
  if (routeVerification) {
    return completionUrls.some((url) =>
      routeVerification.mappings.some((mapping) =>
        url.startsWith(mapping.urlPrefix),
      ),
    );
  }

  // Otherwise: no reachable-artifact intent, no claimed user URL, no route — a
  // routed-shape or input URL appearing only in narration is not a deliverable.
  return false;
}

// True only when the TASK explicitly asked for a REACHABLE / hosted / deployed
// artifact (or for a URL/link to one). Deliberately does NOT match generic
// authoring verbs like `build`, `create`, `site`, `page`, or `static`: a task
// such as "build a static site in its own folder" is a LOCAL build with no
// reachable artifact requested, so an incidental dead `/apps/...` URL in the
// sub-agent's exploratory narration must not trigger URL verification + a
// glitch/retry. We key on deployment/serving/reachability words and on an
// explicit request for a URL/link/address.
function taskRequestsReachableArtifact(text: string): boolean {
  // Unambiguous deployment/serving/reachability words, or an explicit request
  // to VERIFY a target. Deliberately EXCLUDES:
  //  - generic authoring verbs (build/create/site/page/static) so a pure local
  //    build never over-verifies on incidental narration URLs; and
  //  - the ambiguous nouns `url`/`link`/`address`/`endpoint`, because
  //    "summarize this URL: https://..." / "read the link ..." are INPUT-URL
  //    requests, not deliverable requests. A user who names a deliverable URL
  //    target is handled by the artifact-SHAPED user-URL branch (2) instead.
  //    Deliverable intent here means hosting/serving/reachability, e.g.
  //    "deploy X and give me the live url" still matches via `deploy`/`live`.
  return /\b(?:deploy|deployed|deploying|deployment|host|hosted|hosting|publish|published|publishing|serve|served|serving|preview|reachable|live|online|accessible|verify|verified|verifying|verification)\b/i.test(
    text,
  );
}

// True when the user is asking the agent to PROVIDE/SHARE a URL or link back to
// them (an output deliverable), e.g. "give me the url", "send me the link",
// "what's the url", "share the link". This is the deliverable reading of the
// otherwise-ambiguous `url`/`link` nouns — distinct from CONSUMING a URL
// (see taskConsumesUrl), which `taskRequestsReachableArtifact` deliberately
// drops. Requires a provide-verb adjacent to the url/link noun so a bare
// mention of "url" in an input request does not match.
function taskRequestsProvidedUrl(text: string): boolean {
  // Only UNAMBIGUOUS provide/output verbs. Deliberately EXCLUDES `get`/`need`/
  // `want`, which routinely introduce an INPUT URL ("get the URL <x> and
  // summarize it") rather than requesting one back.
  return /\b(?:give|send|share|provide|return|show|tell|what(?:'?s| is)|where(?:'?s| is))\b[^.?!\n]{0,40}\b(?:url|link|address)\b/i.test(
    text,
  );
}

// True when the user is asking the agent to CONSUME/read a URL as input (a
// SOURCE), e.g. "summarize this url", "read the link", "fetch this endpoint",
// "open https://...", "scrape the page at ...". When the task is consuming a
// URL, no URL-based deliverable signal applies — a dead/private source URL must
// not trigger a verify/retry.
function taskConsumesUrl(text: string): boolean {
  return /\b(?:summari[sz]e|summary|read|fetch|scrape|crawl|open|visit|browse|download|parse|extract|analy[sz]e|review|check|look\s+at|go\s+to|load)\b[^.?!\n]{0,40}\b(?:url|link|endpoint|page|site|address|https?:\/\/)/i.test(
    text,
  );
}

function isRoutedArtifactUrl(
  url: string,
  routeVerification?: RouteUrlVerification,
): boolean {
  if (appRoutePathPrefix(url)) return true;
  if (!routeVerification) return false;
  return routeVerification.mappings.some((mapping) =>
    url.startsWith(mapping.urlPrefix),
  );
}

function filterModelIntroducedUrlAliases(
  urls: string[],
  referenceUrls: Set<string>,
): string[] {
  const groups = new Map<string, string[]>();
  for (const url of urls) {
    const key = comparableUrlTarget(url);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(url);
    groups.set(key, group);
  }

  const targetsWithReferencedUrl = new Set<string>();
  for (const [target, group] of groups) {
    if (group.length > 1 && group.some((url) => referenceUrls.has(url))) {
      targetsWithReferencedUrl.add(target);
    }
  }
  if (targetsWithReferencedUrl.size === 0) return urls;

  return urls.filter((url) => {
    const target = comparableUrlTarget(url);
    if (!target || !targetsWithReferencedUrl.has(target)) return true;
    if (referenceUrls.has(url)) return true;
    // Keep loopback aliases: local and public checks often share the same
    // route path, and both are useful evidence. Drop only model-introduced
    // external aliases such as a misspelled public hostname.
    return isLoopbackUrl(url);
  });
}

function comparableUrlTarget(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
}

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "::1" || host.startsWith("127.");
  } catch {
    return false;
  }
}

// Drop any http(s):// loopback URLs from `text` before the reply reaches a
// user-facing channel. Sub-agents that curl-probe `http://127.0.0.1:<port>`
// while diagnosing a build will paste those probes into their task report;
// surfacing them to Discord leaks internal addresses, makes the bot look
// broken (the user can't reach a 127.0.0.1 from their machine), and on
// retry pulls a second sub-agent in to "fix" a non-public URL it should
// never have been told about. Match the same host set as `isLoopbackUrl`
// (localhost / 127.x.x.x / ::1) and strip trailing whitespace cleanly so
// the surrounding sentence stays readable; if a line becomes only a
// dangling colon / dash after stripping, drop the line.
const LOOPBACK_URL_PATTERN =
  /https?:\/\/(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[?::1\]?)(?::\d{1,5})?(?:\/[^\s)<>"`]*)?/gi;
export function redactLoopbackUrls(text: string): string {
  if (!text) return text;
  LOOPBACK_URL_PATTERN.lastIndex = 0;
  if (!LOOPBACK_URL_PATTERN.test(text)) return text;
  LOOPBACK_URL_PATTERN.lastIndex = 0;
  const stripped = text
    .replace(LOOPBACK_URL_PATTERN, "")
    .replace(/[ \t]+\n/g, "\n");
  // Drop lines that became orphan punctuation after the URL was removed
  // (e.g. "- " or "* " markdown list bullets pointing at nothing).
  return stripped
    .split("\n")
    .filter((line) => !/^[-*\s]*[:>→\->]?[\s]*$/.test(line) || line === "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isTelemetryReportUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      (host === "a.nel.cloudflare.com" ||
        host.endsWith(".nel.cloudflare.com")) &&
      parsed.pathname.startsWith("/report/")
    );
  } catch {
    return false;
  }
}

function filterToReferencedAppRoute(
  urls: string[],
  referenceUrls: Set<string>,
): string[] {
  const routePrefixes = new Set<string>();
  for (const url of referenceUrls) {
    const prefix = appRoutePathPrefix(url);
    if (prefix) routePrefixes.add(prefix);
  }
  if (routePrefixes.size === 0) return urls;

  const routeUrls = urls.filter((url) => {
    try {
      const pathname = new URL(url).pathname;
      return [...routePrefixes].some((prefix) => pathname.startsWith(prefix));
    } catch {
      return false;
    }
  });
  return routeUrls.length > 0 ? routeUrls : urls;
}

function appRoutePathPrefix(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/^\/apps\/[^/]+(?:\/|$)/);
    if (!match) return undefined;
    return match[0].endsWith("/") ? match[0] : `${match[0]}/`;
  } catch {
    return undefined;
  }
}

/**
 * SubAgentRouter takes terminal-significant ACPX session events
 * (`task_complete`, `error`, `blocked`) and posts them as synthetic inbound
 * messages into the runtime so the main agent's normal action layer can
 * decide whether to:
 *   - REPLY to the user,
 *   - SEND_TO_AGENT to push the sub-agent further,
 *   - or both.
 *
 * Routing keys are read from `session.metadata` populated by TASKS op=create
 * at spawn time: `roomId`, `worldId`, `userId`, `messageId`, `source`, `label`.
 *
 * Streaming chunks (`agent_message_chunk`, `tool_running`) are intentionally
 * NOT injected — they would refire the planner constantly and burn cache.
 * The provider is the channel for live status; this router is the channel for
 * boundary events that warrant a decision.
 */
export class SubAgentRouter extends Service {
  static serviceType = "ACPX_SUB_AGENT_ROUTER";
  static dependencies = ["ACP_SUBPROCESS_SERVICE"];

  capabilityDescription =
    "Routes ACPX sub-agent terminal events back into the runtime as inbound messages so the main agent decides reply-to-user vs reply-to-agent vs both.";

  protected override runtime: IAgentRuntime;
  private acp: AcpService | null = null;
  private unsubscribe: (() => void) | undefined;
  private readonly delivered = new Set<string>();
  // Per-session accumulation of streamed child text, scanned for
  // `USE_SKILL parent-agent <json>` directives. Kept tiny (only a tail, or
  // from the marker onward) so it never grows with normal task output.
  private readonly parentAgentBuffers = new Map<string, string>();
  private readonly parentAgentDispatchCounts = new Map<string, number>();
  private readonly verifyRetryHandedOffSessions = new Set<string>();
  // The two runaway-loop backstops (per-session round-trip cap + per-lineage
  // state_lost respawn cap) and the cross-session completion-dedupe compare-
  // and-set are consolidated into one pure, fuzz-tested reducer. Every counter
  // lives in `loopState`; `handleEvent` drives `routerLoopTransition` once per
  // decision point and executes the returned decision. See router-loop-guard.ts
  // and the fuzz test (router-loop-guard.test.ts) for the invariants — no
  // double-post, no early force-stop, no leaked session (#9960, #7967).
  private loopState: RouterLoopState = createRouterLoopState();

  // Per-root-origin spawn cap. The completion-dedupe slot above only
  // suppresses duplicate POSTS; it does not stop the PLANNER from re-spawning a
  // fresh sub-agent each time a (weak-model) completion comes back truncated or
  // blocked. Observed live: ONE user request fanned out to 70 TASKS_SPAWN_AGENT
  // calls (each emitting a "working on it" ack + a partial answer = Discord
  // spam). The loop guard's round-trip count is per-session (a fresh spawn
  // resets it), its state_lost count only counts session_state_lost and is
  // cleared on every task_complete, and waitForSpawnSlot caps only SIMULTANEOUS
  // sessions —
  // so nothing bounds SERIAL re-spawns of one user message. These count spawns
  // against the STABLE root origin (connector/parent message id + agent type,
  // NOT the per-spawn instruction text — so re-spawns collapse to one key while
  // distinct parallel TASKS:create subtasks are unaffected). FIFO bounded 1024.
  private readonly spawnCountsForOrigin = new Map<string, number>();
  private readonly bestResultForOrigin = new Map<
    string,
    { text: string; deliverable?: string }
  >();

  /** Spawns already issued for this root origin (for the per-origin cap). */
  spawnCountForOrigin(originKey: string): number {
    return this.spawnCountsForOrigin.get(originKey) ?? 0;
  }

  /** Record a spawn against a root origin (FIFO-bounded). */
  noteSpawnForOrigin(originKey: string): void {
    this.spawnCountsForOrigin.set(
      originKey,
      (this.spawnCountsForOrigin.get(originKey) ?? 0) + 1,
    );
    while (this.spawnCountsForOrigin.size > 1024) {
      const oldest = this.spawnCountsForOrigin.keys().next().value;
      if (!oldest) break;
      this.spawnCountsForOrigin.delete(oldest);
    }
  }

  /** Best already-completed result for an origin, relayed instead of re-spawning. */
  bestResultFor(
    originKey: string,
  ): { text: string; deliverable?: string } | undefined {
    return this.bestResultForOrigin.get(originKey);
  }

  /** Keep the LONGEST non-empty result for an origin (full 479001600 wins over truncated 479). */
  recordOriginResult(
    originKey: string,
    result: { text: string; deliverable?: string },
  ): void {
    const candidate = (result.deliverable ?? result.text ?? "").trim();
    if (!candidate) return;
    const prev = this.bestResultForOrigin.get(originKey);
    const prevLen = (prev?.deliverable ?? prev?.text ?? "").trim().length;
    if (prev && candidate.length <= prevLen) return;
    this.bestResultForOrigin.set(originKey, result);
    while (this.bestResultForOrigin.size > 1024) {
      const oldest = this.bestResultForOrigin.keys().next().value;
      if (!oldest) break;
      this.bestResultForOrigin.delete(oldest);
    }
  }

  /**
   * Capture a completed task's deliverable for its origin BEFORE any early
   * return (verify-retry handoff, stale-continuation suppression, lineage
   * dedupe). Those paths return before the main recordOriginResult call
   * further down, so without this bestResultFor() is undefined when the spawn
   * cap later fires — a real finished deliverable is lost and the user sees a
   * generic cap message instead of the answer. recordOriginResult is monotonic
   * (longest-wins), so recording here AND later is always safe. Keys exactly
   * like the main call site (#8875).
   */
  private captureOriginResultForCompletion(
    origin: OriginInfo,
    session: SessionInfo,
    text: string,
    deliverable: string | undefined,
  ): void {
    const originResultKey =
      origin.parentConnectorMessageId ?? origin.spawnRootMessageId;
    if (!originResultKey) return;
    this.recordOriginResult(`${originResultKey}\0${session.agentType}`, {
      text,
      deliverable,
    });
  }

  /**
   * The per-session round-trip count the loop guard has accumulated so far
   * (0 when the session has not round-tripped yet). Read-only: the count is
   * owned by the loop-guard reducer; this only exposes it so the watchdog can
   * warn the user before a runaway session hits the force-stop cap (#8901).
   */
  getRoundTripCount(sessionId: string): number {
    return this.loopState.roundTripCounts.get(sessionId) ?? 0;
  }

  /** The configured per-session round-trip cap (the runaway-loop force-stop limit). */
  getRoundTripCap(): number {
    return this.loopState.roundTripCap;
  }

  private started = false;
  private bindRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.runtime = runtime;
  }

  static async start(runtime: IAgentRuntime): Promise<SubAgentRouter> {
    const router = new SubAgentRouter(runtime);
    await router.start();
    return router;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const disabled = readSetting(
      this.runtime,
      "ACPX_SUB_AGENT_ROUTER_DISABLED",
    );
    if (disabled === "1" || disabled === "true") {
      this.log("info", "router disabled via ACPX_SUB_AGENT_ROUTER_DISABLED");
      return;
    }
    const capRaw = readSetting(this.runtime, "ACPX_SUB_AGENT_ROUND_TRIP_CAP");
    const parsed = capRaw ? Number.parseInt(capRaw, 10) : NaN;
    const slCapRaw = readSetting(this.runtime, "ACPX_STATE_LOST_RESPAWN_CAP");
    const slParsed = slCapRaw ? Number.parseInt(slCapRaw, 10) : NaN;
    this.loopState = createRouterLoopState({
      roundTripCap: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
      stateLostRespawnCap:
        Number.isFinite(slParsed) && slParsed > 0 ? slParsed : undefined,
    });
    // Service registration runs in parallel — when router.start() executes,
    // AcpService may not yet be registered with the runtime, so getService
    // returns null. Static `dependencies` is not enough to order startup.
    // Retry binding on a short backoff (or give up after ~10s and stay idle).
    this.tryBindSources(0);
  }

  private tryBindSources(attempt: number): void {
    if (this.stopped) return;
    const needsAcp = !this.unsubscribe;
    if (!needsAcp) return;

    if (needsAcp) {
      const acp = this.runtime.getService(
        "ACP_SUBPROCESS_SERVICE",
      ) as AcpService | null;
      if (acp && typeof acp.onSessionEvent === "function") {
        this.acp = acp;
        this.unsubscribe = acp.onSessionEvent((sid, event, data) => {
          this.handleEvent(sid, event, data).catch((err) => {
            this.log("error", "router event failed", {
              sessionId: sid,
              event,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        });
      }
    }
    const acpBound = !!this.unsubscribe;
    if (acpBound) {
      this.log("info", "router bound to AcpService");
      return;
    }
    // Service startup is lazy and can happen outside this plugin's ordered
    // eager-start path, so do not go idle forever when ACP is late. Poll
    // quickly for the first ~10s, then keep a low-frequency retry alive.
    if (attempt >= 50) {
      if (attempt === 50 || attempt % 30 === 0) {
        this.log("debug", "AcpService unavailable; router still waiting");
      }
      this.bindRetryTimer = setTimeout(
        () => this.tryBindSources(attempt + 1),
        1000,
      );
      return;
    }
    this.bindRetryTimer = setTimeout(
      () => this.tryBindSources(attempt + 1),
      200,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.bindRetryTimer) {
      clearTimeout(this.bindRetryTimer);
      this.bindRetryTimer = undefined;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.acp = null;
    this.started = false;
    this.delivered.clear();
    this.parentAgentBuffers.clear();
    this.parentAgentDispatchCounts.clear();
    this.verifyRetryHandedOffSessions.clear();
    this.loopState = createRouterLoopState({
      roundTripCap: this.loopState.roundTripCap,
      stateLostRespawnCap: this.loopState.stateLostRespawnCap,
    });
  }

  private async handleEvent(
    sessionId: string,
    event: SessionEventName,
    data: unknown,
  ): Promise<void> {
    // Streamed child output: intercept `USE_SKILL parent-agent <json>` and
    // bridge it to the parent-agent broker. `message` chunks are not injected
    // into the parent (shouldInject excludes them), so this is the only place
    // the directive is observed; the marker guard keeps it inert otherwise.
    if (event === "message") {
      await this.maybeDispatchParentAgent(sessionId, data);
    }
    // Bound the per-session tracking collections. Each accrues one entry per
    // session (buffered parent-agent output, dispatch count, verify-retry
    // handoff marker) and only stop() cleared them, so a long-lived orchestrator
    // leaked one set of entries per finished session. Cap to the most recent N
    // sessions — evicting an old, finished session's entry is harmless (its
    // buffer/count are only used while it streams, and a handoff suppression is
    // moot once the original session is long gone).
    pruneOldestTracked(this.parentAgentBuffers, PARENT_AGENT_TRACKING_CAP);
    pruneOldestTracked(
      this.parentAgentDispatchCounts,
      PARENT_AGENT_TRACKING_CAP,
    );
    pruneOldestTracked(
      this.verifyRetryHandedOffSessions,
      PARENT_AGENT_TRACKING_CAP,
    );
    if (!shouldInject(event)) return;
    const acp = this.acp;
    if (!acp) return;
    const session = (await acp.getSession(sessionId)) ?? undefined;
    if (!session) return;
    if (this.verifyRetryHandedOffSessions.has(sessionId)) {
      this.log(
        "debug",
        "suppressing original session event after verify retry handoff",
        {
          sessionId,
          event,
        },
      );
      return;
    }
    if (event === "error" && isUnsupportedAcpMethodError(data)) {
      this.log(
        "debug",
        "suppressing internal ACP method-not-found error (not a task failure)",
        {
          sessionId,
        },
      );
      return;
    }

    const dedupKey = computeDedupKey(sessionId, event, session, data);
    if (this.delivered.has(dedupKey)) return;
    this.delivered.add(dedupKey);
    pruneDelivered(this.delivered, 256);

    const origin = readOrigin(session);
    if (!origin) {
      this.log(
        "debug",
        "session has no origin metadata; skipping router post",
        {
          sessionId,
          event,
        },
      );
      return;
    }

    // A successful task_complete means this origin task is making progress —
    // reset its state_lost respawn counter so a later genuine restart is not
    // pre-capped by an earlier transient one.
    if (event === "task_complete") {
      this.loopState = routerLoopTransition(this.loopState, {
        type: "task_complete_progress",
        lineageKey: respawnLineageKey(session, origin),
      }).state;
    }

    // The ACP session/prompt stopReason for a task_complete tells us whether the
    // sub-agent's model finished cleanly or DEGENERATELY (truncated / blocked).
    // Threaded into the completion metadata below so the response evaluator can
    // relay the best partial once rather than letting the planner re-spawn the
    // same request — the ~70x weak-model loop (issue elizaOS/eliza#8875).
    const finishReason =
      event === "task_complete"
        ? normalizeFinishReason(pickPayloadString(data, "stopReason"))
        : undefined;

    // Deterministic recovery for the cross-session state_lost cascade. A lost
    // session used to be re-injected into the planner so the planner would
    // spawn a fresh sub-agent — which leaked a "the sub-agent crashed, let me
    // try again" message to the user alongside the eventual deliverable, and
    // each respawn is a NEW session so the per-session roundTripCap never
    // fired. Instead, recover inside the router (mirroring retryIncompleteBuild)
    // and suppress the dead session's narration entirely. Bounded per stable
    // origin lineage; once the cap is exhausted, post ONE honest terminal
    // failure instead of hanging silently.
    // Propagate a spawned account's auth / rate-limit failure to the pool so the
    // selector stops handing out the dud account (and the readiness gate +
    // account-health panel reflect it), instead of swallowing it and re-picking
    // the same account next spawn. Best-effort and conservative — see
    // classifyAccountFailure (a false positive would evict a healthy account).
    let accountFailoverExhausted: CodingAccountFailureKind | null = null;
    let accountFailoverCount = 0;
    if (event === "error") {
      const failureKind = classifyAccountFailure(
        pickPayloadString(data, "message"),
      );
      const accountMeta = accountMetaFromSessionMetadata(
        session.metadata as Record<string, unknown> | undefined,
      );
      if (failureKind && accountMeta) {
        this.log("warn", "coding account failure reported to pool", {
          sessionId,
          providerId: accountMeta.providerId,
          accountId: accountMeta.accountId,
          failureKind,
        });
        // Awaited (not fire-and-forget): the failover respawn below re-selects
        // through the pool, so the dud account's mark must land first or the
        // replacement can be handed the very account that just failed.
        await reportCodingAccountFailure(
          accountMeta,
          failureKind,
          Date.now(),
          `sub-agent session ${sessionId} (${session.agentType})`,
        );
        // Bounded in-router account failover, mirroring the state_lost
        // recovery: the failed account was just marked rate-limited /
        // needs-reauth (or verified healthy again by the bridge's auto-heal),
        // so a respawn through the normal spawn path selects a healthy
        // account and the task continues instead of dying with the session.
        // Shares the state_lost lineage budget so combined crash + limit
        // flapping stays bounded, and only fires while a healthy pooled
        // account remains — with the whole pool exhausted the honest failure
        // below reaches the user.
        if (this.hasHealthyPooledAccount(session.agentType)) {
          const { state, decision } = routerLoopTransition(this.loopState, {
            type: "state_lost",
            lineageKey: respawnLineageKey(session, origin),
            completionKey: completionLineageKey(session, origin),
          });
          this.loopState = state;
          if (decision.kind === "already_terminal") {
            await acp.stopSession(sessionId).catch(() => {});
            return;
          }
          if (decision.kind === "respawn") {
            const respawned = await this.respawnStateLost(
              session,
              `account ${failureKind}`,
            );
            if (respawned) {
              this.verifyRetryHandedOffSessions.add(sessionId);
              await acp.stopSession(sessionId).catch(() => {});
              return;
            }
          } else if (decision.kind === "terminal_failure") {
            accountFailoverExhausted = failureKind;
            accountFailoverCount = decision.count;
            await acp.stopSession(sessionId).catch(() => {});
          }
        }
      }
    }

    let stateLostExhausted = false;
    let stateLostRespawnCount = 0;
    if (
      event === "error" &&
      pickPayloadString(data, "failureKind") === "session_state_lost"
    ) {
      const { state, decision } = routerLoopTransition(this.loopState, {
        type: "state_lost",
        lineageKey: respawnLineageKey(session, origin),
        // A `task_complete` for this lineage claims its slot under the
        // completion key; pass it so the reducer can suppress a teardown-race
        // state-loss whose deliverable already posted (no false "retry?").
        completionKey: completionLineageKey(session, origin),
      });
      this.loopState = state;
      if (decision.kind === "already_terminal") {
        // Cap exhausted and already reported once for this lineage: stop the
        // dead session and drop silently — the user already got one honest
        // failure (eliza#7967).
        await acp.stopSession(sessionId).catch(() => {});
        return;
      }
      if (decision.kind === "terminal_failure") {
        // Cap exhausted, first time: stop the dead session and fall through to
        // the normal delivery path below with a forced terminal narration so
        // the user is not left with a silent hang. The completion-claim slot is
        // task_complete-only, so an error never routes through it.
        stateLostRespawnCount = decision.count;
        await acp.stopSession(sessionId).catch(() => {});
        this.log(
          "warn",
          "state_lost respawn cap reached; reporting terminal failure for this origin lineage",
          {
            sessionId,
            count: decision.count,
            cap: this.loopState.stateLostRespawnCap,
          },
        );
        stateLostExhausted = true;
      } else if (decision.kind === "respawn") {
        // Under cap: recover deterministically inside the router. On success,
        // suppress the dead session's tail events and return WITHOUT posting —
        // the recovered child's task_complete becomes the only user-facing
        // message. On failure (no initialTask / spawn threw), fall through to
        // the normal error narration so the user gets an honest report instead
        // of silence.
        stateLostRespawnCount = decision.count;
        const respawned = await this.respawnStateLost(session);
        if (respawned) {
          this.verifyRetryHandedOffSessions.add(sessionId);
          await acp.stopSession(sessionId).catch(() => {});
          return;
        }
      }
    }

    const roundTrip = routerLoopTransition(this.loopState, {
      type: "round_trip",
      sessionId,
    });
    this.loopState = roundTrip.state;
    const nextCount =
      "count" in roundTrip.decision ? roundTrip.decision.count : 0;
    const capExceeded =
      roundTrip.decision.kind === "force_stop" ||
      roundTrip.decision.kind === "already_capped";
    // Roll the round-trip counter back when this event is suppressed downstream
    // (verify-retry handoff, stale continuation, or cross-session completion
    // dedupe). Those events never post a synthetic inbound, so counting them
    // against the runaway-loop cap would miscount real round-trips and trip the
    // force-stop early. The reducer only undoes the increment if it is still the
    // current value (no later event has advanced it).
    const rollbackRoundTrip = (): void => {
      this.loopState = routerLoopTransition(this.loopState, {
        type: "rollback_round_trip",
        sessionId,
        expectedCount: nextCount,
      }).state;
    };
    if (roundTrip.decision.kind === "already_capped") {
      this.log("debug", "round-trip cap already surfaced; suppressing", {
        sessionId,
        event,
        count: nextCount,
      });
      return;
    }
    if (roundTrip.decision.kind === "force_stop") {
      this.log("warn", "sub-agent round-trip cap exceeded; force-stopping", {
        sessionId,
        count: nextCount,
        cap: this.loopState.roundTripCap,
      });
      await acp.stopSession(sessionId).catch((err) =>
        this.log("warn", "force-stop after cap failed", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    const subAgentEntityId = deriveUuidFromString(
      `${this.runtime.agentId}:${SUB_AGENT_ENTITY_NAMESPACE}:${sessionId}`,
    );
    // The synthetic sub-agent entityId is a deterministic UUID for the
    // session — but it doesn't exist in the entities table yet, so the
    // FK on memories.entity_id rejects the insert and the router post
    // dies before the planner ever sees it.
    //
    // Create just the entity, NOT a full ensureConnection. ensureConnection
    // upserts the room with `channelId: c.channelId ?? c.roomId` — we don't
    // have the source channelId snowflake here, so it would overwrite the
    // Discord plugin's `channelId = snowflake` with `channelId = UUID` and
    // break outbound delivery via runtime.sendMessageToTarget. The room
    // already exists (the user's inbound Discord message created it); we
    // only need the entity + room participation.
    await this.runtime
      .createEntity({
        id: subAgentEntityId,
        agentId: this.runtime.agentId,
        names: [`sub-agent: ${origin.label}`],
        metadata: {
          [ACPX_ROUTER_SOURCE]: {
            subAgentSessionId: sessionId,
            subAgentAgentType: session.agentType,
          },
        },
      })
      .catch((err) => {
        this.log("warn", "createEntity for sub-agent failed", {
          sessionId,
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    // Capture the real git change set the sub-agent produced, scoped to the
    // baseline recorded at spawn. This is ground truth — it replaces the
    // model's raw step transcript in the completion narration (which leaked
    // verbatim to the user and read as pending work to the planner) and
    // is persisted so "what did you change / show me the diff" can be
    // answered from the actual change set instead of a confabulated edit.
    let changeSet: WorkspaceChangeSet | undefined;
    let artifactVerification: WorkspaceArtifactVerification | undefined;
    if (event === "task_complete" && this.acp) {
      try {
        const meta = session.metadata as Record<string, unknown> | undefined;
        const baseline = pickPlainString(meta?.codingBaselineSha);
        const baselineDirty = Array.isArray(meta?.codingBaselineDirty)
          ? (meta.codingBaselineDirty as unknown[]).map(String)
          : [];
        changeSet = await captureChangeSet(
          session.workdir,
          baseline,
          this.acp.getChangedPaths(sessionId),
          baselineDirty,
        );
        // Persist only a real change set. An unchanged completion stores nothing,
        // so the provider — which selects the most-recently-completed session
        // and reads ITS change set — can't bleed an older task's diff.
        if (changeSet) {
          artifactVerification = verifyChangedFilesOnDisk(
            session.workdir,
            changeSet.changedFiles,
          );
          await this.acp.updateSessionMetadata(sessionId, {
            lastChangeSet: changeSet,
            lastArtifactVerification: artifactVerification,
          });
        }
      } catch (err) {
        this.log("debug", "change-set capture failed", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Normalize URLs in the sub-agent's narration before anything else
    // reads it. Weak coding models (gpt-oss-class) emit Unicode look-alike
    // dashes (non-breaking hyphen U+2011, en/em dashes) inside URLs, so the
    // link 404s even though the directory exists under the ASCII-hyphen
    // name — breaking it for both the verification probe AND the user.
    const baseText = normalizeUrlsInText(
      accountFailoverExhausted
        ? `[sub-agent: ${origin.label} (${session.agentType}) — account ${accountFailoverExhausted}]\nThis task hit a pooled-account ${accountFailoverExhausted} failure ${accountFailoverCount} times and exhausted its automatic account-failover restarts (cap=${this.loopState.stateLostRespawnCap}). Decide whether to wait for the limit to reset, connect another account, or drop the task.`
        : stateLostExhausted
          ? `[sub-agent: ${origin.label} (${session.agentType}) — unrecoverable]\nThis task lost its working session ${stateLostRespawnCount} times and could not be recovered after ${this.loopState.stateLostRespawnCap} automatic restarts. Decide whether to retry the task from scratch, escalate to the user, or drop it.`
          : capExceeded
            ? `[sub-agent: ${origin.label} (${session.agentType}) — round-trip cap exceeded]\nThis session reached ${nextCount} round-trips (cap=${this.loopState.roundTripCap}) and was force-stopped to prevent a runaway loop. Decide whether to spawn a fresh session, escalate to the user, or drop the task.`
            : composeNarration(
                event,
                origin.label,
                session,
                data,
                changeSet,
                artifactVerification,
              ),
    );
    // Fact-check any URLs the sub-agent claimed. Weak coding models
    // routinely report "the app is live at <url>" without writing the
    // files (or the deps the page references). Independently probing each
    // claimed URL — and following an HTML page's own sub-resources —
    // turns the parent's reply from a hallucinated success into an
    // accurate status report.
    let text = redactLoopbackUrls(baseText);
    let deadUrls: DeadUrl[] = [];
    let verifiedUrls: string[] = [];
    if (event === "task_complete") {
      const meta = session.metadata as Record<string, unknown> | undefined;
      const verificationReferenceText =
        typeof meta?.initialTask === "string" ? meta.initialTask : undefined;
      const ignoredVerifyUrls = pickStringSet(meta?.cachedStaleMissUrls);
      const routeVerification = routeVerificationForSession(session);
      const verified = await annotateUnverifiedUrls(
        baseText,
        (m) => this.log("debug", m),
        verificationReferenceText,
        ignoredVerifyUrls,
        this.runtime,
        routeVerification,
      );
      text = redactLoopbackUrls(verified.text);
      deadUrls = verified.dead;
      verifiedUrls = verified.verifiedUrls;
    }
    // When the deliverable IS the printed/tool output and there is no change
    // set and no verified URL, composeNarration→stripToolTranscript has just
    // deleted it from `text`. Recover the captured block from the RAW response
    // (before stripping) so the parent relays it verbatim instead of replying
    // with an empty completion. Gated to a single short block so multi-KB
    // transcripts stay on the model-rendered (summarized) path.
    let deliverable: string | undefined;
    // Capture the deliverable even when files changed: a "do X and report the
    // output" task that also writes a file must still surface the output, not
    // only the diff summary. The verifiedUrls path keeps its dedicated handling.
    if (event === "task_complete" && verifiedUrls.length === 0) {
      deliverable = extractShortToolDeliverable(data);
    }
    // Verify-retry: the sub-agent reported done but referenced URLs that
    // are unreachable — the build is incomplete (missing or empty files).
    // Re-dispatch a fresh sub-agent with the verification failures fed
    // back in, before surfacing the failure to the user. When a retry is
    // spawned, suppress this post — the retry's own task_complete reports.
    if (event === "task_complete" && deadUrls.length > 0) {
      const retried = await this.retryIncompleteBuild(session, deadUrls);
      if (retried) {
        this.verifyRetryHandedOffSessions.add(sessionId);
        this.captureOriginResultForCompletion(
          origin,
          session,
          text,
          deliverable,
        );
        rollbackRoundTrip();
        return;
      }
      if (await this.hasNewerContinuation(session, origin)) {
        this.log(
          "debug",
          "suppressing stale verification failure; newer continuation exists",
          { sessionId, deadCount: deadUrls.length },
        );
        this.captureOriginResultForCompletion(
          origin,
          session,
          text,
          deliverable,
        );
        rollbackRoundTrip();
        return;
      }
    }
    // Origin-message dedupe: if a DIFFERENT sub-agent session for the
    // SAME user prompt has already posted a task_complete to the user,
    // absorb this one silently. This catches the cascade case where the
    // orchestrator dispatched a retry sub-agent for a different reason
    // (state_lost, blocked, transient error) after the first task_complete
    // already shipped — without this guard the user sees 2-3+ overlapping
    // replies with random URL leakage (issue elizaOS/eliza#7967).
    //
    // Same-session progressive task_completes (a sub-agent reports
    // partial progress, then full completion) still post both — the
    // dedupe key includes sessionId. Only cross-session retries are
    // suppressed.
    const completionKey =
      event === "task_complete" ? completionLineageKey(session, origin) : null;
    // Atomically claim the lineage's completion slot BEFORE the awaited delivery
    // loop, so two same-lineage retry sessions completing in the same window
    // cannot both pass the check and double-post (eliza#7967). The reducer's
    // claim is a synchronous compare-and-set — there is no await between the
    // get and the set, so the TOCTOU window is closed by construction.
    if (completionKey) {
      const claim = routerLoopTransition(this.loopState, {
        type: "claim_completion",
        completionKey,
        sessionId,
      });
      this.loopState = claim.state;
      if (claim.decision.kind === "already_claimed") {
        this.log(
          "debug",
          "suppressing duplicate sub-agent task_complete for lineage; another session already claimed this task",
          {
            sessionId,
            completionKey,
            event,
          },
        );
        this.captureOriginResultForCompletion(
          origin,
          session,
          text,
          deliverable,
        );
        rollbackRoundTrip();
        return;
      }
    }
    if (event === "task_complete" && verifiedUrls.length > 0) {
      text = verifiedUrlCompletionFallback(text, verifiedUrls);
    } else if (
      event === "task_complete" &&
      deliverable &&
      !text.includes(deliverable)
    ) {
      // The captured tool output IS the answer for a "run it and report the
      // output" task. The weak model's prose paraphrase of the same run is
      // routinely truncated (relays "479" for a captured "479001600"), and that
      // prose — not the metadata deliverable — is what every downstream reader
      // consumes: the planner re-derives its reply from this narration, and
      // Stage-1 regenerates any bare-numeric reply from it. So surface the
      // verbatim deliverable as the narration body (the header's relay /
      // do-not-respawn directive is preserved on the first line).
      const firstNewline = text.indexOf("\n");
      const header = firstNewline === -1 ? text : text.slice(0, firstNewline);
      text = `${header}\n${deliverable}`;
    }
    if (event === "task_complete") {
      // Remember the best (longest) result for this root origin so the spawn
      // cap (tasks.ts) can relay it instead of re-spawning when a weak model's
      // later completion for the SAME user request comes back truncated/blocked.
      // Key on the stable root id — the connector message id when present, else
      // the user message id the router stamps onto each synthetic re-spawn
      // inbound as `spawnRootMessageId` (dashboard/web has no connector id).
      // This MUST match tasks.ts's `spawnOriginKey` derivation so record +
      // enforce agree on every transport (#8875).
      const originResultKey =
        origin.parentConnectorMessageId ?? origin.spawnRootMessageId;
      if (originResultKey) {
        this.recordOriginResult(`${originResultKey}\0${session.agentType}`, {
          text,
          deliverable,
        });
      }
      // Strip the planner-only `[sub-agent: …]` header before previewing so
      // the notification body shows the actual result (e.g. "PR opened"),
      // not the relay/do-not-respawn directive. The header can now be long
      // (it carries the actual-workdir + requested-vs-actual-agent note), so a
      // naive slice(0,200) of the raw text would capture only the directive.
      const previewSource = (
        deliverable ?? stripSubAgentHeaderLine(text)
      ).trim();
      const preview = previewSource.slice(0, 200);
      void getNotifier(this.runtime)
        ?.notify({
          title: `${origin.label || "Agent task"} finished`,
          ...(preview ? { body: preview } : {}),
          category: "agent",
          priority: "normal",
          source: "orchestrator",
          deepLink: "/orchestrator",
          groupKey: `orchestrator:${sessionId}`,
          data: {
            sessionId,
            label: origin.label,
            ...(origin.source ? { originSource: origin.source } : {}),
          },
        })
        .catch((err: unknown) => {
          this.log("debug", "notification emit failed", {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      // #8904: forward any screenshots/artifacts the completion carries to the
      // origin chat as photos (best-effort; missing target/paths → no-op). The
      // connector renders Content.attachments (Telegram via sendMedia PHOTO).
      const completionText =
        pickPayloadString(data, "response") ??
        pickPayloadString(data, "finalText");
      const screenshotPaths = collectScreenshotPaths(
        completionText,
        session.metadata as Record<string, unknown> | undefined,
      ).filter((p) => fs.existsSync(p));
      const sendShots = (this.runtime as RuntimeWithSendTarget)
        .sendMessageToTarget;
      if (screenshotPaths.length > 0 && origin.source && sendShots) {
        await deliverScreenshots(
          (t, c) => sendShots(t, c),
          { source: origin.source, roomId: origin.roomId },
          screenshotPaths,
          origin.label,
        );
      }
    }
    const routingKind = routingKindForEvent(event, data, capExceeded);
    const targets = swarmTargetsForRouting(origin, routingKind);
    await Promise.all(
      targets.map((target) =>
        this.runtime
          .addParticipant(subAgentEntityId, target.roomId)
          .catch((err) => {
            this.log("warn", "addParticipant for sub-agent failed", {
              sessionId,
              event,
              roomId: target.roomId,
              error: err instanceof Error ? err.message : String(err),
            });
          }),
      ),
    );

    // The Discord plugin wires a callback bound to the originating channel
    // when it calls handleMessage; without that callback, the planner has
    // nowhere to deliver its reply and the bot's answer to the sub-agent
    // narration is dropped silently (the user sees only "On it…" and never
    // the actual result). For synthetic router posts we build the same
    // callback from `runtime.sendMessageToTarget`, scoped to the origin
    // source and selected swarm room. If the connector isn't registered, fall through to
    // handleMessage without a callback — the planner will still update
    // state but no message reaches the user.
    for (const target of targets) {
      const sessionMeta = session.metadata as
        | Record<string, unknown>
        | undefined;
      const sessionRoute =
        sessionMeta?.workdirRoute &&
        typeof sessionMeta.workdirRoute === "object"
          ? (sessionMeta.workdirRoute as Record<string, unknown>)
          : undefined;
      const sessionRouteId = pickPlainString(sessionMeta?.workdirRouteId);
      const sessionInitialTask = pickPlainString(sessionMeta?.initialTask);
      const memory: Memory = {
        id: randomUUID() as UUID,
        entityId: subAgentEntityId,
        agentId: this.runtime.agentId,
        roomId: target.roomId,
        ...(origin.worldId ? { worldId: origin.worldId } : {}),
        content: {
          text,
          source: ACPX_ROUTER_SOURCE,
          ...(origin.parentMessageId
            ? { inReplyTo: origin.parentMessageId }
            : {}),
          metadata: {
            subAgent: true,
            subAgentSessionId: sessionId,
            subAgentLabel: origin.label,
            subAgentEvent: stateLostExhausted
              ? "state_lost_exhausted"
              : capExceeded
                ? "round_trip_cap_exceeded"
                : event,
            subAgentStatus: stateLostExhausted
              ? "failed"
              : capExceeded
                ? "stopped"
                : session.status,
            subAgentAgentType: session.agentType,
            subAgentActualAgentType: session.agentType,
            ...(pickPlainString(sessionMeta?.requestedType)
              ? {
                  subAgentRequestedType: pickPlainString(
                    sessionMeta?.requestedType,
                  ),
                }
              : {}),
            subAgentWorkdir: session.workdir,
            ...(artifactVerification
              ? {
                  subAgentArtifactVerification:
                    artifactVerificationMetadata(artifactVerification),
                }
              : {}),
            subAgentRoundTrip: nextCount,
            subAgentRoundTripCap: this.loopState.roundTripCap,
            subAgentRoutingKind: routingKind,
            subAgentTargetRoomId: target.roomId,
            subAgentTargetRoomRole: target.roles[0],
            subAgentTargetRoomRoles: target.roles,
            // Cast: the Content index signature expects MetadataValue but
            // swarmRoomsMetadata returns Array<Record<string, string|string[]>>,
            // which is a valid JsonValue[] but TypeScript can't infer that here.
            subAgentSwarmRooms: swarmRoomsMetadata(origin.swarmRooms) as Array<
              Record<string, string | string[]>
            >,
            taskRoomId: origin.taskRoomId,
            ...(origin.worktreeRoomId
              ? { worktreeRoomId: origin.worktreeRoomId }
              : {}),
            ...(capExceeded ? { subAgentCapExceeded: true } : {}),
            ...(verifiedUrls.length > 0
              ? { subAgentVerifiedUrls: verifiedUrls }
              : {}),
            ...(deliverable ? { subAgentDeliverable: deliverable } : {}),
            ...(finishReason ? { subAgentFinishReason: finishReason } : {}),
            ...(origin.userId ? { originUserId: origin.userId } : {}),
            ...(origin.parentMessageId
              ? { originMessageId: origin.parentMessageId }
              : {}),
            ...(origin.parentConnectorMessageId
              ? { originConnectorMessageId: origin.parentConnectorMessageId }
              : {}),
            // Re-stamp the stable root id so the NEXT re-spawn anchors its
            // per-origin cap key to the same user request on connector-less
            // (dashboard/web) transports. (#8875)
            ...(origin.spawnRootMessageId
              ? { spawnRootMessageId: origin.spawnRootMessageId }
              : {}),
            ...(origin.source ? { originSource: origin.source } : {}),
            ...(sessionRouteId ? { workdirRouteId: sessionRouteId } : {}),
            ...(sessionRoute ? { workdirRoute: sessionRoute } : {}),
            ...(sessionInitialTask ? { initialTask: sessionInitialTask } : {}),
          } as Content["metadata"],
        },
        createdAt: Date.now(),
      };
      const replyCallback = this.buildReplyCallback(origin, sessionId, target);
      // messageService.handleMessage saves the memory itself ("Saving message
      // to memory" inside SERVICE:MESSAGE). When that path is available, skip
      // the explicit createMemory — otherwise we double-save with the same
      // primary key and the second insert dies on a unique-constraint
      // violation, killing the planner trip and dropping the sub-agent answer.
      if (this.runtime.messageService?.handleMessage) {
        await this.runtime.messageService
          .handleMessage(this.runtime, memory, replyCallback)
          .catch((err) => {
            this.log("error", "handleMessage for sub-agent post failed", {
              sessionId,
              event,
              roomId: target.roomId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      } else {
        this.log(
          "warn",
          "runtime.messageService unavailable; falling back to MESSAGE_RECEIVED emit",
          {
            sessionId,
            event,
            roomId: target.roomId,
          },
        );
        await this.runtime.createMemory(memory, "messages").catch((err) => {
          this.log("warn", "createMemory for sub-agent post failed", {
            sessionId,
            event,
            roomId: target.roomId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        const emit = this.runtime.emitEvent.bind(this.runtime) as (
          name: string,
          payload: { source: string; message: Memory; runtime: IAgentRuntime },
        ) => Promise<void>;
        await emit("MESSAGE_RECEIVED", {
          runtime: this.runtime,
          message: memory,
          source: ACPX_ROUTER_SOURCE,
        });
      }
    }

    // The lineage slot was already claimed atomically before the delivery loop
    // (the reducer's claim_completion), so there is nothing to mark here. The
    // claim suppresses
    // a later retry sub-agent (different sessionId) for the same parent prompt
    // (issue elizaOS/eliza#7967); same-session progressive task_completes are
    // unaffected because the claim is keyed by sessionId, and a verify-retry
    // handoff returns earlier (above) so an incomplete build never claims.
  }

  private buildReplyCallback(
    origin: OriginInfo,
    sessionId: string,
    target: SwarmRoomTarget,
  ): HandlerCallback | undefined {
    const sendToTarget = (
      this.runtime as RuntimeWithSendTarget
    ).sendMessageToTarget?.bind(this.runtime);
    if (!sendToTarget) return undefined;
    const source = origin.source;
    if (!source) return undefined;
    return async (response: Content): Promise<Memory[]> => {
      const text =
        typeof response.text === "string" ? response.text.trim() : "";
      if (!text) return [];
      const originReplyTarget =
        origin.parentConnectorMessageId ?? origin.parentMessageId;
      const threadedResponse = originReplyTarget
        ? {
            ...response,
            source: "sub_agent_complete",
            inReplyTo: originReplyTarget,
          }
        : { ...response, source: "sub_agent_complete" };
      const delivered = await sendToTarget(
        {
          source,
          roomId: origin.roomId,
        },
        threadedResponse,
      ).catch((err) => {
        this.log("warn", "sub-agent reply delivery failed", {
          sessionId,
          source,
          roomId: origin.roomId,
          targetRoomId: target.roomId,
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      });
      return delivered ? [delivered] : [];
    };
  }

  /**
   * Recover a session that reported `session_state_lost` by deterministically
   * spawning a fresh sub-agent inside the router — carrying the byte-identical
   * origin metadata and the original task — instead of re-injecting the error
   * and relying on the parent planner to spawn the replacement (which leaked a
   * "the sub-agent crashed, let me try again" message to the user). Returns
   * true when a replacement was spawned (the caller suppresses the dead
   * session's events and posts nothing — the child's own task_complete is the
   * only user-facing message). Returns false when the original task is
   * unavailable or no spawn service is registered, in which case the caller
   * falls through to an honest failure post.
   *
   * Lineage capping lives in the loop-guard reducer (the state_lost respawn
   * count + cap), parallel to the verify-retry budget, so a flapping session
   * can't respawn unbounded.
   */
  private async respawnStateLost(
    session: SessionInfo,
    reason = "session_state_lost",
  ): Promise<boolean> {
    const meta = (session.metadata ?? {}) as Record<string, unknown>;
    // The original task is stashed on metadata by TASKS op=spawn_agent —
    // SessionInfo itself doesn't carry it. Without it we can't reconstruct the
    // work, so surface the failure honestly instead of respawning a blank one.
    const originalTask =
      typeof meta.initialTask === "string" ? meta.initialTask.trim() : "";
    if (!originalTask) return false;

    const service =
      this.acp ??
      (this.runtime.getService("ACP_SUBPROCESS_SERVICE") as AcpService | null);
    if (!service?.spawnSession) return false;

    // Drop the dead session's account descriptor: spawnSession re-selects and
    // re-stamps `account`, but if the pool degrades to single-account on the
    // respawn a stale copy would mis-attribute the replacement's failures to
    // an account that isn't serving it.
    const { account: _staleAccount, ...carriedMeta } = meta;
    try {
      const result = await service.spawnSession({
        agentType: session.agentType,
        workdir: session.workdir,
        initialTask: originalTask,
        approvalPreset: session.approvalPreset,
        // Carry the original metadata forward verbatim — origin routing keys
        // (roomId/source/...) plus the unchanged `initialTask` — so the
        // replacement reports back to the same user thread. retryOfSessionId
        // records the lineage; keepAliveAfterComplete:false mirrors the
        // verify-retry recovery.
        metadata: {
          ...carriedMeta,
          keepAliveAfterComplete: false,
          retryOfSessionId: session.id,
        },
      });
      this.log("info", `re-dispatched sub-agent after ${reason}`, {
        sessionId: session.id,
        retrySessionId: result.sessionId,
      });
      return true;
    } catch (err) {
      this.log(
        "warn",
        `${reason} respawn spawn failed; surfacing the failure instead`,
        {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return false;
    }
  }

  /**
   * Whether the account pool still has ≥1 healthy pooled account for this
   * agent type — the gate for the in-router account failover. False when the
   * bridge is absent (single-account host) or the pool is fully exhausted, in
   * which case the honest failure must reach the user instead of a doomed
   * respawn burning a lineage-budget slot.
   */
  private hasHealthyPooledAccount(agentType: string): boolean {
    const bridge = getCodingAccountBridge();
    if (!bridge) return false;
    try {
      const rows = bridge.describe()[agentType.toLowerCase()] ?? [];
      return rows.some((row) => row.healthy > 0);
    } catch {
      return false;
    }
  }

  /**
   * Re-dispatch a sub-agent when its claimed URLs verify as unreachable —
   * an incomplete build (missing or empty files). Returns true if a retry
   * was spawned (the caller suppresses the parent post and lets the
   * retry's own task_complete report the outcome). Returns false when
   * retries are disabled, the budget is exhausted, the original task is
   * unavailable, or no spawn service is registered — in which case the
   * caller posts the honest "build incomplete" report instead.
   *
   * Bounded by ELIZA_BUILD_VERIFY_MAX_RETRIES (default 2; 0 disables).
   * The retry count rides on the spawned session's metadata so a whole
   * lineage of retries shares one budget. Mirrors the APP-create
   * verification-retry pattern.
   */
  private async retryIncompleteBuild(
    session: SessionInfo,
    dead: DeadUrl[],
  ): Promise<boolean> {
    const maxRetriesRaw =
      readSetting(this.runtime, "ELIZA_BUILD_VERIFY_MAX_RETRIES") ?? "2";
    const maxRetries = Number.parseInt(maxRetriesRaw, 10);
    if (!Number.isFinite(maxRetries) || maxRetries <= 0) return false;

    const meta = (session.metadata ?? {}) as Record<string, unknown>;
    const priorRetries =
      typeof meta.buildVerifyRetryCount === "number"
        ? meta.buildVerifyRetryCount
        : 0;
    if (priorRetries >= maxRetries) {
      this.log(
        "info",
        "build still incomplete after verify-retry budget exhausted",
        { sessionId: session.id, retries: priorRetries, maxRetries },
      );
      return false;
    }

    // The original task is stashed on metadata by TASKS op=spawn_agent —
    // SessionInfo itself doesn't carry it.
    const originalTask =
      typeof meta.initialTask === "string" ? meta.initialTask.trim() : "";
    if (!originalTask) return false;

    const service =
      this.acp ??
      (this.runtime.getService("ACP_SUBPROCESS_SERVICE") as AcpService | null);
    if (!service?.spawnSession) return false;

    const nextRetry = priorRetries + 1;
    const cachedStaleMissUrls = mergeCachedStaleMissUrls(
      pickStringSet(meta.cachedStaleMissUrls),
      dead,
    );
    const cachedDead = dead.filter((entry) =>
      entry.status.includes("cached stale miss"),
    );
    const missingDead = dead.filter(
      (entry) => !entry.status.includes("cached stale miss"),
    );
    const formatDeadLines = (entries: DeadUrl[]) =>
      entries
        .map((d) =>
          d.via
            ? `  - ${d.url} (referenced by ${d.via}) → ${d.status}`
            : `  - ${d.url} → ${d.status}`,
        )
        .join("\n");
    const cachedFeedback =
      cachedDead.length > 0
        ? `\nThese URL(s) are stale cached 404s. Their exact filenames are unavailable for this retry; do not recreate them and do not leave any HTML reference pointing to them. Create fresh asset filenames in the same app directory (for example, add a version suffix), update every HTML reference to the fresh filenames, then verify the fresh public URLs:\n${formatDeadLines(cachedDead)}\n`
        : "";
    const missingFeedback =
      missingDead.length > 0
        ? `\nThese URL(s) are not reachable, which means the corresponding files are missing, empty, or served from the wrong path. Create or fix every one of these files in the location the task specifies, then verify each file exists and is non-empty:\n${formatDeadLines(missingDead)}\n`
        : "";
    const retryTask = `--- VERIFICATION FEEDBACK (retry ${nextRetry}/${maxRetries}) ---
The previous attempt reported the task complete, but verification failed. This feedback overrides conflicting filename or URL instructions in the original task.${cachedFeedback}${missingFeedback}
Original task for context:
${originalTask}

Do not report done until every referenced URL in the final page resolves without verification errors.`;

    try {
      const result = await service.spawnSession({
        agentType: session.agentType,
        workdir: session.workdir,
        initialTask: retryTask,
        approvalPreset: session.approvalPreset,
        // Carry the original metadata forward — origin routing keys
        // (roomId/source/...) plus the unchanged `initialTask` — and bump
        // the shared retry counter so the lineage stays bounded.
        metadata: {
          ...meta,
          buildVerifyRetryCount: nextRetry,
          keepAliveAfterComplete: false,
          retryOfSessionId: session.id,
          ...(cachedStaleMissUrls.size > 0
            ? { cachedStaleMissUrls: [...cachedStaleMissUrls] }
            : {}),
        },
      });
      this.log("info", "re-dispatched sub-agent after failed verification", {
        sessionId: session.id,
        retrySessionId: result.sessionId,
        retry: nextRetry,
        maxRetries,
        deadCount: dead.length,
      });
      return true;
    } catch (err) {
      this.log(
        "warn",
        "verify-retry spawn failed; surfacing the failure instead",
        {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return false;
    }
  }

  private async hasNewerContinuation(
    session: SessionInfo,
    origin: OriginInfo,
  ): Promise<boolean> {
    const service =
      this.acp ??
      (this.runtime.getService("ACP_SUBPROCESS_SERVICE") as AcpService | null);
    if (!service?.listSessions) return false;
    const currentCreatedAt = sessionTimeMs(session.createdAt);
    const sessions = await service
      .listSessions()
      .catch(() => [] as SessionInfo[]);
    return sessions.some((candidate) =>
      isNewerContinuationSession(candidate, session, origin, currentCreatedAt),
    );
  }

  /**
   * Accumulate streamed child text and, when a complete
   * `USE_SKILL parent-agent <json>` directive appears, bridge it to the broker
   * and stream the reply back into the session. Synchronous up to the point a
   * complete directive is found (the buffer is trimmed before any await), so
   * out-of-order `message` chunks cannot re-dispatch or corrupt the buffer.
   */
  private async maybeDispatchParentAgent(
    sessionId: string,
    data: unknown,
  ): Promise<void> {
    const acp = this.acp;
    if (!acp) return;
    const chunk =
      typeof (data as { text?: unknown } | null)?.text === "string"
        ? (data as { text: string }).text
        : "";
    if (!chunk) return;

    const MAX_BUFFER = 16_384;
    const TAIL = 64; // ≥ marker length, to catch a marker split across chunks
    let buf = (this.parentAgentBuffers.get(sessionId) ?? "") + chunk;

    const markerAt = parentAgentMarkerIndex(buf);
    if (markerAt < 0) {
      this.parentAgentBuffers.set(sessionId, buf.slice(-TAIL));
      return;
    }
    buf = buf.slice(markerAt);
    if (buf.length > MAX_BUFFER) buf = buf.slice(-MAX_BUFFER);

    const directive = extractParentAgentDirective(buf);
    if (!directive) {
      // Marker present but the JSON is still streaming (or malformed). If it is
      // malformed the extractor returns null; drop the dead marker so we do not
      // re-scan it forever, keeping only a tail.
      this.parentAgentBuffers.set(
        sessionId,
        buf.length > MAX_BUFFER ? buf.slice(-TAIL) : buf,
      );
      return;
    }
    // Consume the directive BEFORE awaiting so a concurrent chunk cannot
    // re-dispatch it.
    this.parentAgentBuffers.set(sessionId, buf.slice(directive.endIndex));

    const nextCount = (this.parentAgentDispatchCounts.get(sessionId) ?? 0) + 1;
    this.parentAgentDispatchCounts.set(sessionId, nextCount);
    if (nextCount > this.loopState.roundTripCap) {
      this.log(
        "warn",
        "parent-agent dispatch cap exceeded; dropping directive",
        {
          sessionId,
          count: nextCount,
          cap: this.loopState.roundTripCap,
        },
      );
      await acp
        .sendToSession(
          sessionId,
          `parent-agent bridge: round-trip cap (${this.loopState.roundTripCap}) reached for this session; not running further USE_SKILL parent-agent requests.`,
        )
        .catch(() => undefined);
      return;
    }

    const session = (await acp.getSession(sessionId)) ?? undefined;
    this.log("info", "dispatching parent-agent directive", {
      sessionId,
      mode:
        typeof directive.args.mode === "string" ? directive.args.mode : "ask",
      command:
        typeof directive.args.command === "string"
          ? directive.args.command
          : undefined,
      count: nextCount,
    });
    await dispatchParentAgentDirective({
      runtime: this.runtime,
      acp,
      sessionId,
      session,
      args: directive.args,
      log: this.runtime.logger,
    });
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    data?: unknown,
  ): void {
    const logger = this.runtime.logger;
    const fn = logger[level];
    if (typeof fn === "function") {
      fn.call(
        logger,
        { src: "acpx:sub-agent-router", ...(data as object) },
        msg,
      );
    }
  }
}

interface NotificationEmitter {
  notify: (input: {
    title: string;
    body?: string;
    category?: string;
    priority?: string;
    source?: string;
    deepLink?: string;
    groupKey?: string;
    data?: Record<string, unknown>;
  }) => Promise<unknown>;
}

function getNotifier(runtime: {
  getService: (t: string) => unknown;
}): NotificationEmitter | null {
  const svc = runtime.getService(
    ServiceType.NOTIFICATION,
  ) as NotificationEmitter | null;
  return svc && typeof svc.notify === "function" ? svc : null;
}

function shouldInject(event: SessionEventName): boolean {
  return (
    event === "task_complete" ||
    event === "error" ||
    event === "blocked" ||
    event === QUESTION_FOR_TASK_CREATOR ||
    event === AGENT_COORDINATION
  );
}

function isUnsupportedAcpMethodError(data: unknown): boolean {
  const serialized =
    typeof data === "object" && data !== null
      ? JSON.stringify(data)
      : String(data ?? "");
  // Gate on the JSON-RPC method-not-found CODE (-32601), NOT free text. A
  // sub-agent's own build error that merely contains the words "method not
  // found" (e.g. an upstream "405 Method Not Allowed") must still reach the
  // user — only a real -32601 from the ACP layer is internal protocol noise.
  // It means the CLIENT called an auxiliary method the adapter lacks
  // (session/cancel, terminal/*, fs/*); the sub-agent keeps running and the
  // real outcome still arrives via task_complete or a timeout.
  const isMethodNotFound =
    /"code"\s*:\s*-32601\b/.test(serialized) ||
    /\(-32601\)/.test(serialized) ||
    // A "method not found" that names a REAL auxiliary ACP method. Match an
    // explicit allow-list of method names rather than `(session|terminal|fs)/*`:
    // the broad form false-matches a sub-agent's own build output (e.g. a stack
    // trace mentioning `node:fs/promises`), which would wrongly swallow a real
    // failure. session/prompt is intentionally absent — it is fatal, not noise.
    (/method\s+not\s+found/i.test(serialized) &&
      /\b(?:session\/cancel|terminal\/(?:create|output|release|wait_for_exit|kill)|fs\/(?:read_text_file|write_text_file)|_meta\/[a-z_]+)\b/i.test(
        serialized,
      ));
  if (!isMethodNotFound) return false;
  // NEVER suppress a -32601 on the core prompt method: that means the adapter
  // cannot run the task at all, so swallowing it would hang the user with no
  // feedback until the full ACP timeout fires.
  return !/session\/prompt/i.test(serialized);
}

function verifiedUrlCompletionFallback(text: string, verifiedUrls: string[]) {
  const userFacingUrls = publicPreferredUrls(verifiedUrls);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const retained: string[] = [];
  let insideToolOutput = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!insideToolOutput && trimmed.startsWith("[tool output:")) {
      insideToolOutput = true;
      continue;
    }
    if (insideToolOutput && trimmed === "[/tool output]") {
      insideToolOutput = false;
      continue;
    }
    if (!insideToolOutput) retained.push(line);
  }
  const meaningful = retained
    .filter((line) => !line.trim().startsWith("[sub-agent:"))
    .join("\n")
    .trim();
  const header = retained.find((line) => line.trim().startsWith("[sub-agent:"));
  if (meaningful.length > 0) {
    const meaningfulLines = meaningful
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (
      verifiedUrls.length > 0 &&
      meaningfulLines.length > 0 &&
      meaningfulLines.every((line) => /^https?:\/\/\S+$/.test(line)) &&
      meaningfulLines.join("\n") !== userFacingUrls.join("\n")
    ) {
      return [header, ...userFacingUrls].filter(Boolean).join("\n");
    }
    return text;
  }
  return [header, ...userFacingUrls].filter(Boolean).join("\n");
}

function publicPreferredUrls(urls: string[]): string[] {
  const publicUrls = urls.filter((url) => !isLoopbackUrl(url));
  return publicUrls.length > 0 ? publicUrls : urls;
}

interface OriginInfo {
  /** Original user-facing room, e.g. the Discord channel-backed room. */
  roomId: UUID;
  /** Internal task/swarm room minted for sub-agent coordination. */
  taskRoomId: UUID;
  worktreeRoomId?: UUID;
  swarmRooms: SwarmRoomTarget[];
  worldId?: UUID;
  userId?: UUID;
  parentMessageId?: UUID;
  parentConnectorMessageId?: string;
  /** Stable per-request root id for the per-origin spawn cap; present on every
   * transport (connector message id, else the origin user message id). (#8875) */
  spawnRootMessageId?: string;
  label: string;
  source?: string;
}

interface SwarmRoomTarget {
  roomId: UUID;
  roles: string[];
}

function swarmRoomsMetadata(
  rooms: readonly SwarmRoomTarget[],
): Array<Record<string, string | string[]>> {
  return rooms.map((room) => ({
    roomId: room.roomId,
    roles: [...room.roles],
  }));
}

function pickPlainString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

/**
 * The stable per-request root id read from a session's metadata for the
 * per-origin spawn cap (#8875). MUST resolve to the same value that tasks.ts's
 * `spawnRootIdFor` produced when the session was spawned, so the router's
 * `recordOriginResult` and the action's cap enforcement key on the same origin
 * on every transport. Newer spawns persist `spawnRootMessageId`; the fallbacks
 * keep sessions that predate this change (in-flight across a deploy) capped by
 * their stable id too.
 */
export function spawnRootIdFromMeta(
  meta: Record<string, unknown> | undefined,
): string | undefined {
  if (!meta) return undefined;
  return (
    pickPlainString(meta.spawnRootMessageId) ??
    pickPlainString(meta.originConnectorMessageId) ??
    pickUuid(meta.messageId)
  );
}

export function readOrigin(session: SessionInfo): OriginInfo | null {
  const meta = session.metadata as Record<string, unknown> | undefined;
  if (!meta) return null;
  const taskRoomId = pickUuid(meta.taskRoomId) ?? pickUuid(meta.roomId);
  const roomId =
    pickUuid(meta.originRoomId) ?? pickUuid(meta.sourceRoomId) ?? taskRoomId;
  if (!roomId || !taskRoomId) return null;
  const worktreeRoomId = pickUuid(meta.worktreeRoomId);
  const swarmRooms = normalizeSwarmRooms(
    meta.swarmRooms,
    taskRoomId,
    worktreeRoomId,
  );
  return {
    roomId,
    taskRoomId,
    ...(worktreeRoomId ? { worktreeRoomId } : {}),
    swarmRooms,
    worldId: pickUuid(meta.worldId),
    userId: pickUuid(meta.userId),
    parentMessageId: pickUuid(meta.messageId),
    parentConnectorMessageId: pickPlainString(meta.originConnectorMessageId),
    spawnRootMessageId: spawnRootIdFromMeta(meta),
    label: pickLabel(meta) ?? session.name ?? session.id,
    source: typeof meta.source === "string" ? meta.source : undefined,
  };
}

// Stable across respawns: a new session is spawned each cascade iteration
// (new sessionId, new synthetic-inbound messageId), but the origin task's
// room and agent type stay constant. Keyed on those so the respawn cap
// actually accumulates instead of resetting every loop.
function respawnLineageKey(session: SessionInfo, origin: OriginInfo): string {
  const meta = session.metadata as Record<string, unknown> | undefined;
  const initialTask = pickPlainString(meta?.initialTask);
  return JSON.stringify({
    taskRoomId: origin.taskRoomId,
    originTaskId:
      origin.parentConnectorMessageId ??
      origin.parentMessageId ??
      initialTask ??
      origin.label,
    agentType: session.agentType,
  });
}

function completionLineageKey(
  session: SessionInfo,
  origin: OriginInfo,
): string | null {
  const meta = session.metadata as Record<string, unknown> | undefined;
  const initialTask = pickPlainString(meta?.initialTask) ?? "";
  const originTaskId =
    origin.parentConnectorMessageId ?? origin.parentMessageId ?? initialTask;
  if (!originTaskId) return null;
  return JSON.stringify({
    originTaskId,
    agentType: session.agentType,
    initialTask,
  });
}

function sessionTimeMs(value: Date | string | number | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function mayStillProduceContinuation(session: SessionInfo): boolean {
  const status = session.status.toLowerCase();
  return (
    status !== "stopped" &&
    status !== "errored" &&
    status !== "error" &&
    status !== "cancelled"
  );
}

function isNewerContinuationSession(
  candidate: SessionInfo,
  current: SessionInfo,
  currentOrigin: OriginInfo,
  currentCreatedAt: number,
): boolean {
  if (candidate.id === current.id) return false;
  if (candidate.workdir !== current.workdir) return false;
  if (!mayStillProduceContinuation(candidate)) return false;
  if (sessionTimeMs(candidate.createdAt) <= currentCreatedAt) return false;
  const candidateOrigin = readOrigin(candidate);
  if (!candidateOrigin) return false;
  if (candidateOrigin.taskRoomId !== currentOrigin.taskRoomId) return false;
  if (
    currentOrigin.parentConnectorMessageId &&
    candidateOrigin.parentConnectorMessageId
  ) {
    return (
      candidateOrigin.parentConnectorMessageId ===
      currentOrigin.parentConnectorMessageId
    );
  }
  if (currentOrigin.parentMessageId && candidateOrigin.parentMessageId) {
    return candidateOrigin.parentMessageId === currentOrigin.parentMessageId;
  }
  return currentOrigin.label === candidateOrigin.label;
}

function normalizeSwarmRooms(
  value: unknown,
  taskRoomId: UUID,
  worktreeRoomId: UUID | undefined,
): SwarmRoomTarget[] {
  const byRoom = new Map<string, SwarmRoomTarget>();
  const add = (roomId: UUID | undefined, roles: readonly string[]) => {
    if (!roomId) return;
    const current = byRoom.get(roomId) ?? { roomId, roles: [] };
    for (const role of roles) {
      if (role === "task" || role === "worktree" || role === "origin") {
        if (!current.roles.includes(role)) current.roles.push(role);
      }
    }
    byRoom.set(roomId, current);
  };
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const roomId = pickUuid(record.roomId);
      const roles = Array.isArray(record.roles)
        ? record.roles.filter(
            (role): role is string => typeof role === "string",
          )
        : typeof record.role === "string"
          ? [record.role]
          : [];
      add(roomId, roles);
    }
  }
  add(taskRoomId, ["task"]);
  add(worktreeRoomId, ["worktree"]);
  return [...byRoom.values()]
    .map((target) => ({ ...target, roles: sortSwarmRoles(target.roles) }))
    .sort(compareSwarmRooms);
}

function compareSwarmRooms(a: SwarmRoomTarget, b: SwarmRoomTarget): number {
  const roleRank = (target: SwarmRoomTarget) =>
    target.roles.includes("task")
      ? 0
      : target.roles.includes("worktree")
        ? 1
        : 2;
  const rank = roleRank(a) - roleRank(b);
  return rank !== 0 ? rank : a.roomId.localeCompare(b.roomId);
}

function sortSwarmRoles(roles: string[]): string[] {
  return [...roles].sort((a, b) => {
    const aRank = SWARM_ROLE_ORDER.indexOf(
      a as (typeof SWARM_ROLE_ORDER)[number],
    );
    const bRank = SWARM_ROLE_ORDER.indexOf(
      b as (typeof SWARM_ROLE_ORDER)[number],
    );
    return (aRank === -1 ? 99 : aRank) - (bRank === -1 ? 99 : bRank);
  });
}

function routingKindForEvent(
  event: SessionEventName,
  data: unknown,
  capExceeded: boolean,
): string {
  if (capExceeded) return "ROUND_TRIP_CAP_EXCEEDED";
  if (event === QUESTION_FOR_TASK_CREATOR) return QUESTION_FOR_TASK_CREATOR;
  if (event === AGENT_COORDINATION) return AGENT_COORDINATION;
  const rawKind =
    pickPayloadString(data, "routingKind") ??
    pickPayloadString(data, "type") ??
    pickPayloadString(data, "kind") ??
    pickPayloadString(data, "purpose");
  const normalized = rawKind?.trim().toUpperCase();
  if (normalized === QUESTION_FOR_TASK_CREATOR)
    return QUESTION_FOR_TASK_CREATOR;
  if (normalized === AGENT_COORDINATION) return AGENT_COORDINATION;
  const bannerKind = routingKindFromPayloadBanner(data);
  if (bannerKind) return bannerKind;
  if (event === "blocked") return QUESTION_FOR_TASK_CREATOR;
  return "TASK_STATUS";
}

function swarmTargetsForRouting(
  origin: OriginInfo,
  routingKind: string,
): SwarmRoomTarget[] {
  if (routingKind === QUESTION_FOR_TASK_CREATOR) {
    return [targetForRoom(origin, origin.taskRoomId, "task")];
  }
  if (routingKind === AGENT_COORDINATION) {
    const roomId = origin.worktreeRoomId ?? origin.taskRoomId;
    return [
      targetForRoom(
        origin,
        roomId,
        origin.worktreeRoomId ? "worktree" : "task",
      ),
    ];
  }
  return origin.swarmRooms.length > 0
    ? origin.swarmRooms
    : [targetForRoom(origin, origin.taskRoomId, "task")];
}

function targetForRoom(
  origin: OriginInfo,
  roomId: UUID,
  fallbackRole: string,
): SwarmRoomTarget {
  return (
    origin.swarmRooms.find((target) => target.roomId === roomId) ?? {
      roomId,
      roles: [fallbackRole],
    }
  );
}

function pickUuid(v: unknown): UUID | undefined {
  if (typeof v !== "string") return undefined;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  )
    return undefined;
  return v as UUID;
}

function pickLabel(meta: Record<string, unknown>): string | undefined {
  if (typeof meta.label === "string" && meta.label.trim()) return meta.label;
  return undefined;
}

function pickStringSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.filter((v): v is string => typeof v === "string" && v.length > 0),
  );
}

function pickRouteUrlMappings(value: unknown): RouteUrlMapping[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const record = entry as Record<string, unknown>;
      const urlPrefix =
        typeof record.urlPrefix === "string" ? record.urlPrefix.trim() : "";
      const localPath =
        typeof record.localPath === "string" ? record.localPath.trim() : "";
      if (!urlPrefix || !localPath) return undefined;
      return {
        urlPrefix,
        localPath,
        ...(typeof record.requireFresh === "boolean"
          ? { requireFresh: record.requireFresh }
          : {}),
      };
    })
    .filter((entry): entry is RouteUrlMapping => entry !== undefined);
}

function routeVerificationForSession(
  session: SessionInfo,
): RouteUrlVerification | undefined {
  const route =
    session.metadata?.workdirRoute &&
    typeof session.metadata.workdirRoute === "object"
      ? (session.metadata.workdirRoute as Record<string, unknown>)
      : undefined;
  const mappings = pickRouteUrlMappings(route?.urlMappings);
  if (mappings.length === 0) return undefined;
  const createdAt =
    session.createdAt instanceof Date
      ? session.createdAt.getTime()
      : new Date(session.createdAt).getTime();
  return {
    workdir: session.workdir,
    sessionStartedAtMs: Number.isFinite(createdAt) ? createdAt : Date.now(),
    mappings,
  };
}

function expandRouteUrlAliases(
  urls: readonly string[],
  routeVerification: RouteUrlVerification | undefined,
): string[] {
  if (!routeVerification) return [...urls];
  const expanded = new Set(urls);
  for (const url of urls) {
    const relativePath = routeRelativePathForUrl(
      url,
      routeVerification.mappings,
    );
    if (!relativePath) continue;
    for (const mapping of routeVerification.mappings) {
      const alias = urlForRouteMapping(mapping, relativePath);
      if (alias) expanded.add(alias);
    }
  }
  return [...expanded];
}

function routeRelativePathForUrl(
  url: string,
  mappings: readonly RouteUrlMapping[],
): string | undefined {
  return routeMatchForUrl(url, mappings)?.relativePath;
}

// A bare route-mapping prefix (the collection root, e.g. `https://host/apps/`)
// is the route's own URL-namespace documentation stem — `taskWithResolvedRoute`
// writes it verbatim into the spawn task's `--- URL Path Mapping ---` hint, and
// that hint is also the `verificationReferenceText`. The `<slug>` template form
// (`.../apps/<slug>/`) is already skipped by `collectVerifiableUrlCandidates`,
// but the bare-prefix form ("URL prefix https://host/apps/ maps to …") is not,
// so it leaks into the verify list, probes 200 (the index page exists), and gets
// surfaced as a "verified deliverable" — clobbering the sub-agent's real answer
// for a non-build info-fetch (e.g. a price). It is never a built page: a real
// app build claims `.../apps/<slug>/`, which has a path BEYOND the prefix and is
// unaffected. Structural — keys on the configured `urlMappings[].urlPrefix`, not
// on prose.
function isBareRouteMappingPrefix(
  url: string,
  mappings: readonly RouteUrlMapping[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const urlPath = parsed.pathname.endsWith("/")
    ? parsed.pathname
    : `${parsed.pathname}/`;
  return mappings.some((mapping) => {
    let prefix: URL;
    try {
      prefix = new URL(mapping.urlPrefix);
    } catch {
      return false;
    }
    if (parsed.origin !== prefix.origin) return false;
    const prefixPath = prefix.pathname.endsWith("/")
      ? prefix.pathname
      : `${prefix.pathname}/`;
    return urlPath === prefixPath && parsed.search === "" && parsed.hash === "";
  });
}

function routeMatchForUrl(
  url: string,
  mappings: readonly RouteUrlMapping[],
): { mapping: RouteUrlMapping; relativePath: string } | undefined {
  for (const mapping of mappings) {
    let parsed: URL;
    let prefix: URL;
    try {
      parsed = new URL(url);
      prefix = new URL(mapping.urlPrefix);
    } catch {
      continue;
    }
    if (parsed.origin !== prefix.origin) continue;
    const prefixPath = prefix.pathname.endsWith("/")
      ? prefix.pathname
      : `${prefix.pathname}/`;
    if (!parsed.pathname.startsWith(prefixPath)) continue;
    const relativePath = parsed.pathname.slice(prefixPath.length);
    if (relativePath) return { mapping, relativePath };
  }
  return undefined;
}

function urlForRouteMapping(
  mapping: RouteUrlMapping,
  relativePath: string,
): string | undefined {
  try {
    const prefix = mapping.urlPrefix.endsWith("/")
      ? mapping.urlPrefix
      : `${mapping.urlPrefix}/`;
    return new URL(relativePath, prefix).toString();
  } catch {
    return undefined;
  }
}

function mergeCachedStaleMissUrls(
  prior: Set<string>,
  dead: DeadUrl[],
): Set<string> {
  const merged = new Set(prior);
  for (const entry of dead) {
    if (entry.status.includes("cached stale miss")) {
      merged.add(entry.url);
    }
  }
  return merged;
}

function pickPayloadString(data: unknown, key: string): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const v = (data as Record<string, unknown>)[key];
  if (typeof v !== "string" || !v.trim()) return undefined;
  return v;
}

// Map the ACP `session/prompt` stopReason to a normalized LLM finish reason for
// the completion evaluator. `max_tokens` / `max_turn_requests` mean the model
// ran out of token / turn budget mid-answer (truncated); `refusal` is a
// content-filter block. Both are DEGENERATE: the completion is partial, and the
// planner re-issuing the SAME root request just truncates / blocks again — the
// ~70x weak-model re-spawn loop (issue elizaOS/eliza#8875). Every other
// stopReason (`end_turn`, `cancelled`, `exit`, `stopped`, `error`, …) is a clean
// stop and keeps the existing routing (returns undefined → no signal).
function normalizeFinishReason(
  stopReason: string | undefined,
): "length" | "content_filter" | undefined {
  if (!stopReason) return undefined;
  switch (stopReason.toLowerCase()) {
    case "max_tokens":
    case "max_turn_requests":
    case "length":
      return "length";
    case "refusal":
    case "content_filter":
      return "content_filter";
    default:
      return undefined;
  }
}

function stripToolTranscript(text: string): string {
  // Remove the orchestrator's OWN captured tool-output envelope blocks
  // ("[tool output: <title>]\n<output>\n[/tool output]", emitted by
  // captureTerminalToolOutput in acp-service). These are our structured
  // markers, not model prose, so dropping them keeps raw tool results from
  // leaking into the user-facing completion narration — distinct from
  // matching semantic LLM output, which we do not do.
  return text
    .replace(/\[tool output:[^\]]*\][\s\S]*?\[\/tool output\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Maximum size of a captured tool-output block we will relay verbatim. Above
// this, the deliverable is a multi-KB transcript and stays on the
// model-rendered (summarized) path rather than being dumped to the user.
const MAX_VERBATIM_DELIVERABLE_BYTES = 2048;

// Recover the deliverable when it is the sub-agent's printed/tool output and
// composeNarration→stripToolTranscript has deleted it. Extracts the inner body
// of the FIRST `[tool output: …] … [/tool output]` block from the RAW response
// (the same envelope captureTerminalToolOutput emits). Returns it only when it
// is a single short block (≤2KB); multi-block or multi-KB transcripts return
// undefined so they stay on the summarized path.
export function extractShortToolDeliverable(data: unknown): string | undefined {
  const response =
    pickPayloadString(data, "response") ?? pickPayloadString(data, "finalText");
  if (!response) return undefined;
  const blocks = response.match(
    /\[tool output:[^\]]*\]([\s\S]*?)\[\/tool output\]/g,
  );
  if (!blocks?.length) return undefined;
  // Multi-step tool use is normal — a failed attempt then a retry (`python`
  // not found, then `python3`), or write-a-file then run-it. The LAST
  // non-empty block is the sub-agent's final result, so surface it verbatim:
  // a weak coding model routinely truncates that result in its own prose
  // (relays "479" for a captured "479001600"), and the ground-truth tool
  // output must win over the paraphrase. A block over the size cap is a
  // transcript dump, not a deliverable — fall back to the summarized path.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const inner = blocks[i]
      .replace(/^\[tool output:[^\]]*\]/, "")
      .replace(/\[\/tool output\]$/, "")
      .trim();
    if (!inner) continue;
    return Buffer.byteLength(inner, "utf8") > MAX_VERBATIM_DELIVERABLE_BYTES
      ? undefined
      : inner;
  }
  return undefined;
}

function composeNarration(
  event: SessionEventName,
  label: string,
  session: SessionInfo,
  data: unknown,
  changeSet?: WorkspaceChangeSet,
  artifactVerification?: WorkspaceArtifactVerification,
): string {
  // For task_complete the LABEL is the original (often imperative) task text —
  // e.g. "Use the webfetch tool on this exact URL: …". A literal planner reads
  // that leading imperative as a fresh instruction and re-spawns the SAME task
  // whose completion triggered this turn, looping (observed live: the claude
  // backend spawned 6 sessions for one BTC price and never relayed the answer
  // that each sub-agent had already returned). The directive below is INSIDE
  // the bracketed header, so every `[sub-agent:`-prefix stripper (user-facing
  // reply, deliverable extraction) still removes it — only the planner sees it.
  const meta = session.metadata as Record<string, unknown> | undefined;
  const requestedType = pickPlainString(meta?.requestedType);
  const agentTypeNote =
    event === "task_complete" &&
    requestedType &&
    requestedType !== session.agentType
      ? ` Requested agent type was ${requestedType}; actual agent type was ${session.agentType}.`
      : "";
  const header =
    event === "task_complete"
      ? `[sub-agent: ${label} (${session.agentType}) — task_complete — this delegated task is DONE; the result is below, relay it to the user as the answer, state the actual workdir (${session.workdir}), do NOT substitute or repeat a requested path unless it matches the actual workdir, and do NOT start another sub-agent for it.${agentTypeNote}]`
      : `[sub-agent: ${label} (${session.agentType}) — ${event}]`;
  if (event === QUESTION_FOR_TASK_CREATOR) {
    const message =
      pickPayloadString(data, "question") ??
      pickPayloadString(data, "message") ??
      pickPayloadString(data, "prompt") ??
      "sub-agent has a question for the task creator";
    return `${header}\n${stripRoutingKindBanner(message)}`;
  }
  if (event === AGENT_COORDINATION) {
    const message =
      pickPayloadString(data, "message") ??
      pickPayloadString(data, "coordination") ??
      pickPayloadString(data, "prompt") ??
      "sub-agent posted a coordination update";
    return `${header}\n${stripRoutingKindBanner(message)}`;
  }
  if (event === "error") {
    const message =
      pickPayloadString(data, "message") ?? "sub-agent reported an error";
    return `${header}\n${stripRoutingKindBanner(message)}`;
  }
  if (event === "blocked") {
    const message =
      pickPayloadString(data, "message") ??
      pickPayloadString(data, "prompt") ??
      "sub-agent is blocked and waiting for input";
    return `${header}\n${stripRoutingKindBanner(message)}`;
  }
  const response =
    pickPayloadString(data, "response") ?? pickPayloadString(data, "finalText");
  if (changeSet) {
    // Build the completion narration from the real git change set, not the
    // sub-agent's raw step transcript. For weak coding models that transcript
    // is a dump of tool plans + tool outputs that (a) leaked verbatim to the
    // user and (b) read as pending work to the planner, driving respawns.
    // Preserve any deployed URL the sub-agent claimed so the downstream
    // reachability verification still runs.
    const urls = collectVerifiableUrlCandidates(response ?? "");
    // A file write must not swallow the answer the user asked for: when the
    // sub-agent captured a concrete deliverable (e.g. a script's stdout for a
    // "run it and report the output" task), surface it ABOVE the change
    // summary. This is the typed `[tool output: …]` envelope, not the raw
    // transcript, so the leak/respawn problems the diff-summary path solved
    // stay solved.
    const capturedDeliverable = extractShortToolDeliverable(data);
    // Only surface a disk-verification LINE when it carries a real signal —
    // i.e. a claimed changed file was MISSING at completion. A clean, verified
    // change set stays silent here: `summarizeChangeSet(..., verification)`
    // already appends a `(verified on disk)` suffix, and adding a separate
    // "verified" body line would pollute the completion body that downstream
    // consumers (notification preview, verified-URL fallback, the completion
    // evaluator's reply) read from, regressing existing narration tests. The
    // authoritative workdir + requested-vs-actual-agent note lives in the
    // planner-only header (stripped by every `[sub-agent:`-prefix reader), so
    // it never leaks into the user-facing body.
    const missing = artifactVerification?.missingFiles ?? [];
    const unverifiedLine =
      artifactVerification &&
      !artifactVerification.verified &&
      missing.length > 0
        ? `Artifact verification: UNVERIFIED at completion; missing ${missing.join(", ")}.`
        : undefined;
    const lines = [
      ...(capturedDeliverable ? [capturedDeliverable] : []),
      summarizeChangeSet(changeSet, artifactVerification),
      unverifiedLine,
      changeSet.diffStat,
      ...urls,
    ].filter((line) => typeof line === "string" && line.trim().length > 0);
    return `${header}\n${lines.join("\n")}`;
  }
  // Genuinely no captured output — keep the explicit note. The workdir lives
  // in the planner-only header, not the body.
  if (response === undefined) {
    return `${header}\nsub-agent reports task complete (no captured output).`;
  }
  // A verification-retry attempt (re-dispatched by retryIncompleteBuild) that
  // produced no change set: never narrate its raw step prose. On weak coding
  // models that prose is tool-loop reasoning ("I need to call read properly.
  // Seems stuck. Let's retry.") that leaks verbatim to the user and reads as
  // pending work to the planner. Surface only the public URL(s) it claimed
  // (loopback dropped, verified downstream); a genuine failure is covered by
  // the separate build-incomplete report.
  const retryCount = (session.metadata as Record<string, unknown> | undefined)
    ?.buildVerifyRetryCount;
  if (typeof retryCount === "number" && retryCount > 0) {
    const urls = collectVerifiableUrlCandidates(response).filter(
      (url) => !isLoopbackUrl(url),
    );
    return urls.length > 0 ? `${header}\n${urls.join("\n")}` : header;
  }
  // Non-retry completion: keep the (transcript-stripped, banner-stripped) prose
  // so legitimate results ("PR opened: …", a question) still reach the user.
  const cleaned = stripToolTranscript(response);
  if (!cleaned) return header;
  return `${header}\n${stripRoutingKindBanner(cleaned)}`;
}

function stripRoutingKindBanner(text: string): string {
  return text
    .replace(
      /^(?:\s*(?:#{1,6}\s*)?(?:\*\*)?(?:QUESTION_FOR_TASK_CREATOR|AGENT_COORDINATION)(?:\*\*)?\s*(?::|-)?\s*(?:\r?\n|$))+/u,
      "",
    )
    .trimStart();
}

// Flatten a disk-verification result into a JSON-safe metadata shape so it
// satisfies the Content metadata index signature (a plain object of
// JsonValue-compatible fields, no optional-undefined members).
function artifactVerificationMetadata(
  verification: WorkspaceArtifactVerification,
): Record<string, unknown> {
  return {
    workdir: verification.workdir,
    verified: verification.verified,
    missingFiles: [...verification.missingFiles],
    files: verification.files.map((file) => ({
      path: file.path,
      absolutePath: file.absolutePath,
      exists: file.exists,
      ...(typeof file.sizeBytes === "number"
        ? { sizeBytes: file.sizeBytes }
        : {}),
      ...(file.kind ? { kind: file.kind } : {}),
      ...(file.error ? { error: file.error } : {}),
    })),
  };
}

// Drop the leading planner-only `[sub-agent: …]` directive line so a preview or
// body reader sees the actual result, not the relay/do-not-respawn header.
// Mirrors the evaluator's `stripRouterAnnotations` header handling; kept local
// so the router has no cross-module import for a one-line string op.
function stripSubAgentHeaderLine(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return (lines[0]?.startsWith("[sub-agent:") ? lines.slice(1) : lines)
    .join("\n")
    .trim();
}

function routingKindFromPayloadBanner(data: unknown): string | undefined {
  for (const key of [
    "response",
    "finalText",
    "message",
    "question",
    "coordination",
    "prompt",
  ]) {
    const value = pickPayloadString(data, key);
    const match = value?.match(
      /^\s*(?:#{1,6}\s*)?(?:\*\*)?(QUESTION_FOR_TASK_CREATOR|AGENT_COORDINATION)(?:\*\*)?\b/u,
    );
    if (match?.[1] === QUESTION_FOR_TASK_CREATOR)
      return QUESTION_FOR_TASK_CREATOR;
    if (match?.[1] === AGENT_COORDINATION) return AGENT_COORDINATION;
  }
  return undefined;
}

/**
 * GET-check every http(s) URL a sub-agent claimed in its completion text —
 * and, for any that return HTML, follow the page's own declared
 * sub-resources (`<link href>` / `<script src>`) and check those too.
 * The sub-agent's claim ("the app is live at X") is treated as a
 * hypothesis, not a fact — the parent agent should see ground truth.
 *
 * Why follow sub-resources: a weak coding model routinely writes the
 * entry `index.html` but drops the `style.css` / `app.js` it references.
 * The index URL then returns 200 while the app is visibly broken — only
 * probing the mentioned URL would pass it as "live". Following the page's
 * declared dependencies catches the partial build.
 *
 * Conservative by design:
 *  - only runs on `task_complete` text (not errors/blocked)
 *  - caps at the first 5 distinct mentioned URLs + their sub-resources
 *  - 4s per-request timeout, failures (DNS, timeout, refused) count as
 *    unverified rather than throwing
 *  - one short settle-retry before declaring a URL dead, covering a
 *    transient network blip on the checker side
 *  - never strips the original text — it only appends an annotation, so a
 *    transient network blip on the checker side degrades to "couldn't
 *    verify" rather than hiding a real success
 *
 * Callers should pass text that has already been through
 * {@link normalizeUrlsInText} so Unicode-dash-corrupted URLs are probed in
 * their intended form.
 */
export async function annotateUnverifiedUrls(
  text: string,
  log?: (message: string) => void,
  referenceText?: string,
  ignoredUrls?: ReadonlySet<string>,
  runtime?: IAgentRuntime,
  routeVerification?: RouteUrlVerification,
): Promise<{ text: string; dead: DeadUrl[]; verifiedUrls: string[] }> {
  if (!shouldVerifyCompletionUrls(text, referenceText, routeVerification)) {
    return { text, dead: [], verifiedUrls: [] };
  }
  const urls = expandRouteUrlAliases(
    extractVerifiableUrls(text, 5, referenceText, ignoredUrls),
    routeVerification,
  ).filter(
    (url) =>
      routeVerification === undefined ||
      !isBareRouteMappingPrefix(url, routeVerification.mappings),
  );
  if (urls.length === 0) return { text, dead: [], verifiedUrls: [] };
  log?.(
    `[verify] start @ ${new Date().toISOString()} — ${urls.length} url(s): ${urls.join(", ")}`,
  );
  // GET-probe a URL with a 4s timeout. On a 2xx HTML response also returns
  // the body so the caller can follow the page's sub-resources. (GET, not
  // HEAD: we need the body for HTML, and many static hosts reject HEAD.)
  const probeOnce = async (
    url: string,
  ): Promise<{ status: string | null; html?: string; servedLive: boolean }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      // SSRF guard: the URL comes from untrusted sub-agent narration. Resolve
      // and reject non-public (private/link-local/metadata) hosts, and follow
      // redirects manually so a public page can't 302 us into an internal
      // endpoint. Loopback is allowed — local build verification depends on it.
      const res = await safeFetch(url, {
        method: "GET",
        signal: controller.signal,
      });
      // 405/501 mean the server IS reachable — it just won't serve a GET.
      // Sub-agents routinely dump raw HTTP headers into their narration
      // (a `curl -i`), and those headers carry incidental URLs — CDN
      // telemetry endpoints (`report-to`/NEL), POST-only APIs — that 405 a
      // GET. For a liveness check that URL exists, so it is NOT dead;
      // flagging it would trigger a pointless retry of a build that
      // actually succeeded.
      if (res.status === 405 || res.status === 501) {
        log?.(
          `[verify] probe ${url} → HTTP ${res.status} (reachable; GET not allowed) @ ${new Date().toISOString()}`,
        );
        return { status: null, servedLive: false };
      }
      if (res.status < 200 || res.status >= 300) {
        const cachedMiss = await detectCachedMiss(url, res, controller.signal);
        if (cachedMiss) {
          log?.(
            `[verify] probe ${url} → HTTP ${res.status} (cached stale miss; cache-busting probe returned ${cachedMiss.status}) @ ${new Date().toISOString()}`,
          );
          return {
            status: `HTTP ${res.status} (cached stale miss; cache-busting probe returned ${cachedMiss.status})`,
            servedLive: false,
          };
        }
        log?.(
          `[verify] probe ${url} → HTTP ${res.status} @ ${new Date().toISOString()}`,
        );
        return { status: `HTTP ${res.status}`, servedLive: false };
      }
      const contentType = res.headers.get("content-type") ?? "";
      log?.(
        `[verify] probe ${url} → ${res.status} (${contentType.split(";")[0] || "?"}) @ ${new Date().toISOString()}`,
      );
      if (contentType.includes("text/html")) {
        return { status: null, html: await res.text(), servedLive: true };
      }
      return { status: null, servedLive: true };
    } catch (err) {
      // A blocked non-public host is not a reachable artifact; report it as
      // such (it must never be surfaced to the user as "live").
      const reason =
        err instanceof SsrfBlockedError
          ? "blocked (non-public host)"
          : err instanceof Error
            ? err.name
            : "unreachable";
      log?.(`[verify] probe ${url} → ${reason} @ ${new Date().toISOString()}`);
      return { status: reason, servedLive: false };
    } finally {
      clearTimeout(timer);
    }
  };
  // One short settle-retry. `task_complete` fires after the sub-agent's
  // file writes have landed (verified against real timelines), and the
  // static host serves from disk with no cache lag — so a single retry is
  // only there to ride out a transient network blip on the checker side,
  // not a write→serve race. Tunable via ELIZA_URL_VERIFY_SETTLE_MS
  // (default 2500ms); 0 disables the retry (single probe).
  const settleRaw = runtime
    ? readSetting(runtime, "ELIZA_URL_VERIFY_SETTLE_MS")
    : process.env.ELIZA_URL_VERIFY_SETTLE_MS;
  const settleParsed = settleRaw ? Number.parseInt(settleRaw, 10) : 2500;
  const settleMs =
    Number.isFinite(settleParsed) && settleParsed >= 0 ? settleParsed : 2500;
  const probe = async (
    url: string,
  ): Promise<{ status: string | null; html?: string; servedLive: boolean }> => {
    let result = await probeOnce(url);
    if (result.status !== null && settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      result = await probeOnce(url);
    }
    return result;
  };
  const dead: DeadUrl[] = [];
  await Promise.all(
    urls.map(async (url) => {
      const result = await probe(url);
      if (result.status !== null) {
        dead.push({ url, status: result.status });
        return;
      }
      const localStatus = verifyMappedLocalUrl(
        url,
        routeVerification,
        result.servedLive,
      );
      if (localStatus) {
        dead.push({ url, status: localStatus });
        return;
      }
      // Follow the page's own declared dependencies — a 200 index.html
      // that <link>s a missing style.css is still a broken app.
      if (result.html) {
        const subResources = extractSubResources(result.html, url);
        await Promise.all(
          subResources.map(async (subUrl) => {
            const subResult = await probe(subUrl);
            if (subResult.status !== null) {
              dead.push({ url: subUrl, status: subResult.status, via: url });
              return;
            }
            const subLocalStatus = verifyMappedLocalUrl(
              subUrl,
              routeVerification,
              subResult.servedLive,
            );
            if (subLocalStatus) {
              dead.push({ url: subUrl, status: subLocalStatus, via: url });
            }
          }),
        );
      }
    }),
  );
  log?.(
    `[verify] done @ ${new Date().toISOString()} — ${dead.length} dead of ${urls.length} mentioned`,
  );
  if (dead.length === 0) {
    return {
      text,
      dead,
      verifiedUrls: canonicalUserFacingVerifiedUrls(urls, routeVerification),
    };
  }
  const lines = dead
    .map((d) =>
      d.via
        ? `  - ${d.url} → ${d.status} (referenced by ${d.via})`
        : `  - ${d.url} → ${d.status}`,
    )
    .join("\n");
  return {
    text: `${text}\n\n[verification: the following URL(s) the sub-agent referenced are NOT reachable — do NOT tell the user the app is live; report the real status and that the build likely did not complete]\n${lines}`,
    dead,
    verifiedUrls: canonicalUserFacingVerifiedUrls(
      urls.filter(
        (url) => !dead.some((entry) => entry.url === url || entry.via === url),
      ),
      routeVerification,
    ),
  };
}

// A reachable URL is only a user-facing *deliverable* when it is a routed
// hosted-artifact PAGE — a route-mapped page (or a bare `/apps/<slug>/` page
// when no route map is configured). Data-source URLs the task told the sub-agent
// to fetch (e.g. a CoinGecko price endpoint) and any other incidental URL are
// inputs/mentions, not deliverables: probing them 200 must never promote them to
// the reply that the completion evaluator surfaces. Without this gate, a
// non-build info-fetch turn ("what's BTC worth?") had its real answer ("$64,223")
// clobbered by the input data-source (or route-prefix) URL. Bare route-mapping
// prefixes are excluded too — they are the route's documentation stem, not a
// built page. Structural: keys on route-mapping shape + the `/apps/<slug>/`
// page shape, never on prose.
function isVerifiedDeliverableUrl(
  url: string,
  routeVerification: RouteUrlVerification | undefined,
): boolean {
  if (
    routeVerification &&
    isBareRouteMappingPrefix(url, routeVerification.mappings)
  ) {
    return false;
  }
  return isRoutedArtifactUrl(url, routeVerification);
}

function canonicalUserFacingVerifiedUrls(
  urls: string[],
  routeVerification: RouteUrlVerification | undefined,
): string[] {
  const deliverables = urls.filter((url) =>
    isVerifiedDeliverableUrl(url, routeVerification),
  );
  if (!routeVerification) return deliverables;
  const canonical = new Set<string>();
  for (const url of deliverables) {
    const pageAliases = routePageAliasesForUrl(url, routeVerification);
    if (pageAliases.length > 0) {
      for (const alias of pageAliases) canonical.add(alias);
    } else {
      canonical.add(url);
    }
  }
  return publicPreferredUrls([...canonical]);
}

function routePageAliasesForUrl(
  url: string,
  routeVerification: RouteUrlVerification,
): string[] {
  const match = routeMatchForUrl(url, routeVerification.mappings);
  if (!match) return [];
  const relativePath = decodeURIComponent(match.relativePath);
  const directory = pageDirectoryForRelativePath(relativePath);
  if (!directory) return [];
  const representative = urlForRouteMapping(match.mapping, directory);
  if (!representative) return [];
  if (verifyMappedLocalUrl(representative, routeVerification)) return [];
  return routeVerification.mappings
    .map((mapping) => urlForRouteMapping(mapping, directory))
    .filter((alias): alias is string => Boolean(alias));
}

function pageDirectoryForRelativePath(
  relativePath: string,
): string | undefined {
  const normalized = relativePath.replace(/^\/+/, "");
  if (!normalized) return undefined;
  if (normalized.endsWith("/")) return normalized;
  const base = path.posix.basename(normalized);
  if (!base) return undefined;
  if (!base.includes(".")) return `${normalized}/`;
  const dir = path.posix.dirname(normalized);
  if (!dir || dir === ".") return undefined;
  if (base.toLowerCase() === "index.html") return `${dir}/`;
  const ext = path.posix.extname(base).toLowerCase();
  if (!ext || ext === ".html") return undefined;
  return `${dir}/`;
}

function verifyMappedLocalUrl(
  url: string,
  routeVerification: RouteUrlVerification | undefined,
  servedLive = false,
): string | undefined {
  if (!routeVerification) return undefined;
  for (const mapping of routeVerification.mappings) {
    const localTarget = mappedLocalTarget(
      url,
      routeVerification.workdir,
      mapping,
    );
    if (!localTarget) continue;
    return verifyLocalTarget(
      localTarget,
      routeVerification.sessionStartedAtMs,
      mapping.requireFresh !== false,
      servedLive,
    );
  }
  return undefined;
}

function mappedLocalTarget(
  url: string,
  workdir: string,
  mapping: RouteUrlMapping,
): string | undefined {
  let parsed: URL;
  let prefix: URL;
  try {
    parsed = new URL(url);
    prefix = new URL(mapping.urlPrefix);
  } catch {
    return undefined;
  }
  if (parsed.origin !== prefix.origin) return undefined;
  const prefixPath = prefix.pathname.endsWith("/")
    ? prefix.pathname
    : `${prefix.pathname}/`;
  if (!parsed.pathname.startsWith(prefixPath)) return undefined;
  const relativePath = decodeURIComponent(
    parsed.pathname.slice(prefixPath.length),
  );
  if (!relativePath) return undefined;
  const localRoot = path.resolve(workdir, mapping.localPath);
  const target = path.resolve(localRoot, relativePath);
  if (target !== localRoot && !target.startsWith(`${localRoot}${path.sep}`)) {
    return undefined;
  }
  return target;
}

function verifyLocalTarget(
  target: string,
  sessionStartedAtMs: number,
  requireFresh: boolean,
  servedLive = false,
): string | undefined {
  const file = localFileForTarget(target);
  if (!file) {
    return `mapped local target missing or empty: ${path.relative(process.cwd(), target)}`;
  }
  const stat = fs.statSync(file);
  if (stat.size <= 0) {
    return `mapped local target missing or empty: ${path.relative(process.cwd(), file)}`;
  }
  // A live HTTP 200 is authoritative for a served URL: the artifact exists,
  // is non-empty, and is actually being served right now. Deploy steps that
  // copy a build into place preserve the source file's mtime, so the
  // wall-clock freshness comparison false-positives on a healthy app whose
  // files predate the session. Only fall back to the mtime gate when the URL
  // is NOT confirmed served — there the file is the only liveness signal.
  if (requireFresh && !servedLive && stat.mtimeMs < sessionStartedAtMs - 5000) {
    return `mapped local target was not updated during this session: ${path.relative(process.cwd(), file)}`;
  }
  return undefined;
}

function localFileForTarget(target: string): string | undefined {
  if (!fs.existsSync(target)) return undefined;
  const stat = fs.statSync(target);
  if (stat.isFile()) return target;
  if (!stat.isDirectory()) return undefined;
  const indexFile = path.join(target, "index.html");
  return fs.existsSync(indexFile) && fs.statSync(indexFile).isFile()
    ? indexFile
    : undefined;
}

async function detectCachedMiss(
  url: string,
  res: Response,
  signal: AbortSignal,
): Promise<{ status: number } | null> {
  if (res.status !== 404) return null;
  let busted: URL;
  try {
    busted = new URL(url);
  } catch {
    return null;
  }
  // Some static hosts/CDNs serve a stale cached 404 without useful cache
  // headers. A same-URL cache-bust probe distinguishes that case from a real
  // missing file without treating arbitrary non-404 failures as cache issues.
  busted.searchParams.set("__eliza_verify", Date.now().toString(36));
  // Same SSRF guard as the primary probe: the host is unchanged from the
  // already-validated URL, but route through safeFetch so a redirect on the
  // cache-bust probe can't reach an internal host either.
  const bustedRes = await safeFetch(busted.toString(), {
    method: "GET",
    signal,
  }).catch(() => null);
  if (!bustedRes) return null;
  return bustedRes.status >= 200 && bustedRes.status < 300
    ? { status: bustedRes.status }
    : null;
}

/**
 * Extract the sub-resource URLs an HTML document declares via common
 * resource-bearing attributes, resolved absolute against the page URL.
 * Mechanical extraction from a structured document — not intent
 * classification. Skips in-page anchors and data:/mailto: refs, and caps
 * the result so a pathological page can't fan out unbounded probes.
 */
export function extractSubResources(html: string, pageUrl: string): string[] {
  const refs = new Set<string>();
  const attrRe =
    /<(?:link|script|img|source|video|audio|iframe)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  const srcsetRe = /<(?:img|source)\b[^>]*?\bsrcset\s*=\s*["']([^"']+)["']/gi;
  const addRef = (rawRef: string | undefined) => {
    const ref = rawRef?.trim();
    if (
      !ref ||
      ref.startsWith("#") ||
      ref.startsWith("data:") ||
      ref.startsWith("mailto:")
    ) {
      return;
    }
    try {
      const resolved = new URL(ref, pageUrl);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        refs.add(resolved.toString());
      }
    } catch {
      // unparseable ref — skip
    }
  };
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((match = attrRe.exec(html)) !== null) {
    addRef(match[1]);
    if (refs.size >= 10) break;
  }
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while (refs.size < 10 && (match = srcsetRe.exec(html)) !== null) {
    for (const candidate of (match[1] ?? "").split(",")) {
      addRef(candidate.trim().split(/\s+/)[0]);
      if (refs.size >= 10) break;
    }
  }
  return [...refs];
}

/**
 * Normalize http(s) URLs embedded in free text: replace Unicode look-alike
 * dashes (non-breaking hyphen, en/em dash, …) with an ASCII hyphen. Weak
 * coding models emit these inside URLs, which makes the link 404 even
 * though the target exists under the ASCII-hyphen name — broken for both
 * the verification probe and the user clicking it. Only dash characters
 * inside a URL are touched; surrounding prose (where an em dash is
 * legitimate punctuation) is left untouched.
 */
export function normalizeUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT_RE, (url) =>
    url.replace(UNICODE_DASHES_RE, "-"),
  );
}

function computeDedupKey(
  sessionId: string,
  event: SessionEventName,
  session: SessionInfo,
  data: unknown,
): string {
  const fingerprint =
    pickPayloadString(data, "response") ??
    pickPayloadString(data, "finalText") ??
    pickPayloadString(data, "message") ??
    "";
  return `${sessionId}|${event}|${session.status}|${shortHash(fingerprint)}`;
}

function shortHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function pruneDelivered(set: Set<string>, max: number): void {
  if (set.size <= max) return;
  const it = set.values();
  for (let i = 0; i < set.size - max; i++) {
    const next = it.next();
    if (next.done) break;
    set.delete(next.value);
  }
}

// Cap for the per-session parent-agent tracking collections (buffers, dispatch
// counts, verify-retry handoffs). Far above any realistic concurrent-session
// count; it exists only to stop unbounded growth over a long uptime.
const PARENT_AGENT_TRACKING_CAP = 256;

/**
 * Evict the oldest entries from a Map or Set (insertion-ordered) so it never
 * exceeds `max`. Collects the doomed keys first, then deletes, so it prunes the
 * exact excess in one pass (unlike the older size-mutating loop in
 * {@link pruneDelivered}).
 */
export function pruneOldestTracked(
  collection: {
    size: number;
    keys(): IterableIterator<string>;
    delete(key: string): unknown;
  },
  max: number,
): void {
  const excess = collection.size - max;
  if (excess <= 0) return;
  const doomed: string[] = [];
  let seen = 0;
  for (const key of collection.keys()) {
    if (seen++ >= excess) break;
    doomed.push(key);
  }
  for (const key of doomed) collection.delete(key);
}

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const get = (runtime as { getSetting?: (k: string) => string | undefined })
    .getSetting;
  if (typeof get === "function") {
    const v = get.call(runtime, key);
    if (typeof v === "string" && v.length > 0) return v;
  }
  const env = process.env[key];
  return typeof env === "string" && env.length > 0 ? env : undefined;
}

/**
 * Deterministic UUIDv5-like derivation from a string. Same input → same
 * UUID. Local replacement for `createUniqueUuid` from @elizaos/core so
 * this service stays type-only on core (no runtime dist dependency).
 */
function deriveUuidFromString(input: string): UUID {
  const digest = createHash("sha1").update(input).digest("hex");
  const bytes = digest.slice(0, 32).split("");
  // Set version (5) and variant bits per RFC 4122.
  bytes[12] = "5";
  bytes[16] = ((parseInt(bytes[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const hex = bytes.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` as UUID;
}
