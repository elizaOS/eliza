/**
 * Composes the suites that drive the user-facing callback modules touched by
 * the fencePreformatted change (shell transcript, grep matches, ls listings,
 * file device entries, and the format helpers). The changed-file coverage gate
 * runs only tests present in a PR diff, so this lane keeps callback-formatting
 * changes attached to the existing behavioral matrix. Mirrors the discord
 * messages/service regression lanes.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import "./bash.error-path.test.ts";
import "./bash.test.ts";
import "./file.test.ts";
import "./grep.test.ts";
import "./ls.test.ts";
import "../lib/format.test.ts";

describe("coding actions regression lane composition", () => {
	it("imports every co-located suite for the fenced callback modules", () => {
		const selfSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
		const imported = [...selfSource.matchAll(/import "\.\/([^"]+)";/g)]
			.map((match) => match[1])
			.sort();
		const here = path.dirname(fileURLToPath(import.meta.url));
		const suites = readdirSync(here)
			.filter(
				(name) =>
					/^(bash|grep|ls|file)[.-].*test\.ts$/.test(name) &&
					name !== path.basename(fileURLToPath(import.meta.url)),
			)
			.sort();
		expect(imported).toEqual(suites);
	});
});
