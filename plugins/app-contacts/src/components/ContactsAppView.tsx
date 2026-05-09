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

import type { OverlayAppContext } from "@elizaos/ui";
import {
  type ContactSummary,
  Contacts,
  type CreateContactOptions,
} from "@elizaos/capacitor-contacts";
import { Button, Input } from "@elizaos/ui";
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
    return (first?.charAt(0) ?? "?").toUpperCase();
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

  return (
    <div
      data-testid="contacts-shell"
      className="fixed inset-0 z-50 flex flex-col bg-bg h-[100vh] overflow-hidden supports-[height:100dvh]:h-[100dvh]"
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
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-xl text-muted hover:text-txt"
            onClick={mode === "list" ? exitToApps : handleBackToList}
            aria-label={
              mode === "list"
                ? t("nav.back", { defaultValue: "Back" })
                : t("nav.backToList", { defaultValue: "Back to list" })
            }
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
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-xl text-muted hover:text-txt"
              onClick={refresh}
              disabled={loading}
              aria-label={t("actions.refresh", { defaultValue: "Refresh" })}
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-xl text-muted hover:text-txt"
              onClick={handleOpenNew}
              aria-label={t("contacts.new", { defaultValue: "New contact" })}
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
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("contacts.search", {
                defaultValue: "Search contacts",
              })}
              className="pl-9"
              aria-label={t("contacts.search", {
                defaultValue: "Search contacts",
              })}
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
        <UserRound className="h-10 w-10 text-muted" />
        <div className="text-sm font-medium text-txt">
          {t("contacts.empty.title", { defaultValue: "No contacts yet" })}
        </div>
        <p className="text-xs text-muted">
          {t("contacts.empty.body", {
            defaultValue:
              "Import a vCard file or tap the plus button to create one.",
          })}
        </p>
        <Button variant="default" onClick={onImport} className="mt-2">
          <Upload className="mr-2 h-4 w-4" />
          {t("contacts.import", { defaultValue: "Import vCard" })}
        </Button>
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
      {contacts.map((contact) => {
        const primaryPhone = contact.phoneNumbers[0] ?? "";
        const primaryEmail = contact.emailAddresses[0] ?? "";
        const subtitle = primaryPhone || primaryEmail;
        return (
          <li key={contact.id}>
            <button
              type="button"
              onClick={() => onSelect(contact.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-bg-accent/40 focus:bg-bg-accent/40 focus:outline-none"
            >
              <Avatar name={contact.displayName} photoUri={contact.photoUri} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-txt">
                    {contact.displayName ||
                      t("contacts.unnamed", { defaultValue: "Unnamed" })}
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
      })}
    </ul>
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
          id={nameId}
          value={form.displayName}
          onChange={(e) => onChange({ ...form, displayName: e.target.value })}
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
          id={phoneId}
          type="tel"
          inputMode="tel"
          value={form.phoneNumber}
          onChange={(e) => onChange({ ...form, phoneNumber: e.target.value })}
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
          id={emailId}
          type="email"
          inputMode="email"
          value={form.emailAddress}
          onChange={(e) => onChange({ ...form, emailAddress: e.target.value })}
          placeholder="name@example.com"
        />
      </div>

      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={submitting}
        >
          {t("actions.cancel", { defaultValue: "Cancel" })}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
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
