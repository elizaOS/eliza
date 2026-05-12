import type { MessageExampleGroup } from "@elizaos/core";
import { Button } from "../ui/button";
import { PageLayout } from "../../layouts/page-layout/page-layout";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import {
  BookOpen,
  Brain,
  LayoutDashboard,
  type LucideIcon,
  MessageCircle,
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
  DocumentRecord,
  ExperienceRecord,
  RelationshipsActivityItem,
} from "../../api/client-types";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import {
  getWindowNavigationPath,
  shouldUseHashNavigation,
} from "../../navigation";
import { useApp } from "../../state/useApp";
// Direct sub-path import to avoid the widgets/index.ts ↔ WidgetHost.tsx
// chunk-level circular dependency.
import { WidgetHost } from "../../widgets/WidgetHost";
import { getBrandIcon } from "../conversations/brand-icons";
import { DocumentsView } from "../pages/DocumentsView";
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
import {
  CHARACTER_HUB_SECTIONS,
  type CharacterHubSection,
  getCharacterHubSectionLabel,
  mapExperienceRecordToHubRecord,
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
  documents: "/character/documents",
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
  documents: {
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

const HUB_CACHE_PREFIX = "character-hub-cache";

function hubCacheKey(suffix: string): string {
  return `${HUB_CACHE_PREFIX}:${suffix}`;
}

function readHubCache<T>(suffix: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(hubCacheKey(suffix));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeHubCache<T>(suffix: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(hubCacheKey(suffix), JSON.stringify(value));
  } catch {
    /* ignore quota / serialization errors */
  }
}

function formatRelativeTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const time = typeof value === "number" ? value : new Date(value).getTime();
  if (Number.isNaN(time) || time <= 0) return "";
  const diff = Date.now() - time;
  if (diff < 0) return "just now";
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) {
    const value = Math.round(diff / minute);
    return `${value}m ago`;
  }
  if (diff < day) {
    const value = Math.round(diff / hour);
    return `${value}h ago`;
  }
  if (diff < 7 * day) {
    const value = Math.round(diff / day);
    return `${value}d ago`;
  }
  return new Date(time).toLocaleDateString();
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
  useRenderGuard("CharacterHubView");
  const { setActionNotice, setTab, tab, t } = useApp();
  const [activeSection, setActiveSection] = useState<CharacterHubSection>(() =>
    getSectionFromLocation(tab),
  );
  const [documentRecords, setDocumentRecords] = useState<DocumentRecord[]>(() =>
    readHubCache<DocumentRecord[]>("documents", []),
  );
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(
    null,
  );
  const [historyEntries, setHistoryEntries] = useState<CharacterHistoryEntry[]>(
    () => readHubCache<CharacterHistoryEntry[]>("history", []),
  );
  const [historyLoading, setHistoryLoading] = useState(true);
  const [, setHistoryError] = useState<string | null>(null);
  const [relationshipActivity, setRelationshipActivity] = useState<
    RelationshipsActivityItem[]
  >(() =>
    readHubCache<RelationshipsActivityItem[]>("relationship-activity", []),
  );
  const [relationshipActivityLoading, setRelationshipActivityLoading] =
    useState(true);
  const [relationshipActivityError, setRelationshipActivityError] = useState<
    string | null
  >(null);
  const [learnedSkills, setLearnedSkills] = useState<LearnedSkillSummary[]>(
    () => readHubCache<LearnedSkillSummary[]>("learned-skills", []),
  );
  const [learnedSkillsLoading, setLearnedSkillsLoading] = useState(true);
  const [experienceRecords, setExperienceRecords] = useState<
    ExperienceRecord[]
  >(() => readHubCache<ExperienceRecord[]>("experience-records", []));
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
    const syncSectionFromLocation = () => {
      setActiveSection(getSectionFromLocation(tab));
    };
    window.addEventListener("popstate", syncSectionFromLocation);
    window.addEventListener("hashchange", syncSectionFromLocation);
    return () => {
      window.removeEventListener("popstate", syncSectionFromLocation);
      window.removeEventListener("hashchange", syncSectionFromLocation);
    };
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
          writeHubCache("history", response.history);
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
          writeHubCache("experience-records", response.experiences);
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
          const activity = response.activity ?? [];
          setRelationshipActivity(activity);
          writeHubCache("relationship-activity", activity);
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
      })
      .finally(() => {
        if (!cancelled) {
          setRelationshipActivityLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void client
      .listDocuments({ limit: 100 })
      .then((response) => {
        if (cancelled) return;
        const docs = response.documents ?? [];
        setDocumentRecords(docs);
        writeHubCache("documents", docs);
      })
      .catch(() => {
        /* ignored — DocumentsView shows its own error when active */
      })
      .finally(() => {
        if (!cancelled) {
          setDocumentsLoading(false);
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
        const filtered = (data.skills ?? []).filter(
          (skill) => skill.source !== "human",
        );
        setLearnedSkills(filtered);
        writeHubCache("learned-skills", filtered);
      })
      .catch(() => {
        if (!cancelled) {
          setLearnedSkills([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLearnedSkillsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void client
      .listDocuments({ limit: 100 })
      .then((response) => {
        if (!cancelled) {
          setDocumentRecords(response.documents);
          setSelectedDocumentId(
            (current) => current ?? response.documents[0]?.id ?? null,
          );
        }
      })
      .catch(() => {
        // The embedded documents view owns the richer error UI.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const customDocumentRecords = useMemo(
    () =>
      documentRecords.filter((document) => !isDefaultDocumentRecord(document)),
    [documentRecords],
  );

  const overviewWidgets = useMemo<CharacterOverviewWidget[]>(() => {
    const styleItems = Object.values(d.style ?? {}).reduce(
      (count, values) => count + (Array.isArray(values) ? values.length : 0),
      0,
    );
    const exampleCount = normalizedMessageExamples.length;
    const recentHistory = [...historyEntries]
      .sort(
        (left, right) =>
          latestTimestamp(right.timestamp) - latestTimestamp(left.timestamp),
      )
      .slice(0, 3);
    const activeSkills = learnedSkills.filter(
      (skill) => skill.status !== "disabled",
    );
    const recentDocs = [...customDocumentRecords]
      .sort(
        (left, right) =>
          latestTimestamp(right.createdAt) - latestTimestamp(left.createdAt),
      )
      .slice(0, 3);
    const recentExperience = [...experienceRecords].sort(
      (left, right) =>
        latestTimestamp(right.updatedAt ?? right.createdAt) -
        latestTimestamp(left.updatedAt ?? left.createdAt),
    )[0];
    const recentRelationshipActivity = [...relationshipActivity]
      .filter((item) => item.type !== "relationship")
      .sort(
        (left, right) =>
          latestTimestamp(right.timestamp) - latestTimestamp(left.timestamp),
      )
      .slice(0, 5);

    const personalityHasHistory = recentHistory.length > 0;
    const trimmedBio = bioText.trim();
    const personalityHasContent =
      personalityHasHistory ||
      trimmedBio.length > 0 ||
      styleItems > 0 ||
      exampleCount > 0;
    const personalityBody: ReactNode = personalityHasHistory ? (
      <ul className="flex flex-col divide-y divide-border/10 text-xs text-muted">
        {recentHistory.map((entry, index) => {
          const fields = entry.fieldsChanged ?? [];
          const headField = fields[0];
          const extraCount = Math.max(fields.length - 1, 0);
          const actor =
            entry.source === "agent"
              ? d.name?.trim() || "agent"
              : entry.source === "restore"
                ? "system"
                : "you";
          const fieldLabel = headField
            ? extraCount > 0
              ? `${headField} +${extraCount} more`
              : headField
            : (entry.summary?.trim() ?? "personality");
          return (
            <li
              key={entry.id ?? `history-${index}`}
              className="flex min-w-0 items-baseline gap-2 py-1.5 first:pt-0 last:pb-0"
            >
              <span className="shrink-0 rounded-full border border-border/40 bg-bg-muted/30 px-1.5 py-0.5 text-2xs font-medium text-muted">
                @{actor}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted">
                edited <span className="text-txt">{fieldLabel}</span>
              </span>
              <span className="shrink-0 text-2xs text-muted/70">
                {formatRelativeTime(entry.timestamp)}
              </span>
            </li>
          );
        })}
      </ul>
    ) : trimmedBio ? (
      <p className="line-clamp-3 text-xs leading-relaxed text-muted">
        {trimmedBio}
      </p>
    ) : (
      <div className="flex flex-wrap gap-1.5 text-2xs">
        {styleItems > 0 ? (
          <span className="rounded-full border border-border/30 bg-bg-muted/30 px-2 py-0.5 text-muted">
            {styleItems} style rule{styleItems === 1 ? "" : "s"}
          </span>
        ) : null}
        {exampleCount > 0 ? (
          <span className="rounded-full border border-border/30 bg-bg-muted/30 px-2 py-0.5 text-muted">
            {exampleCount} example{exampleCount === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
    );

    function parseConnectorsFromDetail(detail: string | null): string[] {
      if (!detail) return [];
      const match = detail.match(/identity on ([^·]+?)(?:\s+·|$)/i);
      if (!match) return [];
      return match[1]
        .split(/[, ]+/)
        .map((value) => value.trim())
        .filter(Boolean);
    }

    function shortenConnectorLabel(value: string): string {
      const lower = value.toLowerCase();
      if (lower === "client_chat") return "chat";
      if (lower === "telegram") return "tg";
      return lower;
    }

    function ConnectorBadge({ connector }: { connector: string }) {
      const Brand = getBrandIcon(connector);
      const label = shortenConnectorLabel(connector);
      const Icon =
        Brand ?? (connector === "client_chat" ? MessageCircle : null);
      if (Icon) {
        return (
          <span
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted/80"
            title={label}
            role="img"
            aria-label={label}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
        );
      }
      return (
        <span
          className="rounded-full border border-border/30 bg-bg-muted/20 px-1.5 py-0.5 text-2xs lowercase text-muted/80"
          title={label}
        >
          {label}
        </span>
      );
    }

    const emptyHint = (text: string): ReactNode => (
      <p className="text-xs leading-relaxed text-muted">{text}</p>
    );

    return [
      {
        section: "personality",
        title: "Personality",
        meta: null,
        body: personalityHasContent
          ? personalityBody
          : emptyHint(
              "Bio, voice, and how I show up. Tell me who I am — I'll keep this in mind every conversation.",
            ),
        isLoading: historyLoading && !personalityHasContent,
        isEmpty: !personalityHasContent,
      },
      {
        section: "relationships",
        title: "Relationships",
        meta: null,
        body:
          recentRelationshipActivity.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border/10 text-xs text-muted">
              {recentRelationshipActivity.map((item) => {
                const connectors = parseConnectorsFromDetail(item.detail);
                const memoryText =
                  item.type === "fact"
                    ? item.summary?.trim() || item.detail?.trim() || "fact"
                    : item.type === "identity"
                      ? "joined"
                      : item.summary?.trim() || item.type;
                return (
                  <li
                    key={[
                      item.personId,
                      item.personName,
                      item.type,
                      item.timestamp ?? "no-time",
                      item.summary,
                      item.detail ?? "",
                    ].join(":")}
                    className="flex min-w-0 items-center gap-2 py-1.5 first:pt-0 last:pb-0"
                  >
                    <span className="inline-flex shrink-0 items-center gap-1">
                      <span className="rounded-full border border-border/40 bg-bg-muted/30 px-1.5 py-0.5 text-2xs font-medium text-muted">
                        @{item.personName?.trim() || "unknown"}
                      </span>
                      {connectors.map((connector) => (
                        <ConnectorBadge key={connector} connector={connector} />
                      ))}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {memoryText}
                    </span>
                    <span className="shrink-0 text-2xs text-muted/70">
                      {formatRelativeTime(item.timestamp)}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            emptyHint(
              "People I know — names, facts, preferences. Builds up as we talk.",
            )
          ),
        isLoading:
          relationshipActivityLoading &&
          recentRelationshipActivity.length === 0,
        isEmpty: recentRelationshipActivity.length === 0,
      },
      {
        section: "documents",
        title: "Knowledge",
        meta:
          customDocumentRecords.length > 0
            ? `${customDocumentRecords.length} doc${
                customDocumentRecords.length === 1 ? "" : "s"
              }`
            : null,
        body:
          recentDocs.length > 0 ? (
            <ul className="flex flex-col gap-1 text-xs text-muted">
              {recentDocs.map((doc) => (
                <li key={doc.id} className="truncate">
                  {doc.filename}
                </li>
              ))}
            </ul>
          ) : documentRecords.length > 0 ? (
            emptyHint(
              "Just the default knowledge so far. Upload notes, docs, or links to teach me what matters.",
            )
          ) : (
            emptyHint(
              "Things I should read and remember. Upload notes, docs, or links.",
            )
          ),
        isLoading: documentsLoading && documentRecords.length === 0,
        isEmpty: documentRecords.length === 0,
      },
      {
        section: "skills",
        title: "Skills",
        meta: activeSkills.length > 0 ? `${activeSkills.length} active` : null,
        body:
          activeSkills.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {activeSkills.slice(0, 5).map((skill) => (
                <span
                  key={skill.name}
                  className="truncate rounded-full border border-border/30 bg-bg-muted/30 px-2 py-0.5 text-2xs text-muted"
                  title={skill.name}
                >
                  {skill.name}
                </span>
              ))}
              {activeSkills.length > 5 ? (
                <span className="text-2xs text-muted">
                  +{activeSkills.length - 5} more
                </span>
              ) : null}
            </div>
          ) : (
            emptyHint(
              "Abilities I'll pick up over time. Browse the catalog or teach me by example.",
            )
          ),
        isLoading: learnedSkillsLoading && activeSkills.length === 0,
        isEmpty: activeSkills.length === 0,
      },
      {
        section: "experience",
        title: "Experience",
        meta:
          experienceRecords.length > 0
            ? `${experienceRecords.length} lesson${
                experienceRecords.length === 1 ? "" : "s"
              }`
            : null,
        body: recentExperience ? (
          <p className="line-clamp-3 text-xs italic leading-relaxed text-muted">
            {recentExperience.learning ||
              recentExperience.result ||
              recentExperience.context ||
              recentExperience.type}
          </p>
        ) : (
          emptyHint(
            "Lessons from what worked and what didn't. I'll add these as we go.",
          )
        ),
        isLoading: experienceLoading && experienceRecords.length === 0,
        isEmpty: experienceRecords.length === 0,
      },
    ];
  }, [
    bioText,
    customDocumentRecords,
    d.name,
    d.style,
    experienceLoading,
    experienceRecords,
    historyEntries,
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
      <nav
        className="flex flex-col gap-0"
        aria-label={t("character.characterHubSections")}
      >
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
          characterName={d.name}
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

          <section className="rounded-2xl border border-border/40 bg-bg/70 px-4 py-4">
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
        <DocumentsView
          embedded
          fileInputId="character-hub-documents-upload"
          onDocumentsChange={(docs) => {
            setDocumentRecords(docs);
            writeHubCache("documents", docs);
            setDocumentsLoading(false);
          }}
          onSelectedDocumentIdChange={setSelectedDocumentId}
          selectedDocumentId={selectedDocumentId}
          showSelectorRail={false}
        />
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
          <SidebarScrollRegion className="scrollbar-hide !px-0 pb-3 pt-0 [scrollbar-width:none] [scrollbar-gutter:auto] supports-[scrollbar-gutter:stable]:[scrollbar-gutter:auto] [&::-webkit-scrollbar]:hidden">
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
