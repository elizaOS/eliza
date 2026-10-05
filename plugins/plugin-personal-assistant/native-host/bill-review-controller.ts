/** Explicit host-driven review sequencing. This is not a payment authorization
 * service: ports must enforce account access, provenance and provider matching. */
export type BillReviewStep = "search" | "read" | "observe" | "submit";
export type BillReviewFailure =
  | "missing-bill"
  | "missing-message"
  | "ambiguous-message"
  | "changed-message"
  | "invalid-review"
  | "invalid-observation"
  | "unknown-outcome"
  | "cancelled";
export class BillReviewError extends Error {
  readonly code: BillReviewFailure;
  constructor(code: BillReviewFailure) {
    super(code);
    this.code = code;
    this.name = "BillReviewError";
  }
}
export interface ReviewRecord {
  id: string;
  accountLabel: string;
  paymentMethodLabel: string;
  amount: { amountMinor: number };
  fee: { amountMinor: number };
}
export interface ReviewObservation {
  billId: string;
  status: "accepted" | "pending" | "unknown";
  observedAt: string;
}
export interface BillReviewPorts<O extends ReviewObservation> {
  currentBillId(): string | undefined;
  list(): Promise<{ id: string; billId?: string }[]>;
  read(id: string): Promise<{ id: string; billId?: string }>;
  get(id: string): Promise<ReviewRecord>;
  observe(): Promise<O | null>;
  /** Call beforeDispatch immediately before the effect, and abort if it throws. */
  submit(active: () => boolean, beforeDispatch: () => void): Promise<O | null>;
  /** Scope to owner/account and bill; methods must throw on persistence failure. */
  pending: {
    has(billId: string): boolean;
    set(billId: string): void;
    clear(billId: string): void;
  };
}
export interface BillReviewCallbacks<O> {
  complete(observation: O | null): void;
  error(error: unknown): void;
  settled(): void;
}

export class BillReviewController<O extends ReviewObservation> {
  private generation = 0;
  private running = false;
  private selected: { billId: string; messageId: string } | null = null;
  private readonly ports: BillReviewPorts<O>;
  constructor(ports: BillReviewPorts<O>) {
    this.ports = ports;
  }
  get pending(): boolean {
    return this.running;
  }
  /** Invalidates callbacks and selected metadata, never a durable pending effect. */
  cancel(): void {
    this.generation++;
    this.running = false;
    this.selected = null;
  }

  async run(
    step: BillReviewStep,
    callbacks: BillReviewCallbacks<O>,
  ): Promise<void> {
    if (this.running) return;
    this.running = true;
    const ticket = ++this.generation;
    const billId = this.ports.currentBillId();
    const active = () =>
      ticket === this.generation && billId === this.ports.currentBillId();
    try {
      if (!billId) throw new BillReviewError("missing-bill");
      let observation: O | null = null;
      if (step === "search" || step === "read") {
        let messageId =
          this.selected?.billId === billId
            ? this.selected.messageId
            : undefined;
        if (step === "search" || !messageId) {
          const messages = await this.ports.list();
          if (!active()) return;
          const matches = messages.filter(
            (message) => message.billId === billId,
          );
          if (matches.length !== 1)
            throw new BillReviewError(
              matches.length ? "ambiguous-message" : "missing-message",
            );
          messageId = matches[0].id;
          if (!messageId) throw new BillReviewError("changed-message");
          this.selected = { billId, messageId };
        }
        if (step === "read") {
          const message = await this.ports.read(messageId);
          if (!active()) return;
          if (message.id !== messageId || message.billId !== billId)
            throw new BillReviewError("changed-message");
          const record = await this.ports.get(billId);
          if (!active()) return;
          if (
            record.id !== billId ||
            !record.accountLabel?.trim() ||
            !record.paymentMethodLabel?.trim() ||
            !Number.isSafeInteger(record.amount?.amountMinor) ||
            record.amount.amountMinor < 0 ||
            !Number.isSafeInteger(record.fee?.amountMinor) ||
            record.fee.amountMinor < 0
          ) {
            throw new BillReviewError("invalid-review");
          }
        }
      } else if (step === "observe" || step === "submit") {
        if (step === "observe" || this.ports.pending.has(billId)) {
          observation = await this.ports.observe();
        } else {
          let dispatched = false;
          observation = await this.ports.submit(active, () => {
            if (!active() || dispatched) throw new BillReviewError("cancelled");
            // A synchronous durable write must succeed before crossing the effect boundary.
            this.ports.pending.set(billId);
            dispatched = true;
          });
        }
        if (!active()) return;
        if (
          observation &&
          (observation.billId !== billId ||
            !["accepted", "pending", "unknown"].includes(observation.status) ||
            typeof observation.observedAt !== "string" ||
            !observation.observedAt.trim())
        ) {
          throw new BillReviewError("invalid-observation");
        }
        if (step === "submit") {
          if (!observation) throw new BillReviewError("unknown-outcome");
          if (observation.status !== "unknown")
            this.ports.pending.clear(billId);
          else this.ports.pending.set(billId);
        }
      }
      if (active()) callbacks.complete(observation);
    } catch (error) {
      if (active()) callbacks.error(error);
    } finally {
      if (ticket === this.generation) {
        this.running = false;
        if (active()) callbacks.settled();
      }
    }
  }
}

/** Read-only latest-result lookup, including task-id admission and stale fencing. */
export class LatestOutcomeController {
  private generation = 0;
  cancel(): void {
    this.generation++;
  }
  async refresh(
    request: () => Promise<unknown>,
    receive: (id: string | null) => void,
  ): Promise<void> {
    const ticket = ++this.generation;
    let id: string | null = null;
    try {
      const result = (await request()) as {
        outcome?: { taskId?: unknown } | null;
      } | null;
      const value = result?.outcome?.taskId;
      if (
        typeof value === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(value)
      )
        id = value;
    } catch (error) {
      // A failed lookup provides no evidence that the active task is absent.
      if (ticket === this.generation) throw error;
      return;
    }
    if (ticket === this.generation) receive(id);
  }
}
