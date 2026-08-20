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

describe("scenario required-service contract", () => {
  it("accepts typed services and rejects malformed runtime definitions", () => {
    const definition = scenario({
      id: "typed-services",
      title: "typed services",
      domain: "required-service-preflight",
      requires: {
        plugins: ["@elizaos/plugin-wallet"],
        services: ["wallet-backend"],
        workers: ["LIFEOPS_SCHEDULER"],
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
    expect(() =>
      scenario({
        ...definition,
        id: "misspelled-services",
        requires: { service: ["wallet-backend"] },
      } as unknown as ScenarioDefinition),
    ).toThrow("unknown requires field(s): service");
    expect(() =>
      scenario({
        ...definition,
        id: "malformed-workers",
        requires: { workers: ["LIFEOPS_SCHEDULER", ""] },
      } as unknown as ScenarioDefinition),
    ).toThrow("invalid requires.workers");
  });

  it("accepts corpus credential and os requirements and rejects malformed ones", () => {
    const definition = scenario({
      id: "credential-os-requirements",
      title: "credential and os requirements",
      domain: "required-service-preflight",
      requires: {
        plugins: ["@elizaos/plugin-agent-skills"],
        credentials: ["1password:eliza-e2e-autofill"],
        os: "macos",
      },
      turns: [],
    });
    expect(resolveRequiredServiceTypes(definition)).toEqual([]);

    expect(() =>
      scenario({
        ...definition,
        id: "malformed-credentials",
        requires: { credentials: ["1password:eliza-e2e-autofill", ""] },
      } as unknown as ScenarioDefinition),
    ).toThrow("invalid requires.credentials");
    expect(() =>
      scenario({
        ...definition,
        id: "malformed-os",
        requires: { os: " " },
      } as unknown as ScenarioDefinition),
    ).toThrow("invalid requires.os");
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
    );

    const required = waitForScenarioRequiredServices(
      runtime,
      scenarioWithServices("required-b", [PreRegisteredService.serviceType]),
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

  it("accepts a later plugin implementation when an earlier sibling fails", async () => {
    const runtime = await createRuntime();
    runtimes.push(runtime);
    const optionalCause = new Error("optional implementation unavailable");
    let failingStarts = 0;

    class FailingOptionalService extends Service {
      static override serviceType = "scenario-sibling";
      static override allowsMultiple = true;
      capabilityDescription = "failing optional implementation";

      static override async start(): Promise<FailingOptionalService> {
        failingStarts += 1;
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
      name: "scenario-failing-sibling-plugin",
      description: "Registers an unavailable implementation",
      services: [FailingOptionalService],
    });
    await runtime.registerPlugin({
      name: "scenario-healthy-sibling-plugin",
      description: "Registers a later healthy implementation",
      services: [HealthyRequiredService],
    });
    const services = await waitForScenarioRequiredServices(
      runtime,
      scenarioWithServices("sibling", [HealthyRequiredService.serviceType]),
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
    await expect(
      runtime.getServiceLoadPromise("scenario-sibling"),
    ).resolves.toBeInstanceOf(HealthyRequiredService);
    expect(failingStarts).toBe(1);
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
      // Each per-implementation failure is wrapped in a typed ElizaError that
      // adds service identity; the original startup cause must remain
      // reachable through the cause chain.
      const chainContains = (error: unknown): boolean => {
        if (error === startupCause) return true;
        if (error instanceof AggregateError) {
          return error.errors.some(chainContains);
        }
        if (error instanceof Error && error.cause !== undefined) {
          return chainContains(error.cause);
        }
        return false;
      };
      expect(chainContains(runtimeError.cause)).toBe(true);
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
    const failed = waitForScenarioRequiredServices(runtime, definition);
    firstAttempt.reject(new Error("transient startup failure"));
    await expect(failed).rejects.toBeInstanceOf(
      ScenarioRequiredServicePreflightError,
    );

    await expect(
      waitForScenarioRequiredServices(runtime, definition),
    ).resolves.toEqual(
      new Map([
        [RetryService.serviceType, expect.any(RetryService) as RetryService],
      ]),
    );
    expect(attempts).toBe(2);
  });

  it("lets the execution owner cancel a never-settling wait", async () => {
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

    const controller = new AbortController();
    const preflight = waitForScenarioRequiredServices(
      runtime,
      scenarioWithServices("hanging", [HangingService.serviceType]),
      controller.signal,
    );
    controller.abort(new Error("scenario runner stopped"));

    await expect(preflight).rejects.toMatchObject({
      code: "SCENARIO_REQUIRED_SERVICE_PREFLIGHT_FAILED",
      cause: expect.objectContaining({
        code: "SCENARIO_REQUIRED_SERVICE_ABORTED",
      }),
    });
    await runtime.stop({ fast: true });
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
        );
        startup.resolve(new OrderedService(runtime));
        await pending;
        observations.push("required-ready");
      };
      const optional = async () => {
        await waitForScenarioRequiredServices(
          runtime,
          scenarioWithServices("ordered-optional", []),
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
      await runtime.stop({ fast: true });
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

  it("keeps credentialless signing and Birdeye optional for token analytics", async () => {
    const runtime = await createRuntime();
    runtimes.push(runtime);
    const { default: walletPlugin } = (await import(
      "@elizaos/plugin-wallet"
    )) as { default: Plugin };

    await runtime.registerPlugin(walletPlugin);
    const services = await waitForScenarioRequiredServices(
      runtime,
      scenarioWithServices("credentialless-wallet", ["token-info"]),
    );

    const tokenInfo = services.get("token-info");
    expect(tokenInfo).toBeDefined();
    expect(tokenInfo).toBe(runtime.getService("token-info"));
    await expect(
      runtime.getServiceLoadPromise("birdeye"),
    ).rejects.toMatchObject({
      code: "SERVICE_START_FAILED",
      cause: expect.any(AggregateError),
    });
  });
});
