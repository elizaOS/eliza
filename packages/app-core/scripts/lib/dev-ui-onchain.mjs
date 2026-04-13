/**
 * dev-ui-onchain.mjs
 *
 * Pure, injectable on-chain preference resolution for dev-ui.mjs.
 * Extracted here so it can be unit-tested without starting any servers.
 */

/**
 * Coerces an environment variable string to a boolean.
 * Returns null when the value is absent or unrecognised.
 *
 * @param {unknown} value
 * @returns {boolean | null}
 */
export function coerceBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

/**
 * Resolves whether on-chain dev features (Anvil + optional Anchor) should be
 * enabled for this dev session.
 *
 * Priority order:
 *  1. `ELIZA_DEV_ONCHAIN` env var — explicit opt-in/out, no prompts (CI-safe).
 *  2. Interactive TTY prompts — ask the user, then optionally install Foundry.
 *  3. Non-TTY / no promptFn — defaults to disabled.
 *
 * All side-effectful dependencies are injected so the function is fully
 * testable without touching the filesystem or spawning processes.
 *
 * @param {object} opts
 * @param {Record<string, string | undefined>} opts.env         Process env vars.
 * @param {boolean}                            opts.isTTY       Whether stdin is a TTY.
 * @param {(cmd: string) => string | null}     opts.whichFn     Resolves a binary path.
 * @param {(q: string, d: boolean) => Promise<boolean>} [opts.promptFn]  Interactive yes/no.
 * @param {() => Promise<boolean>}             [opts.installFn] Installs Foundry; returns success.
 *
 * @returns {Promise<{ onchainEnabled: boolean; anchorRequested: boolean }>}
 */
export async function resolveOnchainPreference({
  env,
  isTTY,
  whichFn,
  promptFn,
  installFn,
}) {
  // ── Explicit env var takes precedence (CI / scripts / power users) ──────
  const explicitOnchain = coerceBoolean(env.ELIZA_DEV_ONCHAIN);
  if (explicitOnchain !== null) {
    return {
      onchainEnabled: explicitOnchain === true,
      anchorRequested: coerceBoolean(env.ELIZA_DEV_ANCHOR) === true,
    };
  }

  // ── Non-interactive: default on, auto-install Foundry if missing ────────
  if (!isTTY || !promptFn) {
    let anvilAvailable = whichFn("anvil") !== null;
    if (!anvilAvailable && installFn) {
      anvilAvailable = await installFn();
    }
    if (!anvilAvailable) {
      return { onchainEnabled: false, anchorRequested: false };
    }
    return { onchainEnabled: true, anchorRequested: true };
  }

  // ── Interactive flow ─────────────────────────────────────────────────────
  let anvilAvailable = whichFn("anvil") !== null;

  if (!anvilAvailable) {
    const wantsInstall = await promptFn(
      "Anvil not found. Install Foundry now? (y/N) ",
      false,
    );
    if (wantsInstall && installFn) {
      anvilAvailable = await installFn();
    }
  }

  if (!anvilAvailable) {
    return { onchainEnabled: false, anchorRequested: false };
  }

  return { onchainEnabled: true, anchorRequested: true };
}
