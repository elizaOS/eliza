/**
 * Projects a participant display name, never the agent name or an account mutation.
 * The caller supplies preferredName only from verified owner profile data.
 */
import type { SharedTurnMessage } from "./run-shared-agent-turn";

const EXPLICIT_SELF_NAME = /^(?:please\s+)?(?:my name is|call me|you can call me)\s+(.+?)[.!?]?$/iu;

function usableName(value: string | undefined): string | undefined {
  const name = value?.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    !name ||
    name.length > 60 ||
    /[\p{C}]/u.test(value ?? "") ||
    !/^[\p{L}\p{M}][\p{L}\p{M}'’.-]*(?: [\p{L}\p{M}][\p{L}\p{M}'’.-]*){0,3}$/u.test(name) ||
    /^(?:shared user|shared lifecycle|user|anonymous|unknown)$/iu.test(name)
  ) return undefined;
  return name;
}

function explicitSelfName(message: string): string | undefined {
  return usableName(EXPLICIT_SELF_NAME.exec(message.trim())?.[1]);
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
