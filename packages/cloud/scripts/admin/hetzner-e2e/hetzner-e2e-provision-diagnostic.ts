#!/usr/bin/env bun
/**
 * Defines the privacy-safe provisioning failure record consumed by the Hetzner
 * E2E workflow. The workflow renders operator guidance from this validated
 * record instead of inferring causes from human-readable error text.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { HetznerCloudError } from "@elizaos/cloud-shared/lib/services/containers/hetzner-cloud-api";

export type CapacityInventory = {
  totalServers: number;
  hetznerE2eServers: number;
  otherServers: number;
  byStatus: Record<string, number>;
  byServerType: Record<string, number>;
  byLocation: Record<string, number>;
};

export type ProvisionFailureKind = "authentication" | "quota" | "other";

export type ProvisionFailureDiagnostic = {
  version: 1;
  kind: ProvisionFailureKind;
  code: string | null;
  status: number | null;
  inventory: CapacityInventory | null;
  inventoryError: {
    code: string | null;
    status: number | null;
  } | null;
};

export interface CapacityDiagnosticError extends Error {
  readonly inventory: CapacityInventory | null;
  readonly inventoryError: unknown;
}

function errorMetadata(error: unknown): {
  code: string | null;
  status: number | null;
} {
  if (!(error instanceof HetznerCloudError)) {
    return { code: null, status: null };
  }
  return {
    code: error.code,
    status: error.status ?? null,
  };
}

export function buildProvisionFailureDiagnostic(
  error: unknown,
): ProvisionFailureDiagnostic {
  const metadata = errorMetadata(error);
  const kind: ProvisionFailureKind =
    metadata.code === "quota_exceeded"
      ? "quota"
      : metadata.code === "missing_token"
        ? "authentication"
        : "other";
  const capacityError =
    typeof error === "object" && error !== null
      ? (error as Partial<CapacityDiagnosticError>)
      : null;
  const inventory = isCapacityInventory(capacityError?.inventory)
    ? capacityError.inventory
    : null;

  return {
    version: 1,
    kind,
    ...metadata,
    inventory,
    inventoryError:
      capacityError?.inventoryError === undefined
        ? null
        : errorMetadata(capacityError.inventoryError),
  };
}

export function writeProvisionFailureDiagnostic(
  path: string,
  diagnostic: ProvisionFailureDiagnostic,
): void {
  writeFileSync(path, `${JSON.stringify(diagnostic)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function isCountMap(value: unknown): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, count]) =>
        key.length > 0 && Number.isInteger(count) && Number(count) >= 0,
    )
  );
}

function isCapacityInventory(value: unknown): value is CapacityInventory {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<CapacityInventory>;
  const totalServers = Number(candidate.totalServers);
  const hetznerE2eServers = Number(candidate.hetznerE2eServers);
  const otherServers = Number(candidate.otherServers);
  return (
    Number.isInteger(candidate.totalServers) &&
    totalServers >= 0 &&
    Number.isInteger(candidate.hetznerE2eServers) &&
    hetznerE2eServers >= 0 &&
    Number.isInteger(candidate.otherServers) &&
    otherServers >= 0 &&
    totalServers === hetznerE2eServers + otherServers &&
    isCountMap(candidate.byStatus) &&
    isCountMap(candidate.byServerType) &&
    isCountMap(candidate.byLocation) &&
    Object.values(candidate.byStatus).reduce((sum, count) => sum + count, 0) ===
      totalServers &&
    Object.values(candidate.byServerType).reduce(
      (sum, count) => sum + count,
      0,
    ) === totalServers &&
    Object.values(candidate.byLocation).reduce(
      (sum, count) => sum + count,
      0,
    ) === totalServers
  );
}

function isNullableMetadata(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { code?: unknown; status?: unknown };
  return (
    (candidate.code === null || typeof candidate.code === "string") &&
    (candidate.status === null || Number.isInteger(candidate.status))
  );
}

export function readProvisionFailureDiagnostic(
  path: string,
): ProvisionFailureDiagnostic {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Hetzner E2E provision diagnostic must be an object");
  }
  const candidate = parsed as Partial<ProvisionFailureDiagnostic>;
  if (
    candidate.version !== 1 ||
    !["authentication", "quota", "other"].includes(candidate.kind ?? "") ||
    (candidate.code !== null && typeof candidate.code !== "string") ||
    (candidate.status !== null && !Number.isInteger(candidate.status)) ||
    (candidate.inventory !== null &&
      !isCapacityInventory(candidate.inventory)) ||
    !isNullableMetadata(candidate.inventoryError)
  ) {
    throw new Error("Hetzner E2E provision diagnostic has an invalid shape");
  }
  return candidate as ProvisionFailureDiagnostic;
}

export function renderProvisionFailureSummary(
  diagnostic: ProvisionFailureDiagnostic,
): string {
  const lines = ["### Hetzner E2E provisioning failed", ""];
  if (diagnostic.kind === "quota") {
    lines.push(
      "**Cause:** Hetzner project quota exhausted (server cap reached).",
      "",
    );
    if (diagnostic.inventory) {
      lines.push(
        `Sanitized capacity: ${diagnostic.inventory.totalServers} total server(s), ${diagnostic.inventory.hetznerE2eServers} tagged Hetzner E2E server(s), ${diagnostic.inventory.otherServers} other server(s).`,
        "",
      );
    } else if (diagnostic.inventoryError) {
      lines.push(
        "The follow-up capacity inventory also failed; the quota result from the create request remains authoritative.",
        "",
      );
    }
    lines.push(
      "Operator action:",
      "1. Check the CI project for servers tagged `ci=true`, `workflow=hetzner-e2e` and remove only stale resources.",
      "2. Re-run this workflow after capacity is available.",
      "3. If no stale E2E server is consuming the limit, request a Hetzner server-limit increase for the CI project.",
    );
  } else if (diagnostic.kind === "authentication") {
    lines.push(
      "**Cause:** Hetzner rejected the API credential.",
      "",
      "Operator action: replace `HCLOUD_TOKEN_CI` in the `ci-hetzner-e2e` GitHub environment with an active read-write token for the intended CI project.",
    );
  } else {
    lines.push(
      "**Cause:** the provisioner returned a non-quota, non-authentication failure.",
      "",
      'See the "Provision Hetzner server" step for the preserved primary error.',
    );
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    throw new Error("usage: hetzner-e2e-provision-diagnostic.ts <path>");
  }
  process.stdout.write(
    renderProvisionFailureSummary(readProvisionFailureDiagnostic(path)),
  );
}
