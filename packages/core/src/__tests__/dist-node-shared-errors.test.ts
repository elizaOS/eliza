/**
 * Imports real Node, document, and edge artifacts to verify typed errors survive
 * package boundaries and host normalization. A prior full core build is required;
 * source aliases would hide the independent-bundle regression under test.
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
	edge: join(packageRoot, "dist/edge/index.edge.js"),
} as const;

type ErrorsModule = {
	ElizaError: new (
		message: string,
		options: { code: string; context?: Record<string, unknown> },
	) => Error;
	isElizaError: (value: unknown) => boolean;
	toElizaError: (value: unknown) => Error;
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

	it("preserves edge error classification when a Node host normalizes it", async () => {
		const root = await importBundle<ErrorsModule>(bundles.root);
		const edge = await importBundle<{
			assertModelOutputComplete: (input: {
				finishReason: string;
				model: string;
				provider: string;
			}) => void;
		}>(bundles.edge);
		let thrown: unknown;
		try {
			edge.assertModelOutputComplete({
				finishReason: "length",
				model: "fixture",
				provider: "fixture",
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(root.ElizaError);
		expect(root.toElizaError(thrown)).toBe(thrown);
		expect(thrown).toMatchObject({
			code: "MODEL_OUTPUT_INCOMPLETE",
			context: {
				finishReason: "length",
				model: "fixture",
				provider: "fixture",
			},
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
