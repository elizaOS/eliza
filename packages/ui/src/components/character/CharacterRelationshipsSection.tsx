import type { ReactNode } from "react";

export function CharacterRelationshipsSection({
  children,
}: {
  /** Legacy prop kept so existing callsites don't break; intentionally unused. */
  summary?: string;
  children: ReactNode;
}) {
  return <section className="flex min-w-0 flex-col gap-3">{children}</section>;
}
