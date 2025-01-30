import { describe, it, expect } from "vitest";
import {
    parseShouldRespondFromText,
    parseBooleanFromText,
    parseJsonArrayFromText,
    parseJSONObjectFromText,
} from "../src/parsing";

describe("Parsing Module", () => {
    describe("parseShouldRespondFromText", () => {
        it("should parse exact matches", () => {
            expect(parseShouldRespondFromText("[RESPOND]")).toBe("RESPOND");
            expect(parseShouldRespondFromText("[IGNORE]")).toBe("IGNORE");
            expect(parseShouldRespondFromText("[STOP]")).toBe("STOP");
        });

        it("should handle case insensitive input", () => {
            expect(parseShouldRespondFromText("[respond]")).toBe("RESPOND");
            expect(parseShouldRespondFromText("[ignore]")).toBe("IGNORE");
            expect(parseShouldRespondFromText("[stop]")).toBe("STOP");
        });

        it("should handle text containing keywords", () => {
            expect(
                parseShouldRespondFromText("I think we should RESPOND here")
            ).toBe("RESPOND");
            expect(
                parseShouldRespondFromText("Better to IGNORE this one")
            ).toBe("IGNORE");
            expect(parseShouldRespondFromText("We need to STOP now")).toBe(
                "STOP"
            );
        });

        it("should return null for invalid input", () => {
            expect(parseShouldRespondFromText("")).toBe(null);
            expect(parseShouldRespondFromText("invalid")).toBe(null);
            expect(parseShouldRespondFromText("[INVALID]")).toBe(null);
        });
    });

    describe("parseBooleanFromText", () => {
        it("should parse exact YES/NO matches", () => {
            expect(parseBooleanFromText("YES")).toBe(true);
            expect(parseBooleanFromText("NO")).toBe(false);
        });

        it("should handle case insensitive input", () => {
            expect(parseBooleanFromText("yes")).toBe(true);
            expect(parseBooleanFromText("no")).toBe(false);
        });

        it("should return null for invalid input", () => {
            expect(parseBooleanFromText("")).toBe(null);
            expect(parseBooleanFromText("maybe")).toBe(null);
            expect(parseBooleanFromText("YES NO")).toBe(null);
        });
    });

    describe("parseJsonArrayFromText", () => {
        it("should parse JSON array from code block", () => {
            const input = '```json\n["item1", "item2", "item3"]\n```';
            expect(parseJsonArrayFromText(input)).toEqual([
                "item1",
                "item2",
                "item3",
            ]);
        });

        it("should handle single quote", () => {
            let input = "```json\n['item1', 'item2', 'item3']\n```";
            expect(parseJsonArrayFromText(input)).toEqual([
                "item1",
                "item2",
                "item3",
            ]);
            input = '```json\n["A\'s item", "B\'s item", "C\'s item"]\n```';
            expect(parseJsonArrayFromText(input)).toEqual([
                "A's item",
                "B's item",
                "C's item",
            ]);
            input = '["A\'s item", "B\'s item", "C\'s item"]';
            expect(parseJsonArrayFromText(input)).toEqual([
                "A's item",
                "B's item",
                "C's item",
            ]);
            input = `[
                'MANAGE_POSITIONS_RETRIGGER_EVALUATOR'
              ]`;
            expect(parseJsonArrayFromText(input)).toEqual([
                "MANAGE_POSITIONS_RETRIGGER_EVALUATOR",
            ]);
        });

        it("should handle empty arrays", () => {
            expect(parseJsonArrayFromText("```json\n[]\n```")).toEqual([]);
            expect(parseJsonArrayFromText("[]")).toEqual(null);
        });

        it("should return null for invalid JSON", () => {
            expect(parseJsonArrayFromText("invalid")).toBe(null);
            expect(parseJsonArrayFromText("[invalid]")).toBe(null);
            expect(parseJsonArrayFromText("```json\n[invalid]\n```")).toBe(
                null
            );
        });
    });

    describe("parseJSONObjectFromText", () => {
        it("should parse JSON object from code block", () => {
            const input = '```json\n{"key": "value", "number": 42}\n```';
            expect(parseJSONObjectFromText(input)).toEqual({
                key: "value",
                number: 42,
            });
        });

        it("should parse JSON object without code block", () => {
            const input = '{"key": "value", "number": 42}';
            expect(parseJSONObjectFromText(input)).toEqual({
                key: "value",
                number: 42,
            });
        });

        it("should handle empty objects", () => {
            expect(parseJSONObjectFromText("```json\n{}\n```")).toEqual({});
            expect(parseJSONObjectFromText("{}")).toEqual({});
        });

        it("should return null for invalid JSON", () => {
            expect(parseJSONObjectFromText("invalid")).toBe(null);
            expect(parseJSONObjectFromText("{invalid}")).toBe(null);
            expect(parseJSONObjectFromText("```json\n{invalid}\n```")).toBe(
                null
            );
        });
    });
});
