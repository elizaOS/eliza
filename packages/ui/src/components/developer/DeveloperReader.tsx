/** Read recorded model inputs and outputs without expanding the chat transcript. */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { client } from "../../api/client";
import type { ConversationMessage } from "../../api/client-types-chat";
import type {
  TrajectoryDetailResult,
  TrajectoryRecord,
} from "../../api/client-types-cloud";
import { useAppSelector } from "../../state/app-store";
import { trajectoryStageLabel } from "../composites/trajectories/trajectory-recorded-steps";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import {
  isReplyRecoveryRun,
  useMessageTrajectories,
} from "./DeveloperTrajectories";
import {
  buildTrajectoryReaderData,
  splitTrajectoryReaderText,
  type TrajectoryReaderSection,
  trajectoryCallStageLabel,
} from "./trajectory-reader-data";
import { trajectoryRevision } from "./useDeveloperTrajectories";
import "../../styles/developer-reader.css";

const measurement = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;
const count = (n: number | null | undefined) =>
  measurement(n) ? n?.toLocaleString() : "unknown";
const duration = (n: number | null | undefined) =>
  measurement(n) ? `${((n ?? 0) / 1000).toFixed(2)}s` : "unknown";
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const readableKey = (key: string) =>
  key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");

function section(
  id: string,
  label: string,
  value: unknown,
): TrajectoryReaderSection {
  const text =
    typeof value === "string"
      ? value
      : value === undefined
        ? ""
        : JSON.stringify(value, null, 2);
  return {
    id,
    label,
    sourcePath: id,
    status:
      value === undefined ? "unavailable" : text === "" ? "empty" : "recorded",
    text,
    format: typeof value === "string" ? "text" : "json",
    characterCount: value === undefined ? null : text.length,
    rawValue: value,
    parts: splitTrajectoryReaderText(text),
  };
}

/** Field names and string values remain intact; only JSON punctuation is hidden. */
function ReadableValue({ value }: { value: unknown }) {
  if (Array.isArray(value))
    return value.length ? (
      <ol className="reader-values">
        {value.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Recorded arrays are immutable and have no required IDs.
          <li key={index}>
            <ReadableValue value={item} />
          </li>
        ))}
      </ol>
    ) : (
      <p className="text-muted">Empty list</p>
    );
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length ? (
      <dl className="reader-fields">
        {entries.map(([key, item]) => (
          <div key={key}>
            <dt>{readableKey(key)}</dt>
            <dd>
              <ReadableValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    ) : (
      <p className="text-muted">Empty object</p>
    );
  }
  return (
    <p className="reader-prose">
      {typeof value === "string" ? value : JSON.stringify(value)}
    </p>
  );
}

function parsedText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* Plain text and JSONL are legitimate recorded outputs. */
  }
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length > 1) {
    try {
      return lines.map((line) => JSON.parse(line));
    } catch {
      /* Preserve all text if any line is not JSON. */
    }
  }
  return text;
}

export function DeveloperReader({
  messages,
  records,
  roomId,
  busy,
  error,
}: {
  messages: ConversationMessage[];
  records: TrajectoryRecord[];
  roomId?: string;
  busy: boolean;
  error: string | null;
}) {
  const id = useId();
  const [messageId, selectMessage] = useState<string>();
  const [runId, selectRun] = useState<string>();
  const requests = messages.filter(
    (message) =>
      message.role === "user" && message.transcriptVisibility !== "internal",
  );
  const selected =
    requests.find((message) => message.id === messageId) ??
    requests[requests.length - 1];
  const reply =
    selected &&
    messages.find(
      (message) =>
        message.role === "assistant" &&
        message.replyToMessageId === selected.id,
    );
  const matching = records.filter(
    (record) =>
      record.roomId === roomId && record.metadata?.messageId === selected?.id,
  );
  const lookup = useMessageTrajectories({
    records: matching,
    roomId,
    messageId: selected?.id,
    enabled: Boolean(selected),
  });
  const run =
    lookup.runs.find((item) => item.id === runId) ??
    lookup.runs.find(
      (item) => item.source === "client_chat" && !isReplyRecoveryRun(item),
    ) ??
    lookup.runs[0];
  return (
    <section className="developer-reader" aria-label="Run reader">
      <div className="reader-selection">
        {!roomId ? (
          <p role="status">Waiting for the app’s conversation connection…</p>
        ) : null}
        <div className="reader-select-row">
          <label htmlFor={`${id}-request`}>Conversation turn</label>
          <NativeSelect
            id={`${id}-request`}
            value={messageId ?? "latest"}
            onChange={(event) => {
              selectMessage(
                event.target.value === "latest"
                  ? undefined
                  : event.target.value,
              );
              selectRun(undefined);
            }}
          >
            <option value="latest">Follow latest message</option>
            {[...requests].reverse().map((message) => (
              <option key={message.id} value={message.id}>
                {new Date(message.timestamp).toLocaleTimeString()} ·{" "}
                {message.text}
              </option>
            ))}
          </NativeSelect>
        </div>
        <details className="reader-exchange-details">
          <summary>Message &amp; reply</summary>
          <div className="reader-exchange">
            <p>
              <strong>You</strong>{" "}
              {selected?.text || "Send a message below to begin."}
            </p>
            <p>
              <strong>Eliza</strong>{" "}
              {reply?.text || (busy ? "Working…" : "No linked reply recorded.")}
            </p>
          </div>
        </details>
        {lookup.runs.length > 1 ? (
          <div className="reader-select-row">
            <label htmlFor={`${id}-run`}>Recorded run</label>
            <NativeSelect
              id={`${id}-run`}
              value={run?.id}
              onChange={(event) => selectRun(event.target.value)}
            >
              {lookup.runs.map((item) => (
                <option key={item.id} value={item.id}>
                  {isReplyRecoveryRun(item)
                    ? "Reply recovery"
                    : item.source === "client_chat"
                      ? "Chat"
                      : item.source === "background_memory"
                        ? "Background memory"
                        : item.source}{" "}
                  · {item.llmCallCount}{" "}
                  {item.llmCallCount === 1 ? "attempt" : "attempts"} ·{" "}
                  {item.status}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        {busy ? (
          <p role="status" className="text-sm">
            Working — recorded steps update as they finish.
          </p>
        ) : null}
        {error || lookup.error ? (
          <p role="alert">
            {error || "Couldn’t load every run for this message."}{" "}
            <Button variant="outline" onClick={lookup.retry}>
              Retry
            </Button>
          </p>
        ) : null}
      </div>
      {run ? (
        <LoadedReader key={run.id} run={run} />
      ) : (
        <p role="status" className="reader-empty">
          {lookup.loading
            ? "Finding the recorded run…"
            : "No recorded run for this message yet."}
        </p>
      )}
    </section>
  );
}

function LoadedReader({ run }: { run: TrajectoryRecord }) {
  const [loaded, setLoaded] = useState<{
    detail: TrajectoryDetailResult;
    record: TrajectoryRecord;
    revision: string;
  }>();
  const detail = loaded?.detail;
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const revision = trajectoryRevision(run);
  // Only the selected run requests full payloads. Old responses cannot replace a newer run.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision and explicit retry invalidate the payload read.
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void client
      .getTrajectoryDetail(run.id, {
        includePayloads: true,
        signal: controller.signal,
      })
      .then((result) => {
        if (!controller.signal.aborted)
          setLoaded({ detail: result, record: run, revision });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [run.id, revision, retry]);
  return (
    <>
      {error ? (
        <p role="alert" className="reader-empty">
          Couldn’t refresh the recorded inputs.{" "}
          {detail ? "Showing the last loaded version." : ""}{" "}
          <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>
            Retry payloads
          </Button>
        </p>
      ) : null}
      {detail && loaded?.revision !== revision && !error ? (
        <p role="status" className="reader-refresh">
          Updating recorded payloads… Showing the last loaded version.
        </p>
      ) : null}
      {detail ? (
        <TrajectoryReader detail={detail} record={loaded?.record} />
      ) : !error ? (
        <p role="status" className="reader-empty">
          Loading the complete recorded inputs and outputs…
        </p>
      ) : null}
    </>
  );
}

/** Pure viewer used by live runs, component tests and synthetic stories. */
export function TrajectoryReader({
  detail,
  record,
}: {
  detail: TrajectoryDetailResult;
  record?: TrajectoryRecord;
}) {
  const [mode, setMode] = useState<"calls" | "steps" | "providers" | "raw">(
    "calls",
  );
  const [selectedId, select] = useState<string>();
  const [direction, setDirection] = useState<"input" | "output">("input");
  const copy = useAppSelector((state) => state.copyToClipboard);
  const [copyStatus, setCopyStatus] = useState("");
  const id = useId();
  const steps = useMemo(
    () =>
      [...(detail.semanticStages ?? [])].sort(
        (a, b) => a.startedAt - b.startedAt,
      ),
    [detail.semanticStages],
  );
  const items =
    mode === "calls"
      ? detail.llmCalls.map((call, index) => ({
          id: call.id,
          label: `${index + 1}. ${trajectoryCallStageLabel(call)}`,
          meta: `${count(call.promptTokens)} in · ${duration(call.latencyMs)}`,
        }))
      : mode === "steps"
        ? steps.map((step, index) => ({
            id: step.stageId,
            label: `${index + 1}. ${trajectoryStageLabel(step)}`,
            meta: duration(step.latencyMs),
          }))
        : mode === "providers"
          ? detail.providerAccesses.map((provider, index) => ({
              id: provider.id,
              label: `${index + 1}. ${provider.providerName}`,
              meta: provider.purpose,
            }))
          : [];
  const active = items.find((item) => item.id === selectedId) ?? items[0];
  const call =
    mode === "calls"
      ? detail.llmCalls.find((item) => item.id === active?.id)
      : undefined;
  const stage =
    mode === "steps"
      ? steps.find((item) => item.stageId === active?.id)
      : undefined;
  const provider =
    mode === "providers"
      ? detail.providerAccesses.find((item) => item.id === active?.id)
      : undefined;
  const sections = useMemo(() => {
    if (call) return buildTrajectoryReaderData(call)[direction];
    if (stage) {
      const model = object(stage.payload.model),
        tool = object(stage.payload.tool),
        search = object(stage.payload.toolSearch);
      return direction === "input"
        ? [
            section(
              "stage.input",
              "Step input",
              model.messages ?? tool.input ?? tool.args ?? search.query,
            ),
            section("stage.raw", "Complete step record", stage),
          ]
        : [
            section(
              "stage.output",
              "Step output",
              model.response ??
                tool.output ??
                tool.result ??
                search.results ??
                stage.payload.evaluation,
            ),
            section("stage.raw", "Complete step record", stage),
          ];
    }
    if (provider) {
      const data = object(provider.data);
      return direction === "input"
        ? [
            section("provider.query", "Provider request", provider.query),
            section("provider.raw", "Complete provider record", provider),
          ]
        : [
            section(
              "provider.result",
              "Provider result",
              data.text ?? data.resultText,
            ),
            section("provider.raw", "Complete provider record", provider),
          ];
    }
    return mode === "raw"
      ? [section("run", "Complete recorded run", detail)]
      : [];
  }, [call, stage, provider, mode, direction, detail]);
  const onCopy = async (text: string) => {
    try {
      await copy(text);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Copy failed. Select the text to copy it manually.");
    }
  };
  const run = record ?? detail.trajectory;
  const attempts = Math.max(run.llmCallCount ?? 0, detail.llmCalls.length);
  const runTokens = (
    field: "promptTokens" | "completionTokens",
    reported: number | null | undefined,
  ) => {
    const known = detail.llmCalls
      .map((call) => call[field])
      .filter((value): value is number => measurement(value));
    if (known.length < attempts)
      return known.length
        ? `${count(known.reduce((sum, value) => sum + value, 0))}+ (partial)`
        : "unknown";
    return count(reported);
  };
  const estimated = detail.llmCalls.some((call) => call.tokenUsageEstimated);
  return (
    <div className="reader-run">
      <div className="reader-run-summary">
        <p>
          {run.source === "background_memory"
            ? "Background memory"
            : "Recorded run"}{" "}
          · {run.status} · {attempts} model{" "}
          {attempts === 1 ? "attempt" : "attempts"} · {estimated ? "≈ " : ""}
          {runTokens("promptTokens", run.totalPromptTokens)} input /{" "}
          {estimated ? "≈ " : ""}
          {runTokens("completionTokens", run.totalCompletionTokens)} output
          tokens · {duration(run.durationMs)} server run
        </p>
        <nav aria-label="Evidence type" className="reader-tabs">
          {(
            [
              ["calls", "Model calls"],
              ["steps", "Steps & actions"],
              ["providers", "Providers"],
              ["raw", "Raw run"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              variant={mode === value ? "secondary" : "ghost"}
              aria-pressed={mode === value}
              onClick={() => {
                setMode(value);
                select(undefined);
                setDirection(value === "providers" ? "output" : "input");
              }}
            >
              {label}
            </Button>
          ))}
        </nav>
      </div>
      <div className="reader-columns">
        {mode !== "raw" ? (
          <aside className="reader-index" aria-label="Recorded items">
            <label className="reader-mobile-label" htmlFor={`${id}-step`}>
              Choose{" "}
              {mode === "calls"
                ? "model call"
                : mode === "providers"
                  ? "provider"
                  : "step"}
            </label>
            <NativeSelect
              className="reader-mobile-select"
              id={`${id}-step`}
              value={active?.id ?? ""}
              onChange={(event) => select(event.target.value)}
            >
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} · {item.meta}
                </option>
              ))}
            </NativeSelect>
            <div className="reader-desktop-index">
              {items.map((item) => (
                <Button
                  key={item.id}
                  variant="ghost"
                  className="reader-index-item"
                  aria-pressed={item.id === active?.id}
                  onClick={() => select(item.id)}
                >
                  <span>{item.label}</span>
                  <small>{item.meta}</small>
                </Button>
              ))}
            </div>
          </aside>
        ) : null}
        <div className="reader-document">
          {mode !== "raw" ? (
            <div className="reader-call-heading">
              <h2>{active?.label ?? "Nothing recorded here"}</h2>
              {call ? (
                <p className="reader-help">
                  {call.model} · {count(call.promptTokens)} input ·{" "}
                  {count(call.completionTokens)} output ·{" "}
                  {count(call.cacheReadInputTokens)} cached input (included) ·{" "}
                  {duration(call.latencyMs)} model span
                  {call.tokenUsageEstimated ? " · Token counts estimated" : ""}
                </p>
              ) : null}
              <nav className="reader-tabs" aria-label="Read direction">
                {(
                  [
                    ["input", "Input"],
                    ["output", "Output"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    variant={direction === value ? "secondary" : "ghost"}
                    aria-pressed={direction === value}
                    onClick={() => setDirection(value)}
                  >
                    {label}
                  </Button>
                ))}
              </nav>
              {mode === "providers" ? (
                <p className="reader-help">
                  Provider results are intermediate context. Only a model call’s
                  recorded input proves what it received.
                </p>
              ) : mode === "steps" ? (
                <p className="reader-help">
                  Steps can wrap the same model calls; they are not additional
                  token usage.
                </p>
              ) : null}
            </div>
          ) : null}
          <ReaderSections
            key={`${active?.id ?? "raw"}-${mode}-${direction}`}
            sections={sections}
            reference={`Run ${run.id}\n${active?.label ?? "Raw run"}`}
            onCopy={(text) => {
              void onCopy(text);
            }}
          />
        </div>
      </div>
      <div className="reader-footer">
        <span role="status">
          {copyStatus || "Sizes are characters, not tokens."}
        </span>
        <Button
          variant="ghost"
          onClick={() => {
            void onCopy(JSON.stringify(detail, null, 2));
          }}
        >
          Copy full run
        </Button>
      </div>
    </div>
  );
}

function ReaderSections({
  sections,
  reference,
  onCopy,
}: {
  sections: TrajectoryReaderSection[];
  reference: string;
  onCopy: (text: string) => void;
}) {
  const id = useId();
  const [selectedId, select] = useState<string>();
  const [partIndex, selectPart] = useState(-1);
  const [raw, setRaw] = useState(false);
  const [query, setQuery] = useState("");
  const [showFind, setShowFind] = useState(false);
  const active = sections.find((item) => item.id === selectedId) ?? sections[0];
  const part = partIndex >= 0 ? active?.parts[partIndex] : undefined;
  const text = part?.text ?? active?.text ?? "";
  const matches =
    active?.parts
      .map((p, index) => ({ ...p, index }))
      .filter(
        (p) =>
          !query ||
          p.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      ) ?? [];
  const scrollRef = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset position only when the user selects different text.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [active?.id, partIndex]);
  const readable = useMemo(() => parsedText(text), [text]);
  if (!active)
    return (
      <p className="reader-empty">No payloads recorded in this category.</p>
    );
  return (
    <div className="reader-section-browser">
      <div className="reader-section-controls">
        <label htmlFor={`${id}-content`}>Content</label>
        <NativeSelect
          id={`${id}-content`}
          value={active.id}
          onChange={(event) => {
            select(event.target.value);
            selectPart(-1);
            setQuery("");
          }}
        >
          {sections.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label} ·{" "}
              {item.characterCount === null
                ? "not recorded"
                : `${count(item.characterCount)} characters`}
            </option>
          ))}
        </NativeSelect>
        {active.parts.length > 1 ? (
          <>
            {showFind ? (
              <>
                <label htmlFor={`${id}-find`}>Find a section</label>
                <Input
                  id={`${id}-find`}
                  placeholder="Search this input…"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    selectPart(-1);
                  }}
                />
              </>
            ) : null}
            <label htmlFor={`${id}-part`}>Jump to section</label>
            <NativeSelect
              id={`${id}-part`}
              value={partIndex}
              onChange={(event) => selectPart(Number(event.target.value))}
            >
              <option value={-1}>
                All text · {count(active.characterCount)} characters
              </option>
              {matches.map((p) => (
                <option key={p.index} value={p.index}>
                  {p.label} · {count(p.text.length)} characters
                </option>
              ))}
            </NativeSelect>
            {query ? (
              <p className="reader-help">
                {matches.length} matching sections. Select one to read it.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="reader-text-toolbar">
        <span>
          {part?.label ?? active.label} ·{" "}
          {active.status === "unavailable"
            ? "not recorded"
            : `${text.length.toLocaleString()} characters`}
        </span>
        <div>
          {active.parts.length > 1 ? (
            <Button
              variant="ghost"
              aria-expanded={showFind}
              onClick={() => {
                setShowFind(!showFind);
                setQuery("");
                selectPart(-1);
              }}
            >
              Find
            </Button>
          ) : null}
          <Button
            variant="ghost"
            aria-pressed={raw}
            onClick={() => setRaw(!raw)}
          >
            {raw ? "Readable view" : "Raw text"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => onCopy(text)}
            disabled={active.status === "unavailable"}
          >
            Copy text
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              onCopy(
                `${reference}\n${active.sourcePath}${part ? ` [characters ${part.start}–${part.end})` : ""}\n\n${text}`,
              )
            }
            disabled={active.status === "unavailable"}
          >
            Copy reference
          </Button>
        </div>
      </div>
      {active.representationNote ? (
        <p className="reader-help reader-representation-note">
          {active.representationNote}
        </p>
      ) : null}
      <section
        className="reader-text-scroll"
        aria-label="Recorded content"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable text must be keyboard reachable.
        tabIndex={0}
        ref={scrollRef}
      >
        {active.status === "unavailable" ? (
          <p>
            This payload was not recorded. It cannot be reconstructed from its
            size or token count.
          </p>
        ) : raw ? (
          <pre className="reader-raw">{text}</pre>
        ) : active.status === "empty" ? (
          <p>Recorded empty value.</p>
        ) : typeof readable === "string" ? (
          <div className="reader-prose">{text}</div>
        ) : (
          <ReadableValue value={readable} />
        )}
      </section>
    </div>
  );
}
