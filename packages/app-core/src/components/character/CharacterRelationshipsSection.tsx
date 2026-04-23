import type { ReactNode } from "react";

export function CharacterRelationshipsSection({
  summary,
  children,
}: {
  summary?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-txt">Relationships</h2>
        <p className="text-sm text-muted">
          {summary ??
            "Browse the full relationship graph, inspect facts and memories, and review extracted information."}
        </p>
      </div>
      <div className="min-w-0 overflow-hidden rounded-2xl border border-border/40 bg-bg/70">
        {children}
      </div>
    </section>
  );
}
