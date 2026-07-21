/**
 * Unit coverage for the runtime health checks that gate runtime promotion.
 * The database check delegates to the same real probe as `/api/health`, while
 * the surrounding checks keep optional runtime surfaces fail-closed only where
 * they can prove a real broken dependency.
 */

import type { AgentRuntime } from "@elizaos/core";
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

describe("built-in runtime health checks", () => {
  it("checks required runtime identity before promotion", async () => {
    await expect(runtimeReadyCheck.run(runtime())).resolves.toEqual({
      ok: true,
    });
    await expect(
      runtimeReadyCheck.run(runtime({ agentId: "" })),
    ).resolves.toMatchObject({
      ok: false,
      reason: "runtime.agentId is empty",
    });
    await expect(
      runtimeReadyCheck.run(runtime({ character: { name: " " } })),
    ).resolves.toMatchObject({
      ok: false,
      reason: "runtime.character.name is empty",
    });
  });

  it("fails only registered services that report failed", async () => {
    await expect(essentialServicesCheck.run(runtime())).resolves.toEqual({
      ok: true,
    });
    await expect(
      essentialServicesCheck.run(
        runtime({
          getRegisteredServiceTypes: () => ["ok", "bad"],
          getServiceRegistrationStatus: (type: string) =>
            type === "bad" ? "failed" : "registered",
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: "service bad is in failed state",
    });
  });

  it("passes unknown database surfaces but fails transient and terminal probe errors", async () => {
    await expect(dbConnectionCheck.run(runtime())).resolves.toEqual({
      ok: true,
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
    ).resolves.toMatchObject({
      ok: false,
      reason: "transient_error: temporary probe timeout",
    });
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
    ).resolves.toMatchObject({
      ok: false,
      reason: "terminal_error: PGlite is closed",
    });
  });

  it("classifies provider smoke responses without hiding quota failures", async () => {
    await expect(providerSmokeCheck.run(runtime())).resolves.toEqual({
      ok: true,
    });
    await expect(
      providerSmokeCheck.run(
        runtime({
          async useModel() {
            return "";
          },
        }),
      ),
    ).resolves.toEqual({ ok: true });

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

    await expect(
      providerSmokeCheck.run(
        runtime({
          async useModel() {
            throw new Error("transport down");
          },
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: "provider unreachable: transport down",
    });
  });

  it("exports the expected default check set and diagnostic formatter", () => {
    expect(builtInHealthChecks.map((check) => check.name)).toEqual([
      "runtime-ready",
      "essential-services",
      "db-connection",
      "provider-smoke",
    ]);
    expect(describeError("plain")).toBe("plain");
    expect(describeError({ code: "E_TEST" })).toBe('{"code":"E_TEST"}');
  });
});
