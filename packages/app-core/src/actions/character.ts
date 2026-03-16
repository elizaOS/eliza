/**
 * Character action helpers — extracted from AppContext.
 *
 * Pure functions for character CRUD and draft management.
 */

import type { CharacterData, MiladyClient } from "../api/client";

export interface CharacterActionContext {
  client: MiladyClient;
  setCharacterData: (data: CharacterData | null) => void;
  setCharacterDraft: (
    fn: CharacterData | ((prev: CharacterData) => CharacterData),
  ) => void;
  setCharacterLoading: (loading: boolean) => void;
  setCharacterSaving: (saving: boolean) => void;
  setCharacterSaveError: (error: string | null) => void;
  setCharacterSaveSuccess: (message: string | null) => void;
}

export async function loadCharacter(
  ctx: CharacterActionContext,
): Promise<void> {
  ctx.setCharacterLoading(true);
  ctx.setCharacterSaveError(null);
  ctx.setCharacterSaveSuccess(null);
  try {
    const { character } = await ctx.client.getCharacter();
    ctx.setCharacterData(character);
    ctx.setCharacterDraft({
      name: character.name ?? "",
      username: character.username ?? "",
      bio: Array.isArray(character.bio)
        ? character.bio.join("\n")
        : (character.bio ?? ""),
      system: character.system ?? "",
      adjectives: character.adjectives ?? [],
      style: {
        all: character.style?.all ?? [],
        chat: character.style?.chat ?? [],
        post: character.style?.post ?? [],
      },
      messageExamples: character.messageExamples ?? [],
      postExamples: character.postExamples ?? [],
    });
  } catch {
    ctx.setCharacterData(null);
    ctx.setCharacterDraft({});
  }
  ctx.setCharacterLoading(false);
}

export function prepareDraftForSave(
  draft: CharacterData,
): Record<string, unknown> {
  const result = { ...draft };
  if (typeof result.bio === "string") {
    const lines = result.bio
      .split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0);
    result.bio = lines.length > 0 ? lines : undefined;
  }
  if (Array.isArray(result.adjectives) && result.adjectives.length === 0)
    delete result.adjectives;
  if (Array.isArray(result.postExamples) && result.postExamples.length === 0)
    delete result.postExamples;
  if (
    Array.isArray(result.messageExamples) &&
    result.messageExamples.length === 0
  )
    delete result.messageExamples;
  if (result.style) {
    const s = result.style as Record<string, string[] | undefined>;
    if (s.all && s.all.length === 0) delete s.all;
    if (s.chat && s.chat.length === 0) delete s.chat;
    if (s.post && s.post.length === 0) delete s.post;
    if (!s.all && !s.chat && !s.post) delete result.style;
  }
  if (result.name) result.username = result.name;
  if (!result.name) delete result.name;
  if (!result.username) delete result.username;
  if (!result.system) delete result.system;
  return result;
}

export function parseMessageExamplesInput(value: string): Array<{
  examples: Array<{ name: string; content: { text: string } }>;
}> {
  if (!value.trim()) return [];
  const blocks = value.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
  return blocks.map((block) => {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    const examples = lines.map((line) => {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        return {
          name: line.slice(0, colonIdx).trim(),
          content: { text: line.slice(colonIdx + 1).trim() },
        };
      }
      return { name: "User", content: { text: line.trim() } };
    });
    return { examples };
  });
}

export function parseArrayInput(value: string): string[] {
  return value
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
