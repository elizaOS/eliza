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
import { PermissionRecoveryCallout } from "@elizaos/ui/components";
import { isNative } from "@elizaos/ui/platform";
import {
  ArrowLeft,
  ChevronLeft,
  Mail,
  MessageSquareText,
  Phone,
  Plus,
  Star,
  Upload,
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

function navigateToPhoneWithNumber(number: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("eliza:navigate:view", {
      detail: {
        viewId: "phone",
        viewPath: "/phone",
        payload: { number },
      },
    }),
  );
}

function navigateToMessagesWithNumber(recipient: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("eliza:navigate:view", {
      detail: {
        viewId: "messages",
        viewPath: "/messages",
        payload: { recipient },
      },
    }),
  );
}

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

function isPermissionRecoveryError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("permission") ||
    normalized.includes("denied") ||
    normalized.includes("access is needed") ||
    normalized.includes("read_contacts")
  );
}

export function ContactsAppView({ exitToApps, t }: OverlayAppContext) {
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
      // Feature-gated permission: prompt for contacts access the first time the
      // Contacts view opens (idempotent — already-granted returns granted with
      // no prompt). Nothing requests this at app launch. Tolerates older bridges
      // without the request path by falling through to listContacts.
      // error-policy:J4 older-bridge compat degrade; null -> fall through to listContacts (which surfaces a real error)
      const status = await Contacts.requestPermissions().catch(() => null);
      if (status && status.contacts !== "granted") {
        setContacts([]);
        setError(
          "Contacts access is needed to show your address book. Grant it in your device settings, then retry.",
        );
        return;
      }
      const result = await Contacts.listContacts({});
      setContacts(result.contacts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // The native bridge has no change subscription, so keep the list fresh with a
  // quiet background poll (no user-facing Refresh control). Create/import still
  // re-load eagerly via `refresh()`.
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 20000);
    return () => clearInterval(interval);
  }, [refresh]);

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
  const newLabel = t("contacts.new", { defaultValue: "New contact" });
  const newEl = useAgentElement<HTMLButtonElement>({
    id: "action-new",
    role: "button",
    label: newLabel,
    group: "contacts-actions",
    description: "Open the new contact form",
  });

  return (
    <div
      data-testid="contacts-shell"
      className="fixed inset-0 z-50 flex h-[100vh] flex-col overflow-hidden bg-bg pb-[var(--safe-area-bottom,0px)] pl-[var(--safe-area-left,0px)] pr-[var(--safe-area-right,0px)] pt-[var(--safe-area-top,0px)] supports-[height:100dvh]:h-[100dvh]"
    >
      <Input
        ref={fileInputRef}
        type="file"
        accept=".vcf,text/vcard,text/x-vcard"
        className="hidden"
        onChange={handleFileChange}
      />

      <header className="flex shrink-0 items-center justify-between px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            ref={back.ref}
            {...back.agentProps}
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted hover:text-txt"
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
          <Button
            ref={newEl.ref}
            {...newEl.agentProps}
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-muted hover:text-txt"
            onClick={handleOpenNew}
            aria-label={newLabel}
            data-testid="contacts-new"
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </header>

      {mode === "list" && (
        <p data-testid="contacts-search-hint" className="sr-only">
          {t("contacts.searchHint", {
            defaultValue: "Search contacts by typing in the chat.",
          })}
        </p>
      )}

      <div className="chat-native-scrollbar flex-1 overflow-y-auto">
        {error && isPermissionRecoveryError(error) ? (
          <PermissionRecoveryCallout
            permission="contacts"
            title={t("contacts.permissionTitle", {
              defaultValue: "Contacts access is off",
            })}
            description={error}
            onRetry={refresh}
            retryLabel={t("actions.retry", { defaultValue: "Try again" })}
            className="mx-4 mt-4"
            testId="contacts-permission-callout"
          />
        ) : error ? (
          <div
            role="alert"
            className="mx-4 mt-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {error}
          </div>
        ) : null}

        {mode === "list" && (
          <ContactList
            contacts={contacts}
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
        {t("contacts.loading", { defaultValue: "Loading" })}
      </div>
    );
  }

  if (empty) {
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-3 px-4 py-16 text-center">
        <span
          className="flex h-16 w-16 items-center justify-center"
          style={{ background: "var(--accent-subtle)" }}
        >
          <AddressBookMotif />
        </span>
        <div className="mt-2 text-base font-semibold text-txt">
          {t("contacts.empty.title", { defaultValue: "None" })}
        </div>
        <p className="sr-only">
          {t("contacts.empty.body", {
            defaultValue: "Import vCard or add contact.",
          })}
        </p>
        <ImportVCardButton onImport={onImport} t={t} />
      </div>
    );
  }

  return (
    <ul>
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

function AddressBookMotif() {
  return (
    <svg width="88" height="88" viewBox="0 0 88 88" fill="none" role="img">
      <title>Address book</title>
      <rect
        x="20"
        y="14"
        width="48"
        height="60"
        rx="10"
        fill="var(--surface)"
        stroke="var(--accent)"
        strokeWidth="2"
      />
      <line
        x1="20"
        y1="30"
        x2="14"
        y2="30"
        stroke="var(--accent)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <line
        x1="20"
        y1="44"
        x2="14"
        y2="44"
        stroke="var(--accent)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <line
        x1="20"
        y1="58"
        x2="14"
        y2="58"
        stroke="var(--accent)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle
        cx="44"
        cy="38"
        r="8"
        fill="var(--accent-subtle)"
        stroke="var(--accent)"
        strokeWidth="2"
      />
      <path
        d="M32 60 C32 51 56 51 56 60"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
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
      <Button
        unstyled
        ref={ref}
        {...agentProps}
        type="button"
        onClick={() => onSelect(contact.id)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-bg-accent/40 focus:bg-bg-accent/40 focus:outline-none"
      >
        <Avatar name={contact.displayName} photoUri={contact.photoUri} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-txt">
              {name}
            </span>
            {contact.starred && (
              <Star
                className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
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
      </Button>
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
            <div className="mt-1 inline-flex items-center gap-1 text-xs text-[var(--accent)]">
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
          <ContactPhoneRow value={value} contactId={contact.id} t={t} />
        )}
        emptyLabel={t("contacts.noPhones", {
          defaultValue: "None",
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
          defaultValue: "None",
        })}
      />

      <p className="sr-only">
        {t("contacts.detail.readOnlyNote", {
          defaultValue:
            "Editing existing contacts is unavailable on this device.",
        })}
      </p>
    </div>
  );
}

// A phone-number row in the contact detail. Instead of an OS `tel:` handoff,
// it links to the in-app Phone and Messages views via the navigation bus,
// pre-seeding each with this number.
function ContactPhoneRow({
  value,
  contactId,
  t,
}: {
  value: string;
  contactId: string;
  t: TFn;
}) {
  const callLabel = t("contacts.call", { defaultValue: "Call" });
  const textLabel = t("contacts.text", { defaultValue: "Text" });
  const callEl = useAgentElement<HTMLButtonElement>({
    id: `call-${contactId}-${value}`,
    role: "button",
    label: `${callLabel} ${value}`,
    group: "contacts-detail-phone",
    description: "Open the Phone dialer pre-filled with this number",
  });
  const textEl = useAgentElement<HTMLButtonElement>({
    id: `text-${contactId}-${value}`,
    role: "button",
    label: `${textLabel} ${value}`,
    group: "contacts-detail-phone",
    description: "Open Messages to text this number",
  });
  return (
    <div className="flex items-center gap-2">
      <Phone className="h-4 w-4 shrink-0 text-muted" />
      <span className="min-w-0 flex-1 break-all text-sm text-txt">{value}</span>
      <Button
        ref={callEl.ref}
        {...callEl.agentProps}
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 rounded-lg text-muted hover:text-txt"
        onClick={() => navigateToPhoneWithNumber(value)}
        aria-label={`${callLabel} ${value}`}
        data-testid="contacts-detail-call"
      >
        <Phone className="h-4 w-4" />
      </Button>
      <Button
        ref={textEl.ref}
        {...textEl.agentProps}
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 rounded-lg text-muted hover:text-txt"
        onClick={() => navigateToMessagesWithNumber(value)}
        aria-label={`${textLabel} ${value}`}
        data-testid="contacts-detail-text"
      >
        <MessageSquareText className="h-4 w-4" />
      </Button>
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
    <section className="flex flex-col gap-2 pt-2">
      <h3 className="text-sm font-medium text-muted">{label}</h3>
      {items.length === 0 ? (
        <p className="sr-only">{emptyLabel}</p>
      ) : (
        <ul className="flex flex-col gap-2">
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
      className="mx-auto flex max-w-md flex-col gap-3 px-3 py-4"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className="text-sm font-medium text-muted">
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
        <label htmlFor={phoneId} className="text-sm font-medium text-muted">
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
        <label htmlFor={emailId} className="text-sm font-medium text-muted">
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
        className={`${dimension} shrink-0 object-cover`}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      className={`${dimension} flex shrink-0 items-center justify-center bg-bg-accent font-semibold text-muted`}
    >
      {getInitials(name)}
    </div>
  );
}
