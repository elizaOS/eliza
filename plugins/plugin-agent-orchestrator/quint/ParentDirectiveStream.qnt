// SubAgentRouter.maybeDispatchParentAgent
// (plugins/plugin-agent-orchestrator/src/services/sub-agent-router.ts)
// buffers the text a sub-agent streams as `message` session events and
// bridges each complete `USE_SKILL parent-agent {json}` directive to the
// parent-agent broker. takeParentAgentDirective
// (src/services/parent-agent-dispatch.ts) finds the first complete directive
// in the buffered text and returns the text the router keeps buffering.
// chunks: what the sub-agent streamed, in order, at most three chunks:
// 0 prose without the marker, 1 the marker in prose ("via the parent-agent
// bridge (USE_SKILL parent-agent)"), 2 the marker with a balanced object that
// is not JSON ("params":{...} as in the deploy guidance), 3 a complete
// directive, 4 the first part of a directive whose JSON is still streaming,
// 5 the rest of that directive.
// routed: how many of the chunks the router has handled.
// pending: a directive whose JSON is still streaming stays buffered.
// dispatched: directives bridged to the broker.
module ParentDirectiveStream {
  pure val Prose = 0
  pure val Mention = 1
  pure val Malformed = 2
  pure val Directive = 3
  pure val Opening = 4
  pure val Closing = 5
  pure val MaxChunks = 3
  pure val NoChunks: List[int] = []

  var chunks: List[int]
  var routed: int
  var pending: bool
  var dispatched: int

  // A whole directive, or the rest of a streaming one, completes a directive.
  pure def completes(kind: int): bool = kind == Directive or kind == Closing
  pure def complete(cs: List[int]): int =
    cs.foldl(0, (n, kind) => if (completes(kind)) n + 1 else n)
  // After the first part of a directive the sub-agent streams its rest, and
  // the rest only follows a first part.
  pure def canFollow(cs: List[int], kind: int): bool =
    if (cs.length() > 0 and cs[cs.length() - 1] == Opening) kind == Closing
    else kind != Closing
  pure def kindAt(cs: List[int], i: int): int =
    if (i < cs.length()) cs[i] else Prose
  // The chunks the router has handled.
  pure def handled(cs: List[int], r: int): List[int] = cs.slice(0, r)
  pure def notDirective(kind: int): bool = kind == Mention or kind == Malformed

  action init = all {
    chunks' = NoChunks,
    routed' = 0,
    pending' = false,
    dispatched' = 0,
  }
  // The sub-agent streams one more chunk.
  action stream = {
    nondet kind = 0.to(5).oneOf()
    all {
      chunks.length() < MaxChunks,
      canFollow(chunks, kind),
      chunks' = chunks.append(kind),
      routed' = routed,
      pending' = pending,
      dispatched' = dispatched,
    }
  }
  // The router handles the next chunk. A whole directive and the rest of a
  // streaming one are dispatched. A marker in prose and a malformed object are
  // dropped, so they hold back nothing that follows. The first part of a
  // directive stays buffered until its rest arrives.
  action route = all {
    routed < chunks.length(),
    chunks' = chunks,
    routed' = routed + 1,
    pending' = (kindAt(chunks, routed) == Opening),
    dispatched' =
      if (completes(kindAt(chunks, routed))) dispatched + 1 else dispatched,
  }
  // The router has not handled the latest chunk yet.
  action stutter = all {
    chunks' = chunks,
    routed' = routed,
    pending' = pending,
    dispatched' = dispatched,
  }
  action step = any { stream, route, stutter }

  val ModelState = {
    chunks: chunks,
    routed: routed,
    pending: pending,
    dispatched: dispatched,
  }
  val AllDispatched = dispatched == complete(chunks)
  temporal DirectivesDispatchedWithoutFairness = not(AllDispatched).leadsTo(AllDispatched)
  temporal DirectivesDispatched = route.weakFair(ModelState)
    .implies(DirectivesDispatchedWithoutFairness)

  // Every complete directive the router has handled is dispatched exactly
  // once.
  val EveryDirectiveDispatchedOnce =
    dispatched == complete(handled(chunks, routed))
  // A marker in prose or a malformed object does not hold back a directive
  // that is streamed after it.
  val NonDirectiveMarkerSkipped =
    handled(chunks, routed).indices().forall(i =>
      not(notDirective(chunks[i])) or
      dispatched >= complete(chunks.slice(i + 1, routed)))
  // A stream that has no complete directive dispatches nothing.
  val NothingDispatchedWithoutDirective =
    complete(handled(chunks, routed)) > 0 or dispatched == 0
  // Only the first part of a directive stays buffered, until its rest
  // arrives; a dropped marker never does.
  val StreamingDirectiveKept =
    pending == (routed > 0 and kindAt(chunks, routed - 1) == Opening)
  val TypeOK = and {
    chunks.length() <= MaxChunks,
    chunks.indices().forall(i => chunks[i].in(0.to(5))),
    chunks.indices().forall(i => canFollow(chunks.slice(0, i), chunks[i])),
    routed.in(0.to(chunks.length())),
    dispatched.in(0.to(MaxChunks)),
  }
}
