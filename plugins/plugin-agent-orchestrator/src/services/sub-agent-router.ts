import { createHash, randomUUID } from "node:crypto";
import type {
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import type { AcpService } from "./acp-service.js";
import type {
  SessionEventName,
  SessionInfo,
  SpawnOptions,
  SpawnResult,
} from "./types.js";

const ACPX_ROUTER_SOURCE = "sub_agent";
const SUB_AGENT_ENTITY_NAMESPACE = "acpx:sub-agent";
const DEFAULT_ROUND_TRIP_CAP = 32;

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

function collectVerifiableUrlCandidates(
  text: string,
  ignoredUrls?: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const match of text.matchAll(URL_IN_TEXT_RE)) {
    const raw = match[0];
    const index = match.index ?? -1;
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
  const candidates = collectVerifiableUrlCandidates(text, ignoredUrls);
  const filtered = candidates.filter((url) => {
    const prefix = url.endsWith("/") ? url : `${url}/`;
    return !candidates.some(
      (other) => other !== url && other.startsWith(prefix),
    );
  });
  const referenceUrls = referenceText
    ? new Set(collectVerifiableUrlCandidates(referenceText))
    : undefined;
  const routeFocused = referenceUrls?.size
    ? filterToReferencedAppRoute(filtered, referenceUrls)
    : filtered;
  const aliasFiltered = referenceUrls?.size
    ? filterModelIntroducedUrlAliases(routeFocused, referenceUrls)
    : routeFocused;
  return aliasFiltered.slice(0, limit);
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
export class SubAgentRouter {
  static serviceType = "ACPX_SUB_AGENT_ROUTER";
  static dependencies = ["ACP_SUBPROCESS_SERVICE", "PTY_SERVICE"];

  capabilityDescription =
    "Routes ACPX sub-agent terminal events back into the runtime as inbound messages so the main agent decides reply-to-user vs reply-to-agent vs both.";

  private readonly runtime: IAgentRuntime;
  private acp: AcpService | null = null;
  private unsubscribe: (() => void) | undefined;
  private unsubscribePty: (() => void) | undefined;
  private readonly delivered = new Set<string>();
  private readonly roundTripCounts = new Map<string, number>();
  private readonly capExceededSessions = new Set<string>();
  private started = false;
  private roundTripCap = DEFAULT_ROUND_TRIP_CAP;
  private bindRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(runtime: IAgentRuntime) {
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
    if (Number.isFinite(parsed) && parsed > 0) this.roundTripCap = parsed;
    // Service registration runs in parallel — when router.start() executes,
    // AcpService and PTYService may not yet be registered with the runtime,
    // so getService returns null. Static `dependencies` is not enough to
    // order startup. Retry binding on a short backoff until both event
    // sources are bound (or we give up after ~10s and stay idle).
    this.tryBindSources(0);
  }

  private tryBindSources(attempt: number): void {
    if (this.stopped) return;
    const needsAcp = !this.unsubscribe;
    const needsPty = !this.unsubscribePty;
    if (!needsAcp && !needsPty) return;

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
    if (needsPty) {
      // PTY_SERVICE is a separate event channel from AcpService. The
      // direct PTYService.spawnSession path used by opencode-run / codex-exec
      // fast-path emits task_complete through PTYService.emitEvent — without
      // this subscription, those completions never reach the router and the
      // sub-agent's actual answer is dropped (user sees only the "On it…" ack).
      const pty = this.runtime.getService("PTY_SERVICE") as {
        onSessionEvent?: (
          cb: (sid: string, event: SessionEventName, data: unknown) => void,
        ) => () => void;
      } | null;
      if (pty && typeof pty.onSessionEvent === "function") {
        this.unsubscribePty = pty.onSessionEvent((sid, event, data) => {
          this.handleEvent(sid, event, data).catch((err) => {
            this.log("error", "router event failed (pty)", {
              sessionId: sid,
              event,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        });
      }
    }

    const acpBound = !!this.unsubscribe;
    const ptyBound = !!this.unsubscribePty;
    if (acpBound && ptyBound) {
      this.log("info", "router bound to AcpService + PTYService");
      return;
    }
    // Give up after ~10s of polling and log what we got.
    if (attempt >= 50) {
      if (acpBound) {
        this.log("info", "router bound to AcpService (PTYService unavailable)");
      } else if (ptyBound) {
        this.log("info", "router bound to PTYService (AcpService unavailable)");
      } else {
        this.log("debug", "no session-event source available; router idle");
      }
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
    this.unsubscribePty?.();
    this.unsubscribePty = undefined;
    this.acp = null;
    this.started = false;
    this.delivered.clear();
    this.roundTripCounts.clear();
    this.capExceededSessions.clear();
  }

  private async handleEvent(
    sessionId: string,
    event: SessionEventName,
    data: unknown,
  ): Promise<void> {
    if (!shouldInject(event)) return;
    const acp = this.acp;
    // ACPX-protocol sessions live in AcpService.store; sessions spawned
    // via PTYService.spawnSession (opencode-run / codex-exec) live in
    // PTYService instead. Look up both — and don't require ACP to exist,
    // since the PTY-only path needs to work when ACP isn't loaded.
    let session: SessionInfo | undefined;
    if (acp) {
      session = (await acp.getSession(sessionId)) ?? undefined;
    }
    if (!session) {
      const ptyService = this.runtime.getService("PTY_SERVICE") as {
        getSession?: (sid: string) => SessionInfo | undefined;
      } | null;
      session = ptyService?.getSession?.(sessionId) ?? undefined;
    }
    if (!session) return;

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

    const nextCount = (this.roundTripCounts.get(sessionId) ?? 0) + 1;
    this.roundTripCounts.set(sessionId, nextCount);
    const capExceeded = nextCount > this.roundTripCap;
    if (capExceeded) {
      if (this.capExceededSessions.has(sessionId)) {
        this.log("debug", "round-trip cap already surfaced; suppressing", {
          sessionId,
          event,
          count: nextCount,
        });
        return;
      }
      this.capExceededSessions.add(sessionId);
      this.log("warn", "sub-agent round-trip cap exceeded; force-stopping", {
        sessionId,
        count: nextCount,
        cap: this.roundTripCap,
      });
      const stopper =
        acp ??
        (this.runtime.getService("PTY_SERVICE") as {
          stopSession?: (sid: string) => Promise<unknown>;
        } | null);
      if (stopper && typeof stopper.stopSession === "function") {
        await stopper.stopSession(sessionId).catch((err) =>
          this.log("warn", "force-stop after cap failed", {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
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
    await this.runtime
      .addParticipant(subAgentEntityId, origin.roomId)
      .catch((err) => {
        this.log("warn", "addParticipant for sub-agent failed", {
          sessionId,
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    // Normalize URLs in the sub-agent's narration before anything else
    // reads it. Weak coding models (gpt-oss-class) emit Unicode look-alike
    // dashes (non-breaking hyphen U+2011, en/em dashes) inside URLs, so the
    // link 404s even though the directory exists under the ASCII-hyphen
    // name — breaking it for both the verification probe AND the user.
    const baseText = normalizeUrlsInText(
      capExceeded
        ? `[sub-agent: ${origin.label} (${session.agentType}) — round-trip cap exceeded]\nThis session reached ${nextCount} round-trips (cap=${this.roundTripCap}) and was force-stopped to prevent a runaway loop. Decide whether to spawn a fresh session, escalate to the user, or drop the task.`
        : composeNarration(event, origin.label, session, data),
    );
    // Fact-check any URLs the sub-agent claimed. Weak coding models
    // routinely report "the app is live at <url>" without writing the
    // files (or the deps the page references). Independently probing each
    // claimed URL — and following an HTML page's own sub-resources —
    // turns the parent's reply from a hallucinated success into an
    // accurate status report.
    let text = baseText;
    let deadUrls: DeadUrl[] = [];
    if (event === "task_complete") {
      const meta = session.metadata as Record<string, unknown> | undefined;
      const verificationReferenceText =
        typeof meta?.initialTask === "string" ? meta.initialTask : undefined;
      const ignoredVerifyUrls = pickStringSet(meta?.cachedStaleMissUrls);
      const verified = await annotateUnverifiedUrls(
        baseText,
        (m) => this.log("debug", m),
        verificationReferenceText,
        ignoredVerifyUrls,
      );
      text = verified.text;
      deadUrls = verified.dead;
    }
    // Verify-retry: the sub-agent reported done but referenced URLs that
    // are unreachable — the build is incomplete (missing or empty files).
    // Re-dispatch a fresh sub-agent with the verification failures fed
    // back in, before surfacing the failure to the user. When a retry is
    // spawned, suppress this post — the retry's own task_complete reports.
    if (event === "task_complete" && deadUrls.length > 0) {
      const retried = await this.retryIncompleteBuild(session, deadUrls);
      if (retried) return;
    }
    const memory: Memory = {
      id: randomUUID() as UUID,
      entityId: subAgentEntityId,
      agentId: this.runtime.agentId,
      roomId: origin.roomId,
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
          subAgentEvent: capExceeded ? "round_trip_cap_exceeded" : event,
          subAgentStatus: capExceeded ? "stopped" : session.status,
          subAgentAgentType: session.agentType,
          subAgentRoundTrip: nextCount,
          subAgentRoundTripCap: this.roundTripCap,
          ...(capExceeded ? { subAgentCapExceeded: true } : {}),
          ...(origin.userId ? { originUserId: origin.userId } : {}),
          ...(origin.parentMessageId
            ? { originMessageId: origin.parentMessageId }
            : {}),
          ...(origin.source ? { originSource: origin.source } : {}),
        },
      },
      createdAt: Date.now(),
    };

    // The Discord plugin wires a callback bound to the originating channel
    // when it calls handleMessage; without that callback, the planner has
    // nowhere to deliver its reply and the bot's answer to the sub-agent
    // narration is dropped silently (the user sees only "On it…" and never
    // the actual result). For synthetic router posts we build the same
    // callback from `runtime.sendMessageToTarget`, scoped to the origin
    // source/room. If the connector isn't registered, fall through to
    // handleMessage without a callback — the planner will still update
    // state but no message reaches the user.
    const replyCallback = this.buildReplyCallback(origin, sessionId);
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
        },
      );
      await this.runtime.createMemory(memory, "messages").catch((err) => {
        this.log("warn", "createMemory for sub-agent post failed", {
          sessionId,
          event,
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

  private buildReplyCallback(
    origin: OriginInfo,
    sessionId: string,
  ): HandlerCallback | undefined {
    const sendToTarget = (
      this.runtime as {
        sendMessageToTarget?: (
          target: { source: string; roomId?: UUID; accountId?: string },
          content: Content,
        ) => Promise<Memory | undefined>;
      }
    ).sendMessageToTarget?.bind(this.runtime);
    if (!sendToTarget) return undefined;
    const source = origin.source;
    if (!source) return undefined;
    return async (response: Content): Promise<Memory[]> => {
      const text =
        typeof response?.text === "string" ? response.text.trim() : "";
      if (!text) return [];
      const delivered = await sendToTarget(
        {
          source,
          roomId: origin.roomId,
        },
        response,
      ).catch((err) => {
        this.log("warn", "sub-agent reply delivery failed", {
          sessionId,
          source,
          roomId: origin.roomId,
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      });
      return delivered ? [delivered] : [];
    };
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

    const service = this.runtime.getService("PTY_SERVICE") as {
      spawnSession?: (opts: SpawnOptions) => Promise<SpawnResult>;
    } | null;
    if (!service?.spawnSession) return false;

    const nextRetry = priorRetries + 1;
    const cachedStaleMissUrls = mergeCachedStaleMissUrls(
      pickStringSet(meta.cachedStaleMissUrls),
      dead,
    );
    const deadLines = dead
      .map((d) =>
        d.via
          ? `  - ${d.url} (referenced by ${d.via}) → ${d.status}`
          : `  - ${d.url} → ${d.status}`,
      )
      .join("\n");
    const retryTask = `${originalTask}

--- VERIFICATION FEEDBACK (retry ${nextRetry}/${maxRetries}) ---
A previous attempt reported the task complete, but these URL(s) are NOT reachable, which means the corresponding files are missing or empty:
${deadLines}
Create or fix every one of those files in the location your task specifies, then verify each file exists and is non-empty.
If a URL reports a cached stale miss, do not keep rewriting the same filename: rename that asset to a fresh filename, update every HTML reference to the new filename, then verify the new public URL. Do not report done until every referenced URL would resolve.`;

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

  private log(
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    data?: unknown,
  ): void {
    const logger = this.runtime.logger;
    const fn = logger?.[level];
    if (typeof fn === "function") {
      fn.call(
        logger,
        { src: "acpx:sub-agent-router", ...(data as object) },
        msg,
      );
    }
  }
}

function shouldInject(event: SessionEventName): boolean {
  return event === "task_complete" || event === "error" || event === "blocked";
}

interface OriginInfo {
  roomId: UUID;
  worldId?: UUID;
  userId?: UUID;
  parentMessageId?: UUID;
  label: string;
  source?: string;
}

function readOrigin(session: SessionInfo): OriginInfo | null {
  const meta = session.metadata as Record<string, unknown> | undefined;
  if (!meta) return null;
  const roomId = pickUuid(meta.roomId);
  if (!roomId) return null;
  return {
    roomId,
    worldId: pickUuid(meta.worldId),
    userId: pickUuid(meta.userId),
    parentMessageId: pickUuid(meta.messageId),
    label: pickLabel(meta) ?? session.name ?? session.id,
    source: typeof meta.source === "string" ? meta.source : undefined,
  };
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

function composeNarration(
  event: SessionEventName,
  label: string,
  session: SessionInfo,
  data: unknown,
): string {
  const header = `[sub-agent: ${label} (${session.agentType}) — ${event}]`;
  if (event === "error") {
    const message =
      pickPayloadString(data, "message") ?? "sub-agent reported an error";
    return `${header}\n${message}`;
  }
  if (event === "blocked") {
    const message =
      pickPayloadString(data, "message") ??
      pickPayloadString(data, "prompt") ??
      "sub-agent is blocked and waiting for input";
    return `${header}\n${message}`;
  }
  const response =
    pickPayloadString(data, "response") ??
    pickPayloadString(data, "finalText") ??
    "sub-agent reports task complete (no captured output).";
  return `${header}\n${response}`;
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
async function annotateUnverifiedUrls(
  text: string,
  log?: (message: string) => void,
  referenceText?: string,
  ignoredUrls?: ReadonlySet<string>,
): Promise<{ text: string; dead: DeadUrl[] }> {
  const urls = extractVerifiableUrls(text, 5, referenceText, ignoredUrls);
  if (urls.length === 0) return { text, dead: [] };
  log?.(
    `[verify] start @ ${new Date().toISOString()} — ${urls.length} url(s): ${urls.join(", ")}`,
  );
  // GET-probe a URL with a 4s timeout. On a 2xx HTML response also returns
  // the body so the caller can follow the page's sub-resources. (GET, not
  // HEAD: we need the body for HTML, and many static hosts reject HEAD.)
  const probeOnce = async (
    url: string,
  ): Promise<{ status: string | null; html?: string }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
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
        return { status: null };
      }
      if (res.status < 200 || res.status >= 300) {
        const cachedMiss = await detectCachedMiss(url, res, controller.signal);
        if (cachedMiss) {
          log?.(
            `[verify] probe ${url} → HTTP ${res.status} (cached stale miss; cache-busting probe returned ${cachedMiss.status}) @ ${new Date().toISOString()}`,
          );
          return {
            status: `HTTP ${res.status} (cached stale miss; cache-busting probe returned ${cachedMiss.status})`,
          };
        }
        log?.(
          `[verify] probe ${url} → HTTP ${res.status} @ ${new Date().toISOString()}`,
        );
        return { status: `HTTP ${res.status}` };
      }
      const contentType = res.headers.get("content-type") ?? "";
      log?.(
        `[verify] probe ${url} → ${res.status} (${contentType.split(";")[0] || "?"}) @ ${new Date().toISOString()}`,
      );
      if (contentType.includes("text/html")) {
        return { status: null, html: await res.text() };
      }
      return { status: null };
    } catch (err) {
      const reason = err instanceof Error ? err.name : "unreachable";
      log?.(`[verify] probe ${url} → ${reason} @ ${new Date().toISOString()}`);
      return { status: reason };
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
  const settleRaw = process.env.ELIZA_URL_VERIFY_SETTLE_MS;
  const settleParsed = settleRaw ? Number.parseInt(settleRaw, 10) : 2500;
  const settleMs =
    Number.isFinite(settleParsed) && settleParsed >= 0 ? settleParsed : 2500;
  const probe = async (
    url: string,
  ): Promise<{ status: string | null; html?: string }> => {
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
      // Follow the page's own declared dependencies — a 200 index.html
      // that <link>s a missing style.css is still a broken app.
      if (result.html) {
        const subResources = extractSubResources(result.html, url);
        await Promise.all(
          subResources.map(async (subUrl) => {
            const subResult = await probe(subUrl);
            if (subResult.status !== null) {
              dead.push({ url: subUrl, status: subResult.status, via: url });
            }
          }),
        );
      }
    }),
  );
  log?.(
    `[verify] done @ ${new Date().toISOString()} — ${dead.length} dead of ${urls.length} mentioned`,
  );
  if (dead.length === 0) return { text, dead };
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
  };
}

async function detectCachedMiss(
  url: string,
  res: Response,
  signal: AbortSignal,
): Promise<{ status: number } | null> {
  if (res.status !== 404 || !looksCached(res.headers)) return null;
  let busted: URL;
  try {
    busted = new URL(url);
  } catch {
    return null;
  }
  busted.searchParams.set("__eliza_verify", Date.now().toString(36));
  const bustedRes = await fetch(busted, {
    method: "GET",
    redirect: "follow",
    signal,
  }).catch(() => null);
  if (!bustedRes) return null;
  return bustedRes.status >= 200 && bustedRes.status < 300
    ? { status: bustedRes.status }
    : null;
}

function looksCached(headers: Headers): boolean {
  const age = headers.get("age");
  if (age && Number.parseInt(age, 10) > 0) return true;
  const cacheStatus = [
    headers.get("cf-cache-status"),
    headers.get("x-cache"),
    headers.get("cdn-cache-status"),
  ]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
  return /\b(hit|stale|cached)\b/.test(cacheStatus);
}

/**
 * Extract the sub-resource URLs an HTML document declares via
 * `<link href>` and `<script src>`, resolved absolute against the page
 * URL. Mechanical extraction from a structured document — not intent
 * classification. Skips in-page anchors and data:/mailto: refs, and caps
 * the result so a pathological page can't fan out unbounded probes.
 */
export function extractSubResources(html: string, pageUrl: string): string[] {
  const refs = new Set<string>();
  const attrRe =
    /<(?:link|script)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((match = attrRe.exec(html)) !== null) {
    const ref = match[1]?.trim();
    if (
      !ref ||
      ref.startsWith("#") ||
      ref.startsWith("data:") ||
      ref.startsWith("mailto:")
    ) {
      continue;
    }
    try {
      const resolved = new URL(ref, pageUrl);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        refs.add(resolved.toString());
      }
    } catch {
      // unparseable ref — skip
    }
    if (refs.size >= 10) break;
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
