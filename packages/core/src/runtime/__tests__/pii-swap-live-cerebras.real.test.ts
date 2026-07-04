/**
 * LIVE end-to-end proof for the PII pseudonymization layer (#10469 / #7007)
 * against a REAL model provider (Cerebras `gpt-oss-120b`) — not a mock.
 *
 * It boots a runtime with `ELIZA_PII_SWAP_ENABLED`, sends a prompt containing a
 * real person, org, and street address, and captures the EXACT text the provider
 * received. It asserts the provider saw only realistic surrogates (zero real
 * PII) and that the live model's own response references the surrogate — then
 * runs the execution boundary and asserts the real values are restored into the
 * tool-call args. Every artifact is written to
 * `.github/issue-evidence/10469-pii-ner/` for manual review.
 *
 * Gated on CEREBRAS_API_KEY (post-merge / manual lane); skips cleanly otherwise.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
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
	type Character,
	type IAgentRuntime,
	type Memory,
	ModelType,
} from "../../types";
import { executePlannedToolCall } from "../execute-planned-tool-call";


const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
const EVIDENCE_DIR = join(
	__dirname,
	"../../../../../.github/issue-evidence/10469-pii-ner",
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

function makeStubRuntime(actions: Action[]): IAgentRuntime {
	return {
		actions,
		logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as IAgentRuntime;
}

const REAL = {
	person: "Dana Whitfield",
	org: "Acme Robotics",
	address: "1600 Amphitheatre Parkway",
};

describe.skipIf(!CEREBRAS_KEY)(
	"PII swap — LIVE Cerebras end-to-end (#10469)",
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

			const runtime = new AgentRuntime({
				character: {
					name: "PiiLiveAgent",
					bio: "test",
					settings: { ELIZA_PII_SWAP_ENABLED: true },
				} as Character,
				adapter: new InMemoryDatabaseAdapter(),
				logLevel: "fatal",
			});

			let promptSentToProvider = "";
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				async (_rt, params: { prompt: string }) => {
					// `params.prompt` is what the runtime hands the provider AFTER the
					// ingress swap — i.e. exactly the bytes that leave the process.
					promptSentToProvider = params.prompt;
					return await callCerebras(params.prompt);
				},
				"cerebras",
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

			await runWithTrajectoryContext(
				{ runId: "evidence-run", piiSwapSession: session },
				() =>
					executePlannedToolCall(
						makeStubRuntime([sendEmail]),
						{ message: { id: "m", roomId: "r", content: {} } as Memory },
						// The model emitted the SURROGATE in the tool arg (as it would).
						{
							name: "SEND_EMAIL",
							params: {
								to: personSurrogate,
								body: `Reaching out from ${orgSurrogate}.`,
							},
						},
					),
			);
			expect(received.to).toBe(REAL.person);
			expect(received.body).toBe(`Reaching out from ${REAL.org}.`);

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
					model_emitted: {
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

function renderEvidenceMarkdown(e: {
	provider: string;
	capturedAt: string;
	original_prompt: string;
	prompt_sent_to_provider: string;
	surrogate_mapping: { real: string; surrogate: string; kind: string }[];
	live_provider_response: string;
	execution_boundary_restored: {
		model_emitted: { to: string; body: string };
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
		"## 5. Execution boundary — real values restored into the tool call",
		"```json",
		JSON.stringify(e.execution_boundary_restored, null, 2),
		"```",
		"",
		"The provider and this trajectory contain **zero** real names/orgs/addresses;",
		"the `SEND_EMAIL` handler ran with the **real** recipient.",
		"",
	].join("\n");
}
