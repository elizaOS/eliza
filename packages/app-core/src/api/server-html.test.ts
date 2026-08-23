/**
 * Colocated coverage for the app-core HTML API-base injector. Drives the real
 * `injectApiBaseIntoHtml` re-export: early returns, first `</head>` placement,
 * trim, boot-config merge, token sinks, and inline-script serialization.
 */
import { describe, expect, it } from "vitest";
import { injectApiBaseIntoHtml } from "./server-html";

const HTML = "<!doctype html><html><head></head><body></body></html>";
const TOKEN = "secret-full-capability-token";
const VAPID = "BExamplePublicKeyBase64Url";
const API_BASE = "https://agent.example.test/api";

function extractInlineScript(html: string): string {
  const open = html.indexOf("<script>");
  const close = html.indexOf("</script>");
  if (open < 0 || close < 0 || close <= open) {
    throw new Error("injected HTML has no inline <script>");
  }
  return html.slice(open + "<script>".length, close);
}

function runInjectedScript(
  html: string,
  stored?: unknown,
): {
  window: Record<PropertyKey, unknown>;
  store: Map<string, string>;
} {
  const script = extractInlineScript(html);
  const store = new Map<string, string>();
  if (stored !== undefined) {
    store.set("elizaos:active-server", JSON.stringify(stored));
  }
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
  const window: Record<PropertyKey, unknown> = {};
  new Function("window", "localStorage", script)(window, localStorage);
  return { window, store };
}

describe("injectApiBaseIntoHtml", () => {
  it("returns the same Buffer when base, token, and VAPID are all absent", () => {
    const html = Buffer.from(HTML);
    expect(injectApiBaseIntoHtml(html)).toBe(html);
    expect(injectApiBaseIntoHtml(html, undefined, undefined)).toBe(html);
    expect(injectApiBaseIntoHtml(html, null, {})).toBe(html);
  });

  it("treats whitespace-only base, token, and VAPID as absent", () => {
    const html = Buffer.from(HTML);
    expect(
      injectApiBaseIntoHtml(html, "   ", {
        apiToken: "\t",
        webPushVapidPublicKey: "\n",
      }),
    ).toBe(html);
  });

  it("returns the same Buffer when </head> is missing even with values to inject", () => {
    const html = Buffer.from("<html><body>no head</body></html>");
    expect(
      injectApiBaseIntoHtml(html, API_BASE, {
        apiToken: TOKEN,
        webPushVapidPublicKey: VAPID,
      }),
    ).toBe(html);
  });

  it("does not treat a case-shifted </HEAD> as the insertion point", () => {
    const html = Buffer.from("<html><HEAD></HEAD><body></body></html>");
    expect(injectApiBaseIntoHtml(html, API_BASE).toString("utf-8")).toBe(
      html.toString("utf-8"),
    );
  });

  it("inserts one script immediately before the first </head>", () => {
    const out = injectApiBaseIntoHtml(Buffer.from(HTML), API_BASE).toString(
      "utf-8",
    );
    expect(out.match(/<script>/g)).toHaveLength(1);
    expect(out.match(/<\/script>/g)).toHaveLength(1);
    expect(out).toContain("</script></head>");
    expect(out.indexOf("<script>")).toBeLessThan(out.indexOf("</head>"));
  });

  it("uses the first </head> when the document contains more than one", () => {
    const html =
      "<html><head></head><body><template></head></template></body></html>";
    const out = injectApiBaseIntoHtml(Buffer.from(html), API_BASE).toString(
      "utf-8",
    );
    const firstClose = out.indexOf("</head>");
    const secondClose = out.indexOf("</head>", firstClose + 1);
    expect(out.slice(0, firstClose)).toContain("<script>");
    expect(out.slice(firstClose, secondClose)).not.toContain("<script>");
    expect(out.slice(secondClose)).toBe("</head></template></body></html>");
  });

  it("does not mutate the input Buffer when it injects", () => {
    const html = Buffer.from(HTML);
    const before = Buffer.from(html);
    injectApiBaseIntoHtml(html, API_BASE);
    expect(html.equals(before)).toBe(true);
  });

  it("trims externalBase and seeds it as apiBase in a single boot-config write", () => {
    const out = injectApiBaseIntoHtml(
      Buffer.from(HTML),
      `  ${API_BASE}  `,
    ).toString("utf-8");
    const { window } = runInjectedScript(out);
    const boot = window.__ELIZAOS_APP_BOOT_CONFIG__ as {
      apiBase?: string;
      apiToken?: string;
      webPushVapidPublicKey?: string;
    };
    expect(boot.apiBase).toBe(API_BASE);
    expect(boot.apiToken).toBeUndefined();
    expect(boot.webPushVapidPublicKey).toBeUndefined();
    expect(window.__ELIZA_API_TOKEN__).toBeUndefined();
    expect(out.split("__ELIZAOS_APP_BOOT_CONFIG__=next").length - 1).toBe(1);
  });

  it("does not emit token sinks when only an API base is provided", () => {
    const out = injectApiBaseIntoHtml(Buffer.from(HTML), API_BASE).toString(
      "utf-8",
    );
    expect(out).not.toContain("apiToken");
    expect(out).not.toContain("__ELIZA_API_TOKEN__");
    expect(out).not.toContain("elizaos:active-server");
  });

  it("seeds every token sink when only an API token is provided", () => {
    const out = injectApiBaseIntoHtml(Buffer.from(HTML), undefined, {
      apiToken: `  ${TOKEN}  `,
    }).toString("utf-8");
    const { window, store } = runInjectedScript(out);
    const bootKey = Symbol.for("elizaos.app.boot-config");
    expect(
      (window.__ELIZAOS_APP_BOOT_CONFIG__ as { apiToken?: string }).apiToken,
    ).toBe(TOKEN);
    expect(
      (window[bootKey] as { current: { apiToken?: string } }).current.apiToken,
    ).toBe(TOKEN);
    expect(window.__ELIZA_API_TOKEN__).toBe(TOKEN);
    expect(JSON.parse(store.get("elizaos:active-server") ?? "{}")).toEqual({
      id: "local:embedded",
      kind: "local",
      label: "This device",
      accessToken: TOKEN,
    });
    expect(store.get("eliza:first-run-complete")).toBeUndefined();
    expect(out).not.toContain("apiBase");
    expect(out).not.toContain("webPushVapidPublicKey");
  });

  it("refreshes accessToken on an existing local record and leaves remote/cloud records untouched", () => {
    const localHtml = injectApiBaseIntoHtml(Buffer.from(HTML), undefined, {
      apiToken: TOKEN,
    }).toString("utf-8");
    const local = runInjectedScript(localHtml, {
      id: "local:embedded",
      kind: "local",
      label: "This device",
      accessToken: "stale-token",
    });
    expect(
      JSON.parse(local.store.get("elizaos:active-server") ?? "{}"),
    ).toEqual({
      id: "local:embedded",
      kind: "local",
      label: "This device",
      accessToken: TOKEN,
    });

    const remote = {
      id: "remote:https://box.lan",
      kind: "remote",
      label: "box.lan",
      apiBase: "https://box.lan",
    };
    const remoteResult = runInjectedScript(localHtml, remote);
    expect(
      JSON.parse(remoteResult.store.get("elizaos:active-server") ?? "{}"),
    ).toEqual(remote);

    const cloud = {
      id: "cloud:https://elizacloud.ai",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: "https://elizacloud.ai",
    };
    const cloudResult = runInjectedScript(localHtml, cloud);
    expect(
      JSON.parse(cloudResult.store.get("elizaos:active-server") ?? "{}"),
    ).toEqual(cloud);
  });

  it("seeds a local record when stored JSON is corrupt", () => {
    const out = injectApiBaseIntoHtml(Buffer.from(HTML), undefined, {
      apiToken: TOKEN,
    }).toString("utf-8");
    const script = extractInlineScript(out);
    const store = new Map<string, string>([
      ["elizaos:active-server", "{not json"],
    ]);
    const localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
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

  it("still seeds in-memory token sinks when localStorage throws", () => {
    const out = injectApiBaseIntoHtml(Buffer.from(HTML), undefined, {
      apiToken: TOKEN,
    }).toString("utf-8");
    const script = extractInlineScript(out);
    const hostile = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    };
    const window: Record<PropertyKey, unknown> = {};
    expect(() =>
      new Function("window", "localStorage", script)(window, hostile),
    ).not.toThrow();
    expect(
      (window.__ELIZAOS_APP_BOOT_CONFIG__ as { apiToken?: string }).apiToken,
    ).toBe(TOKEN);
    expect(window.__ELIZA_API_TOKEN__).toBe(TOKEN);
  });

  it("seeds the VAPID public key into the boot-config store", () => {
    const out = injectApiBaseIntoHtml(Buffer.from(HTML), undefined, {
      webPushVapidPublicKey: ` ${VAPID} `,
    }).toString("utf-8");
    const { window } = runInjectedScript(out);
    expect(
      (window.__ELIZAOS_APP_BOOT_CONFIG__ as { webPushVapidPublicKey?: string })
        .webPushVapidPublicKey,
    ).toBe(VAPID);
    expect(out).not.toContain("apiToken");
    expect(out).not.toContain("__ELIZA_API_TOKEN__");
  });

  it("merges apiBase and VAPID into one boot-config write", () => {
    const out = injectApiBaseIntoHtml(Buffer.from(HTML), API_BASE, {
      webPushVapidPublicKey: VAPID,
    }).toString("utf-8");
    const { window } = runInjectedScript(out);
    expect(window.__ELIZAOS_APP_BOOT_CONFIG__).toEqual({
      apiBase: API_BASE,
      webPushVapidPublicKey: VAPID,
    });
    expect(out.split("__ELIZAOS_APP_BOOT_CONFIG__=next").length - 1).toBe(1);
  });

  it("keeps boot-config overrides and token sinks as separate sequential writes", () => {
    const out = injectApiBaseIntoHtml(Buffer.from(HTML), API_BASE, {
      apiToken: TOKEN,
      webPushVapidPublicKey: VAPID,
    }).toString("utf-8");
    expect(out.split("__ELIZAOS_APP_BOOT_CONFIG__=next").length - 1).toBe(2);
    const { window } = runInjectedScript(out);
    expect(window.__ELIZAOS_APP_BOOT_CONFIG__).toEqual({
      apiBase: API_BASE,
      webPushVapidPublicKey: VAPID,
      apiToken: TOKEN,
    });
    expect(window.__ELIZA_API_TOKEN__).toBe(TOKEN);
  });

  it("keeps script-shaped values inside the generated JavaScript literal", () => {
    const externalBase =
      'https://agent.example.test/</script><script data-owned="no">alert(1)</script>?x=&';
    const token =
      'token</script><script data-owned="no">alert(2)</script>&A\u2028\u2029B';
    const vapid = 'vapid</script><img src=x onerror="alert(3)">&';
    const out = injectApiBaseIntoHtml(Buffer.from(HTML), externalBase, {
      apiToken: token,
      webPushVapidPublicKey: vapid,
    }).toString("utf-8");

    expect(out.match(/<script>/g)).toHaveLength(1);
    expect(out.match(/<\/script>/g)).toHaveLength(1);
    expect(out).not.toContain('</script><script data-owned="no">');
    expect(out).toContain("\\u003c/script\\u003e");
    expect(out).toContain("\\u0026");
    expect(out).toContain("\\u2028\\u2029");

    const { window } = runInjectedScript(out);
    const boot = window.__ELIZAOS_APP_BOOT_CONFIG__ as {
      apiBase: string;
      apiToken: string;
      webPushVapidPublicKey: string;
    };
    expect(boot.apiBase).toBe(externalBase);
    expect(boot.apiToken).toBe(token);
    expect(boot.webPushVapidPublicKey).toBe(vapid);
    expect(window.__ELIZA_API_TOKEN__).toBe(token);
  });
});
