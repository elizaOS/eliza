import type { ReactNode } from "react";

export function CharacterRelationshipsSection({
  summary,
  children,
}: {
  summary: string;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-txt">Relationships</h2>
        <p className="mt-1 text-sm text-muted">{summary}</p>
      </div>
      {children}
    </section>
  );
}
