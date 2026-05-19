import { client } from "@elizaos/ui";
import { useEffect, useRef } from "react";

/**
 * Renders a single xterm.js terminal for a PTY session.
 * On mount: loads xterm lazily, hydrates buffered output, subscribes to live data.
 * On unmount: unsubscribes and disposes.
 */
export function PtyTerminalPane({
  sessionId,
  visible,
}: {
  sessionId: string;
  visible: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ dispose: () => void } | null>(null);
  const fitRef = useRef<{ fit: () => void } | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;

    let disposed = false;
    let unsub: (() => void) | undefined;
    let resizeObserver: ResizeObserver | undefined;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);

      if (disposed || !containerRef.current) return;

      const cs = getComputedStyle(containerRef.current);
      const cssVar = (name: string, fallback: string) =>
        cs.getPropertyValue(name).trim() || fallback;

      const term = new Terminal({
        allowTransparency: true,
        convertEol: true,
        cursorBlink: true,
        fontFamily: "var(--font-mono, monospace)",
        fontSize: 12,
        scrollback: 5000,
        theme: {
          background: "rgba(0, 0, 0, 0)",
          black: "#1a1b26",
          blue: "#7aa2f7",
          brightBlack: "#6e7681",
          brightBlue: "#8fb3ff",
          brightCyan: "#a2e9ff",
          brightGreen: "#b9f27c",
          brightMagenta: "#caa9fa",
          brightRed: "#ff7a93",
          brightWhite: "#ffffff",
          brightYellow: "#ffd580",
          cursor: cssVar("--accent", "#5a9a2a"),
          cyan: "#7dcfff",
          foreground: cssVar("--txt", "#e4e4e7"),
          green: "#9ece6a",
          magenta: "#bb9af7",
          red: "#f7768e",
          selectionBackground: cssVar(
            "--accent-muted",
            "rgba(90, 154, 42, 0.3)",
          ),
          white: "#c0caf5",
          yellow: "#e0af68",
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);

      fitRef.current = fitAddon;
      termRef.current = {
        dispose: () => {
          resizeObserver?.disconnect();
          term.dispose();
        },
      };

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!disposed) {
            try {
              fitAddon.fit();
            } catch {
              // Container may not have layout yet.
            }
          }
        });
      });

      try {
        const buf = await client.getPtyBufferedOutput(sessionId);
        if (!disposed && buf) {
          // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape
          term.write(buf.replace(/\x1b\[3J/g, ""));
          term.scrollToBottom();
        }
      } catch {
        // Session may have ended.
      }

      client.subscribePtyOutput(sessionId);
      unsub = client.onWsEvent(
        "pty-output",
        (data: Record<string, unknown>) => {
          if (
            data.sessionId === sessionId &&
            typeof data.data === "string" &&
            !disposed
          ) {
            // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape
            term.write(data.data.replace(/\x1b\[3J/g, ""));
          }
        },
      );

      term.onData((data: string) => {
        if (!disposed) {
          try {
            client.sendPtyInput(sessionId, data);
          } catch {
            // writeRaw may timeout if worker is busy; non-fatal.
          }
        }
      });

      resizeObserver = new ResizeObserver(() => {
        if (disposed || !containerRef.current) return;
        if (containerRef.current.clientHeight < 10) return;
        try {
          fitAddon.fit();
          client.resizePty(sessionId, term.cols, term.rows);
        } catch {
          // Ignore fit errors during transitions.
        }
      });
      resizeObserver.observe(containerRef.current);
    })();

    return () => {
      disposed = true;
      unsub?.();
      client.unsubscribePtyOutput(sessionId);
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      mountedRef.current = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!visible || !fitRef.current) return;
    const frameId = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // Container may not have layout yet.
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [visible]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ display: visible ? "block" : "none" }}
    />
  );
}
