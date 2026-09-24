/**
 * Filesystem-backed audit proving the first-party profile matrix covers every
 * production message-connector registration and remains byte-deterministic.
 */

import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
	FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT,
	renderFirstPartyInteractionCapabilityMatrix,
} from "./profile-catalog";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../..");

function normalizeRelativePath(
	relativePath: string,
	separator = path.sep,
): string {
	return relativePath.split(separator).join("/");
}

function normalizeGoldenLineEndings(golden: string): string {
	return golden.replace(/\r\n/g, "\n");
}

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
				const site = normalizeRelativePath(path.relative(pluginsRoot, file));
				// Personal Telegram accounts only retrieve messages. They do
				// not acquire the bot connector's interactive delivery profile.
				if (site === "plugin-telegram/src/account-client-service.ts") {
					const ast = ts.createSourceFile(
						file,
						source,
						ts.ScriptTarget.Latest,
						true,
					);
					const calls: ts.CallExpression[] = [];
					const visit = (node: ts.Node): void => {
						if (
							ts.isCallExpression(node) &&
							ts.isPropertyAccessExpression(node.expression) &&
							node.expression.name.text === "registerMessageConnector"
						)
							calls.push(node);
						ts.forEachChild(node, visit);
					};
					visit(ast);
					expect(calls).toHaveLength(1);
					const config = calls[0]?.arguments[0];
					if (!config || !ts.isObjectLiteralExpression(config))
						throw new Error(
							"Read-only connector registration must be inspectable",
						);
					if (
						config.properties.some(
							(property) =>
								ts.isSpreadAssignment(property) ||
								ts.isComputedPropertyName(property.name),
						)
					) {
						throw new Error(
							"Computed connector configuration requires interaction-profile review",
						);
					}
					const capabilityFields = config.properties.filter(
						(property) =>
							ts.isPropertyAssignment(property) &&
							(ts.isIdentifier(property.name) ||
								ts.isStringLiteral(property.name)) &&
							property.name.text === "capabilities",
					);
					expect(capabilityFields).toHaveLength(1);
					const capabilities = capabilityFields[0];
					if (
						!capabilities ||
						!ts.isPropertyAssignment(capabilities) ||
						!ts.isArrayLiteralExpression(capabilities.initializer)
					)
						throw new Error(
							"Read-only connector capabilities must be explicit",
						);
					const names = capabilities.initializer.elements.map((element) => {
						if (!ts.isStringLiteral(element))
							throw new Error(
								"Computed capabilities require interaction-profile review",
							);
						return element.text;
					});
					expect(names.sort()).toEqual(["read_messages", "search_messages"]);
					continue;
				}
				found.push({
					site: normalizeRelativePath(path.relative(pluginsRoot, file)),
					registrations,
				});
			}
		}
	}
	return found.sort((a, b) => a.site.localeCompare(b.site));
}

describe("first-party interaction capability matrix", () => {
	it("normalizes only platform separators and CRLF golden endings", () => {
		expect(
			normalizeRelativePath(
				String.raw`plugin-instagram\src\service.ts`,
				path.win32.sep,
			),
		).toBe("plugin-instagram/src/service.ts");
		expect(normalizeGoldenLineEndings("first\r\nsecond\rthird\n")).toBe(
			"first\nsecond\rthird\n",
		);
	});

	it("covers interactive registrations and separately verifies the read-only account registration", async () => {
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
		const golden = normalizeGoldenLineEndings(
			await fs.readFile(
				path.join(import.meta.dirname, "CAPABILITY_MATRIX.md"),
				"utf8",
			),
		);
		const rendered = renderFirstPartyInteractionCapabilityMatrix();
		expect(`${rendered}\n`).toBe(golden);
		expect(renderFirstPartyInteractionCapabilityMatrix()).toBe(rendered);
	});
});
