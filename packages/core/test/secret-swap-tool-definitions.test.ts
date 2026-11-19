/**
 * A tool definition documents a format with an example ("for example
 * +14155550100"). The swap read that as someone's phone number: the definition
 * was rewritten with every nonce and whenever the conversation repeated the
 * example, and the example was listed as a contact of the request. Measured on
 * a provider, the cached prefix is the tool definitions, then the system
 * prompt, then the messages, so one changed byte in a definition costs the
 * rest of the request. Only values reserved for documentation are examples: a
 * real number or address in a definition is still someone's.
 */
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import {
	isReservedExampleContact,
	SecretSwapSession,
} from "../src/security/secret-swap.ts";
import { runWithTrajectoryContext } from "../src/trajectory-context.ts";
import type { Character } from "../src/types/agent.ts";
import { ModelType } from "../src/types/model.ts";

const REFERENCE = /^__ELIZA_CONTACT_[0-9a-f]{16}_\d+__$/;
const tools = () => [
	{
		name: "DIAL",
		description: "Dial a number, for example +14155550100 or 5550100.",
		parameters: {
			type: "object",
			properties: {
				number: {
					type: "string",
					description:
						"Digits with an optional leading +, e.g. +14155550100. Or an address such as name@example.com.",
				},
			},
		},
	},
];
const request = (text: string) => ({
	messages: [{ role: "user", content: text }],
	tools: tools(),
});
// The fields a model request names, as the dispatcher passes them.
const fields = {
	authoredFields: ["tools"],
	conversationFields: ["messages", "prompt", "system"],
};

it("recognises only contact values reserved for documentation as examples", () => {
	for (const reserved of [
		"+14155550100",
		"1 (415) 555-0199",
		"415-555-0142",
		"628.555.0100",
		"555-0100",
		"5550199",
		"name@example.com",
		"Name@EXAMPLE.ORG",
		"a.b@mail.example.net",
		"bob.smith@acme-tax.example",
		"qa@staging.test",
		"nobody@nowhere.invalid",
		"dev@localhost",
	])
		expect(isReservedExampleContact(reserved), reserved).toBe(true);
	for (const real of [
		"555-0200",
		"555-0099",
		"555-1000",
		"415-555-1000",
		"+12128675309",
		"(646) 234-5678",
		// A Danish number whose digits end like a fictional line.
		"+4555550100",
		"+441555501000",
		"user@example.co",
		"user@notexample.com",
		"user@example.com.evil.io",
		"jane.doe@gmail.com",
		"test@contest",
	])
		expect(isReservedExampleContact(real), real).toBe(false);
});

it("leaves examples in tool definitions as written and still swaps the conversation", () => {
	const session = new SecretSwapSession();
	const sent = session.substituteInValue(request("call 415-555-0199"), {
		authoredFields: ["tools"],
	});
	expect(sent.tools).toEqual(tools());
	expect(sent.messages[0].content).toMatch(
		/^call __ELIZA_CONTACT_[0-9a-f]{16}_\d+__$/,
	);
	expect(session.entries.map((entry) => entry.value)).toEqual(["415-555-0199"]);
	// Any other graph is read whole, as before.
	expect(
		JSON.stringify(
			new SecretSwapSession().substituteInValue(request("hello")).tools,
		),
	).toContain("__ELIZA_CONTACT_");
});

it("keeps a tool's example as written when the conversation or a reply repeats it", () => {
	const session = new SecretSwapSession();
	const asked = request("call +14155550100 or name@example.com");
	const sent = session.substituteInValue(asked, fields);
	expect(sent.tools).toEqual(tools());
	// The conversation's copy is still a reference.
	const [, phone, email] =
		/^call (\S+) or (\S+)$/.exec(sent.messages[0].content) ?? [];
	expect(phone).toMatch(REFERENCE);
	expect(email).toMatch(REFERENCE);
	expect(session.restoreInValue(sent)).toEqual(asked);

	// A model that copies the example into its reply teaches it to the session
	// mid-turn; the next request of the turn sends the same tools.
	const echoed = new SecretSwapSession();
	expect(echoed.substituteInValue("I will dial +14155550100 now.")).toMatch(
		/^I will dial __ELIZA_CONTACT_[0-9a-f]{16}_\d+__ now\.$/,
	);
	expect(echoed.substituteInValue(request("call mom"), fields)).toEqual(
		request("call mom"),
	);
});

it("swaps a real number or address written into a tool definition", () => {
	const session = new SecretSwapSession();
	const sent = session.substituteInValue(
		{
			messages: [{ role: "user", content: "hello" }],
			tools: [
				{
					name: "TEXT_BOB",
					description: "Text Bob at +12128675309, written like +14155550100.",
					parameters: {
						type: "object",
						properties: {
							to: {
								type: "string",
								enum: ["jane.doe@gmail.com", "(646) 234-5678"],
							},
						},
					},
				},
			],
		},
		fields,
	);
	expect(sent.tools[0].description).toMatch(
		/^Text Bob at __ELIZA_CONTACT_[0-9a-f]{16}_\d+__, written like \+14155550100\.$/,
	);
	expect(sent.tools[0].parameters.properties.to.enum).toEqual([
		expect.stringMatching(REFERENCE),
		expect.stringMatching(REFERENCE),
	]);
	expect(session.entries.map((entry) => entry.value).sort()).toEqual([
		"(646) 234-5678",
		"+12128675309",
		"jane.doe@gmail.com",
	]);
});

it("does not learn a tool's example from the copies of its definition a request carries", () => {
	const session = new SecretSwapSession();
	const sent = session.substituteInValue(
		{
			...request("call 415-555-0199"),
			// A planner request repeats its tool schemas for local validation.
			providerOptions: {
				eliza: { plannerActionSchemas: tools(), owner: "628-302-4399" },
			},
			responseSkeleton: { id: JSON.stringify(tools()) },
		},
		fields,
	);
	expect(sent.tools).toEqual(tools());
	expect(sent.providerOptions.eliza.plannerActionSchemas).toEqual(tools());
	expect(sent.responseSkeleton.id).toBe(JSON.stringify(tools()));
	// A contact that is not a reserved example is still swapped wherever it sits.
	expect(sent.providerOptions.eliza.owner).toMatch(REFERENCE);
	expect(session.entries.map((entry) => entry.value).sort()).toEqual([
		"415-555-0199",
		"628-302-4399",
	]);
});

it("still swaps a credential written into a tool definition", () => {
	const session = new SecretSwapSession();
	const leaky = request("hello");
	leaky.tools[0].description += ' Send api_key: "zx81-not-a-real-key-1234".';
	const sent = session.substituteInValue(leaky, fields);
	expect(JSON.stringify(sent.tools)).not.toContain("zx81");
	expect(sent.tools[0].description).toContain("__ELIZA_SECRET_");
	expect(sent.tools[0].description).toContain("+14155550100");
});

it("sends the same tool definitions on every turn and lists only the contacts the conversation carries", async () => {
	const runtime = createSQLiteTestRuntime({
		character: {
			name: "A",
			bio: "t",
			settings: { ELIZA_SECRET_SWAP_ENABLED: "true" },
		} as Character,
		logLevel: "fatal",
	});
	const sent: {
		system?: string;
		tools: unknown;
		messages: { content: string }[];
		providerOptions: { eliza: { plannerActionSchemas: unknown } };
	}[] = [];
	runtime.registerModel(
		ModelType.TEXT_LARGE,
		async (_runtime, params) => {
			sent.push(JSON.parse(JSON.stringify(params)));
			return "ok";
		},
		"p",
	);
	for (const text of [
		"what can you do?",
		"call 415-555-0199",
		"call +14155550100",
	])
		await runWithTrajectoryContext({ roomId: "room-a" }, () =>
			runtime.useModel(ModelType.TEXT_LARGE, {
				system: "Be brief.",
				...request(text),
				providerOptions: { eliza: { plannerActionSchemas: tools() } },
			} as never),
		);
	await runtime.stop();
	expect(sent.map((request) => request.tools)).toEqual([
		tools(),
		tools(),
		tools(),
	]);
	// The copies of the definitions add no contact and stay as written, like
	// the definitions, whatever the conversation carries.
	expect(sent[0].system).toBe("Be brief.");
	for (const request of sent)
		expect(request.providerOptions.eliza.plannerActionSchemas).toEqual(tools());
	// One contact in each later request, the number the owner gave, even when
	// it is the number the tool uses as its example.
	for (const request of sent.slice(1)) {
		expect(request.messages[0].content).toMatch(
			/^call __ELIZA_CONTACT_[0-9a-f]{16}_\d+__$/,
		);
		expect(request.system?.match(/__ELIZA_CONTACT_/g)).toHaveLength(2);
	}
});

// A model copies a schema's example into its reply ("I will dial +14155550100
// now."). The next request of the turn then listed the example as a contact,
// read out of the planner's own copy of the schema.
it("lists no contact for a tool's example the model repeated in a reply", async () => {
	const runtime = createSQLiteTestRuntime({
		character: {
			name: "A",
			bio: "t",
			settings: {
				ELIZA_SECRET_SWAP_ENABLED: "true",
				ELIZA_SECRET_SWAP_STABLE_REFERENCES: "true",
			},
		} as Character,
		logLevel: "fatal",
	});
	const sent: string[] = [];
	runtime.registerModel(
		ModelType.TEXT_LARGE,
		async (_runtime, params) => {
			sent.push(JSON.stringify(params));
			return "I will dial +14155550100 now.";
		},
		"p",
	);
	const planner = {
		...request("call mom"),
		providerOptions: { eliza: { plannerActionSchemas: tools() } },
	};
	// One turn: both calls share the turn's session.
	await runWithTrajectoryContext({ roomId: "room-a" }, async () => {
		await runtime.useModel(ModelType.TEXT_LARGE, planner as never);
		await runtime.useModel(ModelType.TEXT_LARGE, planner as never);
	});
	await runtime.stop();
	expect(sent).toHaveLength(2);
	for (const text of sent) {
		expect(text).not.toMatch(/__ELIZA_CONTACT_[0-9a-f]{16}_/);
		expect(text).not.toContain("reference kinds:");
	}
	expect(JSON.parse(sent[1]).tools).toEqual(tools());
});
