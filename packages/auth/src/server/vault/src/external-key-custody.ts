import type { ChainFamily } from "../../shared/src/index.ts";

export type ExternalKeySigningAvailability =
  | "not-supported"
  | "provider-signing";

/** Public compatibility marker for operator-supplied custody providers. */
export const EXTERNAL_KEY_CUSTODY_CONTRACT_VERSION = 1 as const;

export interface ExternalKeyHandleDescriptor {
  providerId: string;
  keyId: string;
  version?: string;
  region?: string;
  metadata?: Record<string, unknown>;
}

export interface ExternalKeyHandleImportRequest {
  tenantId: string;
  agentId: string;
  chainFamily: ChainFamily;
  address: string;
  handle: ExternalKeyHandleDescriptor;
  venue?: string | null;
  purpose?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ExternalKeyHandleExportRequest {
  tenantId: string;
  agentId: string;
  chainFamily: ChainFamily;
  venue?: string | null;
}

export interface ExternalKeySignTransactionRequest {
  tenantId: string;
  agentId: string;
  chainFamily: Extract<ChainFamily, "evm" | "solana">;
  address: string;
  handle: ExternalKeyHandleDescriptor;
  venue?: string | null;
  chainId: number;
  to: string;
  value: string;
  data?: string;
  gasLimit?: string;
  nonce?: number;
  broadcast: boolean;
  rpcUrl?: string;
  /**
   * Durable pre-broadcast checkpoint. Providers that can derive the final
   * transaction hash MUST await this before the first mutating RPC call.
   */
  onPreparedBroadcast?: (transactionHash: string) => Promise<void>;
}

export interface ExternalKeySignTransactionResult {
  result: string;
  broadcast: boolean;
}

/**
 * Signed EVM bytes have reached a mutating RPC boundary, but Steward could not
 * prove whether the RPC accepted them. The locally-derived transaction hash is
 * safe to expose and is the only identifier callers may reconcile; provider
 * errors and signed bytes deliberately remain private.
 *
 * The historical class and wire-code names are retained for compatibility,
 * but this fail-closed envelope now covers both external and local EVM custody.
 */
export class ExternalBroadcastOutcomeUnknownError extends Error {
  readonly code = "external_broadcast_outcome_unknown" as const;

  constructor(
    readonly transactionHash: string,
    options?: { cause?: unknown },
  ) {
    super("EVM broadcast outcome is unknown", options);
    this.name = "ExternalBroadcastOutcomeUnknownError";
  }
}

/** A Solana RPC preflight rejection proves the signed bytes were not submitted. */
export class SolanaBroadcastNotSubmittedError extends Error {
  readonly transactionHash: string;

  constructor(transactionHash: string, options?: { cause?: unknown }) {
    super("Solana transaction was rejected before submission", options);
    this.name = "SolanaBroadcastNotSubmittedError";
    this.transactionHash = transactionHash;
  }
}

export interface ExternalKeyHandleRegistration {
  custody: "external";
  tenantId: string;
  agentId: string;
  chainFamily: ChainFamily;
  address: string;
  handle: ExternalKeyHandleDescriptor;
  venue: string | null;
  purpose: string | null;
  metadata: Record<string, unknown>;
  registeredAt: Date;
  exportablePrivateKey: false;
  signingAvailability: ExternalKeySigningAvailability;
}

export interface ExternalKeyCustodyProvider {
  id: string;
  readonly contractVersion: typeof EXTERNAL_KEY_CUSTODY_CONTRACT_VERSION;
  registerKeyHandle(
    request: ExternalKeyHandleImportRequest,
  ): Promise<ExternalKeyHandleRegistration>;
  exportKeyHandle?(
    request: ExternalKeyHandleExportRequest,
  ): Promise<ExternalKeyHandleRegistration>;
  signTransaction?(
    request: ExternalKeySignTransactionRequest,
  ): Promise<ExternalKeySignTransactionResult>;
}

export function assertExternalKeyCustodyProviderV1(
  provider: ExternalKeyCustodyProvider,
): void {
  if (provider.contractVersion !== EXTERNAL_KEY_CUSTODY_CONTRACT_VERSION) {
    throw new Error(
      `Unsupported external key custody contract version: ${String(provider.contractVersion)}`,
    );
  }
  if (
    !provider.id?.trim() ||
    typeof provider.registerKeyHandle !== "function"
  ) {
    throw new Error(
      "External key custody provider does not implement the v1 registration contract",
    );
  }
}

const PRIVATE_MATERIAL_FIELD_NAMES = new Set([
  "privatekey",
  "secretkey",
  "signingkey",
  "encryptionkey",
  "keymaterial",
  "plaintextkey",
  "mnemonic",
  "recoveryphrase",
  "seed",
  "seedphrase",
  "secretaccesskey",
  "awssecretaccesskey",
  "sessiontoken",
]);

const MAX_EXTERNAL_CUSTODY_OBJECT_DEPTH = 32;
const MAX_EXTERNAL_CUSTODY_OBJECT_NODES = 10_000;

export function externalKeyCustodyUnavailableError(): Error {
  return new Error(
    "External key custody provider is not configured; hardware/HSM handle import is disabled",
  );
}

export function externalKeySigningUnavailableError(): Error {
  return new Error(
    "External key custody signing provider is not configured for this wallet; hardware/HSM signing is disabled",
  );
}

export function externalKeyPrivateExportUnavailableError(): Error {
  return new Error("External key custody private keys are not exportable");
}

export function assertNoExternalPrivateKeyMaterial(
  value: unknown,
  path = "request",
): void {
  const seen = new WeakSet<object>();
  let visitedNodes = 0;

  function visit(current: unknown, currentPath: string, depth: number): void {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    )
      return;
    if (depth > MAX_EXTERNAL_CUSTODY_OBJECT_DEPTH) {
      throw new Error(
        `External key custody ${currentPath} exceeds the maximum nesting depth`,
      );
    }
    if (++visitedNodes > MAX_EXTERNAL_CUSTODY_OBJECT_NODES) {
      throw new Error("External key custody object exceeds the maximum size");
    }
    if (seen.has(current)) {
      throw new Error(
        `External key custody ${currentPath} must not contain cyclic references`,
      );
    }
    seen.add(current);

    if (current instanceof Date) {
      if (!Number.isFinite(current.getTime())) {
        throw new Error(
          `External key custody ${currentPath} contains an invalid date`,
        );
      }
      seen.delete(current);
      return;
    }

    const prototype = Object.getPrototypeOf(current);
    if (
      prototype !== Object.prototype &&
      prototype !== null &&
      !Array.isArray(current)
    ) {
      throw new Error(
        `External key custody ${currentPath} must contain plain data only`,
      );
    }

    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string") {
        throw new Error(
          `External key custody ${currentPath} must not contain symbol properties`,
        );
      }
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (PRIVATE_MATERIAL_FIELD_NAMES.has(normalizedKey)) {
        throw new Error(
          `External key custody ${currentPath}.${key} must not contain private key material`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new Error(
          `External key custody ${currentPath}.${key} must be a data property`,
        );
      }
      visit(descriptor.value, `${currentPath}.${key}`, depth + 1);
    }
    seen.delete(current);
  }

  visit(value, path, 0);
}

function sameAddress(
  chainFamily: ChainFamily,
  actual: string,
  expected: string,
): boolean {
  return chainFamily === "evm"
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
}

function assertRegistrationIdentityBinding(
  request: ExternalKeyHandleImportRequest,
  registration: ExternalKeyHandleRegistration,
): void {
  if (
    registration.tenantId !== request.tenantId ||
    registration.agentId !== request.agentId ||
    registration.chainFamily !== request.chainFamily ||
    !sameAddress(request.chainFamily, registration.address, request.address) ||
    registration.handle.providerId !== request.handle.providerId ||
    registration.handle.keyId !== request.handle.keyId ||
    registration.handle.version !== request.handle.version ||
    registration.handle.region !== request.handle.region
  ) {
    throw new Error(
      "External key custody provider did not preserve the requested identity binding",
    );
  }
}

export function normalizeExternalKeyHandleRegistration(
  request: ExternalKeyHandleImportRequest,
  registration: ExternalKeyHandleRegistration,
): ExternalKeyHandleRegistration {
  assertNoExternalPrivateKeyMaterial(registration, "registration");
  assertRegistrationIdentityBinding(request, registration);
  if (registration.exportablePrivateKey !== false) {
    throw new Error(
      "External key custody registration must not be private-key exportable",
    );
  }
  if (
    registration.signingAvailability !== "not-supported" &&
    registration.signingAvailability !== "provider-signing"
  ) {
    throw new Error(
      "External key custody signingAvailability is not supported",
    );
  }
  return {
    ...registration,
    custody: "external",
    tenantId: request.tenantId,
    agentId: request.agentId,
    chainFamily: request.chainFamily,
    address: request.address,
    venue: request.venue ?? null,
    purpose: request.purpose ?? null,
    exportablePrivateKey: false,
    signingAvailability: registration.signingAvailability,
  };
}

export class FailClosedExternalKeyCustodyProvider
  implements ExternalKeyCustodyProvider
{
  id = "external-key-custody-disabled";
  readonly contractVersion = EXTERNAL_KEY_CUSTODY_CONTRACT_VERSION;

  async registerKeyHandle(): Promise<ExternalKeyHandleRegistration> {
    throw externalKeyCustodyUnavailableError();
  }

  async exportKeyHandle(): Promise<ExternalKeyHandleRegistration> {
    throw externalKeyCustodyUnavailableError();
  }
}

export class InMemoryExternalKeyCustodyProvider
  implements ExternalKeyCustodyProvider
{
  id: string;
  readonly contractVersion = EXTERNAL_KEY_CUSTODY_CONTRACT_VERSION;
  private registrations = new Map<string, ExternalKeyHandleRegistration>();

  constructor(id = "in-memory-external-key-custody") {
    this.id = id;
  }

  async registerKeyHandle(
    request: ExternalKeyHandleImportRequest,
  ): Promise<ExternalKeyHandleRegistration> {
    assertNoExternalPrivateKeyMaterial(request);
    const registration: ExternalKeyHandleRegistration = {
      custody: "external",
      tenantId: request.tenantId,
      agentId: request.agentId,
      chainFamily: request.chainFamily,
      address: request.address,
      handle: request.handle,
      venue: request.venue ?? null,
      purpose: request.purpose ?? null,
      metadata: request.metadata ?? {},
      registeredAt: new Date(),
      exportablePrivateKey: false,
      signingAvailability: "not-supported",
    };
    this.registrations.set(this.registrationKey(request), registration);
    return registration;
  }

  async exportKeyHandle(
    request: ExternalKeyHandleExportRequest,
  ): Promise<ExternalKeyHandleRegistration> {
    const registration = this.registrations.get(this.registrationKey(request));
    if (!registration) {
      throw new Error("External key handle is not registered");
    }
    return registration;
  }

  private registrationKey(request: ExternalKeyHandleExportRequest): string {
    return [
      request.tenantId,
      request.agentId,
      request.chainFamily,
      request.venue ?? "",
    ].join(":");
  }
}
