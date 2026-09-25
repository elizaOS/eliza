# @elizaos/plugin-native-contacts

Android address-book overlay app for elizaOS: provides a full-screen UI surface for
browsing, searching, creating, and importing contacts, plus a read-only dynamic provider
that injects address-book context into the agent planner.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-contacts build  # build
bun run --cwd plugins/plugin-native-contacts test   # tests
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
