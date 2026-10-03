# @elizaos/plugin-native-contacts

Android address-book overlay app for elizaOS: provides a full-screen UI surface for browsing, searching, creating, and importing contacts, plus a read-only dynamic provider that injects address-book context into the agent planner.

Build, test, and setup: [README.md](README.md).

Explicit limits must be positive safe integers; omitted reads are complete.
Malformed limits reject with INVALID_LIMIT. Missing provider cursors reject with
CONTACTS_UNAVAILABLE; valid empty cursors remain empty arrays. The isolated
ContactsBridgeInstrumentedTest exercises create/read/search and numeric limits
against actual ContactsProvider; null/empty child-query failures inject only the
provider response into the production reader. Cleanup owns exact synthetic raw
contact IDs. Inspect terminal instrumentation results, not just shell exit status.
