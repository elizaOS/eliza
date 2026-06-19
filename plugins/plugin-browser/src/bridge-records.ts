import crypto from "node:crypto";
import type {
  BrowserBridgeCompanionStatus,
  BrowserBridgePageContext,
  BrowserBridgeTabSummary,
} from "./contracts.js";

function isoNow(): string {
  return new Date().toISOString();
}

export function createBrowserBridgeCompanionStatus(
  params: Omit<
    BrowserBridgeCompanionStatus,
    | "id"
    | "createdAt"
    | "updatedAt"
    | "pairedAt"
    | "pairingTokenExpiresAt"
    | "pairingTokenRevokedAt"
  > & {
    pairedAt?: string | null;
    pairingTokenExpiresAt?: string | null;
    pairingTokenRevokedAt?: string | null;
  },
): BrowserBridgeCompanionStatus {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    pairedAt: params.pairedAt ?? timestamp,
    pairingTokenExpiresAt: params.pairingTokenExpiresAt ?? null,
    pairingTokenRevokedAt: params.pairingTokenRevokedAt ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createBrowserBridgeTabSummary(
  params: Omit<BrowserBridgeTabSummary, "id" | "createdAt" | "updatedAt">,
): BrowserBridgeTabSummary {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createBrowserBridgePageContext(
  params: Omit<BrowserBridgePageContext, "id">,
): BrowserBridgePageContext {
  return {
    ...params,
    id: crypto.randomUUID(),
  };
}
