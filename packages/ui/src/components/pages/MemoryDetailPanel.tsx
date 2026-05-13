import { useApp } from "../../state";
import { PagePanel } from "../composites/page-panel";
import type { MemoryRecord } from "./vector-browser-utils";

export function MemoryDetailPanel({ memory }: { memory: MemoryRecord | null }) {
  const { t } = useApp();
  if (!memory) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="rounded-3xl border border-border/35 bg-bg/35 px-8 py-10 text-center shadow-inner">
          <div className="text-base font-semibold text-txt">
            {t("vectorbrowserview.MemoryDetail")}
          </div>
          <div className="mt-2 max-w-sm text-sm text-muted">
            {t("vectorbrowserview.MemorySelectionHint", {
              defaultValue:
                "Select a memory from the sidebar to inspect its content, metadata, and embedding values.",
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="px-6 py-5">
        <div className="text-2xs font-semibold uppercase tracking-[0.16em] text-muted/60">
          {t("common.vectors", { defaultValue: "Vectors" })}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold text-txt">
            {memory.type && memory.type !== "undefined"
              ? memory.type
              : t("vectorbrowserview.MemoryDetail")}
          </h2>
          {memory.unique ? (
            <span className="rounded-full border border-accent/30 bg-accent/12 px-3 py-1 text-xs-tight font-semibold uppercase tracking-[0.16em] text-accent-fg">
              {t("vectorbrowserview.Unique", { defaultValue: "Unique" })}
            </span>
          ) : null}
        </div>
        <div className="mt-2 text-sm text-muted">
          {memory.createdAt ||
            t("vectorbrowserview.NoTimestamp", {
              defaultValue: "No timestamp",
            })}{" "}
          {memory.id ? `· ${memory.id}` : ""}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-6">
        <PagePanel variant="inset" className="p-5">
          <div className="text-xs-tight font-bold uppercase tracking-[0.16em] text-muted/60">
            {t("vectorbrowserview.Content")}
          </div>
          <div className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-txt">
            {memory.content || "(empty)"}
          </div>
        </PagePanel>

        <section className="rounded-2xl border border-border/40 bg-card/45 p-5">
          <div className="text-xs-tight font-bold uppercase tracking-[0.16em] text-muted/60">
            {t("vectorbrowserview.Metadata")}
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <div className="text-xs-tight uppercase tracking-[0.16em] text-muted/60">
                {t("vectorbrowserview.ID", { defaultValue: "ID" })}
              </div>
              <div className="mt-1 break-all font-mono text-sm text-txt">
                {memory.id || "—"}
              </div>
            </div>
            <div>
              <div className="text-xs-tight uppercase tracking-[0.16em] text-muted/60">
                {t("common.type")}
              </div>
              <div className="mt-1 text-sm text-txt">{memory.type || "—"}</div>
            </div>
            <div>
              <div className="text-xs-tight uppercase tracking-[0.16em] text-muted/60">
                {t("vectorbrowserview.Room")}
              </div>
              <div className="mt-1 break-all font-mono text-sm text-txt">
                {memory.roomId || "—"}
              </div>
            </div>
            <div>
              <div className="text-xs-tight uppercase tracking-[0.16em] text-muted/60">
                {t("vectorbrowserview.Entity")}
              </div>
              <div className="mt-1 break-all font-mono text-sm text-txt">
                {memory.entityId || "—"}
              </div>
            </div>
          </div>
        </section>

        {memory.embedding ? (
          <section className="rounded-2xl border border-border/40 bg-card/45 p-5">
            <div className="text-xs-tight font-bold uppercase tracking-[0.16em] text-muted/60">
              {t("vectorbrowserview.Embedding")}
              {" · "}
              {memory.embedding.length} {t("vectorbrowserview.dimensions")}
            </div>
            <div className="mt-3 max-h-[16rem] overflow-auto rounded-xl border border-border/35 bg-bg/35 p-3 text-xs-tight leading-6 text-muted">
              [{memory.embedding.map((v) => v.toFixed(6)).join(", ")}]
            </div>
          </section>
        ) : null}

        <details className="rounded-2xl border border-border/40 bg-card/45 p-5">
          <summary className="cursor-pointer text-xs-tight font-bold uppercase tracking-[0.16em] text-muted/60 hover:text-txt">
            {t("vectorbrowserview.RawRecord")}
          </summary>
          <div className="mt-3 max-h-[18rem] overflow-auto rounded-xl border border-border/35 bg-bg/35 p-3 font-mono text-xs-tight leading-6 text-muted">
            {JSON.stringify(memory.raw, null, 2)}
          </div>
        </details>
      </div>
    </div>
  );
}
