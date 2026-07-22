/**
 * Compatibility export for app-core automation that consumes the repository's
 * fail-closed workspace resolver. Keeping this seam avoids two glob walkers
 * disagreeing about package membership or malformed manifests.
 */

export { collectWorkspaceMaps } from "../../../scripts/lib/workspaces.mjs";
