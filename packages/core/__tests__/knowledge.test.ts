import { beforeEach, describe, expect, it, vi } from "vitest";
import knowledge from "../src/knowledge";
import type { AgentRuntime } from "../src/runtime";
import type { Memory } from "../src/types";

vi.mock("../generation", () => ({
    splitChunks: vi.fn().mockImplementation(async (text) => [text]),
}));

vi.mock("../uuid", () => ({
    stringToUuid: vi.fn().mockImplementation((str) => str),
}));

describe("Knowledge Module", () => {
    describe("preprocess", () => {
        it("should handle invalid inputs", () => {
            expect(knowledge.preprocess(null)).toBe("");
            expect(knowledge.preprocess(undefined)).toBe("");
            expect(knowledge.preprocess("")).toBe("");
        });

        it("should remove code blocks and inline code", () => {
            const input =
                "Here is some code: ```const x = 1;``` and `inline code`";
            expect(knowledge.preprocess(input)).toBe("here is some code: and");
        });

        it("should handle markdown formatting", () => {
            const input =
                "# Header\n## Subheader\n[Link](http://example.com)\n![Image](image.jpg)";
            expect(knowledge.preprocess(input)).toBe(
                "header subheader link image"
            );
        });

        it("should simplify URLs", () => {
            const input = "Visit https://www.example.com/path?param=value";
            expect(knowledge.preprocess(input)).toBe(
                "visit example.com/path?param=value"
            );
        });

        it("should remove Discord mentions and HTML tags", () => {
            const input = "Hello <@123456789> and <div>HTML content</div>";
            expect(knowledge.preprocess(input)).toBe("hello and html content");
        });

        it("should normalize whitespace and newlines", () => {
            const input = "Multiple    spaces\n\n\nand\nnewlines";
            expect(knowledge.preprocess(input)).toBe(
                "multiple spaces and newlines"
            );
        });

        it("should remove comments", () => {
            const input = "/* Block comment */ Normal text // Line comment";
            expect(knowledge.preprocess(input)).toBe("normal text");
        });
    });

    describe("get and set", () => {
        let mockRuntime: AgentRuntime;

        beforeEach(() => {
            mockRuntime = {
                agentId: "test-agent",
                messageManager: {
                    getCachedEmbeddings: vi.fn().mockResolvedValue([]),
                },
                knowledgeManager: {
                    searchMemories: vi.fn().mockResolvedValue([
                        {
                            content: {
                                text: "test fragment",
                                source: "source1",
                            },
                            similarity: 0.9,
                        },
                    ]),
                    createMemory: vi.fn().mockResolvedValue(undefined),
                },
                documentsManager: {
                    getMemoryById: vi.fn().mockResolvedValue({
                        id: "source1",
                        content: { text: "test document" },
                    }),
                    createMemory: vi.fn().mockResolvedValue(undefined),
                },
            } as unknown as AgentRuntime;
        });

        describe("get", () => {
            it("should handle invalid messages", async () => {
                const invalidMessage = {} as Memory;
                const result = await knowledge.get(mockRuntime, invalidMessage);
                expect(result).toEqual([]);
            });

            it("should handle empty processed text", async () => {
                const message: Memory = {
                    agentId: "test-agent",
                    content: { text: "```code only```" },
                } as unknown as Memory;

                const result = await knowledge.get(mockRuntime, message);
                expect(result).toEqual([]);
            });
        });
        });
    });

