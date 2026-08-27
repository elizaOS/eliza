/**
 * The Skills section of the Character family (#13591): the agent's learned/
 * curated skills, distinct from developer-managed Agent Skills (the developer
 * "Skills" tool at /apps/skills). The host supplies Character-family chrome as
 * part of this view's framed page, so this view never renders a second top bar.
 */

import type { ReactNode } from "react";
import { FramedPage, FramedPageBody } from "../../layouts/framed-page";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { CharacterLearnedSkillsSection } from "./CharacterLearnedSkillsSection";

export function CharacterSkillsView({
  pageChrome,
}: {
  pageChrome?: ReactNode;
}) {
  return (
    <ShellViewAgentSurface viewId="character-skills">
      <FramedPage>
        {pageChrome}
        <FramedPageBody
          padded={false}
          className="gap-4 pt-1 [@media(min-width:768px)_and_(min-height:600px)]:px-6 lg:px-8"
        >
          <CharacterLearnedSkillsSection showTitle={false} />
        </FramedPageBody>
      </FramedPage>
    </ShellViewAgentSurface>
  );
}
