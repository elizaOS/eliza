/**
 * Unit tests for assistant text extraction and stage direction stripping.
 * Exercises response unboxing, delimiter matching, and code block preservation.
 */

import { describe, expect, it } from "vitest";
import {
	extractAssistantReplyText,
	stripAssistantStageDirections,
} from "./assistant-text.js";

describe("stripAssistantStageDirections", () => {
	it("strips asterisk stage directions", () => {
		expect(stripAssistantStageDirections("hello *smiles* world")).toBe(
			"hello world",
		);
		expect(stripAssistantStageDirections("*sighs* okay fine")).toBe(
			"okay fine",
		);
	});

	it("strips underscore stage directions", () => {
		expect(stripAssistantStageDirections("hello _waves_ there")).toBe(
			"hello there",
		);
	});

	it("preserves emphasis words that are not stage directions", () => {
		expect(stripAssistantStageDirections("this is *very* important")).toBe(
			"this is *very* important",
		);
		expect(stripAssistantStageDirections("not _really_ sure")).toBe(
			"not _really_ sure",
		);
	});

	it("preserves markdown bold and italic spans", () => {
		expect(stripAssistantStageDirections("**bold** and *smile*")).toBe(
			"**bold** and",
		);
	});

	it("handles non-string inputs safely", () => {
		expect(stripAssistantStageDirections("" as unknown as string)).toBe("");
	});

	it("does not strip text when removed length exceeds safety threshold", () => {
		const text = `*${"a".repeat(101)}*`;
		expect(stripAssistantStageDirections(text)).toBe(text);
	});

	it("strips stage directions leaving only clean text", () => {
		expect(
			stripAssistantStageDirections(
				"*looks at the camera and smiles warmly* hello",
			),
		).toBe("hello");
		expect(stripAssistantStageDirections("*waves* hello").trim()).toBe("hello");
	});

	it('unwraps a bare {"reply":...} object the model emitted as text', () => {
		expect(extractAssistantReplyText('{"reply":"107"}')).toBe("107");
		expect(
			extractAssistantReplyText('{"reply":"Red, blue, and yellow."}'),
		).toBe("Red, blue, and yellow.");
	});

	it('unwraps {"reply":...} alongside known response-shape siblings', () => {
		expect(
			extractAssistantReplyText('{"reply":"hi there","action":"NONE"}'),
		).toBe("hi there");
		expect(
			extractAssistantReplyText(
			JSON.stringify({ thought: "x", reply: "done", actions: ["REPLY"] }),
		),
		).toBe("done");
	});

	it("strips stage directions from an unwrapped reply object", () => {
		expect(extractAssistantReplyText('{"reply":"*waves* hello"}')).toBe(
			"hello",
		);
	});

	it("does NOT unwrap a reply object carrying unrelated data or a non-primitive reply", () => {
		expect(
			extractAssistantReplyText('{"reply":"hi","userData":{"id":1}}'),
		).toBeNull();
		expect(extractAssistantReplyText('{"reply":{"x":1}}')).toBeNull();
		expect(extractAssistantReplyText('{"reply":[1,2]}')).toBeNull();
	});

	it("unwraps a primitive (number/boolean) reply the model emitted as text", () => {
		expect(extractAssistantReplyText('{"reply":42}')).toBe("42");
		expect(extractAssistantReplyText('{"reply":true}')).toBe("true");
		expect(extractAssistantReplyText('{"reply":7,"action":"NONE"}')).toBe("7");
	});

	it("unwraps the `response` wrapper key too (the key drifts reply/response)", () => {
		expect(extractAssistantReplyText('{"response":"54"}')).toBe("54");
		expect(extractAssistantReplyText('{"response":42}')).toBe("42");
		expect(extractAssistantReplyText('{"response":"hi","action":"NONE"}')).toBe(
			"hi",
		);
		expect(extractAssistantReplyText('{"response":{"x":1}}')).toBeNull();
		expect(
			extractAssistantReplyText('{"response":"hi","userData":{"id":1}}'),
		).toBeNull();
	});

	it("does not rewrite ordinary chat text that merely contains the word reply", () => {
		expect(
			extractAssistantReplyText("Sure ? my reply is that the sky is blue."),
		).toBeNull();
	});

	it("preserves leading indentation and structure inside fenced code blocks", () => {
		const pythonCode =
			"```python\ndef f(x):\n    if x > 1:\n        return x * 2\n    return x\n```";
		expect(stripAssistantStageDirections(pythonCode)).toBe(pythonCode);

		const mixedMessage = `Here is the configuration:

```yaml
services:
  agent:
    image: elizaos/agent:latest
    environment:
      - DEBUG=true
```

*smiles* Hope that helps!`;

		const expected = `Here is the configuration:

```yaml
services:
  agent:
    image: elizaos/agent:latest
    environment:
      - DEBUG=true
```

Hope that helps!`;

		expect(stripAssistantStageDirections(mixedMessage)).toBe(expected);
	});

	it("preserves stage direction words and formatting inside code blocks", () => {
		const codeWithComments =
			"```ts\n// *smiles* this is a comment\nconst x = _value_;\n```";
		expect(stripAssistantStageDirections(codeWithComments)).toBe(
			codeWithComments,
		);
	});

	it("preserves indentation in streaming / unterminated code blocks", () => {
		const streamingCode = "```python\ndef f(x):\n    if x > 1:\n        pass";
		expect(stripAssistantStageDirections(streamingCode)).toBe(streamingCode);
	});

	it("preserves indentation and termination for code blocks inside lists", () => {
		const listNestedBlock = "- item\n    ```py\n    x = 1\n    ```\n*smiles*";
		const expected = "- item\n    ```py\n    x = 1\n    ```\n";
		expect(stripAssistantStageDirections(listNestedBlock)).toBe(expected);

		const numberedList = "1. step\n   ```sh\n   npm test\n   ```\n*waves*";
		const expectedNumbered = "1. step\n   ```sh\n   npm test\n   ```\n";
		expect(stripAssistantStageDirections(numberedList)).toBe(expectedNumbered);
	});

	it("preserves outer code fences containing shorter inner code fences (backticks and tildes)", () => {
		const nestedBackticks =
			"````markdown\n```ts\nconst x = 1;\n```\n    indented tail\n````\n*smiles* done";
		const expectedBackticks =
			"````markdown\n```ts\nconst x = 1;\n```\n    indented tail\n````\ndone";
		expect(stripAssistantStageDirections(nestedBackticks)).toBe(
			expectedBackticks,
		);

		const nestedTildes =
			"~~~~markdown\n~~~ts\nconst x = 1;\n~~~\n    indented tail\n~~~~\n*smiles* done";
		const expectedTildes =
			"~~~~markdown\n~~~ts\nconst x = 1;\n~~~\n    indented tail\n~~~~\ndone";
		expect(stripAssistantStageDirections(nestedTildes)).toBe(expectedTildes);
	});

	it("preserves sentinel-like or marker-like tokens in user text without collision", () => {
		const textWithMarker =
			'Original text with \u0000ELIZACODE0\u0000 inside it.\n\n```python\nprint("Hello world")\n```';
		expect(stripAssistantStageDirections(textWithMarker)).toBe(textWithMarker);
	});

	it("preserves multiple alternating code blocks and prose segments", () => {
		const multi =
			"prose 1\n```py\ncode 1\n```\nprose 2 *smiles*\n```js\ncode 2\n```\nprose 3";
		const expected =
			"prose 1\n```py\ncode 1\n```\nprose 2\n```js\ncode 2\n```\nprose 3";
		expect(stripAssistantStageDirections(multi)).toBe(expected);
	});

	it("preserves literal code lines with false closing fences having 4 or more spaces indentation (CommonMark Example 137)", () => {
		const codeWithFalseCloser =
			'```python\ndef f():\n    note = """\n    ```\n        keep  two  spaces\n    """\n    # *smiles* literal comment\n    return note\n```\n*smiles* done';
		const expected =
			'```python\ndef f():\n    note = """\n    ```\n        keep  two  spaces\n    """\n    # *smiles* literal comment\n    return note\n```\ndone';
		expect(stripAssistantStageDirections(codeWithFalseCloser)).toBe(expected);
	});

	it("preserves list-nested code blocks with false closing fences indented beyond the opener (CommonMark relative indentation)", () => {
		const listWithFalseCloser =
			'- Example\n  ```python\n  def f():\n      note = """\n      ```\n          keep  two  spaces\n      """\n      # *smiles* literal comment\n      return note\n  ```\n*smiles* done';
		const expectedList =
			'- Example\n  ```python\n  def f():\n      note = """\n      ```\n          keep  two  spaces\n      """\n      # *smiles* literal comment\n      return note\n  ```\ndone';
		expect(stripAssistantStageDirections(listWithFalseCloser)).toBe(
			expectedList,
		);
	});

	it("preserves blockquoted code blocks without corrupting indentation or literal comments", () => {
		const blockquoteCode =
			"> ```python\n> def f():\n>     # *smiles* literal comment\n>     return 1\n> ```\n*smiles* done";
		const expectedBlockquote =
			"> ```python\n> def f():\n>     # *smiles* literal comment\n>     return 1\n> ```\ndone";
		expect(stripAssistantStageDirections(blockquoteCode)).toBe(
			expectedBlockquote,
		);
	});

	it("terminates blockquoted code blocks when blockquote container ends", () => {
		const unclosedBlockquote =
			"> ```python\n> def f():\n>     return 1\n\n*smiles* done";
		const expectedUnclosed = "> ```python\n> def f():\n>     return 1\n\ndone";
		expect(stripAssistantStageDirections(unclosedBlockquote)).toBe(
			expectedUnclosed,
		);
	});

	it("is null/undefined-safe (e.g. a 202 placeholder body with no text)", () => {
		expect(
			extractAssistantReplyText(undefined as unknown as string),
		).toBeNull();
		expect(extractAssistantReplyText(null as unknown as string)).toBeNull();
		expect(stripAssistantStageDirections(undefined as unknown as string)).toBe(
			"",
		);
		expect(stripAssistantStageDirections(null as unknown as string)).toBe("");
	});
});
