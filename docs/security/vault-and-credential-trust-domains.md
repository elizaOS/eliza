# Vault and credential trust domains

Eliza deliberately has more than one credential store. They serve different
owners and runtimes and must not be presented as one globally synchronized
vault.

| Domain | Owner and scope | Storage | Management surface |
| --- | --- | --- | --- |
| Local Vault | One local Eliza host and its owner | Sensitive values are AES-256-GCM encrypted in PGlite. The master key comes from the OS keychain or `ELIZA_VAULT_PASSPHRASE`. Audit records contain key names and actions, never values. | Owner-only `/vault` view and `/api/secrets/*` routes |
| Connector account store | One agent, provider, and account on a host | The host's shared Vault when available; otherwise a state-directory Vault. Canonical keys are `connector.<agentId>.<provider>.<accountId>.<credentialType>`. | Connected accounts category in `/vault` |
| Eliza Cloud organization pool | One Cloud organization | Cloud database secrets protected by organization-scoped envelope encryption and KMS. List responses are masked and never return plaintext. | Cloud organization credential settings |
| Wallet material | One local owner/agent | Local Vault wallet category and wallet-specific policy | Wallet and `/vault` views |
| Browser logins | One local browser profile | Local Vault or an external password-manager reference | Saved logins tab in `/vault` |
| Login/session state | One authenticated local session | The narrowest platform store currently supported | Security findings in `/vault` when storage is not encrypted by Vault |

## Required boundaries

- The local Vault is core security infrastructure, not a dynamically installed
  plugin. A plugin may request a credential through a host service, but it must
  not implement its own plaintext database or secret-list endpoint.
- Local Vault and Cloud organization credentials remain separate. Connecting
  Eliza Cloud does not copy local keys to an organization, and listing the local
  Vault does not query or imply access to the Cloud pool.
- List and inventory APIs return metadata only. Plaintext is available only via
  an explicit owner-authorized reveal or at the connector execution boundary.
- `vault://<key>` is the only durable config pointer. At agent boot it resolves
  into the in-memory runtime settings overlay and is never copied into
  `process.env`.
- Connector keys must use the canonical connector namespace. This keeps bot
  tokens, OAuth grants, provider keys, wallets, and login sessions visibly
  separate even though they can share the same encrypted backend.
- Deleting or disconnecting an account must delete its credential reference.
  Logs, API errors, inventory responses, analytics, and audit files must never
  contain the credential value.

## Connector migration policy

Known top-level connector credentials in `eliza.json` are access-controlled by
mode `0600` for compatibility. Desktop boot migrates them into deterministic
`connector.host.<connector>.default.<field>` Vault keys and replaces the config
value with a `vault://` reference. New Telegram bot setup writes through the
connector credential service immediately when encrypted storage is available.

Nested multi-account connector credentials are reported as findings but are not
rewritten until every corresponding runtime resolver supports references.
Blindly rewriting them would break login while creating a false sense of
protection.

Telegram Personal currently stores its GramJS `StringSession` and transient
login state as mode-`0600` state files. Those files are reported in `/vault`
with their permission status and can be removed by disconnecting Telegram
Personal. Migrating them requires an asynchronous, platform-backed session
store that works on desktop and mobile; the UI must not claim these files are
Vault-encrypted before that boundary exists.

## Adding another connector secret

1. Add the field to `CONNECTOR_SECRET_FIELDS`.
2. Add its config-to-runtime projection and environment name, if applicable.
3. Ensure the runtime resolves `vault://` only into its settings overlay.
4. Use `ConnectorSetupService.persistConnectorCredential` in interactive setup
   and remove the reference on disconnect.
5. Add tests proving inventory never returns the value, migration is
   deterministic, and unresolved references fail closed rather than reaching a
   provider SDK.
