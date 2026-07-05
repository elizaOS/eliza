/** Exercises api base owner behavior with deterministic app-core test fixtures. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCurrent,
  injectIntoHtml,
  pushToWindow,
  setCurrent,
} from "./api-base-owner";

const ENV_KEYS = [
  "ELIZA_API_BASE",
  "ELIZA_API_BASE_URL",
  "ELIZA_DESKTOP_API_BASE",
  "ELIZA_DESKTOP_CLOUD_AGENT_BASE",
  "ELIZA_DESKTOP_CLOUD_ONLY",
  "ELIZA_DESKTOP_RUNTIME_MODE",
  "ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT",
  "ELIZA_DESKTOP_TEST_API_BASE",
  "ELIZA_DESKTOP_TEST_ENABLE_RUNTIME_CHOOSER",
  "ELIZA_STARTUP_SESSION_ID",
  "ELIZA_STARTUP_STATE_FILE",
  "ELIZA_STARTUP_EVENTS_FILE",
  "HOME",
] as const;

const originalEnv = new Map<string, string | undefined>();
let tempHome: string | null = null;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    if (key !== "HOME") delete process.env[key];
  }
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-api-base-owner-"));
  process.env.HOME = tempHome;
  setCurrent(null);
});

afterEach(() => {
  setCurrent(null);
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  originalEnv.clear();
  if (tempHome) {
    fs.rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

describe("api-base-owner", () => {
  it("leaves HTML unchanged without an API base or startup trace id", () => {
    const html = "<html><head></head><body></body></html>";
    expect(injectIntoHtml(html)).toBe(html);
    expect(getCurrent().base).toBeNull();
  });

  it("injects the host startup trace id before renderer JavaScript runs", () => {
    process.env.ELIZA_STARTUP_SESSION_ID = "desktop-session-123";
    const html = "<html><head></head><body></body></html>";

    const injected = injectIntoHtml(html);

    expect(injected).toContain(
      'window.__ELIZA_STARTUP_TRACE_ID__="desktop-session-123";',
    );
    // No API base set → no boot-config apiBase seeded.
    expect(injected).not.toContain("apiBase:");
    expect(injected.indexOf("<script>")).toBeLessThan(
      injected.indexOf("</head>"),
    );
  });

  it("injects startup trace id alongside the current API base snapshot", () => {
    process.env.ELIZA_STARTUP_SESSION_ID = "desktop-session-456";
    setCurrent("http://127.0.0.1:31337", "dev-token");

    const injected = injectIntoHtml("<html><head></head><body></body></html>");

    expect(injected).toContain(
      'window.__ELIZA_STARTUP_TRACE_ID__="desktop-session-456";',
    );
    // Both the API base and token are seeded into the boot config (the single
    // source of truth), not bespoke window globals.
    expect(injected).toContain('apiBase:"http://127.0.0.1:31337"');
    expect(injected).not.toContain("__ELIZA_API_TOKEN__");
    expect(injected).toContain("apiToken");
    expect(injected).toContain("elizaos.app.boot-config");
  });

  it("injects the packaged runtime chooser test marker without an API base", () => {
    process.env.ELIZA_DESKTOP_TEST_ENABLE_RUNTIME_CHOOSER = "1";

    const injected = injectIntoHtml("<html><head></head><body></body></html>");

    expect(injected).toContain(
      "window.__ELIZA_DESKTOP_TEST_ENABLE_RUNTIME_CHOOSER__=true;",
    );
    expect(injected).not.toContain("apiBase:");
  });

  it("marks a non-loopback current API base as an external desktop API base", () => {
    setCurrent("https://agent.example.com", "cloud-token");

    const injected = injectIntoHtml("<html><head></head><body></body></html>");

    expect(injected).toContain('apiBase:"https://agent.example.com"');
    expect(injected).toContain(
      'window.__ELIZA_DESKTOP_EXTERNAL_API_BASE__="https://agent.example.com";',
    );
  });

  it("pushes the external desktop API base to already-open renderer windows", () => {
    setCurrent("https://agent.example.com", "cloud-token");
    const apiBaseUpdate = vi.fn();

    pushToWindow({
      webview: {
        rpc: {
          send: { apiBaseUpdate },
        },
      },
    });

    expect(apiBaseUpdate).toHaveBeenCalledWith({
      base: "https://agent.example.com",
      token: "cloud-token",
      externalApiBase: "https://agent.example.com",
    });
  });

  it("does not mark loopback API bases as external", () => {
    setCurrent("http://127.0.0.1:31337", "dev-token");
    const apiBaseUpdate = vi.fn();

    pushToWindow({
      webview: {
        rpc: {
          send: { apiBaseUpdate },
        },
      },
    });

    expect(apiBaseUpdate).toHaveBeenCalledWith({
      base: "http://127.0.0.1:31337",
      token: "dev-token",
      externalApiBase: null,
    });
  });

  it("neutralizes a </script> breakout in the injected base and token (js/bad-code-sanitization)", () => {
    // Both the base and the token flow verbatim into an inline <script>.
    // JSON.stringify alone leaves `</script>`/`<script>` intact, so a crafted
    // value could terminate the element and inject markup; the escaper must map
    // the angle brackets so only the snippet's own closing tag survives.
    setCurrent(
      "http://127.0.0.1:31337/</script><script>alert(1)</script>",
      "tok</script><img src=x onerror=alert(2)>",
    );

    const injected = injectIntoHtml("<html><head></head><body></body></html>");

    // Exactly one real opening + closing tag — the injected snippet's own.
    expect((injected.match(/<script>/g) ?? []).length).toBe(1);
    expect((injected.match(/<\/script>/g) ?? []).length).toBe(1);
    // The payload's angle brackets are emitted as \uXXXX escapes, not raw.
    expect(injected).not.toContain('apiBase:"http://127.0.0.1:31337/</script>');
    expect(injected).toContain("\\u003C/script\\u003E");
    // The value still round-trips to the identical string at renderer parse
    // time (the \uXXXX escapes decode back inside the JS string literal).
    const baseLiteral = injected.match(/apiBase:("(?:[^"\\]|\\.)*")/)?.[1];
    expect(baseLiteral).toBeDefined();
    expect(JSON.parse(baseLiteral as string)).toBe(
      "http://127.0.0.1:31337/</script><script>alert(1)</script>",
    );
  });

  it("escapes U+2028 / U+2029 line separators in injected values", () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    setCurrent(`http://127.0.0.1:31337/${ls}p`, `token${ps}x`);

    const injected = injectIntoHtml("<html><head></head><body></body></html>");

    // Raw separators are illegal in older JS string literals; they must be
    // escaped, and the runtime value must still round-trip.
    expect(injected).not.toContain(ls);
    expect(injected).not.toContain(ps);
    expect(injected).toContain("\\u2028");
    expect(injected).toContain("\\u2029");
    const baseLiteral = injected.match(/apiBase:("(?:[^"\\]|\\.)*")/)?.[1];
    expect(JSON.parse(baseLiteral as string)).toBe(
      `http://127.0.0.1:31337/${ls}p`,
    );
  });
});
