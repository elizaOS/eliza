/**
 * Proves the package build rejects checkout paths in every emitted artifact,
 * including JavaScript maps and declaration maps that npm publishes.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRelocatableRuntimeOutput } from "../build-relocation-audit";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createOutputRoot(): string {
	const outputRoot = mkdtempSync(
		path.join(tmpdir(), "local-inference-relocation-audit-"),
	);
	temporaryDirectories.push(outputRoot);
	return outputRoot;
}

describe("local-inference build relocation audit", () => {
	it.each(["index.js", "index.js.map", "runtime/index.d.ts.map"])(
		"rejects an absolute checkout path in %s",
		(relativeFile) => {
			const outputRoot = createOutputRoot();
			const forbiddenRoot = path.join(outputRoot, "source-checkout");
			const outputFile = path.join(outputRoot, relativeFile);
			mkdirSync(path.dirname(outputFile), { recursive: true });
			writeFileSync(outputFile, `runtime path: ${forbiddenRoot}\n`);

			expect(() =>
				assertRelocatableRuntimeOutput(outputRoot, forbiddenRoot),
			).toThrow(relativeFile);
		},
	);

	it("accepts relative runtime references", () => {
		const outputRoot = createOutputRoot();
		mkdirSync(path.join(outputRoot, "runtime"));
		writeFileSync(
			path.join(outputRoot, "index.js"),
			'import("./runtime/index.js");\n',
		);
		writeFileSync(
			path.join(outputRoot, "runtime", "index.d.ts.map"),
			JSON.stringify({ sources: ["../../src/runtime/index.ts"] }),
		);

		expect(() =>
			assertRelocatableRuntimeOutput(outputRoot, "/checkout/eliza"),
		).not.toThrow();
	});

	it("rejects symlinks instead of following files outside the package", () => {
		const outputRoot = createOutputRoot();
		const externalRoot = createOutputRoot();
		const externalFile = path.join(externalRoot, "external-runtime.js");
		writeFileSync(externalFile, "export {};\n");
		symlinkSync(externalFile, path.join(outputRoot, "linked-runtime.js"));

		expect(() =>
			assertRelocatableRuntimeOutput(outputRoot, "/checkout/eliza"),
		).toThrow("non-regular entry");
	});
});
