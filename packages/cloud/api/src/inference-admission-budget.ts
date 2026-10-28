/** Durable ownership of already-reserved database funds. No method performs network I/O. */
import type { InferenceAdmissionRecoveryContext } from "@elizaos/cloud-shared/lib/services/inference-admission-recovery";
import type {
  InferenceFundingBudgetConsumption,
  InferenceFundingBudgetGrant,
  InferenceFundingBudgetSeal,
} from "@elizaos/cloud-shared/lib/services/inference-funding-budget-protocol";
import { canonicalSettlementJson as identity } from "@elizaos/cloud-shared/lib/services/settlement-digest";
export type InferenceBudgetGrant = InferenceFundingBudgetGrant;
export type InferenceBudgetReceipt = Pick<
  InferenceFundingBudgetConsumption,
  "organizationId" | "requestId" | "amountMicros" | "allocations"
>;

export interface InferenceBudgetRefill {
  id: string;
  ownerRequestId: string;
  minimumMicros: string;
  policyGeneration: string;
  policyEpoch: string;
}

export interface InferenceBudgetRequest {
  requestId: string;
  maximumMicros: string;
  unknownCostMicros: string;
  policyGeneration: string;
  policyEpoch: string;
  preProviderCancellationToken: string;
  createdAt: number;
  expiresAt: number;
  recovery: InferenceAdmissionRecoveryContext;
}

interface RequestState extends InferenceBudgetRequest {
  phase: "dispatched" | "completed" | "cancelled";
  reserved: { grantId: string; amountMicros: string }[];
  receipt?: InferenceBudgetReceipt;
  acknowledged?: boolean;
}

interface GrantState extends InferenceBudgetGrant {
  remainingMicros: string;
  consumedMicros: string;
  lastSequence: number;
  activeLeaseCount: number;
  unacknowledgedReceiptCount: number;
  sealed: boolean;
}

interface Summary {
  organizationId: string;
  grantIds: string[];
  pendingRefill?: InferenceBudgetRefill;
}

export class InferenceBudgetError extends Error {
  constructor(
    readonly code:
      | "INVALID_BUDGET_INPUT"
      | "BUDGET_REPLAY_CONFLICT"
      | "BUDGET_NOT_READY",
    message: string,
  ) {
    super(message);
    this.name = "InferenceBudgetError";
  }
}

function conflict(message: string): never {
  throw new InferenceBudgetError("BUDGET_REPLAY_CONFLICT", message);
}

function micros(value: string, positive = false): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new InferenceBudgetError(
      "INVALID_BUDGET_INPUT",
      "Invalid canonical micro amount",
    );
  }
  const amount = BigInt(value);
  if (positive && amount === 0n)
    throw new InferenceBudgetError(
      "INVALID_BUDGET_INPUT",
      "Budget maximum must be positive",
    );
  return amount;
}

const SUMMARY_KEY = "funding-budget:summary:v1";
const grantKey = (id: string) => `funding-budget:grant:${id}`;
const requestKey = (id: string) => `funding-budget:request:${id}`;
const outboxKey = (id: string) => `funding-budget:outbox:${id}`;
const sealKey = (id: string) => `funding-budget:seal:${id}`;
export type InferenceBudgetSeal = Omit<InferenceFundingBudgetSeal, "signature">;

export type InferenceBudgetReservation =
  | {
      kind: "RESERVED";
      maximumMicros: string;
    }
  | { kind: "COMPLETED"; receipt: InferenceBudgetReceipt }
  | {
      kind: "NEEDS_REFILL";
      shortfallMicros: string;
      refill: InferenceBudgetRefill;
    };

/** Every operation commits only its affected grant, request, and receipt keys. */
export class InferenceAdmissionBudget {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly organizationId: string,
  ) {}

  private async summary(tx: DurableObjectTransaction): Promise<Summary> {
    const value = await tx.get<Summary>(SUMMARY_KEY);
    if (value && value.organizationId !== this.organizationId)
      conflict("Budget storage belongs to another organization");
    return value ?? { organizationId: this.organizationId, grantIds: [] };
  }

  /** Reserve funds and acknowledge dispatch in one durable transaction. */
  async reserve(
    input: InferenceBudgetRequest,
    now = Date.now(),
  ): Promise<InferenceBudgetReservation> {
    const maximum = micros(input.maximumMicros, true);
    if (micros(input.unknownCostMicros) > maximum)
      throw new InferenceBudgetError(
        "INVALID_BUDGET_INPUT",
        "Unknown cost exceeds the authorized maximum",
      );
    micros(input.policyGeneration);
    micros(input.policyEpoch);
    if (
      !input.requestId ||
      !input.preProviderCancellationToken ||
      input.recovery.organizationId !== this.organizationId ||
      input.recovery.requestId !== input.requestId ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(input.createdAt) ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.createdAt < 0 ||
      input.expiresAt <= input.createdAt
    )
      throw new InferenceBudgetError(
        "INVALID_BUDGET_INPUT",
        "Invalid budget request identity",
      );
    return this.storage.transaction<InferenceBudgetReservation>(async (tx) => {
      const summary = await this.summary(tx);
      const existing = await tx.get<RequestState>(requestKey(input.requestId));
      if (existing) {
        const {
          phase: _phase,
          reserved: _reserved,
          receipt: _receipt,
          acknowledged: _ack,
          ...original
        } = existing;
        if (identity(original) !== identity(input))
          conflict("Request replay changes its immutable intent");
        if (existing.receipt)
          return { kind: "COMPLETED", receipt: existing.receipt };

        return {
          kind: "RESERVED",
          maximumMicros: existing.maximumMicros,
        };
      }
      if (input.expiresAt <= now)
        throw new InferenceBudgetError(
          "BUDGET_NOT_READY",
          "Request expired before reservation",
        );
      const grants: GrantState[] = [];
      for (const id of summary.grantIds) {
        const grant = await tx.get<GrantState>(grantKey(id));
        if (!grant) conflict("Budget grant index is incomplete");
        if (
          !grant.sealed &&
          grant.expiresAt > now &&
          grant.policyGeneration === input.policyGeneration
        )
          grants.push(grant);
      }
      grants.sort(
        (a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id),
      );
      const available = grants.reduce(
        (total, grant) => total + micros(grant.remainingMicros),
        0n,
      );
      if (available < maximum) {
        if (!summary.pendingRefill) {
          summary.pendingRefill = {
            id: crypto.randomUUID(),
            ownerRequestId: input.requestId,
            minimumMicros: (maximum - available).toString(),
            policyGeneration: input.policyGeneration,
            policyEpoch: input.policyEpoch,
          };
          await tx.put(SUMMARY_KEY, summary);
        }
        return {
          kind: "NEEDS_REFILL",
          shortfallMicros: (maximum - available).toString(),
          refill: summary.pendingRefill,
        };
      }
      let left = maximum;
      const reserved: RequestState["reserved"] = [];
      const updates: Record<string, unknown> = {};
      for (const grant of grants) {
        if (left === 0n) break;
        const remaining = micros(grant.remainingMicros);
        const amount = remaining < left ? remaining : left;
        if (amount === 0n) continue;
        grant.remainingMicros = (remaining - amount).toString();
        grant.activeLeaseCount++;
        reserved.push({ grantId: grant.id, amountMicros: amount.toString() });
        updates[grantKey(grant.id)] = grant;
        left -= amount;
      }
      updates[requestKey(input.requestId)] = {
        ...input,
        phase: "dispatched",
        reserved,
      } satisfies RequestState;
      await tx.put(updates);
      return {
        kind: "RESERVED",
        maximumMicros: input.maximumMicros,
      };
    });
  }

  /** A lost mint acknowledgement is retried under this exact pending grant ID. */
  async installGrant(grant: InferenceBudgetGrant): Promise<void> {
    micros(grant.amountMicros, true);
    micros(grant.policyGeneration);
    micros(grant.policyEpoch);
    if (
      typeof grant.id !== "string" ||
      grant.id.length === 0 ||
      grant.id.trim() !== grant.id ||
      grant.organizationId !== this.organizationId ||
      !Number.isSafeInteger(grant.expiresAt)
    )
      throw new InferenceBudgetError(
        "INVALID_BUDGET_INPUT",
        "Invalid budget grant scope",
      );
    await this.storage.transaction(async (tx) => {
      const summary = await this.summary(tx);
      const existing = await tx.get<GrantState>(grantKey(grant.id));
      if (existing) {
        for (const field of [
          "id",
          "organizationId",
          "amountMicros",
          "expiresAt",
          "policyGeneration",
          "policyEpoch",
        ] as const)
          if (existing[field] !== grant[field])
            conflict("Grant replay changes its immutable receipt");
        return;
      }
      const pending = summary.pendingRefill;
      if (
        !pending ||
        pending.id !== grant.id ||
        pending.policyGeneration !== grant.policyGeneration ||
        pending.policyEpoch !== grant.policyEpoch
      )
        conflict("Grant does not match the pending refill");
      if (micros(grant.amountMicros) < micros(pending.minimumMicros))
        conflict("Grant is smaller than its durable refill minimum");
      const stored: GrantState = {
        ...grant,
        remainingMicros: grant.amountMicros,
        consumedMicros: "0",
        lastSequence: 0,
        activeLeaseCount: 0,
        unacknowledgedReceiptCount: 0,
        sealed: false,
      };
      summary.grantIds.push(grant.id);
      delete summary.pendingRefill;
      await tx.put({ [SUMMARY_KEY]: summary, [grantKey(grant.id)]: stored });
    });
  }

  /** Clear only after the database proves no grant was committed. Unknown outcomes retain ownership. */
  async rejectRefill(id: string): Promise<void> {
    await this.storage.transaction(async (tx) => {
      const summary = await this.summary(tx);
      if (summary.pendingRefill?.id !== id)
        conflict("Refill outcome belongs to another operation");
      delete summary.pendingRefill;
      await tx.put(SUMMARY_KEY, summary);
    });
  }

  async complete(
    requestId: string,
    amountMicros: string,
  ): Promise<InferenceBudgetReceipt> {
    return this.finish(requestId, amountMicros, "completed");
  }

  private async finish(
    requestId: string,
    amountMicros: string,
    phase: "completed" | "cancelled",
    token?: string,
  ): Promise<InferenceBudgetReceipt> {
    const actual = micros(amountMicros);
    return this.storage.transaction(async (tx) => {
      await this.summary(tx);
      const request = await tx.get<RequestState>(requestKey(requestId));
      if (!request) conflict("Completion has no reservation");
      if (token !== undefined && request.preProviderCancellationToken !== token)
        conflict("Cancellation capability does not match the reservation");
      if (request.receipt) {
        if (request.receipt.amountMicros !== amountMicros)
          conflict("Completion replay changes its charge");
        return request.receipt;
      }
      if (actual > 0n && request.phase !== "dispatched")
        conflict("A positive charge requires durable dispatch acknowledgement");
      if (actual > micros(request.maximumMicros))
        conflict("Actual charge exceeds the authorized hard maximum");
      const receipt: InferenceBudgetReceipt = {
        organizationId: this.organizationId,
        requestId,
        amountMicros,
        allocations: [],
      };
      let left = actual;
      const updates: Record<string, unknown> = {};
      for (const allocation of request.reserved) {
        const grant = await tx.get<GrantState>(grantKey(allocation.grantId));
        if (!grant || grant.sealed)
          conflict("Reserved grant is missing or sealed");
        const reserved = micros(allocation.amountMicros);
        const used = reserved < left ? reserved : left;
        grant.remainingMicros = (
          micros(grant.remainingMicros) +
          reserved -
          used
        ).toString();
        grant.consumedMicros = (micros(grant.consumedMicros) + used).toString();
        grant.activeLeaseCount--;
        grant.unacknowledgedReceiptCount++;
        if (used > 0n) {
          if (!Number.isSafeInteger(grant.lastSequence + 1))
            conflict("Grant sequence is exhausted");
          receipt.allocations.push({
            grantId: grant.id,
            sequence: ++grant.lastSequence,
            amountMicros: used.toString(),
          });
        }
        left -= used;
        updates[grantKey(grant.id)] = grant;
      }
      request.phase = phase;
      request.receipt = receipt;
      updates[requestKey(requestId)] = request;
      updates[outboxKey(requestId)] = receipt;
      await tx.put(updates);
      return receipt;
    });
  }

  /** The capability stays with the caller only until provider forwarding. */
  async cancel(
    requestId: string,
    token: string,
  ): Promise<InferenceBudgetReceipt> {
    return this.finish(requestId, "0", "cancelled", token);
  }

  async readRequest(
    requestId: string,
  ): Promise<Readonly<RequestState> | undefined> {
    return this.storage.transaction(async (tx) => {
      await this.summary(tx);
      return tx.get<RequestState>(requestKey(requestId));
    });
  }

  async acknowledge(receipt: InferenceBudgetReceipt): Promise<void> {
    await this.storage.transaction(async (tx) => {
      await this.summary(tx);
      const request = await tx.get<RequestState>(requestKey(receipt.requestId));
      if (!request?.receipt || identity(request.receipt) !== identity(receipt))
        conflict("Acknowledgement differs from the durable receipt");
      if (request.acknowledged) return;
      const updates: Record<string, unknown> = {};
      for (const allocation of request.reserved) {
        const grant = await tx.get<GrantState>(grantKey(allocation.grantId));
        if (!grant || grant.unacknowledgedReceiptCount <= 0)
          conflict("Receipt acknowledgement lost its grant");
        grant.unacknowledgedReceiptCount--;
        updates[grantKey(grant.id)] = grant;
      }
      request.acknowledged = true;
      updates[requestKey(receipt.requestId)] = request;
      await tx.put(updates);
      await tx.delete(outboxKey(receipt.requestId));
    });
  }

  /** Root signs this immutable proof only after durable database receipt acknowledgement. */
  async sealGrant(id: string): Promise<{
    organizationId: string;
    grantId: string;
    lastSequence: number;
    consumedMicros: string;
  }> {
    return this.storage.transaction(async (tx) => {
      const summary = await this.summary(tx);
      const grant = await tx.get<GrantState>(grantKey(id));
      if (!grant) conflict("Unknown grant cannot be sealed");
      if (
        grant.activeLeaseCount !== 0 ||
        grant.unacknowledgedReceiptCount !== 0
      )
        throw new InferenceBudgetError(
          "BUDGET_NOT_READY",
          "Grant still has active or unacknowledged work",
        );
      grant.sealed = true;
      summary.grantIds = summary.grantIds.filter(
        (candidate) => candidate !== id,
      );
      const proof = {
        organizationId: this.organizationId,
        grantId: id,
        lastSequence: grant.lastSequence,
        consumedMicros: grant.consumedMicros,
      };
      await tx.put({
        [SUMMARY_KEY]: summary,
        [grantKey(id)]: grant,
        [sealKey(id)]: proof,
      });
      return proof;
    });
  }

  async readPendingRefill(): Promise<InferenceBudgetRefill | undefined> {
    return this.storage.transaction(
      async (tx) => (await this.summary(tx)).pendingRefill,
    );
  }

  async readGrants(): Promise<Readonly<GrantState>[]> {
    return this.storage.transaction(async (tx) => {
      const summary = await this.summary(tx);
      const result: GrantState[] = [];
      for (const id of summary.grantIds) {
        const grant = await tx.get<GrantState>(grantKey(id));
        if (!grant) conflict("Budget grant index is incomplete");
        result.push(grant);
      }
      return result;
    });
  }

  async requests(options: {
    limit: number;
    startAfter?: string;
  }): Promise<Map<string, RequestState>> {
    return this.storage.list<RequestState>({
      prefix: "funding-budget:request:",
      ...options,
    });
  }

  async pendingSeals(options: {
    limit: number;
    startAfter?: string;
  }): Promise<Map<string, InferenceBudgetSeal>> {
    return this.storage.list<InferenceBudgetSeal>({
      prefix: "funding-budget:seal:",
      ...options,
    });
  }
  async acknowledgeSeal(proof: InferenceBudgetSeal): Promise<void> {
    await this.storage.transaction(async (tx) => {
      await this.summary(tx);
      const grant = await tx.get<GrantState>(grantKey(proof.grantId));
      if (
        !grant?.sealed ||
        identity(proof) !==
          identity({
            organizationId: this.organizationId,
            grantId: grant.id,
            lastSequence: grant.lastSequence,
            consumedMicros: grant.consumedMicros,
          })
      )
        conflict("Seal acknowledgement differs from its immutable proof");
      await tx.delete(sealKey(proof.grantId));
    });
  }

  async pendingReceipts(options: {
    limit: number;
    startAfter?: string;
  }): Promise<Map<string, InferenceBudgetReceipt>> {
    return this.storage.list<InferenceBudgetReceipt>({
      prefix: "funding-budget:outbox:",
      ...options,
    });
  }
}
