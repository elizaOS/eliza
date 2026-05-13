import type { QueryResult } from "../../api";
import { useApp } from "../../state";
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
  const { t } = useApp();

  return (
    <>
      <PagePanel variant="surface" as="section" className="px-5 py-5 sm:px-6">
        <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted">
          {t("common.database")}
        </div>
        <h1 className="mt-1 text-2xl font-semibold text-txt-strong">
          {t("databaseview.SQLEditor")}
        </h1>
      </PagePanel>

      <PagePanel variant="surface" className="mt-4 flex flex-col p-4">
        <div className="relative group">
          <div className="absolute -inset-[1px] bg-gradient-to-r from-accent/0 via-accent/30 to-accent/0 rounded-2xl opacity-0 group-focus-within:opacity-100 blur transition-opacity duration-500" />
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
            className="w-full relative bg-bg/80 backdrop-blur-md border-border/50 text-txt text-sm font-mono resize-y leading-relaxed rounded-xl focus-visible:ring-accent focus-visible:border-accent custom-scrollbar shadow-inner"
            spellCheck={false}
          />
        </div>
        <div className="flex items-center gap-3 mt-3">
          <Button
            variant="default"
            size="sm"
            className="h-auto min-h-[2.25rem] whitespace-normal break-words rounded-xl bg-accent px-6 py-1.5 text-left text-xs font-bold text-accent-fg shadow-[0_0_15px_rgba(var(--accent-rgb),0.4)] transition-[opacity,transform,box-shadow] hover:scale-[1.02] hover:opacity-90 disabled:opacity-40"
            disabled={queryLoading || !queryText.trim()}
            onClick={runQuery}
          >
            {queryLoading
              ? t("common.running", { defaultValue: "Running..." })
              : t("databaseview.runQuery", {
                  defaultValue: "Run Query",
                })}
          </Button>
          <kbd className="text-2xs text-muted font-mono bg-bg/50 px-2 py-1 rounded-md border border-border/30 shadow-inner tracking-wider">
            {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}{" "}
            {t("onboarding.enter")}
          </kbd>
          {queryResult && (
            <div className="text-xs text-muted ml-auto bg-bg/50 px-3 py-1.5 rounded-lg border border-border/30 font-medium shadow-inner tracking-wide">
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
        <div className="border border-border/40 bg-card/40 backdrop-blur-xl rounded-2xl shadow-sm overflow-hidden">
          <div className="px-4 py-2.5 text-2xs text-muted uppercase font-bold tracking-widest bg-bg/60 shadow-inner">
            {t("databaseview.RecentQueries")}
          </div>
          <div className="flex flex-col">
            {queryHistory.slice(0, 5).map((q) => (
              <Button
                variant="ghost"
                key={q}
                className="w-full px-4 py-3 h-auto justify-start text-xs-tight font-mono text-txt text-left rounded-none hover:bg-accent/10 hover:text-txt transition-colors truncate"
                onClick={() => setQueryText(q)}
              >
                <span className="truncate opacity-80 group-hover:opacity-100">
                  {q}
                </span>
              </Button>
            ))}
          </div>
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
        <PagePanel.Empty
          className="mt-4 min-h-[12rem]"
          title={t("databaseview.QueryReturnedNoRo")}
          description={t("databaseview.QueryReturnedNoRo")}
        />
      ) : null}
    </>
  );
}
