import { describe, expect, it } from "vitest";
import { checkWebGpuSupport } from "./webgpu-browser-support";

describe("webgpu browser support", () => {
	it("reports CEF-specific requirements when CEF is active", () => {
		const status = checkWebGpuSupport("cef");

		expect(status.renderer).toBe("cef");
		expect(status.reason).toContain("CEF needs WebGPU-related Chromium flags");
	});

	it("reports native renderer support without falling back to unknown", () => {
		const status = checkWebGpuSupport("native");

		expect(status.renderer).toBe("native");
		expect(status.reason).not.toContain("Unable to determine");
	});
});
