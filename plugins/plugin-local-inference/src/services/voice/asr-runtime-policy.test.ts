/** Proves Apple-silicon ASR settings normalize explicitly and reject ambiguity. */

import { describe, expect, it } from "vitest";
import {
	AsrRuntimePolicyError,
	resolveAsrRuntimeSetting,
} from "./asr-runtime-policy";

describe("ASR runtime accelerator policy", () => {
	it("defaults Apple silicon to the correctness-proven CPU path", () => {
		expect(resolveAsrRuntimeSetting({}, "darwin", "arm64")).toBe("0");
	});

	it.each(["1", "true", "YES", "on"])(
		"normalizes the explicit GPU override %s",
		(value) => {
			const env: NodeJS.ProcessEnv = { ELIZA_ASR_USE_GPU: value };

			expect(resolveAsrRuntimeSetting(env, "darwin", "arm64")).toBe("1");
		},
	);

	it.each(["0", "false", "NO", "off"])(
		"normalizes the explicit CPU override %s",
		(value) => {
			const env: NodeJS.ProcessEnv = { ELIZA_ASR_USE_GPU: value };

			expect(resolveAsrRuntimeSetting(env, "darwin", "arm64")).toBe("0");
		},
	);

	it.each(["", " ", "auto", "2"])(
		"rejects the ambiguous override %j instead of falling back to GPU",
		(value) => {
			expect(() =>
				resolveAsrRuntimeSetting(
					{ ELIZA_ASR_USE_GPU: value },
					"darwin",
					"arm64",
				),
			).toThrow(AsrRuntimePolicyError);
		},
	);

	it("does not constrain other platforms or architectures", () => {
		const linuxEnv: NodeJS.ProcessEnv = {};
		const intelMacEnv: NodeJS.ProcessEnv = {};

		expect(resolveAsrRuntimeSetting(linuxEnv, "linux", "arm64")).toBeNull();
		expect(resolveAsrRuntimeSetting(intelMacEnv, "darwin", "x64")).toBeNull();
	});

	it("still rejects invalid explicit values on platforms using native defaults", () => {
		expect(() =>
			resolveAsrRuntimeSetting({ ELIZA_ASR_USE_GPU: "auto" }, "linux", "x64"),
		).toThrow(AsrRuntimePolicyError);
	});
});
