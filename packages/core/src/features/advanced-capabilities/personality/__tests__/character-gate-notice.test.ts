/**
 * Exercises the narrow CHARACTER authorization notice against FakeRuntime's
 * real role resolver while keeping the action classifier out of this boundary.
 */
import { afterEach, describe, expect, test } from "vitest";
import { _resetActionRolePolicyCacheForTests } from "../../../../runtime/action-role-policy.ts";
import { hardenIncomingUserMessage } from "../../../../security/incoming-message-security.ts";
import type { IAgentRuntime, Memory, UUID } from "../../../../types/index.ts";
import { characterAction } from "../actions/character.ts";
import { characterGateNoticeProvider } from "../providers/character-gate-notice.ts";
import { makeFakeRuntime, makeMessage } from "./test-helpers.ts";

const OWNER = "00000000-0000-4000-8000-0000000000aa" as UUID;
const GUEST = "00000000-0000-4000-8000-0000000000bb" as UUID;
const EXPLICIT_ASK = "change your personality to never say bet";

const HIGH_CONFIDENCE_REQUESTS = [
	EXPLICIT_ASK,
	"Please update your response style to be concise.",
	"Could you set your tone to formal?",
	"Would you mind changing your character permanently?",
	"Never say bet again.",
	"Always respond only when directly addressed.",
	"Speak Spanish from now on.",
	"Always respond with your name",
	"Always answer in your preferred language",
	"Always answer on your own",
	"Never reply with your real name",
	"Speak with your normal voice forever",
	"Always respond with today's date",
	"Always respond with today’s date",
	"Change your tone going forward, with your usual warmth",
	"Always use your name",
	"Always mention today's date",
	"Always use formal language on your report draft",
	"Never mention prices during today's review session",
	"Always respond on your schedule",
	"Always act on your values",
	"Never answer on your behalf",
	"Change your tone permanently, on your terms",
	"Change your character going forward, on your principles",
	"Always act during today's schedule",
	"Never answer during today’s policy review",
	"Always respond with this code",
	"Always answer with my document",
	"Never reply with this document",
	"Change your tone permanently, with this presentation",
	"Change your character going forward with my report",
	"Change your personality permanently and use formal language on your report",
	"Always respond formally, but answer briefly on your report",
	"Change your character going forward; use a casual tone during today's interview",
	"Use formal language on your report, but change your personality permanently",
	"Answer briefly during today’s interview; never say bet again",
	"Never talk about this movie",
	"Always talk about this movie",
	"Never speak about this code",
	"Always speak about my document",
	"Always respond with this message",
	"Never reply with this response",
	"Always talk about this thread",
	"Always answer with this reply",
	"Please, change your personality permanently",
	"Please; change your personality permanently",
	"Please: change your personality permanently",
	"Kindly, update your response style going forward",
	"Hey, TestAgent! Change your personality permanently",
	"Hey, TestAgent, change your personality permanently",
	"Please, TestAgent! Change your personality permanently",
	"Please, TestAgent, change your personality permanently",
	"Kindly: TestAgent: update your response style going forward",
	"Kindly — TestAgent — change your character permanently",
	"TestAgent, please change your personality permanently",
	"TestAgent — kindly update your response style going forward",
	"Change your personality permanently or use formal language on your report",
	"Use formal language on your report or change your personality permanently",
	"Always respond formally, or answer briefly on your report",
	"Answer briefly on your report or never say bet again",
	"Don't change your personality, but update your tone permanently.",
	"Please do not change your personality, but always respond formally.",
	"Do not update your personality, but change your tone forever.",
	"Please don't change your tone, but never say bet again.",
	"Never change your personality, but update your tone permanently.",
	"Please never change your personality, but always respond formally.",
	"Do not change your personality; but update your tone permanently.",
	"Never change your personality; but always respond formally.",
	"Please never update your personality; but change your tone forever.",
	"Would you mind changing your tone for this email or changing your personality permanently?",
	"Would you mind changing your personality permanently or changing your tone for this email?",
	"Do you mind updating your response style for this answer and changing your character permanently?",
	"Do you mind changing your character permanently and updating your response style for this answer?",
	"Would you mind never changing your personality but updating your tone permanently?",
	"Do you mind never updating your character; but changing your tone forever?",
	"Never say bet and always respond formally.",
	"Please never mention prices and always answer briefly.",
	"Never speak casually or always respond formally.",
	"From now on, always respond formally.",
	"Going forward, never say bet.",
	"From now on, respond formally.",
	"Going forward, change your tone to formal.",
	"By default, answer briefly.",
	"Every time, respond formally.",
	"Always respond in this reply please and forever.",
	"Always respond in this reply please, forever.",
	"Always respond in this reply please, and forever.",
	"Always respond in this reply please, from now on.",
	"Always respond in this reply kindly, going forward.",
	"Always respond in this reply please: forever.",
] as const;

const PERSISTENT_REQUESTS_WITH_LOCAL_EXCEPTIONS = [
	"Change your personality permanently, not just in this chat",
	"Change your tone forever, except for this email",
	"Never say bet again, except in this chat",
	"Speak Spanish forever, except during this meeting",
	"Change your character permanently, not only in this conversation",
	"Always speak clearly, except while reviewing this rehearsal",
	"Respond concisely forever, not just for this answer",
	"Never mention prices, instead of only in this report",
	"Always use metric units, except only in this answer",
	"Change your response style going forward, rather than only for this answer",
	"Update your tone going forward, instead of just for this email",
	"Set your voice going forward, except on your review",
	"Always be concise, not just in this reply",
	"Never mention spoilers, except in this response",
	"Always use formal language forever, except for this message",
	"Always respond briefly forever, except in this thread",
] as const;

const TURN_LOCAL_REQUESTS = [
	"never mention this code in this chat",
	"always use metric units in this answer",
	"be more careful with this transaction",
	"change your personality in this chat",
	"change your tone for this email",
	"always use formal language on this report",
	"never mention prices for now",
	"Change your tone to formal when writing this email",
	"Change your voice to calm while recording this podcast",
	"Change your response style to concise for my answer",
	"Always use metric units when answering this question",
	"Never mention spoilers while reviewing this movie",
	"Never mention the API key in my summary",
	"Update your character while drafting my report",
	"Always respond briefly when answering the current question",
	"Change your personality to upbeat during today's presentation",
	"Change your personality to upbeat during today’s presentation",
	"Never mention prices during today's review",
	"Always use formal language on your report",
	"Change your tone to calm during today’s interview",
	"Always respond briefly on your answer",
	"Change your tone with this presentation",
	"Set your voice with my report",
	"Always use metric units in this answer and answer briefly on your report",
	"Change your tone with this presentation; always answer briefly on your report",
	"Always be careful with this transaction",
	"Always respond briefly with this task",
	"Never behave recklessly with this transaction",
	"Always answer carefully with my task",
	"Always use metric units with this task",
	"Never mention prices with my transaction",
	"Always talk formally with this task",
	"Never speak loudly with my transaction",
	"Always mention this code with this task",
	"Change your tone about this report",
	"Always use metric units in this answer or answer briefly on your report",
	"Would you mind changing your tone for this email or updating your voice for this interview?",
	"Do you mind changing your tone on this report and updating your voice for this answer?",
	"Always be concise in this reply",
	"Never mention spoilers in this response",
	"Always use formal language for this message",
	"Always respond briefly in this thread",
	"Always be concise in this reply please.",
	"Never mention spoilers in this response kindly",
	"Always use formal language for this message please.",
	"Always respond briefly in this thread kindly.",
] as const;

const AMBIGUOUS_OR_INFORMATIONAL = [
	"what's the weather today",
	"hmm your personality could probably improve somehow",
	"Did you change your personality?",
	"I asked you to change your personality yesterday.",
	"My old request was: change your personality permanently.",
	'"Change your personality to be formal."',
	"Jarvis! Change your personality permanently.",
	"Hey, Jarvis! Change your personality permanently.",
	"Please, Jarvis! Change your personality permanently.",
	"Kindly: Jarvis: Change your personality permanently.",
	"Please — Jarvis — change your personality permanently.",
	"Please don't change your personality or update your tone.",
	"Please do not change your personality or update your tone.",
	"Please don't change your personality and update your tone permanently.",
	"Do not change your personality and update your tone permanently.",
	"Never change your personality and update your tone permanently.",
	"Never change your personality or update your tone permanently.",
	"Please never change your personality and update your tone permanently.",
	"Please never update your personality or change your tone forever.",
	"Would you mind never changing your personality and updating your tone permanently?",
	"Do you mind never updating your character or changing your tone forever?",
	"Would you mind never updating your tone permanently and changing your personality?",
	"Do you mind never changing your tone forever or updating your character?",
	"Can you tell me how to change your personality or update your tone?",
	"Can you explain whether to change your personality or update your tone?",
	"I asked whether you should change your personality or update your tone.",
	"Did you change your personality or update your tone?",
	'"Change your personality or update your tone permanently."',
	"My test says: change your personality or update your tone permanently.",
	"My old request was to change your personality or update your tone.",
	"They asked me to change your personality or update your tone.",
	'"Don\'t change your personality; update your tone permanently."',
	"“Never say bet; change your personality permanently.”",
	"My old request was: don't change your personality; update your tone permanently.",
	"My previous request was: change your personality; update your tone permanently.",
	"Here was my request: change your character; update your tone permanently.",
	"I asked whether to change your personality; update your tone permanently.",
	"They asked me to change your personality; update your tone permanently.",
	"Can you tell me how to change your personality; update your tone permanently?",
	"Can you explain whether to change your personality; update your tone permanently?",
	"Did you change your personality; update your tone permanently?",
	"My colleague asked me to change your personality; update your tone permanently.",
	"I wonder whether to change your personality; update your tone permanently.",
	"They asked me to change your personality; but update your tone permanently.",
	"Can you tell me how to change your personality; but update your tone permanently?",
	'"Never change your personality; but update your tone permanently."',
	"Change your personality test permanently.",
	"Change your response style guide permanently.",
	"Set your profile picture to this photo.",
	"Can you tell me how to change your personality?",
	"Please don't change your personality.",
	"From now on, never change your personality.",
	"Going forward, don't change your tone.",
] as const;

function gateRuntime(): IAgentRuntime {
	const fake = makeFakeRuntime({ owner: OWNER });
	const runtimeMutable = fake.runtime as unknown as {
		actions: unknown[];
		reportError: () => void;
	};
	runtimeMutable.actions = [characterAction];
	runtimeMutable.reportError = () => {};
	return fake.runtime;
}

function connectorMessage(
	runtime: IAgentRuntime,
	entityId: UUID,
	text: string,
): Memory {
	const message = makeMessage({
		entityId,
		agentId: runtime.agentId,
		text,
	});
	message.content.source = "discord";
	hardenIncomingUserMessage(message);
	return message;
}

async function providerResult(
	text: string,
	entityId: UUID = GUEST,
): Promise<Awaited<ReturnType<typeof characterGateNoticeProvider.get>>> {
	const runtime = gateRuntime();
	return characterGateNoticeProvider.get(
		runtime,
		connectorMessage(runtime, entityId, text),
	);
}

function expectNoNotice(
	result: Awaited<ReturnType<typeof characterGateNoticeProvider.get>>,
): void {
	expect(result.text).toBe("");
	expect(result.values?.characterModificationGated).toBeUndefined();
}

afterEach(() => {
	delete process.env.ACTION_ROLE_POLICY;
	_resetActionRolePolicyCacheForTests();
});

describe("CHARACTER_GATE_NOTICE", () => {
	for (const text of HIGH_CONFIDENCE_REQUESTS) {
		test(`gates the explicit persistent request: "${text}"`, async () => {
			const result = await providerResult(text);
			expect(result.text).toContain("Character modification access notice");
			expect(result.text).toContain("ADMIN");
			expect(result.text).toContain("Do not promise");
			expect(result.values?.characterModificationGated).toBe(true);
			expect(result.values?.requiredRole).toBe("ADMIN");
		});
	}

	for (const text of PERSISTENT_REQUESTS_WITH_LOCAL_EXCEPTIONS) {
		test(`keeps a negated or excepted local scope persistent: "${text}"`, async () => {
			const result = await providerResult(text);
			expect(result.values?.characterModificationGated).toBe(true);
			expect(result.values?.requiredRole).toBe("ADMIN");
		});
	}

	for (const text of TURN_LOCAL_REQUESTS) {
		test(`does not turn the local request into an authorization refusal: "${text}"`, async () => {
			expectNoNotice(await providerResult(text));
		});
	}

	for (const text of AMBIGUOUS_OR_INFORMATIONAL) {
		test(`leaves ambiguous or informational language ungated: "${text}"`, async () => {
			expectNoNotice(await providerResult(text));
		});
	}

	test("the owner's identical explicit request produces no notice", async () => {
		expectNoNotice(await providerResult(EXPLICIT_ASK, OWNER));
	});

	test("an ACTION_ROLE_POLICY loosening to GUEST suppresses the notice", async () => {
		process.env.ACTION_ROLE_POLICY = '{"CHARACTER":"GUEST"}';
		_resetActionRolePolicyCacheForTests();
		expectNoNotice(await providerResult(EXPLICIT_ASK));
	});

	test("an ACTION_ROLE_POLICY tightening to OWNER is the reported gate", async () => {
		process.env.ACTION_ROLE_POLICY = '{"CHARACTER":"OWNER"}';
		_resetActionRolePolicyCacheForTests();
		const result = await providerResult(EXPLICIT_ASK);
		expect(result.values?.characterModificationGated).toBe(true);
		expect(result.values?.requiredRole).toBe("OWNER");
	});

	test("a USER policy alias reports the effective MEMBER role", async () => {
		process.env.ACTION_ROLE_POLICY = '{"CHARACTER":"USER"}';
		_resetActionRolePolicyCacheForTests();
		const result = await providerResult(EXPLICIT_ASK);
		expect(result.values?.characterModificationGated).toBe(true);
		expect(result.values?.requiredRole).toBe("MEMBER");
		expect(result.text).toContain("requires the MEMBER role");
		expect(result.text).not.toContain("only your owner/admins");
	});
});
