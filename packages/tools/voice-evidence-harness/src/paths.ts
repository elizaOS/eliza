/**
 * Evidence-root and secrets-dir derivation seam for the harness CLI.
 *
 * The CLI used to join node:os.homedir() inline, and a test that only
 * reassigned process.env.HOME still wrote evidence under the REAL ~/.moltbot
 * tree because Bun's homedir() ignores a HOME reassignment (#16180). This
 * module is the single injectable seam: explicit env overrides
 * (VOICE_EVIDENCE_ROOT / VOICE_EVIDENCE_SECRETS_DIR) win, the live default
 * stays the real-home ~/.moltbot layout, and both the env map and the home
 * lookup are parameters so the contract is assertable as pure derivation.
 *
 * Runtime-neutral on purpose: only node:os / node:path and erasable-TS syntax,
 * so the same file executes under Bun (bun:test) and under Node type stripping
 * — paths.test.ts exercises both legs, because the #16180 leak was exactly a
 * Bun-vs-Node runtime divergence a single-runtime test could not see.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Env var overriding where evidence runs are written (absolute path). */
export const EVIDENCE_ROOT_ENV = "VOICE_EVIDENCE_ROOT";
/** Env var overriding where provider secret JSONs are read (absolute path). */
export const SECRETS_DIR_ENV = "VOICE_EVIDENCE_SECRETS_DIR";

/** Live default evidence location, relative to the user home (see README). */
export const DEFAULT_EVIDENCE_SUBPATH =
  ".moltbot/projects/eliza-fleet/evidence/voice-e2e";
/** Live default secrets location, relative to the user home (see README). */
export const DEFAULT_SECRETS_SUBPATH = ".moltbot/secrets";

/** Minimal read surface of process.env, injectable for pure derivation tests. */
export interface PathEnv {
  readonly [name: string]: string | undefined;
}

/**
 * Read an override env var. A set-but-blank or relative value throws instead
 * of silently falling back: this seam exists to keep test runs out of the real
 * home, so a malformed override must never be able to redirect writes there.
 */
function overrideFrom(env: PathEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error(
      `${name} is set but blank; unset it or provide an absolute path`,
    );
  }
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path (got "${value}")`);
  }
  return value;
}

/** Root directory evidence runs are written under. */
export function evidenceRoot(
  env: PathEnv = process.env,
  home: () => string = homedir,
): string {
  const override = overrideFrom(env, EVIDENCE_ROOT_ENV);
  if (override !== undefined) return override;
  return join(home(), DEFAULT_EVIDENCE_SUBPATH);
}

/** Directory the provider secret JSONs are read from. */
export function secretsDir(
  env: PathEnv = process.env,
  home: () => string = homedir,
): string {
  const override = overrideFrom(env, SECRETS_DIR_ENV);
  if (override !== undefined) return override;
  return join(home(), DEFAULT_SECRETS_SUBPATH);
}

/** Path of one provider's secret JSON (shape: `{"api_key": "..."}`). */
export function secretPath(
  provider: "deepgram" | "cartesia",
  env: PathEnv = process.env,
  home: () => string = homedir,
): string {
  return join(secretsDir(env, home), `${provider}.json`);
}
