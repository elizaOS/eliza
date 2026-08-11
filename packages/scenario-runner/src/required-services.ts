/**
 * Enforces scenario-declared service readiness before any turn executes.
 * Required service types are checked on every scenario, including when their
 * plugin was registered by an earlier scenario in the shared runtime.
 */

import { type AgentRuntime, ElizaError, type Service } from "@elizaos/core";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";

type RequiredServiceFailure = {
  serviceType: string;
  error: unknown;
};

/** Typed boundary failure for required scenario service startup. */
export class ScenarioRequiredServicePreflightError extends ElizaError {
  override readonly name = "ScenarioRequiredServicePreflightError";
  readonly serviceTypes: readonly string[];

  constructor(failures: readonly RequiredServiceFailure[]) {
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
        context: { serviceTypes },
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

async function waitForService(
  runtime: Pick<AgentRuntime, "getServiceLoadPromise">,
  serviceType: string,
  signal?: AbortSignal,
): Promise<Service> {
  const servicePromise = runtime.getServiceLoadPromise(serviceType);
  if (!signal) {
    return servicePromise;
  }
  const aborted = () =>
    new ElizaError(
      `Required scenario service "${serviceType}" wait was cancelled by its owner`,
      {
        code: "SCENARIO_REQUIRED_SERVICE_ABORTED",
        context: { serviceType },
        cause:
          signal.reason instanceof Error
            ? signal.reason
            : new Error(
                String(signal.reason ?? "Scenario execution cancelled"),
              ),
      },
    );
  if (signal.aborted) {
    throw aborted();
  }
  return new Promise<Service>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(aborted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    servicePromise.then(
      (service) => {
        signal.removeEventListener("abort", onAbort);
        resolve(service);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Wait for every explicitly required service. The execution owner may cancel
 * the wait; service startup itself remains owned by the runtime lifecycle.
 */
export async function waitForScenarioRequiredServices(
  runtime: Pick<AgentRuntime, "getServiceLoadPromise">,
  scenario: ScenarioDefinition,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, Service>> {
  const serviceTypes = resolveRequiredServiceTypes(scenario);
  const settled = await Promise.allSettled(
    serviceTypes.map(async (serviceType) => {
      const service = await waitForService(runtime, serviceType, signal);
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
    throw new ScenarioRequiredServicePreflightError(failures);
  }
  return services;
}
