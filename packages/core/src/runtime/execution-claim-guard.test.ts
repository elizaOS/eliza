/**
 * Recognizer matrix for the simple-turn execution-claim guard: first-person
 * promises of imminent tool/background output must fire (including the four
 * live 2026-08-24 evidence replies), while offers, questions, completed-work
 * claims, and ordinary conversational futures must not.
 */
import { describe, expect, it } from "vitest";
import {
	findImminentExecutionPromise,
	replyPromisesImminentExecution,
} from "./execution-claim-guard";

describe("replyPromisesImminentExecution — live evidence replies fire", () => {
	it.each([
		// tj-cb6f91c5e32afe
		"it wasn't a hang or an error—it just finished and the output was empty.\n\ni'll re-run the t=3 action now... one second",
		// tj-cc509ce7e91f86
		"makes sense. it's a binary outcome now. i'm sending 10 and i'll paste the exact return here as soon as it hits.",
		// tj-cc8c77e1691584
		"i'm on it. will post the exact output here the second it lands.",
		// tj-d166d2a722e44d
		"still waiting for it to land. i'll drop the output here the second it does.",
	])("fires on: %s", (reply) => {
		expect(replyPromisesImminentExecution(reply)).toBe(true);
	});

	it.each([
		"i'll re-run the failing test now",
		"I will execute the script and report back",
		"i'm going to paste the full log here",
		"i'll spawn a fresh sub-agent for this",
		"i'll kick off the build shortly",
		"i'll ping everyone in 10 minutes if nothing's landed",
		"i'll nudge the channel in 5 min",
		"i'm re-running it right now",
		"i'll check the status as soon as the deploy finishes",
		"i'll get back to you shortly with the numbers",
		"ok. will send the diff once it finishes",
	])("fires on promise variant: %s", (reply) => {
		expect(replyPromisesImminentExecution(reply)).toBe(true);
	});
});

describe("replyPromisesImminentExecution — honest replies never fire", () => {
	it.each([
		// offers and conditionals are not promises
		"i can run it again if you want",
		"want me to re-run it?",
		"should i paste the output here?",
		"happy to check it whenever you like",
		// completed-work claims are the side-effect-claims module's beat
		"i ran it and here's the output: 011",
		"done — the file is saved",
		// plain answers, even with temporal words
		"right now the answer is 42",
		"the script will paste its own output when it finishes",
		"nothing is running that could time out",
		// conversational futures with non-execution verbs
		"i'll be honest, that looks wrong",
		"i'll admit that surprised me",
		"i'll get back to you on that",
		"i'll check it out sometime",
		"let me know if you want me to run it",
		// questions about someone else's send
		"will you send it over?",
		// empty / whitespace
		"",
		"   ",
	])("stays quiet on: %s", (reply) => {
		expect(replyPromisesImminentExecution(reply)).toBe(false);
	});
});

describe("findImminentExecutionPromise — evidence fragment", () => {
	it("returns the matched commitment fragment for debug traces", () => {
		const evidence = findImminentExecutionPromise(
			"i'll re-run the t=3 action now",
		);
		expect(evidence).toContain("re-run");
	});

	it("returns null when no promise exists", () => {
		expect(findImminentExecutionPromise("sounds good, thanks")).toBeNull();
	});
});
