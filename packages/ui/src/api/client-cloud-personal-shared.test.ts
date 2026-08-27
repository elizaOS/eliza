/**
 * Verifies that account-native Shared identity resolution uses the read-only
 * personal endpoint and returns the standard per-agent chat base.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { ElizaClient } from "./client-base";
import "./client-cloud";
import {
  loadAgentProfileRegistry,
  upsertAndActivateAgentProfile,
} from "../state/agent-profiles";
import {
  createPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../state/persistence";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getPersonalSharedEliza", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resolves the rowless identity without creating an agent", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(200, {
          success: true,
          data: {
            identity: {
              id: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
              displayName: "Eliza",
              runtime: "shared",
            },
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const result = await new ElizaClient().getPersonalSharedEliza({
      cloudApiBase: "https://api.eliza.app",
      authToken: "steward-token",
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.eliza.app/api/v1/eliza/personal",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: "Bearer steward-token",
      },
      signal: controller.signal,
    });
    expect(result).toEqual({
      personalElizaId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      agentId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      activeAgentId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      agentName: "Eliza",
      apiBase:
        "https://api.eliza.app/api/v1/eliza/agents/personal%3A3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      runtime: "shared",
    });
  });

  it("reconnects a returning account to its activated Dedicated target", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          success: true,
          data: {
            identity: {
              id: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
              displayName: "Eliza",
              runtime: "dedicated",
              activeAgentId: "00000000-0000-4000-8000-000000000020",
              apiBase:
                "https://00000000-0000-4000-8000-000000000020.cloud.eliza.app",
            },
          },
        }),
      ),
    );

    await expect(
      new ElizaClient().getPersonalSharedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).resolves.toEqual({
      personalElizaId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      agentId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      activeAgentId: "00000000-0000-4000-8000-000000000020",
      agentName: "Eliza",
      apiBase: "https://00000000-0000-4000-8000-000000000020.cloud.eliza.app",
      runtime: "dedicated",
    });
  });

  it("rejects a response that does not identify the personal Shared runtime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          success: true,
          data: {
            identity: {
              id: "sandbox-row-id",
              displayName: "Eliza",
              runtime: "shared",
            },
          },
        }),
      ),
    );

    await expect(
      new ElizaClient().getPersonalSharedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).rejects.toThrow("invalid personal Eliza identity");
  });

  it("keeps the browser deadline active through a stalled Personal response body", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const response = jsonResponse(200, {});
    vi.spyOn(response, "text").mockImplementation(
      async () => await new Promise<string>(() => undefined),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return response;
      }),
    );

    const request = new ElizaClient().getPersonalSharedEliza({
      cloudApiBase: "https://api.eliza.app",
      authToken: "steward-token",
    });
    const rejection = expect(request).rejects.toThrow(
      "Eliza Cloud request timed out after 30s",
    );
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("propagates caller abort while the Personal response body is pending", async () => {
    const response = jsonResponse(200, {});
    vi.spyOn(response, "text").mockImplementation(
      async () => await new Promise<string>(() => undefined),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const controller = new AbortController();

    const request = new ElizaClient().getPersonalSharedEliza({
      cloudApiBase: "https://api.eliza.app",
      authToken: "steward-token",
      signal: controller.signal,
    });
    controller.abort(new DOMException("superseded", "AbortError"));

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails closed on malformed Personal JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("not-json", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(
      new ElizaClient().getPersonalSharedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).rejects.toThrow("invalid personal Eliza identity");
  });
});

describe("ensurePersonalDedicatedEliza", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("activates one Dedicated target and completes the personal cutover", async () => {
    const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    const dedicatedBase = `https://${dedicatedAgentId}.cloud.eliza.app`;
    let cutoverAttempts = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://api.eliza.app/api/v1/eliza/personal") {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              quoteId: "a".repeat(64),
              canActivate: true,
              activation: { state: "available" },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
          expect(JSON.parse(String(init.body))).toEqual({
            action: "activate_dedicated",
            quoteId: "a".repeat(64),
          });
          return jsonResponse(202, {
            success: true,
            data: { dedicatedAgentId },
          });
        }
        if (url.endsWith("/upgrade-tier/cutover")) {
          cutoverAttempts += 1;
          if (cutoverAttempts <= 3) {
            return jsonResponse([409, 423, 503][cutoverAttempts - 1] ?? 409, {
              success: false,
              error: "Dedicated is still provisioning",
            });
          }
          return jsonResponse(200, {
            success: true,
            data: {
              personalElizaId,
              activeAgentId: dedicatedAgentId,
              runtime: "dedicated",
              apiBase: dedicatedBase,
              importedMessages: 7,
            },
          });
        }
        return jsonResponse(500, { error: `Unexpected URL ${url}` });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const onProgress = vi.fn();

    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
        pollIntervalMs: 0,
        timeoutMs: 1_000,
        onProgress,
      }),
    ).resolves.toEqual({
      personalElizaId,
      agentId: personalElizaId,
      activeAgentId: dedicatedAgentId,
      agentName: "Eliza",
      apiBase: dedicatedBase,
      runtime: "dedicated",
    });
    expect(cutoverAttempts).toBe(4);
    expect(onProgress).toHaveBeenCalledWith(
      "provisioning",
      "Starting your Dedicated agent…",
    );
    expect(onProgress).toHaveBeenLastCalledWith(
      "ready",
      "Connected to your Dedicated agent",
    );
  });

  it.each(["pending", "provisioning", "running"])(
    "reattaches to an in-progress %s target without replaying activation",
    async (targetStatus) => {
      const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
      const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
      const dedicatedBase = `https://${dedicatedAgentId}.cloud.eliza.app`;
      let cutoverAttempts = 0;
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/api/v1/eliza/personal")) {
            return jsonResponse(200, {
              success: true,
              data: {
                identity: {
                  id: personalElizaId,
                  displayName: "Eliza",
                  runtime: "shared",
                },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
            return jsonResponse(200, {
              success: true,
              data: {
                quoteId: "d".repeat(64),
                canActivate: true,
                activation: {
                  state: "in_progress",
                  dedicatedAgentId,
                  status: targetStatus,
                },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
            throw new Error("activation POST must not replay");
          }
          if (url.endsWith("/upgrade-tier/cutover")) {
            cutoverAttempts += 1;
            if (cutoverAttempts <= 3) {
              return jsonResponse([409, 423, 503][cutoverAttempts - 1] ?? 409, {
                success: false,
                error: "Dedicated is still provisioning",
              });
            }
            return jsonResponse(200, {
              success: true,
              data: {
                personalElizaId,
                activeAgentId: dedicatedAgentId,
                runtime: "dedicated",
                apiBase: dedicatedBase,
                importedMessages: 0,
              },
            });
          }
          return jsonResponse(500, { error: "unexpected route" });
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        new ElizaClient().ensurePersonalDedicatedEliza({
          cloudApiBase: "https://api.eliza.app",
          authToken: "steward-token",
          pollIntervalMs: 0,
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({
        activeAgentId: dedicatedAgentId,
        runtime: "dedicated",
      });
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) =>
            String(url).endsWith("/upgrade-tier") && init?.method === "POST",
        ),
      ).toHaveLength(0);
      expect(cutoverAttempts).toBe(4);
    },
  );

  it.each(["error", "stopped", "sleeping"])(
    "confirms and resumes an in-progress %s target under the fresh quote",
    async (targetStatus) => {
      const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
      const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
      let activationPosts = 0;
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/api/v1/eliza/personal")) {
            return jsonResponse(200, {
              success: true,
              data: {
                identity: {
                  id: personalElizaId,
                  displayName: "Eliza",
                  runtime: "shared",
                },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
            return jsonResponse(200, {
              success: true,
              data: {
                quoteId: "e".repeat(64),
                canActivate: true,
                activation: {
                  state: "in_progress",
                  dedicatedAgentId,
                  status: targetStatus,
                },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
            activationPosts += 1;
            return jsonResponse(202, {
              success: true,
              data: { dedicatedAgentId },
            });
          }
          if (url.endsWith("/upgrade-tier/cutover")) {
            return jsonResponse(200, {
              success: true,
              data: {
                personalElizaId,
                activeAgentId: dedicatedAgentId,
                runtime: "dedicated",
                apiBase: `https://${dedicatedAgentId}.cloud.eliza.app`,
                importedMessages: 0,
              },
            });
          }
          return jsonResponse(500, { error: "unexpected route" });
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        new ElizaClient().ensurePersonalDedicatedEliza({
          cloudApiBase: "https://api.eliza.app",
          authToken: "steward-token",
          pollIntervalMs: 0,
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({
        activeAgentId: dedicatedAgentId,
        runtime: "dedicated",
      });
      expect(activationPosts).toBe(1);
    },
  );

  it("reconciles a stalled first activation body without replaying its POST", async () => {
    vi.useFakeTimers();
    const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    let activationPosts = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              quoteId: "f".repeat(64),
              canActivate: true,
              activation:
                activationPosts === 0
                  ? { state: "available" }
                  : {
                      state: "in_progress",
                      dedicatedAgentId,
                      status: "provisioning",
                    },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
          expect(JSON.parse(String(init.body))).toEqual({
            action: "activate_dedicated",
            quoteId: "f".repeat(64),
          });
          activationPosts += 1;
          const committed = jsonResponse(202, {
            success: true,
            data: { dedicatedAgentId },
          });
          vi.spyOn(committed, "text").mockImplementation(
            async () => await new Promise<string>(() => undefined),
          );
          return committed;
        }
        if (url.endsWith("/upgrade-tier/cutover")) {
          return jsonResponse(200, {
            success: true,
            data: {
              personalElizaId,
              activeAgentId: dedicatedAgentId,
              runtime: "dedicated",
              apiBase: `https://${dedicatedAgentId}.cloud.eliza.app`,
              importedMessages: 0,
            },
          });
        }
        return jsonResponse(500, { error: "unexpected route" });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ElizaClient();

    const ambiguous = client.ensurePersonalDedicatedEliza({
      cloudApiBase: "https://api.eliza.app",
      authToken: "steward-token",
      pollIntervalMs: 0,
      timeoutMs: 1_000,
    });
    const rejection = expect(ambiguous).rejects.toThrow(
      "Eliza Cloud request timed out after 30s",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(activationPosts).toBe(1);

    await expect(
      client.ensurePersonalDedicatedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
        pollIntervalMs: 0,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      activeAgentId: dedicatedAgentId,
      runtime: "dedicated",
    });
    expect(activationPosts).toBe(1);
    expect(
      fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith("/upgrade-tier"))
        .map(([, init]) => init?.method),
    ).toEqual(["GET", "POST", "GET"]);
  });

  it("keeps the default cutover window open until exactly 360000ms", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    let cutoverPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              quoteId: "3".repeat(64),
              canActivate: true,
              activation: {
                state: "in_progress",
                dedicatedAgentId,
                status: "provisioning",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
          throw new Error("activation POST must not replay");
        }
        if (url.endsWith("/upgrade-tier/cutover")) {
          cutoverPosts += 1;
          return jsonResponse(409, {
            success: false,
            error: "Dedicated is still provisioning",
          });
        }
        return jsonResponse(500, { error: "unexpected route" });
      }),
    );

    let outcome: Error | "resolved" | undefined;
    const attempt = new ElizaClient()
      .ensurePersonalDedicatedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
        pollIntervalMs: 359_999,
      })
      .then(() => {
        outcome = "resolved";
      })
      .catch((error: unknown) => {
        outcome = error instanceof Error ? error : new Error(String(error));
      });

    await vi.advanceTimersByTimeAsync(359_999);
    expect(outcome).toBeUndefined();
    expect(cutoverPosts).toBe(2);

    await vi.advanceTimersByTimeAsync(1);
    await attempt;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(
      "did not become ready before the signed-in startup deadline",
    );
    expect(cutoverPosts).toBe(3);
  });

  it("fails closed on an unknown retained-target status", async () => {
    let activationPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              quoteId: "1".repeat(64),
              canActivate: true,
              activation: {
                state: "in_progress",
                dedicatedAgentId: "00000000-0000-4000-8000-000000000020",
                status: "unknown-future-state",
              },
            },
          });
        }
        if (init?.method === "POST") activationPosts += 1;
        return jsonResponse(500, { error: "unexpected route" });
      }),
    );

    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).rejects.toThrow("invalid in-progress Dedicated status");
    expect(activationPosts).toBe(0);
  });

  it("rejects a resume receipt for a target other than the quoted row", async () => {
    const quotedTargetId = "00000000-0000-4000-8000-000000000020";
    const otherTargetId = "00000000-0000-4000-8000-000000000021";
    let cutoverPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              quoteId: "2".repeat(64),
              canActivate: true,
              activation: {
                state: "in_progress",
                dedicatedAgentId: quotedTargetId,
                status: "stopped",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
          return jsonResponse(202, {
            success: true,
            data: { dedicatedAgentId: otherTargetId },
          });
        }
        if (url.endsWith("/upgrade-tier/cutover")) cutoverPosts += 1;
        return jsonResponse(500, { error: "unexpected route" });
      }),
    );

    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).rejects.toThrow("different Dedicated target than the quoted activation");
    expect(cutoverPosts).toBe(0);
  });

  it("fails closed instead of returning Shared when hosting credit is insufficient", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.eliza.app/api/v1/eliza/personal") {
        return jsonResponse(200, {
          success: true,
          data: {
            identity: {
              id: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
              displayName: "Eliza",
              runtime: "shared",
            },
          },
        });
      }
      return jsonResponse(200, {
        success: true,
        data: {
          quoteId: "b".repeat(64),
          canActivate: false,
          activation: { state: "available" },
          unavailableReason: "Add hosting credits to continue.",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).rejects.toMatchObject({
      message: "Add hosting credits to continue.",
      status: 402,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("personal Eliza runtime repoint", () => {
  const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
  const sharedBase =
    "https://api.eliza.app/api/v1/eliza/agents/personal%3A3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
  const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
  const dedicatedBase = `https://${dedicatedAgentId}.cloud.eliza.app`;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    const server = createPersistedActiveServer({
      kind: "cloud",
      id: `cloud:${personalElizaId}`,
      label: "Eliza",
      apiBase: sharedBase,
      accessToken: "steward-token",
      cloudRuntimeAgentId: personalElizaId,
      cloudRuntime: "shared",
    });
    savePersistedActiveServer(server);
    upsertAndActivateAgentProfile({
      kind: "cloud",
      label: "Eliza",
      cloudAgentId: personalElizaId,
      cloudRuntimeAgentId: personalElizaId,
      cloudRuntime: "shared",
      apiBase: sharedBase,
      accessToken: "steward-token",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("repoints an open Shared client and retries the rejected turn once", async () => {
    const requestBodies: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `${sharedBase}/api/chat`) {
          requestBodies.push(String(init?.body));
          return jsonResponse(409, {
            success: false,
            code: "personal_eliza_dedicated",
            error: "This personal Eliza is active on Dedicated.",
          });
        }
        if (url === "https://api.eliza.app/api/v1/eliza/personal") {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "dedicated",
                activeAgentId: dedicatedAgentId,
                apiBase: dedicatedBase,
              },
            },
          });
        }
        if (url === `${dedicatedBase}/api/chat`) {
          requestBodies.push(String(init?.body));
          return jsonResponse(200, { delivered: true });
        }
        return jsonResponse(500, { error: `Unexpected URL ${url}` });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ElizaClient(sharedBase, "steward-token");
    const body = JSON.stringify({
      text: "keep this exact turn",
      clientMessageId: "same-idempotency-key",
    });

    await expect(
      client.fetch<{ delivered: boolean }>("/api/chat", {
        method: "POST",
        body,
      }),
    ).resolves.toEqual({ delivered: true });

    expect(requestBodies).toEqual([body, body]);
    expect(client.getBaseUrl()).toBe(dedicatedBase);
    expect(loadPersistedActiveServer()).toMatchObject({
      id: `cloud:${personalElizaId}`,
      apiBase: dedicatedBase,
      cloudRuntimeAgentId: dedicatedAgentId,
      cloudRuntime: "dedicated",
    });
    const registry = loadAgentProfileRegistry();
    expect(registry.profiles).toHaveLength(1);
    expect(registry.profiles[0]).toMatchObject({
      cloudAgentId: personalElizaId,
      cloudRuntimeAgentId: dedicatedAgentId,
      cloudRuntime: "dedicated",
      apiBase: dedicatedBase,
    });
    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method ?? "GET",
    }));
    expect(calls).toEqual([
      { url: `${sharedBase}/api/chat`, method: "POST" },
      {
        url: "https://api.eliza.app/api/v1/eliza/personal",
        method: "GET",
      },
      { url: `${dedicatedBase}/api/chat`, method: "POST" },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(
      /upgrade-tier|provision|create-agent|sandbox/i,
    );
  });

  it("fails closed when the saved logical identity does not own the rejection", async () => {
    savePersistedActiveServer(
      createPersistedActiveServer({
        kind: "cloud",
        id: "cloud:personal:00000000-0000-5000-8000-000000000099",
        label: "Other account",
        apiBase: sharedBase,
        accessToken: "steward-token",
      }),
    );
    const fetchMock = vi.fn(async () =>
      jsonResponse(409, {
        code: "personal_eliza_dedicated",
        error: "This personal Eliza is active on Dedicated.",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ElizaClient(sharedBase, "steward-token");

    await expect(client.fetch("/api/chat")).rejects.toMatchObject({
      status: 409,
      code: "personal_eliza_dedicated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.getBaseUrl()).toBe(sharedBase);
  });

  it("fails closed when Shared authority cannot fund the required Dedicated target", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === `${sharedBase}/api/chat`) {
          return jsonResponse(409, {
            code: "personal_eliza_dedicated",
            error: "This personal Eliza is active on Dedicated.",
          });
        }
        if (url.endsWith("/upgrade-tier")) {
          return jsonResponse(200, {
            success: true,
            data: {
              quoteId: "c".repeat(64),
              canActivate: false,
              activation: { state: "available" },
              unavailableReason: "Dedicated hosting credit is required.",
            },
          });
        }
        return jsonResponse(200, {
          success: true,
          data: {
            identity: {
              id: personalElizaId,
              displayName: "Eliza",
              runtime: "shared",
            },
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ElizaClient(sharedBase, "steward-token");

    await expect(client.fetch("/api/chat")).rejects.toMatchObject({
      status: 409,
      code: "personal_eliza_dedicated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.some((call) => call[1]?.method === "POST"),
    ).toBe(false);
    expect(client.getBaseUrl()).toBe(sharedBase);
    expect(loadPersistedActiveServer()).toMatchObject({
      id: `cloud:${personalElizaId}`,
      cloudRuntime: "shared",
    });
  });
});
