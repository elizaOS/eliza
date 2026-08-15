/**
 * Verifies shell projections require runtime-owned configured-secret redaction
 * and then apply pattern redaction before output leaves the shell boundary.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  redactShellText,
  resolveShellRedactionOverlapChars,
} from "./redaction.ts";

describe("shell redaction boundary", () => {
  it("fails closed when a runtime omits the required secret redactor", () => {
    const runtime = {} as IAgentRuntime;

    expect(() => redactShellText(runtime, "ordinary output")).toThrow(
      expect.objectContaining({
        name: "ElizaError",
        code: "SHELL_REDACTION_UNAVAILABLE",
      }),
    );
  });

  it("composes runtime-known and pattern redaction", () => {
    const redactSecrets = vi.fn((text: string) =>
      text.replaceAll("ordinary configured value", "[REDACTED:configured]"),
    );
    const runtime = { redactSecrets } as unknown as IAgentRuntime;
    const result = redactShellText(
      runtime,
      "ordinary configured value --token=flag-value-123456789",
    );

    expect(redactSecrets).toHaveBeenCalledOnce();
    expect(result).toContain("[REDACTED:configured]");
    expect(result).not.toContain("ordinary configured value");
    expect(result).not.toContain("flag-value-123456789");
  });

  it("propagates a runtime redactor failure instead of degrading open", () => {
    const failure = new Error("secret store unavailable");
    const runtime = {
      redactSecrets: vi.fn(() => {
        throw failure;
      }),
    } as unknown as IAgentRuntime;

    expect(() => redactShellText(runtime, "must stay private")).toThrow(
      failure,
    );
  });

  it("retains enough overlap for the longest configured literal secret", () => {
    const runtime = {
      character: {
        settings: { secrets: { SHORT: "abcd", LONG: "x".repeat(96) } },
      },
      redactSecrets: (text: string) => text,
    } as unknown as IAgentRuntime;

    expect(resolveShellRedactionOverlapChars(runtime, 32)).toBe(96);
  });
});
