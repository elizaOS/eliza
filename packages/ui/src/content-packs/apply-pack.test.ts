/**
 * Unit tests for apply-pack: validates content pack dispatching, CSS custom property application, and url() sanitization.
 */
import type {
  ContentPackColorScheme,
  ResolvedContentPack,
} from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  applyColorScheme,
  applyContentPack,
  type ContentPackApplyDeps,
} from "./apply-pack.ts";

describe("apply-pack", () => {
  it("dispatches bundled avatar pack state when avatarIndex > 0", () => {
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

    const pack: ResolvedContentPack = {
      avatarIndex: 3,
      backgroundUrl: "https://example.com/bg.png",
      worldUrl: "https://example.com/world.glb",
      personality: {
        name: "Luna",
        catchphrase: "Ready to assist!",
        voicePresetId: "voice-123",
      },
      manifest: {
        id: "pack-luna",
        name: "Luna Pack",
        description: "A companion",
        version: "1.0.0",
        category: "companion",
        assets: {},
      },
    };

    applyContentPack(pack, deps);
    expect(deps.setSelectedVrmIndex).toHaveBeenCalledWith(3);
    expect(deps.setCustomBackgroundUrl).toHaveBeenCalledWith(
      "https://example.com/bg.png",
    );
    expect(deps.setFirstRunName).toHaveBeenCalledWith("Luna");
    expect(deps.setCustomCatchphrase).toHaveBeenCalledWith("Ready to assist!");
    expect(deps.setCustomVoicePresetId).toHaveBeenCalledWith("voice-123");
    expect(deps.setFirstRunStyle).toHaveBeenCalledWith("pack-luna");
  });

  it("applies CSS custom properties and sanitizes external url() values", () => {
    const setProperty = vi.fn();
    const removeProperty = vi.fn();
    const originalDocument = globalThis.document;

    globalThis.document = {
      documentElement: {
        style: { setProperty, removeProperty },
        getAttribute: () => "dark",
      },
    } as unknown as Document;

    const scheme: ContentPackColorScheme = {
      accent: "#ff8800",
      bg: "#111111",
      customProperties: {
        "--custom-glow": "rgba(255,136,0,0.5)",
        "--malicious-url": "url('http://evil.com/leak')",
      },
    };

    const cleanup = applyColorScheme(scheme);
    expect(setProperty).toHaveBeenCalledWith("--pack-accent", "#ff8800");
    expect(setProperty).toHaveBeenCalledWith("--pack-bg", "#111111");
    expect(setProperty).toHaveBeenCalledWith(
      "--custom-glow",
      "rgba(255,136,0,0.5)",
    );
    // url() must be sanitized out
    expect(setProperty).not.toHaveBeenCalledWith(
      "--malicious-url",
      expect.anything(),
    );

    cleanup();
    expect(removeProperty).toHaveBeenCalledWith("--pack-accent");
    expect(removeProperty).toHaveBeenCalledWith("--pack-bg");
    expect(removeProperty).toHaveBeenCalledWith("--custom-glow");

    globalThis.document = originalDocument;
  });
});
