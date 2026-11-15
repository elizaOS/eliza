// Five finite line streams exercise only fence boundaries and field ownership.
// Text bytes and every Markdown construct are outside this projection.
module ResponseFieldFences {
  pure val Scripts = Map(
    1 -> List("inline", "outer"),
    2 -> List("open4", "short3", "quoted", "close4", "outer"),
    3 -> List("open3", "info3", "quoted", "short3", "outer"),
    4 -> List("open3", "closeTilde3", "quoted", "short3", "outer"),
    5 -> List("openTilde3", "quoted", "closeTilde3", "outer")
  )
  var s: { script: int, cursor: int, fence: int, outer: int, quoted: bool }
  action start(script: int): bool = s' = { script: script, cursor: 0, fence: 0, outer: 0, quoted: false }
  action init = { nondet script = 1.to(5).oneOf(); start(script) }
  pure def nextFence(fence: int, token: str): int =
    if (fence == 0) {
      if (token == "open4") 4
      else if (token == "open3" or token == "info3") 3
      else if (token == "openTilde3") -3 else 0
    } else if (fence > 0 and token == "close4") 0
    else if (fence == 3 and token == "short3") 0
    else if (fence == -3 and token == "closeTilde3") 0
    else fence
  action consume = {
    val lines = Scripts.get(s.script)
    all {
      s.cursor < lines.length(),
      {
        val token = lines[s.cursor]
        s' = { ...s, cursor: s.cursor + 1,
          fence: nextFence(s.fence, token),
          outer: s.outer + (if (token == "outer" and s.fence == 0) 1 else 0),
          quoted: s.quoted or (token == "quoted" and s.fence == 0) }
      }
    }
  }
  action step = any { consume, s' = s }
  val TypeOK = s.script.in(1.to(5)) and s.cursor.in(0.to(Scripts.get(s.script).length()))
    and s.fence.in(Set(-3, 0, 3, 4)) and s.outer.in(Set(0, 1))
  val QuotedFieldsStayQuoted = not(s.quoted)
  val OuterFieldsSurvive = s.cursor == Scripts.get(s.script).length() implies s.outer == 1
  temporal StreamFinishesWithoutFairness =
    (s.cursor < Scripts.get(s.script).length()).leadsTo(s.cursor == Scripts.get(s.script).length())
  temporal StreamFinishes = consume.weakFair(s).implies(StreamFinishesWithoutFairness)
  run shorterFenceKeepsQuoteTest = start(2).then(consume).then(consume).then(consume)
    .expect(QuotedFieldsStayQuoted).then(consume).then(consume).expect(OuterFieldsSurvive)
  run otherFenceKindKeepsQuoteTest = start(4).then(consume).then(consume).then(consume)
    .expect(QuotedFieldsStayQuoted).then(consume).then(consume).expect(OuterFieldsSurvive)
}
