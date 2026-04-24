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
import { KnowledgeView } from "../pages/KnowledgeView";
import { RelationshipsWorkspaceView } from "../pages/relationships/RelationshipsWorkspaceView";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import {
  CharacterExamplesPanel,
  CharacterIdentityPanel,
  CharacterStylePanel,
} from "./CharacterEditorPanels";
import { CharacterExperienceWorkspace } from "./CharacterExperienceWorkspace";
import {
  type CharacterOverviewInsight,
  CharacterOverviewSection,
} from "./CharacterOverviewSection";
import { CharacterPersonalityTimeline } from "./CharacterPersonalityTimeline";
import { CharacterRelationshipsSection } from "./CharacterRelationshipsSection";
import {
  buildCharacterOverviewItems,
  CHARACTER_HUB_SECTIONS,
  type CharacterHubSection,
  getCharacterHubSectionLabel,
  mapExperienceRecordToHubRecord,
  mapHistoryEntryToTimelineItem,
} from "./character-hub-helpers";

type CharacterStyleSection = "all" | "chat" | "post";

const CHARACTER_SECTION_PATHS: Record<CharacterHubSection, string> = {
  overview: "/character",
  personality: "/character/personality",
  knowledge: "/character/knowledge",
  experience: "/character/experience",
  relationships: "/character/relationships",
};

const CHARACTER_SECTION_META: Record<
  CharacterHubSection,
  {
    description: string;
    icon: LucideIcon;
  }
> = {
  overview: {
    description: "Recent character activity",
    icon: LayoutDashboard,
  },
  personality: {
    description: "Bio, style rules, examples",
    icon: PencilLine,
  },
  knowledge: {
    description: "Documents, chunks, CRUD",
    icon: BookOpen,
  },
  experience: {
    description: "Learnings, confidence, review",
    icon: Brain,
  },
  relationships: {
    description: "People, facts, graph context",
    icon: Network,
  },
};

function getSectionFromLocation(tab: string): CharacterHubSection {
  if (typeof window === "undefined") return "overview";
  const pathname = window.location.pathname.toLowerCase();
  if (pathname.endsWith("/personality")) return "personality";
  if (pathname.endsWith("/knowledge")) return "knowledge";
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

function countDuplicateValues(values: string[]): number {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized) continue;
    if (seen.has(normalized)) {
      duplicates.add(normalized);
    }
    seen.add(normalized);
  }
  return duplicates.size;
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
  onReset,
  canReset,
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
  onReset: () => void;
  canReset: boolean;
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
  const personalitySectionRefs = useRef<
    Record<"bio" | "style" | "examples" | "evolution", HTMLElement | null>
  >({
    bio: null,
    style: null,
    examples: null,
    evolution: null,
  });

  const clearPendingAutoSave = useCallback(() => {
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    pendingAutoSavePatchRef.current = {};
  }, []);

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
  const needsKnowledgeUpload = customKnowledgeDocuments.length === 0;

  const overviewItems = useMemo(
    () =>
      buildCharacterOverviewItems({
        history: historyEntries,
        documents: customKnowledgeDocuments,
        experiences: experienceRecords,
        relationshipActivity,
      }),
    [
      customKnowledgeDocuments,
      experienceRecords,
      historyEntries,
      relationshipActivity,
    ],
  );
  const balancedOverviewItems = useMemo(() => {
    const byKind = new Map<string, typeof overviewItems>();
    for (const item of overviewItems) {
      const bucket = byKind.get(item.kind) ?? [];
      if (bucket.length < 4) {
        bucket.push(item);
        byKind.set(item.kind, bucket);
      }
    }
    return Array.from(byKind.values())
      .flat()
      .sort((left, right) => {
        const leftTime = left.timestamp
          ? new Date(left.timestamp).getTime()
          : 0;
        const rightTime = right.timestamp
          ? new Date(right.timestamp).getTime()
          : 0;
        return rightTime - leftTime;
      });
  }, [overviewItems]);

  const styleRules = d.style?.all ?? [];
  const duplicateStyleRules = countDuplicateValues(styleRules);
  const postExamples = d.postExamples ?? [];
  const duplicatePostExamples = countDuplicateValues(postExamples);
  const lowConfidenceExperiences = experienceRecords.filter(
    (experience) => experience.confidence < 0.55,
  ).length;
  const overviewInsights: CharacterOverviewInsight[] = [
    ...(hasPendingChanges
      ? [
          {
            id: "pending-personality",
            section: "personality" as const,
            title: "Unsaved personality changes",
            detail: "Bio edits still need a manual save.",
            tone: "warn" as const,
          },
        ]
      : []),
    ...(duplicateStyleRules > 0
      ? [
          {
            id: "duplicate-style",
            section: "personality" as const,
            title: "Duplicate style rules",
            detail: `${duplicateStyleRules} repeated style rule ${duplicateStyleRules === 1 ? "entry" : "entries"} should be merged.`,
            tone: "warn" as const,
          },
        ]
      : []),
    ...(duplicatePostExamples > 0
      ? [
          {
            id: "duplicate-posts",
            section: "personality" as const,
            title: "Duplicate post examples",
            detail: `${duplicatePostExamples} repeated post example ${duplicatePostExamples === 1 ? "entry" : "entries"} should be trimmed.`,
            tone: "warn" as const,
          },
        ]
      : []),
    ...(needsKnowledgeUpload
      ? [
          {
            id:
              knowledgeDocuments.length === 0
                ? "empty-knowledge"
                : "default-knowledge-only",
            section: "knowledge" as const,
            title:
              knowledgeDocuments.length === 0
                ? "No knowledge uploaded"
                : "Only default knowledge loaded",
            detail:
              "Upload documents, notes, or links to give this character source material that is specific to your workspace.",
            tone: "warn" as const,
          },
        ]
      : []),
    ...(knowledgeDocuments.some((document) => document.fragmentCount === 0)
      ? [
          {
            id: "empty-fragments",
            section: "knowledge" as const,
            title: "Knowledge without chunks",
            detail: "At least one document has no retrievable chunks.",
            tone: "danger" as const,
          },
        ]
      : []),
    ...(lowConfidenceExperiences > 0
      ? [
          {
            id: "low-confidence-experience",
            section: "experience" as const,
            title: "Experience review needed",
            detail: `${lowConfidenceExperiences} learned ${lowConfidenceExperiences === 1 ? "experience has" : "experiences have"} low confidence.`,
            tone: "warn" as const,
          },
        ]
      : []),
    ...(experienceError
      ? [
          {
            id: "experience-error",
            section: "experience" as const,
            title: "Experience load failed",
            detail: experienceError,
            tone: "danger" as const,
          },
        ]
      : []),
    ...(relationshipActivityError
      ? [
          {
            id: "relationship-error",
            section: "relationships" as const,
            title: "Relationship activity failed",
            detail: relationshipActivityError,
            tone: "danger" as const,
          },
        ]
      : []),
    ...(historyError
      ? [
          {
            id: "history-error",
            section: "personality" as const,
            title: "Personality history failed",
            detail: historyError,
            tone: "danger" as const,
          },
        ]
      : []),
  ];

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

  const scrollPersonalitySectionIntoView = (
    section: "bio" | "style" | "examples" | "evolution",
  ) => {
    if (activeSection !== "personality") {
      navigateToSection("personality");
      requestAnimationFrame(() => {
        personalitySectionRefs.current[section]?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
      return;
    }

    personalitySectionRefs.current[section]?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const handleOverviewOpen = (
    item: ReturnType<typeof buildCharacterOverviewItems>[number],
  ) => {
    if (item.kind === "knowledge") {
      setSelectedKnowledgeDocumentId(item.id.replace("knowledge:", ""));
      navigateToSection("knowledge");
      return;
    }
    if (item.kind === "experience") {
      setSelectedExperienceId(item.id.replace("experience:", ""));
      navigateToSection("experience");
      return;
    }
    if (item.kind === "relationship") {
      navigateToSection("relationships");
      return;
    }
    navigateToSection("personality");
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

  const handleReset = useCallback(() => {
    clearPendingAutoSave();
    onReset();
  }, [clearPendingAutoSave, onReset]);

  const sectionNav = (
    <SidebarPanel className="min-h-0 gap-2 bg-transparent p-0 shadow-none">
      <SidebarContent.SectionLabel className="px-2">
        Character
      </SidebarContent.SectionLabel>
      <nav className="flex flex-col gap-1" aria-label="Character hub sections">
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
                className="items-center gap-2 px-2.5 py-2"
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

  const contextualSidebar =
    activeSection === "personality" ? (
      <SidebarPanel className="min-h-0 gap-2 bg-transparent p-0 shadow-none">
        <SidebarContent.SectionLabel>Personality</SidebarContent.SectionLabel>
        <div className="flex flex-col gap-1">
          {(
            [
              ["bio", "Bio"],
              ["style", "Style Rules"],
              ["examples", "Examples"],
              ["evolution", "Evolution"],
            ] as const
          ).map(([id, label]) => (
            <SidebarContent.Item
              key={id}
              onClick={() => scrollPersonalitySectionIntoView(id)}
              className="items-center gap-2 px-2.5 py-2"
            >
              <SidebarContent.ItemTitle className="font-medium">
                {label}
              </SidebarContent.ItemTitle>
            </SidebarContent.Item>
          ))}
        </div>
      </SidebarPanel>
    ) : activeSection === "knowledge" ? (
      <SidebarPanel className="min-h-0 gap-2 bg-transparent p-0 shadow-none">
        <SidebarContent.SectionLabel>Documents</SidebarContent.SectionLabel>
        <div className="ml-2 flex flex-col gap-0.5 border-l border-border/25 pl-2">
          {knowledgeDocuments.length > 0 ? (
            knowledgeDocuments.map((document) => (
              <SidebarContent.Item
                key={document.id}
                active={selectedKnowledgeDocumentId === document.id}
                onClick={() => setSelectedKnowledgeDocumentId(document.id)}
                aria-current={
                  selectedKnowledgeDocumentId === document.id
                    ? "page"
                    : undefined
                }
                className="items-center gap-2 py-1.5 pl-2 pr-2"
              >
                <SidebarContent.ItemTitle className="truncate text-xs-tight font-medium">
                  {document.filename}
                </SidebarContent.ItemTitle>
              </SidebarContent.Item>
            ))
          ) : (
            <div className="px-2 py-2 text-xs-tight text-muted">
              No knowledge documents yet.
            </div>
          )}
        </div>
      </SidebarPanel>
    ) : null;

  const renderSection = (): ReactNode => {
    if (activeSection === "overview") {
      return (
        <CharacterOverviewSection
          insights={overviewInsights}
          items={balancedOverviewItems}
          needsKnowledgeUpload={needsKnowledgeUpload}
          onOpenItem={handleOverviewOpen}
          onOpenIdentitySettings={() => setTab("settings")}
          onOpenKnowledgeUpload={() => navigateToSection("knowledge")}
          onOpenSection={navigateToSection}
        />
      );
    }

    if (activeSection === "personality") {
      return (
        <div className="flex min-w-0 flex-col gap-8">
          <section
            ref={(node) => {
              personalitySectionRefs.current.bio = node;
            }}
            className="rounded-2xl border border-border/40 bg-bg/70 px-4 py-4"
          >
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-txt">Personality</h2>
                <p className="text-sm text-muted">
                  Save your bio manually. Style rules and examples autosave as
                  you edit them.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-lg"
                onClick={() => setTab("settings")}
              >
                Open identity settings
              </Button>
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

          <section
            ref={(node) => {
              personalitySectionRefs.current.style = node;
            }}
            className="rounded-2xl border border-border/40 bg-bg/70 px-4 py-4"
          >
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

          <section
            ref={(node) => {
              personalitySectionRefs.current.examples = node;
            }}
            className="rounded-2xl border border-border/40 bg-bg/70 px-4 py-4"
          >
            <CharacterExamplesPanel
              d={d}
              normalizedMessageExamples={normalizedMessageExamples}
              handleFieldEdit={handleAutoSavedExamplesEdit}
              t={t}
            />
          </section>

          <section
            ref={(node) => {
              personalitySectionRefs.current.evolution = node;
            }}
            className="rounded-2xl border border-border/40 bg-bg/70 px-4 py-4"
          >
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
          bottomAction={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 rounded-sm px-2 text-xs font-semibold uppercase tracking-[0.14em]"
              onClick={handleReset}
              disabled={!canReset}
            >
              RESET
            </Button>
          }
        >
          <SidebarScrollRegion className="scrollbar-hide px-1 pb-3 pt-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {sectionNav}
            {contextualSidebar}
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
        {renderSection()}
      </div>
    </PageLayout>
  );
}
