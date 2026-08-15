/** Deterministic transport coverage for Dedicated delivery of migrated Shared reminders. */

import type { IAgentRuntime } from "@elizaos/core";
import {
  getScheduledTaskChannelDispatcher,
  SHARED_CUTOVER_GATEWAY_CHANNEL,
} from "@elizaos/plugin-scheduling";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSharedCutoverReminderDispatcher } from "./shared-cutover-reminder-dispatch.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function record() {
  return {
    taskId: "shared-reminder-1",
    kind: "reminder" as const,
    firedAtIso: "2026-08-15T17:00:00.000Z",
    channelKey: SHARED_CUTOVER_GATEWAY_CHANNEL,
    promptInstructions: "private source text must not cross this request",
    ownerVisible: true,
    contextRequest: undefined,
  };
}

describe("Shared cutover reminder dispatcher", () => {
  it("sends only task identity and occurrence through the authenticated Cloud boundary", async () => {
    const runtime = { agentId: "dedicated-agent" } as IAgentRuntime;
    globalThis.fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe(
        "https://api.eliza.app/api/v1/eliza/agents/dedicated-agent/shared-reminders/shared-reminder-1/deliver",
      );
      expect(new Headers(init?.headers).get("x-api-key")).toBe("agent-key");
      expect(JSON.parse(String(init?.body))).toEqual({
        firedAtIso: "2026-08-15T17:00:00.000Z",
      });
      expect(String(init?.body)).not.toContain("private source text");
      return Response.json({
        success: true,
        metadata: { providerMessageIds: ["91"] },
      });
    }) as unknown as typeof fetch;

    expect(
      registerSharedCutoverReminderDispatcher(runtime, {
        ELIZAOS_CLOUD_API_KEY: "agent-key",
        ELIZA_CLOUD_AGENT_ID: "dedicated-agent",
      }),
    ).toBe(true);
    const contribution = getScheduledTaskChannelDispatcher(
      runtime,
      SHARED_CUTOVER_GATEWAY_CHANNEL,
    );
    await expect(contribution?.dispatch(record())).resolves.toMatchObject({
      ok: true,
      metadata: { providerMessageIds: ["91"] },
    });
  });

  it("keeps an indeterminate Cloud receipt failed instead of marking the task fired", async () => {
    const runtime = { agentId: "dedicated-agent" } as IAgentRuntime;
    globalThis.fetch = vi.fn(async () =>
      Response.json({ success: false, acceptance: "unknown" }, { status: 202 }),
    ) as unknown as typeof fetch;
    registerSharedCutoverReminderDispatcher(runtime, {
      ELIZAOS_CLOUD_API_KEY: "agent-key",
      ELIZA_CLOUD_AGENT_ID: "dedicated-agent",
    });

    await expect(
      getScheduledTaskChannelDispatcher(
        runtime,
        SHARED_CUTOVER_GATEWAY_CHANNEL,
      )?.dispatch(record()),
    ).resolves.toMatchObject({
      ok: false,
      reason: "transport_error",
      acceptance: "unknown",
    });
  });

  it("preserves an explicit Cloud failure reason instead of treating every conflict as rate limiting", async () => {
    const runtime = { agentId: "dedicated-agent" } as IAgentRuntime;
    globalThis.fetch = vi.fn(async () =>
      Response.json(
        {
          success: false,
          reason: "unknown_recipient",
          acceptance: "not_accepted",
        },
        { status: 409 },
      ),
    ) as unknown as typeof fetch;
    registerSharedCutoverReminderDispatcher(runtime, {
      ELIZAOS_CLOUD_API_KEY: "agent-key",
      ELIZA_CLOUD_AGENT_ID: "dedicated-agent",
    });

    await expect(
      getScheduledTaskChannelDispatcher(
        runtime,
        SHARED_CUTOVER_GATEWAY_CHANNEL,
      )?.dispatch(record()),
    ).resolves.toEqual({
      ok: false,
      reason: "unknown_recipient",
      userActionable: true,
      acceptance: "not_accepted",
    });
  });
});
