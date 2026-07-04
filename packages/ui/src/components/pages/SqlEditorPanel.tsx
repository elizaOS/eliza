/**
 * Presentational SQL editor panel for the Database view: a query textarea
 * (Cmd/Ctrl+Enter runs) plus the results grid rendered from a QueryResult. All
 * query state and execution are owned by the parent and passed in as props; this
 * component holds no data-fetching logic of its own.
 */

import { SearchX } from "lucide-react";
import type { QueryResult } from "../../api";
import { useAppSelector } from "../../state";
import { ChatEmptyStateWithRecommendations } from "../composites/chat";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ResultsGrid } from "./database-utils";

export function SqlEditorPanel({
  queryText,
  setQueryText,
  queryResult,
  queryLoading,
  runQuery,
  queryHistory,
  showHistory,
  onCellClick,
}: {
  queryText: string;
  setQueryText: (text: string) => void;
  queryResult: QueryResult | null;
  queryLoading: boolean;
  runQuery: () => void;
  queryHistory: string[];
  /** Show inline query history (used when there is no sidebar to display it). */
  showHistory: boolean;
  onCellClick: (value: string) => void;
}) {
  const t = useAppSelector((s) => s.t);

  return (
    <>
      <PagePanel variant="surface" className="flex flex-col p-4">
        <Textarea
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              runQuery();
            }
          }}
          placeholder={t("databaseview.SELECTFROMMemori")}
          rows={6}
          className="w-full bg-bg/95 border-border/50 text-txt text-sm font-mono resize-y leading-relaxed rounded-sm custom-scrollbar"
          spellCheck={false}
        />
        <div className="flex items-center gap-3 mt-3">
          <Button
            variant="default"
            size="sm"
            disabled={queryLoading || !queryText.trim()}
            onClick={runQuery}
          >
            {queryLoading
              ? t("common.running", { defaultValue: "Running..." })
              : t("databaseview.runQuery", {
                  defaultValue: "Run Query",
                })}
          </Button>
          <kbd className="text-2xs text-muted font-mono px-2 py-1 tracking-wider">
            {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}{" "}
            {t("common.enter")}
          </kbd>
          {queryResult && (
            <div className="text-xs text-muted ml-auto font-medium">
              <span className="text-txt">{queryResult.rowCount}</span>{" "}
              {queryResult.rowCount === 1
                ? t("databaseview.row")
                : t("common.rows")}{" "}
              · <span className="text-txt">{queryResult.durationMs}ms</span>
            </div>
          )}
        </div>
      </PagePanel>

      {/* Inline query history (standalone layout only) */}
      {showHistory && queryHistory.length > 0 && !queryResult && (
        <div className="mt-4 flex flex-col gap-1">
          <div className="px-1 text-xs-tight font-medium text-muted">
            {t("databaseview.RecentQueries")}
          </div>
          {queryHistory.slice(0, 5).map((q) => (
            <Button
              variant="ghost"
              key={q}
              className="h-auto w-full justify-start rounded-sm px-3 py-2 text-left text-xs-tight font-mono text-muted-strong hover:text-txt"
              onClick={() => setQueryText(q)}
            >
              <span className="truncate">{q}</span>
            </Button>
          ))}
        </div>
      )}

      {queryResult && queryResult.rows.length > 0 ? (
        <PagePanel
          variant="surface"
          className="mt-4 flex flex-1 min-h-0 flex-col overflow-hidden p-3"
        >
          <ResultsGrid
            columns={queryResult.columns}
            rows={queryResult.rows}
            onCellClick={onCellClick}
          />
        </PagePanel>
      ) : null}

      {queryResult && queryResult.rows.length === 0 ? (
        <ChatEmptyStateWithRecommendations
          className="mt-4 min-h-[12rem]"
          icon={SearchX}
          title={t("databaseview.QueryReturnedNoRo")}
          recommendations={[
            t("databaseview.TrySelectCountRec", {
              defaultValue: "Try SELECT COUNT(*)",
            }),
            t("databaseview.CheckLimitRec", {
              defaultValue: "Check your LIMIT clause",
            }),
            t("databaseview.RunOnDifferentTableRec", {
              defaultValue: "Run on a different table",
            }),
          ]}
        />
      ) : null}
    </>
  );
}
