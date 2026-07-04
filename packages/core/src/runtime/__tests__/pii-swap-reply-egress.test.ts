/**
 * Reply-boundary egress test for the PII pseudonymization layer (#10827).
 *
 * The tool-call boundary (`execute-planned-tool-call.ts`) restores real PII into
 * handler args, but a direct/terminal reply that does NOT go through a tool call
 * would otherwise ship the surrogate to the user. `restorePiiInUserReplyText`
 * is the restore wired into `createV5ReplyStrategyResult` — the single chokepoint
 * every user-facing reply (direct `final_reply`, terminal `messageToUser`,
 * terminal planner `REPLY`, LifeOps direct) is built through. This proves the
 * user sees the REAL value while the surrogate is what the model produced
 * (i.e. what the trajectory/providers kept).
 */
import { describe, expect, it } from "vitest";
import {
	GazetteerEntityRecognizer,
	PseudonymSession,
} from "../../security/index.js";
import { restorePiiInUserReplyText } from "../../services/message";
import { runWithTrajectoryContext } from "../../trajectory-context";


/** A turn session over a known contact roster, exactly as the ingress mints one. */
function sessionWithContacts(): PseudonymSession {
	return new PseudonymSession({
		salt: "fixed",
		recognizer: new GazetteerEntityRecognizer([
			{ kind: "person", value: "Dana Whitfield" },
			{ kind: "org", value: "Acme Robotics" },
		]),
	});
}

describe("PII swap egress at the user-facing reply boundary (#10827)", () => {
	it("restores the real value into a direct reply the model wrote with a surrogate", async () => {
		const session = sessionWithContacts();
		await session.learn("Dana Whitfield works at Acme Robotics");
		const dana = session.entries.find((e) => e.value === "Dana Whitfield")
			?.surrogate as string;
		const acme = session.entries.find((e) => e.value === "Acme Robotics")
			?.surrogate as string;
		// Sanity: the surrogate is a real, different name (not the raw value).
		expect(dana).toBeTruthy();
		expect(dana).not.toBe("Dana Whitfield");

		// The model produced SURROGATES in its reply text (that is what the
		// trajectory/providers/logs kept).
		const modelReply = `I've sent that note to ${dana} at ${acme}.`;

		const shownToUser = await runWithTrajectoryContext(
			{ runId: "reply-1", piiSwapSession: session },
			() => restorePiiInUserReplyText(modelReply),
		);

		// The user sees the REAL contact + org, never the surrogate.
		expect(shownToUser).toBe(
			"I've sent that note to Dana Whitfield at Acme Robotics.",
		);
		expect(shownToUser).not.toContain(dana);
		expect(shownToUser).not.toContain(acme);
	});

	it("leaves a brand-new name the model invented unchanged (best-effort)", async () => {
		const session = sessionWithContacts();
		await session.learn("Dana Whitfield");

		const shown = await runWithTrajectoryContext(
			{ runId: "reply-2", piiSwapSession: session },
			() => restorePiiInUserReplyText("Reaching out to Someone New now."),
		);

		expect(shown).toBe("Reaching out to Someone New now.");
	});

	it("is a passthrough no-op when PII swap is disabled (no session on the turn)", () => {
		// No trajectory context / no session → the surrogate-looking text (there is
		// none to restore) flows through untouched, at zero cost.
		expect(restorePiiInUserReplyText("Plain reply, no PII.")).toBe(
			"Plain reply, no PII.",
		);
	});

	it("only restores at the reply boundary — the surrogate is what the model saw", async () => {
		const session = sessionWithContacts();
		await session.learn("Dana Whitfield");
		const dana = session.entries.find((e) => e.value === "Dana Whitfield")
			?.surrogate as string;

		// The pseudonymized copy (what the model + trajectory + providers see)
		// carries the surrogate; the restore only happens at egress.
		const pseudonymized = session.substituteInValue(
			"Remind Dana Whitfield about lunch.",
		);
		expect(pseudonymized).toContain(dana);
		expect(pseudonymized).not.toContain("Dana Whitfield");

		const shown = await runWithTrajectoryContext(
			{ runId: "reply-3", piiSwapSession: session },
			() => restorePiiInUserReplyText(pseudonymized),
		);
		expect(shown).toBe("Remind Dana Whitfield about lunch.");
	});
});
