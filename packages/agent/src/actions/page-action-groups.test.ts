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
  fields: Pick<Action, "name" | "contexts" | "parameters">,
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
});
