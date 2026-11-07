/**
 * Always-mounted bridge for chat-driven appearance preferences.
 *
 * SETTINGS broadcasts `appearance:apply` over the shared view-event bus; this
 * hook is the renderer subscriber that applies those semantic values to the
 * same persisted preference setters used by the Appearance settings section.
 */

import type { UiLanguage } from "@elizaos/core/protocol";

import {
  APPEARANCE_APPLY_EVENT,
  type AppearanceApplyPayload,
} from "@elizaos/core/protocol";
import { useViewEvent } from "../hooks/useViewEvent";
import { UI_LANGUAGES } from "../i18n";
import { useAppSelector } from "../state/app-store";
import { ACCENT_PRESETS } from "../state/ui-preferences";

export type { AppearanceApplyPayload } from "@elizaos/core/protocol";
export { APPEARANCE_APPLY_EVENT };

const ACCENT_IDS = new Set(ACCENT_PRESETS.map((preset) => preset.id));
const LANGUAGE_IDS = new Set<string>(UI_LANGUAGES);
function readAccentId(value: unknown): string | null {
  return typeof value === "string" && ACCENT_IDS.has(value) ? value : null;
}
function readLanguage(value: unknown): UiLanguage | null {
  return typeof value === "string" && LANGUAGE_IDS.has(value)
    ? (value as UiLanguage)
    : null;
}
export function useAppearanceApplyChannel(): void {
  const setUiAccent = useAppSelector((state) => state.setUiAccent);
  const setUiLanguage = useAppSelector((state) => state.setUiLanguage);
  const setHomeTimeWidgetHidden = useAppSelector(
    (state) => state.setHomeTimeWidgetHidden,
  );
  useViewEvent(APPEARANCE_APPLY_EVENT, (event) => {
    const payload = event.payload as AppearanceApplyPayload;
    const accentId = readAccentId(payload.accentId);
    if (accentId) setUiAccent(accentId);
    const language = readLanguage(payload.language);
    if (language) setUiLanguage(language);
    if (typeof payload.homeTimeWidgetHidden === "boolean") {
      setHomeTimeWidgetHidden(payload.homeTimeWidgetHidden);
    }
  });
}
