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

      // Resolve CSS custom properties at mount time — xterm.js passes
      // theme colors directly to canvas.fillStyle which cannot resolve
      // CSS var() expressions. fontFamily works because it's applied to
      // a DOM element, not canvas.
      const cs = getComputedStyle(containerRef.current);
      const cssVar = (name: string, fallback: string) =>
        cs.getPropertyValue(name).trim() || fallback;

      const term = new Terminal({
        fontSize: 12,
        fontFamily: "var(--font-mono, monospace)",
        convertEol: true,
        scrollback: 5000,
        cursorBlink: true,
        // Transparent background so the terminal inherits the app's theme
        // (light or dark) instead of forcing a near-black surface. The host
        // container's background becomes the terminal background.
        allowTransparency: true,
        theme: {
          background: "rgba(0, 0, 0, 0)",
          foreground: cssVar("--txt", "#e4e4e7"),
          cursor: cssVar("--accent", "#5a9a2a"),
          selectionBackground: cssVar(
            "--accent-muted",
            "rgba(90, 154, 42, 0.3)",
          ),
          // Full 16-color ANSI palette. xterm's defaults render several
          // dim colors (especially brightBlack, blue, and red) that are
          // illegible against our near-black background. Codex uses
          // brightBlack heavily for commentary / status rows, so a
          // readable palette is required for the terminal to be usable.
          //
          // Palette inspired by Tokyo Night (Storm variant) — chosen
          // for high contrast against #0a0a0a while staying aesthetic
          // and coherent with the green accent already used by the app.
          black: "#1a1b26",
          red: "#f7768e",
          green: "#9ece6a",
          yellow: "#e0af68",
          blue: "#7aa2f7",
          magenta: "#bb9af7",
          cyan: "#7dcfff",
          white: "#c0caf5",
          brightBlack: "#6e7681", // dim commentary — must be readable
          brightRed: "#ff7a93",
          brightGreen: "#b9f27c",
          brightYellow: "#ffd580",
          brightBlue: "#8fb3ff",
          brightMagenta: "#caa9fa",
          brightCyan: "#a2e9ff",
          brightWhite: "#ffffff",
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

      // Double-rAF to let the drawer layout settle before fitting
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!disposed) {
            try {
              fitAddon.fit();
            } catch {
              // Container may not have layout yet
            }
          }
        });
      });

      // Hydrate with buffered output
      try {
        const buf = await client.getPtyBufferedOutput(sessionId);
        if (!disposed && buf) {
          // Strip clear-scrollback ANSI escape to preserve scroll history
          // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape
          term.write(buf.replace(/\x1b\[3J/g, ""));
          term.scrollToBottom();
        }
      } catch {
        // Session may have ended
      }

      // Subscribe to live output AFTER hydration
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

      // Forward keyboard input so users can manually interject with running
      // coding agents through the terminal (e.g. answering prompts, sending
      // Ctrl-C to cancel, or typing follow-up commands).
      term.onData((data: string) => {
        if (!disposed) {
          try {
            client.sendPtyInput(sessionId, data);
          } catch {
            // writeRaw may timeout if worker is busy — non-fatal
          }
        }
      });

      // Resize handling
      resizeObserver = new ResizeObserver(() => {
        if (disposed || !containerRef.current) return;
        if (containerRef.current.clientHeight < 10) return;
        try {
          fitAddon.fit();
          client.resizePty(sessionId, term.cols, term.rows);
        } catch {
          // Ignore fit errors during transitions
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

  // Re-fit when becoming visible
  useEffect(() => {
    if (!visible || !fitRef.current) return;
    const frameId = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // Container may not have layout yet
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [visible]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{
        display: visible ? "block" : "none",
      }}
    />
  );
}
