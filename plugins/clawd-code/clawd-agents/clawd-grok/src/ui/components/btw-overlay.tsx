import { useEffect, useState } from "react";
import { Markdown } from "../markdown.js";
import type { Theme } from "../theme.js";

export interface BtwState {
  status: "loading" | "done" | "error";
  question: string;
  answer?: string;
  error?: string;
}

const LOADING_SPINNER_FRAMES = ["⬒", "⬔", "⬓", "⬕"];

function LoadingSpinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((n) => (n + 1) % LOADING_SPINNER_FRAMES.length), 120);
    return () => clearInterval(id);
  }, []);
  return <>{LOADING_SPINNER_FRAMES[frame]}</>;
}

export function BtwOverlay({ state, theme: t }: { state: BtwState; theme: Theme }) {
  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      flexShrink={0}
      backgroundColor={t.backgroundPanel}
    >
      <text>
        <span style={{ fg: t.accent }}>/btw</span>
        <span style={{ fg: t.textMuted }}>{" — "}</span>
        <span style={{ fg: t.text }}>{state.question}</span>
      </text>

      <box height={1} />

      {state.status === "loading" && (
        <text>
          <span style={{ fg: t.textMuted }}>
            <LoadingSpinner />
          </span>
          <span style={{ fg: t.textMuted }}> Answering…</span>
        </text>
      )}

      {state.status === "done" && state.answer && <Markdown content={state.answer} t={t} />}

      {state.status === "error" && <text fg={t.diffRemovedFg}>{state.error || "Something went wrong."}</text>}

      {state.status !== "loading" && (
        <>
          <box height={1} />
          <text>
            <span style={{ fg: t.accent }}>esc</span>
            <span style={{ fg: t.textMuted }}> dismiss</span>
          </text>
        </>
      )}
    </box>
  );
}
