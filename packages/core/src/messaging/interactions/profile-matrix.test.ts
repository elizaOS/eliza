/**
 * Filesystem-backed audit proving the first-party profile matrix covers every
 * production message-connector registration and remains byte-deterministic.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT,
	FIRST_PARTY_INTERACTION_CONNECTOR_EXCLUSIONS,
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
		else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(fullPath);
	}
	return files;
}

async function productionRegistrationPlugins(): Promise<string[]> {
	const pluginsRoot = path.join(repositoryRoot, "plugins");
	const found: string[] = [];
	for (const entry of await fs.readdir(pluginsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("plugin-")) continue;
		const files = await sourceFiles(path.join(pluginsRoot, entry.name));
		for (const file of files) {
			if (
				(await fs.readFile(file, "utf8")).includes("registerMessageConnector")
			) {
				found.push(entry.name);
				break;
			}
		}
	}
	return found.sort();
}

describe("first-party interaction capability matrix", () => {
	it("covers every production message connector plugin root", async () => {
		const declared = [
			...new Set(
				FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT.map((entry) => entry.plugin),
			),
		].sort();
		expect(await productionRegistrationPlugins()).toEqual(declared);
	});

	it("keeps deliberate unsupported connectors visible and unregistered", async () => {
		expect(FIRST_PARTY_INTERACTION_CONNECTOR_EXCLUSIONS).toContainEqual(
			expect.objectContaining({ plugin: "plugin-signal" }),
		);
		const files = await sourceFiles(
			path.join(repositoryRoot, "plugins/plugin-signal"),
		);
		const combined = (
			await Promise.all(files.map((file) => fs.readFile(file, "utf8")))
		).join("\n");
		expect(combined).not.toContain("registerMessageConnector");
		expect(combined).toContain("SIGNAL_DIRECT_TRANSPORT_UNAVAILABLE");
	});

	it("matches the committed reviewer-readable golden artifact", async () => {
		const golden = await fs.readFile(
			path.join(import.meta.dirname, "CAPABILITY_MATRIX.md"),
			"utf8",
		);
		expect(`${renderFirstPartyInteractionCapabilityMatrix()}\n`).toBe(golden);
	});
});
