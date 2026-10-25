import fs from "node:fs";
import path from "node:path";
import { resolveUserPath } from "@elizaos/core";
import { normalizeDeploymentTargetConfig } from "@elizaos/host/protocol";
import type { PersistedDeployment } from "./api-base";
import { logger } from "./logger";
import {
	resolveBrandAwareNamespace,
	resolveStateDir,
} from "./native/auth-bridge";

/**
 * Resolve the config file the agent persists its config to. Mirrors
 * `@elizaos/agent`'s `resolveConfigPath` (the `ELIZA_CONFIG_PATH` override,
 * else the first existing of `${namespace}.json` then `eliza.json` under the
 * state dir, defaulting to `${namespace}.json`) without importing the agent,
 * which the desktop shell bundle keeps external. The namespace and state dir
 * are brand-aware, matching the env the desktop hands the agent child.
 */
function resolveElizaConfigPath(
	env: Record<string, string | undefined>,
): string {
	const override = env.ELIZA_CONFIG_PATH?.trim();
	if (override) {
		return resolveUserPath(override);
	}
	const stateDir = resolveStateDir(env as NodeJS.ProcessEnv);
	const namespace = resolveBrandAwareNamespace(env.ELIZA_NAMESPACE);
	const primary = path.join(stateDir, `${namespace}.json`);
	const candidates =
		namespace === "eliza"
			? [primary]
			: [primary, path.join(stateDir, "eliza.json")];
	return candidates.find((candidate) => fs.existsSync(candidate)) ?? primary;
}
/**
 * Read the persisted `deploymentTarget` from the agent config as a
 * {@link PersistedDeployment} (runtime plus the cloud-hosted/external agent's
 * API base and bound access token). Best-effort and fail-safe: any missing
 * file, parse error, or absent deployment target resolves to `null`, which the
 * caller treats as "no cloud-hosted target" and keeps the existing local-agent
 * boot path. The
 * persisted config is written by `saveElizaConfig` as strict JSON, so a strict
 * `JSON.parse` is sufficient.
 */
export function readPersistedDeployment(
	env: Record<string, string | undefined> = process.env as Record<
		string,
		string | undefined
	>,
): PersistedDeployment | null {
	const configPath = resolveElizaConfigPath(env);
	let raw: string;
	try {
		raw = fs.readFileSync(configPath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		logger.warn(
			`[Deployment] Could not read ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		logger.warn(
			`[Deployment] Could not parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
	const deploymentTarget = normalizeDeploymentTargetConfig(
		(
			parsed as {
				deploymentTarget?: unknown;
			} | null
		)?.deploymentTarget,
	);
	if (!deploymentTarget) {
		return null;
	}
	return {
		runtime: deploymentTarget.runtime,
		remoteApiBase: deploymentTarget.remoteApiBase ?? null,
		remoteAccessToken: deploymentTarget.remoteAccessToken ?? null,
	};
}
let cachedDeployment: PersistedDeployment | null | undefined;
/**
 * Cached read of the persisted deployment for the lifetime of the desktop
 * process. The deployment target only changes via a first-run flow that
 * restarts the shell, so a single read at boot is the source of truth for every
 * runtime-mode decision in `main()`.
 */
export function getPersistedDeployment(): PersistedDeployment | null {
	if (cachedDeployment === undefined) {
		cachedDeployment = readPersistedDeployment();
	}
	return cachedDeployment;
}
