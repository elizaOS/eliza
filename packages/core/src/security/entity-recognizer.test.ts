import { describe, expect, it } from "vitest";
import {
	CompositeEntityRecognizer,
	canonicalKind,
	GazetteerEntityRecognizer,
	RegexEntityRecognizer,
} from "./entity-recognizer";

describe("RegexEntityRecognizer", () => {
	it("detects US-style street addresses by default", async () => {
		const r = new RegexEntityRecognizer();
		const spans = await r.recognize(
			"Deliver to 742 Evergreen Terrace, Springfield, IL 62704 tomorrow.",
		);
		expect(spans).toHaveLength(1);
		expect(spans[0]?.kind).toBe("address");
		expect(spans[0]?.value).toContain("742 Evergreen Terrace");
		// Offsets are populated for regex spans (unlike the ONNX path).
		expect(spans[0]?.start).toBeGreaterThanOrEqual(0);
	});

	it("does not treat ordinary quantities as addresses", async () => {
		const r = new RegexEntityRecognizer();
		expect(await r.recognize("I bought 12 apples and 3 oranges.")).toHaveLength(
			0,
		);
	});

	it("emails and phones are opt-in", async () => {
		const off = new RegexEntityRecognizer();
		expect(await off.recognize("mail a@b.com or call 415-555-0100")).toEqual(
			[],
		);
		const on = new RegexEntityRecognizer({
			email: true,
			phone: true,
			address: false,
		});
		const spans = await on.recognize("mail a@b.com or call 415-555-0100");
		expect(spans.map((s) => s.kind).sort()).toEqual(["email", "phone"]);
	});
});

describe("GazetteerEntityRecognizer", () => {
	it("matches whole words only and preserves source casing", async () => {
		const r = new GazetteerEntityRecognizer([{ kind: "person", value: "Sam" }]);
		const spans = await r.recognize("Sam and SAM met Samuel");
		// "Sam" and "SAM" match; "Samuel" does not (word boundary).
		expect(spans).toHaveLength(2);
		expect(spans.map((s) => s.value)).toEqual(["Sam", "SAM"]);
	});

	it("prefers the longest term on overlap", async () => {
		const r = new GazetteerEntityRecognizer([
			{ kind: "location", value: "San" },
			{ kind: "location", value: "San Francisco" },
		]);
		const spans = await r.recognize("flying into San Francisco today");
		// Both terms technically match "San", but downstream composite resolves
		// the overlap; here we assert the longer term is emitted.
		expect(spans.some((s) => s.value === "San Francisco")).toBe(true);
	});
});

describe("CompositeEntityRecognizer", () => {
	it("merges recognizers, resolves overlaps (longest wins), applies blocklist", async () => {
		const composite = new CompositeEntityRecognizer(
			[
				new GazetteerEntityRecognizer([
					{ kind: "PER", value: "San" },
					{ kind: "LOC", value: "San Francisco" },
					{ kind: "ORG", value: "elizaOS" },
				]),
			],
			{ blocklist: ["elizaOS"] },
		);
		const spans = await composite.recognize("San Francisco loves elizaOS");
		// Longest overlapping span kept, blocklisted org dropped, label canonicalized.
		expect(spans).toHaveLength(1);
		expect(spans[0]?.value).toBe("San Francisco");
		expect(spans[0]?.kind).toBe("location");
	});

	it("keeps offset-less spans (ONNX null-offset case) de-duplicated by value", async () => {
		// A recognizer that returns spans without offsets, like transformers.js #359.
		const noOffset = {
			name: "fake-ner",
			recognize: async () => [
				{ kind: "PER", value: "Dana Whitfield" },
				{ kind: "PER", value: "Dana Whitfield" },
			],
		};
		const composite = new CompositeEntityRecognizer([noOffset]);
		const spans = await composite.recognize("... Dana Whitfield ...");
		expect(spans).toHaveLength(1);
		expect(spans[0]?.kind).toBe("person");
	});
});

describe("canonicalKind", () => {
	it("maps distilbert CoNLL + BIO labels and PII synonyms", () => {
		expect(canonicalKind("B-PER")).toBe("person");
		expect(canonicalKind("I-ORG")).toBe("org");
		expect(canonicalKind("LOC")).toBe("location");
		expect(canonicalKind("first_name")).toBe("person");
		expect(canonicalKind("organization")).toBe("org");
		expect(canonicalKind("street_address")).toBe("address");
		expect(canonicalKind("phone_number")).toBe("phone");
		// Unknown labels pass through lowercased.
		expect(canonicalKind("MISC")).toBe("misc");
	});
});
