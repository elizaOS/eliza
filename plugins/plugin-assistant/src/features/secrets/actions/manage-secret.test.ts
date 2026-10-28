/**
 * Exercises the planner-facing `SECRETS` umbrella action: validation gates,
 * normalized action resolution, rejection of unknown operations, and dispatch
 * to every real atomic handler. The runtime is a deterministic boundary stub;
 * no handler module, model, database, or secret implementation is mocked.
 */

import { ChannelType, validateToolArgs } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import { maskSecretValue, secretsAction } from "./manage-secret.ts";

function createRuntime(hasSecretsService = true) {
  return {
    agentId: "agent-1",
    getService: (name: string) =>
      name === "SECRETS" && hasSecretsService ? {} : null,
    getSetting: () => undefined,
    composeState: async () => ({ values: {} }),
    dynamicPromptExecFromState: async () => ({}),
  };
}

function createMessage(
  channelType: ChannelType | undefined = ChannelType.DM,
  metadata?: Record<string, unknown>,
) {
  return {
    entityId: "user-1",
    roomId: "room-1",
    content: { text: "manage a secret", channelType, metadata },
  };
}

async function validate(
  parameters: unknown,
  channelType: ChannelType | undefined = ChannelType.DM,
  metadata?: Record<string, unknown>,
  serviceAvailable = true,
) {
  return secretsAction.validate?.(
    createRuntime(serviceAvailable) as never,
    createMessage(channelType, metadata) as never,
    undefined,
    { parameters } as never,
  );
}

async function handle(parameters: unknown) {
  return secretsAction.handler(
    createRuntime(false) as never,
    createMessage() as never,
    undefined,
    { parameters } as never,
  );
}

describe("SECRETS umbrella action", () => {
  test("publishes the planner-facing action contract", () => {
    expect(secretsAction).toMatchObject({
      name: "SECRETS",
      contexts: ["secrets", "settings", "connectors"],
      roleGate: { minRole: "OWNER" },
      suppressPostActionContinuation: true,
    });
    expect(secretsAction.parameters?.[0]).toMatchObject({
      name: "action",
      required: true,
      schema: {
        type: "string",
        enum: ["get", "set", "delete", "list", "check", "request"],
      },
    });
  });

  test("re-exports the secret masking implementation", () => {
    expect(maskSecretValue("123456789")).toBe("1234*6789");
  });

  test("fails validation when the secrets service is unavailable", async () => {
    expect(
      await validate(
        { action: "request" },
        ChannelType.GROUP,
        undefined,
        false,
      ),
    ).toBe(false);
  });

  test("normalizes request and permits it in a public channel", async () => {
    expect(await validate({ action: "  ReQuEsT  " }, ChannelType.GROUP)).toBe(
      true,
    );
  });

  test("stays offered in a public channel when validate gets no arguments", async () => {
    // The planner tool surface calls validate with no options; `request`
    // must remain selectable there.
    expect(
      await secretsAction.validate?.(
        createRuntime() as never,
        createMessage(ChannelType.GROUP, {
          __responseContext: { primaryContext: "secrets" },
        }) as never,
        undefined,
      ),
    ).toBe(true);
  });

  test.each(["get", "set", "delete", "list", "check"])(
    "rejects action=%s in a public channel",
    async (action) => {
      expect(await validate({ action }, ChannelType.GROUP)).toBe(false);
    },
  );

  test.each(["get", "list", "check"])(
    "the handler refuses action=%s in a public channel without reading secrets",
    async (action) => {
      // PAGE_DELEGATE validates a child without arguments, then calls its
      // handler directly, so the handler must hold the DM rule itself.
      let reads = 0;
      const read = async () => {
        reads += 1;
        return "sk-abcdef12345678901234567890ABCD";
      };
      const runtime = {
        ...createRuntime(),
        getService: (name: string) =>
          name === "SECRETS"
            ? { get: read, list: read, exists: read, has: read }
            : null,
      };

      const result = await secretsAction.handler(
        runtime as never,
        createMessage(ChannelType.GROUP) as never,
        undefined,
        { parameters: { action, key: "OPENAI_API_KEY", mask: false } } as never,
      );

      expect(result).toMatchObject({
        success: false,
        text: "Refused: secrets can only be managed in DMs",
        data: { actionName: "SECRETS", action },
      });
      expect(reads).toBe(0);
    },
  );

  test.each([
    ["a supported action", { action: "get" }],
    ["a non-empty key", { key: " OPENAI_API_KEY " }],
    ["a non-empty secrets array", { secrets: [{ key: "K", value: "V" }] }],
  ])("accepts %s as a structured DM signal", async (_label, parameters) => {
    expect(await validate(parameters)).toBe(true);
  });

  test("accepts a supported action when channel type is omitted", async () => {
    expect(await validate({ action: "list" }, undefined)).toBe(true);
  });

  test("falls back to explicit secrets routing context", async () => {
    expect(
      await validate({}, ChannelType.DM, {
        __responseContext: { primaryContext: "secrets" },
      }),
    ).toBe(true);
  });

  test.each([
    ["missing parameters", undefined],
    ["null parameters", null],
    ["non-object parameters", "request"],
    ["an unknown action", { action: "rotate" }],
    ["a blank key", { key: "   " }],
    ["an empty secrets array", { secrets: [] }],
  ])("rejects %s without a matching context", async (_label, parameters) => {
    expect(await validate(parameters)).toBe(false);
  });

  test.each([
    ["missing parameters", undefined],
    ["a non-string action", { action: 42 }],
    ["a blank action", { action: "   " }],
    ["an unknown action", { action: "rotate" }],
  ])("returns an actionable failure for %s", async (_label, parameters) => {
    const result = await handle(parameters);

    expect(result).toMatchObject({
      success: false,
      data: { actionName: "SECRETS", action: null },
    });
    expect(result.text).toContain("No clear secret operation");
  });

  test.each([
    [" GET ", "get"],
    ["SET", "set"],
    ["delete", "delete"],
    ["list", "list"],
    ["check", "check"],
    ["request", "request"],
  ])("dispatches %s to the real %s handler", async (input, expected) => {
    const result = await handle({ action: input, key: "OPENAI_API_KEY" });

    expect(result.data).toMatchObject({
      actionName: "SECRETS",
      action: expected,
    });
  });

  test("the declared schema rejects the removed mirror operation", () => {
    // No registered service implements a vault write, so mirror is not offered.
    const validation = validateToolArgs(secretsAction, {
      action: "mirror",
      key: "OPENAI_API_KEY",
      vaultName: "vault",
    });

    expect(validation.errors).toEqual([
      "Unexpected argument 'vaultName'",
      "Argument 'action' value 'mirror' is not one of: get, set, delete, list, check, request",
    ]);
  });

  test("the declared schema accepts a key array for check", () => {
    const parameters = {
      action: "check",
      key: ["OPENAI_API_KEY", "DISCORD_BOT_TOKEN"],
    };

    const validation = validateToolArgs(secretsAction, parameters);

    expect(validation.errors).toEqual([]);
    expect(validation.args).toEqual(parameters);
  });

  test("set stores the planner's key and value without model extraction", async () => {
    const stored: unknown[][] = [];
    let extractions = 0;
    const runtime = {
      ...createRuntime(),
      getService: (name: string) =>
        name === "SECRETS"
          ? {
              set: async (...args: unknown[]) => {
                stored.push(args);
                return true;
              },
            }
          : null,
      dynamicPromptExecFromState: async () => {
        extractions += 1;
        return {};
      },
    };
    const parameters = {
      action: "set",
      key: "OPENAI_API_KEY",
      value: "sk-abc123",
      description: "OpenAI key",
      type: "api_key",
    };
    expect(validateToolArgs(secretsAction, parameters).errors).toEqual([]);

    const result = await secretsAction.handler(
      runtime as never,
      createMessage() as never,
      { values: {} } as never,
      { parameters } as never,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        action: "set",
        results: [{ key: "OPENAI_API_KEY", success: true }],
      },
    });
    expect(extractions).toBe(0);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.[0]).toBe("OPENAI_API_KEY");
    expect(stored[0]?.[1]).toBe("sk-abc123");
    expect(stored[0]?.[3]).toMatchObject({
      type: "api_key",
      description: "OpenAI key",
    });
  });
});
