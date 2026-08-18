/** Verifies shell preference persistence through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Device-local shell preferences use real jsdom localStorage to verify their
 * defaults, normalization, round trips, and clearing behavior as one contract.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ElectrobunRendererRpc } from "../bridge/electrobun-rpc";
import {
  clearAvatarIndex,
  hasStoredUiLanguage,
  loadActiveConversationId,
  loadAvatarIndex,
  loadBrowserEnabled,
  loadChatAvatarVisible,
  loadChatVoiceMuted,
  loadCompanionMessageCutoffTs,
  loadComputerUseEnabled,
  loadContinuousChatMode,
  loadHomeTimeWidgetHidden,
  loadLastNativeTab,
  loadOsIntentAutoStartConsent,
  loadPersistedActivePackId,
  loadPersistedActivePackUrl,
  loadPersistedFirstRunComplete,
  loadRecentApps,
  loadUiLanguage,
  loadUiShellMode,
  loadUiTheme,
  loadUiThemeMode,
  loadWakeWordEnabled,
  loadWalletEnabled,
  normalizeUiShellMode,
  normalizeUiTheme,
  normalizeUiThemeMode,
  RECENT_APPS_MAX,
  saveActiveConversationId,
  saveAvatarIndex,
  saveBrowserEnabled,
  saveChatAvatarVisible,
  saveChatVoiceMuted,
  saveCompanionMessageCutoffTs,
  saveComputerUseEnabled,
  saveContinuousChatMode,
  saveHomeTimeWidgetHidden,
  saveLastNativeTab,
  saveOsIntentAutoStartConsent,
  savePersistedActivePackId,
  savePersistedActivePackUrl,
  savePersistedFirstRunComplete,
  saveRecentApps,
  saveUiLanguage,
  saveUiShellMode,
  saveUiTheme,
  saveUiThemeMode,
  saveWakeWordEnabled,
  saveWalletEnabled,
} from "./persistence";

type TestWindow = Window & {
  __ELIZA_ELECTROBUN_RPC__?: ElectrobunRendererRpc;
};

describe("shell preference persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    delete (window as TestWindow).__ELIZA_ELECTROBUN_RPC__;
  });

  it("defaults a fresh elizaOS appliance session to always-on voice", () => {
    (window as TestWindow).__ELIZA_ELECTROBUN_RPC__ = {
      request: {},
      onMessage: () => undefined,
      offMessage: () => undefined,
    };
    window.history.replaceState({}, "", "/?elizaOSAlwaysOnVoice=1");
    expect(loadContinuousChatMode()).toBe("always-on");
    saveContinuousChatMode("off");
    expect(loadContinuousChatMode()).toBe("off");
  });

  it("does not trust a malformed desktop bridge marker from a public page", () => {
    (window as TestWindow).__ELIZA_ELECTROBUN_RPC__ = null as never;
    window.history.replaceState({}, "", "/?elizaOSAlwaysOnVoice=1");
    expect(loadContinuousChatMode()).toBe("off");
  });

  it("exposes the designed defaults for a fresh device", () => {
    expect(loadHomeTimeWidgetHidden()).toBe(false);
    expect(loadPersistedFirstRunComplete()).toBe(false);
    expect(loadPersistedActivePackId()).toBeNull();
    expect(loadPersistedActivePackUrl()).toBeNull();
    expect(hasStoredUiLanguage()).toBe(false);
    expect(loadUiShellMode()).toBe("native");
    expect(loadLastNativeTab()).toBe("chat");
    expect(loadAvatarIndex()).toBe(1);
    expect(loadRecentApps()).toEqual([]);
    expect(loadWalletEnabled()).toBe(true);
    expect(loadContinuousChatMode()).toBe("off");
    expect(loadWakeWordEnabled()).toBe(true);
    expect(loadBrowserEnabled()).toBe(true);
    expect(loadComputerUseEnabled()).toBe(false);
    expect(loadChatAvatarVisible()).toBe(true);
    expect(loadChatVoiceMuted()).toBe(false);
    expect(loadActiveConversationId()).toBeNull();
    expect(loadCompanionMessageCutoffTs()).toBe(0);
    expect(loadOsIntentAutoStartConsent()).toEqual({
      voice: false,
      transcription: false,
    });
  });

  it("round-trips boolean and enum preferences", () => {
    saveHomeTimeWidgetHidden(true);
    savePersistedFirstRunComplete(true);
    saveUiShellMode("native");
    saveLastNativeTab("settings");
    saveWalletEnabled(false);
    saveContinuousChatMode("vad-gated");
    saveWakeWordEnabled(false);
    saveBrowserEnabled(false);
    saveComputerUseEnabled(true);
    saveChatAvatarVisible(false);
    saveChatVoiceMuted(true);
    saveOsIntentAutoStartConsent({ voice: true, transcription: true });

    expect(loadHomeTimeWidgetHidden()).toBe(true);
    expect(loadPersistedFirstRunComplete()).toBe(true);
    expect(loadUiShellMode()).toBe("native");
    expect(loadLastNativeTab()).toBe("settings");
    expect(loadWalletEnabled()).toBe(false);
    expect(loadContinuousChatMode()).toBe("vad-gated");
    expect(loadWakeWordEnabled()).toBe(false);
    expect(loadBrowserEnabled()).toBe(false);
    expect(loadComputerUseEnabled()).toBe(true);
    expect(loadChatAvatarVisible()).toBe(false);
    expect(loadChatVoiceMuted()).toBe(true);
    expect(loadOsIntentAutoStartConsent()).toEqual({
      voice: true,
      transcription: true,
    });
  });

  it("normalizes invalid and legacy theme and navigation values", () => {
    expect(normalizeUiThemeMode("sepia")).toBe("dark");
    expect(normalizeUiTheme("sepia")).toBe("dark");
    expect(normalizeUiShellMode("classic")).toBe("native");

    localStorage.setItem("eliza:ui-theme", "light");
    localStorage.setItem("eliza:last-native-tab", "advanced");
    expect(loadUiThemeMode()).toBe("dark");
    expect(loadUiTheme()).toBe("dark");
    expect(loadLastNativeTab()).toBe("chat");

    saveUiThemeMode("dark");
    saveUiTheme("dark");
    expect(loadUiThemeMode()).toBe("dark");
    expect(loadUiTheme()).toBe("dark");
  });

  it("round-trips and clears identifiers without retaining blank values", () => {
    savePersistedActivePackId("starter-pack");
    savePersistedActivePackUrl("https://example.test/pack.json");
    saveActiveConversationId(" conversation-1 ");
    saveAvatarIndex(0);

    expect(loadPersistedActivePackId()).toBe("starter-pack");
    expect(loadPersistedActivePackUrl()).toBe("https://example.test/pack.json");
    expect(loadActiveConversationId()).toBe("conversation-1");
    expect(loadAvatarIndex()).toBe(0);

    savePersistedActivePackId(null);
    savePersistedActivePackUrl(null);
    saveActiveConversationId("  ");
    clearAvatarIndex();
    expect(loadPersistedActivePackId()).toBeNull();
    expect(loadPersistedActivePackUrl()).toBeNull();
    expect(loadActiveConversationId()).toBeNull();
    expect(loadAvatarIndex()).toBe(1);
  });

  it("normalizes language, recency, and timestamp inputs at storage boundaries", () => {
    saveUiLanguage("en");
    expect(hasStoredUiLanguage()).toBe(true);
    expect(loadUiLanguage()).toBe("en");

    const apps = Array.from(
      { length: RECENT_APPS_MAX + 3 },
      (_, index) => `app-${index}`,
    );
    saveRecentApps(apps);
    expect(loadRecentApps()).toEqual(apps.slice(0, RECENT_APPS_MAX));

    saveCompanionMessageCutoffTs(42.9);
    expect(loadCompanionMessageCutoffTs()).toBe(42);
    saveCompanionMessageCutoffTs(-10);
    expect(loadCompanionMessageCutoffTs()).toBe(0);
  });
});
