# Connector migration observations

The authoritative transfer state is [connectorHandoff](./connectorHandoff.md). It embeds full account/flow values, the source and target stores, the database bridge and the owning operation queue. This file retains read-only migration observations and owns no duplicate transfer counters or payload list.

## Story: Inspect a complete handoff before the selected operation runs

### Progress derives from the exact captured account and flow arrays

An operation is ready only when the authoritative owner reaches invocation. Copy progress is bounded by the captured value arrays; a failure preserves the owner's source store for retry.

```quint
import connectorHandoff as H from "./connectorHandoff"
import connectorStorage as D from "./connectorStorage"
import oauthBridge as B from "./oauthBridge"
import oauthSecrets as S from "./oauthSecrets"
import accountValues as A from "./accountValues"
import connectorQueues as Q from "./connectorQueues"
type MigrationProgress = { accountsCopied: int, accountsCaptured: int, flowsCopied: int, flowsCaptured: int, failed: bool, ready: bool }
pure def observe(s: H::Handoff): MigrationProgress = { accountsCopied: s.accountIndex, accountsCaptured: s.accountSnapshot.length(), flowsCopied: s.flowIndex, flowsCaptured: s.flowSnapshot.length(), failed: s.failed, ready: s.phase == H::InvokeOperation }
pure def lawProgressMatchesOwner(s: H::Handoff): bool = observe(s).accountsCopied == s.accountIndex and observe(s).flowsCopied == s.flowIndex
pure val sValues: Set[H::Handoff] = Set(H::initial)
```
