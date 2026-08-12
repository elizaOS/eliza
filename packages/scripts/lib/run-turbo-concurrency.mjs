/**
 * Fail-closed RUN_TURBO_CONCURRENCY resolution for the shared Turbo runner.
 * Pure helpers so unit tests can exercise accept/reject paths without spawning
 * Turbo or materializing generated-source prerequisites.
 */

/**
 * Parses a complete positive safe-integer decimal string. Partial suffixes,
 * signs, fractions, whitespace-only, zero, and non-finite values throw so a
 * typo in RUN_TURBO_CONCURRENCY cannot disable or corrupt the CI fan-out cap
 * that prevents hosted-runner OOM kills (#15140).
 *
 * @param {string | number | undefined | null} value
 * @param {string} label
 * @returns {number}
 */
export function parsePositiveSafeInteger(value, label) {
  const received =
    typeof value === "number"
      ? JSON.stringify(value)
      : JSON.stringify(String(value ?? ""));
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(
        `${label} must be a positive safe-integer decimal (received ${received})`,
      );
    }
    return value;
  }
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${label} must be a positive safe-integer decimal (received ${received})`,
    );
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(
      `${label} must be a positive safe-integer decimal (received ${received})`,
    );
  }
  return parsed;
}

/**
 * Resolve the RUN_TURBO_CONCURRENCY override. Unset, empty, and whitespace-only
 * values mean "do not inject". Explicit overrides fail closed so a typo cannot
 * forward garbage to Turbo or silently drop the OOM-protection cap.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {number | null}
 */
export function resolveTurboConcurrency(env = process.env) {
  const raw = env.RUN_TURBO_CONCURRENCY;
  if (raw == null || String(raw).trim() === "") {
    return null;
  }
  return parsePositiveSafeInteger(raw, "RUN_TURBO_CONCURRENCY");
}

/**
 * Inject or replace `--concurrency=<n>` on a Turbo argv copy. When
 * `concurrency` is null the args are returned unchanged. When set, an existing
 * CLI concurrency flag is replaced so the env cap wins for CI.
 *
 * @param {string[]} turboArgs
 * @param {number | null} concurrency
 * @returns {string[]}
 */
export function applyTurboConcurrency(turboArgs, concurrency) {
  if (concurrency == null) {
    return turboArgs;
  }
  const args = [...turboArgs];
  const runIndex = args.indexOf("run");
  const idx = args.findIndex(
    (arg) => arg === "--concurrency" || arg.startsWith("--concurrency="),
  );
  const override = `--concurrency=${concurrency}`;
  if (idx === -1) {
    if (runIndex !== -1) args.splice(runIndex + 1, 0, override);
    else args.push(override);
  } else if (args[idx] === "--concurrency") {
    args.splice(idx, 2, override);
  } else {
    args.splice(idx, 1, override);
  }
  return args;
}
