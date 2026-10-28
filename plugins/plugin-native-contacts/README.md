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
truncating it. Reads take a CancellationSignal and time out after five seconds.
`reviewed(id, lookup, revision)` rechecks a selected contact before the host
hands an edit to the system Contacts editor. Hosts gate it behind their own
image admission and foreground checks.

`ai.eliza.plugins.contacts.AddressBookPlugin` is the address book of the AOSP
telephony profile built on the catalog. A host subclasses it under its own
plugin name (declaring the `contacts` permission alias) and answers
`admitted()` from its native image admission. It offers `status`,
`requestPermissions`, `list({ query, limit })`, `create()` and
`edit({ id, lookup, revision })`. Reads run only while the phone is unlocked
with the host in front and are cancelled on pause, resume, screen-off and
permission change. Creation and edits open a system app's exported Contacts
editor, which owns the account choice and the save; nothing is written from the
plugin and `edit` rechecks the contact's lookup key and revision first.
