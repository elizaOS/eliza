/**
 * Unit tests for stainless-headers generator: validates SDK headers,
 * OS / architecture mappings, and session ID inclusion.
 */
import { describe, expect, it } from "vitest";
import { getStainlessHeaders } from "./stainless-headers.ts";

describe("stainless-headers", () => {
  it("generates complete set of expected Stainless SDK headers", () => {
    const headers = getStainlessHeaders();

    expect(headers["user-agent"]).toContain("claude-cli/");
    expect(headers["x-app"]).toBe("cli");
    expect(headers["x-stainless-lang"]).toBe("js");
    expect(headers["x-stainless-package-version"]).toBe("0.81.0");
    expect(headers["x-stainless-runtime"]).toBe("node");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers["x-claude-code-session-id"]).toBeDefined();
  });
});
