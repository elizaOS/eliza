import type { ReactNode } from "react";
import type { CharacterHubSection } from "./character-hub-helpers";

type OverviewSection = Exclude<CharacterHubSection, "overview">;
export interface CharacterOverviewWidget {
  /** Section the widget links to. */
  section: OverviewSection;
  /** Header title. */
  title: string;
  /** Optional small text on the right side of the header. */
  meta?: string | null;
  /**
   * Content rendered in the widget body. Should always be present so the widget
   * shows useful copy even when there is no real data yet.
   */
  body?: ReactNode | null;
  /** True while the widget's data source is fetching for the first time. */
  isLoading?: boolean;
  /** True when no real content exists; widget still renders with hint copy. */
  isEmpty: boolean;
}
export declare function CharacterOverviewSection({
  onOpenSection,
  widgets,
}: {
  characterName?: string | null;
  onOpenSection: (section: OverviewSection) => void;
  widgets: CharacterOverviewWidget[];
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=CharacterOverviewSection.d.ts.map
