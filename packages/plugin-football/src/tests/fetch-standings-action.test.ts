import { describe, it, expect, vi, beforeEach } from "vitest";
import dotenv from "dotenv";
import { fetchStandingsAction } from "../actions/fetchStandingsAction";
import { IAgentRuntime, Memory, State } from "@elizaos/core";

dotenv.config();
global.fetch = vi.fn();

describe("fetchStandingsAction", () => {
    const mockRuntime: IAgentRuntime = {
        getSetting: vi.fn((key: string) => {
            if (key === "FOOTBALL_API_KEY") return process.env.FOOTBALL_API_KEY;
            if (key === "LEAGUE_ID") return "PL";
            return null;
        }),
    } as unknown as IAgentRuntime;

    it("should validate when API key is provided", async () => {
        const isValid = await fetchStandingsAction.validate(
            mockRuntime,
            {} as Memory,
            {} as State
        );
        expect(isValid).toBe(true);
    });

    it("should not validate when API key is missing", async () => {
        const invalidRuntime = {
            getSetting: vi.fn(() => null),
        } as unknown as IAgentRuntime;

        const isValid = await fetchStandingsAction.validate(
            invalidRuntime,
            {} as Memory,
            {} as State
        );
        expect(isValid).toBe(false);
    });

    it("should fetch standings successfully", async () => {
        global.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                json: () =>
                    Promise.resolve({
                        standings: [
                            {
                                table: [
                                    {
                                        position: 1,
                                        team: { name: "Manchester City" },
                                        points: 45,
                                    },
                                    {
                                        position: 2,
                                        team: { name: "Arsenal" },
                                        points: 42,
                                    },
                                ],
                            },
                        ],
                    }),
            })
        ) as any;

        const result = await fetchStandingsAction.handler(
            mockRuntime,
            {} as Memory,
            {} as State
        );
        expect(result).toEqual({
            standings: [
                {
                    table: [
                        {
                            position: 1,
                            team: { name: "Manchester City" },
                            points: 45,
                        },
                        { position: 2, team: { name: "Arsenal" }, points: 42 },
                    ],
                },
            ],
        });

        expect(global.fetch).toHaveBeenCalledWith(
            "https://api.football-data.org/v4/competitions/PL/standings",
            { headers: { "X-Auth-Token": process.env.FOOTBALL_API_KEY } }
        );
    });

    it("should handle fetch errors gracefully", async () => {
        global.fetch = vi.fn(() =>
            Promise.resolve({
                ok: false,
                statusText: "Internal Server Error",
            })
        ) as any;

        const result = await fetchStandingsAction.handler(
            mockRuntime,
            {} as Memory,
            {} as State
        );
        expect(result).toBe(false);
    });
});
