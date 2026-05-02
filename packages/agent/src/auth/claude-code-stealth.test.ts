import { afterEach, describe, expect, it } from "vitest";
import { installClaudeCodeStealthFetchInterceptor } from "./claude-code-stealth.js";

const STEALTH_GUARD = Symbol.for("eliza.claudeCodeStealthInstalled");
const originalFetch = globalThis.fetch;

describe("installClaudeCodeStealthFetchInterceptor", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as Record<symbol, unknown>)[STEALTH_GUARD];
  });

  it("rewrites Anthropic subscription requests with Claude Code headers and system prefix", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response("ok");
    };
    globalThis.fetch = mockFetch;

    installClaudeCodeStealthFetchInterceptor();

    await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "sk-ant-oat-test-token",
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        system: "Use the repository context.",
      }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      "https://api.anthropic.com/v1/messages?beta=true",
    );

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer sk-ant-oat-test-token");
    expect(headers.get("anthropic-beta")).toContain("claude-code-20250219");
    expect(headers.get("user-agent")).toContain("claude-cli/");
    expect(headers.get("x-app")).toBe("cli");

    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      system: Array<{ text: string; type: string }>;
    };
    expect(body.system[0]).toEqual({
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    });
    expect(body.system[1]).toEqual({
      type: "text",
      text: "Use the repository context.",
    });
  });
});
