/**
 * Configuration regression coverage for the Anthropic proxy service.
 * Deterministic: resolves environment-backed configuration without starting a server.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/services/proxy-service.ts";

const originalMode = process.env.CLAUDE_MAX_PROXY_MODE;
const originalPort = process.env.CLAUDE_MAX_PROXY_PORT;

afterEach(() => {
  if (originalMode === undefined) delete process.env.CLAUDE_MAX_PROXY_MODE;
  else process.env.CLAUDE_MAX_PROXY_MODE = originalMode;
  if (originalPort === undefined) delete process.env.CLAUDE_MAX_PROXY_PORT;
  else process.env.CLAUDE_MAX_PROXY_PORT = originalPort;
});

describe("resolveConfig", () => {
  it("rejects ports with a numeric prefix instead of silently truncating them", () => {
    process.env.CLAUDE_MAX_PROXY_MODE = "inline";
    process.env.CLAUDE_MAX_PROXY_PORT = "123junk";

    const config = resolveConfig();

    expect(config.port).toBe(18801);
    expect(config.configError).toBe("Invalid CLAUDE_MAX_PROXY_PORT: 123junk");
  });

  it("rejects ports outside the TCP range while preserving port zero", () => {
    process.env.CLAUDE_MAX_PROXY_MODE = "inline";
    process.env.CLAUDE_MAX_PROXY_PORT = "65536";
    expect(resolveConfig().configError).toBe("Invalid CLAUDE_MAX_PROXY_PORT: 65536");

    process.env.CLAUDE_MAX_PROXY_PORT = "0";
    expect(resolveConfig()).toMatchObject({ port: 0, configError: undefined });
  });

  it("ignores the inline-only port setting in shared and off modes", () => {
    process.env.CLAUDE_MAX_PROXY_PORT = "not-a-port";

    process.env.CLAUDE_MAX_PROXY_MODE = "shared";
    expect(resolveConfig()).toMatchObject({
      mode: "shared",
      port: 18801,
      configError: undefined,
    });

    process.env.CLAUDE_MAX_PROXY_MODE = "off";
    expect(resolveConfig()).toMatchObject({
      mode: "off",
      port: 18801,
      configError: undefined,
    });
  });
});
