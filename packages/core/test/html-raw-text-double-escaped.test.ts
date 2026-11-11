import { describe, expect, it } from "vitest";
import { stripHtmlRawTextElements } from "../src/utils/html-raw-text";

describe("stripHtmlRawTextElements script double-escape", () => {
	it("keeps the script open after --> in the double-escaped state", () => {
		// WHATWG tokenizer: <!-- enters the escaped state, <script> enters the
		// double-escaped state, and --> in the double-escaped state returns
		// to the escaped state (not to data). The <script> that follows
		// re-enters double-escape, so the first </script> only drops back to
		// escaped and the SECRET stays inside the script element.
		const input =
			"<script><!-- <script> --> <script> </script> SECRET </script> done";
		const stripped = stripHtmlRawTextElements(input);
		expect(stripped).not.toContain("SECRET");
		expect(stripped).toContain("done");
	});

	it("still closes at the end tag after --> in the escaped state", () => {
		const stripped = stripHtmlRawTextElements(
			"<script><!-- alert(1) --> </script> after",
		);
		expect(stripped).not.toContain("alert");
		expect(stripped).toContain("after");
	});

	it("still strips a plain script element", () => {
		expect(stripHtmlRawTextElements("<script>alert(1)</script> hello")).toBe(
			"  hello",
		);
	});
});
