import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "../api";
import { surfaceCloudLoginRetryTurn } from "./use-first-run-conductor";

function applyRetry(existing: ConversationMessage[]): ConversationMessage[] {
  let messages = [...existing];
  surfaceCloudLoginRetryTurn({
    seedTurn(turn) {
      messages = messages.some((message) => message.id === turn.id)
        ? messages
        : [...messages, turn];
    },
    replaceTurn(id, next) {
      messages = messages.map((message) =>
        message.id === id ? next : message,
      );
    },
  });
  return messages;
}

describe("surfaceCloudLoginRetryTurn", () => {
  it("adds the cloud OAuth retry turn when the hybrid path never seeded one", () => {
    const messages = applyRetry([
      {
        id: "first-run:provider",
        role: "assistant",
        text: "Which model provider should Eliza use?",
        timestamp: 1,
        source: "first_run",
      },
    ]);

    expect(messages.map((message) => message.id)).toEqual([
      "first-run:provider",
      "first-run:cloud-oauth",
    ]);
    expect(messages[1]?.secretRequest?.status).toBe("failed");
    expect(messages[1]?.secretRequest?.form?.kind).toBe("oauth");
    expect(messages[1]?.text).toContain("Connect your Eliza Cloud account");
  });

  it("replaces the existing cloud OAuth turn on the managed-cloud path", () => {
    const messages = applyRetry([
      {
        id: "first-run:cloud-oauth",
        role: "assistant",
        text: "Connecting your Eliza Cloud account...",
        timestamp: 1,
        source: "first_run",
        secretRequest: {
          key: "elizacloud",
          reason: "Connect your Eliza Cloud account",
          status: "pending",
          form: {
            type: "sensitive_request_form",
            kind: "oauth",
            mode: "cloud_authenticated_link",
            fields: [],
            submitLabel: "Connect Eliza Cloud",
            provider: "elizacloud",
            authorizationUrl: "https://example.test",
          },
        },
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("first-run:cloud-oauth");
    expect(messages[0]?.secretRequest?.status).toBe("failed");
    expect(messages[0]?.text).toContain("then pick Eliza Cloud again");
  });
});
