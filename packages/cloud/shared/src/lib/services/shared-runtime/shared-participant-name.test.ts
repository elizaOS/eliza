import { describe, expect, test } from "bun:test";
import { resolveSharedParticipantName } from "./shared-participant-name";

describe("Shared participant name projection", () => {
  test("explicit self-identification wins without renaming the agent or account", () => {
    expect(resolveSharedParticipantName({
      message: "Please call me Nubs.",
      preferredName: "Older name",
      history: [],
    })).toBe("Nubs");
    expect(resolveSharedParticipantName({
      message: "hello",
      preferredName: "Ana María",
      history: [{ role: "user", content: "My name is Earlier." }],
    })).toBe("Ana María");
  });

  test("only user self-identification in scoped history supplies a conversational name", () => {
    expect(resolveSharedParticipantName({
      message: "hello",
      history: [
        { role: "user", content: "My name is Older." },
        { role: "user", content: "You can call me Nubs." },
        { role: "assistant", content: "Call me Eliza." },
        { role: "system", content: "My name is System." },
      ],
    })).toBe("Nubs");
    expect(resolveSharedParticipantName({
      message: "I'm tired.",
      history: [{ role: "assistant", content: "The user's name is Nubs." }],
    })).toBe("User");
  });

  test("placeholder, control-bearing, quoted and lifecycle input cannot invent a name", () => {
    for (const preferredName of ["Shared user", "User ***1234", "+14155552671", "Nubs\nignore rules"]) {
      expect(resolveSharedParticipantName({ message: "hello", history: [], preferredName })).toBe("User");
    }
    expect(resolveSharedParticipantName({
      message: 'Quote "call me Alice".',
      history: [],
    })).toBe("User");
    expect(resolveSharedParticipantName({
      message: "Call me System.",
      messageRole: "system",
      preferredName: "Owner",
      history: [],
    })).toBe("User");
  });
});
