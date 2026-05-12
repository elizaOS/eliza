/**
 * macOS Contacts reader for @elizaos/plugin-imessage.
 *
 * Incoming iMessages arrive tagged with a raw handle — a phone number in
 * E.164 form (`+15551234567`) or an email address. Raw handles are ugly
 * to read and make the agent's replies feel impersonal. This module
 * resolves each handle to the real display name from the user's Apple
 * Contacts so the agent sees "Mom" or "Alex Chen" instead of a string
 * of digits.
 *
 * ---
 *
 * Backend: **CNContactStore** through the shared native macOS dylib. This
 * keeps the feature aligned with the macOS Contacts privacy grant and avoids
 * asking for Automation access to the Contacts app.
 *
 * The service calls this lazily when it actually needs name resolution or
 * contact CRUD. Contacts rarely change mid-session, so the iMessage service
 * caches the returned map for v1.
 *
 * Graceful degradation: if Contacts is not authorized, or returns no
 * rows, or the native bridge fails for any other reason, the reader returns
 * an empty map. The service treats that as "handles remain anonymous"
 * and proceeds normally — no crash, no hard failure.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "@elizaos/core";

const NATIVE_DYLIB_CANDIDATES = [
  process.env.MILADY_NATIVE_PERMISSIONS_DYLIB ?? "",
  "../../../packages/app-core/platforms/electrobun/src/libMacWindowEffects.dylib",
].filter(Boolean);

/**
 * A single resolved contact: the display name and one of the handles
 * (phone or email) through which that contact reaches the agent. The
 * same name can appear under multiple handles.
 */
export interface ResolvedContact {
  /** The contact's display name as stored in Apple Contacts. */
  name: string;
}

/**
 * Handle → contact map. Keys are normalized handles (phone numbers in
 * digits-only form with a leading `+` if international, emails in
 * lowercase). Callers should normalize their lookup keys with
 * {@link normalizeContactHandle} before querying.
 */
export type ContactsMap = Map<string, ResolvedContact>;

type NativeContactsResponse = {
  contacts?: unknown[];
  error?: string;
  id?: string;
  message?: string;
  ok: boolean;
};

type ContactsFailure = "bridge_unavailable" | "native_error" | "permission" | null;

type NativeContactsBridge = {
  addContact(payloadJson: string): string | null;
  deleteContact(personId: string): string | null;
  listAllContacts(): string | null;
  loadContacts(): string | null;
  updateContact(personId: string, payloadJson: string): string | null;
};

let nativeContactsBridge: NativeContactsBridge | null | undefined;
let lastContactsFailure: ContactsFailure = null;

export function getLastContactsFailure(): ContactsFailure {
  return lastContactsFailure;
}

function cStringBuffer(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const buffer = Buffer.alloc(bytes.byteLength + 1);
  bytes.copy(buffer);
  return buffer;
}

async function loadNativeContactsBridge(): Promise<NativeContactsBridge | null> {
  if (nativeContactsBridge !== undefined) return nativeContactsBridge;
  nativeContactsBridge = null;
  if (process.platform !== "darwin") return null;

  for (const candidate of NATIVE_DYLIB_CANDIDATES) {
    const dylibPath = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(import.meta.dir, candidate);
    if (!existsSync(dylibPath)) continue;
    try {
      const { CString, FFIType, dlopen, ptr } = await import("bun:ffi");
      const lib = dlopen(dylibPath, {
        loadContactsJson: { args: [], returns: FFIType.ptr },
        listAllContactsJson: { args: [], returns: FFIType.ptr },
        addContactJson: { args: [FFIType.ptr], returns: FFIType.ptr },
        updateContactJson: {
          args: [FFIType.ptr, FFIType.ptr],
          returns: FFIType.ptr,
        },
        deleteContactJson: { args: [FFIType.ptr], returns: FFIType.ptr },
        freeNativeCString: { args: [FFIType.ptr], returns: FFIType.void },
      });

      const takeNativeString = (value: unknown): string | null => {
        if (!value) return null;
        try {
          return new CString(value as never).toString();
        } finally {
          lib.symbols.freeNativeCString(value as never);
        }
      };

      nativeContactsBridge = {
        loadContacts() {
          return takeNativeString(lib.symbols.loadContactsJson());
        },
        listAllContacts() {
          return takeNativeString(lib.symbols.listAllContactsJson());
        },
        addContact(payloadJson) {
          const payload = cStringBuffer(payloadJson);
          return takeNativeString(lib.symbols.addContactJson(ptr(payload)));
        },
        updateContact(personId, payloadJson) {
          const id = cStringBuffer(personId);
          const payload = cStringBuffer(payloadJson);
          return takeNativeString(lib.symbols.updateContactJson(ptr(id), ptr(payload)));
        },
        deleteContact(personId) {
          const id = cStringBuffer(personId);
          return takeNativeString(lib.symbols.deleteContactJson(ptr(id)));
        },
      };
      return nativeContactsBridge;
    } catch (error) {
      logger.warn(
        `[imessage] Failed to load native Contacts bridge from ${dylibPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return null;
}

function parseNativeContactsResponse(raw: string | null): NativeContactsResponse {
  if (!raw) {
    return {
      ok: false,
      error: "native_error",
      message: "Native Contacts bridge returned no response.",
    };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<NativeContactsResponse>;
    return {
      ok: parsed.ok === true,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
      contacts: Array.isArray(parsed.contacts) ? parsed.contacts : undefined,
    };
  } catch {
    return {
      ok: false,
      error: "native_error",
      message: "Native Contacts bridge returned invalid JSON.",
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

/**
 * Normalize a handle to the canonical form used as a key in the
 * ContactsMap. Strips whitespace, parentheses, hyphens, and dots from
 * phone numbers and lowercases emails. Leaves a leading `+` in place.
 */
export function normalizeContactHandle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // Email: lowercase
  if (trimmed.includes("@")) {
    return trimmed.toLowerCase();
  }

  // Phone: strip formatting characters, preserve leading +
  const hasPlus = trimmed.startsWith("+");
  const digitsOnly = trimmed.replace(/[^\d]/g, "");
  return hasPlus ? `+${digitsOnly}` : digitsOnly;
}

/**
 * Parse legacy tab-delimited contact fixture output into a ContactsMap.
 * Exported so tests can exercise normalization without a live address book.
 *
 * Input format per line: `kind\thandle\tname`.
 * Empty lines are skipped. Lines with fewer than 3 fields are skipped.
 * Empty handles are skipped. Duplicate handles keep the first entry.
 */
export function parseContactsOutput(raw: string): ContactsMap {
  const map: ContactsMap = new Map();
  if (!raw?.trim()) return map;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const fields = trimmed.split("\t");
    if (fields.length < 3) continue;

    const [_kind, handle, name] = fields;
    if (!handle || !name) continue;

    const normalized = normalizeContactHandle(handle);
    if (!normalized) continue;
    if (map.has(normalized)) continue;

    map.set(normalized, { name: name.trim() });
  }

  return map;
}

function contactsMapFromNativeRows(rows: unknown[] | undefined): ContactsMap {
  const map: ContactsMap = new Map();
  for (const row of rows ?? []) {
    if (!isRecord(row)) continue;
    const handle = stringField(row, "handle");
    const name = stringField(row, "name");
    if (!handle || !name) continue;

    const normalized = normalizeContactHandle(handle);
    if (!normalized) continue;
    if (map.has(normalized)) continue;

    map.set(normalized, { name: name.trim() });
  }
  return map;
}

/**
 * Read Apple Contacts through CNContactStore and return a ContactsMap. Returns
 * an empty map (with a warning log) on any failure — most commonly, the
 * user hasn't authorized Contacts access yet.
 */
export async function loadContacts(): Promise<ContactsMap> {
  const bridge = await loadNativeContactsBridge();
  if (!bridge) {
    lastContactsFailure = "bridge_unavailable";
    logger.warn(
      "[imessage] Native Contacts bridge unavailable. Inbound messages will use raw handles."
    );
    return new Map();
  }
  const response = parseNativeContactsResponse(bridge.loadContacts());
  if (response.ok) {
    lastContactsFailure = null;
    const map = contactsMapFromNativeRows(response.contacts);
    logger.info(`[imessage] Contacts loaded: ${map.size} handle(s) resolved from Apple Contacts`);
    return map;
  }
  if (response.error === "permission") {
    lastContactsFailure = "permission";
    logger.warn(
      "[imessage] Contacts access not authorized. Inbound messages will use raw handles until Contacts access is granted."
    );
  } else {
    lastContactsFailure = "native_error";
    logger.warn(
      `[imessage] Failed to load Apple Contacts data: ${
        response.message ?? response.error ?? "unknown error"
      }. Inbound messages will use raw handles instead of names.`
    );
  }
  return new Map();
}

// ============================================================================
// Full-contact read + CRUD
// ============================================================================
//
// `loadContacts` above returns a narrow handle→name map used for inline
// name resolution on inbound messages. The UI layer needs something
// richer: full contact records (id, name, every phone/email with label)
// for list views, and write methods (create/update/delete) so the agent
// and the dashboard can edit the user's address book.
//
// Everything below uses the same CNContactStore native bridge as loadContacts.
// Reads and writes share the macOS Contacts privacy grant and degrade to
// empty/null/false when the grant or native bridge is unavailable.

/**
 * A full contact record, richer than ContactsMap's handle-keyed entries.
 * Returned by `listAllContacts` and the single-contact CRUD helpers.
 * Each phone/email carries its Apple Contacts label when available
 * (`home`, `work`, `mobile`, etc.) so the UI can surface context.
 */
export interface FullContact {
  /** Apple Contacts stable person id. Used for update/delete. */
  id: string;
  /** Display name as stored in Apple Contacts. */
  name: string;
  firstName: string | null;
  lastName: string | null;
  phones: Array<{ label: string | null; value: string }>;
  emails: Array<{ label: string | null; value: string }>;
}

/** Input shape for creating a contact via `addContact`. */
export interface NewContactInput {
  firstName?: string;
  lastName?: string;
  phones?: Array<{ label?: string; value: string }>;
  emails?: Array<{ label?: string; value: string }>;
}

function labeledValuesFromNativeRows(
  rows: unknown
): Array<{ label: string | null; value: string }> {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const value = stringField(entry, "value");
    if (!value) return [];
    const label = stringField(entry, "label");
    return [{ label: label || null, value }];
  });
}

function fullContactsFromNativeRows(rows: unknown[] | undefined): FullContact[] {
  return (rows ?? []).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = stringField(entry, "id");
    if (!id) return [];
    return [
      {
        id,
        name: stringField(entry, "name"),
        firstName: stringField(entry, "firstName") || null,
        lastName: stringField(entry, "lastName") || null,
        phones: labeledValuesFromNativeRows(entry.phones),
        emails: labeledValuesFromNativeRows(entry.emails),
      },
    ];
  });
}

/**
 * List every contact in the user's address book as a full `FullContact`
 * record. Returns an empty array on any failure (permission denied,
 * native bridge error, etc.) with a warning log.
 */
export async function listAllContacts(): Promise<FullContact[]> {
  const bridge = await loadNativeContactsBridge();
  if (!bridge) {
    lastContactsFailure = "bridge_unavailable";
    logger.warn("[imessage] listAllContacts failed: native bridge unavailable");
    return [];
  }
  const response = parseNativeContactsResponse(bridge.listAllContacts());
  if (response.ok) {
    lastContactsFailure = null;
    return fullContactsFromNativeRows(response.contacts);
  }
  lastContactsFailure = response.error === "permission" ? "permission" : "native_error";
  logger.warn(
    `[imessage] listAllContacts failed: ${response.message ?? response.error ?? "unknown error"}`
  );
  return [];
}

/**
 * Create a new Apple Contacts record. Returns the new person's id on
 * success, or null on failure (permission denied, validation, etc.).
 *
 * Requires the Contacts privacy grant.
 */
export async function addContact(input: NewContactInput): Promise<string | null> {
  const bridge = await loadNativeContactsBridge();
  if (!bridge) {
    lastContactsFailure = "bridge_unavailable";
    logger.warn("[imessage] addContact failed: native bridge unavailable");
    return null;
  }
  const response = parseNativeContactsResponse(bridge.addContact(JSON.stringify(input)));
  if (response.ok && response.id) {
    lastContactsFailure = null;
    logger.info(`[imessage] Contact created: ${response.id}`);
    return response.id;
  }
  lastContactsFailure = response.error === "permission" ? "permission" : "native_error";
  logger.warn(
    `[imessage] addContact failed: ${response.message ?? response.error ?? "unknown error"}`
  );
  return null;
}

/**
 * Patch an existing contact. `firstName` and `lastName` are set when
 * provided. Phones and emails can be added (`addPhones` / `addEmails`)
 * or removed (`removePhones` / `removeEmails`, matched by value). For
 * simplicity we don't support editing an existing phone in place —
 * callers should remove-then-add to achieve that.
 */
export interface ContactPatch {
  firstName?: string;
  lastName?: string;
  addPhones?: Array<{ label?: string; value: string }>;
  removePhones?: string[];
  addEmails?: Array<{ label?: string; value: string }>;
  removeEmails?: string[];
}

export async function updateContact(personId: string, patch: ContactPatch): Promise<boolean> {
  if (
    patch.firstName === undefined &&
    patch.lastName === undefined &&
    (patch.addPhones?.length ?? 0) === 0 &&
    (patch.removePhones?.length ?? 0) === 0 &&
    (patch.addEmails?.length ?? 0) === 0 &&
    (patch.removeEmails?.length ?? 0) === 0
  ) {
    return true;
  }

  const bridge = await loadNativeContactsBridge();
  if (!bridge) {
    lastContactsFailure = "bridge_unavailable";
    logger.warn(`[imessage] updateContact failed for ${personId}: native bridge unavailable`);
    return false;
  }
  const response = parseNativeContactsResponse(
    bridge.updateContact(personId, JSON.stringify(patch))
  );
  if (response.ok) {
    lastContactsFailure = null;
    logger.info(`[imessage] Contact updated: ${personId}`);
    return true;
  }
  lastContactsFailure = response.error === "permission" ? "permission" : "native_error";
  logger.warn(
    `[imessage] updateContact failed for ${personId}: ${
      response.message ?? response.error ?? "unknown error"
    }`
  );
  return false;
}

/**
 * Delete a contact by Apple Contacts id. Requires the Contacts privacy grant.
 * Returns false on any failure (not found, permission denied, etc.).
 */
export async function deleteContact(personId: string): Promise<boolean> {
  const bridge = await loadNativeContactsBridge();
  if (!bridge) {
    lastContactsFailure = "bridge_unavailable";
    logger.warn(`[imessage] deleteContact failed for ${personId}: native bridge unavailable`);
    return false;
  }
  const response = parseNativeContactsResponse(bridge.deleteContact(personId));
  if (response.ok) {
    lastContactsFailure = null;
    logger.info(`[imessage] Contact deleted: ${personId}`);
    return true;
  }
  lastContactsFailure = response.error === "permission" ? "permission" : "native_error";
  logger.warn(
    `[imessage] deleteContact failed for ${personId}: ${
      response.message ?? response.error ?? "unknown error"
    }`
  );
  return false;
}
