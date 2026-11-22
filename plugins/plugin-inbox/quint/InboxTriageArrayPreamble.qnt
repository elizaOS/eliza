// classifyMessages (plugins/plugin-inbox/src/inbox/triage-classifier.ts)
// asks the TEXT_SMALL model for a {"results": [...]} object and also accepts
// a legacy JSON array. parseTriageStructuredArray reads the object answer with
// core parseJsonModelRecord and, when that gives no results, reads the answer
// as a legacy array with parseTriageJsonArray.
// One model answer for one batch of messages.
// tag: 0 no reasoning block, 1 <think>, 2 <thinking>, 3 <reasoning> (names
// from core REASONING_TAG_NAMES), written before the JSON.
// upper: the tag name is written in upper case (<THINKING>).
// closed: the reasoning block has its closing tag.
// shape: 0 legacy array, 1 results object.
// wrapper: 0 bare JSON, 1 the JSON in a whole ```json code fence, 2 a
// sentence of prose before the JSON.
// phase: 0 the answer is not read yet, 1 classifyMessages read it.
// After the answer is read:
// classified: classifyMessages returned one result per message.
// failed: classifyMessages threw InboxTriageClassificationError.
// calls: model calls made for the batch.
module InboxTriageArrayPreamble {
  pure val NoTag = 0
  pure val Tags = 0.to(3)
  pure val Shapes = 0.to(1)
  pure val Prose = 2
  pure val Wrappers = 0.to(2)
  type Answer = {
    tag: int,
    upper: bool,
    closed: bool,
    shape: int,
    wrapper: int,
  }

  pure val Answers: Set[Answer] = Tags.map(t => Set(false, true).map(u =>
    Set(false, true).map(c => Shapes.map(s => Wrappers.map(w =>
      { tag: t, upper: u, closed: c, shape: s, wrapper: w }
    )).flatten()).flatten()
  ).flatten()).flatten().filter(a => a.tag != NoTag or and {
    not(a.upper),
    a.closed,
  })

  var answer: Answer
  var phase: int
  var classified: bool
  var failed: bool
  var calls: int

  // The answer is read when any reasoning block before it is closed and its
  // JSON is bare or in a whole code fence. The tag name, its case and the
  // answer shape do not matter.
  pure def readable(a: Answer): bool = and {
    a.tag == NoTag or a.closed,
    a.wrapper != Prose,
  }

  action init = {
    nondet a = Answers.oneOf()
    all {
      answer' = a,
      phase' = 0,
      classified' = false,
      failed' = false,
      calls' = 0,
    }
  }
  // classifyMessages calls the model once for the batch and reads the answer.
  action classify = all {
    phase == 0,
    answer' = answer,
    phase' = 1,
    classified' = readable(answer),
    failed' = not(readable(answer)),
    calls' = 1,
  }
  // The triage run may not have started yet.
  action stutter = all {
    answer' = answer,
    phase' = phase,
    classified' = classified,
    failed' = failed,
    calls' = calls,
  }
  action step = any { classify, stutter }

  val ModelState = {
    answer: answer,
    phase: phase,
    classified: classified,
    failed: failed,
    calls: calls,
  }
  temporal AnswerReadWithoutFairness = (phase == 0).leadsTo(phase == 1)
  temporal AnswerRead = classify.weakFair(ModelState)
    .implies(AnswerReadWithoutFairness)

  // A closed reasoning block before bare or fenced JSON is skipped for the
  // legacy array as for the results object, whatever its tag name and case.
  val ClosedBlockSkipped = phase == 0 or not(readable(answer)) or classified
  // An unclosed reasoning block is never skipped.
  val UnclosedBlockRefused =
    phase == 0 or answer.tag == NoTag or answer.closed or failed
  // No array or object is cut out of prose.
  val ProseRefused = phase == 0 or answer.wrapper != Prose or failed
  // The batch gets results or an error, never both and never neither.
  val OneOutcome = phase == 0 or classified != failed
  // A refused answer is not retried.
  val OneModelCall = calls == phase
  val NothingBeforeRead = phase == 1 or and {
    not(classified),
    not(failed),
  }
  val TypeOK = and {
    Answers.contains(answer),
    Set(0, 1).contains(phase),
    Set(0, 1).contains(calls),
  }
}
