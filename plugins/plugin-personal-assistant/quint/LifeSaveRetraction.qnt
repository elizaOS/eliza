// runLifeOperationHandler (plugins/plugin-personal-assistant/src/actions/life.ts)
// undoes a recent un-previewed save when the owner's next message is a
// retraction (isLifeSaveRetraction in
// plugins/plugin-personal-assistant/src/actions/lib/lifeops-deferred-draft.ts):
// it deletes the saved definition and clears the recent-save cache. A message
// that keeps the item ("don't forget to set it for 9") is an edit and leaves
// both alone. iOS and macOS smart punctuation type U+2019 for the apostrophe
// of "don't", and some keyboards drop it, so the spelling of the apostrophe
// must not decide whether a message is a retraction.
// The owner has just saved one reminder without a preview, so it is active
// and the recent-save cache names it. The action planner answers
// OWNER_REMINDERS action=delete for the next message.
// prefix: 0 none, 1 "actually ", 2 "no, ".
// mark: the apostrophe of "don't": 0 none ("dont"), 1 U+0027, 2 U+2019.
// form: what follows "don't": 0 "save that one", 1 "keep it",
// 2 "forget to set it for 9".
// target: the planner's delete target: 0 none, 1 "that one".
// live: the saved definition is still active. cached: the recent-save cache
// still names it. removed: the handler reports that it removed the save.
module LifeSaveRetraction {
  pure val NoMark = 0
  pure val Ascii = 1
  pure val Typographic = 2
  pure val SaveThatOne = 0
  pure val KeepIt = 1
  pure val Forget = 2

  var sent: bool
  var prefix: int
  var mark: int
  var form: int
  var target: int
  var handled: bool
  var live: bool
  var cached: bool
  var removed: bool

  // "don't save that one" and "don't keep it" take the save back;
  // "don't forget to set it for 9" asks to keep it.
  pure def isRetraction(f: int): bool = f != Forget

  action init = all {
    sent' = false,
    prefix' = 0,
    mark' = NoMark,
    form' = SaveThatOne,
    target' = 0,
    handled' = false,
    live' = true,
    cached' = true,
    removed' = false,
  }
  // The owner sends the next message.
  action send = {
    nondet p = 0.to(2).oneOf()
    nondet m = Set(NoMark, Ascii, Typographic).oneOf()
    nondet f = Set(SaveThatOne, KeepIt, Forget).oneOf()
    nondet t = 0.to(1).oneOf()
    all {
      not(sent),
      sent' = true,
      prefix' = p,
      mark' = m,
      form' = f,
      target' = t,
      handled' = false,
      live' = true,
      cached' = true,
      removed' = false,
    }
  }
  // The OWNER_REMINDERS handler runs for the message. A retraction deletes
  // the recent save and clears the cache; any other message leaves both.
  action handle = all {
    sent,
    not(handled),
    sent' = sent,
    prefix' = prefix,
    mark' = mark,
    form' = form,
    target' = target,
    handled' = true,
    live' = not(isRetraction(form)),
    cached' = not(isRetraction(form)),
    removed' = isRetraction(form),
  }
  // The handler has not run yet.
  action stutter = all {
    sent' = sent,
    prefix' = prefix,
    mark' = mark,
    form' = form,
    target' = target,
    handled' = handled,
    live' = live,
    cached' = cached,
    removed' = removed,
  }
  action step = any { send, handle, stutter }

  val ModelState = {
    sent: sent,
    prefix: prefix,
    mark: mark,
    form: form,
    target: target,
    handled: handled,
    live: live,
    cached: cached,
    removed: removed,
  }
  val Settled = not(sent) or handled
  temporal SettlesWithoutFairness = not(Settled).leadsTo(Settled)
  temporal Settles = handle.weakFair(ModelState)
    .implies(SettlesWithoutFairness)

  // Whether the save is undone depends on the words, not on how the
  // apostrophe is spelled.
  val ApostropheDoesNotDecide = not(handled) or live == (form == Forget)
  // "don't forget to set it for 9" keeps the save and the cache, with any
  // apostrophe.
  val EditKeepsSave =
    not(handled) or form != Forget or and { live, cached, not(removed) }
  // The cache is cleared exactly when the save is deleted, so a later
  // retraction can still undo a save that an edit kept.
  val CacheFollowsSave = not(handled) or cached == live
  // The reply says the save was removed exactly when it was.
  val ReplyMatchesStore = not(handled) or removed == not(live)
  // Nothing changes before the handler runs.
  val SaveStandsUntilHandled = handled or and { live, cached, not(removed) }
  val TypeOK = and {
    prefix.in(0.to(2)),
    mark.in(Set(NoMark, Ascii, Typographic)),
    form.in(Set(SaveThatOne, KeepIt, Forget)),
    target.in(0.to(1)),
    sent or not(handled),
  }
}
