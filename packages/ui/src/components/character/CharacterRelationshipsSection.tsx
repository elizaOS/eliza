import type { ReactNode } from "react";

export function CharacterRelationshipsSection({
  children,
}: {
  children: ReactNode;
}) {
  return <section className="flex min-w-0 flex-col gap-3">{children}</section>;
}
