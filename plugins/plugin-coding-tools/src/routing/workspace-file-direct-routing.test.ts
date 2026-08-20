import { describe, expect, it } from "vitest";

import {
  createWorkspaceFileDirectRoutingRule,
  createWorkspaceFileExecutionDirectRoutingRule,
  matchesWorkspaceFileExecutionRequest,
  matchesWorkspaceFileRequest,
} from "./workspace-file-direct-routing.js";

describe("workspace file direct routing", () => {
  it.each([
    "Please change milk to oat milk in grocery-list.txt and don't change anything else.",
    "Make a simple Python script prime_checker.py that checks a number.",
    "Fix temperature.py so 212 F becomes 100 C.",
    "Read the project file README.md.",
  ])("routes ordinary workspace-file language to FILE: %s", (message) => {
    expect(matchesWorkspaceFileRequest(message)).toBe(true);
  });

  it.each([
    "show my stored files",
    "delete the uploaded photo",
    "what is a Python script?",
    "visit example.com",
    "hey",
    "Ask a coding agent to create hello.py and run it.",
    "Delegate making prime_checker.py to a sub-agent.",
  ])("does not hijack non-workspace requests: %s", (message) => {
    expect(matchesWorkspaceFileRequest(message)).toBe(false);
  });

  it("adds SHELL only when the workspace request asks for execution", () => {
    const runMessage = "Create prime_checker.py and run it for 29 and 30.";
    expect(matchesWorkspaceFileExecutionRequest(runMessage)).toBe(true);
    expect(createWorkspaceFileExecutionDirectRoutingRule().actionNames).toEqual(
      ["FILE", "SHELL"],
    );
    expect(
      createWorkspaceFileExecutionDirectRoutingRule().replacesActionNames,
    ).toEqual([
      "FILES",
      "READ_FILE",
      "WRITE_FILE",
      "EDIT_FILE",
      "WRITE_CODE",
      "RUN_CODE",
      "EXECUTE_COMMAND",
      "RUN_TERMINAL_COMMAND",
      "TASKS",
      "TASKS_CREATE",
    ]);
    expect(
      matchesWorkspaceFileExecutionRequest("Edit grocery-list.txt only."),
    ).toBe(false);
  });

  it("reconciles the stored-media FILES mistake with workspace FILE", () => {
    const rule = createWorkspaceFileDirectRoutingRule();
    expect(rule.actionNames).toEqual(["FILE"]);
    expect(rule.replacesActionNames).toEqual([
      "FILES",
      "READ_FILE",
      "WRITE_FILE",
      "EDIT_FILE",
      "WRITE_CODE",
      "TASKS",
      "TASKS_CREATE",
    ]);
    expect(rule.contexts).toEqual(["code"]);
    expect(rule.requiredActionTags).toEqual(["workspace-file"]);
  });
});
