import { resolveRepoRoot } from "../../../scripts/lib/repo-root.mjs";

/** Milady checkout root (contains `apps/`, `eliza/`, `package.json`). */
export const repoRoot = resolveRepoRoot(import.meta.url, 3);
