/**
 * Characterization tests for `sanitizeOutboundText` — the shared outbound
 * sanitizer moved from the Discord-local pre-send sanitizer (plugin-discord
 * `reasoning-tags.ts`, #15812 → #15888). The corpus locks the Discord
 * semantics (paired, unclosed, nested, malformed, and adversarial tag shapes;
 * fenced-code preservation; sentinel removal; whitespace collapse;
 * idempotence) so the move to `packages/core` is behavior-preserving for
 * every connector, and pins the four deliberate deltas fixed at the promotion
 * moment: the lone-`eot_id` pre-filter gap, `$`-replacement-pattern corruption
 * during fence restore, blank-line collapse inside restored fences, and
 * inline code-span protection. Each delta has a dedicated test naming it.
 */
import { describe, expect, it } from "vitest";
import { sanitizeOutboundText } from "./outbound-sanitize";

describe("sanitizeOutboundText — reasoning tags (Discord characterization)", () => {
	it("strips paired reasoning tags with their contents", () => {
		expect(
			sanitizeOutboundText(
				"<thinking>internal notes</thinking>The answer is 4.",
			),
		).toBe("The answer is 4.");
	});

	it("strips an unclosed reasoning tag to end of text", () => {
		expect(sanitizeOutboundText("The answer is 4.<reasoning>and then I")).toBe(
			"The answer is 4.",
		);
	});

	it("strips every reasoning tag family", () => {
		for (const tag of [
			"thinking",
			"reasoning",
			"reflection",
			"thought",
			"antthinking",
		]) {
			expect(
				sanitizeOutboundText(`Before.<${tag}>hidden</${tag}>After.`),
				`paired <${tag}> is stripped`,
			).toBe("Before.After.");
		}
	});

	it("unwraps <final> keeping its contents", () => {
		expect(
			sanitizeOutboundText("<final>The verified answer is 4.</final>"),
		).toBe("The verified answer is 4.");
	});

	it("removes end-of-turn sentinels", () => {
		expect(sanitizeOutboundText("All done.<|im_end|>")).toBe("All done.");
		expect(sanitizeOutboundText("All done.<STOP/>")).toBe("All done.");
		expect(sanitizeOutboundText("All done.<END>")).toBe("All done.");
		expect(sanitizeOutboundText("All done.<end_turn />")).toBe("All done.");
	});

	it("removes a lone eot_id sentinel (delta: quick-filter gap)", () => {
		// The Discord original stripped `<|eot_id|>` only when another marker was
		// also present — its quick pre-filter did not list `eot_id`, so the lone
		// sentinel bypassed sanitization entirely. The shared sanitizer closes
		// that gap.
		expect(sanitizeOutboundText("All done.<|eot_id|>")).toBe("All done.");
		expect(sanitizeOutboundText("All done.<eot_id/>")).toBe("All done.");
	});
});

describe("sanitizeOutboundText — native tool-call syntax", () => {
	it("strips an unclosed native tool_call leak (observed live)", () => {
		// glm-4.7 drifted out of the response grammar mid-turn and this exact
		// shape reached Discord verbatim (#15812).
		expect(
			sanitizeOutboundText(
				"Let me try the weather action for current conditions.<tool_call>get_weather",
			),
		).toBe("Let me try the weather action for current conditions.");
	});

	it("strips paired tool_call and function_call blocks with contents", () => {
		expect(
			sanitizeOutboundText(
				'Done.<tool_call>{"name":"get_weather","args":{}}</tool_call>',
			),
		).toBe("Done.");
		expect(
			sanitizeOutboundText(
				"Sure.<function_call>lookup(x)</function_call> Next.",
			),
		).toBe("Sure. Next.");
	});

	it("strips multiple tool_call blocks in one message", () => {
		expect(
			sanitizeOutboundText(
				"A.<tool_call>one</tool_call>B.<tool_call>two</tool_call>C.",
			),
		).toBe("A.B.C.");
	});

	it("strips tags case-insensitively", () => {
		expect(sanitizeOutboundText("Hi.<TOOL_CALL>x</TOOL_CALL>Bye.")).toBe(
			"Hi.Bye.",
		);
		expect(sanitizeOutboundText("Hi.<Function_Call>y</Function_Call>")).toBe(
			"Hi.",
		);
	});

	it("strips tags carrying attributes", () => {
		expect(
			sanitizeOutboundText(
				'Hi.<tool_call name="get_weather" id="1">args</tool_call>Bye.',
			),
		).toBe("Hi.Bye.");
		expect(
			sanitizeOutboundText('Hi.<function_call name="lookup">rest of turn'),
		).toBe("Hi.");
	});
});

describe("sanitizeOutboundText — nested, malformed, and adversarial shapes", () => {
	it("strips nested same-family tags (outer pair wins, tail removed as unclosed)", () => {
		// The paired pass is non-greedy: it matches the outer open tag up to the
		// FIRST close tag, leaving the dangling second close tag and any trailing
		// prose to the unclosed pass only when an open tag remains. Here the
		// remainder has no open tag, so the stray close tag survives — locked as
		// the exact Discord behavior.
		expect(
			sanitizeOutboundText(
				"Hi.<tool_call>outer<tool_call>inner</tool_call>tail</tool_call>Bye.",
			),
		).toBe("Hi.tail</tool_call>Bye.");
	});

	it("strips cross-family nesting completely", () => {
		expect(
			sanitizeOutboundText(
				"Hi.<thinking>plan<tool_call>get_weather</tool_call>more</thinking>Bye.",
			),
		).toBe("Hi.Bye.");
	});

	it("does not treat a lone close tag as strippable", () => {
		// No opening tag means neither the paired nor the unclosed pass matches;
		// a stray close tag passes through (locked Discord behavior).
		expect(sanitizeOutboundText("Odd.</tool_call> Right.")).toBe(
			"Odd.</tool_call> Right.",
		);
	});

	it("does not strip a tag-name prefix of a longer identifier", () => {
		// \b after the tag name: <tool_callback> is a different tag, and with no
		// matching listed tag the quick filter still fires on `<tool_call` — the
		// text must survive both passes unchanged.
		expect(sanitizeOutboundText("See <thoughtful>notes</thoughtful>.")).toBe(
			"See <thoughtful>notes</thoughtful>.",
		);
	});

	it("strips an unterminated open tag as unclosed-to-end", () => {
		// `[^>]*>` needs a closing angle bracket; without one the paired pass
		// cannot match, but the text has no other content to protect either —
		// locked: the malformed `<tool_call` with no `>` survives (it never
		// forms a tag).
		expect(sanitizeOutboundText("Hmm <tool_call get_weather")).toBe(
			"Hmm <tool_call get_weather",
		);
	});

	it("removes a whole message that is only machine syntax", () => {
		expect(sanitizeOutboundText("<tool_call>get_weather</tool_call>")).toBe("");
		expect(sanitizeOutboundText("<thinking>only thoughts")).toBe("");
	});

	it("collapses the whitespace a stripped block leaves behind", () => {
		expect(
			sanitizeOutboundText(
				"Line one.\n\n<tool_call>x</tool_call>\n\nLine two.",
			),
		).toBe("Line one.\n\nLine two.");
	});

	it("strips user-echoed tool syntax outside code fences (adversarial input)", () => {
		// A user can bait the model into echoing raw syntax back; the sanitizer
		// cannot distinguish provenance, so unfenced machine syntax is always
		// stripped. Prose written to LOOK like it survives only inside fences.
		expect(
			sanitizeOutboundText(
				"You asked about <tool_call>do_evil</tool_call> — I will not run that.",
			),
		).toBe("You asked about  — I will not run that.");
	});
});

describe("sanitizeOutboundText — fenced code preservation", () => {
	it("preserves tool_call syntax inside fenced code blocks", () => {
		const text =
			"Example:\n```xml\n<tool_call>get_weather</tool_call>\n```\nThat is the format.";
		expect(sanitizeOutboundText(text)).toBe(text);
	});

	it("preserves multiple fences while stripping unfenced syntax between them", () => {
		const input =
			"```\n<thinking>kept</thinking>\n```\n<tool_call>stripped</tool_call>\n```\n<function_call>kept</function_call>\n```";
		const expected =
			"```\n<thinking>kept</thinking>\n```\n\n```\n<function_call>kept</function_call>\n```";
		expect(sanitizeOutboundText(input)).toBe(expected);
	});

	it("preserves code with $-replacement patterns inside fences (delta: function-replacement restore)", () => {
		// The Discord original restored fences with a STRING `.replace`, so `$$`
		// collapsed to `$` and `$&` re-inserted the raw NUL sentinel onto the
		// wire. Fixed at the promotion moment; all four `$` patterns pinned.
		const dollarDollar = "Run this:\n```bash\nkill -9 $$\n```";
		expect(
			sanitizeOutboundText(`${dollarDollar}\n<tool_call>x</tool_call>`),
		).toBe(dollarDollar);

		const dollarAmp = "Try:\n```bash\nsed 's/x/$&/'\n```";
		expect(sanitizeOutboundText(`${dollarAmp}\n<tool_call>x</tool_call>`)).toBe(
			dollarAmp,
		);
		expect(
			sanitizeOutboundText(`${dollarAmp}\n<tool_call>x</tool_call>`),
		).not.toContain("\x00");

		const dollarBacktick = "F:\n```\necho $`\n```";
		expect(
			sanitizeOutboundText(`${dollarBacktick}\n<tool_call>x</tool_call>`),
		).toBe(dollarBacktick);

		const dollarQuote = "F:\n```\necho $'\n```";
		expect(
			sanitizeOutboundText(`${dollarQuote}\n<tool_call>x</tool_call>`),
		).toBe(dollarQuote);
	});

	it("preserves blank-line spacing inside fences (delta: collapse runs before restore)", () => {
		// The Discord original ran the cosmetic `\n{3,}` collapse on the RESTORED
		// text, reformatting e.g. PEP8 two-blank-line spacing inside a fence.
		const fence = "```py\ndef a():\n    pass\n\n\ndef b():\n    pass\n```";
		expect(sanitizeOutboundText(`Fence:\n${fence}\n<thinking>drop`)).toBe(
			`Fence:\n${fence}`,
		);
	});

	it("protects inline code spans (delta: span protection)", () => {
		// The Discord original treated `` `<tool_call>` `` as an unclosed tag and
		// truncated the whole rest of the reply to "The `". Now that the
		// sanitizer runs on every surface and the persisted memory, a coding
		// answer that mentions the syntax in an inline span must survive.
		const single = "The `<tool_call>` tag wraps a native call.";
		expect(sanitizeOutboundText(single)).toBe(single);

		expect(
			sanitizeOutboundText(
				"Use ``<function_call>`` here. <tool_call>x</tool_call>",
			),
		).toBe("Use ``<function_call>`` here.");

		// Protection is span-scoped: the same tag outside a span still strips.
		expect(
			sanitizeOutboundText(
				"See `<thinking>` and strip <thinking>gone</thinking> done.",
			),
		).toBe("See `<thinking>` and strip  done.");
	});

	it("treats an unclosed fence as unprotected", () => {
		// ``` without a closing fence never matches CODE_BLOCK_RE, so syntax
		// after it is stripped like any other text.
		expect(
			sanitizeOutboundText("```\n<tool_call>get_weather</tool_call>"),
		).toBe("```");
	});
});

describe("sanitizeOutboundText — pass-through and idempotence", () => {
	it("leaves plain text untouched", () => {
		expect(sanitizeOutboundText("Bitcoin is at $63,217.")).toBe(
			"Bitcoin is at $63,217.",
		);
	});

	it("leaves benign user-authored markup untouched", () => {
		expect(sanitizeOutboundText("Use <b>bold</b> and 3 < 4 && 5 > 4.")).toBe(
			"Use <b>bold</b> and 3 < 4 && 5 > 4.",
		);
	});

	it("returns empty text unchanged", () => {
		expect(sanitizeOutboundText("")).toBe("");
	});

	it("is idempotent across the whole corpus", () => {
		const corpus = [
			"<thinking>internal notes</thinking>The answer is 4.",
			"The answer is 4.<reasoning>and then I",
			"Let me try the weather action.<tool_call>get_weather",
			'Done.<tool_call>{"name":"get_weather","args":{}}</tool_call>',
			"Sure.<function_call>lookup(x)</function_call> Next.",
			"Hi.<tool_call>outer<tool_call>inner</tool_call>tail</tool_call>Bye.",
			"Example:\n```xml\n<tool_call>get_weather</tool_call>\n```\nThat is the format.",
			"Line one.\n\n<tool_call>x</tool_call>\n\nLine two.",
			"All done.<|im_end|>",
			"<final>The verified answer is 4.</final>",
			"Bitcoin is at $63,217.",
			"Odd.</tool_call> Right.",
			"The `<tool_call>` tag wraps a native call.",
			"Run this:\n```bash\nkill -9 $$\n```\n<tool_call>x</tool_call>",
			"Try:\n```bash\nsed 's/x/$&/'\n```\n<tool_call>x</tool_call>",
			"Fence:\n```py\ndef a():\n    pass\n\n\ndef b():\n    pass\n```\n<thinking>drop",
			"Use ``<function_call>`` here. <tool_call>x</tool_call>",
			"See `<thinking>` and strip <thinking>gone</thinking> done.",
			"All done.<|eot_id|>",
		];
		for (const text of corpus) {
			const once = sanitizeOutboundText(text);
			expect(sanitizeOutboundText(once), `idempotent for: ${text}`).toBe(once);
		}
	});
});
