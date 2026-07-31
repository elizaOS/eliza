/**
 * Enforces scenario-declared service readiness before any turn executes.
 * Required service types are checked on every scenario, including when their
 * plugin was registered by an earlier scenario in the shared runtime.
 */

import { type AgentRuntime, ElizaError, type Service } from "@elizaos/core";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";

export const DEFAULT_SCENARIO_SERVICE_START_TIMEOUT_MS = 30_000;

type RequiredServiceFailure = {
  serviceType: string;
  error: unknown;
};

/** Typed boundary failure for required scenario service startup. */
export class ScenarioRequiredServicePreflightError extends ElizaError {
  override readonly name = "ScenarioRequiredServicePreflightError";
  readonly serviceTypes: readonly string[];

  constructor(failures: readonly RequiredServiceFailure[], timeoutMs: number) {
    const serviceTypes = failures.map(({ serviceType }) => serviceType);
    const cause =
      failures.length === 1
        ? failures[0].error
        : new AggregateError(
            failures.map(({ error }) => error),
            "Multiple required scenario services failed preflight",
          );
    super(
      `Required scenario service preflight failed: ${serviceTypes.join(", ")}`,
      {
        code: "SCENARIO_REQUIRED_SERVICE_PREFLIGHT_FAILED",
        context: { serviceTypes, timeoutMs },
        cause,
      },
    );
    this.serviceTypes = serviceTypes;
  }
}

export function resolveRequiredServiceTypes(
  scenario: ScenarioDefinition,
): string[] {
  const services = scenario.requires?.services;
  if (!Array.isArray(services)) {
    return [];
  }
  return [
    ...new Set(services.map((service) => service.trim()).filter(Boolean)),
  ].sort();
}

export function resolveScenarioServiceStartTimeoutMs(
  raw = process.env.SCENARIO_SERVICE_START_TIMEOUT_MS,
): number {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_SCENARIO_SERVICE_START_TIMEOUT_MS;
  }
  const timeoutMs = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ElizaError(
      `SCENARIO_SERVICE_START_TIMEOUT_MS must be a positive integer (got "${raw}")`,
      {
        code: "SCENARIO_SERVICE_START_TIMEOUT_INVALID",
        context: { raw },
      },
    );
  }
  return timeoutMs;
}

async function waitForService(
  runtime: Pick<AgentRuntime, "getServiceLoadPromise">,
  serviceType: string,
  timeoutMs: number,
): Promise<Service> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new ElizaError(
          `Required scenario service "${serviceType}" did not become ready within ${timeoutMs}ms`,
          {
            code: "SCENARIO_REQUIRED_SERVICE_TIMEOUT",
            context: { serviceType, timeoutMs },
          },
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      runtime.getServiceLoadPromise(serviceType),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Wait for every explicitly required service with a bounded deadline.
 * Optional plugin services are deliberately absent from this operation.
 */
export async function waitForScenarioRequiredServices(
  runtime: Pick<AgentRuntime, "getServiceLoadPromise">,
  scenario: ScenarioDefinition,
  timeoutMs = resolveScenarioServiceStartTimeoutMs(),
): Promise<ReadonlyMap<string, Service>> {
  const serviceTypes = resolveRequiredServiceTypes(scenario);
  const settled = await Promise.allSettled(
    serviceTypes.map(async (serviceType) => {
      const service = await waitForService(runtime, serviceType, timeoutMs);
      return [serviceType, service] as const;
    }),
  );
  const failures: RequiredServiceFailure[] = [];
  const services = new Map<string, Service>();
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    const serviceType = serviceTypes[index];
    if (result.status === "fulfilled") {
      services.set(result.value[0], result.value[1]);
    } else {
      failures.push({ serviceType, error: result.reason });
    }
  }
  if (failures.length > 0) {
    throw new ScenarioRequiredServicePreflightError(failures, timeoutMs);
  }
  return services;
}
