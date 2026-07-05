# @elizaos/plugin-nostr

Adds Nostr decentralized messaging to an Eliza agent: encrypted DMs (NIP-04), public note publishing (kind:1), and profile management (kind:0) over multiple relays.

## Purpose / role

This plugin gives an Eliza agent a Nostr identity and connects it to one or more Nostr relays. It is **opt-in** and auto-enables when `config.connectors.nostr` is present and not explicitly disabled (see `auto-enable.ts`). It registers a message connector for DMs and a post connector for public notes so the agent's planner can route `MESSAGE` and `POST` actions to Nostr without extra plugin-specific actions.

## Plugin surface

Registered in `src/index.ts`:

| Surface | Name | Description |
|---|---|---|
| Service | `NostrService` (serviceType `"nostr"`) | Manages relay pool, per-account subscriptions, NIP-04 encrypt/decrypt, event signing, and connector registration |
| Provider | `nostrIdentityContext` | Injects agent npub + connected relays into context; only active for `source === "nostr"` messages in `social`/`connectors` contexts |
| Actions | _(none)_ | DMs route through the `MESSAGE` connector; public notes route through the `POST` connector |
| Message connector | `"nostr"` | Registered at service start via `runtime.registerMessageConnector`; handles encrypted DM send, fetch, target resolution |
| Post connector | `"nostr"` | Registered at service start via `runtime.registerPostConnector`; handles `publishNote`, `fetchFeed`, `searchPosts` (NIP-50 where relay supports it) |

Events emitted via `runtime.emitEvent` (values from `NostrEventTypes` enum in `src/types.ts`):

- `NOSTR_MESSAGE_RECEIVED` — incoming DM after policy check and decrypt
- `NOSTR_MESSAGE_SENT` — outgoing DM published to relays
- `NOSTR_CONNECTION_READY` — account service fully initialized
- `NOSTR_PROFILE_PUBLISHED` — kind:0 profile event published
- `NOSTR_RELAY_CONNECTED` / `NOSTR_RELAY_DISCONNECTED` — relay lifecycle (type defined; emission site is in future extension)

## Layout

```
plugins/plugin-nostr/
  src/
    index.ts                  Plugin definition; exports NostrService, identityContextProvider, types
    service.ts                NostrService class — all relay, crypto, connector, and subscription logic
    accounts.ts               Multi-account resolution (env vars + character.settings.nostr + NOSTR_ACCOUNTS JSON)
    connector-account-provider.ts  ConnectorAccountProvider adapter for ConnectorAccountManager
    types.ts                  NostrSettings, NostrProfile, NostrMessage, error classes, utility fns
    providers/
      identityContext.ts      identityContextProvider implementation
      index.ts                Re-exports providers
    __tests__/
      accounts.test.ts        Unit tests for account resolution
      service-hardening.test.ts  Unit tests for service hardening / edge cases
  auto-enable.ts              shouldEnable() hook read by the plugin auto-enable engine
```

## Commands

Only scripts that exist in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-nostr build         # compile via build.ts
bun run --cwd plugins/plugin-nostr test          # vitest run
bun run --cwd plugins/plugin-nostr lint          # biome check --write --unsafe
bun run --cwd plugins/plugin-nostr lint:check    # biome check (read-only)
bun run --cwd plugins/plugin-nostr format        # biome format --write
bun run --cwd plugins/plugin-nostr format:check  # biome format (read-only)
bun run --cwd plugins/plugin-nostr typecheck     # tsgo --noEmit
```

## Config / env vars

All resolved in `src/accounts.ts` → `resolveNostrAccountSettings`. For multiple accounts, use `character.settings.nostr.accounts` or `NOSTR_ACCOUNTS` (JSON array or object keyed by accountId).

| Env var | Required | Default | Description |
|---|---|---|---|
| `NOSTR_PRIVATE_KEY` | Yes (single-account) | — | Hex or `nsec1` bech32 private key |
| `NOSTR_RELAYS` | No | `wss://relay.damus.io, wss://nos.lol, wss://relay.nostr.band` | Comma-separated relay WebSocket URLs |
| `NOSTR_DM_POLICY` | No | `pairing` | `open` / `pairing` / `allowlist` / `disabled` |
| `NOSTR_ALLOW_FROM` | No | — | Comma-separated hex pubkeys or npubs (required when policy = `allowlist`) |
| `NOSTR_ENABLED` | No | `true` | Set to `false` to disable without removing config |
| `NOSTR_ACCOUNTS` | No | — | JSON to configure multiple accounts (array or `{id: config}` object) |
| `NOSTR_DEFAULT_ACCOUNT_ID` | No | `"default"` | Which account is the default when multiple are configured |

Character-file override path: `character.settings.nostr` — same fields as `NostrAccountConfig` in `src/accounts.ts`. Per-account overrides go under `character.settings.nostr.accounts.<id>`.

## How to extend

**Add a new provider:**
1. Create `src/providers/myProvider.ts` implementing `Provider` from `@elizaos/core`.
2. Export it from `src/providers/index.ts`.
3. Add it to the `providers` array in the plugin object in `src/index.ts`.

**Add a new action:**
1. Create `src/actions/myAction.ts` implementing `Action` from `@elizaos/core`.
2. Export it from `src/index.ts`.
3. Add it to the `actions` array in `src/index.ts`.

**Add a new Nostr event kind handler:**
1. Add a `Filter` entry in `NostrService.startSubscription` in `src/service.ts`.
2. Handle the event in `NostrService.handleEvent` (or dispatch to a dedicated method).
3. Add a corresponding `NostrEventTypes` enum value in `src/types.ts` and emit it.

## Conventions / gotchas

- **Multi-account:** `NostrService` spawns child `NostrService` instances (one per enabled account). Public methods like `sendDm` / `getPublicKey` on the root instance delegate to the default child. When working on multi-account routing, trace through `accountServices: Map<string, NostrService>`.
- **NIP-04 only:** Encryption uses `nostr-tools/nip04` (AES-256-CBC over an ECDH shared secret). NIP-44 is outside this plugin's current protocol surface. DM content is always decrypted in-process; plaintext is never persisted by this plugin directly.
- **`@noble/hashes` pin:** `package.json` has a hard override to `@noble/hashes@2.2.0`. Do not change this without verifying `nostr-tools` cryptography still works end-to-end.
- **Relay errors are non-fatal:** `publishNote` / `sendDm` / `publishProfile` loop over relays and succeed if any relay accepts the event. Failure on all relays returns `success: false`.
- **No Markdown in Nostr content:** The `contentShaping` hints passed to both connector registrations disable Markdown. Keep note/DM text plain.
- **Message deduplication:** `seenEventIds` (capped at 10 000) prevents processing the same event twice across relay subscriptions.
- See root `AGENTS.md` for repo-wide rules (logger-only, ESM, architecture rules, naming).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — platform connector:**
- A real (or sandbox-account) round-trip on the platform: inbound message → agent → outbound reply, captured as logs **and** a screenshot/recording of the actual conversation.
- The raw inbound event/webhook payload and the outbound API request/response, with IDs mapped correctly (`stringToUuid` / `createUniqueUuid`).
- Attachments, threads/replies, edits, multi-account, and rate-limit/error paths — not just a single text ping.
- The agent trajectory for the turn the connector drove.
<!-- END: evidence-and-e2e-mandate -->
