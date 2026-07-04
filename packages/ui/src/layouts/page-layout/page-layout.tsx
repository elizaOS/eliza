/**
 * PageLayout: a WorkspaceLayout with the header placed outside the content pane.
 */
import { WorkspaceLayout } from "../workspace-layout";
import type { PageLayoutProps } from "./page-layout-types";

export function PageLayout(props: PageLayoutProps) {
  return <WorkspaceLayout {...props} headerPlacement="outside" />;
}
