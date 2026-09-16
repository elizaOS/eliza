/**
 * License-aware icon-pack mappings used only by the launcher selection lab.
 * The chosen pack will be vendored from its official package before shipping;
 * these previews use Iconify's SVG API so no candidate library enters the app.
 */

export type LauncherPackId =
  | "phosphor-duotone"
  | "phosphor-fill"
  | "solar"
  | "ionicons"
  | "fluent"
  | "tabler";

export interface LauncherPack {
  id: LauncherPackId;
  name: string;
  style: string;
  prefix: string;
  license: string;
  total: string;
  iconColor: string;
  note: string;
}

export const LAUNCHER_PACKS: readonly LauncherPack[] = [
  {
    id: "phosphor-duotone",
    name: "Phosphor",
    style: "Duotone",
    prefix: "ph",
    license: "MIT",
    total: "9,072 variants",
    iconColor: "#11100f",
    note: "Layered, friendly, and highly legible at app-icon scale.",
  },
  {
    id: "phosphor-fill",
    name: "Phosphor",
    style: "Fill",
    prefix: "ph",
    license: "MIT",
    total: "9,072 variants",
    iconColor: "#000000",
    note: "The same family with stronger silhouettes and more visual mass.",
  },
  {
    id: "solar",
    name: "Solar",
    style: "Bold Duotone",
    prefix: "solar",
    license: "CC BY 4.0",
    total: "7,608 variants",
    iconColor: "#ff6a1f",
    note: "Plush layered shapes; richest reference for custom artwork.",
  },
  {
    id: "ionicons",
    name: "Ionicons",
    style: "Filled",
    prefix: "ion",
    license: "MIT",
    total: "1,357 icons",
    iconColor: "#11100f",
    note: "Mobile-native forms and the closest stock pack to iOS.",
  },
  {
    id: "fluent",
    name: "Fluent UI",
    style: "Filled",
    prefix: "fluent",
    license: "MIT",
    total: "19,757 exports",
    iconColor: "#000000",
    note: "Polished optical sizing with soft, friendly silhouettes.",
  },
  {
    id: "tabler",
    name: "Tabler",
    style: "Outline control",
    prefix: "tabler",
    license: "MIT",
    total: "6,184 icons",
    iconColor: "#11100f",
    note: "A crisp comparison control for the simpler line-icon direction.",
  },
] as const;

export const LAUNCHER_APPS = [
  {
    id: "chat",
    label: "Chat",
    icons: {
      "phosphor-duotone": "chat-circle-dots-duotone",
      "phosphor-fill": "chat-circle-dots-fill",
      solar: "chat-round-dots-bold-duotone",
      ionicons: "chatbubble-ellipses",
      fluent: "chat-24-filled",
      tabler: "message-circle",
    },
  },
  {
    id: "settings",
    label: "Settings",
    icons: {
      "phosphor-duotone": "gear-six-duotone",
      "phosphor-fill": "gear-six-fill",
      solar: "settings-bold-duotone",
      ionicons: "settings",
      fluent: "settings-24-filled",
      tabler: "settings",
    },
  },
  {
    id: "wallet",
    label: "Wallet",
    icons: {
      "phosphor-duotone": "wallet-duotone",
      "phosphor-fill": "wallet-fill",
      solar: "wallet-2-bold-duotone",
      ionicons: "wallet",
      fluent: "wallet-24-filled",
      tabler: "wallet",
    },
  },
  {
    id: "activity",
    label: "Activity",
    icons: {
      "phosphor-duotone": "pulse-duotone",
      "phosphor-fill": "pulse-fill",
      solar: "pulse-2-bold-duotone",
      ionicons: "pulse",
      fluent: "pulse-24-filled",
      tabler: "activity-heartbeat",
    },
  },
  {
    id: "calendar",
    label: "Calendar",
    icons: {
      "phosphor-duotone": "calendar-dots-duotone",
      "phosphor-fill": "calendar-dots-fill",
      solar: "calendar-bold-duotone",
      ionicons: "calendar",
      fluent: "calendar-24-filled",
      tabler: "calendar-event",
    },
  },
  {
    id: "notes",
    label: "Notes",
    icons: {
      "phosphor-duotone": "notepad-duotone",
      "phosphor-fill": "notepad-fill",
      solar: "notes-bold-duotone",
      ionicons: "document-text",
      fluent: "note-24-filled",
      tabler: "notes",
    },
  },
  {
    id: "browser",
    label: "Browser",
    icons: {
      "phosphor-duotone": "browser-duotone",
      "phosphor-fill": "browser-fill",
      solar: "global-bold-duotone",
      ionicons: "compass",
      fluent: "globe-24-filled",
      tabler: "world-www",
    },
  },
  {
    id: "knowledge",
    label: "Knowledge",
    icons: {
      "phosphor-duotone": "books-duotone",
      "phosphor-fill": "books-fill",
      solar: "library-bold-duotone",
      ionicons: "library",
      fluent: "book-number-24-filled",
      tabler: "books",
    },
  },
  {
    id: "memories",
    label: "Memories",
    icons: {
      "phosphor-duotone": "brain-duotone",
      "phosphor-fill": "brain-fill",
      solar: "brain-bold-duotone",
      ionicons: "hardware-chip",
      fluent: "brain-circuit-24-filled",
      tabler: "brain",
    },
  },
  {
    id: "cloud",
    label: "Cloud",
    icons: {
      "phosphor-duotone": "cloud-duotone",
      "phosphor-fill": "cloud-fill",
      solar: "cloud-bold-duotone",
      ionicons: "cloud",
      fluent: "cloud-24-filled",
      tabler: "cloud-computing",
    },
  },
  {
    id: "feed",
    label: "Feed",
    icons: {
      "phosphor-duotone": "rss-duotone",
      "phosphor-fill": "rss-fill",
      solar: "feed-bold-duotone",
      ionicons: "newspaper",
      fluent: "news-24-filled",
      tabler: "rss",
    },
  },
  {
    id: "trading",
    label: "Trading",
    icons: {
      "phosphor-duotone": "trend-up-duotone",
      "phosphor-fill": "trend-up-fill",
      solar: "chart-2-bold-duotone",
      ionicons: "trending-up",
      fluent: "data-trending-24-filled",
      tabler: "chart-candle",
    },
  },
] as const;

export type LauncherApp = (typeof LAUNCHER_APPS)[number];
export type LauncherAppId = LauncherApp["id"];

export const CUSTOM_ICON_BRIEFS: Partial<Record<LauncherAppId, string>> = {
  activity:
    "Stock packs skew medical. A custom icon should read as an agent-run timeline or event trail.",
  knowledge:
    "Books are generic. A custom icon could use layered knowledge cards or a compact network lattice.",
  memories:
    "A brain reads as intelligence, not recollection. A keepsake or recall motif would be more specific.",
  cloud:
    "A plain cloud reads as weather. A custom icon should combine Eliza Cloud with apps or services.",
  feed: "RSS feels dated. A custom icon should suggest stacked agent posts with a broadcast cue.",
  trading:
    "If a duotone family wins, a native-style candlestick and token composition would fit better.",
};

export function launcherPack(packId: LauncherPackId): LauncherPack {
  return LAUNCHER_PACKS.find((pack) => pack.id === packId) ?? LAUNCHER_PACKS[0];
}

export function launcherIconUrl(
  app: LauncherApp,
  packId: LauncherPackId,
): string {
  const pack = launcherPack(packId);
  const color = encodeURIComponent(pack.iconColor);
  return `https://api.iconify.design/${pack.prefix}/${app.icons[packId]}.svg?color=${color}`;
}
