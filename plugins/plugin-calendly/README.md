# @elizaos/plugin-calendly

elizaOS plugin for Calendly v2 integration. Adds scheduling capabilities to an Eliza agent: listing event types, handing off booking links, and canceling scheduled events.

## Capabilities

- **List event types** — surfaces the connected Calendly user's active event types (name, slug, duration, scheduling URL) as agent context in supported routing contexts.
- **Book** — hands off a third-party Calendly URL found in a message, or resolves the agent owner's own booking link (optionally filtered by slug or duration in minutes).
- **Cancel** — cancels a scheduled event by UUID or URI, with a confirmation step before the API call is made.

## Requirements

- elizaOS agent runtime (`@elizaos/core`)
- A Calendly account with a personal access token, or an OAuth app for the OAuth flow

## Configuration

### Personal access token (simplest)

```env
CALENDLY_ACCESS_TOKEN=your_personal_access_token
```

### Multiple accounts

Set `CALENDLY_ACCOUNTS` to a JSON array:

```env
CALENDLY_ACCOUNTS='[{"accountId":"work","accessToken":"tok_1"},{"accountId":"personal","accessToken":"tok_2"}]'
```

### OAuth (optional)

```env
CALENDLY_OAUTH_CLIENT_ID=your_client_id
CALENDLY_OAUTH_CLIENT_SECRET=your_client_secret
CALENDLY_OAUTH_REDIRECT_URI=https://your-app.example.com/oauth/calendly/callback
```

### Optional tuning

| Var | Purpose |
|-----|---------|
| `CALENDLY_ACCOUNT_ID` | Explicit account ID when using single-token mode |
| `CALENDLY_DEFAULT_ACCOUNT_ID` | Default account ID when multiple accounts are configured |
| `CALENDLY_USER_URI` | Skip the `/users/me` lookup by providing the URI directly |
| `CALENDLY_ORGANIZATION_URI` | Override organization URI |

## Auto-enable

The plugin auto-enables when `CALENDLY_ACCESS_TOKEN`, `CALENDLY_ACCOUNTS`, or `ELIZA_E2E_CALENDLY_ACCESS_TOKEN` is set in the environment.

## Plugin registration

```typescript
import calendlyPlugin from "@elizaos/plugin-calendly";

// Add to your AgentRuntime plugins array
const runtime = new AgentRuntime({
  plugins: [calendlyPlugin],
  // ...
});
```

## Exported action

`calendlyOpAction` (`CALENDLY`) is exported but not included in the plugin's default `actions` array. To enable it, register it explicitly in your agent configuration:

```typescript
import { calendlyPlugin, calendlyOpAction } from "@elizaos/plugin-calendly";

const myPlugin = {
  ...calendlyPlugin,
  actions: [calendlyOpAction],
};
```

### Action parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `op` | `"book" \| "cancel"` | Yes | Operation to perform |
| `slug` | string | No | Event-type slug for own-event booking |
| `durationMinutes` | number | No | Desired duration (minutes) for own-event booking |
| `eventUuid` | string | No | Scheduled event UUID for cancellation |
| `reason` | string | No | Cancellation reason |
| `accountId` | string | No | Calendly account ID (multi-account setups) |

**Note:** Cancellation requires user confirmation. The action returns `requiresConfirmation: true` on first invocation and waits for the user to confirm before making the API call. The `CALENDLY` action requires `minRole: "ADMIN"`.

## Routing context

| Surface | Context tags |
|---------|-------------|
| `calendlyEventTypesProvider` | `connectors`, `productivity` |
| `CALENDLY` action | `calendar`, `automation`, `connectors` |

The provider and action are only active when a conversation is routed into one of the listed contexts.

## Public API

In addition to the plugin object, the package exports the raw Calendly client functions and types for direct use:

```typescript
import {
  CalendlyService,
  calendlyEventTypesProvider,
  calendlyOpAction,
  listCalendlyEventTypes,
  listCalendlyScheduledEvents,
  getCalendlyAvailability,
  cancelCalendlyScheduledEvent,
  createCalendlySingleUseLink,
  getCalendlyUser,
  readCalendlyCredentialsFromEnv,
  CalendlyError,
  // types
  type CalendlyCredentials,
  type CalendlyEventTypeNormalized,
  type CalendlyScheduledEventNormalized,
  type CalendlyAvailabilityNormalized,
  type CalendlySingleUseLink,
} from "@elizaos/plugin-calendly";
```

## Development

```bash
bun run --cwd plugins/plugin-calendly build      # build
bun run --cwd plugins/plugin-calendly test       # run tests
bun run --cwd plugins/plugin-calendly typecheck  # type check
```
