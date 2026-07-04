/**
 * Renders the character skills page that lists capability and skill
 * configuration for an agent profile.
 */
import { ViewHeader } from "../shared/ViewHeader";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { CharacterLearnedSkillsSection } from "./CharacterLearnedSkillsSection";

/**
 * Skills — a top-level view (promoted out of the old Character hub). Shows the
 * skills the agent has learned/curated from its trajectories. Distinct from the
 * installable skill catalog (the developer "Skills" tool at /apps/skills).
 */
export function CharacterSkillsView() {
  return (
    <ShellViewAgentSurface viewId="character-skills">
      <div className="flex h-full min-h-0 w-full flex-col">
        <ViewHeader title="Skills" />
        <div className="custom-scrollbar mx-auto flex min-h-0 w-full min-w-0 max-w-6xl flex-1 flex-col gap-4 overflow-y-auto px-4 pb-32 pt-1 sm:px-5 lg:px-6">
          <CharacterLearnedSkillsSection showTitle={false} />
        </div>
      </div>
    </ShellViewAgentSurface>
  );
}
