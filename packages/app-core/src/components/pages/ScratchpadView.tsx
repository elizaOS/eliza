import { Button, PagePanel } from "@elizaos/ui";
import { Plus, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api/client";
import type {
  ScratchpadSummaryPreviewResponse,
  ScratchpadTopicDto,
  ScratchpadTopicSearchResultDto,
} from "../../api/client-types-chat";
import { useApp } from "../../state/useApp";
import { ConfirmDeleteControl } from "../shared/confirm-delete-control";

type ScratchpadDraft = {
  title: string;
  text: string;
};

type ScratchpadLimits = {
  count: number;
  maxTopics: number;
  maxTokensPerTopic: number;
};

const EMPTY_DRAFT: ScratchpadDraft = {
  title: "",
  text: "",
};

function formatScratchpadTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function upsertTopic(
  topics: ScratchpadTopicDto[],
  topic: ScratchpadTopicDto,
): ScratchpadTopicDto[] {
  const existingIndex = topics.findIndex((item) => item.id === topic.id);
  if (existingIndex === -1) {
    return [topic, ...topics];
  }
  return topics.map((item) => (item.id === topic.id ? topic : item));
}

function ScratchpadTopicListItem({
  active,
  matchCount,
  onSelect,
  topic,
}: {
  active: boolean;
  matchCount?: number;
  onSelect: (topicId: string) => void;
  topic: ScratchpadTopicDto;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(topic.id)}
      className={`group flex w-full items-start gap-3 px-3 py-3 text-left transition-colors ${
        active ? "bg-accent/8" : "bg-transparent hover:bg-white/[0.03]"
      }`}
    >
      <span
        className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
          active ? "bg-accent" : "bg-border"
        }`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold leading-snug text-txt">
          {topic.title}
        </span>
        <span className="mt-1 block line-clamp-2 text-xs text-muted">
          {topic.summary}
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs text-muted/70">
          <span>{topic.tokenCount} tokens</span>
          <span>/</span>
          <span>{topic.fragmentCount} fragments</span>
          {matchCount !== undefined ? (
            <>
              <span>/</span>
              <span>{matchCount} matches</span>
            </>
          ) : null}
        </span>
      </span>
    </button>
  );
}

export function ScratchpadView() {
  const { setActionNotice, t } = useApp();
  const [topics, setTopics] = useState<ScratchpadTopicDto[]>([]);
  const [limits, setLimits] = useState<ScratchpadLimits | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScratchpadDraft>(EMPTY_DRAFT);
  const [creatingNew, setCreatingNew] = useState(true);
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingTopicId, setDeletingTopicId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    ScratchpadTopicSearchResultDto[] | null
  >(null);
  const [preview, setPreview] =
    useState<ScratchpadSummaryPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setActionNoticeRef = useRef(setActionNotice);
  const selectedTopicIdRef = useRef<string | null>(null);
  setActionNoticeRef.current = setActionNotice;
  selectedTopicIdRef.current = selectedTopicId;

  const selectedTopic = useMemo(
    () => topics.find((topic) => topic.id === selectedTopicId) ?? null,
    [selectedTopicId, topics],
  );
  const isAtTopicCap =
    limits !== null && limits.count >= limits.maxTopics && creatingNew;
  const visibleResults = searchResults ?? [];
  const tokenCount =
    preview?.tokenCount ??
    (!creatingNew &&
    selectedTopic &&
    draft.title === selectedTopic.title &&
    draft.text === selectedTopic.text
      ? selectedTopic.tokenCount
      : null);
  const serverSummary =
    preview?.summary ??
    (!creatingNew && selectedTopic && draft.text === selectedTopic.text
      ? selectedTopic.summary
      : null);
  const canSave =
    draft.title.trim().length > 0 &&
    draft.text.trim().length > 0 &&
    !saving &&
    !isAtTopicCap &&
    previewError === null;

  const startNewTopic = useCallback(() => {
    if (limits && limits.count >= limits.maxTopics) return;
    setCreatingNew(true);
    setSelectedTopicId(null);
    setDraft(EMPTY_DRAFT);
    setPreview(null);
    setPreviewError(null);
    setError(null);
  }, [limits]);

  const loadTopics = useCallback(
    async (preferredTopicId?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const response = await client.listScratchpadTopics();
        setTopics(response.topics);
        setLimits({
          count: response.count,
          maxTopics: response.maxTopics,
          maxTokensPerTopic: response.maxTokensPerTopic,
        });

        const selectedId =
          preferredTopicId === undefined
            ? selectedTopicIdRef.current
            : preferredTopicId;
        const nextSelectedId =
          selectedId && response.topics.some((topic) => topic.id === selectedId)
            ? selectedId
            : (response.topics[0]?.id ?? null);

        if (nextSelectedId) {
          setCreatingNew(false);
          setSelectedTopicId(nextSelectedId);
        } else {
          setCreatingNew(true);
          setSelectedTopicId(null);
          setDraft(EMPTY_DRAFT);
        }
      } catch (err) {
        const message = getErrorMessage(
          err,
          t("scratchpadview.FailedToLoad", {
            defaultValue: "Failed to load scratchpad topics.",
          }),
        );
        setError(message);
        setActionNoticeRef.current(message, "error");
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void loadTopics(null);
  }, [loadTopics]);

  useEffect(() => {
    if (creatingNew || !selectedTopicId) return;

    let cancelled = false;
    setReading(true);
    setError(null);
    setPreview(null);
    setPreviewError(null);
    void client
      .getScratchpadTopic(selectedTopicId)
      .then((response) => {
        if (cancelled) return;
        setTopics((currentTopics) =>
          upsertTopic(currentTopics, response.topic),
        );
        setDraft({
          title: response.topic.title,
          text: response.topic.text,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = getErrorMessage(
          err,
          t("scratchpadview.FailedToRead", {
            defaultValue: "Failed to read scratchpad topic.",
          }),
        );
        setError(message);
        setActionNoticeRef.current(message, "error");
      })
      .finally(() => {
        if (!cancelled) setReading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [creatingNew, selectedTopicId, t]);

  useEffect(() => {
    const text = draft.text.trim();
    const selectedTextIsUnchanged =
      !creatingNew &&
      selectedTopic !== null &&
      draft.title === selectedTopic.title &&
      draft.text === selectedTopic.text;

    if (!text || selectedTextIsUnchanged) {
      setPreview(null);
      setPreviewError(null);
      setPreviewing(false);
      return;
    }

    let cancelled = false;
    setPreviewing(true);
    setPreviewError(null);
    const timer = window.setTimeout(() => {
      void client
        .previewScratchpadSummary({ text })
        .then((response) => {
          if (cancelled) return;
          setPreview(response);
        })
        .catch((err) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(
            getErrorMessage(
              err,
              t("scratchpadview.FailedToPreview", {
                defaultValue: "Failed to preview scratchpad size.",
              }),
            ),
          );
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [creatingNew, draft.text, draft.title, selectedTopic, t]);

  const handleSelectTopic = useCallback((topicId: string) => {
    setCreatingNew(false);
    setSelectedTopicId(topicId);
    setError(null);
  }, []);

  const handleSearch = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      const query = searchQuery.trim();
      if (!query) {
        setSearchResults(null);
        return;
      }

      setSearching(true);
      setError(null);
      try {
        const response = await client.searchScratchpadTopics(query, {
          limit: limits?.maxTopics,
        });
        setSearchResults(response.results);
      } catch (err) {
        const message = getErrorMessage(
          err,
          t("scratchpadview.SearchFailed", {
            defaultValue: "Scratchpad search failed.",
          }),
        );
        setError(message);
        setActionNoticeRef.current(message, "error");
      } finally {
        setSearching(false);
      }
    },
    [limits?.maxTopics, searchQuery, t],
  );

  const handleSave = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!canSave) return;

      setSaving(true);
      setError(null);
      try {
        const response =
          creatingNew || !selectedTopicId
            ? await client.createScratchpadTopic({
                title: draft.title,
                text: draft.text,
              })
            : await client.replaceScratchpadTopic(selectedTopicId, {
                title: draft.title,
                text: draft.text,
              });
        setTopics((currentTopics) =>
          upsertTopic(currentTopics, response.topic),
        );
        setCreatingNew(false);
        setSelectedTopicId(response.topic.id);
        setDraft({
          title: response.topic.title,
          text: response.topic.text,
        });
        setPreview(null);
        setPreviewError(null);
        setActionNotice(
          creatingNew
            ? t("scratchpadview.TopicCreated", {
                defaultValue: "Scratchpad topic created.",
              })
            : t("scratchpadview.TopicUpdated", {
                defaultValue: "Scratchpad topic updated.",
              }),
          "success",
        );
        await loadTopics(response.topic.id);
      } catch (err) {
        const message = getErrorMessage(
          err,
          t("scratchpadview.SaveFailed", {
            defaultValue: "Failed to save scratchpad topic.",
          }),
        );
        setError(message);
        setActionNotice(message, "error");
      } finally {
        setSaving(false);
      }
    },
    [
      canSave,
      creatingNew,
      draft.text,
      draft.title,
      loadTopics,
      selectedTopicId,
      setActionNotice,
      t,
    ],
  );

  const handleDelete = useCallback(async () => {
    if (!selectedTopicId) return;

    setDeletingTopicId(selectedTopicId);
    setError(null);
    try {
      await client.deleteScratchpadTopic(selectedTopicId);
      setTopics((currentTopics) =>
        currentTopics.filter((topic) => topic.id !== selectedTopicId),
      );
      setDraft(EMPTY_DRAFT);
      setPreview(null);
      setPreviewError(null);
      setSelectedTopicId(null);
      setCreatingNew(true);
      setActionNotice(
        t("scratchpadview.TopicDeleted", {
          defaultValue: "Scratchpad topic deleted.",
        }),
        "success",
      );
      await loadTopics(null);
    } catch (err) {
      const message = getErrorMessage(
        err,
        t("scratchpadview.DeleteFailed", {
          defaultValue: "Failed to delete scratchpad topic.",
        }),
      );
      setError(message);
      setActionNotice(message, "error");
    } finally {
      setDeletingTopicId(null);
    }
  }, [loadTopics, selectedTopicId, setActionNotice, t]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4"
      data-testid="scratchpad-view"
    >
      {error ? (
        <PagePanel.Notice tone="danger">{error}</PagePanel.Notice>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <div className="order-2 flex min-w-0 flex-1 flex-col lg:order-1">
          <PagePanel
            variant="inset"
            className="flex min-h-0 flex-1 flex-col gap-4 p-4 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-bold text-txt">
                  {creatingNew
                    ? t("scratchpadview.NewTopic", {
                        defaultValue: "New scratchpad topic",
                      })
                    : (selectedTopic?.title ??
                      t("scratchpadview.SelectedTopic", {
                        defaultValue: "Scratchpad topic",
                      }))}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  {tokenCount !== null && limits ? (
                    <span>
                      {tokenCount} / {limits.maxTokensPerTopic} tokens
                    </span>
                  ) : null}
                  {previewing ? (
                    <span className="inline-flex items-center gap-1">
                      <RefreshCw
                        className="h-3 w-3 animate-spin"
                        aria-hidden="true"
                      />
                      {t("scratchpadview.Counting", {
                        defaultValue: "Counting",
                      })}
                    </span>
                  ) : null}
                  {!creatingNew && selectedTopic ? (
                    <span>
                      {t("scratchpadview.UpdatedAt", {
                        defaultValue: "Updated {{date}}",
                        date: formatScratchpadTimestamp(
                          selectedTopic.updatedAt,
                        ),
                      })}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={startNewTopic}
                  disabled={limits !== null && limits.count >= limits.maxTopics}
                  className="gap-1.5 px-3 text-xs"
                  title={t("scratchpadview.NewTopic", {
                    defaultValue: "New scratchpad topic",
                  })}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("common.new", { defaultValue: "New" })}
                </Button>
                {!creatingNew && selectedTopicId ? (
                  <ConfirmDeleteControl
                    triggerLabel={
                      <span className="inline-flex items-center gap-1.5">
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        {t("common.delete", { defaultValue: "Delete" })}
                      </span>
                    }
                    triggerClassName="h-8 rounded-lg border border-danger/25 px-3 text-xs font-bold !bg-transparent text-danger transition-all hover:!bg-danger/12"
                    confirmClassName="h-8 rounded-lg border border-danger/25 bg-danger/14 px-3 text-xs font-bold text-danger transition-all hover:bg-danger/20"
                    cancelClassName="h-8 rounded-lg border border-border/35 px-3 text-xs font-bold text-muted-strong transition-all hover:border-border-strong hover:text-txt"
                    disabled={deletingTopicId === selectedTopicId}
                    busyLabel="..."
                    onConfirm={handleDelete}
                    triggerTitle={t("scratchpadview.DeleteTopic", {
                      defaultValue: "Delete scratchpad topic",
                    })}
                  />
                ) : null}
              </div>
            </div>

            {isAtTopicCap ? (
              <PagePanel.Notice tone="warning">
                {t("scratchpadview.TopicLimitReached", {
                  defaultValue: "Scratchpad topic limit reached.",
                })}
              </PagePanel.Notice>
            ) : null}

            <form
              className="flex min-h-0 flex-1 flex-col gap-3"
              onSubmit={handleSave}
            >
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted/70">
                  {t("scratchpadview.Title", { defaultValue: "Title" })}
                </span>
                <input
                  type="text"
                  value={draft.title}
                  onChange={(event) =>
                    setDraft((currentDraft) => ({
                      ...currentDraft,
                      title: event.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-border/50 bg-bg px-3 py-2 text-sm text-txt placeholder:text-muted/50 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30"
                  disabled={reading || saving}
                />
              </label>

              <label className="flex min-h-0 flex-1 flex-col gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted/70">
                  {t("scratchpadview.Text", { defaultValue: "Text" })}
                </span>
                <textarea
                  value={draft.text}
                  onChange={(event) =>
                    setDraft((currentDraft) => ({
                      ...currentDraft,
                      text: event.target.value,
                    }))
                  }
                  className="custom-scrollbar min-h-[18rem] flex-1 resize-none rounded-lg border border-border/50 bg-bg px-3 py-2 text-sm leading-6 text-txt placeholder:text-muted/50 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30"
                  disabled={reading || saving}
                />
              </label>

              <div className="min-h-6 text-xs text-muted">
                {previewError ? (
                  <span className="text-danger">{previewError}</span>
                ) : serverSummary ? (
                  <span>{serverSummary}</span>
                ) : null}
              </div>

              <div className="flex justify-end">
                <Button
                  type="submit"
                  size="sm"
                  disabled={!canSave}
                  className="gap-1.5 px-3 text-xs"
                >
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  {saving
                    ? t("common.saving", { defaultValue: "Saving..." })
                    : t("common.save", { defaultValue: "Save" })}
                </Button>
              </div>
            </form>
          </PagePanel>
        </div>

        <div className="order-1 flex w-full shrink-0 flex-col gap-3 lg:order-2 lg:w-[22rem] xl:w-[24rem]">
          <PagePanel
            variant="inset"
            className="flex flex-1 flex-col overflow-hidden p-2.5 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
          >
            <div className="mb-2 flex items-center justify-between gap-3 px-1">
              <div className="min-w-0 text-xs font-semibold uppercase tracking-[0.12em] text-muted/70">
                {searchResults
                  ? t("scratchpadview.SearchResults", {
                      defaultValue: "Search results",
                    })
                  : t("scratchpadview.Topics", { defaultValue: "Topics" })}
              </div>
              <div className="shrink-0 text-2xs text-muted">
                {limits
                  ? t("scratchpadview.TopicCount", {
                      defaultValue: "{{count}} / {{max}} topics",
                      count: limits.count,
                      max: limits.maxTopics,
                    })
                  : null}
              </div>
            </div>

            <form className="relative" onSubmit={handleSearch}>
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t("scratchpadview.SearchPlaceholder", {
                  defaultValue: "Search scratchpad",
                })}
                className="w-full rounded-lg border border-border/50 bg-bg px-3 py-2 pl-9 pr-20 text-sm text-txt placeholder:text-muted/50 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
              <Search
                className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted/50"
                aria-hidden="true"
              />
              <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
                {searchResults || searchQuery ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery("");
                      setSearchResults(null);
                    }}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-white/[0.04] hover:text-txt"
                    aria-label={t("common.clear", { defaultValue: "Clear" })}
                    title={t("common.clear", { defaultValue: "Clear" })}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                ) : null}
                <button
                  type="submit"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-white/[0.04] hover:text-txt"
                  aria-label={t("common.search", { defaultValue: "Search" })}
                  title={t("common.search", { defaultValue: "Search" })}
                  disabled={searching}
                >
                  <Search
                    className={`h-3.5 w-3.5 ${searching ? "animate-pulse" : ""}`}
                    aria-hidden="true"
                  />
                </button>
              </div>
            </form>

            <div className="custom-scrollbar mt-2 flex min-h-[18rem] flex-1 flex-col gap-1.5 overflow-y-auto px-0.5 py-0.5">
              {loading && topics.length === 0 ? (
                <PagePanel.Empty
                  variant="inset"
                  className="min-h-[12rem] px-0 py-8 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
                  title={t("scratchpadview.LoadingTopics", {
                    defaultValue: "Loading topics",
                  })}
                />
              ) : null}

              {!loading && !searchResults && topics.length === 0 ? (
                <PagePanel.Empty
                  variant="inset"
                  className="min-h-[12rem] px-0 py-8 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
                  title={t("scratchpadview.NoTopics", {
                    defaultValue: "No scratchpad topics",
                  })}
                />
              ) : null}

              {searchResults && visibleResults.length === 0 ? (
                <PagePanel.Empty
                  variant="inset"
                  className="min-h-[12rem] px-0 py-8 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
                  title={t("scratchpadview.NoSearchResults", {
                    defaultValue: "No matching topics",
                  })}
                />
              ) : null}

              {searchResults
                ? visibleResults.map((result) => (
                    <ScratchpadTopicListItem
                      key={result.topic.id}
                      topic={result.topic}
                      active={selectedTopicId === result.topic.id}
                      matchCount={result.matches.length}
                      onSelect={handleSelectTopic}
                    />
                  ))
                : topics.map((topic) => (
                    <ScratchpadTopicListItem
                      key={topic.id}
                      topic={topic}
                      active={selectedTopicId === topic.id}
                      onSelect={handleSelectTopic}
                    />
                  ))}
            </div>
          </PagePanel>
        </div>
      </div>
    </div>
  );
}
