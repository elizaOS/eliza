/** Exercises malformed X DM draft participant identifiers before service dispatch. */

import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { XDmAdapter } from "./lifeops-message-adapter.ts";

const sendDirectMessageForAccount = vi.fn(async () => ({
  ok: true,
  status: 201,
  messageId: "sent-1",
}));
const fetchDirectMessagesForAccount = vi.fn(async () => []);

function runtimeWithXService(): IAgentRuntime {
  return {
    agentId: "agent-1",
    getService: (serviceType: string) =>
      serviceType === "x"
        ? { sendDirectMessageForAccount, fetchDirectMessagesForAccount }
        : null,
  } as unknown as IAgentRuntime;
}

function draftId(participant: string, body = "hello"): string {
  return `twitter:${participant}:${Date.now()}:${Buffer.from(body, "utf8").toString("base64url")}`;
}

describe("x dm draft participant encoding", () => {
  beforeEach(() => {
    sendDirectMessageForAccount.mockClear();
    fetchDirectMessagesForAccount.mockClear();
  });

  test("canonical createDraft still reaches sendDirectMessageForAccount", async () => {
    const adapter = new XDmAdapter();
    const runtime = runtimeWithXService();
    const draft = await adapter.createDraft(runtime, {
      to: [{ identifier: "recipient-1" }],
      body: "see you tomorrow",
    });
    const sent = await adapter.sendDraft(runtime, draft.draftId);
    expect(sendDirectMessageForAccount).toHaveBeenCalledWith("default", {
      participantId: "recipient-1",
      text: "see you tomorrow",
    });
    expect(sent).toEqual({ externalId: "sent-1" });
  });

  test("canonical percent-encoded hyphen still decodes before send", async () => {
    const adapter = new XDmAdapter();
    const runtime = runtimeWithXService();
    await adapter.sendDraft(runtime, draftId("user%2D1"));
    expect(sendDirectMessageForAccount).toHaveBeenCalledWith("default", {
      participantId: "user-1",
      text: "hello",
    });
  });

  test.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed recipient encoding %s before the X service",
    async (token) => {
      const adapter = new XDmAdapter();
      const runtime = runtimeWithXService();
      await expect(adapter.sendDraft(runtime, draftId(token))).rejects.toThrow(
        "[XDmAdapter] malformed draftId encoding",
      );
      expect(sendDirectMessageForAccount).not.toHaveBeenCalled();
    },
  );

  test("list remains untouched", async () => {
    const adapter = new XDmAdapter();
    const runtime = runtimeWithXService();
    await adapter.listMessages(runtime, { limit: 5 });
    expect(fetchDirectMessagesForAccount).toHaveBeenCalledWith("default", {
      participantId: undefined,
      limit: 5,
    });
    expect(sendDirectMessageForAccount).not.toHaveBeenCalled();
  });
});
