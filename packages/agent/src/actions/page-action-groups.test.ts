import {
  type Action,
  type ActionParameters,
  type IAgentRuntime,
  type Memory,
  validateToolArgs,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { pageDelegateAction } from "./page-action-groups.ts";

function recordingChild(
  fields: Pick<Action, "name" | "contexts" | "parameters" | "similes">,
  seen: unknown[],
): Action {
  return {
    ...fields,
    description: fields.name,
    validate: async () => true,
    handler: async (_runtime, _message, _state, options) => {
      seen.push(options?.parameters);
      return { success: true };
    },
  };
}

async function delegate(
  children: Action[],
  args: Record<string, unknown>,
): Promise<void> {
  const validated = validateToolArgs(pageDelegateAction, args);
  expect(validated.errors).toEqual([]);
  await pageDelegateAction.handler(
    { actions: [pageDelegateAction, ...children] } as IAgentRuntime,
    { content: { text: "request" } } as Memory,
    undefined,
    { parameters: validated.args as ActionParameters },
  );
}

describe("PAGE_DELEGATE call shape", () => {
  it("declares only page and action; child fields are forwarded from the top level", async () => {
    expect(pageDelegateAction.parameters?.map((p) => p.name)).toEqual([
      "page",
      "action",
    ]);
    const seen: unknown[] = [];
    const browser = recordingChild(
      { name: "BROWSER", contexts: ["browser"] },
      seen,
    );
    await delegate([browser], {
      page: "browser",
      action: "BROWSER",
      subaction: "navigate",
      url: "https://example.com",
    });
    expect(seen).toEqual([
      { subaction: "navigate", url: "https://example.com" },
    ]);
  });

  it("does not advertise the character page, which no child action is registered under", async () => {
    expect(
      validateToolArgs(pageDelegateAction, {
        page: "character",
        action: "CHARACTER_MODIFY",
      }).valid,
    ).toBe(false);
    // The character actions declare the settings context, so the child name
    // the `action` description advertises is reached through that page.
    const seen: unknown[] = [];
    const character = recordingChild(
      {
        name: "CHARACTER",
        contexts: ["settings", "agent_internal", "media", "admin"],
        parameters: [
          {
            name: "action",
            description: "op",
            required: true,
            schema: {
              type: "string",
              enum: ["modify", "persist", "update_identity"],
            },
          },
          {
            name: "request",
            description: "change",
            required: false,
            schema: { type: "string" },
          },
        ],
      },
      seen,
    );
    await delegate([character], {
      page: "settings",
      action: "CHARACTER_MODIFY",
      request: "be more playful",
    });
    expect(seen).toEqual([{ action: "modify", request: "be more playful" }]);
  });

  it("advertises a wallet child name that resolves to the WALLET discriminator", async () => {
    const advertised = pageDelegateAction.parameters?.find(
      (p) => p.name === "action",
    )?.description;
    expect(advertised).toContain("WALLET_TOKEN_INFO");
    const seen: unknown[] = [];
    const wallet = recordingChild(
      {
        name: "WALLET",
        contexts: ["finance", "crypto", "wallet"],
        parameters: [
          {
            name: "action",
            description: "Wallet operation.",
            required: true,
            schema: { type: "string", enum: ["transfer", "token_info"] },
          },
          {
            name: "query",
            description: "Token query.",
            required: false,
            schema: { type: "string" },
          },
        ],
      },
      seen,
    );
    await delegate([wallet], {
      page: "wallet",
      action: "WALLET_TOKEN_INFO",
      query: "SOL",
    });
    expect(seen).toEqual([{ action: "token_info", query: "SOL" }]);
  });

  // The legacy similes resolve to the umbrella child but carry no operation,
  // and PAGE_DELEGATE consumes `action`, so the child fails on its required
  // discriminator. Only the <CHILD>_<operation> names may be advertised.
  it.each([
    {
      page: "settings",
      advertised: "SETTINGS_UPDATE_AI_PROVIDER",
      legacy: "UPDATE_AI_PROVIDER",
      child: "SETTINGS",
      contexts: ["settings"],
      op: "update_ai_provider",
    },
    {
      page: "connectors",
      advertised: "PLUGIN_LIST",
      legacy: "LIST_CONNECTORS",
      child: "PLUGIN",
      contexts: ["connectors"],
      op: "list",
    },
    {
      page: "settings",
      advertised: "CHARACTER_MODIFY",
      legacy: "MODIFY_CHARACTER",
      child: "CHARACTER",
      contexts: ["settings"],
      op: "modify",
    },
  ])(
    "advertises $advertised, which delivers the $child operation",
    async ({ page, advertised, legacy, child, contexts, op }) => {
      const description = pageDelegateAction.parameters?.find(
        (p) => p.name === "action",
      )?.description;
      expect(description).toContain(advertised);
      expect(description?.replace(advertised, "")).not.toContain(legacy);
      const seen: unknown[] = [];
      const umbrella = recordingChild(
        {
          name: child,
          similes: [legacy],
          contexts,
          parameters: [
            {
              name: "action",
              description: "Operation.",
              required: true,
              schema: { type: "string", enum: [op, "other"] },
            },
          ],
        },
        seen,
      );
      await delegate([umbrella], { page, action: advertised });
      expect(seen).toEqual([{ action: op }]);
    },
  );
});
