# Asynchronous context scopes

The source is `packages/core/src/utils/async-context-manager.ts` at
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. The current implementation
delegates to Node `AsyncLocalStorage`. This model specifies context
inheritance and restoration for logical continuations. The future Effect
adapter must preserve the public `run` and `active` behavior through real
asynchronous and exceptional continuations.

## Story: Keep concurrent turn context isolated

As a runtime caller, I enter a scope with a context, inherit that context
in continuations created inside it, and recover the outer context when
the scope returns or throws. A peer continuation keeps its own context.

### A continuation owns its current context and restoration stack

```quint
type ContextValue = NoContext | ContextReference({ identity: str })
pure val emptyContext: ContextValue = NoContext
type Continuation = { id: str, activeContext: ContextValue, stack: List[ContextValue] }
type ContextScopes = { continuations: List[Continuation] }
pure val initial: ContextScopes = { continuations: List() }
pure def hasContinuation(s: ContextScopes, id: str): bool = s.continuations.some(continuation => continuation.id == id)
pure def observedContext(s: ContextScopes, id: str): ContextValue = s.continuations.select(continuation => continuation.id == id).nthOr(0, { id: id, activeContext: emptyContext, stack: List() }).activeContext
pure def canCreateRoot(s: ContextScopes, id: str): bool = not(hasContinuation(s, id))
pure def createRoot(s: ContextScopes, id: str): ContextScopes = { continuations: s.continuations.append({ id: id, activeContext: emptyContext, stack: List() }) }
pure def canForkContinuation(s: ContextScopes, parentId: str, childId: str): bool = hasContinuation(s, parentId) and not(hasContinuation(s, childId))
pure def forkContinuation(s: ContextScopes, parentId: str, childId: str): ContextScopes = { continuations: s.continuations.append({ id: childId, activeContext: observedContext(s, parentId), stack: List() }) }
pure def canEnterScope(s: ContextScopes, id: str, identity: str): bool = hasContinuation(s, id)
pure def enterScope(s: ContextScopes, id: str, identity: str): ContextScopes = { continuations: s.continuations.listMap(continuation => if (continuation.id == id) { ...continuation, activeContext: ContextReference({ identity: identity }), stack: continuation.stack.append(continuation.activeContext) } else continuation) }
pure def canLeaveScope(s: ContextScopes, id: str): bool = s.continuations.some(continuation => continuation.id == id and continuation.stack.length() > 0)
pure def leaveScope(s: ContextScopes, id: str): ContextScopes = { continuations: s.continuations.listMap(continuation => if (continuation.id == id and continuation.stack.length() > 0) { ...continuation, activeContext: continuation.stack.nthOr(continuation.stack.length() - 1, emptyContext), stack: continuation.stack.removeAt(continuation.stack.length() - 1) } else continuation) }
pure val idValues = Set("parent", "child", "peer")
pure val parentIdValues = idValues
pure val childIdValues = idValues
pure val identityValues = Set("turn-one", "turn-two")
pure def alwaysContinuationIdsAreUnique(s: ContextScopes): bool = s.continuations.every(continuation => s.continuations.select(other => other.id == continuation.id).length() == 1)
pure def stepExistingContinuationsRemainRegistered(before: ContextScopes, after: ContextScopes): bool =
  before.continuations.every(continuation => after.continuations.some(other => other.id == continuation.id))
pure def sometimesNestedScope(s: ContextScopes): bool = s.continuations.some(continuation => continuation.stack.length() > 1)
pure def sometimesDistinctConcurrentContexts(s: ContextScopes): bool = s.continuations.some(left => s.continuations.some(right => left.id != right.id and left.activeContext != right.activeContext))
```

### Scope restoration and peer isolation are exact for every context value

```quint
pure def lawEnterThenLeaveRestores(s: ContextScopes, id: str, identity: str): bool =
  leaveScope(enterScope(s, id, identity), id) == s
pure def lawPeerContextUnchanged(s: ContextScopes, id: str, peerId: str, identity: str): bool =
  id != peerId implies observedContext(enterScope(s, id, identity), peerId) == observedContext(s, peerId)
pure val sValues = Set(initial, { continuations: List({ id: "parent", activeContext: emptyContext, stack: List() }) })
```
