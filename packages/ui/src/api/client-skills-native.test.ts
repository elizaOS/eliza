/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves glance skills hops carry timeoutMs into Agent.request.
 */
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

describe("ElizaClient skills glance native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the getSkills deadline to Agent.request", async () => {
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

  it("forwards the refreshSkills deadline to Agent.request", async () => {
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

  it("times out a stalled getSkills hop through ElizaClient", async () => {
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
    await expect(makeClient(request).getSkills(10)).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/skills",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });
});
