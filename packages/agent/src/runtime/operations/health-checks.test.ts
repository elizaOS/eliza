/**
 * Unit coverage for the built-in runtime-operations health checks. Drives the
 * real `HealthCheck` objects and `describeError`: identity metadata, every
 * pass/fail branch, first-failed service ordering, live database-probe
 * outcomes, provider smoke classification (quota vs empty vs transport), and
 * the default `builtInHealthChecks` set. Collaborator stubs implement runtime
 * surfaces; the database probe and credit classifier run unmocked.
 */

import { type AgentRuntime, ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  builtInHealthChecks,
  dbConnectionCheck,
  describeError,
  essentialServicesCheck,
  providerSmokeCheck,
  runtimeReadyCheck,
} from "./health-checks.ts";

function runtime(overrides: Record<string, unknown> = {}): AgentRuntime {
  return {
    agentId: "agent-id",
    character: { name: "Health Agent" },
    plugins: [],
    actions: [],
    providers: [],
    evaluators: [],
    services: new Map(),
    ...overrides,
  } as unknown as AgentRuntime;
}

describe("describeError", () => {
  it("returns Error.message for Error instances", () => {
    expect(describeError(new Error("adapter ping failed"))).toBe(
      "adapter ping failed",
    );
    expect(describeError(new Error(""))).toBe("");
  });

  it("returns a string argument unchanged", () => {
    expect(describeError("plain")).toBe("plain");
    expect(describeError("")).toBe("");
  });

  it("JSON-serializes plain objects and primitives", () => {
    expect(describeError({ code: "E_TEST" })).toBe('{"code":"E_TEST"}');
    expect(describeError(null)).toBe("null");
    expect(describeError(42)).toBe("42");
    expect(describeError(true)).toBe("true");
  });

  it("falls back to String() when JSON.stringify throws", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(describeError(circular)).toBe("[object Object]");
    expect(describeError(1n)).toBe("1");
  });
});

describe("runtimeReadyCheck", () => {
  it("is a required 1000ms identity check", () => {
    expect(runtimeReadyCheck.name).toBe("runtime-ready");
    expect(runtimeReadyCheck.required).toBe(true);
    expect(runtimeReadyCheck.timeoutMs).toBe(1000);
  });

  it("passes when agentId and character.name are populated", async () => {
    await expect(runtimeReadyCheck.run(runtime())).resolves.toEqual({
      ok: true,
    });
  });

  it("fails when the runtime is missing or not an object", async () => {
    await expect(
      runtimeReadyCheck.run(null as unknown as AgentRuntime),
    ).resolves.toEqual({
      ok: false,
      reason: "runtime is not an object",
    });
    await expect(
      runtimeReadyCheck.run(undefined as unknown as AgentRuntime),
    ).resolves.toEqual({
      ok: false,
      reason: "runtime is not an object",
    });
    await expect(
      runtimeReadyCheck.run(1 as unknown as AgentRuntime),
    ).resolves.toEqual({
      ok: false,
      reason: "runtime is not an object",
    });
  });

  it("fails when agentId is missing, empty, or not a string", async () => {
    await expect(
      runtimeReadyCheck.run(runtime({ agentId: "" })),
    ).resolves.toEqual({
      ok: false,
      reason: "runtime.agentId is empty",
    });
    await expect(
      runtimeReadyCheck.run(runtime({ agentId: 17 })),
    ).resolves.toEqual({
      ok: false,
      reason: "runtime.agentId is empty",
    });
    await expect(
      runtimeReadyCheck.run(runtime({ agentId: undefined })),
    ).resolves.toEqual({
      ok: false,
      reason: "runtime.agentId is empty",
    });
  });

  it("fails when character is missing or not an object", async () => {
    await expect(
      runtimeReadyCheck.run(runtime({ character: undefined })),
    ).resolves.toEqual({
      ok: false,
      reason: "runtime.character is missing",
    });
    await expect(
      runtimeReadyCheck.run(runtime({ character: null })),
    ).resolves.toEqual({
      ok: false,
      reason: "runtime.character is missing",
    });
    await expect(
      runtimeReadyCheck.run(runtime({ character: "Eliza" })),
    ).resolves.toEqual({
      ok: false,
      reason: "runtime.character is missing",
    });
  });

  it("fails when character.name is empty after trim or not a string", async () => {
    await expect(
      runtimeReadyCheck.run(runtime({ character: { name: "" } })),
    ).resolves.toEqual({
      ok: false,
      reason: "runtime.character.name is empty",
    });
    await expect(
      runtimeReadyCheck.run(runtime({ character: { name: "   " } })),
    ).resolves.toEqual({
      ok: false,
      reason: "runtime.character.name is empty",
    });
    await expect(
      runtimeReadyCheck.run(runtime({ character: { name: 3 } })),
    ).resolves.toEqual({
      ok: false,
      reason: "runtime.character.name is empty",
    });
    await expect(
      runtimeReadyCheck.run(runtime({ character: {} })),
    ).resolves.toEqual({
      ok: false,
      reason: "runtime.character.name is empty",
    });
  });
});

describe("essentialServicesCheck", () => {
  it("is a required 2000ms service-registry check", () => {
    expect(essentialServicesCheck.name).toBe("essential-services");
    expect(essentialServicesCheck.required).toBe(true);
    expect(essentialServicesCheck.timeoutMs).toBe(2000);
  });

  it("passes when the registry enumeration API is absent", async () => {
    await expect(essentialServicesCheck.run(runtime())).resolves.toEqual({
      ok: true,
    });
  });

  it("passes for an empty or non-array service-type list", async () => {
    await expect(
      essentialServicesCheck.run(
        runtime({ getRegisteredServiceTypes: () => [] }),
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      essentialServicesCheck.run(
        runtime({ getRegisteredServiceTypes: () => "not-an-array" }),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("passes when status lookup is missing even if types are listed", async () => {
    await expect(
      essentialServicesCheck.run(
        runtime({
          getRegisteredServiceTypes: () => ["task"],
        }),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("passes pending, registering, registered, and unknown statuses", async () => {
    const statuses: Record<string, string> = {
      a: "pending",
      b: "registering",
      c: "registered",
      d: "unknown",
    };
    await expect(
      essentialServicesCheck.run(
        runtime({
          getRegisteredServiceTypes: () => ["a", "b", "c", "d"],
          getServiceRegistrationStatus: (type: string) => statuses[type],
        }),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("fails on the first service in failed state and ignores later failures", async () => {
    const statuses: Record<string, string> = {
      ok: "registered",
      bad: "failed",
      alsoBad: "failed",
    };
    await expect(
      essentialServicesCheck.run(
        runtime({
          getRegisteredServiceTypes: () => ["ok", "bad", "alsoBad"],
          getServiceRegistrationStatus: (type: string) => statuses[type],
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "service bad is in failed state",
    });
  });

  it("passes a single registered service", async () => {
    await expect(
      essentialServicesCheck.run(
        runtime({
          getRegisteredServiceTypes: () => ["task"],
          getServiceRegistrationStatus: () => "registered",
        }),
      ),
    ).resolves.toEqual({ ok: true });
  });
});

describe("dbConnectionCheck", () => {
  it("is a required 1500ms database probe", () => {
    expect(dbConnectionCheck.name).toBe("db-connection");
    expect(dbConnectionCheck.required).toBe(true);
    expect(dbConnectionCheck.timeoutMs).toBe(1500);
  });

  it("passes when no adapter is present (probe status unknown)", async () => {
    await expect(dbConnectionCheck.run(runtime())).resolves.toEqual({
      ok: true,
    });
  });

  it("passes a null runtime because the probe reports unknown, not a failure", async () => {
    await expect(
      dbConnectionCheck.run(null as unknown as AgentRuntime),
    ).resolves.toEqual({ ok: true });
  });

  it("passes when the live probe succeeds", async () => {
    await expect(
      dbConnectionCheck.run(
        runtime({
          adapter: {
            async isReady() {
              return true;
            },
          },
        }),
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      dbConnectionCheck.run(
        runtime({
          adapter: {
            getRawConnection: () => ({
              async query(sql: string) {
                expect(sql).toBe("SELECT 1");
                return { rows: [{ "?column?": 1 }] };
              },
            }),
          },
        }),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("fails transient probe errors with the probe status and message", async () => {
    await expect(
      dbConnectionCheck.run(
        runtime({
          adapter: {
            async isReady() {
              return false;
            },
          },
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "transient_error: adapter.isReady() returned false",
    });
    await expect(
      dbConnectionCheck.run(
        runtime({
          adapter: {
            getRawConnection: () => ({
              async query() {
                throw new Error("temporary probe timeout");
              },
            }),
          },
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "transient_error: temporary probe timeout",
    });
    await expect(
      dbConnectionCheck.run(runtime({ adapter: {} })),
    ).resolves.toEqual({
      ok: false,
      reason:
        "transient_error: database adapter exposes no liveness probe surface",
    });
  });

  it("fails terminal closed-database probe errors", async () => {
    await expect(
      dbConnectionCheck.run(
        runtime({
          adapter: {
            db: {
              async execute() {
                throw new Error("PGlite is closed");
              },
            },
          },
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "terminal_error: PGlite is closed",
    });
  });
});

describe("providerSmokeCheck", () => {
  it("is a required 5000ms provider transport check", () => {
    expect(providerSmokeCheck.name).toBe("provider-smoke");
    expect(providerSmokeCheck.required).toBe(true);
    expect(providerSmokeCheck.timeoutMs).toBe(5000);
  });

  it("passes when useModel is absent", async () => {
    await expect(providerSmokeCheck.run(runtime())).resolves.toEqual({
      ok: true,
    });
  });

  it("passes a successful useModel call and sends the ping payload", async () => {
    const calls: unknown[] = [];
    await expect(
      providerSmokeCheck.run(
        runtime({
          async useModel(modelType: unknown, params: unknown) {
            calls.push([modelType, params]);
            return "pong";
          },
        }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      [ModelType.TEXT_SMALL, { prompt: "ping", maxTokens: 1, temperature: 0 }],
    ]);
  });

  it("treats an empty completion as a healthy transport", async () => {
    await expect(
      providerSmokeCheck.run(
        runtime({
          async useModel() {
            return "";
          },
        }),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("treats AI_NoOutputGeneratedError as a healthy empty completion", async () => {
    const noOutput = new Error("empty");
    noOutput.name = "AI_NoOutputGeneratedError";
    await expect(
      providerSmokeCheck.run(
        runtime({
          async useModel() {
            throw noOutput;
          },
        }),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("does not treat a non-Error duck-typed no-output name as healthy", async () => {
    const duck = { name: "AI_NoOutputGeneratedError", message: "empty" };
    await expect(
      providerSmokeCheck.run(
        runtime({
          async useModel() {
            throw duck;
          },
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      reason: `provider unreachable: ${JSON.stringify(duck)}`,
      cause: duck,
    });
  });

  it("fails quota exhaustion before the empty-completion exception name", async () => {
    const quota = Object.assign(new Error("Payment Required"), {
      name: "AI_NoOutputGeneratedError",
      status: 402,
    });
    await expect(
      providerSmokeCheck.run(
        runtime({
          async useModel() {
            throw quota;
          },
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "provider quota exhausted",
      cause: quota,
    });
  });

  it("fails other transport errors with describeError text and the cause", async () => {
    const transport = new Error("transport down");
    await expect(
      providerSmokeCheck.run(
        runtime({
          async useModel() {
            throw transport;
          },
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "provider unreachable: transport down",
      cause: transport,
    });

    await expect(
      providerSmokeCheck.run(
        runtime({
          async useModel() {
            throw "socket hang up";
          },
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "provider unreachable: socket hang up",
      cause: "socket hang up",
    });
  });
});

describe("builtInHealthChecks", () => {
  it("is the four named checks in declaration order, by identity", () => {
    expect(builtInHealthChecks).toEqual([
      runtimeReadyCheck,
      essentialServicesCheck,
      dbConnectionCheck,
      providerSmokeCheck,
    ]);
    expect(builtInHealthChecks[0]).toBe(runtimeReadyCheck);
    expect(builtInHealthChecks[1]).toBe(essentialServicesCheck);
    expect(builtInHealthChecks[2]).toBe(dbConnectionCheck);
    expect(builtInHealthChecks[3]).toBe(providerSmokeCheck);
    expect(builtInHealthChecks.map((check) => check.name)).toEqual([
      "runtime-ready",
      "essential-services",
      "db-connection",
      "provider-smoke",
    ]);
    expect(builtInHealthChecks.every((check) => check.required)).toBe(true);
  });
});
