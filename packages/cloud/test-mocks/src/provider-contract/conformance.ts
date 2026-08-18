/** Runs adapter-owned scenarios and enforces the managed-provider invariants. */

import { appendFileSync } from "node:fs";
import {
  PROVIDER_CONTRACT_SCENARIOS,
  type ProviderContractCapability,
  type ProviderContractObservation,
  type ProviderContractProfile,
  type ProviderContractScenario,
} from "./types.js";

const PROFILE_SCENARIOS: Record<
  ProviderContractProfile,
  readonly ProviderContractScenario[]
> = {
  "outbound-http": [
    "success",
    "designed-empty",
    "invalid-input",
    "rate-limit-retry-metadata",
    "malformed-json",
    "schema-drift",
    "timeout",
    "connection-reset",
    "provider-4xx",
    "provider-5xx",
    "opaque-connection-id",
    "secret-redaction",
    "read-policy",
  ],
  "inbound-webhook": [
    "success",
    "designed-empty",
    "invalid-input",
    "malformed-json",
    "schema-drift",
    "provider-4xx",
    "provider-5xx",
    "secret-redaction",
    "read-policy",
  ],
};

const CAPABILITY_SCENARIOS: Record<
  ProviderContractCapability,
  readonly ProviderContractScenario[]
> = {
  oauth: ["oauth-state-pkce"],
  "oauth-credential-lifecycle": [
    "oauth-refresh-rotation",
    "oauth-revoked-credential",
    "oauth-expired-credential",
  ],
  "http-read": [],
  "http-write": ["write-policy-receipt"],
  "irreversible-write": ["irreversible-policy-receipt"],
  pagination: ["pagination-cursors"],
  "tenant-isolation": ["cross-tenant-denial"],
  webhooks: [
    "duplicate-webhook",
    "out-of-order-webhook",
    "webhook-idempotency",
  ],
};

export interface ProviderAdapterConformanceOptions {
  adapterName: string;
  profile?: ProviderContractProfile;
  capabilities: readonly ProviderContractCapability[];
  /** Additional adapter-owned scenarios beyond its mandatory capability profile. */
  requiredScenarios?: readonly ProviderContractScenario[];
  scenarios: Partial<
    Record<ProviderContractScenario, () => Promise<ProviderContractObservation>>
  >;
}

export interface ProviderAdapterConformanceReport {
  adapterName: string;
  profile: ProviderContractProfile;
  capabilities: readonly ProviderContractCapability[];
  observations: ProviderContractObservation[];
}

export const PROVIDER_CONTRACT_REPORT_PATH_ENV =
  "ELIZA_PROVIDER_CONTRACT_REPORT_PATH";
export const PROVIDER_CONTRACT_REPORT_NONCE_ENV =
  "ELIZA_PROVIDER_CONTRACT_REPORT_NONCE";

export function requiredProviderContractScenarios(
  capabilities: readonly ProviderContractCapability[],
  profile: ProviderContractProfile = "outbound-http",
): ProviderContractScenario[] {
  return [
    ...new Set([
      ...PROFILE_SCENARIOS[profile],
      ...capabilities.flatMap((capability) => CAPABILITY_SCENARIOS[capability]),
    ]),
  ];
}

export async function runProviderAdapterConformance(
  options: ProviderAdapterConformanceOptions,
): Promise<ProviderAdapterConformanceReport> {
  const profile = options.profile ?? "outbound-http";
  const required = [
    ...new Set([
      ...requiredProviderContractScenarios(options.capabilities, profile),
      ...(options.requiredScenarios ?? []),
    ]),
  ];
  const unknown = required.filter(
    (scenario) => !PROVIDER_CONTRACT_SCENARIOS.includes(scenario),
  );
  if (unknown.length > 0) {
    throw new Error(
      `${options.adapterName} declared unknown provider contract scenarios: ${unknown.join(", ")}`,
    );
  }
  if (required.length === 0) {
    throw new Error(
      `${options.adapterName} declared an empty provider contract suite`,
    );
  }
  const missing = required.filter((scenario) => !options.scenarios[scenario]);
  if (missing.length > 0) {
    throw new Error(
      `${options.adapterName} is missing provider contract scenarios: ${missing.join(", ")}`,
    );
  }

  const observations: ProviderContractObservation[] = [];
  for (const scenario of required) {
    const execute = options.scenarios[scenario];
    if (!execute) continue;
    const observation = await execute();
    if (observation.scenario !== scenario) {
      throw new Error(
        `${options.adapterName} scenario ${scenario} returned observation for ${observation.scenario}`,
      );
    }
    if (observation.status !== "passed") {
      throw new Error(
        `${options.adapterName} required scenario ${scenario} was marked not applicable: ${observation.detail}`,
      );
    }
    assertObservationSafe(options.adapterName, observation);
    observations.push(observation);
  }

  const report = {
    adapterName: options.adapterName,
    profile,
    capabilities: options.capabilities,
    observations,
  };
  recordExecutedReport(report, required);
  return report;
}

function recordExecutedReport(
  report: ProviderAdapterConformanceReport,
  requiredScenarios: readonly ProviderContractScenario[],
): void {
  const reportPath = process.env[PROVIDER_CONTRACT_REPORT_PATH_ENV];
  if (!reportPath) return;
  const nonce = process.env[PROVIDER_CONTRACT_REPORT_NONCE_ENV];
  if (!nonce) {
    throw new Error("provider contract report capture requires a nonce");
  }
  appendFileSync(
    reportPath,
    `${JSON.stringify({
      version: 1,
      nonce,
      adapterName: report.adapterName,
      profile: report.profile,
      capabilities: report.capabilities,
      requiredScenarios,
      executedObservations: report.observations.map(
        (observation) => observation.scenario,
      ),
    })}\n`,
  );
}

function assertObservationSafe(
  adapterName: string,
  observation: ProviderContractObservation,
): void {
  if (!observation.detail.trim()) {
    throw new Error(
      `${adapterName} ${observation.scenario} has no evidence detail`,
    );
  }
  if (
    observation.scenario === "opaque-connection-id" &&
    (!observation.connectionId ||
      !/^conn_[A-Za-z0-9_-]{16,}$/.test(observation.connectionId))
  ) {
    throw new Error(`${adapterName} exposed a non-opaque connection id`);
  }
  if (
    (observation.scenario === "write-policy-receipt" ||
      observation.scenario === "irreversible-policy-receipt") &&
    !observation.receiptId
  ) {
    throw new Error(
      `${adapterName} ${observation.scenario} did not emit a receipt`,
    );
  }
  if (observation.scenario === "secret-redaction") {
    const serialized = JSON.stringify(observation.diagnostic);
    if (
      /bearer\s+[A-Za-z0-9._-]+|refresh_[A-Za-z0-9_-]+|client_secret/i.test(
        serialized,
      )
    ) {
      throw new Error(
        `${adapterName} leaked a credential in conformance diagnostics`,
      );
    }
  }
}

export function assertCompleteScenarioCatalog(
  scenarios: readonly ProviderContractScenario[],
): void {
  const missing = PROVIDER_CONTRACT_SCENARIOS.filter(
    (scenario) => !scenarios.includes(scenario),
  );
  if (missing.length > 0) {
    throw new Error(
      `Provider scenario catalog is incomplete: ${missing.join(", ")}`,
    );
  }
}
