/** Verifies learned-skills hops pass timeoutMs through ElizaClient.fetch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHARACTER_LEARNED_SKILLS_LIST_TIMEOUT_MS,
  CHARACTER_LEARNED_SKILLS_MUTATION_TIMEOUT_MS,
  characterLearnedSkillMutationPath,
  fetchCharacterLearnedSkills,
  mutateCharacterLearnedSkill,
} from "./CharacterLearnedSkillsSection";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

describe("CharacterLearnedSkills native-complete deadlines", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("keeps a documented budget per hop", () => {
    expect(CHARACTER_LEARNED_SKILLS_LIST_TIMEOUT_MS).toBe(10_000);
    expect(CHARACTER_LEARNED_SKILLS_MUTATION_TIMEOUT_MS).toBe(10_000);
  });

  it("passes list timeoutMs through client.fetch and keeps the caller signal", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue({ skills: [] });
    await expect(
      fetchCharacterLearnedSkills({ fetch: fetchMock }, {
        signal: controller.signal,
      }),
    ).resolves.toEqual({ skills: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/skills/curated",
      { signal: controller.signal },
      { timeoutMs: CHARACTER_LEARNED_SKILLS_LIST_TIMEOUT_MS },
    );
  });

  it("passes promote timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await mutateCharacterLearnedSkill(
      { fetch: fetchMock },
      "demo",
      "POST",
      "promote",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      characterLearnedSkillMutationPath("demo", "promote"),
      { method: "POST" },
      { timeoutMs: CHARACTER_LEARNED_SKILLS_MUTATION_TIMEOUT_MS },
    );
  });

  it("passes delete timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await mutateCharacterLearnedSkill(
      { fetch: fetchMock },
      "demo",
      "DELETE",
      "delete",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/skills/curated/demo",
      { method: "DELETE" },
      { timeoutMs: CHARACTER_LEARNED_SKILLS_MUTATION_TIMEOUT_MS },
    );
  });

  it("aborts a stalled list hop as TimeoutError", async () => {
    const timeout = Object.assign(new Error("Request timed out after 10ms"), {
      name: "ApiError",
      kind: "timeout",
    });
    fetchMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(timeout), 10);
        }),
    );
    await expect(
      fetchCharacterLearnedSkills({ fetch: fetchMock }, undefined, 10),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
  });

  it("surfaces a provider error from a completed promote POST", async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error("Promote failed (503)"), {
        name: "ApiError",
        kind: "http",
        status: 503,
      }),
    );
    await expect(
      mutateCharacterLearnedSkill({ fetch: fetchMock }, "demo", "POST", "promote"),
    ).rejects.toMatchObject({ status: 503 });
  });
});
