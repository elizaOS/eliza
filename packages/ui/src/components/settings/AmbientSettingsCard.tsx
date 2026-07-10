/**
 * AmbientSettingsCard — Settings → Voice entry point for ambient listening.
 *
 * A thin settings surface: it explains the always-listening capture mode, its
 * honest limits (foreground-only on iOS PWA), and routes to the full Ambient
 * view where consent + capture live. It never starts capture itself — the
 * consent gate is on the Ambient surface, not buried in Settings.
 *
 * Flag-gated: the caller (VoiceSection) only mounts this when ambient is
 * enabled, so the card adds nothing to the default Settings tree.
 *
 * Black/white/orange tokens + lucide icons only; no gradients, no emoji.
 */

import { Ear } from "lucide-react";
import type * as React from "react";
import { AMBIENT_TWO_PARTY_REMINDER } from "../../ambient/ambient-consent";
import { SettingsGroup, SettingsRow } from "./settings-layout";

export interface AmbientSettingsCardProps {
  /** Navigate to the Ambient view (`/ambient`). */
  onOpen?: () => void;
}

export function AmbientSettingsCard({
  onOpen,
}: AmbientSettingsCardProps): React.ReactElement {
  return (
    <SettingsGroup
      title="Ambient listening"
      description="Continuous, always-on capture that transcribes what it hears until you pause or stop it."
      footer={AMBIENT_TWO_PARTY_REMINDER}
      data-testid="ambient-settings"
    >
      <SettingsRow
        icon={Ear}
        label="Ambient session"
        description="Opens the always-listening surface. You confirm consent there before capture starts. On iPhone, ambient runs only while the app is open and in the foreground."
        onClick={onOpen}
        chevron
        data-testid="ambient-settings-open"
      />
    </SettingsGroup>
  );
}
