/**
 * Unit tests for normalizeToolOutput's exec-record handling (issue #11578 FIX B).
 *
 * Codex emits exec records ({ call_id, command, exit_code, stdout, … }). The
 * old fallback JSON.stringify'd them into the captured `[tool output: …]`
 * envelope, leaking the raw record to the user. normalizeToolOutput now renders
 * a compact `$ <command> → exit <code>` one-liner for any record carrying
 * call_id + command, and NEVER JSON.stringify's such a record.
 */

import { describe, expect, it } from "vitest";

import { normalizeToolOutput } from "../../src/services/acp-service.ts";

describe("normalizeToolOutput — exec records (#11578)", () => {
  it("renders a one-liner for a codex exec record (array command)", () => {
    const record = {
      call_id: "call_abc",
      turn_id: "turn_1",
      process_id: 42,
      command: ["bash", "-lc", "npm run build"],
      exit_code: 0,
      duration: 1234,
      parsed_cmd: [],
    };
    const out = normalizeToolOutput(record);
    expect(out).toBe("$ bash -lc npm run build → exit 0");
    expect(out).not.toContain("call_id");
    expect(out).not.toContain("{");
  });

  it("renders a one-liner for a string command with non-zero exit", () => {
    const record = { call_id: "c1", command: "ls /nope", exit_code: 2 };
    expect(normalizeToolOutput(record)).toBe("$ ls /nope → exit 2");
  });

  it("appends a capped stdout/stderr tail when present", () => {
    const record = {
      call_id: "c2",
      command: "echo hi",
      exit_code: 0,
      stdout: "hi there",
    };
    const out = normalizeToolOutput(record);
    expect(out).toBe("$ echo hi → exit 0\nhi there");
  });

  it("caps a long stdout tail to 200 chars", () => {
    const record = {
      call_id: "c3",
      command: "cat big",
      exit_code: 0,
      stdout: "A".repeat(500),
    };
    const out = normalizeToolOutput(record);
    const tail = out.split("\n")[1];
    expect(tail.length).toBe(201); // 200 chars + ellipsis
    expect(tail.endsWith("…")).toBe(true);
  });

  it("parses a STRINGIFIED exec record back to a one-liner", () => {
    const stringified = JSON.stringify({
      call_id: "c4",
      command: ["git", "status"],
      exit_code: 0,
    });
    expect(normalizeToolOutput(stringified)).toBe("$ git status → exit 0");
  });

  it("does NOT treat a plain object without call_id as an exec record", () => {
    const record = { command: "echo hi", exit_code: 0 };
    // No call_id → falls through to the normal extract/stringify path.
    const out = normalizeToolOutput(record);
    expect(out).not.toContain("→ exit");
  });

  it("leaves ordinary string output untouched", () => {
    expect(normalizeToolOutput("just some text")).toBe("just some text");
  });

  it("renders `?` exit when exit_code is missing", () => {
    const record = { call_id: "c5", command: "true" };
    expect(normalizeToolOutput(record)).toBe("$ true → exit ?");
  });
});
