// Main-thread handoff admission, with one selected tab and fixed Android review actions.
module BrowserExternalHandoff {
  var s: { live: bool, foreground: bool, current: bool, selected: bool,
    effect: int, admitted: bool, ownTarget: bool, system: bool }
  action init = s' = { live: true, foreground: true, current: true, selected: true,
    effect: 0, admitted: false, ownTarget: false, system: false }
  // Kinds: tel, SMS, geo, foreign VIEW, forbidden own intent. No CALL or SEND action exists.
  action attempt(kind: int, tap: bool): bool = {
    val system = kind < 3
    val allowed = s.live and s.foreground and s.current and s.selected and tap and kind != 4
    s' = { ...s, effect: if (allowed) (if (kind == 0) 1 else if (kind == 1) 2 else 3) else 0,
      admitted: allowed, ownTarget: system or kind == 4, system: system }
  }
  action pause = s' = { ...s, foreground: false }
  action retire = s' = { ...s, live: false, current: false }
  action deselect = s' = { ...s, selected: false }
  action replace = s' = { ...s, current: false }
  action step = any { { nondet kind = 0.to(4).oneOf() nondet tap = Set(false, true).oneOf() attempt(kind, tap) },
    pause, retire, deselect, replace, s' = s }
  val OnlyReviewActions = s.effect >= 0 and s.effect <= 3
  val EffectRequiresAdmission = s.effect > 0 implies s.admitted
  val OwnHandlerRequiresFixedSystemAction = (s.effect > 0 and s.ownTarget) implies s.system
  run tappedSmsMayOpenItsOwnHostTest = init.then(attempt(1, true)).expect(s.effect == 2)
  run untappedSmsCannotOpenTest = init.then(attempt(1, false)).expect(s.effect == 0)
  run backgroundTabCannotOpenTest = init.then(pause).then(attempt(0, true)).expect(s.effect == 0)
  run replacedTabCannotOpenTest = init.then(replace).then(attempt(2, true)).expect(s.effect == 0)
  run retiredTabCannotOpenTest = init.then(retire).then(attempt(1, true)).expect(s.effect == 0)
  run unselectedTabCannotOpenTest = init.then(deselect).then(attempt(1, true)).expect(s.effect == 0)
  run privateIntentCannotOpenOwnHostTest = init.then(attempt(4, true)).expect(s.effect == 0)
}
