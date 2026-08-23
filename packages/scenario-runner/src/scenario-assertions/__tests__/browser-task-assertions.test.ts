/** Exercises the real browser-task outcome assertion helpers against captured action records. */

import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import {
  expectScenarioBrowserTask,
  expectTurnBrowserTask,
} from "../browser-task-assertions.ts";

function action(overrides: Partial<CapturedAction> = {}): CapturedAction {
  return {
    actionName: "test",
    parameters: {},
    result: { success: true, data: { ok: 1 } },
    ...overrides,
  } as CapturedAction;
}

function browserAction(
  actionName: string,
  browserTask: Record<string, unknown>,
): CapturedAction {
  return action({
    actionName,
    result: { success: true, data: { browserTask } },
  });
}

function ctx(actions: CapturedAction[]): ScenarioContext {
  return { actionsCalled: actions } as ScenarioContext;
}

function turn(actions: CapturedAction[]): ScenarioTurnExecution {
  return { actionsCalled: actions } as ScenarioTurnExecution;
}

describe("expectScenarioBrowserTask", () => {
  it("returns undefined when a filtered action carries a fully satisfying browserTask", () => {
    const check = expectScenarioBrowserTask({
      description: "file uploaded",
      actionName: "UPLOAD_FILE",
      completed: true,
      minArtifacts: 2,
    });
    expect(
      check(
        ctx([
          action({ actionName: "OTHER_ACTION", result: { data: { ok: 1 } } }),
          browserAction("UPLOAD_FILE", {
            completed: true,
            artifactCount: 2,
          }),
        ]),
      ),
    ).toBeUndefined();
  });

  it("accepts an actionName array by matching any listed name", () => {
    const check = expectScenarioBrowserTask({
      description: "submitted",
      actionName: ["SAVE_DRAFT", "SUBMIT_FORM"],
      completed: true,
    });
    expect(
      check(ctx([browserAction("SUBMIT_FORM", { completed: true })])),
    ).toBeUndefined();
    const message = check(
      ctx([browserAction("SEND_EMAIL", { completed: true })]),
    );
    expect(message).toContain("no browserTask payload found");
    expect(message).toContain("SAVE_DRAFT, SUBMIT_FORM");
  });

  it("treats an empty action filter as matching every action", () => {
    const check = expectScenarioBrowserTask({ description: "any task" });
    expect(
      check(ctx([browserAction("WHATEVER", { completed: true })])),
    ).toBeUndefined();
  });

  it("reports the wildcard action list when no actions were called at all", () => {
    const message = expectScenarioBrowserTask({
      description: "file uploaded",
    })(ctx([]));
    expect(message).toContain("Expected file uploaded:");
    expect(message).toContain("no browserTask payload found on actions [*].");
  });

  it("ignores actions whose result.data is not an object", () => {
    const message = expectScenarioBrowserTask({
      description: "task done",
      actionName: "UPLOAD_FILE",
    })(
      ctx([
        action({ actionName: "UPLOAD_FILE", result: { data: "plain text" } }),
        action({ actionName: "UPLOAD_FILE", result: undefined }),
      ]),
    );
    expect(message).toContain("no browserTask payload found");
    expect(message).toContain("UPLOAD_FILE");
  });

  it("ignores a browserTask field that is not an object", () => {
    const message = expectScenarioBrowserTask({
      description: "task done",
      actionName: "UPLOAD_FILE",
    })(
      ctx([
        action({
          actionName: "UPLOAD_FILE",
          result: { success: true, data: { browserTask: "done" } },
        }),
      ]),
    );
    expect(message).toContain("no browserTask payload found");
  });

  it("accepts an empty expectation against any browserTask payload", () => {
    const check = expectScenarioBrowserTask({ description: "anything" });
    expect(check(ctx([browserAction("ANY", {})]))).toBeUndefined();
  });

  it("fails and serializes seen payloads when no task matches completed", () => {
    const message = expectScenarioBrowserTask({
      description: "finished upload",
      completed: true,
    })(
      ctx([
        browserAction("UPLOAD_FILE", { completed: false, artifactCount: 0 }),
      ]),
    );
    expect(message).toContain("Expected finished upload:");
    expect(message).toContain("saw browserTask payloads");
    expect(message).toContain('"completed":false');
    expect(message).not.toBeUndefined();
    expect(typeof message).toBe("string");
  });

  it("matches a completed:false task among completed ones", () => {
    const check = expectScenarioBrowserTask({
      description: "still running",
      completed: false,
    });
    expect(
      check(
        ctx([
          browserAction("A", { completed: true }),
          browserAction("B", { completed: false }),
        ]),
      ),
    ).toBeUndefined();
  });

  it("checks needsHuman, approvalRequired, and approvalSatisfied together", () => {
    const check = expectScenarioBrowserTask({
      description: "awaiting approval",
      needsHuman: true,
      approvalRequired: true,
      approvalSatisfied: false,
    });
    expect(
      check(
        ctx([
          browserAction("ASK_APPROVAL", {
            completed: false,
            needsHuman: true,
            approvalRequired: true,
            approvalSatisfied: false,
          }),
        ]),
      ),
    ).toBeUndefined();
    const message = check(
      ctx([browserAction("ASK_APPROVAL", { needsHuman: true })]),
    );
    expect(message).toContain("saw browserTask payloads");
  });

  it("treats a missing count field as zero for minimum expectations", () => {
    const strict = expectScenarioBrowserTask({
      description: "with artifacts",
      minArtifacts: 1,
    });
    expect(typeof strict(ctx([browserAction("UPLOAD_FILE", {})]))).toBe(
      "string",
    );
    const lenient = expectScenarioBrowserTask({
      description: "zero artifacts ok",
      minArtifacts: 0,
    });
    expect(lenient(ctx([browserAction("UPLOAD_FILE", {})]))).toBeUndefined();
  });

  it("passes when counts meet the minima exactly and fails below them", () => {
    const check = expectScenarioBrowserTask({
      description: "rich upload",
      minUploadedAssets: 2,
      minInterventions: 3,
      minProvenance: 4,
    });
    expect(
      check(
        ctx([
          browserAction("UPLOAD_FILE", {
            uploadedAssetCount: 2,
            interventionCount: 3,
            provenanceCount: 4,
          }),
        ]),
      ),
    ).toBeUndefined();
    const message = check(
      ctx([
        browserAction("UPLOAD_FILE", {
          uploadedAssetCount: 1,
          interventionCount: 3,
          provenanceCount: 9,
        }),
      ]),
    );
    expect(message).toContain("saw browserTask payloads");
    expect(message).toContain('"uploadedAssetCount":1');
  });

  it("matches blockedReasonIncludes case-insensitively", () => {
    const check = expectScenarioBrowserTask({
      description: "captcha wall",
      blockedReasonIncludes: "CAPTCHA",
    });
    expect(
      check(
        ctx([
          browserAction("FILL_FORM", { blockedReason: "blocked by CaPtChA" }),
        ]),
      ),
    ).toBeUndefined();
  });

  it("never matches blockedReasonIncludes against a null reason", () => {
    const check = expectScenarioBrowserTask({
      description: "reason required",
      blockedReasonIncludes: "captcha",
    });
    expect(
      typeof check(ctx([browserAction("FILL_FORM", { blockedReason: null })])),
    ).toBe("string");
  });

  it("requires every stated expectation to hold on one task", () => {
    const check = expectScenarioBrowserTask({
      description: "approved upload",
      completed: true,
      blockedReasonIncludes: "timeout",
    });
    const message = check(
      ctx([
        browserAction("UPLOAD_FILE", { completed: true }),
        browserAction("UPLOAD_FILE", { blockedReason: "TIMED out waiting" }),
      ]),
    );
    expect(message).toContain("Expected approved upload:");
    expect(message).toContain("saw browserTask payloads");
    expect(message).toContain('"completed":true');
    expect(message).toContain('"blockedReason":"TIMED out waiting"');
  });
});

describe("expectTurnBrowserTask", () => {
  it("validates against the turn's own actionsCalled list", () => {
    const check = expectTurnBrowserTask({
      description: "turn upload",
      completed: true,
      minArtifacts: 1,
    });
    expect(
      check(
        turn([
          browserAction("UPLOAD_FILE", { completed: true, artifactCount: 1 }),
        ]),
      ),
    ).toBeUndefined();
  });

  it("fails on an empty turn queue and ignores scenario-level context", () => {
    const message = expectTurnBrowserTask({
      description: "turn upload",
      actionName: "UPLOAD_FILE",
    })(turn([]));
    expect(message).toContain("Expected turn upload:");
    expect(message).toContain("actions [UPLOAD_FILE].");
  });
});
