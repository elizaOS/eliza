# @elizaos/auth

Leaf auth package for Eliza agents. Owns account credential storage, OAuth /
subscription login flows, direct-API-key probing, refresh coordination, and the
encrypted account envelope those depend on. Valid legacy plaintext records are
migrated atomically before they are returned.

It sits **below** `@elizaos/agent` and `@elizaos/app-core` so both consume it
without a dependency cycle. It depends only on `@elizaos/core`, `@elizaos/shared`,
`@elizaos/vault`, and node builtins — never on `@elizaos/agent` or `@elizaos/app-core`.

## Public surface

- `account-storage` — AES-GCM encrypted on-disk account records (`saveAccount`, `loadAccount`, …).
- `credentials` — provider credential resolution + access-token acquisition.
- `oauth-flow` — interactive OAuth/subscription login flows.
- `direct-api-probe` — direct-API-key availability probing.
- `refresh-mutex` — per-account refresh serialization.
- `types` — shared account/provider types and id constants.

Import subpaths directly, e.g. `import { saveAccount } from "@elizaos/auth/account-storage"`.

## OpenRouter and xAI accounts

OpenRouter credits/BYOK and xAI API PAYG are distinct direct-account products:
their canonical account IDs are `openrouter-api` and `xai-api`, with
`OPENROUTER_API_KEY` and `XAI_API_KEY` as the exported env aliases. Adding,
repairing, or testing an OpenRouter key first authenticates through its
current-key endpoint, then fetches the bounded public model catalog separately;
xAI authenticates through its bounded model endpoint. Failure bodies from either
provider are never reflected to callers. Like every direct provider, the
credential of the pool-selected account is exported to the process environment
by the account-pool bridge at boot and again after each account mutation, so
add, replace, enable/disable, re-prioritize, and delete take effect without a
restart; when the pool rejects every linked account the exported value is
retracted rather than falling back to an ineligible key. Neither account
advertises coding-agent spawn. Grok subscription login is a separate product
and must not be represented as an xAI API key.
