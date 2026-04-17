import { ContentLayout } from "@elizaos/ui";
import type { ReactNode } from "react";
import { LogsView } from "./LogsView";

export function LogsPageView({
  contentHeader,
  inModal,
}: {
  contentHeader?: ReactNode;
  inModal?: boolean;
} = {}) {
  return (
    <ContentLayout contentHeader={contentHeader} inModal={inModal}>
      <LogsView />
    </ContentLayout>
  );
}
