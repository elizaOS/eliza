/**
 * Unit coverage for `executeFallbackParsedActions`: when the runtime parses
 * fallback tool calls out of a model response, each action's raw callback text
 * is rewritten through a TEXT_SMALL model pass into a natural reply before it is
 * appended. Deterministic — the runtime, services, and `useModel` are vitest
 * mocks; no live model.
 */
import type { Action, AgentRuntime } from "@elizaos/core";
import {
  createMessageMemory,
  EventType,
  ModelType,
  stringToUuid,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { executeFallbackParsedActions } from "./fallback-action-helpers.ts";

describe("executeFallbackParsedActions", () => {
  it("rewrites fallback action callback text through TEXT_SMALL before appending", async () => {
    const action: Action = {
      name: "CUSTOM_FALLBACK",
      description: "Block a site",
      parameters: [
        {
          name: "target",
          description: "Site to block",
          required: false,
          schema: { type: "string" },
        },
      ],
      validate: vi.fn(async () => true),
      handler: vi.fn(async (_runtime, _message, _state, _options, callback) => {
        await callback?.({ text: "stdout: block active for example.com" });
        return { success: true };
      }),
    } as Action;
    const runtime = {
      agentId: stringToUuid("fallback-agent"),
      actions: [action],
      character: { name: "Example" },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      getService: vi.fn(() => ({
        getLoadedSkill: vi.fn(() => ({ slug: "example-skill" })),
      })),
      getRoom: vi.fn(async () => ({
        id: stringToUuid("fallback-room"),
        worldId: stringToUuid("fallback-world"),
      })),
      getWorld: vi.fn(async () => ({
        id: stringToUuid("fallback-world"),
        metadata: {
          roles: { [stringToUuid("fallback-user")]: "OWNER" },
        },
      })),
      getSetting: vi.fn(() => undefined),
      useModel: vi.fn(async (modelType, params) => {
        expect(modelType).toBe(ModelType.TEXT_SMALL);
        expect(String((params as { prompt?: string }).prompt)).toContain(
          "stdout: block active for example.com",
        );
        expect(params).not.toHaveProperty("maxTokens");
        return JSON.stringify({
          response: "I turned on the block for example.com.",
        });
      }),
    } as unknown as AgentRuntime;
    const message = createMessageMemory({
      id: stringToUuid("fallback-message"),
      entityId: stringToUuid("fallback-user"),
      roomId: stringToUuid("fallback-room"),
      content: { text: "block example.com", source: "test" },
    });
    const appended: string[] = [];
    const callbacks: Array<{ actionTag: string; hasText: boolean }> = [];

    const executions = await executeFallbackParsedActions(
      runtime,
      message,
      [{ name: "CUSTOM_FALLBACK", parameters: { target: "example.com" } }],
      (incoming) => appended.push(incoming),
      (actionTag, hasText) => callbacks.push({ actionTag, hasText }),
    );

    expect(appended).toEqual(["I turned on the block for example.com."]);
    expect(callbacks).toEqual([
      { actionTag: "CUSTOM_FALLBACK", hasText: true },
    ]);
    expect(executions).toEqual([
      { actionName: "CUSTOM_FALLBACK", success: true },
    ]);
    expect(runtime.useModel).toHaveBeenCalledWith(
      ModelType.TEXT_SMALL,
      expect.any(Object),
    );
  });

  it("executes a context- and role-gated fallback through the central gate", async () => {
    const userId = stringToUuid("gated-fallback-user");
    const roomId = stringToUuid("gated-fallback-room");
    const worldId = stringToUuid("gated-fallback-world");
    const handler = vi.fn(
      async (_runtime, _message, _state, options, callback) => {
        await callback?.({ text: "block enabled" });
        return { success: true, data: { parameters: options.parameters } };
      },
    );
    const action: Action = {
      name: "GATED_FALLBACK",
      description: "Production-shaped gated fallback",
      contexts: ["browser"],
      roleGate: { minRole: "OWNER" },
      parameters: [
        {
          name: "action",
          description: "Operation",
          required: true,
          schema: { type: "string", enum: ["block"] },
        },
      ],
      validate: vi.fn(async () => true),
      handler,
    };
    const runtime = {
      agentId: stringToUuid("gated-fallback-agent"),
      actions: [action],
      character: { name: "Example" },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      getRoom: vi.fn(async () => ({ id: roomId, worldId })),
      getWorld: vi.fn(async () => ({
        id: worldId,
        metadata: { roles: { [userId]: "OWNER" } },
      })),
      getSetting: vi.fn((key: string) =>
        key === "ELIZA_ADMIN_ENTITY_ID" ? userId : undefined,
      ),
      getService: vi.fn(() => null),
      useModel: vi.fn(async () =>
        JSON.stringify({ response: "I enabled the block." }),
      ),
    } as unknown as AgentRuntime;
    const appended: string[] = [];

    await executeFallbackParsedActions(
      runtime,
      createMessageMemory({
        id: stringToUuid("gated-fallback-message"),
        entityId: userId,
        agentId: runtime.agentId,
        roomId,
        content: { text: "block distractions", source: "test" },
      }),
      [{ name: action.name, parameters: { action: "block" } }],
      (incoming) => appended.push(incoming),
      vi.fn(),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      runtime,
      expect.any(Object),
      undefined,
      expect.objectContaining({ parameters: { action: "block" } }),
      expect.any(Function),
      undefined,
    );
    expect(appended).toEqual(["I enabled the block."]);
  });

  it("does not enter the action handler when cancellation wins during preflight", async () => {
    const caller = new AbortController();
    const handler = vi.fn(async () => ({ success: true, text: "committed" }));
    const action: Action = {
      name: "CANCELLED_FALLBACK",
      description: "An action whose validation races with cancellation.",
      validate: vi.fn(async () => {
        caller.abort(new DOMException("socket closed", "AbortError"));
        return true;
      }),
      handler,
    };
    const runtime = {
      agentId: stringToUuid("cancelled-fallback-agent"),
      actions: [action],
      character: { name: "Example" },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      getRoom: vi.fn(async () => null),
      getWorld: vi.fn(async () => null),
      getSetting: vi.fn(() => undefined),
      getService: vi.fn(() => null),
      emitEvent: vi.fn(async () => undefined),
      useModel: vi.fn(),
    } as unknown as AgentRuntime;
    const appended: string[] = [];

    const executions = await executeFallbackParsedActions(
      runtime,
      createMessageMemory({
        id: stringToUuid("cancelled-fallback-message"),
        entityId: stringToUuid("cancelled-fallback-user"),
        roomId: stringToUuid("cancelled-fallback-room"),
        content: { text: "run it", source: "test" },
      }),
      [{ name: action.name }],
      (incoming) => appended.push(incoming),
      vi.fn(),
      { abortSignal: caller.signal },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(runtime.emitEvent).not.toHaveBeenCalledWith(
      EventType.ACTION_STARTED,
      expect.anything(),
    );
    expect(appended).toEqual([]);
    expect(executions).toEqual([
      { actionName: "CANCELLED_FALLBACK", success: false },
    ]);
  });
});
