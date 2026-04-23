import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  AndroidRoleStatus,
  ContactSummary,
  SmsMessageSummary,
} from "../../bridge/native-plugins";
import { getPlugins } from "../../bridge/plugin-bridge";

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
  onClick,
  type = "button",
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-9 items-center justify-center rounded border border-border bg-primary px-3 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  disabled,
  onClick,
  type = "button",
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-9 items-center justify-center rounded border border-border bg-bg px-3 text-sm font-medium text-txt disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
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

function roleLine(role: AndroidRoleStatus): string {
  const holderText = role.holders.length > 0 ? role.holders.join(", ") : "none";
  return `${role.role}: ${role.held ? "held" : "not held"} (${holderText})`;
}

function numberFromTelUri(uri: string | null): string {
  if (!uri) return "";
  if (!uri.startsWith("tel:")) return uri;
  return decodeURIComponent(uri.slice("tel:".length));
}

export function PhonePageView() {
  const params = useLaunchParams();
  const [number, setNumber] = useState(() =>
    numberFromTelUri(params.get("uri")),
  );
  const [status, setStatus] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const uriNumber = numberFromTelUri(params.get("uri"));
    if (uriNumber) setNumber(uriNumber);
  }, [params]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const plugins = getPlugins();
      if (typeof plugins.phone.plugin.getStatus !== "function") {
        throw new Error("MiladyPhone plugin is unavailable");
      }
      if (typeof plugins.system.plugin.getStatus !== "function") {
        throw new Error("MiladySystem plugin is unavailable");
      }
      const [phone, system] = await Promise.all([
        plugins.phone.plugin.getStatus(),
        plugins.system.plugin.getStatus(),
      ]);
      setStatus([
        `telecom: ${phone.hasTelecom ? "available" : "unavailable"}`,
        `default dialer: ${phone.defaultDialerPackage ?? "none"}`,
        `can place calls: ${phone.canPlaceCalls ? "yes" : "no"}`,
        ...system.roles.map(roleLine),
      ]);
      setNotice(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const placeCall = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const trimmed = number.trim();
      if (!trimmed) throw new Error("number is required");
      const plugins = getPlugins();
      if (typeof plugins.phone.plugin.placeCall !== "function") {
        throw new Error("MiladyPhone plugin is unavailable");
      }
      await plugins.phone.plugin.placeCall({ number: trimmed });
      setNotice("Call request handed to Android Telecom.");
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
        throw new Error("MiladyPhone plugin is unavailable");
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

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-4">
      <Panel
        title="Phone"
        description="MiladyOS phone role and Android Telecom surface."
      >
        <div className="grid gap-3">
          <TextInput
            label="Number"
            placeholder="+15551234567"
            value={number}
            onChange={setNumber}
          />
          <div className="flex flex-wrap gap-2">
            <PrimaryButton disabled={busy} onClick={placeCall}>
              Call
            </PrimaryButton>
            <SecondaryButton disabled={busy} onClick={openDialer}>
              Open Dialer
            </SecondaryButton>
            <SecondaryButton disabled={busy} onClick={refresh}>
              Refresh Status
            </SecondaryButton>
          </div>
          <StatusNotice error={error} notice={notice} />
          <div className="grid gap-1 rounded border border-border bg-bg p-3 text-sm text-muted">
            {status.length > 0
              ? status.map((line) => <div key={line}>{line}</div>)
              : "No status loaded."}
          </div>
        </div>
      </Panel>
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

export function MessagesPageView() {
  const params = useLaunchParams();
  const [address, setAddress] = useState(() => params.get("recipient") ?? "");
  const [body, setBody] = useState(() => params.get("body") ?? "");
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
    setAddress(params.get("recipient") ?? params.get("sender") ?? "");
    setBody(params.get("body") ?? "");
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
        throw new Error("MiladyMessages plugin is unavailable");
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
        throw new Error("MiladyMessages plugin is unavailable");
      }
      await plugins.messages.plugin.sendSms({
        address: trimmedAddress,
        body: trimmedBody,
      });
      setNotice("SMS sent.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
      <Panel title="Compose" description="Send through Android SMS Manager.">
        <div className="grid gap-3">
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
          <PrimaryButton disabled={busy} onClick={send}>
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
          <SecondaryButton disabled={busy} onClick={refresh}>
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
            <div className="rounded border border-border bg-bg p-3 text-sm text-muted">
              No messages returned by Android.
            </div>
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
        throw new Error("MiladyContacts plugin is unavailable");
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
      if (!name) throw new Error("displayName is required");
      const plugins = getPlugins();
      if (typeof plugins.contacts.plugin.createContact !== "function") {
        throw new Error("MiladyContacts plugin is unavailable");
      }
      const result = await plugins.contacts.plugin.createContact({
        displayName: name,
        phoneNumber: number || undefined,
      });
      setNotice(`Created contact ${result.id}.`);
      setDisplayName("");
      setPhoneNumber("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
      <Panel
        title="Create Contact"
        description="Write into Android ContactsProvider."
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
          <PrimaryButton disabled={busy} onClick={create}>
            Create
          </PrimaryButton>
          <StatusNotice error={error} notice={notice} />
        </div>
      </Panel>
      <Panel title="Contacts" description="Read from Android ContactsProvider.">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row">
          <div className="min-w-0 flex-1">
            <TextInput
              label="Search"
              placeholder="Name"
              value={query}
              onChange={setQuery}
            />
          </div>
          <div className="flex items-end">
            <SecondaryButton disabled={busy} onClick={refresh}>
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
              </div>
            ))
          ) : (
            <div className="rounded border border-border bg-bg p-3 text-sm text-muted">
              No contacts returned by Android.
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
