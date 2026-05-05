export interface StylePreset {
  avatarIndex: number;
  name: string;
  [key: string]: unknown;
}

export function buildElizaCharacterCatalog(): unknown;
export function getStylePresets(): StylePreset[];
