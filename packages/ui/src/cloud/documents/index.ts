/**
 * Documents (Knowledge) cloud domain — barrel + route/section registration.
 *
 * Lifted from `@elizaos/cloud-frontend/src/dashboard/documents/*` and its data
 * hook (`src/lib/data/agents.ts`). Documents is a per-character knowledge
 * surface (list / upload-file / upload-text / delete / semantic-query against
 * `/api/v1/documents`, characterId-scoped); the canonical home is an
 * agent-scoped view (PLAN §"`dashboard/documents` → AGENT-VIEW (Knowledge)").
 *
 *  - {@link DocumentsSection} is the zero-prop component Wave 3 hands to
 *    `registerSettingsSection({ id: "documents", Component: DocumentsSection })`
 *    or mounts as a standalone view.
 *  - {@link documentsCloudRoute} is registered **at import time** at
 *    `dashboard/documents`. Unlike `dashboard/api-keys`, this path has no
 *    `CloudRouterShell` redirect to shadow, so eager registration is safe and
 *    keeps the standalone deep link live. {@link registerDocumentsCloudRoute}
 *    is also exported for re-registration at a custom path if needed.
 */

import { lazy } from "react";
import {
  type CloudRouteDef,
  registerCloudRoute,
} from "../shell/cloud-route-registry";

export type { DocumentsPageCharacter } from "./components/documents-page-client";
export { DocumentsPageClient } from "./components/documents-page-client";
export { DocumentsSurface, default as DocumentsRoute } from "./DocumentsRoute";
export { DocumentsSection } from "./DocumentsSection";
export { type MyAgentCharacter, useMyAgents } from "./lib/agents";
export {
  type CloudDocument,
  type QueryResult,
  useDeleteDocument,
  useDocuments,
  useQueryDocuments,
  useUploadFiles,
  useUploadText,
} from "./lib/documents";

/** Stable view/section id + URL path slug for the Documents surface. */
export const DOCUMENTS_SECTION_ID = "documents";
export const DOCUMENTS_ROUTE_PATH = "dashboard/documents";

/** Lazy route element for the standalone Documents surface (code-split). */
const DocumentsRouteLazy = lazy(() => import("./DocumentsRoute"));

/** Cloud-route definition for the standalone Documents (Knowledge) surface. */
export const documentsCloudRoute: CloudRouteDef = {
  path: DOCUMENTS_ROUTE_PATH,
  element: DocumentsRouteLazy,
  group: "dashboard",
};

/**
 * Register (or re-register) the standalone Documents route. Exported for an
 * explicit custom-path mount; the default registration below runs at import
 * time since `dashboard/documents` has no shell redirect to collide with.
 */
export function registerDocumentsCloudRoute(
  override?: Partial<CloudRouteDef>,
): void {
  registerCloudRoute({ ...documentsCloudRoute, ...override });
}

registerDocumentsCloudRoute();
