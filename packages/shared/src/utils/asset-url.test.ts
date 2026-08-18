/**
 * Unit tests for asset and API URL resolution in packages/shared/src/utils/asset-url.ts.
 * Exercises relative asset normalization, absolute URL preservation, custom currentUrl/baseUrl options,
 * boot-config CDN base resolution, and API base URL prefixing.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BOOT_CONFIG,
  setBootConfig,
} from "../config/boot-config-store.js";
import { resolveApiUrl, resolveAppAssetUrl } from "./asset-url.js";

describe("asset-url utilities", () => {
  afterEach(() => {
    setBootConfig(DEFAULT_BOOT_CONFIG);
  });

  describe("resolveAppAssetUrl", () => {
    it("returns empty string for empty string input", () => {
      expect(resolveAppAssetUrl("")).toBe("");
    });

    it("preserves already absolute URLs", () => {
      expect(resolveAppAssetUrl("https://cdn.eliza.com/avatar.vrm")).toBe(
        "https://cdn.eliza.com/avatar.vrm",
      );
      expect(resolveAppAssetUrl("http://localhost:3000/anim.glb")).toBe(
        "http://localhost:3000/anim.glb",
      );
      expect(resolveAppAssetUrl("//assets.eliza.com/logo.png")).toBe(
        "//assets.eliza.com/logo.png",
      );
      expect(resolveAppAssetUrl("file:///home/user/avatar.vrm")).toBe(
        "file:///home/user/avatar.vrm",
      );
    });

    it("normalizes and prepends root slash when runtime base is not available", () => {
      expect(resolveAppAssetUrl("vrms/avatar.vrm")).toBe("/vrms/avatar.vrm");
      expect(resolveAppAssetUrl("./vrms/avatar.vrm")).toBe("/vrms/avatar.vrm");
      expect(resolveAppAssetUrl("/vrms/avatar.vrm")).toBe("/vrms/avatar.vrm");
    });

    it("resolves relative to currentUrl option", () => {
      const resolvedWeb = resolveAppAssetUrl("vrms/1.vrm", {
        currentUrl: "http://localhost:5173/chat",
      });
      expect(resolvedWeb).toBe("http://localhost:5173/vrms/1.vrm");

      const resolvedFile = resolveAppAssetUrl("vrms/1.vrm", {
        currentUrl: "file:///app/dist/index.html",
      });
      expect(resolvedFile).toBe("file:///app/dist/vrms/1.vrm");
    });

    it("resolves relative to currentUrl with custom baseUrl", () => {
      const resolved = resolveAppAssetUrl("vrms/1.vrm", {
        currentUrl: "file:///app/dist/sub/index.html",
        baseUrl: "./",
      });
      expect(resolved).toBe("file:///app/dist/sub/vrms/1.vrm");
    });

    it("falls back to root-relative path when currentUrl is invalid", () => {
      const resolved = resolveAppAssetUrl("vrms/1.vrm", {
        currentUrl: "invalid-url",
      });
      expect(resolved).toBe("/vrms/1.vrm");
    });

    it("resolves against configured boot config assetBaseUrl", () => {
      setBootConfig({
        ...DEFAULT_BOOT_CONFIG,
        assetBaseUrl: "https://static.elizaos.com/dist",
      });
      expect(resolveAppAssetUrl("models/agent.vrm")).toBe(
        "https://static.elizaos.com/dist/models/agent.vrm",
      );

      setBootConfig({
        ...DEFAULT_BOOT_CONFIG,
        assetBaseUrl: "https://static.elizaos.com/dist/",
      });
      expect(resolveAppAssetUrl("models/agent.vrm")).toBe(
        "https://static.elizaos.com/dist/models/agent.vrm",
      );
    });

    it("falls back to runtime resolution when configured assetBaseUrl is invalid", () => {
      setBootConfig({
        ...DEFAULT_BOOT_CONFIG,
        assetBaseUrl: "not-a-valid-url",
      });
      expect(resolveAppAssetUrl("models/agent.vrm")).toBe("/models/agent.vrm");
    });
  });

  describe("resolveApiUrl", () => {
    it("returns bare apiPath when no apiBase is set", () => {
      expect(resolveApiUrl("/api/agents")).toBe("/api/agents");
      expect(resolveApiUrl("api/status")).toBe("api/status");
    });

    it("prefixes apiBase from boot config and normalizes slashes", () => {
      setBootConfig({
        ...DEFAULT_BOOT_CONFIG,
        apiBase: "http://127.0.0.1:3000",
      });

      expect(resolveApiUrl("/api/agents")).toBe(
        "http://127.0.0.1:3000/api/agents",
      );
      expect(resolveApiUrl("api/agents")).toBe(
        "http://127.0.0.1:3000/api/agents",
      );
    });

    it("handles trailing slashes on apiBase without duplicate slashes", () => {
      setBootConfig({
        ...DEFAULT_BOOT_CONFIG,
        apiBase: "http://127.0.0.1:3000///",
      });

      expect(resolveApiUrl("/api/agents")).toBe(
        "http://127.0.0.1:3000/api/agents",
      );
      expect(resolveApiUrl("api/agents")).toBe(
        "http://127.0.0.1:3000/api/agents",
      );
    });
  });
});
