/**
 * A tool definition documents a format with an example ("for example
 * +14155550100"). The swap read that as someone's phone number: the definition
 * was rewritten with every nonce, so no two requests carried the same tools,
 * and the example was listed as a contact of the request.
 */
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { SecretSwapSession } from "../src/security/secret-swap.ts";
import { runWithTrajectoryContext } from "../src/trajectory-context.ts";
import type { Character } from "../src/types/agent.ts";
import { ModelType } from "../src/types/model.ts";

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

it("does not learn a tool's example from the copies of its definition a request carries", () => {
	const session = new SecretSwapSession();
	const sent = session.substituteInValue(
		{
			...request("call 415-555-0199"),
			// A planner request repeats its tool schemas for local validation.
			providerOptions: {
				eliza: { plannerActionSchemas: tools(), owner: "628-555-0110" },
			},
			responseSkeleton: { id: JSON.stringify(tools()) },
		},
		{
			authoredFields: ["tools"],
			conversationFields: ["messages", "prompt", "system"],
		},
	);
	expect(sent.tools).toEqual(tools());
	expect(sent.providerOptions.eliza.plannerActionSchemas).toEqual(tools());
	expect(sent.responseSkeleton.id).toBe(JSON.stringify(tools()));
	// A contact that is not one of the examples is still swapped wherever it sits.
	expect(sent.providerOptions.eliza.owner).toMatch(/^__ELIZA_CONTACT_/);
	expect(session.entries.map((entry) => entry.value).sort()).toEqual([
		"415-555-0199",
		"628-555-0110",
	]);
});

it("still replaces a value the conversation carries wherever it appears", () => {
	const session = new SecretSwapSession();
	const sent = session.substituteInValue(request("call +14155550100"), {
		authoredFields: ["tools"],
		conversationFields: ["messages"],
	});
	const reference = /__ELIZA_CONTACT_[0-9a-f]{16}_\d+__/.exec(
		sent.messages[0].content,
	)?.[0];
	expect(reference).toBeDefined();
	expect(JSON.stringify(sent)).not.toContain("+14155550100");
	expect(sent.tools[0].description).toContain(String(reference));
});

it("still swaps a credential written into a tool definition", () => {
	const session = new SecretSwapSession();
	const leaky = request("hello");
	leaky.tools[0].description += ' Send api_key: "zx81-not-a-real-key-1234".';
	const sent = session.substituteInValue(leaky, { authoredFields: ["tools"] });
	expect(JSON.stringify(sent.tools)).not.toContain("zx81");
	expect(sent.tools[0].description).toContain("__ELIZA_SECRET_");
	expect(sent.tools[0].description).toContain("+14155550100");
});

it("sends the same tool definitions on every turn and lists no contact the request does not carry", async () => {
	const runtime = createSQLiteTestRuntime({
		character: {
			name: "A",
			bio: "t",
			settings: { ELIZA_SECRET_SWAP_ENABLED: "true" },
		} as Character,
		logLevel: "fatal",
	});
	const sent: { system?: string; tools: unknown; messages: unknown }[] = [];
	runtime.registerModel(
		ModelType.TEXT_LARGE,
		async (_runtime, params) => {
			sent.push(JSON.parse(JSON.stringify(params)));
			return "ok";
		},
		"p",
	);
	for (const text of ["what can you do?", "call 415-555-0199"])
		await runWithTrajectoryContext({ roomId: "room-a" }, () =>
			runtime.useModel(ModelType.TEXT_LARGE, {
				system: "Be brief.",
				...request(text),
			} as never),
		);
	await runtime.stop();
	expect(sent[0].tools).toEqual(tools());
	expect(sent[1].tools).toEqual(sent[0].tools);
	expect(sent[0].system).toBe("Be brief.");
	// One contact in the second request: the number the owner gave.
	expect(sent[1].system?.match(/__ELIZA_CONTACT_/g)).toHaveLength(2);
});
