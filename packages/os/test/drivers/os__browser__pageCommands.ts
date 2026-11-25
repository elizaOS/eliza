// spec/os/browser/pageCommands.md, "Story: Run a website task step only on the page it was planned for"
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createSurfaceTaskHandler, type SurfaceControlReply, type SurfacePage, type SurfaceTaskHandler } from "../../browser/src/surface-task-handler.mjs";
import { COMMIT_GRANT_MAX_MS } from "../../browser/src/task-bindings.mjs";
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/os__browser__pageCommands.conformance.ts";
import type { BindingOffer, CommandScope, Event, PageRequest, ReceiverPhase, Reply, RequestedAction, SurfaceReceiver } from "../../gen/os__browser__pageCommands.ts";

export function nativeControlProgram(): string {
  const source = new URL("../../android/browser-surface/native-control-channel.mjs", import.meta.url);
  return execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    "const { nativeControlProgram } = await import(process.argv[1]); process.stdout.write(nativeControlProgram());",
    source.href,
  ], { encoding: "utf8" });
}

export interface PeerView {
  readonly retired: boolean;
  readonly phase: ReceiverPhase;
  readonly reply: Reply;
}

type Outcome = "accepted" | "refused";
type Settlement = { readonly kind: "pending" } | { readonly kind: "resolved"; readonly value: unknown } | { readonly kind: "rejected"; readonly code: string; readonly error: unknown };
type Held = "snapshot" | "status" | "input";

interface Gate<T> {
  readonly promise: Promise<T>;
  open(value: T): void;
  fail(error: Error): void;
}

interface Bound {
  readonly taskId: string;
  readonly epoch: number;
  readonly expiresAt: number;
}

interface InFlight {
  readonly message: PageRequest;
  readonly settlement: () => Settlement;
  readonly spentStale: boolean;
}

interface BindGate {
  armed: boolean;
  released: boolean;
  gate: Gate<unknown> | undefined;
}

const PAGE = "page-1";
const ORIGIN = "https://shop.example";
const ELSEWHERE = "https://elsewhere.example";
const DOCUMENT = "document-1";
const NODE = 7;
const REVIEWED = "#continue";
const VALUE = "approved value";
const OWNER = { actorId: "owner", accountId: "account", agentId: "agent" };
const SUBACTIONS: Record<RequestedAction, string> = {
  SnapshotAction: "snapshot",
  ClickAction: "click",
  FillAction: "fill",
  SelectAction: "select",
  ScrollAction: "scroll",
  FollowAction: "follow",
  UnlistedAction: "navigate",
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const snapshotId = (ref: string) => {
  const hex = sha256(`snapshot:${ref}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
const idle = async () => {
  for (let turn = 0; turn < 8; turn += 1) await Effect.runPromise(Effect.yieldNow);
};

function gate<T>(): Gate<T> {
  let open!: (value: T) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

function track(promise: Promise<unknown>): () => Settlement {
  let settlement: Settlement = { kind: "pending" };
  promise.then(
    (value) => {
      settlement = { kind: "resolved", value };
    },
    (error: unknown) => {
      const fields = typeof error === "object" && error !== null ? error : {};
      const code = "code" in fields ? fields.code : undefined;
      const kind = "kind" in fields ? fields.kind : undefined;
      const tag = typeof code === "string" ? code : typeof kind === "string" ? kind : "UNKNOWN";
      settlement = { kind: "rejected", code: tag, error };
    },
  );
  return () => settlement;
}

function unexpected(what: string, settlement: Settlement): Error {
  return new Error(`the surface peer ${what}: ${settlement.kind === "rejected" ? `${settlement.code} ${String(settlement.error)}` : JSON.stringify(settlement)}`);
}

class Peer {
  clock = 1_000_000;
  retired = false;
  reply: Reply = { tag: "NoReply" };
  readonly page: { id: string; url: string; isCurrent(): boolean } = { id: PAGE, url: `${ORIGIN}/`, isCurrent: () => true };
  admissionPage: SurfacePage | undefined;
  bound: Bound | undefined;
  inFlight: InFlight | undefined;
  native: Gate<SurfaceControlReply> | undefined;
  held: Held | undefined;
  binding: { readonly lost: { value: boolean }; readonly revoked: boolean; readonly settlement: () => Settlement } | undefined;
  bindGate: BindGate | undefined;
  cleanupOkay = true;
  validationDocument = DOCUMENT;
  binds = 0;
  readonly snapshots = new Map<string, string>();
  readonly realNow = Date.now;
  readonly handler: SurfaceTaskHandler;

  constructor() {
    Date.now = () => this.clock;
    this.handler = createSurfaceTaskHandler({
      getPage: () => Promise.resolve(this.admissionPage ?? this.page),
      listPages: () => Promise.resolve([{ id: PAGE }]),
      isCurrent: () => true,
      cleanup: () => Promise.resolve(this.cleanup()),
      control: async (_page, request) => this.control(request),
    });
  }

  control(request: { readonly documentId?: string; readonly command: Readonly<Record<string, unknown>> }): Promise<SurfaceControlReply> | SurfaceControlReply {
    const command = request.command;
    if (command.subaction === "guide") {
      const guidance = command.guidance as { readonly kind?: unknown };
      if (guidance.kind !== "action-status") return { documentId: request.documentId, result: { accepted: true, visible: false } };
      return this.hold("status");
    }
    if (command.validateOnly === true) return { frameScope: "main", documentId: this.validationDocument, result: { validated: true } };
    return this.hold(command.subaction === "snapshot" ? "snapshot" : "input");
  }

  hold(held: Held): Promise<SurfaceControlReply> {
    if (this.native !== undefined) throw new Error(`the surface peer sent a second native request (${held}) while ${this.held} was held`);
    this.native = gate<SurfaceControlReply>();
    this.held = held;
    return this.native.promise;
  }

  release(): Gate<SurfaceControlReply> {
    const native = this.native;
    if (native === undefined) throw new Error("no native request is held");
    this.native = undefined;
    this.held = undefined;
    return native;
  }

  cleanup(): unknown {
    const bindGate = this.bindGate;
    if (bindGate?.armed === true) {
      bindGate.armed = false;
      if (bindGate.released) return { visible: false };
      bindGate.gate = gate<unknown>();
      return bindGate.gate.promise;
    }
    return { visible: !this.cleanupOkay };
  }

  phase(): ReceiverPhase {
    if (this.inFlight === undefined) return "ReceiverIdle";
    if (this.inFlight.spentStale) return "ReceiverChecking";
    if (this.held === "snapshot") return "ReceiverReading";
    if (this.held === "status") return "ReceiverChecking";
    if (this.held === "input") return "ReceiverSending";
    throw unexpected("holds a request with no native step pending", this.inFlight.settlement());
  }

  view(): PeerView {
    return { retired: this.retired, phase: this.phase(), reply: this.reply };
  }

  command(message: PageRequest, scope: CommandScope): Record<string, unknown> {
    const subaction = SUBACTIONS[message.pageAction];
    const input = subaction !== "snapshot" && subaction !== "navigate";
    const bound = this.bound ?? { taskId: "task1", epoch: 0, expiresAt: this.clock };
    const selector = input && message.selectorRef !== "" ? `${snapshotId(message.selectorRef)}:0:${NODE}` : undefined;
    const grant = message.grantId === "" ? undefined : {
      grantId: message.grantId,
      taskId: scope.grantMatches ? bound.taskId : "another-task",
      epoch: bound.epoch,
      origin: ORIGIN,
      targetRef: selector,
      selector: REVIEWED,
      subaction,
      ...(subaction === "click" ? {} : { valueHash: sha256(VALUE) }),
      expiresAt: this.clock + COMMIT_GRANT_MAX_MS / 2,
    };
    return {
      subaction,
      id: PAGE,
      taskContext: { ...OWNER, actorId: scope.contextMatches ? OWNER.actorId : "stranger", taskId: bound.taskId, epoch: bound.epoch },
      taskExpiresAt: this.clock + (scope.commandExpiresAt - scope.now),
      ...(selector === undefined ? {} : { selector }),
      ...(subaction === "fill" || subaction === "select" ? { text: VALUE } : {}),
      ...(subaction === "scroll" ? { direction: "down" } : {}),
      ...(input || !scope.targetReviewed ? { expectedSelector: scope.targetReviewed ? REVIEWED : "#unreviewed" } : {}),
      ...(grant === undefined ? {} : { commitGrant: grant }),
    };
  }

  async spent(requestId: string, command: Record<string, unknown>): Promise<boolean> {
    const probe = track(this.handler({ type: "command", id: requestId, command }));
    await idle();
    const settled = probe();
    return settled.kind === "rejected" && settled.code === "UNCERTAIN_OUTCOME";
  }

  async admitRequest(message: PageRequest, scope: CommandScope): Promise<Outcome> {
    if (this.inFlight !== undefined) return "refused";
    if (this.bound !== undefined) this.clock = this.bound.expiresAt - (scope.bindingExpiresAt - scope.now);
    this.page.url = scope.originAllowed ? `${ORIGIN}/checkout` : `${ELSEWHERE}/checkout`;
    this.admissionPage = scope.pageCurrent ? undefined : { id: PAGE, url: this.page.url, isCurrent: () => false };
    const command = this.command(message, scope);
    const settlement = track(this.handler({ type: "command", id: message.requestId, command }));
    await idle();
    try {
      const settled = settlement();
      if (settled.kind === "rejected" && (settled.code === "INVALID_REQUEST" || (this.retired && settled.code === "STALE_REF"))) return "refused";
      if (settled.kind === "pending") {
        this.inFlight = { message, settlement, spentStale: false };
        this.reply = { tag: "NoReply" };
        return "accepted";
      }
      if (settled.kind === "resolved") throw unexpected("answered a request before its native step", settled);
      if (settled.code === "POLICY_BLOCKED") this.reply = { tag: "Refused", refusal: "RefusedPolicy" };
      else if (settled.code === "UNCERTAIN_OUTCOME") this.reply = { tag: "Reported", status: "Unknown", evidenceRef: "" };
      else if (settled.code !== "STALE_REF") throw unexpected("refused an admission in an unknown way", settled);
      else if (message.pageAction !== "SnapshotAction" && (await this.spent(message.requestId, command))) {
        this.inFlight = { message, settlement, spentStale: true };
        this.reply = { tag: "NoReply" };
      } else this.reply = { tag: "Refused", refusal: "RefusedStale" };
      return "accepted";
    } finally {
      this.admissionPage = undefined;
    }
  }

  async bindTask(offer: BindingOffer): Promise<Outcome> {
    const alreadyReplacing = this.binding !== undefined;
    const before = this.clock;
    const previous = this.bound;
    if (previous !== undefined) this.clock = offer.renewsExpired ? previous.expiresAt : previous.expiresAt - 10;
    const expiresAt = this.clock + 10;
    if (!alreadyReplacing) this.bindGate = { armed: true, released: false, gate: undefined };
    const lost = { value: false };
    this.binds += 1;
    const targets = ["click", "fill", "select", "scroll", "follow"].map((action) => ({ selector: REVIEWED, action }));
    const binding = { tabId: PAGE, bindingRevision: offer.revision, ...OWNER, taskId: offer.taskId, epoch: offer.epoch, origin: ORIGIN, expiresAt, targets, revoked: offer.revoke };
    const settlement = track(this.handler({ type: "task-bind", id: `bind-${this.binds}`, binding }, { signal: { get aborted() { return lost.value; } } }));
    await idle();
    const settled = settlement();
    if (settled.kind === "rejected") {
      if (settled.code !== "POLICY_BLOCKED") throw unexpected("refused a binding in an unknown way", settled);
      this.clock = before;
      if (!alreadyReplacing) this.bindGate = undefined;
      return "refused";
    }
    if (alreadyReplacing) throw unexpected("admitted a second binding before its predecessor settled", settled);
    if (settled.kind !== "pending") throw unexpected("settled a binding before native cleanup", settled);
    this.bound = { taskId: offer.taskId, epoch: offer.epoch, expiresAt };
    this.binding = { lost, revoked: offer.revoke, settlement };
    return "accepted";
  }

  async settleBinding(storedWhileCurrent: boolean): Promise<Outcome> {
    const binding = this.binding;
    if (binding === undefined) return "refused";
    this.binding = undefined;
    binding.lost.value = !storedWhileCurrent;
    this.openBindGate();
    await idle();
    const settled = binding.settlement();
    if (storedWhileCurrent) {
      if (settled.kind !== "resolved" || typeof settled.value !== "object" || settled.value === null
          || !("bound" in settled.value) || settled.value.bound !== !binding.revoked) {
        throw unexpected("did not acknowledge the same binding", settled);
      }
    } else if (settled.kind !== "rejected" || settled.code !== "POLICY_BLOCKED") {
      throw unexpected("kept a retired binding", settled);
    }
    return "accepted";
  }

  openBindGate(): void {
    const bindGate = this.bindGate;
    if (bindGate === undefined) return;
    bindGate.released = true;
    bindGate.gate?.open({ visible: false });
  }

  answered(what: string): Exclude<Settlement, { readonly kind: "pending" }> {
    const settled: Settlement = this.inFlight?.settlement() ?? { kind: "pending" };
    if (settled.kind === "pending") throw unexpected(`did not answer after ${what}`, settled);
    return settled;
  }

  async settleRead(snapshotRef: string, completeForOrigin: boolean): Promise<Outcome> {
    if (this.inFlight === undefined || this.held !== "snapshot") return "refused";
    const id = snapshotId(snapshotRef);
    this.snapshots.set(id, snapshotRef);
    this.release().open({
      frameScope: "main",
      documentId: DOCUMENT,
      result: {
        complete: completeForOrigin,
        ...(snapshotRef === "" ? {} : { snapshotId: id }),
        url: `${ORIGIN}/checkout`,
        elements: [{ id: NODE, role: "button", name: "Continue" }],
        blockers: [],
      },
    });
    await idle();
    const settled = this.answered("its page read");
    this.inFlight = undefined;
    if (settled.kind === "resolved") {
      const read = settled.value as { readonly snapshotId?: unknown };
      const ref = typeof read.snapshotId === "string" ? this.snapshots.get(read.snapshotId) : undefined;
      if (ref === undefined) throw unexpected("reported a page read it never took", settled);
      this.reply = { tag: "Reported", status: "Succeeded", evidenceRef: ref };
    } else if (settled.code === "INCOMPLETE_SNAPSHOT") this.reply = { tag: "Refused", refusal: "RefusedIncomplete" };
    else if (settled.code === "STALE_REF") this.reply = { tag: "Refused", refusal: "RefusedStale" };
    else throw unexpected("failed a page read in an unknown way", settled);
    return "accepted";
  }

  async dispatchInput(previewReady: boolean): Promise<Outcome> {
    const inFlight = this.inFlight;
    if (inFlight === undefined || this.phase() !== "ReceiverChecking") return "refused";
    if (!inFlight.spentStale) {
      this.release().open({ documentId: DOCUMENT, result: previewReady ? { ready: true } : { cancelled: true } });
      await idle();
      if (this.held === "input") return "accepted";
    }
    const settled = this.answered("its input check");
    if (settled.kind !== "rejected" || settled.code !== "STALE_REF") throw unexpected("ended an input check in an unknown way", settled);
    this.inFlight = undefined;
    this.reply = { tag: "Refused", refusal: "RefusedStale" };
    return "accepted";
  }

  async settleInput(confirmed: boolean, cleanupOkay: boolean): Promise<Outcome> {
    const inFlight = this.inFlight;
    if (inFlight === undefined || this.held !== "input") return "refused";
    this.cleanupOkay = cleanupOkay;
    const native = this.release();
    if (confirmed) native.open({ documentId: DOCUMENT, result: { dispatched: true } });
    else native.fail(new Error("the native page did not answer"));
    await idle();
    this.cleanupOkay = true;
    const settled = this.answered("its input");
    this.inFlight = undefined;
    if (settled.kind === "resolved") this.reply = { tag: "Reported", status: "Dispatched", evidenceRef: inFlight.message.selectorRef };
    else if (settled.code === "UNCERTAIN_OUTCOME") this.reply = { tag: "Reported", status: "Unknown", evidenceRef: "" };
    else throw unexpected("failed an input with a retryable error", settled);
    return "accepted";
  }

  checkTarget(selectorRef: string, id: string, grantId?: string): () => Settlement {
    const bound = this.bound;
    const command = {
      subaction: "click" as const,
      id: PAGE,
      taskContext: { ...OWNER, taskId: bound?.taskId ?? "task1", epoch: bound?.epoch ?? 0 },
      selector: `${snapshotId(selectorRef)}:0:${NODE}`,
      expectedSelector: REVIEWED,
      ...(grantId === undefined || bound === undefined ? {} : {
        commitGrant: {
          grantId, taskId: bound.taskId, epoch: bound.epoch, origin: ORIGIN,
          targetRef: `${snapshotId(selectorRef)}:0:${NODE}`, selector: REVIEWED,
          subaction: "click", expiresAt: this.clock + COMMIT_GRANT_MAX_MS / 2,
        },
      }),
    };
    return track(this.handler({ type: "validate-target", id, command }));
  }

  async validateTarget(selectorRef: string): Promise<Outcome> {
    if (this.retired || this.inFlight !== undefined) return "refused";
    const settlement = this.checkTarget(selectorRef, "validate-target");
    await idle();
    const checked = settlement();
    if (checked.kind === "resolved" && typeof checked.value === "object" && checked.value !== null
        && "validated" in checked.value && checked.value.validated === true) this.reply = { tag: "TargetChecked" };
    else if (checked.kind === "rejected" && (checked.code === "STALE_REF" || checked.code === "POLICY_BLOCKED")) {
      this.reply = { tag: "Refused", refusal: "RefusedStale" };
    } else throw unexpected("did not settle native target validation", checked);
    return "accepted";
  }

  async retire(): Promise<Outcome> {
    if (this.retired) return "refused";
    this.retired = true;
    if (this.binding !== undefined) this.binding.lost.value = true;
    this.binding = undefined;
    if (this.bindGate !== undefined) this.bindGate.armed = false;
    this.openBindGate();
    await this.handler.close();
    await idle();
    return "accepted";
  }

  async dispose(): Promise<void> {
    if (!this.retired) await this.retire();
    this.native?.fail(new Error("the driver was reset"));
    this.native = undefined;
    await idle();
    Date.now = this.realNow;
  }
}

let peer: Peer | undefined;
const live = () => (peer ??= new Peer());

export const driver: Driver<PeerView> & AsyncDisposable = {
  reset: async () => {
    await peer?.dispose();
    peer = new Peer();
  },
  dispatch: (_key, event: Event) => {
    switch (event.type) {
      case "admitRequest":
        return live().admitRequest(event.message, event.scope);
      case "bindTask":
        return live().bindTask(event.offer);
      case "settleBinding":
        return live().settleBinding(event.storedWhileCurrent);
      case "settleRead":
        return live().settleRead(event.snapshotRef, event.completeForOrigin);
      case "dispatchInput":
        return live().dispatchInput(event.previewReady);
      case "settleInput":
        return live().settleInput(event.confirmed, event.cleanupOkay);
      case "validateTarget":
        return live().validateTarget(event.selectorRef);
      case "retire":
        return live().retire();
    }
  },
  observe: () => live().view(),
  [Symbol.asyncDispose]: async () => {
    await peer?.dispose();
    peer = undefined;
  },
};

export const options: Options<PeerView> = {
  keys: ["peer"],
  view: (state: SurfaceReceiver): PeerView => ({ retired: state.retired, phase: state.phase, reply: state.reply }),
};

export async function reviewedTarget(input: { readonly selectorRef: string; readonly id: string; readonly grant?: string; readonly currentDocument?: boolean }) {
  const active = live();
  active.validationDocument = input.currentDocument === false ? "changed-document" : DOCUMENT;
  const outcome = active.checkTarget(input.selectorRef, input.id, input.grant);
  await idle();
  active.validationDocument = DOCUMENT;
  const completed = outcome();
  if (completed.kind === "pending") throw unexpected("did not answer target validation", completed);
  return completed.kind === "resolved" ? { result: completed.value } : { code: completed.code };
}
