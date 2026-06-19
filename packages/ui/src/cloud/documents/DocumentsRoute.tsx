/**
 * Documents (Knowledge) cloud route entry.
 *
 * Lifted from `@elizaos/cloud-frontend/src/dashboard/documents/Page.tsx`. Gates
 * on the Steward session, loads the caller's characters with {@link useMyAgents}
 * (the per-character scope selector), and renders {@link DocumentsPageClient}.
 * Loading uses the cloud-ui dashboard placeholder; the page title is set via
 * {@link useDocumentTitle} (no Helmet).
 *
 * The same {@link DocumentsSurface} is exported for both the registered
 * standalone route and the Wave-3 settings-section wrapper (see `index.ts`).
 */

import { DashboardLoadingState } from "../../cloud-ui/components/dashboard/route-placeholders";
import { useCloudT } from "../shell/CloudI18nProvider";
import {
  type DocumentsPageCharacter,
  DocumentsPageClient,
} from "./components/documents-page-client";
import { useMyAgents } from "./lib/agents";
import { useRequireAuth } from "./lib/use-session-auth";
import { useDocumentTitle } from "./use-document-title";

/**
 * The Documents/Knowledge surface. Embeddable: used directly by the Wave-3
 * settings section and wrapped by {@link DocumentsRoute} for the standalone
 * route.
 */
export function DocumentsSurface() {
  const t = useCloudT();
  const { ready, authenticated } = useRequireAuth();
  const agentsQuery = useMyAgents();

  useDocumentTitle(
    t("cloud.documents.metaTitle", { defaultValue: "Knowledge" }),
  );

  const loadingLabel = t("cloud.documents.loading", {
    defaultValue: "Loading Knowledge",
  });

  if (!ready || !authenticated) {
    return <DashboardLoadingState label={loadingLabel} />;
  }

  if (agentsQuery.isLoading) {
    return <DashboardLoadingState label={loadingLabel} />;
  }

  const characters: DocumentsPageCharacter[] =
    agentsQuery.data?.map((a) => ({ id: a.id, name: a.name })) ?? [];

  return <DocumentsPageClient initialCharacters={characters} />;
}

/** Default export consumed by the cloud-route registry. */
export default function DocumentsRoute() {
  return <DocumentsSurface />;
}
