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
 * Backend: **AppleScript against Contacts.app**. Unlike Messages.app
 * (whose scripting dictionary does not expose the message table), the
 * Contacts app ships with a complete and officially-supported AppleScript
 * vocabulary covering `person`, `phone`, and `email` classes. Reading
 * contacts this way is the Apple-blessed path and does not require Full
 * Disk Access — only the macOS "Contacts" TCC permission, which the OS
 * prompts for on first use.
 *
 * The reader runs once on service start and caches the result. Contacts
 * rarely change mid-session, so a periodic refresh is overkill for v1.
 * Callers can force a reload by constructing a fresh reader instance.
 *
 * Graceful degradation: if Contacts is not authorized, or returns no
 * rows, or AppleScript fails for any other reason, the reader returns
 * an empty map. The service treats that as "handles remain anonymous"
 * and proceeds normally — no crash, no hard failure.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "@elizaos/core";

const execFileAsync = promisify(execFile);
const DEFAULT_CONTACTS_SCRIPT_TIMEOUT_MS = 5_000;

/**
 * A single resolved contact: the display name and one of the handles
 * (phone or email) through which that contact reaches the agent. The
 * same name can appear under multiple handles.
 */
export interface ResolvedContact {
  /** The contact's display name as stored in Contacts.app. */
  name: string;
}

/**
 * Handle → contact map. Keys are normalized handles (phone numbers in
 * digits-only form with a leading `+` if international, emails in
 * lowercase). Callers should normalize their lookup keys with
 * {@link normalizeContactHandle} before querying.
 */
export type ContactsMap = Map<string, ResolvedContact>;

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
 * AppleScript that asks Contacts.app to dump every person's name and
 * every phone/email handle they own, one row per handle, tab-delimited.
 *
 * Format per line: `<kind>\t<handle>\t<name>` where `<kind>` is
 * `phone` or `email`. Lines with empty values are skipped by the parser.
 */
const CONTACTS_DUMP_SCRIPT = `
tell application "Contacts"
  launch
  set AppleScript's text item delimiters to tab
  set outputLines to {}
  repeat with p in people
    set personName to name of p
    if personName is missing value then set personName to ""
    repeat with ph in phones of p
      set phoneValue to value of ph
      if phoneValue is not missing value then
        set end of outputLines to "phone" & tab & phoneValue & tab & personName
      end if
    end repeat
    repeat with em in emails of p
      set emailValue to value of em
      if emailValue is not missing value then
        set end of outputLines to "email" & tab & emailValue & tab & personName
      end if
    end repeat
  end repeat
  set AppleScript's text item delimiters to linefeed
  set outputText to outputLines as string
  set AppleScript's text item delimiters to ""
  return outputText
end tell
`.trim();

/**
 * Parse the tab-delimited output of `CONTACTS_DUMP_SCRIPT` into a
 * ContactsMap. Exported so tests can exercise it with fixture strings
 * without needing a live Contacts.app.
 *
 * Input format per line: `kind\thandle\tname`.
 * Empty lines are skipped. Lines with fewer than 3 fields are skipped.
 * Empty handles are skipped. Duplicate handles keep the first entry
 * (AppleScript's iteration order is generally stable).
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

/**
 * Run the contacts dump AppleScript and return a ContactsMap. Returns
 * an empty map (with a warning log) on any failure — most commonly, the
 * user hasn't authorized Contacts access yet, in which case macOS
 * surfaces a one-time system prompt and this call returns empty until
 * the user accepts on a subsequent run.
 */
export async function loadContacts(): Promise<ContactsMap> {
  try {
    const stdout = await runContactsScript(CONTACTS_DUMP_SCRIPT);
    const map = parseContactsOutput(stdout);
    logger.info(`[imessage] Contacts loaded: ${map.size} handle(s) resolved from Contacts.app`);
    return map;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (/not authorized|1743/.test(reason)) {
      logger.warn(
        "[imessage] Contacts access not yet authorized. macOS will prompt " +
          "the user on the next run. Inbound messages will use raw handles " +
          "(phone numbers / emails) until Contacts access is granted."
      );
    } else {
      logger.warn(
        `[imessage] Failed to load Contacts.app data: ${reason}. ` +
          "Inbound messages will use raw handles instead of names."
      );
    }
    return new Map();
  }
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
// Everything below uses the same Contacts.app AppleScript surface as
// loadContacts — no new dependencies, no private Cocoa APIs, no extra
// TCC permissions beyond what's already required. On first write macOS
// will prompt for Contacts WRITE access (distinct from read), and
// subsequent writes use that grant.

/**
 * A full contact record, richer than ContactsMap's handle-keyed entries.
 * Returned by `listAllContacts` and the single-contact CRUD helpers.
 * Each phone/email carries its Contacts.app label when available
 * (`home`, `work`, `mobile`, etc.) so the UI can surface context.
 */
export interface FullContact {
  /** Contacts.app stable person id (UUID-ish). Used for update/delete. */
  id: string;
  /** Display name as stored in Contacts.app (composed by the app). */
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

/**
 * Escape a JavaScript string so it can be embedded inside an
 * AppleScript double-quoted string literal. Handles backslashes and
 * quotes — AppleScript doesn't treat newlines specially inside quoted
 * strings, so those pass through as-is.
 */
function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Whether we've already confirmed Contacts.app is running in this
 * process lifetime. Avoids paying the `open -a` cost on every call.
 */
let contactsLaunched = false;

function getContactsScriptTimeoutMs(): number {
  const raw = Number(process.env.IMESSAGE_CONTACTS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONTACTS_SCRIPT_TIMEOUT_MS;
}

/**
 * Ensure Contacts.app is actually in the running process list before
 * handing an AppleScript to it. Annoyingly, the `launch` verb inside
 * `tell application "Contacts"` is a no-op on modern macOS when the
 * app isn't already running — it doesn't actually start the process,
 * and the subsequent scripting call returns `Application isn't running
 * (-600)`. The reliable fix is to use the shell-level `open` which
 * goes through LaunchServices and spawns the app.
 *
 * `-g` launches in the background so Contacts doesn't steal focus from
 * whatever window the user was just looking at (a plain `open -a`
 * raises the app to the foreground, which interrupts the UI mid-boot).
 * `-j` hides the app entirely on first launch so the user never sees a
 * Contacts window flash across the screen — the AppleScript bridge
 * still works against a hidden instance.
 *
 * Idempotent: after the first successful launch we set a flag and
 * subsequent calls are no-ops. If Contacts.app is force-quit mid-run
 * the next osascript will still throw -600 and the caller's error
 * path will log it; at that point restarting the plugin recovers.
 */
async function ensureContactsLaunched(): Promise<void> {
  if (contactsLaunched) return;
  try {
    await execFileAsync("open", ["-g", "-j", "-a", "Contacts"]);
    // Give LaunchServices a beat to register the process so the next
    // scripting-bridge call finds it. 400ms is empirical: 100ms was
    // flaky, 250ms worked most of the time, 400ms has been reliable.
    await new Promise<void>((r) => setTimeout(r, 400));
    contactsLaunched = true;
  } catch {
    // If `open` fails (unlikely — it's a LaunchServices primitive
    // that almost never fails on a healthy Mac), we still try the
    // osascript below. The error from there will be more informative.
  }
}

/**
 * Run an AppleScript against Contacts.app and return its stdout. Shared
 * helper used by every read/write in this file. On failure — which
 * includes both TCC denials and actual script errors — throws an Error
 * with the stderr/message for the caller to classify.
 */
async function runContactsScript(script: string): Promise<string> {
  await ensureContactsLaunched();
  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: getContactsScriptTimeoutMs(),
    killSignal: "SIGTERM",
  });
  return stdout;
}

/**
 * Parse the tab-delimited output of the full-contacts dump. One row per
 * contact with pipe-separated phone and email lists so the script can
 * return everything in a single round-trip.
 *
 * Row format (tab-delimited):
 *   `<id>\t<name>\t<firstName>\t<lastName>\t<phones>\t<emails>`
 * where <phones> is `label1=value1|label2=value2` and same for emails.
 * Empty fields are empty strings, not missing.
 */
function parseFullContactsOutput(raw: string): FullContact[] {
  const out: FullContact[] = [];
  if (!raw?.trim()) return out;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split("\t");
    if (fields.length < 6) continue;
    const [id, name, firstName, lastName, phonesField, emailsField] = fields;
    if (!id) continue;
    const parsePairs = (input: string): Array<{ label: string | null; value: string }> => {
      if (!input) return [];
      return input
        .split("|")
        .filter(Boolean)
        .map((pair) => {
          const eqIdx = pair.indexOf("=");
          if (eqIdx === -1) return { label: null, value: pair };
          return {
            label: pair.slice(0, eqIdx) || null,
            value: pair.slice(eqIdx + 1),
          };
        });
    };
    out.push({
      id,
      name: name || "",
      firstName: firstName || null,
      lastName: lastName || null,
      phones: parsePairs(phonesField),
      emails: parsePairs(emailsField),
    });
  }
  return out;
}

/**
 * AppleScript that dumps every contact as a tab-delimited row with
 * pipe-separated phone and email lists. Matches `parseFullContactsOutput`
 * above. Runs in a single round-trip against Contacts.app.
 */
const FULL_CONTACTS_DUMP_SCRIPT = `
tell application "Contacts"
  launch
  set AppleScript's text item delimiters to tab
  set outputLines to {}
  repeat with p in people
    set personId to id of p
    set personName to name of p
    if personName is missing value then set personName to ""
    set personFirst to first name of p
    if personFirst is missing value then set personFirst to ""
    set personLast to last name of p
    if personLast is missing value then set personLast to ""

    set phoneList to ""
    repeat with ph in phones of p
      set phoneValue to value of ph
      if phoneValue is not missing value then
        set phoneLabel to label of ph
        if phoneLabel is missing value then set phoneLabel to ""
        if phoneList is not "" then set phoneList to phoneList & "|"
        set phoneList to phoneList & phoneLabel & "=" & phoneValue
      end if
    end repeat

    set emailList to ""
    repeat with em in emails of p
      set emailValue to value of em
      if emailValue is not missing value then
        set emailLabel to label of em
        if emailLabel is missing value then set emailLabel to ""
        if emailList is not "" then set emailList to emailList & "|"
        set emailList to emailList & emailLabel & "=" & emailValue
      end if
    end repeat

    set end of outputLines to personId & tab & personName & tab & personFirst & tab & personLast & tab & phoneList & tab & emailList
  end repeat
  set AppleScript's text item delimiters to linefeed
  set outputText to outputLines as string
  set AppleScript's text item delimiters to ""
  return outputText
end tell
`.trim();

/**
 * List every contact in the user's address book as a full `FullContact`
 * record. Returns an empty array on any failure (permission denied,
 * script error, etc.) with a warning log.
 */
export async function listAllContacts(): Promise<FullContact[]> {
  try {
    const stdout = await runContactsScript(FULL_CONTACTS_DUMP_SCRIPT);
    return parseFullContactsOutput(stdout);
  } catch (error) {
    logger.warn(
      `[imessage] listAllContacts failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

/**
 * Create a new contact in Contacts.app. Returns the new person's id on
 * success, or null on failure (permission denied, validation, etc.).
 *
 * Requires Contacts WRITE permission, which macOS prompts for on the
 * first write call. Read-only sessions never trigger this prompt.
 */
export async function addContact(input: NewContactInput): Promise<string | null> {
  const first = escapeAppleScriptString(input.firstName ?? "");
  const last = escapeAppleScriptString(input.lastName ?? "");

  // Build phone + email blocks as separate `make new phone/email` verbs
  // nested inside a `tell newPerson` block. This lets us set the label
  // on each one, which the simpler `{phones: {...}}` property syntax
  // doesn't support.
  const phoneLines = (input.phones ?? [])
    .filter((p) => p.value)
    .map((p) => {
      const value = escapeAppleScriptString(p.value);
      const label = escapeAppleScriptString(p.label ?? "mobile");
      return `make new phone at end of phones with properties {value:"${value}", label:"${label}"}`;
    })
    .join("\n    ");

  const emailLines = (input.emails ?? [])
    .filter((e) => e.value)
    .map((e) => {
      const value = escapeAppleScriptString(e.value);
      const label = escapeAppleScriptString(e.label ?? "home");
      return `make new email at end of emails with properties {value:"${value}", label:"${label}"}`;
    })
    .join("\n    ");

  const script = `
tell application "Contacts"
  launch
  set newPerson to make new person with properties {first name:"${first}", last name:"${last}"}
  tell newPerson
    ${phoneLines}
    ${emailLines}
  end tell
  save
  return id of newPerson
end tell
  `.trim();

  try {
    const stdout = await runContactsScript(script);
    const id = stdout.trim();
    if (!id) return null;
    logger.info(`[imessage] Contact created: ${id}`);
    return id;
  } catch (error) {
    logger.warn(
      `[imessage] addContact failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
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
  const id = escapeAppleScriptString(personId);
  const fragments: string[] = [];

  if (patch.firstName !== undefined) {
    fragments.push(`set first name of thePerson to "${escapeAppleScriptString(patch.firstName)}"`);
  }
  if (patch.lastName !== undefined) {
    fragments.push(`set last name of thePerson to "${escapeAppleScriptString(patch.lastName)}"`);
  }

  for (const phone of patch.addPhones ?? []) {
    if (!phone.value) continue;
    fragments.push(
      `tell thePerson to make new phone at end of phones with properties {value:"${escapeAppleScriptString(phone.value)}", label:"${escapeAppleScriptString(phone.label ?? "mobile")}"}`
    );
  }
  for (const phoneValue of patch.removePhones ?? []) {
    if (!phoneValue) continue;
    fragments.push(`
    tell thePerson
      repeat with ph in phones
        if (value of ph) is "${escapeAppleScriptString(phoneValue)}" then
          delete ph
          exit repeat
        end if
      end repeat
    end tell`);
  }

  for (const email of patch.addEmails ?? []) {
    if (!email.value) continue;
    fragments.push(
      `tell thePerson to make new email at end of emails with properties {value:"${escapeAppleScriptString(email.value)}", label:"${escapeAppleScriptString(email.label ?? "home")}"}`
    );
  }
  for (const emailValue of patch.removeEmails ?? []) {
    if (!emailValue) continue;
    fragments.push(`
    tell thePerson
      repeat with em in emails
        if (value of em) is "${escapeAppleScriptString(emailValue)}" then
          delete em
          exit repeat
        end if
      end repeat
    end tell`);
  }

  if (fragments.length === 0) {
    // Nothing to do — treat as a successful no-op.
    return true;
  }

  const script = `
tell application "Contacts"
  launch
  set thePerson to person id "${id}"
  ${fragments.join("\n  ")}
  save
  return "ok"
end tell
  `.trim();

  try {
    await runContactsScript(script);
    logger.info(`[imessage] Contact updated: ${personId}`);
    return true;
  } catch (error) {
    logger.warn(
      `[imessage] updateContact failed for ${personId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Delete a contact by Contacts.app id. Requires write permission.
 * Returns false on any failure (not found, permission denied, etc.).
 */
export async function deleteContact(personId: string): Promise<boolean> {
  const id = escapeAppleScriptString(personId);
  const script = `
tell application "Contacts"
  launch
  delete (person id "${id}")
  save
  return "ok"
end tell
  `.trim();

  try {
    await runContactsScript(script);
    logger.info(`[imessage] Contact deleted: ${personId}`);
    return true;
  } catch (error) {
    logger.warn(
      `[imessage] deleteContact failed for ${personId}: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
