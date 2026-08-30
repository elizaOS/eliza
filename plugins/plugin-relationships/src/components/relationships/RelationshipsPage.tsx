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
    <FramedPage gutterOwner="framed-page" reserveComposer={false}>
      {pageChrome}
      <FramedPageBody>
        <RelationshipsView />
      </FramedPageBody>
    </FramedPage>
  );
}
