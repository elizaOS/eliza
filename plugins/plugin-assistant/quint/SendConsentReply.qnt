// requireSendConsent (plugins/plugin-assistant/src/features/messaging/triage/
// send-consent.ts) holds a drafted message after its preview ("— want me to
// send it?") until a later user turn answers. That first answer consumes the
// consent. An entire affirmative answer sends the draft; any other answer
// cancels it. A reply after that only previews the draft again, so a draft is
// sent at most once and a cancelled draft is never sent without a new preview.
// A reply is "yes" and at most one more word: extra 0 none, 1 "please",
// 2 "later". Its written form may start with a capital letter, may put a comma
// after "yes" when another word follows ("Yes, please"), and ends with mark
// 0 nothing, 1 "." or 2 "!".
// outcome of the first answer: 0 none yet, 1 sent, 2 cancelled.
module SendConsentReply {
  type Reply = { extra: int, capital: bool, comma: bool, mark: int }
  pure val NoReply: Reply = { extra: -1, capital: false, comma: false, mark: 0 }
  pure val Extras = 0.to(2)
  pure val Marks = 0.to(2)

  // The first answer to the preview, and a later reply after it.
  var first: Reply
  var later: Reply
  var outcome: int
  var sends: int

  // "yes" and "yes please" are on the list of entire affirmative answers,
  // whatever their capital letter, comma or end mark.
  pure def affirmative(r: Reply): bool = r.extra == 0 or r.extra == 1
  pure def written(r: Reply): bool =
    Extras.contains(r.extra) and Marks.contains(r.mark) and
    (r.comma implies r.extra != 0)

  action init = all {
    first' = NoReply, later' = NoReply, outcome' = 0, sends' = 0
  }
  action answer = {
    nondet extra = Extras.oneOf()
    nondet capital = Bool.oneOf()
    nondet comma = Bool.oneOf()
    nondet mark = Marks.oneOf()
    val r = { extra: extra, capital: capital, comma: comma, mark: mark }
    all {
      written(r),
      later == NoReply,
      if (outcome == 0) all {
        first' = r,
        later' = later,
        outcome' = if (affirmative(r)) 1 else 2,
        sends' = if (affirmative(r)) sends + 1 else sends,
      } else all {
        // Consent was consumed: the reply arms a new preview and sends nothing.
        first' = first, later' = r, outcome' = outcome, sends' = sends,
      },
    }
  }
  // The user may never answer the preview.
  action stutter = all {
    first' = first, later' = later, outcome' = outcome, sends' = sends
  }
  action step = any { answer, stutter }

  val ModelState = { first: first, later: later, outcome: outcome, sends: sends }
  temporal AnswerSettlesWithoutFairness = (outcome == 0).leadsTo(outcome != 0)
  temporal AnswerSettles = answer.weakFair(ModelState)
    .implies(AnswerSettlesWithoutFairness)

  val EntireAffirmativeSends =
    first == NoReply or not(affirmative(first)) or (outcome == 1 and sends == 1)
  val QualifiedAnswerCancels =
    first == NoReply or affirmative(first) or (outcome == 2 and sends == 0)
  val SentAtMostOnce = sends <= 1
  val LaterReplySendsNothing =
    later == NoReply or sends == (if (outcome == 1) 1 else 0)
  val TypeOK =
    Set(0, 1, 2).contains(outcome) and Set(0, 1).contains(sends) and
    (first == NoReply or written(first)) and
    (later == NoReply or written(later)) and
    (first == NoReply iff outcome == 0) and
    (later != NoReply implies first != NoReply)
}
