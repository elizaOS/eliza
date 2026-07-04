/**
 * Device registry tests pin every supported facewear profile and the public
 * lookup helpers used by setup and status views.
 */
import { describe, expect, it } from "vitest";
import {
	DEVICE_REGISTRY,
	type FacewearDeviceType,
	getAllDeviceProfiles,
	getDeviceProfile,
} from "../devices/registry.ts";

describe("FacewearDeviceRegistry", () => {
	const EXPECTED_TYPES: FacewearDeviceType[] = [
		"meta-quest",
		"xreal",
		"even-realities",
		"apple-vision-pro",
		"simulator",
	];

	it("has all 5 device types registered", () => {
		for (const type of EXPECTED_TYPES) {
			expect(DEVICE_REGISTRY[type], `${type} not in registry`).toBeDefined();
		}
	});

	it("every profile has required fields", () => {
		for (const profile of getAllDeviceProfiles()) {
			expect(profile.id).toBeTruthy();
			expect(profile.displayName).toBeTruthy();
			expect(profile.manufacturer).toBeTruthy();
			expect(["webxr", "ble", "webxr+ble"]).toContain(profile.connectionType);
			expect(Array.isArray(profile.features)).toBe(true);
			expect(typeof profile.emulatorSupported).toBe("boolean");
		}
	});

	it("getDeviceProfile returns the correct profile", () => {
		const quest = getDeviceProfile("meta-quest");
		expect(quest.manufacturer).toBe("Meta");
		expect(quest.connectionType).toBe("webxr");

		const g1 = getDeviceProfile("even-realities");
		expect(g1.connectionType).toBe("ble");
		expect(g1.features).toContain("ble");

		const avp = getDeviceProfile("apple-vision-pro");
		expect(avp.features).toContain("visionos");
		expect(avp.nativeAppPlatform).toBe("visionos");
	});

	it("getAllDeviceProfiles returns all 5 profiles", () => {
		const all = getAllDeviceProfiles();
		expect(all).toHaveLength(5);
		const ids = all.map((p) => p.id);
		for (const type of EXPECTED_TYPES) {
			expect(ids).toContain(type);
		}
	});

	it("each XR device has emulatorSupported: true", () => {
		for (const profile of getAllDeviceProfiles()) {
			expect(profile.emulatorSupported).toBe(true);
		}
	});

	it("native devices have nativeAppPath", () => {
		expect(getDeviceProfile("meta-quest").nativeAppPath).toBe(
			"native/android/quest",
		);
		expect(getDeviceProfile("xreal").nativeAppPath).toBe(
			"native/android/xreal",
		);
		expect(getDeviceProfile("even-realities").nativeAppPath).toBe(
			"native/android/even-realities",
		);
		expect(getDeviceProfile("apple-vision-pro").nativeAppPath).toBe(
			"native/visionos",
		);
	});
});
