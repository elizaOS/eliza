/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves the vault Overview tab install hop carries timeoutMs into
 * Agent.request and keeps allowNonOk. Sign-in hop stays untouched.
 * Not wallets. Not Finances.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../../../api/client-base";
import type { AgentRequestTransport } from "../../../api/transport";
import { setBootConfig } from "../../../config/boot-config";
import {
  VAULT_OVERVIEW_INSTALL_RAW_REQUEST_TIMEOUT_MS,
  rawRequestVaultOverviewInstall,
} from "./OverviewTab";

const METHOD = { kind: "brew" as const, package: "1password-cli", cask: false };

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("OverviewTab install rawRequest native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the POST /api/secrets/manager/install deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ jobId: "job-1" }),
    );
    const res = await rawRequestVaultOverviewInstall(
      "1password",
      METHOD,
      VAULT_OVERVIEW_INSTALL_RAW_REQUEST_TIMEOUT_MS,
      makeClient(request),
    );
    expect(res.ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/manager/install",
      expect.objectContaining({ method: "POST" }),
      { timeoutMs: VAULT_OVERVIEW_INSTALL_RAW_REQUEST_TIMEOUT_MS },
    );
  });

  it("returns a non-ok install response instead of throwing", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () => new Response("nope", { status: 503 }),
    );
    const res = await rawRequestVaultOverviewInstall(
      "1password",
      METHOD,
      VAULT_OVERVIEW_INSTALL_RAW_REQUEST_TIMEOUT_MS,
      makeClient(request),
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/manager/install",
      expect.objectContaining({ method: "POST" }),
      { timeoutMs: VAULT_OVERVIEW_INSTALL_RAW_REQUEST_TIMEOUT_MS },
    );
  });

  it("times out a stalled install hop through ElizaClient", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async (_url, init, ctx) => {
        const ms = ctx?.timeoutMs ?? 10;
        return new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(
              Object.assign(new Error(`Request timed out after ${ms}ms`), {
                name: "TimeoutError",
              }),
            );
          }, ms);
          init.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(
                Object.assign(new Error("The operation was aborted"), {
                  name: "AbortError",
                }),
              );
            },
            { once: true },
          );
        });
      },
    );
    await expect(
      rawRequestVaultOverviewInstall(
        "1password",
        METHOD,
        10,
        makeClient(request),
      ),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/manager/install",
      expect.objectContaining({ method: "POST" }),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from the install hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw Object.assign(new Error("vault install unavailable"), {
        name: "TypeError",
      });
    });
    await expect(
      rawRequestVaultOverviewInstall(
        "1password",
        METHOD,
        VAULT_OVERVIEW_INSTALL_RAW_REQUEST_TIMEOUT_MS,
        makeClient(request),
      ),
    ).rejects.toMatchObject({ name: "ApiError" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/manager/install",
      expect.objectContaining({ method: "POST" }),
      { timeoutMs: VAULT_OVERVIEW_INSTALL_RAW_REQUEST_TIMEOUT_MS },
    );
  });
});
