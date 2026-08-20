# Platform secure store

Eliza uses one narrow contract for secrets that must live outside the encrypted
Vault database: its encryption master key and native application session state.
Secret values are never listed, logged, included in diagnostics, or exposed by
the Vault inventory endpoint.

## Backends

| Host | Backend | Scope |
| --- | --- | --- |
| iOS | Security.framework generic-password items | Fixed `ai.elizaos.secure-store` service, allowlisted accounts, app-only, `AfterFirstUnlockThisDeviceOnly`, iCloud synchronization disabled |
| macOS desktop | Native `@napi-rs/keyring` Keychain binding in the signed main process | Per-state-directory opaque Vault id; no `/usr/bin/security` subprocess |
| Linux desktop | Secret Service through `secret-tool` | Per-state-directory opaque Vault id and user session |
| Headless hosts | Explicit passphrase resolver | `ELIZA_VAULT_PASSPHRASE`; no plaintext fallback |

Unsupported or denied stores fail closed. A new key must not be minted after a
read error because doing so would orphan existing ciphertext.

Provider discovery does not shell out to Apple's `security` utility or inspect
another application's Keychain records. Imported provider credentials must use
an explicit provider file, OAuth flow, environment setting, or an Eliza-managed
account record.

## Native renderer migration

The iOS and Electrobun storage bridge protects device auth, the Steward/Cloud
session token, the active runtime record, and the agent-profile registry. On
first launch after upgrade it:

1. reads the protected store;
2. if absent, reads the legacy Preferences/localStorage value;
3. writes the protected value;
4. reads it back and compares the exact bytes; and
5. only then removes both plaintext copies.

Synchronous callers see an in-memory compatibility cache. A failed new secure
write is not redirected to plaintext persistence.

## Apple distribution policy

Keychain Services is a public Apple API and needs no privacy purpose string.
Eliza intentionally does not request `keychain-access-groups`, so its widgets
and keyboard extension cannot read app credentials. Apple documents that an
item with no explicit access group uses the app's private default group, while
[Keychain Sharing](https://developer.apple.com/documentation/xcode/configuring-keychain-sharing)
adds shared groups through an entitlement. The existing app-group entitlement
is for explicitly shared non-secret app data and is not used as a credential
store.

iCloud Keychain synchronization remains off. Apple specifies that
[`AfterFirstUnlockThisDeviceOnly`](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly)
items do not migrate to a new device. A safe future sync feature must be an
end-to-end Personal Sync Vault that synchronizes encrypted data and recovery
metadata together; setting `kSecAttrSynchronizable` on the master key alone is
not a backup or multi-device design.
