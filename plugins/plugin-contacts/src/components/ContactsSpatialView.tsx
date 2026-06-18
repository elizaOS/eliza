/**
 * ContactsSpatialView - the contacts address book authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus a type-only view of
 * the native contact record, so it is safe to render in the Node agent process
 * where the terminal lives (no Capacitor runtime import).
 */

import type { ContactSummary } from "@elizaos/capacitor-contacts";
import {
  Button,
  Card,
  Divider,
  Field,
  HStack,
  List,
  Text,
  VStack,
} from "@elizaos/ui/spatial";

/** Which screen the contacts surface is currently showing. */
export type ContactsMode = "list" | "detail" | "new";

/** Pending values for the new-contact form. */
export interface ContactsFormDraft {
  displayName: string;
  phoneNumber: string;
  emailAddress: string;
}

export interface ContactsSnapshot {
  /** Address book records (already filtered to the active query when present). */
  contacts: ContactSummary[];
  /** Active search filter; empty string when unfiltered. */
  query: string;
  /** Current screen. */
  mode: ContactsMode;
  /** Id of the contact shown in detail mode, if any. */
  selectedId?: string | null;
  /** Draft for the new-contact form (detail/new mode). */
  form?: ContactsFormDraft;
  loading?: boolean;
  submitting?: boolean;
  error?: string | null;
}

const EMPTY_FORM: ContactsFormDraft = {
  displayName: "",
  phoneNumber: "",
  emailAddress: "",
};

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]?.charAt(0) ?? "?").toUpperCase();
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts[parts.length - 1]?.charAt(0) ?? "";
  return `${first}${last}`.toUpperCase() || "?";
}

function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function primaryLine(contact: ContactSummary): string {
  return (
    contact.phoneNumbers[0] ?? contact.emailAddresses[0] ?? "no contact method"
  );
}

export interface ContactsSpatialViewProps {
  snapshot: ContactsSnapshot;
  /**
   * Dispatch by agent id: `refresh`, `new`, `back`, `cancel`, `save`,
   * `select:<id>`, `call:<value>`, `text:<value>`.
   */
  onAction?: (action: string) => void;
}

export function ContactsSpatialView({
  snapshot,
  onAction,
}: ContactsSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const mode = snapshot.mode;
  const selected =
    snapshot.selectedId != null
      ? (snapshot.contacts.find((c) => c.id === snapshot.selectedId) ?? null)
      : null;
  const title =
    mode === "detail" && selected
      ? selected.displayName || "Unnamed"
      : mode === "new"
        ? "New contact"
        : "Contacts";

  return (
    <Card title={title} gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text style="caption" tone="muted" grow={1}>
          {snapshot.loading
            ? "loading"
            : `${snapshot.contacts.length} contacts`}
        </Text>
        {mode === "list" ? (
          <>
            <Button
              variant="outline"
              tone="default"
              agent="refresh"
              onPress={dispatch("refresh")}
            >
              Refresh
            </Button>
            <Button agent="new" onPress={dispatch("new")}>
              New
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            tone="default"
            agent="back"
            onPress={dispatch("back")}
          >
            Back
          </Button>
        )}
      </HStack>

      {snapshot.error ? (
        <Text tone="danger" style="caption">
          {snapshot.error}
        </Text>
      ) : null}

      {mode === "list" ? (
        <ContactsListBody snapshot={snapshot} dispatch={dispatch} />
      ) : mode === "detail" && selected ? (
        <ContactsDetailBody contact={selected} dispatch={dispatch} />
      ) : (
        <ContactsFormBody snapshot={snapshot} dispatch={dispatch} />
      )}
    </Card>
  );
}

function ContactsListBody({
  snapshot,
  dispatch,
}: {
  snapshot: ContactsSnapshot;
  dispatch: (action: string) => () => void;
}) {
  return (
    <>
      <Field
        kind="text"
        label="Search"
        value={snapshot.query}
        placeholder="name, phone, or email"
        agent="search"
      />
      <Divider label="address book" />
      {snapshot.contacts.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          {snapshot.loading ? "Loading contacts" : "No contacts"}
        </Text>
      ) : (
        <List gap={0}>
          {snapshot.contacts.slice(0, 12).map((contact) => {
            const name = contact.displayName || "Unnamed";
            return (
              <HStack
                key={contact.id}
                gap={1}
                align="center"
                agent={`select-${contact.id}`}
              >
                <Text tone="muted" wrap={false}>
                  [{getInitials(name)}]
                </Text>
                <VStack gap={0} grow={1}>
                  <Text bold wrap={false}>
                    {name}
                  </Text>
                  <Text style="caption" tone="muted" wrap={false}>
                    {primaryLine(contact)}
                  </Text>
                </VStack>
                {contact.starred ? (
                  <Text tone="warning" wrap={false}>
                    *
                  </Text>
                ) : null}
                <Button
                  variant="outline"
                  tone="default"
                  agent={`select:${contact.id}`}
                  onPress={dispatch(`select:${contact.id}`)}
                >
                  Open
                </Button>
              </HStack>
            );
          })}
        </List>
      )}
    </>
  );
}

function ContactsDetailBody({
  contact,
  dispatch,
}: {
  contact: ContactSummary;
  dispatch: (action: string) => () => void;
}) {
  const phones = dedupePreservingOrder(contact.phoneNumbers);
  const emails = dedupePreservingOrder(contact.emailAddresses);
  return (
    <>
      <HStack gap={1} align="center">
        <Text tone="muted">[{getInitials(contact.displayName)}]</Text>
        <Text style="subheading" bold grow={1}>
          {contact.displayName || "Unnamed"}
        </Text>
        {contact.starred ? <Text tone="warning">starred</Text> : null}
      </HStack>

      <Divider label="phone" />
      {phones.length === 0 ? (
        <Text tone="muted" style="caption">
          No phone numbers
        </Text>
      ) : (
        <List gap={0}>
          {phones.map((value) => (
            <HStack key={value} gap={1} align="center">
              <Text grow={1} wrap={false}>
                {value}
              </Text>
              <Button
                agent={`call:${value}`}
                onPress={dispatch(`call:${value}`)}
              >
                Call
              </Button>
              <Button
                variant="outline"
                tone="default"
                agent={`text:${value}`}
                onPress={dispatch(`text:${value}`)}
              >
                Text
              </Button>
            </HStack>
          ))}
        </List>
      )}

      <Divider label="email" />
      {emails.length === 0 ? (
        <Text tone="muted" style="caption">
          No email addresses
        </Text>
      ) : (
        <List gap={0}>
          {emails.map((value) => (
            <Text key={value} wrap={false}>
              {value}
            </Text>
          ))}
        </List>
      )}

      <Text tone="muted" style="caption">
        Editing existing contacts is unavailable on this device.
      </Text>
    </>
  );
}

function ContactsFormBody({
  snapshot,
  dispatch,
}: {
  snapshot: ContactsSnapshot;
  dispatch: (action: string) => () => void;
}) {
  const form = snapshot.form ?? EMPTY_FORM;
  const canSubmit = form.displayName.trim().length > 0 && !snapshot.submitting;
  return (
    <>
      <Field
        kind="text"
        label="Name"
        value={form.displayName}
        placeholder="Full name"
        agent="name"
      />
      <Field
        kind="text"
        label="Phone"
        value={form.phoneNumber}
        placeholder="+1 555 123 4567"
        agent="phone"
      />
      <Field
        kind="text"
        label="Email"
        value={form.emailAddress}
        placeholder="name@example.com"
        agent="email"
      />
      <HStack gap={1}>
        <Button
          grow={1}
          disabled={!canSubmit}
          agent="save"
          onPress={dispatch("save")}
        >
          {snapshot.submitting ? "Saving" : "Save"}
        </Button>
        <Button
          variant="ghost"
          tone="danger"
          agent="cancel"
          onPress={dispatch("cancel")}
        >
          Cancel
        </Button>
      </HStack>
    </>
  );
}
