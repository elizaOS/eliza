import { describe, expect, test } from "bun:test";
import {
  isAllowedAbsoluteRedirectUrl,
  LOOPBACK_REDIRECT_ORIGINS,
  resolveOAuthSuccessRedirectUrl,
  resolveSafeRedirectTarget,
} from "@/lib/security/redirect-validation";

describe("redirect validation", () => {
  test("accepts allowlisted absolute redirect URLs", () => {
    expect(
      isAllowedAbsoluteRedirectUrl("https://app.example.com/success", ["https://app.example.com"]),
    ).toBe(true);
  });

  test("rejects redirect URLs on untrusted origins", () => {
    expect(
      isAllowedAbsoluteRedirectUrl("https://evil.example.com/success", ["https://app.example.com"]),
    ).toBe(false);
  });

  test("rejects redirect URLs with embedded credentials", () => {
    expect(
      isAllowedAbsoluteRedirectUrl("https://user:pass@app.example.com/success", [
        "https://app.example.com",
      ]),
    ).toBe(false);
  });

  test("resolves safe relative redirect targets against the base URL", () => {
    const target = resolveSafeRedirectTarget(
      "/dashboard/settings?tab=connections",
      "https://app.example.com",
      "/dashboard",
    );

    expect(target.toString()).toBe("https://app.example.com/dashboard/settings?tab=connections");
  });

  test("falls back when an external redirect target is provided", () => {
    const target = resolveSafeRedirectTarget(
      "https://evil.example.com/steal",
      "https://app.example.com",
      "/dashboard",
    );

    expect(target.toString()).toBe("https://app.example.com/dashboard");
  });
});

describe("resolveOAuthSuccessRedirectUrl", () => {
  const baseUrl = "https://www.elizacloud.ai";
  const fallbackPath = "/dashboard/settings?tab=connections";

  test("accepts allowlisted cross-origin Agent URL (production)", () => {
    const { target, rejected } = resolveOAuthSuccessRedirectUrl({
      value: "https://eliza.app/api/lifeops/connectors/google/success?side=owner",
      baseUrl,
      fallbackPath,
      allowedAbsoluteOrigins: ["https://eliza.app"],
    });

    expect(rejected).toBe(false);
    expect(target.toString()).toBe(
      "https://eliza.app/api/lifeops/connectors/google/success?side=owner",
    );
  });

  test("accepts loopback origin on any port via wildcard allowlist", () => {
    const { target, rejected } = resolveOAuthSuccessRedirectUrl({
      value:
        "http://localhost:2138/api/lifeops/connectors/google/success?side=owner&mode=cloud_managed",
      baseUrl,
      fallbackPath,
      allowedAbsoluteOrigins: [...LOOPBACK_REDIRECT_ORIGINS],
    });

    expect(rejected).toBe(false);
    expect(target.toString()).toBe(
      "http://localhost:2138/api/lifeops/connectors/google/success?side=owner&mode=cloud_managed",
    );
  });

  test("accepts 127.0.0.1 loopback on any port", () => {
    const { target, rejected } = resolveOAuthSuccessRedirectUrl({
      value: "http://127.0.0.1:31337/api/lifeops/connectors/google/success",
      baseUrl,
      fallbackPath,
      allowedAbsoluteOrigins: [...LOOPBACK_REDIRECT_ORIGINS],
    });

    expect(rejected).toBe(false);
    expect(target.toString()).toBe("http://127.0.0.1:31337/api/lifeops/connectors/google/success");
  });

  test("accepts same-origin absolute URL without being in allowlist", () => {
    const { target, rejected } = resolveOAuthSuccessRedirectUrl({
      value: "https://www.elizacloud.ai/auth/success?platform=google",
      baseUrl,
      fallbackPath,
      allowedAbsoluteOrigins: [],
    });

    expect(rejected).toBe(false);
    expect(target.toString()).toBe("https://www.elizacloud.ai/auth/success?platform=google");
  });

  test("accepts safe relative paths without consulting allowlist", () => {
    const { target, rejected } = resolveOAuthSuccessRedirectUrl({
      value: "/dashboard/settings?tab=agents",
      baseUrl,
      fallbackPath,
      allowedAbsoluteOrigins: [],
    });

    expect(rejected).toBe(false);
    expect(target.toString()).toBe("https://www.elizacloud.ai/dashboard/settings?tab=agents");
  });

  test("rejects cross-origin URL not on allowlist and marks result as rejected", () => {
    const { target, rejected } = resolveOAuthSuccessRedirectUrl({
      value: "https://evil.example.com/steal?token=1",
      baseUrl,
      fallbackPath,
      allowedAbsoluteOrigins: ["https://eliza.app"],
    });

    expect(rejected).toBe(true);
    expect(target.toString()).toBe("https://www.elizacloud.ai/dashboard/settings?tab=connections");
  });

  test("rejects protocol-relative URLs", () => {
    const { target, rejected } = resolveOAuthSuccessRedirectUrl({
      value: "//evil.example.com/steal",
      baseUrl,
      fallbackPath,
      allowedAbsoluteOrigins: ["https://eliza.app"],
    });

    expect(rejected).toBe(true);
    expect(target.toString()).toBe("https://www.elizacloud.ai/dashboard/settings?tab=connections");
  });

  test("rejects redirect URLs with embedded credentials even on allowlisted origin", () => {
    const { target, rejected } = resolveOAuthSuccessRedirectUrl({
      value: "https://user:pass@eliza.app/success",
      baseUrl,
      fallbackPath,
      allowedAbsoluteOrigins: ["https://eliza.app"],
    });

    expect(rejected).toBe(true);
    expect(target.toString()).toBe("https://www.elizacloud.ai/dashboard/settings?tab=connections");
  });

  test("rejects non-http schemes", () => {
    const { target, rejected } = resolveOAuthSuccessRedirectUrl({
      value: "javascript:alert(1)",
      baseUrl,
      fallbackPath,
      allowedAbsoluteOrigins: ["https://eliza.app"],
    });

    expect(rejected).toBe(true);
    expect(target.toString()).toBe("https://www.elizacloud.ai/dashboard/settings?tab=connections");
  });

  test("returns fallback when value is empty, without marking rejected", () => {
    const { target, rejected } = resolveOAuthSuccessRedirectUrl({
      value: undefined,
      baseUrl,
      fallbackPath,
      allowedAbsoluteOrigins: [],
    });

    expect(rejected).toBe(false);
    expect(target.toString()).toBe("https://www.elizacloud.ai/dashboard/settings?tab=connections");
  });
});
