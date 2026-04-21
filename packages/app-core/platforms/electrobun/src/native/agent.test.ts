import { describe, expect, it } from "vitest";
import { redactSensitiveDiagnostics } from "./agent";

describe("redactSensitiveDiagnostics", () => {
  it("removes bearer tokens and API keys but preserves request context", () => {
    const input = [
      '[Renderer:fetch] HTTP 401 Unauthorized {"url":"http://127.0.0.1:31337/api/cloud/status","method":"GET"}',
      "Authorization: Bearer sk-secret-token",
      "api_key=super-secret",
    ].join("\n");

    const redacted = redactSensitiveDiagnostics(input);

    expect(redacted).toContain(
      '"url":"http://127.0.0.1:31337/api/cloud/status"',
    );
    expect(redacted).toContain("HTTP 401 Unauthorized");
    expect(redacted).toContain("Authorization: Bearer [REDACTED]");
    expect(redacted).toContain("api_key=[REDACTED]");
    expect(redacted).not.toContain("sk-secret-token");
    expect(redacted).not.toContain("super-secret");
  });
});
