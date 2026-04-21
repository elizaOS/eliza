import { describe, expect, it } from "vitest";
import {
  formatRendererDiagnosticLine,
  redactDiagnosticUrl,
} from "./diagnostic-format";

/* ---------- redactDiagnosticUrl ---------- */

describe("redactDiagnosticUrl", () => {
  it("redacts api_key query param", () => {
    expect(
      redactDiagnosticUrl(
        "https://api.openai.com/v1/models?api_key=sk-abc123xyz",
      ),
    ).toBe("https://api.openai.com/v1/models?api_key=[redacted]");
  });

  it("redacts key param", () => {
    expect(
      redactDiagnosticUrl("https://example.com/api?key=supersecret&format=json"),
    ).toBe("https://example.com/api?key=[redacted]&format=json");
  });

  it("redacts token param", () => {
    expect(
      redactDiagnosticUrl("https://example.com/api?token=abc123&v=2"),
    ).toBe("https://example.com/api?token=[redacted]&v=2");
  });

  it("redacts access_token param", () => {
    expect(
      redactDiagnosticUrl("https://api.example.com?access_token=xyz789"),
    ).toBe("https://api.example.com?access_token=[redacted]");
  });

  it("redacts multiple sensitive params", () => {
    expect(
      redactDiagnosticUrl(
        "https://example.com?key=secret1&token=secret2&other=safe",
      ),
    ).toBe("https://example.com?key=[redacted]&token=[redacted]&other=safe");
  });

  it("redacts sk-* tokens in URLs", () => {
    expect(
      redactDiagnosticUrl(
        "https://api.anthropic.com/v1/messages?x=sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      ),
    ).toBe(
      "https://api.anthropic.com/v1/messages?x=[redacted-token]",
    );
  });

  it("redacts ghp_* GitHub tokens", () => {
    expect(
      redactDiagnosticUrl(
        "https://api.github.com/user?auth=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678901",
      ),
    ).toBe("https://api.github.com/user?auth=[redacted]");
  });

  it("leaves safe URLs untouched", () => {
    const safe = "http://127.0.0.1:31337/api/status";
    expect(redactDiagnosticUrl(safe)).toBe(safe);
  });

  it("leaves URLs without query params untouched", () => {
    const url = "https://api.anthropic.com/v1/messages";
    expect(redactDiagnosticUrl(url)).toBe(url);
  });

  it("handles empty string", () => {
    expect(redactDiagnosticUrl("")).toBe("");
  });
});

/* ---------- formatRendererDiagnosticLine ---------- */

describe("formatRendererDiagnosticLine", () => {
  it("keeps provider-path status and URL context in mirrored lines", () => {
    const line = formatRendererDiagnosticLine({
      source: "fetch",
      message: "HTTP 401 Unauthorized",
      details: {
        url: "http://127.0.0.1:31337/api/cloud/status",
        method: "GET",
        durationMs: 42,
      },
    });

    expect(line).toContain("[Renderer:fetch]");
    expect(line).toContain("HTTP 401 Unauthorized");
    expect(line).toContain('"url":"http://127.0.0.1:31337/api/cloud/status"');
    expect(line).toContain('"method":"GET"');
  });

  it("captures post-connect RPC failures with structured details", () => {
    const line = formatRendererDiagnosticLine({
      source: "rpc",
      message:
        "Electrobun RPC request failed: agentCloudDisconnectWithConfirm",
      details: {
        name: "Error",
        message: "Unauthorized",
        status: 401,
        url: "http://127.0.0.1:31337/api/cloud/status",
      },
    });

    expect(line).toContain("agentCloudDisconnectWithConfirm");
    expect(line).toContain('"status":401');
    expect(line).toContain('"url":"http://127.0.0.1:31337/api/cloud/status"');
  });

  it("redacts API keys in URL query params within details", () => {
    const line = formatRendererDiagnosticLine({
      source: "fetch",
      message: "HTTP 403 Forbidden",
      details: {
        url: "https://api.openai.com/v1/models?api_key=sk-live-abc123",
        method: "GET",
      },
    });

    expect(line).not.toContain("sk-live-abc123");
    expect(line).toContain("api_key=[redacted]");
  });

  it("redacts sk-* tokens in detail URLs", () => {
    const line = formatRendererDiagnosticLine({
      source: "fetch",
      message: "HTTP 401",
      details: {
        url: "https://api.anthropic.com/v1/messages?auth=sk-ant-api03-verylongsecretkeystring1234",
      },
    });

    expect(line).not.toContain("sk-ant-api03-verylongsecretkeystring1234");
    expect(line).toContain("[redacted");
  });

  it("handles missing details", () => {
    const line = formatRendererDiagnosticLine({
      source: "fetch",
      message: "Network error",
    });
    expect(line).toBe("[Renderer:fetch] Network error");
  });

  it("handles null params", () => {
    const line = formatRendererDiagnosticLine(null);
    expect(line).toBe("[Renderer:renderer] (no message)");
  });

  it("handles undefined params", () => {
    const line = formatRendererDiagnosticLine(undefined);
    expect(line).toBe("[Renderer:renderer] (no message)");
  });
});
