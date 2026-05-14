import { Button, client } from "@elizaos/ui";
import type { CodingAgentSession } from "@elizaos/ui/api/client-types-cloud";
import { Send, Square, Terminal, X } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const MAX_BUFFER_CHARS = 200_000;

export interface PtyConsoleBaseProps {
  activeSessionId: string;
  sessions: CodingAgentSession[];
  onClose: () => void;
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
    let disposed = false;
    setOutput("");
    void client.getPtyBufferedOutput(activeSessionId).then((buffered) => {
      if (!disposed) setOutput(trimBuffer(buffered));
    });

    const unbind = client.onWsEvent("pty-output", (event) => {
      const message = event as { sessionId?: string; data?: string };
      if (message.sessionId !== activeSessionId || !message.data) return;
      setOutput((current) => trimBuffer(current + message.data));
    });
    client.subscribePtyOutput(activeSessionId);
    client.resizePty(activeSessionId, variant === "full" ? 120 : 96, 32);

    return () => {
      disposed = true;
      unbind();
      client.unsubscribePtyOutput(activeSessionId);
    };
  }, [activeSessionId, variant]);

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
    <section
      className={containerClassName(variant)}
      aria-label="Agent terminal"
      data-testid="pty-console-base"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <Terminal className="h-4 w-4 shrink-0 text-muted" aria-hidden />
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
        >
          <Square className="h-4 w-4" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={stopSession}
          title="Stop session"
          aria-label="Stop terminal session"
        >
          <Square className="h-4 w-4 fill-current" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          title="Close"
          aria-label="Close terminal"
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </header>
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-auto bg-black p-3 font-mono text-[11px] leading-relaxed text-neutral-100"
      >
        <pre className="whitespace-pre-wrap break-words">
          {output || "\u001b[2mConnecting to terminal...\u001b[0m"}
        </pre>
      </div>
      <footer className="flex h-11 shrink-0 items-center gap-2 border-t border-border/60 px-2">
        <input
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          onKeyDown={onInputKeyDown}
          className="min-w-0 flex-1 rounded-md border border-border/60 bg-bg px-2 py-1.5 font-mono text-xs text-txt outline-none focus:border-accent"
          aria-label="Terminal input"
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={sendLine}
          title="Send"
          aria-label="Send terminal input"
        >
          <Send className="h-4 w-4" aria-hidden />
        </Button>
      </footer>
    </section>
  );
}

function containerClassName(variant: PtyConsoleBaseProps["variant"]): string {
  const base =
    "flex min-h-0 min-w-0 flex-col overflow-hidden border border-border/70 bg-bg shadow-xl";
  if (variant === "full") {
    return `${base} h-full w-full rounded-none border-0 shadow-none`;
  }
  if (variant === "drawer") {
    return `${base} h-[min(70vh,40rem)] w-full rounded-t-lg`;
  }
  return `${base} h-[min(70vh,42rem)] w-[min(34rem,calc(100vw-1rem))] rounded-lg`;
}

function trimBuffer(value: string): string {
  if (value.length <= MAX_BUFFER_CHARS) return value;
  return value.slice(value.length - MAX_BUFFER_CHARS);
}
