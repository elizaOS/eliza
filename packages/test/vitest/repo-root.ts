import { resolveRepoRootFromImportMeta } from "../../packages/app-core/scripts/lib/repo-root.mjs";

export const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
