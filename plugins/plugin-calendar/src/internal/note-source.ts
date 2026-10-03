/** Validates the cross-domain Notes reference before calendar preparation or dispatch. */
import { ElizaError } from "@elizaos/core";
import type { CalendarNoteSourceReference } from "@elizaos/core/contracts/calendar";

export function parseCalendarNoteSource(
  value: unknown,
): CalendarNoteSourceReference | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    !("agentId" in value) ||
    typeof value.agentId !== "string" ||
    !value.agentId ||
    !("noteId" in value) ||
    typeof value.noteId !== "string" ||
    !value.noteId ||
    !("contentHash" in value) ||
    typeof value.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.contentHash)
  ) {
    throw new ElizaError(
      "Use the complete sourceNote reference from the exact Notes read.",
      {
        code: "CALENDAR_NOTE_SOURCE_INVALID",
        severity: "ephemeral",
      },
    );
  }
  return {
    agentId: value.agentId,
    noteId: value.noteId,
    contentHash: value.contentHash,
  };
}
