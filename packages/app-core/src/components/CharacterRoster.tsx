/**
 * Shared character roster grid — slant-clipped card selector used by both
 * onboarding (selection-only) and the character editor (with customization).
 */

import type { StylePreset } from "@elizaos/app-core/api";
import { getVrmPreviewUrl } from "@elizaos/app-core/state";

/* ── Shared constants ─────────────────────────────────────────────────── */

export const SLANT_CLIP =
  "polygon(32px 0, 100% 0, calc(100% - 32px) 100%, 0 100%)";
export const INSET_CLIP =
  "polygon(0px 0, 100% 0, calc(100% - 4px) 100%, -8px 100%)";

export const CHARACTER_PRESET_META: Record<
  string,
  { name: string; avatarIndex: number; voicePresetId?: string }
> = {
  "uwu~": { name: "Chen", avatarIndex: 1, voicePresetId: "sarah" },
  "hell yeah": { name: "Jin", avatarIndex: 2, voicePresetId: "adam" },
  "lol k": { name: "Kei", avatarIndex: 3, voicePresetId: "lily" },
  "Noted.": { name: "Momo", avatarIndex: 4, voicePresetId: "alice" },
  "hehe~": { name: "Rin", avatarIndex: 5, voicePresetId: "gigi" },
  "...": { name: "Ryu", avatarIndex: 6, voicePresetId: "daniel" },
  "lmao kms": { name: "Satoshi", avatarIndex: 7, voicePresetId: "callum" },
  "bruh": { name: "Yuki", avatarIndex: 8, voicePresetId: "echo" },
};

/* ── Types ────────────────────────────────────────────────────────────── */

export type CharacterRosterEntry = {
  id: string;
  name: string;
  avatarIndex: number;
  voicePresetId?: string;
  preset: StylePreset;
};

/* ── Helpers ──────────────────────────────────────────────────────────── */

export function resolveRosterEntries(
  styles: readonly StylePreset[],
): CharacterRosterEntry[] {
  return styles.map((preset, index) => {
    const meta = CHARACTER_PRESET_META[preset.catchphrase];
    const fallbackName = `Character ${index + 1}`;
    return {
      id: preset.catchphrase,
      name: meta?.name ?? fallbackName,
      avatarIndex: meta?.avatarIndex ?? (index % 4) + 1,
      voicePresetId: meta?.voicePresetId,
      preset,
    };
  });
}

/* ── Component ────────────────────────────────────────────────────────── */

interface CharacterRosterProps {
  entries: CharacterRosterEntry[];
  selectedId: string | null;
  onSelect: (entry: CharacterRosterEntry) => void;
  /** "onboarding" always uses translucent white borders; "editor" uses theme-aware borders. */
  variant?: "onboarding" | "editor";
  testIdPrefix?: string;
}

export function CharacterRoster({
  entries,
  selectedId,
  onSelect,
  variant = "editor",
  testIdPrefix = "character",
}: CharacterRosterProps) {
  const useWhiteBorders = variant === "onboarding";

  if (entries.length === 0) {
    return (
      <div
        className={`rounded-2xl border p-4 text-sm ${
          useWhiteBorders
            ? "border-white/10 bg-black/10 text-white/50"
            : "border-border/40 bg-black/10 text-muted"
        }`}
      >
        Loading character presets...
      </div>
    );
  }

  return (
    <div
      className="ce-roster"
      data-testid={`${testIdPrefix}-roster-grid`}
    >
      {entries.map((entry) => {
        const isSelected = selectedId === entry.id;

        return (
          <button
            key={entry.id}
            type="button"
            className={`ce-roster-card ${isSelected ? "ce-roster-card--active" : ""}`}
            onClick={() => onSelect(entry)}
            data-testid={`${testIdPrefix}-preset-${entry.id}`}
          >
            <div
              className={`ce-roster-card-frame ${isSelected ? "ce-roster-card-frame--active" : ""}`}
              style={{ clipPath: SLANT_CLIP }}
            >
              <div
                className="ce-roster-card-inner"
                style={{ clipPath: SLANT_CLIP }}
              >
                {isSelected && (
                  <div
                    className="pointer-events-none absolute -inset-3 bg-yellow-300/15 blur-xl"
                    style={{ clipPath: SLANT_CLIP }}
                  />
                )}
                <img
                  src={getVrmPreviewUrl(entry.avatarIndex)}
                  alt={entry.name}
                  draggable={false}
                  className={`ce-roster-card-img ${isSelected ? "ce-roster-card-img--active" : ""}`}
                />
                <div className="ce-roster-card-label">
                  <div
                    className={`ce-roster-card-name ${isSelected ? "ce-roster-card-name--active" : ""}`}
                    style={{ clipPath: INSET_CLIP }}
                  >
                    {entry.name}
                  </div>
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
