// odysseus Settings panel (static/js/settings.js + admin.js + search.js, the
// #settings-modal markup in static/index.html lines ~1300-2220, and the
// settings-* / admin-* rules in style.css). A tabbed modal surface whose left
// nav-rail is grouped into four sections separated by dividers, plus an
// admin-only "Admin" section:
//   • AI plumbing — Add Models (services) / AI Defaults (ai) / Search (search)
//   • Comms       — Integrations / Email / Reminders
//   • UX          — Appearance / Shortcuts
//   • Account     — Account
//   • ADMIN       — Agent Tools (tools) / Users / System
// (Issue #208: a centered window whose content height differs per tab jumps up
// and down between tab switches, so the panel is fixed-height and the overlay
// anchors to flex-start so the rail and window never shift between tabs.)
//
// odysseus has NO separate Admin window — Admin lives inside this Settings
// modal as the admin-only trio, so the clone's standalone AdminView content is
// folded in here (Users / Agent Tools / System).
//
// elizaMapping — real eliza wiring where the @elizaos/ui `client` exposes it,
// honest disabled/empty chrome where it does NOT (grepped the singleton; the
// only relevant methods are getMcpStatus / getPlugins / getCharacter /
// updateCharacter / fetchModels — there is no endpoints / users / auth /
// backup / search-config / reminders / integrations API, so tsgo would fail on
// any invented call):
//   • Add Models (services) — the endpoint add/list machinery is odysseus's
//     /api/admin/endpoints surface, absent from eliza's client. The full
//     collapsible Local/API add forms + Added Models lists are rendered
//     pixel-faithful but inert/disabled with an honest note; the Added Models
//     lists surface the REAL installed model-provider plugins
//     (client.getPlugins, category "ai-provider") as the closest live mapping,
//     and fall back to odysseus's "None" empty state.
//   • AI Defaults (ai) — odysseus's per-endpoint model map (default / utility /
//     vision / research / agent) is owned by the eliza runtime, which exposes
//     no per-endpoint editor. The cards render faithful but disabled, with the
//     real provider plugins shown read-only and an honest note.
//   • Search (search) — odysseus's search-provider / result-count / key fields
//     are its /api/auth/settings surface (not exposed). They persist locally
//     via readPref/writePref under SEARCH_SETTINGS_KEY with an honest note,
//     matching the CompareView COMPARE_VOTES_KEY precedent.
//   • Integrations / Email / Reminders / Account — odysseus's unified-accounts,
//     email-account, reminder-channel, and auth/account surfaces have no eliza
//     client method. Full chrome, honest disabled/empty states; Account shows
//     the real agent name from client.getCharacter().
//   • Appearance — odysseus's appearance panel is a pure-frontend UI VISIBILITY
//     editor (per-element show/hide switches grouped Sidebar / Chat Area, plus
//     Reset All), persisted in localStorage under UI_VIS_KEY and broadcast via
//     OdysseusUiVisEvent so the shell can hide/show the matching elements. The
//     live theme/font/density prefs stay owned by the shell's Theme rail (a
//     read-only summary here).
//   • Shortcuts — odysseus's keyboard-shortcuts panel is client-side; we port
//     the rebindable list, persisted locally under KEYBINDS_KEY and broadcast
//     via OdysseusKeybindEvent for the shell's global key handler.
//   • Admin (tools / users / system) — odysseus's admin sub-tabs are backed by
//     a multi-user auth server (/api/auth/users, /api/admin/wipe, /api/export,
//     …) that eliza does not run. Full chrome, every control disabled with an
//     honest reason; the Users "Allowed models" list is populated from the REAL
//     client.fetchModels(provider) — the same /api/models fetch CompareView +
//     GalleryView use — so it lights up with the agent's real providers.

import type {
  McpServerStatus,
  PluginInfo,
  ProviderModelRecord,
} from "@elizaos/ui";
import { client } from "@elizaos/ui";
import { Minus } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";
import { PREF_KEYS, readPref, writePref } from "./util/storage";

// localStorage key for the locally-persisted web-search preference. The web
// search provider / result-count / key fields are odysseus's /api/auth/settings
// surface, which eliza's client does NOT expose — so this view owns its own
// (non-shared) pref rather than adding to the shared PREF_KEYS table, matching
// the CompareView precedent (COMPARE_VOTES_KEY). If a future eliza search-config
// endpoint lands, promote this to PREF_KEYS.searchSettings (see integrationNotes).
const SEARCH_SETTINGS_KEY = "search-settings";

// odysseus settings-sidebar tabs (index.html data-settings-tab values), 1:1.
type SettingsTab =
  | "services"
  | "ai"
  | "search"
  | "integrations"
  | "email"
  | "reminders"
  | "appearance"
  | "shortcuts"
  | "account"
  | "tools"
  | "users"
  | "system";

// A leading 15x15 icon path-set per rail item (lucide-style, path data copied
// from index.html lines 1316-1371). Rendered inline so the rail matches
// odysseus's icon+label nav items exactly.
interface RailItem {
  id: SettingsTab;
  label: string;
  icon: ReactNode;
  admin?: boolean;
}

// Dividers + the admin section header are positioned by the section the item
// closes (odysseus groups: …Search ⸺ …Reminders ⸺ Shortcuts ⸺ Account ⸺ ADMIN).
const DIVIDER_AFTER: ReadonlySet<SettingsTab> = new Set([
  "search",
  "reminders",
  "shortcuts",
  "account",
]);

function railSvg(children: ReactNode): ReactNode {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const RAIL: readonly RailItem[] = [
  {
    id: "services",
    label: "Add Models",
    icon: railSvg(
      <>
        <rect x="2" y="2" width="20" height="8" rx="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" />
        <circle cx="6" cy="6" r="1" />
        <circle cx="6" cy="18" r="1" />
      </>,
    ),
  },
  {
    id: "ai",
    label: "AI Defaults",
    icon: railSvg(
      <path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z" />,
    ),
  },
  {
    id: "search",
    label: "Search",
    icon: railSvg(
      <>
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </>,
    ),
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: railSvg(
      <>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </>,
    ),
  },
  {
    id: "email",
    label: "Email",
    icon: railSvg(
      <>
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
      </>,
    ),
  },
  {
    id: "reminders",
    label: "Reminders",
    icon: railSvg(
      <>
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </>,
    ),
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: railSvg(
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a7 7 0 0 0 0 20 4 4 0 0 1 0-8 4 4 0 0 0 0-8" />
      </>,
    ),
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    icon: railSvg(
      <>
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" />
      </>,
    ),
  },
  {
    id: "account",
    label: "Account",
    icon: railSvg(
      <>
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </>,
    ),
  },
  {
    id: "tools",
    label: "Agent Tools",
    admin: true,
    icon: railSvg(
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
    ),
  },
  {
    id: "users",
    label: "Users",
    admin: true,
    icon: railSvg(
      <>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </>,
    ),
  },
  {
    id: "system",
    label: "System",
    admin: true,
    icon: railSvg(
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </>,
    ),
  },
];

// ── 14x14 card-title icons (admin-card h2 leading svg, opacity 0.6). ──
function cardSvg(children: ReactNode): ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ICON_SERVER = cardSvg(
  <>
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <circle cx="6" cy="6" r="1" />
    <circle cx="6" cy="18" r="1" />
  </>,
);
const ICON_DEVICE = cardSvg(
  <>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </>,
);
const ICON_GLOBE = cardSvg(
  <>
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </>,
);
const ICON_CHAT = cardSvg(
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
);
const ICON_WRENCH = cardSvg(
  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
);
const ICON_EYE = cardSvg(
  <>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);
const ICON_RESEARCH = cardSvg(
  <>
    <circle cx="11" cy="11" r="8" />
    <path d="M21 21l-4.35-4.35" />
    <line x1="11" y1="8" x2="11" y2="14" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </>,
);
const ICON_SEARCH = cardSvg(
  <>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </>,
);
const ICON_LINK = cardSvg(
  <>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </>,
);
const ICON_ENVELOPE = cardSvg(
  <>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
  </>,
);
const ICON_PEN = cardSvg(
  <>
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </>,
);
const ICON_BELL = cardSvg(
  <>
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </>,
);
const ICON_CHECK = cardSvg(
  <>
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </>,
);
const ICON_USER = cardSvg(
  <>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </>,
);
const ICON_USERPLUS = cardSvg(
  <>
    <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="8.5" cy="7" r="4" />
    <line x1="20" y1="8" x2="20" y2="14" />
    <line x1="23" y1="11" x2="17" y2="11" />
  </>,
);
const ICON_USERS = cardSvg(
  <>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </>,
);
const ICON_LOCK = cardSvg(
  <>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </>,
);
const ICON_LOCK2FA = cardSvg(
  <>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    <circle cx="12" cy="16" r="1" />
  </>,
);
const ICON_DATABASE = cardSvg(
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </>,
);
const ICON_CAL = cardSvg(
  <>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
    <path d="M9 16l2 2 4-4" />
  </>,
);

// ── Web-search providers (search.js _labels + settings.js _searchProviderHints
// / _searchNeedsKey / _searchKeyFields), 1:1 from upstream. ──
type SearchProvider =
  | "searxng"
  | "duckduckgo"
  | "brave"
  | "google_pse"
  | "tavily"
  | "serper"
  | "disabled";

interface SearchProviderMeta {
  id: SearchProvider;
  label: string;
  hint: string;
  needsKey: boolean;
}

const SEARCH_PROVIDERS: readonly SearchProviderMeta[] = [
  {
    id: "searxng",
    label: "SearXNG",
    hint: "Self-hosted SearXNG instance. Leave URL empty to use the SEARXNG_INSTANCE env var.",
    needsKey: false,
  },
  {
    id: "duckduckgo",
    label: "DuckDuckGo",
    hint: "Free search — no API key required. Works out of the box.",
    needsKey: false,
  },
  {
    id: "brave",
    label: "Brave Search",
    hint: "Get your API key from brave.com/search/api",
    needsKey: true,
  },
  {
    id: "google_pse",
    label: "Google PSE",
    hint: "Requires a Google API key and a Programmable Search Engine ID (CX). Create one at programmablesearchengine.google.com",
    needsKey: true,
  },
  {
    id: "tavily",
    label: "Tavily",
    hint: "AI-optimized search. 1,000 free credits/month at tavily.com",
    needsKey: true,
  },
  {
    id: "serper",
    label: "Serper",
    hint: "Google results via API. 2,500 free queries at serper.dev",
    needsKey: true,
  },
  {
    id: "disabled",
    label: "Disabled",
    hint: "Web search and deep research tools will be unavailable.",
    needsKey: false,
  },
];

// Result-count presets (settings.js updateCountDisplay), plus "custom".
const RESULT_COUNT_PRESETS: readonly number[] = [3, 5, 10, 20];

function isPresetCount(n: number): boolean {
  return RESULT_COUNT_PRESETS.includes(n);
}

// Locally-persisted web-search preference (odysseus search_* settings shape,
// trimmed to what this surface edits). Persisted via SEARCH_SETTINGS_KEY until
// eliza exposes a search-config client method.
interface SearchSettings {
  provider: SearchProvider;
  resultCount: number;
  searxngUrl: string;
  apiKey: string;
  googlePseCx: string;
}

const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  provider: "searxng",
  resultCount: 5,
  searxngUrl: "",
  apiKey: "",
  googlePseCx: "",
};

function providerMeta(id: SearchProvider): SearchProviderMeta {
  const found = SEARCH_PROVIDERS.find((p) => p.id === id);
  return found ?? SEARCH_PROVIDERS[0];
}

// Narrow the <select>'s string value to a known SearchProvider without a cast:
// look it up in the provider table (the only source of <option> values), so an
// unknown value falls back to the first provider instead of asserting a type.
function toSearchProvider(value: string): SearchProvider {
  const found = SEARCH_PROVIDERS.find((p) => p.id === value);
  return found ? found.id : SEARCH_PROVIDERS[0].id;
}

// ── Appearance: UI-visibility editor (odysseus initAppearance / applyUIVis) ──
// odysseus keys hide DOM elements by data-ui-key; we scope the set to the
// elements THIS clone's shell renders (IconRail tools + sidebar pieces) so each
// toggle maps to a real surface the integrator can hide. Default is visible.
const UI_VIS_KEY = "ui-visibility";

// Broadcast on every visibility change so OdysseusShell can hide/show the
// matching elements without this panel importing the shell (one-way contract,
// mirrors odysseus's window.applyUIVis). The shell reads UI_VIS_KEY on mount
// and listens for this event.
const UI_VIS_EVENT = "odysseus:ui-visibility-change";

interface VisToggle {
  key: string;
  label: string;
  hint?: string;
}

interface VisGroup {
  title: string;
  icon: ReactNode;
  rows: readonly VisToggle[];
}

// Grouped exactly as odysseus (Sidebar / Chat Area), trimmed to the surfaces
// the clone shell owns. Keys match the shell's data-ui-key contract.
const VIS_GROUPS: readonly VisGroup[] = [
  {
    title: "Sidebar",
    icon: cardSvg(
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="9" y1="3" x2="9" y2="21" />
      </>,
    ),
    rows: [
      { key: "sidebar-brand", label: "Brand", hint: "App name" },
      { key: "sidebar-search", label: "Search" },
      { key: "sidebar-new-chat", label: "New Chat" },
      {
        key: "sessions-section",
        label: "Chats",
        hint: "Session history list",
      },
    ],
  },
  {
    title: "Tools",
    icon: ICON_WRENCH,
    rows: [
      { key: "tool-memory", label: "Memory" },
      { key: "tool-skills", label: "Skills" },
      { key: "tool-notes", label: "Notes" },
      { key: "tool-library", label: "Documents" },
      { key: "tool-compare", label: "Compare" },
      { key: "tool-research", label: "Deep Research" },
      { key: "tool-calendar", label: "Calendar" },
      { key: "tool-tasks", label: "Tasks" },
      { key: "tool-models", label: "Models" },
      { key: "tool-email", label: "Email" },
      { key: "tool-gallery", label: "Gallery" },
      { key: "tool-cookbook", label: "Cookbook" },
      { key: "tool-group", label: "Group Chat" },
      { key: "tool-editor", label: "Image Editor" },
      { key: "tool-admin", label: "Admin" },
      { key: "tool-voice", label: "Voice" },
      { key: "tool-presets", label: "Presets" },
      { key: "tool-theme", label: "Theme" },
    ],
  },
  {
    title: "Chat Area",
    icon: cardSvg(
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />,
    ),
    rows: [
      {
        key: "chat-meta",
        label: "Session Header",
        hint: "Model name & controls above chat",
      },
      {
        key: "show-thinking",
        label: "Thinking Process",
        hint: "Show reasoning collapsibles",
      },
    ],
  },
];

// A row is visible unless explicitly set false (odysseus default-on semantics).
function isVisOn(state: Record<string, boolean>, key: string): boolean {
  return state[key] !== false;
}

// ── Shortcuts: rebindable keybinds (odysseus keyboard-shortcuts.js) ──
// odysseus persists via /api/auth/settings (absent in eliza); we persist
// locally and broadcast so the shell's global key handler can pick up changes.
const KEYBINDS_KEY = "keybinds";
const KEYBIND_EVENT = "odysseus:keybinds-change";

// odysseus _defaultKeybinds (keyboard-shortcuts.js). Open-tool combos are
// unbound by default except Calendar; the panel lets the user assign them.
const SHORTCUT_DEFAULTS: Readonly<Record<string, string>> = {
  search: "ctrl+k",
  toggle_sidebar: "ctrl+alt+b",
  new_session: "ctrl+alt+n",
  fav_session: "ctrl+alt+f",
  delete_session: "ctrl+alt+d",
  cancel: "escape",
  settings: "ctrl+,",
  focus_input: "ctrl+/",
  open_calendar: "ctrl+alt+c",
  open_compare: "",
  open_cookbook: "",
  open_research: "",
  open_gallery: "",
  open_library: "",
  open_memory: "",
  open_notes: "",
  open_tasks: "",
  open_theme: "",
};

const SHORTCUT_LABELS: Readonly<Record<string, string>> = {
  search: "Search conversations",
  toggle_sidebar: "Toggle sidebar",
  new_session: "New session",
  fav_session: "Favorite session",
  delete_session: "Delete session",
  cancel: "Cancel / close",
  settings: "Toggle Settings",
  focus_input: "Focus chat input",
  open_calendar: "Open Calendar",
  open_compare: "Open Compare",
  open_cookbook: "Open Cookbook",
  open_research: "Open Deep Research",
  open_gallery: "Open Gallery",
  open_library: "Open Library",
  open_memory: "Open Memory",
  open_notes: "Open Notes",
  open_tasks: "Open Tasks",
  open_theme: "Open Theme",
};

// odysseus SHORTCUT_CATEGORIES (settings.js), trimmed to bound actions.
const SHORTCUT_CATEGORIES: ReadonlyArray<{
  name: string;
  keys: readonly string[];
}> = [
  {
    name: "Navigation",
    keys: ["search", "toggle_sidebar", "focus_input", "settings"],
  },
  { name: "Sessions", keys: ["new_session", "fav_session", "delete_session"] },
  { name: "General", keys: ["cancel"] },
  {
    name: "Open Tools",
    keys: [
      "open_calendar",
      "open_compare",
      "open_cookbook",
      "open_research",
      "open_gallery",
      "open_library",
      "open_memory",
      "open_notes",
      "open_tasks",
      "open_theme",
    ],
  },
];

// Render a combo as keycap chips (odysseus _formatKeyCaps).
function formatKeyCaps(combo: string): readonly string[] {
  return combo.split("+").map((p) => {
    if (p === "ctrl") return "Ctrl";
    if (p === "alt") return "Alt";
    if (p === "shift") return "Shift";
    if (p === "meta") return "Cmd";
    if (p === "escape") return "Esc";
    if (p === "space") return "Space";
    return p.length === 1
      ? p.toUpperCase()
      : p.charAt(0).toUpperCase() + p.slice(1);
  });
}

// Mirrors platform.js IS_MAC (and useKeyboardShortcuts' detectIsMac): all Apple
// platforms, where a Magic Keyboard's Option key sets AltGraph just like a Mac's
// — so they get the same AltGr carve-out below.
const IS_MAC =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad/.test(navigator.platform || "") ||
    /Mac/.test(navigator.userAgent || ""));

// Build a combo string from a keydown (odysseus _comboFromEvent). Returns ""
// for modifier-only presses so they are never recorded as a binding.
function comboFromEvent(e: KeyboardEvent): string {
  // Drop a stray AltGr keystroke (e.g. AltGr+E to type € on AZERTY/QWERTZ): a
  // non-mac browser reports AltGr AS Ctrl+Alt, so without this guard it would
  // be recorded as a bogus ctrl+alt+<char> binding. onKey ignores empty combos.
  if (!IS_MAC && e.ctrlKey && e.altKey && e.getModifierState?.("AltGraph"))
    return "";
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const key = e.key.toLowerCase();
  if (!["control", "alt", "shift", "meta"].includes(key)) {
    parts.push(key === " " ? "space" : key);
  }
  const combo = parts.join("+");
  // Reject modifier-only combos (odysseus guard).
  if (
    combo === "" ||
    combo === "ctrl" ||
    combo === "alt" ||
    combo === "shift" ||
    combo === "ctrl+alt" ||
    combo === "ctrl+shift" ||
    combo === "alt+shift" ||
    combo === "ctrl+alt+shift"
  ) {
    return "";
  }
  return combo;
}

// ── Admin: built-in tool catalogue (admin.js TOOL_META, index.html
// #adm-builtin-tools-list). Static catalogue metadata — NOT runtime state — so
// the Agent Tools card reads 1:1 while every toggle stays disabled until a
// /api/tools backend exists. ──
interface ToolMeta {
  id: string;
  name: string;
  desc: string;
  cat: string;
  ctx: string;
}

const TOOL_META: readonly ToolMeta[] = [
  {
    id: "bash",
    name: "Shell",
    desc: "Execute bash commands",
    cat: "Code",
    ctx: "~200",
  },
  {
    id: "python",
    name: "Python",
    desc: "Run Python scripts",
    cat: "Code",
    ctx: "~200",
  },
  {
    id: "read_file",
    name: "Read File",
    desc: "Read files from disk",
    cat: "Code",
    ctx: "~150",
  },
  {
    id: "write_file",
    name: "Write File",
    desc: "Write/create files",
    cat: "Code",
    ctx: "~150",
  },
  {
    id: "web_search",
    name: "Web Search",
    desc: "Search the web via SearXNG",
    cat: "Search",
    ctx: "~300",
  },
  {
    id: "search_chats",
    name: "Search Chats",
    desc: "Search conversation history",
    cat: "Search",
    ctx: "~150",
  },
  {
    id: "create_document",
    name: "Create Document",
    desc: "Create new documents",
    cat: "Documents",
    ctx: "~200",
  },
  {
    id: "update_document",
    name: "Update Document",
    desc: "Modify existing documents",
    cat: "Documents",
    ctx: "~200",
  },
  {
    id: "edit_document",
    name: "Edit Document",
    desc: "Find & replace in documents",
    cat: "Documents",
    ctx: "~200",
  },
  {
    id: "suggest_document",
    name: "Suggest Changes",
    desc: "Propose document edits",
    cat: "Documents",
    ctx: "~200",
  },
  {
    id: "manage_documents",
    name: "Manage Documents",
    desc: "List, delete, organize docs",
    cat: "Documents",
    ctx: "~150",
  },
  {
    id: "generate_image",
    name: "Generate Image",
    desc: "Create images via AI",
    cat: "Media",
    ctx: "~150",
  },
  {
    id: "manage_memory",
    name: "Memory",
    desc: "Save and recall memories",
    cat: "Knowledge",
    ctx: "~200",
  },
  {
    id: "manage_skills",
    name: "Skills",
    desc: "Learn and use procedures",
    cat: "Knowledge",
    ctx: "~200",
  },
  {
    id: "manage_rag",
    name: "RAG / Docs",
    desc: "Query indexed documents",
    cat: "Knowledge",
    ctx: "~150",
  },
  {
    id: "chat_with_model",
    name: "Chat with Model",
    desc: "Talk to another AI model",
    cat: "Multi-Agent",
    ctx: "~200",
  },
  {
    id: "second_opinion",
    name: "Second Opinion",
    desc: "Get another model's take",
    cat: "Multi-Agent",
    ctx: "~150",
  },
  {
    id: "pipeline",
    name: "Pipeline",
    desc: "Multi-step AI workflows",
    cat: "Multi-Agent",
    ctx: "~200",
  },
  {
    id: "ask_teacher",
    name: "Ask Teacher",
    desc: "Query a more capable model",
    cat: "Multi-Agent",
    ctx: "~150",
  },
  {
    id: "send_to_session",
    name: "Send to Session",
    desc: "Send message to another chat",
    cat: "Sessions",
    ctx: "~100",
  },
  {
    id: "create_session",
    name: "Create Session",
    desc: "Start a new chat session",
    cat: "Sessions",
    ctx: "~100",
  },
  {
    id: "list_sessions",
    name: "List Sessions",
    desc: "Browse existing sessions",
    cat: "Sessions",
    ctx: "~100",
  },
  {
    id: "manage_session",
    name: "Manage Session",
    desc: "Rename, archive, configure",
    cat: "Sessions",
    ctx: "~100",
  },
  {
    id: "list_models",
    name: "List Models",
    desc: "Show available models",
    cat: "System",
    ctx: "~100",
  },
  {
    id: "ui_control",
    name: "UI Control",
    desc: "Change theme, layout, settings",
    cat: "System",
    ctx: "~150",
  },
  {
    id: "manage_tasks",
    name: "Tasks",
    desc: "Schedule automated tasks",
    cat: "System",
    ctx: "~150",
  },
  {
    id: "api_call",
    name: "API Call",
    desc: "Make HTTP requests",
    cat: "System",
    ctx: "~200",
  },
  {
    id: "manage_endpoints",
    name: "Endpoints",
    desc: "Add/remove model endpoints",
    cat: "System",
    ctx: "~100",
  },
  {
    id: "manage_mcp",
    name: "MCP Servers",
    desc: "Manage MCP connections",
    cat: "System",
    ctx: "~100",
  },
  {
    id: "manage_webhooks",
    name: "Webhooks",
    desc: "Configure webhook events",
    cat: "System",
    ctx: "~100",
  },
  {
    id: "manage_tokens",
    name: "API Tokens",
    desc: "Manage API access tokens",
    cat: "System",
    ctx: "~100",
  },
  {
    id: "manage_settings",
    name: "Settings",
    desc: "Change app settings",
    cat: "System",
    ctx: "~100",
  },
];

const CATEGORY_ORDER = [
  "Code",
  "Search",
  "Documents",
  "Media",
  "Knowledge",
  "Multi-Agent",
  "Sessions",
  "System",
  "Other",
] as const;

// odysseus admin.js PRIV_LABELS — per-user boolean feature grants.
const PRIV_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["can_use_agent", "Agent mode"],
  ["can_use_browser", "Browser automation"],
  ["can_use_bash", "Shell / Python / Files"],
  ["can_use_documents", "Document editor"],
  ["can_use_research", "Deep research"],
  ["can_generate_images", "Image generation"],
  ["can_manage_memory", "Memory & skills"],
];

// odysseus index.html Danger Zone rows (data-wipe-kind + label + sub). 1:1.
interface WipeRow {
  kind: string;
  label: string;
  sub: string;
}

const WIPE_ROWS: readonly WipeRow[] = [
  {
    kind: "chats",
    label: "Wipe all chats",
    sub: "Every session, message, and chat history. Documents/notes/etc. stay.",
  },
  {
    kind: "memory",
    label: "Wipe all memory",
    sub: "Clears `memory.json`, the Memory table, and the vector store. Skills not affected.",
  },
  {
    kind: "skills",
    label: "Wipe all skills",
    sub: "Drops `data/skills/` (all SKILL.md files). Memory not affected.",
  },
  {
    kind: "notes",
    label: "Wipe all notes",
    sub: "Every note, todo, and checklist.",
  },
  {
    kind: "tasks",
    label: "Wipe all tasks",
    sub: "Every scheduled task and its run history (Tasks tool).",
  },
  {
    kind: "documents",
    label: "Wipe all documents",
    sub: "Every document and version. Drafts, exports, library — all gone.",
  },
  {
    kind: "gallery",
    label: "Wipe all gallery",
    sub: "Every image record and the upload directory on disk.",
  },
  {
    kind: "calendar",
    label: "Wipe all calendar",
    sub: "Every event and every calendar (incl. CalDAV-synced ones; resync to restore).",
  },
];

// Real provider model lists feed the per-user "Allowed models" list — the same
// /api/models fetch keys CompareView + GalleryView use.
const MODEL_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "groq",
  "xai",
  "ollama",
] as const;

// ── Small reusable card chrome (admin-card h2 + admin-toggle-sub). ──
function CardTitle({
  icon,
  children,
  faded,
}: {
  icon: ReactNode;
  children: ReactNode;
  faded?: string;
}): ReactNode {
  return (
    <h2 className="od-set-card-title">
      <span className="od-set-card-title-icon">{icon}</span>
      <span>{children}</span>
      {faded ? <span className="od-set-card-faded">{faded}</span> : null}
    </h2>
  );
}

function Sub({ children }: { children: ReactNode }): ReactNode {
  return <div className="od-set-sub">{children}</div>;
}

export function SettingsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  useEscapeClose(open, onClose);
  const win = useWindowControls(
    "win-settings",
    { w: 820, h: 700 },
    { label: "Settings", icon: "Settings", onClose },
  );
  const [tab, setTab] = useState<SettingsTab>("services");

  // General/admin — MCP servers (real status) + installed plugins (real list).
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);

  // Web search — local preference (no eliza backend).
  const [search, setSearch] = useState<SearchSettings>(DEFAULT_SEARCH_SETTINGS);
  const [countMode, setCountMode] = useState<"preset" | "custom">("preset");

  // Account — real character / agent name (read-only here).
  const [agentName, setAgentName] = useState("");

  // Appearance — read-only mirror of the live shell theme prefs (Theme rail is
  // the writer), plus the editable UI-visibility toggle set.
  const [themeMode, setThemeMode] = useState("dark");
  const [font, setFont] = useState("mono");
  const [density, setDensity] = useState("comfortable");
  const [vis, setVis] = useState<Record<string, boolean>>({});

  // Shortcuts — editable keybinds + the action currently being rebound.
  const [keybinds, setKeybinds] =
    useState<Record<string, string>>(SHORTCUT_DEFAULTS);
  const [rebinding, setRebinding] = useState<string | null>(null);
  const keybindsRef = useRef(keybinds);
  keybindsRef.current = keybinds;

  // Admin — real provider models for the per-user "Allowed models" list.
  const [models, setModels] = useState<ProviderModelRecord[]>([]);

  // Services — collapsed/expanded state of the Local/API add sections.
  const [openLocal, setOpenLocal] = useState(false);
  const [openApi, setOpenApi] = useState(false);

  useEffect(() => {
    if (!open) return;
    void client
      .getMcpStatus()
      .then((r) => setServers(r.servers))
      .catch(() => setServers([]));
    void client
      .getPlugins()
      .then((r) => setPlugins(r.plugins))
      .catch(() => setPlugins([]));

    // Merge on read: readPref returns the raw parsed blob, so a partial stored
    // object (e.g. an older write missing apiKey) would otherwise leave
    // search.apiKey undefined and crash the searchStatus / warn-class
    // .trim() calls during render. Spread DEFAULT first so every field is
    // present, and feed the MERGED object to the preset-count detection.
    const stored = readPref<Partial<SearchSettings>>(SEARCH_SETTINGS_KEY, {});
    const merged: SearchSettings = { ...DEFAULT_SEARCH_SETTINGS, ...stored };
    setSearch(merged);
    setCountMode(isPresetCount(merged.resultCount) ? "preset" : "custom");

    void client
      .getCharacter()
      .then((r) => setAgentName(r.agentName))
      .catch(() => setAgentName(""));

    setThemeMode(readPref<string>(PREF_KEYS.themeMode, "dark"));
    setFont(readPref<string>(PREF_KEYS.font, "mono"));
    setDensity(readPref<string>(PREF_KEYS.density, "comfortable"));

    setVis(readPref<Record<string, boolean>>(UI_VIS_KEY, {}));
    setKeybinds({
      ...SHORTCUT_DEFAULTS,
      ...readPref<Record<string, string>>(KEYBINDS_KEY, {}),
    });
    setRebinding(null);
  }, [open]);

  // Populate the admin "Allowed models" list from the REAL provider model lists
  // — the same /api/models endpoint the settings + compare surfaces use.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all(
      MODEL_PROVIDERS.map((provider) =>
        client
          .fetchModels(provider)
          .then((r): ProviderModelRecord[] => r.models)
          .catch((): ProviderModelRecord[] => []),
      ),
    ).then((lists) => {
      if (cancelled) return;
      const seen = new Set<string>();
      const flat: ProviderModelRecord[] = [];
      for (const m of lists.flat()) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        flat.push(m);
      }
      flat.sort((a, b) => a.name.localeCompare(b.name));
      setModels(flat);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Persist + broadcast outside any setState updater (updaters must stay pure;
  // React StrictMode runs them twice, which would double-write the pref and fire
  // the events twice).
  const persistKeybinds = useCallback((next: Record<string, string>) => {
    setKeybinds(next);
    writePref(KEYBINDS_KEY, next);
    window.dispatchEvent(new CustomEvent(KEYBIND_EVENT, { detail: next }));
  }, []);

  useEffect(() => {
    if (!rebinding) return;
    const action = rebinding;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRebinding(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      persistKeybinds({ ...keybindsRef.current, [action]: combo });
      setRebinding(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rebinding, persistKeybinds]);

  const persistVis = useCallback((next: Record<string, boolean>) => {
    setVis(next);
    writePref(UI_VIS_KEY, next);
    window.dispatchEvent(new CustomEvent(UI_VIS_EVENT, { detail: next }));
  }, []);

  const toggleVis = useCallback(
    (key: string) => {
      persistVis({ ...vis, [key]: !isVisOn(vis, key) });
    },
    [vis, persistVis],
  );

  const resetVis = useCallback(() => {
    persistVis({});
  }, [persistVis]);

  const resetKeybind = useCallback(
    (action: string) => {
      persistKeybinds({
        ...keybinds,
        [action]: SHORTCUT_DEFAULTS[action] ?? "",
      });
    },
    [keybinds, persistKeybinds],
  );

  const resetAllKeybinds = useCallback(() => {
    setRebinding(null);
    persistKeybinds({ ...SHORTCUT_DEFAULTS });
  }, [persistKeybinds]);

  // Real installed model-provider plugins — surfaced as the closest live
  // mapping for the "Added Models" endpoint lists.
  const modelPlugins = useMemo(
    () => plugins.filter((p) => p.category === "ai-provider"),
    [plugins],
  );

  if (!open) return null;
  if (win.minimized) return null;

  const persistSearch = (next: SearchSettings) => {
    setSearch(next);
    writePref(SEARCH_SETTINGS_KEY, next);
  };

  const activeProvider = providerMeta(search.provider);
  const searchStatus =
    search.provider === "disabled"
      ? "Search disabled"
      : `${activeProvider.label} · ${search.resultCount} results${
          activeProvider.needsKey
            ? search.apiKey.trim()
              ? " · key set"
              : " · no key"
            : ""
        }`;

  return (
    <div
      className={`od-search-overlay od-settings-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="od-search-backdrop"
      />
      {win.snapGhost ? (
        <div
          className="od-snap-ghost"
          style={win.snapGhost}
          aria-hidden="true"
        />
      ) : null}
      <div className="od-search-panel od-settings-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        {/* ── Header (settings-modal header) ── */}
        <div
          className="od-settings-header od-window-header"
          onPointerDown={win.onDragStart}
        >
          <span className="od-settings-header-icon" aria-hidden="true">
            ⚙
          </span>
          <span className="od-settings-header-title">Settings</span>
          <span className="od-settings-header-spacer" />
          {/* odysseus's Settings modal header carries only minimize + close —
              no Peek (theme-opacity) control on this surface. */}
          <button
            type="button"
            className="od-window-min-btn"
            onClick={win.minimize}
            title="Minimize"
            aria-label="Minimize"
          >
            <Minus size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="od-settings-close"
            aria-label="Close settings"
            title="Close settings"
            onClick={onClose}
          >
            ✖
          </button>
        </div>

        {/* Subtitle row (index.html admin-toggle-sub under the header). */}
        <div className="od-settings-subtitle">
          Toggle on/off visibility of tools and modules across the interface.
        </div>

        {/* ── Body: left tab rail + anchored panels ── */}
        <div className="od-settings-body">
          <div
            className="od-settings-rail"
            role="tablist"
            aria-label="Settings sections"
          >
            {RAIL.map((item) => (
              <RailButton
                key={item.id}
                item={item}
                active={tab === item.id}
                onSelect={() => setTab(item.id)}
              />
            ))}
          </div>

          <div className="od-settings-panels">
            {tab === "services" ? (
              <div className="od-settings-section" role="tabpanel">
                <div className="od-settings-card">
                  <CardTitle icon={ICON_SERVER} faded="(Endpoints)">
                    Add Models
                  </CardTitle>
                  <Sub>Connect local models first, or add a cloud API.</Sub>

                  {/* Local subsection (collapsible) */}
                  <CollapsibleEndpoint
                    open={openLocal}
                    onToggle={() => setOpenLocal((v) => !v)}
                    icon={ICON_DEVICE}
                    label="Local"
                  >
                    <div className="od-set-ep-form">
                      <div className="od-set-ep-row">
                        <input
                          className="od-settings-input"
                          type="text"
                          placeholder="Paste endpoint URL, e.g. http://localhost:11434/v1"
                          disabled
                        />
                        <select
                          className="od-settings-select od-set-ep-type"
                          disabled
                        >
                          <option>LLM</option>
                          <option>Image</option>
                        </select>
                      </div>
                      <div className="od-set-ep-row od-set-ep-actions">
                        <span className="od-set-ep-spacer" />
                        <button
                          type="button"
                          className="od-settings-btn-sm"
                          disabled
                        >
                          Test
                        </button>
                        <button
                          type="button"
                          className="od-settings-btn-add"
                          disabled
                        >
                          Add
                        </button>
                      </div>
                      <div className="od-set-quickstart">
                        <span className="od-set-quickstart-label">
                          Quickstart
                        </span>
                        <button
                          type="button"
                          className="od-settings-btn-sm"
                          disabled
                        >
                          <span className="od-set-btn-ico">{ICON_SEARCH}</span>
                          Scan for Servers
                        </button>
                        <button
                          type="button"
                          className="od-settings-btn-sm"
                          disabled
                        >
                          Ollama
                        </button>
                      </div>
                    </div>
                  </CollapsibleEndpoint>

                  {/* API subsection (collapsible) */}
                  <CollapsibleEndpoint
                    open={openApi}
                    onToggle={() => setOpenApi((v) => !v)}
                    icon={ICON_GLOBE}
                    label="API"
                  >
                    <div className="od-set-ep-form">
                      <div className="od-set-ep-row">
                        <input
                          className="od-settings-input"
                          type="text"
                          placeholder="Base URL or pick provider"
                          disabled
                        />
                      </div>
                      <div className="od-set-ep-row">
                        <input
                          className="od-settings-input"
                          type="password"
                          placeholder="API key"
                          disabled
                        />
                        <select
                          className="od-settings-select od-set-ep-type"
                          disabled
                        >
                          <option>LLM</option>
                          <option>Image</option>
                        </select>
                        <button
                          type="button"
                          className="od-settings-btn-sm"
                          disabled
                        >
                          Test
                        </button>
                        <button
                          type="button"
                          className="od-settings-btn-add"
                          disabled
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  </CollapsibleEndpoint>
                </div>

                <div className="od-settings-card">
                  <CardTitle icon={ICON_DEVICE} faded="(Endpoints)">
                    Added Models
                  </CardTitle>
                  <Sub>Manage the endpoints you've added.</Sub>
                  <div className="od-set-ep-list">
                    <div className="od-set-ep-list-head">
                      <span className="od-set-ep-list-ico">{ICON_DEVICE}</span>
                      <span>Local</span>
                    </div>
                    <div className="od-set-ep-none">None</div>
                  </div>
                  <div className="od-set-ep-list">
                    <div className="od-set-ep-list-head">
                      <span className="od-set-ep-list-ico">{ICON_GLOBE}</span>
                      <span>API</span>
                    </div>
                    {modelPlugins.length === 0 ? (
                      <div className="od-set-ep-none">None</div>
                    ) : (
                      modelPlugins.map((p) => (
                        <div className="od-skill-item" key={p.id}>
                          <div className="od-skill-info">
                            <div className="od-skill-name">{p.name}</div>
                            <div className="od-skill-desc">
                              {p.configured ? "configured" : "not configured"}
                            </div>
                          </div>
                          <span
                            className={`od-skill-toggle${p.enabled ? " on" : ""}`}
                          >
                            {p.enabled ? "On" : "Off"}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                <div className="od-settings-note">
                  Endpoints are added through the eliza runtime, not this client
                  — the add forms are shown faithfully but disabled. The API
                  list surfaces the agent's real installed model-provider
                  plugins.
                </div>
              </div>
            ) : null}

            {tab === "ai" ? (
              <div className="od-settings-section" role="tabpanel">
                <AiCard
                  icon={ICON_CHAT}
                  title="Default Chat Model"
                  sub="The model used when creating a new chat session."
                />
                <AiCard
                  icon={ICON_WRENCH}
                  title="Utility Model"
                  faded="(Recommended: Local Endpoint)"
                  sub="Runs background tasks (compaction, cleanup, auto-naming, retrieving memories from files) on a small/local model instead of your chat model. Leave blank to use the chat model."
                />
                <AiCard
                  icon={ICON_EYE}
                  title="Vision"
                  sub="Analyze images with a vision-capable model."
                />
                <AiCard
                  icon={ICON_RESEARCH}
                  title="Research Model"
                  sub="Model used for Deep Research. Falls back to the default chat model if not set."
                />
                <div className="od-settings-card">
                  <CardTitle icon={ICON_WRENCH}>Agent</CardTitle>
                  <Sub>Controls for the agent tool loop.</Sub>
                  <div className="od-settings-row">
                    <span className="od-settings-label">Active agent</span>
                    <span className="od-settings-value">
                      {agentName || "—"}
                    </span>
                  </div>
                  <div className="od-settings-row">
                    <span className="od-settings-label">Plugins loaded</span>
                    <span className="od-settings-value">{plugins.length}</span>
                  </div>
                  <div className="od-settings-row">
                    <span className="od-settings-label">Model providers</span>
                    <span className="od-settings-value">
                      {modelPlugins.length}
                    </span>
                  </div>
                </div>
                <div className="od-settings-note">
                  This agent's model map (default / utility / vision / research
                  endpoints and fallback chains) is owned by the eliza runtime,
                  which does not expose a per-endpoint editor to this client —
                  so the selectors are shown disabled rather than offering an
                  editor that cannot persist.
                </div>
              </div>
            ) : null}

            {tab === "search" ? (
              <div className="od-settings-section" role="tabpanel">
                <div className="od-settings-card">
                  <CardTitle icon={ICON_SEARCH}>Web Search</CardTitle>
                  <Sub>Search API used for web search and deep research.</Sub>
                  <div className="od-settings-field">
                    <label
                      className="od-settings-flabel"
                      htmlFor="od-set-search-provider"
                    >
                      Provider
                    </label>
                    <select
                      id="od-set-search-provider"
                      className="od-settings-select"
                      value={search.provider}
                      onChange={(e) =>
                        persistSearch({
                          ...search,
                          provider: toSearchProvider(e.target.value),
                        })
                      }
                    >
                      {SEARCH_PROVIDERS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    <div className="od-settings-hint">
                      {activeProvider.hint}
                    </div>
                  </div>

                  {search.provider !== "disabled" ? (
                    <div className="od-settings-field">
                      <label
                        className="od-settings-flabel"
                        htmlFor="od-set-search-count"
                      >
                        Results
                      </label>
                      <select
                        id="od-set-search-count"
                        className="od-settings-select"
                        value={
                          countMode === "custom"
                            ? "custom"
                            : String(search.resultCount)
                        }
                        onChange={(e) => {
                          if (e.target.value === "custom") {
                            setCountMode("custom");
                            return;
                          }
                          setCountMode("preset");
                          persistSearch({
                            ...search,
                            resultCount: Number.parseInt(e.target.value, 10),
                          });
                        }}
                      >
                        {RESULT_COUNT_PRESETS.map((n) => (
                          <option key={n} value={String(n)}>
                            {n}
                          </option>
                        ))}
                        <option value="custom">Custom</option>
                      </select>
                      {countMode === "custom" ? (
                        <input
                          className="od-settings-input"
                          type="number"
                          min={1}
                          max={100}
                          value={search.resultCount}
                          aria-label="Custom result count"
                          onChange={(e) => {
                            const raw = Number.parseInt(e.target.value, 10);
                            const clamped = Number.isFinite(raw)
                              ? Math.max(1, Math.min(100, raw))
                              : search.resultCount;
                            persistSearch({ ...search, resultCount: clamped });
                          }}
                        />
                      ) : null}
                    </div>
                  ) : null}

                  {search.provider === "searxng" ? (
                    <div className="od-settings-field">
                      <label
                        className="od-settings-flabel"
                        htmlFor="od-set-search-url"
                      >
                        URL
                      </label>
                      <input
                        id="od-set-search-url"
                        className="od-settings-input"
                        type="text"
                        placeholder="http://localhost:8080"
                        value={search.searxngUrl}
                        onChange={(e) =>
                          persistSearch({
                            ...search,
                            searxngUrl: e.target.value,
                          })
                        }
                      />
                    </div>
                  ) : null}

                  {activeProvider.needsKey ? (
                    <div className="od-settings-field">
                      <label
                        className="od-settings-flabel"
                        htmlFor="od-set-search-key"
                      >
                        API Key
                      </label>
                      <input
                        id="od-set-search-key"
                        className="od-settings-input"
                        type="password"
                        placeholder="API key"
                        value={search.apiKey}
                        onChange={(e) =>
                          persistSearch({ ...search, apiKey: e.target.value })
                        }
                      />
                    </div>
                  ) : null}

                  {search.provider === "google_pse" ? (
                    <div className="od-settings-field">
                      <label
                        className="od-settings-flabel"
                        htmlFor="od-set-search-cx"
                      >
                        CX ID
                      </label>
                      <input
                        id="od-set-search-cx"
                        className="od-settings-input"
                        type="text"
                        placeholder="Google PSE engine ID"
                        value={search.googlePseCx}
                        onChange={(e) =>
                          persistSearch({
                            ...search,
                            googlePseCx: e.target.value,
                          })
                        }
                      />
                    </div>
                  ) : null}

                  <div
                    className={`od-settings-status${
                      search.provider === "disabled" ||
                      (activeProvider.needsKey && !search.apiKey.trim())
                        ? " warn"
                        : ""
                    }`}
                  >
                    {searchStatus}
                  </div>
                  <div className="od-settings-note">
                    Stored as a local browser preference — eliza does not yet
                    expose a search-config endpoint to persist this server-side.
                  </div>
                </div>
              </div>
            ) : null}

            {tab === "integrations" ? (
              <div className="od-settings-section" role="tabpanel">
                <div className="od-settings-card">
                  <CardTitle icon={ICON_LINK}>Connections</CardTitle>
                  <Sub>All external service connections in one place.</Sub>
                  <div className="od-settings-empty">
                    No integrations connected.
                  </div>
                  <div className="od-set-center-actions">
                    <button
                      type="button"
                      className="od-settings-btn-sm"
                      disabled
                    >
                      + Add Integration
                    </button>
                  </div>
                </div>
                <div className="od-settings-note">
                  Unified integrations (API keys, calendars, contacts, email
                  accounts, MCP, vault) are managed by the eliza runtime — this
                  client has no integrations API, so the surface is shown
                  faithfully but inert.
                </div>
              </div>
            ) : null}

            {tab === "email" ? (
              <div className="od-settings-section" role="tabpanel">
                <div className="od-settings-card">
                  <CardTitle icon={ICON_ENVELOPE}>Email Accounts</CardTitle>
                  <div className="od-set-row-action">
                    <Sub>
                      Add, edit, delete, and test accounts in Integrations.
                    </Sub>
                    <button
                      type="button"
                      className="od-settings-btn-add"
                      disabled
                    >
                      Manage in Integrations
                    </button>
                  </div>
                </div>
                <div className="od-settings-card">
                  <CardTitle icon={ICON_CAL}>Email Tasks</CardTitle>
                  <div className="od-set-row-action">
                    <Sub>Manage email background tasks in Tasks.</Sub>
                    <button
                      type="button"
                      className="od-settings-btn-add"
                      disabled
                    >
                      Open Tasks
                    </button>
                  </div>
                </div>
                <div className="od-settings-card">
                  <CardTitle icon={ICON_PEN}>Writing Style</CardTitle>
                  <Sub>
                    AI-extracted from your sent emails. Used when AI drafts
                    replies.
                  </Sub>
                  <textarea
                    className="od-settings-textarea"
                    rows={4}
                    placeholder="e.g. I write emails in this style. I don't use exclamation marks. I sign emails with: ..."
                    disabled
                  />
                  <div className="od-settings-actions od-set-actions-end">
                    <button
                      type="button"
                      className="od-settings-btn-add"
                      disabled
                    >
                      Extract from Sent (15 emails)
                    </button>
                    <button
                      type="button"
                      className="od-settings-btn-add"
                      disabled
                    >
                      Save
                    </button>
                  </div>
                </div>
                <div className="od-settings-note">
                  Email accounts and writing-style extraction are owned by the
                  eliza runtime — no email-config API is exposed to this client,
                  so these controls are shown faithfully but inert.
                </div>
              </div>
            ) : null}

            {tab === "reminders" ? (
              <div className="od-settings-section" role="tabpanel">
                <div className="od-settings-card">
                  <CardTitle icon={ICON_BELL}>How you're reminded</CardTitle>
                  <Sub>Controls how fired note reminders are delivered.</Sub>
                  <div className="od-settings-field">
                    <label
                      className="od-settings-flabel"
                      htmlFor="od-set-rem-ch"
                    >
                      Channel
                    </label>
                    <select
                      id="od-set-rem-ch"
                      className="od-settings-select"
                      disabled
                    >
                      <option>Browser notification (default)</option>
                      <option>Email</option>
                      <option>ntfy</option>
                    </select>
                  </div>
                </div>
                <div className="od-settings-card">
                  <CardTitle icon={ICON_CHECK}>AI Synthesis</CardTitle>
                  <Sub>
                    When on, the utility model writes a short, warm one-line
                    reminder for browser, email, AND ntfy reminders instead of
                    just the raw note content.
                  </Sub>
                </div>
                <div className="od-settings-card">
                  <CardTitle icon={ICON_LINK}>Public App URL</CardTitle>
                  <Sub>
                    Used to build clickable links back to Orchestrator inside
                    outgoing reminder / urgent-email emails. Leave blank to omit
                    links.
                  </Sub>
                  <div className="od-settings-field">
                    <label
                      className="od-settings-flabel"
                      htmlFor="od-set-rem-url"
                    >
                      URL
                    </label>
                    <input
                      id="od-set-rem-url"
                      className="od-settings-input"
                      type="url"
                      placeholder="https://chat.example.com"
                      disabled
                    />
                  </div>
                </div>
                <div className="od-settings-card">
                  <CardTitle icon={ICON_CHECK}>Test</CardTitle>
                  <Sub>
                    Fire a test reminder using your current settings to verify
                    everything works.
                  </Sub>
                  <div className="od-settings-actions od-set-actions-end">
                    <button
                      type="button"
                      className="od-settings-btn-add"
                      disabled
                    >
                      Send Test Reminder
                    </button>
                  </div>
                </div>
                <div className="od-settings-note">
                  Reminder delivery (channels, ntfy, email-from) is owned by the
                  eliza runtime — no reminder-config API is exposed to this
                  client, so these controls are shown faithfully but inert.
                </div>
              </div>
            ) : null}

            {tab === "appearance" ? (
              <div className="od-settings-section" role="tabpanel">
                <div className="od-settings-card">
                  <CardTitle icon={ICON_EYE}>Theme</CardTitle>
                  <div className="od-settings-row">
                    <span className="od-settings-label">Theme</span>
                    <span className="od-settings-value">{themeMode}</span>
                  </div>
                  <div className="od-settings-row">
                    <span className="od-settings-label">Font</span>
                    <span className="od-settings-value">{font}</span>
                  </div>
                  <div className="od-settings-row">
                    <span className="od-settings-label">Density</span>
                    <span className="od-settings-value">{density}</span>
                  </div>
                  <div className="od-settings-note">
                    Theme, font, and density are set live from the shell's theme
                    rail so changes preview instantly; this tab mirrors the
                    active values.
                  </div>
                </div>

                {VIS_GROUPS.map((group) => (
                  <div className="od-settings-card" key={group.title}>
                    <CardTitle icon={group.icon}>{group.title}</CardTitle>
                    <div className="od-vis-toggles">
                      {group.rows.map((row) => {
                        const on = isVisOn(vis, row.key);
                        return (
                          <button
                            type="button"
                            key={row.key}
                            className="od-vis-row"
                            aria-pressed={on}
                            onClick={() => toggleVis(row.key)}
                          >
                            <span className="od-vis-label">
                              {row.label}
                              {row.hint ? (
                                <span className="od-vis-hint">{row.hint}</span>
                              ) : null}
                            </span>
                            <span
                              className={`od-vis-switch${on ? " on" : ""}`}
                            />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}

                <div className="od-settings-actions od-vis-reset-row">
                  <button
                    type="button"
                    className="od-settings-reset"
                    onClick={resetVis}
                  >
                    Reset All
                  </button>
                </div>
                <div className="od-settings-note">
                  Show or hide shell elements. Stored as a local browser
                  preference and applied live to the sidebar and tool rail.
                </div>
              </div>
            ) : null}

            {tab === "shortcuts" ? (
              <div className="od-settings-section" role="tabpanel">
                <div className="od-settings-card od-shortcut-head-card">
                  <div>
                    <CardTitle
                      icon={cardSvg(
                        <>
                          <rect x="2" y="4" width="20" height="16" rx="2" />
                          <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" />
                        </>,
                      )}
                    >
                      Keyboard Shortcuts
                    </CardTitle>
                    <div className="od-settings-hint">
                      Click a shortcut to rebind. Press Escape to cancel.
                    </div>
                  </div>
                  <button
                    type="button"
                    className="od-settings-reset"
                    onClick={resetAllKeybinds}
                  >
                    Reset
                  </button>
                </div>
                <div className="od-settings-card">
                  {(() => {
                    // Highlight any combo bound to more than one action
                    // (odysseus _findConflicts).
                    const seen = new Set<string>();
                    const conflicts = new Set<string>();
                    for (const combo of Object.values(keybinds)) {
                      if (!combo) continue;
                      if (seen.has(combo)) conflicts.add(combo);
                      else seen.add(combo);
                    }
                    return SHORTCUT_CATEGORIES.map((cat) => (
                      <div key={cat.name}>
                        <div className="od-shortcut-category">{cat.name}</div>
                        {cat.keys.map((action) => {
                          const combo = keybinds[action] ?? "";
                          const isCustom =
                            combo !== (SHORTCUT_DEFAULTS[action] ?? "");
                          const isListening = rebinding === action;
                          const conflict =
                            combo.length > 0 && conflicts.has(combo);
                          return (
                            <div
                              key={action}
                              className={`od-shortcut-row${conflict ? " conflict" : ""}`}
                            >
                              <span className="od-shortcut-label">
                                {SHORTCUT_LABELS[action] ?? action}
                                {conflict ? (
                                  <span
                                    className="od-shortcut-warn"
                                    title="Duplicate shortcut"
                                  >
                                    !
                                  </span>
                                ) : null}
                              </span>
                              <div className="od-shortcut-controls">
                                <button
                                  type="button"
                                  className={`od-shortcut-key${combo ? "" : " unset"}${isListening ? " listening" : ""}`}
                                  title="Click to rebind"
                                  onClick={() =>
                                    setRebinding(isListening ? null : action)
                                  }
                                >
                                  {isListening ? (
                                    <span className="od-shortcut-listening">
                                      Press keys…
                                    </span>
                                  ) : combo ? (
                                    formatKeyCaps(combo).map((cap, i) => (
                                      // biome-ignore lint/suspicious/noArrayIndexKey: keycaps are positional within a fixed combo
                                      <kbd key={`${action}-${i}`}>{cap}</kbd>
                                    ))
                                  ) : (
                                    <span className="od-shortcut-unset">
                                      Set
                                    </span>
                                  )}
                                </button>
                                {isCustom ? (
                                  <button
                                    type="button"
                                    className="od-shortcut-resetbtn"
                                    title="Reset to default"
                                    aria-label={`Reset ${SHORTCUT_LABELS[action] ?? action}`}
                                    onClick={() => resetKeybind(action)}
                                  >
                                    ↩
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ));
                  })()}
                </div>
                <div className="od-settings-note">
                  Stored as a local browser preference. The shell applies these
                  bindings to its global key handler.
                </div>
              </div>
            ) : null}

            {tab === "account" ? (
              <div className="od-settings-section" role="tabpanel">
                <div className="od-settings-card">
                  <CardTitle icon={ICON_USER}>Account</CardTitle>
                  <div className="od-set-account-row">
                    <span className="od-set-account-avatar">
                      {(agentName.charAt(0) || "A").toUpperCase()}
                    </span>
                    <div className="od-set-account-meta">
                      <div className="od-set-account-name">
                        {agentName || "—"}
                      </div>
                      <div className="od-set-account-role">Agent</div>
                    </div>
                    <button
                      type="button"
                      className="od-settings-btn-logout"
                      disabled
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                        <polyline points="16 17 21 12 16 7" />
                        <line x1="21" y1="12" x2="9" y2="12" />
                      </svg>
                      Logout
                    </button>
                  </div>
                </div>
                <div className="od-settings-card">
                  <CardTitle icon={ICON_LOCK}>Change Password</CardTitle>
                  <div className="od-settings-field">
                    <input
                      className="od-settings-input"
                      type="password"
                      placeholder="Current password"
                      disabled
                    />
                    <input
                      className="od-settings-input"
                      type="password"
                      placeholder="New password (min 8)"
                      disabled
                    />
                    <input
                      className="od-settings-input"
                      type="password"
                      placeholder="Confirm new password"
                      disabled
                    />
                    <div className="od-settings-actions od-set-actions-end">
                      <button
                        type="button"
                        className="od-settings-btn-add"
                        disabled
                      >
                        Update Password
                      </button>
                    </div>
                  </div>
                </div>
                <div className="od-settings-card">
                  <CardTitle icon={ICON_LOCK2FA}>
                    Two-Factor Authentication
                  </CardTitle>
                  <div className="od-settings-empty">
                    Two-factor authentication requires an auth backend.
                  </div>
                </div>
                <div className="od-settings-note">
                  This orchestrator runs a single agent — account credentials,
                  password change, and 2FA light up once an auth backend is
                  connected. The name shown is the live agent identity.
                </div>
              </div>
            ) : null}

            {tab === "tools" ? (
              <div className="od-settings-section" role="tabpanel">
                <ToolsTab />
              </div>
            ) : null}

            {tab === "users" ? (
              <div className="od-settings-section" role="tabpanel">
                <UsersTab models={models} />
              </div>
            ) : null}

            {tab === "system" ? (
              <div className="od-settings-section" role="tabpanel">
                <SystemTab servers={servers} />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Rail button: icon + label, with the divider + admin-section header it
// closes rendered after it (odysseus settings-sidebar grouping). ──
function RailButton({
  item,
  active,
  onSelect,
}: {
  item: RailItem;
  active: boolean;
  onSelect: () => void;
}): ReactNode {
  return (
    <>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className={`od-settings-rail-item${active ? " active" : ""}`}
        onClick={onSelect}
      >
        <span className="od-settings-rail-ico">{item.icon}</span>
        <span>{item.label}</span>
      </button>
      {DIVIDER_AFTER.has(item.id) ? (
        <div className="od-settings-rail-divider" aria-hidden="true" />
      ) : null}
      {item.id === "account" ? (
        <div className="od-settings-rail-label">Admin</div>
      ) : null}
    </>
  );
}

// ── Collapsible Local/API endpoint add section (services tab). ──
function CollapsibleEndpoint({
  open,
  onToggle,
  icon,
  label,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  icon: ReactNode;
  label: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={`od-set-ep-section${open ? " open" : ""}`}>
      <button
        type="button"
        className="od-set-ep-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="od-set-ep-head-ico">{icon}</span>
        <span>{label}</span>
        <svg
          className="od-set-ep-caret"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* Right-pointing chevron when collapsed; CSS rotates it to point
              down (90deg) when the section is .open — matching odysseus's
              collapsible Local/API rows. */}
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {open ? children : null}
    </div>
  );
}

// ── AI Defaults card: faithful Endpoint/Model selectors, disabled (the eliza
// runtime owns the model map; no per-endpoint editor is exposed). ──
function AiCard({
  icon,
  title,
  faded,
  sub,
}: {
  icon: ReactNode;
  title: string;
  faded?: string;
  sub: string;
}): ReactNode {
  return (
    <div className="od-settings-card">
      <CardTitle icon={icon} faded={faded}>
        {title}
      </CardTitle>
      <Sub>{sub}</Sub>
      <div className="od-settings-row">
        <span className="od-settings-label">Endpoint</span>
        <select className="od-settings-select od-set-inline-select" disabled>
          <option>—</option>
        </select>
      </div>
      <div className="od-settings-row">
        <span className="od-settings-label">Model</span>
        <select className="od-settings-select od-set-inline-select" disabled>
          <option>—</option>
        </select>
      </div>
    </div>
  );
}

// ── Admin: Agent Tools tab (odysseus loadBuiltinTools). Catalogue chrome only;
// every toggle disabled until a /api/tools backend exists. ──
function ToolsTab(): ReactNode {
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(CATEGORY_ORDER),
  );

  const categories = useMemo(
    () =>
      CATEGORY_ORDER.map((cat) => ({
        cat,
        tools: TOOL_META.filter((t) => t.cat === cat),
      })).filter((g) => g.tools.length > 0),
    [],
  );

  const toggleCategory = (cat: string): void => {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  return (
    <>
      <div className="od-settings-card">
        <CardTitle icon={ICON_WRENCH}>Built-in Tools</CardTitle>
        <Sub>Enable or disable tools available to the AI agent.</Sub>
        <div className="od-set-tool-list">
          {categories.map(({ cat, tools }) => {
            const isOpen = !collapsed.has(cat);
            return (
              <div className="od-set-tool-cat" key={cat}>
                <button
                  type="button"
                  className="od-set-tool-cat-head"
                  aria-expanded={isOpen}
                  onClick={() => toggleCategory(cat)}
                >
                  <span>{cat}</span>
                  <span className="od-set-tool-cat-right">
                    <span className="od-set-tool-cat-count">
                      0/{tools.length}
                    </span>
                    <span className="od-set-tool-cat-chev" data-open={isOpen}>
                      ▾
                    </span>
                  </span>
                </button>
                {isOpen ? (
                  <div className="od-set-tool-cat-body">
                    {tools.map((t) => (
                      <div className="od-set-tool-row" key={t.id}>
                        <div className="od-set-tool-info">
                          <span className="od-set-tool-name">{t.name}</span>
                          <span className="od-set-tool-desc">{t.desc}</span>
                        </div>
                        <span
                          className="od-set-tool-ctx"
                          title="Approximate context tokens used"
                        >
                          {t.ctx}
                        </span>
                        <label className="od-set-switch">
                          <input type="checkbox" disabled />
                          <span className="od-set-slider" />
                        </label>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <div className="od-settings-note">
        The tool catalogue is the agent's real built-in tool surface, shown
        read-only — the eliza runtime exposes no tools-config API to this
        client, so each toggle is disabled until such a backend exists.
      </div>
    </>
  );
}

// ── Admin: Users tab (odysseus /api/auth/users). No multi-user auth backend in
// eliza — full chrome, honest empty/disabled state; the "Allowed models" list
// is the only real mapping (client.fetchModels). ──
function UsersTab({ models }: { models: ProviderModelRecord[] }): ReactNode {
  return (
    <>
      <div className="od-settings-card">
        <CardTitle icon={ICON_USERPLUS}>Registration</CardTitle>
        <div className="od-settings-row">
          <div>
            <div className="od-settings-value">Open signup</div>
            <Sub>Allow anyone to create an account from the login page</Sub>
          </div>
          <label className="od-set-switch" title="Requires an auth backend">
            <input type="checkbox" disabled />
            <span className="od-set-slider" />
          </label>
        </div>
      </div>
      <div className="od-settings-card">
        <CardTitle icon={ICON_USERS}>Users</CardTitle>
        <div className="od-settings-empty">No users found</div>
      </div>
      <div className="od-settings-card">
        <CardTitle icon={ICON_USERPLUS}>Add User</CardTitle>
        <div className="od-set-add-form">
          <input type="text" placeholder="Username (email)" disabled />
          <input type="password" placeholder="Password (min 8)" disabled />
          <label
            className="od-set-switch-inline"
            title="Grant full admin access"
          >
            <span className="od-set-switch">
              <input type="checkbox" disabled />
              <span className="od-set-slider" />
            </span>
            Admin
          </label>
        </div>
        <div className="od-settings-actions">
          <button type="button" className="od-settings-btn-add" disabled>
            Add User
          </button>
          <span className="od-settings-status warn">
            Auth backend not connected
          </span>
        </div>
      </div>
      <div className="od-settings-card">
        <CardTitle icon={ICON_SERVER}>Allowed Models</CardTitle>
        <Sub>
          Per-user model allow-lists bind here once an auth backend exists.
          These are the agent's real available models.
        </Sub>
        <div className="od-set-priv-models">
          {models.length === 0 ? (
            <span className="od-settings-empty">No models available</span>
          ) : (
            models.map((m) => (
              <label className="od-set-priv-model" key={m.id}>
                <input type="checkbox" disabled defaultChecked />
                <span>{m.name}</span>
              </label>
            ))
          )}
        </div>
      </div>
      <div className="od-settings-note">
        This orchestrator runs a single agent — multi-user management, signup
        control, and per-user privileges ({PRIV_LABELS.length} feature grants)
        light up once an auth backend is connected. No users are fabricated.
      </div>
    </>
  );
}

// ── Admin: System tab (odysseus Data Backup + Danger Zone). No backup/wipe API
// in eliza — full chrome, every control disabled with an honest reason. ──
function SystemTab({ servers }: { servers: McpServerStatus[] }): ReactNode {
  return (
    <>
      <div className="od-settings-card">
        <CardTitle icon={ICON_SERVER}>MCP Servers</CardTitle>
        {servers.length === 0 ? (
          <div className="od-settings-empty">No MCP servers configured.</div>
        ) : (
          servers.map((s) => (
            <div className="od-skill-item" key={s.name}>
              <div className="od-skill-info">
                <div className="od-skill-name">{s.name}</div>
                {s.error ? (
                  <div className="od-skill-desc">{s.error}</div>
                ) : null}
              </div>
              <span className={`od-skill-toggle${s.connected ? " on" : ""}`}>
                {s.connected ? "Up" : "Down"}
              </span>
            </div>
          ))
        )}
      </div>
      <div className="od-settings-card">
        <CardTitle icon={ICON_DATABASE}>Data Backup</CardTitle>
        <Sub>
          Export or import your user data (memories, presets, settings, skills,
          preferences) as a JSON file.
        </Sub>
        <div className="od-settings-actions">
          <button type="button" className="od-settings-btn-add" disabled>
            Export Data
          </button>
          <button type="button" className="od-settings-btn-add" disabled>
            Import Data
          </button>
        </div>
        <span className="od-settings-status warn">
          Backup endpoints not connected
        </span>
      </div>
      <div className="od-settings-card od-set-danger-card">
        <h2 className="od-set-card-title od-set-danger-title">Danger Zone</h2>
        <Sub>
          Irreversible. Each wipe targets one category — pick exactly what you
          want gone.
        </Sub>
        {WIPE_ROWS.map((row) => (
          <div className="od-set-wipe-row" key={row.kind}>
            <div>
              <div className="od-settings-value">{row.label}</div>
              <Sub>{row.sub}</Sub>
            </div>
            <button type="button" className="od-settings-btn-delete" disabled>
              Wipe
            </button>
          </div>
        ))}
      </div>
      <div className="od-settings-note">
        Data backup and category wipes are owned by the eliza runtime — no
        backup/wipe API is exposed to this client, so these controls are shown
        faithfully but inert. MCP server status above is read live.
      </div>
    </>
  );
}
