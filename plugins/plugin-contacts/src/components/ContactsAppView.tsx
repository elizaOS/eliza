/**
 * ContactsAppView — full-screen overlay app for the Android address book.
 *
 * Implements the OverlayApp Component contract. Backed by the
 * @elizaos/capacitor-contacts native plugin which exposes:
 *   - listContacts({ query, limit })
 *   - createContact({ displayName, phoneNumber(s), emailAddress(es) })
 *   - importVCard({ vcardText })
 *
 * The native plugin does not currently expose update or delete, so the detail
 * panel is read-only; "Edit" creates a new contact entry rather than mutating
 * an existing row.
 */

import {
  type ContactSummary,
  Contacts,
  type CreateContactOptions,
} from "@elizaos/capacitor-contacts";
import type { OverlayAppContext } from "@elizaos/ui";
import { Button, Input } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { isNative } from "@elizaos/ui/platform";
import {
  ArrowLeft,
  ChevronLeft,
  Mail,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Star,
  Upload,
  UserRound,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

type Mode = "list" | "detail" | "new";

type NewContactForm = {
  displayName: string;
  phoneNumber: string;
  emailAddress: string;
};

const EMPTY_FORM: NewContactForm = {
  displayName: "",
  phoneNumber: "",
  emailAddress: "",
};

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    const first = parts[0];
    return first?.charAt(0).toUpperCase() ?? "?";
  }
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts[parts.length - 1]?.charAt(0) ?? "";
  return `${first}${last}`.toUpperCase() || "?";
}

function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function matchesQuery(contact: ContactSummary, q: string): boolean {
  if (q.length === 0) return true;
  const needle = q.toLowerCase();
  if (contact.displayName.toLowerCase().includes(needle)) return true;
  if (
    contact.phoneNumbers.some((p: string) => p.toLowerCase().includes(needle))
  ) {
    return true;
  }
  if (
    contact.emailAddresses.some((e: string) => e.toLowerCase().includes(needle))
  ) {
    return true;
  }
  return false;
}

function normalizeContactsLimit(value: unknown, fallback = 200): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(500, Math.max(1, Math.trunc(value)));
}

async function loadContactsState(options?: { query?: string; limit?: number }) {
  const query = options?.query?.trim() ?? "";
  const limit =
    typeof options?.limit === "number"
      ? normalizeContactsLimit(options.limit)
      : undefined;
  const result = await Contacts.listContacts({
    ...(query ? { query } : {}),
    ...(typeof limit === "number" ? { limit } : {}),
  });
  const contacts = query
    ? result.contacts.filter((contact) => matchesQuery(contact, query))
    : result.contacts;
  return {
    contacts,
    query,
    count: contacts.length,
  };
}

export function ContactsAppView({ exitToApps, t }: OverlayAppContext) {
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<NewContactForm>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    if (!isNative) {
      setContacts([]);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await Contacts.listContacts({});
      setContacts(result.contacts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (q.length === 0) return contacts;
    return contacts.filter((c) => matchesQuery(c, q));
  }, [contacts, query]);

  const selected = useMemo(
    () => contacts.find((c) => c.id === selectedId) ?? null,
    [contacts, selectedId],
  );

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMode("detail");
  }, []);

  const handleBackToList = useCallback(() => {
    setMode("list");
    setSelectedId(null);
  }, []);

  const handleOpenNew = useCallback(() => {
    setForm(EMPTY_FORM);
    setMode("new");
  }, []);

  const handleSubmitNew = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const displayName = form.displayName.trim();
      if (displayName.length === 0) return;

      const payload: CreateContactOptions = { displayName };
      const phone = form.phoneNumber.trim();
      const email = form.emailAddress.trim();
      if (phone.length > 0) payload.phoneNumber = phone;
      if (email.length > 0) payload.emailAddress = email;

      setSubmitting(true);
      setError(null);
      try {
        await Contacts.createContact(payload);
        await refresh();
        setMode("list");
        setForm(EMPTY_FORM);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [form, refresh],
  );

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset input so the same file can be re-selected later.
      event.target.value = "";
      if (!file) return;

      setLoading(true);
      setError(null);
      try {
        const vcardText = await file.text();
        await Contacts.importVCard({ vcardText });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    },
    [refresh],
  );

  const backLabel =
    mode === "list"
      ? t("nav.back", { defaultValue: "Back" })
      : t("nav.backToList", { defaultValue: "Back to list" });
  const back = useAgentElement<HTMLButtonElement>({
    id: "nav-back",
    role: "button",
    label: backLabel,
    group: "contacts-nav",
    description:
      mode === "list"
        ? "Leave the contacts app"
        : "Return to the contacts list",
  });
  const refreshLabel = t("actions.refresh", { defaultValue: "Refresh" });
  const refreshEl = useAgentElement<HTMLButtonElement>({
    id: "action-refresh",
    role: "button",
    label: refreshLabel,
    group: "contacts-actions",
    description: "Reload the contacts list",
  });
  const newLabel = t("contacts.new", { defaultValue: "New contact" });
  const newEl = useAgentElement<HTMLButtonElement>({
    id: "action-new",
    role: "button",
    label: newLabel,
    group: "contacts-actions",
    description: "Open the new contact form",
  });
  const searchLabel = t("contacts.search", {
    defaultValue: "Search contacts",
  });
  const searchEl = useAgentElement<HTMLInputElement>({
    id: "input-search",
    role: "text-input",
    label: searchLabel,
    group: "contacts-actions",
    description: "Filter contacts by name, phone, or email",
  });

  return (
    <div
      data-testid="contacts-shell"
      className="fixed inset-0 z-50 flex h-[100vh] flex-col overflow-hidden bg-bg pb-[var(--safe-area-bottom,0px)] pl-[var(--safe-area-left,0px)] pr-[var(--safe-area-right,0px)] pt-[var(--safe-area-top,0px)] supports-[height:100dvh]:h-[100dvh]"
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".vcf,text/vcard,text/x-vcard"
        className="hidden"
        onChange={handleFileChange}
      />

      <header className="flex shrink-0 items-center justify-between border-b border-border/20 bg-bg/80 px-4 py-3 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            ref={back.ref}
            {...back.agentProps}
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-xl text-muted hover:text-txt"
            onClick={mode === "list" ? exitToApps : handleBackToList}
            aria-label={backLabel}
          >
            {mode === "list" ? (
              <ArrowLeft className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </Button>
          <h1 className="truncate text-base font-semibold text-txt">
            {mode === "detail" && selected
              ? selected.displayName
              : mode === "new"
                ? t("contacts.new", { defaultValue: "New contact" })
                : t("contacts.title", { defaultValue: "Contacts" })}
          </h1>
        </div>

        {mode === "list" && (
          <div className="flex items-center gap-2">
            <Button
              ref={refreshEl.ref}
              {...refreshEl.agentProps}
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-xl text-muted hover:text-txt"
              onClick={refresh}
              disabled={loading}
              aria-label={refreshLabel}
              data-testid="contacts-refresh"
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              />
            </Button>
            <Button
              ref={newEl.ref}
              {...newEl.agentProps}
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-xl text-muted hover:text-txt"
              onClick={handleOpenNew}
              aria-label={newLabel}
              data-testid="contacts-new"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        )}
      </header>

      {mode === "list" && (
        <div className="shrink-0 border-b border-border/20 px-4 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <Input
              ref={searchEl.ref}
              {...searchEl.agentProps}
              value={query}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setQuery(e.target.value)
              }
              placeholder={searchLabel}
              className="pl-9"
              aria-label={searchLabel}
              data-testid="contacts-search"
            />
          </div>
        </div>
      )}

      <div className="chat-native-scrollbar flex-1 overflow-y-auto">
        {error && (
          <div
            role="alert"
            className="mx-4 mt-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {error}
          </div>
        )}

        {mode === "list" && (
          <ContactList
            contacts={filtered}
            loading={loading && contacts.length === 0}
            empty={!loading && contacts.length === 0}
            onSelect={handleSelect}
            onImport={handleImportClick}
            t={t}
          />
        )}

        {mode === "detail" && selected && (
          <ContactDetail contact={selected} t={t} />
        )}

        {mode === "new" && (
          <NewContactForm
            form={form}
            submitting={submitting}
            onChange={setForm}
            onSubmit={handleSubmitNew}
            onCancel={handleBackToList}
            t={t}
          />
        )}
      </div>
    </div>
  );
}

type TFn = OverlayAppContext["t"];

function ContactList({
  contacts,
  loading,
  empty,
  onSelect,
  onImport,
  t,
}: {
  contacts: ContactSummary[];
  loading: boolean;
  empty: boolean;
  onSelect: (id: string) => void;
  onImport: () => void;
  t: TFn;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted">
        {t("contacts.loading", { defaultValue: "Loading contacts…" })}
      </div>
    );
  }

  if (empty) {
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-3 px-4 py-16 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/25 bg-accent/12">
          <UserRound className="h-7 w-7 text-accent" />
        </div>
        <div className="text-sm font-medium text-txt">
          {t("contacts.empty.title", { defaultValue: "No contacts yet" })}
        </div>
        <ImportVCardButton onImport={onImport} t={t} />
      </div>
    );
  }

  if (contacts.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-sm text-muted">
        {t("contacts.noMatches", {
          defaultValue: "No contacts match your search.",
        })}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border/20">
      {contacts.map((contact, index) => (
        <ContactListItem
          key={contact.id}
          contact={contact}
          index={index}
          onSelect={onSelect}
          t={t}
        />
      ))}
    </ul>
  );
}

function ImportVCardButton({ onImport, t }: { onImport: () => void; t: TFn }) {
  const label = t("contacts.import", { defaultValue: "Import vCard" });
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "action-import",
    role: "button",
    label,
    group: "contacts-actions",
    description: "Import contacts from a vCard file",
  });
  return (
    <Button
      ref={ref}
      {...agentProps}
      variant="default"
      onClick={onImport}
      className="mt-2"
    >
      <Upload className="mr-2 h-4 w-4" />
      {label}
    </Button>
  );
}

function ContactListItem({
  contact,
  index,
  onSelect,
  t,
}: {
  contact: ContactSummary;
  index: number;
  onSelect: (id: string) => void;
  t: TFn;
}) {
  const name =
    contact.displayName || t("contacts.unnamed", { defaultValue: "Unnamed" });
  const primaryPhone = contact.phoneNumbers[0] ?? "";
  const primaryEmail = contact.emailAddresses[0] ?? "";
  const subtitle = primaryPhone || primaryEmail;
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `contact-${contact.id}`,
    role: "list-item",
    label: name,
    group: "contacts-list",
    description: "Open this contact's details",
    order: index,
  });
  return (
    <li>
      <button
        ref={ref}
        {...agentProps}
        type="button"
        onClick={() => onSelect(contact.id)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-bg-accent/40 focus:bg-bg-accent/40 focus:outline-none"
      >
        <Avatar name={contact.displayName} photoUri={contact.photoUri} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-txt">
              {name}
            </span>
            {contact.starred && (
              <Star
                className="h-3.5 w-3.5 shrink-0 text-amber-400"
                fill="currentColor"
                aria-label={t("contacts.starred", {
                  defaultValue: "Starred",
                })}
              />
            )}
          </div>
          {subtitle && (
            <div className="truncate text-xs text-muted">{subtitle}</div>
          )}
        </div>
      </button>
    </li>
  );
}

function ContactDetail({ contact, t }: { contact: ContactSummary; t: TFn }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 px-4 py-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Avatar
          name={contact.displayName}
          photoUri={contact.photoUri}
          size="lg"
        />
        <div>
          <h2 className="text-lg font-semibold text-txt">
            {contact.displayName ||
              t("contacts.unnamed", { defaultValue: "Unnamed" })}
          </h2>
          {contact.starred && (
            <div className="mt-1 inline-flex items-center gap-1 text-xs text-amber-400">
              <Star className="h-3 w-3" fill="currentColor" />
              {t("contacts.starred", { defaultValue: "Starred" })}
            </div>
          )}
        </div>
      </div>

      <ContactFieldGroup
        label={t("contacts.phones", { defaultValue: "Phone" })}
        items={contact.phoneNumbers}
        renderItem={(value) => (
          <a
            href={`tel:${value}`}
            className="flex items-center gap-2 text-sm text-txt hover:underline"
          >
            <Phone className="h-4 w-4 text-muted" />
            <span className="break-all">{value}</span>
          </a>
        )}
        emptyLabel={t("contacts.noPhones", {
          defaultValue: "No phone numbers",
        })}
      />

      <ContactFieldGroup
        label={t("contacts.emails", { defaultValue: "Email" })}
        items={contact.emailAddresses}
        renderItem={(value) => (
          <a
            href={`mailto:${value}`}
            className="flex items-center gap-2 text-sm text-txt hover:underline"
          >
            <Mail className="h-4 w-4 text-muted" />
            <span className="break-all">{value}</span>
          </a>
        )}
        emptyLabel={t("contacts.noEmails", {
          defaultValue: "No email addresses",
        })}
      />

      <p className="text-xs text-muted">
        {t("contacts.detail.readOnlyNote", {
          defaultValue:
            "Editing existing contacts is not yet supported on this device.",
        })}
      </p>
    </div>
  );
}

function ContactFieldGroup({
  label,
  items,
  renderItem,
  emptyLabel,
}: {
  label: string;
  items: string[];
  renderItem: (value: string) => ReactElement;
  emptyLabel: string;
}) {
  return (
    <section className="rounded-xl border border-border/30 bg-bg-accent/40 px-4 py-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </h3>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-muted">{emptyLabel}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {dedupePreservingOrder(items).map((value) => (
            <li key={value}>{renderItem(value)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NewContactForm({
  form,
  submitting,
  onChange,
  onSubmit,
  onCancel,
  t,
}: {
  form: NewContactForm;
  submitting: boolean;
  onChange: (next: NewContactForm) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
  t: TFn;
}) {
  const canSubmit = form.displayName.trim().length > 0 && !submitting;
  const nameId = useId();
  const phoneId = useId();
  const emailId = useId();

  const nameEl = useAgentElement<HTMLInputElement>({
    id: "input-name",
    role: "text-input",
    label: t("contacts.form.name", { defaultValue: "Name" }),
    group: "contacts-form",
    description: "Display name for the new contact",
  });
  const phoneEl = useAgentElement<HTMLInputElement>({
    id: "input-phone",
    role: "text-input",
    label: t("contacts.form.phone", { defaultValue: "Phone" }),
    group: "contacts-form",
    description: "Phone number for the new contact",
  });
  const emailEl = useAgentElement<HTMLInputElement>({
    id: "input-email",
    role: "text-input",
    label: t("contacts.form.email", { defaultValue: "Email" }),
    group: "contacts-form",
    description: "Email address for the new contact",
  });
  const cancelEl = useAgentElement<HTMLButtonElement>({
    id: "action-cancel",
    role: "button",
    label: t("actions.cancel", { defaultValue: "Cancel" }),
    group: "contacts-form",
    description: "Discard the new contact and return to the list",
  });
  const saveEl = useAgentElement<HTMLButtonElement>({
    id: "action-save",
    role: "button",
    label: t("contacts.form.save", { defaultValue: "Save" }),
    group: "contacts-form",
    description: "Save the new contact",
    status: canSubmit ? undefined : "disabled",
  });

  return (
    <form
      onSubmit={onSubmit}
      className="mx-auto flex max-w-md flex-col gap-4 px-4 py-6"
    >
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={nameId}
          className="text-xs font-semibold uppercase tracking-wide text-muted"
        >
          {t("contacts.form.name", { defaultValue: "Name" })}
        </label>
        <Input
          ref={nameEl.ref}
          {...nameEl.agentProps}
          id={nameId}
          value={form.displayName}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            onChange({ ...form, displayName: e.target.value })
          }
          placeholder={t("contacts.form.namePlaceholder", {
            defaultValue: "Full name",
          })}
          required
          autoFocus
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={phoneId}
          className="text-xs font-semibold uppercase tracking-wide text-muted"
        >
          {t("contacts.form.phone", { defaultValue: "Phone" })}
        </label>
        <Input
          ref={phoneEl.ref}
          {...phoneEl.agentProps}
          id={phoneId}
          type="tel"
          inputMode="tel"
          value={form.phoneNumber}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            onChange({ ...form, phoneNumber: e.target.value })
          }
          placeholder="+1 555 123 4567"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={emailId}
          className="text-xs font-semibold uppercase tracking-wide text-muted"
        >
          {t("contacts.form.email", { defaultValue: "Email" })}
        </label>
        <Input
          ref={emailEl.ref}
          {...emailEl.agentProps}
          id={emailId}
          type="email"
          inputMode="email"
          value={form.emailAddress}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            onChange({ ...form, emailAddress: e.target.value })
          }
          placeholder="name@example.com"
        />
      </div>

      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          ref={cancelEl.ref}
          {...cancelEl.agentProps}
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={submitting}
        >
          {t("actions.cancel", { defaultValue: "Cancel" })}
        </Button>
        <Button
          ref={saveEl.ref}
          {...saveEl.agentProps}
          type="submit"
          disabled={!canSubmit}
        >
          {submitting
            ? t("contacts.form.saving", { defaultValue: "Saving…" })
            : t("contacts.form.save", { defaultValue: "Save" })}
        </Button>
      </div>
    </form>
  );
}

function Avatar({
  name,
  photoUri,
  size = "md",
}: {
  name: string;
  photoUri?: string;
  size?: "md" | "lg";
}) {
  const dimension = size === "lg" ? "h-16 w-16 text-xl" : "h-10 w-10 text-sm";
  if (photoUri) {
    return (
      <img
        src={photoUri}
        alt=""
        className={`${dimension} shrink-0 rounded-full object-cover`}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      className={`${dimension} flex shrink-0 items-center justify-center rounded-full bg-bg-accent font-semibold text-muted`}
    >
      {getInitials(name)}
    </div>
  );
}

function ContactsTuiListItem({
  contact,
  index,
  selected,
  onSelect,
}: {
  contact: ContactSummary;
  index: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const name = contact.displayName || "Unnamed";
  const subtitle =
    contact.phoneNumbers[0] ?? contact.emailAddresses[0] ?? "no contact method";
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `tui-contact-${contact.id}`,
    role: "list-item",
    label: name,
    group: "contacts-tui-list",
    description: "Open this contact's terminal detail",
    order: index,
    status: selected ? "active" : "inactive",
  });
  return (
    <button
      ref={ref}
      {...agentProps}
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(contact.id)}
      style={{
        width: "100%",
        display: "grid",
        gridTemplateColumns: "4ch minmax(8ch, 1fr) 2ch",
        gap: 10,
        border: "none",
        borderTop: index === 0 ? "none" : "1px solid rgba(125,211,252,0.18)",
        background: selected ? "rgba(125,211,252,0.12)" : "transparent",
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
      <span style={{ color: "#e2e8f0", overflow: "hidden" }}>{name}</span>
      <span
        aria-label={contact.starred ? "Starred" : "Not starred"}
        role="img"
        style={{ color: contact.starred ? "#facc15" : "#64748b" }}
        title={contact.starred ? "Starred" : "Not starred"}
      >
        <Star
          aria-hidden
          fill={contact.starred ? "currentColor" : "none"}
          size={14}
          strokeWidth={contact.starred ? 0 : 1.8}
        />
      </span>
      <span style={{ gridColumn: "2 / 4", color: "#94a3b8" }}>{subtitle}</span>
    </button>
  );
}

export function ContactsTuiView() {
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [vcardText, setVcardText] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [lastAction, setLastAction] = useState("boot");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadContactsState({ query });
      setContacts(next.contacts);
      setLastAction(query ? `search ${query}` : "refresh");
    } catch (err) {
      setContacts([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = useMemo(
    () => contacts.find((contact) => contact.id === selectedId) ?? null,
    [contacts, selectedId],
  );

  const refreshEl = useAgentElement<HTMLButtonElement>({
    id: "tui-action-refresh",
    role: "button",
    label: "Refresh",
    group: "contacts-tui-list",
    description: "Reload the terminal contacts list",
    status: loading ? "disabled" : undefined,
  });
  const searchEl = useAgentElement<HTMLInputElement>({
    id: "tui-input-search",
    role: "text-input",
    label: "Search contacts",
    group: "contacts-tui-list",
    description: "Filter the terminal contacts by name, phone, or email",
    getValue: () => query,
    onFill: setQuery,
  });
  const nameEl = useAgentElement<HTMLInputElement>({
    id: "tui-input-name",
    role: "text-input",
    label: "Name",
    group: "contacts-tui-create",
    description: "Display name for the new terminal contact",
    getValue: () => displayName,
    onFill: setDisplayName,
  });
  const phoneEl = useAgentElement<HTMLInputElement>({
    id: "tui-input-phone",
    role: "text-input",
    label: "Phone",
    group: "contacts-tui-create",
    description: "Phone number for the new terminal contact",
    getValue: () => phoneNumber,
    onFill: setPhoneNumber,
  });
  const emailEl = useAgentElement<HTMLInputElement>({
    id: "tui-input-email",
    role: "text-input",
    label: "Email",
    group: "contacts-tui-create",
    description: "Email address for the new terminal contact",
    getValue: () => emailAddress,
    onFill: setEmailAddress,
  });
  const createEl = useAgentElement<HTMLButtonElement>({
    id: "tui-action-create",
    role: "button",
    label: "Create contact",
    group: "contacts-tui-create",
    description: "Create the contact from the terminal form",
    status: !displayName.trim() || submitting ? "disabled" : undefined,
  });
  const vcardEl = useAgentElement<HTMLTextAreaElement>({
    id: "tui-input-vcard",
    role: "textarea",
    label: "vCard text",
    group: "contacts-tui-create",
    description: "Raw vCard text to import as contacts",
    getValue: () => vcardText,
    onFill: setVcardText,
  });
  const importEl = useAgentElement<HTMLButtonElement>({
    id: "tui-action-import",
    role: "button",
    label: "Import vCard",
    group: "contacts-tui-create",
    description: "Import contacts from the pasted vCard text",
    status: !vcardText.trim() || submitting ? "disabled" : undefined,
  });

  const createContact = useCallback(async () => {
    const name = displayName.trim();
    if (!name || submitting) return;
    const payload: CreateContactOptions = { displayName: name };
    const phone = phoneNumber.trim();
    const email = emailAddress.trim();
    if (phone) payload.phoneNumber = phone;
    if (email) payload.emailAddress = email;

    setSubmitting(true);
    setError(null);
    try {
      const result = await Contacts.createContact(payload);
      setDisplayName("");
      setPhoneNumber("");
      setEmailAddress("");
      setLastAction(`created ${result.id}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [displayName, emailAddress, phoneNumber, refresh, submitting]);

  const importVCard = useCallback(async () => {
    const text = vcardText.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await Contacts.importVCard({ vcardText: text });
      setVcardText("");
      setLastAction(`imported ${result.imported.length}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [refresh, submitting, vcardText]);

  const state = {
    viewType: "tui",
    viewId: "contacts",
    contactCount: contacts.length,
    query,
    selectedId,
    selectedName: selected?.displayName ?? null,
    pendingName: displayName,
    pendingPhone: phoneNumber,
    pendingEmail: emailAddress,
    pendingVCardLength: vcardText.length,
    loading,
    submitting,
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
        elizaos://contacts --type=tui
      </div>
      <div style={{ color: "#475569", marginBottom: 16 }}>
        {loading ? "loading" : `${contacts.length} contacts`} | {lastAction}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(240px, 0.9fr) minmax(300px, 1.1fr)",
          gap: 16,
        }}
      >
        <section
          aria-label="Contacts list"
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
              gap: 10,
              marginBottom: 12,
            }}
          >
            <strong style={{ color: "#e2e8f0" }}>address book</strong>
            <button
              ref={refreshEl.ref}
              {...refreshEl.agentProps}
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

          <label
            htmlFor="contacts-tui-search"
            style={{ display: "block", color: "#94a3b8", marginBottom: 6 }}
          >
            search
          </label>
          <input
            ref={searchEl.ref}
            {...searchEl.agentProps}
            id="contacts-tui-search"
            name="query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
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

          {error && <div style={{ color: "#fca5a5" }}>{error}</div>}
          {!loading && !error && contacts.length === 0 && (
            <div style={{ color: "#64748b" }}>no contacts</div>
          )}
          {contacts.map((contact, index) => (
            <ContactsTuiListItem
              key={contact.id}
              contact={contact}
              index={index}
              selected={contact.id === selectedId}
              onSelect={(id) => {
                setSelectedId(id);
                setLastAction(`open ${id}`);
              }}
            />
          ))}
        </section>

        <section
          aria-label="Contacts detail and create"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <strong style={{ color: "#e2e8f0" }}>
            {selected ? selected.displayName || "Unnamed" : "create contact"}
          </strong>
          <div style={{ color: "#64748b", margin: "6px 0 14px" }}>
            commands: list | create | import-vcard
          </div>

          {selected && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ color: "#a7f3d0", marginBottom: 8 }}>detail</div>
              <div>
                <span style={{ color: "#64748b" }}>id</span> {selected.id}
              </div>
              {dedupePreservingOrder(selected.phoneNumbers).map((phone) => (
                <div key={phone}>
                  <span style={{ color: "#64748b" }}>tel</span> {phone}
                </div>
              ))}
              {dedupePreservingOrder(selected.emailAddresses).map((email) => (
                <div key={email}>
                  <span style={{ color: "#64748b" }}>mail</span> {email}
                </div>
              ))}
              {selected.starred && (
                <div style={{ color: "#facc15" }}>starred</div>
              )}
            </div>
          )}

          <label
            htmlFor="contacts-tui-name"
            style={{ display: "block", color: "#94a3b8", marginBottom: 6 }}
          >
            name
          </label>
          <input
            ref={nameEl.ref}
            {...nameEl.agentProps}
            id="contacts-tui-name"
            name="displayName"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
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
            htmlFor="contacts-tui-phone"
            style={{ display: "block", color: "#94a3b8", marginBottom: 6 }}
          >
            phone
          </label>
          <input
            ref={phoneEl.ref}
            {...phoneEl.agentProps}
            id="contacts-tui-phone"
            name="phoneNumber"
            value={phoneNumber}
            onChange={(event) => setPhoneNumber(event.target.value)}
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
            htmlFor="contacts-tui-email"
            style={{ display: "block", color: "#94a3b8", marginBottom: 6 }}
          >
            email
          </label>
          <input
            ref={emailEl.ref}
            {...emailEl.agentProps}
            id="contacts-tui-email"
            name="emailAddress"
            value={emailAddress}
            onChange={(event) => setEmailAddress(event.target.value)}
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
            ref={createEl.ref}
            {...createEl.agentProps}
            type="button"
            onClick={() => void createContact()}
            disabled={!displayName.trim() || submitting}
            style={{
              background: "transparent",
              color: "#7dd3fc",
              border: "1px solid rgba(125,211,252,0.45)",
              borderRadius: 4,
              padding: "6px 10px",
              cursor:
                !displayName.trim() || submitting ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              marginBottom: 18,
            }}
          >
            create
          </button>

          <label
            htmlFor="contacts-tui-vcard"
            style={{ display: "block", color: "#94a3b8", marginBottom: 6 }}
          >
            vcard
          </label>
          <textarea
            ref={vcardEl.ref}
            {...vcardEl.agentProps}
            id="contacts-tui-vcard"
            name="vcardText"
            value={vcardText}
            onChange={(event) => setVcardText(event.target.value)}
            rows={5}
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
              marginBottom: 12,
            }}
          />
          <button
            ref={importEl.ref}
            {...importEl.agentProps}
            type="button"
            onClick={() => void importVCard()}
            disabled={!vcardText.trim() || submitting}
            style={{
              background: "transparent",
              color: "#a7f3d0",
              border: "1px solid rgba(167,243,208,0.45)",
              borderRadius: 4,
              padding: "6px 10px",
              cursor:
                !vcardText.trim() || submitting ? "not-allowed" : "pointer",
              fontFamily: "inherit",
            }}
          >
            import-vcard
          </button>
        </section>
      </div>
    </div>
  );
}

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-list-contacts") {
    const state = await loadContactsState({
      query: typeof params?.query === "string" ? params.query : undefined,
      limit: typeof params?.limit === "number" ? params.limit : undefined,
    });
    return {
      viewType: "tui",
      query: state.query,
      count: state.count,
      contacts: state.contacts.map((contact) => ({
        id: contact.id,
        lookupKey: contact.lookupKey,
        displayName: contact.displayName,
        phoneNumbers: contact.phoneNumbers,
        emailAddresses: contact.emailAddresses,
        starred: contact.starred,
      })),
    };
  }

  if (capability === "terminal-create-contact") {
    const displayName =
      typeof params?.displayName === "string" ? params.displayName.trim() : "";
    if (!displayName) throw new Error("displayName is required");
    const payload: CreateContactOptions = { displayName };
    const phoneNumber =
      typeof params?.phoneNumber === "string" ? params.phoneNumber.trim() : "";
    const emailAddress =
      typeof params?.emailAddress === "string"
        ? params.emailAddress.trim()
        : "";
    if (phoneNumber) payload.phoneNumber = phoneNumber;
    if (emailAddress) payload.emailAddress = emailAddress;
    const result = await Contacts.createContact(payload);
    return { created: true, id: result.id, viewType: "tui" };
  }

  if (capability === "terminal-import-vcard") {
    const vcardText =
      typeof params?.vcardText === "string" ? params.vcardText.trim() : "";
    if (!vcardText) throw new Error("vcardText is required");
    const result = await Contacts.importVCard({ vcardText });
    return {
      imported: result.imported.length,
      contacts: result.imported.map((contact) => ({
        id: contact.id,
        lookupKey: contact.lookupKey,
        displayName: contact.displayName,
        phoneNumbers: contact.phoneNumbers,
        emailAddresses: contact.emailAddresses,
        starred: contact.starred,
        sourceName: contact.sourceName,
      })),
      viewType: "tui",
    };
  }

  throw new Error(`Unsupported capability "${capability}"`);
}
