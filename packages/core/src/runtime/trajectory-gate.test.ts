/**
 * Deterministic truth-table for the single trajectory gate resolver and a
 * property that both recorder wrappers agree with it (#13775). Pure env in,
 * boolean out — no DB, no filesystem.
 */

import { describe, expect, it } from "vitest";
import { resolveTrajectoryGate } from "./trajectory-gate";
import { isTrajectoryRecordingEnabled } from "./trajectory-recorder";

function gate(env: Record<string, string | undefined>): boolean {
	return resolveTrajectoryGate(env as NodeJS.ProcessEnv).enabled;
}

describe("resolveTrajectoryGate precedence", () => {
	it("hard opt-out wins over everything", () => {
		const decision = resolveTrajectoryGate({
			ELIZA_DISABLE_TRAJECTORY_LOGGING: "1",
			ELIZA_TRAJECTORY_LOGGING: "1",
			ELIZA_TRAJECTORY_RECORDING: "1",
			NODE_ENV: "development",
		} as NodeJS.ProcessEnv);
		expect(decision.enabled).toBe(false);
		expect(decision.reason).toBe("disable-flag");
	});

	it("explicit ELIZA_TRAJECTORY_LOGGING overrides NODE_ENV and the legacy alias", () => {
		expect(
			gate({ ELIZA_TRAJECTORY_LOGGING: "1", NODE_ENV: "production" }),
		).toBe(true);
		expect(
			gate({ ELIZA_TRAJECTORY_LOGGING: "0", NODE_ENV: "development" }),
		).toBe(false);
		expect(
			gate({
				ELIZA_TRAJECTORY_LOGGING: "1",
				ELIZA_TRAJECTORY_RECORDING: "0",
			}),
		).toBe(true);
	});

	it("coerces truthy/falsey strings for the explicit knob", () => {
		for (const v of ["1", "true", "yes", "on", "TRUE", " On "]) {
			expect(gate({ ELIZA_TRAJECTORY_LOGGING: v })).toBe(true);
		}
		for (const v of ["0", "false", "no", "off", "nonsense"]) {
			expect(gate({ ELIZA_TRAJECTORY_LOGGING: v })).toBe(false);
		}
	});

	it("treats a blank/whitespace-only explicit knob as unset, not opt-out (#13802)", () => {
		// An empty `.env` line (`ELIZA_TRAJECTORY_LOGGING=`) must not silently
		// disable dev recording — it falls through to the NODE_ENV default.
		for (const blank of ["", " ", "\t"]) {
			const dev = resolveTrajectoryGate({
				ELIZA_TRAJECTORY_LOGGING: blank,
				NODE_ENV: "development",
			} as NodeJS.ProcessEnv);
			expect(dev.enabled).toBe(true);
			expect(dev.reason).toBe("dev-default-on");

			const prod = resolveTrajectoryGate({
				ELIZA_TRAJECTORY_LOGGING: blank,
				NODE_ENV: "production",
			} as NodeJS.ProcessEnv);
			expect(prod.enabled).toBe(false);
			expect(prod.reason).toBe("production-opt-in");
		}
		// A blank canonical knob also falls through to the legacy alias.
		expect(
			gate({
				ELIZA_TRAJECTORY_LOGGING: "",
				ELIZA_TRAJECTORY_RECORDING: "1",
				NODE_ENV: "production",
			}),
		).toBe(true);
	});

	it("honors the legacy ELIZA_TRAJECTORY_RECORDING alias when the canonical knob is unset", () => {
		expect(
			gate({ ELIZA_TRAJECTORY_RECORDING: "0", NODE_ENV: "development" }),
		).toBe(false);
		expect(
			gate({ ELIZA_TRAJECTORY_RECORDING: "1", NODE_ENV: "production" }),
		).toBe(true);
	});

	it("test NODE_ENV is off by default", () => {
		const decision = resolveTrajectoryGate({
			NODE_ENV: "test",
		} as NodeJS.ProcessEnv);
		expect(decision.enabled).toBe(false);
		expect(decision.reason).toBe("test-default-off");
	});

	it("production NODE_ENV is opt-in (off by default, SOC2 O-5)", () => {
		const decision = resolveTrajectoryGate({
			NODE_ENV: "production",
		} as NodeJS.ProcessEnv);
		expect(decision.enabled).toBe(false);
		expect(decision.reason).toBe("production-opt-in");
	});

	it("dev / unset NODE_ENV is on by default", () => {
		expect(
			resolveTrajectoryGate({ NODE_ENV: "development" } as NodeJS.ProcessEnv)
				.reason,
		).toBe("dev-default-on");
		expect(gate({})).toBe(true);
	});
});

describe("recorder wrapper agrees with the gate", () => {
	it("isTrajectoryRecordingEnabled reflects resolveTrajectoryGate(process.env)", () => {
		// The file-recorder wrapper reads process.env directly; assert it matches
		// the resolver for whatever the ambient env currently is.
		expect(isTrajectoryRecordingEnabled()).toBe(
			resolveTrajectoryGate(process.env).enabled,
		);
	});
});
