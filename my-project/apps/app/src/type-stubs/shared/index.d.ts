export interface StylePreset {
  avatarIndex: number;
  name: string;
  [key: string]: unknown;
}

export function buildElizaCharacterCatalog(): unknown;
export function getStylePresets(): StylePreset[];

export interface DevSettingsRow {
  label: string;
  value: unknown;
  source?: string;
  detail?: string;
}

export function colorizeDevSettingsStartupBanner(text: string): string;
export function formatDevSettingsTable(
  title: string,
  rows: readonly DevSettingsRow[],
): string;
export function prependDevSubsystemFigletHeading(
  subsystem: string,
  body: string,
): string;
export function resolveDesktopApiPort(): number;
export function resolveDesktopApiPortPreference(): string | undefined;
export function resolveDesktopUiPort(): number;
export function resolveDesktopUiPortPreference(): string | undefined;
