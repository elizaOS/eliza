/** Verifies glance skills list/refresh hops pass timeoutMs through ElizaClient.fetch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  SKILLS_LIST_FETCH_TIMEOUT_MS,
  SKILLS_REFRESH_FETCH_TIMEOUT_MS,
} from "./client-skills";
import "./client-skills";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("ElizaClient skills glance native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget per hop", () => {
    expect(SKILLS_LIST_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(SKILLS_REFRESH_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("passes getSkills timeoutMs through client.fetch with no query", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ skills: [] }),
    );
    await makeClient(request).getSkills();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/skills",
      expect.any(Object),
      { timeoutMs: SKILLS_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("passes refreshSkills timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ ok: true, skills: [] }),
    );
    await makeClient(request).refreshSkills();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/skills/refresh",
      expect.any(Object),
      { timeoutMs: SKILLS_REFRESH_FETCH_TIMEOUT_MS },
    );
  });

  it("aborts a stalled refresh hop as TimeoutError", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async (_url, init, ctx) => {
        const ms = ctx?.timeoutMs ?? 10;
        await new Promise<never>((_, reject) => {
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
    await expect(makeClient(request).refreshSkills(10)).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
  });

  it("surfaces a provider error from a completed getSkills GET", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(makeClient(request).getSkills()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
