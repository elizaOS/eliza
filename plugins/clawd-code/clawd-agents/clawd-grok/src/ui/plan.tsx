import type { Plan, PlanQuestion } from "../types/index";
import type { Theme } from "./theme";

export type PlanAnswers = Record<string, string | string[]>;

/* ── Plan Steps (inline in chat) ───────────────────────────── */

interface PlanViewProps {
  plan: Plan;
  t: Theme;
}

export function PlanView({ plan, t }: PlanViewProps) {
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0} flexDirection="column">
      <box marginBottom={1}>
        <text>
          <span style={{ fg: t.planTitle }}>
            <b>
              {"◆ "}
              {plan.title}
            </b>
          </span>
        </text>
      </box>
      <box paddingLeft={2} marginBottom={1}>
        <text fg={t.textMuted}>{plan.summary}</text>
      </box>
      {plan.steps.map((step, i) => (
        <box key={`step-${step.title}`} paddingLeft={2} marginBottom={0} flexDirection="column">
          <text>
            <span style={{ fg: t.planStepNum }}>{`${i + 1}. `}</span>
            <span style={{ fg: t.planStepTitle }}>
              <b>{step.title}</b>
            </span>
          </text>
          <box paddingLeft={3}>
            <text fg={t.planStepDesc}>{step.description}</text>
          </box>
          {step.filePaths && step.filePaths.length > 0 && (
            <box paddingLeft={3}>
              <text>
                {step.filePaths.map((fp, j) => (
                  <span key={fp} style={{ fg: t.planStepFile }}>
                    {j > 0 ? ", " : ""}
                    {fp}
                  </span>
                ))}
              </text>
            </box>
          )}
        </box>
      ))}
    </box>
  );
}

/* ── Plan Questions Panel (OpenCode-style tabbed inline) ──── */

const SPLIT = {
  topLeft: "",
  bottomLeft: "",
  vertical: "┃",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
};

export interface PlanQuestionsState {
  tab: number;
  selected: number;
  answers: PlanAnswers;
  customInputs: Record<string, string>;
  editing: boolean;
}

export function initialPlanQuestionsState(): PlanQuestionsState {
  return {
    tab: 0,
    selected: 0,
    answers: {},
    customInputs: {},
    editing: false,
  };
}

interface PlanQuestionsPanelProps {
  t: Theme;
  questions: PlanQuestion[];
  state: PlanQuestionsState;
}

export function PlanQuestionsPanel({ t, questions, state }: PlanQuestionsPanelProps) {
  const isSingle = questions.length === 1 && questions[0]?.type !== "multiselect";
  const isConfirmTab = !isSingle && state.tab === questions.length;
  const q = questions[state.tab];

  return (
    <box
      flexDirection="column"
      border={["left"]}
      customBorderChars={SPLIT}
      borderColor={t.planBorder}
      marginTop={1}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={t.backgroundPanel}
    >
      {/* Tabs */}
      {!isSingle && (
        <box flexDirection="row" gap={2} marginBottom={1} flexShrink={0}>
          {questions.map((q, i) => {
            const isActive = i === state.tab;
            const isAnswered = hasAnswer(state.answers, q);
            const label = tabLabel(q);
            return (
              <text key={q.id}>
                <span
                  style={{
                    fg: isActive ? t.planTitle : isAnswered ? t.planOptionCheck : t.textMuted,
                  }}
                >
                  {isActive ? <b>{label}</b> : label}
                  {isAnswered && !isActive ? " ✓" : ""}
                </span>
              </text>
            );
          })}
          <text>
            <span
              style={{
                fg: isConfirmTab ? t.planTitle : t.textMuted,
              }}
            >
              {isConfirmTab ? <b>{"Confirm"}</b> : "Confirm"}
            </span>
          </text>
        </box>
      )}

      {/* Question body */}
      {isConfirmTab ? (
        <ConfirmView t={t} questions={questions} answers={state.answers} />
      ) : q ? (
        <QuestionBody t={t} question={q} state={state} />
      ) : null}

      {/* Footer hints */}
      <box flexDirection="row" gap={3} marginTop={1} flexShrink={0}>
        {!isSingle && (
          <text>
            <span style={{ fg: t.text }}>{"⇆"}</span>
            <span style={{ fg: t.planHint }}>{" tab"}</span>
          </text>
        )}
        <text>
          <span style={{ fg: t.text }}>{"↑↓"}</span>
          <span style={{ fg: t.planHint }}>{" select"}</span>
        </text>
        <text>
          <span style={{ fg: t.text }}>{"enter"}</span>
          <span style={{ fg: t.planHint }}>
            {isConfirmTab ? " submit" : q?.type === "multiselect" ? " toggle" : isSingle ? " submit" : " confirm"}
          </span>
        </text>
        <text>
          <span style={{ fg: t.text }}>{"esc"}</span>
          <span style={{ fg: t.planHint }}>{" dismiss"}</span>
        </text>
      </box>
    </box>
  );
}

/* ── Question Body ────────────────────────────────────────── */

function QuestionBody({ t, question: q, state }: { t: Theme; question: PlanQuestion; state: PlanQuestionsState }) {
  const isMulti = q.type === "multiselect";
  const options = q.options ?? [];
  const showCustom = q.type !== "text";
  const totalItems = options.length + (showCustom ? 1 : 0);
  const isOnCustom = showCustom && state.selected === options.length;
  const customText = state.customInputs[q.id] ?? "";

  return (
    <box flexDirection="column">
      {/* Question text */}
      <box marginBottom={1}>
        <text fg={t.planQuestionText}>
          <b>{q.question}</b>
          {isMulti ? <span style={{ fg: t.textMuted }}>{" (select all that apply)"}</span> : null}
        </text>
      </box>

      {q.type === "text" ? (
        /* Free-form text input */
        <box backgroundColor={t.planInputBg} paddingLeft={1} paddingRight={1}>
          <text fg={t.planInputText}>
            {state.editing || customText ? (
              customText + (state.editing ? "▌" : "")
            ) : (
              <span style={{ fg: t.textMuted }}>{"Type your answer..."}</span>
            )}
          </text>
        </box>
      ) : (
        /* Options list */
        <box flexDirection="column">
          {options.map((opt, i) => {
            const isFocused = i === state.selected;
            const isPicked = isOptionPicked(state.answers, q, opt.id);
            return (
              <box
                key={opt.id}
                backgroundColor={isFocused ? t.selectedBg : undefined}
                paddingLeft={1}
                flexDirection="row"
              >
                <text>
                  <span style={{ fg: t.textMuted }}>{`${i + 1}. `}</span>
                  <span
                    style={{
                      fg: isFocused ? t.selected : isPicked ? t.planOptionCheck : t.text,
                    }}
                  >
                    {isMulti ? `[${isPicked ? "✓" : " "}] ${opt.label}` : opt.label}
                  </span>
                  {isPicked && !isMulti ? <span style={{ fg: t.planOptionCheck }}>{" ✓"}</span> : null}
                </text>
              </box>
            );
          })}

          {/* "Type your own answer" option */}
          {showCustom && (
            <box backgroundColor={isOnCustom ? t.selectedBg : undefined} paddingLeft={1}>
              {state.editing && isOnCustom ? (
                <box backgroundColor={t.planInputBg} paddingLeft={1} paddingRight={1} flexGrow={1}>
                  <text fg={t.planInputText}>{`${customText}▌`}</text>
                </box>
              ) : (
                <text>
                  <span style={{ fg: t.textMuted }}>{`${totalItems}. `}</span>
                  <span
                    style={{
                      fg: isOnCustom ? t.planOptionSelected : t.textMuted,
                    }}
                  >
                    {isMulti
                      ? `[${customText && isOptionPicked(state.answers, q, customText) ? "✓" : " "}] Type your own answer`
                      : "Type your own answer"}
                  </span>
                  {customText ? <span style={{ fg: t.textDim }}>{` (${customText})`}</span> : null}
                </text>
              )}
            </box>
          )}
        </box>
      )}
    </box>
  );
}

/* ── Confirm/Review Tab ───────────────────────────────────── */

function ConfirmView({ t, questions, answers }: { t: Theme; questions: PlanQuestion[]; answers: PlanAnswers }) {
  return (
    <box flexDirection="column">
      <box marginBottom={1}>
        <text fg={t.planQuestionText}>
          <b>{"Review"}</b>
        </text>
      </box>
      {questions.map((q) => {
        const val = formatAnswer(q, answers);
        const answered = val !== "(not answered)";
        return (
          <box key={q.id} paddingLeft={1}>
            <text>
              <span style={{ fg: t.text }}>
                <b>{tabLabel(q)}:</b>
              </span>
              <span style={{ fg: answered ? t.planOptionCheck : t.textMuted }}> {val}</span>
            </text>
          </box>
        );
      })}
    </box>
  );
}

/* ── Helpers ───────────────────────────────────────────────── */

function tabLabel(q: PlanQuestion): string {
  if (q.header) return q.header;
  const words = q.question.replace(/[?.,!:]+$/, "").split(/\s+/);
  const key = words.find(
    (w) => w.length > 2 && !/^(what|how|should|which|does|the|and|for|are|can|will|you|this|that|with|from)$/i.test(w),
  );
  return key ?? words[0] ?? "Question";
}

function hasAnswer(answers: PlanAnswers, q: PlanQuestion): boolean {
  const a = answers[q.id];
  if (!a) return false;
  if (Array.isArray(a)) return a.length > 0;
  return a.trim().length > 0;
}

function isOptionPicked(answers: PlanAnswers, q: PlanQuestion, optionId: string): boolean {
  const a = answers[q.id];
  if (!a) return false;
  if (Array.isArray(a)) return a.includes(optionId);
  return a === optionId;
}

function formatAnswer(q: PlanQuestion, answers: PlanAnswers): string {
  const a = answers[q.id];
  if (!a) return "(not answered)";
  if (q.type === "text") return (a as string) || "(not answered)";
  if (q.type === "select") {
    const opt = q.options?.find((o) => o.id === a);
    return (opt?.label ?? (a as string)) || "(not answered)";
  }
  const arr = a as string[];
  if (arr.length === 0) return "(not answered)";
  return arr.map((id) => q.options?.find((o) => o.id === id)?.label ?? id).join(", ");
}

export function formatPlanAnswers(questions: PlanQuestion[], answers: PlanAnswers): string {
  const parts: string[] = ["Here are my answers to the plan questions:\n"];

  for (const q of questions) {
    const val = formatAnswer(q, answers);
    parts.push(`- ${q.question}: ${val}`);
  }

  return parts.join("\n");
}
