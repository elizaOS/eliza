lemma Views(s: Planning)
  ensures alwaysCallIdentitiesUnique(s) == ((forall c :: c in s.calls ==> c.id > 0) && ProofLib.DistinctBy(s.calls, (x: PlannedCall) => x.id))
  ensures alwaysActionNamesUnique(s) == ((forall d :: d in s.registry ==> d.name != "") && ProofLib.DistinctBy(s.registry, (x: ActionDecl) => x.name))
{
  var C := s.calls;
  assert alwaysCallIdentitiesUnique(s) == (forall c :: c in C ==> c.id > 0 && |ProofLib.Filter((other: PlannedCall) => (other.id == c.id), C)| == 1);
  if forall c :: c in C ==> |ProofLib.Filter((other: PlannedCall) => (other.id == c.id), C)| == 1 {
    forall i, j | 0 <= i < |C| && 0 <= j < |C| && i != j ensures C[i].id != C[j].id {
      if C[i].id == C[j].id { assert C[i] in C; ProofLib.FilterTwo((other: PlannedCall) => (other.id == C[i].id), C, i, j); }
    }
  }
  if ProofLib.DistinctBy(C, (x: PlannedCall) => x.id) {
    forall c | c in C ensures |ProofLib.Filter((other: PlannedCall) => (other.id == c.id), C)| == 1 {
      var i :| 0 <= i < |C| && C[i] == c;
      ProofLib.FilterOne((other: PlannedCall) => (other.id == c.id), C, i);
    }
  }
  var R := s.registry;
  assert alwaysActionNamesUnique(s) == (forall d :: d in R ==> d.name != "" && |ProofLib.Filter((other: ActionDecl) => (other.name == d.name), R)| == 1);
  if forall d :: d in R ==> |ProofLib.Filter((other: ActionDecl) => (other.name == d.name), R)| == 1 {
    forall i, j | 0 <= i < |R| && 0 <= j < |R| && i != j ensures R[i].name != R[j].name {
      if R[i].name == R[j].name { assert R[i] in R; ProofLib.FilterTwo((other: ActionDecl) => (other.name == R[i].name), R, i, j); }
    }
  }
  if ProofLib.DistinctBy(R, (x: ActionDecl) => x.name) {
    forall d | d in R ensures |ProofLib.Filter((other: ActionDecl) => (other.name == d.name), R)| == 1 {
      var i :| 0 <= i < |R| && R[i] == d;
      ProofLib.FilterOne((other: ActionDecl) => (other.name == d.name), R, i);
    }
  }
}

lemma CallAt(s: Planning, p: int)
  requires ProofLib.DistinctBy(s.calls, (x: PlannedCall) => x.id)
  ensures forall k :: 0 <= k < |s.calls| && s.calls[k].id == p ==> callAt(s, p) == s.calls[k]
  ensures !knownCall(s, p) ==> callAt(s, p) == noCall
{
  var C := s.calls;
  assert callAt(s, p) == (if 0 < |ProofLib.Filter((c: PlannedCall) => (c.id == p), C)| then ProofLib.Filter((c: PlannedCall) => (c.id == p), C)[0] else noCall);
  var f := ProofLib.Filter((c: PlannedCall) => (c.id == p), C);
  if knownCall(s, p) {
    var c :| c in C && c.id == p;
    var k :| 0 <= k < |C| && C[k] == c;
    ProofLib.FilterOne((c: PlannedCall) => (c.id == p), C, k);
    assert f[0] in f;
    ProofLib.FilterMember((c: PlannedCall) => (c.id == p), C, f[0]);
    var j :| 0 <= j < |C| && C[j] == f[0];
  } else {
    ProofLib.FilterNone((c: PlannedCall) => (c.id == p), C);
    assert forall i :: 0 <= i < |C| ==> C[i] in C;
  }
}

lemma DeclAt(s: Planning, n: string)
  requires ProofLib.DistinctBy(s.registry, (x: ActionDecl) => x.name)
  ensures forall k :: 0 <= k < |s.registry| && s.registry[k].name == n ==> declOf(s, n) == s.registry[k]
  ensures !registered(s, n) ==> declOf(s, n) == noDecl
{
  var R := s.registry;
  assert declOf(s, n) == (if 0 < |ProofLib.Filter((d: ActionDecl) => (d.name == n), R)| then ProofLib.Filter((d: ActionDecl) => (d.name == n), R)[0] else noDecl);
  var f := ProofLib.Filter((d: ActionDecl) => (d.name == n), R);
  if registered(s, n) {
    var d :| d in R && d.name == n;
    var k :| 0 <= k < |R| && R[k] == d;
    ProofLib.FilterOne((d: ActionDecl) => (d.name == n), R, k);
    assert f[0] in f;
    ProofLib.FilterMember((d: ActionDecl) => (d.name == n), R, f[0]);
    var j :| 0 <= j < |R| && R[j] == f[0];
  } else {
    ProofLib.FilterNone((d: ActionDecl) => (d.name == n), R);
    assert forall i :: 0 <= i < |R| ==> R[i] in R;
  }
}

lemma Remap(s: Planning, t: Planning, k: int)
  requires inv(s) && t.registry == s.registry && |t.calls| == |s.calls| && 0 <= k < |s.calls|
  requires forall i :: 0 <= i < |s.calls| && i != k ==> t.calls[i] == s.calls[i]
  requires t.calls[k].id == s.calls[k].id && t.calls[k].actionName == s.calls[k].actionName && t.calls[k].parent == s.calls[k].parent && t.calls[k].role == s.calls[k].role
  ensures alwaysCallIdentitiesUnique(t)
  ensures forall p :: knownCall(t, p) == knownCall(s, p) && callAt(t, p).actionName == callAt(s, p).actionName && callAt(t, p).role == callAt(s, p).role
  ensures forall p :: p != s.calls[k].id ==> callAt(t, p) == callAt(s, p)
  ensures callAt(t, s.calls[k].id) == t.calls[k] && callAt(s, s.calls[k].id) == s.calls[k]
  ensures forall c :: permitted(t, c) == permitted(s, c)
{
  Views(s);
  Views(t);
  assert forall i :: 0 <= i < |t.calls| ==> t.calls[i].id == s.calls[i].id;
  assert forall c :: c in t.calls ==> c.id > 0 by {
    forall c | c in t.calls ensures c.id > 0 { var i :| 0 <= i < |t.calls| && t.calls[i] == c; assert s.calls[i] in s.calls; }
  }
  forall p ensures knownCall(t, p) == knownCall(s, p) && callAt(t, p).actionName == callAt(s, p).actionName && callAt(t, p).role == callAt(s, p).role && (p != s.calls[k].id ==> callAt(t, p) == callAt(s, p)) {
    CallAt(s, p);
    CallAt(t, p);
    if knownCall(s, p) {
      var c :| c in s.calls && c.id == p;
      var j :| 0 <= j < |s.calls| && s.calls[j] == c;
      assert t.calls[j] in t.calls;
    } else if knownCall(t, p) {
      var c :| c in t.calls && c.id == p;
      var j :| 0 <= j < |t.calls| && t.calls[j] == c;
      assert s.calls[j] in s.calls;
    }
  }
  CallAt(s, s.calls[k].id);
  CallAt(t, s.calls[k].id);
}

lemma Extend(s: Planning, t: Planning, n: PlannedCall)
  requires inv(s) && t.registry == s.registry && t.calls == s.calls + [n] && n.id > 0 && !knownCall(s, n.id)
  ensures alwaysCallIdentitiesUnique(t)
  ensures forall p :: knownCall(t, p) == (knownCall(s, p) || p == n.id)
  ensures forall p :: knownCall(s, p) ==> callAt(t, p) == callAt(s, p)
  ensures callAt(t, n.id) == n
  ensures forall c: PlannedCall :: (c.parent == 0 || knownCall(s, c.parent)) ==> permitted(t, c) == permitted(s, c)
{
  Views(s);
  Views(t);
  assert forall c :: c in s.calls ==> c.id != n.id;
  forall p | knownCall(s, p) ensures callAt(t, p) == callAt(s, p) {
    CallAt(s, p);
    CallAt(t, p);
    var c :| c in s.calls && c.id == p;
    var j :| 0 <= j < |s.calls| && s.calls[j] == c;
    assert t.calls[j] == c;
  }
  CallAt(t, n.id);
  assert t.calls[|s.calls|] == n;
}

lemma registerAction_ensures(s: Planning, decl: ActionDecl)
  ensures (inv(s) ==> canRegisterAction(s, decl) ==> alwaysActionNamesUnique(registerAction(s, decl)))
  ensures (inv(s) ==> canRegisterAction(s, decl) ==> alwaysRejectionNamesItsReason(registerAction(s, decl)))
  ensures (inv(s) ==> canRegisterAction(s, decl) ==> alwaysOnlyPermittedCallsRun(registerAction(s, decl)))
  ensures (inv(s) ==> canRegisterAction(s, decl) ==> alwaysSubactionWithinParentAuthority(registerAction(s, decl)))
  ensures (inv(s) ==> canRegisterAction(s, decl) ==> alwaysParentSettlesAfterSubactions(registerAction(s, decl)))
  ensures (inv(s) ==> canRegisterAction(s, decl) ==> alwaysCallIdentitiesUnique(registerAction(s, decl)))
  ensures (inv(s) ==> canRegisterAction(s, decl) ==> stepInvokedOnlyAfterValidation(s, registerAction(s, decl)))
  ensures (inv(s) ==> canRegisterAction(s, decl) ==> stepSettledCallKeepsItsOutcome(s, registerAction(s, decl)))
{
  if inv(s) && canRegisterAction(s, decl) {
    var t := registerAction(s, decl);
    Views(s);
    Views(t);
    assert forall d :: d in s.registry ==> d.name != decl.name;
    forall n | registered(s, n) ensures registered(t, n) && declOf(t, n) == declOf(s, n) {
      DeclAt(s, n);
      DeclAt(t, n);
      var d :| d in s.registry && d.name == n;
      var j :| 0 <= j < |s.registry| && s.registry[j] == d;
      assert t.registry[j] == d;
    }
    forall n | !registered(s, n) ensures declOf(s, n) == noDecl { DeclAt(s, n); }
    assert forall c :: c in t.calls ==> callAt(t, c.parent) == callAt(s, c.parent);
  }
}

lemma planCall_ensures(s: Planning, id: int, actionName: string, role: core__authorization_Role)
  ensures (inv(s) ==> canPlanCall(s, id, actionName, role) ==> alwaysActionNamesUnique(planCall(s, id, actionName, role)))
  ensures (inv(s) ==> canPlanCall(s, id, actionName, role) ==> alwaysRejectionNamesItsReason(planCall(s, id, actionName, role)))
  ensures (inv(s) ==> canPlanCall(s, id, actionName, role) ==> alwaysOnlyPermittedCallsRun(planCall(s, id, actionName, role)))
  ensures (inv(s) ==> canPlanCall(s, id, actionName, role) ==> alwaysSubactionWithinParentAuthority(planCall(s, id, actionName, role)))
  ensures (inv(s) ==> canPlanCall(s, id, actionName, role) ==> alwaysParentSettlesAfterSubactions(planCall(s, id, actionName, role)))
  ensures (inv(s) ==> canPlanCall(s, id, actionName, role) ==> alwaysCallIdentitiesUnique(planCall(s, id, actionName, role)))
  ensures (inv(s) ==> canPlanCall(s, id, actionName, role) ==> stepInvokedOnlyAfterValidation(s, planCall(s, id, actionName, role)))
  ensures (inv(s) ==> canPlanCall(s, id, actionName, role) ==> stepSettledCallKeepsItsOutcome(s, planCall(s, id, actionName, role)))
{
  if inv(s) && canPlanCall(s, id, actionName, role) {
    var t := planCall(s, id, actionName, role);
    Extend(s, t, PlannedCall(id, actionName, 0, role, false, CallPhase.Planned, RejectReason.NotRejected));
    forall b | b in s.calls ensures b in t.calls {
      var j :| 0 <= j < |s.calls| && s.calls[j] == b;
      assert t.calls[j] == b;
    }
  }
}

lemma validateCall_ensures(s: Planning, id: int, argsValid: bool)
  ensures (inv(s) ==> canValidateCall(s, id, argsValid) ==> alwaysActionNamesUnique(validateCall(s, id, argsValid)))
  ensures (inv(s) ==> canValidateCall(s, id, argsValid) ==> alwaysRejectionNamesItsReason(validateCall(s, id, argsValid)))
  ensures (inv(s) ==> canValidateCall(s, id, argsValid) ==> alwaysOnlyPermittedCallsRun(validateCall(s, id, argsValid)))
  ensures (inv(s) ==> canValidateCall(s, id, argsValid) ==> alwaysSubactionWithinParentAuthority(validateCall(s, id, argsValid)))
  ensures (inv(s) ==> canValidateCall(s, id, argsValid) ==> alwaysParentSettlesAfterSubactions(validateCall(s, id, argsValid)))
  ensures (inv(s) ==> canValidateCall(s, id, argsValid) ==> alwaysCallIdentitiesUnique(validateCall(s, id, argsValid)))
  ensures (inv(s) ==> canValidateCall(s, id, argsValid) ==> stepInvokedOnlyAfterValidation(s, validateCall(s, id, argsValid)))
  ensures (inv(s) ==> canValidateCall(s, id, argsValid) ==> stepSettledCallKeepsItsOutcome(s, validateCall(s, id, argsValid)))
{
  if inv(s) && canValidateCall(s, id, argsValid) {
    var t := validateCall(s, id, argsValid);
    Views(s);
    var c :| c in s.calls && c.id == id;
    var k :| 0 <= k < |s.calls| && s.calls[k] == c;
    CallAt(s, id);
    assert forall i :: 0 <= i < |s.calls| && i != k ==> s.calls[i].id != id;
    Remap(s, t, k);
    ValidateOnlyPermitted(s, id, argsValid, k);
    assert forall q :: q in s.calls && q.parent != 0 ==> q.parent != id;
    assert forall i :: 0 <= i < |t.calls| ==> t.calls[i] in t.calls && s.calls[i] in s.calls;
  }
}

// The validated call is permitted exactly when its verdict is NotRejected,
// and every other call keeps its phase and its permission.
lemma ValidateOnlyPermitted(s: Planning, id: int, argsValid: bool, k: int)
  requires inv(s) && 0 <= k < |s.calls| && s.calls[k].id == id
  requires forall i :: 0 <= i < |s.calls| && i != k ==> s.calls[i].id != id
  requires callAt(s, id) == s.calls[k]
  requires forall c :: permitted(validateCall(s, id, argsValid), c) == permitted(s, c)
  ensures alwaysOnlyPermittedCallsRun(validateCall(s, id, argsValid))
{
}

lemma invokeCall_ensures(s: Planning, id: int)
  ensures (inv(s) ==> canInvokeCall(s, id) ==> alwaysActionNamesUnique(invokeCall(s, id)))
  ensures (inv(s) ==> canInvokeCall(s, id) ==> alwaysRejectionNamesItsReason(invokeCall(s, id)))
  ensures (inv(s) ==> canInvokeCall(s, id) ==> alwaysOnlyPermittedCallsRun(invokeCall(s, id)))
  ensures (inv(s) ==> canInvokeCall(s, id) ==> alwaysSubactionWithinParentAuthority(invokeCall(s, id)))
  ensures (inv(s) ==> canInvokeCall(s, id) ==> alwaysParentSettlesAfterSubactions(invokeCall(s, id)))
  ensures (inv(s) ==> canInvokeCall(s, id) ==> alwaysCallIdentitiesUnique(invokeCall(s, id)))
  ensures (inv(s) ==> canInvokeCall(s, id) ==> stepInvokedOnlyAfterValidation(s, invokeCall(s, id)))
  ensures (inv(s) ==> canInvokeCall(s, id) ==> stepSettledCallKeepsItsOutcome(s, invokeCall(s, id)))
{
  if inv(s) && canInvokeCall(s, id) {
    var t := invokeCall(s, id);
    Views(s);
    var c :| c in s.calls && c.id == id;
    var k :| 0 <= k < |s.calls| && s.calls[k] == c;
    CallAt(s, id);
    assert forall i :: 0 <= i < |s.calls| && i != k ==> s.calls[i].id != id;
    Remap(s, t, k);
    assert forall i :: 0 <= i < |t.calls| ==> t.calls[i] in t.calls && s.calls[i] in s.calls;
  }
}

lemma planSubaction_ensures(s: Planning, id: int, parent: int, actionName: string)
  ensures (inv(s) ==> canPlanSubaction(s, id, parent, actionName) ==> alwaysActionNamesUnique(planSubaction(s, id, parent, actionName)))
  ensures (inv(s) ==> canPlanSubaction(s, id, parent, actionName) ==> alwaysRejectionNamesItsReason(planSubaction(s, id, parent, actionName)))
  ensures (inv(s) ==> canPlanSubaction(s, id, parent, actionName) ==> alwaysOnlyPermittedCallsRun(planSubaction(s, id, parent, actionName)))
  ensures (inv(s) ==> canPlanSubaction(s, id, parent, actionName) ==> alwaysSubactionWithinParentAuthority(planSubaction(s, id, parent, actionName)))
  ensures (inv(s) ==> canPlanSubaction(s, id, parent, actionName) ==> alwaysParentSettlesAfterSubactions(planSubaction(s, id, parent, actionName)))
  ensures (inv(s) ==> canPlanSubaction(s, id, parent, actionName) ==> alwaysCallIdentitiesUnique(planSubaction(s, id, parent, actionName)))
  ensures (inv(s) ==> canPlanSubaction(s, id, parent, actionName) ==> stepInvokedOnlyAfterValidation(s, planSubaction(s, id, parent, actionName)))
  ensures (inv(s) ==> canPlanSubaction(s, id, parent, actionName) ==> stepSettledCallKeepsItsOutcome(s, planSubaction(s, id, parent, actionName)))
{
  if inv(s) && canPlanSubaction(s, id, parent, actionName) {
    var t := planSubaction(s, id, parent, actionName);
    Views(s);
    CallAt(s, parent);
    Extend(s, t, PlannedCall(id, actionName, parent, callAt(s, parent).role, false, CallPhase.Planned, RejectReason.NotRejected));
    forall b | b in s.calls ensures b in t.calls {
      var j :| 0 <= j < |s.calls| && s.calls[j] == b;
      assert t.calls[j] == b;
    }
    assert forall q :: q in s.calls && q.id == parent ==> q == callAt(s, parent) by {
      forall q | q in s.calls && q.id == parent ensures q == callAt(s, parent) { var j :| 0 <= j < |s.calls| && s.calls[j] == q; }
    }
  }
}

lemma settleCall_ensures(s: Planning, id: int, ok: bool)
  ensures (inv(s) ==> canSettleCall(s, id, ok) ==> alwaysActionNamesUnique(settleCall(s, id, ok)))
  ensures (inv(s) ==> canSettleCall(s, id, ok) ==> alwaysRejectionNamesItsReason(settleCall(s, id, ok)))
  ensures (inv(s) ==> canSettleCall(s, id, ok) ==> alwaysOnlyPermittedCallsRun(settleCall(s, id, ok)))
  ensures (inv(s) ==> canSettleCall(s, id, ok) ==> alwaysSubactionWithinParentAuthority(settleCall(s, id, ok)))
  ensures (inv(s) ==> canSettleCall(s, id, ok) ==> alwaysParentSettlesAfterSubactions(settleCall(s, id, ok)))
  ensures (inv(s) ==> canSettleCall(s, id, ok) ==> alwaysCallIdentitiesUnique(settleCall(s, id, ok)))
  ensures (inv(s) ==> canSettleCall(s, id, ok) ==> stepInvokedOnlyAfterValidation(s, settleCall(s, id, ok)))
  ensures (inv(s) ==> canSettleCall(s, id, ok) ==> stepSettledCallKeepsItsOutcome(s, settleCall(s, id, ok)))
{
  if inv(s) && canSettleCall(s, id, ok) {
    var t := settleCall(s, id, ok);
    Views(s);
    var c :| c in s.calls && c.id == id;
    var k :| 0 <= k < |s.calls| && s.calls[k] == c;
    CallAt(s, id);
    assert forall i :: 0 <= i < |s.calls| && i != k ==> s.calls[i].id != id;
    Remap(s, t, k);
    assert forall i :: 0 <= i < |t.calls| ==> t.calls[i] in t.calls && s.calls[i] in s.calls;
  }
}
