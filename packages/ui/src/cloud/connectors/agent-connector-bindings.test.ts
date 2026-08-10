/** Verifies the typed agent connector binding client emits the public CRUD routes. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("../lib/api-client", () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

import {
  createAgentConnectorBinding,
  listAgentConnectorBindings,
  revokeAgentConnectorBinding,
} from "./agent-connector-bindings";

beforeEach(() => apiMock.mockReset());

describe("agent connector bindings client", () => {
  it("lists, grants, and revokes through agent-scoped public routes", async () => {
    apiMock.mockResolvedValue([]);
    await listAgentConnectorBindings("agent/id");
    await createAgentConnectorBinding("agent/id", {
      platformCredentialId: "credential-1",
      provider: "google",
      role: "OWNER",
      selectedProducts: ["gmail"],
    });
    await revokeAgentConnectorBinding("agent/id", "binding/id");

    expect(apiMock.mock.calls).toEqual([
      ["/api/v1/eliza/agents/agent%2Fid/connectors", { signal: undefined }],
      [
        "/api/v1/eliza/agents/agent%2Fid/connectors",
        {
          method: "POST",
          json: {
            platformCredentialId: "credential-1",
            provider: "google",
            role: "OWNER",
            selectedProducts: ["gmail"],
          },
        },
      ],
      [
        "/api/v1/eliza/agents/agent%2Fid/connectors/binding%2Fid",
        { method: "DELETE" },
      ],
    ]);
  });
});
