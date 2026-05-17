import type {
  CharacterExperienceDraft,
  CharacterExperienceRecord,
} from "./character-hub-types";
export declare function CharacterExperienceWorkspace({
  experiences,
  selectedExperienceId,
  onSelectExperience,
  onSaveExperience,
  onDeleteExperience,
  savingExperienceId,
  deletingExperienceId,
}: {
  experiences: CharacterExperienceRecord[];
  selectedExperienceId: string | null;
  onSelectExperience: (experienceId: string) => void;
  onSaveExperience?: (
    experience: CharacterExperienceRecord,
    draft: CharacterExperienceDraft,
  ) => void;
  onDeleteExperience?: (experience: CharacterExperienceRecord) => void;
  savingExperienceId?: string | null;
  deletingExperienceId?: string | null;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=CharacterExperienceWorkspace.d.ts.map
