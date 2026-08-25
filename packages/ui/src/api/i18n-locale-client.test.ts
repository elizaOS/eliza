/**
 * Unit coverage for the i18n locale-suggestion client (`fetchSuggestedLanguage`)
 * through the package's configured test harness. Only the CSRF transport seam
 * is mocked; boot config flows through the real store, the direct/dedicated
 * cloud-base gating through the real capability classifiers, and suggested tags
 * through the real `normalizeLanguage`, so every asserted value is computed by
 * the module under test from controlled boundary responses (real `Response`
 * objects).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { fetchWithCsrf } from "./csrf-client";
import { fetchSuggestedLanguage } from "./i18n-locale-client";

vi.mock("./csrf-client", () => ({ fetchWithCsrf: vi.fn() }));

const fetchWithCsrfMock = vi.mocked(fetchWithCsrf);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function installWindow(location: { origin: string; hostname: string }): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location },
  });
}

const BROWSER_LOCATION = {
  origin: "https://app.elizaos.com",
  hostname: "app.elizaos.com",
};

describe("fetchSuggestedLanguage", () => {
  beforeEach(() => {
    fetchWithCsrfMock.mockReset();
    setBootConfig({ branding: {} });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("returns null outside a browser window without contacting the endpoint", async () => {
    await expect(fetchSuggestedLanguage()).resolves.toBeNull();
    expect(fetchWithCsrfMock).not.toHaveBeenCalled();
  });

  it("returns null on localhost development origins where no geo hint applies", async () => {
    installWindow({ origin: "http://localhost:3000", hostname: "localhost" });
    await expect(fetchSuggestedLanguage()).resolves.toBeNull();
    expect(fetchWithCsrfMock).not.toHaveBeenCalled();
  });

  it("treats loopback IPs as local development and skips the request", async () => {
    for (const hostname of ["127.0.0.1", "::1"]) {
      installWindow({ origin: `http://[${hostname}]:3000`, hostname });
      await expect(fetchSuggestedLanguage()).resolves.toBeNull();
      expect(fetchWithCsrfMock).not.toHaveBeenCalled();
    }
  });

  it("requests the locale endpoint on window.location.origin when no API base is configured", async () => {
    installWindow(BROWSER_LOCATION);
    fetchWithCsrfMock.mockResolvedValueOnce(jsonResponse({ language: "ja" }));
    await expect(fetchSuggestedLanguage()).resolves.toBe("ja");
    expect(fetchWithCsrfMock).toHaveBeenCalledWith(
      "https://app.elizaos.com/api/i18n/locale",
    );
  });

  it("builds the endpoint URL from a trailing-slash API base without doubling the slash", async () => {
    installWindow(BROWSER_LOCATION);
    setBootConfig({ branding: {}, apiBase: "https://api.elizaos.com/" });
    fetchWithCsrfMock.mockResolvedValueOnce(jsonResponse({ language: "ko" }));
    await expect(fetchSuggestedLanguage()).resolves.toBe("ko");
    expect(fetchWithCsrfMock).toHaveBeenCalledWith(
      "https://api.elizaos.com/api/i18n/locale",
    );
  });

  it("skips direct cloud agent bases because they expose no app-shell routes", async () => {
    setBootConfig({
      branding: {},
      apiBase: "https://eliza.app/api/v1/eliza/agents/agent-abc123",
    });
    await expect(fetchSuggestedLanguage()).resolves.toBeNull();
    expect(fetchWithCsrfMock).not.toHaveBeenCalled();
  });

  it("normalizes regional and case variants of the suggested tag", async () => {
    installWindow(BROWSER_LOCATION);
    fetchWithCsrfMock
      .mockResolvedValueOnce(jsonResponse({ language: "ZH-hans-SG" }))
      .mockResolvedValueOnce(jsonResponse({ language: "en-US" }));
    await expect(fetchSuggestedLanguage()).resolves.toBe("zh-CN");
    await expect(fetchSuggestedLanguage()).resolves.toBe("en");
  });

  it("maps an unsupported suggestion onto the default language instead of failing", async () => {
    installWindow(BROWSER_LOCATION);
    fetchWithCsrfMock.mockResolvedValueOnce(
      jsonResponse({ language: "fr-FR" }),
    );
    await expect(fetchSuggestedLanguage()).resolves.toBe("en");
  });

  it("maps an explicitly empty suggestion onto the default language", async () => {
    installWindow(BROWSER_LOCATION);
    fetchWithCsrfMock.mockResolvedValueOnce(jsonResponse({ language: "" }));
    await expect(fetchSuggestedLanguage()).resolves.toBe("en");
  });

  it("degrades to no suggestion when the endpoint answers non-ok", async () => {
    installWindow(BROWSER_LOCATION);
    fetchWithCsrfMock.mockResolvedValueOnce(
      new Response("service unavailable", { status: 503 }),
    );
    await expect(fetchSuggestedLanguage()).resolves.toBeNull();
  });

  it("degrades to no suggestion when the endpoint is unreachable", async () => {
    installWindow(BROWSER_LOCATION);
    fetchWithCsrfMock.mockRejectedValueOnce(
      new TypeError("network unreachable"),
    );
    await expect(fetchSuggestedLanguage()).resolves.toBeNull();
  });

  it("ignores malformed JSON bodies", async () => {
    installWindow(BROWSER_LOCATION);
    fetchWithCsrfMock.mockResolvedValueOnce(
      new Response("<html>under maintenance</html>", { status: 200 }),
    );
    await expect(fetchSuggestedLanguage()).resolves.toBeNull();
  });

  it("requires a string language field in the suggestion payload", async () => {
    installWindow(BROWSER_LOCATION);
    fetchWithCsrfMock
      .mockResolvedValueOnce(jsonResponse(null))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ language: 7 }));
    await expect(fetchSuggestedLanguage()).resolves.toBeNull();
    await expect(fetchSuggestedLanguage()).resolves.toBeNull();
    await expect(fetchSuggestedLanguage()).resolves.toBeNull();
  });
});
