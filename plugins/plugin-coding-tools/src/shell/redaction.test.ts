/**
 * Verifies shell projections always apply pattern redaction while using
 * runtime-owned configured-secret redaction when the host provides it.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { redactShellText } from "./redaction.ts";

describe("shell redaction boundary", () => {
  it("requires the runtime-owned redaction boundary", () => {
    const runtime = {} as IAgentRuntime;
    expect(() => redactShellText(runtime, "secret")).toThrow();
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
});
