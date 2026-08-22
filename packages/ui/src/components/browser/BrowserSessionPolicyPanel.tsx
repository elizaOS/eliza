/**
 * Visible policy-controlled browser session surface: lists the agent's bridge
 * sessions with the effective domain-mode verdict for each, exposes user
 * takeover (confirm / decline) for sessions parked awaiting confirmation,
 * surfaces intercepted submit/account-affecting steps, per-domain grant and
 * block controls, session TTL, and a credential-redacted receipt for
 * finished sessions.
 *
 * Data flows through the injected {@link BrowserSessionPolicyApi} (the shared
 * `client` implements it via `client-browser-bridge`), so tests drive the
 * panel with a protocol-faithful transport fake. Loading, designed-empty, and
 * error are three distinct states. The clock is owned here via an effect —
 * never read in render — so renders stay deterministic.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BrowserBridgeSettings,
  UpdateBrowserBridgeSettingsRequest,
} from "../../api/browser-contracts";
import type {
  BrowserBridgeSession,
  BrowserBridgeSessionResponse,
  BrowserBridgeSessionsResponse,
  BrowserBridgeSettingsResponse,
} from "../../api/client-browser-bridge";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  type BrowserDomainPolicyMode,
  browserSessionExpiresAt,
  interceptedSessionActions,
  isBrowserSessionExpired,
  resolveBrowserDomainPolicy,
  sessionRequiresTakeover,
  summarizeBrowserSessionReceipt,
} from "./browser-session-policy";

export interface BrowserSessionPolicyApi {
  listBrowserBridgeSessions(): Promise<BrowserBridgeSessionsResponse>;
  getBrowserBridgeSettings(): Promise<BrowserBridgeSettingsResponse>;
  updateBrowserBridgeSettings(
    request: UpdateBrowserBridgeSettingsRequest,
  ): Promise<BrowserBridgeSettingsResponse>;
  confirmBrowserBridgeSession(
    id: string,
    confirmed: boolean,
  ): Promise<BrowserBridgeSessionResponse>;
}

export interface BrowserSessionPolicyPanelProps {
  api: BrowserSessionPolicyApi;
  /** Clock refresh cadence for TTL annotations; defaults to 30s. */
  clockIntervalMs?: number;
  /** Omit the redundant empty card when a parent already declares an empty browser workspace. */
  hideWhenEmpty?: boolean;
}

const POLICY_MODE_LABELS: Record<BrowserDomainPolicyMode, string> = {
  bridge_disabled: "Bridge disabled",
  control_disabled: "Browser control off",
  paused: "Paused",
  blocked: "Blocked",
  all_sites: "All sites allowed",
  granted: "Granted",
  current_site_only: "Current site only",
  outside_grants: "Not granted",
  unresolved: "Unknown domain",
};

const STATUS_LABELS: Record<BrowserBridgeSession["status"], string> = {
  awaiting_confirmation: "Awaiting your confirmation",
  queued: "Queued",
  running: "Running",
  done: "Done",
  cancelled: "Cancelled",
  failed: "Failed",
};

function policyBadgeClass(allowed: boolean, mode: BrowserDomainPolicyMode) {
  if (mode === "blocked") {
    return "border-danger/50 bg-danger/15 text-danger";
  }
  return allowed
    ? "border-accent/50 bg-accent/15 text-accent"
    : "border-border bg-muted/40 text-muted-foreground";
}

type LoadPhase = "loading" | "error" | "ready";

export function BrowserSessionPolicyPanel({
  api,
  clockIntervalMs = 30_000,
  hideWhenEmpty = false,
}: BrowserSessionPolicyPanelProps) {
  const [phase, setPhase] = useState<LoadPhase>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<BrowserBridgeSession[]>([]);
  const [settings, setSettings] = useState<BrowserBridgeSettings | null>(null);
  const [nowIso, setNowIso] = useState<string | null>(null);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [pendingDomain, setPendingDomain] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setNowIso(new Date().toISOString());
    const timer = setInterval(() => {
      setNowIso(new Date().toISOString());
    }, clockIntervalMs);
    return () => clearInterval(timer);
  }, [clockIntervalMs]);

  const load = useCallback(async () => {
    setPhase("loading");
    setLoadError(null);
    try {
      const [sessionsResponse, settingsResponse] = await Promise.all([
        api.listBrowserBridgeSessions(),
        api.getBrowserBridgeSettings(),
      ]);
      if (!mountedRef.current) return;
      setSessions(sessionsResponse.sessions);
      setSettings(settingsResponse.settings);
      setPhase("ready");
    } catch (error) {
      // error-policy:J4 user-facing degrade — the fetch failure becomes the
      // panel's visibly distinct error state with a retry affordance.
      if (!mountedRef.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
      setPhase("error");
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmSession = useCallback(
    async (id: string, confirmed: boolean) => {
      setPendingSessionId(id);
      setActionError(null);
      try {
        const { session } = await api.confirmBrowserBridgeSession(
          id,
          confirmed,
        );
        if (!mountedRef.current) return;
        setSessions((current) =>
          current.map((existing) =>
            existing.id === session.id ? session : existing,
          ),
        );
      } catch (error) {
        // error-policy:J4 user-facing degrade — a failed takeover call becomes
        // the panel's visible action-error banner; the session keeps its state.
        if (!mountedRef.current) return;
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        if (mountedRef.current) setPendingSessionId(null);
      }
    },
    [api],
  );

  const updateDomainPolicy = useCallback(
    async (domain: string, action: "grant" | "block" | "unblock") => {
      if (!settings) return;
      setPendingDomain(domain);
      setActionError(null);
      const grantedOrigins =
        action === "grant"
          ? Array.from(new Set([...settings.grantedOrigins, domain]))
          : settings.grantedOrigins.filter((origin) => origin !== domain);
      const blockedOrigins =
        action === "block"
          ? Array.from(new Set([...settings.blockedOrigins, domain]))
          : action === "unblock"
            ? settings.blockedOrigins.filter((origin) => origin !== domain)
            : settings.blockedOrigins;
      try {
        const { settings: updated } = await api.updateBrowserBridgeSettings({
          grantedOrigins,
          blockedOrigins,
        });
        if (!mountedRef.current) return;
        setSettings(updated);
      } catch (error) {
        // error-policy:J4 user-facing degrade — a failed policy write becomes
        // the visible action-error banner; the stored settings are untouched.
        if (!mountedRef.current) return;
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        if (mountedRef.current) setPendingDomain(null);
      }
    },
    [api, settings],
  );

  const visibleSessions = useMemo(() => {
    if (!nowIso) return sessions;
    return sessions.filter(
      (session) => !isBrowserSessionExpired(session, nowIso),
    );
  }, [sessions, nowIso]);

  if (phase === "loading") {
    return (
      <div
        data-testid="browser-session-policy-loading"
        className="flex items-center gap-2 p-4 text-sm text-muted-foreground"
      >
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        Loading browser sessions…
      </div>
    );
  }

  if (phase === "error" || !settings) {
    return (
      <div
        data-testid="browser-session-policy-error"
        className="flex flex-col gap-2 rounded-sm border border-danger/50 bg-danger/10 p-4 text-sm text-danger"
      >
        <span>Failed to load browser sessions.</span>
        {loadError ? (
          <span className="text-xs opacity-80">{loadError}</span>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  if (visibleSessions.length === 0) {
    if (hideWhenEmpty) return null;
    return (
      <div
        data-testid="browser-session-policy-empty"
        className="rounded-sm border border-border bg-muted/30 p-4 text-sm text-muted-foreground"
      >
        No browser sessions yet. When the agent drives a website, the session
        appears here with its domain policy and controls.
      </div>
    );
  }

  return (
    <div
      data-testid="browser-session-policy-panel"
      className="flex flex-col gap-3"
    >
      {actionError ? (
        <div
          data-testid="browser-session-policy-action-error"
          className="rounded-sm border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {actionError}
        </div>
      ) : null}
      {visibleSessions.map((session) => {
        const verdict = resolveBrowserDomainPolicy(
          session.domain,
          settings,
          nowIso ?? session.updatedAt,
        );
        const intercepted = interceptedSessionActions(session, settings);
        const receipt =
          session.status === "done" || session.status === "failed"
            ? summarizeBrowserSessionReceipt(session)
            : [];
        const expiresAt = browserSessionExpiresAt(session);
        const takeover = sessionRequiresTakeover(session);
        const busy = pendingSessionId === session.id;
        const domainBusy = pendingDomain === session.domain;
        const blocked = verdict.mode === "blocked";
        return (
          <div
            key={session.id}
            data-testid={`browser-session-${session.id}`}
            className="flex flex-col gap-2 rounded-sm border border-border bg-background/60 p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{session.title}</span>
              <span
                data-testid={`browser-session-${session.id}-policy`}
                className={cn(
                  "rounded-sm border px-1.5 py-0.5 text-[11px] leading-4",
                  policyBadgeClass(verdict.allowed, verdict.mode),
                )}
              >
                {POLICY_MODE_LABELS[verdict.mode]}
              </span>
              <span className="text-xs text-muted-foreground">
                {session.domain}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span data-testid={`browser-session-${session.id}-status`}>
                {STATUS_LABELS[session.status]}
              </span>
              {expiresAt &&
              (session.status === "done" ||
                session.status === "cancelled" ||
                session.status === "failed") ? (
                <span data-testid={`browser-session-${session.id}-expiry`}>
                  Removed after {expiresAt}
                </span>
              ) : null}
            </div>
            {intercepted.length > 0 ? (
              <div
                data-testid={`browser-session-${session.id}-intercepted`}
                className="rounded-sm border border-accent/40 bg-accent/10 px-2 py-1.5 text-xs"
              >
                <span className="font-medium">Held for confirmation:</span>{" "}
                {intercepted.map((action) => action.label).join(", ")}
              </div>
            ) : null}
            {takeover ? (
              <div className="flex gap-2">
                <Button
                  data-agent-id={`browser-session-${session.id}-approve`}
                  size="sm"
                  disabled={busy}
                  data-testid={`browser-session-${session.id}-approve`}
                  onClick={() => void confirmSession(session.id, true)}
                >
                  Approve and continue
                </Button>
                <Button
                  data-agent-id={`browser-session-${session.id}-decline`}
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid={`browser-session-${session.id}-decline`}
                  onClick={() => void confirmSession(session.id, false)}
                >
                  Decline
                </Button>
              </div>
            ) : null}
            <div className="flex gap-2">
              {blocked ? (
                <Button
                  data-agent-id={`browser-session-${session.id}-unblock`}
                  size="sm"
                  variant="outline"
                  disabled={domainBusy}
                  data-testid={`browser-session-${session.id}-unblock`}
                  onClick={() =>
                    void updateDomainPolicy(session.domain, "unblock")
                  }
                >
                  Unblock {session.domain}
                </Button>
              ) : (
                <>
                  {verdict.mode === "outside_grants" ? (
                    <Button
                      data-agent-id={`browser-session-${session.id}-grant`}
                      size="sm"
                      variant="outline"
                      disabled={domainBusy}
                      data-testid={`browser-session-${session.id}-grant`}
                      onClick={() =>
                        void updateDomainPolicy(session.domain, "grant")
                      }
                    >
                      Grant {session.domain}
                    </Button>
                  ) : null}
                  <Button
                    data-agent-id={`browser-session-${session.id}-block`}
                    size="sm"
                    variant="outline"
                    disabled={domainBusy}
                    data-testid={`browser-session-${session.id}-block`}
                    onClick={() =>
                      void updateDomainPolicy(session.domain, "block")
                    }
                  >
                    Block {session.domain}
                  </Button>
                </>
              )}
            </div>
            {receipt.length > 0 ? (
              <dl
                data-testid={`browser-session-${session.id}-receipt`}
                className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-sm border border-border bg-muted/20 px-2 py-1.5 text-xs"
              >
                {receipt.map((entry) => (
                  <div key={entry.key} className="contents">
                    <dt className="text-muted-foreground">{entry.key}</dt>
                    <dd
                      className={cn(
                        "break-all",
                        entry.redacted && "italic text-muted-foreground",
                      )}
                    >
                      {entry.value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
