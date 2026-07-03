import { Button, client } from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { PtyTerminalPane } from "./PtyTerminalPane";

/** Cerebras inference tier the interactive eliza-code CLI leads with. */
export type CockpitTerminalTier = "fast" | "smart";

/**
 * Which CLI the terminal drives. `"eliza-code"` (default) is the TOS-clean
 * tier on Eliza Cloud/cerebras; `"claude"` / `"codex"` are the experimental
 * vendor tier on the user's own subscription — the server rejects them unless
 * `PTY_VENDOR_CLI_ENABLED=true`.
 */
export type CockpitTerminalKind = "eliza-code" | "claude" | "codex";

export interface CockpitInteractiveTerminalProps {
  /** Which cerebras tier eliza-code leads with (eliza-code sessions only). */
  tier: CockpitTerminalTier;
  /** Which CLI to drive. Defaults to `"eliza-code"`. */
  kind?: CockpitTerminalKind;
  /** Optional working directory for the session. */
  cwd?: string;
  /** Called when the user closes the terminal. */
  onClose?: () => void;
}

type Phase = "spawning" | "ready" | "ended" | "error";

type InteractivePtyClient = typeof client & {
  spawnPtySession(options: {
    kind: CockpitTerminalKind;
    tier?: CockpitTerminalTier;
    cwd?: string;
  }): Promise<{ sessionId: string }>;
  stopPtySession(sessionId: string): Promise<boolean>;
};

const ptyClient = client as InteractivePtyClient;

/**
 * The "tap-in, drive it directly" pillar of the cockpit: launches a REAL
 * interactive `eliza-code` CLI on Eliza Cloud/cerebras (`@elizaos/plugin-pty`'s
 * `spawnPtySession`) and mounts the live xterm pane on it. eliza-code is a real
 * slash-command TUI we own, so this is a real CLI — all slash commands — with
 * zero TOS exposure. The same surface hosts the experimental
 * `kind="claude" | "codex"` vendor tier (server-gated by
 * PTY_VENDOR_CLI_ENABLED, default off).
 *
 * Self-contained: spawns once on mount, surfaces spawn errors with a retry, and
 * kills the session on unmount so the REPL process never orphans.
 */
export function CockpitInteractiveTerminal({
  tier,
  kind = "eliza-code",
  cwd,
  onClose,
}: CockpitInteractiveTerminalProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("spawning");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const spawnStartedRef = useRef(false);
  const activeSessionRef = useRef<string | null>(null);

  // The cerebras tier only means something to eliza-code; the vendor CLIs
  // pick their own models.
  const headerLabel =
    kind === "eliza-code"
      ? `eliza-code · ${tier === "smart" ? "smart" : "fast"} · Cerebras`
      : `${kind} · interactive`;

  const spawn = useCallback(async () => {
    setPhase("spawning");
    setError(null);
    setExitCode(null);
    try {
      const { sessionId: id } = await ptyClient.spawnPtySession({
        kind,
        ...(kind === "eliza-code" ? { tier } : {}),
        ...(cwd ? { cwd } : {}),
      });
      activeSessionRef.current = id;
      setSessionId(id);
      setPhase("ready");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Couldn't start the interactive terminal.",
      );
      setPhase("error");
    }
  }, [kind, tier, cwd]);

  // Spawn exactly once on mount.
  useEffect(() => {
    if (spawnStartedRef.current) return;
    spawnStartedRef.current = true;
    void spawn();
  }, [spawn]);

  // Surface session death. The agent server bridges the PTY's `session_exit`
  // as a `pty-exit` WS event; without this the pane stays "ready" forever over
  // a dead session (nothing echoes, input goes nowhere).
  useEffect(() => {
    if (!sessionId) return;
    return ptyClient.onWsEvent("pty-exit", (data: Record<string, unknown>) => {
      if (data.sessionId !== sessionId) return;
      // The process is already dead — clear the ref so unmount/close doesn't
      // issue a redundant stop against a reaped session.
      if (activeSessionRef.current === sessionId) {
        activeSessionRef.current = null;
      }
      setExitCode(typeof data.exitCode === "number" ? data.exitCode : null);
      setPhase("ended");
    });
  }, [sessionId]);

  // Kill the session when the terminal goes away — eliza-code is a REPL and
  // won't exit on its own, so an unclosed session would leave an orphan process.
  useEffect(
    () => () => {
      const id = activeSessionRef.current;
      activeSessionRef.current = null;
      if (id) void ptyClient.stopPtySession(id);
    },
    [],
  );

  const retry = useCallback(() => {
    void spawn();
  }, [spawn]);

  const close = useCallback(() => {
    const id = activeSessionRef.current;
    activeSessionRef.current = null;
    if (id) void ptyClient.stopPtySession(id);
    onClose?.();
  }, [onClose]);

  return (
    <div
      data-testid="cockpit-interactive-terminal"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "var(--bg, #0b0b0f)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 10px",
          borderBottom: "1px solid var(--border, rgba(255,255,255,0.08))",
          fontSize: 12,
          color: "var(--txt-muted, #9aa0aa)",
        }}
      >
        <span>{headerLabel}</span>
        <Button
          unstyled
          type="button"
          data-testid="cockpit-terminal-close"
          onClick={close}
          style={{
            background: "transparent",
            border: "none",
            color: "inherit",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          ✕
        </Button>
      </div>

      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {phase === "spawning" ? (
          <div
            data-testid="cockpit-terminal-spawning"
            style={{
              padding: 16,
              fontSize: 13,
              color: "var(--txt-muted, #9aa0aa)",
            }}
          >
            {kind === "eliza-code"
              ? "Starting interactive eliza-code on Cerebras…"
              : `Starting interactive ${kind}…`}
          </div>
        ) : null}

        {phase === "ended" ? (
          <div
            data-testid="cockpit-terminal-ended"
            style={{
              padding: 16,
              fontSize: 13,
              color: "var(--txt-muted, #9aa0aa)",
            }}
          >
            <div>
              {kind} session ended
              {exitCode !== null ? ` (exit ${exitCode})` : ""}.
            </div>
            <Button
              type="button"
              size="sm"
              data-testid="cockpit-terminal-restart"
              onClick={retry}
              style={{
                marginTop: 10,
              }}
            >
              Restart
            </Button>
          </div>
        ) : null}

        {phase === "error" ? (
          <div
            data-testid="cockpit-terminal-error"
            style={{
              padding: 16,
              fontSize: 13,
              color: "var(--danger, #f7768e)",
            }}
          >
            <div>{error}</div>
            <Button
              type="button"
              size="sm"
              data-testid="cockpit-terminal-retry"
              onClick={retry}
              style={{
                marginTop: 10,
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {sessionId ? (
          <PtyTerminalPane sessionId={sessionId} visible={phase === "ready"} />
        ) : null}
      </div>
    </div>
  );
}
