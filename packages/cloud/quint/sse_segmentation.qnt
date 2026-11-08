// Finite line-segmentation projection of createPassthroughStreamMeter.
// Symbols0/1/2/3 represent complete content/usage/DONE/error payload atoms,
// 8=CR,9=LF. Two input grammars, chunks1..3 atoms. This is not a JSON, UTF-8
// or arbitrary-SSE proof: byte/Unicode equivalence is exercised by runtime tests.
// DONE is an observed event; only EOF/abort terminates the parser.
module sse_segmentation {
  type Parser = { fragment: List[int], events: List[int] }
  type State = { grammarId: int, input: List[int], cursor: int, parser: Parser, terminal: bool, flushed: bool }
  var s: State
  pure def emit(p: Parser): Parser = {
    val payload = p.fragment.select(c => c != 8)
    { fragment: List(), events: if (payload.length() == 0) p.events else p.events.append(payload.nth(0)) }
  }
  pure def read(p: Parser, c: int): Parser = if (c == 9) emit(p)
    else { fragment: p.fragment.append(c), events: p.events }
  action initialize(grammarId: int): bool = all {
    Set(0,1).contains(grammarId),
    s' = { grammarId: grammarId, input: if (grammarId == 0) List(0,8,9,1,9,2) else List(0,9,2,9,3,9),
      cursor: 0, parser: { fragment: List(), events: List() }, terminal: false, flushed: false }
  }
  action init = { nondet grammarId = Set(0,1).oneOf(); initialize(grammarId) }
  action observe(n: int): bool = all {
    not(s.terminal), n >= 1, n <= 3, s.cursor+n <= s.input.length(),
    s' = s.with("cursor", s.cursor+n).with("parser",
      List(0,1,2).select(i => i < n).foldl(s.parser, (p,i) => read(p, s.input.nth(s.cursor+i))))
  }
  action finish = all {
    not(s.terminal), s' = s.with("terminal", true).with("flushed", true).with("parser", emit(s.parser))
  }
  action abort = all { not(s.terminal), s' = s.with("terminal", true) }
  action ignoredAfterTerminal = all { s.terminal, s' = s }
  action idle = s' = s
  action step = { nondet chunkSize = Set(1,2,3).oneOf(); any { observe(chunkSize), finish, abort, ignoredAfterTerminal, idle } }

  // Independent prefix oracle for the two fixed grammars, including an EOF
  // that flushes a valid unterminated payload and an abort that never flushes.
  val reference = if (s.grammarId == 0)
    (if (s.cursor >= 3 or (s.flushed and s.cursor >= 1)) List(0) else List())
      .concat(if (s.cursor >= 5 or (s.flushed and s.cursor >= 4)) List(1) else List())
      .concat(if (s.flushed and s.cursor >= 6) List(2) else List())
    else
    (if (s.cursor >= 2 or (s.flushed and s.cursor >= 1)) List(0) else List())
      .concat(if (s.cursor >= 4 or (s.flushed and s.cursor >= 3)) List(2) else List())
      .concat(if (s.cursor >= 6 or (s.flushed and s.cursor >= 5)) List(3) else List())
  val safety = s.parser.events == reference and s.cursor >= 0 and s.cursor <= s.input.length()
  run coalescedCrLfAndEofTest = initialize(0).then(observe(3)).then(observe(3)).then(finish)
    .expect(safety and s.parser.events == List(0,1,2))
  run everyAtomFragmentedTest = initialize(0).then(observe(1)).then(observe(1)).then(observe(1))
    .then(observe(1)).then(observe(1)).then(observe(1)).then(finish)
    .expect(safety and s.parser.events == List(0,1,2))
  run finishFlushesUnterminatedPayloadTest = initialize(0).then(observe(1)).then(finish)
    .expect(safety and s.parser.events == List(0))
  run abortDoesNotFlushPartialLineTest = initialize(0).then(observe(1)).then(abort).then(ignoredAfterTerminal)
    .expect(safety and s.parser.events == List())
  run doneDoesNotHideLaterErrorTest = initialize(1).then(observe(3)).then(observe(3)).then(finish)
    .expect(safety and s.parser.events == List(0,2,3))
  action unsafeForgetFragment = s' = s.with("parser", s.parser.with("fragment", List()))
  run lostFragmentNegativeWitnessTest = initialize(0).then(observe(1)).then(unsafeForgetFragment)
    .then(observe(2)).expect(not(safety))
  action unsafeFlushAfterAbort = s' = s.with("parser", emit(s.parser))
  run postAbortMutationNegativeWitnessTest = initialize(0).then(observe(1)).then(abort)
    .then(unsafeFlushAfterAbort).expect(not(safety))
}
