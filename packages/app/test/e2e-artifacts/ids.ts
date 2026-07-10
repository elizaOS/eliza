/**
 * Test-identity helpers shared by the artifact reporter and the capture
 * fixtures. Both sides must derive the exact same test id — the reporter names
 * the on-disk `tests/<id>/` bundle with it, and the fixtures inject it into the
 * page (`window.__ELIZA_E2E.testId`) so out-of-band producers (the PostHog
 * sink) land their artifacts in the same bundle. Keeping the derivation here is
 * what guarantees the two never drift.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** packages/app/test/e2e-artifacts → repo root. */
export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

/** Lane tag for this Playwright invocation (one lane = one config run). */
export function resolveLane(): string {
  return process.env.ELIZA_E2E_LANE ?? "app-ui-smoke";
}

/**
 * `<lane>:<repo-relative spec file>:<title path joined with ' > '>`. The title
 * path includes the Playwright project name, so the same spec running under
 * two projects (e.g. chromium + desktop-webkit) gets two distinct bundles.
 */
export function buildTestId(
  lane: string,
  specFile: string,
  titlePath: readonly string[],
): string {
  const relFile = path.relative(repoRoot, specFile);
  const titles = titlePath.filter((segment) => segment.length > 0);
  return `${lane}:${relFile}:${titles.join(" > ")}`;
}
