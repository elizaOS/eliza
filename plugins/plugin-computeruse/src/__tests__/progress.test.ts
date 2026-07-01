/**
 * Unit coverage for the action-progress + approval-prompt builders
 * (#9170 / #8912 per-step progress streaming).
 *
 * These pure builders shape the transient progress lines and the approval
 * CHOICE prompt that the COMPUTER_USE / COMPUTER_USE_AGENT loop streams back to
 * the user — untested until now.
 */

import type { Content, HandlerCallback } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  ACTION_PROGRESS_SOURCE,
  buildApprovalPromptContent,
  buildStepProgressContent,
  COMPUTER_USE_APPROVAL_SOURCE,
  formatStepProgressText,
  isStreamProgressEnabled,
  withApprovalRelay,
} from "../actions/progress.js";
import type { ApprovalSnapshot, PendingApproval } from "../types.js";

describe("isStreamProgressEnabled", () => {
  it("is a strict === true guard", () => {
    expect(isStreamProgressEnabled(true)).toBe(true);
    expect(isStreamProgressEnabled(false)).toBe(false);
    expect(isStreamProgressEnabled("true")).toBe(false);
    expect(isStreamProgressEnabled(1)).toBe(false);
    expect(isStreamProgressEnabled(undefined)).toBe(false);
  });
});

describe("formatStepProgressText", () => {
  it("renders step / kind / rationale", () => {
    expect(formatStepProgressText(3, "click", "press the button")).toBe(
      "Step 3: click — press the button",
    );
  });

  it("falls back to 'dispatched' for a missing/blank rationale", () => {
    expect(formatStepProgressText(1, "type")).toBe("Step 1: type — dispatched");
    expect(formatStepProgressText(2, "scroll", "   ")).toBe(
      "Step 2: scroll — dispatched",
    );
  });
});

describe("buildStepProgressContent", () => {
  it("builds a transient compact-progress Content with the full payload", () => {
    const c = buildStepProgressContent({
      actionName: "COMPUTER_USE",
      step: 2,
      kind: "click",
      rationale: "  hit OK  ",
      success: true,
    });
    expect(c.text).toBe("Step 2: click — hit OK");
    expect(c.source).toBe(ACTION_PROGRESS_SOURCE);
    expect(c.merge).toBe("replace");
    expect(c.metadata).toMatchObject({
      transient: true,
      compactProgress: true,
      progress: {
        source: "computeruse",
        actionName: "COMPUTER_USE",
        step: 2,
        kind: "click",
        rationale: "hit OK",
        success: true,
      },
    });
  });

  it("defaults the rationale and honors a source override", () => {
    const c = buildStepProgressContent({
      actionName: "WINDOW",
      step: 1,
      kind: "focus",
      source: "custom",
    });
    expect(c.text).toContain("dispatched");
    expect(c.metadata).toMatchObject({
      progress: { source: "custom", rationale: "dispatched" },
    });
  });
});

describe("buildApprovalPromptContent", () => {
  const approval = {
    id: "abc",
    command: "terminal_execute",
    requestedAt: 1000,
  } as PendingApproval;

  it("emits a CHOICE block with approve/deny callbacks", () => {
    const c = buildApprovalPromptContent(approval);
    expect(c.source).toBe(COMPUTER_USE_APPROVAL_SOURCE);
    expect(c.text).toContain("[CHOICE:computeruse-approval id=abc]");
    expect(c.text).toContain("cua:abc:approve=Approve");
    expect(c.text).toContain("cua:abc:deny=Deny");
    expect(c.text).toContain("`terminal_execute`");
  });

  it("scopes the callback to an owner when ownerId is given", () => {
    const c = buildApprovalPromptContent(approval, { ownerId: "7" });
    expect(c.text).toContain("cua:abc:approve:u7=Approve");
    expect(c.text).toContain("cua:abc:deny:u7=Deny");
    expect(c.metadata).toMatchObject({
      computeruse: {
        ownerId: "7",
        approvalId: "abc",
        command: "terminal_execute",
      },
    });
  });
});

describe("withApprovalRelay", () => {
  const emptySnapshot = { pendingApprovals: [] } as unknown as ApprovalSnapshot;

  it("runs and returns the result when there is no callback", async () => {
    const service = {
      getApprovalSnapshot: () => emptySnapshot,
      subscribeApprovals: () => () => {},
    };
    await expect(
      withApprovalRelay(service, undefined, async () => "done"),
    ).resolves.toBe("done");
  });

  it("relays a newly-pending approval to the callback as a prompt", async () => {
    let emit: ((s: ApprovalSnapshot) => void) | null = null;
    const service = {
      getApprovalSnapshot: () => emptySnapshot,
      subscribeApprovals: (listener: (s: ApprovalSnapshot) => void) => {
        emit = listener;
        return () => {};
      },
    };
    const seen: Content[] = [];
    const callback: HandlerCallback = async (content) => {
      seen.push(content);
      return [];
    };

    const result = await withApprovalRelay(service, callback, async () => {
      emit?.({
        pendingApprovals: [
          {
            id: "x1",
            command: "file_write",
            requestedAt: 5,
          } as PendingApproval,
        ],
      } as unknown as ApprovalSnapshot);
      return 42;
    });

    expect(result).toBe(42);
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toContain("cua:x1:approve=Approve");
    expect(seen[0].source).toBe(COMPUTER_USE_APPROVAL_SOURCE);
  });
});
