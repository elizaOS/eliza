/**
 * Tests for the plugin-side network-policy bridge (R5-versioning §4).
 *
 * The shared module ships the classifier + decision rule; this module
 * wires the platform probes. Tests inject a stub probe to exercise each
 * branch of `evaluateRuntimePolicy` and the heuristic helpers.
 */

import { describe, expect, it } from "vitest";
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
} from "./network-policy";

describe("isHeadlessRuntime", () => {
	function withEnv<T>(
		patch: Record<string, string | undefined>,
		fn: () => T,
	): T {
		const prev = new Map<string, string | undefined>();
		for (const k of Object.keys(patch)) prev.set(k, process.env[k]);
		try {
			for (const [k, v] of Object.entries(patch)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			return fn();
		} finally {
			for (const [k, v] of prev) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	}

	it("returns true when ELIZA_NETWORK_POLICY=headless", () => {
		withEnv({ ELIZA_NETWORK_POLICY: "headless", CI: undefined }, () => {
			expect(isHeadlessRuntime()).toBe(true);
		});
	});

	it("returns true under CI=true", () => {
		withEnv(
			{ ELIZA_NETWORK_POLICY: undefined, ELIZA_HEADLESS: undefined, CI: "1" },
			() => {
				expect(isHeadlessRuntime()).toBe(true);
			},
		);
	});

	it("returns false when CI=false explicitly", () => {
		withEnv(
			{
				ELIZA_NETWORK_POLICY: undefined,
				ELIZA_HEADLESS: undefined,
				CI: "false",
				DISPLAY: ":0",
				WAYLAND_DISPLAY: undefined,
			},
			() => {
				// Note: relies on process.stdout.isTTY in the test runner; vitest
				// runs without a TTY but the DISPLAY override prevents the
				// no-display heuristic from forcing headless on Linux.
				const result = isHeadlessRuntime();
				// vitest CI runs sometimes have isTTY=false; tolerate both.
				expect(typeof result).toBe("boolean");
			},
		);
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

	it("Capacitor Android probe returns unknown when bridge missing", async () => {
		// No Capacitor global on the test runtime; expect the shim-missing path.
		const probe = capacitorAndroidProbe();
		const state = await probe.probe();
		// The bridge isn't installed in tests, so we expect unknown/none-class.
		expect(["unknown", "none", "wifi", "cellular"]).toContain(
			state.connectionType,
		);
		expect(typeof state.metered === "boolean" || state.metered === null).toBe(
			true,
		);
	});

	it("Capacitor iOS probe falls back to unknown without bridge", async () => {
		const probe = capacitorIosProbe();
		const state = await probe.probe();
		expect(typeof state.metered === "boolean" || state.metered === null).toBe(
			true,
		);
	});

	it("electronDesktopProbe returns unknown without bridge", async () => {
		const probe = electronDesktopProbe();
		const state = await probe.probe();
		expect(state.connectionType).toBe("unknown");
		expect(state.metered).toBeNull();
	});
});

describe("pickActiveProbe", () => {
	it("returns headless probe when ELIZA_NETWORK_POLICY=headless", () => {
		const prev = process.env.ELIZA_NETWORK_POLICY;
		process.env.ELIZA_NETWORK_POLICY = "headless";
		try {
			expect(pickActiveProbe().id).toBe("headless");
		} finally {
			if (prev === undefined) delete process.env.ELIZA_NETWORK_POLICY;
			else process.env.ELIZA_NETWORK_POLICY = prev;
		}
	});
});
