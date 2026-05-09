import { Button, PageLayout, PagePanel } from "@elizaos/ui";
import { Filter, RefreshCw, Search, X } from "lucide-react";
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
import { useApp } from "../../../state/useApp";
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
  const graphRequestId = useRef(0);
  const deferredSearch = useDeferredValue(search);

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
            : "Failed to load the relationships graph.",
        );
        setGraph(null);
      } finally {
        if (requestId === graphRequestId.current) {
          setGraphLoading(false);
        }
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

  const toolbar = (
    <PagePanel variant="surface" className="px-3 py-3">
      <div className="flex flex-col gap-3">
        <div
          className={
            embedded
              ? "grid min-w-0 gap-2 md:grid-cols-[minmax(16rem,1fr)_minmax(12rem,14rem)_auto]"
              : "flex min-w-0 flex-col gap-2 sm:flex-row sm:justify-end"
          }
        >
          {embedded ? (
            <>
              <label className="sr-only" htmlFor="relationships-search">
                Search people, aliases, handles
              </label>
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                <input
                  id="relationships-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search"
                  aria-label="Search people, aliases, handles"
                  className="h-9 w-full rounded-lg border border-border/35 bg-card/45 pl-9 pr-10 text-sm text-txt outline-none transition focus:border-accent/55"
                />
                {search ? (
                  <button
                    type="button"
                    className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted transition hover:bg-bg-hover hover:text-txt"
                    onClick={() => setSearch("")}
                    aria-label="Clear relationship search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </>
          ) : null}

          <div className="relative min-w-0">
            <label className="sr-only" htmlFor="relationships-platform">
              Platform filter
            </label>
            <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <select
              id="relationships-platform"
              value={platform}
              onChange={(event) => setPlatform(event.target.value)}
              aria-label="Platform filter"
              className="h-9 w-full rounded-lg border border-border/35 bg-card/45 pl-9 pr-8 text-sm text-txt outline-none transition focus:border-accent/55"
            >
              <option value="all">All</option>
              {platforms.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </div>

          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 w-9 shrink-0 rounded-lg p-0"
            onClick={refreshGraph}
            aria-label="Refresh relationships"
          >
            <RefreshCw
              className={`h-4 w-4 ${graphLoading ? "animate-spin" : ""}`}
            />
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
      {detailError ? (
        <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          {detailError}
        </div>
      ) : null}

      {graphError && !graph ? (
        <PagePanel.Empty
          variant="panel"
          className={embedded ? "min-h-[18rem]" : "min-h-[24rem]"}
          title="Relationships failed to load"
          description={graphError}
        />
      ) : !graph && graphLoading ? (
        <PagePanel.Loading
          heading={t("common.loading", { defaultValue: "Loading..." })}
        />
      ) : !graph || graph.people.length === 0 ? (
        <PagePanel.Empty
          variant="panel"
          className={embedded ? "min-h-[18rem]" : "min-h-[24rem]"}
          description={
            search || platform !== "all"
              ? "No people match these filters."
              : "No relationship data yet."
          }
          title={
            search || platform !== "all"
              ? "No matching relationships"
              : "No relationships data available"
          }
        />
      ) : (
        <>
          {graphError ? (
            <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
              {graphError}
            </div>
          ) : null}
          <div
            className={
              embedded
                ? "grid min-h-0 gap-3"
                : "grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.65fr)]"
            }
          >
            <PagePanel variant="surface" className="px-3 py-3 sm:px-4 sm:py-4">
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
              <PagePanel.Loading heading="Loading person..." />
            ) : (
              <PagePanel.Empty
                variant="panel"
                title="Select a person"
                description="Choose a person from the list or graph."
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
                aria-label="Activity"
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
