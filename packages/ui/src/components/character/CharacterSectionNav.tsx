import { FramedPageNavigation } from "../../layouts/framed-page";
import {
  navigateToSectionPath,
  normalizeSectionPath,
  type SectionTab,
  SectionTabStrip,
} from "../shared/SectionNav";
import { Separator } from "../ui/separator";

const CHARACTER_SECTION_GROUP = "character";

const CHARACTER_SECTION_TABS: readonly SectionTab[] = [
  { id: "character", label: "Personality", path: "/character" },
  {
    id: "relationships",
    label: "Relationships",
    path: "/apps/relationships",
  },
  { id: "character-skills", label: "Skills", path: "/character/skills" },
  { id: "experience", label: "Experience", path: "/character/experience" },
] as const;

function characterPathSet(): Set<string> {
  return new Set(CHARACTER_SECTION_TABS.map((tab) => tab.path));
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
 * The Character section strip. Renders for every `/character/*`
 * route and the Relationships alias; the shell mounts it in the workspace nav
 * slot (like `WalletSectionNav`) so the four sections read as one family.
 */
export function CharacterSectionNav({
  activePath,
}: {
  activePath: string;
}): React.JSX.Element {
  return (
    <>
      <FramedPageNavigation className="overflow-x-auto pt-4">
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
          className="px-0 py-0"
          tabClassName="max-[420px]:px-2 max-[360px]:px-1"
        />
      </FramedPageNavigation>
      <Separator tone="subtle45" />
    </>
  );
}
