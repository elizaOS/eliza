/**
 * Resolves the port the homepage e2e web server binds and the suite targets.
 *
 * The port used to be the literal 4444. Self-hosted CI puts 6-8 runners on one
 * host, so two homepage e2e jobs landing on the same machine raced for that
 * single port and the loser died instantly with "http://127.0.0.1:4444 is
 * already used" — a failure with no relationship to the diff under test.
 *
 * A runner executes at most one job at a time, so GitHub's per-runner
 * `RUNNER_NAME` is a collision-free discriminator: deriving a deterministic
 * offset from it gives every runner on a host its own port, with no
 * check-then-bind race (which a "find a free port" scan would reintroduce).
 * Locally, where no RUNNER_NAME exists, the historical 4444 is preserved.
 */

const BASE_PORT = 4444;
/** Ports BASE_PORT..BASE_PORT+SPAN-1; comfortably wider than runners per host. */
const SPAN = 64;

export function resolveHomepageE2ePort(env = process.env) {
  const explicit = env.HOMEPAGE_E2E_PORT?.trim();
  if (explicit) {
    const parsed = Number(explicit);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      throw new Error(
        `HOMEPAGE_E2E_PORT must be an integer between 1024 and 65535, received ${explicit}`,
      );
    }
    return parsed;
  }

  const runner = env.RUNNER_NAME?.trim();
  if (!runner) return BASE_PORT;

  // FNV-1a: stable across processes and Node versions, unlike hashCode-style
  // ad-hoc sums. The config and the web server must agree on the port, and
  // they compute it independently.
  let hash = 0x811c9dc5;
  for (let i = 0; i < runner.length; i += 1) {
    hash ^= runner.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return BASE_PORT + (hash % SPAN);
}

export function resolveHomepageE2eBaseUrl(env = process.env) {
  return `http://127.0.0.1:${resolveHomepageE2ePort(env)}`;
}
