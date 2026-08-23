/**
 * Unit coverage for session-utils — default session-store path resolution
 * under the resolved state dir, and the identity re-export of core's
 * session provider collection. Drives the real module; resolveStateDir is
 * the live core helper so path composition is asserted against the same
 * directory the production plugin uses.
 */
import path from "node:path";
import {
  getSessionProviders as coreGetSessionProviders,
  resolveStateDir,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  getSessionProviders,
  resolveDefaultSessionStorePath,
} from "./session-utils.ts";

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

  it("defaults to the main agent when agentId is undefined", () => {
    expect(resolveDefaultSessionStorePath(undefined)).toBe(storePath("main"));
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

  it("keeps the leaf filename sessions.json", () => {
    expect(path.basename(resolveDefaultSessionStorePath("x"))).toBe(
      "sessions.json",
    );
  });
});

describe("getSessionProviders", () => {
  it("re-exports the canonical collection by identity", () => {
    expect(getSessionProviders).toBe(coreGetSessionProviders);
  });

  it("returns the three default session providers", () => {
    const providers = getSessionProviders();
    expect(providers.map((provider) => provider.name)).toEqual([
      "session",
      "sessionSkills",
      "sendPolicy",
    ]);
  });

  it("forwards storePath without changing provider names", () => {
    const providers = getSessionProviders({
      storePath: resolveDefaultSessionStorePath("agent-1"),
    });
    expect(providers).toHaveLength(3);
    expect(providers.map((provider) => provider.name)).toEqual([
      "session",
      "sessionSkills",
      "sendPolicy",
    ]);
  });
});
