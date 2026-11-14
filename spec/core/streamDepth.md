# Nested stream-chunk delivery depth

The process-shared `elizaos.modelStreamChunkDeliveryDepth` AsyncLocalStorage in `packages/core/src/streaming-context.ts:510-550` at `72fed7e4069ecd35d61d886ab6eec5c02c137517` stores a numeric depth independently from streaming manager identity. `runInsideModelStreamChunkDelivery` increments the current depth for the callback's continuation and restores the parent on return or throw. Continuations created inside retain the inherited depth.

## Story: Avoid duplicate hooks for one delivered model chunk

As the message service I skip its duplicate chunk hook while the current continuation is already inside useModel chunk delivery. Peer continuations retain their independent depth.

### Entering and leaving a chunk scope preserve inherited depth exactly

```quint
type ChunkContinuation = {id: str, depth: int, stack: List[int]}
type StreamDepth = {continuations: List[ChunkContinuation]}
pure val initial: StreamDepth = {continuations: List()}
pure val idValues = Set("parent", "child", "peer")
pure val parentIdValues = idValues
pure val childIdValues = idValues
pure val peerIdValues = idValues
pure def chunkDepth(s: StreamDepth, id: str): int = s.continuations.select(c => c.id == id).nthOr(0, {id: id, depth: 0, stack: List()}).depth
pure def canCreateRoot(s: StreamDepth, id: str): bool = not(s.continuations.some(c => c.id == id))
pure def createRoot(s: StreamDepth, id: str): StreamDepth = {continuations: s.continuations.append({id: id, depth: 0, stack: List()})}
pure def canFork(s: StreamDepth, parentId: str, childId: str): bool = s.continuations.some(c => c.id == parentId) and not(s.continuations.some(c => c.id == childId))
pure def fork(s: StreamDepth, parentId: str, childId: str): StreamDepth = {continuations: s.continuations.append({id: childId, depth: chunkDepth(s, parentId), stack: List()})}
pure def canEnterChunk(s: StreamDepth, id: str): bool = s.continuations.some(c => c.id == id)
pure def enterChunk(s: StreamDepth, id: str): StreamDepth = {continuations: s.continuations.listMap(c => if (c.id == id) { ...c, stack: c.stack.append(c.depth), depth: c.depth + 1 } else c)}
pure def canLeaveChunk(s: StreamDepth, id: str): bool = s.continuations.some(c => c.id == id and c.stack.length() > 0)
pure def leaveChunk(s: StreamDepth, id: str): StreamDepth = {continuations: s.continuations.listMap(c => if (c.id == id and c.stack.length() > 0) { ...c, depth: c.stack.nthOr(c.stack.length() - 1, 0), stack: c.stack.removeAt(c.stack.length() - 1) } else c)}
pure def skipMessageServiceHook(s: StreamDepth, id: str): bool = chunkDepth(s, id) > 0
pure def alwaysDepthNonnegative(s: StreamDepth): bool = s.continuations.every(c => c.depth >= 0 and c.stack.every(depth => depth >= 0))
pure def alwaysContinuationIdentity(s: StreamDepth): bool = s.continuations.every(c => s.continuations.select(other => other.id == c.id).length() == 1)
pure def lawEnterThenLeave(s: StreamDepth, id: str): bool = leaveChunk(enterChunk(s, id), id) == s
pure def lawPeerDepthStable(s: StreamDepth, id: str, peerId: str): bool = id != peerId implies chunkDepth(enterChunk(s, id), peerId) == chunkDepth(s, peerId)
pure val sValues = Set(initial, {continuations: List({id: "parent", depth: 1, stack: List(0)})})
pure def sometimesNestedChunkScope(s: StreamDepth): bool = s.continuations.some(c => c.depth > 1)
```
