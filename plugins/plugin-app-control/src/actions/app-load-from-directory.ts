/**
 * @module plugin-app-control/actions/app-load-from-directory
 *
 * load_from_directory sub-mode: scan an absolute directory for subdirs that
 * contain a package.json with an `elizaos.app` field. For each match, register
 * a curated app definition (security-audited; never auto-launches).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type {
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
	type AppPermissionsManifest,
	parseAppPermissions,
} from "@elizaos/shared/contracts/app-permissions";
import { readStringOption } from "../params.js";
import {
	isProtected,
	type ProtectedAppsResolution,
	resolveProtectedApps,
} from "../protected-apps.js";
import {
	APP_REGISTRY_SERVICE_TYPE,
	type AppRegistryEntry,
	type AppRegistryService,
} from "../services/app-registry-service.js";

interface DiscoveredApp {
	directory: string;
	packageName: string;
	displayName: string;
	slug: string;
	aliases: string[];
	permissions: AppPermissionsManifest;
}

async function readPackageJson(
	dir: string,
): Promise<Record<string, unknown> | null> {
	const pkgPath = path.join(dir, "package.json");
	const raw = await fs.readFile(pkgPath, "utf8").catch(() => null);
	if (raw === null) return null;
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object") return null;
	return parsed as Record<string, unknown>;
}

function readString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string");
}

function packageBasename(name: string): string {
	return name.replace(/^@[^/]+\//, "").trim();
}

interface DiscoveryResult {
	apps: DiscoveredApp[];
	rejectedManifests: Array<{
		directory: string;
		packageName: string | null;
		reason: string;
		path: string;
	}>;
}

async function discoverApps(directory: string): Promise<DiscoveryResult> {
	const stat = await fs.stat(directory).catch(() => null);
	if (!stat?.isDirectory()) {
		throw new Error(`Not a directory: ${directory}`);
	}

	const entries = await fs.readdir(directory, { withFileTypes: true });
	const apps: DiscoveredApp[] = [];
	const rejectedManifests: DiscoveryResult["rejectedManifests"] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const subdir = path.join(directory, entry.name);
		const pkg = await readPackageJson(subdir);
		if (!pkg) continue;

		const elizaos =
			pkg.elizaos && typeof pkg.elizaos === "object"
				? (pkg.elizaos as Record<string, unknown>)
				: null;
		const appMeta =
			elizaos?.app && typeof elizaos.app === "object"
				? (elizaos.app as Record<string, unknown>)
				: null;
		if (!appMeta) continue;

		const packageName = readString(pkg.name);
		if (!packageName) continue;

		const permissionsResult = parseAppPermissions(appMeta.permissions);
		if (!permissionsResult.ok) {
			rejectedManifests.push({
				directory: subdir,
				packageName,
				reason: permissionsResult.reason,
				path: permissionsResult.path,
			});
			continue;
		}

		const slug =
			readString(appMeta.slug) ??
			packageBasename(packageName).replace(/^app-/, "");
		const displayName =
			readString(appMeta.displayName) ?? packageBasename(packageName);
		const aliases = readStringArray(appMeta.aliases);

		apps.push({
			directory: subdir,
			packageName,
			displayName,
			slug,
			aliases,
			permissions: permissionsResult.manifest,
		});
	}

	return { apps, rejectedManifests };
}

export interface RunLoadFromDirectoryInput {
	runtime: IAgentRuntime;
	message: Memory;
	options?: Record<string, unknown>;
	callback?: HandlerCallback;
	repoRoot: string;
}

interface RejectedApp {
	app: DiscoveredApp;
	matchedOn: string;
}

function findProtectedMatch(
	app: DiscoveredApp,
	resolution: ProtectedAppsResolution,
): string | null {
	const candidates: Array<{ kind: string; value: string }> = [
		{ kind: "packageName", value: app.packageName },
		{ kind: "slug", value: app.slug },
		...app.aliases.map((alias) => ({ kind: "alias", value: alias })),
	];
	for (const candidate of candidates) {
		if (isProtected(candidate.value, resolution)) {
			return `${candidate.kind}=${candidate.value}`;
		}
	}
	return null;
}

export async function runLoadFromDirectory({
	runtime,
	message,
	options,
	callback,
	repoRoot,
}: RunLoadFromDirectoryInput): Promise<ActionResult> {
	const directory = readStringOption(options, "directory");
	if (!directory) {
		const text =
			'I need an absolute directory path. Try: pass { directory: "/abs/path/to/apps" }.';
		await callback?.({ text });
		return { success: false, text };
	}

	if (!path.isAbsolute(directory)) {
		const text = `Directory must be an absolute path: "${directory}".`;
		await callback?.({ text });
		return { success: false, text };
	}

	const service = runtime.getService(
		APP_REGISTRY_SERVICE_TYPE,
	) as AppRegistryService | null;
	if (!service) {
		const text = "AppRegistryService is not registered; cannot load apps.";
		await callback?.({ text });
		return { success: false, text };
	}

	const { apps: discovered, rejectedManifests } = await discoverApps(directory);
	if (discovered.length === 0 && rejectedManifests.length === 0) {
		const text = `No apps found under ${directory} (no subdir contained a package.json with elizaos.app).`;
		await callback?.({ text });
		return { success: true, text, data: { directory, registered: [] } };
	}

	const protectedApps = await resolveProtectedApps(repoRoot);
	const requesterEntityId =
		typeof message.entityId === "string" ? message.entityId : null;
	const requesterRoomId =
		typeof message.roomId === "string" ? message.roomId : null;

	const registered: AppRegistryEntry[] = [];
	const rejected: RejectedApp[] = [];

	for (const rejection of rejectedManifests) {
		logger.warn(
			`[plugin-app-control][permissions] rejected manifest name=${rejection.packageName ?? "unknown"} directory=${rejection.directory} path=${rejection.path} reason="${rejection.reason}" requesterEntityId=${requesterEntityId ?? "null"} requesterRoomId=${requesterRoomId ?? "null"}`,
		);
		await service.recordManifestRejection({
			directory: rejection.directory,
			packageName: rejection.packageName,
			reason: rejection.reason,
			path: rejection.path,
			requesterEntityId,
			requesterRoomId,
		});
	}

	for (const app of discovered) {
		const matchedOn = findProtectedMatch(app, protectedApps);
		if (matchedOn !== null) {
			rejected.push({ app, matchedOn });
			logger.warn(
				`[plugin-app-control][protected-apps] rejected name=${app.packageName} directory=${app.directory} matched=${matchedOn} requesterEntityId=${requesterEntityId ?? "null"} requesterRoomId=${requesterRoomId ?? "null"}`,
			);
			continue;
		}

		const entry: AppRegistryEntry = {
			slug: app.slug,
			canonicalName: app.packageName,
			aliases: app.aliases,
			directory: app.directory,
			displayName: app.displayName,
			...(app.permissions.raw !== null
				? { requestedPermissions: app.permissions.raw }
				: {}),
		};
		await service.register(entry, {
			requesterEntityId,
			requesterRoomId,
			trust: "external",
		});
		registered.push(entry);
	}

	logger.info(
		`[plugin-app-control] APP/load_from_directory ${directory} registered=${registered.length} rejected=${rejected.length} rejectedManifests=${rejectedManifests.length}`,
	);

	const lines: string[] = [];
	if (registered.length > 0) {
		lines.push(
			`Registered ${registered.length} app${registered.length === 1 ? "" : "s"} from ${directory}:`,
			...registered.map((r) => `  - ${r.displayName} (${r.canonicalName})`),
		);
	} else {
		lines.push(`Registered 0 apps from ${directory}.`);
	}
	if (rejected.length > 0) {
		const names = rejected.map((r) => r.app.packageName).join(", ");
		lines.push(
			"",
			`Skipped ${rejected.length} protected app${rejected.length === 1 ? "" : "s"}: ${names} (cannot override first-party apps).`,
		);
	}
	if (rejectedManifests.length > 0) {
		const summaries = rejectedManifests.map(
			(r) => `${r.packageName ?? r.directory}: ${r.reason} (${r.path})`,
		);
		lines.push(
			"",
			`Skipped ${rejectedManifests.length} app${rejectedManifests.length === 1 ? "" : "s"} with malformed elizaos.app.permissions:`,
			...summaries.map((s) => `  - ${s}`),
		);
	}
	if (registered.length > 0) {
		lines.push("", "Apps are registered only — none were launched.");
	}
	const text = lines.join("\n");
	await callback?.({ text });

	return {
		success: true,
		text,
		values: {
			mode: "load_from_directory",
			directory,
			registeredCount: registered.length,
			rejectedCount: rejected.length,
			rejectedManifestsCount: rejectedManifests.length,
		},
		data: {
			directory,
			registered,
			rejected: rejected.map((r) => ({
				packageName: r.app.packageName,
				directory: r.app.directory,
				matchedOn: r.matchedOn,
			})),
			rejectedManifests,
		},
	};
}
