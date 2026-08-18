/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves learned-skills hops carry timeoutMs into Agent.request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../../api/client-base";
import type { AgentRequestTransport } from "../../api/transport";
import { setBootConfig } from "../../config/boot-config";
import {
  CHARACTER_LEARNED_SKILLS_LIST_TIMEOUT_MS,
  CHARACTER_LEARNED_SKILLS_MUTATION_TIMEOUT_MS,
  fetchCharacterLearnedSkills,
  mutateCharacterLearnedSkill,
} from "./CharacterLearnedSkillsSection";

function makeClientWithTransport(request: AgentRequestTransport["request"]) {
  const api = new ElizaClient("http://agent.example:2138", "token");
  api.setRequestTransport({ request });
  return api;
}

describe("CharacterLearnedSkills ElizaClient native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the list deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ skills: [] }),
    );
    const api = makeClientWithTransport(request);
    await fetchCharacterLearnedSkills(api);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/skills/curated",
      expect.any(Object),
      { timeoutMs: CHARACTER_LEARNED_SKILLS_LIST_TIMEOUT_MS },
    );
  });

  it("forwards the mutation deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ ok: true }),
    );
    const api = makeClientWithTransport(request);
    await mutateCharacterLearnedSkill(api, "demo", "POST", "disable");
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/skills/curated/demo/disable",
      expect.any(Object),
      { timeoutMs: CHARACTER_LEARNED_SKILLS_MUTATION_TIMEOUT_MS },
    );
  });

  it("times out a stalled list hop through ElizaClient", async () => {
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
    const api = makeClientWithTransport(request);
    await expect(
      fetchCharacterLearnedSkills(api, undefined, 10),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/skills/curated",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });
});
