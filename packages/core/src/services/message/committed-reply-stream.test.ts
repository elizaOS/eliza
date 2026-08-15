/**
 * Exercises the real committed-prefix state machine with adversarial provider
 * chunking, control payloads, cancellation, and concurrent callback ordering.
 */
import { describe, expect, it, vi } from "vitest";
import {
	CommittedReplyDeliveryError,
	CommittedReplyStream,
	MAX_COMMITTED_REPLY_SOURCE_CHARS,
} from "./committed-reply-stream";

function harness(validateCandidate?: (text: string) => boolean) {
	const chunks: string[] = [];
	const snapshots: string[] = [];
	const stream = new CommittedReplyStream({
		onCommit: (chunk, accumulated) => {
			chunks.push(chunk);
			snapshots.push(accumulated);
		},
		...(validateCandidate ? { validateCandidate } : {}),
	});
	return { stream, chunks, snapshots };
}

describe("CommittedReplyStream", () => {
	it("commits genuine provider input only after a stable sentence boundary", async () => {
		const { stream, chunks, snapshots } = harness();
		await stream.pushProviderChunk("First sentence.");
		expect(chunks).toEqual([]);
		await stream.pushProviderChunk(" Sec");
		expect(chunks).toEqual(["First sentence."]);
		expect(snapshots).toEqual(["First sentence."]);
		await stream.pushProviderChunk("ond sentence.");
		const result = await stream.finish();
		expect(chunks.join("")).toBe("First sentence. Second sentence.");
		expect(result).toEqual({
			text: "First sentence. Second sentence.",
			state: "complete",
			committedText: "First sentence. Second sentence.",
		});
	});

	it.each([
		{
			label: "Dr.",
			firstSentence:
				"Please consult the attending physician Dr. Smith before proceeding.",
		},
		{
			label: "Mr.",
			firstSentence:
				"Please consult the attending physician Mr. Smith before proceeding.",
		},
		{
			label: "e.g.",
			firstSentence:
				"Please review the supporting examples, e.g. the first case, before proceeding.",
		},
		{
			label: "i.e.",
			firstSentence:
				"Please use the primary toggle, i.e. the first option, before proceeding.",
		},
	])(
		"never commits $label as a sentence boundary across provider chunk splits",
		async ({ firstSentence }) => {
			const text = `${firstSentence} Next`;
			for (let split = 1; split < text.length; split += 1) {
				const { stream, chunks, snapshots } = harness();
				await stream.pushProviderChunk(text.slice(0, split));
				await stream.pushProviderChunk(text.slice(split));

				expect(chunks[0]).toBe(firstSentence);
				expect(snapshots[0]).toBe(firstSentence);
				expect((await stream.finish()).text).toBe(text);
				expect(chunks.join("")).toBe(text);
			}
		},
	);

	it("does not fake incremental delivery for a one-chunk terminal answer", async () => {
		const onCommit = vi.fn();
		const stream = new CommittedReplyStream({ onCommit });
		await stream.pushProviderChunk("A complete one-shot answer.");
		expect(onCommit).not.toHaveBeenCalled();
		await stream.finish();
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(onCommit).toHaveBeenCalledWith(
			"A complete one-shot answer.",
			"A complete one-shot answer.",
		);
	});

	it("does not treat an arbitrary provider callback boundary as semantic proof", async () => {
		const onCommit = vi.fn();
		const stream = new CommittedReplyStream({ onCommit });
		await stream.pushProviderChunk("The release is version 1.");
		stream.abort();
		await stream.pushProviderChunk("2, not version 1.0.");
		expect(onCommit).not.toHaveBeenCalled();
		expect(await stream.finish()).toMatchObject({
			text: "",
			state: "aborted",
		});
	});

	it("does not freeze a partial domain at a callback-end period", async () => {
		const onCommit = vi.fn();
		const stream = new CommittedReplyStream({ onCommit });
		await stream.pushProviderChunk("Read https://example.");
		stream.abort();
		await stream.pushProviderChunk("com/docs for details.");
		expect(onCommit).not.toHaveBeenCalled();
		expect((await stream.finish()).committedText).toBe("");
	});

	it("strips split reasoning and machine syntax before committing", async () => {
		const { stream, chunks } = harness();
		await stream.pushProviderChunk("<thi");
		await stream.pushProviderChunk("nk>private chain</think>Hello there. Ne");
		expect(chunks).toEqual(["Hello there."]);
		await stream.pushProviderChunk(
			"xt <tool_call>internal()</tool_call>answer.",
		);
		const result = await stream.finish();
		expect(result.text).toBe("Hello there. Next answer.");
		expect(result.text).not.toContain("private chain");
		expect(result.text).not.toContain("internal()");
	});

	it.each(["analysis", "scratchpad"])(
		"holds and strips split <%s> private reasoning outside code",
		async (tag) => {
			const { stream, chunks } = harness();
			await stream.pushProviderChunk(`<${tag.slice(0, 4)}`);
			await stream.pushProviderChunk(
				`${tag.slice(4)}>Private sentence.</${tag}>Public sentence. Tail`,
			);
			expect(chunks).toEqual(["Public sentence."]);
			expect((await stream.finish()).text).toBe("Public sentence. Tail");
		},
	);

	it.each([
		'<tool_calls>{"name":"BROWSER"}</tool_calls> Public answer.',
		"<tools>PRIVATE TOOL PLAN.</tools> Public answer.",
		'<|python_tag|>os.system("id") Public answer.',
	])("strips a native model control tag outside code: %s", async (text) => {
		const { stream, chunks } = harness();
		const split = Math.max(1, Math.floor(text.length / 3));
		await stream.pushProviderChunk(text.slice(0, split));
		await stream.pushProviderChunk(text.slice(split));
		const result = await stream.finish();
		expect(result.text).not.toMatch(/BROWSER|PRIVATE TOOL PLAN|os\.system/u);
		expect(chunks.join("")).not.toMatch(
			/BROWSER|PRIVATE TOOL PLAN|os\.system/u,
		);
	});

	it("holds and blocks split GPT-OSS Harmony reasoning frames", async () => {
		const harmony =
			"<|start|>assistant<|channel|>analysis<|message|>We need hide this. <|channel|>final<|message|>Public answer.<|end|>";
		for (let split = 1; split < "<|channel|>".length; split += 1) {
			const chunks: string[] = [];
			const stream = new CommittedReplyStream({
				onCommit: (chunk) => chunks.push(chunk),
			});
			await stream.pushProviderChunk(harmony.slice(0, split));
			await stream.pushProviderChunk(harmony.slice(split));
			expect(await stream.finish()).toMatchObject({
				text: "",
				state: "blocked",
				blockReason: "internal_control",
			});
			expect(chunks).toEqual([]);
		}
	});

	it("preserves private-looking tag examples inside Markdown code", async () => {
		const text =
			"Document these forms.\n\n```xml\n<analysis>literal</analysis>\n```\n\nAnd `<scratchpad>literal</scratchpad>`.";
		const { stream } = harness();
		await stream.pushProviderChunk(text);
		expect((await stream.finish()).text).toBe(text);
	});

	it("holds a split final wrapper and unwraps it without leaking tag bytes", async () => {
		const { stream, chunks } = harness();
		await stream.pushProviderChunk("<fi");
		await stream.pushProviderChunk("nal>Visible sentence. More");
		expect(chunks).toEqual([]);
		await stream.pushProviderChunk(" detail.</final> Tail");
		expect(chunks.join("")).toBe("Visible sentence. More detail.");
		const result = await stream.finish();
		expect(result.text).toBe("Visible sentence. More detail. Tail");
		expect(result.text).not.toContain("<final>");
	});

	it("preserves legitimate Markdown, fenced code, inline tags, and JSON", async () => {
		const markdown =
			'Use this literal.\n\n```xml\n<think>keep me</think>\n```\n\nThen `{"shouldRespond":true}`.';
		const { stream } = harness();
		for (const chunk of [
			markdown.slice(0, 22),
			markdown.slice(22, 47),
			markdown.slice(47),
		]) {
			await stream.pushProviderChunk(chunk);
		}
		const result = await stream.finish();
		expect(result.text).toBe(markdown);

		const json = '{"answer":"yes","items":[1,2,3]}';
		const jsonHarness = harness();
		await jsonHarness.stream.pushProviderChunk(json.slice(0, 15));
		await jsonHarness.stream.pushProviderChunk(json.slice(15));
		expect(jsonHarness.chunks).toEqual([]);
		expect((await jsonHarness.stream.finish()).text).toBe(json);
	});

	it("preserves safe requested JSON bytes without stripping literal machine-tag strings", async () => {
		const json = JSON.stringify({
			example: "<tool_call>BROWSER</tool_call>",
			documentation: "<analysis>literal documentation</analysis>",
			stopToken: "<STOP/>",
		});
		const chunks: string[] = [];
		const stream = new CommittedReplyStream({
			onCommit: (chunk) => chunks.push(chunk),
			preserveJsonBytes: true,
		});
		await stream.pushProviderChunk(json.slice(0, 24));
		await stream.pushProviderChunk(json.slice(24));
		expect(chunks).toEqual([]);
		expect((await stream.finish()).text).toBe(json);
		expect(chunks.join("")).toBe(json);
	});

	it.each([
		JSON.stringify("literal <tool_call>BROWSER</tool_call> docs"),
		JSON.stringify("<analysis>literal docs</analysis>"),
		"42",
		"true",
		"false",
		"null",
	])(
		"preserves a safe requested JSON scalar byte-for-byte: %s",
		async (json) => {
			const chunks: string[] = [];
			const stream = new CommittedReplyStream({
				onCommit: (chunk) => chunks.push(chunk),
				preserveJsonBytes: true,
			});
			const split = Math.max(1, Math.floor(json.length / 2));
			await stream.pushProviderChunk(json.slice(0, split));
			await stream.pushProviderChunk(json.slice(split));
			expect(chunks).toEqual([]);
			expect((await stream.finish()).text).toBe(json);
			expect(chunks).toEqual([json]);
		},
	);

	it("fails closed on an envelope marker split across provider chunks", async () => {
		const { stream, chunks } = harness();
		await stream.pushProviderChunk("Safe sentence. More ");
		expect(chunks).toEqual(["Safe sentence."]);
		await stream.pushProviderChunk("<<<EXTERNAL_UNTRUSTED_");
		await stream.pushProviderChunk("CONTENT>>> hidden");
		const result = await stream.finish();
		expect(result).toEqual({
			text: "Safe sentence.",
			state: "blocked",
			committedText: "Safe sentence.",
			blockReason: "external_envelope",
		});
		expect(chunks.join("")).not.toContain("EXTERNAL");
	});

	it("holds and blocks only the runtime control envelope, not arbitrary JSON", async () => {
		const { stream, chunks } = harness();
		const control = JSON.stringify({
			shouldRespond: "RESPOND",
			contexts: ["simple"],
			replyText: "must stay internal",
			facts: [],
		});
		await stream.pushProviderChunk(control);
		expect(chunks).toEqual([]);
		const result = await stream.finish();
		expect(result.state).toBe("blocked");
		expect(result.blockReason).toBe("internal_control");
		expect(result.text).toBe("");
	});

	it.each([
		{ replyText: "Public", thought: "PRIVATE" },
		{ messageToUser: "Public", thought: "PRIVATE" },
		{ response: "Public", reasoning: "PRIVATE" },
		[{ nested: { replyText: "Public", thought: "PRIVATE" } }],
		{ action: "BROWSER", parameters: { url: "https://example.test" } },
		{ name: "BROWSER", arguments: { url: "https://example.test" } },
		{ name: "get_weather", input: { city: "Boston" } },
		{ tool: "BROWSER", args: { url: "https://example.test" } },
		[{ name: "BROWSER", arguments: "{}" }],
	])(
		"blocks recursively reserved JSON control material: $%#",
		async (value) => {
			const onCommit = vi.fn();
			const stream = new CommittedReplyStream({
				onCommit,
				preserveJsonBytes: true,
			});
			const json = JSON.stringify(value);
			await stream.pushProviderChunk(json.slice(0, Math.ceil(json.length / 2)));
			await stream.pushProviderChunk(json.slice(Math.ceil(json.length / 2)));
			const result = await stream.finish();
			expect(onCommit).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				text: "",
				state: "blocked",
				blockReason: "internal_control",
			});
		},
	);

	it.each(["shouldRespond", "processMessage"])(
		"holds a split YAML %s control envelope from its first field",
		async (field) => {
			const { stream, chunks } = harness();
			await stream.pushProviderChunk(field.slice(0, 7));
			await stream.pushProviderChunk(
				`${field.slice(7)}: RESPOND\nreplyText: Never leak. Another field follows.`,
			);
			expect(chunks).toEqual([]);
			const result = await stream.finish();
			expect(result).toEqual({
				text: "",
				state: "blocked",
				committedText: "",
				blockReason: "internal_control",
			});
		},
	);

	it.each([
		"action: BROWSER\nparameters:\n  url: https://example.test.\nDone.",
		"toolCalls:\n  - name: BROWSER\nDone.",
		"tool_calls:\n  - type: function\n    function:\n      name: BROWSER\n      arguments: https://example.test.\nDone.",
		"tool_call:\n  name: BROWSER\n  arguments: https://example.test.\nDone.",
		"tool_use:\n  name: BROWSER\n  input:\n    url: https://example.test.\nDone.",
		"replyText: Public answer.\nthought: PRIVATE_REASONING\nDone.",
		"messageToUser: Public answer.\nreasoning: PRIVATE_REASONING\nDone.",
	])(
		"holds and blocks YAML/native control from its first key",
		async (text) => {
			const { stream, chunks } = harness();
			await stream.pushProviderChunk(text.slice(0, 4));
			await stream.pushProviderChunk(text.slice(4));
			expect(chunks).toEqual([]);
			expect(await stream.finish()).toMatchObject({
				text: "",
				state: "blocked",
				blockReason: "internal_control",
			});
		},
	);

	it.each([
		{
			type: "tool_use",
			id: "toolu_1",
			name: "BROWSER",
			input: { url: "https://example.test" },
		},
		{
			tool_calls: [
				{
					function: {
						name: "BROWSER",
						arguments: '{"url":"https://example.test"}',
					},
				},
			],
		},
	])("blocks provider-native JSON control records: $%#", async (value) => {
		const onCommit = vi.fn();
		const stream = new CommittedReplyStream({
			onCommit,
			preserveJsonBytes: true,
		});
		await stream.pushProviderChunk(JSON.stringify(value));
		expect(await stream.finish()).toMatchObject({
			text: "",
			state: "blocked",
			blockReason: "internal_control",
		});
		expect(onCommit).not.toHaveBeenCalled();
	});

	it.each([
		"---\naction: BROWSER\nparameters:\n  url: https://example.test.\n---\nPublic tail.",
		"# private control envelope\naction: BROWSER\nparameters:\n  note: private.\nPublic tail.",
	])("blocks YAML control after comments or document markers", async (text) => {
		const { stream, chunks } = harness();
		await stream.pushProviderChunk(text.slice(0, 3));
		await stream.pushProviderChunk(text.slice(3, 17));
		await stream.pushProviderChunk(text.slice(17));
		expect(chunks).toEqual([]);
		expect(await stream.finish()).toMatchObject({
			text: "",
			state: "blocked",
			blockReason: "internal_control",
		});
	});

	it.each([
		"replyText: SECRET\nthought: PRIVATE",
		"tool_use:\n  name: BROWSER\n  input:\n    url: https://example.test.",
		"shouldRespond: RESPOND\nreplyText: hidden",
	])(
		"freezes a safe prose prefix before a later YAML control root",
		async (tail) => {
			const { stream, chunks } = harness();
			await stream.pushProviderChunk("Public sentence. More prose");
			expect(chunks).toEqual(["Public sentence."]);
			await stream.pushProviderChunk(`\n${tail}`);
			const result = await stream.finish();
			expect(result).toEqual({
				text: "Public sentence.",
				state: "blocked",
				committedText: "Public sentence.",
				blockReason: "internal_control",
			});
			expect(chunks.join("")).not.toMatch(/SECRET|PRIVATE|BROWSER|hidden/u);
		},
	);

	it.each([
		"  shouldRespond: RESPOND\n  replyText: PRIVATE",
		"\tshouldRespond: RESPOND\n\treplyText: PRIVATE",
		"Public sentence. More prose\n replyText: SECRET\n thought: PRIVATE",
		"Public sentence. More prose\n  type: tool_use\n  id: toolu_1\n  name: BROWSER\n  input:\n    url: https://example.test.",
	])("blocks indented and discriminator-shaped YAML control", async (text) => {
		const { stream, chunks } = harness();
		for (const chunk of [text.slice(0, 9), text.slice(9, 27), text.slice(27)]) {
			await stream.pushProviderChunk(chunk);
		}
		const result = await stream.finish();
		expect(result.state).toBe("blocked");
		expect(result.blockReason).toBe("internal_control");
		expect(chunks.join("")).not.toMatch(/SECRET|PRIVATE|toolu_1|BROWSER/u);
	});

	it("holds a split provider-native YAML discriminator", async () => {
		const { stream, chunks } = harness();
		await stream.pushProviderChunk("type: tool_");
		expect(chunks).toEqual([]);
		await stream.pushProviderChunk(
			"use\nid: toolu_1\nname: BROWSER\ninput:\n  url: https://example.test.",
		);
		expect(await stream.finish()).toMatchObject({
			text: "",
			state: "blocked",
			blockReason: "internal_control",
		});
		expect(chunks).toEqual([]);
	});

	it.each([
		'type: "tool_use"\nid: toolu_1\nname: BROWSER\ninput:\n  url: https://example.test.',
		"- type: tool_use\n  name: BROWSER\n  input:\n    url: https://example.test.",
		"plan:\n  action: BROWSER\n  parameters:\n    url: https://example.test.",
	])(
		"blocks quoted, sequence, and nested YAML control shapes",
		async (text) => {
			const { stream, chunks } = harness();
			await stream.pushProviderChunk(text.slice(0, Math.ceil(text.length / 2)));
			await stream.pushProviderChunk(text.slice(Math.ceil(text.length / 2)));
			expect(await stream.finish()).toMatchObject({
				text: "",
				state: "blocked",
				blockReason: "internal_control",
			});
			expect(chunks).toEqual([]);
		},
	);

	it.each([
		"thought: PRIVATE_REASONING",
		"reasoning: PRIVATE_REASONING",
		"analysis: hidden chain of thought",
		"scratchpad: do not show this",
		"action: BROWSER",
	])("blocks a single internal YAML field: %s", async (text) => {
		const { stream, chunks } = harness();
		await stream.pushProviderChunk(text.slice(0, 5));
		await stream.pushProviderChunk(text.slice(5));
		expect(await stream.finish()).toMatchObject({
			text: "",
			state: "blocked",
			blockReason: "internal_control",
		});
		expect(chunks).toEqual([]);
	});

	it.each([
		'action: BROWSER, parameters: {"url":"https://example.test"}',
		'{action: BROWSER, parameters: {"url":"https://example.test"}}',
		'action = BROWSER; parameters = {"url":"https://example.test"}',
	])("blocks a compact one-line control dialect: %s", async (text) => {
		const { stream, chunks } = harness();
		await stream.pushProviderChunk(text.slice(0, Math.floor(text.length / 2)));
		await stream.pushProviderChunk(text.slice(Math.floor(text.length / 2)));
		expect(await stream.finish()).toMatchObject({
			text: "",
			state: "blocked",
			blockReason: "internal_control",
		});
		expect(chunks).toEqual([]);
	});

	it.each([
		'"thought": PRIVATE_REASONING\n"replyText": Public answer.',
		"'thought': PRIVATE_REASONING\n'replyText': Public answer.",
		"{thought: PRIVATE_REASONING, replyText: Public answer.}",
		"thought = PRIVATE_REASONING\nreplyText = Public answer.",
		"> thought: PRIVATE_REASONING.\n> replyText: Public answer.",
		"* thought: PRIVATE_REASONING.\n* replyText: Public answer.",
		"1. thought: PRIVATE_REASONING.\n2. replyText: Public answer.",
	])(
		"blocks quoted, assignment, or Markdown-wrapped control fields",
		async (text) => {
			const { stream, chunks } = harness();
			const split = Math.max(1, Math.floor(text.length / 2));
			await stream.pushProviderChunk(text.slice(0, split));
			await stream.pushProviderChunk(text.slice(split));
			expect(await stream.finish()).toMatchObject({
				text: "",
				state: "blocked",
				blockReason: "internal_control",
			});
			expect(chunks).toEqual([]);
		},
	);

	it("does not block a standalone low-specificity prose label", async () => {
		const prose =
			"Action: explain the result plainly. A second sentence follows.";
		const { stream } = harness();
		await stream.pushProviderChunk(prose);
		expect((await stream.finish()).text).toBe(prose);
	});

	it("does not mistake ordinary prose or fenced YAML examples for control", async () => {
		const prose =
			"Action is the right word here. More prose.\n\n```yaml\naction: BROWSER\nparameters: {}\n```";
		const { stream } = harness();
		await stream.pushProviderChunk(prose);
		expect((await stream.finish()).text).toBe(prose);
	});

	it("never rewrites committed whitespace when a late machine tag is removed", async () => {
		const { stream, chunks } = harness();
		await stream.pushProviderChunk("  First sentence. \n\n\nTail");
		const committedBeforeTag = chunks.join("");
		expect(committedBeforeTag).toBe("  First sentence. \n\n");
		await stream.pushProviderChunk("<tool_call>hidden</tool_call> More text.");
		const result = await stream.finish();
		expect(result.text).toBe("  First sentence. \n\n\nTail More text.");
		expect(result.text.startsWith(committedBeforeTag)).toBe(true);
	});

	it("holds a malformed partial machine opener containing sentence punctuation", async () => {
		const { stream, chunks } = harness();
		await stream.pushProviderChunk('<tool_call name="x. y');
		expect(chunks).toEqual([]);
		await stream.pushProviderChunk(">hidden</tool_call>Visible sentence. Tail");
		expect(chunks).toEqual(["Visible sentence."]);
		const result = await stream.finish();
		expect(result.text).toBe("Visible sentence. Tail");
	});

	it("freezes the committed prefix on cancellation", async () => {
		const { stream, chunks } = harness();
		await stream.pushProviderChunk("Committed sentence. Partial tail");
		expect(chunks).toEqual(["Committed sentence."]);
		stream.abort();
		await stream.pushProviderChunk(" must never appear.");
		const result = await stream.finish();
		expect(result).toEqual({
			text: "Committed sentence.",
			state: "aborted",
			committedText: "Committed sentence.",
		});
	});

	it("rejects a terminal response that rewrites an irrevocable prefix", async () => {
		const { stream } = harness();
		await stream.pushProviderChunk("Frozen sentence. More");
		await expect(
			stream.finish("Rewritten sentence. More"),
		).rejects.toMatchObject({
			name: "CommittedReplyProtocolError",
			recoverableCommittedPrefix: true,
		});
		expect(stream.state).toBe("failed");
	});

	it("treats validator rejection as fatal and non-retryable", async () => {
		const seen: Array<{ text: string; terminal: boolean }> = [];
		const chunks: string[] = [];
		const stream = new CommittedReplyStream({
			onCommit: (chunk) => chunks.push(chunk),
			validateCandidate: (text, context) => {
				seen.push({ text, terminal: context.terminal });
				return !text.includes("unsupported success");
			},
		});
		await expect(
			stream.pushProviderChunk("Safe fact. unsupported success. Next"),
		).rejects.toMatchObject({
			name: "CommittedReplyProtocolError",
			retryable: false,
		});
		expect(chunks).toEqual(["Safe fact."]);
		expect(stream.state).toBe("failed");
		expect(stream.committedText).toBe("Safe fact.");
		expect(seen[0]).toEqual({ text: "Safe fact.", terminal: false });
	});

	it("freezes an already visible prefix when a later policy candidate is rejected", async () => {
		const chunks: string[] = [];
		const stream = new CommittedReplyStream({
			onCommit: (chunk) => chunks.push(chunk),
			validateCandidate: (text) => !text.includes("I created the event"),
		});
		await stream.pushProviderChunk("Safe sentence. Tail");

		await expect(
			stream.pushProviderChunk(" I created the event. More"),
		).rejects.toMatchObject({
			name: "CommittedReplyProtocolError",
			retryable: false,
			recoverableCommittedPrefix: true,
		});
		expect(chunks).toEqual(["Safe sentence."]);
		expect(stream.committedText).toBe("Safe sentence.");
		expect(stream.state).toBe("failed");
	});

	it("lets cancellation dominate a validator that settles afterward", async () => {
		let resolveValidation: ((accepted: boolean) => void) | undefined;
		const validation = new Promise<boolean>((resolve) => {
			resolveValidation = resolve;
		});
		const onCommit = vi.fn();
		const stream = new CommittedReplyStream({
			onCommit,
			validateCandidate: () => validation,
		});
		const pushing = stream.pushProviderChunk("Never delivered. Tail");
		await Promise.resolve();
		stream.abort();
		resolveValidation?.(true);
		await pushing;

		expect(onCommit).not.toHaveBeenCalled();
		expect(stream.committedText).toBe("");
		expect(stream.state).toBe("aborted");
	});

	it("treats validator exceptions as fatal and preserves their cause", async () => {
		const cause = new Error("validator unavailable");
		const stream = new CommittedReplyStream({
			onCommit: vi.fn(),
			validateCandidate: () => {
				throw cause;
			},
		});
		await expect(
			stream.pushProviderChunk("Candidate sentence. Tail"),
		).rejects.toMatchObject({
			name: "CommittedReplyProtocolError",
			retryable: false,
			cause,
		});
		expect(stream.state).toBe("failed");
	});

	it("treats onCommit rejection as fatal and never advances committed text", async () => {
		const cause = new Error("downstream rejected");
		const stream = new CommittedReplyStream({
			onCommit: async () => {
				throw cause;
			},
		});
		let rejection: unknown;
		try {
			await stream.pushProviderChunk("Candidate sentence. Tail");
		} catch (error) {
			rejection = error;
		}
		expect(rejection).toEqual(expect.any(CommittedReplyDeliveryError));
		expect(rejection).toMatchObject({
			name: "CommittedReplyDeliveryError",
			retryable: false,
			cause,
		});
		expect(stream.state).toBe("failed");
		expect(stream.committedText).toBe("");
	});

	it("serializes concurrent provider callbacks without duplicate delivery", async () => {
		let releaseFirst: (() => void) | undefined;
		const firstValidation = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let validationCount = 0;
		const chunks: string[] = [];
		const snapshots: string[] = [];
		const stream = new CommittedReplyStream({
			validateCandidate: async () => {
				validationCount += 1;
				if (validationCount === 1) await firstValidation;
				return true;
			},
			onCommit: (chunk, accumulated) => {
				chunks.push(chunk);
				snapshots.push(accumulated);
			},
		});

		const first = stream.pushProviderChunk("One. Two");
		await Promise.resolve();
		const second = stream.pushProviderChunk(". Three");
		releaseFirst?.();
		await Promise.all([first, second]);
		await stream.finish();

		expect(chunks.join("")).toBe("One. Two. Three");
		expect(snapshots).toEqual(["One.", "One. Two.", "One. Two. Three"]);
	});

	it("queues finish behind an in-flight push", async () => {
		let releaseCommit: (() => void) | undefined;
		const commitBarrier = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		const snapshots: string[] = [];
		const stream = new CommittedReplyStream({
			onCommit: async (_chunk, accumulated) => {
				snapshots.push(accumulated);
				if (snapshots.length === 1) await commitBarrier;
			},
		});
		const pushing = stream.pushProviderChunk("One. Tail");
		await Promise.resolve();
		const finishing = stream.finish("One. Tail");
		releaseCommit?.();
		await pushing;
		expect((await finishing).text).toBe("One. Tail");
		expect(snapshots).toEqual(["One.", "One. Tail"]);
	});

	it("marks source overflow after a visible prefix recoverable", async () => {
		const { stream } = harness();
		await stream.pushProviderChunk("Visible sentence. Tail");
		await expect(
			stream.pushProviderChunk("x".repeat(MAX_COMMITTED_REPLY_SOURCE_CHARS)),
		).rejects.toMatchObject({
			name: "CommittedReplyProtocolError",
			recoverableCommittedPrefix: true,
		});
		expect(stream.committedText).toBe("Visible sentence.");
	});
});
