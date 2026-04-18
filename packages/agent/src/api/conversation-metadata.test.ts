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
});
