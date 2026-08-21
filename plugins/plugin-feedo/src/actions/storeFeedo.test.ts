import { describe, it, expect, vi, beforeEach } from "vitest";
import { storeFeedoAction } from "./storeFeedo";
import { type IAgentRuntime, type Memory } from "@elizaos/core";

const mockIndexDocument = vi.fn().mockResolvedValue(true);

vi.mock("feedo-protocol-sdk", () => {
    return {
        FeedoClient: vi.fn().mockImplementation(() => {
            return {
                search: {
                    indexDocument: mockIndexDocument
                }
            };
        })
    };
});

describe("storeFeedoAction", () => {
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
            content: { text: "Remember that my password is 1234" },
            userId: "user-1",
            agentId: "agent-1",
            roomId: "room-1"
        } as Memory;
        mockIndexDocument.mockClear();
    });

    describe("validate", () => {
        it("should return true if FEEDO_USAGE_KEY and FEEDO_AGENT_DID are set", async () => {
            const result = await storeFeedoAction.validate(mockRuntime, mockMessage);
            expect(result).toBe(true);
        });

        it("should return false if FEEDO_USAGE_KEY or FEEDO_AGENT_DID is not set", async () => {
            (mockRuntime.getSetting as any).mockReturnValue(null);
            const result = await storeFeedoAction.validate(mockRuntime, mockMessage);
            expect(result).toBe(false);
        });
    });

    describe("handler", () => {
        it("should call indexDocument and return true on success", async () => {
            const result = await storeFeedoAction.handler(mockRuntime, mockMessage);
            expect(result).toBe(true);
            expect(mockIndexDocument).toHaveBeenCalledWith("Remember that my password is 1234");
        });

        it("should return false if content is missing", async () => {
            mockMessage.content.text = "";
            const result = await storeFeedoAction.handler(mockRuntime, mockMessage);
            expect(result).toBe(false);
            expect(mockIndexDocument).not.toHaveBeenCalled();
        });

        it("should handle exceptions gracefully", async () => {
            mockIndexDocument.mockRejectedValueOnce(new Error("Network Error"));
            const result = await storeFeedoAction.handler(mockRuntime, mockMessage);
            expect(result).toBe(false); // Action fails gracefully
        });
    });
});
