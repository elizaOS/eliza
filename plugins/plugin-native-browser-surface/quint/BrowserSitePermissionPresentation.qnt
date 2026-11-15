// Android WebView site permission review and its delayed Android permission result.
module BrowserSitePermissionPresentation {
  // Selection 0 is withdrawn. Tabs 1 and 2 stand for two separate presentations.
  // Stages: 0 idle, 1 site review, 2 Android result pending, 3 granted, 4 denied.
  type State = {
    selected: int, requested: int, paused: bool, stage: int, sameVisit: bool,
    sameDocument: bool, wroteChoice: bool, currentAtDecision: bool
  }
  var s: State

  action init = s' = { selected: 1, requested: 0, paused: false, stage: 0,
    sameVisit: false, sameDocument: false, wroteChoice: false, currentAtDecision: false }

  def pending = s.stage == 1 or s.stage == 2
  def current = s.selected == s.requested and s.sameVisit and s.sameDocument

  action request(storedAllow: bool): bool = all {
    not(pending), not(s.paused), s.selected != 0,
    s' = { ...s, requested: s.selected, stage: if (storedAllow) 2 else 1,
      sameVisit: true, sameDocument: true, wroteChoice: false, currentAtDecision: false }
  }

  action selectTab(tab: int): bool = {
    val retained = tab == s.selected
    s' = { ...s, selected: tab, sameVisit: s.sameVisit and retained,
      stage: if (s.stage == 1 and not(retained)) 4 else s.stage }
  }
  action documentChanged = s' = { ...s, sameDocument: false }
  action pause(value: bool): bool = s' = { ...s, paused: value }
  action cancelReview = all { s.stage == 1, s' = { ...s, stage: 4 } }

  action siteDecision(allow: bool, androidGranted: bool): bool = all {
    s.stage == 1,
    s' = { ...s, wroteChoice: current, currentAtDecision: current,
      stage: if (not(current) or not(allow)) 4 else if (androidGranted) 3 else 2 }
  }
  action androidDecision(allow: bool): bool = all {
    s.stage == 2,
    s' = { ...s, wroteChoice: false, currentAtDecision: current,
      stage: if (current and allow) 3 else 4 }
  }
  action completeAndroid = { nondet allow = Set(false, true).oneOf() androidDecision(allow) }

  action step = any {
    { nondet allow = Set(false, true).oneOf() request(allow) },
    { nondet tab = 0.to(2).oneOf() selectTab(tab) },
    { nondet value = Set(false, true).oneOf() pause(value) },
    { nondet allow = Set(false, true).oneOf()
      nondet alreadyGranted = Set(false, true).oneOf()
      siteDecision(allow, alreadyGranted) },
    documentChanged, cancelReview, completeAndroid, s' = s
  }

  val GrantRequiresCurrentPresentation = (s.stage == 3) implies s.currentAtDecision
  val StoredChoiceRequiresCurrentPresentation = s.wroteChoice implies s.currentAtDecision
  temporal AndroidAnswerSettles = completeAndroid.weakFair(s).implies(
    always((s.stage == 2).implies(eventually(s.stage != 2))))

  run sameTabOsPauseTest = init.then(request(true)).then(pause(true)).then(selectTab(1))
    .then(androidDecision(true)).expect(s.stage == 3)
  run switchedTabTest = init.then(request(true)).then(selectTab(2))
    .then(androidDecision(true)).expect(s.stage == 4)
  run roundTripTest = init.then(request(true)).then(selectTab(2)).then(selectTab(1))
    .then(androidDecision(true)).expect(s.stage == 4)
  run withdrawnAndReopenedTest = init.then(request(true)).then(selectTab(0)).then(selectTab(1))
    .then(androidDecision(true)).expect(s.stage == 4)
  run changedDocumentTest = init.then(request(true)).then(documentChanged)
    .then(androidDecision(true)).expect(s.stage == 4)
  run staleSiteChoiceTest = init.then(request(false)).then(documentChanged)
    .then(siteDecision(true, true)).expect(s.stage == 4 and not(s.wroteChoice))
  run freshSiteChoiceTest = init.then(request(false)).then(siteDecision(true, true))
    .expect(s.stage == 3 and s.wroteChoice)
  run retryRequiresFreshPresentationTest = init.then(request(true)).then(selectTab(2))
    .then(selectTab(1)).then(androidDecision(true)).then(request(true))
    .then(androidDecision(true)).expect(s.stage == 3)
}
