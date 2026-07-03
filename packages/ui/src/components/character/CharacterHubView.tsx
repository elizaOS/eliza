import type { MessageExampleGroup } from "@elizaos/core";
import { ChevronLeft } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api/client";
import type {
  CharacterData,
  DocumentRecord,
  ExperienceRecord,
} from "../../api/client-types";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { WorkspaceLayout } from "../../layouts/workspace-layout/workspace-layout";
import {
  getWindowNavigationPath,
  shouldUseHashNavigation,
} from "../../navigation";
import { useAppSelectorShallow } from "../../state";
// Direct sub-path import to avoid the widgets/index.ts ↔ WidgetHost.tsx
// chunk-level circular dependency.
import { WidgetHost } from "../../widgets/WidgetHost";
import { DocumentsView } from "../pages/DocumentsView";
import { RelationshipsWorkspaceView } from "../pages/relationships/RelationshipsWorkspaceView";
import { Button } from "../ui/button";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import {
  CharacterExamplesPanel,
  CharacterIdentityPanel,
  CharacterStylePanel,
} from "./CharacterEditorPanels";
import { CharacterExperienceWorkspace } from "./CharacterExperienceWorkspace";
import { CharacterLearnedSkillsSection } from "./CharacterLearnedSkillsSection";
import {
  CharacterOverviewSection,
  type CharacterOverviewWidget,
} from "./CharacterOverviewSection";
import {
  type CharacterHubSection,
  getCharacterHubSectionLabel,
  mapExperienceRecordToHubRecord,
} from "./character-hub-helpers";
import { useCharacterHubData } from "./useCharacterHubData";

type CharacterStyleSection = "all" | "chat" | "post";

const CHARACTER_SECTION_PATHS: Record<CharacterHubSection, string> = {
  overview: "/character",
  personality: "/character/personality",
  documents: "/character/documents",
  skills: "/character/skills",
  experience: "/character/experience",
  relationships: "/character/relationships",
};

function getSectionFromLocation(tab: string): CharacterHubSection {
  const pathname = getWindowNavigationPath().toLowerCase();
  if (pathname.endsWith("/personality")) return "personality";
  if (pathname.endsWith("/documents")) return "documents";
  if (pathname.endsWith("/skills")) return "skills";
  if (pathname.endsWith("/experience")) return "experience";
  if (pathname.endsWith("/relationships")) return "relationships";
  if (tab === "documents") return "documents";
  return "overview";
}

function updateCharacterSectionPath(
  section: CharacterHubSection,
  mode: "push" | "replace" = "push",
): void {
  if (typeof window === "undefined") return;
  const path = CHARACTER_SECTION_PATHS[section];
  if (!path || getWindowNavigationPath() === path) return;
  if (shouldUseHashNavigation()) {
    window.location.hash = path;
    return;
  }
  window.history[mode === "replace" ? "replaceState" : "pushState"](
    null,
    "",
    path,
  );
}

const DEFAULT_DOCUMENT_FILENAMES = new Set([
  "eliza-overview.txt",
  "eliza-history.txt",
  "eliza-cloud-basics.txt",
]);

function isDefaultDocumentRecord(document: DocumentRecord): boolean {
  const normalizedFilename = document.filename.trim().toLowerCase();
  return (
    document.source === "bundled" ||
    document.source === "character" ||
    document.provenance.kind === "bundled" ||
    document.provenance.kind === "character" ||
    DEFAULT_DOCUMENT_FILENAMES.has(normalizedFilename)
  );
}

function mergeCharacterPatch(
  base: CharacterData,
  patch: CharacterData,
): CharacterData {
  return {
    ...base,
    ...patch,
    style: patch.style ? { ...(base.style ?? {}), ...patch.style } : base.style,
  };
}

function latestTimestamp(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

export function CharacterHubView({
  initialSection,
  d,
  bioText,
  normalizedMessageExamples,
  pendingStyleEntries,
  styleEntryDrafts,
  handleFieldEdit,
  applyFieldEdit,
  handlePendingStyleEntryChange,
  applyStyleEdit,
  handleStyleEntryDraftChange,
  characterSaving,
  characterSaveSuccess,
  characterSaveError,
  hasPendingChanges,
  onSave,
}: {
  initialSection?: CharacterHubSection;
  d: CharacterData;
  bioText: string;
  normalizedMessageExamples: MessageExampleGroup[];
  pendingStyleEntries: Record<string, string>;
  styleEntryDrafts: Record<string, string[]>;
  handleFieldEdit: (field: string, value: unknown) => void;
  applyFieldEdit: (field: string, value: unknown) => void;
  handlePendingStyleEntryChange: (key: string, value: string) => void;
  applyStyleEdit: (key: CharacterStyleSection, value: string) => void;
  handleStyleEntryDraftChange: (
    key: string,
    index: number,
    value: string,
  ) => void;
  characterSaving: boolean;
  characterSaveSuccess: string | null;
  characterSaveError: string | null;
  hasPendingChanges: boolean;
  onSave: () => Promise<unknown>;
}) {
  useRenderGuard("CharacterHubView");
  const { setActionNotice, setTab, tab, t } = useAppSelectorShallow((s) => ({
    setActionNotice: s.setActionNotice,
    setTab: s.setTab,
    tab: s.tab,
    t: s.t,
  }));
  const [activeSection, setActiveSection] = useState<CharacterHubSection>(
    () => initialSection ?? getSectionFromLocation(tab),
  );
  const hubData = useCharacterHubData();
  const documentRecords = hubData.documents.data;
  const documentsLoading = hubData.documents.loading;
  const historyEntries = hubData.history.data;
  const historyLoading = hubData.history.loading;
  const relationshipActivity = hubData.relationshipActivity.data;
  const relationshipActivityLoading = hubData.relationshipActivity.loading;
  const relationshipActivityError = hubData.relationshipActivity.error
    ? hubData.relationshipActivity.error.message
    : null;
  const learnedSkills = hubData.learnedSkills.data;
  const learnedSkillsLoading = hubData.learnedSkills.loading;
  const experienceRecords = hubData.experiences.data;
  const experienceLoading = hubData.experiences.loading;
  const experienceError = hubData.experiences.error
    ? hubData.experiences.error.message
    : null;
  const setDocumentRecords = hubData.documents.mutate;
  const setExperienceRecords = hubData.experiences.mutate;
  const setDocumentRecordsRef = useRef(setDocumentRecords);
  setDocumentRecordsRef.current = setDocumentRecords;
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(
    null,
  );
  const [selectedExperienceId, setSelectedExperienceId] = useState<
    string | null
  >(null);
  const [savingExperienceId, setSavingExperienceId] = useState<string | null>(
    null,
  );
  const [deletingExperienceId, setDeletingExperienceId] = useState<
    string | null
  >(null);
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const autoSaveTimerRef = useRef<number | null>(null);
  const pendingAutoSavePatchRef = useRef<CharacterData>({});

  const flushPendingAutoSave = useCallback(async () => {
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    const patch = pendingAutoSavePatchRef.current;
    if (Object.keys(patch).length === 0) {
      return;
    }

    pendingAutoSavePatchRef.current = {};

    try {
      await client.updateCharacter(patch);
    } catch (error) {
      setActionNotice(
        error instanceof Error
          ? error.message
          : "Failed to autosave personality updates.",
        "error",
        5000,
      );
    }
  }, [setActionNotice]);

  const scheduleAutoSave = useCallback(
    (patch: CharacterData) => {
      pendingAutoSavePatchRef.current = mergeCharacterPatch(
        pendingAutoSavePatchRef.current,
        patch,
      );
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
      autoSaveTimerRef.current = window.setTimeout(() => {
        autoSaveTimerRef.current = null;
        void flushPendingAutoSave();
      }, 700);
    },
    [flushPendingAutoSave],
  );

  useEffect(() => {
    return () => {
      void flushPendingAutoSave();
    };
  }, [flushPendingAutoSave]);

  useEffect(() => {
    if (initialSection) {
      setActiveSection(initialSection);
      return;
    }
    setActiveSection(getSectionFromLocation(tab));
  }, [initialSection, tab]);

  useEffect(() => {
    if (initialSection) return;
    const syncSectionFromLocation = () => {
      setActiveSection(getSectionFromLocation(tab));
    };
    window.addEventListener("popstate", syncSectionFromLocation);
    window.addEventListener("hashchange", syncSectionFromLocation);
    return () => {
      window.removeEventListener("popstate", syncSectionFromLocation);
      window.removeEventListener("hashchange", syncSectionFromLocation);
    };
  }, [initialSection, tab]);

  // Seed `selectedExperienceId` / `selectedDocumentId` from the first loaded
  // record once data lands. The hook owns the fetch; this just mirrors the
  // pre-refactor "first record wins" default.
  useEffect(() => {
    if (experienceRecords.length === 0) return;
    setSelectedExperienceId(
      (current) => current ?? experienceRecords[0]?.id ?? null,
    );
  }, [experienceRecords]);

  useEffect(() => {
    if (documentRecords.length === 0) return;
    setSelectedDocumentId(
      (current) => current ?? documentRecords[0]?.id ?? null,
    );
  }, [documentRecords]);

  const customDocumentRecords = useMemo(
    () =>
      documentRecords.filter((document) => !isDefaultDocumentRecord(document)),
    [documentRecords],
  );

  // Stable identity: DocumentsView's loadData effect depends on this callback,
  // so an inline closure would re-trigger fetch → setState → render → new
  // closure, looping the hub (render-guard trips on /character/documents).
  // `setDocumentRecords` is the hook's mutate fn — it flips state to
  // "success" so the loading flag derived from it also goes false.
  const handleDocumentsChange = useCallback((docs: DocumentRecord[]) => {
    setDocumentRecordsRef.current(docs);
  }, []);

  const overviewWidgets = useMemo<CharacterOverviewWidget[]>(() => {
    const styleItems = Object.values(d.style ?? {}).reduce(
      (count, values) => count + (Array.isArray(values) ? values.length : 0),
      0,
    );
    const exampleCount = normalizedMessageExamples.length;
    const activeSkills = learnedSkills.filter(
      (skill) => skill.status !== "disabled",
    );
    const recentExperience = [...experienceRecords].sort(
      (left, right) =>
        latestTimestamp(right.updatedAt ?? right.createdAt) -
        latestTimestamp(left.updatedAt ?? left.createdAt),
    )[0];
    // Unique people the agent knows (drop edge-only "relationship" rows).
    const peopleNames = Array.from(
      new Set(
        relationshipActivity
          .filter((item) => item.type !== "relationship")
          .map((item) => item.personName?.trim())
          .filter((name): name is string => Boolean(name)),
      ),
    );

    const trimmedBio = bioText.trim();
    const personalityHasContent =
      historyEntries.length > 0 ||
      trimmedBio.length > 0 ||
      styleItems > 0 ||
      exampleCount > 0;

    /**
     * Empty-state CTA shown inside a tile. The tile itself is the button that
     * navigates to the section where the real action lives, so this reads as the
     * concrete next step rather than a dead placeholder line.
     */
    function EmptyCta({ children }: { children: ReactNode }) {
      return (
        <span className="text-xs font-medium text-accent">{children}</span>
      );
    }

    const personalityStats = [
      styleItems > 0
        ? `${styleItems} style rule${styleItems === 1 ? "" : "s"}`
        : null,
      exampleCount > 0
        ? `${exampleCount} example${exampleCount === 1 ? "" : "s"}`
        : null,
      styleItems === 0 && exampleCount === 0 && trimmedBio ? "bio set" : null,
    ].filter(Boolean);

    const personalityBody: ReactNode = personalityHasContent ? (
      <span className="text-xs font-medium text-muted">
        {personalityStats.join(" · ")}
      </span>
    ) : (
      <EmptyCta>Define your voice</EmptyCta>
    );

    const relationshipsBody: ReactNode =
      peopleNames.length > 0 ? (
        <span className="text-xs font-medium text-txt">
          {peopleNames.slice(0, 4).join(" · ")}
          {peopleNames.length > 4 ? ` · +${peopleNames.length - 4}` : ""}
        </span>
      ) : (
        <EmptyCta>Introduce someone in chat</EmptyCta>
      );

    const skillsBody: ReactNode =
      activeSkills.length > 0 ? (
        <span className="text-xs font-medium text-muted">
          {activeSkills
            .slice(0, 4)
            .map((skill) => skill.name)
            .join(" · ")}
          {activeSkills.length > 4 ? ` · +${activeSkills.length - 4}` : ""}
        </span>
      ) : (
        <EmptyCta>Browse skills</EmptyCta>
      );

    return [
      {
        section: "personality",
        title: "Personality",
        body: personalityBody,
        isLoading: historyLoading && !personalityHasContent,
        isEmpty: !personalityHasContent,
      },
      {
        section: "relationships",
        title: "Relationships",
        body: relationshipsBody,
        isLoading: relationshipActivityLoading && peopleNames.length === 0,
        isEmpty: peopleNames.length === 0,
      },
      {
        section: "documents",
        title: "Knowledge",
        body:
          customDocumentRecords.length > 0 ? (
            <span className="text-xs text-muted">
              {customDocumentRecords.length} custom document
              {customDocumentRecords.length === 1 ? "" : "s"}
            </span>
          ) : (
            <EmptyCta>Upload your first document</EmptyCta>
          ),
        isLoading: documentsLoading && documentRecords.length === 0,
        isEmpty: customDocumentRecords.length === 0,
      },
      {
        section: "skills",
        title: "Skills",
        body: skillsBody,
        isLoading: learnedSkillsLoading && activeSkills.length === 0,
        isEmpty: activeSkills.length === 0,
      },
      {
        section: "experience",
        title: "Experience",
        body: recentExperience ? (
          <span className="line-clamp-2 text-xs italic text-muted">
            {recentExperience.learning ||
              recentExperience.result ||
              recentExperience.context ||
              recentExperience.type}
          </span>
        ) : (
          <EmptyCta>Teach Eliza in chat</EmptyCta>
        ),
        isLoading: experienceLoading && experienceRecords.length === 0,
        isEmpty: experienceRecords.length === 0,
      },
    ];
  }, [
    bioText,
    customDocumentRecords,
    d.style,
    experienceLoading,
    experienceRecords,
    historyEntries.length,
    historyLoading,
    documentRecords.length,
    documentsLoading,
    learnedSkills,
    learnedSkillsLoading,
    normalizedMessageExamples.length,
    relationshipActivity,
    relationshipActivityLoading,
  ]);

  const hubExperienceRecords = useMemo(
    () => experienceRecords.map(mapExperienceRecordToHubRecord),
    [experienceRecords],
  );

  const activeSectionLabel = getCharacterHubSectionLabel(activeSection);

  const navigateToSection = useCallback(
    (section: CharacterHubSection) => {
      setActiveSection(section);
      if (initialSection) return;
      if (section === "documents") {
        if (tab !== "documents") {
          setTab("documents");
        } else {
          updateCharacterSectionPath(section);
        }
        return;
      }
      updateCharacterSectionPath(section);
    },
    [initialSection, setTab, tab],
  );

  const handleOverviewOpenSection = (
    section: CharacterOverviewWidget["section"],
  ) => {
    navigateToSection(section);
  };

  const handleSaveExperience = async (
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
      setExperienceRecords((current) =>
        current.map((item) =>
          item.id === experience.id ? response.experience : item,
        ),
      );
    } finally {
      setSavingExperienceId(null);
    }
  };

  const handleDeleteExperience = async (experience: ExperienceRecord) => {
    setDeletingExperienceId(experience.id);
    try {
      await client.deleteExperience(experience.id);
      setExperienceRecords((current) =>
        current.filter((item) => item.id !== experience.id),
      );
      setSelectedExperienceId((current) =>
        current === experience.id ? null : current,
      );
    } finally {
      setDeletingExperienceId(null);
    }
  };

  const handleAutoSavedExamplesEdit = useCallback(
    (field: string, value: unknown) => {
      applyFieldEdit(field, value);
      if (field === "messageExamples" || field === "postExamples") {
        scheduleAutoSave({ [field]: value } as CharacterData);
      }
    },
    [applyFieldEdit, scheduleAutoSave],
  );

  const buildStylePatch = useCallback(
    (key: CharacterStyleSection, items: string[]): CharacterData => ({
      style: {
        ...(d.style ?? {}),
        [key]: items,
      },
    }),
    [d.style],
  );

  const handleAutoAddStyleEntry = useCallback(
    (key: string) => {
      const styleKey = key as CharacterStyleSection;
      const value = pendingStyleEntries[key]?.trim();
      if (!value) return;
      const currentItems = [...(d.style?.[styleKey] ?? [])];
      const nextItems = currentItems.includes(value)
        ? currentItems
        : [...currentItems, value];
      applyStyleEdit(styleKey, nextItems.join("\n"));
      handlePendingStyleEntryChange(key, "");
      scheduleAutoSave(buildStylePatch(styleKey, nextItems));
    },
    [
      applyStyleEdit,
      buildStylePatch,
      d.style,
      handlePendingStyleEntryChange,
      pendingStyleEntries,
      scheduleAutoSave,
    ],
  );

  const handleAutoRemoveStyleEntry = useCallback(
    (key: string, index: number) => {
      const styleKey = key as CharacterStyleSection;
      const nextItems = [...(d.style?.[styleKey] ?? [])];
      nextItems.splice(index, 1);
      applyStyleEdit(styleKey, nextItems.join("\n"));
      scheduleAutoSave(buildStylePatch(styleKey, nextItems));
    },
    [applyStyleEdit, buildStylePatch, d.style, scheduleAutoSave],
  );

  const handleAutoCommitStyleEntry = useCallback(
    (key: string, index: number) => {
      const styleKey = key as CharacterStyleSection;
      const nextValue = styleEntryDrafts[key]?.[index]?.trim() ?? "";
      const nextItems = [...(d.style?.[styleKey] ?? [])];
      if (!nextValue) {
        nextItems.splice(index, 1);
      } else {
        nextItems[index] = nextValue;
      }
      applyStyleEdit(styleKey, nextItems.join("\n"));
      scheduleAutoSave(buildStylePatch(styleKey, nextItems));
    },
    [
      applyStyleEdit,
      buildStylePatch,
      d.style,
      scheduleAutoSave,
      styleEntryDrafts,
    ],
  );

  const handleAutoReorderStyleEntries = useCallback(
    (key: string, items: string[]) => {
      const styleKey = key as CharacterStyleSection;
      applyStyleEdit(styleKey, items.join("\n"));
      scheduleAutoSave(buildStylePatch(styleKey, items));
    },
    [applyStyleEdit, buildStylePatch, scheduleAutoSave],
  );

  const handleManualSave = useCallback(async () => {
    await flushPendingAutoSave();
    try {
      await onSave();
    } catch {
      // handleSaveCharacter already populates the visible error state
    }
  }, [flushPendingAutoSave, onSave]);

  const renderSection = (): ReactNode => {
    if (activeSection === "overview") {
      return (
        <CharacterOverviewSection
          widgets={overviewWidgets}
          onOpenSection={handleOverviewOpenSection}
        />
      );
    }

    if (activeSection === "personality") {
      return (
        <div className="flex min-w-0 flex-col gap-6">
          <section>
            <CharacterIdentityPanel
              bioText={bioText}
              handleFieldEdit={handleFieldEdit}
              t={t}
            />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 pt-4">
              <div className="flex flex-col gap-1">
                {characterSaveSuccess ? (
                  <span className="rounded-sm border border-status-success/20 bg-status-success-bg px-2 py-1 text-2xs font-semibold text-status-success">
                    {characterSaveSuccess}
                  </span>
                ) : null}
                {characterSaveError ? (
                  <span className="rounded-sm border border-status-danger/20 bg-status-danger-bg px-2 py-1 text-2xs font-medium text-status-danger">
                    {characterSaveError}
                  </span>
                ) : null}
              </div>
              <Button
                type="button"
                className="h-9 rounded-sm px-4 text-sm font-semibold tracking-[0.02em]"
                disabled={characterSaving || !hasPendingChanges}
                onClick={() => {
                  void handleManualSave();
                }}
              >
                {characterSaving
                  ? t("charactereditor.Saving", { defaultValue: "saving..." })
                  : t("common.save", { defaultValue: "Save" })}
              </Button>
            </div>
          </section>

          <CharacterStylePanel
            d={d}
            pendingStyleEntries={pendingStyleEntries}
            styleEntryDrafts={styleEntryDrafts}
            handlePendingStyleEntryChange={handlePendingStyleEntryChange}
            handleAddStyleEntry={handleAutoAddStyleEntry}
            handleRemoveStyleEntry={handleAutoRemoveStyleEntry}
            handleStyleEntryDraftChange={handleStyleEntryDraftChange}
            handleCommitStyleEntry={handleAutoCommitStyleEntry}
            handleReorderStyleEntries={handleAutoReorderStyleEntries}
            t={t}
          />

          <section>
            <CharacterExamplesPanel
              d={d}
              normalizedMessageExamples={normalizedMessageExamples}
              handleFieldEdit={handleAutoSavedExamplesEdit}
              t={t}
            />
          </section>
        </div>
      );
    }

    if (activeSection === "documents") {
      return (
        <ShellViewAgentSurface viewId="documents">
          <DocumentsView
            embedded
            fileInputId="character-hub-documents-upload"
            onDocumentsChange={handleDocumentsChange}
            onSelectedDocumentIdChange={setSelectedDocumentId}
            selectedDocumentId={selectedDocumentId}
            showSelectorRail={false}
          />
        </ShellViewAgentSurface>
      );
    }

    if (activeSection === "skills") {
      return <CharacterLearnedSkillsSection />;
    }

    if (activeSection === "experience") {
      return (
        <div className="flex min-w-0 flex-col gap-4">
          {experienceError ? (
            <div className="rounded-sm border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
              {experienceError}
            </div>
          ) : null}
          {experienceLoading ? (
            <div className="text-sm text-muted">Loading experiences…</div>
          ) : (
            <CharacterExperienceWorkspace
              experiences={hubExperienceRecords}
              selectedExperienceId={selectedExperienceId}
              onSelectExperience={setSelectedExperienceId}
              onSaveExperience={(experience, draft) => {
                const source = experienceRecords.find(
                  (item) => item.id === experience.id,
                );
                if (!source) return;
                void handleSaveExperience(source, draft);
              }}
              onDeleteExperience={(experience) => {
                const source = experienceRecords.find(
                  (item) => item.id === experience.id,
                );
                if (!source) return;
                void handleDeleteExperience(source);
              }}
              savingExperienceId={savingExperienceId}
              deletingExperienceId={deletingExperienceId}
            />
          )}
        </div>
      );
    }

    return (
      <section className="flex min-w-0 flex-col gap-3">
        {relationshipActivityError ? (
          <div className="border-b border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
            {relationshipActivityError}
          </div>
        ) : null}
        <div className="min-h-[40rem]">
          <RelationshipsWorkspaceView
            embedded
            onViewMemories={() => {
              setTab("memories");
            }}
          />
        </div>
      </section>
    );
  };

  const isSubPage = activeSection !== "overview";

  return (
    <WorkspaceLayout
      className="h-full"
      contentPadding={false}
      contentInnerClassName="flex w-full min-h-0 flex-1 flex-col px-4 py-4 sm:px-5 sm:py-5 lg:px-6"
      data-testid="character-editor-view"
    >
      <div
        ref={contentScrollRef}
        className="custom-scrollbar mx-auto flex min-h-0 w-full min-w-0 max-w-6xl flex-1 flex-col overflow-y-auto overflow-x-hidden pb-32"
      >
        <WidgetHost slot="character" className="mb-4" />
        {isSubPage ? (
          <div className="mb-5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigateToSection("overview")}
              className="inline-flex min-h-11 items-center gap-1 rounded-sm px-2 text-sm text-muted transition-colors hover:text-txt"
              aria-label="Back to Character hub"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              Character
            </button>
            <span className="text-lg font-semibold text-txt">
              {activeSectionLabel}
            </span>
          </div>
        ) : null}
        {renderSection()}
      </div>
    </WorkspaceLayout>
  );
}
