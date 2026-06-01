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

      // ANSI palette tracks the active eliza theme — no hardcoded blue/Tokyo-Night
      // hex. Tokens: foreground=--txt, dim=--muted, accent(orange)=--accent,
      // success(green)=--ok. Red is the meaning-correct color for ANSI errors,
      // which eliza has no neutral token for, so the sanctioned error red is used.
      const fg = cssVar("--txt", "#e4e4e7");
      const dim = cssVar("--muted", "rgba(255, 255, 255, 0.58)");
      const dimStrong = cssVar("--muted-strong", "rgba(255, 255, 255, 0.74)");
      const accent = cssVar("--accent", "#ff5800");
      const ok = cssVar("--ok", "#4ade80");
      // Sanctioned error red (text-red-500 / text-red-400) — eliza maps
      // --destructive to orange, but ANSI red must read as error.
      const errorRed = "#ef4444";
      const brightErrorRed = "#f87171";

      const term = new Terminal({
        allowTransparency: true,
        convertEol: true,
        cursorBlink: true,
        fontFamily: "var(--font-mono, monospace)",
        fontSize: 12,
        scrollback: 5000,
        theme: {
          background: "rgba(0, 0, 0, 0)",
          black: dim,
          blue: accent,
          brightBlack: dim,
          brightBlue: accent,
          brightCyan: ok,
          brightGreen: ok,
          brightMagenta: accent,
          brightRed: brightErrorRed,
          brightWhite: fg,
          brightYellow: accent,
          cursor: accent,
          cyan: ok,
          foreground: fg,
          green: ok,
          magenta: accent,
          red: errorRed,
          selectionBackground: cssVar(
            "--accent-muted",
            "rgba(255, 88, 0, 0.3)",
          ),
          white: dimStrong,
          yellow: accent,
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
