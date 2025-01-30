import type { Client, IAgentRuntime } from "@elizaos/core";
import { describe, it, expect } from "@jest/globals";

// Helper function to identify client types
function determineClientType(client: Client): string {
    // Check if client has a direct type identifier
    if ("type" in client && typeof client.type === "string") {
        return client.type;
    }

    // Check constructor name
    const constructorName = client.constructor?.name;
    if (constructorName && !constructorName.includes("Object")) {
        return constructorName.toLowerCase().replace("client", "");
    }

    // Fallback: Generate a unique identifier
    return `client_${Date.now()}`;
}

// Mock client implementations for testing
class MockNamedClient implements Client {
    type = "named-client";
    async start(_runtime?: IAgentRuntime) {
        return this;
    }
    async stop(_runtime?: IAgentRuntime) {}
}

class MockConstructorClient implements Client {
    async start(_runtime?: IAgentRuntime) {
        return this;
    }
    async stop(_runtime?: IAgentRuntime) {}
}

const mockPlainClient: Client = {
    async start(_runtime?: IAgentRuntime) {
        return {};
    },
    async stop(_runtime?: IAgentRuntime) {},
};

describe("Client Type Identification", () => {
    it("should identify client type from type property", () => {
        const client = new MockNamedClient();
        expect(determineClientType(client)).toBe("named-client");
    });

    it("should identify client type from constructor name", () => {
        const client = new MockConstructorClient();
        expect(determineClientType(client)).toBe("mockconstructor");
    });

    it("should generate fallback identifier for plain objects", () => {
        const result = determineClientType(mockPlainClient);
        expect(result).toMatch(/^client_\d+$/);
    });
});
