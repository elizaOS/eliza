/**
 * Exposes the plugin-owned Relationships body to its registered app-shell
 * surface. The host owns Character-family page chrome so local and remote
 * renderers share one header and tab contract.
 */

import { FramedPage, FramedPageBody } from "@elizaos/ui/layouts";
import type { JSX, ReactNode } from "react";
import { RelationshipsView } from "./RelationshipsView.tsx";

export function RelationshipsPage({
  pageChrome,
}: {
  pageChrome?: ReactNode;
}): JSX.Element {
  return (
    <FramedPage reserveComposer={false}>
      {pageChrome}
      <FramedPageBody
        padded={false}
        className="[@media(min-width:768px)_and_(min-height:600px)]:px-6 lg:px-8"
      >
        <RelationshipsView />
      </FramedPageBody>
    </FramedPage>
  );
}
