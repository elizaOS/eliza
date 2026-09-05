/**
 * Guards the shared-errors identity contract of the built Node distribution:
 * every `dist/node` bundle (the root barrel and the narrow leaves such as
 * documents) must resolve `ElizaError` to the single `dist/node/errors.js`
 * artifact, so an error thrown inside a leaf passes `instanceof` checks
 * against the class imported from the root entrypoint. Real artifacts — the
 * suite imports the emitted bundles directly and requires a prior
 * `bun run build` (CI's core gate builds before this lane runs).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(import.meta.dirname, "..", "..");
const distNode = join(packageRoot, "dist", "node");
const bundles = {
	root: join(distNode, "index.node.js"),
	errors: join(distNode, "errors.js"),
	documents: join(distNode, "documents.js"),
} as const;

type ErrorsModule = {
	ElizaError: new (
		message: string,
		options: { code: string; context?: Record<string, unknown> },
	) => Error;
	isElizaError: (value: unknown) => boolean;
};

type DocumentsModule = {
	resolveDocumentRequester: (
		runtime: {
			agentId: string;
			getRoom: () => Promise<never>;
			reportError: () => void;
		},
		message: { entityId: string; roomId: string },
	) => Promise<unknown>;
};

async function importBundle<T>(path: string): Promise<T> {
	if (!existsSync(path)) {
		throw new Error(
			`Built artifact missing: ${path}. Run \`bun run build\` in packages/core before this suite.`,
		);
	}
	return (await import(pathToFileURL(path).href)) as T;
}

describe("dist/node shared errors module identity", () => {
	it("resolves one ElizaError class across the root barrel and the errors leaf", async () => {
		const root = await importBundle<ErrorsModule>(bundles.root);
		const errors = await importBundle<ErrorsModule>(bundles.errors);
		expect(root.ElizaError).toBe(errors.ElizaError);
		expect(root.isElizaError).toBe(errors.isElizaError);
	});

	it("preserves document authorization errors across the package boundary", async () => {
		const root = await importBundle<ErrorsModule>(bundles.root);
		const documents = await importBundle<DocumentsModule>(bundles.documents);
		const failure = documents.resolveDocumentRequester(
			{
				agentId: "00000000-0000-4000-8000-000000000001",
				getRoom: async () => {
					throw new Error("room database unavailable");
				},
				reportError: () => undefined,
			},
			{
				entityId: "00000000-0000-4000-8000-000000000002",
				roomId: "00000000-0000-4000-8000-000000000003",
			},
		);
		await expect(failure).rejects.toBeInstanceOf(root.ElizaError);
		await expect(failure).rejects.toMatchObject({
			code: "DOCUMENT_ROLE_LOOKUP_FAILED",
		});
	});

	it("inlines the ElizaError class only into the canonical errors artifact", async () => {
		const { readFile } = await import("node:fs/promises");
		for (const [name, path] of Object.entries(bundles)) {
			if (!existsSync(path)) {
				throw new Error(
					`Built artifact missing: ${path}. Run \`bun run build\` in packages/core before this suite.`,
				);
			}
			const inlined = (await readFile(path, "utf8")).includes(
				"class ElizaError",
			);
			expect(
				inlined,
				`${name} bundle ${inlined ? "inlines" : "shares"} ElizaError`,
			).toBe(name === "errors");
		}
	});
});
