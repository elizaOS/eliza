import { PageLayout, PagePanel } from "@elizaos/ui";
import {
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { client } from "../../../api/client";
import type {
  RelationshipsGraphSnapshot,
  RelationshipsPersonDetail,
} from "../../../api/client-types-relationships";
import { useApp } from "../../../state";
import { RelationshipsGraphPanel } from "../RelationshipsGraphPanel";
import { RelationshipsActivityFeed } from "./RelationshipsActivityFeed";
import { RelationshipsCandidateMergesPanel } from "./RelationshipsCandidateMergesPanel";
import {
  RelationshipsConnectionsPanel,
  RelationshipsConversationsPanel,
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
  onViewMemories,
}: {
  contentHeader?: ReactNode;
  onViewMemories?: (entityIds: string[]) => void;
}) {
  const { t, setTab } = useApp();
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState<string>("all");
  const [graphLoading, setGraphLoading] = useState(true);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graph, setGraph] = useState<RelationshipsGraphSnapshot | null>(null);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detail, setDetail] = useState<RelationshipsPersonDetail | null>(null);
  const previousDetail = useRef<RelationshipsPersonDetail | null>(null);
  const deferredSearch = useDeferredValue(search);

  const loadGraph = useCallback(
    async (query = buildRelationshipsGraphQuery("", "all")) => {
      setGraphLoading(true);
      setGraphError(null);

      try {
        const snapshot = await client.getRelationshipsGraph(query);
        setGraph({
          ...snapshot,
          people: sortPeople(snapshot.people),
        });
      } catch (error) {
        setGraphError(
          error instanceof Error
            ? error.message
            : "Failed to load the relationships graph.",
        );
        setGraph(null);
      } finally {
        setGraphLoading(false);
      }
    },
    [],
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
      setSelectedPersonId(graph.people[0]?.primaryEntityId ?? null);
    }
  }, [graph, selectedPersonId]);

  const detailRef = useRef(detail);
  detailRef.current = detail;

  useEffect(() => {
    if (!selectedPersonId) {
      previousDetail.current = null;
      setDetail(null);
      return;
    }

    let cancelled = false;
    if (detailRef.current) {
      previousDetail.current = detailRef.current;
    }
    setDetailLoading(true);
    setDetailError(null);

    void client
      .getRelationshipsPerson(selectedPersonId)
      .then((person) => {
        if (!cancelled) {
          setDetail(person);
          previousDetail.current = null;
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setDetail(null);
          previousDetail.current = null;
          setDetailError(
            err instanceof Error
              ? err.message
              : "Failed to load the selected person.",
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
  }, [selectedPersonId]);

  const platforms = platformOptions(graph);
  const selectedSummary =
    graph?.people.find(
      (person) => person.primaryEntityId === selectedPersonId,
    ) ?? null;
  const selectedGroupId = selectedSummary?.groupId ?? null;
  const displayDetail =
    detail ?? (detailLoading ? previousDetail.current : null);
  const isStaleDetail =
    detailLoading && !detail && previousDetail.current !== null;
  const handleViewMemories =
    onViewMemories ??
    (() => {
      setTab("memories");
    });

  return (
    <PageLayout
      sidebar={
        <RelationshipsSidebar
          search={search}
          platform={platform}
          platforms={platforms}
          graph={graph}
          graphLoading={graphLoading}
          selectedPersonId={selectedPersonId}
          onSearchChange={setSearch}
          onSearchClear={() => setSearch("")}
          onPlatformChange={setPlatform}
          onRefreshGraph={() => {
            void loadGraph(
              buildRelationshipsGraphQuery(deferredSearch, platform),
            );
          }}
          onSelectPersonId={setSelectedPersonId}
        />
      }
      contentHeader={contentHeader}
      data-testid="relationships-view"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {graphError ? (
          <div className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {graphError}
          </div>
        ) : null}
        {detailError ? (
          <div className="rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            {detailError}
          </div>
        ) : null}

        {!graph && graphLoading ? (
          <PagePanel.Loading
            heading={t("common.loading", { defaultValue: "Loading…" })}
          />
        ) : !graph || graph.people.length === 0 ? (
          <PagePanel.Empty
            variant="panel"
            className="min-h-[24rem]"
            description="Connectors, relationships extraction, and confirmed identity links will populate this workspace."
            title="No relationships data available"
          />
        ) : (
          <>
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
              <PagePanel variant="surface" className="px-4 py-4">
                <RelationshipsGraphPanel
                  snapshot={graph}
                  selectedGroupId={selectedGroupId}
                  onSelectGroupId={(groupId) => {
                    const person = graph.people.find(
                      (entry) => entry.groupId === groupId,
                    );
                    if (person) {
                      setSelectedPersonId(person.primaryEntityId);
                    }
                  }}
                />
              </PagePanel>

              {displayDetail ? (
                <div
                  className={
                    isStaleDetail
                      ? "pointer-events-none opacity-50 transition-opacity duration-200"
                      : "transition-opacity duration-200"
                  }
                >
                  <RelationshipsPersonSummaryPanel
                    person={displayDetail}
                    onViewMemories={handleViewMemories}
                  />
                </div>
              ) : detailLoading ? (
                <PagePanel.Loading heading="Loading person detail…" />
              ) : (
                <PagePanel.Empty
                  variant="panel"
                  title="Select a person"
                  description="Choose a person in the left rail or graph to inspect linked identities, facts, and conversation snippets."
                />
              )}
            </div>

            {displayDetail ? (
              <div
                className={`grid gap-4 xl:grid-cols-2 ${isStaleDetail ? "pointer-events-none opacity-50 transition-opacity duration-200" : "transition-opacity duration-200"}`}
              >
                <RelationshipsFactsPanel person={displayDetail} />
                <RelationshipsConnectionsPanel person={displayDetail} />
                <div className="xl:col-span-2">
                  <RelationshipsConversationsPanel person={displayDetail} />
                </div>
                <RelationshipsRelevantMemoriesPanel person={displayDetail} />
                <RelationshipsUserPreferencesPanel person={displayDetail} />
              </div>
            ) : null}

            <RelationshipsCandidateMergesPanel
              graph={graph}
              onResolved={() => {
                void loadGraph(
                  buildRelationshipsGraphQuery(deferredSearch, platform),
                );
              }}
            />

            <PagePanel variant="surface" className="px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
                    Activity feed
                  </div>
                  <div className="mt-2 text-lg font-semibold text-txt">
                    Recent relationship, identity, and fact events
                  </div>
                </div>
              </div>
              <div className="mt-4">
                <RelationshipsActivityFeed />
              </div>
            </PagePanel>
          </>
        )}
      </div>
    </PageLayout>
  );
}
