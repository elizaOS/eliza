/**
 * PTY output streamer for a coding-agent session, rendered in drawer,
 * side-panel, or full variant. Subscribes to `pty-output` WS events and shows
 * the buffered + streamed scrollback with a single-line input and
 * interrupt/stop controls.
 *
 * Scrollback is capped at `MAX_BUFFER_CHARS` (200,000) — older output is
 * silently trimmed from the head. Backs the PtyConsoleDrawer /
 * PtyConsoleSidePanel wrappers and fills the `@elizaos/ui` PtyConsoleBase slot.
 */

import { Button, Card, Input } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { client } from "@elizaos/ui/api";
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
  const { ref: interruptRef, agentProps: interruptAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "cockpit-terminal-interrupt",
      role: "button",
      label: "Interrupt terminal process",
      group: "cockpit-terminal-controls",
      description: "Send Ctrl-C to the active terminal session",
      onActivate: () => sendInput("\u0003"),
    });
  const { ref: stopRef, agentProps: stopAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "cockpit-terminal-stop",
      role: "button",
      label: "Stop terminal session",
      group: "cockpit-terminal-controls",
      description: "Stop the active coding-agent terminal session",
      onActivate: stopSession,
    });
  const { ref: inputRef, agentProps: inputAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "cockpit-terminal-input",
      role: "text-input",
      label: "Terminal input",
      group: "cockpit-terminal-controls",
      description: "Enter a line to send to the active terminal session",
      getValue: () => input,
      onFill: setInput,
    });
  const { ref: sendRef, agentProps: sendAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "cockpit-terminal-send",
      role: "button",
      label: "Send terminal input",
      group: "cockpit-terminal-controls",
      description: "Send the prepared line to the active terminal session",
      status: input.length > 0 ? "ready" : "empty",
      onActivate: sendLine,
    });

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
              ref={interruptRef}
              variant="ghost"
              size="icon"
              onClick={() => sendInput("\u0003")}
              title="Interrupt"
              aria-label="Interrupt terminal"
              {...interruptAgentProps}
            >
              <Square className="size-4" aria-hidden />
            </Button>
            <Button
              ref={stopRef}
              variant="ghost"
              size="icon"
              onClick={stopSession}
              title="Stop session"
              aria-label="Stop terminal session"
              {...stopAgentProps}
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
              {output || "\u001b[2mConnecting to terminal...\u001b[0m"}
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
              ref={inputRef}
              variant="secret"
              density="compact"
              value={input}
              onChange={(event) => setInput(event.currentTarget.value)}
              onKeyDown={onInputKeyDown}
              className="min-w-0 flex-1"
              aria-label="Terminal input"
              autoComplete="off"
              spellCheck={false}
              {...inputAgentProps}
            />
            <Button
              ref={sendRef}
              variant="ghost"
              size="icon"
              onClick={sendLine}
              title="Send"
              aria-label="Send terminal input"
              {...sendAgentProps}
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
