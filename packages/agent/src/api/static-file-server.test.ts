/**
 * Token-injection gating for the served dashboard HTML.
 *
 * The dashboard `index.html` is served pre-auth, so embedding the
 * full-capability API token into it is a capability grant. These tests pin the
 * gate: the token is injected only for cloud-provisioned containers or when an
 * operator explicitly opts in with `ELIZA_FORCE_INJECT_TOKEN`, and the opt-in
 * uses the canonical truthy parser (not a strict `=== "1"`).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  injectApiBaseIntoHtml,
  resolveInjectedDashboardToken,
} from "./static-file-server.ts";

const TOKEN_ENV = "ELIZA_API_TOKEN";
const FORCE_ENV = "ELIZA_FORCE_INJECT_TOKEN";
const CLOUD_ENV = "ELIZA_CLOUD_PROVISIONED";
const TOKEN = "secret-full-capability-token";

describe("resolveInjectedDashboardToken", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of [TOKEN_ENV, FORCE_ENV, CLOUD_ENV]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of [TOKEN_ENV, FORCE_ENV, CLOUD_ENV]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns null when not cloud-provisioned and the flag is unset (token stays out of pre-auth HTML)", () => {
    process.env[TOKEN_ENV] = TOKEN;
    expect(resolveInjectedDashboardToken()).toBeNull();
  });

  it("returns the token when ELIZA_FORCE_INJECT_TOKEN=1 and a token is configured", () => {
    process.env[TOKEN_ENV] = TOKEN;
    process.env[FORCE_ENV] = "1";
    expect(resolveInjectedDashboardToken()).toBe(TOKEN);
  });

  it("honors the canonical truthy set, not just '1' (e.g. 'true')", () => {
    process.env[TOKEN_ENV] = TOKEN;
    process.env[FORCE_ENV] = "true";
    expect(resolveInjectedDashboardToken()).toBe(TOKEN);
  });

  it("returns null when the flag is set but no token is configured (no injection of an empty token)", () => {
    process.env[FORCE_ENV] = "1";
    expect(resolveInjectedDashboardToken()).toBeNull();
  });

  it("does not inject for falsey flag values", () => {
    process.env[TOKEN_ENV] = TOKEN;
    process.env[FORCE_ENV] = "0";
    expect(resolveInjectedDashboardToken()).toBeNull();
  });
});

describe("injectApiBaseIntoHtml token embedding", () => {
  const html = "<!doctype html><html><head></head><body></body></html>";

  it("embeds the token into boot config and localStorage when provided", () => {
    const out = injectApiBaseIntoHtml(Buffer.from(html), undefined, {
      apiToken: TOKEN,
    }).toString("utf-8");
    expect(out).toContain(TOKEN);
    expect(out).toContain("apiToken");
    expect(out).toContain("elizaos.app.boot-config");
    expect(out).toContain("elizaos:active-server");
    expect(out).toContain("accessToken");
  });

  // The native web shims (plugin-native-agent, plugin-native-websiteblocker)
  // and the Android WebView read this global directly and fall back only to
  // sessionStorage, so removing it sends their API calls unauthenticated.
  it("keeps seeding the window token global the native web shims read", () => {
    const out = injectApiBaseIntoHtml(Buffer.from(html), undefined, {
      apiToken: TOKEN,
    }).toString("utf-8");
    expect(out).toContain("__ELIZA_API_TOKEN__");
  });

  // String matching cannot tell a working seed from a syntactically broken one.
  // Run the injected script against a stubbed browser global and assert the
  // state every reader actually consults.
  it("executes cleanly and populates every token sink a reader consults", () => {
    const out = injectApiBaseIntoHtml(Buffer.from(html), undefined, {
      apiToken: TOKEN,
    }).toString("utf-8");
    const script = out.slice(
      out.indexOf("<script>") + "<script>".length,
      out.indexOf("</script>"),
    );

    const store = new Map<string, string>();
    const localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    const win: Record<PropertyKey, unknown> = {};
    new Function("window", "localStorage", script)(win, localStorage);

    const bootKey = Symbol.for("elizaos.app.boot-config");
    expect(
      (win.__ELIZAOS_APP_BOOT_CONFIG__ as { apiToken?: string }).apiToken,
    ).toBe(TOKEN);
    expect(
      (win[bootKey] as { current: { apiToken?: string } }).current.apiToken,
    ).toBe(TOKEN);
    expect(win.__ELIZA_API_TOKEN__).toBe(TOKEN);

    expect(JSON.parse(store.get("elizaos:active-server") ?? "{}")).toEqual({
      id: "local:embedded",
      kind: "local",
      label: "This device",
      accessToken: TOKEN,
    });
    // Onboarding state is not ours to decide — ELIZA_FORCE_INJECT_TOKEN says
    // the operator accepts HTML token injection, not that setup finished.
    expect(store.get("eliza:first-run-complete")).toBeUndefined();
  });

  // The persisted record can point anywhere the user has previously connected.
  // Startup restore sends `accessToken` to that record's `apiBase`, so merging
  // our token into a remote/cloud record would hand this agent's
  // full-capability token to an unrelated host.
  function runInjectedScript(stored?: unknown) {
    const out = injectApiBaseIntoHtml(Buffer.from(html), undefined, {
      apiToken: TOKEN,
    }).toString("utf-8");
    const script = out.slice(
      out.indexOf("<script>") + "<script>".length,
      out.indexOf("</script>"),
    );
    const store = new Map<string, string>();
    if (stored !== undefined) {
      store.set("elizaos:active-server", JSON.stringify(stored));
    }
    const localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    new Function("window", "localStorage", script)({}, localStorage);
    return store;
  }

  it("never attaches the token to a persisted remote server", () => {
    const remote = {
      id: "remote:https://box.lan",
      kind: "remote",
      label: "box.lan",
      apiBase: "https://box.lan",
    };
    const store = runInjectedScript(remote);
    expect(JSON.parse(store.get("elizaos:active-server") ?? "{}")).toEqual(
      remote,
    );
  });

  it("never attaches the token to a persisted cloud server", () => {
    const cloud = {
      id: "cloud:https://elizacloud.ai",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: "https://elizacloud.ai",
    };
    const store = runInjectedScript(cloud);
    expect(JSON.parse(store.get("elizaos:active-server") ?? "{}")).toEqual(
      cloud,
    );
  });

  it("refreshes the token on this device's own local record", () => {
    const store = runInjectedScript({
      id: "local:embedded",
      kind: "local",
      label: "This device",
      accessToken: "stale-token",
    });
    expect(JSON.parse(store.get("elizaos:active-server") ?? "{}")).toEqual({
      id: "local:embedded",
      kind: "local",
      label: "This device",
      accessToken: TOKEN,
    });
  });

  it("seeds a local record when a corrupt one is stored", () => {
    const out = injectApiBaseIntoHtml(Buffer.from(html), undefined, {
      apiToken: TOKEN,
    }).toString("utf-8");
    const script = out.slice(
      out.indexOf("<script>") + "<script>".length,
      out.indexOf("</script>"),
    );
    const store = new Map<string, string>([
      ["elizaos:active-server", "{not json"],
    ]);
    const localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    new Function("window", "localStorage", script)({}, localStorage);
    expect(JSON.parse(store.get("elizaos:active-server") ?? "{}")).toEqual({
      id: "local:embedded",
      kind: "local",
      label: "This device",
      accessToken: TOKEN,
    });
  });

  // Private-mode Safari throws on localStorage access. The boot-config and
  // window sinks must still land; only the persistence sink degrades.
  it("still seeds the in-memory sinks when localStorage throws", () => {
    const out = injectApiBaseIntoHtml(Buffer.from(html), undefined, {
      apiToken: TOKEN,
    }).toString("utf-8");
    const script = out.slice(
      out.indexOf("<script>") + "<script>".length,
      out.indexOf("</script>"),
    );
    const hostile = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    };
    const win: Record<PropertyKey, unknown> = {};
    expect(() =>
      new Function("window", "localStorage", script)(win, hostile),
    ).not.toThrow();
    expect(
      (win.__ELIZAOS_APP_BOOT_CONFIG__ as { apiToken?: string }).apiToken,
    ).toBe(TOKEN);
    expect(win.__ELIZA_API_TOKEN__).toBe(TOKEN);
  });

  it("never leaks a token into the HTML when none is injected", () => {
    const out = injectApiBaseIntoHtml(
      Buffer.from(html),
      undefined,
      undefined,
    ).toString("utf-8");
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("__ELIZA_API_TOKEN__");
  });
});

describe("injectApiBaseIntoHtml web-push VAPID public key", () => {
  const html = "<!doctype html><html><head></head><body></body></html>";
  const VAPID_PUBLIC = "BExamplePublicKeyBase64Url";

  it("seeds the VAPID public key into the boot config", () => {
    const out = injectApiBaseIntoHtml(Buffer.from(html), undefined, {
      webPushVapidPublicKey: VAPID_PUBLIC,
    }).toString("utf-8");
    expect(out).toContain("webPushVapidPublicKey");
    expect(out).toContain(VAPID_PUBLIC);
    expect(out).toContain("elizaos.app.boot-config");
  });

  it("merges apiBase + VAPID public key into a single boot-config write", () => {
    const out = injectApiBaseIntoHtml(
      Buffer.from(html),
      "https://proxy.example",
      {
        webPushVapidPublicKey: VAPID_PUBLIC,
      },
    ).toString("utf-8");
    expect(out).toContain("apiBase");
    expect(out).toContain("https://proxy.example");
    expect(out).toContain("webPushVapidPublicKey");
    expect(out).toContain(VAPID_PUBLIC);
    // One merged Object.assign seed, not two racing writes.
    const seedCount = out.split("__ELIZAOS_APP_BOOT_CONFIG__=next").length - 1;
    expect(seedCount).toBe(1);
  });

  it("never emits the VAPID field when none is provided", () => {
    const out = injectApiBaseIntoHtml(
      Buffer.from(html),
      undefined,
      undefined,
    ).toString("utf-8");
    expect(out).not.toContain("webPushVapidPublicKey");
  });
});
