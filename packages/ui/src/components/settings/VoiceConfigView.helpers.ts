/**
 * Click-audit manifest for VoiceConfigView's desktop Talk Mode panel — the
 * expected desktop-only interactive controls and their coverage, consumed by
 * the desktop click-audit tooling.
 */

import type { DesktopClickAuditItem } from "../../utils";

export const DESKTOP_TALKMODE_CLICK_AUDIT: readonly DesktopClickAuditItem[] = [
  {
    id: "voice-talkmode-refresh",
    entryPoint: "settings:voice",
    label: "Refresh Talk Mode",
    expectedAction: "Refresh talk mode state and speaking status.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "voice-talkmode-start-stop",
    entryPoint: "settings:voice",
    label: "Start/Stop Talk Mode",
    expectedAction: "Start or stop desktop talk mode.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "voice-talkmode-speak",
    entryPoint: "settings:voice",
    label: "Speak Test Phrase",
    expectedAction: "Send a test phrase to talk mode speech output.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "voice-talkmode-stop-speaking",
    entryPoint: "settings:voice",
    label: "Stop Speaking",
    expectedAction: "Stop current desktop speech output.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
] as const;
