/** Covers building and running the voice workbench and writing its result. Deterministic. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildAndRunVoiceWorkbench,
	writeVoiceWorkbenchResult,
} from "./workbench-entrypoint";
import { groundTruthMockServices } from "./workbench-scenarios";

describe("buildAndRunVoiceWorkbench", () => {
	it("the mocked lane runs the whole matrix to an overall PASS + Markdown", async () => {
		const { report, markdown } = await buildAndRunVoiceWorkbench({
			services: groundTruthMockServices(),
		});
		expect(report.overall).toBe("pass");
		expect(report.scenariosSkipped).toBe(0);
		expect(report.scenariosRan).toBeGreaterThan(0);
		expect(markdown).toContain("Voice Workbench");
		expect(markdown).toContain("WER");
	});

	it("the real lane with no backend skips every scenario (never pass)", async () => {
		const { report } = await buildAndRunVoiceWorkbench({ services: null });
		expect(report.overall).toBe("skipped");
		expect(report.scenariosRan).toBe(0);
	});
});

describe("writeVoiceWorkbenchResult", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), "voice-workbench-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes report.json + report.md", async () => {
		const result = await buildAndRunVoiceWorkbench({
			services: groundTruthMockServices(),
		});
		const { reportJsonPath, reportMarkdownPath } = writeVoiceWorkbenchResult(
			result,
			dir,
		);
		const json = JSON.parse(readFileSync(reportJsonPath, "utf8")) as {
			overall: string;
		};
		expect(json.overall).toBe("pass");
		expect(readFileSync(reportMarkdownPath, "utf8")).toContain(
			"Voice Workbench",
		);
	});
});
