/** Runs adapter-owned scenarios and enforces the managed-provider invariants. */

import {
  PROVIDER_CONTRACT_SCENARIOS,
  type ProviderContractCapability,
  type ProviderContractObservation,
  type ProviderContractScenario,
} from "./types.js";

const ALWAYS_REQUIRED: readonly ProviderContractScenario[] = [
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
];

const CAPABILITY_SCENARIOS: Record<
  ProviderContractCapability,
  readonly ProviderContractScenario[]
> = {
  oauth: [
    "oauth-state-pkce",
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
  capabilities: readonly ProviderContractCapability[];
  /** Scenarios this adapter surface owns; defaults to its full capability profile. */
  requiredScenarios?: readonly ProviderContractScenario[];
  scenarios: Partial<
    Record<ProviderContractScenario, () => Promise<ProviderContractObservation>>
  >;
}

export interface ProviderAdapterConformanceReport {
  adapterName: string;
  capabilities: readonly ProviderContractCapability[];
  observations: ProviderContractObservation[];
}

export function requiredProviderContractScenarios(
  capabilities: readonly ProviderContractCapability[],
): ProviderContractScenario[] {
  return [
    ...new Set([
      ...ALWAYS_REQUIRED,
      ...capabilities.flatMap((capability) => CAPABILITY_SCENARIOS[capability]),
    ]),
  ];
}

export async function runProviderAdapterConformance(
  options: ProviderAdapterConformanceOptions,
): Promise<ProviderAdapterConformanceReport> {
  const required = options.requiredScenarios
    ? [...options.requiredScenarios]
    : requiredProviderContractScenarios(options.capabilities);
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

  return {
    adapterName: options.adapterName,
    capabilities: options.capabilities,
    observations,
  };
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
