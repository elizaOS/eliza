/**
 * Tests markdown → Feishu Post conversion in formatting.ts, including stripping
 * of unsafe link URLs. Pure-function tests, no external calls.
 */
import { describe, expect, it } from "vitest";
import { markdownToFeishuPost } from "./formatting";

describe("Feishu markdown formatting", () => {
	it("drops unsafe markdown link URLs from Feishu post elements", () => {
		const post = markdownToFeishuPost(
			"[safe](https://example.com/path?q=1) [script](javascript:alert) [data](data:text/html,boom)",
		);

		const elements = post.zh_cn?.content.flat() ?? [];
		const links = elements.filter((element) => element.tag === "a");

		expect(links).toEqual([
			expect.objectContaining({
				tag: "a",
				text: "safe",
				href: "https://example.com/path?q=1",
			}),
		]);
		expect(elements.some((element) => element.text?.includes("script"))).toBe(
			true,
		);
		expect(elements.some((element) => element.text?.includes("data"))).toBe(
			true,
		);
	});
});
