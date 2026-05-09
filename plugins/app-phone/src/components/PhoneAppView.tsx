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
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@elizaos/ui";
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
    if (mod && typeof mod.Contacts?.listContacts === "function") {
      return mod;
    }
    return null;
  } catch {
    return null;
  }
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

  return (
    <div
      data-testid="phone-shell"
      className="fixed inset-0 z-50 flex flex-col bg-bg h-[100vh] overflow-hidden supports-[height:100dvh]:h-[100dvh]"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border/20 bg-bg/80 px-4 py-3 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-xl text-muted hover:text-txt"
            onClick={exitToApps}
            aria-label={t("nav.back", { defaultValue: "Back" })}
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
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-xl text-muted hover:text-txt"
            onClick={() => void refreshCalls()}
            disabled={callsLoading}
            aria-label={t("actions.refresh", { defaultValue: "Refresh" })}
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
            <TabsTrigger value="dialer">
              {t("phone.tabs.dialer", { defaultValue: "Dialer" })}
            </TabsTrigger>
            <TabsTrigger value="recent">
              {t("phone.tabs.recent", { defaultValue: "Recent" })}
            </TabsTrigger>
            <TabsTrigger value="contacts" disabled={!contactsAvailable}>
              {t("phone.tabs.contacts", { defaultValue: "Contacts" })}
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Dialer */}
        <TabsContent
          value="dialer"
          className="flex-1 overflow-hidden focus-visible:outline-none"
        >
          <div className="flex h-full flex-col items-center justify-between px-4 py-6">
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
                <button
                  key={key}
                  type="button"
                  className="aspect-square rounded-full border border-border bg-bg-accent text-2xl font-semibold text-txt transition active:scale-95 hover:bg-bg-accent/70"
                  onClick={() => appendDigit(key)}
                  aria-label={`Dial ${key}`}
                >
                  {key}
                </button>
              ))}
            </div>

            {/* Bottom row: + (long-press equivalent), call, backspace */}
            <div className="grid w-full max-w-sm grid-cols-3 items-center gap-3 pb-4">
              <button
                type="button"
                className="h-12 rounded-full border border-border bg-bg-accent text-lg font-semibold text-txt active:scale-95"
                onClick={appendPlus}
                aria-label={t("phone.dialer.intl", {
                  defaultValue: "Insert + for international dialing",
                })}
              >
                +
              </button>
              <Button
                onClick={onDialerCall}
                disabled={calling || dialed.length === 0}
                className="h-14 rounded-full bg-ok text-bg hover:bg-ok/90 disabled:opacity-50"
                aria-label={t("phone.dialer.call", { defaultValue: "Call" })}
              >
                <PhoneIcon className="h-6 w-6" aria-hidden />
              </Button>
              <button
                type="button"
                className="flex h-12 items-center justify-center rounded-full border border-border bg-bg-accent text-txt active:scale-95 disabled:opacity-50"
                onClick={backspace}
                disabled={dialed.length === 0}
                aria-label={t("phone.dialer.backspace", {
                  defaultValue: "Delete digit",
                })}
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
            {!callsError && calls.length === 0 && !callsLoading ? (
              <p className="py-8 text-center text-sm text-muted">
                {t("phone.recent.empty", {
                  defaultValue: "No recent calls.",
                })}
              </p>
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
              <p className="py-8 text-center text-sm text-muted">
                {t("phone.contacts.unavailable", {
                  defaultValue: "Contacts are not available on this device.",
                })}
              </p>
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
              <p className="py-8 text-center text-sm text-muted">
                {t("phone.contacts.empty", {
                  defaultValue: "No contacts with phone numbers.",
                })}
              </p>
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
