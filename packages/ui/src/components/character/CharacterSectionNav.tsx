/**
 * The Character family header: a centered "Character" `ViewHeader` (icon-only
 * launcher back) ABOVE a secondary section-tab strip that ties the four sibling
 * Character views into one group — Personality, Relationships, Skills,
 * Experience (#13591 / views-redesign epic #13560).
 *
 * Unlike Wallet's `SectionNav`, whose members are plugin-contributed app-shell
 * pages that join/leave at runtime, the Character family is a fixed host-owned
 * set, so the tabs are a static declaration fed to the shared presentational
 * `SectionTabStrip`. That keeps the doctrine geometry + ghost-tab styling
 * identical to Wallet/Settings while avoiding a registry round-trip (and the
 * route-hijack that registering these built-in routes as app-shell pages would
 * cause — their render path stays the App.tsx static-tab renderers).
 *
 * Knowledge is deliberately NOT a member: per epic #13560 doctrine it is a
 * standalone multimedia peer hub (#13594 folds Transcripts + Files into it),
 * reachable from the launcher, not owned as a Character sub-tab. It keeps its
 * own "Knowledge" header rather than rendering under this "Character" one.
 */

import {
  navigateToSectionPath,
  normalizeSectionPath,
  type SectionTab,
  SectionTabStrip,
} from "../shared/SectionNav";
import { ViewHeader } from "../shared/ViewHeader";

const CHARACTER_SECTION_GROUP = "character";

/**
 * The fixed Character family sections, in strip order. `aliases` list any legacy
 * `/character/*` deep-link that must still mark the tab active after the section
 * was promoted to a top-level route (Relationships lives at `/apps/relationships`
 * but kept its `/character/relationships` alias).
 */
const CHARACTER_SECTION_TABS: readonly SectionTab[] = [
  { id: "character", label: "Personality", path: "/character" },
  {
    id: "relationships",
    label: "Relationships",
    path: "/apps/relationships",
    aliases: ["/character/relationships"],
  },
  { id: "character-skills", label: "Skills", path: "/character/skills" },
  { id: "experience", label: "Experience", path: "/character/experience" },
] as const;

function characterPathSet(): Set<string> {
  return new Set(
    CHARACTER_SECTION_TABS.flatMap((tab) => [tab.path, ...(tab.aliases ?? [])]),
  );
}

/** True when a route belongs to the Character family (any of its four sections). */
export function isCharacterSectionPath(path: string): boolean {
  return characterPathSet().has(normalizeSectionPath(path));
}

function activeCharacterTabId(path: string): string {
  const normalized = normalizeSectionPath(path);
  const match = CHARACTER_SECTION_TABS.find(
    (tab) =>
      tab.path === normalized || (tab.aliases ?? []).includes(normalized),
  );
  return match?.id ?? CHARACTER_SECTION_TABS[0].id;
}

/**
 * The Character family header + section strip. Renders for every `/character/*`
 * route and the Relationships alias; the shell mounts it in the workspace nav
 * slot (like `WalletSectionNav`) so the four sections read as one family.
 */
export function CharacterSectionNav({
  activePath,
}: {
  activePath: string;
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 flex-col border-b border-border/45">
      <ViewHeader title="Character" />
      <SectionTabStrip
        entries={CHARACTER_SECTION_TABS}
        activeId={activeCharacterTabId(activePath)}
        onSelect={(id) => {
          const tab = CHARACTER_SECTION_TABS.find(
            (candidate) => candidate.id === id,
          );
          if (tab) navigateToSectionPath(tab.path);
        }}
        testId={`section-nav-${CHARACTER_SECTION_GROUP}`}
        ariaLabel="Character sections"
        className="pt-0"
      />
    </div>
  );
}
