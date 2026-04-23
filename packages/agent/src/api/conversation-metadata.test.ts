import { describe, expect, it } from "vitest";

import {
  buildConversationRoomMetadata,
  extractConversationMetadataFromRoom,
  isAutomationConversationMetadata,
  sanitizeConversationMetadata,
} from "./conversation-metadata.js";

describe("conversation metadata helpers", () => {
  it("sanitizes supported automation conversation metadata", () => {
    expect(
      sanitizeConversationMetadata({
        scope: "automation-workflow",
        automationType: "n8n_workflow",
        workflowId: "wf-123",
        workflowName: "Morning Digest",
        draftId: "draft-1",
        sourceConversationId: "conv-1",
        terminalBridgeConversationId: "conv-1",
        ignored: "value",
      }),
    ).toEqual({
      scope: "automation-workflow",
      automationType: "n8n_workflow",
      workflowId: "wf-123",
      workflowName: "Morning Digest",
      draftId: "draft-1",
      sourceConversationId: "conv-1",
      terminalBridgeConversationId: "conv-1",
    });
  });

  it("sanitizes trigger-backed coordinator automation metadata", () => {
    expect(
      sanitizeConversationMetadata({
        scope: "automation-coordinator",
        automationType: "coordinator_text",
        triggerId: "trigger-7",
        terminalBridgeConversationId: "terminal-1",
      }),
    ).toEqual({
      scope: "automation-coordinator",
      automationType: "coordinator_text",
      triggerId: "trigger-7",
      terminalBridgeConversationId: "terminal-1",
    });
  });

  it("persists automation metadata onto room metadata and reads it back", () => {
    const metadata = buildConversationRoomMetadata(
      {
        id: "conv-1",
        metadata: {
          scope: "automation-coordinator",
          automationType: "coordinator_text",
          taskId: "task-7",
          terminalBridgeConversationId: "terminal-1",
        },
      },
      "owner-1",
      { preserved: "value" },
    );

    expect(metadata).toMatchObject({
      ownership: { ownerId: "owner-1" },
      preserved: "value",
      webConversation: {
        conversationId: "conv-1",
        scope: "automation-coordinator",
        automationType: "coordinator_text",
        taskId: "task-7",
        terminalBridgeConversationId: "terminal-1",
      },
    });

    expect(
      extractConversationMetadataFromRoom(
        { metadata } as { metadata: unknown },
        "conv-1",
      ),
    ).toEqual({
      scope: "automation-coordinator",
      automationType: "coordinator_text",
      taskId: "task-7",
      terminalBridgeConversationId: "terminal-1",
    });
  });

  it("identifies only automation-scoped conversations as automation rooms", () => {
    expect(
      isAutomationConversationMetadata({
        scope: "automation-workflow-draft",
      }),
    ).toBe(true);
    expect(
      isAutomationConversationMetadata({
        scope: "general",
      }),
    ).toBe(false);
    expect(isAutomationConversationMetadata(undefined)).toBe(false);
  });

  it("sanitizes page-scoped conversation metadata with pageId", () => {
    expect(
      sanitizeConversationMetadata({
        scope: "page-character",
        pageId: "char-abc",
        sourceConversationId: "conv-main",
        terminalBridgeConversationId: "conv-main",
      }),
    ).toEqual({
      scope: "page-character",
      pageId: "char-abc",
      sourceConversationId: "conv-main",
      terminalBridgeConversationId: "conv-main",
    });
  });

  it("sanitizes page-scoped metadata without pageId", () => {
    expect(
      sanitizeConversationMetadata({
        scope: "page-apps",
      }),
    ).toEqual({ scope: "page-apps" });
  });

  it("accepts all six page scopes as valid", () => {
    for (const scope of [
      "page-character",
      "page-apps",
      "page-lifeops",
      "page-wallet",
      "page-browser",
      "page-automations",
    ] as const) {
      expect(sanitizeConversationMetadata({ scope, pageId: "x" })).toEqual({
        scope,
        pageId: "x",
      });
    }
  });

  it("persists page-scoped metadata with pageId onto room metadata and reads it back", () => {
    const metadata = buildConversationRoomMetadata(
      {
        id: "conv-page-1",
        metadata: {
          scope: "page-browser",
          pageId: "tab-42",
          sourceConversationId: "conv-main",
          terminalBridgeConversationId: "conv-main",
        },
      },
      "owner-2",
    );

    expect(metadata).toMatchObject({
      ownership: { ownerId: "owner-2" },
      webConversation: {
        conversationId: "conv-page-1",
        scope: "page-browser",
        pageId: "tab-42",
        sourceConversationId: "conv-main",
        terminalBridgeConversationId: "conv-main",
      },
    });

    expect(
      extractConversationMetadataFromRoom(
        { metadata } as { metadata: unknown },
        "conv-page-1",
      ),
    ).toEqual({
      scope: "page-browser",
      pageId: "tab-42",
      sourceConversationId: "conv-main",
      terminalBridgeConversationId: "conv-main",
    });
  });
});
