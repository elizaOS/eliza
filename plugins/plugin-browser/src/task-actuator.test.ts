import { describe, expect, it } from "vitest";
import {
  NativeTaskActuator,
  validTaskBrowserBlockers,
} from "./task-actuator.js";

const elements = [
  { selector: "snap:0:0", label: "Reject all" },
  { selector: "snap:0:1", label: "Close" },
];

describe("validTaskBrowserBlockers", () => {
  it("accepts a page from a browser without blocker reports", () => {
    expect(validTaskBrowserBlockers({ elements })).toBe(true);
  });

  it("accepts typed blockers that name this snapshot's controls", () => {
    expect(
      validTaskBrowserBlockers({
        elements,
        blockers: [
          { kind: "cookie-consent", rejectRef: "snap:0:0", covers: "target" },
          { kind: "modal", ref: "snap:0:1", covers: "viewport", text: "News" },
          { kind: "captcha", covers: "partial" },
          { kind: "login-wall", covers: "viewport" },
          { kind: "paywall", covers: "partial" },
        ],
      }),
    ).toBe(true);
  });

  it.each([
    ["an unknown kind", { kind: "popup", covers: "viewport" }],
    ["an unknown coverage", { kind: "modal", covers: "most" }],
    [
      "a ref from another snapshot",
      { kind: "modal", ref: "old:0:1", covers: "viewport" },
    ],
    [
      "a person check with a ref",
      { kind: "captcha", ref: "snap:0:1", covers: "partial" },
    ],
    [
      "a reject ref on a modal",
      { kind: "modal", rejectRef: "snap:0:0", covers: "viewport" },
    ],
    ["non-text text", { kind: "paywall", covers: "partial", text: 3 }],
    [
      "a close ref on a consent banner",
      { kind: "cookie-consent", ref: "snap:0:1", covers: "target" },
    ],
    [
      "text longer than 200 characters",
      { kind: "paywall", covers: "partial", text: "x".repeat(201) },
    ],
  ])("rejects %s", (_name, blocker) => {
    expect(validTaskBrowserBlockers({ elements, blockers: [blocker] })).toBe(
      false,
    );
  });

  it("rejects a blocker report that is not a list", () => {
    expect(validTaskBrowserBlockers({ elements, blockers: {} })).toBe(false);
  });
});

describe("NativeTaskActuator cleanup", () => {
  it("answers only once no cancelled browser command can still take effect", async () => {
    let settle!: (error?: Error) => void;
    const settled = new Promise<void>((resolve, reject) => {
      settle = (error) => (error ? reject(error) : resolve());
    });
    const fail = () => {
      throw new Error("unexpected call");
    };
    const actuator = new NativeTaskActuator({
      target: {
        bindTask: fail,
        execute: fail,
        settled: () => settled,
      },
      getTask: fail,
      policy: fail,
      nextBindingRevision: fail,
      resolveValue: fail,
      verify: fail,
      recordEvidence: fail,
    });
    const owner = {
      actorId: "actor",
      agentId: "agent",
      connector: { source: "browser", accountId: "account" },
    };
    let done = false;
    const quiesced = actuator.quiesce({ owner, taskId: "task-1" }).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    settle();
    await quiesced;
    const refused = new NativeTaskActuator({
      target: {
        bindTask: fail,
        execute: fail,
        settled: () => Promise.reject(new Error("cancel unconfirmed")),
      },
      getTask: fail,
      policy: fail,
      nextBindingRevision: fail,
      resolveValue: fail,
      verify: fail,
      recordEvidence: fail,
    });
    await expect(refused.quiesce({ owner, taskId: "task-1" })).rejects.toThrow(
      "cancel unconfirmed",
    );
  });
});
