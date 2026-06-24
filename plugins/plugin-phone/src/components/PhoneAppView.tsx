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
import { PermissionRecoveryCallout } from "@elizaos/ui/components";
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
  Users as UsersIcon,
  Voicemail,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { callLabelFor, normalizeNumber } from "./PhoneAppView.helpers.ts";

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

function isPhonePermissionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("permission") ||
    normalized.includes("denied") ||
    normalized.includes("access is needed") ||
    normalized.includes("call_phone") ||
    normalized.includes("read_call_log")
  );
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
      className="font-semibold transition-colors"
      style={{
        backgroundColor: "transparent",
        color: active ? "var(--accent)" : "var(--muted)",
        border: "1px solid transparent",
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
      className="h-16 text-2xl font-semibold transition active:scale-95 sm:h-20"
      style={{
        backgroundColor: "transparent",
        color: "var(--text)",
        border: "none",
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
      className="flex w-full items-center gap-3 px-2 py-2 text-left transition active:scale-[0.99]"
      style={{
        backgroundColor: "transparent",
        border: "none",
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

  // Lazy-load the recent-calls tab on first activation, then keep it fresh with
  // a quiet 20s poll while the tab is active (no manual Refresh control). The
  // poll is torn down when the tab changes or the view unmounts.
  useEffect(() => {
    if (activeTab !== "recent") return;
    if (!recentAutoLoadedRef.current && !callsLoading) {
      recentAutoLoadedRef.current = true;
      void refreshCalls();
    }
    const interval = setInterval(() => {
      void refreshCalls();
    }, 20_000);
    return () => clearInterval(interval);
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

  return (
    <div
      data-testid="phone-shell"
      className="fixed inset-0 z-50 flex h-[100vh] flex-col overflow-hidden bg-bg pb-[var(--safe-area-bottom,0px)] pl-[var(--safe-area-left,0px)] pr-[var(--safe-area-right,0px)] pt-[var(--safe-area-top,0px)] supports-[height:100dvh]:h-[100dvh]"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <div className="flex items-center gap-3">
          <Button
            ref={backAgent.ref}
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-muted hover:text-txt"
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
            <p className="sr-only text-xs-tight text-muted leading-none">
              {t("phone.subtitle", {
                defaultValue: "Dialer and recent calls",
              })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            ref={contactsNavAgent.ref}
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-muted hover:text-txt"
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
        <div className="shrink-0 px-3 py-1">
          <TabsList className="grid w-full max-w-sm grid-cols-2 gap-1 bg-transparent">
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
                className="block min-h-[3rem] w-full select-text px-4 py-3 text-center font-mono text-2xl"
                style={{
                  backgroundColor: "transparent",
                  border: "none",
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
              {callError && isPhonePermissionError(callError) ? (
                <PermissionRecoveryCallout
                  permission="phone"
                  title={t("phone.permissionTitle", {
                    defaultValue: "Phone access is off",
                  })}
                  description={callError}
                  onRetry={() => void refreshCalls()}
                  retryLabel={t("actions.retry", { defaultValue: "Try again" })}
                  className="w-full max-w-sm"
                  testId="phone-permission-callout"
                />
              ) : callError ? (
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
                className="h-12 text-lg font-semibold active:scale-95"
                style={{
                  backgroundColor: "transparent",
                  border: "none",
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
                className="flex h-12 items-center justify-center active:scale-95 disabled:opacity-50"
                style={{
                  backgroundColor: "transparent",
                  border: "none",
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
            {callsError && isPhonePermissionError(callsError) ? (
              <PermissionRecoveryCallout
                permission="phone"
                title={t("phone.permissionTitle", {
                  defaultValue: "Phone access is off",
                })}
                description={callsError}
                onRetry={refreshCalls}
                retryLabel={t("actions.retry", { defaultValue: "Try again" })}
                className="mb-3"
                testId="phone-recent-permission-callout"
              />
            ) : callsError ? (
              <p className="px-1 py-2 text-sm text-danger">{callsError}</p>
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
                      defaultValue: "No recent",
                    })}
                  </div>
                  <p className="sr-only mt-1 text-xs text-muted">
                    {t("phone.recent.emptyBody", {
                      defaultValue:
                        "Recent incoming, outgoing, and missed calls will appear here after Android grants call-log access.",
                    })}
                  </p>
                  <div className="mt-4 flex justify-center gap-2">
                    <Button
                      ref={emptyDialerAgent.ref}
                      variant="ghost"
                      size="sm"
                      onClick={() => setActiveTab("dialer")}
                      {...emptyDialerAgent.agentProps}
                    >
                      {t("phone.tabs.dialer", { defaultValue: "Dialer" })}
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
