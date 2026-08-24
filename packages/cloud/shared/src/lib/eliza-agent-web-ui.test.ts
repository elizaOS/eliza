/**
 * Pins agent web-UI URL resolution. The module documents a three-way
 * distinction its callers depend on — omitted baseDomain falls back to env then
 * the built-in default, while an explicitly supplied one never falls back and
 * yields null when it normalizes away — and that distinction is carried by an
 * Object.hasOwn check that is easy to break. Also covers the direct/preferred
 * ordering and the host-preserving path applicator. Deterministic: process.env
 * is saved and restored per test; no network.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getAgentBaseDomain,
  getClientSafeElizaAgentWebUiUrl,
  getElizaAgentDirectWebUiUrl,
  getElizaAgentPublicWebUiUrl,
  getPreferredElizaAgentWebUiUrl,
} from "./eliza-agent-web-ui";

const DEFAULT_DOMAIN = "cloud.eliza.app";
const ENV_KEY = "ELIZA_CLOUD_AGENT_BASE_DOMAIN";
const SANDBOX_ID = "sbx-1234";

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

const sandbox = (over: Record<string, unknown> = {}) =>
  ({
    id: SANDBOX_ID,
    headscale_ip: null,
    web_ui_port: null,
    bridge_port: null,
    ...over,
  }) as never;

describe("getAgentBaseDomain", () => {
  test("falls back to the built-in default when env is unset", () => {
    expect(getAgentBaseDomain()).toBe(DEFAULT_DOMAIN);
  });

  test("treats blank and whitespace-only env as unset", () => {
    for (const value of ["", "   ", "\t\n"]) {
      process.env[ENV_KEY] = value;
      expect(getAgentBaseDomain()).toBe(DEFAULT_DOMAIN);
    }
  });

  test("strips scheme, path, and trailing dots from env", () => {
    const cases: Array<[string, string]> = [
      ["example.com", "example.com"],
      ["  example.com  ", "example.com"],
      ["https://example.com", "example.com"],
      ["http://example.com", "example.com"],
      ["https://example.com/some/path", "example.com"],
      ["example.com/", "example.com"],
      ["example.com...", "example.com"],
    ];
    for (const [input, expected] of cases) {
      process.env[ENV_KEY] = input;
      expect(getAgentBaseDomain()).toBe(expected);
    }
  });

  test("falls back to the default when env normalizes to nothing", () => {
    for (const value of ["https://", "/", "..."]) {
      process.env[ENV_KEY] = value;
      expect(getAgentBaseDomain()).toBe(DEFAULT_DOMAIN);
    }
  });
});

describe("getElizaAgentPublicWebUiUrl — omitted baseDomain", () => {
  test("uses the built-in default when env is unset", () => {
    expect(getElizaAgentPublicWebUiUrl(sandbox())).toBe(`https://${SANDBOX_ID}.${DEFAULT_DOMAIN}`);
  });

  test("uses env when set", () => {
    process.env[ENV_KEY] = "agents.example.com";
    expect(getElizaAgentPublicWebUiUrl(sandbox())).toBe(`https://${SANDBOX_ID}.agents.example.com`);
  });

  test("an explicit undefined is the same as omitting it", () => {
    process.env[ENV_KEY] = "agents.example.com";
    expect(getElizaAgentPublicWebUiUrl(sandbox(), { baseDomain: undefined })).toBe(
      getElizaAgentPublicWebUiUrl(sandbox()),
    );
  });

  test("never returns null on the fallback path", () => {
    for (const value of ["", "https://", "..."]) {
      process.env[ENV_KEY] = value;
      expect(getElizaAgentPublicWebUiUrl(sandbox())).not.toBeNull();
    }
  });
});

describe("getElizaAgentPublicWebUiUrl — supplied baseDomain", () => {
  test("uses the override verbatim after normalization", () => {
    process.env[ENV_KEY] = "env.example.com";
    expect(
      getElizaAgentPublicWebUiUrl(sandbox(), {
        baseDomain: "https://override.example.com/ignored",
      }),
    ).toBe(`https://${SANDBOX_ID}.override.example.com`);
  });

  test("returns null rather than falling back to env or the default", () => {
    process.env[ENV_KEY] = "env.example.com";
    for (const baseDomain of [null, "", "   ", "https://", "/", "..."]) {
      expect(getElizaAgentPublicWebUiUrl(sandbox(), { baseDomain })).toBeNull();
    }
  });
});

describe("path application", () => {
  test("a root path leaves the base URL untouched", () => {
    const base = `https://${SANDBOX_ID}.${DEFAULT_DOMAIN}`;
    expect(getElizaAgentPublicWebUiUrl(sandbox(), { path: "/" })).toBe(base);
    expect(getElizaAgentPublicWebUiUrl(sandbox(), { path: "" })).toBe(base);
  });

  test("carries pathname, search, and hash", () => {
    const url = getElizaAgentPublicWebUiUrl(sandbox(), {
      path: "/chat?tab=logs#top",
    });
    expect(url).not.toBeNull();
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/chat");
    expect(parsed.search).toBe("?tab=logs");
    expect(parsed.hash).toBe("#top");
  });

  test("an absolute or protocol-relative path cannot move the host", () => {
    for (const path of [
      "https://evil.example.net/steal",
      "//evil.example.net/steal",
      "http://evil.example.net:9999/steal",
    ]) {
      const url = getElizaAgentPublicWebUiUrl(sandbox(), { path });
      expect(url).not.toBeNull();
      const parsed = new URL(url as string);
      expect(parsed.host).toBe(`${SANDBOX_ID}.${DEFAULT_DOMAIN}`);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.pathname).toBe("/steal");
    }
  });

  test("resolves a relative path against the agent origin", () => {
    const url = getElizaAgentPublicWebUiUrl(sandbox(), { path: "logs" });
    expect(new URL(url as string).host).toBe(`${SANDBOX_ID}.${DEFAULT_DOMAIN}`);
  });
});

describe("getElizaAgentDirectWebUiUrl", () => {
  test("returns null without a headscale ip", () => {
    expect(getElizaAgentDirectWebUiUrl(sandbox({ web_ui_port: 8080 }))).toBeNull();
  });

  test("returns null when neither port is usable", () => {
    for (const over of [
      { headscale_ip: "100.64.0.1" },
      { headscale_ip: "100.64.0.1", web_ui_port: 0, bridge_port: 0 },
      { headscale_ip: "100.64.0.1", web_ui_port: null, bridge_port: null },
    ]) {
      expect(getElizaAgentDirectWebUiUrl(sandbox(over))).toBeNull();
    }
  });

  test("prefers web_ui_port over bridge_port", () => {
    expect(
      getElizaAgentDirectWebUiUrl(
        sandbox({
          headscale_ip: "100.64.0.1",
          web_ui_port: 8080,
          bridge_port: 9090,
        }),
      ),
    ).toBe("http://100.64.0.1:8080");
  });

  test("falls back to bridge_port when web_ui_port is absent", () => {
    expect(
      getElizaAgentDirectWebUiUrl(sandbox({ headscale_ip: "100.64.0.1", bridge_port: 9090 })),
    ).toBe("http://100.64.0.1:9090");
  });

  test("applies the path without changing host or scheme", () => {
    const url = getElizaAgentDirectWebUiUrl(
      sandbox({ headscale_ip: "100.64.0.1", web_ui_port: 8080 }),
      { path: "/health" },
    );
    const parsed = new URL(url as string);
    expect(parsed.protocol).toBe("http:");
    expect(parsed.host).toBe("100.64.0.1:8080");
    expect(parsed.pathname).toBe("/health");
  });
});

describe("getPreferredElizaAgentWebUiUrl", () => {
  test("prefers the public URL when one resolves", () => {
    expect(
      getPreferredElizaAgentWebUiUrl(sandbox({ headscale_ip: "100.64.0.1", web_ui_port: 8080 })),
    ).toBe(`https://${SANDBOX_ID}.${DEFAULT_DOMAIN}`);
  });

  test("falls back to the direct URL when the override suppresses the public one", () => {
    expect(
      getPreferredElizaAgentWebUiUrl(sandbox({ headscale_ip: "100.64.0.1", web_ui_port: 8080 }), {
        baseDomain: null,
      }),
    ).toBe("http://100.64.0.1:8080");
  });

  test("returns null when neither route resolves", () => {
    expect(getPreferredElizaAgentWebUiUrl(sandbox(), { baseDomain: null })).toBeNull();
  });
});

describe("getClientSafeElizaAgentWebUiUrl", () => {
  test("returns null without a canonical url — it never reads env", () => {
    process.env[ENV_KEY] = "agents.example.com";
    expect(
      getClientSafeElizaAgentWebUiUrl(sandbox({ headscale_ip: "100.64.0.1", web_ui_port: 8080 })),
    ).toBeNull();
  });

  test("returns null for an empty canonical url", () => {
    expect(getClientSafeElizaAgentWebUiUrl(sandbox({ canonicalWebUiUrl: "" }))).toBeNull();
    expect(getClientSafeElizaAgentWebUiUrl(sandbox({ canonicalWebUiUrl: null }))).toBeNull();
  });

  test("applies the path to the canonical url", () => {
    expect(
      getClientSafeElizaAgentWebUiUrl(sandbox({ canonicalWebUiUrl: "https://agent.example.com" }), {
        path: "/chat",
      }),
    ).toBe("https://agent.example.com/chat");
  });

  test("an absolute path cannot move the canonical host", () => {
    const url = getClientSafeElizaAgentWebUiUrl(
      sandbox({ canonicalWebUiUrl: "https://agent.example.com" }),
      { path: "https://evil.example.net/steal" },
    );
    expect(new URL(url as string).host).toBe("agent.example.com");
  });
});
