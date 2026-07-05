/**
 * Screenshot fixture for the #13535 agent-activity surfaces, mounting the REAL
 * shipping components — the Codex-style working indicator (`TurnStatus`) and the
 * inline tool-call row (`ToolCallEventLog`) — across the three states the turn
 * moves through: thinking, tool-running, and settled. Consumed only by
 * `run-activity-feedback-e2e.mjs` (esbuild → headless Chromium), never the app.
 */
import { createRoot } from "react-dom/client";

import type { NativeToolCallEvent } from "../../../api/client-types-cloud";
import { TurnStatus } from "../../composites/chat/chat-typing-indicator";
import { ToolCallEventLog } from "../../tool-events/ToolCallEventLog";

const runningTool: NativeToolCallEvent = {
  id: "call_1",
  callId: "call_1",
  toolName: "WEB_SEARCH",
  type: "tool_call",
  status: "running",
  args: { query: "elizaOS agent activity feedback" },
};

const settledTool: NativeToolCallEvent = {
  id: "call_1",
  callId: "call_1",
  toolName: "WEB_SEARCH",
  type: "tool_result",
  status: "completed",
  args: { query: "elizaOS agent activity feedback" },
  result: { hits: 3, top: "elizaOS/eliza#13535" },
};

function Bubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-[640px] rounded-2xl bg-white/[0.04] px-4 py-3 ring-1 ring-white/10">
      {children}
    </div>
  );
}

function Panel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/40">
        {label}
      </div>
      {children}
    </section>
  );
}

function Fixture() {
  return (
    <div
      data-testid="activity-feedback-fixture"
      className="mx-auto flex max-w-[720px] flex-col gap-8 p-8"
    >
      <Panel label="1 · Thinking (working indicator + elapsed clock)">
        <Bubble>
          <TurnStatus status={{ kind: "thinking" }} showLabel />
        </Bubble>
      </Panel>

      <Panel label="2 · Running a tool (inline row + status line)">
        <Bubble>
          <div className="mb-2">
            <TurnStatus
              status={{ kind: "running_tool", toolName: "WEB_SEARCH" }}
              showLabel
            />
          </div>
          <ToolCallEventLog event={runningTool} />
        </Bubble>
      </Panel>

      <Panel label="3 · Settled (tool result + reply)">
        <Bubble>
          <ToolCallEventLog event={settledTool} />
          <div className="mt-3 text-[15px] leading-relaxed text-white/90">
            I searched the web and found 3 results — the top hit is the
            elizaOS/eliza#13535 activity-feedback issue.
          </div>
        </Bubble>
      </Panel>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
