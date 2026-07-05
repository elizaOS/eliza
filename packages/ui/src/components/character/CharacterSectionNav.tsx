/**
 * Character section navigation (#13591).
 *
 * The Personality editor used to be one endless scroll — About, Style Rules,
 * Chat Examples, and Post Examples stacked in a single column. The redesign
 * doctrine (#13451/#13586/#13452) folds that into a single top-bar section nav
 * BENEATH the shared `ViewHeader`, the same Wallet/Settings pattern: one strip +
 * one detail region for every form factor, no bespoke rail.
 *
 * Like Settings (`SettingsSectionNav`), Character's personality sections are NOT
 * an app-shell-page family — About/Style/Chat/Post are sub-sections of one view,
 * not launchable destinations, so they cannot drive the registry-bound
 * `SectionNav` (which reads `listAppShellPages()`). To avoid a parallel tab
 * renderer this reuses the SAME presentational primitive the app-shell family
 * uses — `SectionTabStrip` — for the doctrine ghost-tab geometry + styling; it
 * only supplies the ordered section entries + path routing.
 *
 * Each section owns a `/character/*` route so deep-links resolve and the strip
 * marks the active tab from the path. All four routes resolve to the built-in
 * `character` tab (the `/character/` prefix fallback in `navigation`), so the
 * shell keeps the one Character view mounted while the section switches.
 */

import { SectionTabStrip } from "../shared/SectionNav";
import { ViewHeader } from "../shared/ViewHeader";

/** The ordered personality sections. `path` is the deep-link each tab owns. */
export const CHARACTER_PERSONALITY_SECTIONS = [
  {
    id: "about",
    labelKey: "charactereditor.TabAbout",
    defaultLabel: "About",
    path: "/character",
  },
  {
    id: "style",
    labelKey: "charactereditor.TabStyleRules",
    defaultLabel: "Style Rules",
    path: "/character/style",
  },
  {
    id: "chat-examples",
    labelKey: "charactereditor.TabChatExamples",
    defaultLabel: "Chat Examples",
    path: "/character/chat-examples",
  },
  {
    id: "post-examples",
    labelKey: "charactereditor.TabPostExamples",
    defaultLabel: "Post Examples",
    path: "/character/post-examples",
  },
] as const;

export type CharacterPersonalitySection =
  (typeof CHARACTER_PERSONALITY_SECTIONS)[number]["id"];

/** Path each section owns, keyed by section id. */
export const CHARACTER_SECTION_PATHS: Record<
  CharacterPersonalitySection,
  string
> = Object.fromEntries(
  CHARACTER_PERSONALITY_SECTIONS.map((section) => [section.id, section.path]),
) as Record<CharacterPersonalitySection, string>;

function normalizePath(path: string): string {
  const trimmed = (path || "/").split(/[?#]/, 1)[0].toLowerCase();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 && withSlash.endsWith("/")
    ? withSlash.slice(0, -1)
    : withSlash;
}

/**
 * The personality section a `/character/*` path selects. `/character` and any
 * unrecognized `/character/<sub>` (the promoted-view aliases live at their own
 * top-level tabs, never here) fall back to `about` — the section this view owns.
 */
export function characterSectionFromPath(
  path: string,
): CharacterPersonalitySection {
  const normalized = normalizePath(path);
  const match = CHARACTER_PERSONALITY_SECTIONS.find(
    (section) => normalizePath(section.path) === normalized,
  );
  return match?.id ?? "about";
}

/** True when a route is one of the personality section tabs. */
export function isCharacterSectionPath(path: string): boolean {
  const normalized = normalizePath(path);
  return CHARACTER_PERSONALITY_SECTIONS.some(
    (section) => normalizePath(section.path) === normalized,
  );
}

/**
 * The Character family header: a centered "Character" `ViewHeader` (icon-only
 * launcher back) ABOVE the personality section strip. `right` carries the
 * autosave status indicator the caller renders into the header's trailing slot.
 */
export function CharacterSectionNav({
  activeSection,
  onSelect,
  t,
  right,
}: {
  activeSection: CharacterPersonalitySection;
  onSelect: (section: CharacterPersonalitySection) => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
  right?: React.ReactNode;
}): React.JSX.Element {
  const entries = CHARACTER_PERSONALITY_SECTIONS.map((section) => ({
    id: section.id,
    label: t(section.labelKey, { defaultValue: section.defaultLabel }),
  }));
  return (
    <div className="flex shrink-0 flex-col border-b border-border/45">
      <ViewHeader
        title={t("nav.character", { defaultValue: "Character" })}
        right={right}
      />
      <SectionTabStrip
        entries={entries}
        activeId={activeSection}
        onSelect={(id) => onSelect(id as CharacterPersonalitySection)}
        testId="section-nav-character"
        ariaLabel={t("charactereditor.SectionNavLabel", {
          defaultValue: "Character sections",
        })}
        className="pt-0"
      />
    </div>
  );
}
