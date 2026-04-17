/**
 * Thinking Machines Tinker training backend.
 *
 * Tinker is the SDK from Thinking Machines for hosted SFT/RLHF runs. The
 * Node SDK package name (`@thinking-machines/tinker`) is loaded lazily so
 * the rest of the training app does not require it to be installed.
 *
 * Activation:
 *   bun run train -- --backend tinker --dataset <path> [--task <task>]
 *
 * Environment:
 *   TINKER_API_KEY    Required when the SDK is installed.
 *   TINKER_PROJECT    Tinker project ID.
 */

import { existsSync } from "node:fs";

const TINKER_PACKAGE_NAME = "@thinking-machines/tinker";

export interface TinkerBackendOptions {
	datasetPath: string;
	task?: string;
	apiKey?: string;
	project?: string;
}

export interface TinkerBackendResult {
	invoked: boolean;
	jobId?: string;
	notes: string[];
}

export async function runTinkerBackend(
	options: TinkerBackendOptions,
): Promise<TinkerBackendResult> {
	if (!existsSync(options.datasetPath)) {
		throw new Error(`Dataset not found at ${options.datasetPath}`);
	}
	const notes: string[] = [];
	const apiKey = options.apiKey ?? process.env.TINKER_API_KEY;
	const project = options.project ?? process.env.TINKER_PROJECT;

	type TinkerSdk = {
		createJob?: (input: unknown) => Promise<{ id?: string }>;
	};
	let sdk: TinkerSdk | null = null;
	try {
		// Optional dependency — load via runtime resolution. We deliberately
		// avoid a static import so app-training builds without the SDK.
		const dynamicImport = new Function(
			"name",
			"return import(name);",
		) as (name: string) => Promise<unknown>;
		const mod = (await dynamicImport(TINKER_PACKAGE_NAME)) as
			| { default?: unknown }
			| Record<string, unknown>;
		const candidate =
			mod && typeof mod === "object" && "default" in mod
				? (mod as { default?: unknown }).default
				: mod;
		if (candidate && typeof candidate === "object") {
			sdk = candidate as TinkerSdk;
		}
	} catch {
		notes.push(
			`Tinker SDK not installed. Add it with \`bun add ${TINKER_PACKAGE_NAME}\` and set TINKER_API_KEY to enable hosted training.`,
		);
		return { invoked: false, notes };
	}

	if (!apiKey) {
		notes.push("TINKER_API_KEY is not set; skipping job submission.");
		return { invoked: false, notes };
	}

	if (!sdk?.createJob || typeof sdk.createJob !== "function") {
		notes.push(
			`Tinker SDK was loaded but does not expose createJob(); update ${TINKER_PACKAGE_NAME}.`,
		);
		return { invoked: false, notes };
	}

	const job = await sdk.createJob({
		datasetPath: options.datasetPath,
		task: options.task,
		project,
	});
	notes.push(`Tinker job submitted (id=${job?.id ?? "unknown"})`);
	return { invoked: true, jobId: job?.id, notes };
}
