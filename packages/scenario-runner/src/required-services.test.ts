/**
 * Required-service preflight regressions over real AgentRuntime instances.
 * Service classes are deterministic; registration, startup, retry, and stop
 * all use the production runtime lifecycle.
 */

import {
  AgentRuntime,
  ElizaError,
  type IAgentRuntime,
  type Plugin,
  Service,
} from "@elizaos/core";
import {
  type ScenarioDefinition,
  scenario,
} from "@elizaos/scenario-runner/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveRequiredServiceTypes,
  ScenarioRequiredServicePreflightError,
  waitForScenarioRequiredServices,
} from "./required-services.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function scenarioWithServices(
  id: string,
  services: readonly string[],
): ScenarioDefinition {
  return {
    id,
    title: id,
    domain: "required-service-preflight",
    requires: { services },
    turns: [],
  };
}

async function createRuntime(): Promise<AgentRuntime> {
  const runtime = new AgentRuntime({ logLevel: "fatal" });
  await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
  return runtime;
}

async function stopWithin(
  runtime: AgentRuntime,
  timeoutMs = 250,
): Promise<void> {
  const result = await Promise.race([
    runtime.stop({ fast: true }).then(() => "stopped" as const),
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), timeoutMs);
    }),
  ]);
  expect(result).toBe("stopped");
}

describe("scenario required-service contract", () => {
  it("accepts typed services and rejects malformed runtime definitions", () => {
    const definition = scenario({
      id: "typed-services",
      title: "typed services",
      domain: "required-service-preflight",
      requires: {
        plugins: ["@elizaos/plugin-wallet"],
        services: ["wallet-backend"],
      },
      turns: [],
    });
    expect(resolveRequiredServiceTypes(definition)).toEqual(["wallet-backend"]);

    expect(() =>
      scenario({
        ...definition,
        id: "malformed-services",
        requires: { services: ["wallet-backend", ""] },
      } as unknown as ScenarioDefinition),
    ).toThrow("invalid requires.services");
  });
});

describe("required-service readiness", () => {
  const runtimes: AgentRuntime[] = [];

  afterEach(async () => {
    await Promise.all(
      runtimes.splice(0).map((runtime) => runtime.stop({ fast: true })),
    );
  });

  it("waits for delayed startup on a newly registered plugin", async () => {
    const runtime = await createRuntime();
    runtimes.push(runtime);
    const startup = deferred<DelayedService>();

    class DelayedService extends Service {
      static override serviceType = "scenario-delayed";
      capabilityDescription = "delayed required service";

      static override async start(): Promise<DelayedService> {
        return startup.promise;
      }

      override async stop(): Promise<void> {}
    }

    await runtime.registerPlugin({
      name: "scenario-delayed-plugin",
      description: "Registers a delayed service",
      services: [DelayedService],
    });

    let settled = false;
    const preflight = waitForScenarioRequiredServices(
      runtime,
      scenarioWithServices("delayed", [DelayedService.serviceType]),
      250,
    ).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    startup.resolve(new DelayedService(runtime));
    const services = await preflight;
    expect(services.get(DelayedService.serviceType)).toBeInstanceOf(
      DelayedService,
    );
  });

  it("waits for a service from a plugin registered before this scenario", async () => {
    const runtime = await createRuntime();
    runtimes.push(runtime);
    const startup = deferred<PreRegisteredService>();

    class PreRegisteredService extends Service {
      static override serviceType = "scenario-pre-registered";
      capabilityDescription = "pre-registered required service";

      static override async start(): Promise<PreRegisteredService> {
        return startup.promise;
      }

      override async stop(): Promise<void> {}
    }

    await runtime.registerPlugin({
      name: "scenario-pre-registered-plugin",
      description: "Registers before scenario preflight",
      services: [PreRegisteredService],
    });
    await waitForScenarioRequiredServices(
      runtime,
      scenarioWithServices("unrelated-a", []),
      250,
    );

    const required = waitForScenarioRequiredServices(
      runtime,
      scenarioWithServices("required-b", [PreRegisteredService.serviceType]),
      250,
    );
    startup.resolve(new PreRegisteredService(runtime));
    await expect(required).resolves.toEqual(
      new Map([
        [
          PreRegisteredService.serviceType,
          expect.any(PreRegisteredService) as PreRegisteredService,
        ],
      ]),
    );
  });

  it("allows a failing optional sibling when another implementation is ready", async () => {
    const runtime = await createRuntime();
    runtimes.push(runtime);
    const optionalCause = new Error("optional implementation unavailable");

    class FailingOptionalService extends Service {
      static override serviceType = "scenario-sibling";
      static override allowsMultiple = true;
      capabilityDescription = "failing optional implementation";

      static override async start(): Promise<FailingOptionalService> {
        throw optionalCause;
      }

      override async stop(): Promise<void> {}
    }

    class HealthyRequiredService extends Service {
      static override serviceType = "scenario-sibling";
      static override allowsMultiple = true;
      capabilityDescription = "healthy required implementation";

      static override async start(
        runtime: IAgentRuntime,
      ): Promise<HealthyRequiredService> {
        return new HealthyRequiredService(runtime);
      }

      override async stop(): Promise<void> {}
    }

    await runtime.registerPlugin({
      name: "scenario-sibling-plugin",
      description: "Registers alternative service implementations",
      services: [FailingOptionalService, HealthyRequiredService],
    });
    const services = await waitForScenarioRequiredServices(
      runtime,
      scenarioWithServices("sibling", [HealthyRequiredService.serviceType]),
      250,
    );

    expect(services.get(HealthyRequiredService.serviceType)).toBeInstanceOf(
      HealthyRequiredService,
    );
    expect(runtime.getServiceRegistrationStatus("scenario-sibling")).toBe(
      "registered",
    );
    expect(runtime.getRecentReportedErrors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: optionalCause.message }),
      ]),
    );
  });

  it("preserves the original startup cause in a typed preflight failure", async () => {
    const runtime = await createRuntime();
    runtimes.push(runtime);
    const startup = deferred<NeverStartsService>();
    const startupCause = new Error("credential rejected by provider");

    class NeverStartsService extends Service {
      static override serviceType = "scenario-failed";
      capabilityDescription = "required service that fails";

      static override async start(): Promise<NeverStartsService> {
        return startup.promise;
      }

      override async stop(): Promise<void> {}
    }

    await runtime.registerPlugin({
      name: "scenario-failed-plugin",
      description: "Registers a failed required service",
      services: [NeverStartsService],
    });
    const preflight = waitForScenarioRequiredServices(
      runtime,
      scenarioWithServices("failed", [NeverStartsService.serviceType]),
      250,
    );
    startup.reject(startupCause);

    try {
      await preflight;
      throw new Error("expected required-service preflight to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ScenarioRequiredServicePreflightError);
      const preflightError = error as ScenarioRequiredServicePreflightError;
      expect(preflightError.code).toBe(
        "SCENARIO_REQUIRED_SERVICE_PREFLIGHT_FAILED",
      );
      expect(preflightError.cause).toBeInstanceOf(ElizaError);
      const runtimeError = preflightError.cause as ElizaError;
      expect(runtimeError.code).toBe("SERVICE_START_FAILED");
      expect(runtimeError.cause).toBeInstanceOf(AggregateError);
      expect((runtimeError.cause as AggregateError).errors).toContain(
        startupCause,
      );
    }
  });

  it("retries startup after an initialization failure", async () => {
    const runtime = await createRuntime();
    runtimes.push(runtime);
    const firstAttempt = deferred<RetryService>();
    let attempts = 0;

    class RetryService extends Service {
      static override serviceType = "scenario-retry";
      capabilityDescription = "transiently failing required service";

      static override async start(
        runtime: IAgentRuntime,
      ): Promise<RetryService> {
        attempts += 1;
        if (attempts === 1) {
          return firstAttempt.promise;
        }
        return new RetryService(runtime);
      }

      override async stop(): Promise<void> {}
    }

    await runtime.registerPlugin({
      name: "scenario-retry-plugin",
      description: "Registers a transiently failing service",
      services: [RetryService],
    });
    const definition = scenarioWithServices("retry", [
      RetryService.serviceType,
    ]);
    const failed = waitForScenarioRequiredServices(runtime, definition, 250);
    firstAttempt.reject(new Error("transient startup failure"));
    await expect(failed).rejects.toBeInstanceOf(
      ScenarioRequiredServicePreflightError,
    );

    await expect(
      waitForScenarioRequiredServices(runtime, definition, 250),
    ).resolves.toEqual(
      new Map([
        [RetryService.serviceType, expect.any(RetryService) as RetryService],
      ]),
    );
    expect(attempts).toBe(2);
  });

  it("times out a never-settling start and fast teardown still completes", async () => {
    const runtime = await createRuntime();
    runtimes.push(runtime);

    class HangingService extends Service {
      static override serviceType = "scenario-hanging";
      capabilityDescription = "never-settling required service";

      static override async start(): Promise<HangingService> {
        return new Promise(() => {});
      }

      override async stop(): Promise<void> {}
    }

    await runtime.registerPlugin({
      name: "scenario-hanging-plugin",
      description: "Registers a never-settling service",
      services: [HangingService],
    });

    await expect(
      waitForScenarioRequiredServices(
        runtime,
        scenarioWithServices("hanging", [HangingService.serviceType]),
        20,
      ),
    ).rejects.toMatchObject({
      code: "SCENARIO_REQUIRED_SERVICE_PREFLIGHT_FAILED",
      cause: expect.objectContaining({
        code: "SCENARIO_REQUIRED_SERVICE_TIMEOUT",
      }),
    });
    await stopWithin(runtime);
    runtimes.pop();
  });

  it("is independent of required-scenario order in a shared runtime", async () => {
    async function run(requiredFirst: boolean): Promise<string[]> {
      const runtime = await createRuntime();
      const startup = deferred<OrderedService>();
      const observations: string[] = [];

      class OrderedService extends Service {
        static override serviceType = "scenario-ordered";
        capabilityDescription = "order-independent required service";

        static override async start(): Promise<OrderedService> {
          return startup.promise;
        }

        override async stop(): Promise<void> {}
      }

      await runtime.registerPlugin({
        name: `scenario-ordered-plugin-${requiredFirst}`,
        description: "Registers an order-independent service",
        services: [OrderedService],
      });
      const required = async () => {
        const pending = waitForScenarioRequiredServices(
          runtime,
          scenarioWithServices("ordered-required", [
            OrderedService.serviceType,
          ]),
          250,
        );
        startup.resolve(new OrderedService(runtime));
        await pending;
        observations.push("required-ready");
      };
      const optional = async () => {
        await waitForScenarioRequiredServices(
          runtime,
          scenarioWithServices("ordered-optional", []),
          250,
        );
        observations.push("optional-ready");
      };

      if (requiredFirst) {
        await required();
        await optional();
      } else {
        await optional();
        await required();
      }
      await stopWithin(runtime);
      return observations.sort();
    }

    await expect(run(true)).resolves.toEqual([
      "optional-ready",
      "required-ready",
    ]);
    await expect(run(false)).resolves.toEqual([
      "optional-ready",
      "required-ready",
    ]);
  });

  it("keeps credentialless Birdeye optional while requiring wallet-backend", async () => {
    const runtime = await createRuntime();
    runtimes.push(runtime);
    const { default: walletPlugin } = (await import(
      "@elizaos/plugin-wallet/plugin"
    )) as { default: Plugin };

    await runtime.registerPlugin(walletPlugin);
    const services = await waitForScenarioRequiredServices(
      runtime,
      scenarioWithServices("credentialless-wallet", ["wallet-backend"]),
      2_000,
    );

    expect(services.get("wallet-backend")).toBeInstanceOf(Service);
    await expect(
      runtime.getServiceLoadPromise("birdeye"),
    ).rejects.toMatchObject({
      code: "SERVICE_START_FAILED",
      cause: expect.any(AggregateError),
    });
  }, 15_000);
});
