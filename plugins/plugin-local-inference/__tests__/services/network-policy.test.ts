/**
 * Exercises native network probes and model-download decisions with controlled
 * bridge responses and environment state. No native device or download runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	capacitorAndroidProbe,
	capacitorIosProbe,
	describeRuntimeNetwork,
	electronDesktopProbe,
	evaluateRuntimePolicy,
	HEADLESS_PROBE,
	isHeadlessRuntime,
	NODE_DEFAULT_PROBE,
	pickActiveProbe,
} from "../../src/services/network-policy";

beforeEach(() => {
	for (const name of ["ELIZA_NETWORK_POLICY", "ELIZA_HEADLESS", "CI", "ELIZA_BIONIC_HOST_DELEGATED", "ELIZA_BIONIC_INFERENCE_SOCK"]) {
		vi.stubEnv(name, undefined);
	}
	vi.stubEnv("DISPLAY", ":0");
	for (const name of [
		"Capacitor",
		"ElizaNetworkPolicy",
		"electrobunNative",
		"electronAPI",
	]) {
		vi.stubGlobal(name, undefined);
	}
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("isHeadlessRuntime", () => {
	it.each([
		["ELIZA_NETWORK_POLICY", "headless"],
		["CI", "1"],
	])("detects headless mode from %s=%s", (name, value) => {
		vi.stubEnv(name, value);
		expect(isHeadlessRuntime()).toBe(true);
	});

	it("returns false when CI=false with a display available", () => {
		vi.stubEnv("CI", "false");
		expect(isHeadlessRuntime()).toBe(false);
	});
});

describe("evaluateRuntimePolicy", () => {
	it("auto-allows on wifi-unmetered when user-pref autoUpdateOnWifi=true", async () => {
		const decision = await evaluateRuntimePolicy({
			prefs: {
				autoUpdateOnWifi: true,
				autoUpdateOnCellular: false,
				autoUpdateOnMetered: false,
				quietHours: [],
			},
			estimatedBytes: 1024 * 1024,
			probe: {
				id: "node-default",
				async probe() {
					return { connectionType: "wifi", metered: false };
				},
			},
		});
		expect(decision.allow).toBe(true);
		expect(decision.reason).toBe("auto");
		expect(decision.class).toBe("wifi-unmetered");
	});

	it("asks on cellular when autoUpdateOnCellular=false", async () => {
		const decision = await evaluateRuntimePolicy({
			prefs: {
				autoUpdateOnWifi: true,
				autoUpdateOnCellular: false,
				autoUpdateOnMetered: false,
				quietHours: [],
			},
			estimatedBytes: 1024 * 1024,
			probe: {
				id: "node-default",
				async probe() {
					return { connectionType: "cellular", metered: null };
				},
			},
		});
		expect(decision.allow).toBe(false);
		expect(decision.reason).toBe("cellular-ask");
	});

	it("returns headless-explicit-only when probe id is headless", async () => {
		const decision = await evaluateRuntimePolicy({
			estimatedBytes: 1024 * 1024,
			probe: HEADLESS_PROBE,
		});
		expect(decision.allow).toBe(false);
		expect(decision.reason).toBe("headless-explicit-only");
	});

	it("downgrades to ask when quiet hours match even with auto-eligible class", async () => {
		// 22:30 local time inside the default quiet window (22:00-08:00).
		const now = new Date();
		now.setHours(22, 30, 0, 0);
		const decision = await evaluateRuntimePolicy({
			prefs: {
				autoUpdateOnWifi: true,
				autoUpdateOnCellular: false,
				autoUpdateOnMetered: false,
				quietHours: [{ start: "22:00", end: "08:00" }],
			},
			estimatedBytes: 1024 * 1024,
			probe: {
				id: "node-default",
				async probe() {
					return { connectionType: "wifi", metered: false };
				},
			},
			now,
		});
		expect(decision.allow).toBe(false);
	});
});

describe("describeRuntimeNetwork", () => {
	it("reports the raw probe state alongside the decision", async () => {
		const out = await describeRuntimeNetwork({
			prefs: {
				autoUpdateOnWifi: true,
				autoUpdateOnCellular: false,
				autoUpdateOnMetered: false,
				quietHours: [],
			},
			estimatedBytes: 0,
			probe: {
				id: "node-default",
				async probe() {
					return { connectionType: "wifi", metered: false };
				},
			},
		});
		expect(out.probeId).toBe("node-default");
		expect(out.state).toEqual({ connectionType: "wifi", metered: false });
		expect(out.class).toBe("wifi-unmetered");
		expect(out.decision.reason).toBe("auto");
	});
});

describe("platform probe factories", () => {
	it("NODE_DEFAULT_PROBE returns unknown", async () => {
		const state = await NODE_DEFAULT_PROBE.probe();
		expect(state).toEqual({ connectionType: "unknown", metered: null });
	});

	it("HEADLESS_PROBE returns unknown (decision rule short-circuits)", async () => {
		const state = await HEADLESS_PROBE.probe();
		expect(state).toEqual({ connectionType: "unknown", metered: null });
	});

	it.each([
		["Android", capacitorAndroidProbe],
		["iOS", capacitorIosProbe],
		["desktop", electronDesktopProbe],
	] as const)(
		"%s probe reports unknown without its bridge",
		async (_name, createProbe) => {
			await expect(createProbe().probe()).resolves.toEqual({
				connectionType: "unknown",
				metered: null,
			});
		},
	);

	it.each([true, "throws"] as const)(
		"Android metering handles native response %s",
		async (response) => {
			vi.stubGlobal("ElizaNetworkPolicy", {
				getMeteredHint: async () => {
					if (response === "throws") throw new Error("simulated native error");
					return { metered: response };
				},
			});
			expect((await capacitorAndroidProbe().probe()).metered).toBe(
				response === "throws" ? null : response,
			);
		},
	);

	function setIosPathHints(hints: unknown): void {
		vi.stubGlobal("ElizaNetworkPolicy", {
			getPathHints: async () => {
				if (hints === "throws") throw new Error("simulated native error");
				return hints;
			},
		});
	}

	it.each([
		{ isExpensive: false, isConstrained: true, metered: true },
		{ isExpensive: false, isConstrained: false, metered: false },
		{ isExpensive: true, isConstrained: false, metered: true },
		{ isExpensive: true, isConstrained: true, metered: true },
	])(
		"iOS metering for $isExpensive / $isConstrained is $metered",
		async ({ metered, ...hints }) => {
			setIosPathHints(hints);
			expect((await capacitorIosProbe().probe()).metered).toBe(metered);
		},
	);

	it.each([
		null,
		undefined,
		{},
		{ isExpensive: null, isConstrained: null },
		{ isExpensive: false },
		{ isConstrained: false },
		{ isExpensive: false, isConstrained: null },
		{ isExpensive: 0, isConstrained: false },
		{ isExpensive: false, isConstrained: "false" },
	])(
		"does not authorize a Wi-Fi download from unknown iOS hints %#",
		async (hints) => {
			vi.stubGlobal("Capacitor", {
				Plugins: {
					Network: { getStatus: async () => ({ connectionType: "wifi" }) },
				},
			});
			setIosPathHints(hints);
			const probe = capacitorIosProbe();
			await expect(probe.probe()).resolves.toEqual({
				connectionType: "wifi",
				metered: null,
			});
			await expect(
				evaluateRuntimePolicy({ probe, estimatedBytes: 2 ** 30 }),
			).resolves.toMatchObject({ allow: false });
		},
	);

	it.each([
		{ isExpensive: true, isConstrained: null },
		{ isExpensive: null, isConstrained: true },
	])(
		"preserves restrictive iOS hints when the other value is unknown %#",
		async (hints) => {
			setIosPathHints(hints);
			expect((await capacitorIosProbe().probe()).metered).toBe(true);
		},
	);

	it("Capacitor iOS probe falls back to metered=null when the path-hints shim throws", async () => {
		setIosPathHints("throws");
		expect((await capacitorIosProbe().probe()).metered).toBeNull();
	});

	it("Low Data Mode requires confirmation for a 3GB Wi-Fi download", async () => {
		vi.stubGlobal("Capacitor", {
			Plugins: {
				Network: {
					getStatus: async () => ({ connected: true, connectionType: "wifi" }),
				},
			},
		});
		const threeGigabytes = 3 * 1024 * 1024 * 1024;
		// Outside the default 22:00-08:00 quiet hours so the flip is caused by
		// metering, not the clock.
		const noon = new Date(2024, 0, 1, 12, 0, 0);
		setIosPathHints({ isExpensive: false, isConstrained: true });
		const snapshot = await describeRuntimeNetwork({
			probe: capacitorIosProbe(),
			estimatedBytes: threeGigabytes,
			now: noon,
		});
		expect(snapshot.state).toEqual({ connectionType: "wifi", metered: true });
		expect(snapshot.class).toBe("wifi-metered");
		expect(snapshot.decision.allow).toBe(false);
		expect(snapshot.decision.reason).toBe("metered-ask");
		expect(snapshot.decision.estimatedBytes).toBe(threeGigabytes);
	});
});

describe("pickActiveProbe", () => {
	it("uses the host socket without a renderer and fails closed when the host disappears", async () => {
		vi.stubEnv("DISPLAY", undefined);
		vi.stubEnv("WAYLAND_DISPLAY", undefined);
		vi.stubEnv("ELIZA_BIONIC_HOST_DELEGATED", "1");
		vi.stubEnv("ELIZA_BIONIC_INFERENCE_SOCK", `eliza-missing-${crypto.randomUUID()}`);
		const snapshot = await describeRuntimeNetwork({ estimatedBytes: 1_000_000 });
		expect(snapshot.probeId).toBe("android-host");
		expect(snapshot.state).toEqual({ connectionType: "unknown", metered: null });
		expect(snapshot.decision.allow).toBe(false);
	});
	it("preserves explicit headless policy even with a native host", () => {
		vi.stubEnv("ELIZA_BIONIC_HOST_DELEGATED", "1");
		vi.stubEnv("ELIZA_BIONIC_INFERENCE_SOCK", "unused-native-host");
		vi.stubEnv("ELIZA_NETWORK_POLICY", "headless");
		expect(pickActiveProbe().id).toBe("headless");
	});
	it("returns headless probe when ELIZA_NETWORK_POLICY=headless", () => {
		vi.stubEnv("ELIZA_NETWORK_POLICY", "headless");
		expect(pickActiveProbe().id).toBe("headless");
	});
});
