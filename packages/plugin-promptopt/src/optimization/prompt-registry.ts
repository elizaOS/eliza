/**
 * On-disk registry of prompt templates + schemas for auto-optimization.
 *
 * WHY: ExecutionTrace only stores templateHash/schemaFingerprint, not the full
 * template or SchemaRow[]. OptimizationRunner needs those to run the pipeline.
 * DPE writes/updates one JSON file per (promptKey, schemaFingerprint) under
 * `_prompt_registry/` whenever prompt optimization is enabled.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SchemaRow } from "@elizaos/core";

/** Per-path write locks to prevent concurrent writes from interleaving */
const writeLocks = new Map<string, Promise<void>>();

async function withWriteLock(path: string, fn: () => Promise<void>): Promise<void> {
	const prev = writeLocks.get(path) ?? Promise.resolve();
	const next = prev.then(fn, fn).finally(() => {
		if (writeLocks.get(path) === next) {
			writeLocks.delete(path);
		}
	});
	writeLocks.set(path, next);
	await next;
}

export interface PromptRegistryEntry {
	promptKey: string;
	schemaFingerprint: string;
	templateHash: string;
	/** Pre-merge base template; empty when the prompt is a function. */
	promptTemplate: string;
	schema: SchemaRow[];
	updatedAt: number;
}

function sanitizeFilePart(s: string): string {
	return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

function registryDir(rootDir: string): string {
	return join(rootDir, "_prompt_registry");
}

function registryPath(
	rootDir: string,
	promptKey: string,
	schemaFingerprint: string,
): string {
	return join(
		registryDir(rootDir),
		`${sanitizeFilePart(promptKey)}__${sanitizeFilePart(schemaFingerprint)}.json`,
	);
}

export async function writePromptRegistryEntry(
	rootDir: string,
	entry: Omit<PromptRegistryEntry, "updatedAt">,
): Promise<void> {
	// Compute path and payload synchronously before any await
	const full: PromptRegistryEntry = {
		...entry,
		updatedAt: Date.now(),
	};
	const path = registryPath(rootDir, entry.promptKey, entry.schemaFingerprint);
	const payload = JSON.stringify(full, null, 2);

	// Serialize writes to the same path to prevent interleaving
	await withWriteLock(path, async () => {
		await mkdir(registryDir(rootDir), { recursive: true });
		await writeFile(path, payload, "utf-8");
	});
}

export async function readPromptRegistryEntry(
	rootDir: string,
	promptKey: string,
	schemaFingerprint: string,
): Promise<PromptRegistryEntry | null> {
	const path = registryPath(rootDir, promptKey, schemaFingerprint);
	try {
		const raw = await readFile(path, "utf-8");
		return JSON.parse(raw) as PromptRegistryEntry;
	} catch {
		return null;
	}
}
