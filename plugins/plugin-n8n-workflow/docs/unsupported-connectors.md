# Connectors Without n8n Automation Support

These connectors exist in Milady but cannot be wired to n8n workflows because no n8n node covers their transport layer.

---

## iMessage (plugin-imessage)

**Why:** iMessage is a closed macOS system service. The connector reads from the local Messages SQLite database (`~/Library/Messages/chat.db`). There is no public API or REST interface n8n can reach.

**Workaround:** Use Apple Shortcuts (macOS 13+) with n8n's Webhook node to bridge. Create a Shortcut triggered on new message → HTTP POST to your n8n webhook URL. Outbound sending via AppleScript or `osascript` called from n8n's Execute Command node (requires local n8n).

---

## Nostr (plugin-nostr)

**Why:** No standardized n8n community node exists for Nostr. The Nostr protocol uses WebSocket relay connections with NIP-01 signed events — not a REST API n8n's HTTP Request node handles cleanly out of the box.

**Workaround:** Use n8n's HTTP Request node with a WebSocket-capable relay proxy, or write a lightweight bridge that exposes a REST endpoint (POST to publish, GET to poll) and wire that as an HTTP Request node. A dedicated n8n community node for Nostr would be the clean path.

---

## Tlon / Urbit (plugin-tlon)

**Why:** Tlon uses the Urbit Eyre HTTP interface and requires Urbit-specific authentication (`~ship/code`). No n8n node exists for Urbit/Tlon.

**Workaround:** Urbit's Eyre server exposes a REST-like scry/poke interface. Use n8n's HTTP Request node pointed at `http://<urbit-ship>:<port>` with the session cookie obtained via `POST /~/login`. Manual setup; no credential provider automation is possible.

---

## Summary Table

| Connector | n8n Node | Reason | Workaround |
|-----------|----------|--------|------------|
| iMessage | None | macOS local-only, closed system | Apple Shortcuts → Webhook |
| Nostr | None | WebSocket relay, no REST | Bridge service or community node |
| Tlon/Urbit | None | Urbit-specific auth, niche platform | HTTP Request + manual session cookie |
