/** A local developer shell around the existing App, under its one AppProvider. */
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { client } from "../../api/client";
import type {
  TrajectoryDetailResult,
  TrajectoryLlmCall,
  TrajectoryRecord,
} from "../../api/client-types-cloud";
import { useActiveAgentAuthority } from "../../hooks/useActiveAgentAuthority";
import "../../styles/developer-workspace.css";
import { useAppSelectorShallow } from "../../state/app-store";
import { useChatComposer } from "../../state/ChatComposerContext.hooks";
import { useConversationMessages } from "../../state/ConversationMessagesContext.hooks";
import { deriveAgentReady } from "../../state/types";
import { AddAccountDialog } from "../accounts/AddAccountDialog";
import { OwnerOnlyNotice, RoleGate } from "../RoleGate";
import { ModelConfigurationPanel } from "../settings/ModelConfigurationPanel";
import { Button } from "../ui/button";
import { SemanticForm } from "../ui/semantic-form";
import { Textarea } from "../ui/textarea";
import {
  trajectoryRevision,
  useDeveloperTrajectories,
} from "./useDeveloperTrajectories";

const count = (value: number | null | undefined) =>
  typeof value === "number" ? value.toLocaleString() : "—";
const duration = (value: number | null | undefined) =>
  typeof value === "number" ? `${(value / 1000).toFixed(2)}s` : "—";

export function callLane(call: TrajectoryLlmCall, source: string): string {
  if (source === "background_memory") return "Background memory";
  if (call.purpose === "evaluation") return "Post-turn evaluation";
  return source === "client_chat" ? "Foreground" : source;
}

function recordedStage(
  call: TrajectoryLlmCall,
  detail: TrajectoryDetailResult,
): string {
  const containing = detail.semanticStages?.filter(
    (stage) =>
      call.timestamp >= stage.startedAt && call.timestamp <= stage.endedAt,
  );
  containing?.sort(
    (a, b) => a.endedAt - a.startedAt - (b.endedAt - b.startedAt),
  );
  return containing?.[0]?.kind || call.purpose || call.stepType || "Model";
}

/** Pure recorded-data view, shared by the workspace and its visual fixtures. */
export function DeveloperTrace({
  record,
  detail,
}: {
  record: TrajectoryRecord;
  detail: TrajectoryDetailResult;
}) {
  const foreground = detail.llmCalls.filter(
    (call) => callLane(call, record.source) === "Foreground",
  );
  const knownInputs = foreground.reduce(
    (total, call) => total + (call.promptTokens ?? 0),
    0,
  );
  const missingUsage = foreground.some((call) => call.promptTokens == null);
  const hasMeasuredInputs = foreground.some(
    (call) => call.promptTokens != null,
  );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 border-y border-border py-3">
        <div>
          <div className="text-xs text-muted">Recorded calls</div>
          <div className="text-lg tabular-nums">{detail.llmCalls.length}</div>
        </div>
        <div>
          <div className="text-xs text-muted">
            Foreground input
            {missingUsage && hasMeasuredInputs ? " (partial)" : ""}
          </div>
          <div className="text-lg tabular-nums">
            {record.source === "client_chat"
              ? !hasMeasuredInputs
                ? "Unknown"
                : `${count(knownInputs)}${missingUsage ? "+" : ""}`
              : "—"}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted">Run duration</div>
          <div className="text-lg tabular-nums">
            {duration(record.durationMs)}
          </div>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        Usage is recorded provider usage; missing values are unknown. Run
        duration can include post-turn evaluation. Stage spans overlap and must
        not be added. HTTP attempts, queue time and provider first-token timing
        are not measured here.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="pb-2 text-left font-medium">
            Model calls · {record.status}
          </caption>
          <thead className="text-muted">
            <tr>
              <th className="py-2 pr-3">Call / route</th>
              <th className="pr-3 text-right">Input</th>
              <th className="pr-3 text-right">Output</th>
              <th className="text-right">Time</th>
            </tr>
          </thead>
          <tbody>
            {detail.llmCalls.map((call, index) => (
              <tr
                key={call.id || index}
                className="border-t border-border align-top"
              >
                <td className="py-3 pr-3">
                  <div className="font-medium">
                    {index + 1}. {recordedStage(call, detail)}
                  </div>
                  <div className="mt-1 break-all text-muted">
                    {call.provider || "Provider not recorded"} / {call.model}
                  </div>
                  <div className="mt-1 text-muted">
                    {callLane(call, record.source)}
                  </div>
                </td>
                <td className="py-3 pr-3 text-right tabular-nums">
                  {count(call.promptTokens)}
                  {call.tokenUsageEstimated ? " ≈" : ""}
                  <div className="mt-1 whitespace-nowrap text-muted">
                    {count(call.cacheReadInputTokens)} cached
                  </div>
                </td>
                <td className="py-3 pr-3 text-right tabular-nums">
                  {count(call.completionTokens)}
                </td>
                <td className="py-3 text-right tabular-nums">
                  {duration(call.latencyMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail.semanticStages?.length ? (
        <details>
          <summary className="cursor-pointer py-2 text-sm font-medium">
            Recorded stages ({detail.semanticStages.length})
          </summary>
          <ol className="space-y-2 py-2 text-xs">
            {detail.semanticStages.map((stage) => (
              <li key={stage.stageId} className="flex justify-between gap-3">
                <span>
                  {stage.kind}
                  {stage.iteration == null
                    ? ""
                    : ` · iteration ${stage.iteration}`}
                </span>
                <span className="tabular-nums text-muted">
                  {duration(stage.latencyMs)}
                </span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      <div className="break-all text-xs text-muted">
        Run: {record.id}
        <br />
        Trace: {String(record.metadata?.traceId ?? "Not recorded")}
        <br />
        Message: {String(record.metadata?.messageId ?? "Not recorded")}
        <br />
        Room: {record.roomId ?? "Not recorded"}
      </div>
    </div>
  );
}

function WireEvidence({ record }: { record: TrajectoryRecord }) {
  const [open, setOpen] = useState(false);
  const [wire, setWire] = useState<TrajectoryDetailResult | null>(null);
  const [error, setError] = useState(false);
  const [part, setPart] = useState("0");
  const revision = trajectoryRevision(record);
  useEffect(() => {
    if (!open || !revision) return;
    const controller = new AbortController();
    setError(false);
    setWire(null);
    void client
      .getTrajectoryDetail(record.id, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setWire(result);
      })
      .catch(() => {
        // error-policy:J4 An unavailable evidence read is shown inline.
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [open, record.id, revision]);
  const evidence = useMemo(() => {
    if (!wire) return "";
    const stage = wire.semanticStages?.[Number(part)];
    return JSON.stringify(part === "all" || !stage ? wire : stage, null, 2);
  }, [wire, part]);
  return (
    <details
      className="border-t border-border pt-2"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer py-2 text-sm font-medium">
        Full prompts, tools, results &amp; context
      </summary>
      {open ? (
        <div className="space-y-3 py-2">
          <p className="text-xs text-muted">
            Full recorded evidence, loaded on demand. This can be large and
            contain private conversation content. No prompt truncation is
            applied.
          </p>
          {wire ? (
            <label className="block text-xs text-muted">
              Evidence section
              <select
                className="mt-2 block min-h-10 w-full rounded-md border border-border bg-bg px-2 text-txt"
                value={part}
                onChange={(event) => setPart(event.target.value)}
              >
                {wire.semanticStages?.map((stage, index) => (
                  <option key={stage.stageId} value={String(index)}>
                    {index + 1}. {stage.kind}
                  </option>
                ))}
                <option value="all">Entire recorded run</option>
              </select>
            </label>
          ) : null}
          {error ? (
            <p role="alert">
              Evidence could not be loaded. Close and reopen to retry.
            </p>
          ) : wire ? (
            <section
              className="max-h-[60dvh] overflow-auto rounded-md bg-bg p-3 text-xs leading-relaxed"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the full evidence region.
              tabIndex={0}
              aria-label="Full trajectory JSON"
            >
              <pre>{evidence}</pre>
            </section>
          ) : (
            <p role="status">Loading recorded evidence…</p>
          )}
        </div>
      ) : null}
    </details>
  );
}

function DeveloperSettings() {
  const [addKey, setAddKey] = useState(false);
  const [route, setRoute] = useState<string>("Loading configured route…");
  useEffect(() => {
    const controller = new AbortController();
    void client
      .getModelsConfig({ signal: controller.signal })
      .then((config) => {
        if (!controller.signal.aborted)
          setRoute(
            config.activeChat
              ? `${config.activeChat.provider} · ${config.activeChat.endpoint}`
              : "Active route not reported",
          );
      })
      .catch(() => {
        // error-policy:J4 Configuration availability is shown without guessing routing.
        if (!controller.signal.aborted)
          setRoute("Configured route unavailable");
      });
    return () => controller.abort();
  }, []);
  return (
    <RoleGate minRole="OWNER" fallback={<OwnerOnlyNotice />}>
      <div className="space-y-4">
        <div>
          <h2 className="text-sm font-medium">Cerebras connection</h2>
          <p className="mt-1 text-xs text-muted">Configured route: {route}</p>
        </div>
        <p className="text-xs leading-relaxed text-muted">
          Uses this Eliza instance’s server-side credentials and routing. Any
          configured fallback still applies; inspect each recorded call for the
          provider actually used.
        </p>
        <Button variant="outline" onClick={() => setAddKey(true)}>
          Add Cerebras API key
        </Button>
        <ModelConfigurationPanel
          activeChatProvider="cerebras"
          showCodingModels={false}
        />
        <AddAccountDialog
          open={addKey}
          providerId="cerebras-api"
          onClose={() => setAddKey(false)}
          onCreated={() => setAddKey(false)}
        />
      </div>
    </RoleGate>
  );
}

function DeveloperLatestReply() {
  const { conversationMessages } = useConversationMessages();
  let reply: (typeof conversationMessages)[number] | undefined;
  for (let index = conversationMessages.length - 1; index >= 0; index--) {
    const message = conversationMessages[index];
    if (
      message.role === "assistant" &&
      message.transcriptVisibility !== "internal"
    ) {
      reply = message;
      break;
    }
  }
  return reply ? (
    <details open>
      <summary className="cursor-pointer text-xs font-medium text-muted">
        Latest app reply
      </summary>
      <p
        className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed"
        data-testid="developer-reply"
      >
        {reply.text}
      </p>
    </details>
  ) : (
    <p className="text-sm text-muted">
      Send a prompt below to start inspecting.
    </p>
  );
}

function DeveloperPanel() {
  const { chatSending } = useChatComposer();
  const state = useAppSelectorShallow((s) => ({
    activeConversationId: s.activeConversationId,
    conversations: s.conversations,
    firstToken: s.chatFirstTokenReceived,
    status: s.agentStatus,
    send: s.sendChatText,
    stop: s.handleChatStop,
    tab: s.tab,
  }));
  const conversation = state.conversations.find(
    (item) => item.id === state.activeConversationId,
  );
  const telemetry = useDeveloperTrajectories(conversation?.roomId, chatSending);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [section, setSection] = useState<"trace" | "settings">("trace");
  const busy = chatSending || sending;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || busy || !deriveAgentReady(state.status)) return;
    const prompt = draft;
    setSending(true);
    setSendError(null);
    setDraft("");
    telemetry.setOffset(0);
    telemetry.select(null);
    try {
      await state.send(prompt);
    } catch {
      // error-policy:J4 Canonical chat retains its recovery state; preserve the unsent draft too.
      setDraft((current) => current || prompt);
      setSendError(
        "The prompt could not be sent. Check the app’s connection and retry.",
      );
    } finally {
      setSending(false);
    }
  };
  const inspection = telemetry.inspection;
  return (
    <aside
      aria-label="Eliza developer console"
      className="developer-console flex h-full min-h-0 min-w-0 flex-col bg-card text-txt"
    >
      <header className="shrink-0 border-b border-border p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold text-txt-strong">
              Eliza developer console
            </h1>
            <p className="mt-1 text-xs text-muted">
              Same conversation. Live app controls.
            </p>
          </div>
          <a
            className="text-xs text-muted underline"
            href={`${window.location.pathname}?devtools=0`}
          >
            Close
          </a>
        </div>
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            variant={section === "trace" ? "default" : "ghost"}
            aria-pressed={section === "trace"}
            onClick={() => setSection("trace")}
          >
            Inspect
          </Button>
          <Button
            size="sm"
            variant={section === "settings" ? "default" : "ghost"}
            aria-pressed={section === "settings"}
            onClick={() => setSection("settings")}
          >
            Models &amp; key
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
        {section === "settings" ? (
          <DeveloperSettings />
        ) : (
          <>
            <div>
              <h2 className="text-sm font-medium">
                {conversation?.title || "Current conversation"}
              </h2>
              <p className="mt-1 text-xs text-muted">
                App view: {state.tab} ·{" "}
                {busy
                  ? state.firstToken
                    ? "Reply streaming"
                    : "Working"
                  : deriveAgentReady(state.status)
                    ? "Ready"
                    : "Agent unavailable"}
              </p>
            </div>
            <DeveloperLatestReply />
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium">Recorded runs</h2>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => telemetry.setPaused(!telemetry.paused)}
              >
                {telemetry.paused ? "Resume telemetry" : "Pause telemetry"}
              </Button>
            </div>
            <label className="block text-xs text-muted">
              Inspect a run
              <select
                aria-label="Inspect a run"
                className="mt-2 block min-h-10 w-full min-w-0 rounded-md border border-border bg-bg px-2 text-xs text-txt"
                value={telemetry.selectedId ?? ""}
                onChange={(event) =>
                  telemetry.select(event.target.value || null)
                }
              >
                <option value="">
                  Follow latest turn in this conversation
                </option>
                {telemetry.rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {new Date(row.startTime).toLocaleTimeString()} ·{" "}
                    {row.source} · {row.llmCallCount} calls ·{" "}
                    {row.roomId === conversation?.roomId
                      ? "this room"
                      : "other room"}{" "}
                    · {row.id}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center justify-between gap-2 text-xs text-muted">
              <span>
                Agent history · {telemetry.offset + 1}–
                {telemetry.offset + telemetry.rows.length} of {telemetry.total}
              </span>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={telemetry.offset === 0}
                  onClick={() => {
                    telemetry.select(null);
                    telemetry.setOffset(Math.max(0, telemetry.offset - 50));
                  }}
                >
                  Newer
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={telemetry.offset + 50 >= telemetry.total}
                  onClick={() => {
                    telemetry.select(null);
                    telemetry.setOffset(telemetry.offset + 50);
                  }}
                >
                  Older
                </Button>
              </div>
            </div>
            {telemetry.error ? (
              <p role="alert" className="text-sm text-warn">
                {telemetry.error}
              </p>
            ) : null}
            {inspection ? (
              <>
                <DeveloperTrace
                  record={inspection.record}
                  detail={inspection.detail}
                />
                <WireEvidence
                  key={inspection.record.id}
                  record={inspection.record}
                />
                <p className="text-xs leading-relaxed text-muted">
                  Background memory runs appear separately above. Match the
                  message ID to correlate them; they can finish after the reply.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted">
                No matching run on this page yet. Recording appears as stages
                finish.
              </p>
            )}
          </>
        )}
      </div>
      <SemanticForm
        className="shrink-0 space-y-2 border-t border-border p-4"
        onSubmit={(event) => void submit(event)}
      >
        <label htmlFor="developer-prompt" className="text-xs font-medium">
          Prompt Eliza · controls the app beside this panel
        </label>
        <Textarea
          id="developer-prompt"
          placeholder="Open Notes, then tell me what you can see…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {sendError ? (
          <p role="alert" className="text-xs text-warn">
            {sendError}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted">
            Enter to send · Shift+Enter for a new line
          </span>
          {busy ? (
            <Button type="button" variant="outline" onClick={state.stop}>
              Stop
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={!draft.trim() || !deriveAgentReady(state.status)}
            >
              Send to Eliza
            </Button>
          )}
        </div>
      </SemanticForm>
    </aside>
  );
}

export function DeveloperWorkspace({ children }: { children: ReactNode }) {
  const authority = useActiveAgentAuthority();
  const [mobilePane, setMobilePane] = useState<"app" | "inspector">(
    "inspector",
  );
  return (
    <div
      data-mobile-pane={mobilePane}
      className="eliza-developer-workspace flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-bg"
    >
      <nav
        aria-label="Developer workspace panes"
        className="developer-pane-navigation flex shrink-0 gap-2 border-b border-border p-2"
      >
        <Button
          size="sm"
          variant={mobilePane === "app" ? "default" : "ghost"}
          aria-pressed={mobilePane === "app"}
          onClick={() => setMobilePane("app")}
        >
          App
        </Button>
        <Button
          size="sm"
          variant={mobilePane === "inspector" ? "default" : "ghost"}
          aria-pressed={mobilePane === "inspector"}
          onClick={() => setMobilePane("inspector")}
        >
          Inspector
        </Button>
      </nav>
      <div className="flex min-h-0 flex-1">
        <div data-testid="developer-app-pane" className="developer-app-pane">
          {children}
        </div>
        <div className="developer-inspector-pane border-l border-border">
          <RoleGate minRole="OWNER" fallback={<OwnerOnlyNotice />}>
            <DeveloperPanel key={authority} />
          </RoleGate>
        </div>
      </div>
    </div>
  );
}
