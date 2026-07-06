/**
 * Declares and registers every built-in settings section into the
 * settings-section registry (`settings-section-registry.ts`), which SettingsView
 * reads to build its nav + render the active section. Section bodies are lazy
 * chunks (see the note below); metadata/order/grouping come from
 * `settings-section-meta.ts`. Also owns the tone/hue icon-class maps and the
 * `#settings/<section>` hash-routing helpers. Importing this module for its side
 * effect is what populates the registry, so it is imported once at app boot.
 */

import {
  Archive,
  Bot,
  Brain,
  Cloud,
  KeyRound,
  LayoutGrid,
  Lock,
  type LucideIcon,
  Mic,
  Palette,
  Puzzle,
  RefreshCw,
  Server,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  User,
  Wallet,
  Wallpaper,
  Webhook,
} from "lucide-react";
import { type ComponentType, type LazyExoticComponent, lazy } from "react";
import { registerCloudConnectorsSettingsSection } from "../../cloud/connectors";
import {
  CLOUD_SETTINGS_GROUP_ID,
  listExtraSettingsGroups,
  registerSettingsGroup,
} from "../../cloud/settings/cloud-settings-group";
import {
  SETTINGS_GROUP_LABEL,
  SETTINGS_GROUP_ORDER,
  SETTINGS_NON_CATALOG_SECTION_META,
  SETTINGS_SECTION_META,
  type SettingsSectionGroup,
} from "./settings-section-meta";
import {
  getAllSettingsSections,
  registerSettingsSection,
  type SettingsSectionDef,
  type SettingsSectionHue,
  type SettingsSectionTone,
} from "./settings-section-registry";

/**
 * Section bodies are lazy-loaded (#11351): the settings-section registry used to
 * pull ~15 section components (Identity, ProviderSwitcher, Connectors, Runtime,
 * Advanced, ReleaseCenter, …) into the eager boot graph through the
 * `@elizaos/ui/browser` barrel. `SettingsView` is already lazy, but the whole
 * registry rode along on the initial chunk. Wrapping each `Component` in
 * `React.lazy` moves those bodies onto their own on-demand chunks; the active
 * section's `<Component/>` render in `SettingsView` sits behind a `<Suspense>`
 * boundary so the split is transparent. Named exports are normalized to the
 * `default` shape `lazy()` expects.
 */
const IdentitySettingsSection = lazy(() =>
  import("./IdentitySettingsSection").then((m) => ({
    default: m.IdentitySettingsSection,
  })),
);
const ProviderSwitcher = lazy(() =>
  import("./ProviderSwitcher").then((m) => ({ default: m.ProviderSwitcher })),
);
const VoiceSectionMount = lazy(() =>
  import("./VoiceSectionMount").then((m) => ({ default: m.VoiceSectionMount })),
);
const CapabilitiesSection = lazy(() =>
  import("./CapabilitiesSection").then((m) => ({
    default: m.CapabilitiesSection,
  })),
);
const AppsManagementSection = lazy(() =>
  import("./AppsManagementSection").then((m) => ({
    default: m.AppsManagementSection,
  })),
);
const ConnectorsSection = lazy(() =>
  import("./ConnectorsSection").then((m) => ({ default: m.ConnectorsSection })),
);
const RuntimeSettingsSection = lazy(() =>
  import("./RuntimeSettingsSection").then((m) => ({
    default: m.RuntimeSettingsSection,
  })),
);
const AppearanceSettingsSection = lazy(() =>
  import("./AppearanceSettingsSection").then((m) => ({
    default: m.AppearanceSettingsSection,
  })),
);
const BackgroundSettingsSection = lazy(() =>
  import("./BackgroundSettingsSection").then((m) => ({
    default: m.BackgroundSettingsSection,
  })),
);
const RemotePluginHostSection = lazy(() =>
  import("./RemotePluginHostSection").then((m) => ({
    default: m.RemotePluginHostSection,
  })),
);
const WalletRpcSection = lazy(() =>
  import("./WalletRpcSection").then((m) => ({ default: m.WalletRpcSection })),
);
const ReleaseCenterView = lazy(() =>
  import("../pages/ReleaseCenterView").then((m) => ({
    default: m.ReleaseCenterView,
  })),
);
const AdvancedSection = lazy(() =>
  import("./AdvancedSection").then((m) => ({ default: m.AdvancedSection })),
);
const AppPermissionsSection = lazy(() =>
  import("./AppPermissionsSection").then((m) => ({
    default: m.AppPermissionsSection,
  })),
);
const PermissionsSection = lazy(() =>
  import("./PermissionsSection").then((m) => ({
    default: m.PermissionsSection,
  })),
);
const SecretsManagerSection = lazy(() =>
  import("./SecretsManagerSection").then((m) => ({
    default: m.SecretsManagerSection,
  })),
);
const SecuritySettingsSection = lazy(() =>
  import("./SecuritySettingsSection").then((m) => ({
    default: m.SecuritySettingsSection,
  })),
);
const CloudOverviewSection = lazy(() =>
  import("./CloudOverviewSection").then((m) => ({
    default: m.CloudOverviewSection,
  })),
);
const CloudAgentsSection = lazy(() =>
  import("./CloudAgentsSection").then((m) => ({
    default: m.CloudAgentsSection,
  })),
);
const MyRuntimesContainer = lazy(() =>
  import("../cockpit/MyRuntimesContainer").then((m) => ({
    default: m.MyRuntimesContainer,
  })),
);

export {
  getAllSettingsSections,
  getSettingsSection,
  listSettingsSections,
  registerSettingsSection,
} from "./settings-section-registry";
export type {
  SettingsSectionDef,
  SettingsSectionGroup,
  SettingsSectionHue,
  SettingsSectionTone,
};
export { SETTINGS_GROUP_LABEL, SETTINGS_GROUP_ORDER };

export const SECTION_TONE_ICON_CLASS: Record<SettingsSectionTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  muted: "text-muted",
  accent: "text-accent",
  neutral: "",
};

/**
 * Medallion styling per hue. All colors resolve from theme tokens (orange
 * accent + neutrals) so light and dark themes both work, and there is no blue.
 */
export const SECTION_HUE_MEDALLION_CLASS: Record<SettingsSectionHue, string> = {
  accent: "bg-accent/12 text-accent  ",
  amber: "bg-warn/12 text-warn  ",
  rose: "bg-[color-mix(in_oklab,var(--accent)_14%,var(--surface))] text-accent  ",
  slate: "bg-surface text-txt-strong  ",
};

/**
 * Canonical, per-id settings-section definition: a single declaration that
 * carries BOTH the pure-data catalog fields (id / label / group / aliases) AND
 * the React visuals (icon / tone / hue / component) for one section. Every
 * built-in section — catalog and non-catalog alike — is declared exactly once
 * in {@link BUILTIN_SECTION_DEFINITIONS}, which a single loop registers.
 *
 * Invariant: the catalog subset (`catalog !== false`) is the pure-data set that
 * app-core's `dev-route-catalog` parity test mirrors through
 * `SETTINGS_SECTION_META`; {@link assertMetaCatalogParity} enforces that those
 * definitions match META in id, order, label, group, and aliases (both
 * directions) at module load. `catalog: false` marks a section that registers
 * into Settings but stays out of that pinned QA catalog — the late-registered
 * Cloud group (`cloud-overview`, `cloud-agents`) and cockpit runtime registry
 * (`my-runtimes`).
 */
interface BuiltinSectionDefinition {
  /** Stable id — URL hash + agent-surface address. */
  id: string;
  /** English display label (the i18n default value). Must match META when catalog. */
  defaultLabel: string;
  /** Top-level group. Custom groups (e.g. Cloud) allowed for non-catalog sections. */
  group: SettingsSectionGroup | (string & {});
  /**
   * Extra friendly tokens for `/settings <token>`. For catalog sections this
   * must equal the declared META aliases (parity-checked); non-catalog sections
   * own their aliases here directly.
   */
  aliases?: readonly string[];
  icon: LucideIcon;
  tone: SettingsSectionTone;
  hue: SettingsSectionHue;
  /** i18n key for the nav label. */
  labelKey: string;
  /** i18n key for the section header, when it differs from the label. */
  titleKey?: string;
  /**
   * English fallback for the section header, when it differs from
   * {@link defaultLabel}. Used when the `titleKey` locale entry is absent. For
   * catalog sections the header falls back to the nav label, so this is only
   * needed for sections (e.g. the Cloud group) whose header text differs.
   */
  defaultTitle?: string;
  bodyClassName?: string;
  /** Hide unless Developer Mode is on. */
  developerOnly?: boolean;
  /** Hide on the cloud mobile build (no host machine). */
  hideOnCloud?: boolean;
  /**
   * Explicit sort order override. Catalog sections default to their META list
   * index; the late-registered Cloud/runtime sections declare fractional orders
   * that interleave with the built-in groups.
   */
  order?: number;
  /**
   * Whether this section is part of the pinned pure-data catalog mirrored by
   * app-core's `dev-route-catalog` test (`SETTINGS_SECTION_META`). `true` (the
   * default) = a built-in local section that MUST appear in META in the same
   * order/label/group. `false` = a section that registers into Settings but is
   * intentionally outside the QA catalog (Cloud group upsell/agents, cockpit
   * runtimes).
   */
  catalog?: boolean;
  Component: ComponentType | LazyExoticComponent<ComponentType>;
}

const NON_CATALOG_META_BY_ID = new Map(
  SETTINGS_NON_CATALOG_SECTION_META.map((meta) => [meta.id, meta]),
);

type NonCatalogSettingsSectionId =
  (typeof SETTINGS_NON_CATALOG_SECTION_META)[number]["id"];

function nonCatalogMeta(id: NonCatalogSettingsSectionId) {
  const meta = NON_CATALOG_META_BY_ID.get(id);
  if (!meta) {
    throw new Error(`Unknown non-catalog settings section "${id}"`);
  }
  return meta;
}

/**
 * The single source of truth for every built-in settings section's full
 * definition (catalog data + visuals + component). Order here is display order
 * within the resolved group ordering. Catalog sections (`catalog !== false`)
 * are parity-checked against `SETTINGS_SECTION_META`; non-catalog sections
 * (`catalog: false`) live in the Cloud group / cockpit runtime registry and
 * stay out of the pinned QA catalog.
 */
const BUILTIN_SECTION_DEFINITIONS: readonly BuiltinSectionDefinition[] = [
  {
    id: "identity",
    defaultLabel: "Basics",
    group: "agent",
    aliases: ["basics", "profile"],
    icon: User,
    tone: "neutral",
    hue: "slate",
    labelKey: "settings.sections.identity.label",
    Component: IdentitySettingsSection,
  },
  {
    id: "ai-model",
    defaultLabel: "Models & Providers",
    group: "agent",
    aliases: ["model", "models", "provider", "providers", "ai", "cloud"],
    icon: Brain,
    tone: "accent",
    hue: "accent",
    labelKey: "settings.sections.aimodel.label",
    Component: ProviderSwitcher,
  },
  {
    id: "voice",
    defaultLabel: "Voice",
    group: "agent",
    aliases: ["tts", "speech"],
    icon: Mic,
    tone: "accent",
    hue: "accent",
    labelKey: "settings.sections.voice.label",
    Component: VoiceSectionMount,
  },
  {
    id: "capabilities",
    defaultLabel: "Capabilities",
    group: "agent",
    aliases: ["abilities"],
    icon: SlidersHorizontal,
    tone: "accent",
    hue: "accent",
    labelKey: "settings.sections.capabilities.label",
    titleKey: "common.capabilities",
    Component: CapabilitiesSection,
  },
  {
    id: "apps",
    defaultLabel: "Apps",
    group: "agent",
    aliases: ["views"],
    icon: LayoutGrid,
    tone: "accent",
    hue: "accent",
    labelKey: "settings.sections.apps.label",
    Component: AppsManagementSection,
  },
  {
    id: "connectors",
    defaultLabel: "Connectors",
    group: "agent",
    aliases: ["connections", "integrations"],
    icon: Webhook,
    tone: "accent",
    hue: "accent",
    labelKey: "settings.sections.connectors.label",
    Component: ConnectorsSection,
  },
  // System group order mirrors SETTINGS_SECTION_META: personalization first
  // (appearance, background), then infrastructure (runtime, wallet, remote
  // plugins), then maintenance (updates, backups) last.
  {
    id: "appearance",
    defaultLabel: "Appearance",
    group: "system",
    aliases: ["theme", "look"],
    icon: Palette,
    tone: "neutral",
    hue: "rose",
    labelKey: "settings.sections.appearance.label",
    Component: AppearanceSettingsSection,
  },
  {
    id: "background",
    defaultLabel: "Background",
    group: "system",
    icon: Wallpaper,
    tone: "neutral",
    hue: "rose",
    labelKey: "settings.sections.background.label",
    // Chrome-light so the live wallpaper shows through while choices apply.
    Component: BackgroundSettingsSection,
  },
  {
    id: "runtime",
    defaultLabel: "Runtime",
    group: "system",
    icon: Server,
    tone: "neutral",
    hue: "slate",
    labelKey: "settings.sections.runtime.label",
    Component: RuntimeSettingsSection,
  },
  {
    id: "wallet-rpc",
    defaultLabel: "Wallet & RPC",
    group: "system",
    aliases: ["wallet", "rpc"],
    icon: Wallet,
    tone: "neutral",
    hue: "slate",
    labelKey: "settings.sections.walletrpc.label",
    bodyClassName: "p-4 sm:p-5",
    Component: WalletRpcSection,
  },
  {
    id: "remote-plugins",
    defaultLabel: "Remote Plugins",
    group: "system",
    aliases: ["remote"],
    icon: Puzzle,
    tone: "accent",
    hue: "rose",
    labelKey: "settings.sections.remote-plugins.label",
    developerOnly: true,
    Component: RemotePluginHostSection,
  },
  {
    id: "updates",
    defaultLabel: "Updates",
    group: "system",
    aliases: ["update"],
    icon: RefreshCw,
    tone: "neutral",
    hue: "slate",
    labelKey: "settings.sections.updates.label",
    Component: ReleaseCenterView,
  },
  {
    id: "advanced",
    defaultLabel: "Backups",
    group: "system",
    aliases: ["fine-tuning", "backup", "backups"],
    icon: Archive,
    tone: "neutral",
    hue: "slate",
    labelKey: "settings.sections.backupReset.label",
    Component: AdvancedSection,
  },
  // Security group order mirrors META: the everyday key store (Vault) first,
  // then the two permission surfaces, then the host-only remote-access section.
  {
    id: "secrets",
    defaultLabel: "Vault",
    group: "security",
    aliases: ["vault", "keys"],
    icon: KeyRound,
    tone: "warn",
    hue: "amber",
    labelKey: "settings.sections.secrets.label",
    Component: SecretsManagerSection,
  },
  {
    id: "permissions",
    defaultLabel: "Permissions",
    group: "security",
    aliases: ["perms"],
    icon: Shield,
    tone: "warn",
    hue: "amber",
    labelKey: "settings.sections.permissions.label",
    titleKey: "common.permissions",
    Component: PermissionsSection,
  },
  {
    id: "app-permissions",
    defaultLabel: "App Permissions",
    group: "security",
    icon: ShieldCheck,
    tone: "warn",
    hue: "amber",
    labelKey: "settings.sections.apppermissions.label",
    Component: AppPermissionsSection,
  },
  {
    id: "security",
    defaultLabel: "Security",
    group: "security",
    icon: Lock,
    tone: "warn",
    hue: "amber",
    labelKey: "settings.sections.security.label",
    // Host/self-host concept ("set a remote password so other machines can log
    // into your host"). Meaningless for a cloud mobile user — the cloud
    // "Sessions & Privacy" section covers real account security on cloud.
    hideOnCloud: true,
    Component: SecuritySettingsSection,
  },

  // ---------------------------------------------------------------------------
  // Non-catalog sections (`catalog: false`): declared in this one canonical list
  // + registered by the shared loop, but kept OUT of the pinned
  // `SETTINGS_SECTION_META` that app-core's dev-route-catalog test mirrors. They
  // live in the late-registered Cloud group / cockpit runtime registry, not the
  // built-in QA route catalog.
  // ---------------------------------------------------------------------------
  {
    ...nonCatalogMeta("cloud-overview"),
    catalog: false,
    icon: Cloud,
    tone: "accent",
    hue: "accent",
    labelKey: "settings.sections.cloudOverview.label",
    titleKey: "settings.sections.cloudOverview.title",
    defaultTitle: "Eliza Cloud",
    order: 1.45,
    Component: CloudOverviewSection,
  },
  // Eliza Cloud agent manager — surfaces in Settings (list / switch /
  // create+name / delete agents) under the local Cloud group with the upsell
  // overview, while full Cloud-only account/billing/API surfaces remain opt-in
  // through registerCloudSettingsSections().
  {
    ...nonCatalogMeta("cloud-agents"),
    catalog: false,
    icon: Bot,
    tone: "accent",
    hue: "accent",
    labelKey: "settings.sections.cloudAgents.label",
    titleKey: "settings.sections.cloudAgents.title",
    defaultTitle: "Eliza Cloud Agents",
    order: 1.55,
    Component: CloudAgentsSection,
  },
  // "My Runtimes" — manage + switch between local / cloud-dedicated /
  // VPS-remote runtimes (the cockpit's runtime registry).
  {
    ...nonCatalogMeta("my-runtimes"),
    catalog: false,
    icon: Server,
    tone: "neutral",
    hue: "slate",
    labelKey: "settings.sections.myRuntimes.label",
    titleKey: "settings.sections.myRuntimes.title",
    order: 3.5,
    Component: MyRuntimesContainer,
  },
] as const;

/** The default-title fallback: explicit `defaultTitle` if declared, else the label. */
function sectionDefaultTitle(def: BuiltinSectionDefinition): string {
  return def.defaultTitle ?? def.defaultLabel;
}

/** Project a canonical definition into the registry's `SettingsSectionDef`. */
function toSettingsSectionDef(
  def: BuiltinSectionDefinition,
  order: number,
): SettingsSectionDef {
  return {
    id: def.id,
    aliases: def.aliases,
    label: def.labelKey,
    defaultLabel: def.defaultLabel,
    icon: def.icon,
    tone: def.tone,
    hue: def.hue,
    group: def.group,
    titleKey: def.titleKey ?? def.labelKey,
    defaultTitle: sectionDefaultTitle(def),
    bodyClassName: def.bodyClassName,
    developerOnly: def.developerOnly,
    hideOnCloud: def.hideOnCloud,
    order: def.order ?? order,
    Component: def.Component,
  };
}

/** True when the definition is part of the pinned pure-data QA catalog. */
function isCatalogSection(def: BuiltinSectionDefinition): boolean {
  return def.catalog !== false;
}

/**
 * Two-way drift guard between the catalog subset of the merged per-id
 * definitions and the pinned pure-data `SETTINGS_SECTION_META` list that
 * app-core mirrors. A catalog section whose id / label / group / aliases /
 * order falls out of sync with META fails loudly at module load (and is
 * asserted by a focused test), so the two sources cannot silently diverge.
 */
export function assertMetaCatalogParity(): void {
  const catalogDefs = BUILTIN_SECTION_DEFINITIONS.filter(isCatalogSection);

  // Same set + same order as the pinned META list.
  const defIds = catalogDefs.map((d) => d.id);
  const metaIds = SETTINGS_SECTION_META.map((m) => m.id);
  if (defIds.length !== metaIds.length) {
    throw new Error(
      `settings-section catalog drift: ${defIds.length} catalog definition(s) ` +
        `vs ${metaIds.length} META entr(ies). Definitions: [${defIds.join(
          ", ",
        )}] META: [${metaIds.join(", ")}].`,
    );
  }
  for (let i = 0; i < metaIds.length; i += 1) {
    if (defIds[i] !== metaIds[i]) {
      throw new Error(
        `settings-section catalog drift at index ${i}: definition "${defIds[i]}" ` +
          `!= META "${metaIds[i]}". Catalog definitions must match ` +
          "SETTINGS_SECTION_META in id and order.",
      );
    }
  }

  // Per-id: label + group + aliases must agree with the pure-data META.
  const metaById = new Map(SETTINGS_SECTION_META.map((m) => [m.id, m]));
  for (const def of catalogDefs) {
    const meta = metaById.get(def.id);
    // Membership + order already validated above; this is the field parity.
    if (!meta) continue;
    if (def.defaultLabel !== meta.defaultLabel) {
      throw new Error(
        `settings-section "${def.id}" label drift: definition ` +
          `"${def.defaultLabel}" != META "${meta.defaultLabel}".`,
      );
    }
    if (def.group !== meta.group) {
      throw new Error(
        `settings-section "${def.id}" group drift: definition ` +
          `"${def.group}" != META "${meta.group}".`,
      );
    }
    const defAliases = [...(def.aliases ?? [])];
    const metaAliases = [...(meta.aliases ?? [])];
    const aliasesMatch =
      defAliases.length === metaAliases.length &&
      defAliases.every((a, idx) => a === metaAliases[idx]);
    if (!aliasesMatch) {
      throw new Error(
        `settings-section "${def.id}" alias drift: definition ` +
          `[${defAliases.join(", ")}] != META [${metaAliases.join(", ")}].`,
      );
    }
  }
}

assertMetaCatalogParity();

/**
 * The built-in local sections that are part of the pinned QA catalog, in
 * display order. Derived from the canonical definitions (catalog subset).
 * Retained as a named export for backward compatibility; runtime consumers read
 * the live registry via {@link getAllSettingsSections}.
 */
export const SETTINGS_SECTIONS: SettingsSectionDef[] =
  BUILTIN_SECTION_DEFINITIONS.filter(isCatalogSection).map((def, index) =>
    toSettingsSectionDef(def, index),
  );

// The Cloud group must exist before its member sections register into it.
registerSettingsGroup({
  id: CLOUD_SETTINGS_GROUP_ID,
  label: "Cloud",
  order: 1.5,
});

// One data-driven registration pass for every built-in section (catalog +
// non-catalog alike) — no per-section side calls. Catalog sections keep their
// META list index as the default order; non-catalog sections use their declared
// fractional order to interleave with the built-in groups.
let catalogIndex = 0;
for (const def of BUILTIN_SECTION_DEFINITIONS) {
  const order = isCatalogSection(def) ? catalogIndex++ : (def.order ?? 0);
  registerSettingsSection(toSettingsSectionDef(def, order));
}

registerCloudConnectorsSettingsSection();

export function settingsSectionLabel(
  section: SettingsSectionDef,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  return t(section.label, { defaultValue: section.defaultLabel });
}

/** One display group: a labelled bucket of sections in display order. */
export type GroupedSettingsSections = {
  group: string;
  label: string;
  items: SettingsSectionDef[];
}[];

/**
 * Group sections for display (shared by the Settings view header/nav and the
 * folded section-nav strip). Built-in groups keep their pinned order + labels;
 * any extra group a section declares (e.g. the `cloud` group) is interleaved by
 * its registered order with a registered label. A section whose group is
 * neither built-in nor registered falls into an "Other" bucket so it is never
 * dropped.
 */
export function groupSettingsSections(
  sections: SettingsSectionDef[],
): GroupedSettingsSections {
  const extra = listExtraSettingsGroups();
  const orderOf = new Map<string, number>();
  const labels = new Map<string, string>();
  SETTINGS_GROUP_ORDER.forEach((group, index) => {
    orderOf.set(group, index);
    labels.set(group, SETTINGS_GROUP_LABEL[group]);
  });
  for (const group of extra) {
    orderOf.set(group.id, group.order);
    labels.set(group.id, group.label);
  }

  const buckets = new Map<string, SettingsSectionDef[]>();
  for (const section of sections) {
    const bucket = buckets.get(section.group);
    if (bucket) bucket.push(section);
    else buckets.set(section.group, [section]);
  }

  const FALLBACK_ORDER = Number.MAX_SAFE_INTEGER;
  return [...buckets.entries()]
    .map(([group, items]) => ({
      group,
      label: labels.get(group) ?? "Other",
      items,
      order: orderOf.get(group) ?? FALLBACK_ORDER,
    }))
    .filter((entry) => entry.items.length > 0)
    .sort((a, b) => a.order - b.order)
    .map(({ group, label, items }) => ({ group, label, items }));
}

export function settingsSectionTitle(
  section: SettingsSectionDef,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  return t(section.titleKey, { defaultValue: section.defaultTitle });
}

/**
 * Legacy hash aliases → section ids. `#billing` / `#api-keys` are the hashes
 * older in-app links and bookmarks carry; the registered cloud sections use
 * `cloud-*` ids so they never collide with the built-in local sections.
 */
const SETTINGS_HASH_ALIASES: Readonly<Record<string, string>> = {
  cloud: "ai-model",
  providers: "ai-model",
  billing: "cloud-billing",
  "api-keys": "cloud-api-keys",
};

export function readSettingsHashSection(): string | null {
  if (typeof window === "undefined") return null;
  const rawHash = window.location.hash.replace(/^#/, "");
  if (!rawHash) return null;
  const hash = SETTINGS_HASH_ALIASES[rawHash] ?? rawHash;
  return getAllSettingsSections().some((section) => section.id === hash)
    ? hash
    : null;
}

export function replaceSettingsHash(sectionId: string): void {
  if (typeof window === "undefined") return;
  const nextHash = `#${sectionId}`;
  if (window.location.hash === nextHash) return;
  window.history.replaceState(null, "", nextHash);
}
