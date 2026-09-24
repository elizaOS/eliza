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
