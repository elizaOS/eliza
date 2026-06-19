# @elizaos/plugin-google

Google Workspace integration for [elizaOS](https://github.com/elizaOS/eliza) agents — Gmail, Google Calendar, Google Drive, and Google Meet, all under a single per-account OAuth grant.

## What it does

This plugin adds `GoogleWorkspaceService` to an Eliza agent runtime. The service exposes typed methods for reading and writing to Gmail, Calendar, Drive (including Docs and Sheets), and Meet. Authentication is account-scoped: every method call includes an `accountId` that maps to a stored OAuth token, so one agent can operate across multiple Google accounts simultaneously.

The plugin also registers with the elizaOS `ConnectorAccountManager` so the built-in connector HTTP routes can manage Google accounts (list, create, delete) and run the OAuth flow (PKCE, offline access, incremental consent) without extra integration work.

> **Not included:** Google Chat. Use `@elizaos/plugin-google-chat` for bot connectors to Google Chat spaces.

## Capabilities

### Gmail

- Search messages by query string
- Fetch message metadata and full body
- Triage inbox (unread, importance score, reply-needed detection)
- List unresponded threads
- Send new messages and replies
- Bulk modify labels/state (archive, trash, mark read/unread, apply/remove labels)
- Create sender filters
- Send mailto unsubscribe emails

### Google Calendar

- List calendars
- List, get, create, update, and delete events
- Create events with Google Meet links attached

### Google Drive, Docs, and Sheets

- Search and list files and folders
- Get file metadata
- Read Google Docs as plain text
- Read Google Sheets as a 2D array of rows
- Create Drive files (with optional content and parent folder)
- Append text to a Google Doc
- Write cell values to a Sheet range

### Google Meet

- Create meeting spaces
- Get space details and active conference records
- List participants, transcripts, and recordings
- Fetch full transcript entries
- End an active conference
- Generate a structured meeting report (summary, key points, action items, full transcript)

## Requirements

- Node.js (this plugin uses Node-only APIs; not supported in browser or edge environments)
- A Google Cloud project with the OAuth 2.0 credentials and relevant APIs enabled

### Google Cloud APIs to enable

- Gmail API
- Google Calendar API
- Google Drive API
- Google Meet API (REST)
- Google Docs API
- Google Sheets API

## Configuration

Set these environment variables (or provide them via agent `pluginParameters`):

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | No (required for OAuth) | OAuth 2.0 client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | No (required for OAuth) | OAuth 2.0 client secret (keep private) |
| `GOOGLE_REDIRECT_URI` | No (required for OAuth) | Redirect URI registered in Google Cloud Console |

Without all three the OAuth flow throws an error; the service itself still starts (read-only agents that inject pre-issued tokens can skip OAuth).

## Enabling the plugin

Add the plugin to your elizaOS agent configuration:

```ts
import { googlePlugin } from "@elizaos/plugin-google";

const agent = {
  plugins: [googlePlugin],
  // ...
};
```

## OAuth scopes

Scopes are derived from the set of capabilities requested at OAuth time, not from a hardcoded list. Requesting only `gmail.read` will ask for `gmail.readonly` only, not all Google Workspace scopes. All grants request `openid`, `userinfo.email`, and `userinfo.profile` as identity scopes.

Available capabilities: `gmail.read`, `gmail.send`, `gmail.manage`, `calendar.read`, `calendar.write`, `drive.read`, `drive.write`, `meet.create`, `meet.read`.

## Using the service

```ts
import type { IGoogleWorkspaceService } from "@elizaos/plugin-google";

const google = runtime.getService("google") as IGoogleWorkspaceService;

// List upcoming calendar events
const events = await google.listEvents({
  accountId: "my-google-account-id",
  timeMin: new Date().toISOString(),
  limit: 10,
});

// Send an email
const result = await google.sendGmailMessage({
  accountId: "my-google-account-id",
  to: ["recipient@example.com"],
  subject: "Hello",
  bodyText: "Message body.",
});
```

## Custom credential resolver

For testing or non-standard hosting, inject a `GoogleCredentialResolver`:

```ts
import { GoogleWorkspaceService } from "@elizaos/plugin-google";

const service = new GoogleWorkspaceService(runtime, {
  credentialResolver: myCustomResolver,
});
```
