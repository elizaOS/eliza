import { describe, expect, it } from "vitest";
import { isAndroidLocalAgentUrl } from "./local-agent-token";

describe("isAndroidLocalAgentUrl", () => {
  it("accepts the Android local agent loopback endpoint", () => {
    expect(isAndroidLocalAgentUrl("http://127.0.0.1:31337/api/auth/status")).toBe(
      true,
    );
    expect(isAndroidLocalAgentUrl("http://localhost:31337/api/health")).toBe(
      true,
    );
  });

  it("rejects non-local or non-agent endpoints", () => {
    expect(isAndroidLocalAgentUrl("https://127.0.0.1:31337/api/auth/status")).toBe(
      false,
    );
    expect(isAndroidLocalAgentUrl("http://127.0.0.1:2138/api/auth/status")).toBe(
      false,
    );
    expect(isAndroidLocalAgentUrl("http://example.com:31337/api/auth/status")).toBe(
      false,
    );
  });
});
