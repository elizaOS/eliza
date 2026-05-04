import { WorkspaceLayout } from "../workspace-layout";
import type { PageLayoutProps } from "./page-layout-types";

export function PageLayout(props: PageLayoutProps) {
  return <WorkspaceLayout {...props} headerPlacement="outside" />;
}
