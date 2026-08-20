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
| Native app session state | One installed Eliza app | iOS Apple Keychain (`AfterFirstUnlockThisDeviceOnly`, app-only, non-synchronizing) or the desktop OS credential store. Native migrations are write/read verified before legacy Preferences or localStorage is removed. | Protection status in `/vault` |
| Connector login state | One connector account on a local host | Local Vault master-key encryption. Telegram Personal stores both its GramJS `StringSession` and transient app credentials as AES-256-GCM envelopes. | Connected accounts and protection status in `/vault` |

## Required boundaries

- The local Vault is core security infrastructure, not a dynamically installed
  plugin. A plugin may request a credential through a host service, but it must
  not implement its own plaintext database or secret-list endpoint.
- Local Vault and Cloud organization credentials remain separate. Connecting
  Eliza Cloud does not copy local keys to an organization, and listing the local
  Vault does not query or imply access to the Cloud pool.
- Eliza does not enumerate or extract credentials from another application's
  Keychain items. External provider access must come from an explicit file,
  environment setting, OAuth flow, or credential saved through Eliza itself.
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

Telegram Personal stores its GramJS `StringSession` and transient login state
in mode-`0600` AES-256-GCM envelopes under the state directory, protected by
the same OS-keychain/passphrase master-key policy as the Local Vault. On first
read, legacy `session.txt` and `auth-state.json` files migrate only after the
encrypted replacement decrypts to the exact original value. Disconnect removes
both encrypted and legacy paths.

## Apple Keychain and iCloud policy

- The native bridge accepts only fixed Eliza account names. Renderers cannot
  choose a Keychain service, account, access group, or accessibility class.
- iOS credentials use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` so
  background restoration works after the owner first unlocks the phone, while
  device backups and migrations do not carry the items to another device.
- `kSecAttrSynchronizable` is explicitly false. Syncing only the Local Vault
  master key would not sync its encrypted database and could create a misleading
  recovery claim. A future Personal Sync Vault must sync versioned ciphertext,
  conflict metadata, deletion tombstones, and recovery material as one design.
- No Keychain Sharing entitlement is requested. Widgets and keyboard extensions
  therefore do not receive the app's credential access group.
- Eliza Cloud organization secrets remain a separate organization-KMS trust
  domain. Enabling iCloud must never copy or merge those credentials.

## Adding another connector secret

1. Add the field to `CONNECTOR_SECRET_FIELDS`.
2. Add its config-to-runtime projection and environment name, if applicable.
3. Ensure the runtime resolves `vault://` only into its settings overlay.
4. Use `ConnectorSetupService.persistConnectorCredential` in interactive setup
   and remove the reference on disconnect.
5. Add tests proving inventory never returns the value, migration is
   deterministic, and unresolved references fail closed rather than reaching a
   provider SDK.
