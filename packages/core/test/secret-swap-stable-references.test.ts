/**
 * A fresh nonce per turn rewrote every contact and credential reference in the
 * system prompt and the transcript, so a provider's prefix cache matched about
 * a tenth of a phone conversation's request. A host can opt into references
 * that stay the same for one conversation.
 */
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import {
	createSecretSwapStableKey,
	SecretSwapSession,
	SecretSwapUnresolvedPlaceholderError,
} from "../src/security/secret-swap.ts";
import { runWithTrajectoryContext } from "../src/trajectory-context.ts";
import type { Character } from "../src/types/agent.ts";
import { ModelType } from "../src/types/model.ts";

const earlier = "text 415-555-0100 saying hi";
const later = `${earlier}\nand mail bob@example.com the api_key: "zx81-not-a-real-key-1234"`;

it("mints the same reference for a value in every session that shares the key", () => {
	const stableKey = createSecretSwapStableKey();
	const first = new SecretSwapSession({ stableKey });
	const second = new SecretSwapSession({ stableKey });
	const sent = first.substituteText(earlier);
	// A later turn learns more values, in another order, before the old text.
	second.substituteText('password: "hunter2-hunter2"');
	const resent = second.substituteText(later);
	expect(sent).toMatch(/^text __ELIZA_CONTACT_[0-9a-f]{16}_\d+__ saying hi$/);
	expect(resent.startsWith(sent)).toBe(true);
	expect(resent).not.toContain("zx81");
	expect(second.restoreText(resent)).toBe(later);
});

it("keeps conversations and default sessions apart", () => {
	const key = createSecretSwapStableKey();
	const room = new SecretSwapSession({ stableKey: `${key}:room-a` });
	const other = new SecretSwapSession({ stableKey: `${key}:room-b` });
	const reference = room.substituteText(earlier);
	expect(other.substituteText(earlier)).not.toBe(reference);
	expect(new SecretSwapSession().substituteText(earlier)).not.toBe(
		new SecretSwapSession().substituteText(earlier),
	);
	// Another conversation's reference is plain text here, never a value.
	expect(other.restoreText(reference)).toBe(reference);
	// A reference of this conversation that this session never minted fails.
	const forged = reference.replace(/_\d+__/, "_999999999__");
	expect(() => room.restoreText(forged, { failOnUnresolved: true })).toThrow(
		SecretSwapUnresolvedPlaceholderError,
	);
});

it("restores only references the session itself wrote", () => {
	const stableKey = createSecretSwapStableKey();
	const knownSecrets = { SERVICE_KEY: "zx81-not-a-real-key-1234" };
	const earlierTurn = new SecretSwapSession({ stableKey, knownSecrets });
	const leaked = earlierTurn.substituteText(
		"use zx81-not-a-real-key-1234 and call 415-555-0100",
	);
	const [secretReference, contactReference] =
		leaked.match(/__ELIZA_(?:SECRET|CONTACT)_[0-9a-f]{16}_\d+__/g) ?? [];
	// A later turn of the same conversation knows the secret but never shows it.
	const laterTurn = new SecretSwapSession({ stableKey, knownSecrets });
	laterTurn.substituteText("what time is it?");
	for (const replayed of [secretReference, contactReference]) {
		expect(laterTurn.restoreText(`fetch ${replayed}`)).toBe(
			`fetch ${replayed}`,
		);
		expect(() =>
			laterTurn.restoreText(`fetch ${replayed}`, { failOnUnresolved: true }),
		).toThrow(SecretSwapUnresolvedPlaceholderError);
		expect(laterTurn.restoreUserReplyText(String(replayed))).toBe(
			"[redacted credential]",
		);
	}
	// Once the later turn shows the contact again, its reference restores.
	expect(laterTurn.substituteText("call 415-555-0100")).toContain(
		String(contactReference),
	);
	expect(laterTurn.restoreText(String(contactReference))).toBe("415-555-0100");
	// A default session cannot be walked from a visible reference to a known
	// secret it never showed either.
	const fresh = new SecretSwapSession({ knownSecrets });
	const visible = fresh.substituteText("call 415-555-0100");
	const counted = visible
		.replace("CONTACT", "SECRET")
		.replace(/_\d+__/, "_1__")
		.replace("call ", "");
	expect(fresh.restoreText(counted)).toBe(counted);
});

it("gives every value of a conversation its own reference", () => {
	const session = new SecretSwapSession({ stableKey: "k" });
	const numbers = Array.from({ length: 3000 }, (_, i) => `+1415555${1000 + i}`);
	const swapped = numbers.map((number) => session.substituteText(number));
	expect(new Set(swapped).size).toBe(numbers.length);
	expect(swapped.map((text) => session.restoreText(text))).toEqual(numbers);
});

async function sentReferences(
	settings: Record<string, string>,
	rooms: (string | undefined)[],
) {
	const runtime = createSQLiteTestRuntime({
		character: { name: "A", bio: "t", settings } as Character,
		logLevel: "fatal",
	});
	const sent: string[] = [];
	runtime.registerModel(
		ModelType.TEXT_LARGE,
		async (_runtime, params) => {
			sent.push(JSON.stringify(params));
			return "ok";
		},
		"p",
	);
	for (const roomId of rooms)
		await runWithTrajectoryContext(roomId ? { roomId } : undefined, () =>
			runtime.useModel(ModelType.TEXT_LARGE, {
				messages: [{ role: "user", content: earlier }],
			} as never),
		);
	await runtime.stop();
	return sent.map(
		(text) => /__ELIZA_CONTACT_[0-9a-f]{16}_\d+__/.exec(text)?.[0],
	);
}

it("is off unless the host turns it on, and needs a conversation", async () => {
	const rotating = await sentReferences({ ELIZA_SECRET_SWAP_ENABLED: "true" }, [
		"room-a",
		"room-a",
	]);
	expect(rotating[0]).toBeDefined();
	expect(rotating[1]).not.toBe(rotating[0]);
	const [first, again, otherRoom, noRoom, noRoomAgain] = await sentReferences(
		{
			ELIZA_SECRET_SWAP_ENABLED: "true",
			ELIZA_SECRET_SWAP_STABLE_REFERENCES: "true",
		},
		["room-a", "room-a", "room-b", undefined, undefined],
	);
	expect(first).toBeDefined();
	expect(again).toBe(first);
	expect(otherRoom).not.toBe(first);
	// A call outside a conversation has no later turn to match: fresh each time.
	expect(noRoom).not.toBe(first);
	expect(noRoomAgain).not.toBe(noRoom);
});

type Sent = {
	system?: string;
	messages?: { role: string; content: string }[];
	tools?: unknown;
	promptSegments?: { content: string; stable: boolean }[];
};

async function sentRequests(
	settings: Record<string, string>,
	requests: Record<string, unknown>[],
): Promise<Sent[]> {
	const runtime = createSQLiteTestRuntime({
		character: { name: "A", bio: "t", settings } as Character,
		logLevel: "fatal",
	});
	const sent: Sent[] = [];
	runtime.registerModel(
		ModelType.TEXT_LARGE,
		async (_runtime, params) => {
			sent.push(JSON.parse(JSON.stringify(params)) as Sent);
			return "ok";
		},
		"p",
	);
	for (const request of requests)
		await runWithTrajectoryContext({ roomId: "room-a" }, () =>
			runtime.useModel(ModelType.TEXT_LARGE, request as never),
		);
	await runtime.stop();
	return sent;
}

const stableSettings = {
	ELIZA_SECRET_SWAP_ENABLED: "true",
	ELIZA_SECRET_SWAP_STABLE_REFERENCES: "true",
};
const hello = { role: "user", content: "hello" };
const reply = { role: "assistant", content: "hi" };

// Measured on a provider, the cached prefix is the tool definitions, then the
// system prompt, then the messages. A list of this request's references inside
// the system prompt changed whenever a contact entered or left the
// conversation, and the provider then read every message again.
it("keeps the tools and the system prompt the same for a conversation and lists reference kinds after the newest user message", async () => {
	const text = { role: "user", content: earlier };
	const mail = { role: "user", content: "and mail bob@example.com" };
	const tools = [
		{ name: "DIAL", description: "Dial a number such as +14155550100." },
	];
	const turns = [
		[hello],
		[hello, reply, text],
		[hello, reply, text, reply, mail],
	].map((messages) => ({ system: "Be brief.", messages, tools }));
	const stable = await sentRequests(stableSettings, turns);
	expect(stable.map((request) => request.tools)).toEqual([tools, tools, tools]);
	expect(stable[0].system).toContain("Contact references beginning");
	expect(stable[0].system).not.toContain("Current contact reference kinds");
	expect(new Set(stable.map((request) => request.system)).size).toBe(1);
	// No reference, no list; then each request lists what it carries, last.
	expect(stable[0].messages).toEqual([hello]);
	const phone = /__ELIZA_CONTACT_[0-9a-f]{16}_\d+__/.exec(
		stable[1].messages?.[2].content ?? "",
	)?.[0];
	expect(stable[1].messages?.[2].content).toBe(
		`text ${phone} saying hi\n\nCurrent contact reference kinds: ${phone}: phone.`,
	);
	expect(stable[2].messages?.[4].content).toMatch(
		new RegExp(
			`^and mail (__ELIZA_CONTACT_[0-9a-f]{16}_\\d+__)\\n\\nCurrent contact reference kinds: ${phone}: phone, \\1: email\\.$`,
		),
	);
	// Earlier messages are sent as they were: a later request extends them.
	expect(stable[2].messages?.slice(0, 2)).toEqual(
		stable[1].messages?.slice(0, 2),
	);
	expect(stable[2].messages?.[2].content).toBe(`text ${phone} saying hi`);

	const rotating = await sentRequests(
		{ ELIZA_SECRET_SWAP_ENABLED: "true" },
		turns,
	);
	expect(rotating[0].system).toBe("Be brief.");
	expect(rotating[1].system).toContain("Current contact reference kinds: ");
	expect(rotating[1].messages?.[2].content).toMatch(/^text \S+ saying hi$/);
});

it("gives a request with no user message the guidance only when it carries a contact, as by default", async () => {
	const [plain, withContact, noUserMessage] = await sentRequests(
		stableSettings,
		[
			{ system: "Be brief.", prompt: "Summarize: the meeting moved." },
			{ system: "Be brief.", prompt: earlier },
			{ system: "Be brief.", messages: [reply] },
		],
	);
	expect(plain.system).toBe("Be brief.");
	// With no user message to follow, the list stays in the system prompt.
	expect(withContact.system).toContain("Current contact reference kinds: ");
	expect(withContact.system).not.toContain("latest user message");
	expect(noUserMessage.system).toBe("Be brief.");
});

// A provider may send a request's non-stable prompt segments in place of its
// leading user message. The kinds line, added to that message only, was then
// never sent, while the system prompt said where to find it.
it("adds the reference kinds to the prompt segments that stand for the leading user message", async () => {
	const system = "Be brief.";
	const promptSegments = [
		{ content: system, stable: true },
		{ content: earlier, stable: false },
	];
	const leading = {
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: earlier },
		],
		promptSegments,
	};
	const later = [...leading.messages, reply, hello];
	const allStable = promptSegments.map((segment) => ({
		...segment,
		stable: true,
	}));
	const [first, again, answered, trailing, unsegmented] = await sentRequests(
		stableSettings,
		[
			leading,
			leading,
			{ ...leading, messages: [...leading.messages, reply] },
			{ ...leading, messages: later },
			{ ...leading, promptSegments: allStable },
		],
	);
	const kinds = /\n\nCurrent contact reference kinds: \S+: phone\.$/.exec(
		first.messages?.[0].content ?? "",
	)?.[0];
	expect(kinds).toBeDefined();
	// One copy either way: the segments say what the leading user message says.
	expect(first.messages).toHaveLength(1);
	expect(first.promptSegments?.[2]).toEqual({ content: kinds, stable: false });
	expect(
		first.promptSegments
			?.filter((segment) => !segment.stable)
			.map((segment) => segment.content)
			.join(""),
	).toBe(first.messages?.[0].content);
	// The caller's array is reused across requests and is left as it was.
	expect(promptSegments).toHaveLength(2);
	expect(again).toEqual(first);
	// An assistant turn after it leaves the leading message the newest.
	expect(answered.promptSegments).toEqual(first.promptSegments);

	// A later user message is sent as it is, so only it carries the line.
	expect(trailing.promptSegments).toHaveLength(2);
	expect(trailing.messages?.[0].content).not.toContain("reference kinds");
	expect(trailing.messages?.[2].content).toBe(`hello${kinds}`);
	// So is a leading one that no non-stable segment stands for.
	expect(unsegmented.promptSegments).toHaveLength(2);
	expect(unsegmented.messages?.[0].content).toBe(first.messages?.[0].content);

	const [rotating] = await sentRequests({ ELIZA_SECRET_SWAP_ENABLED: "true" }, [
		leading,
	]);
	expect(rotating.promptSegments).toHaveLength(2);
	expect(rotating.system).toContain("Current contact reference kinds: ");

	// When another message leads the request, a provider that uses the segments
	// adds them in front and sends the user message as it is: one copy, on it.
	const [led] = await sentRequests(stableSettings, [
		{
			system: "Other.",
			messages: [
				{ role: "system", content: "Other." },
				{ role: "assistant", content: "hi" },
				{ role: "user", content: earlier },
			],
			promptSegments,
		},
	]);
	expect(led.promptSegments).toHaveLength(2);
	expect(led.messages?.at(-1)?.content).toMatch(
		/reference kinds: \S+: phone\.$/,
	);
});
