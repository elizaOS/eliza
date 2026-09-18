/** Verifies the agent session-store path against the configured state directory. */
import path from "node:path";
import { resolveStateDir } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveDefaultSessionStorePath } from "./session-utils.ts";

function storePath(agentId: string): string {
  return path.join(
    resolveStateDir(),
    "agents",
    agentId,
    "sessions",
    "sessions.json",
  );
}

describe("resolveDefaultSessionStorePath", () => {
  it("places sessions.json under the agent's sessions directory", () => {
    expect(resolveDefaultSessionStorePath("agent-1")).toBe(
      storePath("agent-1"),
    );
  });

  it("defaults to the main agent when agentId is omitted", () => {
    expect(resolveDefaultSessionStorePath()).toBe(storePath("main"));
  });

  it("does not coalesce an empty agentId to main", () => {
    // ?? only treats null/undefined as missing; "" is a provided id.
    // path.join drops empty segments, so this is not agents/main/...
    expect(resolveDefaultSessionStorePath("")).toBe(
      path.join(resolveStateDir(), "agents", "sessions", "sessions.json"),
    );
    expect(resolveDefaultSessionStorePath("")).not.toBe(storePath("main"));
  });

  it("preserves an agentId that contains path separators", () => {
    expect(resolveDefaultSessionStorePath("team/alpha")).toBe(
      storePath("team/alpha"),
    );
  });
});
