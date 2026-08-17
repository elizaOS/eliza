/**
 * Unit tests for asset and API URL resolution in packages/shared/src/utils/asset-url.ts.
 * Exercises relative asset normalization, absolute URL preservation, custom currentUrl/baseUrl options,
 * boot-config CDN base resolution, and API base URL prefixing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBootConfig } from "../config/boot-config-store.js";
import { resolveApiUrl, resolveAppAssetUrl } from "./asset-url.js";

describe("asset-url utilities", () => {
  afterEach(() => {
    setBootConfig({});
  });

  describe("resolveAppAssetUrl", () => {
    it("returns empty string for empty or non-string inputs", () => {
      expect(resolveAppAssetUrl("")).toBe("");
      expect(resolveAppAssetUrl(null as unknown as string)).toBe("");
      expect(resolveAppAssetUrl(undefined as unknown as string)).toBe("");
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
      const resolved = resolveAppAssetUrl("vrms/1.vrm", {
        currentUrl: "http://localhost:5173/chat",
      });
      expect(resolved).toBe("http://localhost:5173/vrms/1.vrm");
    });

    it("resolves against configured boot config assetBaseUrl", () => {
      setBootConfig({ assetBaseUrl: "https://static.elizaos.com/dist" });
      expect(resolveAppAssetUrl("models/agent.vrm")).toBe(
        "https://static.elizaos.com/dist/models/agent.vrm",
      );
    });
  });

  describe("resolveApiUrl", () => {
    it("returns empty string for non-string inputs", () => {
      expect(resolveApiUrl(null as unknown as string)).toBe("");
      expect(resolveApiUrl(undefined as unknown as string)).toBe("");
    });

    it("returns bare apiPath when no apiBase is set", () => {
      expect(resolveApiUrl("/api/agents")).toBe("/api/agents");
      expect(resolveApiUrl("api/status")).toBe("api/status");
    });

    it("prefixes apiBase from boot config and normalizes slashes", () => {
      setBootConfig({ apiBase: "http://127.0.0.1:3000" });

      expect(resolveApiUrl("/api/agents")).toBe(
        "http://127.0.0.1:3000/api/agents",
      );
      expect(resolveApiUrl("api/agents")).toBe(
        "http://127.0.0.1:3000/api/agents",
      );
    });

    it("handles trailing slashes on apiBase without duplicate slashes", () => {
      setBootConfig({ apiBase: "http://127.0.0.1:3000/" });

      expect(resolveApiUrl("/api/agents")).toBe(
        "http://127.0.0.1:3000/api/agents",
      );
    });
  });
});
