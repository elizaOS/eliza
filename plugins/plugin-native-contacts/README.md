# @elizaos/plugin-native-contacts

Android address-book overlay app for elizaOS: provides a full-screen UI surface for
browsing, searching, creating, and importing contacts, plus a read-only dynamic provider
that injects address-book context into the agent planner.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-contacts build  # build
```

Native view and app-shell declarations share an ADMIN-gated capability catalog. Agents use named complete-or-error reads; mutations and generic renderer/DOM operations require human interaction. A bridge result at its non-paginated boundary is an explicit incomplete-read error. Device-status failures remain errors rather than fabricated empty state.

Explicit limits must be positive safe integers; omitted reads are complete.
Malformed limits reject with INVALID_LIMIT. Missing provider cursors reject with
CONTACTS_UNAVAILABLE; valid empty cursors remain empty arrays. The isolated
ContactsBridgeInstrumentedTest exercises create/read/search and numeric limits
against actual ContactsProvider; null/empty child-query failures inject only the
provider response into the production reader. Cleanup owns exact synthetic raw
contact IDs. Inspect terminal instrumentation results, not just shell exit status.

The Android WebView contract also verifies multi-card vCard import, folded Unicode
names, escaped backslashes and name separators, all phone/email values, and native
provider readback. Cleanup removes only the run’s synthetic raw-contact IDs and
exports a zero-remaining receipt.

The runner first revokes contacts access on its isolated test APK. A real WebView
requests access through Android's dialog, denies it, verifies read/create/import
rejections, then grants access and verifies recovery without denied writes leaving
contacts behind. Permission results and native grant states are exported separately
from the subsequent granted-access suite.

Permission preflight artifacts include Android grant flags before and after the
request. Missing-dialog failures preserve the actual WebView reply and window
hierarchy; tests remain failures and are not retried automatically.

## Bounded catalog for AOSP image hosts

`ai.eliza.plugins.contacts.ContactsCatalog` reads same-profile contacts in
bounded pages (at most 200 contacts and 1 MiB, 32 numbers or emails per
contact, 1024 characters per field) and refuses a larger record instead of
truncating it. A page with more contacts after it returns `more: true` and an
opaque `next` cursor; pass it back as `cursor` with the same query for the next
page. A cursor whose page boundary has changed is refused (`StaleCursor`), so a
host never skips or repeats a contact. Reads take a CancellationSignal and time
out after five seconds.
`reviewed(id, lookup, revision)` rechecks a selected contact before the host
hands an edit to the system Contacts editor. Hosts gate it behind their own
image admission and foreground checks.

`ai.eliza.plugins.contacts.AddressBookPlugin` is the address book of the AOSP
telephony profile built on the catalog. A host subclasses it under its own
plugin name (declaring the `contacts` permission alias) and answers
`admitted()` from its native image admission. It offers `status`,
`requestPermissions`, `list({ query, limit, cursor })`, `create()` and
`edit({ id, lookup, revision })`. Reads run only while the phone is unlocked
with the host in front and are cancelled on pause, resume, screen-off and
permission change. `create` and `edit` open a system app's exported Contacts
editor, which owns the account choice and the save; `edit` rechecks the
contact's lookup key and revision first.

A host whose manifest keeps `WRITE_CONTACTS` (and whose `contacts` alias asks
for it) can also save from its own screen through `ContactsEditor`:
`get({ id })` returns the display and structured names, owner notes, typed phone
numbers and emails and an opaque `version`;
`save({ id?, version?, displayName, phoneNumbers, emailAddresses, givenName?, familyName?, notes? })`
creates a contact in the device-local account or changes only the rows that
differ; `remove({ id, version })` deletes it. A write names the version that
was read and asserts it again inside the provider's transaction, so a contact
that changed is answered `stale` and nothing is written. A contact with more
than 32 numbers or emails is refused as `incomplete`, never clipped. Without
the permission these methods reject with `permission-required`.
`status().writable` reports it. `android/src/test` holds the JVM tests.
The renderer contract is `@elizaos/contracts/native-address-book`.

Structured `givenName` and `familyName` values come from the provider, not from
splitting its display label. An omitted component stays unchanged; an explicit
empty string clears only that component. When either component is supplied,
Android formats the display label from the retained name components. Otherwise,
`displayName` is the legacy full-name edit. A new contact that supplies a
structured component stores only those components, so
`contactDraftProblem(draft, { create: true })` judges its name from them, as
Android does. Name changes update the selected name row in place and retain
other raw names, middle names, prefixes, suffixes, phonetic/style columns,
photos and other MIME rows. On a linked contact the edited name row becomes
super-primary, so Android shows the new name instead of another raw contact's
older name.

Owner notes are edit-screen data, never added to the catalog or automatic agent
context. `notes` omission preserves the provider rows; an empty string clears
only the selected note value. Notes keep whitespace and allow CR, LF and tabs,
with `CONTACT_MAX_NOTES` / `ContactsEditor.MAX_NOTES` set to 8192 UTF-16 code units.
A scalar editor cannot represent several note rows (linked raw contacts can
each carry one), a stored note longer than 8192 code units, or a note with
other control characters. `get` then omits `notes` and keeps the rest of the contact editable; a save that omits
notes does not touch those rows, and a save that supplies notes is answered
`failed` with nothing written. Use the system editor for those notes. Multiple
name rows on the selected name raw contact are refused as `incomplete`.
Provider versions and the atomic stale-write checks are unchanged.
