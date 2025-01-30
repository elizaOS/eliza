import { vi, type MockInstance } from "vitest";
import type { DevinSession } from "../../src/providers/devinRequests";
import type * as devinRequests from "../../src/providers/devinRequests";

type CreateSessionFn = typeof devinRequests.createSession;
type GetSessionDetailsFn = typeof devinRequests.getSessionDetails;
type SendMessageFn = typeof devinRequests.sendMessage;

type DevinMocks = {
    createSession: MockInstance<CreateSessionFn>;
    getSessionDetails: MockInstance<GetSessionDetailsFn>;
    sendMessage: MockInstance<SendMessageFn>;
};

function createMockFunctions(): DevinMocks {
    return {
        createSession: vi.fn<CreateSessionFn>(),
        getSessionDetails: vi.fn<GetSessionDetailsFn>(),
        sendMessage: vi.fn<SendMessageFn>(),
    } as DevinMocks;
}

export const mockSuccessfulSession: DevinSession = {
    session_id: "test-session-id",
    status_enum: "running",
    url: "https://test.url",
    structured_output: { key: "value" },
};

export const mockBlockedSession: DevinSession = {
    session_id: "blocked-session-id",
    status_enum: "blocked",
    url: "https://test.url",
    structured_output: { status: "waiting_for_input" },
};

export const mockStoppedSession: DevinSession = {
    session_id: "stopped-session-id",
    status_enum: "stopped",
    url: "https://test.url",
    structured_output: { result: "completed" },
};

export const mockApiError = new Error("API Error") as Error & { status?: number };
mockApiError.status = 500;

export const mockUnauthorizedError = new Error("Unauthorized") as Error & { status?: number };
mockUnauthorizedError.status = 401;

export function setupDevinApiMocks(): DevinMocks {
    const mocks = createMockFunctions();
    mocks.createSession.mockResolvedValue(mockSuccessfulSession);
    mocks.getSessionDetails.mockResolvedValue(mockSuccessfulSession);
    mocks.sendMessage.mockResolvedValue(undefined);
    return mocks;
}

export function setupFailedDevinApiMocks(): DevinMocks {
    const mocks = createMockFunctions();
    mocks.createSession.mockRejectedValue(mockApiError);
    mocks.getSessionDetails.mockRejectedValue(mockApiError);
    mocks.sendMessage.mockRejectedValue(mockApiError);
    return mocks;
}

export function setupUnauthorizedDevinApiMocks(): DevinMocks {
    const mocks = createMockFunctions();
    mocks.createSession.mockRejectedValue(mockUnauthorizedError);
    mocks.getSessionDetails.mockRejectedValue(mockUnauthorizedError);
    mocks.sendMessage.mockRejectedValue(mockUnauthorizedError);
    return mocks;
}

export function setupNullDevinApiMocks(): DevinMocks {
    const mocks = createMockFunctions();
    mocks.createSession.mockResolvedValue({
        session_id: "",
        url: "",
        status_enum: "stopped",
    });
    mocks.getSessionDetails.mockResolvedValue({
        session_id: "",
        url: "",
        status_enum: "stopped",
    });
    mocks.sendMessage.mockResolvedValue(undefined);
    return mocks;
}
