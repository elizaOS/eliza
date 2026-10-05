import { describe, expect, it } from "vitest";
import { resolveTrajectoryGate } from "./trajectory-gate";

describe("resolveTrajectoryGate", () => {
	it("is on for development and off for test and production by default", () => {
		expect(resolveTrajectoryGate({})).toEqual({
			enabled: true,
			reason: "dev-default-on",
		});
		expect(resolveTrajectoryGate({ NODE_ENV: "test" }).enabled).toBe(false);
		expect(resolveTrajectoryGate({ NODE_ENV: "production" })).toEqual({
			enabled: false,
			reason: "production-opt-in",
		});
	});

	it("defaults off under a protected profile regardless of NODE_ENV", () => {
		for (const NODE_ENV of [undefined, "development", "production", "test"]) {
			expect(
				resolveTrajectoryGate({
					ELIZA_PROTECTED_PROFILE: "dstack-cpu",
					NODE_ENV,
				}),
			).toEqual({ enabled: false, reason: "protected-profile-default-off" });
		}
	});

	it("treats a blank protected profile as unset", () => {
		expect(
			resolveTrajectoryGate({ ELIZA_PROTECTED_PROFILE: "  " }).enabled,
		).toBe(true);
	});

	it("lets an explicit operator opt-in win inside the protected profile", () => {
		expect(
			resolveTrajectoryGate({
				ELIZA_PROTECTED_PROFILE: "dstack-cpu",
				NODE_ENV: "production",
				ELIZA_TRAJECTORY_LOGGING: "1",
			}),
		).toEqual({ enabled: true, reason: "explicit-logging" });
		expect(
			resolveTrajectoryGate({
				ELIZA_PROTECTED_PROFILE: "dstack-cpu",
				ELIZA_TRAJECTORY_RECORDING: "true",
			}),
		).toEqual({ enabled: true, reason: "explicit-recording-legacy" });
	});

	it("keeps the hard disable flag above every opt-in", () => {
		expect(
			resolveTrajectoryGate({
				ELIZA_PROTECTED_PROFILE: "dstack-cpu",
				ELIZA_DISABLE_TRAJECTORY_LOGGING: "1",
				ELIZA_TRAJECTORY_LOGGING: "1",
			}),
		).toEqual({ enabled: false, reason: "disable-flag" });
	});
});
