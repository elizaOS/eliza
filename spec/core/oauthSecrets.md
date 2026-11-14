# OAuth PKCE verifier ownership

Source `connectors/account-manager.ts` keeps PKCE verifiers in a process-local map. Durable flow rows retain only a verifier reference. Metadata excludes the raw `codeVerifier`, `code_verifier` and `oauthCodeVerifier` fields. The key includes normalized provider and original flow id. Restart deliberately drops the verifier map while durable flow state remains.

## Story: Use a one-time verifier only with its originating flow

As an account provider, I want a callback to retrieve only its original verifier, and a post-restart callback to fail with a fresh-link instruction.

### Storing a verifier sweeps expired entries and replacement preserves the flow key

A missing or blank verifier creates no entry. Expiry is optional; the source checks expiry while storing/sweeping and adopts the durable store's expiry after update. Reading a present entry does not independently recheck its expiry, because flow consumption is the expiry boundary. Completion finally deletes the originating verifier.

```quint
type Verifier = { provider: str, flowId: str, secretId: str, hasExpiry: bool, expiresAt: int }
type OAuthSecrets = { entries: List[Verifier], now: int }
pure val initial: OAuthSecrets = { entries: List(), now: 0 }
pure def canStoreVerifier(s: OAuthSecrets, secretId: str): bool = secretId != ""
pure def storeVerifier(s: OAuthSecrets, provider: str, flowId: str, secretId: str, hasExpiry: bool, expiresAt: int): OAuthSecrets = { ...s, entries: s.entries.select(entry => (not(entry.hasExpiry) or entry.expiresAt == 0 or entry.expiresAt > s.now) and (entry.provider != provider or entry.flowId != flowId)).append({ provider: provider, flowId: flowId, secretId: secretId, hasExpiry: hasExpiry, expiresAt: expiresAt }) }
pure def updateExpiry(s: OAuthSecrets, provider: str, flowId: str, expiresAt: int): OAuthSecrets = { ...s, entries: s.entries.listMap(entry => if (entry.provider == provider and entry.flowId == flowId) { ...entry, hasExpiry: true, expiresAt: expiresAt } else entry) }
pure def removeVerifier(s: OAuthSecrets, provider: str, flowId: str): OAuthSecrets = { ...s, entries: s.entries.select(entry => entry.provider != provider or entry.flowId != flowId) }
pure def restartProcess(s: OAuthSecrets): OAuthSecrets = { ...s, entries: List() }
pure def setClock(s: OAuthSecrets, now: int): OAuthSecrets = { ...s, now: now }
pure def alwaysVerifierScopeUnique(s: OAuthSecrets): bool = s.entries.every(entry => s.entries.select(other => other.provider == entry.provider and other.flowId == entry.flowId).length() == 1)
pure def sometimesVerifierPresent(s: OAuthSecrets): bool = s.entries.length() > 0
pure def stepRestartDropsVerifiers(before: OAuthSecrets, via: str, after: OAuthSecrets): bool = via == "restartProcess" implies after.entries.length() == 0
```
