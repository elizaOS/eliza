import type { MessageExampleGroup } from "@elizaos/core";
import {
  Button,
  PageLayout,
  SidebarContent,
  SidebarPanel,
  SidebarScrollRegion,
} from "@elizaos/ui";
import {
  BookOpen,
  Brain,
  LayoutDashboard,
  type LucideIcon,
  Network,
  PencilLine,
  Sparkles,
} from "lucide-react";
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
  CharacterHistoryEntry,
  ExperienceRecord,
  KnowledgeDocument,
  RelationshipsActivityItem,
} from "../../api/client-types";
import { useApp } from "../../state/useApp";
import { WidgetHost } from "../../widgets";
import { KnowledgeView } from "../pages/KnowledgeView";
import { RelationshipsWorkspaceView } from "../pages/relationships/RelationshipsWorkspaceView";
import { AppPageSidebar } from "../shared/AppPageSidebar";
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
import { CharacterPersonalityTimeline } from "./CharacterPersonalityTimeline";
import { CharacterRelationshipsSection } from "./CharacterRelationshipsSection";
import {
  CHARACTER_HUB_SECTIONS,
  type CharacterHubSection,
  getCharacterHubSectionLabel,
  mapExperienceRecordToHubRecord,
  mapHistoryEntryToTimelineItem,
} from "./character-hub-helpers";

type CharacterStyleSection = "all" | "chat" | "post";

type LearnedSkillSummary = {
  description?: string | null;
  name: string;
  source?: string | null;
  status?: "active" | "proposed" | "disabled" | string;
};

type LearnedSkillsResponse = {
  skills?: LearnedSkillSummary[];
};

const CHARACTER_SECTION_PATHS: Record<CharacterHubSection, string> = {
  overview: "/character",
  personality: "/character/personality",
  knowledge: "/character/knowledge",
  skills: "/character/skills",
  experience: "/character/experience",
  relationships: "/character/relationships",
};

const CHARACTER_SECTION_META: Record<
  CharacterHubSection,
  {
    icon: LucideIcon;
  }
> = {
  overview: {
    icon: LayoutDashboard,
  },
  personality: {
    icon: PencilLine,
  },
  knowledge: {
    icon: BookOpen,
  },
  skills: {
    icon: Sparkles,
  },
  experience: {
    icon: Brain,
  },
  relationships: {
    icon: Network,
  },
};

function getSectionFromLocation(tab: string): CharacterHubSection {
  if (typeof window === "undefined") return "overview";
  const pathname = window.location.pathname.toLowerCase();
  if (pathname.endsWith("/personality")) return "personality";
  if (pathname.endsWith("/knowledge")) return "knowledge";
  if (pathname.endsWith("/skills")) return "skills";
  if (pathname.endsWith("/experience")) return "experience";
  if (pathname.endsWith("/relationships")) return "relationships";
  if (tab === "knowledge") return "knowledge";
  return "overview";
}

function updateCharacterSectionPath(
  section: CharacterHubSection,
  mode: "push" | "replace" = "push",
): void {
  if (typeof window === "undefined") return;
  const path = CHARACTER_SECTION_PATHS[section];
  if (!path || window.location.pathname === path) return;
  window.history[mode === "replace" ? "replaceState" : "pushState"](
    null,
    "",
    path,
  );
}

const DEFAULT_KNOWLEDGE_FILENAMES = new Set([
  "eliza-overview.txt",
  "eliza-history.txt",
  "eliza-cloud-basics.txt",
]);

function isDefaultKnowledgeDocument(document: KnowledgeDocument): boolean {
  const normalizedFilename = document.filename.trim().toLowerCase();
  return (
    document.source === "bundled" ||
    document.source === "character" ||
    document.provenance.kind === "bundled" ||
    document.provenance.kind === "character" ||
    DEFAULT_KNOWLEDGE_FILENAMES.has(normalizedFilename)
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

function ratio(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}

export function CharacterHubView({
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
  const { setActionNotice, setTab, tab, t } = useApp();
  const [activeSection, setActiveSection] = useState<CharacterHubSection>(() =>
    getSectionFromLocation(tab),
  );
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<
    KnowledgeDocument[]
  >([]);
  const [selectedKnowledgeDocumentId, setSelectedKnowledgeDocumentId] =
    useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<CharacterHistoryEntry[]>(
    [],
  );
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [relationshipActivity, setRelationshipActivity] = useState<
    RelationshipsActivityItem[]
  >([]);
  const [relationshipActivityError, setRelationshipActivityError] = useState<
    string | null
  >(null);
  const [learnedSkills, setLearnedSkills] = useState<LearnedSkillSummary[]>([]);
  const [experienceRecords, setExperienceRecords] = useState<
    ExperienceRecord[]
  >([]);
  const [selectedExperienceId, setSelectedExperienceId] = useState<
    string | null
  >(null);
  const [experienceLoading, setExperienceLoading] = useState(true);
  const [experienceError, setExperienceError] = useState<string | null>(null);
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
    setActiveSection(getSectionFromLocation(tab));
  }, [tab]);

  useEffect(() => {
    const handlePopState = () => {
      setActiveSection(getSectionFromLocation(tab));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [tab]);

  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);

    void client
      .listCharacterHistory({ limit: 100 })
      .then((response) => {
        if (!cancelled) {
          setHistoryEntries(response.history);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setHistoryError(
            error instanceof Error
              ? error.message
              : "Failed to load personality history.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setExperienceLoading(true);
    setExperienceError(null);

    void client
      .listExperiences({ limit: 100 })
      .then((response) => {
        if (!cancelled) {
          setExperienceRecords(response.experiences);
          setSelectedExperienceId(
            (current) => current ?? response.experiences[0]?.id ?? null,
          );
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setExperienceError(
            error instanceof Error
              ? error.message
              : "Failed to load experiences.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setExperienceLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void client
      .getRelationshipsActivity(50)
      .then((response) => {
        if (!cancelled) {
          setRelationshipActivity(response.activity ?? []);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRelationshipActivityError(
            error instanceof Error
              ? error.message
              : "Failed to load relationship activity.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void client
      .fetch<LearnedSkillsResponse>("/api/skills/curated")
      .then((data) => {
        if (cancelled) return;
        setLearnedSkills(
          (data.skills ?? []).filter((skill) => skill.source !== "human"),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setLearnedSkills([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void client
      .listKnowledgeDocuments({ limit: 100 })
      .then((response) => {
        if (!cancelled) {
          setKnowledgeDocuments(response.documents);
          setSelectedKnowledgeDocumentId(
            (current) => current ?? response.documents[0]?.id ?? null,
          );
        }
      })
      .catch(() => {
        // The embedded knowledge view owns the richer error UI.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const customKnowledgeDocuments = useMemo(
    () =>
      knowledgeDocuments.filter(
        (document) => !isDefaultKnowledgeDocument(document),
      ),
    [knowledgeDocuments],
  );

  const starterOverviewWidgets = useMemo<CharacterOverviewWidget[]>(
    () => [
      {
        section: "personality",
        title: "Personality",
        caption: "Add bio, style, and examples",
        score: 0,
      },
      {
        section: "knowledge",
        title: "Knowledge",
        caption: "Upload or teach source material",
        score: 0,
      },
      {
        section: "skills",
        title: "Skills",
        caption: "Let the agent learn useful abilities",
        score: 0,
      },
      {
        section: "experience",
        title: "Experience",
        caption: "Record outcomes and lessons",
        score: 0,
      },
      {
        section: "relationships",
        title: "Relationships",
        caption: "Build identity and preference memory",
        score: 0,
      },
    ],
    [],
  );
  const overviewWidgets = useMemo<CharacterOverviewWidget[]>(() => {
    const styleItems = Object.values(d.style ?? {}).reduce(
      (count, values) => count + (Array.isArray(values) ? values.length : 0),
      0,
    );
    const latestPersonalityUpdate = historyEntries.reduce(
      (latest, entry) => Math.max(latest, latestTimestamp(entry.timestamp)),
      0,
    );
    const activeSkills = learnedSkills.filter(
      (skill) => skill.status !== "disabled",
    );
    const averageExperienceConfidence =
      experienceRecords.length > 0
        ? experienceRecords.reduce(
            (total, experience) => total + experience.confidence,
            0,
          ) / experienceRecords.length
        : 0;
    const averageExperienceImportance =
      experienceRecords.length > 0
        ? experienceRecords.reduce(
            (total, experience) => total + experience.importance,
            0,
          ) / experienceRecords.length
        : 0;
    const relationshipNames = relationshipActivity
      .map((item) => item.personName)
      .filter(Boolean);

    return [
      {
        section: "personality",
        title: "Personality",
        caption:
          latestPersonalityUpdate > 0
            ? `Updated ${new Date(latestPersonalityUpdate).toLocaleDateString()}`
            : "No personality edits yet",
        score: ratio(
          (bioText.trim() ? 1 : 0) + styleItems + historyEntries.length,
          12,
        ),
        bars: [
          { label: "Bio", value: bioText.trim() ? 1 : 0 },
          { label: "Style", value: ratio(styleItems, 8) },
          { label: "History", value: ratio(historyEntries.length, 8) },
        ],
      },
      {
        section: "knowledge",
        title: "Knowledge",
        caption: `${customKnowledgeDocuments.length} custom document${customKnowledgeDocuments.length === 1 ? "" : "s"}`,
        score: ratio(customKnowledgeDocuments.length, 8),
        bars: [
          { label: "Custom", value: ratio(customKnowledgeDocuments.length, 8) },
          { label: "Total", value: ratio(knowledgeDocuments.length, 12) },
        ],
      },
      {
        section: "skills",
        title: "Skills",
        caption: `${activeSkills.length} learned skill${activeSkills.length === 1 ? "" : "s"}`,
        score: ratio(activeSkills.length, 8),
        nodes: activeSkills.map((skill) => skill.name),
      },
      {
        section: "experience",
        title: "Experience",
        caption: `${experienceRecords.length} recorded experience${experienceRecords.length === 1 ? "" : "s"}`,
        score: ratio(experienceRecords.length, 10),
        bars: [
          { label: "Confidence", value: averageExperienceConfidence },
          { label: "Importance", value: averageExperienceImportance },
          { label: "Records", value: ratio(experienceRecords.length, 10) },
        ],
      },
      {
        section: "relationships",
        title: "Relationships",
        caption: `${relationshipActivity.length} recent signal${relationshipActivity.length === 1 ? "" : "s"}`,
        score: ratio(relationshipActivity.length, 10),
        nodes: relationshipNames,
      },
    ];
  }, [
    bioText,
    customKnowledgeDocuments.length,
    d.style,
    experienceRecords,
    historyEntries,
    knowledgeDocuments.length,
    learnedSkills,
    relationshipActivity,
  ]);

  const timelineItems = useMemo(
    () => historyEntries.map(mapHistoryEntryToTimelineItem),
    [historyEntries],
  );
  const hubExperienceRecords = useMemo(
    () => experienceRecords.map(mapExperienceRecordToHubRecord),
    [experienceRecords],
  );

  const activeSectionLabel = getCharacterHubSectionLabel(activeSection);

  const navigateToSection = useCallback(
    (section: CharacterHubSection) => {
      setActiveSection(section);
      if (section === "knowledge") {
        if (tab !== "knowledge") {
          setTab("knowledge");
        } else {
          updateCharacterSectionPath(section);
        }
        return;
      }
      updateCharacterSectionPath(section);
    },
    [setTab, tab],
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

  const sectionNav = (
    <SidebarPanel className="min-h-0 gap-2 bg-transparent p-0 shadow-none">
      <nav className="flex flex-col gap-0" aria-label="Character hub sections">
        {CHARACTER_HUB_SECTIONS.map((section) =>
          (() => {
            const meta = CHARACTER_SECTION_META[section];
            const Icon = meta.icon;
            const active = activeSection === section;
            return (
              <SidebarContent.Item
                key={section}
                active={active}
                onClick={() => navigateToSection(section)}
                aria-current={active ? "page" : undefined}
                className="items-center gap-2 rounded-none px-5 py-2"
              >
                <SidebarContent.ItemIcon
                  active={active}
                  className={`mt-0 h-8 w-8 bg-transparent p-0 group-hover:bg-transparent ${
                    active ? "text-accent" : "text-muted"
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                </SidebarContent.ItemIcon>
                <SidebarContent.ItemBody>
                  <SidebarContent.ItemTitle
                    className={`truncate text-sm leading-5 ${
                      active ? "font-semibold" : "font-medium"
                    }`}
                  >
                    {getCharacterHubSectionLabel(section)}
                  </SidebarContent.ItemTitle>
                </SidebarContent.ItemBody>
              </SidebarContent.Item>
            );
          })(),
        )}
      </nav>
    </SidebarPanel>
  );

  const renderSection = (): ReactNode => {
    if (activeSection === "overview") {
      return (
        <CharacterOverviewSection
          starterWidgets={starterOverviewWidgets}
          widgets={overviewWidgets}
          onOpenSection={handleOverviewOpenSection}
        />
      );
    }

    if (activeSection === "personality") {
      return (
        <div className="flex min-w-0 flex-col gap-8">
          <section className="rounded-2xl border border-border/40 bg-bg/70 px-4 py-4">
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-txt">Personality</h2>
              <p className="text-sm text-muted">
                Save your bio manually. Style rules and examples autosave as you
                edit them.
              </p>
            </div>
            <CharacterIdentityPanel
              bioText={bioText}
              handleFieldEdit={handleFieldEdit}
              t={t}
            />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/30 pt-4">
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
                  : t("charactereditor.Save", { defaultValue: "Save" })}
              </Button>
            </div>
          </section>

          <section className="rounded-2xl border border-border/40 bg-bg/70 px-4 py-4">
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
          </section>

          <section className="rounded-2xl border border-border/40 bg-bg/70 px-4 py-4">
            <CharacterExamplesPanel
              d={d}
              normalizedMessageExamples={normalizedMessageExamples}
              handleFieldEdit={handleAutoSavedExamplesEdit}
              t={t}
            />
          </section>

          <section className="rounded-2xl border border-border/40 bg-bg/70 px-4 py-4">
            {historyError ? (
              <div className="mb-4 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
                {historyError}
              </div>
            ) : null}
            {historyLoading ? (
              <div className="text-sm text-muted">
                Loading personality history…
              </div>
            ) : (
              <CharacterPersonalityTimeline entries={timelineItems} />
            )}
          </section>
        </div>
      );
    }

    if (activeSection === "knowledge") {
      return (
        <section className="rounded-2xl border border-border/40 bg-bg/70 p-0">
          <KnowledgeView
            embedded
            fileInputId="character-hub-knowledge-upload"
            onDocumentsChange={setKnowledgeDocuments}
            onSelectedDocumentIdChange={setSelectedKnowledgeDocumentId}
            selectedDocumentId={selectedKnowledgeDocumentId}
            showSelectorRail={false}
          />
        </section>
      );
    }

    if (activeSection === "skills") {
      return <CharacterLearnedSkillsSection />;
    }

    if (activeSection === "experience") {
      return (
        <div className="flex min-w-0 flex-col gap-4">
          {experienceError ? (
            <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
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
      <CharacterRelationshipsSection summary="See the full relationships viewer, including extracted facts, relevant memories, and user-scoped preferences.">
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
      </CharacterRelationshipsSection>
    );
  };

  return (
    <PageLayout
      className="h-full"
      contentPadding={false}
      contentInnerClassName="flex w-full min-h-0 flex-1 flex-col px-4 py-4 sm:px-5 sm:py-5 lg:px-6"
      sidebar={
        <AppPageSidebar
          testId="character-editor-sidebar"
          collapsible
          contentIdentity="character-hub"
        >
          <SidebarScrollRegion className="scrollbar-hide !px-0 pb-3 pt-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {sectionNav}
          </SidebarScrollRegion>
        </AppPageSidebar>
      }
      mobileSidebarLabel={activeSectionLabel}
      data-testid="character-editor-view"
    >
      <div
        ref={contentScrollRef}
        className="custom-scrollbar flex min-h-0 flex-1 min-w-0 flex-col overflow-y-auto overflow-x-hidden"
      >
        <WidgetHost slot="character" className="mb-4" />
        {renderSection()}
      </div>
    </PageLayout>
  );
}
