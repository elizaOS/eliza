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
