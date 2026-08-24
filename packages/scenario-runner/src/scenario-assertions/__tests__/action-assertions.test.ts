/** Exercises the real scenario action and side-effect assertion factories against captured records. */

import type {
  CapturedAction,
  CapturedApprovalRequest,
  CapturedConnectorDispatch,
  CapturedMemoryWrite,
  CapturedStateTransition,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import {
  expectApprovalRequest,
  expectApprovalStateTransition,
  expectConnectorDispatch,
  expectMemoryWrite,
  expectNoSideEffectOnReject,
  expectScenarioToCallAction,
  expectStateTransition,
  expectTurnToCallAction,
  judgeRubric,
} from "../action-assertions.ts";

function action(overrides: Partial<CapturedAction> = {}): CapturedAction {
  return {
    actionName: "test",
    parameters: {},
    result: { success: true, data: { ok: 1 } },
    ...overrides,
  } as CapturedAction;
}

function turn(actions: CapturedAction[]): ScenarioTurnExecution {
  return { actionsCalled: actions };
}

function ctx(overrides: Partial<ScenarioContext> = {}): ScenarioContext {
  return { actionsCalled: [], ...overrides } as ScenarioContext;
}

function approval(
  overrides: Partial<CapturedApprovalRequest> = {},
): CapturedApprovalRequest {
  return {
    id: "req-1",
    state: "pending",
    actionName: "SEND_EMAIL",
    ...overrides,
  };
}

function dispatch(
  overrides: Partial<CapturedConnectorDispatch> = {},
): CapturedConnectorDispatch {
  return { channel: "email", actionName: "SEND_EMAIL", ...overrides };
}

function memoryWrite(
  overrides: Partial<CapturedMemoryWrite> = {},
): CapturedMemoryWrite {
  return { table: "memories", content: { fact: "likes coffee" }, ...overrides };
}

function transition(
  overrides: Partial<CapturedStateTransition> = {},
): CapturedStateTransition {
  return { subject: "approval", to: "approved", ...overrides };
}

describe("expectTurnToCallAction", () => {
  it("passes when a captured action matches the accepted names", () => {
    const check = expectTurnToCallAction({
      acceptedActions: ["SEND_EMAIL"],
      description: "an email being sent",
    });
    expect(check(turn([action({ actionName: "send_email" })]))).toBeUndefined();
  });

  it("credits action-family matches across casing, separators, and prefixes", () => {
    const check = expectTurnToCallAction({
      acceptedActions: ["CALENDAR_CREATE"],
      description: "calendar creation",
    });
    expect(
      check(turn([action({ actionName: "Calendar_Create_Event" })])),
    ).toBeUndefined();
  });

  it("rejects reordered tokens and reports what actually ran", () => {
    const check = expectTurnToCallAction({
      acceptedActions: ["SEND_EMAIL"],
      description: "an email being sent",
    });
    const message = check(turn([action({ actionName: "EMAIL_SEND" })]));
    expect(message).toContain("Expected an email being sent via [SEND_EMAIL]");
    expect(message).toContain("but got EMAIL_SEND.");
  });

  it("describes an empty turn as (none)", () => {
    const check = expectTurnToCallAction({
      acceptedActions: ["DO_THING"],
      description: "the thing",
    });
    const message = check(turn([]));
    expect(message).toContain("but got (none).");
  });

  it("excludes synthesized replies from the matched count", () => {
    const check = expectTurnToCallAction({
      acceptedActions: ["SEND_EMAIL"],
      description: "an email being sent",
    });
    const synthesized = action({
      actionName: "SEND_EMAIL",
      result: { success: true, data: { source: "synthesized-reply" } },
    });
    const message = check(turn([synthesized]));
    expect(message).toContain("but got SEND_EMAIL.");
  });

  it("requires minCount distinct matching calls", () => {
    const check = expectTurnToCallAction({
      acceptedActions: ["SEND_EMAIL"],
      description: "an email being sent",
      minCount: 2,
    });
    const single = turn([
      action({ actionName: "SEND_EMAIL" }),
      action({ actionName: "OTHER" }),
    ]);
    expect(check(single)).toContain("Expected an email being sent");
    expect(
      check(
        turn([
          action({ actionName: "SEND_EMAIL" }),
          action({ actionName: "SEND_EMAIL" }),
        ]),
      ),
    ).toBeUndefined();
  });

  it("checks includesAll terms against the combined payload blob case-insensitively", () => {
    const check = expectTurnToCallAction({
      acceptedActions: ["SEND_EMAIL"],
      description: "an email being sent",
      includesAll: ["A@B.COM", /"id":"x"/],
    });
    expect(
      check(
        turn([
          action({
            actionName: "SEND_EMAIL",
            parameters: { to: "a@b.com" },
            result: { success: true, data: { id: "x" } },
          }),
        ]),
      ),
    ).toBeUndefined();
  });

  it("names the first missing includesAll term and dumps payloads on failure", () => {
    const check = expectTurnToCallAction({
      acceptedActions: ["SEND_EMAIL"],
      description: "an email being sent",
      includesAll: ["receipt-id"],
    });
    const message = check(turn([action({ actionName: "SEND_EMAIL" })]));
    expect(message).toContain("payload to include receipt-id");
    expect(message).toContain("Payloads:");
  });

  it("satisfies includesAny when one alternative appears in any payload", () => {
    const check = expectTurnToCallAction({
      acceptedActions: ["SEND_EMAIL"],
      description: "an email being sent",
      includesAny: ["no such marker", "welcome aboard"],
    });
    expect(
      check(
        turn([
          action({ actionName: "SEND_EMAIL" }),
          action({
            actionName: "SEND_EMAIL",
            result: { success: true, text: "Welcome Aboard!" },
          }),
        ]),
      ),
    ).toBeUndefined();
  });

  it("fails includesAny when no alternative appears anywhere", () => {
    const check = expectTurnToCallAction({
      acceptedActions: ["SEND_EMAIL"],
      description: "an email being sent",
      includesAny: ["alpha", "beta"],
    });
    const message = check(turn([action({ actionName: "SEND_EMAIL" })]));
    expect(message).toContain("include one of [alpha, beta]");
  });

  it("folds action errors into the searchable blob", () => {
    const check = expectTurnToCallAction({
      acceptedActions: ["CALL_API"],
      description: "the api call",
      includesAll: ["rate limited"],
    });
    expect(
      check(
        turn([
          action({
            actionName: "CALL_API",
            result: undefined,
            error: { message: "RATE LIMITED" },
          }),
        ]),
      ),
    ).toBeUndefined();
  });
});

describe("expectScenarioToCallAction", () => {
  it("reads actionsCalled from the scenario context", () => {
    const check = expectScenarioToCallAction({
      acceptedActions: ["SEARCH_MEMORY"],
      description: "a memory search",
    });
    expect(
      check(ctx({ actionsCalled: [action({ actionName: "SEARCH_MEMORY" })] })),
    ).toBeUndefined();
  });

  it("fails on a context with no captured actions", () => {
    const check = expectScenarioToCallAction({
      acceptedActions: ["SEARCH_MEMORY"],
      description: "a memory search",
    });
    expect(check(ctx({}))).toContain("(none)");
  });
});

describe("expectApprovalRequest", () => {
  it("matches requests by fuzzy action name and exact state", () => {
    const check = expectApprovalRequest({
      description: "an email approval",
      actionName: "send_email",
      state: "pending",
    });
    expect(check(ctx({ approvalRequests: [approval()] }))).toBeUndefined();
  });

  it("treats a missing capture list as an empty queue", () => {
    const check = expectApprovalRequest({
      description: "an email approval",
      actionName: "SEND_EMAIL",
    });
    const message = check(ctx({}));
    expect(message).toContain("at least 1 approval request(s)");
    expect(message).toContain("saw 0 of 0 total");
  });

  it("accepts arrays of action names and states", () => {
    const check = expectApprovalRequest({
      description: "a gate decision",
      actionName: ["SEND_EMAIL", "DELETE_DOC"],
      state: ["rejected", "expired"],
    });
    expect(
      check(
        ctx({
          approvalRequests: [
            approval({ id: "r1", state: "done" }),
            approval({ id: "r2", actionName: "delete_doc", state: "rejected" }),
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it("with no filters counts every request toward minCount", () => {
    const check = expectApprovalRequest({
      description: "any approvals",
      minCount: 3,
    });
    const two = ctx({
      approvalRequests: [approval(), approval({ state: "done" })],
    });
    expect(check(two)).toContain("at least 3");
    expect(
      check(ctx({ approvalRequests: [approval(), approval(), approval()] })),
    ).toBeUndefined();
  });

  it("does not credit a different state", () => {
    const check = expectApprovalRequest({
      description: "a rejection",
      actionName: "SEND_EMAIL",
      state: "rejected",
    });
    expect(check(ctx({ approvalRequests: [approval()] }))).toContain(
      "state=[rejected]",
    );
  });
});

describe("expectApprovalStateTransition", () => {
  it("verifies the approval state machine moved from-to", () => {
    const check = expectApprovalStateTransition({
      description: "approval granted",
      from: "pending",
      to: "approved",
    });
    expect(
      check(
        ctx({
          stateTransitions: [transition({ from: "pending", to: "approved" })],
        }),
      ),
    ).toBeUndefined();
  });

  it("ignores transitions of other subjects even with identical endpoints", () => {
    const check = expectApprovalStateTransition({
      description: "approval granted",
      from: "pending",
      to: "approved",
    });
    const message = check(
      ctx({
        stateTransitions: [
          transition({ subject: "delivery", from: "pending", to: "approved" }),
        ],
      }),
    );
    expect(message).toContain("pending→approved");
    expect(message).toContain("saw 1 transitions");
  });

  it("rejects a matching destination reached from the wrong origin", () => {
    const check = expectApprovalStateTransition({
      description: "approval granted",
      from: "executing",
      to: "approved",
    });
    expect(
      check(
        ctx({
          stateTransitions: [transition({ from: "pending", to: "approved" })],
        }),
      ),
    ).toContain("executing→approved");
  });
});

describe("expectConnectorDispatch", () => {
  it("normalizes channel keys across case and separators", () => {
    const check = expectConnectorDispatch({
      description: "a telegram delivery",
      channel: "TELEGRAM-DM",
    });
    expect(
      check(
        ctx({ connectorDispatches: [dispatch({ channel: "telegram_dm" })] }),
      ),
    ).toBeUndefined();
  });

  it("matches any channel when the filter array is empty", () => {
    const check = expectConnectorDispatch({
      description: "any delivery",
      channel: [],
    });
    expect(
      check(
        ctx({ connectorDispatches: [dispatch({ channel: "carrier-pigeon" })] }),
      ),
    ).toBeUndefined();
  });

  it("filters by fuzzy action name and reports the shortfall", () => {
    const check = expectConnectorDispatch({
      description: "a gmail send",
      channel: "gmail",
      actionName: "gmail_send",
    });
    expect(
      check(
        ctx({
          connectorDispatches: [
            dispatch({ channel: "GMAIL", actionName: "GMAIL_SEND" }),
          ],
        }),
      ),
    ).toBeUndefined();

    const miss = expectConnectorDispatch({
      description: "a slack send",
      channel: ["slack"],
      actionName: "SLACK_SEND",
    });
    const message = miss(
      ctx({
        connectorDispatches: [
          dispatch({ channel: "slack", actionName: undefined }),
        ],
      }),
    );
    expect(message).toContain("at least 1 dispatch(es)");
    expect(message).toContain("saw 0 of 1 total");
  });

  it("counts repeated dispatches toward minCount", () => {
    const check = expectConnectorDispatch({
      description: "fan-out deliveries",
      channel: "email",
      minCount: 2,
    });
    const once = ctx({ connectorDispatches: [dispatch()] });
    expect(check(once)).toContain("at least 2");
    const twice = ctx({ connectorDispatches: [dispatch(), dispatch()] });
    expect(check(twice)).toBeUndefined();
  });

  it("checks payloadIncludesAny against serialized payloads", () => {
    const check = expectConnectorDispatch({
      description: "a welcome delivery",
      channel: "email",
      payloadIncludesAny: ["WELCOME ABOARD", /"tier":\d+/],
    });
    expect(
      check(
        ctx({
          connectorDispatches: [
            dispatch(),
            dispatch({ payload: { tier: 3, note: null } }),
          ],
        }),
      ),
    ).toBeUndefined();

    const miss = expectConnectorDispatch({
      description: "a welcome delivery",
      channel: "email",
      payloadIncludesAny: ["welcome aboard"],
    });
    expect(
      miss(ctx({ connectorDispatches: [dispatch({ payload: undefined })] })),
    ).toContain("dispatch payload to include one of");
  });
});

describe("expectMemoryWrite", () => {
  it("matches tables by exact name only", () => {
    const pass = expectMemoryWrite({
      description: "a durable fact",
      table: "memories",
    });
    expect(pass(ctx({ memoryWrites: [memoryWrite()] }))).toBeUndefined();

    const nearMiss = expectMemoryWrite({
      description: "a durable fact",
      table: "memory",
    });
    expect(nearMiss(ctx({ memoryWrites: [memoryWrite()] }))).toContain(
      "at least 1 memory write(s)",
    );
  });

  it("accepts any table in an array", () => {
    const check = expectMemoryWrite({
      description: "a durable fact",
      table: ["documents", "memories"],
    });
    expect(check(ctx({ memoryWrites: [memoryWrite()] }))).toBeUndefined();
  });

  it("counts writes toward minCount before checking content", () => {
    const check = expectMemoryWrite({
      description: "coffee facts",
      table: "memories",
      minCount: 2,
      contentIncludesAny: [/coffee/, "tea"],
    });
    const short = ctx({
      memoryWrites: [
        memoryWrite(),
        memoryWrite({ table: "documents", content: { fact: "likes coffee" } }),
      ],
    });
    expect(check(short)).toContain("at least 2");

    const satisfied = ctx({
      memoryWrites: [
        memoryWrite({ content: { fact: "likes coffee" } }),
        memoryWrite({ content: { fact: "likes hiking" } }),
      ],
    });
    expect(check(satisfied)).toBeUndefined();
  });

  it("names the missing content alternatives on failure", () => {
    const check = expectMemoryWrite({
      description: "coffee facts",
      table: "memories",
      contentIncludesAny: ["matcha", "oolong"],
    });
    const message = check(ctx({ memoryWrites: [memoryWrite()] }));
    expect(message).toContain(
      "memory content to include one of [matcha, oolong]",
    );
  });
});

describe("expectStateTransition", () => {
  it("matches subject and destination without requiring an origin", () => {
    const check = expectStateTransition({
      description: "delivered",
      subject: "delivery",
      to: "delivered",
    });
    expect(
      check(
        ctx({
          stateTransitions: [
            transition({ subject: "delivery", to: "delivered" }),
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it("enforces the origin when one is expected", () => {
    const check = expectStateTransition({
      description: "delivered",
      subject: "delivery",
      from: "sending",
      to: "delivered",
    });
    expect(
      check(ctx({ stateTransitions: [transition({ subject: "delivery" })] })),
    ).toContain("sending→delivered");
  });

  it("ignores every other subject", () => {
    const check = expectStateTransition({
      description: "needs-human escalation",
      subject: "browser-task",
      to: "needs-human",
    });
    const message = check(
      ctx({
        stateTransitions: [
          transition({ subject: "delivery", to: "needs-human" }),
        ],
      }),
    );
    expect(message).toContain("saw 1 transitions");
  });
});

describe("expectNoSideEffectOnReject", () => {
  it("fails when a rejected action dispatched anyway", () => {
    const check = expectNoSideEffectOnReject({
      description: "rejection holds",
      actionName: "SEND_EMAIL",
    });
    const message = check(
      ctx({
        approvalRequests: [approval({ state: "rejected" })],
        connectorDispatches: [dispatch({ actionName: "send_email" })],
      }),
    );
    expect(message).toContain("should NOT dispatch");
    expect(message).toContain("1 dispatch(es) occurred");
  });

  it("passes while the gate holds for unrelated actions", () => {
    const check = expectNoSideEffectOnReject({
      description: "rejection holds",
      actionName: "SEND_EMAIL",
    });
    expect(
      check(
        ctx({
          approvalRequests: [approval({ state: "rejected" })],
          connectorDispatches: [dispatch({ actionName: "SUMMARIZE_DOC" })],
        }),
      ),
    ).toBeUndefined();
  });

  it("ignores approvals that were never rejected", () => {
    const check = expectNoSideEffectOnReject({
      description: "rejection holds",
      actionName: "SEND_EMAIL",
    });
    expect(
      check(
        ctx({
          approvalRequests: [approval({ state: "approved" })],
          connectorDispatches: [dispatch()],
        }),
      ),
    ).toBeUndefined();
  });

  it("treats family-equivalent dispatches as the rejected action", () => {
    const check = expectNoSideEffectOnReject({
      description: "rejection holds",
      actionName: "CALENDAR_CREATE",
    });
    expect(
      check(
        ctx({
          approvalRequests: [
            approval({ state: "rejected", actionName: "calendar_create" }),
          ],
          connectorDispatches: [
            dispatch({
              actionName: "CALENDAR_CREATE_EVENT",
              channel: "calendar",
            }),
          ],
        }),
      ),
    ).toContain("should NOT dispatch");
  });

  it("narrows the absence claim to the requested channels", () => {
    const check = expectNoSideEffectOnReject({
      description: "rejection holds",
      actionName: "SEND_EMAIL",
      channels: ["SLACK"],
    });
    const offChannelOnly = ctx({
      approvalRequests: [approval({ state: "rejected" })],
      connectorDispatches: [dispatch({ channel: "email" })],
    });
    expect(check(offChannelOnly)).toBeUndefined();

    const onChannel = ctx({
      approvalRequests: [approval({ state: "rejected" })],
      connectorDispatches: [dispatch({ channel: "slack" })],
    });
    expect(check(onChannel)).toContain("should NOT dispatch");
  });
});

describe("judgeRubric", () => {
  it("builds the runner rubric marker from the expectation", () => {
    expect(
      judgeRubric({
        name: "tone",
        description: "replies stay polite and concrete",
        threshold: 0.8,
      }),
    ).toEqual({
      type: "judgeRubric",
      name: "tone",
      rubric: "replies stay polite and concrete",
      minimumScore: 0.8,
    });
  });

  it("falls back to the rubric name when no description is authored", () => {
    expect(judgeRubric({ name: "brevity", threshold: 0.5 })).toEqual({
      type: "judgeRubric",
      name: "brevity",
      rubric: "brevity",
      minimumScore: 0.5,
    });
  });
});
