# @elizaos/confidant

Single seam for credential storage, mediation, and audit in Eliza agents.

> **Status**: phase 0 (interface + tests). The runtime does not yet call
> into Confidant. Phase 1 of the rollout wires it into the Eliza runtime;
> see the design doc for the full migration plan.

## Why

Today, every plugin and skill running in an Eliza agent can read every
provider credential via `process.env`. There is no boundary, no audit, no
mediation. Confidant is the structural fix: it's the only seam at which a
credential can be observed.

Concretely it closes seven specific failure modes documented in the design
doc, including the dual-writer bug that lets a model slug overwrite an API
key and the missing skill-exfiltration boundary.

## Surface

```ts
import { createConfidant, defineSecretSchema } from "@elizaos/confidant";

defineSecretSchema({
  "llm.openrouter.apiKey": {
    label: "OpenRouter API Key",
    formatHint: "sk-or-v1-...",
    sensitive: true,
    pluginId: "@elizaos/plugin-openrouter",
  },
});

const confidant = createConfidant();

// User flow (e.g. Settings UI):
await confidant.set("llm.openrouter.apiKey", "sk-or-v1-...");

// Plugin flow:
const scoped = confidant.scopeFor("@elizaos/plugin-openrouter");
const apiKey = await scoped.resolve("llm.openrouter.apiKey"); // implicit grant

// HTTP-client flow (per-request, never copied to long-lived memory):
const lazyKey = scoped.lazyResolve("llm.openrouter.apiKey");
const client = new OpenRouter({ apiKey: lazyKey });
```

## Identifiers

`domain.subject.field`, lowercase, e.g.
`llm.openrouter.apiKey`, `subscription.openai.accessToken`,
`connector.telegram.botToken`. Identifiers are stable across renames of
underlying env vars, files, or storage backends.

## Reference URI scheme

| Scheme | Where the value lives |
|---|---|
| `file://` | encrypted in `~/.milady/confidant.json` (this package) |
| `keyring://service/account` | OS keychain (macOS in phase 0) |
| `op://vault/item/field` | 1Password (phase 4) |
| `pass://...` | Proton Pass (phase 4) |
| `env://VAR_NAME` | `process.env[VAR_NAME]` — migration only, removed in phase 6 |
| `cloud://path` | Eliza Cloud, E2E-encrypted (phase 7) |

## Storage

`~/.milady/confidant.json` (mode `0600`). Literals are AES-256-GCM
encrypted with a master key held in the OS keychain (cross-platform via
`@napi-rs/keyring` — macOS Keychain, Windows Credential Manager, Linux
Secret Service / libsecret). Headless hosts without a Secret Service
agent will need an `inMemoryMasterKey` (or, in phase 1, a passphrase-
derived resolver). The secret id is bound as additional authenticated
data, so a swapped ciphertext fails closed.

## Tests

```bash
bun run --filter @elizaos/confidant test
# or in this package directory:
bun run test
```

## Threat model

See `docs/architecture/confidant.md` §11 for the full table. Headlines:

- **Defended**: cross-skill exfiltration (per-skill grants), at-rest disk
  leak (AES-256-GCM with keyring-held master), phishing autofill (server
  derives domain from tab URL).
- **Accepted**: a skill granted access to a secret can leak it (trust at
  boundary); DOM-level autofill leaks (industry-standard).
- **Out of scope (v1)**: side-channel exfiltration via shared runtime
  memory; HSM/FIDO2 storage; multi-user team vaults.

## License

MIT.
