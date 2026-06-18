// Pure derivation of the EmotePicker grid from the runtime emote catalog.
//
// Extracted so the grid can be unit-tested without rendering the React picker.
// Building the grid from EMOTE_CATALOG (the exact set the agent server's
// POST /api/emote validates against via EMOTE_BY_ID) guarantees every clickable
// item is a server-valid id and that no catalog emote is omitted.

import type { LucideIcon } from "lucide-react";
import {
  Accessibility,
  Activity,
  ArrowUp,
  Axe,
  Bird,
  Bone,
  ChevronsUp,
  Cloud,
  Dumbbell,
  Eye,
  Fish,
  Footprints,
  Frown,
  Hand,
  Heart,
  Leaf,
  Music2,
  Rabbit,
  Shield,
  Skull,
  Sparkles,
  Swords,
  Target,
  WandSparkles,
  Waves,
} from "lucide-react";
import type { EmoteDef } from "../../emotes/catalog";

export interface EmoteItem {
  id: string;
  name: string;
  category: string;
  icon: LucideIcon;
}

// Per-category fallback icons (used when an emote has no specific icon).
export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  greeting: Hand,
  emotion: Heart,
  dance: Music2,
  combat: Swords,
  idle: Leaf,
  movement: Footprints,
  gesture: Hand,
  other: Sparkles,
};

// Specific per-emote icons; ids absent here fall back to the category icon.
export const EMOTE_ICONS: Record<string, LucideIcon> = {
  wave: Hand,
  kiss: Heart,
  crying: Waves,
  sorrow: Frown,
  "rude-gesture": Hand,
  "looking-around": Eye,
  "dance-happy": Music2,
  "dance-breaking": Accessibility,
  "dance-hiphop": Activity,
  "dance-popping": Sparkles,
  "hook-punch": Dumbbell,
  punching: Shield,
  "firing-gun": Target,
  "sword-swing": Swords,
  chopping: Axe,
  "spell-cast": WandSparkles,
  range: Target,
  death: Skull,
  idle: Leaf,
  talk: Activity,
  squat: Accessibility,
  fishing: Fish,
  float: Bird,
  jump: ArrowUp,
  flip: ChevronsUp,
  run: Rabbit,
  walk: Footprints,
  crawling: Bone,
  fall: Cloud,
};

// Stable display order for the category tabs. Categories not present in the
// catalog are dropped by buildCategoryList.
export const CATEGORY_ORDER = [
  "greeting",
  "emotion",
  "dance",
  "combat",
  "idle",
  "movement",
  "gesture",
  "other",
];

export function buildEmoteGrid(catalog: readonly EmoteDef[]): EmoteItem[] {
  return catalog.map((emote) => ({
    id: emote.id,
    name: emote.name,
    category: emote.category,
    icon: EMOTE_ICONS[emote.id] ?? CATEGORY_ICONS[emote.category] ?? Sparkles,
  }));
}

export function buildCategoryList(grid: readonly EmoteItem[]): string[] {
  return CATEGORY_ORDER.filter((cat) =>
    grid.some((emote) => emote.category === cat),
  );
}

export function categoryLabel(category: string): string {
  return category
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
