# DoorDash adapter review

Reviewed on 2026-08-21 at these immutable commits:

- [`markswendsen-code/mcp-doordash@9a6fe591`](https://github.com/markswendsen-code/mcp-doordash/tree/9a6fe591360a6f425c53c8bddd85bc43ecfeb7e1)
- [`SpunkySarb/doordash-mcp@27671657`](https://github.com/SpunkySarb/doordash-mcp/tree/276716573b923a5b4a6eee0e2a415ed945e7b69d)

## Decision

elizaOS uses neither repository as an embedded dependency. The first-party
plugin is a narrow facade over `@elizaos/plugin-mcp`, and Cloud forwards to an
operator-controlled streamable-HTTP adapter. This keeps one stable agent action
while allowing the browser implementation to be replaced when DoorDash changes.

DoorDash's documented APIs are merchant-facing: Marketplace APIs integrate a
merchant's menus and orders, while Drive APIs request delivery fulfillment and
have restricted production access. Neither documented surface is a general
consumer restaurant-search, cart, and checkout API. See DoorDash's
[Marketplace overview](https://developer.doordash.com/en-US/docs/marketplace/overview/about_marketplace/)
and [Drive getting-started guide](https://developer.doordash.com/en-US/docs/drive/tutorials/get_started/).
Both reviewed projects therefore automate the consumer website and remain
subject to website changes and DoorDash policy.

## Comparison

| Area | `markswendsen-code/mcp-doordash` | `SpunkySarb/doordash-mcp` |
| --- | --- | --- |
| Transport | MCP stdio | MCP stdio |
| Browser approach | Patchright page automation and DOM selectors | Playwright persistent profile plus reverse-engineered in-page GraphQL calls |
| Read operations | Auth status, restaurant search, menus, cart, tracking | Auth status, restaurant search, menus, carts, order history |
| Mutations | Address, add-to-cart, clear session, checkout | Add/remove cart items |
| Checkout | Supports preview and placement | No checkout tool |
| Session storage | Writes DoorDash cookies as JSON under the user's config directory | Stores a complete Chromium profile in the repository-local `browser-data` directory |
| Cloud isolation | Single local process/session; no tenant boundary | Single local process/profile; no tenant boundary |
| Operational concerns | Launches Chromium with sandbox and web-security disabling flags; may return a timestamp-generated order ID when it cannot read a real receipt | Uses internal GraphQL operations that may change without notice; force-kills matching stale Chromium processes |
| License evidence | `package.json` declares MIT, but the reviewed tree has no license file | `package.json` declares MIT, but the reviewed tree has no license file |

## Integration consequences

- Local users may run either adapter after reviewing and accepting its browser
  behavior. The facade normalizes both tool vocabularies.
- Cloud must use a separately deployed adapter that authenticates each request,
  isolates and encrypts each user's browser state, supports revocation, and
  never returns cookies to the agent.
- Raw DoorDash MCP tools are not registered as agent actions in Cloud. This
  prevents a model from bypassing the first-party checkout gate.
- `place_order` always refreshes the cart and non-purchasing preview, binds the
  exact state to the user's next-turn confirmation, and rejects missing or
  timestamp-generated order identifiers.
- A production upstream must additionally provide atomic checkout idempotency;
  the facade cannot manufacture that guarantee around a browser click.

## Acceptance still required for a Cloud upstream

Before enabling a production upstream, verify all of the following against the
deployed service and a dedicated test account:

1. Two users in the same organization cannot list, read, invoke, or delete each
   other's DoorDash session.
2. Session material is encrypted at rest, redacted from logs and MCP results,
   and removed by the clear-session operation.
3. Search, menu, cart, and checkout preview work through the public Cloud MCP
   URL with the caller's real Cloud credential.
4. Replayed and concurrent confirmed-checkout requests produce at most one
   DoorDash order and return the same authoritative receipt.
5. A changed cart or total invalidates the prior confirmation.
6. Invalid, expired, cross-tenant, and unauthenticated requests fail closed.
7. The operator reviews the resulting DoorDash order in the provider UI and
   cleans up the test account/session after the run.
