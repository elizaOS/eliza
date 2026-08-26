/**
 * Guards the shared-errors identity contract of the built Node distribution:
 * every `dist/node` bundle (the root barrel and the narrow leaves such as
 * raw-sql) must resolve `ElizaError` to the single `dist/node/errors.js`
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
	rawSql: join(distNode, "raw-sql.js"),
	documents: join(distNode, "documents.js"),
} as const;

type ErrorsModule = {
	ElizaError: new (
		message: string,
		options: { code: string; context?: Record<string, unknown> },
	) => Error;
	isElizaError: (value: unknown) => boolean;
};

type RawSqlModule = {
	parseRawSqlJsonValue: (
		value: unknown,
		fallback: unknown,
		options: { subsystem: string },
	) => unknown;
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

	it("throws raw-sql leaf errors that satisfy instanceof against the root ElizaError", async () => {
		const root = await importBundle<ErrorsModule>(bundles.root);
		const rawSql = await importBundle<RawSqlModule>(bundles.rawSql);
		let thrown: unknown;
		try {
			rawSql.parseRawSqlJsonValue(42, null, { subsystem: "identity-test" });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(root.ElizaError);
		expect(root.isElizaError(thrown)).toBe(true);
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
