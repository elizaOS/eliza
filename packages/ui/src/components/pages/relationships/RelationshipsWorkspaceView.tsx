import { Filter, Network } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgentElement } from "../../../agent-surface";
import { client } from "../../../api/client";
import type {
  RelationshipsGraphSnapshot,
  RelationshipsPersonDetail,
} from "../../../api/client-types-relationships";
import { PageLayout } from "../../../layouts/page-layout/page-layout";
import { useAppSelector } from "../../../state";
import { useRegisterViewChatBinding } from "../../../state/view-chat-binding";
import { ChatEmptyStateWithRecommendations } from "../../composites/chat";
import { PagePanel } from "../../composites/page-panel";
import { RelationshipsGraphPanel } from "../RelationshipsGraphPanel";
import { RelationshipsActivityFeed } from "./RelationshipsActivityFeed";
import { RelationshipsCandidateMergesPanel } from "./RelationshipsCandidateMergesPanel";
import {
  RelationshipsConnectionsPanel,
  RelationshipsConversationsPanel,
  RelationshipsDocumentsPanel,
  RelationshipsFactsPanel,
  RelationshipsPersonSummaryPanel,
  RelationshipsRelevantMemoriesPanel,
  RelationshipsUserPreferencesPanel,
} from "./RelationshipsPersonPanels";
import { RelationshipsSidebar } from "./RelationshipsSidebar";
import {
  buildRelationshipsGraphQuery,
  platformOptions,
  sortPeople,
} from "./relationships-utils";

export function RelationshipsWorkspaceView({
  contentHeader,
  embedded = false,
  onViewMemories,
}: {
  contentHeader?: ReactNode;
  embedded?: boolean;
  onViewMemories?: (entityIds: string[]) => void;
}) {
  const t = useAppSelector((s) => s.t);
  const setTab = useAppSelector((s) => s.setTab);
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState<string>("all");
  const [graphLoading, setGraphLoading] = useState(true);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graph, setGraph] = useState<RelationshipsGraphSnapshot | null>(null);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detail, setDetail] = useState<RelationshipsPersonDetail | null>(null);
  const graphRequestId = useRef(0);
  const deferredSearch = useDeferredValue(search);

  const searchPlaceholder = t("relationships.searchPlaceholder", {
    defaultValue: "Search people, aliases, handles…",
  });
  const chatBinding = useMemo(
    () => ({ placeholder: searchPlaceholder, onQuery: setSearch }),
    [searchPlaceholder],
  );
  useRegisterViewChatBinding(chatBinding);

  const loadGraph = useCallback(
    async (query = buildRelationshipsGraphQuery("", "all")) => {
      const requestId = graphRequestId.current + 1;
      graphRequestId.current = requestId;
      setGraphLoading(true);
      setGraphError(null);

      try {
        const snapshot = await client.getRelationshipsGraph(query);
        if (requestId !== graphRequestId.current) {
          return;
        }
        setGraph({
          ...snapshot,
          people: sortPeople(snapshot.people),
        });
      } catch (error) {
        if (requestId !== graphRequestId.current) {
          return;
        }
        setGraphError(
          error instanceof Error
            ? error.message
            : t("relationships.graphLoadError", {
                defaultValue: "Failed to load the relationships graph.",
              }),
        );
        setGraph(null);
      } finally {
        if (requestId === graphRequestId.current) {
          setGraphLoading(false);
        }
      }
    },
    [t],
  );

  useEffect(() => {
    void loadGraph(buildRelationshipsGraphQuery(deferredSearch, platform));
  }, [deferredSearch, loadGraph, platform]);

  useEffect(() => {
    if (!graph || graph.people.length === 0) {
      setSelectedPersonId(null);
      setDetail(null);
      return;
    }

    const stillSelected = graph.people.some(
      (person) => person.primaryEntityId === selectedPersonId,
    );
    if (!stillSelected) {
      setSelectedPersonId(graph.people[0].primaryEntityId);
    }
  }, [graph, selectedPersonId]);

  useEffect(() => {
    if (!selectedPersonId) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);

    void client
      .getRelationshipsPerson(selectedPersonId)
      .then((person) => {
        if (!cancelled) {
          setDetail(person);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setDetail(null);
          setDetailError(
            err instanceof Error
              ? err.message
              : t("relationships.personLoadError", {
                  defaultValue: "Failed to load the selected person.",
                }),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDetailLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPersonId, t]);

  const platforms = platformOptions(graph);
  const selectedSummary =
    graph?.people.find(
      (person) => person.primaryEntityId === selectedPersonId,
    ) ?? null;
  const selectedGroupId = selectedSummary?.groupId ?? null;
  const ownerSummary = graph?.people.find((person) => person.isOwner) ?? null;
  const ownerGroupId = ownerSummary?.groupId ?? null;
  const ownerDisplayName = ownerSummary?.displayName ?? null;
  const handleViewMemories =
    onViewMemories ??
    (() => {
      setTab("memories");
    });

  const refreshGraph = () => {
    void loadGraph(buildRelationshipsGraphQuery(deferredSearch, platform));
  };

  const platformAgent = useAgentElement<HTMLSelectElement>({
    id: "relationships-platform",
    role: "select",
    label: t("relationships.platformFilter", {
      defaultValue: "Platform filter",
    }),
    group: "relationships-toolbar",
    description: "Filter relationships by platform",
    options: ["all", ...platforms],
    getValue: () => platform,
    onFill: (value) => setPlatform(value),
  });
  const toolbar = (
    <div className="flex flex-col gap-3">
      <div
        className={
          embedded
            ? "grid min-w-0 gap-2 md:grid-cols-[minmax(12rem,14rem)_auto]"
            : "flex min-w-0 flex-col gap-2 sm:flex-row sm:justify-end"
        }
      >
        <div className="relative min-w-0">
          <label className="sr-only" htmlFor="relationships-platform">
            {t("relationships.platformFilter", {
              defaultValue: "Platform filter",
            })}
          </label>
          <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <select
            ref={platformAgent.ref}
            id="relationships-platform"
            value={platform}
            onChange={(event) => setPlatform(event.target.value)}
            aria-label={t("relationships.platformFilter", {
              defaultValue: "Platform filter",
            })}
            className="h-9 w-full rounded-sm border border-border/35 bg-card/45 pl-9 pr-8 text-sm text-txt outline-none transition "
            {...platformAgent.agentProps}
          >
            <option value="all">
              {t("relationships.platformAll", { defaultValue: "All" })}
            </option>
            {platforms.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );

  const content = (
    <div
      className={`flex min-h-0 flex-1 flex-col ${embedded ? "gap-3" : "gap-4"}`}
      data-testid={embedded ? "relationships-embedded-view" : undefined}
    >
      {toolbar}
      {detailError ? (
        <div className="rounded-sm border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          {detailError}
        </div>
      ) : null}

      {graphError && !graph ? (
        <PagePanel.Empty
          variant="panel"
          className={embedded ? "min-h-[18rem]" : "min-h-[24rem]"}
          title={t("relationships.failedToLoad", {
            defaultValue: "Relationships failed to load",
          })}
          description={graphError}
        />
      ) : !graph && graphLoading ? (
        <PagePanel.Loading
          heading={t("common.loading", { defaultValue: "Loading..." })}
        />
      ) : !graph || graph.people.length === 0 ? (
        <ChatEmptyStateWithRecommendations
          className={embedded ? "min-h-[18rem]" : "min-h-[24rem]"}
          icon={Network}
          title={
            search || platform !== "all"
              ? t("relationships.noMatching", {
                  defaultValue: "No people match that filter.",
                })
              : t("relationships.noneYet", {
                  defaultValue:
                    "No relationships yet. Ask Eliza to map who you know.",
                })
          }
          recommendations={[
            {
              label: t("relationships.recAddContact", {
                defaultValue: "Add someone to my network",
              }),
              prompt: "help me add someone to my network",
            },
            {
              label: t("relationships.recIdentify", {
                defaultValue: "Who do I know well?",
              }),
              prompt: "who do I know well in my network",
            },
            {
              label: t("relationships.recImport", {
                defaultValue: "Import contacts from my platforms",
              }),
              prompt:
                "help me import my relationships from my connected platforms",
            },
          ]}
          primaryAction={
            search || platform !== "all"
              ? undefined
              : {
                  label: t("relationships.connectPlatforms", {
                    defaultValue: "Connect your platforms",
                  }),
                  icon: Network,
                  onClick: () => {
                    if (typeof window !== "undefined") {
                      window.location.hash = "connectors";
                    }
                    setTab("settings");
                  },
                }
          }
        />
      ) : (
        <>
          {graphError ? (
            <PagePanel.Notice tone="danger">{graphError}</PagePanel.Notice>
          ) : null}
          <div
            className={
              embedded
                ? "grid min-h-0 min-w-0 gap-3"
                : "grid min-h-0 min-w-0 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.65fr)]"
            }
          >
            <PagePanel
              variant="surface"
              className="min-w-0 px-3 py-3 sm:px-4 sm:py-4"
            >
              <RelationshipsGraphPanel
                snapshot={graph}
                selectedGroupId={selectedGroupId}
                compact={embedded}
                onSelectPersonId={setSelectedPersonId}
              />
            </PagePanel>

            {detail ? (
              <div className="transition-opacity duration-200">
                <RelationshipsPersonSummaryPanel
                  person={detail}
                  compact={embedded}
                  ownerGroupId={ownerGroupId}
                  ownerDisplayName={ownerDisplayName}
                  onViewMemories={handleViewMemories}
                  onOwnerNameUpdated={() => refreshGraph()}
                />
              </div>
            ) : detailLoading ? (
              <PagePanel.Loading
                heading={t("relationships.loadingPerson", {
                  defaultValue: "Loading person...",
                })}
              />
            ) : (
              <PagePanel.Empty
                variant="panel"
                title={t("relationships.selectPerson", {
                  defaultValue: "Select a person",
                })}
                description={t("relationships.selectPersonDesc", {
                  defaultValue: "Choose a person from the list or graph.",
                })}
              />
            )}
          </div>

          {detail ? (
            <div className="grid gap-3 transition-opacity duration-200 xl:grid-cols-2">
              <RelationshipsFactsPanel person={detail} />
              <RelationshipsConnectionsPanel person={detail} />
              <div className="xl:col-span-2">
                <RelationshipsConversationsPanel person={detail} />
              </div>
              <RelationshipsRelevantMemoriesPanel person={detail} />
              <RelationshipsUserPreferencesPanel person={detail} />
              <div className="xl:col-span-2">
                <RelationshipsDocumentsPanel person={detail} />
              </div>
            </div>
          ) : null}

          {!embedded ? (
            <>
              <RelationshipsCandidateMergesPanel
                graph={graph}
                onResolved={refreshGraph}
              />

              <PagePanel
                as="section"
                variant="surface"
                aria-label={t("relationships.activity", {
                  defaultValue: "Activity",
                })}
                className="px-3 py-3"
              >
                <div className="max-h-[24rem] overflow-auto pr-1">
                  <RelationshipsActivityFeed />
                </div>
              </PagePanel>
            </>
          ) : null}
        </>
      )}
    </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <PageLayout
      sidebar={
        <RelationshipsSidebar
          graph={graph}
          selectedPersonId={selectedPersonId}
          onSelectPersonId={setSelectedPersonId}
        />
      }
      contentHeader={contentHeader}
      data-testid="relationships-view"
    >
      {content}
    </PageLayout>
  );
}
