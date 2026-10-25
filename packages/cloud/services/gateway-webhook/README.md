# @elizaos/gateway-webhook

Stateless multi-platform webhook gateway for Eliza Cloud.

Install workspace dependencies with `bun install` at the repository root.

Build from the repository root:

```bash
bun run --cwd packages/cloud/services/gateway-webhook build
```

Test from the repository root:

```bash
bun run --cwd packages/cloud/services/gateway-webhook test
```

## Network on the existing Shared phone route

Shared takeover is off by default. Configure these inputs through the normal
release process after the matching Cloud admission and delivery chain passes:

- `NETWORK_TAKEOVER=1` enables service routing.
- `NETWORK_SHARED_PROJECT` must equal the existing
  `ELIZA_APP_WEBHOOK_PROJECT` (default `eliza-app`). Keep that ingress project,
  its connector account and the existing message-ID namespace.
- `NETWORK_TAKEOVER_ALLOWLIST` must contain a nonempty comma-separated list of
  owned E.164 senders. Other Shared senders keep the existing route.
- `NETWORK_SERVICE_URL` and the existing `SERVICE_TURN_SECRET` must identify
  the Network service authority. Admitted turns fail closed if it is missing.

The owned Shared path requires `NETWORK_PERSONAL_CONTINUITY_ENABLED=true` and
the exact seven-field `NETWORK_OWNED_INGRESS_POLICY` accepted by Cloud: owned
phone, `eliza-app` project, Blooio platform, connector account, exact
`blooio:eliza-app:` message prefix, canonical user UUID and organization UUID.
Malformed policy fails before intake. Cloud separately verifies actual account
ownership. Proof-bearing identity-link challenges keep their original route.

This owned Shared path handles direct private Blooio phone traffic. Group and
explicit-agent traffic keep their existing routing. The original `network`
project keeps its existing rollout policy.

STOP fences apply before provider dispatch, including failure replies.
Completed Network receipts need the matching connector/thread target hash,
acceptance timestamp and provider IDs; missing proof returns unknown without
resending. Phone authentication and same-account/history acceptance remain
separate release checks.
