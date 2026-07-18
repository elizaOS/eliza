/**
 * Verifies that shell view-switch reports carry the same transport identity as
 * the singleton API client's WebSocket. Fetch is stubbed; no live backend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const elizaGlobalsMock = vi.hoisted(() => ({
  getElizaApiBase: vi.fn(),
  getElizaApiToken: vi.fn(),
}));

vi.mock("../utils/eliza-globals", () => elizaGlobalsMock);

import { client } from "../api";
import { reportUserViewSwitch } from "./useSlashCommandController";

describe("reportUserViewSwitch", () => {
  beforeEach(() => {
    elizaGlobalsMock.getElizaApiBase.mockReturnValue("https://agent.test");
    elizaGlobalsMock.getElizaApiToken.mockReturnValue("agent-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("posts the user navigation body with the authoritative client id", () => {
    reportUserViewSwitch("notes", "/notes");

    expect(fetch).toHaveBeenCalledWith(
      "https://agent.test/api/views/notes/navigate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ElizaOS-Client-Id": client.getClientId(),
          Authorization: "Bearer agent-token",
        },
        body: JSON.stringify({ source: "user", path: "/notes" }),
      },
    );
  });
});
