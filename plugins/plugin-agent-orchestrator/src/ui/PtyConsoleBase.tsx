/**
 * PTY output streamer for a coding-agent session, rendered in drawer,
 * side-panel, or full variant. Subscribes to `pty-output` WS events and shows
 * the buffered + streamed scrollback with a single-line input and
 * interrupt/stop controls. Those controls write to or stop the session, so
 * they are human-authority controls the agent surface cannot drive.
 *
 * Scrollback is capped at `MAX_BUFFER_CHARS` (200,000) — older output is
 * silently trimmed from the head. Backs the PtyConsoleDrawer /
 * PtyConsoleSidePanel wrappers and fills the `@elizaos/ui` PtyConsoleBase slot.
 */
import {
  Button,
  Card,
  type CodingAgentSession,
  client,
  Input,
  useAgentElement,
} from "@elizaos/ui";

import { Send, Square, Terminal, X } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { streamPtyOutput } from "./pty-output-stream";
import { stripAnsi } from "./view-format";

const MAX_BUFFER_CHARS = 200_000;

export interface PtyConsoleBaseProps {
  activeSessionId: string;
  sessions: CodingAgentSession[];
  onClose?: () => void;
  variant: "drawer" | "side-panel" | "full";
}

export function PtyConsoleBase({
  activeSessionId,
  sessions,
  onClose,
  variant,
}: PtyConsoleBaseProps) {
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.sessionId === activeSessionId),
    [activeSessionId, sessions],
  );

  useEffect(() => {
    setOutput("");
    const stop = streamPtyOutput(activeSessionId, {
      onSnapshot: (text) => setOutput(trimBuffer(text)),
      onData: (text) => setOutput((current) => trimBuffer(current + text)),
    });
    client.resizePty(activeSessionId, variant === "full" ? 120 : 96, 32);
    return stop;
  }, [activeSessionId, variant]);

  // Cursor-addressed TUIs stay approximate here; the CLI view renders them.
  const displayed = useMemo(() => stripAnsi(output), [output]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: output changes should scroll the terminal to the newest line.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [output]);

  const sendInput = useCallback(
    (data: string) => {
      if (!data) return;
      client.sendPtyInput(activeSessionId, data);
    },
    [activeSessionId],
  );

  const sendLine = useCallback(() => {
    const line = input;
    setInput("");
    sendInput(`${line}\n`);
  }, [input, sendInput]);

  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      sendLine();
    },
    [sendLine],
  );

  const stopSession = useCallback(() => {
    void client.stopCodingAgent(activeSessionId);
  }, [activeSessionId]);

  return (
    <Card
      asChild
      variant={variant === "full" ? "sandboxFrame" : "panel"}
      radius={variant === "full" ? "none" : "large"}
      shadow={variant === "full" ? "none" : "default"}
    >
      <section
        className={containerLayoutClassName(variant)}
        aria-label="Agent terminal"
        data-testid="pty-console-base"
      >
        <Card
          asChild
          variant="bottomDivider"
          className="flex h-10 shrink-0 items-center gap-2 px-3"
        >
          <header>
            <Terminal className="size-4 shrink-0 text-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold text-txt">
                {activeSession?.label ?? "Terminal"}
              </div>
              <div className="truncate text-[11px] text-muted">
                {activeSession?.workdir ?? activeSessionId}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => sendInput("\u0003")}
              title="Interrupt"
              aria-label="Interrupt terminal"
              data-agent-authority="human"
              data-agent-human-id="cockpit-terminal-interrupt"
            >
              <Square className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={stopSession}
              title="Stop session"
              aria-label="Stop terminal session"
              data-agent-authority="human"
              data-agent-human-id="cockpit-terminal-stop"
            >
              <Square className="size-4 fill-current" aria-hidden />
            </Button>
            {onClose ? <PtyCloseButton onClose={onClose} /> : null}
          </header>
        </Card>
        <Card asChild variant="codePane">
          <div
            ref={scrollerRef}
            className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-neutral-100"
          >
            <pre className="whitespace-pre-wrap break-words">
              {displayed || "Connecting to terminal…"}
            </pre>
          </div>
        </Card>
        <Card
          asChild
          variant="topDivider"
          className="flex h-11 shrink-0 items-center gap-2 px-2"
        >
          <footer>
            <Input
              variant="secret"
              density="compact"
              value={input}
              onChange={(event) => setInput(event.currentTarget.value)}
              onKeyDown={onInputKeyDown}
              className="min-w-0 flex-1"
              aria-label="Terminal input"
              autoComplete="off"
              spellCheck={false}
              data-agent-authority="human"
              data-agent-human-id="cockpit-terminal-input"
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={sendLine}
              title="Send"
              aria-label="Send terminal input"
              data-agent-authority="human"
              data-agent-human-id="cockpit-terminal-send"
            >
              <Send className="size-4" aria-hidden />
            </Button>
          </footer>
        </Card>
      </section>
    </Card>
  );
}

function PtyCloseButton({ onClose }: { onClose: () => void }) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "cockpit-terminal-panel-close",
    role: "button",
    label: "Close terminal panel",
    group: "cockpit-terminal-controls",
    description: "Close the terminal panel",
    onActivate: onClose,
  });
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      onClick={onClose}
      title="Close"
      aria-label="Close terminal"
      {...agentProps}
    >
      <X className="size-4" aria-hidden />
    </Button>
  );
}

function containerLayoutClassName(
  variant: PtyConsoleBaseProps["variant"],
): string {
  const base = "flex min-h-0 min-w-0 flex-col overflow-hidden";
  if (variant === "full") return `${base} h-full w-full`;
  if (variant === "drawer") return `${base} h-[min(70vh,40rem)] w-full`;
  return `${base} h-[min(70vh,42rem)] w-[min(34rem,calc(100vw-1rem))]`;
}

function trimBuffer(value: string): string {
  if (value.length <= MAX_BUFFER_CHARS) return value;
  return value.slice(value.length - MAX_BUFFER_CHARS);
}
