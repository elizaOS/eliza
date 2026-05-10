/**
 * `DEVICE_INTENT` action integration test.
 *
 * Closes the gap from `docs/audits/lifeops-2026-05-09/03-coverage-gap-matrix.md`
 * line 441: `deviceIntentAction` had no executable test.
 *
 * Exercises handler → broadcastIntent → SQL insert. We stub the runtime
 * adapter's `db.execute` so we can assert that:
 *   1. an INSERT into `app_lifeops.life_intents` is issued exactly once
 *   2. the returned LifeOpsIntent has the right `kind`, `target`, title, body
 *   3. the callback path fires with a human-readable broadcast confirmation
 *
 * No DB is required — the test owns the SQL surface and asserts the contract.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { deviceIntentAction } from "../src/actions/device-intent.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

interface CapturedQuery {
  text: string;
}

function runtimeWithStubDb(): {
  runtime: IAgentRuntime;
  queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];
  const base = createMinimalRuntimeStub();
  const runtime = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "adapter") {
        return {
          db: {
            async execute(query: { queryChunks: Array<{ value?: unknown }> }) {
              const text = query.queryChunks
                .flatMap((chunk) => {
                  const value = chunk?.value;
                  if (typeof value === "string") return [value];
                  if (Array.isArray(value)) {
                    return value.filter(
                      (v): v is string => typeof v === "string",
                    );
                  }
                  return [];
                })
                .join("");
              queries.push({ text });
              return { rows: [] };
            },
          },
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as IAgentRuntime;
  return { runtime, queries };
}

function ownerMessage(runtime: IAgentRuntime, text: string): Memory {
  return {
    id: ("msg-" + Math.random().toString(36).slice(2, 8)) as UUID,
    entityId: runtime.agentId as UUID,
    roomId: runtime.agentId as UUID,
    agentId: runtime.agentId as UUID,
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

describe("DEVICE_INTENT integration", () => {
  it("broadcasts a routine_reminder to mobile devices and INSERTs the intent row", async () => {
    const { runtime, queries } = runtimeWithStubDb();
    let lastCallbackText: string | undefined;
    const result = await deviceIntentAction.handler?.(
      runtime,
      ownerMessage(runtime, "broadcast a phone reminder"),
      undefined,
      {
        parameters: {
          kind: "routine_reminder",
          target: "mobile",
          title: "Stretch break",
          body: "Stand up for 60 seconds",
          priority: "high",
        },
      },
      async (payload) => {
        lastCallbackText = payload.text;
        return [];
      },
      [],
    );

    expect(result?.success).toBe(true);
    expect(lastCallbackText ?? "").toMatch(/Stretch break.*mobile/);

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toMatch(/INSERT INTO app_lifeops\.life_intents/);
    expect(queries[0]?.text).toContain("'routine_reminder'");
    expect(queries[0]?.text).toContain("'mobile'");
    expect(queries[0]?.text).toContain("'Stretch break'");
    expect(queries[0]?.text).toContain("'Stand up for 60 seconds'");
    expect(queries[0]?.text).toContain("'high'");

    const data = result?.data as
      | { intent?: { kind?: string; target?: string; title?: string } }
      | undefined;
    expect(data?.intent?.kind).toBe("routine_reminder");
    expect(data?.intent?.target).toBe("mobile");
    expect(data?.intent?.title).toBe("Stretch break");
  });

  it("defaults to user_action_requested kind and target=all when not specified", async () => {
    const { runtime, queries } = runtimeWithStubDb();
    const result = await deviceIntentAction.handler?.(
      runtime,
      ownerMessage(runtime, "ping all devices titled 'check in' saying 'heads up'"),
      undefined,
      { parameters: {} },
      async () => [],
      [],
    );

    expect(result?.success).toBe(true);
    expect(queries).toHaveLength(1);
    // No explicit kind/target → planner inference defaults to user_action_requested + all.
    expect(queries[0]?.text).toContain("'user_action_requested'");
    expect(queries[0]?.text).toContain("'all'");
    // Quoted-substring inference picks up titled/saying.
    expect(queries[0]?.text).toContain("'check in'");
    expect(queries[0]?.text).toContain("'heads up'");
  });

  it("sets target_device_id when target=specific is passed", async () => {
    const { runtime, queries } = runtimeWithStubDb();
    const result = await deviceIntentAction.handler?.(
      runtime,
      ownerMessage(runtime, "ring just my phone"),
      undefined,
      {
        parameters: {
          target: "specific",
          targetDeviceId: "device_abc",
          title: "Ring",
          body: "ringing",
          kind: "attention_request",
        },
      },
      async () => [],
      [],
    );

    expect(result?.success).toBe(true);
    expect(queries[0]?.text).toContain("'device_abc'");
    expect(queries[0]?.text).toContain("'specific'");
    expect(queries[0]?.text).toContain("'attention_request'");
    const data = result?.data as
      | { intent?: { targetDeviceId?: string } }
      | undefined;
    expect(data?.intent?.targetDeviceId).toBe("device_abc");
  });
});
