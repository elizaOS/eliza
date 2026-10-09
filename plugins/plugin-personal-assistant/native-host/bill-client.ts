import type { TaskChoiceWidget } from "@elizaos/core/protocol";
import { gmailSourceLink } from "./bill-source-link.mjs";

export class BillClientResponseError extends Error {
  readonly code = "BILL_CLIENT_RESPONSE_INVALID";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BillClientResponseError";
  }
}

function parseResponseUrl(value: string, message: string): URL {
  try {
    return new URL(value);
  } catch (cause) {
    throw new BillClientResponseError(message, { cause });
  }
}

/** Browser response admission only. The host remains responsible for owner,
 * origin, task revision, source provenance and effect authorization. */
export interface BillClientValidators {
  choice(value: unknown): asserts value is TaskChoiceWidget;
  money(value: {
    amountMinor: number;
    currency: string;
    currencyDigits?: number;
  }): unknown;
}
export type BillSourceReference = {
  messageId: string;
  kind?: string;
  partId?: string;
  filename?: string;
  threadId?: string;
  url?: string;
};
export function validateBillSourceLinks(value: unknown): BillSourceReference[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new BillClientResponseError("Unsupported source links");
  for (const source of value)
    if (
      !source ||
      typeof source.messageId !== "string" ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(source.messageId) ||
      (source.kind !== undefined && typeof source.kind !== "string") ||
      (source.partId !== undefined && typeof source.partId !== "string") ||
      ((source.url !== undefined || source.threadId !== undefined) &&
        !gmailSourceLink(source.url, source.threadId))
    )
      throw new BillClientResponseError("Unsupported source link");
  for (const source of value)
    if (
      source.filename !== undefined &&
      (typeof source.filename !== "string" || source.filename.length > 1024)
    )
      throw new BillClientResponseError("Unsupported source filename");
  return structuredClone(value);
}
export type BillSourceCandidate = {
  candidateId: string;
  billId: string;
  /** When the newest message for this bill arrived (ISO time). */
  receivedAt?: string;
  /** Set on the newest candidate only. */
  mostRecent?: true;
  facts: {
    company: string;
    accountLabel: string;
    origin: string;
    amountMinor: number;
    currency: string;
    currencyDigits: number;
    dueDate?: string;
    serviceAddress?: string;
    servicePeriod?: { startsOn: string; endsOn: string };
  };
  sources: BillSourceReference[];
};
/** A look-alike bill email for another company, account or website. */
export type BillSourceConflict = {
  company: string;
  accountLabel: string;
  origin: string;
};
export type BillSourceOffer = {
  status:
    | "candidate"
    | "ambiguous"
    | "missing"
    | "incomplete"
    | "conflicting-source";
  reason?: "conflicting-invoice";
  /** Messages from the bill sender that could not be read. */
  unreadable?: number;
  conflicts?: BillSourceConflict[];
  offerId: string;
  expectedRevision: number;
  expiresAt: number;
  candidates: BillSourceCandidate[];
};
export function readBillSourceOffer(
  value: unknown,
  validators: BillClientValidators,
): BillSourceOffer {
  const v = value as BillSourceOffer;
  if (
    !v ||
    ![
      "candidate",
      "ambiguous",
      "missing",
      "incomplete",
      "conflicting-source",
    ].includes(v.status) ||
    !/^[a-f0-9-]{36}$/.test(v.offerId) ||
    !Number.isSafeInteger(v.expectedRevision) ||
    v.expectedRevision < 0 ||
    !Number.isSafeInteger(v.expiresAt) ||
    !Array.isArray(v.candidates) ||
    v.candidates.length > 100 ||
    (v.reason !== undefined && v.reason !== "conflicting-invoice") ||
    (v.unreadable !== undefined &&
      (!Number.isSafeInteger(v.unreadable) || v.unreadable < 1)) ||
    (v.conflicts !== undefined &&
      (!Array.isArray(v.conflicts) ||
        v.conflicts.some(
          (c) =>
            ![c?.company, c?.accountLabel, c?.origin].every(
              (x) => typeof x === "string" && x.length > 0 && x.length <= 300,
            ),
        )))
  )
    throw new BillClientResponseError("Unsupported source result");
  for (const c of v.candidates) {
    const f = c?.facts;
    if (
      !/^[a-f0-9]{64}$/.test(c?.candidateId) ||
      !/^[a-f0-9]{64}$/.test(c.billId) ||
      !f ||
      !Number.isSafeInteger(f.amountMinor) ||
      f.amountMinor < 0 ||
      !Number.isInteger(f.currencyDigits) ||
      f.currencyDigits < 0 ||
      f.currencyDigits > 4 ||
      !/^[A-Z]{3}$/.test(f.currency) ||
      ![f.company, f.accountLabel, f.origin].every(
        (x) => typeof x === "string" && x.length > 0 && x.length <= 300,
      ) ||
      (f.dueDate !== undefined &&
        (typeof f.dueDate !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(f.dueDate))) ||
      (c.receivedAt !== undefined &&
        (typeof c.receivedAt !== "string" ||
          !Number.isFinite(Date.parse(c.receivedAt)))) ||
      (c.mostRecent !== undefined && c.mostRecent !== true) ||
      !Array.isArray(c.sources) ||
      !c.sources.length
    )
      throw new BillClientResponseError("Unsupported source candidate");
    validators.money(f);
    validateBillSourceLinks(c.sources);
    const origin = parseResponseUrl(f.origin, "Unsupported source website");
    if (origin.protocol !== "https:" || origin.origin !== f.origin)
      throw new BillClientResponseError("Unsupported source website");
    if (
      f.serviceAddress !== undefined &&
      (typeof f.serviceAddress !== "string" || f.serviceAddress.length > 300)
    )
      throw new BillClientResponseError("Unsupported source address");
    if (
      f.servicePeriod !== undefined &&
      (!f.servicePeriod ||
        typeof f.servicePeriod !== "object" ||
        ![f.servicePeriod.startsOn, f.servicePeriod.endsOn].every(
          (x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x),
        ))
    )
      throw new BillClientResponseError("Unsupported source period");
  }
  return structuredClone(v);
}
export type BillConflict = {
  field: string;
  expected: string;
  observed: string;
  billSource: string;
  websiteSource: string;
};
export type BillReview = {
  serviceAddress?: string | null;
  company: string;
  accountLabel: string;
  amountMinor: number;
  feeMinor: number;
  totalMinor: number;
  currency: string;
  currencyDigits: number;
  paymentDate: string;
  method: string;
  servicePeriod: string | null;
  source: string;
};
export type BillDecision = {
  billSources?: BillSourceReference[];
  /** expiresAt: when the guide on the website ends unless it is renewed. */
  guidance?: { instruction: string; available: boolean; expiresAt?: number };
  kind: string;
  conflict?: BillConflict;
  message?: string;
  reason?: string;
  review?: BillReview;
  reviewKey?: string;
  choice?: TaskChoiceWidget;
  status?: string;
  reference?: string;
  source?: string;
  saveStatus?: "saved" | "pending";
  totalMinor?: number | null;
  paymentDate?: string | null;
  currency?: string;
  currencyDigits?: number;
  /** The company named on the source bill, for an outcome. */
  company?: string | null;
};
export function readBillDecision(
  value: unknown,
  taskId: string,
  validators: BillClientValidators,
): BillDecision {
  const decision = (value as { decision?: BillDecision })?.decision;
  if (
    !decision ||
    ![
      "source-selection-required",
      "blocked",
      "human-sign-in",
      "human-verification",
      "human-review",
      "choose-existing-method",
      "choice-pending",
      "submission-pending",
      "human-submit",
      "outcome",
      "prior-outcome",
      "paused",
      "unknown-outcome",
      "unavailable",
    ].includes(decision.kind)
  )
    throw new BillClientResponseError("Unsupported bill state");
  if (decision.billSources !== undefined)
    validateBillSourceLinks(decision.billSources);
  if (decision.kind === "choose-existing-method") {
    validators.choice(decision.choice);
    if (
      decision.choice.taskId !== taskId ||
      decision.choice.contextKey !== decision.reviewKey
    )
      throw new BillClientResponseError("Unbound bill choice");
  }
  if (
    decision.guidance !== undefined &&
    (!decision.guidance ||
      typeof decision.guidance !== "object" ||
      typeof decision.guidance.instruction !== "string" ||
      !decision.guidance.instruction.trim() ||
      decision.guidance.instruction.length > 600 ||
      typeof decision.guidance.available !== "boolean" ||
      (decision.guidance.expiresAt !== undefined &&
        (!Number.isSafeInteger(decision.guidance.expiresAt) ||
          decision.guidance.expiresAt < 0)))
  )
    throw new BillClientResponseError("Invalid guidance");
  if (
    decision.totalMinor != null &&
    (!Number.isSafeInteger(decision.totalMinor) ||
      decision.totalMinor < 0 ||
      !/^[A-Z]{3}$/.test(decision.currency || "") ||
      !Number.isInteger(decision.currencyDigits) ||
      (decision.currencyDigits ?? -1) < 0 ||
      (decision.currencyDigits ?? -1) > 4)
  )
    throw new BillClientResponseError("Invalid outcome amount");
  if (decision.totalMinor != null)
    validators.money({
      amountMinor: decision.totalMinor,
      currency: decision.currency ?? "",
      currencyDigits: decision.currencyDigits,
    });
  if (
    decision.paymentDate != null &&
    (typeof decision.paymentDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(decision.paymentDate))
  )
    throw new BillClientResponseError("Invalid outcome date");
  if (
    decision.saveStatus !== undefined &&
    !["saved", "pending"].includes(decision.saveStatus)
  )
    throw new BillClientResponseError("Invalid save status");
  for (const value of [
    decision.message,
    decision.reason,
    decision.status,
    decision.reference,
    decision.source,
  ])
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length > 2000)
    )
      throw new BillClientResponseError("Invalid bill state");
  if (
    decision.company != null &&
    (typeof decision.company !== "string" ||
      !decision.company.trim() ||
      decision.company.length > 300)
  )
    throw new BillClientResponseError("Invalid bill state");
  if (
    decision.review !== undefined ||
    ["choose-existing-method", "human-submit"].includes(decision.kind)
  ) {
    const r = decision.review;
    if (
      !r ||
      ![r.amountMinor, r.feeMinor, r.totalMinor].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      !Number.isInteger(r.currencyDigits) ||
      r.currencyDigits < 0 ||
      r.currencyDigits > 4 ||
      !/^[A-Z]{3}$/.test(r.currency) ||
      !/^[a-f0-9]{64}$/.test(decision.reviewKey || "")
    )
      throw new BillClientResponseError("Invalid bill review");
    for (const amountMinor of [r.amountMinor, r.feeMinor, r.totalMinor])
      validators.money({
        amountMinor,
        currency: r.currency,
        currencyDigits: r.currencyDigits,
      });
    for (const value of [r.company, r.accountLabel, r.paymentDate, r.method])
      if (typeof value !== "string" || value.length > 300)
        throw new BillClientResponseError("Invalid bill detail");
    if (r.servicePeriod !== null && typeof r.servicePeriod !== "string")
      throw new BillClientResponseError("Invalid service period");
  }
  if (decision.conflict !== undefined) {
    const c = decision.conflict;
    if (
      decision.kind !== "blocked" ||
      !c ||
      !["Company", "Account", "Service address", "Bill amount"].includes(
        c.field,
      )
    )
      throw new BillClientResponseError("Invalid bill conflict");
    for (const value of [c.expected, c.observed, c.billSource])
      if (typeof value !== "string" || !value || value.length > 300)
        throw new BillClientResponseError("Invalid conflict detail");
    const url = parseResponseUrl(c.websiteSource, "Invalid conflict source");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new BillClientResponseError("Invalid conflict source");
  }
  if (
    decision.review?.serviceAddress != null &&
    (typeof decision.review.serviceAddress !== "string" ||
      decision.review.serviceAddress.length > 300)
  )
    throw new BillClientResponseError("Invalid address");
  const source = decision.review?.source || decision.source;
  if (
    source &&
    (typeof source !== "string" ||
      parseResponseUrl(source, "Invalid bill source").protocol !== "https:")
  )
    throw new BillClientResponseError("Invalid bill source");
  return structuredClone(decision);
}

export type BillRequest = (
  path: string,
  body?: Record<string, unknown>,
) => Promise<unknown>;
export interface BillDecisionState {
  decision: BillDecision | null;
  pending: boolean;
  error: "load" | "save" | null;
}
/** Why a source search failed, from the host's fixed list. */
export type BillSourceFailureReason =
  | "reauth_required"
  | "insufficient_scope"
  | "account_changed"
  | "unavailable"
  | "timeout";
const sourceFailureReasons: readonly BillSourceFailureReason[] = [
  "reauth_required",
  "insufficient_scope",
  "account_changed",
  "unavailable",
  "timeout",
];
export interface BillSourceState {
  offer: BillSourceOffer | null;
  pending: boolean;
  selected: boolean;
  error: "search" | "selection" | null;
  /** Set with a search error when the request error carries a host reason. */
  reason?: BillSourceFailureReason;
}

/** One active task and operation. Invalidating a request suppresses its replies;
 * it does not claim to undo an already dispatched host effect. */
class BillSession<S extends { pending: boolean }> {
  protected taskId: string | null = null;
  protected generation = 0;
  protected state: S;
  private readonly changed: (state: S) => void;
  constructor(state: S, changed: (state: S) => void) {
    this.state = state;
    this.changed = changed;
  }
  snapshot(): S {
    return structuredClone(this.state);
  }
  protected publish() {
    this.changed(this.snapshot());
  }
  protected begin(): number | null {
    if (this.taskId === null || this.state.pending) return null;
    this.state.pending = true;
    return ++this.generation;
  }
  protected current(ticket: number) {
    return this.taskId !== null && ticket === this.generation;
  }
  protected finish(ticket: number) {
    if (this.current(ticket)) {
      this.state.pending = false;
      this.publish();
    }
  }
  stop() {
    this.taskId = null;
    this.generation++;
    this.state.pending = false;
  }
}

/** Check the website again this often while a guide is shown. */
export const GUIDANCE_RECHECK_MS = 15000;
/** Renew a guide this long before it expires. */
const GUIDANCE_RENEW_BEFORE_MS = 5000;
export interface BillTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
export class BillDecisionClient extends BillSession<BillDecisionState> {
  private readonly request: BillRequest;
  private readonly validators: BillClientValidators;
  private readonly now: () => number;
  private readonly timers: BillTimers;
  private recheck: unknown = null;
  constructor(options: {
    request: BillRequest;
    validators: BillClientValidators;
    changed: (state: BillDecisionState) => void;
    now?: () => number;
    timers?: BillTimers;
  }) {
    super({ decision: null, pending: false, error: null }, options.changed);
    this.request = options.request;
    this.validators = options.validators;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }
  override stop() {
    this.cancelRecheck();
    super.stop();
  }
  private cancelRecheck() {
    if (this.recheck !== null) this.timers.clear(this.recheck);
    this.recheck = null;
  }
  /**
   * While a guide is shown, look at the website again on a short interval and
   * before the guide expires. A page change hides the guide in the page; the
   * next check shows it on the current page, or reports it unavailable.
   */
  private scheduleRecheck() {
    this.cancelRecheck();
    const guidance = this.state.decision?.guidance;
    if (!guidance?.available || this.taskId === null) return;
    const ticket = this.generation;
    const untilExpiry =
      guidance.expiresAt === undefined
        ? Number.POSITIVE_INFINITY
        : guidance.expiresAt - this.now();
    // After a failed renewal, try once more when the guide expires.
    const delay =
      untilExpiry - GUIDANCE_RENEW_BEFORE_MS > 0
        ? Math.min(GUIDANCE_RECHECK_MS, untilExpiry - GUIDANCE_RENEW_BEFORE_MS)
        : Math.max(1000, untilExpiry);
    this.recheck = this.timers.set(() => {
      this.recheck = null;
      if (this.generation !== ticket || this.taskId === null) return;
      const shown = this.state.decision?.guidance;
      // The guide is gone once it expires, even if the check fails.
      if (
        shown?.expiresAt !== undefined &&
        shown.expiresAt <= this.now() &&
        this.state.decision
      ) {
        this.state.decision = {
          ...this.state.decision,
          guidance: { ...shown, available: false },
        };
        this.publish();
      }
      void this.refresh();
    }, delay);
  }
  start(taskId: string) {
    this.stop();
    this.taskId = taskId;
    this.state = { decision: null, pending: false, error: null };
    this.publish();
    const ticket = this.generation;
    // React effect replay/unmount must not dispatch a second durable observation.
    queueMicrotask(() => {
      if (this.current(ticket)) void this.refresh();
    });
  }
  refresh(): Promise<boolean> {
    return this.update();
  }
  restoreGuidance(): Promise<boolean> {
    return this.update({ action: "show-guidance" });
  }
  choose(widget: TaskChoiceWidget, value: string): Promise<boolean> {
    const offered = this.state.decision?.choice;
    if (
      !offered ||
      widget.taskId !== this.taskId ||
      widget.callbackData !== offered.callbackData ||
      widget.contextKey !== offered.contextKey ||
      !offered.block.options.some((option) => option.value === value)
    )
      return Promise.resolve(false);
    return this.update({
      callbackData: offered.callbackData,
      contextKey: offered.contextKey,
      value,
    });
  }
  private async update(body?: Record<string, unknown>): Promise<boolean> {
    const taskId = this.taskId,
      ticket = this.begin();
    if (ticket === null || taskId === null) return false;
    this.state.error = null;
    this.publish();
    try {
      const reply = await this.request(
        `/tasks/${encodeURIComponent(taskId)}/bill`,
        body,
      );
      if (!this.current(ticket)) return false;
      this.state.decision = readBillDecision(reply, taskId, this.validators);
      return true;
    } catch {
      if (this.current(ticket))
        this.state.error =
          this.state.decision?.saveStatus === "pending" ? "save" : "load";
      return false;
    } finally {
      if (this.current(ticket)) this.scheduleRecheck();
      this.finish(ticket);
    }
  }
}

export class BillSourceClient extends BillSession<BillSourceState> {
  private readonly request: BillRequest;
  private readonly validators: BillClientValidators;
  private readonly now: () => number;
  constructor(options: {
    request: BillRequest;
    validators: BillClientValidators;
    changed: (state: BillSourceState) => void;
    now?: () => number;
  }) {
    super(
      { offer: null, pending: false, selected: false, error: null },
      options.changed,
    );
    this.request = options.request;
    this.validators = options.validators;
    this.now = options.now ?? Date.now;
  }
  start(taskId: string) {
    this.stop();
    this.taskId = taskId;
    this.state = { offer: null, pending: false, selected: false, error: null };
    this.publish();
    const ticket = this.generation;
    queueMicrotask(() => {
      if (this.current(ticket)) void this.search();
    });
  }
  search(): Promise<boolean> {
    return this.update();
  }
  choose(candidateId: string): Promise<boolean> {
    const offer = this.state.offer;
    if (
      !offer ||
      offer.reason ||
      offer.expiresAt <= this.now() ||
      !["candidate", "ambiguous"].includes(offer.status) ||
      !offer.candidates.some((c) => c.candidateId === candidateId)
    )
      return Promise.resolve(false);
    return this.update({
      candidateId,
      offerId: offer.offerId,
      expectedRevision: offer.expectedRevision,
    });
  }
  private async update(body?: Record<string, unknown>): Promise<boolean> {
    const taskId = this.taskId,
      ticket = this.begin();
    if (ticket === null || taskId === null) return false;
    this.state.error = null;
    delete this.state.reason;
    this.state.selected = false;
    this.publish();
    try {
      const reply = await this.request(
        `/tasks/${encodeURIComponent(taskId)}/source-bills`,
        body,
      );
      if (!this.current(ticket)) return false;
      if ((reply as { status?: string })?.status === "selected") {
        this.state.offer = null;
        this.state.selected = true;
      } else {
        if (body) throw new BillClientResponseError("Selection unavailable");
        this.state.offer = readBillSourceOffer(reply, this.validators);
      }
      return true;
    } catch (error) {
      if (this.current(ticket)) {
        this.state.error = body ? "selection" : "search";
        const reason = (error as { reason?: unknown } | null)?.reason;
        if (
          !body &&
          sourceFailureReasons.includes(reason as BillSourceFailureReason)
        )
          this.state.reason = reason as BillSourceFailureReason;
        // An uncertain POST can have committed. Discard its offer and require an
        // explicit GET of authoritative state; never retry/replay that POST.
        if (body) this.state.offer = null;
      }
      return false;
    } finally {
      this.finish(ticket);
    }
  }
}

export interface BillSourceLinkState {
  opening: boolean;
  failed: boolean;
}
/** Explicit source opening, with single-flight and stale completion suppression. */
export class BillSourceLinkClient {
  private generation = 0;
  private active = false;
  private state: BillSourceLinkState = { opening: false, failed: false };
  private readonly open: (url: string) => Promise<unknown>;
  private readonly changed: (state: BillSourceLinkState) => void;
  constructor(options: {
    open: (url: string) => Promise<unknown>;
    changed: (state: BillSourceLinkState) => void;
  }) {
    this.open = options.open;
    this.changed = options.changed;
  }
  start() {
    this.stop();
    this.active = true;
    this.state = { opening: false, failed: false };
    this.changed({ ...this.state });
  }
  stop() {
    this.active = false;
    this.generation++;
    this.state.opening = false;
  }
  async openSource(source: BillSourceReference): Promise<boolean> {
    const safe = gmailSourceLink(source.url, source.threadId);
    if (!this.active || this.state.opening || !safe) return false;
    const ticket = ++this.generation;
    this.state = { opening: true, failed: false };
    this.changed({ ...this.state });
    try {
      await this.open(safe);
      return this.active && ticket === this.generation;
    } catch {
      if (this.active && ticket === this.generation) this.state.failed = true;
      return false;
    } finally {
      if (this.active && ticket === this.generation) {
        this.state.opening = false;
        this.changed({ ...this.state });
      }
    }
  }
}
