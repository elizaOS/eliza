/**
 * Regression coverage for the external-content security envelope leak in the
 * create_comment handler: core's hardenIncomingUserMessage wraps content.text
 * in a ~2KB "SECURITY NOTICE … <<<EXTERNAL_UNTRUSTED_CONTENT>>>" envelope, and
 * the handler both regex-parsed the raw text (posting envelope text as the
 * comment body) and echoed a blob-shaped model-extracted issueDescription into
 * not-found / multi-match replies (live leak 2026-08-02, tj-2dc95f75456876).
 * Deterministic, mocked LinearService + model — no live API.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { ModelType, wrapExternalContent } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createCommentAction } from "./createComment";

/** A hardened inbound message exactly as core leaves it: wrapped text + stamp. */
function envelopedMessage(userSentence: string): Memory {
  const wrapped = wrapExternalContent(userSentence, {
    source: "api",
    includeWarning: true,
  });
  expect(wrapped.startsWith("SECURITY NOTICE")).toBe(true);
  expect(wrapped).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
  return {
    id: "msg",
    agentId: "agent",
    entityId: "entity",
    roomId: "room",
    content: {
      text: wrapped,
      source: "test",
      metadata: { externalContentWrapped: true },
    },
  } as unknown as Memory;
}

function runtime(service: Record<string, unknown>, modelResponse?: string): IAgentRuntime {
  return {
    getService: vi.fn((name: string) => (name === "linear" ? service : undefined)),
    getSetting: vi.fn(() => undefined),
    useModel: vi.fn(async (modelType) => {
      expect(modelType).toBe(ModelType.TEXT_LARGE);
      return modelResponse ?? "";
    }),
  } as unknown as IAgentRuntime;
}

function expectNoEnvelope(text: string | undefined) {
  expect(text).toBeDefined();
  expect(text).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
  expect(text).not.toContain("SECURITY NOTICE");
}

describe("createCommentAction — hardened-envelope messages never leak the envelope", () => {
  it("regex fallback parses the payload, not the envelope, and posts only the user's words", async () => {
    const service = {
      getIssue: vi.fn(async () => ({ id: "issue-id", identifier: "ENG-123" })),
      createComment: vi.fn(async () => ({ id: "comment-id", createdAt: new Date(0) })),
      getDefaultTeamKey: vi.fn(() => undefined),
    };
    const callback = vi.fn();

    const result = await createCommentAction.handler(
      runtime(service),
      envelopedMessage("Comment on ENG-123: This looks good to me"),
      undefined,
      undefined,
      callback
    );

    expect(result.success).toBe(true);
    expect(service.createComment).toHaveBeenCalledWith(
      { issueId: "issue-id", body: "This looks good to me" },
      "default"
    );
    expectNoEnvelope(result.text);
    expectNoEnvelope(callback.mock.calls[0]?.[0]?.text);
  });

  it("no-match reply renders a blob-shaped issueDescription as the neutral noun", async () => {
    const blob = envelopedMessage("irrelevant").content.text as string;
    const service = {
      searchIssues: vi.fn(async () => []),
      getDefaultTeamKey: vi.fn(() => undefined),
    };
    const callback = vi.fn();

    const result = await createCommentAction.handler(
      runtime(service, JSON.stringify({ issueDescription: blob, commentBody: "needs more info" })),
      envelopedMessage("Tell the login bug that we need more information"),
      undefined,
      undefined,
      callback
    );

    expect(result.success).toBe(false);
    expectNoEnvelope(result.text);
    expect(result.text).toContain("No issues found matching that issue");
    expectNoEnvelope(callback.mock.calls[0]?.[0]?.text);
  });

  it("multi-match clarify quotes a name-shaped description and clamps a blob-shaped one", async () => {
    const issues = [
      {
        id: "id-1",
        identifier: "ENG-1",
        title: "Login bug",
        state: Promise.resolve({ name: "Todo" }),
      },
      {
        id: "id-2",
        identifier: "ENG-2",
        title: "Login regression",
        state: Promise.resolve({ name: "In Progress" }),
      },
    ];
    const service = {
      searchIssues: vi.fn(async () => issues),
      getDefaultTeamKey: vi.fn(() => undefined),
    };

    const named = await createCommentAction.handler(
      runtime(service, JSON.stringify({ issueDescription: "login bug", commentBody: "hi" })),
      envelopedMessage("Tell the login bug something"),
      undefined,
      undefined,
      vi.fn()
    );
    expect(named.text).toContain('Found multiple issues matching "login bug"');

    const blob = envelopedMessage("irrelevant").content.text as string;
    const callback = vi.fn();
    const blobbed = await createCommentAction.handler(
      runtime(service, JSON.stringify({ issueDescription: blob, commentBody: "hi" })),
      envelopedMessage("Tell the login bug something"),
      undefined,
      undefined,
      callback
    );
    expect(blobbed.success).toBe(false);
    expectNoEnvelope(blobbed.text);
    expect(blobbed.text).toContain("Found multiple issues matching that issue");
    expectNoEnvelope(callback.mock.calls[0]?.[0]?.text);
  });
});
