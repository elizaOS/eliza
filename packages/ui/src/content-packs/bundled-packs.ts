/**
 * Bundled content packs derived from the existing character presets.
 *
 * Each of the 8 built-in characters (Chen, Jin, Kei, etc.) becomes a
 * content pack with their VRM, background, and personality.
 */

import type { ContentPackManifest, ResolvedContentPack } from "@elizaos/shared";

interface BundledPackDef {
  id: string;
  name: string;
  avatarIndex: number;
  slug: string;
  catchphrase: string;
}

const BUNDLED_PACK_DEFS: BundledPackDef[] = [
  {
    id: "chen",
    name: "Chen",
    avatarIndex: 1,
    slug: "bundled-1",
    catchphrase: "Hey there!",
  },
  {
    id: "jin",
    name: "Jin",
    avatarIndex: 2,
    slug: "bundled-2",
    catchphrase: "What's up?",
  },
  {
    id: "kei",
    name: "Kei",
    avatarIndex: 3,
    slug: "bundled-3",
    catchphrase: "Hi!",
  },
  {
    id: "momo",
    name: "Momo",
    avatarIndex: 4,
    slug: "bundled-4",
    catchphrase: "Hello!",
  },
  {
    id: "rin",
    name: "Rin",
    avatarIndex: 5,
    slug: "bundled-5",
    catchphrase: "Greetings!",
  },
  {
    id: "ryu",
    name: "Ryu",
    avatarIndex: 6,
    slug: "bundled-6",
    catchphrase: "Yo!",
  },
  {
    id: "satoshi",
    name: "Satoshi",
    avatarIndex: 7,
    slug: "bundled-7",
    catchphrase: "Welcome!",
  },
  {
    id: "yuki",
    name: "Yuki",
    avatarIndex: 8,
    slug: "bundled-8",
    catchphrase: "Nice to meet you!",
  },
];

function defToManifest(def: BundledPackDef): ContentPackManifest {
  return {
    id: def.id,
    name: def.name,
    version: "1.0.0",
    assets: {
      vrm: {
        file: `${def.slug}.vrm.gz`,
        preview: `previews/${def.slug}.png`,
        slug: def.slug,
      },
      background: `backgrounds/${def.slug}.png`,
      personality: {
        name: def.name,
        catchphrase: def.catchphrase,
      },
    },
  };
}

let _cached: ResolvedContentPack[] | null = null;

function defToResolvedPack(def: BundledPackDef): ResolvedContentPack {
  const manifest = defToManifest(def);
  return {
    manifest,
    avatarIndex: def.avatarIndex,
    vrmPreviewUrl: `/vrms/previews/${def.slug}.png`,
    backgroundUrl: `/vrms/backgrounds/${def.slug}.png`,
    personality: manifest.assets.personality,
    source: { kind: "bundled", id: def.id },
  };
}

/**
 * Get all bundled content packs (derived from the 8 built-in characters).
 * Bundled packs use avatarIndex (1-8) to reference existing VRM assets
 * rather than generating custom VRM URLs.
 */
export function getBundledContentPacks(): ResolvedContentPack[] {
  if (_cached) return _cached;
  _cached = BUNDLED_PACK_DEFS.map(defToResolvedPack);
  return _cached;
}
