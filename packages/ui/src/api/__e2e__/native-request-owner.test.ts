import { afterEach, describe, expect, it, vi } from "vitest";
import { createAndroidNativeAgentTransport } from "../android-native-agent-transport";
import { ElizaClient } from "../client-base";
import { fetchWithCsrf } from "../csrf-client";
import { configureHostAgentCapabilities, configureHostTransport } from "../host-transport";

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });

describe("native request owner across transport selection", () => {
  it.each(["client", "csrf"])("%s preserves its original owner when native selection waits", async kind => {
    let owner = "owner-a";
    let selected!: () => void;
    const request = vi.fn(async (input: { ownerId?: string }) => ({
      status: input.ownerId === owner ? 200 : 409,
      body: JSON.stringify(input.ownerId === owner ? { privateData: true } : { error: "Owner changed" }),
    }));
    disposers.push(configureHostAgentCapabilities({
      isInProcessAgentBase: () => false, isTerminalBootError: () => false,
      lifecycleForUrl: async () => null, requestOwnerIdForUrl: () => owner,
    }));
    const transport = createAndroidNativeAgentTransport({ request });
    disposers.push(configureHostTransport(async () => {
      await new Promise<void>(resolve => { selected = resolve; });
      return transport;
    }));
    const client = new ElizaClient("eliza-local-agent://ipc", "fixture-token");
    const response = kind === "client"
      ? client.rawRequest("/api/config", undefined, { allowNonOk: true })
      : fetchWithCsrf("eliza-local-agent://ipc/api/config", { headers: { Authorization: "Bearer fixture-token" } });
    await vi.waitFor(() => expect(selected).toBeTypeOf("function"));
    owner = "owner-b";
    selected();
    const result = await response;
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "owner-a" }));
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: "Owner changed" });
  });
  it.each(["client", "csrf"])("%s does not dispatch after cancellation during native selection", async kind => {
    let selected!: () => void;
    const request = vi.fn(async () => ({status: 200, body: "{}"}));
    const transport = createAndroidNativeAgentTransport({ request });
    disposers.push(configureHostTransport(async () => {
      await new Promise<void>(resolve => { selected = resolve; });
      return transport;
    }));
    const cancel = new AbortController();
    const client = new ElizaClient("eliza-local-agent://ipc", "fixture-token");
    const response = kind === "client"
      ? client.rawRequest("/api/config", {signal: cancel.signal})
      : fetchWithCsrf("eliza-local-agent://ipc/api/config", {signal: cancel.signal, headers: {Authorization: "Bearer fixture-token"}});
    await vi.waitFor(() => expect(selected).toBeTypeOf("function"));
    cancel.abort(new DOMException("Owner left", "AbortError"));
    selected();
    await expect(response).rejects.toBeDefined();
    expect(request).not.toHaveBeenCalled();
  });

});
