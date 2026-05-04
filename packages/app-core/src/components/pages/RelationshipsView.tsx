import type { ReactNode } from "react";
import { RelationshipsWorkspaceView } from "./relationships/RelationshipsWorkspaceView";

export function RelationshipsView({
  contentHeader,
}: {
  contentHeader?: ReactNode;
} = {}) {
  return <RelationshipsWorkspaceView contentHeader={contentHeader} />;
}
