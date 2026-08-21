import { describe, it, expect, vi, beforeEach } from "vitest";
import { feedoProvider } from "./feedoProvider";
import { type IAgentRuntime, type Memory } from "@elizaos/core";

// Mock the feedo-protocol-sdk
vi.mock("feedo-protocol-sdk", () => {
    return {
        FeedoClient: vi.fn().mockImplementation(() => {
            return {
                search: {
                    search: vi.fn().mockResolvedValue({
                        documents: [
                            { text: "Mocked context result 1", score: 0.95 },
                            { text: "Mocked context result 2", score: 0.85 }
                        ]
                    })
                }
            };
        })
    };
});

describe("feedoProvider", () => {
    let mockRuntime: IAgentRuntime;
    let mockMessage: Memory;

    beforeEach(() => {
        mockRuntime = {
            getSetting: vi.fn((key: string) => {
                if (key === "FEEDO_USAGE_KEY") return "0x123456789";
                if (key === "FEEDO_AGENT_DID") return "did:feedo:0xabcdef";
                return null;
            })
        } as unknown as IAgentRuntime;

        mockMessage = {
            id: "msg-123",
            userId: "user-123",
            agentId: "agent-123",
            roomId: "room-123",
            content: { text: "What is my favorite color?" }
        } as Memory;
    });

    it("should return null if FEEDO_USAGE_KEY or FEEDO_AGENT_DID is not set", async () => {
        (mockRuntime.getSetting as any).mockReturnValue(null);
        const result = await feedoProvider.get(mockRuntime, mockMessage);
        expect(result).toEqual({ text: "" });
    });

    it("should return null if query is empty or too short", async () => {
        mockMessage.content.text = "hi";
        const result = await feedoProvider.get(mockRuntime, mockMessage);
        expect(result).toEqual({ text: "" });
    });

    it("should call client.search.search and return formatted results", async () => {
        const result = await feedoProvider.get(mockRuntime, mockMessage);
        expect(result).not.toBeNull();
        expect(result?.text).toContain("Mocked context result 1");
        expect(result?.text).toContain("Mocked context result 2");
        expect(result?.data).toHaveLength(2);
    });
});
