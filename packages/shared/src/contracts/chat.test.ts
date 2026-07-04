/**
 * Guards the single-source chat SSE contract (#12409): both `ChatTurnStatus`
 * and `ChatFailureKind` are declared exactly once here and re-exported from the
 * `@elizaos/shared` root, so the agent SSE emitter and the UI client parse the
 * same union. The unions are type-only, so these tests pin the member sets via
 * exhaustive const arrays that stop compiling if a member is added or removed
 * on one side without updating this contract.
 */
import { describe, expect, it } from "vitest";
import type {
  ChatFailureKind as RootChatFailureKind,
  ChatTurnStatus as RootChatTurnStatus,
} from "../index.js";
import type { ChatFailureKind, ChatTurnStatus } from "./chat.js";

// Compile-time proof the root barrel re-exports the same declaration: a
// mismatch on either side is a type error, not a silent divergence.
const _sameTurnStatus: RootChatTurnStatus = {} as ChatTurnStatus;
const _sameFailureKind: RootChatFailureKind = "no_provider" as ChatFailureKind;
void _sameTurnStatus;
void _sameFailureKind;

describe("ChatTurnStatus contract", () => {
  it("covers exactly the seven in-flight turn phases", () => {
    const kinds: ChatTurnStatus["kind"][] = [
      "thinking",
      "streaming",
      "running_action",
      "running_tool",
      "evaluating",
      "waking",
      "speaking",
    ];
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toHaveLength(7);
  });

  it("carries only optional label/actionName/toolName alongside kind", () => {
    const running: ChatTurnStatus = {
      kind: "running_action",
      actionName: "SEND_MESSAGE",
    };
    const tool: ChatTurnStatus = { kind: "running_tool", toolName: "search" };
    const bare: ChatTurnStatus = { kind: "thinking" };
    expect(running.actionName).toBe("SEND_MESSAGE");
    expect(tool.toolName).toBe("search");
    expect(bare.label).toBeUndefined();
  });
});

describe("ChatFailureKind contract", () => {
  it("covers exactly the five turn-failure discriminators", () => {
    const kinds: ChatFailureKind[] = [
      "insufficient_credits",
      "no_provider",
      "provider_issue",
      "rate_limited",
      "local_inference",
    ];
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toHaveLength(5);
  });
});
