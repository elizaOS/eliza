/**
 * Renders the character experience page for inspecting and editing agent
 * persona-facing fields.
 */
import { useCallback, useMemo, useState } from "react";
import { client } from "../../api/client";
import type { ExperienceRecord } from "../../api/client-types";
import { useFetchData } from "../../hooks/useFetchData";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { CharacterExperienceWorkspace } from "./CharacterExperienceWorkspace";
import { mapExperienceRecordToHubRecord } from "./character-hub-helpers";

/**
 * The Experience section of the Character family (#13591): the agent's learned
 * experiences, editable/deletable. Owns just the experiences fetch (not the
 * hub's other reads), so opening it never pulls data it doesn't render. Renders
 * a headerless body — the shared `CharacterSectionNav` supplies the "Character"
 * header + section strip in the shell nav slot.
 */
export function CharacterExperienceView() {
  const fetchState = useFetchData<ExperienceRecord[]>(async () => {
    const response = await client.listExperiences({ limit: 100 });
    return response.experiences;
  }, []);

  // Optimistic edits layer over the fetched list so save/delete reflect
  // immediately without a refetch; null means "use the server list as-is".
  const [edits, setEdits] = useState<ExperienceRecord[] | null>(null);
  const records =
    edits ?? (fetchState.status === "success" ? fetchState.data : []);
  const loading = fetchState.status === "loading" && edits === null;
  const error = fetchState.status === "error" ? fetchState.error.message : null;

  const [selectedExperienceId, setSelectedExperienceId] = useState<
    string | null
  >(null);
  const [savingExperienceId, setSavingExperienceId] = useState<string | null>(
    null,
  );
  const [deletingExperienceId, setDeletingExperienceId] = useState<
    string | null
  >(null);

  const hubRecords = useMemo(
    () => records.map(mapExperienceRecordToHubRecord),
    [records],
  );

  const handleSaveExperience = useCallback(
    async (
      experience: ExperienceRecord,
      draft: {
        learning: string;
        importance: number;
        confidence: number;
        tags: string;
      },
    ) => {
      setSavingExperienceId(experience.id);
      try {
        const response = await client.updateExperience(experience.id, {
          learning: draft.learning,
          importance: draft.importance,
          confidence: draft.confidence,
          tags: draft.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
        });
        setEdits(
          records.map((item) =>
            item.id === experience.id ? response.experience : item,
          ),
        );
      } finally {
        setSavingExperienceId(null);
      }
    },
    [records],
  );

  const handleDeleteExperience = useCallback(
    async (experience: ExperienceRecord) => {
      setDeletingExperienceId(experience.id);
      try {
        await client.deleteExperience(experience.id);
        setEdits(records.filter((item) => item.id !== experience.id));
        setSelectedExperienceId((current) =>
          current === experience.id ? null : current,
        );
      } finally {
        setDeletingExperienceId(null);
      }
    },
    [records],
  );

  return (
    <ShellViewAgentSurface viewId="experience">
      <div className="custom-scrollbar mx-auto flex min-h-0 w-full min-w-0 max-w-6xl flex-1 flex-col gap-4 overflow-y-auto px-4 pb-32 pt-1 sm:px-5 lg:px-6">
        {error ? (
          <div className="rounded-sm border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        ) : null}
        {loading ? (
          <div className="text-sm text-muted">Loading experiences…</div>
        ) : (
          <CharacterExperienceWorkspace
            showTitle={false}
            experiences={hubRecords}
            selectedExperienceId={selectedExperienceId}
            onSelectExperience={setSelectedExperienceId}
            onSaveExperience={(experience, draft) => {
              const source = records.find((item) => item.id === experience.id);
              if (!source) return;
              void handleSaveExperience(source, draft);
            }}
            onDeleteExperience={(experience) => {
              const source = records.find((item) => item.id === experience.id);
              if (!source) return;
              void handleDeleteExperience(source);
            }}
            savingExperienceId={savingExperienceId}
            deletingExperienceId={deletingExperienceId}
          />
        )}
      </div>
    </ShellViewAgentSurface>
  );
}
