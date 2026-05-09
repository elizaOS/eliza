import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeDecisionWithTurnOutput,
  completionReasoningFromTurnOutput,
  executeDecision,
  isCompletingWithCapturedOutput,
  isMissingPtySessionError,
  shouldIgnoreStoppedEventDuringCompletion,
  taskAgentFailureReasonFromTurnOutput,
  uniqueSummaryParts,
} from "../services/swarm-decision-loop.js";
import { validateTaskCompletion } from "../services/task-validation.js";

vi.mock("../services/task-validation.js", () => ({
  validateTaskCompletion: vi.fn(),
}));

const mockedValidateTaskCompletion = vi.mocked(validateTaskCompletion);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("completionReasoningFromTurnOutput", () => {
  it("uses the subagent output instead of internal assessor diagnostics", () => {
    expect(
      completionReasoningFromTurnOutput(
        "Asset price is $101,234.56 USD from Market API as of 2026-05-07 10:55 UTC.",
      ),
    ).toBe(
      "Asset price is $101,234.56 USD from Market API as of 2026-05-07 10:55 UTC.",
    );
  });

  it("keeps artifact summaries when the task produced a PR", () => {
    expect(
      completionReasoningFromTurnOutput(
        "Done\nhttps://github.com/elizaOS/eliza/pull/7459\n",
      ),
    ).toBe("https://github.com/elizaOS/eliza/pull/7459");
  });

  it("keeps ordinary completion text with public URLs readable", () => {
    expect(
      completionReasoningFromTurnOutput(
        "Built the app at https://example.com/apps/breath-orbit/ and verified it returns 200.",
      ),
    ).toBe(
      "Built the app at https://example.com/apps/breath-orbit/ and verified it returns 200.",
    );
  });

  it("does not surface raw patch/source dumps as the final chat answer", () => {
    expect(
      completionReasoningFromTurnOutput(`+ if (state.phase >= phases.length) state.phase = 0;
+ const phase = phases[state.phase];
+ const duration = settings[phase.key];
+ const progress = Math.min(1, Math.max(0, state.elapsed / duration));
+ const remaining = Math.max(0, Math.ceil(duration - state.elapsed));
+ orbit.style.setProperty("--progress", progress.toFixed(4));
+ orbit.style.setProperty("--breath-scale", phase.scale(progress).toFixed(4));
+ phaseName.textContent = state.done ? "Complete" : phase.label;
+ chips.forEach((chip) => {
+   chip.classList.toggle("active", chip.dataset.chip === phase.key);
+ });`),
    ).toBe(
      "Task agent completed but did not produce a user-facing final summary.",
    );
  });

  it("preserves a Codex final answer block with verification details", () => {
    expect(
      completionReasoningFromTurnOutput(`exec
/bin/bash -lc 'git diff'
 succeeded in 0ms:
diff --git a/app.js b/app.js
+ const noisy = true;

codex
Built the static breathing timer at \`data/apps/breath-ring/\`.

URL: https://example.com/apps/breath-ring/

Verified:
- \`node --check data/apps/breath-ring/app.js\`
- public URL returned \`200\`

diff --git a/data/apps/breath-ring/app.js b/data/apps/breath-ring/app.js
+ const after = true;
tokens used
79,074`),
    ).toBe(`Built the static breathing timer at \`data/apps/breath-ring/\`.

URL: https://example.com/apps/breath-ring/

Verified:
- \`node --check data/apps/breath-ring/app.js\`
- public URL returned \`200\``);
  });

  it("keeps structured URL and verification blocks without duplicating URLs", () => {
    expect(
      completionReasoningFromTurnOutput(`Built the static breathing timer at \`data/apps/breath-ring/\`.

URL: https://example.com/apps/breath-ring/

Verified:
- \`node --check data/apps/breath-ring/app.js\`
- public URL returned \`200\`

https://example.com/apps/breath-ring/`),
    ).toBe(`Built the static breathing timer at \`data/apps/breath-ring/\`.

URL: https://example.com/apps/breath-ring/

Verified:
- \`node --check data/apps/breath-ring/app.js\`
- public URL returned \`200\``);
  });

  it("deduplicates labeled and bare URL fallback summaries", () => {
    expect(
      completionReasoningFromTurnOutput(`URL: https://example.com/apps/breath-ring/
https://example.com/apps/breath-ring/`),
    ).toBe("URL: https://example.com/apps/breath-ring/");
  });
});

describe("taskAgentFailureReasonFromTurnOutput", () => {
  it("summarizes Codex auth failures without dumping raw terminal output", () => {
    expect(
      taskAgentFailureReasonFromTurnOutput(
        "failed to connect to websocket: HTTP error: 401 Unauthorized\nSet OPENAI_API_KEY environment variable or provide credentials in adapterConfig",
      ),
    ).toBe("Task agent failed to authenticate before completing.");
  });
});

describe("executeDecision", () => {
  it("keeps a task active when validation requests a revision", async () => {
    mockedValidateTaskCompletion.mockResolvedValueOnce({
      verdict: "revise",
      summary: "The task still needs a final PR link.",
      followUpPrompt: "Continue and report the final PR link.",
      reportPath: "",
      artifacts: [],
    });

    const sessionId = "pty-test";
    const taskCtx = {
      agentType: "codex",
      completionSummary: "",
      label: "agent-test",
      originalTask: "make a small docs PR",
      status: "active",
      threadId: "thread-test",
      workdir: "/repo",
    };
    const stopSession = vi.fn(async () => undefined);
    const sendToSession = vi.fn(async () => undefined);
    const updateThreadSummary = vi.fn(async () => undefined);
    const broadcast = vi.fn();
    const ctx = {
      broadcast,
      log: vi.fn(),
      ptyService: {
        getSessionOutput: vi.fn(async () => "I am checking the final PR."),
        sendToSession,
        stopSession,
      },
      syncTaskContext: vi.fn(async () => undefined),
      taskRegistry: {
        appendEvent: vi.fn(async () => undefined),
        getSession: vi.fn(async () => null),
        updateThreadSummary,
      },
      tasks: new Map([[sessionId, taskCtx]]),
    };

    await executeDecision(ctx as never, sessionId, {
      action: "complete",
      reasoning: "I am checking the final PR.",
    });

    expect(sendToSession).toHaveBeenCalledWith(
      sessionId,
      "Continue and report the final PR link.",
    );
    expect(stopSession).not.toHaveBeenCalled();
    expect(taskCtx.status).toBe("active");
    expect(updateThreadSummary).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "task_complete" }),
    );
  });
});

describe("completeDecisionWithTurnOutput", () => {
  it("uses the subagent final output for complete decisions", () => {
    expect(
      completeDecisionWithTurnOutput(
        {
          action: "complete",
          reasoning: "Accept the agent's reported value and source as final.",
          keyDecision: "Accept the agent's reported value and source as final.",
        },
        "Asset price is $81,000 USD from Market API at 2026-05-07T12:09:23Z.",
      ),
    ).toMatchObject({
      action: "complete",
      reasoning:
        "Asset price is $81,000 USD from Market API at 2026-05-07T12:09:23Z.",
      keyDecision:
        "Asset price is $81,000 USD from Market API at 2026-05-07T12:09:23Z.",
    });
  });

  it("does not rewrite non-complete decisions", () => {
    const decision = {
      action: "respond" as const,
      response: "continue",
      reasoning: "Needs another turn.",
    };

    expect(completeDecisionWithTurnOutput(decision, "final output")).toBe(
      decision,
    );
  });
});

describe("completion synthesis guards", () => {
  it("treats tool_running with captured output as completion in progress", () => {
    expect(
      isCompletingWithCapturedOutput({
        status: "tool_running",
        completionSummary: "final answer",
      }),
    ).toBe(true);
    expect(
      isCompletingWithCapturedOutput({
        status: "tool_running",
        completionSummary: "   ",
      }),
    ).toBe(false);
    expect(
      isCompletingWithCapturedOutput({
        status: "active",
        completionSummary: "final answer",
      }),
    ).toBe(false);
  });

  it("ignores session-end stopped events while completion assessment is in flight", () => {
    expect(
      shouldIgnoreStoppedEventDuringCompletion({
        task: { status: "active" },
        hasInFlightDecision: true,
        hasPendingTurnComplete: false,
      }),
    ).toBe(true);
    expect(
      shouldIgnoreStoppedEventDuringCompletion({
        task: { status: "tool_running" },
        hasInFlightDecision: false,
        hasPendingTurnComplete: true,
      }),
    ).toBe(true);
    expect(
      shouldIgnoreStoppedEventDuringCompletion({
        task: { status: "active" },
        hasInFlightDecision: false,
        hasPendingTurnComplete: false,
      }),
    ).toBe(false);
  });

  it("recognizes missing PTY session errors for completion finalization", () => {
    expect(
      isMissingPtySessionError(new Error("Session pty-123 not found")),
    ).toBe(true);
    expect(
      isMissingPtySessionError(new Error("Session pty-123 is blocked")),
    ).toBe(false);
    expect(isMissingPtySessionError("Session pty-123 not found")).toBe(false);
  });

  it("deduplicates identical completion summaries", () => {
    expect(
      uniqueSummaryParts(["Asset $81k", " Asset   $81k ", "other"]),
    ).toEqual(["Asset $81k", "other"]);
  });

  it("deduplicates partial and complete versions of the same summary", () => {
    const partial = [
      "Disk check: urgent. `/` is 97% used (`372G/387G`, only `15G` free), so this VPS needs cleanup soon.",
      "`df -h` source:",
      "```text",
      "/dev/sda1 387G 372G 15G 97% /",
    ].join("\n");
    const complete = [
      "Disk check: urgent. `/` is 97% used (`372G/387G`, only `15G` free), so this VPS needs cleanup soon.",
      "`df -h` source:",
      "```text",
      "/dev/sda1  387G  372G  15G  97%  /",
      "```",
    ].join("\n");

    expect(uniqueSummaryParts([partial, complete])).toEqual([
      `${partial}\n\`\`\``,
    ]);
    expect(uniqueSummaryParts([complete, partial])).toEqual([complete]);
  });

  it("deduplicates equivalent table summaries with different markdown table syntax", () => {
    const tableWithoutSeparator = [
      "Filesystem summary:",
      "| Mount | Size | Used | Avail | Use% |",
      "| `/` | 100G | 92G | 8G | 92% |",
      "| `/boot` | 1G | 90M | 910M | 9% |",
      "Assessment: root needs cleanup soon.",
    ].join("\n");
    const tableWithSeparator = [
      "Filesystem summary:",
      "",
      "| Mount | Size | Used | Avail | Use% |",
      "|---|---:|---:|---:|---:|",
      "| `/` | 100G | 92G | 8G | 92% |",
      "| `/boot` | 1G | 90M | 910M | 9% |",
      "",
      "Assessment: root needs cleanup soon.",
    ].join("\n");

    expect(
      uniqueSummaryParts([tableWithoutSeparator, tableWithSeparator]),
    ).toEqual([
      [
        "Filesystem summary:",
        "- `/`: Size: 100G, Used: 92G, Avail: 8G, Use%: 92%",
        "- `/boot`: Size: 1G, Used: 90M, Avail: 910M, Use%: 9%",
        "Assessment: root needs cleanup soon.",
      ].join("\n"),
    ]);
  });
});
