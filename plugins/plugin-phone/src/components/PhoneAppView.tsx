/**
 * PhoneAppView — full-screen overlay for the Phone app.
 *
 * Three tabs:
 *   - Dialer: number pad, in-progress display, place-call button.
 *   - Recent: scrollable call log with type icon, name/number, timestamp.
 *   - Contacts: optional, only when `@elizaos/capacitor-contacts` is loadable
 *     and contact permission has been granted.
 *
 * The native dependency (`@elizaos/capacitor-phone`) is imported eagerly —
 * Capacitor's `registerPlugin` returns a proxy that resolves the web fallback
 * on web/iOS, so the import is safe even on non-Android platforms.
 *
 * Contacts are loaded with a soft import so the Phone app still mounts on
 * devices without contacts permission (or where the contacts plugin is not
 * compiled into the host APK).
 */

import type { CallLogEntry, CallLogType } from "@elizaos/capacitor-phone";
import { Phone } from "@elizaos/capacitor-phone";
import type { OverlayAppContext } from "@elizaos/ui";
import { Button, useAgentElement } from "@elizaos/ui";
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
  User as UserIcon,
  Voicemail,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface ContactRow {
  id: string;
  displayName: string;
  phoneNumbers: string[];
}

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

type PhoneTab = "dialer" | "recent" | "contacts";
const DEFAULT_CALL_LOG_LIMIT = 50;
const MAX_CALL_LOG_LIMIT = 200;

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
      return <PhoneOutgoing className="h-4 w-4 text-info" aria-hidden />;
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

function callLabelFor(entry: CallLogEntry): string {
  if (entry.cachedName && entry.cachedName.trim().length > 0) {
    return entry.cachedName.trim();
  }
  if (entry.number && entry.number.trim().length > 0) {
    return entry.number.trim();
  }
  return "Unknown";
}

/** Strip whitespace and visual separators while keeping leading + and digits. */
function normalizeNumber(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const leadingPlus = trimmed.startsWith("+") ? "+" : "";
  return `${leadingPlus}${trimmed.replace(/[^0-9]/g, "")}`;
}

function normalizeCallLogLimit(limit: unknown): number {
  if (!Number.isFinite(limit) || typeof limit !== "number") {
    return DEFAULT_CALL_LOG_LIMIT;
  }
  return Math.min(MAX_CALL_LOG_LIMIT, Math.max(1, Math.trunc(limit)));
}

async function loadPhoneState(options?: { limit?: unknown; number?: string }) {
  const normalizedNumber =
    typeof options?.number === "string" ? normalizeNumber(options.number) : "";
  const [status, recent] = await Promise.all([
    Phone.getStatus().catch(() => null),
    Phone.listRecentCalls({
      limit: normalizeCallLogLimit(options?.limit),
      ...(normalizedNumber ? { number: normalizedNumber } : {}),
    }),
  ]);
  return {
    status,
    calls: recent.calls,
  };
}

interface ContactsModule {
  Contacts: {
    listContacts(options?: {
      limit?: number;
    }): Promise<{ contacts: ContactRow[] }>;
  };
}

/**
 * Lazily import `@elizaos/capacitor-contacts`. Soft-fails so the Phone app
 * still mounts on devices where contacts is not compiled in.
 *
 * The dynamic specifier is built at runtime so TypeScript does not require the
 * package's type declarations during typecheck, and Vite skips static analysis
 * via the inline ignore comment.
 */
async function loadContactsModule(): Promise<ContactsModule | null> {
  const specifier = "@elizaos/capacitor-contacts";
  try {
    const mod = (await import(/* @vite-ignore */ specifier)) as ContactsModule;
    if (mod && typeof mod.Contacts.listContacts === "function") {
      return mod;
    }
    return null;
  } catch {
    return null;
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
      className="h-16 rounded-full border border-border bg-bg-accent text-2xl font-semibold text-txt transition active:scale-95 hover:bg-bg-accent/70 sm:h-20"
      onClick={() => onPress(digit)}
      aria-label={`Dial ${digit}`}
      data-testid={`phone-dial-key-${digit}`}
      {...agentProps}
    >
      {digit}
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

  const [contacts, setContacts] = useState<ContactRow[] | null>(null);
  const [contactsAvailable, setContactsAvailable] = useState(false);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const contactsModuleRef = useRef<ContactsModule | null>(null);

  const refreshCalls = useCallback(async () => {
    setCallsLoading(true);
    setCallsError(null);
    try {
      const { calls: fetched } = await Phone.listRecentCalls({ limit: 50 });
      setCalls(fetched);
    } catch (err) {
      setCallsError(err instanceof Error ? err.message : String(err));
      setCalls([]);
    } finally {
      setCallsLoading(false);
    }
  }, []);

  const loadContacts = useCallback(async () => {
    let mod = contactsModuleRef.current;
    if (!mod) {
      mod = await loadContactsModule();
      contactsModuleRef.current = mod;
    }
    if (!mod) {
      setContactsAvailable(false);
      return;
    }
    setContactsAvailable(true);
    setContactsLoading(true);
    setContactsError(null);
    try {
      const { contacts: fetched } = await mod.Contacts.listContacts({
        limit: 500,
      });
      const filtered = fetched.filter((c) => c.phoneNumbers.length > 0);
      setContacts(filtered);
    } catch (err) {
      setContactsError(err instanceof Error ? err.message : String(err));
      setContacts([]);
    } finally {
      setContactsLoading(false);
    }
  }, []);

  // Probe contacts availability on mount so the tab strip can hide the
  // contacts pane on devices without the plugin.
  useEffect(() => {
    let cancelled = false;
    loadContactsModule().then((mod) => {
      if (cancelled) return;
      contactsModuleRef.current = mod;
      setContactsAvailable(mod !== null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Lazy-load each tab's data on first activation.
  useEffect(() => {
    if (activeTab === "recent" && calls.length === 0 && !callsLoading) {
      void refreshCalls();
    }
    if (
      activeTab === "contacts" &&
      contactsAvailable &&
      contacts === null &&
      !contactsLoading
    ) {
      void loadContacts();
    }
  }, [
    activeTab,
    calls.length,
    callsLoading,
    contactsAvailable,
    contacts,
    contactsLoading,
    loadContacts,
    refreshCalls,
  ]);

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
                defaultValue: "Dialer, recent calls, and contacts",
              })}
            </p>
          </div>
        </div>
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
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(v: string) => setActiveTab(v as PhoneTab)}
        className="flex flex-1 min-h-0 flex-col"
      >
        <div className="shrink-0 border-b border-border/20 bg-bg/60 px-3 py-2">
          <TabsList className="grid w-full max-w-sm grid-cols-3">
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
            <PhoneTabTrigger
              tab="contacts"
              label={t("phone.tabs.contacts", { defaultValue: "Contacts" })}
              active={activeTab === "contacts"}
              disabled={!contactsAvailable}
            />
          </TabsList>
        </div>

        {/* Dialer */}
        <TabsContent
          value="dialer"
          className="flex-1 overflow-y-auto focus-visible:outline-none"
        >
          <div className="flex min-h-full flex-col items-center justify-between px-4 py-6">
            <div className="flex w-full max-w-sm flex-col items-center gap-3 pt-2">
              <output
                className="block min-h-[3rem] w-full select-text rounded-xl border border-border bg-bg-accent px-4 py-3 text-center font-mono text-2xl text-txt"
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
                className="h-12 rounded-full border border-border bg-bg-accent text-lg font-semibold text-txt active:scale-95"
                onClick={appendPlus}
                data-testid="phone-dial-plus"
                aria-label={intlLabel}
                {...plusAgent.agentProps}
              >
                +
              </button>
              <Button
                ref={callAgent.ref}
                onClick={onDialerCall}
                disabled={calling || dialed.length === 0}
                className="h-14 rounded-full bg-ok text-bg hover:bg-ok/90 disabled:opacity-50"
                aria-label={callLabel}
                data-testid="phone-dial-call"
                {...callAgent.agentProps}
              >
                <PhoneIcon className="h-6 w-6" aria-hidden />
              </Button>
              <button
                ref={backspaceAgent.ref}
                type="button"
                className="flex h-12 items-center justify-center rounded-full border border-border bg-bg-accent text-txt active:scale-95 disabled:opacity-50"
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
          <div className="chat-native-scrollbar h-full overflow-y-auto px-4 py-3">
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
                      variant="outline"
                      size="sm"
                      onClick={() => setActiveTab("dialer")}
                    >
                      {t("phone.tabs.dialer", { defaultValue: "Dialer" })}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void refreshCalls()}
                    >
                      <RefreshCw className="mr-2 h-4 w-4" />
                      {t("actions.refresh", { defaultValue: "Refresh" })}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
            <ul className="flex flex-col gap-1">
              {calls.map((entry) => {
                const label = callLabelFor(entry);
                const showNumber =
                  entry.cachedName && entry.cachedName.trim().length > 0
                    ? entry.number
                    : null;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => onCallEntry(entry.number)}
                      className="flex w-full items-center gap-3 rounded-xl border border-transparent bg-bg-accent/40 px-3 py-2.5 text-left transition hover:border-border hover:bg-bg-accent active:scale-[0.99]"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-accent">
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
                  </li>
                );
              })}
            </ul>
          </div>
        </TabsContent>

        {/* Contacts */}
        <TabsContent
          value="contacts"
          className="flex-1 overflow-hidden focus-visible:outline-none"
        >
          <div className="chat-native-scrollbar h-full overflow-y-auto px-4 py-3">
            {!contactsAvailable ? (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div className="max-w-sm">
                  <UserIcon className="mx-auto h-12 w-12 text-muted" />
                  <div className="mt-3 text-sm font-medium text-txt">
                    {t("phone.contacts.unavailable", {
                      defaultValue:
                        "Contacts are not available on this device.",
                    })}
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {t("phone.contacts.unavailableBody", {
                      defaultValue:
                        "Install the Contacts bridge or open the standalone Contacts app to add phone numbers.",
                    })}
                  </p>
                </div>
              </div>
            ) : null}
            {contactsAvailable && contactsError ? (
              <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                {contactsError}
              </p>
            ) : null}
            {contactsAvailable &&
            !contactsError &&
            contacts !== null &&
            contacts.length === 0 &&
            !contactsLoading ? (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div className="max-w-sm">
                  <UserIcon className="mx-auto h-12 w-12 text-muted" />
                  <div className="mt-3 text-sm font-medium text-txt">
                    {t("phone.contacts.empty", {
                      defaultValue: "No contacts with phone numbers.",
                    })}
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {t("phone.contacts.emptyBody", {
                      defaultValue:
                        "Contacts with callable phone numbers will appear here.",
                    })}
                  </p>
                </div>
              </div>
            ) : null}
            <ul className="flex flex-col gap-1">
              {(contacts ?? []).map((contact) => {
                const primary = contact.phoneNumbers[0] ?? "";
                return (
                  <li key={contact.id}>
                    <button
                      type="button"
                      onClick={() => onCallEntry(primary)}
                      disabled={primary.length === 0}
                      className="flex w-full items-center gap-3 rounded-xl border border-transparent bg-bg-accent/40 px-3 py-2.5 text-left transition hover:border-border hover:bg-bg-accent active:scale-[0.99] disabled:opacity-50"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-accent">
                        <UserIcon className="h-4 w-4 text-muted" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-txt">
                          {contact.displayName || primary || "Unknown"}
                        </span>
                        {primary ? (
                          <span className="block truncate text-xs text-muted">
                            {primary}
                          </span>
                        ) : null}
                      </span>
                      <PhoneIcon className="h-4 w-4 shrink-0 text-muted" />
                    </button>
                  </li>
                );
              })}
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
        background: "#020617",
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
          gridTemplateColumns: "minmax(260px, 0.9fr) minmax(320px, 1.1fr)",
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
            id="phone-tui-number"
            name="number"
            value={dialed}
            onChange={(event) => setDialed(event.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "#0f172a",
              color: "#e2e8f0",
              border: "1px solid rgba(125,211,252,0.3)",
              borderRadius: 4,
              padding: 8,
              fontFamily: "inherit",
              marginBottom: 12,
            }}
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
              <button
                key={key}
                type="button"
                onClick={() => setDialed((prev) => `${prev}${key}`)}
                style={{
                  background: "transparent",
                  color: "#e2e8f0",
                  border: "1px solid rgba(125,211,252,0.28)",
                  borderRadius: 4,
                  padding: "8px 0",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {key}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
            <button
              type="button"
              onClick={() =>
                setDialed((prev) => (prev ? prev.slice(0, -1) : ""))
              }
              style={{
                background: "transparent",
                color: "#94a3b8",
                border: "1px solid rgba(148,163,184,0.45)",
                borderRadius: 4,
                padding: "6px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              backspace
            </button>
            <button
              type="button"
              onClick={() => void openDialer()}
              style={{
                background: "transparent",
                color: "#a7f3d0",
                border: "1px solid rgba(167,243,208,0.45)",
                borderRadius: 4,
                padding: "6px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              open-dialer
            </button>
            <button
              type="button"
              onClick={() => void callNumber()}
              disabled={!normalizeNumber(dialed) || calling}
              style={{
                background: "transparent",
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
            id="phone-tui-call-id"
            name="callId"
            value={transcriptCallId}
            onChange={(event) => setTranscriptCallId(event.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "#0f172a",
              color: "#e2e8f0",
              border: "1px solid rgba(125,211,252,0.3)",
              borderRadius: 4,
              padding: 8,
              fontFamily: "inherit",
              marginBottom: 10,
            }}
          />
          <label
            htmlFor="phone-tui-transcript"
            style={{ display: "block", color: "#94a3b8", marginBottom: 6 }}
          >
            transcript
          </label>
          <textarea
            id="phone-tui-transcript"
            name="transcript"
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
            rows={4}
            style={{
              width: "100%",
              boxSizing: "border-box",
              resize: "vertical",
              background: "#0f172a",
              color: "#e2e8f0",
              border: "1px solid rgba(125,211,252,0.3)",
              borderRadius: 4,
              padding: 8,
              fontFamily: "inherit",
              marginBottom: 10,
            }}
          />
          <label
            htmlFor="phone-tui-summary"
            style={{ display: "block", color: "#94a3b8", marginBottom: 6 }}
          >
            summary
          </label>
          <input
            id="phone-tui-summary"
            name="summary"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "#0f172a",
              color: "#e2e8f0",
              border: "1px solid rgba(125,211,252,0.3)",
              borderRadius: 4,
              padding: 8,
              fontFamily: "inherit",
              marginBottom: 12,
            }}
          />
          <button
            type="button"
            onClick={() => void saveTranscript()}
            disabled={
              !transcriptCallId.trim() || !transcript.trim() || savingTranscript
            }
            style={{
              background: "transparent",
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
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              style={{
                background: "transparent",
                color: "#a7f3d0",
                border: "1px solid rgba(167,243,208,0.45)",
                borderRadius: 4,
                padding: "4px 8px",
                cursor: loading ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
            >
              refresh
            </button>
          </div>
          {error && <div style={{ color: "#fca5a5" }}>{error}</div>}
          {!loading && !error && calls.length === 0 && (
            <div style={{ color: "#64748b" }}>no recent calls</div>
          )}
          {calls.map((call, index) => (
            <button
              key={call.id}
              type="button"
              onClick={() => setDialed(call.number)}
              style={{
                width: "100%",
                display: "grid",
                gridTemplateColumns: "4ch minmax(8ch, 1fr) 10ch",
                gap: 10,
                border: "none",
                borderTop:
                  index === 0 ? "none" : "1px solid rgba(125,211,252,0.18)",
                background: "transparent",
                color: "#cbd5e1",
                padding: "8px 0",
                cursor: "pointer",
                fontFamily: "inherit",
                textAlign: "left",
              }}
            >
              <span style={{ color: "#64748b" }}>
                {String(index + 1).padStart(2, "0")}
              </span>
              <span style={{ color: "#e2e8f0", overflow: "hidden" }}>
                {callLabelFor(call)}
              </span>
              <span
                style={{
                  color: call.type === "missed" ? "#fca5a5" : "#94a3b8",
                }}
              >
                {call.type}
              </span>
              <span style={{ gridColumn: "2 / 4", color: "#94a3b8" }}>
                {call.number} | {formatTimestamp(call.date)} |{" "}
                {call.durationSeconds}s
              </span>
              {(call.agentSummary || call.agentTranscript) && (
                <span style={{ gridColumn: "2 / 4", color: "#a7f3d0" }}>
                  {call.agentSummary ?? call.agentTranscript}
                </span>
              )}
            </button>
          ))}
        </section>
      </div>
    </div>
  );
}

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-phone-state") {
    const state = await loadPhoneState({
      limit: params?.limit,
      number: typeof params?.number === "string" ? params.number : undefined,
    });
    return {
      viewType: "tui",
      status: state.status,
      calls: state.calls.map((call) => ({
        id: call.id,
        number: call.number,
        cachedName: call.cachedName,
        label: callLabelFor(call),
        date: call.date,
        durationSeconds: call.durationSeconds,
        type: call.type,
        isNew: call.isNew,
        agentSummary: call.agentSummary,
        agentTranscript: call.agentTranscript,
      })),
    };
  }

  if (capability === "terminal-place-call") {
    const number = normalizeNumber(
      typeof params?.number === "string" ? params.number : "",
    );
    if (!number) throw new Error("number is required");
    await Phone.placeCall({ number });
    return { placed: true, number, viewType: "tui" };
  }

  if (capability === "terminal-open-dialer") {
    const number = normalizeNumber(
      typeof params?.number === "string" ? params.number : "",
    );
    await Phone.openDialer(number ? { number } : undefined);
    return { opened: true, number: number || null, viewType: "tui" };
  }

  if (capability === "terminal-save-call-transcript") {
    const callId =
      typeof params?.callId === "string" ? params.callId.trim() : "";
    const transcript =
      typeof params?.transcript === "string" ? params.transcript.trim() : "";
    const summary =
      typeof params?.summary === "string" ? params.summary.trim() : "";
    if (!callId) throw new Error("callId is required");
    if (!transcript) throw new Error("transcript is required");
    const result = await Phone.saveCallTranscript({
      callId,
      transcript,
      ...(summary ? { summary } : {}),
    });
    return { saved: true, updatedAt: result.updatedAt, viewType: "tui" };
  }

  throw new Error(`Unsupported capability "${capability}"`);
}
