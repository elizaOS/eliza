/**
 * Exercises PII pseudonymization and argument restoration through a real runtime,
 * isolated storage, canonical caller-role lookup and the production executor.
 * A deterministic provider echo covers the boundary without network effects;
 * the opt-in Cerebras variant additionally checks a real model response and
 * writes explicitly live evidence. The registered action only captures arguments.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryDatabaseAdapter } from "@elizaos/testing/in-memory-adapter";
import { afterEach, describe, expect, it } from "vitest";
import { checkSenderRole } from "../../roles";
import { AgentRuntime } from "../../runtime";
import {
	CompositeEntityRecognizer,
	GazetteerEntityRecognizer,
	PseudonymSession,
	RegexEntityRecognizer,
} from "../../security/index.js";
import { runWithTrajectoryContext } from "../../trajectory-context";
import {
	type Action,
	ChannelType,
	type Character,
	type Memory,
	ModelType,
	type UUID,
} from "../../types";
import { executePlannedToolCall } from "../execute-planned-tool-call";

const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
const EVIDENCE_DIR = join(
	__dirname,
	"../../../../../test-results/evidence/10469-pii-ner",
);

async function callCerebras(prompt: string): Promise<string> {
	const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${CEREBRAS_KEY}`,
		},
		body: JSON.stringify({
			model: "gpt-oss-120b",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 200,
			temperature: 0.2,
		}),
	});
	if (!res.ok) throw new Error(`Cerebras ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as {
		choices: { message: { content: string } }[];
	};
	return data.choices[0]?.message?.content ?? "";
}

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.stop();
});

const REAL = {
	person: "Dana Whitfield",
	org: "Acme Robotics",
	address: "1600 Amphitheatre Parkway",
};

for (const mode of ["deterministic", "live"] as const) {
	describe.skipIf(mode === "live" && !CEREBRAS_KEY)(
		`PII swap — ${mode} provider boundary (#10469)`,
		() => {
			it("provider receives only surrogates; execution boundary restores real values", async () => {
				// Turn session over a known contact roster + street-address regex.
				const session = new PseudonymSession({
					salt: "evidence-10469",
					recognizer: new CompositeEntityRecognizer([
						new GazetteerEntityRecognizer([
							{ kind: "person", value: REAL.person },
							{ kind: "org", value: REAL.org },
						]),
						new RegexEntityRecognizer(),
					]),
				});

				const ownerId = randomUUID() as UUID;
				const worldId = randomUUID() as UUID;
				const roomId = randomUUID() as UUID;
				const adapter = new InMemoryDatabaseAdapter();
				await adapter.init();
				const runtime = new AgentRuntime({
					character: {
						name: "PiiLiveAgent",
						bio: "test",
						settings: {
							ELIZA_PII_SWAP_ENABLED: true,
							ELIZA_ADMIN_ENTITY_ID: ownerId,
						},
					} as Character,
					adapter,
					logLevel: "fatal",
				});

				runtimes.push(runtime);
				await runtime.createWorlds([
					{ id: worldId, agentId: runtime.agentId, name: "PII fixture" },
				]);
				await runtime.createEntities([
					{
						id: ownerId,
						agentId: runtime.agentId,
						names: ["Owner"],
						metadata: {},
					},
				]);
				await runtime.createRooms([
					{
						id: roomId,
						agentId: runtime.agentId,
						worldId,
						source: "test",
						type: ChannelType.DM,
					},
				]);
				await runtime.addParticipant(ownerId, roomId);
				const message: Memory = {
					id: randomUUID() as UUID,
					agentId: runtime.agentId,
					entityId: ownerId,
					roomId,
					content: {
						text: "Send the prepared reply.",
						source: "test",
						channelType: ChannelType.DM,
					},
				};
				expect((await checkSenderRole(runtime, message))?.isOwner).toBe(true);

				let promptSentToProvider = "";
				runtime.registerModel(
					ModelType.TEXT_LARGE,
					async (_rt, params: { prompt: string }) => {
						// `params.prompt` is what the runtime hands the provider AFTER the
						// ingress swap — i.e. exactly the bytes that leave the process.
						promptSentToProvider = params.prompt;
						return mode === "live"
							? await callCerebras(params.prompt)
							: params.prompt;
					},
					mode === "live" ? "cerebras" : "deterministic-pii-fixture",
				);

				const originalPrompt =
					`Draft a one-sentence reply to ${REAL.person} at ${REAL.org}. ` +
					`Their office is at ${REAL.address}, Mountain View, CA. ` +
					`Address them by name in the sentence.`;

				const providerResponse = (await runWithTrajectoryContext(
					{ runId: "evidence-run", piiSwapSession: session },
					() =>
						runtime.useModel(ModelType.TEXT_LARGE, { prompt: originalPrompt }),
				)) as string;

				// ── Assertions: the live provider never saw real PII ──────────────────
				expect(promptSentToProvider).not.toContain(REAL.person);
				expect(promptSentToProvider).not.toContain(REAL.org);
				expect(promptSentToProvider).not.toContain(REAL.address);
				expect(promptSentToProvider).not.toContain("__ELIZA"); // fluent, not opaque
				const personSurrogate = session.entries.find(
					(e) => e.value === REAL.person,
				)?.surrogate as string;
				const orgSurrogate = session.entries.find((e) => e.value === REAL.org)
					?.surrogate as string;
				expect(promptSentToProvider).toContain(personSurrogate);
				expect(promptSentToProvider).toContain(orgSurrogate);
				// The live model produced real text and — because we asked it to address
				// the person by name — it echoes the SURROGATE, never the real name.
				expect(providerResponse.length).toBeGreaterThan(0);
				expect(providerResponse).not.toContain(REAL.person);

				// ── Execution boundary: real values restored into the tool-call args ──
				const received: { to?: unknown; body?: unknown } = {};
				const sendEmail = {
					name: "SEND_EMAIL",
					description: "Send an email",
					contexts: ["messaging"],
					roleGate: { minRole: "OWNER" },
					parameters: [
						{
							name: "to",
							description: "recipient",
							required: true,
							schema: { type: "string" },
						},
						{
							name: "body",
							description: "body",
							required: true,
							schema: { type: "string" },
						},
					],
					validate: async () => true,
					handler: async (_rt, _m, _s, options) => {
						received.to = options?.parameters?.to;
						received.body = options?.parameters?.body;
						return { success: true };
					},
				} as Action;

				runtime.registerAction(sendEmail);
				const executionResult = await runWithTrajectoryContext(
					{ runId: "evidence-run", piiSwapSession: session },
					() =>
						executePlannedToolCall(
							runtime,
							{ message, activeContexts: ["messaging"] },
							// Fixture-supplied surrogate arguments probe restoration independently of model planning.
							{
								name: "SEND_EMAIL",
								params: {
									to: personSurrogate,
									body: `Reaching out from ${orgSurrogate}.`,
								},
							},
						),
				);
				expect(executionResult, JSON.stringify(executionResult)).toMatchObject({
					success: true,
				});
				expect(received.to).toBe(REAL.person);
				expect(received.body).toBe(`Reaching out from ${REAL.org}.`);

				if (mode !== "live") return;
				// ── Write the manually-reviewable evidence ────────────────────────────
				mkdirSync(EVIDENCE_DIR, { recursive: true });
				const evidence = {
					issue: "#10469 / #7007",
					provider: "cerebras/gpt-oss-120b",
					capturedAt: new Date().toISOString(),
					original_prompt: originalPrompt,
					prompt_sent_to_provider: promptSentToProvider,
					surrogate_mapping: session.entries.map((e) => ({
						real: e.value,
						surrogate: e.surrogate,
						kind: e.kind,
					})),
					live_provider_response: providerResponse,
					execution_boundary_restored: {
						fixture_tool_args: {
							to: personSurrogate,
							body: `Reaching out from ${orgSurrogate}.`,
						},
						handler_received: received,
					},
				};
				writeFileSync(
					join(EVIDENCE_DIR, "live-cerebras-trajectory.json"),
					JSON.stringify(evidence, null, 2),
				);
				writeFileSync(
					join(EVIDENCE_DIR, "live-cerebras-trajectory.md"),
					renderEvidenceMarkdown(evidence),
				);
			}, 60_000);
		},
	);
}

function renderEvidenceMarkdown(e: {
	provider: string;
	capturedAt: string;
	original_prompt: string;
	prompt_sent_to_provider: string;
	surrogate_mapping: { real: string; surrogate: string; kind: string }[];
	live_provider_response: string;
	execution_boundary_restored: {
		fixture_tool_args: { to: string; body: string };
		handler_received: { to?: unknown; body?: unknown };
	};
}): string {
	return [
		"# PII pseudonymization — live Cerebras trajectory (#10469 / #7007)",
		"",
		`- Provider: **${e.provider}** (live, not a mock)`,
		`- Captured: ${e.capturedAt}`,
		"",
		"## 1. Original prompt (contains real PII)",
		"```",
		e.original_prompt,
		"```",
		"",
		"## 2. Exact prompt the provider received (surrogates only — no real PII)",
		"```",
		e.prompt_sent_to_provider,
		"```",
		"",
		"## 3. Surrogate mapping (turn-scoped, never sent)",
		"",
		"| real | → surrogate | kind |",
		"| --- | --- | --- |",
		...e.surrogate_mapping.map(
			(m) => `| ${m.real} | ${m.surrogate} | ${m.kind} |`,
		),
		"",
		"## 4. Live model response (reasoned over surrogates)",
		"```",
		e.live_provider_response,
		"```",
		"",
		"## 5. Deterministic executor probe — fixture arguments restored",
		"These arguments are supplied by the fixture, not parsed from the live model response. No model-selected SEND_EMAIL operation is claimed.",
		"```json",
		JSON.stringify(e.execution_boundary_restored, null, 2),
		"```",
		"",
		"The provider request contains pseudonyms; this review artifact also retains the synthetic original values.",
		"the `SEND_EMAIL` handler ran with the **real** recipient.",
		"",
	].join("\n");
}
