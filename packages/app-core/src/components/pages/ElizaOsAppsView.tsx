import {
  Clock3,
  ContactRound,
  FileUp,
  MessageSquare,
  NotebookText,
  PhoneCall,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AndroidRoleStatus,
  CallLogEntry,
  ContactSummary,
  SmsMessageSummary,
} from "../../bridge/native-plugins";
import { getPlugins } from "../../bridge/plugin-bridge";

type PhonePanel = "dialer" | "recents" | "contacts" | "import" | "transcripts";

const PHONE_PANEL_ITEMS: Array<{
  id: PhonePanel;
  label: string;
  icon: ReactNode;
}> = [
  { id: "dialer", label: "Dialer", icon: <PhoneCall className="h-4 w-4" /> },
  { id: "recents", label: "Recents", icon: <Clock3 className="h-4 w-4" /> },
  {
    id: "contacts",
    label: "Contacts",
    icon: <ContactRound className="h-4 w-4" />,
  },
  { id: "import", label: "Import", icon: <FileUp className="h-4 w-4" /> },
  {
    id: "transcripts",
    label: "Transcripts",
    icon: <NotebookText className="h-4 w-4" />,
  },
];

const DIALPAD_KEYS = [
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

function useLaunchParams(): URLSearchParams {
  const [params, setParams] = useState(() => readLaunchParams());

  useEffect(() => {
    const onHashChange = () => setParams(readLaunchParams());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return params;
}

function readLaunchParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.hash.split("?")[1] ?? "");
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded border border-border bg-card p-4 shadow-sm">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-txt">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-muted">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function PrimaryButton({
  children,
  disabled,
  icon,
  onClick,
  type = "button",
}: {
  children: ReactNode;
  disabled?: boolean;
  icon?: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-9 items-center justify-center gap-2 rounded border border-border bg-primary px-3 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  );
}

function SecondaryButton({
  children,
  disabled,
  icon,
  onClick,
  type = "button",
}: {
  children: ReactNode;
  disabled?: boolean;
  icon?: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-9 items-center justify-center gap-2 rounded border border-border bg-bg px-3 text-sm font-medium text-txt disabled:cursor-not-allowed disabled:opacity-50"
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  );
}

function TextInput({
  label,
  onChange,
  placeholder,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <label className="grid gap-1 text-sm text-txt">
      <span className="font-medium">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 rounded border border-border bg-bg px-3 text-sm text-txt outline-none focus:border-primary"
      />
    </label>
  );
}

function TextArea({
  label,
  onChange,
  placeholder,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <label className="grid gap-1 text-sm text-txt">
      <span className="font-medium">{label}</span>
      <textarea
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-24 rounded border border-border bg-bg px-3 py-2 text-sm text-txt outline-none focus:border-primary"
      />
    </label>
  );
}

function StatusNotice({
  error,
  notice,
}: {
  error: string | null;
  notice: string | null;
}) {
  if (error) {
    return (
      <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (notice) {
    return (
      <div className="rounded border border-border bg-bg px-3 py-2 text-sm text-muted">
        {notice}
      </div>
    );
  }
  return null;
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-border bg-bg p-3 text-sm text-muted">
      {children}
    </div>
  );
}

function roleHolderText(role: AndroidRoleStatus): string {
  return role.holders.length > 0 ? role.holders.join(", ") : "none";
}

function numberFromTelUri(uri: string | null): string {
  if (!uri) return "";
  if (!uri.startsWith("tel:")) return uri;
  return decodeURIComponent(uri.slice("tel:".length));
}

function primaryPhoneNumber(contact: ContactSummary): string {
  return contact.phoneNumbers[0] ?? "";
}

function callDisplayName(call: CallLogEntry): string {
  return call.cachedName || call.number || "Unknown caller";
}

function callTypeLabel(type: CallLogEntry["type"]): string {
  switch (type) {
    case "incoming":
      return "Incoming";
    case "outgoing":
      return "Outgoing";
    case "missed":
      return "Missed";
    case "voicemail":
      return "Voicemail";
    case "rejected":
      return "Rejected";
    case "blocked":
      return "Blocked";
    case "answered_externally":
      return "Answered elsewhere";
    default:
      return "Unknown";
  }
}

function durationLabel(seconds: number): string {
  if (seconds <= 0) return "0s";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function formatTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Unknown time";
  return new Date(timestamp).toLocaleString();
}

function openMessagesForNumber(number: string): void {
  if (!number) return;
  window.location.hash = `#messages?recipient=${encodeURIComponent(number)}`;
}

export function PhonePageView() {
  const params = useLaunchParams();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [activePanel, setActivePanel] = useState<PhonePanel>("dialer");
  const [number, setNumber] = useState(() => {
    return params.get("number") ?? numberFromTelUri(params.get("uri"));
  });
  const [contactQuery, setContactQuery] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [vcardText, setVcardText] = useState("");
  const [status, setStatus] = useState<string[]>([]);
  const [roles, setRoles] = useState<AndroidRoleStatus[]>([]);
  const [calls, setCalls] = useState<CallLogEntry[]>([]);
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [transcriptDraft, setTranscriptDraft] = useState("");
  const [summaryDraft, setSummaryDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(() => {
    const event = params.get("event");
    const launchNumber =
      params.get("number") ?? numberFromTelUri(params.get("uri"));
    if (!event) return null;
    return launchNumber ? `${event}: ${launchNumber}` : event;
  });
  const [error, setError] = useState<string | null>(null);

  const selectedCall = useMemo(
    () => calls.find((call) => call.id === selectedCallId) ?? calls[0] ?? null,
    [calls, selectedCallId],
  );

  const contactListOptions = useMemo(
    () => ({ limit: 200, query: contactQuery.trim() || undefined }),
    [contactQuery],
  );

  useEffect(() => {
    const launchNumber =
      params.get("number") ?? numberFromTelUri(params.get("uri"));
    if (launchNumber) setNumber(launchNumber);
    const event = params.get("event");
    if (event) {
      setNotice(launchNumber ? `${event}: ${launchNumber}` : event);
      setActivePanel("dialer");
    }
  }, [params]);

  useEffect(() => {
    if (!selectedCall) {
      setTranscriptDraft("");
      setSummaryDraft("");
      return;
    }
    setTranscriptDraft(
      selectedCall.agentTranscript ?? selectedCall.transcription ?? "",
    );
    setSummaryDraft(selectedCall.agentSummary ?? "");
  }, [selectedCall]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const plugins = getPlugins();
      if (typeof plugins.phone.plugin.getStatus !== "function") {
        throw new Error("ElizaPhone plugin is unavailable");
      }
      if (typeof plugins.phone.plugin.listRecentCalls !== "function") {
        throw new Error("ElizaPhone call log API is unavailable");
      }
      if (typeof plugins.system.plugin.getStatus !== "function") {
        throw new Error("ElizaSystem plugin is unavailable");
      }
      if (typeof plugins.contacts.plugin.listContacts !== "function") {
        throw new Error("ElizaContacts plugin is unavailable");
      }
      const [phone, system, recentCalls, contactResult] = await Promise.all([
        plugins.phone.plugin.getStatus(),
        plugins.system.plugin.getStatus(),
        plugins.phone.plugin.listRecentCalls({ limit: 100 }),
        plugins.contacts.plugin.listContacts(contactListOptions),
      ]);
      setStatus([
        `telecom: ${phone.hasTelecom ? "available" : "unavailable"}`,
        `default dialer: ${phone.defaultDialerPackage ?? "none"}`,
        `eliza default dialer: ${phone.isDefaultDialer ? "yes" : "no"}`,
        `can place calls: ${phone.canPlaceCalls ? "yes" : "no"}`,
      ]);
      setRoles(system.roles);
      setCalls(recentCalls.calls);
      setContacts(contactResult.contacts);
      setSelectedCallId(
        (current) => current ?? recentCalls.calls[0]?.id ?? null,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [contactListOptions]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const appendDialpadKey = (key: string) =>
    setNumber((current) => `${current}${key}`);

  const placeCall = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const trimmed = number.trim();
      if (!trimmed) throw new Error("number is required");
      const plugins = getPlugins();
      if (typeof plugins.phone.plugin.placeCall !== "function") {
        throw new Error("ElizaPhone plugin is unavailable");
      }
      await plugins.phone.plugin.placeCall({ number: trimmed });
      setNotice("Call request handed to Android Telecom.");
      setActivePanel("recents");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openDialer = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const plugins = getPlugins();
      if (typeof plugins.phone.plugin.openDialer !== "function") {
        throw new Error("ElizaPhone plugin is unavailable");
      }
      await plugins.phone.plugin.openDialer({
        number: number.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createContact = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const name = displayName.trim();
      const nextPhoneNumber = phoneNumber.trim();
      const nextEmailAddress = emailAddress.trim();
      if (!name) throw new Error("displayName is required");
      const plugins = getPlugins();
      if (typeof plugins.contacts.plugin.createContact !== "function") {
        throw new Error("ElizaContacts plugin is unavailable");
      }
      const result = await plugins.contacts.plugin.createContact({
        displayName: name,
        phoneNumber: nextPhoneNumber || undefined,
        emailAddress: nextEmailAddress || undefined,
      });
      setNotice(`Created contact ${result.id}.`);
      setDisplayName("");
      setPhoneNumber("");
      setEmailAddress("");
      await refresh();
      setActivePanel("contacts");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const importVCardText = async (text: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const plugins = getPlugins();
      if (typeof plugins.contacts.plugin.importVCard !== "function") {
        throw new Error("ElizaContacts import API is unavailable");
      }
      const result = await plugins.contacts.plugin.importVCard({
        vcardText: text,
      });
      setNotice(`Imported ${result.imported.length} contact(s).`);
      setVcardText("");
      await refresh();
      setActivePanel("contacts");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const importSelectedFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await importVCardText(await file.text());
  };

  const saveTranscript = async () => {
    if (!selectedCall) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const transcript = transcriptDraft.trim();
      if (!transcript) throw new Error("transcript is required");
      const plugins = getPlugins();
      if (typeof plugins.phone.plugin.saveCallTranscript !== "function") {
        throw new Error("ElizaPhone transcript API is unavailable");
      }
      await plugins.phone.plugin.saveCallTranscript({
        callId: selectedCall.id,
        transcript,
        summary: summaryDraft.trim() || undefined,
      });
      setNotice("Transcript saved.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const requestAndroidRole = async (role: AndroidRoleStatus) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!role.available) {
        throw new Error(`${role.androidRole} is not available on this device`);
      }
      const plugins = getPlugins();
      if (typeof plugins.system.plugin.requestRole !== "function") {
        throw new Error("ElizaSystem role request API is unavailable");
      }
      const result = await plugins.system.plugin.requestRole({
        role: role.role,
      });
      setNotice(
        `${role.role} role ${result.held ? "is held by Eliza" : "was not granted"}.`,
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openSystemSettings = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const plugins = getPlugins();
      if (typeof plugins.system.plugin.openSettings !== "function") {
        throw new Error("ElizaSystem settings API is unavailable");
      }
      await plugins.system.plugin.openSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const renderPanel = () => {
    if (activePanel === "recents") {
      return (
        <Panel title="Recent Calls" description="Android call log entries.">
          <div className="mb-3 flex flex-wrap gap-2">
            <SecondaryButton
              disabled={busy}
              icon={<RefreshCw className="h-4 w-4" />}
              onClick={refresh}
            >
              Refresh
            </SecondaryButton>
          </div>
          <div className="grid max-h-[62vh] gap-2 overflow-y-auto">
            {calls.length > 0 ? (
              calls.map((call) => (
                <button
                  key={call.id}
                  type="button"
                  onClick={() => {
                    setSelectedCallId(call.id);
                    setActivePanel("transcripts");
                  }}
                  className="rounded border border-border bg-bg p-3 text-left text-sm hover:border-primary"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-txt">
                      {callDisplayName(call)}
                    </span>
                    <span className="text-xs text-muted">
                      {callTypeLabel(call.type)} ·{" "}
                      {durationLabel(call.durationSeconds)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                    <span>{call.number || "unknown number"}</span>
                    <span>{formatTimestamp(call.date)}</span>
                  </div>
                  {call.agentTranscript || call.transcription ? (
                    <div className="mt-2 line-clamp-2 text-xs text-muted">
                      {call.agentSummary ||
                        call.agentTranscript ||
                        call.transcription}
                    </div>
                  ) : null}
                </button>
              ))
            ) : (
              <EmptyState>No calls returned by Android.</EmptyState>
            )}
          </div>
        </Panel>
      );
    }

    if (activePanel === "contacts") {
      return (
        <Panel title="Contacts" description="Android Contacts Provider.">
          <div className="mb-3 grid gap-3 sm:grid-cols-[1fr_auto]">
            <TextInput
              label="Search"
              placeholder="Name, number, or email"
              value={contactQuery}
              onChange={setContactQuery}
            />
            <div className="flex items-end">
              <SecondaryButton
                disabled={busy}
                icon={<Search className="h-4 w-4" />}
                onClick={refresh}
              >
                Search
              </SecondaryButton>
            </div>
          </div>
          <div className="grid max-h-[62vh] gap-2 overflow-y-auto">
            {contacts.length > 0 ? (
              contacts.map((contact) => {
                const contactNumber = primaryPhoneNumber(contact);
                return (
                  <div
                    key={contact.id}
                    className="rounded border border-border bg-bg p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium text-txt">
                          {contact.displayName || "Unnamed contact"}
                        </div>
                        <div className="mt-1 text-muted">
                          {contact.phoneNumbers.length > 0
                            ? contact.phoneNumbers.join(", ")
                            : "No phone numbers"}
                        </div>
                        {contact.emailAddresses.length > 0 ? (
                          <div className="mt-1 text-xs text-muted">
                            {contact.emailAddresses.join(", ")}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <SecondaryButton
                          disabled={!contactNumber}
                          icon={<PhoneCall className="h-4 w-4" />}
                          onClick={() => {
                            setNumber(contactNumber);
                            setActivePanel("dialer");
                          }}
                        >
                          Dial
                        </SecondaryButton>
                        <SecondaryButton
                          disabled={!contactNumber}
                          icon={<MessageSquare className="h-4 w-4" />}
                          onClick={() => openMessagesForNumber(contactNumber)}
                        >
                          SMS
                        </SecondaryButton>
                      </div>
                    </div>
                  </div>
                );
              })
            ) : (
              <EmptyState>No contacts returned by Android.</EmptyState>
            )}
          </div>
        </Panel>
      );
    }

    if (activePanel === "import") {
      return (
        <Panel title="Import Contacts" description="vCard contacts import.">
          <div className="grid gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".vcf,text/vcard,text/x-vcard"
              className="hidden"
              onChange={importSelectedFile}
            />
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                disabled={busy}
                icon={<FileUp className="h-4 w-4" />}
                onClick={() => fileInputRef.current?.click()}
              >
                Choose vCard
              </PrimaryButton>
              <SecondaryButton
                disabled={busy || !vcardText.trim()}
                icon={<Plus className="h-4 w-4" />}
                onClick={() => importVCardText(vcardText)}
              >
                Import Text
              </SecondaryButton>
            </div>
            <TextArea
              label="vCard Text"
              placeholder="BEGIN:VCARD"
              value={vcardText}
              onChange={setVcardText}
            />
          </div>
        </Panel>
      );
    }

    if (activePanel === "transcripts") {
      return (
        <Panel
          title="Call Transcript"
          description="Call log transcription and agent notes."
        >
          {selectedCall ? (
            <div className="grid gap-3">
              <div className="rounded border border-border bg-bg p-3 text-sm">
                <div className="font-medium text-txt">
                  {callDisplayName(selectedCall)}
                </div>
                <div className="mt-1 text-xs text-muted">
                  {selectedCall.number || "unknown number"} ·{" "}
                  {callTypeLabel(selectedCall.type)} ·{" "}
                  {formatTimestamp(selectedCall.date)}
                </div>
              </div>
              {selectedCall.transcription ? (
                <div className="rounded border border-border bg-bg p-3 text-sm text-txt">
                  <div className="mb-1 text-xs font-medium uppercase text-muted">
                    Voicemail transcription
                  </div>
                  {selectedCall.transcription}
                </div>
              ) : null}
              <TextArea
                label="Agent Transcript"
                value={transcriptDraft}
                onChange={setTranscriptDraft}
              />
              <TextInput
                label="Agent Summary"
                value={summaryDraft}
                onChange={setSummaryDraft}
              />
              <div className="flex flex-wrap gap-2">
                <PrimaryButton
                  disabled={busy || !transcriptDraft.trim()}
                  icon={<NotebookText className="h-4 w-4" />}
                  onClick={saveTranscript}
                >
                  Save Transcript
                </PrimaryButton>
                <SecondaryButton
                  disabled={!selectedCall.number}
                  icon={<MessageSquare className="h-4 w-4" />}
                  onClick={() => openMessagesForNumber(selectedCall.number)}
                >
                  Reply SMS
                </SecondaryButton>
              </div>
            </div>
          ) : (
            <EmptyState>No call selected.</EmptyState>
          )}
        </Panel>
      );
    }

    return (
      <Panel title="Dialer" description="Android Telecom calling surface.">
        <div className="grid gap-4 lg:grid-cols-[minmax(240px,320px)_1fr]">
          <div className="grid gap-3">
            <TextInput
              label="Number"
              placeholder="+15551234567"
              value={number}
              onChange={setNumber}
            />
            <div className="grid grid-cols-3 gap-2">
              {DIALPAD_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => appendDialpadKey(key)}
                  className="aspect-[1.6] rounded border border-border bg-bg text-lg font-semibold text-txt hover:border-primary"
                >
                  {key}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                disabled={busy || !number.trim()}
                icon={<PhoneCall className="h-4 w-4" />}
                onClick={placeCall}
              >
                Call
              </PrimaryButton>
              <SecondaryButton
                disabled={busy}
                icon={<PhoneCall className="h-4 w-4" />}
                onClick={openDialer}
              >
                Open Dialer
              </SecondaryButton>
              <SecondaryButton
                disabled={!number.trim()}
                icon={<MessageSquare className="h-4 w-4" />}
                onClick={() => openMessagesForNumber(number.trim())}
              >
                SMS
              </SecondaryButton>
            </div>
          </div>
          <div className="grid gap-3">
            <div className="grid gap-1 rounded border border-border bg-bg p-3 text-sm text-muted">
              {status.length > 0
                ? status.map((line) => <div key={line}>{line}</div>)
                : "No status loaded."}
            </div>
            <div className="grid gap-2 rounded border border-border bg-bg p-3">
              <div className="text-sm font-medium text-txt">
                Android default roles
              </div>
              {roles.length > 0 ? (
                roles.map((role) => (
                  <div
                    key={role.role}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-card p-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-txt">
                        {role.role}: {role.held ? "held" : "not held"}
                      </div>
                      <div className="truncate text-xs text-muted">
                        holders: {roleHolderText(role)}
                      </div>
                    </div>
                    <SecondaryButton
                      disabled={busy || !role.available || role.held}
                      icon={<ShieldCheck className="h-4 w-4" />}
                      onClick={() => requestAndroidRole(role)}
                    >
                      Request
                    </SecondaryButton>
                  </div>
                ))
              ) : (
                <EmptyState>No Android roles returned.</EmptyState>
              )}
              <SecondaryButton
                disabled={busy}
                icon={<Settings className="h-4 w-4" />}
                onClick={openSystemSettings}
              >
                Settings
              </SecondaryButton>
            </div>
            <div className="rounded border border-border bg-bg p-3">
              <div className="mb-3 text-sm font-medium text-txt">
                New Contact
              </div>
              <div className="grid gap-3">
                <TextInput
                  label="Display Name"
                  value={displayName}
                  onChange={setDisplayName}
                />
                <TextInput
                  label="Phone Number"
                  value={phoneNumber}
                  onChange={setPhoneNumber}
                />
                <TextInput
                  label="Email"
                  value={emailAddress}
                  onChange={setEmailAddress}
                />
                <PrimaryButton
                  disabled={busy || !displayName.trim()}
                  icon={<UserPlus className="h-4 w-4" />}
                  onClick={createContact}
                >
                  Create Contact
                </PrimaryButton>
              </div>
            </div>
          </div>
        </div>
      </Panel>
    );
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-txt">Phone</h1>
          <div className="text-sm text-muted">
            ElizaOS Android phone workspace
          </div>
        </div>
        <SecondaryButton
          disabled={busy}
          icon={<RefreshCw className="h-4 w-4" />}
          onClick={refresh}
        >
          Refresh
        </SecondaryButton>
      </div>
      <div className="flex flex-wrap gap-2">
        {PHONE_PANEL_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setActivePanel(item.id)}
            className={`inline-flex h-9 items-center gap-2 rounded border px-3 text-sm font-medium ${
              activePanel === item.id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-bg text-txt"
            }`}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <StatusNotice error={error} notice={notice} />
      <div className="min-h-0 flex-1 overflow-y-auto">{renderPanel()}</div>
    </div>
  );
}

function messageTypeLabel(type: number): string {
  if (type === 1) return "inbox";
  if (type === 2) return "sent";
  if (type === 3) return "draft";
  if (type === 4) return "outbox";
  if (type === 5) return "failed";
  if (type === 6) return "queued";
  return `type ${type}`;
}

interface IncomingSmsContext {
  sender: string;
  body: string;
  timestamp: number | null;
  messageId: string | null;
}

function readIncomingSmsContext(
  params: URLSearchParams,
): IncomingSmsContext | null {
  if (params.get("event") !== "sms-deliver") return null;
  const sender = params.get("sender") ?? "";
  const body = params.get("body") ?? "";
  const rawTimestamp = Number(params.get("timestamp"));
  if (!sender && !body) return null;
  return {
    sender,
    body,
    timestamp: Number.isFinite(rawTimestamp) ? rawTimestamp : null,
    messageId: params.get("messageId"),
  };
}

function initialMessageBody(params: URLSearchParams): string {
  return params.get("event") === "sms-deliver"
    ? ""
    : (params.get("body") ?? "");
}

export function MessagesPageView() {
  const params = useLaunchParams();
  const [address, setAddress] = useState(
    () => params.get("recipient") ?? params.get("sender") ?? "",
  );
  const [body, setBody] = useState(() => initialMessageBody(params));
  const [incomingSms, setIncomingSms] = useState<IncomingSmsContext | null>(
    () => readIncomingSmsContext(params),
  );
  const [messages, setMessages] = useState<SmsMessageSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(() => {
    const event = params.get("event");
    if (!event) return null;
    if (params.get("unsupported"))
      return `${event}: MMS WAP push needs parser support.`;
    return event;
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const incoming = readIncomingSmsContext(params);
    setIncomingSms(incoming);
    setAddress(params.get("recipient") ?? params.get("sender") ?? "");
    setBody(initialMessageBody(params));
    const event = params.get("event");
    if (event) {
      setNotice(
        params.get("unsupported")
          ? `${event}: MMS WAP push needs parser support.`
          : event,
      );
    }
  }, [params]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const plugins = getPlugins();
      if (typeof plugins.messages.plugin.listMessages !== "function") {
        throw new Error("ElizaMessages plugin is unavailable");
      }
      const result = await plugins.messages.plugin.listMessages({ limit: 100 });
      setMessages(result.messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const send = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const trimmedAddress = address.trim();
      const trimmedBody = body.trim();
      if (!trimmedAddress) throw new Error("address is required");
      if (!trimmedBody) throw new Error("body is required");
      const plugins = getPlugins();
      if (typeof plugins.messages.plugin.sendSms !== "function") {
        throw new Error("ElizaMessages plugin is unavailable");
      }
      const result = await plugins.messages.plugin.sendSms({
        address: trimmedAddress,
        body: trimmedBody,
      });
      setNotice(`SMS sent and saved as message ${result.messageId}.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 p-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
      <Panel title="Compose" description="Send through Android SMS Manager.">
        <div className="grid gap-3">
          {incomingSms ? (
            <div className="rounded border border-border bg-bg p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                <span>{incomingSms.sender || "unknown sender"}</span>
                <span>
                  {incomingSms.timestamp
                    ? formatTimestamp(incomingSms.timestamp)
                    : "Unknown time"}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-txt">
                {incomingSms.body || "Empty SMS body"}
              </p>
              {incomingSms.messageId ? (
                <div className="mt-2 text-xs text-muted">
                  message {incomingSms.messageId}
                </div>
              ) : null}
            </div>
          ) : null}
          <TextInput
            label="Address"
            placeholder="+15551234567"
            value={address}
            onChange={setAddress}
          />
          <TextArea
            label="Body"
            placeholder="Message"
            value={body}
            onChange={setBody}
          />
          <PrimaryButton
            disabled={busy}
            icon={<Send className="h-4 w-4" />}
            onClick={send}
          >
            Send SMS
          </PrimaryButton>
          <StatusNotice error={error} notice={notice} />
        </div>
      </Panel>
      <Panel
        title="Messages"
        description="Recent rows from Android's SMS provider."
      >
        <div className="mb-3">
          <SecondaryButton
            disabled={busy}
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={refresh}
          >
            Refresh
          </SecondaryButton>
        </div>
        <div className="grid max-h-[60vh] gap-2 overflow-y-auto">
          {messages.length > 0 ? (
            messages.map((message) => (
              <div
                key={message.id}
                className="rounded border border-border bg-bg p-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                  <span>{message.address || "unknown address"}</span>
                  <span>
                    {messageTypeLabel(message.type)} ·{" "}
                    {new Date(message.date).toLocaleString()}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-txt">
                  {message.body}
                </p>
              </div>
            ))
          ) : (
            <EmptyState>No messages returned by Android.</EmptyState>
          )}
        </div>
      </Panel>
    </div>
  );
}

export function ContactsPageView() {
  const [query, setQuery] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listOptions = useMemo(
    () => ({ limit: 100, query: query.trim() || undefined }),
    [query],
  );

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const plugins = getPlugins();
      if (typeof plugins.contacts.plugin.listContacts !== "function") {
        throw new Error("ElizaContacts plugin is unavailable");
      }
      const result = await plugins.contacts.plugin.listContacts(listOptions);
      setContacts(result.contacts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [listOptions]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const name = displayName.trim();
      const number = phoneNumber.trim();
      const email = emailAddress.trim();
      if (!name) throw new Error("displayName is required");
      const plugins = getPlugins();
      if (typeof plugins.contacts.plugin.createContact !== "function") {
        throw new Error("ElizaContacts plugin is unavailable");
      }
      const result = await plugins.contacts.plugin.createContact({
        displayName: name,
        phoneNumber: number || undefined,
        emailAddress: email || undefined,
      });
      setNotice(`Created contact ${result.id}.`);
      setDisplayName("");
      setPhoneNumber("");
      setEmailAddress("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 p-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
      <Panel
        title="Create Contact"
        description="Write into Android Contacts Provider."
      >
        <div className="grid gap-3">
          <TextInput
            label="Display Name"
            value={displayName}
            onChange={setDisplayName}
          />
          <TextInput
            label="Phone Number"
            value={phoneNumber}
            onChange={setPhoneNumber}
          />
          <TextInput
            label="Email"
            value={emailAddress}
            onChange={setEmailAddress}
          />
          <PrimaryButton
            disabled={busy}
            icon={<UserPlus className="h-4 w-4" />}
            onClick={create}
          >
            Create
          </PrimaryButton>
          <StatusNotice error={error} notice={notice} />
        </div>
      </Panel>
      <Panel
        title="Contacts"
        description="Read from Android Contacts Provider."
      >
        <div className="mb-3 flex flex-col gap-2 sm:flex-row">
          <div className="min-w-0 flex-1">
            <TextInput
              label="Search"
              placeholder="Name, number, or email"
              value={query}
              onChange={setQuery}
            />
          </div>
          <div className="flex items-end">
            <SecondaryButton
              disabled={busy}
              icon={<RefreshCw className="h-4 w-4" />}
              onClick={refresh}
            >
              Refresh
            </SecondaryButton>
          </div>
        </div>
        <div className="grid max-h-[60vh] gap-2 overflow-y-auto">
          {contacts.length > 0 ? (
            contacts.map((contact) => (
              <div
                key={contact.id}
                className="rounded border border-border bg-bg p-3 text-sm"
              >
                <div className="font-medium text-txt">
                  {contact.displayName}
                </div>
                <div className="mt-1 text-muted">
                  {contact.phoneNumbers.length > 0
                    ? contact.phoneNumbers.join(", ")
                    : "No phone numbers"}
                </div>
                {contact.emailAddresses.length > 0 ? (
                  <div className="mt-1 text-xs text-muted">
                    {contact.emailAddresses.join(", ")}
                  </div>
                ) : null}
              </div>
            ))
          ) : (
            <EmptyState>No contacts returned by Android.</EmptyState>
          )}
        </div>
      </Panel>
    </div>
  );
}
