/**
 * Skill marketplace — search/install modal and marketplace result cards.
 *
 * Extracted from SkillsView.tsx to keep individual files under ~500 LOC.
 */
import type { SkillInfo, SkillMarketplaceResult } from "../../api";
import { useApp } from "../../state";
export declare function MarketplaceCard({
  item,
  installedSkill,
  skillsMarketplaceAction,
  onInstall,
  onUninstall,
  onEnable,
  onDisable,
  onCopy,
  onDetails,
}: {
  item: SkillMarketplaceResult;
  installedSkill: SkillInfo | null;
  skillsMarketplaceAction: string;
  onInstall: (item: SkillMarketplaceResult) => void;
  onUninstall: (skillId: string, name: string) => void;
  onEnable: (skillId: string, name: string) => void;
  onDisable: (skillId: string, name: string) => void;
  onCopy: (skillId: string, name: string) => void;
  onDetails: (skillId: string) => void;
}): import("react/jsx-runtime").JSX.Element;
export declare function InstallModal({
  skills,
  skillsMarketplaceQuery,
  skillsMarketplaceResults,
  skillsMarketplaceError,
  skillsMarketplaceLoading,
  skillsMarketplaceAction,
  skillsMarketplaceManualGithubUrl,
  searchSkillsMarketplace,
  installSkillFromMarketplace,
  uninstallMarketplaceSkill,
  installSkillFromGithubUrl,
  enableSkill,
  disableSkill,
  copySkillSource,
  showSkillDetails,
  setState,
  onClose,
}: {
  skills: SkillInfo[];
  skillsMarketplaceQuery: string;
  skillsMarketplaceResults: SkillMarketplaceResult[];
  skillsMarketplaceError: string;
  skillsMarketplaceLoading: boolean;
  skillsMarketplaceAction: string;
  skillsMarketplaceManualGithubUrl: string;
  searchSkillsMarketplace: () => Promise<void>;
  installSkillFromMarketplace: (item: SkillMarketplaceResult) => Promise<void>;
  uninstallMarketplaceSkill: (skillId: string, name: string) => Promise<void>;
  installSkillFromGithubUrl: () => Promise<void>;
  enableSkill: (skillId: string, name: string) => Promise<void>;
  disableSkill: (skillId: string, name: string) => Promise<void>;
  copySkillSource: (skillId: string, name: string) => Promise<void>;
  showSkillDetails: (skillId: string) => void;
  setState: ReturnType<typeof useApp>["setState"];
  onClose: () => void;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=skill-marketplace.d.ts.map
