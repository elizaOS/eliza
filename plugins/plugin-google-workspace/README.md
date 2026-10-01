# @elizaos/plugin-google-workspace

Google Workspace integration for Gmail, Calendar, Drive, Meet, and People (Contacts)
with account-scoped OAuth, plus the Google Chat messaging connector (service-account
auth) and Google-owned assistant message projections.

Node-only integration. Enable the relevant Google APIs and configure `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` for OAuth. Pre-issued account tokens
can be injected without starting OAuth. Keep account scopes and token isolation intact;
Google Chat uses its separate service-account transport.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-google-workspace build  # build
bun run --cwd plugins/plugin-google-workspace test   # tests
```

`GoogleTaskCodeResolver` is a host-only adapter over the account-scoped Gmail
service. A reviewed provider parser must bind a message to the actual challenge;
there is no generic newest-code fallback. Bounded incomplete searches and multiple
matching codes return no handle. Successful lookup returns only an opaque,
short-lived reference, consumed once by a trusted fill adapter after a fresh
authorization check. Hosts must revoke on account/task teardown and keep raw
messages, parser results and consumed values out of model context and logs.
The resolver stores handles in memory and registers no model action or HTTP route.
It does not implement provider parsers, OAuth setup or native OTP-fill policy;
those integrations and live acceptance remain host responsibilities.

Message detail includes attachment descriptors. Host callers can use
`getGmailAttachment({accountId, messageId, partId, maxBytes})` to read an inline or
separate Gmail attachment. The reader verifies the part belongs to that message,
re-resolves account credentials before a separate content fetch and again before
releasing bytes after the final response, enforces a
caller limit up to 25 MiB, and returns complete bytes with their SHA-256 hash.
Filenames are untrusted metadata, never output paths. Hosts still own task
reauthorization, content-type policy and document extraction; this method does
not register a model action, parse documents or persist attachment contents.
