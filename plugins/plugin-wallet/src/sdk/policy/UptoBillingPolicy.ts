/**
 * UptoBillingPolicy
 *
 * Local accounting for x402 "upto" flows where a buyer authorizes a maximum
 * amount up front and the seller later settles only actual usage.
 *
 * The policy tracks three things:
 * - the max amount authorized
 * - the amount actually settled
 * - ledger deltas for reservation, settlement, and release of unused capacity
 */

export type UptoAuthorizationStatus =
  | "authorized"
  | "partially_settled"
  | "settled"
  | "released";

export interface UptoAuthorizationRequest {
  authorizationId?: string;
  service: string;
  resource?: string;
  network: string;
  asset: string;
  payTo: string;
  maxAmount: bigint;
  metadata?: Record<string, unknown>;
  authorizedAt?: string;
}

export interface UptoSettlementOptions {
  settledAt?: string;
  finalize?: boolean;
  txHash?: string;
  reference?: string;
  metadata?: Record<string, unknown>;
}

export interface UptoSettlementRecord {
  settlementId: string;
  authorizationId: string;
  amount: bigint;
  settledAt: string;
  txHash?: string;
  reference?: string;
  metadata?: Record<string, unknown>;
}

export interface UptoAuthorizationRecord {
  authorizationId: string;
  service: string;
  resource?: string;
  network: string;
  asset: string;
  payTo: string;
  maxAmount: bigint;
  settledAmount: bigint;
  releasedAmount: bigint;
  remainingAmount: bigint;
  authorizedAt: string;
  finalizedAt?: string;
  status: UptoAuthorizationStatus;
  metadata?: Record<string, unknown>;
}

export interface WalletLedgerDelta {
  deltaId: string;
  authorizationId: string;
  type: "authorization" | "settlement" | "release";
  timestamp: string;
  reservedDelta: bigint;
  settledDelta: bigint;
  netWalletDelta: bigint;
  txHash?: string;
  reference?: string;
}

export interface UptoBillingSnapshot {
  authorization: UptoAuthorizationRecord;
  settlements: UptoSettlementRecord[];
  ledgerDeltas: WalletLedgerDelta[];
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

function nowIso(value?: string): string {
  return value ?? new Date().toISOString();
}

function cloneAuthorization(
  record: UptoAuthorizationRecord,
): UptoAuthorizationRecord {
  return {
    ...record,
    metadata: record.metadata ? { ...record.metadata } : undefined,
  };
}

function cloneSettlement(record: UptoSettlementRecord): UptoSettlementRecord {
  return {
    ...record,
    metadata: record.metadata ? { ...record.metadata } : undefined,
  };
}

function cloneDelta(record: WalletLedgerDelta): WalletLedgerDelta {
  return { ...record };
}

export class UptoBillingPolicy {
  private authorizations = new Map<string, UptoAuthorizationRecord>();
  private settlements = new Map<string, UptoSettlementRecord[]>();
  private ledger = new Map<string, WalletLedgerDelta[]>();

  authorize(request: UptoAuthorizationRequest): UptoAuthorizationRecord {
    if (request.maxAmount <= 0n) {
      throw new Error("maxAmount must be greater than zero");
    }

    const authorizationId = request.authorizationId ?? nextId("upto-auth");
    if (this.authorizations.has(authorizationId)) {
      throw new Error(`Authorization already exists: ${authorizationId}`);
    }

    const record: UptoAuthorizationRecord = {
      authorizationId,
      service: request.service,
      resource: request.resource,
      network: request.network,
      asset: request.asset,
      payTo: request.payTo,
      maxAmount: request.maxAmount,
      settledAmount: 0n,
      releasedAmount: 0n,
      remainingAmount: request.maxAmount,
      authorizedAt: nowIso(request.authorizedAt),
      status: "authorized",
      metadata: request.metadata ? { ...request.metadata } : undefined,
    };

    this.authorizations.set(authorizationId, record);
    this.settlements.set(authorizationId, []);
    this.ledger.set(authorizationId, [
      {
        deltaId: nextId("upto-ledger"),
        authorizationId,
        type: "authorization",
        timestamp: record.authorizedAt,
        reservedDelta: record.maxAmount,
        settledDelta: 0n,
        netWalletDelta: 0n,
      },
    ]);

    return cloneAuthorization(record);
  }

  recordSettlement(
    authorizationId: string,
    amount: bigint,
    options: UptoSettlementOptions = {},
  ): UptoBillingSnapshot {
    const auth = this.requireAuthorization(authorizationId);

    if (auth.status === "settled" || auth.status === "released") {
      throw new Error(`Authorization is already finalized: ${authorizationId}`);
    }
    if (amount <= 0n) {
      throw new Error("Settlement amount must be greater than zero");
    }
    if (amount > auth.remainingAmount) {
      throw new Error(
        `Settlement amount ${amount} exceeds remaining authorized amount ${auth.remainingAmount}`,
      );
    }

    const settledAt = nowIso(options.settledAt);
    const settlement: UptoSettlementRecord = {
      settlementId: nextId("upto-settlement"),
      authorizationId,
      amount,
      settledAt,
      txHash: options.txHash,
      reference: options.reference,
      metadata: options.metadata ? { ...options.metadata } : undefined,
    };

    auth.settledAmount += amount;
    auth.remainingAmount -= amount;
    auth.status = auth.remainingAmount === 0n ? "settled" : "partially_settled";

    const settlementList = this.settlements.get(authorizationId);
    if (!settlementList) {
      throw new Error(
        `[UptoBillingPolicy] Missing settlements for authorization ${authorizationId}`,
      );
    }
    settlementList.push(settlement);

    const ledger = this.ledger.get(authorizationId);
    if (!ledger) {
      throw new Error(
        `[UptoBillingPolicy] Missing ledger for authorization ${authorizationId}`,
      );
    }
    ledger.push({
      deltaId: nextId("upto-ledger"),
      authorizationId,
      type: "settlement",
      timestamp: settledAt,
      reservedDelta: -amount,
      settledDelta: amount,
      netWalletDelta: -amount,
      txHash: options.txHash,
      reference: options.reference,
    });

    if (options.finalize) {
      this.finalizeAuthorization(authorizationId, settledAt, options.reference);
    }

    return this.getSnapshot(authorizationId);
  }

  finalizeAuthorization(
    authorizationId: string,
    finalizedAt?: string,
    reference?: string,
  ): UptoAuthorizationRecord {
    const auth = this.requireAuthorization(authorizationId);
    const ledger = this.ledger.get(authorizationId);
    if (!ledger) {
      throw new Error(
        `[UptoBillingPolicy] Missing ledger for authorization ${authorizationId}`,
      );
    }
    const timestamp = nowIso(finalizedAt);

    if (auth.status === "settled" || auth.status === "released") {
      auth.finalizedAt = auth.finalizedAt ?? timestamp;
      return cloneAuthorization(auth);
    }

    const released = auth.remainingAmount;
    auth.releasedAmount += released;
    auth.remainingAmount = 0n;
    auth.finalizedAt = timestamp;
    auth.status = auth.settledAmount > 0n ? "settled" : "released";

    if (released > 0n) {
      ledger.push({
        deltaId: nextId("upto-ledger"),
        authorizationId,
        type: "release",
        timestamp,
        reservedDelta: -released,
        settledDelta: 0n,
        netWalletDelta: 0n,
        reference,
      });
    }

    return cloneAuthorization(auth);
  }

  getAuthorization(authorizationId: string): UptoAuthorizationRecord | null {
    const auth = this.authorizations.get(authorizationId);
    return auth ? cloneAuthorization(auth) : null;
  }

  listAuthorizations(): UptoAuthorizationRecord[] {
    return Array.from(this.authorizations.values()).map(cloneAuthorization);
  }

  getSettlements(authorizationId: string): UptoSettlementRecord[] {
    return (this.settlements.get(authorizationId) ?? []).map(cloneSettlement);
  }

  getWalletLedgerDeltas(authorizationId: string): WalletLedgerDelta[] {
    return (this.ledger.get(authorizationId) ?? []).map(cloneDelta);
  }

  getSnapshot(authorizationId: string): UptoBillingSnapshot {
    return {
      authorization: cloneAuthorization(
        this.requireAuthorization(authorizationId),
      ),
      settlements: this.getSettlements(authorizationId),
      ledgerDeltas: this.getWalletLedgerDeltas(authorizationId),
    };
  }

  getNetWalletDelta(authorizationId: string): bigint {
    return this.getWalletLedgerDeltas(authorizationId).reduce(
      (sum, delta) => sum + delta.netWalletDelta,
      0n,
    );
  }

  getReservedAmount(authorizationId: string): bigint {
    return this.getWalletLedgerDeltas(authorizationId).reduce(
      (sum, delta) => sum + delta.reservedDelta,
      0n,
    );
  }

  private requireAuthorization(
    authorizationId: string,
  ): UptoAuthorizationRecord {
    const auth = this.authorizations.get(authorizationId);
    if (!auth) {
      throw new Error(`Unknown authorization: ${authorizationId}`);
    }
    return auth;
  }
}
