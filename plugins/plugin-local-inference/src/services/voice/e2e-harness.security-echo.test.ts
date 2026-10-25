/** Covers the voice E2E harness echo-rejection and owner-security scoring (#9147). Deterministic, fixture inputs. */
import { describe, expect, it } from "vitest";
import {
	type EchoRejectionSample,
	type OwnerSecuritySample,
	scoreEchoRejection,
	scoreOwnerSecurity,
} from "./e2e-harness";

// #9147 — self-echo rejection ("did the agent talk to itself?") and owner-vs-
// impostor gating are two of the three heavy voice cases the issue calls out as
// having scorers that "do not run anywhere that gates merges". These scorers are
// pure + GGUF-independent, so pin their decision math here so the gate runs.

const echo = (
	isAgentEcho: boolean,
	responded: boolean,
): EchoRejectionSample => ({
	isAgentEcho,
	responded,
});

describe("scoreEchoRejection (#9147)", () => {
	it("passes when every agent-echo turn is suppressed", () => {
		const r = scoreEchoRejection([echo(true, false), echo(true, false)]);
		expect(r.total).toBe(2);
		expect(r.rejected).toBe(2);
		expect(r.rejectionRate).toBe(1);
		expect(r.passed).toBe(true);
	});

	it("scores ONLY agent-echo turns (real turns are ignored here)", () => {
		// 2 echo (one leaked) + 2 real turns the agent answered (must not count).
		const r = scoreEchoRejection([
			echo(true, false),
			echo(true, true),
			echo(false, true),
			echo(false, true),
		]);
		expect(r.total).toBe(2);
		expect(r.rejected).toBe(1);
		expect(r.rejectionRate).toBe(0.5);
		expect(r.passed).toBe(false); // 0.5 < default 0.9 floor
	});

	it("fails closed when there are no echo samples to prove rejection", () => {
		const r = scoreEchoRejection([echo(false, true)]);
		expect(r.total).toBe(0);
		expect(r.rejectionRate).toBe(0);
		expect(r.passed).toBe(false);
	});

	it("honors a custom minRejectionRate floor", () => {
		const samples = [echo(true, false), echo(true, false), echo(true, true)];
		expect(scoreEchoRejection(samples).passed).toBe(false); // 0.6667 < 0.9
		expect(scoreEchoRejection(samples, { minRejectionRate: 0.6 }).passed).toBe(
			true,
		); // 0.6667 >= 0.6
	});
});

const sec = (
	predictedOwner: boolean,
	expectedOwner: boolean,
): OwnerSecuritySample => ({
	predictedOwner,
	expectedOwner,
});

describe("scoreOwnerSecurity (#9147)", () => {
	it("passes only when accuracy is high AND no impostor is accepted", () => {
		const r = scoreOwnerSecurity([sec(true, true), sec(false, false)]);
		expect(r.accuracy).toBe(1);
		expect(r.impostorAcceptRate).toBe(0);
		expect(r.passed).toBe(true);
	});

	it("FAILS on a single impostor-accept even at high overall accuracy", () => {
		// 9 correct + 1 stranger let in as owner → accuracy 0.9 but a real breach.
		const samples = [
			...Array.from({ length: 9 }, () => sec(true, true)),
			sec(true, false),
		];
		const r = scoreOwnerSecurity(samples);
		expect(r.accuracy).toBe(0.9);
		expect(r.impostorAcceptRate).toBeGreaterThan(0);
		expect(r.passed).toBe(false); // default maxImpostorAcceptRate is 0
	});

	it("treats rejecting the real owner as friction, not a security failure", () => {
		// owner rejected once (friction) but no impostor accepted.
		const r = scoreOwnerSecurity(
			[sec(false, true), sec(false, false), sec(false, false)],
			{ minAccuracy: 0.6 },
		);
		expect(r.ownerRejectRate).toBe(1);
		expect(r.impostorAcceptRate).toBe(0);
		expect(r.passed).toBe(true); // 2/3 accuracy >= 0.6 floor, no impostor in
	});

	it("fails closed on an empty sample set", () => {
		expect(scoreOwnerSecurity([]).passed).toBe(false);
	});
});
