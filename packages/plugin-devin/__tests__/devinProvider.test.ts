import { describe, expect, it, vi, beforeEach } from "vitest";
import { devinProvider } from "../src/providers/devinProvider";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import * as devinRequests from "../src/providers/devinRequests";
import {
    mockSuccessfulSession,
    mockApiError,
    mockUnauthorizedError,
    setupDevinApiMocks,
    setupFailedDevinApiMocks,
    setupNullDevinApiMocks,
} from "./mocks/devinApi";

describe("devinProvider", () => {
    let runtime: IAgentRuntime;
    let message: Memory;

    beforeEach(() => {
        runtime = {
            getSetting: vi.fn(),
            agentId: "00000000-0000-0000-0000-000000000001",
        } as unknown as IAgentRuntime;

        message = {
            userId: "00000000-0000-0000-0000-000000000002",
            content: { text: "test message" },
            roomId: "00000000-0000-0000-0000-000000000003",
            agentId: "00000000-0000-0000-0000-000000000001",
        };

        vi.clearAllMocks();
    });

    it("should handle missing API token", async () => {
        (runtime.getSetting as any).mockReturnValue(undefined);

        const result = await devinProvider.get(runtime, message);

        expect(result).toEqual({
            error: "No Devin API token found",
            lastUpdate: expect.any(Number),
        });
    });

    it("should return session details if sessionId is set", async () => {
        (runtime.getSetting as any).mockReturnValue("test-token");
        const mocks = setupDevinApiMocks();
        Object.entries(mocks).forEach(([key, mock]) => {
            vi.spyOn(devinRequests, key as keyof typeof mocks).mockImplementation(mock);
        });

        const state = {
            devin: {
                sessionId: "test-session-id",
            },
            bio: "",
            lore: "",
            messageDirections: "",
            postDirections: "",
            recentMessages: [],
            recentMessageState: {},
            userStates: {},
            character: {
                name: "test",
                settings: {},
                templates: {},
            },
        } as unknown as State;

        const result = await devinProvider.get(runtime, message, state);

        expect(result).toEqual({
            sessionId: mockSuccessfulSession.session_id,
            status: mockSuccessfulSession.status_enum,
            url: mockSuccessfulSession.url,
            structured_output: mockSuccessfulSession.structured_output,
            lastUpdate: expect.any(Number),
        });
        expect(devinRequests.getSessionDetails).toHaveBeenCalledWith(runtime, "test-session-id");
    });

    it("should handle session details fetch error", async () => {
        (runtime.getSetting as any).mockReturnValue("test-token");
        vi.spyOn(devinRequests, "getSessionDetails").mockRejectedValue(new Error("API Error"));

        const state = {
            devin: {
                sessionId: "test-session-id",
            },
            bio: "",
            lore: "",
            messageDirections: "",
            postDirections: "",
            recentMessages: [],
            recentMessageState: {},
            userStates: {},
            character: {
                name: "test",
                settings: {},
                templates: {},
            },
        } as unknown as State;

        const result = await devinProvider.get(runtime, message, state);

        expect(result).toEqual({
            error: "Failed to fetch session details",
            lastUpdate: expect.any(Number),
            sessionId: "test-session-id",
        });
    });

    it("should return empty state when no session exists", async () => {
        (runtime.getSetting as any).mockReturnValue("test-token");

        const result = await devinProvider.get(runtime, message);

        expect(result).toEqual({
            lastUpdate: expect.any(Number),
        });
    });

    it("should handle unexpected errors", async () => {
        (runtime.getSetting as any).mockImplementation(() => {
            throw new Error("Unexpected error");
        });

        const result = await devinProvider.get(runtime, message);

        expect(result).toEqual({
            error: "Internal provider error",
            lastUpdate: expect.any(Number),
        });
    });
});
