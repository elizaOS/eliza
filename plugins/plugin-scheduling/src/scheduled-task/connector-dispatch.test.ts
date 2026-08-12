/**
 * Connector-transport dispatch for the default scheduled-task dispatcher.
 *
 * Covers the target grammar, the connector-availability probe, disposition →
 * DispatchResult translation, and the default dispatcher's routing order
 * (connector path first for channel destinations, notification fallback for
 * everything else).
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import {
  dispatchViaMessageConnector,
  resolveConnectorDispatchTarget,
  runtimeHasMessageConnector,
} from "./connector-dispatch.js";
import type { ScheduledTaskDispatchRecord } from "./runner.js";
import { ScheduledTaskRunnerService } from "./runner-service.js";

function makeRecord(
  overrides: Partial<ScheduledTaskDispatchRecord> = {},
): ScheduledTaskDispatchRecord {
  return {
    taskId: "st_test_1",
    kind: "reminder",
    firedAtIso: "2026-08-12T09:00:00.000Z",
    channelKey: "discord",
    promptInstructions: "Tell the owner good morning.",
    contextRequest: undefined,
    output: {
      destination: "channel",
      target: "discord:user:308276393450668032",
    },
    ...overrides,
  };
}

function makeRuntime(opts: {
  connectors?: string[];
  sendResult?: unknown;
  sendError?: Error;
}): IAgentRuntime & { sends: Array<{ target: unknown; content: unknown }> } {
  const sends: Array<{ target: unknown; content: unknown }> = [];
  return {
    agentId: "00000000-0000-0000-0000-00000000beef",
    sends,
    getService: () => null,
    useModel: async () => "Rendered dispatch message.",
    reportError: () => undefined,
    getMessageConnectors: () =>
      (opts.connectors ?? []).map((source) => ({ source })),
    sendMessageToTarget: async (target: unknown, content: unknown) => {
      sends.push({ target, content });
      if (opts.sendError) throw opts.sendError;
      return opts.sendResult;
    },
  } as unknown as IAgentRuntime & {
    sends: Array<{ target: unknown; content: unknown }>;
  };
}

describe("resolveConnectorDispatchTarget — target grammar", () => {
  it("parses prefixed user targets into entityId TargetInfo", () => {
    const resolved = resolveConnectorDispatchTarget(makeRecord());
    expect(resolved).toEqual({
      source: "discord",
      targetInfo: { source: "discord", entityId: "308276393450668032" },
      rawTarget: "discord:user:308276393450668032",
    });
  });

  it("parses channel targets, prefixed and bare", () => {
    expect(
      resolveConnectorDispatchTarget(
        makeRecord({
          output: { destination: "channel", target: "discord:channel:123" },
        }),
      )?.targetInfo,
    ).toEqual({ source: "discord", channelId: "123" });
    expect(
      resolveConnectorDispatchTarget(
        makeRecord({
          output: { destination: "channel", target: "discord:123" },
        }),
      )?.targetInfo,
    ).toEqual({ source: "discord", channelId: "123" });
    // No channelKey prefix at all — still a channel id for that channel key.
    expect(
      resolveConnectorDispatchTarget(
        makeRecord({ output: { destination: "channel", target: "456" } }),
      )?.targetInfo,
    ).toEqual({ source: "discord", channelId: "456" });
  });

  it("returns null for non-channel destinations, in-process keys, and empty targets", () => {
    expect(
      resolveConnectorDispatchTarget(
        makeRecord({ output: { destination: "in_app_card" } }),
      ),
    ).toBeNull();
    expect(
      resolveConnectorDispatchTarget(
        makeRecord({
          channelKey: "in_app",
          output: { destination: "channel", target: "in_app" },
        }),
      ),
    ).toBeNull();
    expect(
      resolveConnectorDispatchTarget(
        makeRecord({ output: { destination: "channel" } }),
      ),
    ).toBeNull();
    expect(
      resolveConnectorDispatchTarget(
        makeRecord({
          output: { destination: "channel", target: "discord:user:" },
        }),
      ),
    ).toBeNull();
  });
});

describe("runtimeHasMessageConnector", () => {
  it("requires the transport method and a matching registered source", () => {
    expect(
      runtimeHasMessageConnector(
        makeRuntime({ connectors: ["discord"] }),
        "discord",
      ),
    ).toBe(true);
    expect(
      runtimeHasMessageConnector(
        makeRuntime({ connectors: ["telegram"] }),
        "discord",
      ),
    ).toBe(false);
    const noTransport = {
      getMessageConnectors: () => [{ source: "discord" }],
    } as unknown as IAgentRuntime;
    expect(runtimeHasMessageConnector(noTransport, "discord")).toBe(false);
  });
});

describe("dispatchViaMessageConnector — disposition translation", () => {
  it("returns null when no connector matches (caller falls through)", async () => {
    const runtime = makeRuntime({ connectors: ["telegram"] });
    expect(
      await dispatchViaMessageConnector(runtime, makeRecord(), "body"),
    ).toBeNull();
    expect(runtime.sends).toHaveLength(0);
  });

  it("delivers the rendered body (agentVoiced) and reports ok with the provider id", async () => {
    const runtime = makeRuntime({
      connectors: ["discord"],
      sendResult: {
        kind: "delivered",
        receipt: {
          providerMessageIds: ["mid-1"],
          acceptedAt: Date.now(),
          persistence: { status: "persisted", memoryIds: ["m-1"] },
        },
        memories: [],
      },
    });
    const result = await dispatchViaMessageConnector(
      runtime,
      makeRecord(),
      "morning brief body",
    );
    expect(result).toMatchObject({
      ok: true,
      messageId: "mid-1",
      channelKey: "discord",
      target: "discord:user:308276393450668032",
    });
    expect(runtime.sends).toHaveLength(1);
    const { target, content } = runtime.sends[0] as {
      target: { source: string; entityId: string };
      content: { text: string; agentVoiced: boolean };
    };
    expect(target).toMatchObject({
      source: "discord",
      entityId: "308276393450668032",
    });
    expect(content.text).toBe("morning brief body");
    expect(content.agentVoiced).toBe(true);
  });

  it("treats a legacy Memory return as delivered", async () => {
    const runtime = makeRuntime({
      connectors: ["discord"],
      sendResult: { id: "11111111-2222-3333-4444-555555555555", content: {} },
    });
    const result = await dispatchViaMessageConnector(
      runtime,
      makeRecord(),
      "body",
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("maps not_delivered to a typed disconnected failure", async () => {
    const runtime = makeRuntime({
      connectors: ["discord"],
      sendResult: {
        kind: "not_delivered",
        code: "client_not_ready",
        message: "Discord client is not ready.",
      },
    });
    const result = await dispatchViaMessageConnector(
      runtime,
      makeRecord(),
      "body",
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "disconnected",
      acceptance: "not_accepted",
      userActionable: true,
    });
  });

  it("maps an unknown/no-evidence outcome to a non-retryable-by-default transport error", async () => {
    const runtime = makeRuntime({
      connectors: ["discord"],
      sendResult: undefined,
    });
    const result = await dispatchViaMessageConnector(
      runtime,
      makeRecord(),
      "body",
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "transport_error",
      acceptance: "unknown",
    });
  });

  it("translates a transport throw into a typed failure and reports it", async () => {
    const reportError = vi.fn();
    const runtime = makeRuntime({
      connectors: ["discord"],
      sendError: new Error("socket hang up"),
    });
    (runtime as unknown as { reportError: unknown }).reportError = reportError;
    const result = await dispatchViaMessageConnector(
      runtime,
      makeRecord(),
      "body",
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "transport_error",
      acceptance: "unknown",
      message: "socket hang up",
    });
    expect(reportError).toHaveBeenCalledWith(
      "scheduling:scheduled-task:connector-dispatch",
      expect.any(Error),
      expect.objectContaining({ taskId: "st_test_1", source: "discord" }),
    );
  });
});

describe("default dispatcher routing — connector path before notification fallback", () => {
  it("routes a discord channel-destination fire through the connector transport", async () => {
    const runtime = makeRuntime({
      connectors: ["discord"],
      sendResult: {
        kind: "delivered",
        receipt: {
          providerMessageIds: ["mid-2"],
          acceptedAt: Date.now(),
          persistence: { status: "persisted", memoryIds: ["m-2"] },
        },
        memories: [],
      },
    });
    const service = await ScheduledTaskRunnerService.start(runtime);
    const runner = service.getRunner({ agentId: runtime.agentId });
    const task = await runner.schedule({
      kind: "reminder",
      promptInstructions: "Morning brief for the owner.",
      trigger: { kind: "manual" },
      priority: "low",
      respectsGlobalPause: false,
      source: "plugin",
      createdBy: runtime.agentId,
      ownerVisible: true,
      output: {
        destination: "channel",
        target: "discord:user:308276393450668032",
      },
      escalation: { steps: [{ delayMinutes: 0, channelKey: "discord" }] },
    });
    const fired = await runner.fire(task.taskId);
    expect(fired.state.status).toBe("fired");
    expect(runtime.sends).toHaveLength(1);
    expect(fired.metadata?.lastDispatchResult).toMatchObject({
      ok: true,
      messageId: "mid-2",
      channelKey: "discord",
    });
    // The delivered text is the model rendering, not the raw instruction.
    const sent = runtime.sends[0] as { content: { text: string } };
    expect(sent.content.text).toBe("Rendered dispatch message.");
  });

  it("keeps the in_app notification fallback for non-connector dispatches", async () => {
    const runtime = makeRuntime({ connectors: ["discord"] });
    const service = await ScheduledTaskRunnerService.start(runtime);
    const runner = service.getRunner({ agentId: runtime.agentId });
    const task = await runner.schedule({
      kind: "reminder",
      promptInstructions: "In-app nudge.",
      trigger: { kind: "manual" },
      priority: "low",
      respectsGlobalPause: false,
      source: "plugin",
      createdBy: runtime.agentId,
      ownerVisible: true,
      output: { destination: "channel", target: "in_app" },
    });
    const fired = await runner.fire(task.taskId);
    expect(fired.state.status).toBe("fired");
    expect(runtime.sends).toHaveLength(0);
    expect(fired.metadata?.lastDispatchResult).toMatchObject({
      ok: true,
      messageId: expect.stringContaining("in_app:"),
    });
  });
});
