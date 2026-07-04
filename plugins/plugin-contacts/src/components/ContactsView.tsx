/**
 * ContactsView — the single GUI/XR data wrapper for the Contacts surface.
 *
 * It owns the live Android address-book data (contact fetch, permission gate,
 * background poll, list/detail/new mode, the new-contact form, and the
 * Call/Text handoffs to the Phone/Messages views) and renders the one
 * presentational {@link ContactsSpatialView} inside a {@link SpatialSurface}.
 * Omitting the `modality` prop lets `SpatialSurface` auto-detect GUI vs XR via
 * `window.__elizaXRContext`, so the SAME component serves both surfaces. The
 * TUI surface renders the same `ContactsSpatialView` through the terminal
 * registry (see `register-terminal-view.tsx`).
 *
 * The full-screen overlay-app variant (with vCard import + permission-recovery
 * callout) remains `ContactsAppView`, loaded by the overlay-app registry on
 * ElizaOS; this wrapper is the cross-modality view-bundle export.
 */

import {
  type ContactSummary,
  Contacts,
  type CreateContactOptions,
} from "@elizaos/capacitor-contacts";
import { isNative } from "@elizaos/ui/platform";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { matchesQuery } from "./ContactsAppView.helpers.ts";
import {
  type ContactsFormDraft,
  type ContactsMode,
  type ContactsSnapshot,
  ContactsSpatialView,
} from "./ContactsSpatialView.tsx";

const EMPTY_FORM: ContactsFormDraft = {
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

export function ContactsView() {
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<ContactsMode>("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<ContactsFormDraft>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setContacts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load the address book on mount, then keep it fresh with a quiet 20s poll.
  // Torn down on unmount.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (!autoLoadedRef.current) {
      autoLoadedRef.current = true;
      void refresh();
    }
    const interval = setInterval(() => {
      void refresh();
    }, 20_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // The native bridge has no server-side filter we depend on here; apply the
  // active query client-side so search reacts instantly without a refetch.
  const visibleContacts = useMemo(() => {
    const needle = query.trim();
    if (!needle) return contacts;
    return contacts.filter((contact) => matchesQuery(contact, needle));
  }, [contacts, query]);

  const createContact = useCallback(async () => {
    const displayName = form.displayName.trim();
    if (!displayName || submitting) return;
    const payload: CreateContactOptions = { displayName };
    const phone = form.phoneNumber.trim();
    const email = form.emailAddress.trim();
    if (phone) payload.phoneNumber = phone;
    if (email) payload.emailAddress = email;

    setSubmitting(true);
    setError(null);
    try {
      await Contacts.createContact(payload);
      setForm(EMPTY_FORM);
      setMode("list");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [form, refresh, submitting]);

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("select:")) {
        setSelectedId(action.slice("select:".length));
        setMode("detail");
        return;
      }
      if (action.startsWith("call:")) {
        navigateToPhoneWithNumber(action.slice("call:".length));
        return;
      }
      if (action.startsWith("text:")) {
        navigateToMessagesWithNumber(action.slice("text:".length));
        return;
      }
      if (action.startsWith("search:")) {
        setQuery(action.slice("search:".length));
        return;
      }
      if (action.startsWith("name:")) {
        const value = action.slice("name:".length);
        setForm((prev) => ({ ...prev, displayName: value }));
        return;
      }
      if (action.startsWith("phone:")) {
        const value = action.slice("phone:".length);
        setForm((prev) => ({ ...prev, phoneNumber: value }));
        return;
      }
      if (action.startsWith("email:")) {
        const value = action.slice("email:".length);
        setForm((prev) => ({ ...prev, emailAddress: value }));
        return;
      }
      switch (action) {
        case "refresh":
          void refresh();
          return;
        case "new":
          setForm(EMPTY_FORM);
          setMode("new");
          return;
        case "back":
        case "cancel":
          setMode("list");
          setSelectedId(null);
          return;
        case "save":
          void createContact();
          return;
      }
    },
    [createContact, refresh],
  );

  const snapshot: ContactsSnapshot = {
    contacts: visibleContacts,
    query,
    mode,
    selectedId,
    form,
    loading,
    submitting,
    error,
  };

  return <ContactsSpatialView snapshot={snapshot} onAction={onAction} />;
}
