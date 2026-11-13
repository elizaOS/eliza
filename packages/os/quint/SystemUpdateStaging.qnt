/// One optional inactive updater included in a product staging transaction.
module SystemUpdateStaging {
  type State = {selected: bool, admitted: bool, collision: bool, staged: bool, published: bool, enabled: bool}
  var s: State
  action init = s' = {selected: false, admitted: false, collision: false, staged: false, published: false, enabled: false}
  action includeClient = all {not(s.staged), not(s.published), s' = {...s, selected: true}}
  action admit = all {s.selected, not(s.staged), s' = {...s, admitted: true}}
  action collide = all {not(s.staged), s' = {...s, collision: true}}
  action stage = all {s.selected, s.admitted, not(s.collision), not(s.staged), s' = {...s, staged: true}}
  action publish = all {s.staged, s.admitted, not(s.collision), s' = {...s, published: true}}
  action step = any {includeClient, admit, collide, stage, publish, s' = s}
  action selectedInit = s' = {selected: true, admitted: false, collision: false, staged: false, published: false, enabled: false}
  action stableStep = any {admit, stage, publish, s' = s}
  temporal SelectedSourcePublishes = (admit.weakFair(s) and stage.weakFair(s) and publish.weakFair(s))
    implies eventually(s.published)
  val safety = not(s.enabled) and (s.staged implies (s.selected and s.admitted and not(s.collision)))
    and (s.published implies s.staged)
  run explicitSelectionStaysInactiveTest = init.then(includeClient).then(admit).then(stage).then(publish)
    .expect(s.published and not(s.enabled) and safety)
  run absenceDoesNotInstallTest = init.expect(not(s.staged) and not(s.published) and safety)
  run collisionPreservesExistingTest = init.then(includeClient).then(collide).then(admit)
    .expect(not(s.staged) and not(s.published) and safety)
}
