import { describe, it, expect, vi, beforeEach } from "vitest";
import dotenv from "dotenv";
import { fetchMatchAction } from "../actions/fetchMatchAction";
import { IAgentRuntime, Memory, State } from "@elizaos/core";

dotenv.config();

global.fetch = vi.fn();

const mockRuntime = {
    getSetting: vi.fn((key: string) => {
        if (key === "FOOTBALL_API_KEY") return process.env.FOOTBALL_API_KEY;
        return null;
    }),
    character: {
        name: "test-character",
    },
};

describe("fetchMatchAction", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("handler", () => {
        it("should fetch match data successfully", async () => {
            const mockResponse = {
                matches: [
                    {
                        homeTeam: { name: "Chelsea" },
                        awayTeam: { name: "Arsenal" },
                        score: {
                            fullTime: { homeTeam: 1, awayTeam: 2 },
                        },
                    },
                ],
            };

            (global.fetch as any).mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockResponse),
            });

            const result = await fetchMatchAction.handler(
                mockRuntime as unknown as IAgentRuntime,
                {} as Memory,
                {} as State
            );

            expect(result).toEqual(mockResponse);
            expect(global.fetch).toHaveBeenCalledWith(
                "https://api.football-data.org/v4/matches",
                {
                    headers: {
                        "X-Auth-Token": process.env.FOOTBALL_API_KEY,
                    },
                }
            );
        });

        it("should handle errors when fetching match data", async () => {
            (global.fetch as any).mockResolvedValueOnce({
                ok: false,
                statusText: "Internal Server Error",
            });

            const result = await fetchMatchAction.handler(
                mockRuntime as unknown as IAgentRuntime,
                {} as Memory,
                {} as State
            );

            expect(result).toBe(false);
        });
    });

    describe("validate", () => {
        it("should validate when API key is available", async () => {
            const mockMessage: Memory = {
                id: "123e4567-e89b-12d3-a456-426614174000",
                content: { text: "test message" },
                userId: "123e4567-e89b-12d3-a456-426614174000",
                agentId: "123e4567-e89b-12d3-a456-426614174000",
                roomId: "123e4567-e89b-12d3-a456-426614174000",
            };

            const isValid = await fetchMatchAction.validate(
                mockRuntime as unknown as IAgentRuntime,
                mockMessage
            );

            expect(isValid).toBe(true);
        });

        it("should not validate when API key is missing", async () => {
            const invalidRuntime = {
                getSetting: vi.fn(() => null),
                character: {
                    name: "test-character",
                },
            };

            const mockMessage: Memory = {
                id: "123e4567-e89b-12d3-a456-426614174000",
                content: { text: "test message" },
                userId: "123e4567-e89b-12d3-a456-426614174000",
                agentId: "123e4567-e89b-12d3-a456-426614174000",
                roomId: "123e4567-e89b-12d3-a456-426614174000",
            };

            const isValid = await fetchMatchAction.validate(
                invalidRuntime as unknown as IAgentRuntime,
                mockMessage
            );

            expect(isValid).toBe(false);
        });
    });
});
