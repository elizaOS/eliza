import { readClientTurnObservation } from "@elizaos/contracts/client-turn-observation";

/**
 * The browser tab and document the agent's turn observed. The renderer refuses
 * a history command when its current tab or document no longer matches.
 */
export type NativeHistorySelection = {
  id: string;
  revision: string;
  navigation?: string;
};
/** Complete typed commands supported by a mounted native browser history surface. */
export type NativeHistoryCommand = {
  subaction: "back" | "forward" | "reload";
  selection?: NativeHistorySelection;
};
const HISTORY_SUBACTIONS = ["back", "forward", "reload"];
// Same bounds as the client observation contract's selected object id and token.
const SELECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@=+-]{0,511}$/;
const SELECTION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@=+-]{0,255}$/;

function parseNativeHistorySelection(value: unknown): NativeHistorySelection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Browser selection is invalid");
  const selection = value as Record<string, unknown>;
  const token = (key: string, pattern = SELECTION_TOKEN) =>
    typeof selection[key] === "string" &&
    pattern.test(selection[key] as string);
  if (
    Object.keys(selection).some(
      (key) => !["id", "revision", "navigation"].includes(key),
    ) ||
    !token("id", SELECTION_ID) ||
    !token("revision") ||
    (selection.navigation !== undefined && !token("navigation"))
  )
    throw Error("Browser selection is invalid");
  return {
    id: selection.id as string,
    revision: selection.revision as string,
    ...(selection.navigation === undefined
      ? {}
      : { navigation: selection.navigation as string }),
  };
}

/** Parse a frame's `command` and its optional observed `selection`. */
export function parseNativeHistoryCommand(
  value: unknown,
  selection?: unknown,
): NativeHistoryCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Browser command is required");
  const command = value as Record<string, unknown>;
  if (
    Object.keys(command).some((key) => key !== "subaction") ||
    !HISTORY_SUBACTIONS.includes(String(command.subaction))
  )
    throw Error(
      "This mounted browser supports back, forward and reload without server tab IDs",
    );
  return {
    subaction: command.subaction as NativeHistoryCommand["subaction"],
    ...(selection === undefined
      ? {}
      : { selection: parseNativeHistorySelection(selection) }),
  };
}

/**
 * The browser tab the current turn observed, copied from the message's client
 * observation for a history command. Undefined when the turn saw no browser tab.
 */
export function observedNativeHistorySelection(
  message: { content: unknown },
  subaction: string,
): NativeHistorySelection | undefined {
  if (!HISTORY_SUBACTIONS.includes(subaction)) return undefined;
  const content = message.content;
  if (!content || typeof content !== "object" || Array.isArray(content))
    return undefined;
  const observation = readClientTurnObservation(
    (content as Record<string, unknown>).metadata,
  );
  const selected = observation?.selectedObject;
  if (
    !observation ||
    observation.sensitive ||
    observation.view !== "browser" ||
    selected?.kind !== "browser-tab" ||
    selected.revision === undefined ||
    !SELECTION_ID.test(selected.id) ||
    !SELECTION_TOKEN.test(selected.revision)
  )
    return undefined;
  return { id: selected.id, revision: selected.revision };
}
