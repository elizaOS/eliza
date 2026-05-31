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
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgentElement } from "../../agent-surface";
import type {
  AndroidRoleStatus,
  CallLogEntry,
  ContactSummary,
  SmsMessageSummary,
} from "../../bridge/native-plugins";
import { getPlugins } from "../../bridge/plugin-bridge";
import { useTranslation } from "../../state/TranslationContext";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

type PhonePanel = "dialer" | "recents" | "contacts" | "import" | "transcripts";

const PHONE_PANEL_ITEMS: Array<{
  id: PhonePanel;
  labelKey: string;
  defaultLabel: string;
  icon: ReactNode;
}> = [
  {
    id: "dialer",
    labelKey: "elizaosapps.phone.tab.dialer",
    defaultLabel: "Dialer",
    icon: <PhoneCall className="h-4 w-4" />,
  },
  {
    id: "recents",
    labelKey: "elizaosapps.phone.tab.recents",
    defaultLabel: "Recents",
    icon: <Clock3 className="h-4 w-4" />,
  },
  {
    id: "contacts",
    labelKey: "elizaosapps.phone.tab.contacts",
    defaultLabel: "Contacts",
    icon: <ContactRound className="h-4 w-4" />,
  },
  {
    id: "import",
    labelKey: "elizaosapps.phone.tab.import",
    defaultLabel: "Import",
    icon: <FileUp className="h-4 w-4" />,
  },
  {
    id: "transcripts",
    labelKey: "elizaosapps.phone.tab.transcripts",
    defaultLabel: "Transcripts",
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

const ANDROID_SMS_GATEWAY_ENABLED =
  import.meta.env.VITE_ELIZA_ANDROID_SMS_GATEWAY_ENABLED === "true";
const ANDROID_SMS_GATEWAY_SECRET = String(
  import.meta.env.VITE_ELIZA_ANDROID_SMS_GATEWAY_SECRET ?? "",
);
const ANDROID_SMS_GATEWAY_WEBHOOK_URL = String(
  import.meta.env.VITE_ELIZA_ANDROID_SMS_GATEWAY_WEBHOOK_URL ??
    "https://api.elizacloud.ai/api/webhooks/blooio/local?bridge=bluebubbles",
);
const ANDROID_SMS_GATEWAY_PHONE_NUMBER = String(
  import.meta.env.VITE_ELIZA_ANDROID_SMS_GATEWAY_PHONE_NUMBER ?? "+14159611510",
);
const ANDROID_SMS_GATEWAY_PHONE_LABEL = String(
  import.meta.env.VITE_ELIZA_ANDROID_SMS_GATEWAY_PHONE_LABEL ??
    "Eliza Cloud Gateway (+14159611510)",
);

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
    <section className="rounded-sm border border-border bg-card p-4">
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
  agentId,
  agentLabel,
  agentGroup,
  children,
  disabled,
  icon,
  onClick,
  type = "button",
}: {
  agentId: string;
  agentLabel: string;
  agentGroup?: string;
  children: ReactNode;
  disabled?: boolean;
  icon?: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label: agentLabel,
    group: agentGroup,
    status: disabled ? "inactive" : "active",
    onActivate: onClick,
  });
  return (
    <Button
      ref={ref}
      type={type}
      variant="default"
      size="sm"
      disabled={disabled}
      onClick={onClick}
      {...agentProps}
    >
      {icon}
      <span className="truncate">{children}</span>
    </Button>
  );
}

function SecondaryButton({
  agentId,
  agentLabel,
  agentGroup,
  children,
  disabled,
  icon,
  onClick,
  type = "button",
}: {
  agentId: string;
  agentLabel: string;
  agentGroup?: string;
  children: ReactNode;
  disabled?: boolean;
  icon?: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label: agentLabel,
    group: agentGroup,
    status: disabled ? "inactive" : "active",
    onActivate: onClick,
  });
  return (
    <Button
      ref={ref}
      type={type}
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onClick}
      {...agentProps}
    >
      {icon}
      <span className="truncate">{children}</span>
    </Button>
  );
}

function TextInput({
  agentId,
  agentGroup,
  label,
  onChange,
  placeholder,
  value,
}: {
  agentId: string;
  agentGroup?: string;
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  const id = useId();
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: agentId,
    role: "text-input",
    label,
    group: agentGroup,
    getValue: () => value,
    onFill: onChange,
  });
  return (
    <label className="grid gap-1 text-sm text-txt" htmlFor={id}>
      <span className="font-medium">{label}</span>
      <Input
        ref={ref}
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        {...agentProps}
      />
    </label>
  );
}

function TextArea({
  agentId,
  agentGroup,
  label,
  onChange,
  placeholder,
  value,
}: {
  agentId: string;
  agentGroup?: string;
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  const id = useId();
  const { ref, agentProps } = useAgentElement<HTMLTextAreaElement>({
    id: agentId,
    role: "textarea",
    label,
    group: agentGroup,
    getValue: () => value,
    onFill: onChange,
  });
  return (
    <label className="grid gap-1 text-sm text-txt" htmlFor={id}>
      <span className="font-medium">{label}</span>
      <Textarea
        ref={ref}
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        {...agentProps}
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
      <div className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (notice) {
    return (
      <div className="rounded-sm border border-border bg-bg px-3 py-2 text-sm text-muted">
        {notice}
      </div>
    );
  }
  return null;
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-sm border border-border bg-bg p-3 text-sm text-muted">
      {children}
    </div>
  );
}

function PhonePanelTabButton({
  item,
  label,
  isActive,
  onSelect,
}: {
  item: (typeof PHONE_PANEL_ITEMS)[number];
  label: string;
  isActive: boolean;
  onSelect: (id: PhonePanel) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `phone-tab-${item.id}`,
    role: "tab",
    label,
    group: "phone-panels",
    status: isActive ? "active" : "inactive",
    onActivate: () => onSelect(item.id),
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={isActive ? "page" : undefined}
      className={`inline-flex h-9 items-center gap-2 rounded-sm border px-3 text-sm font-medium ${
        isActive
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-bg text-txt"
      }`}
      {...agentProps}
    >
      {item.icon}
      <span>{label}</span>
    </button>
  );
}

function DialpadButton({
  digit,
  onPress,
}: {
  digit: string;
  onPress: (digit: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `dialpad-${digit}`,
    role: "button",
    label: `Dialpad ${digit}`,
    group: "dialpad",
    onActivate: () => onPress(digit),
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onPress(digit)}
      className="aspect-[1.6] rounded-sm border border-border bg-bg text-lg font-semibold text-txt hover:border-primary"
      {...agentProps}
    >
      {digit}
    </button>
  );
}

function RecentCallButton({
  call,
  onSelect,
  children,
}: {
  call: CallLogEntry;
  onSelect: () => void;
  children: ReactNode;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `recent-call-${call.id}`,
    role: "list-item",
    label: callDisplayName(call),
    group: "recent-calls",
    onActivate: onSelect,
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      className="rounded-sm border border-border bg-bg p-3 text-left text-sm hover:border-primary"
      {...agentProps}
    >
      {children}
    </button>
  );
}

function PhoneContactRow({
  contact,
  dialLabel,
  smsLabel,
  unnamedLabel,
  noNumbersLabel,
  onDial,
  onSms,
}: {
  contact: ContactSummary;
  dialLabel: string;
  smsLabel: string;
  unnamedLabel: string;
  noNumbersLabel: string;
  onDial: (contactNumber: string) => void;
  onSms: (contactNumber: string) => void;
}) {
  const contactNumber = primaryPhoneNumber(contact);
  return (
    <div className="rounded-sm border border-border bg-bg p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-txt">
            {contact.displayName || unnamedLabel}
          </div>
          <div className="mt-1 text-muted">
            {contact.phoneNumbers.length > 0
              ? contact.phoneNumbers.join(", ")
              : noNumbersLabel}
          </div>
          {contact.emailAddresses.length > 0 ? (
            <div className="mt-1 text-xs text-muted">
              {contact.emailAddresses.join(", ")}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <SecondaryButton
            agentId={`phone-contact-dial-${contact.id}`}
            agentLabel={`${dialLabel} ${contact.displayName || contactNumber}`}
            agentGroup="phone-contacts"
            disabled={!contactNumber}
            icon={<PhoneCall className="h-4 w-4" />}
            onClick={() => onDial(contactNumber)}
          >
            {dialLabel}
          </SecondaryButton>
          <SecondaryButton
            agentId={`phone-contact-sms-${contact.id}`}
            agentLabel={`${smsLabel} ${contact.displayName || contactNumber}`}
            agentGroup="phone-contacts"
            disabled={!contactNumber}
            icon={<MessageSquare className="h-4 w-4" />}
            onClick={() => onSms(contactNumber)}
          >
            {smsLabel}
          </SecondaryButton>
        </div>
      </div>
    </div>
  );
}

function PhoneRoleRow({
  role,
  heldLabel,
  notHeldLabel,
  holdersLabel,
  requestLabel,
  disabled,
  onRequest,
}: {
  role: AndroidRoleStatus;
  heldLabel: string;
  notHeldLabel: string;
  holdersLabel: string;
  requestLabel: string;
  disabled: boolean;
  onRequest: (role: AndroidRoleStatus) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border bg-card p-2 text-sm">
      <div className="min-w-0">
        <div className="font-medium text-txt">
          {role.role}: {role.held ? heldLabel : notHeldLabel}
        </div>
        <div className="truncate text-xs text-muted">{holdersLabel}</div>
      </div>
      <SecondaryButton
        agentId={`phone-role-request-${role.role}`}
        agentLabel={`${requestLabel} ${role.role}`}
        agentGroup="phone-roles"
        disabled={disabled || !role.available || role.held}
        icon={<ShieldCheck className="h-4 w-4" />}
        onClick={() => onRequest(role)}
      >
        {requestLabel}
      </SecondaryButton>
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
  const { t } = useTranslation();
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
        <Panel
          title={t("elizaosapps.phone.recents.title", {
            defaultValue: "Recent Calls",
          })}
          description={t("elizaosapps.phone.recents.description", {
            defaultValue: "Android call log entries.",
          })}
        >
          <div className="mb-3 flex flex-wrap gap-2">
            <SecondaryButton
              agentId="recents-refresh"
              agentLabel={t("elizaosapps.phone.refresh", {
                defaultValue: "Refresh",
              })}
              disabled={busy}
              icon={<RefreshCw className="h-4 w-4" />}
              onClick={refresh}
            >
              {t("elizaosapps.phone.refresh", { defaultValue: "Refresh" })}
            </SecondaryButton>
          </div>
          <div className="grid max-h-[62vh] gap-2 overflow-y-auto">
            {calls.length > 0 ? (
              calls.map((call) => (
                <RecentCallButton
                  key={call.id}
                  call={call}
                  onSelect={() => {
                    setSelectedCallId(call.id);
                    setActivePanel("transcripts");
                  }}
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
                    <span>
                      {call.number ||
                        t("elizaosapps.phone.unknownNumber", {
                          defaultValue: "unknown number",
                        })}
                    </span>
                    <span>{formatTimestamp(call.date)}</span>
                  </div>
                  {call.agentTranscript || call.transcription ? (
                    <div className="mt-2 line-clamp-2 text-xs text-muted">
                      {call.agentSummary ||
                        call.agentTranscript ||
                        call.transcription}
                    </div>
                  ) : null}
                </RecentCallButton>
              ))
            ) : (
              <EmptyState>
                {t("elizaosapps.phone.recents.empty", {
                  defaultValue: "No calls returned by Android.",
                })}
              </EmptyState>
            )}
          </div>
        </Panel>
      );
    }

    if (activePanel === "contacts") {
      return (
        <Panel
          title={t("elizaosapps.phone.contacts.title", {
            defaultValue: "Contacts",
          })}
          description={t("elizaosapps.phone.contacts.description", {
            defaultValue: "Android Contacts Provider.",
          })}
        >
          <div className="mb-3 grid gap-3 sm:grid-cols-[1fr_auto]">
            <TextInput
              agentId="phone-contacts-search"
              label={t("elizaosapps.phone.contacts.searchLabel", {
                defaultValue: "Search",
              })}
              placeholder={t("elizaosapps.phone.contacts.searchPlaceholder", {
                defaultValue: "Name, number, or email",
              })}
              value={contactQuery}
              onChange={setContactQuery}
            />
            <div className="flex items-end">
              <SecondaryButton
                agentId="phone-contacts-search-submit"
                agentLabel={t("elizaosapps.phone.contacts.search", {
                  defaultValue: "Search",
                })}
                disabled={busy}
                icon={<Search className="h-4 w-4" />}
                onClick={refresh}
              >
                {t("elizaosapps.phone.contacts.search", {
                  defaultValue: "Search",
                })}
              </SecondaryButton>
            </div>
          </div>
          <div className="grid max-h-[62vh] gap-2 overflow-y-auto">
            {contacts.length > 0 ? (
              contacts.map((contact) => (
                <PhoneContactRow
                  key={contact.id}
                  contact={contact}
                  dialLabel={t("elizaosapps.phone.dial", {
                    defaultValue: "Dial",
                  })}
                  smsLabel={t("elizaosapps.phone.sms", { defaultValue: "SMS" })}
                  unnamedLabel={t("elizaosapps.phone.contacts.unnamed", {
                    defaultValue: "Unnamed contact",
                  })}
                  noNumbersLabel={t("elizaosapps.phone.contacts.noNumbers", {
                    defaultValue: "No phone numbers",
                  })}
                  onDial={(contactNumber) => {
                    setNumber(contactNumber);
                    setActivePanel("dialer");
                  }}
                  onSms={openMessagesForNumber}
                />
              ))
            ) : (
              <EmptyState>
                {t("elizaosapps.phone.contacts.empty", {
                  defaultValue: "No contacts returned by Android.",
                })}
              </EmptyState>
            )}
          </div>
        </Panel>
      );
    }

    if (activePanel === "import") {
      return (
        <Panel
          title={t("elizaosapps.phone.import.title", {
            defaultValue: "Import Contacts",
          })}
          description={t("elizaosapps.phone.import.description", {
            defaultValue: "vCard contacts import.",
          })}
        >
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
                agentId="phone-import-choose-vcard"
                agentLabel={t("elizaosapps.phone.import.chooseVcard", {
                  defaultValue: "Choose vCard",
                })}
                disabled={busy}
                icon={<FileUp className="h-4 w-4" />}
                onClick={() => fileInputRef.current?.click()}
              >
                {t("elizaosapps.phone.import.chooseVcard", {
                  defaultValue: "Choose vCard",
                })}
              </PrimaryButton>
              <SecondaryButton
                agentId="phone-import-text"
                agentLabel={t("elizaosapps.phone.import.importText", {
                  defaultValue: "Import Text",
                })}
                disabled={busy || !vcardText.trim()}
                icon={<Plus className="h-4 w-4" />}
                onClick={() => importVCardText(vcardText)}
              >
                {t("elizaosapps.phone.import.importText", {
                  defaultValue: "Import Text",
                })}
              </SecondaryButton>
            </div>
            <TextArea
              agentId="phone-import-vcard-text"
              label={t("elizaosapps.phone.import.vcardLabel", {
                defaultValue: "vCard Text",
              })}
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
          title={t("elizaosapps.phone.transcript.title", {
            defaultValue: "Call Transcript",
          })}
          description={t("elizaosapps.phone.transcript.description", {
            defaultValue: "Call log transcription and agent notes.",
          })}
        >
          {selectedCall ? (
            <div className="grid gap-3">
              <div className="rounded-sm border border-border bg-bg p-3 text-sm">
                <div className="font-medium text-txt">
                  {callDisplayName(selectedCall)}
                </div>
                <div className="mt-1 text-xs text-muted">
                  {selectedCall.number ||
                    t("elizaosapps.phone.unknownNumber", {
                      defaultValue: "unknown number",
                    })}{" "}
                  · {callTypeLabel(selectedCall.type)} ·{" "}
                  {formatTimestamp(selectedCall.date)}
                </div>
              </div>
              {selectedCall.transcription ? (
                <div className="rounded-sm border border-border bg-bg p-3 text-sm text-txt">
                  <div className="mb-1 text-xs font-medium uppercase text-muted">
                    {t("elizaosapps.phone.transcript.voicemail", {
                      defaultValue: "Voicemail transcription",
                    })}
                  </div>
                  {selectedCall.transcription}
                </div>
              ) : null}
              <TextArea
                agentId="phone-transcript-draft"
                label={t("elizaosapps.phone.transcript.agentTranscript", {
                  defaultValue: "Agent Transcript",
                })}
                value={transcriptDraft}
                onChange={setTranscriptDraft}
              />
              <TextInput
                agentId="phone-transcript-summary"
                label={t("elizaosapps.phone.transcript.agentSummary", {
                  defaultValue: "Agent Summary",
                })}
                value={summaryDraft}
                onChange={setSummaryDraft}
              />
              <div className="flex flex-wrap gap-2">
                <PrimaryButton
                  agentId="phone-transcript-save"
                  agentLabel={t("elizaosapps.phone.transcript.save", {
                    defaultValue: "Save Transcript",
                  })}
                  disabled={busy || !transcriptDraft.trim()}
                  icon={<NotebookText className="h-4 w-4" />}
                  onClick={saveTranscript}
                >
                  {t("elizaosapps.phone.transcript.save", {
                    defaultValue: "Save Transcript",
                  })}
                </PrimaryButton>
                <SecondaryButton
                  agentId="phone-transcript-reply-sms"
                  agentLabel={t("elizaosapps.phone.transcript.replySms", {
                    defaultValue: "Reply SMS",
                  })}
                  disabled={!selectedCall.number}
                  icon={<MessageSquare className="h-4 w-4" />}
                  onClick={() => openMessagesForNumber(selectedCall.number)}
                >
                  {t("elizaosapps.phone.transcript.replySms", {
                    defaultValue: "Reply SMS",
                  })}
                </SecondaryButton>
              </div>
            </div>
          ) : (
            <EmptyState>
              {t("elizaosapps.phone.transcript.empty", {
                defaultValue: "No call selected.",
              })}
            </EmptyState>
          )}
        </Panel>
      );
    }

    return (
      <Panel
        title={t("elizaosapps.phone.dialer.title", { defaultValue: "Dialer" })}
        description={t("elizaosapps.phone.dialer.description", {
          defaultValue: "Android Telecom calling surface.",
        })}
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(240px,320px)_1fr]">
          <div className="grid gap-3">
            <TextInput
              agentId="dialer-number"
              label={t("elizaosapps.phone.dialer.numberLabel", {
                defaultValue: "Number",
              })}
              placeholder="+15551234567"
              value={number}
              onChange={setNumber}
            />
            <div className="grid grid-cols-3 gap-2">
              {DIALPAD_KEYS.map((key) => (
                <DialpadButton
                  key={key}
                  digit={key}
                  onPress={appendDialpadKey}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                agentId="dialer-call"
                agentLabel={t("elizaosapps.phone.dialer.call", {
                  defaultValue: "Call",
                })}
                disabled={busy || !number.trim()}
                icon={<PhoneCall className="h-4 w-4" />}
                onClick={placeCall}
              >
                {t("elizaosapps.phone.dialer.call", { defaultValue: "Call" })}
              </PrimaryButton>
              <SecondaryButton
                agentId="dialer-open-dialer"
                agentLabel={t("elizaosapps.phone.dialer.openDialer", {
                  defaultValue: "Open Dialer",
                })}
                disabled={busy}
                icon={<PhoneCall className="h-4 w-4" />}
                onClick={openDialer}
              >
                {t("elizaosapps.phone.dialer.openDialer", {
                  defaultValue: "Open Dialer",
                })}
              </SecondaryButton>
              <SecondaryButton
                agentId="dialer-sms"
                agentLabel={t("elizaosapps.phone.sms", { defaultValue: "SMS" })}
                disabled={!number.trim()}
                icon={<MessageSquare className="h-4 w-4" />}
                onClick={() => openMessagesForNumber(number.trim())}
              >
                {t("elizaosapps.phone.sms", { defaultValue: "SMS" })}
              </SecondaryButton>
            </div>
          </div>
          <div className="grid gap-3">
            <div className="grid gap-1 rounded-sm border border-border bg-bg p-3 text-sm text-muted">
              {status.length > 0
                ? status.map((line) => <div key={line}>{line}</div>)
                : t("elizaosapps.phone.dialer.noStatus", {
                    defaultValue: "No status loaded.",
                  })}
            </div>
            <div className="grid gap-2 rounded-sm border border-border bg-bg p-3">
              <div className="text-sm font-medium text-txt">
                {t("elizaosapps.phone.dialer.defaultRoles", {
                  defaultValue: "Android default roles",
                })}
              </div>
              {roles.length > 0 ? (
                roles.map((role) => (
                  <PhoneRoleRow
                    key={role.role}
                    role={role}
                    heldLabel={t("elizaosapps.phone.role.held", {
                      defaultValue: "held",
                    })}
                    notHeldLabel={t("elizaosapps.phone.role.notHeld", {
                      defaultValue: "not held",
                    })}
                    holdersLabel={t("elizaosapps.phone.role.holders", {
                      holders: roleHolderText(role),
                      defaultValue: "holders: {{holders}}",
                    })}
                    requestLabel={t("elizaosapps.phone.role.request", {
                      defaultValue: "Request",
                    })}
                    disabled={busy}
                    onRequest={requestAndroidRole}
                  />
                ))
              ) : (
                <EmptyState>
                  {t("elizaosapps.phone.role.empty", {
                    defaultValue: "No Android roles returned.",
                  })}
                </EmptyState>
              )}
              <SecondaryButton
                agentId="phone-open-settings"
                agentLabel={t("elizaosapps.phone.settings", {
                  defaultValue: "Settings",
                })}
                disabled={busy}
                icon={<Settings className="h-4 w-4" />}
                onClick={openSystemSettings}
              >
                {t("elizaosapps.phone.settings", { defaultValue: "Settings" })}
              </SecondaryButton>
            </div>
            <div className="rounded-sm border border-border bg-bg p-3">
              <div className="mb-3 text-sm font-medium text-txt">
                {t("elizaosapps.phone.newContact.title", {
                  defaultValue: "New Contact",
                })}
              </div>
              <div className="grid gap-3">
                <TextInput
                  agentId="phone-new-contact-display-name"
                  agentGroup="phone-new-contact"
                  label={t("elizaosapps.phone.newContact.displayName", {
                    defaultValue: "Display Name",
                  })}
                  value={displayName}
                  onChange={setDisplayName}
                />
                <TextInput
                  agentId="phone-new-contact-phone-number"
                  agentGroup="phone-new-contact"
                  label={t("elizaosapps.phone.newContact.phoneNumber", {
                    defaultValue: "Phone Number",
                  })}
                  value={phoneNumber}
                  onChange={setPhoneNumber}
                />
                <TextInput
                  agentId="phone-new-contact-email"
                  agentGroup="phone-new-contact"
                  label={t("elizaosapps.phone.newContact.email", {
                    defaultValue: "Email",
                  })}
                  value={emailAddress}
                  onChange={setEmailAddress}
                />
                <PrimaryButton
                  agentId="phone-new-contact-create"
                  agentLabel={t("elizaosapps.phone.newContact.create", {
                    defaultValue: "Create Contact",
                  })}
                  agentGroup="phone-new-contact"
                  disabled={busy || !displayName.trim()}
                  icon={<UserPlus className="h-4 w-4" />}
                  onClick={createContact}
                >
                  {t("elizaosapps.phone.newContact.create", {
                    defaultValue: "Create Contact",
                  })}
                </PrimaryButton>
              </div>
            </div>
          </div>
        </div>
      </Panel>
    );
  };

  return (
    <ShellViewAgentSurface viewId="elizaos-apps-phone">
      <div className="flex h-full min-h-0 w-full flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-txt">
              {t("elizaosapps.phone.heading", { defaultValue: "Phone" })}
            </h1>
            <div className="text-sm text-muted">
              {t("elizaosapps.phone.subheading", {
                defaultValue: "ElizaOS Android phone workspace",
              })}
            </div>
          </div>
          <SecondaryButton
            agentId="phone-refresh"
            agentLabel={t("elizaosapps.phone.refresh", {
              defaultValue: "Refresh",
            })}
            disabled={busy}
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={refresh}
          >
            {t("elizaosapps.phone.refresh", { defaultValue: "Refresh" })}
          </SecondaryButton>
        </div>
        <div className="flex flex-wrap gap-2">
          {PHONE_PANEL_ITEMS.map((item) => (
            <PhonePanelTabButton
              key={item.id}
              item={item}
              label={t(item.labelKey, { defaultValue: item.defaultLabel })}
              isActive={activePanel === item.id}
              onSelect={setActivePanel}
            />
          ))}
        </div>
        <StatusNotice error={error} notice={notice} />
        <div className="min-h-0 flex-1 overflow-y-auto">{renderPanel()}</div>
      </div>
    </ShellViewAgentSurface>
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

interface AndroidSmsGatewayReply {
  success?: boolean;
  handled?: boolean;
  reason?: string;
  replyText?: string | null;
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

function androidSmsGatewayPayload(incoming: IncomingSmsContext) {
  return {
    type: "new-message",
    data: {
      guid:
        incoming.messageId ??
        `android-sms-${incoming.sender}-${incoming.timestamp ?? Date.now()}`,
      text: incoming.body,
      isFromMe: false,
      handle: {
        address: incoming.sender,
        service: "SMS",
      },
      chats: [
        {
          guid: `SMS;-;${incoming.sender}`,
          chatIdentifier: incoming.sender,
        },
      ],
      dateCreated: incoming.timestamp ?? Date.now(),
      metadata: {
        localPhoneNumber: ANDROID_SMS_GATEWAY_PHONE_NUMBER,
        phoneNumber: ANDROID_SMS_GATEWAY_PHONE_NUMBER,
        phoneAccountId: ANDROID_SMS_GATEWAY_PHONE_NUMBER,
        phoneAccountLabel: ANDROID_SMS_GATEWAY_PHONE_LABEL,
        androidSmsGateway: true,
      },
    },
  };
}

export function MessagesPageView() {
  const { t } = useTranslation();
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
  const forwardedIncomingIds = useRef<Set<string>>(new Set());

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

  useEffect(() => {
    if (!ANDROID_SMS_GATEWAY_ENABLED || !incomingSms) return;
    if (!ANDROID_SMS_GATEWAY_SECRET) {
      setError("Android SMS gateway secret is not configured.");
      return;
    }

    const key =
      incomingSms.messageId ??
      `${incomingSms.sender}:${incomingSms.timestamp ?? ""}:${incomingSms.body}`;
    if (forwardedIncomingIds.current.has(key)) return;
    forwardedIncomingIds.current.add(key);

    let cancelled = false;
    const forward = async () => {
      try {
        const response = await fetch(ANDROID_SMS_GATEWAY_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-eliza-bridge": "android-sms",
            "x-eliza-gateway-secret": ANDROID_SMS_GATEWAY_SECRET,
          },
          body: JSON.stringify(androidSmsGatewayPayload(incomingSms)),
        });
        const cloudReply = (await response.json().catch(() => ({}))) as
          | AndroidSmsGatewayReply
          | Record<string, never>;
        if (!response.ok) {
          throw new Error(
            `Cloud gateway failed (${response.status}): ${JSON.stringify(cloudReply)}`,
          );
        }

        const replyText = cloudReply.replyText?.trim();
        if (!replyText) {
          if (!cancelled) setNotice("SMS forwarded to Eliza Cloud.");
          return;
        }

        const plugins = getPlugins();
        if (typeof plugins.messages.plugin.sendSms !== "function") {
          throw new Error("ElizaMessages plugin is unavailable");
        }
        await plugins.messages.plugin.sendSms({
          address: incomingSms.sender,
          body: replyText,
        });
        if (!cancelled) {
          setNotice("SMS forwarded to Eliza Cloud and reply sent.");
          await refresh();
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    void forward();
    return () => {
      cancelled = true;
    };
  }, [incomingSms, refresh]);

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
    <ShellViewAgentSurface viewId="elizaos-apps-messages">
      <div className="mx-auto grid w-full max-w-5xl gap-4 p-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
        <Panel
          title={t("elizaosapps.messages.compose.title", {
            defaultValue: "Compose",
          })}
          description={t("elizaosapps.messages.compose.description", {
            defaultValue: "Send through Android SMS Manager.",
          })}
        >
          <div className="grid gap-3">
            {incomingSms ? (
              <div className="rounded-sm border border-border bg-bg p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                  <span>
                    {incomingSms.sender ||
                      t("elizaosapps.messages.unknownSender", {
                        defaultValue: "unknown sender",
                      })}
                  </span>
                  <span>
                    {incomingSms.timestamp
                      ? formatTimestamp(incomingSms.timestamp)
                      : t("elizaosapps.messages.unknownTime", {
                          defaultValue: "Unknown time",
                        })}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-txt">
                  {incomingSms.body ||
                    t("elizaosapps.messages.emptyBody", {
                      defaultValue: "Empty SMS body",
                    })}
                </p>
                {incomingSms.messageId ? (
                  <div className="mt-2 text-xs text-muted">
                    {t("elizaosapps.messages.messageId", {
                      id: incomingSms.messageId,
                      defaultValue: "message {{id}}",
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
            <TextInput
              agentId="messages-address"
              agentGroup="messages-compose"
              label={t("elizaosapps.messages.addressLabel", {
                defaultValue: "Address",
              })}
              placeholder="+15551234567"
              value={address}
              onChange={setAddress}
            />
            <TextArea
              agentId="messages-body"
              agentGroup="messages-compose"
              label={t("elizaosapps.messages.bodyLabel", {
                defaultValue: "Body",
              })}
              placeholder={t("elizaosapps.messages.bodyPlaceholder", {
                defaultValue: "Message",
              })}
              value={body}
              onChange={setBody}
            />
            <PrimaryButton
              agentId="messages-send"
              agentLabel={t("elizaosapps.messages.send", {
                defaultValue: "Send SMS",
              })}
              agentGroup="messages-compose"
              disabled={busy}
              icon={<Send className="h-4 w-4" />}
              onClick={send}
            >
              {t("elizaosapps.messages.send", { defaultValue: "Send SMS" })}
            </PrimaryButton>
            <StatusNotice error={error} notice={notice} />
          </div>
        </Panel>
        <Panel
          title={t("elizaosapps.messages.list.title", {
            defaultValue: "Messages",
          })}
          description={t("elizaosapps.messages.list.description", {
            defaultValue: "Recent rows from Android's SMS provider.",
          })}
        >
          <div className="mb-3">
            <SecondaryButton
              agentId="messages-refresh"
              agentLabel={t("elizaosapps.messages.refresh", {
                defaultValue: "Refresh",
              })}
              disabled={busy}
              icon={<RefreshCw className="h-4 w-4" />}
              onClick={refresh}
            >
              {t("elizaosapps.messages.refresh", { defaultValue: "Refresh" })}
            </SecondaryButton>
          </div>
          <div className="grid max-h-[60vh] gap-2 overflow-y-auto">
            {messages.length > 0 ? (
              messages.map((message) => (
                <div
                  key={message.id}
                  className="rounded-sm border border-border bg-bg p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                    <span>
                      {message.address ||
                        t("elizaosapps.messages.unknownAddress", {
                          defaultValue: "unknown address",
                        })}
                    </span>
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
              <EmptyState>
                {t("elizaosapps.messages.list.empty", {
                  defaultValue: "No messages returned by Android.",
                })}
              </EmptyState>
            )}
          </div>
        </Panel>
      </div>
    </ShellViewAgentSurface>
  );
}

export function ContactsPageView() {
  const { t } = useTranslation();
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
    <ShellViewAgentSurface viewId="elizaos-apps-contacts">
      <div className="mx-auto grid w-full max-w-5xl gap-4 p-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
        <Panel
          title={t("elizaosapps.contacts.create.title", {
            defaultValue: "Create Contact",
          })}
          description={t("elizaosapps.contacts.create.description", {
            defaultValue: "Write into Android Contacts Provider.",
          })}
        >
          <div className="grid gap-3">
            <TextInput
              agentId="contacts-create-display-name"
              agentGroup="contacts-create"
              label={t("elizaosapps.contacts.displayName", {
                defaultValue: "Display Name",
              })}
              value={displayName}
              onChange={setDisplayName}
            />
            <TextInput
              agentId="contacts-create-phone-number"
              agentGroup="contacts-create"
              label={t("elizaosapps.contacts.phoneNumber", {
                defaultValue: "Phone Number",
              })}
              value={phoneNumber}
              onChange={setPhoneNumber}
            />
            <TextInput
              agentId="contacts-create-email"
              agentGroup="contacts-create"
              label={t("elizaosapps.contacts.email", {
                defaultValue: "Email",
              })}
              value={emailAddress}
              onChange={setEmailAddress}
            />
            <PrimaryButton
              agentId="contacts-create-submit"
              agentLabel={t("elizaosapps.contacts.create.button", {
                defaultValue: "Create",
              })}
              agentGroup="contacts-create"
              disabled={busy}
              icon={<UserPlus className="h-4 w-4" />}
              onClick={create}
            >
              {t("elizaosapps.contacts.create.button", {
                defaultValue: "Create",
              })}
            </PrimaryButton>
            <StatusNotice error={error} notice={notice} />
          </div>
        </Panel>
        <Panel
          title={t("elizaosapps.contacts.list.title", {
            defaultValue: "Contacts",
          })}
          description={t("elizaosapps.contacts.list.description", {
            defaultValue: "Read from Android Contacts Provider.",
          })}
        >
          <div className="mb-3 flex flex-col gap-2 sm:flex-row">
            <div className="min-w-0 flex-1">
              <TextInput
                agentId="contacts-search"
                label={t("elizaosapps.contacts.searchLabel", {
                  defaultValue: "Search",
                })}
                placeholder={t("elizaosapps.contacts.searchPlaceholder", {
                  defaultValue: "Name, number, or email",
                })}
                value={query}
                onChange={setQuery}
              />
            </div>
            <div className="flex items-end">
              <SecondaryButton
                agentId="contacts-refresh"
                agentLabel={t("elizaosapps.contacts.refresh", {
                  defaultValue: "Refresh",
                })}
                disabled={busy}
                icon={<RefreshCw className="h-4 w-4" />}
                onClick={refresh}
              >
                {t("elizaosapps.contacts.refresh", { defaultValue: "Refresh" })}
              </SecondaryButton>
            </div>
          </div>
          <div className="grid max-h-[60vh] gap-2 overflow-y-auto">
            {contacts.length > 0 ? (
              contacts.map((contact) => (
                <div
                  key={contact.id}
                  className="rounded-sm border border-border bg-bg p-3 text-sm"
                >
                  <div className="font-medium text-txt">
                    {contact.displayName}
                  </div>
                  <div className="mt-1 text-muted">
                    {contact.phoneNumbers.length > 0
                      ? contact.phoneNumbers.join(", ")
                      : t("elizaosapps.contacts.noNumbers", {
                          defaultValue: "No phone numbers",
                        })}
                  </div>
                  {contact.emailAddresses.length > 0 ? (
                    <div className="mt-1 text-xs text-muted">
                      {contact.emailAddresses.join(", ")}
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <EmptyState>
                {t("elizaosapps.contacts.list.empty", {
                  defaultValue: "No contacts returned by Android.",
                })}
              </EmptyState>
            )}
          </div>
        </Panel>
      </div>
    </ShellViewAgentSurface>
  );
}
