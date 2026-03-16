import { client } from "@elizaos/app-core/api";
import { useApp } from "@elizaos/app-core/state";
import { useCallback, useEffect, useRef, useState } from "react";

interface TerminalLine {
  id: string;
  type: "command" | "stdout" | "stderr" | "exit" | "error";
  text: string;
  ts: number;
}

export function StreamTerminal() {
  const { t } = useApp();
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineIdRef = useRef(0);

  const addLine = useCallback((type: TerminalLine["type"], text: string) => {
    const id = String(++lineIdRef.current);
    setLines((prev) => {
      const next = [...prev, { id, type, text, ts: Date.now() }];
      return next.length > 300 ? next.slice(-300) : next;
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    const unbind = client.onWsEvent(
      "terminal-output",
      (data: Record<string, unknown>) => {
        const event = data.event as string;
        switch (event) {
          case "start":
            addLine("command", `$ ${data.command as string}`);
            break;
          case "stdout":
            addLine("stdout", data.data as string);
            break;
          case "stderr":
            addLine("stderr", data.data as string);
            break;
          case "exit":
            addLine("exit", `Process exited with code ${data.code as number}`);
            break;
          case "error":
            addLine("error", `Error: ${data.data as string}`);
            break;
        }
      },
    );
    return unbind;
  }, [addLine]);

  return (
    <div className="h-full w-full bg-bg-muted flex flex-col">
      <div className="flex items-center px-3 py-1.5 border-b border-border bg-bg shrink-0">
        <span className="text-[11px] font-mono text-muted tracking-wide">
          {t("streamterminal.TERMINAL")}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-2 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap break-all"
      >
        {lines.length === 0 ? (
          <span className="text-muted italic text-[11px]">
            {t("streamterminal.WaitingForTerminal")}
          </span>
        ) : (
          lines.map((line) => (
            <div
              key={line.id}
              className={
                line.type === "command"
                  ? "text-txt font-bold"
                  : line.type === "stderr" || line.type === "error"
                    ? "text-destructive"
                    : line.type === "exit"
                      ? "text-muted"
                      : "text-txt"
              }
            >
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
