/**
 * Resolves a deterministic homepage e2e port shared by Playwright and its Vite process.
 * Co-hosted self-hosted runners use a dedicated CI range; local runs retain the
 * conventional homepage port, and explicit overrides support other environments.
 */

const LOCAL_PORT = 4444;
const CI_BASE_PORT = 24_000;
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
  if (!runner) return LOCAL_PORT;

  // Production runner names end in a host-local slot. Mapping that slot
  // directly guarantees distinct ports for runners that share a host.
  const slot = runner.match(/-r([1-9]\d*)$/)?.[1];
  const slotNumber = slot ? Number(slot) : 0;
  if (slotNumber > 0 && slotNumber <= SPAN) {
    return CI_BASE_PORT + slotNumber - 1;
  }

  // Unknown runner naming schemes still need a stable value because Playwright
  // and the Vite launcher resolve the port in separate processes.
  let hash = 0x811c9dc5;
  for (let i = 0; i < runner.length; i += 1) {
    hash ^= runner.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return CI_BASE_PORT + (hash % SPAN);
}

export function resolveHomepageE2eBaseUrl(env = process.env) {
  return `http://127.0.0.1:${resolveHomepageE2ePort(env)}`;
}
