import { describe, expect, it } from "vitest";
import { detectOpenVinoDevices } from "./hardware";

function detector(files: Record<string, string[] | true>) {
	const existsSync = (path: string): boolean => path in files;
	const readdirSync = (path: string): string[] => {
		const value = files[path];
		return Array.isArray(value) ? value : [];
	};
	return { existsSync, readdirSync };
}

describe("detectOpenVinoDevices", () => {
	it("prefers NPU for ASR when OpenVINO runtime and accel node are present", () => {
		const probe = detectOpenVinoDevices({
			platform: "linux",
			env: { OpenVINO_DIR: "/opt/intel/openvino_2026/runtime/cmake" },
			...detector({
				"/dev/accel": ["accel0"],
			}),
		});

		expect(probe.runtimeAvailable).toBe(true);
		expect(probe.devices).toEqual(["CPU", "NPU"]);
		expect(probe.npu.accelNodes).toEqual(["/dev/accel/accel0"]);
		expect(probe.recommendedAsrDevice).toBe("NPU");
	});

	it("warns when Intel render nodes exist without the Compute Runtime stack", () => {
		const probe = detectOpenVinoDevices({
			platform: "linux",
			env: { OpenVINO_DIR: "/opt/intel/openvino_2026/runtime/cmake" },
			...detector({
				"/dev/dri": ["card0", "renderD128"],
			}),
		});

		expect(probe.devices).toEqual(["CPU"]);
		expect(probe.gpu.renderNodes).toEqual(["/dev/dri/renderD128"]);
		expect(probe.gpu.computeRuntimeReady).toBe(false);
		expect(probe.gpu.missingLinuxPackages).toEqual([
			"intel-opencl-icd",
			"libigc2",
			"libigdfcl2",
		]);
		expect(probe.warnings[0]).toContain("Intel Compute Runtime packages");
	});

	it("does not report OpenVINO devices when the runtime is not installed", () => {
		const probe = detectOpenVinoDevices({
			platform: "linux",
			env: {},
			...detector({
				"/dev/accel": ["accel0"],
				"/dev/dri": ["renderD128"],
				"/usr/lib/x86_64-linux-gnu/intel-opencl/libigdrcl.so": true,
			}),
		});

		expect(probe.runtimeAvailable).toBe(false);
		expect(probe.devices).toEqual([]);
		expect(probe.recommendedAsrDevice).toBeNull();
		expect(probe.warnings).toContain(
			"Intel accelerator nodes are present, but OpenVINO Runtime was not found; source setupvars.sh or set OpenVINO_DIR.",
		);
	});
});
