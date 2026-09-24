/**
 * Locator for real-mode source imports that live in a separate elizaOS
 * checkout (plugin-vision, plugin-computeruse, plugin-anthropic source
 * files that the published bundles do not export). The benchmarks repo is
 * standalone, so there is no valid relative path — real mode requires
 * ELIZA_REPO to point at a github.com/elizaOS/eliza checkout. Stub mode
 * never calls this.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";

export function elizaSourceUrl(relPath: string): string {
  const repo = process.env.ELIZA_REPO;
  if (!repo) {
    throw new Error(
      "[vision-cua-e2e] ELIZA_REPO is not set — real mode imports plugin source from an elizaOS checkout; set ELIZA_REPO to its root.",
    );
  }
  return pathToFileURL(join(repo, relPath)).href;
}
