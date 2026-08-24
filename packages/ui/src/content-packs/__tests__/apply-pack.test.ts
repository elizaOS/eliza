/**
 * @vitest-environment jsdom
 * Unit tests for content pack application and color scheme CSS variable binding.
 */
import type { ResolvedContentPack } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  applyColorScheme,
  applyContentPack,
  type ContentPackApplyDeps,
} from "../apply-pack.ts";

describe("apply-pack", () => {
  describe("applyContentPack", () => {
    it("applies bundled pack with avatarIndex and personality fields", () => {
      const deps: ContentPackApplyDeps = {
        setCustomVrmUrl: vi.fn(),
        setCustomVrmPreviewUrl: vi.fn(),
        setCustomBackgroundUrl: vi.fn(),
        setCustomWorldUrl: vi.fn(),
        setSelectedVrmIndex: vi.fn(),
        setFirstRunName: vi.fn(),
        setFirstRunStyle: vi.fn(),
        setCustomCatchphrase: vi.fn(),
        setCustomVoicePresetId: vi.fn(),
      };

      const pack = {
        manifest: { id: "pack-chen", assets: {} },
        avatarIndex: 2,
        backgroundUrl: "https://example.com/bg.png",
        worldUrl: "https://example.com/world.glb",
        personality: {
          name: "Chen",
          catchphrase: "Let us build.",
          voicePresetId: "voice-1",
        },
      } as unknown as ResolvedContentPack;

      applyContentPack(pack, deps);

      expect(deps.setSelectedVrmIndex).toHaveBeenCalledWith(2);
      expect(deps.setCustomVrmUrl).toHaveBeenCalledWith("");
      expect(deps.setCustomVrmPreviewUrl).toHaveBeenCalledWith("");
      expect(deps.setCustomBackgroundUrl).toHaveBeenCalledWith(
        "https://example.com/bg.png",
      );
      expect(deps.setCustomWorldUrl).toHaveBeenCalledWith(
        "https://example.com/world.glb",
      );
      expect(deps.setFirstRunName).toHaveBeenCalledWith("Chen");
      expect(deps.setCustomCatchphrase).toHaveBeenCalledWith("Let us build.");
      expect(deps.setCustomVoicePresetId).toHaveBeenCalledWith("voice-1");
      expect(deps.setFirstRunStyle).toHaveBeenCalledWith("pack-chen");
    });

    it("applies custom pack with vrmUrl and previewUrl", () => {
      const deps: ContentPackApplyDeps = {
        setCustomVrmUrl: vi.fn(),
        setCustomVrmPreviewUrl: vi.fn(),
        setCustomBackgroundUrl: vi.fn(),
        setCustomWorldUrl: vi.fn(),
        setSelectedVrmIndex: vi.fn(),
        setFirstRunName: vi.fn(),
        setFirstRunStyle: vi.fn(),
        setCustomCatchphrase: vi.fn(),
        setCustomVoicePresetId: vi.fn(),
      };

      const pack = {
        manifest: { id: "custom-pack", assets: {} },
        vrmUrl: "https://example.com/custom.vrm",
        vrmPreviewUrl: "https://example.com/preview.png",
      } as unknown as ResolvedContentPack;

      applyContentPack(pack, deps);

      expect(deps.setSelectedVrmIndex).toHaveBeenCalledWith(0);
      expect(deps.setCustomVrmUrl).toHaveBeenCalledWith(
        "https://example.com/custom.vrm",
      );
      expect(deps.setCustomVrmPreviewUrl).toHaveBeenCalledWith(
        "https://example.com/preview.png",
      );
    });
  });

  describe("applyColorScheme", () => {
    it("sets standard CSS variables on documentElement and cleanup removes them", () => {
      const cleanup = applyColorScheme({
        accent: "#ff8800",
        bg: "#111111",
        card: "#222222",
        border: "#333333",
        text: "#ffffff",
        textMuted: "#888888",
      });

      expect(
        document.documentElement.style.getPropertyValue("--pack-accent"),
      ).toBe("#ff8800");
      expect(document.documentElement.style.getPropertyValue("--pack-bg")).toBe(
        "#111111",
      );
      expect(
        document.documentElement.style.getPropertyValue("--pack-card"),
      ).toBe("#222222");

      cleanup();

      expect(
        document.documentElement.style.getPropertyValue("--pack-accent"),
      ).toBe("");
      expect(document.documentElement.style.getPropertyValue("--pack-bg")).toBe(
        "",
      );
    });

    it("sanitizes customProperties and rejects url() injection values", () => {
      const cleanup = applyColorScheme({
        customProperties: {
          customColor: "#123456",
          malicious: "url(https://evil.com/leak)",
        },
      });

      expect(
        document.documentElement.style.getPropertyValue("--customColor"),
      ).toBe("#123456");
      expect(
        document.documentElement.style.getPropertyValue("--malicious"),
      ).toBe("");

      cleanup();
      expect(
        document.documentElement.style.getPropertyValue("--customColor"),
      ).toBe("");
    });
  });
});
