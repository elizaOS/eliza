export const HOMEPAGE_ROOT_PR_IGNORES = Object.freeze([
  "visual.spec.ts",
  "contact-sheet-capture.spec.ts",
]);

/**
 * Homepage screenshot baselines and contact sheets are authoritative in the
 * homepage deployment lane. Root PR smoke keeps every functional/readiness
 * spec, but omits those duplicate GPU-heavy evidence captures so the shared
 * two-hour smoke job can complete and report its functional result.
 */
export function resolveHomepageTestIgnore(env = process.env) {
  return env.TEST_LANE === "pr" ? [...HOMEPAGE_ROOT_PR_IGNORES] : undefined;
}
