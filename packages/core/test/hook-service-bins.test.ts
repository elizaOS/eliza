/**
 * Covers HookService binary requirements (`requires.bins` / `requires.anyBins`):
 * PATH is pointed at a temp directory so eligibility depends only on what the
 * test places there — an executable file, a same-named non-executable file, a
 * missing name, a name containing a path separator, and an empty PATH.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookService } from "../src/services/hook.ts";
import { EventType } from "../src/types/events.ts";
import type { HookRequirements } from "../src/types/hook.ts";
import type { IAgentRuntime } from "../src/types/runtime.ts";

const runtimeStub = {
	logger: { debug() {}, info() {}, warn() {}, error() {} },
} as unknown as IAgentRuntime;

describe.skipIf(process.platform === "win32")(
	"HookService binary requirements",
	() => {
		let originalPath: string | undefined;
		let binDir: string;
		let otherDir: string;
		let service: HookService;

		beforeEach(() => {
			originalPath = process.env.PATH;
			binDir = mkdtempSync(join(tmpdir(), "hook-bins-"));
			otherDir = mkdtempSync(join(tmpdir(), "hook-bins-other-"));

			const executable = join(binDir, "hook-test-present");
			writeFileSync(executable, "#!/bin/sh\nexit 0\n");
			chmodSync(executable, 0o755);

			const notExecutable = join(binDir, "hook-test-noexec");
			writeFileSync(notExecutable, "#!/bin/sh\nexit 0\n");
			chmodSync(notExecutable, 0o644);

			process.env.PATH = binDir;
			service = new HookService(runtimeStub);
		});

		afterEach(() => {
			if (originalPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = originalPath;
			}
			rmSync(binDir, { recursive: true, force: true });
			rmSync(otherDir, { recursive: true, force: true });
		});

		const eligibilityFor = (requires: HookRequirements) => {
			const id = service.register(EventType.MESSAGE_RECEIVED, async () => {}, {
				name: "bins test",
				requires,
			});
			return service.checkEligibility(id);
		};

		it("is eligible when a required binary is an executable file on PATH", () => {
			expect(eligibilityFor({ bins: ["hook-test-present"] })).toEqual({
				eligible: true,
				reasons: undefined,
			});
		});

		it("rejects a missing binary", () => {
			expect(eligibilityFor({ bins: ["hook-test-missing"] })).toEqual({
				eligible: false,
				reasons: ["Required binary 'hook-test-missing' not found"],
			});
		});

		it("rejects a same-named file that is not executable", () => {
			expect(eligibilityFor({ bins: ["hook-test-noexec"] })).toEqual({
				eligible: false,
				reasons: ["Required binary 'hook-test-noexec' not found"],
			});
		});

		it("rejects names containing a path separator instead of resolving them", () => {
			const relative = `${binDir.split("/").pop()}/hook-test-present`;
			process.env.PATH = tmpdir();
			expect(eligibilityFor({ bins: [relative] }).eligible).toBe(false);
			expect(
				eligibilityFor({ bins: [join(binDir, "hook-test-present")] }).eligible,
			).toBe(false);
			expect(eligibilityFor({ bins: ["a\\b"] }).eligible).toBe(false);
		});

		it("finds a binary in a later PATH entry", () => {
			process.env.PATH = [otherDir, "", binDir].join(":");
			expect(eligibilityFor({ bins: ["hook-test-present"] }).eligible).toBe(
				true,
			);
		});

		it("rejects every binary when PATH is empty", () => {
			process.env.PATH = "";
			expect(eligibilityFor({ bins: ["hook-test-present"] }).eligible).toBe(
				false,
			);
		});

		it("accepts anyBins when one entry is present and another missing", () => {
			expect(
				eligibilityFor({
					anyBins: ["hook-test-missing", "hook-test-present"],
				}),
			).toEqual({ eligible: true, reasons: undefined });
		});

		it("rejects anyBins when no entry is an executable on PATH", () => {
			expect(
				eligibilityFor({ anyBins: ["hook-test-missing", "hook-test-noexec"] }),
			).toEqual({
				eligible: false,
				reasons: [
					"None of required binaries found: hook-test-missing, hook-test-noexec",
				],
			});
		});
	},
);
