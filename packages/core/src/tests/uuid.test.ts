import { beforeEach, describe, expect, it } from "vitest";
import { stringToUuid } from "../uuid";
import type { UUID } from "../types";

describe("UUID Module", () => {
    // Helper function to generate test strings
    const generateTestString = (): string =>
        Math.random().toString(36).substring(7);

    // Test data setup
    let testString: string;
    let testNumber: number;

    beforeEach(() => {
        testString = generateTestString();
        testNumber = Math.floor(Math.random() * 1000);
    });

    describe("stringToUuid", () => {
        it("should generate a valid UUID matching the standard format", () => {
            const result = stringToUuid(testString) as UUID;
            expect(result).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            );
        });

        it("should generate consistent UUIDs for identical inputs", () => {
            const input = testString;
            const uuid1 = stringToUuid(input) as UUID;
            const uuid2 = stringToUuid(input) as UUID;
            expect(uuid1).toBe(uuid2);
        });

        it("should generate unique UUIDs for different inputs", () => {
            const input1 = testString;
            const input2 = generateTestString();
            const uuid1 = stringToUuid(input1) as UUID;
            const uuid2 = stringToUuid(input2) as UUID;
            expect(uuid1).not.toBe(uuid2);
        });

        describe("input handling", () => {
            it("should convert number inputs to strings correctly", () => {
                const numberUuid = stringToUuid(testNumber) as UUID;
                const stringUuid = stringToUuid(testNumber.toString()) as UUID;
                expect(numberUuid).toBe(stringUuid);
            });

            it("should throw TypeError for invalid input types", () => {
                expect(() => stringToUuid(undefined as any)).toThrow(TypeError);
                expect(() => stringToUuid(null as any)).toThrow(TypeError);
                expect(() => stringToUuid({} as any)).toThrow(TypeError);
            });

            it("should handle empty string input", () => {
                const result = stringToUuid("") as UUID;
                expect(result).toMatch(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
                );
            });

            it("should handle Unicode characters and emojis consistently", () => {
                const unicodeInput = "Hello 世界! 🌍";
                const result1 = stringToUuid(unicodeInput) as UUID;
                const result2 = stringToUuid(unicodeInput) as UUID;
                expect(result1).toBe(result2);
                expect(result1).toMatch(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
                );
            });
        });

        describe("UUID version and variant bits", () => {
            it("should set correct version bits (version 5)", () => {
                const uuid = stringToUuid(testString) as UUID;
                const versionChar = uuid.split("-")[2][0];
                expect(versionChar).toBe("5");
            });

            it("should set correct variant bits (RFC4122)", () => {
                const uuid = stringToUuid(testString) as UUID;
                const variantByte = parseInt(
                    uuid.split("-")[3].slice(0, 2),
                    16
                );
                expect(variantByte >= 0x80 && variantByte <= 0xbf).toBe(true);
            });
        });

        describe("encoding handling", () => {
            it("should handle URL-unsafe characters", () => {
                const urlUnsafeInput = "test?query=value&param=123";
                const result = stringToUuid(urlUnsafeInput) as UUID;
                expect(result).toMatch(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
                );
            });

            it("should handle very long inputs", () => {
                const longInput = "a".repeat(1000);
                const result = stringToUuid(longInput) as UUID;
                expect(result).toMatch(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
                );
            });
        });
    });
});
