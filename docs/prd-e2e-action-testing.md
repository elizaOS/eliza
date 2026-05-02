# PRD: E2E Conversation Testing with Action Verification

## Source Requirements

This PRD is based on recordings 47 and 48, but the recordings were exploratory and mixed firm requirements with brainstorming. This summary keeps the stable product expectations that matter for action-level E2E coverage.

### Product Capabilities To Exercise

- Identity and account setup: user-owned and agent-owned Gmail/GitHub accounts, plus secure local login flows.
- Messaging and social connectors: email, Discord, Telegram, X, Signal, iMessage, and similar gateway-style messaging paths.
- Scheduling and coordination: calendar access, meeting negotiation, reminders, alarms, follow-up tracking, and daily planning.
- LifeOps routines: to-dos, habits, recurring reminders, relationship tracking, and morning/night check-ins.
- Local and remote execution: browser tooling, browser automation, computer control, shell access, and remote intervention when the agent needs help.
- Device awareness: Mac and iPhone as primary targets, with shared state across multiple devices.
- Safety and approvals: outbound sends, calls, and other sensitive actions require explicit confirmation; remote access must stay paired and secure.

### Representative User Outcomes

- Triage inbound messages, draft replies, escalate urgent items, and keep follow-ups from going stale.
- Schedule meetings using user preferences and the counterpart's availability.
- Keep daily routines on track with reminders, alarms, and configurable enforcement.
- Surface upcoming commitments with enough context and lead time to act.
- Let the user jump in remotely when the agent hits a browser, auth, or computer-use blocker.

The rest of this document focuses on the test framework needed to verify those action-driven workflows end to end.

---

## Current State Analysis

### What EXISTS for E2E Conversation Testing

| Component | Location | Description |
|-----------|----------|-------------|
| Full runtime E2E | `eliza/packages/app-core/test/live-agent/agent-runtime.live.e2e.test.ts` | Real LLM + PGLite, no mocks. Tests startup, shouldRespond, multi-turn memory, REST API, autonomy, triggers |
| `handleMessageAndCollectText()` | Same file | Helper: sends message to runtime.messageService, collects response text via callback |
| `postChatWithRetries()` | Same file | Helper: sends message via REST API with retry logic |
| PGLite runtime helper | `eliza/packages/app-core/test/helpers/pglite-runtime.ts` | Creates real AgentRuntime with in-process PGLite |
| Real runtime helper | `eliza/packages/app-core/test/helpers/real-runtime.ts` | Extends PGLite with optional real LLM + connectors |
| Live provider selector | `test/helpers/live-provider.ts` | Picks cheapest available LLM provider (Groq > OpenAI > Anthropic > etc.) |
| Conditional tests | `test/helpers/conditional-tests.ts` | `itIf()` for gating tests on env vars/API keys |
| Action unit tests | `eliza/packages/typescript/src/__tests__/actions.test.ts` | Action formatting, example parsing, param extraction — no real LLM |
| Context routing tests | `eliza/packages/typescript/src/__tests__/context-routing.test.ts` | Action filtering by context — mocked runtime |
| Callback history tests | `eliza/packages/agent/src/api/conversation-routes.test.ts` | Action callback dedup, formatting, memory persistence |
| Vitest configs | `test/vitest/*.config.ts` | 7 configs: default, integration, e2e, real, live-e2e, real-qa, unit |
| CI workflow | `.github/workflows/test.yml` | regression-matrix, unit-tests, db-check, desktop-contract, cloud-live-e2e, validation-e2e, ui-playwright-smoke |

### What DOES NOT EXIST (Gaps)

| Gap | Impact |
|-----|--------|
| **No action invocation verification in E2E tests** | We test that the agent responds with text, but never verify it chose and executed the correct action |
| **No `expectActionCalled()` helper** | No reusable assertion for "agent invoked action X with params Y" |
| **No conversation scenario tests** | No tests like "user asks to schedule a meeting → agent calls SCHEDULE action with correct params" |
| **No action selection accuracy benchmarks** | No way to measure if the agent picks the right action N% of the time |
| **No action parameter extraction tests in E2E** | We test XML param parsing in unit tests but never verify the full pipeline extracts correct params from natural language |
| **No multi-action chain tests** | No tests for "user asks complex task → agent chains actions A, B, C in correct order" |
| **No negative action tests** | No tests for "user says X → agent should NOT call action Y" |
| **No action timeout/failure recovery tests** | No tests for what happens when an action fails mid-execution |

### How Action Invocation CAN Be Verified (Existing Mechanisms)

The runtime already provides multiple verification surfaces — they just aren't used in tests:

1. **`runtime.getActionResults(messageId)`** — Returns `ActionResult[]` from in-memory cache
2. **Database memories** — `type: "action_result"`, `content.actionName`, `content.actionStatus`
3. **Database logs** — `type: "action_event"` with `ActionLogBody`
4. **Events** — `ACTION_STARTED` / `ACTION_COMPLETED` with actionName, runId, success status
5. **Callback history** — `Memory.content.actionCallbackHistory` for streaming actions
6. **State cache** — `stateCache[messageId + "_action_results"]` holds full results + plan

---

## PRD: E2E Action Verification Test Framework

### Problem Statement

Eliza is being built as a comprehensive personal assistant with dozens of actions (scheduling, messaging, reminders, to-dos, relationship tracking, browser control, etc.). We have no way to verify in E2E tests that the agent actually invokes the correct action when a user asks it to do something. We can only verify that the agent produced text output — not that it took the right action.

This means:
- We ship action-dependent features (LifeOps reminders, scheduling, message triage) with zero confidence they work end-to-end
- Regressions in action selection go undetected
- LLM prompt changes can silently break action routing
- We can't benchmark action selection accuracy across model providers

### Goals

1. **Verify action invocation**: Given a user message, assert that the agent called a specific action (or set of actions)
2. **Verify action parameters**: Assert that extracted parameters match expectations
3. **Verify action results**: Assert that action execution produced expected outcomes
4. **Support scenario testing**: Multi-turn conversations that exercise action chains
5. **Support negative testing**: Verify the agent does NOT call certain actions
6. **Enable benchmarking**: Measure action selection accuracy across providers/prompts
7. **Run in CI**: Tests must work with real LLM (Groq for cost) and PGLite

### Non-Goals

- UI testing (covered by Playwright)
- Action handler unit testing (already exists)
- Mock-based action testing (against project philosophy)
- Testing every possible user utterance (use benchmarks for that)

---

## Implementation Plan

### Phase 1: Action Assertion Helpers

**Files to create/modify:**

#### 1.1 `test/helpers/action-assertions.ts` (NEW)

Core assertion utilities that leverage existing runtime mechanisms:

```typescript
import type { AgentRuntime, UUID, ActionResult, Memory } from "@elizaos/core";

export interface ActionInvocation {
  actionName: string;
  actionStatus: "success" | "failed" | string;
  params?: Record<string, unknown>;
  result?: ActionResult;
  runId?: string;
  timestamp?: number;
}

/**
 * After handleMessage completes, query the runtime for action invocations
 * that occurred during processing of the given message.
 */
export async function getActionInvocations(
  runtime: AgentRuntime,
  roomId: UUID,
  sinceTimestamp: number,
): Promise<ActionInvocation[]> {
  // Query action_result memories created after sinceTimestamp
  const memories = await runtime.getMemories({
    roomId,
    tableName: "messages",
    count: 50,
  });

  return memories
    .filter(
      (m) =>
        m.content.type === "action_result" &&
        m.content.actionName &&
        (m.createdAt ?? 0) >= sinceTimestamp,
    )
    .map((m) => ({
      actionName: m.content.actionName as string,
      actionStatus: (m.content.actionStatus as string) ?? "unknown",
      params: m.content.data as Record<string, unknown> | undefined,
      runId: m.content.runId as string | undefined,
      timestamp: m.createdAt,
    }));
}

/**
 * Assert that a specific action was called during message processing.
 */
export function expectActionCalled(
  invocations: ActionInvocation[],
  actionName: string,
  opts?: {
    status?: "success" | "failed";
    params?: Record<string, unknown>;
  },
): ActionInvocation {
  const normalized = actionName.trim().toUpperCase().replace(/_/g, "");
  const match = invocations.find(
    (inv) => inv.actionName.trim().toUpperCase().replace(/_/g, "") === normalized,
  );

  if (!match) {
    const called = invocations.map((i) => i.actionName).join(", ") || "(none)";
    throw new Error(
      `Expected action "${actionName}" to be called, but only these were: ${called}`,
    );
  }

  if (opts?.status) {
    expect(match.actionStatus).toBe(opts.status);
  }

  if (opts?.params) {
    for (const [key, value] of Object.entries(opts.params)) {
      expect(match.params?.[key]).toEqual(value);
    }
  }

  return match;
}

/**
 * Assert that a specific action was NOT called.
 */
export function expectActionNotCalled(
  invocations: ActionInvocation[],
  actionName: string,
): void {
  const normalized = actionName.trim().toUpperCase().replace(/_/g, "");
  const match = invocations.find(
    (inv) => inv.actionName.trim().toUpperCase().replace(/_/g, "") === normalized,
  );

  if (match) {
    throw new Error(
      `Expected action "${actionName}" NOT to be called, but it was (status: ${match.actionStatus})`,
    );
  }
}

/**
 * Assert that actions were called in a specific order.
 */
export function expectActionOrder(
  invocations: ActionInvocation[],
  actionNames: string[],
): void {
  const sorted = [...invocations].sort(
    (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
  );
  const actualNames = sorted.map((i) =>
    i.actionName.trim().toUpperCase().replace(/_/g, ""),
  );
  const expectedNames = actionNames.map((n) =>
    n.trim().toUpperCase().replace(/_/g, ""),
  );

  for (let i = 0; i < expectedNames.length; i++) {
    const idx = actualNames.indexOf(expectedNames[i]);
    if (idx === -1) {
      throw new Error(
        `Expected action "${actionNames[i]}" in sequence but it was not called`,
      );
    }
    if (i > 0) {
      const prevIdx = actualNames.indexOf(expectedNames[i - 1]);
      if (idx <= prevIdx) {
        throw new Error(
          `Expected "${actionNames[i]}" after "${actionNames[i - 1]}" but order was wrong`,
        );
      }
    }
  }
}
```

#### 1.2 `test/helpers/conversation-harness.ts` (NEW)

Higher-level harness for multi-turn conversation testing:

```typescript
import type { AgentRuntime, UUID } from "@elizaos/core";
import { createMessageMemory, ChannelType, stringToUuid } from "@elizaos/core";
import crypto from "node:crypto";
import { getActionInvocations, type ActionInvocation } from "./action-assertions";
import { withTimeout } from "./test-utils";

export interface ConversationTurn {
  text: string;
  responseText: string;
  actions: ActionInvocation[];
  timestamp: number;
}

export class ConversationHarness {
  private runtime: AgentRuntime;
  private roomId: UUID;
  private userId: UUID;
  private worldId: UUID;
  private turns: ConversationTurn[] = [];

  constructor(
    runtime: AgentRuntime,
    opts?: { roomId?: UUID; userId?: UUID; worldId?: UUID },
  ) {
    this.runtime = runtime;
    this.roomId = opts?.roomId ?? (crypto.randomUUID() as UUID);
    this.userId = opts?.userId ?? (crypto.randomUUID() as UUID);
    this.worldId = opts?.worldId ?? stringToUuid("test-world");
  }

  async setup(): Promise<void> {
    await this.runtime.ensureConnection({
      entityId: this.userId,
      roomId: this.roomId,
      worldId: this.worldId,
      userName: "TestUser",
      source: "test",
      channelId: this.roomId,
      type: ChannelType.DM,
    });
  }

  async send(
    text: string,
    opts?: { timeoutMs?: number },
  ): Promise<ConversationTurn> {
    const beforeTimestamp = Date.now();
    let responseText = "";

    const msg = createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId: this.userId,
      roomId: this.roomId,
      content: {
        text,
        source: "test",
        channelType: ChannelType.DM,
      },
    });

    const result = await withTimeout(
      Promise.resolve(
        this.runtime.messageService?.handleMessage(
          this.runtime,
          msg,
          async (content: { text?: string }) => {
            if (content.text) responseText += content.text;
            return [];
          },
        ),
      ),
      opts?.timeoutMs ?? 90_000,
      "handleMessage",
    );

    if (!responseText && result?.responseContent?.text) {
      responseText = result.responseContent.text;
    }

    // Give a moment for action memories to persist
    await new Promise((r) => setTimeout(r, 500));

    const actions = await getActionInvocations(
      this.runtime,
      this.roomId,
      beforeTimestamp,
    );

    const turn: ConversationTurn = {
      text,
      responseText,
      actions,
      timestamp: beforeTimestamp,
    };

    this.turns.push(turn);
    return turn;
  }

  getTurns(): ConversationTurn[] {
    return this.turns;
  }

  getLastTurn(): ConversationTurn | undefined {
    return this.turns[this.turns.length - 1];
  }
}
```

### Phase 2: Action Scenario Test Suite

**File:** `eliza/packages/app-core/test/live-agent/action-invocation.live.e2e.test.ts` (NEW)

This test suite verifies that the agent correctly selects and executes actions in response to natural language:

```typescript
// Test structure (pseudocode for PRD purposes):

describe("Action Invocation E2E", () => {
  // Shared runtime setup (same pattern as agent-runtime.live.e2e.test.ts)

  describe("action selection", () => {
    it("personality update triggers MODIFY_CHARACTER action", async () => {
      const turn = await convo.send("Change your personality to be more concise");
      expectActionCalled(turn.actions, "MODIFY_CHARACTER", { status: "success" });
    });

    it("asking a question does NOT trigger any action", async () => {
      const turn = await convo.send("What is the capital of France?");
      expect(turn.actions).toHaveLength(0);
      expect(turn.responseText.length).toBeGreaterThan(0);
    });
  });

  describe("multi-turn action chains", () => {
    it("follow-up message references prior action context", async () => {
      await convo.send("Create a todo called 'Test PRD review'");
      const turn2 = await convo.send("Mark that todo as high priority");
      // Both turns should have invoked todo-related actions
    });
  });

  describe("action parameter extraction", () => {
    it("extracts contact name from natural language", async () => {
      const turn = await convo.send("Add John Smith to my contacts");
      expectActionCalled(turn.actions, "ADD_CONTACT", { status: "success" });
      // Verify params include extracted name
    });
  });

  describe("negative cases", () => {
    it("does not call SEND_MESSAGE for a simple greeting", async () => {
      const turn = await convo.send("Hey, how are you?");
      expectActionNotCalled(turn.actions, "SEND_MESSAGE");
    });
  });
});
```

### Phase 3: Event-Based Action Spy

For cases where database persistence is slow or unreliable, add an event-based spy:

**File:** `test/helpers/action-spy.ts` (NEW)

```typescript
import type { AgentRuntime } from "@elizaos/core";

export interface SpiedAction {
  name: string;
  status: "started" | "completed";
  success?: boolean;
  timestamp: number;
  runId?: string;
  data?: unknown;
}

export class ActionSpy {
  private actions: SpiedAction[] = [];
  private cleanup: (() => void) | null = null;

  attach(runtime: AgentRuntime): void {
    // Subscribe to ACTION_STARTED and ACTION_COMPLETED events
    const onStarted = (payload: unknown) => {
      this.actions.push({
        name: extractActionName(payload),
        status: "started",
        timestamp: Date.now(),
        runId: extractRunId(payload),
      });
    };

    const onCompleted = (payload: unknown) => {
      this.actions.push({
        name: extractActionName(payload),
        status: "completed",
        success: extractSuccess(payload),
        timestamp: Date.now(),
        runId: extractRunId(payload),
        data: extractData(payload),
      });
    };

    runtime.on("ACTION_STARTED", onStarted);
    runtime.on("ACTION_COMPLETED", onCompleted);

    this.cleanup = () => {
      runtime.off("ACTION_STARTED", onStarted);
      runtime.off("ACTION_COMPLETED", onCompleted);
    };
  }

  detach(): void {
    this.cleanup?.();
    this.cleanup = null;
  }

  clear(): void {
    this.actions = [];
  }

  getActions(): SpiedAction[] {
    return [...this.actions];
  }

  getCompletedActions(): SpiedAction[] {
    return this.actions.filter((a) => a.status === "completed");
  }

  wasActionCalled(name: string): boolean {
    const normalized = name.trim().toUpperCase().replace(/_/g, "");
    return this.actions.some(
      (a) =>
        a.status === "completed" &&
        a.name.trim().toUpperCase().replace(/_/g, "") === normalized,
    );
  }
}
```

### Phase 4: Benchmarking & Eval Framework

For measuring action selection accuracy at scale (not per-commit CI, but periodic eval):

**File:** `test/benchmarks/action-selection-benchmark.ts` (NEW)

```typescript
interface ActionBenchmarkCase {
  id: string;
  userMessage: string;
  expectedAction: string | null; // null = no action expected
  expectedParams?: Record<string, unknown>;
  tags: string[]; // e.g., ["scheduling", "critical", "regression"]
}

const BENCHMARK_CASES: ActionBenchmarkCase[] = [
  {
    id: "schedule-meeting-basic",
    userMessage: "Schedule a meeting with John tomorrow at 3pm",
    expectedAction: "SCHEDULE_MEETING",
    expectedParams: { contactName: "John" },
    tags: ["scheduling", "critical"],
  },
  {
    id: "greeting-no-action",
    userMessage: "Hey, good morning!",
    expectedAction: null,
    tags: ["negative", "basic"],
  },
  {
    id: "todo-create",
    userMessage: "Add 'buy groceries' to my to-do list",
    expectedAction: "LIFE",
    expectedParams: { subaction: "create" },
    tags: ["todos", "critical"],
  },
  // ... many more cases covering LifeOps features
];

// Runner produces accuracy report:
// - Overall accuracy: N%
// - Per-tag accuracy: scheduling=85%, todos=92%, ...
// - Failures: list of cases where wrong action was chosen
// - Latency: avg/p50/p95 per action selection
```

### Phase 5: Plugin-Specific Action Tests

For each major feature area from the recordings, add targeted action tests:

| Feature Area | Actions to Test | Priority |
|-------------|----------------|----------|
| **To-Do Management** | LIFE (`create`, `update`, `complete`, `list`) | P0 |
| **Reminders** | LIFE (`create`, `list`, `complete`, `snooze`) | P0 |
| **Personality** | MODIFY_CHARACTER, UPDATE_RESPONSE_STYLE | P0 (exists partially) |
| **Contacts/Rolodex** | ADD_CONTACT, SEARCH_CONTACTS | P1 |
| **Messaging** | SEND_MESSAGE, DRAFT_MESSAGE, TRIAGE_MESSAGES | P1 |
| **Calendar** | SCHEDULE_MEETING, CHECK_CALENDAR, CANCEL_MEETING | P1 |
| **LifeOps Routines** | LIFE, RUN_MORNING_CHECKIN, RUN_NIGHT_CHECKIN | P2 |
| **Browser/Computer** | BROWSE_URL, COMPUTER_ACTION | P2 |
| **Social Media** | SEARCH_X, SUMMARIZE_FEED, SEND_DM | P3 |

---

## Execution Plan

### Sprint 1 (Week 1-2): Foundation
1. Create `test/helpers/action-assertions.ts`
2. Create `test/helpers/conversation-harness.ts`
3. Create `test/helpers/action-spy.ts`
4. Write 5 basic action invocation tests using existing actions (MODIFY_CHARACTER, ADD_CONTACT, etc.)
5. Verify tests pass with Groq in CI

### Sprint 2 (Week 3-4): Coverage
1. Add 15+ action scenario tests covering all P0 features
2. Add multi-turn conversation tests
3. Add negative case tests
4. Add action parameter extraction verification
5. Update CI workflow to include action-invocation tests

### Sprint 3 (Week 5-6): Benchmarking
1. Create benchmark case library (50+ cases)
2. Build benchmark runner with accuracy reporting
3. Run baseline benchmarks across Groq/OpenAI/Anthropic
4. Set up nightly benchmark runs
5. Add benchmark results to PR comments

### Sprint 4 (Week 7-8): LifeOps-Specific
1. Add LifeOps action tests (reminders, routines, tracking)
2. Add scheduling/calendar action tests
3. Add messaging triage action tests
4. Add multi-device scenario tests (simulated)
5. Integration with the features described in recordings

---

## Test Configuration

### Vitest Config Addition

Add to `test/vitest/e2e.config.ts`:
```typescript
// Action invocation tests (subset of live-e2e)
// Include: *.action.live.e2e.test.ts
```

### CI Additions

Add to `.github/workflows/test.yml`:
```yaml
action-e2e:
  name: "Action Invocation E2E"
  needs: [regression-matrix]
  timeout-minutes: 30
  env:
    ELIZA_LIVE_TEST: "1"
    GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
  steps:
    - run: bun run test:e2e:actions
```

### New npm scripts

```json
{
  "test:e2e:actions": "vitest run --config test/vitest/e2e.config.ts --testPathPattern action-invocation",
  "test:benchmark:actions": "vitest run --config test/vitest/real.config.ts --testPathPattern action-selection-benchmark"
}
```

---

## Success Criteria

1. **Action assertion helpers** are reusable and tested
2. **20+ action scenario tests** pass in CI with Groq
3. **Conversation harness** supports multi-turn with action tracking
4. **Negative tests** verify the agent doesn't call wrong actions
5. **Benchmark framework** produces accuracy reports
6. **CI integration** catches action selection regressions on every PR
7. **Documentation** covers how to add new action tests

## Risk Factors

| Risk | Mitigation |
|------|-----------|
| LLM non-determinism | Use retry logic, accept fuzzy matches, run benchmarks with statistical thresholds |
| Groq rate limits | Use `selectLiveProvider()` fallback chain, add backoff |
| Slow tests | Parallelize independent scenarios, share runtime (PGLite constraint) |
| Actions not registered | Pre-check `runtime.actions` in beforeAll, skip if missing |
| Action param formats change | Use flexible matching, not exact equality |
