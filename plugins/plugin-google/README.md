# Google Plugin

Workspace Google integration for ElizaOS.

This plugin is the home for Gmail, Google Calendar, Google Drive, and Google Meet capability
services under one selected-scope OAuth grant. It intentionally does not include Google Chat;
`@elizaos/plugin-google-chat` remains the bot connector for Google Chat spaces.

The implementation is account-scoped: every capability method starts with `accountId`, and OAuth
scopes are derived from selected capabilities instead of requesting all Google Workspace scopes.
Credential persistence is intentionally out of scope. The default
`DefaultGoogleCredentialResolver` reads from the shared connector account manager/storage and
credential vault services when the host provides them; consumers can still inject a
`GoogleCredentialResolver` for tests or custom hosts.

Current capability modules:

- Gmail: search, get, and send messages.
- Calendar: list and create events, including optional Meet links.
- Drive: search and read file metadata.
- Meet: create spaces, read spaces/conference records/participants/transcripts/recordings, end an
  active conference, and generate a structured report from Meet artifacts.
