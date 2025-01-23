import { describe, expect, it, vi } from "vitest";
import { startSessionAction } from "../src/actions/startSession";
import type { IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import * as devinRequests from "../src/providers/devinRequests";
import {
    mockSuccessfulSession,
    mockApiError,
    setupDevinApiMocks,
    setupFailedDevinApiMocks,
} from "./mocks/devinApi";

describe("startSessionAction", () => {
    let runtime: IAgentRuntime;
    let message: Memory;
    let callback: HandlerCallback;

    beforeEach(() => {
        runtime = {
            getSetting: vi.fn(),
            agentId: "00000000-0000-0000-0000-000000000001",
        } as unknown as IAgentRuntime;

        message = {
            userId: "00000000-0000-0000-0000-000000000002",
            content: { text: "Help me with my code" },
            roomId: "00000000-0000-0000-0000-000000000003",
            agentId: "00000000-0000-0000-0000-000000000001",
        };

        callback = vi.fn();
        vi.clearAllMocks();
    });

    describe("Action Structure", () => {
        it("should have required action properties", () => {
            expect(startSessionAction).toHaveProperty("name");
            expect(startSessionAction).toHaveProperty("description");
            expect(startSessionAction).toHaveProperty("examples");
            expect(startSessionAction).toHaveProperty("similes");
            expect(startSessionAction).toHaveProperty("handler");
            expect(startSessionAction).toHaveProperty("validate");
            expect(Array.isArray(startSessionAction.examples)).toBe(true);
            expect(Array.isArray(startSessionAction.similes)).toBe(true);
        });

        it("should have valid example structure", () => {
            startSessionAction.examples.forEach((example) => {
                example.forEach((message) => {
                    expect(message).toHaveProperty("user");
                    expect(message).toHaveProperty("content");
                    expect(message.content).toHaveProperty("text");
                });
            });
        });

        it("should have unique action name", () => {
            expect(startSessionAction.name).toBe("START_DEVIN_SESSION");
        });
    });

    describe("Handler Behavior", () => {
        it("should create a session with valid prompt", async () => {
            (runtime.getSetting as any).mockReturnValue("test-token");
            const mocks = setupDevinApiMocks();
            Object.entries(mocks).forEach(([key, mock]) => {
                vi.spyOn(devinRequests, key as keyof typeof mocks).mockImplementation(mock);
            });

            await startSessionAction.handler(runtime, message, {} as State, {}, callback);

            expect(callback).toHaveBeenCalledWith(
                {
                    text: expect.stringContaining(mockSuccessfulSession.session_id),
                    action: "START_SESSION",
                },
                []
            );
            expect(devinRequests.createSession).toHaveBeenCalledWith(runtime, message.content.text);
        });

        it("should handle missing prompt gracefully", async () => {
            message.content.text = "";
            await startSessionAction.handler(runtime, message, {} as State, {}, callback);

            expect(callback).toHaveBeenCalledWith(
                {
                    text: "No prompt provided for session creation",
                },
                []
            );
        });

        it("should handle API errors", async () => {
            (runtime.getSetting as any).mockReturnValue("test-token");
            vi.spyOn(devinRequests, "createSession").mockRejectedValue(new Error("API Error"));

            await startSessionAction.handler(runtime, message, {} as State, {}, callback);

            expect(callback).toHaveBeenCalledWith(
                {
                    text: "Failed to create Devin session: API Error",
                    error: "API Error",
                },
                []
            );
        });

        it("should validate API token presence", async () => {
            const isValid = await startSessionAction.validate(runtime, message);
            expect(isValid).toBe(false);

            (runtime.getSetting as any).mockReturnValue("test-token");
            const isValidWithToken = await startSessionAction.validate(runtime, message);
            expect(isValidWithToken).toBe(true);
        });
    });
});
