# Anonymous character naming

The source is the `AgentRuntime` constructor and its static
`anonymousAgentCounter` in `packages/core/src/runtime.ts` at
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. Explicit characters retain
their supplied identity. A constructor without a character uses the next
process-local ordinal in `Agent-<ordinal>` and the existing anonymous
character defaults before the normal agent-ID derivation.

## Story: Construct anonymous agents with distinct generated names

As an embedded host, I can omit a character and receive a usable default
without overwriting the identity of an explicitly supplied character.

### Only anonymous construction advances the shared name counter

The ordinal is an internal naming input. String formatting and UUID
derivation retain the concrete source contracts in the baseline.

```quint
type NamingState = { nextOrdinal: int, anonymousCount: int, explicitCount: int }
pure val initial: NamingState = { nextOrdinal: 1, anonymousCount: 0, explicitCount: 0 }
pure def constructAnonymous(s: NamingState): NamingState = { ...s, nextOrdinal: s.nextOrdinal + 1, anonymousCount: s.anonymousCount + 1 }
pure def constructExplicit(s: NamingState): NamingState = { ...s, explicitCount: s.explicitCount + 1 }
pure def alwaysCounterTracksAnonymousNames(s: NamingState): bool = s.anonymousCount >= 0 and s.explicitCount >= 0 and s.nextOrdinal == s.anonymousCount + 1
pure def stepExplicitNameLeavesOrdinal(before: NamingState, via: str, after: NamingState): bool = via == "constructExplicit" implies after.nextOrdinal == before.nextOrdinal
pure def stepAnonymousGetsFreshOrdinal(before: NamingState, via: str, after: NamingState): bool = via == "constructAnonymous" implies after.nextOrdinal == before.nextOrdinal + 1
pure def sometimesMultipleAnonymousAgents(s: NamingState): bool = s.anonymousCount >= 2
```
