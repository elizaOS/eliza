/**
 * Unit tests for computer-use adapter conformance test runner and case definitions.
 * Validates required case inventory, identity invariants, and conformance failure modes.
 */
import { describe, expect, it } from "vitest";
import type {
	InteractionAdapter,
	InteractionSession,
	InteractionSurfaceRef,
} from "../contracts/computer-use.ts";
import {
	REQUIRED_INTERACTION_CONFORMANCE_CASES,
	runInteractionAdapterConformance,
} from "../testing/computer-use-conformance.ts";

describe("computer-use-conformance", () => {
	describe("REQUIRED_INTERACTION_CONFORMANCE_CASES", () => {
		it("contains all mandatory conformance cases", () => {
			expect(REQUIRED_INTERACTION_CONFORMANCE_CASES).toContain("success");
			expect(REQUIRED_INTERACTION_CONFORMANCE_CASES).toContain(
				"failed_no_effect",
			);
			expect(REQUIRED_INTERACTION_CONFORMANCE_CASES).toContain(
				"uncertain_effect",
			);
			expect(REQUIRED_INTERACTION_CONFORMANCE_CASES).toContain("policy_block");
			expect(REQUIRED_INTERACTION_CONFORMANCE_CASES).toContain("confirmation");
			expect(REQUIRED_INTERACTION_CONFORMANCE_CASES).toContain("unsupported");
			expect(REQUIRED_INTERACTION_CONFORMANCE_CASES).toContain(
				"stale_observation",
			);
			expect(REQUIRED_INTERACTION_CONFORMANCE_CASES).toHaveLength(7);
		});
	});

	describe("runInteractionAdapterConformance validation", () => {
		it("fails when adapter and session identifiers do not match", async () => {
			const adapter: InteractionAdapter = {
				id: "adapter-1",
				capabilities: async () => ({
					adapterId: "adapter-1",
					adapterVersion: "1.0.0",
					surfaceKinds: ["window"],
					actionKinds: ["click"],
					features: [],
				}),
				observe: async () => ({}) as unknown as InteractionObservation,
				execute: async () => ({}) as unknown as InteractionActionResult,
			};

			const session: InteractionSession = {
				sessionId: "session-1",
				adapterId: "adapter-2", // mismatched!
				createdAt: 1000,
				expiresAt: 2000,
				status: "ACTIVE",
				generation: 1,
				surfaces: [],
			};

			const surface: InteractionSurfaceRef = {
				surfaceId: "surf-1",
				sessionId: "session-1",
				adapterId: "adapter-1",
				kind: "window",
				generation: 1,
			};

			await expect(
				runInteractionAdapterConformance({
					adapter,
					session,
					surface,
					fixtures: [],
				}),
			).rejects.toThrow(
				"Adapter, session, and surface identifiers do not match.",
			);
		});

		it("fails when required conformance cases are missing", async () => {
			const surface: InteractionSurfaceRef = {
				surfaceId: "surf-1",
				sessionId: "session-1",
				adapterId: "adapter-1",
				kind: "window",
				generation: 1,
			};

			const session: InteractionSession = {
				sessionId: "session-1",
				adapterId: "adapter-1",
				createdAt: 1000,
				expiresAt: 2000,
				status: "ACTIVE",
				generation: 1,
				surfaces: [surface],
			};

			const adapter: InteractionAdapter = {
				id: "adapter-1",
				capabilities: async () => ({
					adapterId: "adapter-1",
					adapterVersion: "1.0.0",
					surfaceKinds: ["window"],
					actionKinds: ["click"],
					features: [],
				}),
				observe: async () => ({}) as unknown as InteractionObservation,
				execute: async () => ({}) as unknown as InteractionActionResult,
			};

			await expect(
				runInteractionAdapterConformance({
					adapter,
					session,
					surface,
					fixtures: [], // missing required cases!
				}),
			).rejects.toThrow("Missing required interaction conformance case");
		});
	});
});
