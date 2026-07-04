/**
 * Bundled content packs derived from the shared character-preset registry.
 *
 * Every named built-in character (Chen, Jin, Kei, …) — i.e. every style preset
 * except the app's default agent — becomes a content pack. All character data
 * (id, name, avatarIndex, catchphrase) comes from the shared registry so it
 * cannot drift; this module only shapes those presets into ResolvedContentPacks
 * that reference the existing /vrms assets by avatarIndex.
 */

import {
  type ContentPackManifest,
  getDefaultStylePreset,
  getStylePresets,
  type ResolvedContentPack,
  type StylePreset,
} from "@elizaos/shared";

const PACK_VERSION = "1.0.0";

function presetToResolvedPack(preset: StylePreset): ResolvedContentPack {
  const slug = `bundled-${preset.avatarIndex}`;
  const manifest: ContentPackManifest = {
    id: preset.id,
    name: preset.name,
    version: PACK_VERSION,
    assets: {
      vrm: {
        file: `${slug}.vrm.gz`,
        preview: `previews/${slug}.png`,
        slug,
      },
      background: `backgrounds/${slug}.png`,
      personality: {
        name: preset.name,
        catchphrase: preset.catchphrase,
      },
    },
  };
  return {
    manifest,
    avatarIndex: preset.avatarIndex,
    vrmPreviewUrl: `/vrms/previews/${slug}.png`,
    backgroundUrl: `/vrms/backgrounds/${slug}.png`,
    personality: manifest.assets.personality,
    source: { kind: "bundled", id: preset.id },
  };
}

let _cached: ResolvedContentPack[] | null = null;

/**
 * Get all bundled content packs (the named built-in characters — one per style
 * preset, excluding the default agent). Bundled packs use avatarIndex (1-8) to
 * reference existing VRM assets rather than generating custom VRM URLs.
 */
export function getBundledContentPacks(): ResolvedContentPack[] {
  if (_cached) return _cached;
  const defaultPresetId = getDefaultStylePreset().id;
  _cached = getStylePresets()
    .filter((preset) => preset.id !== defaultPresetId)
    .map(presetToResolvedPack);
  return _cached;
}
