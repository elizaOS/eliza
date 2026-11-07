/**
 * The outbound group guard promises that a participant's raw connector handle
 * never reaches a group reply. A connector-supplied display name may contain
 * `$` replacement patterns, so the label itself must not be read as one by
 * `String.prototype.replace`.
 */
import { expect, test } from "bun:test";
import {
  redactGroupParticipantHandles,
  resolveGroupParticipantDisplayName,
} from "./group-participant-labels";

const HANDLE = "+14155550100";

function replyFor(name: string): string {
  const displayName = resolveGroupParticipantDisplayName({
    candidate: name,
    platformUserId: HANDLE,
    roster: [],
  });
  return redactGroupParticipantHandles(`thanks ${HANDLE} for the note`, [
    { platformUserId: HANDLE, displayName, ordinal: 2 },
  ]);
}

test("a dollar sign in a display name never restores the redacted handle", () => {
  const reply = replyFor("$&");
  expect(reply).not.toContain(HANDLE);
  expect(reply).toBe("thanks $& for the note");
});

test("a dollar sign in a display name never splices the surrounding text", () => {
  expect(replyFor("Ada $`")).toBe("thanks Ada $` for the note");
  expect(replyFor("$'tail")).toBe("thanks $'tail for the note");
  expect(replyFor("$$")).toBe("thanks $$ for the note");
});

test("an ordinary display name still replaces the handle", () => {
  expect(replyFor("Ada")).toBe("thanks Ada for the note");
});
