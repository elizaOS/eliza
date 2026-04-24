import { Button, MetaPill, PageLayout, PagePanel } from "@elizaos/ui";
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
  embedded = false,
  onViewMemories,
}: {
  contentHeader?: ReactNode;
  embedded?: boolean;
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

  const refreshGraph = () => {
    void loadGraph(buildRelationshipsGraphQuery(deferredSearch, platform));
  };

  const toolbar = (
    <PagePanel variant="surface" className="px-3 py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
          <MetaPill compact>{graph?.stats.totalPeople ?? 0} people</MetaPill>
          <MetaPill compact>
            {graph?.stats.totalRelationships ?? 0} links
          </MetaPill>
          <MetaPill compact>
            {graph?.stats.totalIdentities ?? 0} identities
          </MetaPill>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row lg:max-w-3xl">
          {embedded ? (
            <>
              <label className="sr-only" htmlFor="relationships-search">
                Search people, aliases, handles
              </label>
              <div className="relative min-w-0 flex-1">
                <input
                  id="relationships-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search people, aliases, handles"
                  aria-label="Search people, aliases, handles"
                  className="h-9 w-full rounded-lg border border-border/35 bg-card/45 px-3 pr-16 text-sm text-txt outline-none transition focus:border-accent/55"
                />
                {search ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="absolute right-1 top-1 h-7 rounded-md px-2 text-2xs"
                    onClick={() => setSearch("")}
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}

          <label className="sr-only" htmlFor="relationships-platform">
            Platform filter
          </label>
          <select
            id="relationships-platform"
            value={platform}
            onChange={(event) => setPlatform(event.target.value)}
            aria-label="Platform filter"
            className="h-9 rounded-lg border border-border/35 bg-card/45 px-3 text-sm text-txt outline-none transition focus:border-accent/55"
          >
            <option value="all">All platforms</option>
            {platforms.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>

          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 shrink-0 rounded-lg px-3"
            onClick={refreshGraph}
          >
            {graphLoading ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </div>
    </PagePanel>
  );

  const content = (
    <div
      className={`flex min-h-0 flex-1 flex-col ${embedded ? "gap-3" : "gap-4"}`}
      data-testid={embedded ? "relationships-embedded-view" : undefined}
    >
      {toolbar}
      {graphError ? (
        <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {graphError}
        </div>
      ) : null}
      {detailError ? (
        <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          {detailError}
        </div>
      ) : null}

      {!graph && graphLoading ? (
        <PagePanel.Loading
          heading={t("common.loading", { defaultValue: "Loading..." })}
        />
      ) : !graph || graph.people.length === 0 ? (
        <PagePanel.Empty
          variant="panel"
          className={embedded ? "min-h-[18rem]" : "min-h-[24rem]"}
          description={
            search || platform !== "all"
              ? "No people match the current relationship filters."
              : "Connectors, relationships extraction, and confirmed identity links will populate this workspace."
          }
          title={
            search || platform !== "all"
              ? "No matching relationships"
              : "No relationships data available"
          }
        />
      ) : (
        <>
          <div
            className={
              embedded
                ? "grid min-h-0 gap-3 xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,0.75fr)]"
                : "grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.65fr)]"
            }
          >
            <PagePanel variant="surface" className="px-3 py-3 sm:px-4 sm:py-4">
              <RelationshipsGraphPanel
                snapshot={graph}
                selectedGroupId={selectedGroupId}
                compact={embedded}
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
                  compact={embedded}
                  onViewMemories={handleViewMemories}
                />
              </div>
            ) : detailLoading ? (
              <PagePanel.Loading heading="Loading person detail..." />
            ) : (
              <PagePanel.Empty
                variant="panel"
                title="Select a person"
                description="Choose a person from the list or graph to inspect linked identities, facts, and conversation snippets."
              />
            )}
          </div>

          {displayDetail ? (
            <div
              className={`grid gap-3 xl:grid-cols-2 ${isStaleDetail ? "pointer-events-none opacity-50 transition-opacity duration-200" : "transition-opacity duration-200"}`}
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

          {!embedded ? (
            <>
              <RelationshipsCandidateMergesPanel
                graph={graph}
                onResolved={refreshGraph}
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
                <div className="mt-4 max-h-[24rem] overflow-auto pr-1">
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
          search={search}
          graph={graph}
          selectedPersonId={selectedPersonId}
          onSearchChange={setSearch}
          onSearchClear={() => setSearch("")}
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
