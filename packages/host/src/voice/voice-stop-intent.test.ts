import { expect, test } from "vitest";
import { parseClientControlFrame } from "./protocol";

const parse = (intent?: unknown) =>
  parseClientControlFrame(
    JSON.stringify({ t: "bye", ...(intent === undefined ? {} : { intent }) }),
  );
test("legacy bye remains unclaimed", () =>
  expect(parse()).toEqual({ ok: true, value: { t: "bye" } }));
test.each(["user_stop", "budget_rotation"])("accepts typed %s", (kind) =>
  expect(parse({ version: 1, kind, generation: "session" }).ok).toBe(true),
);
test.each([
  { version: 2, kind: "user_stop", generation: "session" },
  {
    version: 1,
    kind: "user_stop",
    generation: "session",
    successorSessionId: "next",
  },
  { version: 1, kind: ["user_stop"], generation: "session" },
  { version: 1, kind: "user_stop", generation: "" },
  { version: 1, kind: "budget_rotation", generation: "session", extra: true },
])("rejects malformed intent %j", (intent) =>
  expect(parse(intent).ok).toBe(false),
);
