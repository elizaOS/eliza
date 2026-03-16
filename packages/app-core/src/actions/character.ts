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
      topics: character.topics ?? [],
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
  // Only pick fields the API schema accepts (.strict() rejects unknown keys)
  const result: Record<string, unknown> = {};

  if (draft.name?.trim()) {
    result.name = draft.name.trim();
  }

  if (draft.username?.trim()) {
    result.username = draft.username.trim();
  } else if (typeof result.name === "string") {
    result.username = result.name;
  }
  if (draft.system) result.system = draft.system;

  if (typeof draft.bio === "string") {
    const lines = draft.bio
      .split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0);
    if (lines.length > 0) result.bio = lines;
  } else if (Array.isArray(draft.bio) && draft.bio.length > 0) {
    result.bio = draft.bio;
  }

  const adjectives = (draft.adjectives ?? []).filter(
    (s) => s.trim().length > 0,
  );
  if (adjectives.length > 0) result.adjectives = adjectives;

  const topics = (draft.topics ?? []).filter((s) => s.trim().length > 0);
  if (topics.length > 0) result.topics = topics;

  const postExamples = (draft.postExamples ?? []).filter(
    (s) => s.trim().length > 0,
  );
  if (postExamples.length > 0) result.postExamples = postExamples;

  if (
    Array.isArray(draft.messageExamples) &&
    draft.messageExamples.length > 0
  ) {
    // Strip extra fields from content (schema is .strict() — only text + actions allowed)
    const cleaned = draft.messageExamples
      .map((group) => ({
        examples: (group.examples ?? [])
          .filter((msg) => msg.name?.trim() && msg.content?.text?.trim())
          .map((msg) => ({
            name: msg.name,
            content: {
              text: msg.content.text,
              ...(msg.content.actions ? { actions: msg.content.actions } : {}),
            },
          })),
      }))
      .filter((group) => group.examples.length > 0);
    if (cleaned.length > 0) result.messageExamples = cleaned;
  }

  if (draft.style) {
    const style: Record<string, string[]> = {};
    if (draft.style.all?.length) style.all = draft.style.all;
    if (draft.style.chat?.length) style.chat = draft.style.chat;
    if (draft.style.post?.length) style.post = draft.style.post;
    if (Object.keys(style).length > 0) result.style = style;
  }

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
