import { describe, expect, it } from "vitest";
import { BM25, Tokenizer } from "../src/retrieval.ts";

describe("Tokenizer cleanText contractions", () => {
	it("keeps in-word apostrophes as the docstring promises", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.cleanText("I'm don't")).toBe("i'm don't");
		expect(tokenizer.cleanText("it's a test")).toBe("it's a test");
	});

	it("tokenizes a contraction as one token", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.tokenize("I don't know").tokens).toEqual([
			"don't",
			"know",
		]);
		expect(tokenizer.tokenize("it's a test").tokens).toEqual(["it's", "test"]);
	});

	it("normalizes curly apostrophes and drops stray ones", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.cleanText("don’t can’t")).toBe("don't can't");
		expect(tokenizer.cleanText("'quoted' word")).toBe("quoted word");
		expect(tokenizer.cleanText("the dogs' toys")).toBe("the dogs toys");
	});

	it("still splits on other punctuation", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.cleanText("Hello, World!")).toBe("hello world");
		expect(tokenizer.cleanText("test©2023")).toBe("test2023");
	});

	it("lets BM25 match a contraction query to a contraction document", () => {
		const bm25 = new BM25([
			{ title: "a", content: "I don't know the answer" },
			{ title: "b", content: "donkeys are here" },
		]);
		const results = bm25.search("don't");
		expect(results[0]?.index).toBe(0);
		expect(results[0]?.score).toBeGreaterThan(0);
	});
});
