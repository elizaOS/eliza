import type { ReactNode } from "react";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { RelationshipsWorkspaceView } from "./relationships/RelationshipsWorkspaceView";

export function RelationshipsView({
  contentHeader,
}: {
  contentHeader?: ReactNode;
} = {}) {
  return (
    <ShellViewAgentSurface viewId="relationships">
      <RelationshipsWorkspaceView contentHeader={contentHeader} />
    </ShellViewAgentSurface>
  );
}
