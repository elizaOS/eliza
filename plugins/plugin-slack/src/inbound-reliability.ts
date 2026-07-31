/**
 * Inbound reliability core for the Slack connector.
 *
 * Slack's Events API is an at-least-once transport delivered over two
 * overlapping streams. Two independent failure modes follow from that, and
 * this module owns both:
 *
 *  1. **Redelivery.** Slack retries an event whenever the ack is slow or lost.
 *     The retry carries the *same* `event_id`, so without a dedupe memory a
 *     laggy agent turn produces duplicate replies — the slower the agent, the
 *     more duplicates, which is exactly backwards.
 *
 *  2. **The `app_mention` / `message` twin.** @-mentioning the bot in a channel
 *     produces *two* events for one human message: a `message` event and an
 *     `app_mention` event, in no guaranteed order. The previous code resolved
 *     this with an unconditional `if (isMentioned && channel_type !== "im")
 *     return;` in the message path. That is a drop-or-double coin flip: if the
 *     `app_mention` path bails for any reason (gating, missing memory, a
 *     throw), the turn is silently lost, because the message twin already
 *     returned. Under load the reverse also happens.
 *
 * The fix is a small state machine keyed by the debounce key. Exactly one
 * source dispatches per logical Slack message, and the loser only yields once
 * the winner has *actually* dispatched — never on the mere expectation that it
 * will.
 *
 * Keying follows the Slack conversation model rather than the raw event:
 *  - thread replies are scoped by `thread_ts`, so a thread is one lane;
 *  - a reply whose `thread_ts` has not been resolved yet gets a `maybe-thread`
 *    prefix so it cannot collide with the channel's top-level lane;
 *  - top-level channel messages are scoped by their own `ts`, otherwise two
 *    unrelated messages in a busy channel share a lane and the second is
 *    mistaken for a duplicate of the first;
 *  - DMs stay channel-scoped, which keeps consecutive short DM lines batchable;
 *  - `bot_id` is the sender fallback, because bot messages carry no `user`.
 */

/** Which inbound stream an event arrived on. */
export type SlackInboundSource = "message" | "app_mention";

/** Structural shape of the inbound Slack message-family events we key on. */
export interface SlackInboundEventLike {
  channel?: string;
  user?: string;
  bot_id?: string;
  ts?: string;
  event_ts?: string;
  thread_ts?: string;
  parent_user_id?: string;
}

const DEFAULT_SLOT_TTL_MS = 10 * 60_000;
const DEFAULT_EVENT_ID_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 5_000;
/**
 * How long a `message` twin waits for its `app_mention` counterpart to show
 * up before deciding it is not coming. Slack emits the pair within
 * milliseconds of each other; this only has to cover socket jitter.
 */
const DEFAULT_MENTION_GRACE_MS = 1_500;

function resolveSenderId(event: SlackInboundEventLike): string | null {
  return event.user ?? event.bot_id ?? null;
}

function isDirectMessageChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}

function isTopLevel(event: SlackInboundEventLike): boolean {
  return !event.thread_ts && !event.parent_user_id;
}

/**
 * Builds the conversation-lane key an inbound event belongs to.
 *
 * Returns `null` when the event carries neither a `user` nor a `bot_id`, since
 * an event with no sender cannot be attributed to a lane and must not be
 * deduped against anything.
 */
export function buildSlackDebounceKey(
  event: SlackInboundEventLike,
  accountId: string,
): string | null {
  const channel = event.channel;
  if (!channel) {
    return null;
  }
  const senderId = resolveSenderId(event);
  if (!senderId) {
    return null;
  }
  const messageTs = event.ts ?? event.event_ts;
  const threadKey = event.thread_ts
    ? `${channel}:${event.thread_ts}`
    : event.parent_user_id && messageTs
      ? // Thread reply whose thread_ts has not been resolved yet: isolate it
        // from the channel's top-level lane rather than letting it collide.
        `${channel}:maybe-thread:${messageTs}`
      : messageTs && !isDirectMessageChannel(channel)
        ? `${channel}:${messageTs}`
        : channel;
  return `slack:${accountId}:${threadKey}:${senderId}`;
}

/**
 * Lane key for top-level (non-thread) messages, used to reason about a
 * conversation as a whole rather than a single message.
 */
export function buildSlackTopLevelConversationKey(
  event: SlackInboundEventLike,
  accountId: string,
): string | null {
  if (!isTopLevel(event)) {
    return null;
  }
  const channel = event.channel;
  const senderId = resolveSenderId(event);
  if (!channel || !senderId) {
    return null;
  }
  return `slack:${accountId}:${channel}:${senderId}`;
}

export type SlackAdmissionReason =
  | "new"
  | "unkeyed"
  | "supersedes-stale-slot"
  | "mention-preempts-message"
  | "message-twin-awaits-mention"
  | "duplicate-same-source"
  | "duplicate-event-id"
  | "twin-already-dispatched";

export interface SlackAdmission {
  admitted: boolean;
  reason: SlackAdmissionReason;
  /** Lane key, or `null` when the event could not be keyed. */
  key: string | null;
  /** True when this event is the `message` half of a mention twin. */
  isMentionTwin: boolean;
}

export type SlackDispatchOutcome = "dispatched" | "skipped" | "failed";

export interface SlackTwinDecision {
  proceed: boolean;
  reason:
    | "no-twin"
    | "twin-dispatched"
    | "twin-released"
    | "grace-expired"
    | "unkeyed";
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  settled: boolean;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  const deferred: Deferred<T> = {
    promise,
    settled: false,
    resolve: (value: T) => {
      if (deferred.settled) {
        return;
      }
      deferred.settled = true;
      resolve(value);
    },
  };
  return deferred;
}

interface Slot {
  /** The `ts` of the logical Slack message occupying this lane. */
  ts: string;
  /** Sources admitted for this message, in arrival order. */
  admitted: Set<SlackInboundSource>;
  /** Set once a source has actually handed the message to the agent. */
  dispatchedBy: SlackInboundSource | null;
  /** Resolves when the `app_mention` half settles, for twins to await. */
  mentionSettled: Deferred<SlackDispatchOutcome> | null;
  /** Resolves as soon as an `app_mention` is admitted for this lane. */
  mentionArrived: Deferred<void>;
  expiresAt: number;
}

export interface SlackInboundReliabilityOptions {
  /** How long a lane remembers a message. Defaults to 10 minutes. */
  slotTtlMs?: number;
  /** How long a processed `event_id` is remembered. Defaults to 10 minutes. */
  eventIdTtlMs?: number;
  /** Hard cap on retained entries, oldest evicted first. */
  maxEntries?: number;
  /** How long a message twin waits for its mention. Defaults to 1500ms. */
  mentionGraceMs?: number;
  now?: () => number;
  /** Injected for deterministic tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface SlackInboundReliabilityStats {
  trackedLanes: number;
  trackedEventIds: number;
  duplicatesDropped: number;
  twinsSuppressed: number;
  twinsRecovered: number;
}

/**
 * Per-account inbound coordinator. One instance guards one Slack workspace
 * connection; lanes are already account-scoped through the key, so sharing
 * would be safe, but per-account keeps eviction pressure proportional.
 */
export class SlackInboundReliability {
  private readonly slots = new Map<string, Slot>();
  private readonly seenEventIds = new Map<string, number>();
  private readonly slotTtlMs: number;
  private readonly eventIdTtlMs: number;
  private readonly maxEntries: number;
  private readonly mentionGraceMs: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  private duplicatesDropped = 0;
  private twinsSuppressed = 0;
  private twinsRecovered = 0;

  constructor(options: SlackInboundReliabilityOptions = {}) {
    this.slotTtlMs = options.slotTtlMs ?? DEFAULT_SLOT_TTL_MS;
    this.eventIdTtlMs = options.eventIdTtlMs ?? DEFAULT_EVENT_ID_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.mentionGraceMs = options.mentionGraceMs ?? DEFAULT_MENTION_GRACE_MS;
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn =
      options.setTimeoutFn ??
      ((fn, ms) => setTimeout(fn, ms) as unknown as unknown);
    this.clearTimeoutFn =
      options.clearTimeoutFn ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
  }

  /**
   * Envelope-level redelivery guard.
   *
   * Slack reuses `event_id` across retries of the same event, so this is the
   * exact, transport-level answer to "have I already taken this event?" — it
   * covers every event family, including the ones with no channel/ts to key on
   * (reactions, member joins, file shares).
   *
   * Returns `false` when the event has already been accepted.
   */
  admitEventId(eventId: string | null | undefined): boolean {
    if (!eventId) {
      // No envelope id (hand-built payloads, some socket frames): fall through
      // to the lane-level guard rather than dropping a possibly-real event.
      return true;
    }
    const now = this.now();
    this.pruneEventIds(now);
    const existing = this.seenEventIds.get(eventId);
    if (existing !== undefined && existing > now) {
      this.duplicatesDropped += 1;
      return false;
    }
    this.seenEventIds.set(eventId, now + this.eventIdTtlMs);
    this.enforceEventIdCap();
    return true;
  }

  /**
   * Lane-level admission for message-family events.
   *
   * `retryNum` is Slack's redelivery counter. It is not itself a drop signal:
   * a retry with no matching record means we never successfully processed the
   * original, and dropping it would turn a slow turn into a lost one. It is
   * recorded so the decision is auditable.
   */
  admit(params: {
    accountId: string;
    source: SlackInboundSource;
    event: SlackInboundEventLike;
    eventId?: string | null;
    retryNum?: number;
  }): SlackAdmission {
    const { accountId, source, event } = params;

    if (!this.admitEventId(params.eventId)) {
      return {
        admitted: false,
        reason: "duplicate-event-id",
        key: buildSlackDebounceKey(event, accountId),
        isMentionTwin: false,
      };
    }

    const key = buildSlackDebounceKey(event, accountId);
    if (!key) {
      return {
        admitted: true,
        reason: "unkeyed",
        key: null,
        isMentionTwin: false,
      };
    }

    const ts = event.ts ?? event.event_ts ?? "";
    const now = this.now();
    this.pruneSlots(now);

    const existing = this.slots.get(key);

    if (!existing || existing.ts !== ts) {
      // Either a fresh lane or a new message in a channel-scoped lane (DMs).
      // Replacing is correct: a different `ts` is a different human message.
      this.slots.set(key, this.createSlot(ts, source, now));
      this.enforceSlotCap();
      return {
        admitted: true,
        reason: existing ? "supersedes-stale-slot" : "new",
        key,
        isMentionTwin: false,
      };
    }

    existing.expiresAt = now + this.slotTtlMs;

    if (existing.admitted.has(source)) {
      // Same stream, same message, twice: a redelivery or a double bolt fire.
      this.duplicatesDropped += 1;
      return {
        admitted: false,
        reason: "duplicate-same-source",
        key,
        isMentionTwin: false,
      };
    }

    if (existing.dispatchedBy && existing.dispatchedBy !== source) {
      this.twinsSuppressed += 1;
      return {
        admitted: false,
        reason: "twin-already-dispatched",
        key,
        isMentionTwin: source === "message",
      };
    }

    existing.admitted.add(source);

    if (source === "app_mention") {
      existing.mentionSettled ??= createDeferred<SlackDispatchOutcome>();
      existing.mentionArrived.resolve();
      return {
        admitted: true,
        reason: "mention-preempts-message",
        key,
        isMentionTwin: false,
      };
    }

    // A `message` arriving after its `app_mention`: admitted, but it must wait
    // for the mention to settle before doing anything user-visible.
    return {
      admitted: true,
      reason: "message-twin-awaits-mention",
      key,
      isMentionTwin: true,
    };
  }

  /**
   * Resolves the twin race for a `message` event.
   *
   * If an `app_mention` has been admitted for this lane, wait for it to
   * settle: only a real dispatch suppresses the message. If none has arrived,
   * wait out a short grace window — Slack emits the pair together, so a window
   * with no mention means there is no mention coming and this message is the
   * only chance to answer.
   */
  async awaitMentionTwin(
    key: string | null,
    graceMs?: number,
  ): Promise<SlackTwinDecision> {
    if (!key) {
      return { proceed: true, reason: "unkeyed" };
    }
    const slot = this.slots.get(key);
    if (!slot) {
      return { proceed: true, reason: "no-twin" };
    }

    if (!slot.admitted.has("app_mention")) {
      const arrived = await this.raceWithGrace(
        slot.mentionArrived.promise,
        graceMs ?? this.mentionGraceMs,
      );
      if (!arrived) {
        // No mention showed up. On the old code path this message was already
        // dropped and the turn lost; here it proceeds.
        this.twinsRecovered += 1;
        return { proceed: true, reason: "grace-expired" };
      }
    }

    const settled = slot.mentionSettled;
    if (!settled) {
      return { proceed: true, reason: "no-twin" };
    }
    const outcome = await settled.promise;
    if (outcome === "dispatched") {
      this.twinsSuppressed += 1;
      return { proceed: false, reason: "twin-dispatched" };
    }
    // The mention bailed before reaching the agent — the message twin is now
    // the only surviving copy of this turn, so it proceeds.
    this.twinsRecovered += 1;
    return { proceed: true, reason: "twin-released" };
  }

  /**
   * Records the terminal outcome for a source on a lane.
   *
   * - `dispatched` locks the lane so the twin yields.
   * - `skipped` (gated, unbuildable memory) releases this source's claim; if
   *   nothing else holds the lane it is freed so the twin can take over.
   * - `failed` always frees the lane, so Slack's redelivery gets a real retry
   *   instead of being swallowed as a duplicate.
   */
  settle(
    key: string | null,
    source: SlackInboundSource,
    outcome: SlackDispatchOutcome,
  ): void {
    if (!key) {
      return;
    }
    const slot = this.slots.get(key);
    if (!slot) {
      return;
    }

    if (outcome === "dispatched") {
      slot.dispatchedBy = source;
      slot.expiresAt = this.now() + this.slotTtlMs;
      if (source === "app_mention") {
        slot.mentionSettled?.resolve("dispatched");
        slot.mentionArrived.resolve();
      }
      return;
    }

    slot.admitted.delete(source);
    if (source === "app_mention") {
      slot.mentionSettled?.resolve(outcome);
      slot.mentionSettled = null;
      slot.mentionArrived.resolve();
    }

    if (outcome === "failed") {
      this.slots.delete(key);
      return;
    }
    if (slot.admitted.size === 0 && !slot.dispatchedBy) {
      this.slots.delete(key);
    }
  }

  stats(): SlackInboundReliabilityStats {
    return {
      trackedLanes: this.slots.size,
      trackedEventIds: this.seenEventIds.size,
      duplicatesDropped: this.duplicatesDropped,
      twinsSuppressed: this.twinsSuppressed,
      twinsRecovered: this.twinsRecovered,
    };
  }

  clear(): void {
    for (const slot of this.slots.values()) {
      slot.mentionArrived.resolve();
      slot.mentionSettled?.resolve("skipped");
    }
    this.slots.clear();
    this.seenEventIds.clear();
  }

  private createSlot(
    ts: string,
    source: SlackInboundSource,
    now: number,
  ): Slot {
    const slot: Slot = {
      ts,
      admitted: new Set<SlackInboundSource>([source]),
      dispatchedBy: null,
      mentionSettled:
        source === "app_mention"
          ? createDeferred<SlackDispatchOutcome>()
          : null,
      mentionArrived: createDeferred<void>(),
      expiresAt: now + this.slotTtlMs,
    };
    if (source === "app_mention") {
      slot.mentionArrived.resolve();
    }
    return slot;
  }

  private async raceWithGrace(
    promise: Promise<void>,
    graceMs: number,
  ): Promise<boolean> {
    if (graceMs <= 0) {
      // Still yield one microtask so a mention admitted in the same tick wins.
      await Promise.resolve();
      return false;
    }
    let handle: unknown;
    const timeout = new Promise<false>((resolve) => {
      handle = this.setTimeoutFn(() => resolve(false), graceMs);
    });
    try {
      return await Promise.race([promise.then(() => true), timeout]);
    } finally {
      this.clearTimeoutFn(handle);
    }
  }

  private pruneSlots(now: number): void {
    for (const [key, slot] of this.slots) {
      if (slot.expiresAt <= now) {
        slot.mentionArrived.resolve();
        slot.mentionSettled?.resolve("skipped");
        this.slots.delete(key);
      }
    }
  }

  private pruneEventIds(now: number): void {
    for (const [id, expiresAt] of this.seenEventIds) {
      if (expiresAt <= now) {
        this.seenEventIds.delete(id);
      }
    }
  }

  private enforceSlotCap(): void {
    while (this.slots.size > this.maxEntries) {
      const oldest = this.slots.keys().next();
      if (oldest.done) {
        return;
      }
      const slot = this.slots.get(oldest.value);
      slot?.mentionArrived.resolve();
      slot?.mentionSettled?.resolve("skipped");
      this.slots.delete(oldest.value);
    }
  }

  private enforceEventIdCap(): void {
    while (this.seenEventIds.size > this.maxEntries) {
      const oldest = this.seenEventIds.keys().next();
      if (oldest.done) {
        return;
      }
      this.seenEventIds.delete(oldest.value);
    }
  }
}

/**
 * Extracts Slack's redelivery counter from whichever surface carries it.
 * Socket Mode puts `retry_attempt` on the envelope; the Events API HTTP
 * receiver surfaces `retryNum` on the bolt context and `retry_num` on the body.
 */
export function extractSlackRetryNum(
  body: unknown,
  context?: unknown,
): number | undefined {
  const fromContext = (context as { retryNum?: unknown } | undefined)?.retryNum;
  if (typeof fromContext === "number") {
    return fromContext;
  }
  const raw = body as
    | { retry_num?: unknown; retry_attempt?: unknown }
    | undefined;
  if (typeof raw?.retry_num === "number") {
    return raw.retry_num;
  }
  if (typeof raw?.retry_attempt === "number") {
    return raw.retry_attempt;
  }
  return undefined;
}

/** Extracts the envelope `event_id`, the stable identity across redeliveries. */
export function extractSlackEventId(body: unknown): string | null {
  const raw = body as { event_id?: unknown } | undefined;
  return typeof raw?.event_id === "string" && raw.event_id.length > 0
    ? raw.event_id
    : null;
}
