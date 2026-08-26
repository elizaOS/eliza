/**
 * The Skills section of the Character family (#13591): the agent's learned/
 * curated skills, distinct from developer-managed Agent Skills (the developer
 * "Skills" tool at /apps/skills). Renders a headerless body — the shared
 * `CharacterSectionNav` supplies the "Character" header + section strip in the
 * shell nav slot, so this view never renders its own top bar.
 */

import { FramedPage, FramedPageBody } from "../../layouts/framed-page";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { CharacterLearnedSkillsSection } from "./CharacterLearnedSkillsSection";

export function CharacterSkillsView() {
  return (
    <ShellViewAgentSurface viewId="character-skills">
      <FramedPage>
        <FramedPageBody className="gap-4 pt-1">
          <CharacterLearnedSkillsSection showTitle={false} />
        </FramedPageBody>
      </FramedPage>
    </ShellViewAgentSurface>
  );
}
