/**
 * Filesystem-backed audit proving the first-party profile matrix covers every
 * production message-connector registration and remains byte-deterministic.
 */

import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
	createFirstPartyInteractionProfile,
	DISCORD_INTERACTION_PROFILE,
	FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT,
	FIRST_PARTY_INTERACTION_CONNECTOR_EXCLUSIONS,
	renderFirstPartyInteractionCapabilityMatrix,
	resolveFirstPartyInteractionProfile,
} from "./profile-catalog";
import { INTERACTION_BLOCK_KINDS } from "./profiles";

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
		else if (
			entry.isFile() &&
			(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
		)
			files.push(fullPath);
	}
	return files;
}

async function productionRegistrationSites(): Promise<string[]> {
	const pluginsRoot = path.join(repositoryRoot, "plugins");
	const found: string[] = [];
	for (const entry of await fs.readdir(pluginsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("plugin-")) continue;
		const files = await sourceFiles(path.join(pluginsRoot, entry.name));
		for (const file of files) {
			const source = await fs.readFile(file, "utf8");
			const relativeSite = path.relative(
				path.join(pluginsRoot, entry.name),
				file,
			);
			const syntax = ts.createSourceFile(
				file,
				source,
				ts.ScriptTarget.Latest,
				true,
				file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
			);
			const visit = (node: ts.Node): void => {
				if (
					ts.isCallExpression(node) &&
					ts.isPropertyAccessExpression(node.expression) &&
					node.expression.name.text === "registerMessageConnector"
				) {
					found.push(`${entry.name}:direct:${relativeSite}`);
				}
				if (
					ts.isPropertyAssignment(node) &&
					((ts.isIdentifier(node.name) &&
						node.name.text === "messageConnector") ||
						(ts.isStringLiteral(node.name) &&
							node.name.text === "messageConnector"))
				) {
					found.push(`${entry.name}:account-provider:${relativeSite}`);
				}
				ts.forEachChild(node, visit);
			};
			visit(syntax);
		}
	}
	return found.sort();
}

describe("first-party interaction capability matrix", () => {
	it("covers every production registration site and account-provider extension", async () => {
		const declared = FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT.map(
			(entry) =>
				`${entry.plugin}:${entry.registrationMechanism}:${entry.registrationSite}`,
		).sort();
		expect(await productionRegistrationSites()).toEqual(declared);
	});

	it("requires every audited source registration to expose a concrete resolver", async () => {
		const pluginsRoot = path.join(repositoryRoot, "plugins");
		for (const plugin of new Set(
			FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT.map((entry) => entry.plugin),
		)) {
			const expected = FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT.filter(
				(entry) => entry.plugin === plugin,
			).length;
			const files = await sourceFiles(path.join(pluginsRoot, plugin));
			const sources = await Promise.all(
				files.map((file) => fs.readFile(file, "utf8")),
			);
			const combined = sources.join("\n");
			expect(
				combined.match(/resolveInteractionProfile\s*:/g)?.length ?? 0,
				`${plugin} must declare one resolver per audited source`,
			).toBeGreaterThanOrEqual(expected);
		}
	});

	it("registers a host-prepared send seam for every native callback connector", async () => {
		for (const plugin of [
			"plugin-discord",
			"plugin-slack",
			"plugin-telegram",
			"plugin-whatsapp",
		]) {
			const files = await sourceFiles(
				path.join(repositoryRoot, "plugins", plugin),
			);
			const combined = (
				await Promise.all(files.map((file) => fs.readFile(file, "utf8")))
			).join("\n");
			expect(
				combined,
				`${plugin} must consume host-prepared delivery`,
			).toContain("sendPreparedInteraction");
		}
	});

	it("materializes exhaustive behavior for every block kind and source", () => {
		for (const entry of FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT) {
			const profile = createFirstPartyInteractionProfile({
				source: entry.source,
				accountId: "account",
				targetKind: entry.targetKind,
				targetId: "target",
			});
			expect(Object.keys(profile.blocks).sort()).toEqual(
				[...INTERACTION_BLOCK_KINDS].sort(),
			);
		}
	});

	it("retains provider-specific limits instead of the generic button profile", () => {
		expect(DISCORD_INTERACTION_PROFILE.limits.links.maxUrlBytes).toBe(512);
	});

	it("fails closed when trusted account or target identity is absent", () => {
		expect(() =>
			resolveFirstPartyInteractionProfile({
				source: "gmail",
				defaultAccountId: "",
				defaultTargetKind: "email",
				target: { source: "gmail", channelId: "user@example.test" },
			}),
		).toThrow(/trusted connector identity/i);
		expect(() =>
			resolveFirstPartyInteractionProfile({
				source: "slack",
				defaultAccountId: "default",
				defaultTargetKind: "channel",
				target: { source: "slack" },
			}),
		).toThrow(/stable provider identity/i);
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
