/**
 * Projects a participant display name, never the agent name or an account mutation.
 * The caller supplies preferredName only from verified owner profile data.
 */
import type { SharedTurnMessage } from "./run-shared-agent-turn";

const EXPLICIT_SELF_NAME = /^my(?: preferred)? name is\s+(.+?)[.!?]?$/iu;
// An unquoted name is written as one: no word starts with a lowercase letter,
// apart from surname particles, including elided ones before a capital
// (d'Angelo, o'Connor). "My name is not important" or "my name is on the
// account" is a phrase, not a name. Caseless scripts (李明, محمد) pass.
const UNQUOTED_NAME_WORD =
  /^(?:[^\p{Ll}]|\p{Ll}{1,3}['’]\p{Lu}|(?:al|bin|da|de|del|della|der|di|du|la|le|van|von|y)$)/u;
const QUOTED_SELF_NAME =
  /^(?:please\s+)?(?:call me|you can call me|i go by)\s+["“]([^"”]+)["”][.!?]?$/iu;

function usableName(value: string | undefined): string | undefined {
  const name = value?.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    !name ||
    name.length > 60 ||
    /[\p{C}]/u.test(value ?? "") ||
    !/[\p{L}]/u.test(name) ||
    !/^[@\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}_'’.-]*(?: [\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}_'’.-]*){0,3}$/u.test(
      name,
    ) ||
    /^(?:shared user|shared lifecycle|eliza user|user|anonymous|unknown)$/iu.test(name)
  )
    return undefined;
  return name;
}

/** Only the canonical owner's saved nickname/display name, excluding placeholders. */
export function sharedOwnerProfileName(profile: {
  nickname?: string | null;
  name?: string | null;
}): string | undefined {
  return usableName(profile.nickname ?? undefined) ?? usableName(profile.name ?? undefined);
}

function explicitSelfName(message: string): string | undefined {
  const unquoted = EXPLICIT_SELF_NAME.exec(message.trim())?.[1];
  if (unquoted)
    return unquoted
      .trim()
      .split(/\s+/u)
      .every((word) => UNQUOTED_NAME_WORD.test(word))
      ? usableName(unquoted)
      : undefined;
  return usableName(QUOTED_SELF_NAME.exec(message.trim())?.[1]);
}

export function resolveSharedParticipantName(args: {
  message: string;
  messageRole?: "user" | "system";
  history: readonly SharedTurnMessage[];
  /** Server-verified owner preference, never RPC or transport display text. */
  preferredName?: string;
}): string | undefined {
  if (args.messageRole === "system") return undefined;
  const current = explicitSelfName(args.message);
  if (current) return current;
  const preferred = usableName(args.preferredName);
  if (preferred) return preferred;
  for (let index = args.history.length - 1; index >= 0; index -= 1) {
    const previous = args.history[index];
    if (previous.role !== "user") continue;
    const name = explicitSelfName(previous.content);
    if (name) return name;
  }
  return undefined;
}
