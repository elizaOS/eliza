import { describe, expect, it } from "bun:test";
import type { Memory } from "@elizaos/core";
import { extractRunInput } from "../actions/run-workflow.ts";

function makeMemory(text: string): Memory {
  return {
    id: "memory-id",
    content: {
      text,
      source: "test",
    },
  } as unknown as Memory;
}

describe("workbench actions", () => {
  it("extractRunInput prefers explicit workflow options", () => {
    const input = extractRunInput(makeMemory("ignored"), {
      workflow: "check",
      cwd: "/tmp/workspace",
    });

    expect(input).toEqual({
      workflow: "check",
      cwd: "/tmp/workspace",
      stdin: undefined,
    });
  });

  it("extractRunInput parses workbench command text", () => {
    const input = extractRunInput(
      makeMemory("workbench run pre_review_local"),
      {},
    );

    expect(input).toEqual({
      workflow: "pre_review_local",
      cwd: undefined,
      stdin: undefined,
    });
  });

  it("extractRunInput parses shorthand alias", () => {
    const input = extractRunInput(makeMemory("ccw check"), {});

    expect(input).toEqual({
      workflow: "check",
      cwd: undefined,
      stdin: undefined,
    });
  });

  it("extractRunInput returns null for unrelated text", () => {
    expect(extractRunInput(makeMemory("hello world"), {})).toBeNull();
  });
});
