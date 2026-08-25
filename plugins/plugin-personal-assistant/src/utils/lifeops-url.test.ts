import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveBrowserBridgeApiBaseUrl,
  resolveLifeOpsSettingsApiBaseUrl,
} from "./lifeops-url.ts";
import { __setBaseUrl } from "./ui_client_mock.mjs";

// The module reads globalThis.location / window lazily inside the functions,
// so stubbing the globals per test is sufficient (no re-import needed).
function stubNoOrigin() {
  vi.stubGlobal("location", { origin: "" });
  vi.stubGlobal("window", { location: { origin: "" } });
}

describe("resolveBrowserBridgeApiBaseUrl", () => {
  beforeEach(() => {
    __setBaseUrl("");
    stubNoOrigin();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the client base URL when set", () => {
    __setBaseUrl("https://api.lifeops.example");
    expect(resolveBrowserBridgeApiBaseUrl()).toBe(
      "https://api.lifeops.example",
    );
  });

  it("trims whitespace from the configured base URL", () => {
    __setBaseUrl("  https://api.lifeops.example/  ");
    expect(resolveBrowserBridgeApiBaseUrl()).toBe(
      "https://api.lifeops.example",
    );
  });

  it("strips trailing slashes from the bridge URL", () => {
    __setBaseUrl("https://api.lifeops.example///");
    expect(resolveBrowserBridgeApiBaseUrl()).toBe(
      "https://api.lifeops.example",
    );
  });

  it("falls back to the location origin when the base URL is empty", () => {
    vi.stubGlobal("location", { origin: "https://app.lifeops.example" });
    expect(resolveBrowserBridgeApiBaseUrl()).toBe(
      "https://app.lifeops.example",
    );
  });

  it("falls back to window.location when globalThis.location has no origin", () => {
    vi.stubGlobal("location", {});
    vi.stubGlobal("window", {
      location: { origin: "https://win.lifeops.example" },
    });
    expect(resolveBrowserBridgeApiBaseUrl()).toBe(
      "https://win.lifeops.example",
    );
  });

  it("falls back to the localhost bridge when no origin is available", () => {
    expect(resolveBrowserBridgeApiBaseUrl()).toBe("http://127.0.0.1:31337");
  });

  it("ignores a whitespace-only configured base URL (falls back, no empty URL)", () => {
    __setBaseUrl("   ");
    expect(resolveBrowserBridgeApiBaseUrl()).toBe("http://127.0.0.1:31337");
  });
});

describe("resolveLifeOpsSettingsApiBaseUrl", () => {
  beforeEach(() => {
    __setBaseUrl("");
    stubNoOrigin();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the client base URL when set", () => {
    __setBaseUrl("https://api.lifeops.example");
    expect(resolveLifeOpsSettingsApiBaseUrl().toString()).toBe(
      "https://api.lifeops.example/",
    );
  });

  it("falls back to the location origin", () => {
    vi.stubGlobal("location", { origin: "https://app.lifeops.example" });
    expect(resolveLifeOpsSettingsApiBaseUrl().toString()).toBe(
      "https://app.lifeops.example/",
    );
  });

  it("falls back to the localhost settings endpoint when no origin is available", () => {
    expect(resolveLifeOpsSettingsApiBaseUrl().toString()).toBe(
      "http://127.0.0.1:3000/",
    );
  });
});
