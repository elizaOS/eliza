import { describe, expect, it } from "vitest";
import { stripHtmlRawTextElements } from "../src/utils/html-raw-text";

describe("stripHtmlRawTextElements", () => {
	it("strips a plain script element", () => {
		expect(stripHtmlRawTextElements("<script>var x = 1;</script>hello")).toBe(
			" hello",
		);
	});

	it("strips a style element", () => {
		expect(stripHtmlRawTextElements("<style>a { color: red; }</style>hi")).toBe(
			" hi",
		);
	});

	it("closes on an escaped end tag after a comment", () => {
		expect(
			stripHtmlRawTextElements("<script><!-- alert(1); --></script>hi"),
		).toBe(" hi");
	});

	it("does not close on an end tag while double-escaped", () => {
		expect(
			stripHtmlRawTextElements(
				"<script><!-- <script> </script> SECRET </script>visible",
			),
		).toBe(" visible");
	});

	it("returns to the escaped state on --> while double-escaped", () => {
		// WHATWG script-data tokenizer: --> in the double-escaped state
		// returns to the escaped state, not the data state. A later
		// <script> must re-enter double-escaped, so the first </script>
		// after it only leaves the double-escaped state and the SECRET
		// stays inside the script element.
		expect(
			stripHtmlRawTextElements(
				"<script><!-- <script> --> <script> </script> SECRET </script>visible",
			),
		).toBe(" visible");
	});

	it("strips through end of input when the script never closes", () => {
		expect(stripHtmlRawTextElements("hi<script>var x = 1;")).toBe("hi ");
	});
});
