/** Load a public package API from the checkout selected for real-mode measurement. */
import { importMeasuredPackage } from "../../../../lib/target-package.ts";

export function importElizaPackage<T>(specifier: string): Promise<T> {
  const repo =
    process.env.ELIZA_REPO_DIR?.trim() || process.env.ELIZA_REPO?.trim();
  if (!repo)
    throw new Error(
      "[vision-cua-e2e] Set ELIZA_REPO_DIR to the checkout being measured.",
    );
  return importMeasuredPackage<T>(repo, specifier);
}
