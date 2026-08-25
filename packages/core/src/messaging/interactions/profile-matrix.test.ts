/**
 * Filesystem-backed audit proving the first-party profile matrix covers every
 * production message-connector registration and remains byte-deterministic.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT,
	renderFirstPartyInteractionCapabilityMatrix,
} from "./profile-catalog";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../..");

async function sourceFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		if (
			entry.name === "node_modules" ||
			entry.name === "dist" ||
			entry.name === "__tests__" ||
			entry.name === "test" ||
			entry.name.includes(".test.")
		)
			continue;
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(fullPath)));
		else if (entry.isFile() && /[.](?:[cm]?[jt]sx?)$/.test(entry.name))
			files.push(fullPath);
	}
	return files;
}

async function productionRegistrationSites(): Promise<
	Array<{ site: string; registrations: number }>
> {
	const pluginsRoot = path.join(repositoryRoot, "plugins");
	const found: Array<{ site: string; registrations: number }> = [];
	for (const entry of await fs.readdir(pluginsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("plugin-")) continue;
		const files = await sourceFiles(path.join(pluginsRoot, entry.name));
		for (const file of files) {
			const source = await fs.readFile(file, "utf8");
			const registrations = source.match(
				/\bregisterMessageConnector\s*\(/g,
			)?.length;
			if (registrations) {
				found.push({
					site: path.relative(pluginsRoot, file),
					registrations,
				});
			}
		}
	}
	return found.sort((a, b) => a.site.localeCompare(b.site));
}

describe("first-party interaction capability matrix", () => {
	it("covers every production registration site and invocation", async () => {
		const declared = [
			...new Set(
				FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT.map(
					(entry) => entry.registrationSite,
				),
			),
		]
			.sort()
			.map((site) => ({ site, registrations: 1 }));
		expect(await productionRegistrationSites()).toEqual(declared);
	});

	it("matches the committed reviewer-readable golden artifact", async () => {
		const golden = await fs.readFile(
			path.join(import.meta.dirname, "CAPABILITY_MATRIX.md"),
			"utf8",
		);
		expect(`${renderFirstPartyInteractionCapabilityMatrix()}\n`).toBe(golden);
	});
});
