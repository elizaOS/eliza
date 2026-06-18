/**
 * PhoneAppView — full-screen overlay for the Phone app.
 *
 * Two tabs:
 *   - Dialer: number pad, in-progress display, place-call button.
 *   - Recent: scrollable call log with type icon, name/number, timestamp.
 *
 * The address book lives in the separate Contacts view; the header "Contacts"
 * affordance navigates there via the `eliza:navigate:view` bus rather than
 * embedding a duplicate contacts pane here.
 *
 * The native dependency (`@elizaos/capacitor-phone`) is imported eagerly —
 * Capacitor's `registerPlugin` returns a proxy that resolves the web fallback
 * on web/iOS, so the import is safe even on non-Android platforms.
 */

import type { CallLogEntry, CallLogType } from "@elizaos/capacitor-phone";
import { Phone } from "@elizaos/capacitor-phone";
import type { OverlayAppContext } from "@elizaos/ui";
import { Button, useAgentElement } from "@elizaos/ui";
import { consumePendingPhoneNumber } from "@elizaos/ui/app-navigate-view";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@elizaos/ui/components/ui/tabs";
import {
  ArrowLeft,
  Delete,
  Phone as PhoneIcon,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  RefreshCw,
  Users as UsersIcon,
  Voicemail,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  callLabelFor,
  loadPhoneState,
  normalizeNumber,
} from "./PhoneAppView.helpers.ts";

const DIAL_KEYS: readonly string[] = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "*",
  "0",
  "#",
];

type PhoneTab = "dialer" | "recent";

function defaultOverlayContext(): OverlayAppContext {
  return {
    exitToApps: () => {
      if (typeof window !== "undefined") window.history.back();
    },
    uiTheme: "light",
    t: (key: string, opts?: { defaultValue?: string }) =>
      typeof opts?.defaultValue === "string" ? opts.defaultValue : key,
  };
}

function formatTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function callIconFor(type: CallLogType) {
  switch (type) {
    case "incoming":
    case "answered_externally":
      return <PhoneIncoming className="h-4 w-4 text-ok" aria-hidden />;
    case "outgoing":
      return <PhoneOutgoing className="h-4 w-4 text-accent" aria-hidden />;
    case "missed":
    case "rejected":
    case "blocked":
      return <PhoneMissed className="h-4 w-4 text-danger" aria-hidden />;
    case "voicemail":
      return <Voicemail className="h-4 w-4 text-muted" aria-hidden />;
    default:
      return <PhoneIcon className="h-4 w-4 text-muted" aria-hidden />;
  }
}

function PhoneTabTrigger({
  tab,
  label,
  active,
  disabled,
}: {
  tab: PhoneTab;
  label: string;
  active: boolean;
  disabled?: boolean;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `tab-${tab}`,
    role: "tab",
    label,
    group: "phone-tabs",
    status: active ? "active" : "inactive",
    description: `Switch to the ${label} tab`,
  });
  return (
    <TabsTrigger
      ref={ref}
      value={tab}
      disabled={disabled}
      aria-current={active ? "true" : undefined}
      className="rounded-full font-semibold transition-colors"
      style={{
        backgroundColor: active ? "var(--accent-subtle)" : "transparent",
        color: active ? "var(--accent)" : "var(--muted)",
        border: active ? "1px solid var(--accent)" : "1px solid transparent",
      }}
      {...agentProps}
    >
      {label}
    </TabsTrigger>
  );
}

function PhoneDialKey({
  digit,
  onPress,
}: {
  digit: string;
  onPress: (digit: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `dial-key-${digit}`,
    role: "button",
    label: `Dial ${digit}`,
    group: "phone-dialpad",
    description: `Append ${digit} to the number being dialed`,
  });
  return (
    <button
      ref={ref}
      type="button"
      className="h-16 rounded-full text-2xl font-semibold transition active:scale-95 sm:h-20"
      style={{
        backgroundColor: "var(--surface)",
        color: "var(--text)",
        border: "1px solid var(--border)",
      }}
      onClick={() => onPress(digit)}
      aria-label={`Dial ${digit}`}
      data-testid={`phone-dial-key-${digit}`}
      {...agentProps}
    >
      {digit}
    </button>
  );
}

function RecentCallButton({
  entry,
  onCall,
}: {
  entry: CallLogEntry;
  onCall: (number: string) => void;
}) {
  const label = callLabelFor(entry);
  const showNumber =
    entry.cachedName && entry.cachedName.trim().length > 0
      ? entry.number
      : null;
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `recent-call-${entry.id}`,
    role: "list-item",
    label: `Call ${label}`,
    group: "phone-recent",
    description: `Place a call to ${label}`,
    onActivate: () => onCall(entry.number),
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onCall(entry.number)}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition active:scale-[0.99]"
      style={{
        backgroundColor: "var(--surface)",
        border: "1px solid transparent",
      }}
      {...agentProps}
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: "var(--accent-subtle)" }}
      >
        {callIconFor(entry.type)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-txt">
          {label}
        </span>
        <span className="block truncate text-xs text-muted">
          {showNumber ? `${showNumber} · ` : ""}
          {formatTimestamp(entry.date)}
        </span>
      </span>
      <PhoneIcon className="h-4 w-4 shrink-0 text-muted" />
    </button>
  );
}

function TuiDialKey({
  digit,
  onPress,
}: {
  digit: string;
  onPress: (digit: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `tui-dial-key-${digit}`,
    role: "button",
    label: `Dial ${digit}`,
    group: "phone-tui-dialpad",
    description: `Append ${digit} to the number being dialed`,
    onActivate: () => onPress(digit),
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onPress(digit)}
      style={{
        backgroundColor: "transparent",
        color: "#e2e8f0",
        border: "1px solid rgba(125,211,252,0.28)",
        borderRadius: 4,
        padding: "8px 0",
        cursor: "pointer",
        fontFamily: "inherit",
      }}
      {...agentProps}
    >
      {digit}
    </button>
  );
}

function TuiRecentCallButton({
  call,
  index,
  onSelect,
}: {
  call: CallLogEntry;
  index: number;
  onSelect: (number: string) => void;
}) {
  const label = callLabelFor(call);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `tui-recent-call-${call.id}`,
    role: "list-item",
    label: `Use ${label}`,
    group: "phone-tui-recent",
    description: `Load ${label} (${call.number}) into the dialer input`,
    onActivate: () => onSelect(call.number),
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(call.number)}
      style={{
        width: "100%",
        display: "grid",
        gridTemplateColumns: "4ch minmax(8ch, 1fr) 10ch",
        gap: 10,
        border: "none",
        borderTop: index === 0 ? "none" : "1px solid rgba(125,211,252,0.18)",
        backgroundColor: "transparent",
        color: "#cbd5e1",
        padding: "8px 0",
        cursor: "pointer",
        fontFamily: "inherit",
        textAlign: "left",
      }}
      {...agentProps}
    >
      <span style={{ color: "#64748b" }}>
        {String(index + 1).padStart(2, "0")}
      </span>
      <span style={{ color: "#e2e8f0", overflow: "hidden" }}>{label}</span>
      <span
        style={{
          color: call.type === "missed" ? "#fca5a5" : "#94a3b8",
        }}
      >
        {call.type}
      </span>
      <span style={{ gridColumn: "2 / 4", color: "#94a3b8" }}>
        {call.number} | {formatTimestamp(call.date)} | {call.durationSeconds}s
      </span>
      {(call.agentSummary || call.agentTranscript) && (
        <span style={{ gridColumn: "2 / 4", color: "#a7f3d0" }}>
          {call.agentSummary ?? call.agentTranscript}
        </span>
      )}
    </button>
  );
}

export function PhoneAppView({ exitToApps, t }: OverlayAppContext) {
  const [activeTab, setActiveTab] = useState<PhoneTab>("dialer");
  const [dialed, setDialed] = useState("");
  const [calling, setCalling] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);

  const [calls, setCalls] = useState<CallLogEntry[]>([]);
  const [callsLoading, setCallsLoading] = useState(false);
  const [callsError, setCallsError] = useState<string | null>(null);

  // Guards the lazy auto-load so an empty recent-calls result does not retrigger
  // the fetch forever (an empty list keeps `calls.length === 0`, which would
  // otherwise re-satisfy the effect's guard on every render → infinite reload).
  const recentAutoLoadedRef = useRef(false);

  const refreshCalls = useCallback(async () => {
    setCallsLoading(true);
    setCallsError(null);
    try {
      // Feature-gated: request phone access on first open (idempotent — already
      // granted never re-prompts). Tolerates older bridges without the request
      // path by falling through to listRecentCalls.
      const status = await Phone.requestPermissions().catch(() => null);
      if (status && status.phone !== "granted") {
        setCalls([]);
        setCallsError(
          "Phone access is needed for recent calls and dialing. Grant it in your device settings, then retry.",
        );
        return;
      }
      const { calls: fetched } = await Phone.listRecentCalls({ limit: 50 });
      setCalls(fetched);
    } catch (err) {
      setCallsError(err instanceof Error ? err.message : String(err));
      setCalls([]);
    } finally {
      setCallsLoading(false);
    }
  }, []);

  // Seed the dialer from a cross-view handoff (e.g. a Contacts "Call" control
  // that navigated here with a number). Single-shot: the number is consumed so
  // a later plain navigation to Phone does not re-seed a stale value.
  useEffect(() => {
    const pending = consumePendingPhoneNumber();
    if (pending) {
      setCallError(null);
      setDialed(pending);
      setActiveTab("dialer");
    }
  }, []);

  // Lazy-load the recent-calls tab on first activation.
  useEffect(() => {
    if (
      activeTab === "recent" &&
      !recentAutoLoadedRef.current &&
      !callsLoading
    ) {
      recentAutoLoadedRef.current = true;
      void refreshCalls();
    }
  }, [activeTab, callsLoading, refreshCalls]);

  const appendDigit = useCallback((digit: string) => {
    setCallError(null);
    setDialed((prev) => `${prev}${digit}`);
  }, []);

  const appendPlus = useCallback(() => {
    setCallError(null);
    setDialed((prev) => (prev.length === 0 ? "+" : prev));
  }, []);

  const backspace = useCallback(() => {
    setCallError(null);
    setDialed((prev) => prev.slice(0, -1));
  }, []);

  const placeCall = useCallback(async (number: string) => {
    const normalized = normalizeNumber(number);
    if (!normalized) {
      setCallError("Enter a number to call.");
      return;
    }
    setCalling(true);
    setCallError(null);
    try {
      await Phone.placeCall({ number: normalized });
    } catch (err) {
      setCallError(err instanceof Error ? err.message : String(err));
    } finally {
      setCalling(false);
    }
  }, []);

  const onDialerCall = useCallback(() => {
    void placeCall(dialed);
  }, [dialed, placeCall]);

  const onCallEntry = useCallback(
    (number: string) => {
      void placeCall(number);
    },
    [placeCall],
  );

  const dialerDisplay = useMemo(() => dialed || "", [dialed]);

  // Open the separate Contacts view via the navigation bus. Contacts live in
  // their own plugin/view; the Phone app links to them rather than embedding a
  // duplicate address book.
  const openContacts = useCallback(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("eliza:navigate:view", {
        detail: { viewId: "contacts", viewPath: "/contacts" },
      }),
    );
  }, []);

  const backLabel = t("nav.back", { defaultValue: "Back" });
  const refreshLabel = t("actions.refresh", { defaultValue: "Refresh" });
  const callLabel = t("phone.dialer.call", { defaultValue: "Call" });
  const intlLabel = t("phone.dialer.intl", {
    defaultValue: "Insert + for international dialing",
  });
  const backspaceLabel = t("phone.dialer.backspace", {
    defaultValue: "Delete digit",
  });

  const backAgent = useAgentElement<HTMLButtonElement>({
    id: "action-back",
    role: "button",
    label: backLabel,
    group: "phone-nav",
    description: "Leave the Phone app and return to the app grid",
  });
  const contactsLabel = t("phone.tabs.contacts", { defaultValue: "Contacts" });
  const contactsNavAgent = useAgentElement<HTMLButtonElement>({
    id: "action-contacts",
    role: "button",
    label: contactsLabel,
    group: "phone-nav",
    description: "Open the Contacts app to browse the address book",
    onActivate: openContacts,
  });
  const refreshAgent = useAgentElement<HTMLButtonElement>({
    id: "action-refresh",
    role: "button",
    label: refreshLabel,
    group: "phone-recent",
    description: "Reload the recent calls list",
  });
  const plusAgent = useAgentElement<HTMLButtonElement>({
    id: "dial-plus",
    role: "button",
    label: intlLabel,
    group: "phone-dialer",
    description: "Insert a leading + for international dialing",
  });
  const callAgent = useAgentElement<HTMLButtonElement>({
    id: "action-call",
    role: "button",
    label: callLabel,
    group: "phone-dialer",
    description: "Place a call to the dialed number",
  });
  const backspaceAgent = useAgentElement<HTMLButtonElement>({
    id: "dial-backspace",
    role: "button",
    label: backspaceLabel,
    group: "phone-dialer",
    description: "Delete the last digit of the dialed number",
  });
  const emptyDialerAgent = useAgentElement<HTMLButtonElement>({
    id: "recent-empty-dialer",
    role: "button",
    label: t("phone.tabs.dialer", { defaultValue: "Dialer" }),
    group: "phone-recent",
    description: "Switch to the Dialer tab from the empty recent-calls state",
    onActivate: () => setActiveTab("dialer"),
  });
  const emptyRefreshAgent = useAgentElement<HTMLButtonElement>({
    id: "recent-empty-refresh",
    role: "button",
    label: refreshLabel,
    group: "phone-recent",
    description: "Reload the recent calls list from the empty state",
    onActivate: () => {
      void refreshCalls();
    },
  });

  return (
    <div
      data-testid="phone-shell"
      className="fixed inset-0 z-50 flex h-[100vh] flex-col overflow-hidden bg-bg pb-[var(--safe-area-bottom,0px)] pl-[var(--safe-area-left,0px)] pr-[var(--safe-area-right,0px)] pt-[var(--safe-area-top,0px)] supports-[height:100dvh]:h-[100dvh]"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border/20 bg-bg/80 px-4 py-3 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <Button
            ref={backAgent.ref}
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-xl text-muted hover:text-txt"
            onClick={exitToApps}
            aria-label={backLabel}
            {...backAgent.agentProps}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-base font-semibold text-txt">
              {t("phone.title", { defaultValue: "Phone" })}
            </h1>
            <p className="text-xs-tight text-muted leading-none">
              {t("phone.subtitle", {
                defaultValue: "Dialer and recent calls",
              })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {activeTab === "recent" ? (
            <Button
              ref={refreshAgent.ref}
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-xl text-muted hover:text-txt"
              onClick={() => void refreshCalls()}
              disabled={callsLoading}
              aria-label={refreshLabel}
              {...refreshAgent.agentProps}
            >
              <RefreshCw
                className={`h-4 w-4 ${callsLoading ? "animate-spin" : ""}`}
              />
            </Button>
          ) : null}
          <Button
            ref={contactsNavAgent.ref}
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-xl text-muted hover:text-txt"
            onClick={openContacts}
            aria-label={contactsLabel}
            data-testid="phone-open-contacts"
            {...contactsNavAgent.agentProps}
          >
            <UsersIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(v: string) => setActiveTab(v as PhoneTab)}
        className="flex flex-1 min-h-0 flex-col"
      >
        <div className="shrink-0 border-b border-border/20 bg-bg/60 px-3 py-2">
          <TabsList
            className="grid w-full max-w-sm grid-cols-2 gap-1"
            style={{ backgroundColor: "var(--surface)" }}
          >
            <PhoneTabTrigger
              tab="dialer"
              label={t("phone.tabs.dialer", { defaultValue: "Dialer" })}
              active={activeTab === "dialer"}
            />
            <PhoneTabTrigger
              tab="recent"
              label={t("phone.tabs.recent", { defaultValue: "Recent" })}
              active={activeTab === "recent"}
            />
          </TabsList>
        </div>

        {/* Dialer */}
        <TabsContent
          value="dialer"
          className="flex-1 overflow-y-auto focus-visible:outline-none"
        >
          <div className="flex min-h-full flex-col items-center px-4 pb-32 pt-6">
            <div className="flex w-full max-w-sm flex-col items-center gap-3 pt-2">
              <output
                className="block min-h-[3rem] w-full select-text rounded-xl px-4 py-3 text-center font-mono text-2xl"
                style={{
                  backgroundColor: "var(--surface)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                }}
                aria-live="polite"
                aria-label={t("phone.dialer.display", {
                  defaultValue: "Number being dialed",
                })}
              >
                {dialerDisplay || (
                  <span className="text-muted">
                    {t("phone.dialer.placeholder", {
                      defaultValue: "Enter a number",
                    })}
                  </span>
                )}
              </output>
              {callError ? (
                <p className="w-full text-center text-sm text-danger">
                  {callError}
                </p>
              ) : null}
            </div>

            {/* Number pad */}
            <div className="grid w-full max-w-sm grid-cols-3 gap-3 py-4">
              {DIAL_KEYS.map((key) => (
                <PhoneDialKey key={key} digit={key} onPress={appendDigit} />
              ))}
            </div>

            {/* Bottom row: + (long-press equivalent), call, backspace */}
            <div className="grid w-full max-w-sm grid-cols-3 items-center gap-3 pb-4">
              <button
                ref={plusAgent.ref}
                type="button"
                className="h-12 rounded-full text-lg font-semibold active:scale-95"
                style={{
                  backgroundColor: "var(--surface)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                }}
                onClick={appendPlus}
                data-testid="phone-dial-plus"
                aria-label={intlLabel}
                {...plusAgent.agentProps}
              >
                +
              </button>
              <button
                ref={callAgent.ref}
                type="button"
                onClick={onDialerCall}
                disabled={calling || dialed.length === 0}
                className="flex h-14 items-center justify-center rounded-full transition-colors active:scale-95 disabled:opacity-50"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-foreground)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--accent-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "var(--accent)";
                }}
                aria-label={callLabel}
                data-testid="phone-dial-call"
                {...callAgent.agentProps}
              >
                <PhoneIcon className="h-6 w-6" aria-hidden />
              </button>
              <button
                ref={backspaceAgent.ref}
                type="button"
                className="flex h-12 items-center justify-center rounded-full active:scale-95 disabled:opacity-50"
                style={{
                  backgroundColor: "var(--surface)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                }}
                onClick={backspace}
                disabled={dialed.length === 0}
                aria-label={backspaceLabel}
                data-testid="phone-dial-backspace"
                {...backspaceAgent.agentProps}
              >
                <Delete className="h-5 w-5" aria-hidden />
              </button>
            </div>
          </div>
        </TabsContent>

        {/* Recent */}
        <TabsContent
          value="recent"
          className="flex-1 overflow-hidden focus-visible:outline-none"
        >
          <div className="chat-native-scrollbar h-full overflow-y-auto px-4 pb-32 pt-3">
            {callsError ? (
              <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                {callsError}
              </p>
            ) : null}
            {!callsError && calls.length === 0 && callsLoading ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted">
                {t("phone.recent.loading", {
                  defaultValue: "Loading recent calls…",
                })}
              </div>
            ) : null}
            {!callsError && calls.length === 0 && !callsLoading ? (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div className="max-w-sm">
                  <PhoneIcon className="mx-auto h-12 w-12 text-muted" />
                  <div className="mt-3 text-sm font-medium text-txt">
                    {t("phone.recent.empty", {
                      defaultValue: "No recent calls.",
                    })}
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {t("phone.recent.emptyBody", {
                      defaultValue:
                        "Recent incoming, outgoing, and missed calls will appear here after Android grants call-log access.",
                    })}
                  </p>
                  <div className="mt-4 flex justify-center gap-2">
                    <Button
                      ref={emptyDialerAgent.ref}
                      variant="outline"
                      size="sm"
                      onClick={() => setActiveTab("dialer")}
                      {...emptyDialerAgent.agentProps}
                    >
                      {t("phone.tabs.dialer", { defaultValue: "Dialer" })}
                    </Button>
                    <Button
                      ref={emptyRefreshAgent.ref}
                      variant="outline"
                      size="sm"
                      onClick={() => void refreshCalls()}
                      {...emptyRefreshAgent.agentProps}
                    >
                      <RefreshCw className="mr-2 h-4 w-4" />
                      {t("actions.refresh", { defaultValue: "Refresh" })}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
            <ul className="flex flex-col gap-1">
              {calls.map((entry) => (
                <li key={entry.id}>
                  <RecentCallButton entry={entry} onCall={onCallEntry} />
                </li>
              ))}
            </ul>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function PhonePluginView() {
  return <PhoneAppView {...defaultOverlayContext()} />;
}

export function PhoneTuiView() {
  const [status, setStatus] = useState<Awaited<
    ReturnType<typeof Phone.getStatus>
  > | null>(null);
  const [calls, setCalls] = useState<CallLogEntry[]>([]);
  const [dialed, setDialed] = useState("");
  const [transcriptCallId, setTranscriptCallId] = useState("");
  const [transcript, setTranscript] = useState("");
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(true);
  const [calling, setCalling] = useState(false);
  const [savingTranscript, setSavingTranscript] = useState(false);
  const [lastAction, setLastAction] = useState("boot");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadPhoneState({ limit: 50 });
      setStatus(next.status);
      setCalls(next.calls);
      setLastAction("refresh");
    } catch (err) {
      setStatus(null);
      setCalls([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const callNumber = useCallback(async () => {
    const number = normalizeNumber(dialed);
    if (!number || calling) return;
    setCalling(true);
    setError(null);
    try {
      await Phone.placeCall({ number });
      setLastAction(`call ${number}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCalling(false);
    }
  }, [calling, dialed]);

  const openDialer = useCallback(async () => {
    const number = normalizeNumber(dialed);
    setError(null);
    try {
      await Phone.openDialer(number ? { number } : undefined);
      setLastAction(number ? `dialer ${number}` : "dialer");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [dialed]);

  const saveTranscript = useCallback(async () => {
    const callId = transcriptCallId.trim();
    const text = transcript.trim();
    if (!callId || !text || savingTranscript) return;
    setSavingTranscript(true);
    setError(null);
    try {
      const result = await Phone.saveCallTranscript({
        callId,
        transcript: text,
        ...(summary.trim() ? { summary: summary.trim() } : {}),
      });
      setLastAction(`transcript ${result.updatedAt}`);
      setTranscript("");
      setSummary("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingTranscript(false);
    }
  }, [refresh, savingTranscript, summary, transcript, transcriptCallId]);

  const numberInputAgent = useAgentElement<HTMLInputElement>({
    id: "tui-number",
    role: "text-input",
    label: "Phone number",
    group: "phone-tui-dialer",
    description: "The phone number to call or open in the dialer",
    getValue: () => dialed,
    onFill: (value) => setDialed(value),
  });
  const tuiBackspaceAgent = useAgentElement<HTMLButtonElement>({
    id: "tui-backspace",
    role: "button",
    label: "Backspace",
    group: "phone-tui-dialer",
    description: "Delete the last digit of the dialed number",
    onActivate: () => setDialed((prev) => (prev ? prev.slice(0, -1) : "")),
  });
  const tuiOpenDialerAgent = useAgentElement<HTMLButtonElement>({
    id: "tui-open-dialer",
    role: "button",
    label: "Open dialer",
    group: "phone-tui-dialer",
    description: "Open the system dialer with the dialed number",
    onActivate: () => {
      void openDialer();
    },
  });
  const tuiCallAgent = useAgentElement<HTMLButtonElement>({
    id: "tui-call",
    role: "button",
    label: "Call",
    group: "phone-tui-dialer",
    description: "Place a call to the dialed number",
    onActivate: () => {
      void callNumber();
    },
  });
  const callIdInputAgent = useAgentElement<HTMLInputElement>({
    id: "tui-call-id",
    role: "text-input",
    label: "Call ID",
    group: "phone-tui-transcript",
    description: "The call ID the transcript will be saved against",
    getValue: () => transcriptCallId,
    onFill: (value) => setTranscriptCallId(value),
  });
  const transcriptInputAgent = useAgentElement<HTMLTextAreaElement>({
    id: "tui-transcript",
    role: "textarea",
    label: "Transcript",
    group: "phone-tui-transcript",
    description: "The transcript text to save for the call",
    getValue: () => transcript,
    onFill: (value) => setTranscript(value),
  });
  const summaryInputAgent = useAgentElement<HTMLInputElement>({
    id: "tui-summary",
    role: "text-input",
    label: "Summary",
    group: "phone-tui-transcript",
    description: "An optional summary saved alongside the transcript",
    getValue: () => summary,
    onFill: (value) => setSummary(value),
  });
  const saveTranscriptAgent = useAgentElement<HTMLButtonElement>({
    id: "tui-save-transcript",
    role: "button",
    label: "Save transcript",
    group: "phone-tui-transcript",
    description: "Save the call ID, transcript, and optional summary",
    onActivate: () => {
      void saveTranscript();
    },
  });
  const tuiRefreshAgent = useAgentElement<HTMLButtonElement>({
    id: "tui-refresh",
    role: "button",
    label: "Refresh",
    group: "phone-tui-recent",
    description: "Reload the recent calls list and phone status",
    onActivate: () => {
      void refresh();
    },
  });

  const state = {
    viewType: "tui",
    viewId: "phone",
    callCount: calls.length,
    dialed,
    canPlaceCalls: status?.canPlaceCalls ?? false,
    isDefaultDialer: status?.isDefaultDialer ?? false,
    defaultDialerPackage: status?.defaultDialerPackage ?? null,
    loading,
    calling,
    savingTranscript,
    lastAction,
    error,
  };

  return (
    <div
      data-view-state={JSON.stringify(state)}
      style={{
        minHeight: "100vh",
        backgroundColor: "#020617",
        color: "#cbd5e1",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        padding: 20,
      }}
    >
      <div style={{ color: "#7dd3fc", marginBottom: 4 }}>
        elizaos://phone --type=tui
      </div>
      <div style={{ color: "#475569", marginBottom: 16 }}>
        {loading ? "loading" : `${calls.length} recent`} |{" "}
        {status?.canPlaceCalls ? "call-ready" : "call-blocked"} | {lastAction}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 16,
        }}
      >
        <section
          aria-label="Phone dialer"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <strong style={{ color: "#e2e8f0" }}>dialer</strong>
          <div style={{ color: "#64748b", margin: "6px 0 14px" }}>
            default dialer: {status?.isDefaultDialer ? "yes" : "no"}{" "}
            {status?.defaultDialerPackage ?? ""}
          </div>

          <label
            htmlFor="phone-tui-number"
            style={{ display: "block", color: "#94a3b8", marginBottom: 6 }}
          >
            number
          </label>
          <input
            ref={numberInputAgent.ref}
            id="phone-tui-number"
            name="number"
            value={dialed}
            onChange={(event) => setDialed(event.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              backgroundColor: "#0f172a",
              color: "#e2e8f0",
              border: "1px solid rgba(125,211,252,0.3)",
              borderRadius: 4,
              padding: 8,
              fontFamily: "inherit",
              marginBottom: 12,
            }}
            {...numberInputAgent.agentProps}
          />

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 8,
              marginBottom: 12,
            }}
          >
            {DIAL_KEYS.map((key) => (
              <TuiDialKey
                key={key}
                digit={key}
                onPress={(digit) => setDialed((prev) => `${prev}${digit}`)}
              />
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
            <button
              ref={tuiBackspaceAgent.ref}
              type="button"
              onClick={() =>
                setDialed((prev) => (prev ? prev.slice(0, -1) : ""))
              }
              style={{
                backgroundColor: "transparent",
                color: "#94a3b8",
                border: "1px solid rgba(148,163,184,0.45)",
                borderRadius: 4,
                padding: "6px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
              {...tuiBackspaceAgent.agentProps}
            >
              backspace
            </button>
            <button
              ref={tuiOpenDialerAgent.ref}
              type="button"
              onClick={() => void openDialer()}
              style={{
                backgroundColor: "transparent",
                color: "#a7f3d0",
                border: "1px solid rgba(167,243,208,0.45)",
                borderRadius: 4,
                padding: "6px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
              {...tuiOpenDialerAgent.agentProps}
            >
              open-dialer
            </button>
            <button
              ref={tuiCallAgent.ref}
              type="button"
              onClick={() => void callNumber()}
              disabled={!normalizeNumber(dialed) || calling}
              style={{
                backgroundColor: "transparent",
                color: "#7dd3fc",
                border: "1px solid rgba(125,211,252,0.45)",
                borderRadius: 4,
                padding: "6px 10px",
                cursor:
                  !normalizeNumber(dialed) || calling
                    ? "not-allowed"
                    : "pointer",
                fontFamily: "inherit",
              }}
              {...tuiCallAgent.agentProps}
            >
              call
            </button>
          </div>

          <strong style={{ color: "#e2e8f0" }}>transcript</strong>
          <label
            htmlFor="phone-tui-call-id"
            style={{ display: "block", color: "#94a3b8", margin: "12px 0 6px" }}
          >
            call id
          </label>
          <input
            ref={callIdInputAgent.ref}
            id="phone-tui-call-id"
            name="callId"
            value={transcriptCallId}
            onChange={(event) => setTranscriptCallId(event.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              backgroundColor: "#0f172a",
              color: "#e2e8f0",
              border: "1px solid rgba(125,211,252,0.3)",
              borderRadius: 4,
              padding: 8,
              fontFamily: "inherit",
              marginBottom: 10,
            }}
            {...callIdInputAgent.agentProps}
          />
          <label
            htmlFor="phone-tui-transcript"
            style={{ display: "block", color: "#94a3b8", marginBottom: 6 }}
          >
            transcript
          </label>
          <textarea
            ref={transcriptInputAgent.ref}
            id="phone-tui-transcript"
            name="transcript"
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
            rows={4}
            style={{
              width: "100%",
              boxSizing: "border-box",
              resize: "vertical",
              backgroundColor: "#0f172a",
              color: "#e2e8f0",
              border: "1px solid rgba(125,211,252,0.3)",
              borderRadius: 4,
              padding: 8,
              fontFamily: "inherit",
              marginBottom: 10,
            }}
            {...transcriptInputAgent.agentProps}
          />
          <label
            htmlFor="phone-tui-summary"
            style={{ display: "block", color: "#94a3b8", marginBottom: 6 }}
          >
            summary
          </label>
          <input
            ref={summaryInputAgent.ref}
            id="phone-tui-summary"
            name="summary"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              backgroundColor: "#0f172a",
              color: "#e2e8f0",
              border: "1px solid rgba(125,211,252,0.3)",
              borderRadius: 4,
              padding: 8,
              fontFamily: "inherit",
              marginBottom: 12,
            }}
            {...summaryInputAgent.agentProps}
          />
          <button
            ref={saveTranscriptAgent.ref}
            type="button"
            onClick={() => void saveTranscript()}
            disabled={
              !transcriptCallId.trim() || !transcript.trim() || savingTranscript
            }
            style={{
              backgroundColor: "transparent",
              color: "#a7f3d0",
              border: "1px solid rgba(167,243,208,0.45)",
              borderRadius: 4,
              padding: "6px 10px",
              cursor:
                !transcriptCallId.trim() ||
                !transcript.trim() ||
                savingTranscript
                  ? "not-allowed"
                  : "pointer",
              fontFamily: "inherit",
            }}
            {...saveTranscriptAgent.agentProps}
          >
            save-transcript
          </button>
        </section>

        <section
          aria-label="Recent calls"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <strong style={{ color: "#e2e8f0" }}>recent calls</strong>
            <button
              ref={tuiRefreshAgent.ref}
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              style={{
                backgroundColor: "transparent",
                color: "#a7f3d0",
                border: "1px solid rgba(167,243,208,0.45)",
                borderRadius: 4,
                padding: "4px 8px",
                cursor: loading ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
              {...tuiRefreshAgent.agentProps}
            >
              refresh
            </button>
          </div>
          {error && <div style={{ color: "#fca5a5" }}>{error}</div>}
          {!loading && !error && calls.length === 0 && (
            <div style={{ color: "#64748b" }}>no recent calls</div>
          )}
          {calls.slice(0, 12).map((call, index) => (
            <TuiRecentCallButton
              key={call.id}
              call={call}
              index={index}
              onSelect={setDialed}
            />
          ))}
        </section>
      </div>
    </div>
  );
}
