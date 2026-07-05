/**
 * The Skills section of the Character family (#13591): the agent's learned/
 * curated skills, distinct from the installable skill catalog (the developer
 * "Skills" tool at /apps/skills). Renders a headerless body — the shared
 * `CharacterSectionNav` supplies the "Character" header + section strip in the
 * shell nav slot, so this view never renders its own top bar.
 */
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { CharacterLearnedSkillsSection } from "./CharacterLearnedSkillsSection";

export function CharacterSkillsView() {
  return (
    <ShellViewAgentSurface viewId="character-skills">
      <div className="custom-scrollbar mx-auto flex min-h-0 w-full min-w-0 max-w-6xl flex-1 flex-col gap-4 overflow-y-auto px-4 pb-32 pt-1 sm:px-5 lg:px-6">
        <CharacterLearnedSkillsSection showTitle={false} />
      </div>
    </ShellViewAgentSurface>
  );
}
