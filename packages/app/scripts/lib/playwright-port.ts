/**
 * Canonical TCP-port parsing for Playwright lane environment overrides.
 *
 * Lane configs previously used `Number(process.env.X || default)`, which
 * accepts `0`, negatives, fractions, and turns typos like `2138junk` into
 * `NaN` that only fail later inside webServer bind or baseURL construction.
 * Explicit invalid overrides must fail closed at config/preflight load with
 * the env-var name in the message.
 */

export const MIN_TCP_PORT = 1;
export const MAX_TCP_PORT = 65535;

/**
 * Accept only full-string decimal TCP ports in the range 1..65535.
 * Rejects partial numbers, signed values, fractions, leading zeros beyond a
 * single digit, and out-of-range integers so a typo never selects a different
 * bind target than the operator requested.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
export function parsePlaywrightPort(value, label) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${label} must be a TCP port integer from ${MIN_TCP_PORT} to ${MAX_TCP_PORT} (received ${JSON.stringify(String(value ?? ""))})`,
    );
  }
  const port = Number.parseInt(raw, 10);
  if (
    !Number.isSafeInteger(port) ||
    port < MIN_TCP_PORT ||
    port > MAX_TCP_PORT ||
    String(port) !== raw
  ) {
    throw new Error(
      `${label} must be a TCP port integer from ${MIN_TCP_PORT} to ${MAX_TCP_PORT} (received ${JSON.stringify(String(value ?? ""))})`,
    );
  }
  return port;
}

/**
 * Resolve a port from env: unset/empty keeps `defaultPort`; any other explicit
 * value must be a canonical TCP port or the command fails closed.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} envName
 * @param {number} defaultPort
 * @returns {number}
 */
export function resolvePlaywrightPortEnv(env, envName, defaultPort) {
  const raw = env?.[envName];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return defaultPort;
  }
  return parsePlaywrightPort(raw, envName);
}
