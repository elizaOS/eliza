import { expect, test } from "bun:test";
import { decisionPrompt, isCommandAllowed, parseDecision } from "./autonomous";

test("parseDecision accepts valid JSON decisions and clamps sleep", () => {
  expect(
    parseDecision('{"action":"RUN","command":"ls","note":"inspect"}'),
  ).toEqual({
    action: "RUN",
    command: "ls",
    note: "inspect",
  });
  expect(parseDecision('{"action":"SLEEP","sleepMs":1,"note":"wait"}')).toEqual(
    {
      action: "SLEEP",
      sleepMs: 100,
      note: "wait",
    },
  );
  expect(parseDecision('{"action":"STOP","note":"done"}')).toEqual({
    action: "STOP",
    note: "done",
  });
});

test("parseDecision rejects incomplete or malformed decisions", () => {
  expect(parseDecision("not json")).toBeNull();
  expect(parseDecision('{"action":"RUN","note":"missing command"}')).toBeNull();
  expect(parseDecision('{"action":"SLEEP","sleepMs":"nope"}')).toBeNull();
  expect(parseDecision('{"action":"DELETE","note":"bad action"}')).toBeNull();
});

test("isCommandAllowed blocks shell metacharacters and unknown commands", () => {
  const allowed = ["ls", "pwd", "cat", "echo"];

  expect(isCommandAllowed("ls -la", allowed)).toBe(true);
  expect(isCommandAllowed(" echo hello ", allowed)).toBe(true);
  expect(isCommandAllowed("rm file", allowed)).toBe(false);
  expect(isCommandAllowed("ls && rm file", allowed)).toBe(false);
  expect(isCommandAllowed("cat file | grep x", allowed)).toBe(false);
  expect(isCommandAllowed("echo hello\npwd", allowed)).toBe(false);
});

test("decisionPrompt includes sandbox, commands, goal, and history", () => {
  const prompt = decisionPrompt({
    goal: "Write STATUS.txt",
    allowedDirectory: "/tmp/sandbox",
    allowedCommands: ["ls", "echo"],
    recentSteps: "[step 1] SLEEP",
  });

  expect(prompt).toContain("Write STATUS.txt");
  expect(prompt).toContain("/tmp/sandbox");
  expect(prompt).toContain("ls, echo");
  expect(prompt).toContain("[step 1] SLEEP");
  expect(prompt).toContain('"action": "RUN|SLEEP|STOP"');
});
