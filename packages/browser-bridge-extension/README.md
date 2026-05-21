# `@elizaos/browser-bridge-extension`

The browser bridge extension pairs a user's personal browser profile with an
Eliza agent so the agent can read the current page and run owner-approved
browser actions.

## Security model

### Host allowlist (SOC2 L-4)

The extension ships with a **scoped host allowlist** rather than the legacy
`<all_urls>` grant. The default-install hosts are:

- `https://eliza.how/*` and subdomains
- `https://eliza.dev/*` and subdomains

These are the only origins where the content script and wallet shim auto-
inject. The allowlist is declared once in
[`scripts/build.mjs`](./scripts/build.mjs) as `BROWSER_BRIDGE_HOST_ALLOWLIST`
and is mirrored into both `host_permissions` and the `content_scripts`
matches block at build time.

### Optional hosts

If a user wants the agent to read or act on an additional site, the extension
requests permission at runtime via `chrome.permissions.request` against
`optional_host_permissions`. The renderer surfaces an in-product approval
prompt before requesting; users see and confirm the exact origin before any
script is injected.

### Content Security Policy

`script-src 'self'; object-src 'self'` is enforced on extension pages. Inline
scripts are forbidden; only first-party bundle code may execute. No
`unsafe-eval` and no `wasm-unsafe-eval`.

### Threat model boundaries

- Out of scope: keylogging, password harvesting, generic content
  extraction beyond allowlisted hosts.
- In scope: agent-driven `click`, `type`, `submit`, `history_back`,
  `history_forward` actions on allowlisted pages; wallet-shim isolation
  for crypto requests (separate content script, `document_start` timing).
