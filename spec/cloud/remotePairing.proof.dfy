lemma AtMostOne<T>(p: T -> bool, xs: seq<T>)
  ensures |ProofLib.Filter(p, xs)| <= 1 <==> forall i, j :: 0 <= i < |xs| && 0 <= j < |xs| && p(xs[i]) && p(xs[j]) ==> i == j
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    AtMostOne(p, xs[1..]);
    ProofLib.FilterNone(p, xs[1..]);
    if forall i, j :: 0 <= i < |xs| && 0 <= j < |xs| && p(xs[i]) && p(xs[j]) ==> i == j {
      forall i, j | 0 <= i < |xs[1..]| && 0 <= j < |xs[1..]| && p(xs[1..][i]) && p(xs[1..][j])
        ensures i == j
      {
        assert xs[1..][i] == xs[i + 1] && xs[1..][j] == xs[j + 1];
      }
      if p(xs[0]) {
        forall k | 0 <= k < |xs[1..]|
          ensures !p(xs[1..][k])
        {
          assert xs[1..][k] == xs[k + 1];
        }
      }
    } else {
      var i, j :| 0 <= i < |xs| && 0 <= j < |xs| && p(xs[i]) && p(xs[j]) && i != j;
      ProofLib.FilterTwo(p, xs, i, j);
    }
  }
}

lemma UnclaimedKept(s: Remote, t: Remote)
  requires alwaysOneUnclaimedPairing(s)
  requires |t.sessions| == |s.sessions|
  requires forall i :: 0 <= i < |s.sessions| && unstaged(t.sessions[i].status) ==> unstaged(s.sessions[i].status)
  ensures alwaysOneUnclaimedPairing(t)
{
  AtMostOne((r: RemoteSession) => unstaged(r.status), s.sessions);
  AtMostOne((r: RemoteSession) => unstaged(r.status), t.sessions);
}

lemma SessionLookup(s: Remote, id: int)
  ensures hasSession(s, id) ==> sessionOf(s, id) in s.sessions && sessionOf(s, id).id == id
  ensures !hasSession(s, id) ==> sessionOf(s, id) == noSession
  ensures alwaysOnePairingPerId(s) ==> forall r :: r in s.sessions && r.id == id ==> sessionOf(s, id) == r
{
  ProofLib.FilterNone((r: RemoteSession) => (r.id == id), s.sessions);
  if hasSession(s, id) {
    var w :| w in s.sessions && w.id == id;
    var k :| 0 <= k < |s.sessions| && s.sessions[k] == w;
    assert s.sessions[k].id == id;
    var found := ProofLib.Filter((r: RemoteSession) => (r.id == id), s.sessions);
    assert found[0] in found;
    ProofLib.FilterMember((r: RemoteSession) => (r.id == id), s.sessions, found[0]);
  } else {
    forall k | 0 <= k < |s.sessions|
      ensures s.sessions[k].id != id
    {
      assert s.sessions[k] in s.sessions;
    }
  }
}

lemma CommandLookup(s: Remote, command: int)
  ensures (exists c :: c in s.commands && c.command == command) ==> commandOf(s, command) in s.commands && commandOf(s, command).command == command
  ensures !(exists c :: c in s.commands && c.command == command) ==> commandOf(s, command) == noCommand
  ensures alwaysOneCommandPerNumber(s) ==> forall c :: c in s.commands && c.command == command ==> commandOf(s, command) == c
{
  ProofLib.FilterNone((c: RemoteCommand) => (c.command == command), s.commands);
  if exists c :: c in s.commands && c.command == command {
    var w :| w in s.commands && w.command == command;
    var k :| 0 <= k < |s.commands| && s.commands[k] == w;
    assert s.commands[k].command == command;
    var found := ProofLib.Filter((c: RemoteCommand) => (c.command == command), s.commands);
    assert found[0] in found;
    ProofLib.FilterMember((c: RemoteCommand) => (c.command == command), s.commands, found[0]);
  } else {
    forall k | 0 <= k < |s.commands|
      ensures s.commands[k].command != command
    {
      assert s.commands[k] in s.commands;
    }
  }
}

lemma SessionsMapped(s: Remote, t: Remote, f: RemoteSession -> RemoteSession)
  requires alwaysOnePairingPerId(s)
  requires |t.sessions| >= |s.sessions|
  requires forall i :: 0 <= i < |s.sessions| ==> t.sessions[i] == f(s.sessions[i]) && t.sessions[i].id == s.sessions[i].id
  requires forall i :: |s.sessions| <= i < |t.sessions| ==> t.sessions[i].id > 0
  requires forall i, j :: |s.sessions| <= i < |t.sessions| && 0 <= j < |t.sessions| && i != j ==> t.sessions[i].id != t.sessions[j].id
  ensures alwaysOnePairingPerId(t)
  ensures forall r :: r in s.sessions ==> hasSession(t, r.id) && sessionOf(t, r.id) == f(r)
  ensures forall x :: x in t.sessions ==> sessionOf(t, x.id) == x
  ensures (forall r :: r in s.sessions ==> f(r).pairUntil == r.pairUntil && f(r).grantUntil == r.grantUntil && (r.controller != 0 ==> f(r).controller == r.controller) && (r.confirmed ==> f(r).confirmed) && (r.committedAt >= 0 ==> f(r).committedAt == r.committedAt) && ((r.status.SessionDenied? || r.status.SessionRevoked? || r.status.SessionExpired?) ==> f(r).status == r.status)) ==> stepPairingOwnershipIsDurable(s, t)
{
  forall a | a in t.sessions
    ensures a.id > 0
  {
    var i :| 0 <= i < |t.sessions| && t.sessions[i] == a;
    if i < |s.sessions| {
      assert s.sessions[i] in s.sessions;
    }
  }
  forall a, b | a in t.sessions && b in t.sessions && a.id == b.id
    ensures a == b
  {
    var i :| 0 <= i < |t.sessions| && t.sessions[i] == a;
    var j :| 0 <= j < |t.sessions| && t.sessions[j] == b;
    if i < |s.sessions| && j < |s.sessions| {
      assert s.sessions[i] in s.sessions && s.sessions[j] in s.sessions;
    }
  }
  assert alwaysOnePairingPerId(t);
  forall r | r in s.sessions
    ensures hasSession(t, r.id) && sessionOf(t, r.id) == f(r)
  {
    var i :| 0 <= i < |s.sessions| && s.sessions[i] == r;
    assert t.sessions[i] in t.sessions;
    SessionLookup(t, r.id);
  }
  forall x | x in t.sessions
    ensures sessionOf(t, x.id) == x
  {
    SessionLookup(t, x.id);
  }
}

lemma CommandsMapped(s: Remote, t: Remote, g: RemoteCommand -> RemoteCommand)
  requires alwaysOneCommandPerNumber(s)
  requires |t.commands| >= |s.commands|
  requires forall i :: 0 <= i < |s.commands| ==> t.commands[i] == g(s.commands[i]) && t.commands[i].command == s.commands[i].command
  requires forall i, j :: |s.commands| <= i < |t.commands| && 0 <= j < |t.commands| && i != j ==> t.commands[i].command != t.commands[j].command
  ensures alwaysOneCommandPerNumber(t)
  ensures (forall c :: c in s.commands && !commandOpen(c.status) ==> g(c) == c) ==> stepSettledCommandIsFinal(s, t)
{
  forall a, b | a in t.commands && b in t.commands && a.command == b.command
    ensures a == b
  {
    var i :| 0 <= i < |t.commands| && t.commands[i] == a;
    var j :| 0 <= j < |t.commands| && t.commands[j] == b;
    if i < |s.commands| && j < |s.commands| {
      assert s.commands[i] in s.commands && s.commands[j] in s.commands;
    }
  }
  assert alwaysOneCommandPerNumber(t);
  forall c | c in s.commands
    ensures commandOf(t, c.command) == g(c)
  {
    var i :| 0 <= i < |s.commands| && s.commands[i] == c;
    assert t.commands[i] in t.commands;
    CommandLookup(t, c.command);
  }
}

lemma SameCommands(s: Remote, t: Remote)
  requires alwaysOneCommandPerNumber(s)
  requires t.commands == s.commands
  ensures stepSettledCommandIsFinal(s, t)
{
  CommandsMapped(s, t, (c: RemoteCommand) => c);
}

lemma SameRows(s: Remote, t: Remote)
  requires alwaysOnePairingPerId(s) && alwaysOneCommandPerNumber(s)
  requires t.sessions == s.sessions && t.commands == s.commands
  ensures stepPairingOwnershipIsDurable(s, t) && stepSettledCommandIsFinal(s, t)
{
  SessionsMapped(s, t, (r: RemoteSession) => r);
  SameCommands(s, t);
}

lemma PutSession(s: Remote, t: Remote, prev: RemoteSession, row: RemoteSession)
  requires alwaysOnePairingPerId(s) && alwaysOneUnclaimedPairing(s) && alwaysOneCommandPerNumber(s)
  requires prev == sessionOf(s, row.id) && t.sessions == putSession(s, row) && t.commands == s.commands
  ensures alwaysOnePairingPerId(t)
  ensures forall x :: x in t.sessions ==> x in s.sessions || x == row
  ensures forall x :: x in t.sessions ==> sessionOf(t, x.id) == x
  ensures stepSettledCommandIsFinal(s, t)
  ensures (row.pairUntil == prev.pairUntil && row.grantUntil == prev.grantUntil && (prev.controller != 0 ==> row.controller == prev.controller) && (prev.confirmed ==> row.confirmed) && (prev.committedAt >= 0 ==> row.committedAt == prev.committedAt) && ((prev.status.SessionDenied? || prev.status.SessionRevoked? || prev.status.SessionExpired?) ==> row.status == prev.status)) ==> stepPairingOwnershipIsDurable(s, t)
  ensures (unstaged(row.status) ==> unstaged(prev.status)) ==> alwaysOneUnclaimedPairing(t)
{
  SessionLookup(s, row.id);
  SessionsMapped(s, t, (r: RemoteSession) => (if (r.id == row.id) then row else r));
  forall x | x in t.sessions
    ensures x in s.sessions || x == row
  {
    var i :| 0 <= i < |t.sessions| && t.sessions[i] == x;
    assert s.sessions[i] in s.sessions;
  }
  SameCommands(s, t);
  if unstaged(row.status) ==> unstaged(prev.status) {
    forall i | 0 <= i < |s.sessions| && unstaged(t.sessions[i].status)
      ensures unstaged(s.sessions[i].status)
    {
      assert s.sessions[i] in s.sessions;
    }
    UnclaimedKept(s, t);
  }
}

lemma CommandsNeedCommitted(s: Remote, t: Remote)
  requires alwaysCommandsNeedCommittedPairing(s) && alwaysOnePairingPerId(s)
  requires forall x :: x in t.sessions ==> sessionOf(t, x.id) == x
  requires t.hostActive == s.hostActive && t.now == s.now
  requires forall r :: r in t.sessions && r !in s.sessions && r.status.SessionActive? && t.hostActive && t.now < r.grantUntil ==> r.confirmed && r.committedAt >= 0
  ensures alwaysCommandsNeedCommittedPairing(t)
{
  forall r | r in t.sessions && permitsCommands(t, r.id)
    ensures r.confirmed && r.committedAt >= 0
  {
    if r in s.sessions {
      SessionLookup(s, r.id);
    }
  }
}

lemma issueCode_ensures(s: Remote, operator: bool, pairingEnabled: bool, access: PairAccess)
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysPairingCoordinates(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysTransientPairReplyKeepsCode(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysOneUnclaimedPairing(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysPendingHoldsOnlyVerifier(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysClaimedHasController(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysActivationIsConfirmed(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysCommittedBeforeDeadline(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysCommitTimeIsSetOnlyByCommit(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysCommandsNeedCommittedPairing(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysOnePairingPerId(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysOneCommandPerNumber(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysClaimedCommandHoldsItsClaim(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysLiveHostHasNoRevocationReceipt(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysCancelledCommandDropsClaim(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysStartedCommandBecomesAmbiguous(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysRevokedPairingHasNoVerifier(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysReceiptCoversOutstandingRows(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> alwaysRevokedHostKeepsOnlyLockedWork(issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> stepFinishedMintCannotBeRepeated(s, "issueCode", issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> stepPairingOwnershipIsDurable(s, issueCode(s, operator, pairingEnabled, access)))
  ensures (inv(s) ==> canIssueCode(s, operator, pairingEnabled) ==> stepSettledCommandIsFinal(s, issueCode(s, operator, pairingEnabled, access)))
{
  if inv(s) && canIssueCode(s, operator, pairingEnabled) {
    SameRows(s, issueCode(s, operator, pairingEnabled, access));
  }
}

lemma redeemCode_ensures(s: Remote, pairingEnabled: bool, peerKnown: bool, instanceExact: bool, tokenExact: bool, codeExpired: bool, hasBudget: bool, storeReady: bool)
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysPairingCoordinates(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysTransientPairReplyKeepsCode(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysOneUnclaimedPairing(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysPendingHoldsOnlyVerifier(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysClaimedHasController(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysActivationIsConfirmed(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysCommittedBeforeDeadline(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysCommitTimeIsSetOnlyByCommit(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysCommandsNeedCommittedPairing(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysOnePairingPerId(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysOneCommandPerNumber(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysClaimedCommandHoldsItsClaim(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysLiveHostHasNoRevocationReceipt(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysCancelledCommandDropsClaim(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysStartedCommandBecomesAmbiguous(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysRevokedPairingHasNoVerifier(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysReceiptCoversOutstandingRows(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> alwaysRevokedHostKeepsOnlyLockedWork(redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> stepFinishedMintCannotBeRepeated(s, "redeemCode", redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> stepPairingOwnershipIsDurable(s, redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
  ensures (inv(s) ==> canRedeemCode(s) ==> stepSettledCommandIsFinal(s, redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady)))
{
  if inv(s) && canRedeemCode(s) {
    SameRows(s, redeemCode(s, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady));
  }
}

lemma finishMint_ensures(s: Remote, saved: bool)
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysPairingCoordinates(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysTransientPairReplyKeepsCode(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysOneUnclaimedPairing(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysPendingHoldsOnlyVerifier(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysClaimedHasController(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysActivationIsConfirmed(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysCommittedBeforeDeadline(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysCommitTimeIsSetOnlyByCommit(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysCommandsNeedCommittedPairing(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysOnePairingPerId(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysOneCommandPerNumber(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysClaimedCommandHoldsItsClaim(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysLiveHostHasNoRevocationReceipt(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysCancelledCommandDropsClaim(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysStartedCommandBecomesAmbiguous(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysRevokedPairingHasNoVerifier(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysReceiptCoversOutstandingRows(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> alwaysRevokedHostKeepsOnlyLockedWork(finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> stepFinishedMintCannotBeRepeated(s, "finishMint", finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> stepPairingOwnershipIsDurable(s, finishMint(s, saved)))
  ensures (inv(s) ==> canFinishMint(s) ==> stepSettledCommandIsFinal(s, finishMint(s, saved)))
{
  if inv(s) && canFinishMint(s) {
    SameRows(s, finishMint(s, saved));
  }
}

lemma tick_ensures(s: Remote)
  ensures (inv(s) ==> canTick(s) ==> alwaysPairingCoordinates(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysTransientPairReplyKeepsCode(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysOneUnclaimedPairing(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysPendingHoldsOnlyVerifier(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysClaimedHasController(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysActivationIsConfirmed(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysCommittedBeforeDeadline(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysCommitTimeIsSetOnlyByCommit(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysCommandsNeedCommittedPairing(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysOnePairingPerId(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysOneCommandPerNumber(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysClaimedCommandHoldsItsClaim(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysLiveHostHasNoRevocationReceipt(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysCancelledCommandDropsClaim(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysStartedCommandBecomesAmbiguous(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysRevokedPairingHasNoVerifier(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysReceiptCoversOutstandingRows(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysRevokedHostKeepsOnlyLockedWork(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> stepFinishedMintCannotBeRepeated(s, "tick", tick(s)))
  ensures (inv(s) ==> canTick(s) ==> stepPairingOwnershipIsDurable(s, tick(s)))
  ensures (inv(s) ==> canTick(s) ==> stepSettledCommandIsFinal(s, tick(s)))
{
  if inv(s) && canTick(s) {
    SameRows(s, tick(s));
  }
}

lemma issueSession_ensures(s: Remote, id: int, authenticated: bool)
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysPairingCoordinates(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysTransientPairReplyKeepsCode(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysOneUnclaimedPairing(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysPendingHoldsOnlyVerifier(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysClaimedHasController(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysActivationIsConfirmed(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysCommittedBeforeDeadline(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysCommitTimeIsSetOnlyByCommit(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysCommandsNeedCommittedPairing(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysOnePairingPerId(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysOneCommandPerNumber(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysClaimedCommandHoldsItsClaim(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysLiveHostHasNoRevocationReceipt(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysCancelledCommandDropsClaim(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysStartedCommandBecomesAmbiguous(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysRevokedPairingHasNoVerifier(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysReceiptCoversOutstandingRows(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> alwaysRevokedHostKeepsOnlyLockedWork(issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> stepFinishedMintCannotBeRepeated(s, "issueSession", issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> stepPairingOwnershipIsDurable(s, issueSession(s, id, authenticated)))
  ensures (inv(s) ==> canIssueSession(s, id, authenticated) ==> stepSettledCommandIsFinal(s, issueSession(s, id, authenticated)))
{
  if inv(s) && canIssueSession(s, id, authenticated) {
    var t := issueSession(s, id, authenticated);
    var f := (r: RemoteSession) => (if (r.status.SessionPending? && codeExpiredAt(r, s.now)) then ended(r, SessionStatus.SessionExpired) else (if unstaged(r.status) then ended(r, SessionStatus.SessionDenied) else r));
    var n := |s.sessions|;
    assert |t.sessions| == n + 1 && t.sessions[n].id == id;
    forall i | 0 <= i < n
      ensures t.sessions[i] == f(s.sessions[i]) && t.sessions[i].id == s.sessions[i].id && !unstaged(t.sessions[i].status) && t.sessions[i].id != id
      ensures t.sessions[i].status.SessionActive? ==> t.sessions[i] == s.sessions[i]
    {
      assert s.sessions[i] in s.sessions;
    }
    SessionsMapped(s, t, f);
    SameCommands(s, t);
    AtMostOne((r: RemoteSession) => unstaged(r.status), t.sessions);
    forall r | r in t.sessions && r.status.SessionActive?
      ensures r in s.sessions
    {
      var i :| 0 <= i < |t.sessions| && t.sessions[i] == r;
      assert s.sessions[i] in s.sessions;
    }
    CommandsNeedCommitted(s, t);
  }
}

lemma claimSession_ensures(s: Remote, id: int, controller: int, codeMatches: bool)
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysPairingCoordinates(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysTransientPairReplyKeepsCode(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysOneUnclaimedPairing(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysPendingHoldsOnlyVerifier(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysClaimedHasController(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysActivationIsConfirmed(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysCommittedBeforeDeadline(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysCommitTimeIsSetOnlyByCommit(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysCommandsNeedCommittedPairing(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysOnePairingPerId(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysOneCommandPerNumber(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysClaimedCommandHoldsItsClaim(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysLiveHostHasNoRevocationReceipt(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysCancelledCommandDropsClaim(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysStartedCommandBecomesAmbiguous(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysRevokedPairingHasNoVerifier(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysReceiptCoversOutstandingRows(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> alwaysRevokedHostKeepsOnlyLockedWork(claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> stepFinishedMintCannotBeRepeated(s, "claimSession", claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> stepPairingOwnershipIsDurable(s, claimSession(s, id, controller, codeMatches)))
  ensures (inv(s) ==> canClaimSession(s, id, controller, codeMatches) ==> stepSettledCommandIsFinal(s, claimSession(s, id, controller, codeMatches)))
{
  if inv(s) && canClaimSession(s, id, controller, codeMatches) {
    var t := claimSession(s, id, controller, codeMatches);
    var prev := sessionOf(s, id);
    SessionLookup(s, prev.id);
    PutSession(s, t, prev, prev.(status := SessionStatus.SessionClaimed, verifier := false, controller := controller));
    CommandsNeedCommitted(s, t);
  }
}

lemma dropObservation_ensures(s: Remote)
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysPairingCoordinates(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysTransientPairReplyKeepsCode(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysOneUnclaimedPairing(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysPendingHoldsOnlyVerifier(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysClaimedHasController(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysActivationIsConfirmed(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysCommittedBeforeDeadline(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysCommitTimeIsSetOnlyByCommit(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysCommandsNeedCommittedPairing(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysOnePairingPerId(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysOneCommandPerNumber(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysClaimedCommandHoldsItsClaim(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysLiveHostHasNoRevocationReceipt(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysCancelledCommandDropsClaim(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysStartedCommandBecomesAmbiguous(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysRevokedPairingHasNoVerifier(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysReceiptCoversOutstandingRows(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> alwaysRevokedHostKeepsOnlyLockedWork(dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> stepFinishedMintCannotBeRepeated(s, "dropObservation", dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> stepPairingOwnershipIsDurable(s, dropObservation(s)))
  ensures (inv(s) ==> canDropObservation(s) ==> stepSettledCommandIsFinal(s, dropObservation(s)))
{
  if inv(s) && canDropObservation(s) {
    SameRows(s, dropObservation(s));
  }
}

lemma observeClaim_ensures(s: Remote, id: int, authenticated: bool)
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysPairingCoordinates(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysTransientPairReplyKeepsCode(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysOneUnclaimedPairing(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysPendingHoldsOnlyVerifier(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysClaimedHasController(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysActivationIsConfirmed(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysCommittedBeforeDeadline(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysCommitTimeIsSetOnlyByCommit(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysCommandsNeedCommittedPairing(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysOnePairingPerId(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysOneCommandPerNumber(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysClaimedCommandHoldsItsClaim(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysLiveHostHasNoRevocationReceipt(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysCancelledCommandDropsClaim(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysStartedCommandBecomesAmbiguous(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysRevokedPairingHasNoVerifier(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysReceiptCoversOutstandingRows(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> alwaysRevokedHostKeepsOnlyLockedWork(observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> stepFinishedMintCannotBeRepeated(s, "observeClaim", observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> stepPairingOwnershipIsDurable(s, observeClaim(s, id, authenticated)))
  ensures (inv(s) ==> canObserveClaim(s, id, authenticated) ==> stepSettledCommandIsFinal(s, observeClaim(s, id, authenticated)))
{
  if inv(s) && canObserveClaim(s, id, authenticated) {
    var t := observeClaim(s, id, authenticated);
    var prev := sessionOf(s, id);
    SessionLookup(s, id);
    if unstaged(prev.status) && codeExpiredAt(prev, s.now) {
      PutSession(s, t, prev, ended(prev, SessionStatus.SessionExpired));
      CommandsNeedCommitted(s, t);
    } else {
      SameRows(s, t);
    }
  }
}

lemma confirmClaim_ensures(s: Remote)
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysPairingCoordinates(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysTransientPairReplyKeepsCode(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysOneUnclaimedPairing(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysPendingHoldsOnlyVerifier(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysClaimedHasController(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysActivationIsConfirmed(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysCommittedBeforeDeadline(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysCommitTimeIsSetOnlyByCommit(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysCommandsNeedCommittedPairing(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysOnePairingPerId(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysOneCommandPerNumber(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysClaimedCommandHoldsItsClaim(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysLiveHostHasNoRevocationReceipt(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysCancelledCommandDropsClaim(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysStartedCommandBecomesAmbiguous(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysRevokedPairingHasNoVerifier(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysReceiptCoversOutstandingRows(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> alwaysRevokedHostKeepsOnlyLockedWork(confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> stepFinishedMintCannotBeRepeated(s, "confirmClaim", confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> stepPairingOwnershipIsDurable(s, confirmClaim(s)))
  ensures (inv(s) ==> canConfirmClaim(s) ==> stepSettledCommandIsFinal(s, confirmClaim(s)))
{
  if inv(s) && canConfirmClaim(s) {
    var t := confirmClaim(s);
    var prev := sessionOf(s, s.observedClaim);
    SessionLookup(s, prev.id);
    SessionLookup(s, s.observedClaim);
    PutSession(s, t, prev, (if (!(s.hostActive) || (!prev.status.SessionClaimed?)) then prev else (if codeExpiredAt(prev, s.now) then ended(prev, SessionStatus.SessionExpired) else prev.(status := SessionStatus.SessionActivating, confirmed := true))));
    CommandsNeedCommitted(s, t);
  }
}

lemma compensate_ensures(s: Remote, id: int, authenticated: bool)
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysPairingCoordinates(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysTransientPairReplyKeepsCode(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysOneUnclaimedPairing(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysPendingHoldsOnlyVerifier(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysClaimedHasController(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysActivationIsConfirmed(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysCommittedBeforeDeadline(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysCommitTimeIsSetOnlyByCommit(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysCommandsNeedCommittedPairing(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysOnePairingPerId(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysOneCommandPerNumber(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysClaimedCommandHoldsItsClaim(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysLiveHostHasNoRevocationReceipt(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysCancelledCommandDropsClaim(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysStartedCommandBecomesAmbiguous(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysRevokedPairingHasNoVerifier(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysReceiptCoversOutstandingRows(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> alwaysRevokedHostKeepsOnlyLockedWork(compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> stepFinishedMintCannotBeRepeated(s, "compensate", compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> stepPairingOwnershipIsDurable(s, compensate(s, id, authenticated)))
  ensures (inv(s) ==> canCompensate(s, id, authenticated) ==> stepSettledCommandIsFinal(s, compensate(s, id, authenticated)))
{
  if inv(s) && canCompensate(s, id, authenticated) {
    var t := compensate(s, id, authenticated);
    var prev := sessionOf(s, id);
    SessionLookup(s, prev.id);
    PutSession(s, t, prev, ended(prev, SessionStatus.SessionDenied));
    CommandsNeedCommitted(s, t);
  }
}

lemma commitSession_ensures(s: Remote, id: int, authenticated: bool)
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysPairingCoordinates(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysTransientPairReplyKeepsCode(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysOneUnclaimedPairing(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysPendingHoldsOnlyVerifier(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysClaimedHasController(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysActivationIsConfirmed(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysCommittedBeforeDeadline(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysCommitTimeIsSetOnlyByCommit(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysCommandsNeedCommittedPairing(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysOnePairingPerId(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysOneCommandPerNumber(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysClaimedCommandHoldsItsClaim(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysLiveHostHasNoRevocationReceipt(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysCancelledCommandDropsClaim(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysStartedCommandBecomesAmbiguous(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysRevokedPairingHasNoVerifier(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysReceiptCoversOutstandingRows(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> alwaysRevokedHostKeepsOnlyLockedWork(commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> stepFinishedMintCannotBeRepeated(s, "commitSession", commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> stepPairingOwnershipIsDurable(s, commitSession(s, id, authenticated)))
  ensures (inv(s) ==> canCommitSession(s, id, authenticated) ==> stepSettledCommandIsFinal(s, commitSession(s, id, authenticated)))
{
  if inv(s) && canCommitSession(s, id, authenticated) {
    var t := commitSession(s, id, authenticated);
    var prev := sessionOf(s, id);
    SessionLookup(s, prev.id);
    SessionLookup(s, id);
    PutSession(s, t, prev, (if (codeExpiredAt(prev, s.now) || (s.now >= prev.grantUntil)) then ended(prev, SessionStatus.SessionExpired) else prev.(status := SessionStatus.SessionActive, committedAt := s.now)));
    CommandsNeedCommitted(s, t);
  }
}

lemma revokeSession_ensures(s: Remote, id: int, authorized: bool)
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysPairingCoordinates(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysTransientPairReplyKeepsCode(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysOneUnclaimedPairing(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysPendingHoldsOnlyVerifier(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysClaimedHasController(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysActivationIsConfirmed(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysCommittedBeforeDeadline(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysCommitTimeIsSetOnlyByCommit(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysCommandsNeedCommittedPairing(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysOnePairingPerId(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysOneCommandPerNumber(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysClaimedCommandHoldsItsClaim(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysLiveHostHasNoRevocationReceipt(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysCancelledCommandDropsClaim(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysStartedCommandBecomesAmbiguous(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysRevokedPairingHasNoVerifier(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysReceiptCoversOutstandingRows(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> alwaysRevokedHostKeepsOnlyLockedWork(revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> stepFinishedMintCannotBeRepeated(s, "revokeSession", revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> stepPairingOwnershipIsDurable(s, revokeSession(s, id, authorized)))
  ensures (inv(s) ==> canRevokeSession(s, id, authorized) ==> stepSettledCommandIsFinal(s, revokeSession(s, id, authorized)))
{
  if inv(s) && canRevokeSession(s, id, authorized) {
    var t := revokeSession(s, id, authorized);
    var prev := sessionOf(s, id);
    SessionLookup(s, prev.id);
    PutSession(s, t, prev, ended(prev, (if (unstaged(prev.status) && codeExpiredAt(prev, s.now)) then SessionStatus.SessionExpired else SessionStatus.SessionRevoked)));
    CommandsNeedCommitted(s, t);
  }
}

lemma enqueueCommand_ensures(s: Remote, command: int, id: int)
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysPairingCoordinates(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysTransientPairReplyKeepsCode(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysOneUnclaimedPairing(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysPendingHoldsOnlyVerifier(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysClaimedHasController(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysActivationIsConfirmed(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysCommittedBeforeDeadline(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysCommitTimeIsSetOnlyByCommit(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysCommandsNeedCommittedPairing(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysOnePairingPerId(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysOneCommandPerNumber(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysClaimedCommandHoldsItsClaim(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysLiveHostHasNoRevocationReceipt(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysCancelledCommandDropsClaim(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysStartedCommandBecomesAmbiguous(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysRevokedPairingHasNoVerifier(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysReceiptCoversOutstandingRows(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> alwaysRevokedHostKeepsOnlyLockedWork(enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> stepFinishedMintCannotBeRepeated(s, "enqueueCommand", enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> stepPairingOwnershipIsDurable(s, enqueueCommand(s, command, id)))
  ensures (inv(s) ==> canEnqueueCommand(s, command, id) ==> stepSettledCommandIsFinal(s, enqueueCommand(s, command, id)))
{
  if inv(s) && canEnqueueCommand(s, command, id) {
    var t := enqueueCommand(s, command, id);
    SessionsMapped(s, t, (r: RemoteSession) => r);
    forall j | 0 <= j < |s.commands|
      ensures s.commands[j].command != command
    {
      assert s.commands[j] in s.commands;
    }
    CommandsMapped(s, t, (c: RemoteCommand) => c);
  }
}

lemma advanceCommand_ensures(s: Remote, command: int, succeeded: bool)
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysPairingCoordinates(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysTransientPairReplyKeepsCode(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysOneUnclaimedPairing(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysPendingHoldsOnlyVerifier(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysClaimedHasController(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysActivationIsConfirmed(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysCommittedBeforeDeadline(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysCommitTimeIsSetOnlyByCommit(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysCommandsNeedCommittedPairing(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysOnePairingPerId(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysOneCommandPerNumber(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysClaimedCommandHoldsItsClaim(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysLiveHostHasNoRevocationReceipt(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysCancelledCommandDropsClaim(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysStartedCommandBecomesAmbiguous(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysRevokedPairingHasNoVerifier(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysReceiptCoversOutstandingRows(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> alwaysRevokedHostKeepsOnlyLockedWork(advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> stepFinishedMintCannotBeRepeated(s, "advanceCommand", advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> stepPairingOwnershipIsDurable(s, advanceCommand(s, command, succeeded)))
  ensures (inv(s) ==> canAdvanceCommand(s, command, succeeded) ==> stepSettledCommandIsFinal(s, advanceCommand(s, command, succeeded)))
{
  if inv(s) && canAdvanceCommand(s, command, succeeded) {
    var t := advanceCommand(s, command, succeeded);
    var prev := commandOf(s, command);
    var next := (if prev.status.CommandPending? then prev.(status := CommandStatus.CommandClaimed, claimToken := true) else (if prev.status.CommandClaimed? then prev.(status := CommandStatus.CommandStarted) else prev.(status := (if succeeded then CommandStatus.CommandCompleted else CommandStatus.CommandFailed), ended := true)));
    CommandLookup(s, command);
    SessionsMapped(s, t, (r: RemoteSession) => r);
    CommandsMapped(s, t, (c: RemoteCommand) => (if (c.command == next.command) then next else c));
    forall x | x in t.commands
      ensures x in s.commands || x == next
    {
      var i :| 0 <= i < |t.commands| && t.commands[i] == x;
      assert s.commands[i] in s.commands;
    }
  }
}

lemma lockSession_ensures(s: Remote, id: int)
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysPairingCoordinates(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysTransientPairReplyKeepsCode(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysOneUnclaimedPairing(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysPendingHoldsOnlyVerifier(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysClaimedHasController(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysActivationIsConfirmed(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysCommittedBeforeDeadline(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysCommitTimeIsSetOnlyByCommit(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysCommandsNeedCommittedPairing(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysOnePairingPerId(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysOneCommandPerNumber(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysClaimedCommandHoldsItsClaim(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysLiveHostHasNoRevocationReceipt(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysCancelledCommandDropsClaim(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysStartedCommandBecomesAmbiguous(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysRevokedPairingHasNoVerifier(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysReceiptCoversOutstandingRows(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> alwaysRevokedHostKeepsOnlyLockedWork(lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> stepFinishedMintCannotBeRepeated(s, "lockSession", lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> stepPairingOwnershipIsDurable(s, lockSession(s, id)))
  ensures (inv(s) ==> canLockSession(s, id) ==> stepSettledCommandIsFinal(s, lockSession(s, id)))
{
  if inv(s) && canLockSession(s, id) {
    SameRows(s, lockSession(s, id));
  }
}

lemma unlockSession_ensures(s: Remote, id: int)
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysPairingCoordinates(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysTransientPairReplyKeepsCode(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysOneUnclaimedPairing(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysPendingHoldsOnlyVerifier(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysClaimedHasController(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysActivationIsConfirmed(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysCommittedBeforeDeadline(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysCommitTimeIsSetOnlyByCommit(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysCommandsNeedCommittedPairing(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysOnePairingPerId(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysOneCommandPerNumber(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysClaimedCommandHoldsItsClaim(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysLiveHostHasNoRevocationReceipt(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysCancelledCommandDropsClaim(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysStartedCommandBecomesAmbiguous(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysRevokedPairingHasNoVerifier(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysReceiptCoversOutstandingRows(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> alwaysRevokedHostKeepsOnlyLockedWork(unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> stepFinishedMintCannotBeRepeated(s, "unlockSession", unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> stepPairingOwnershipIsDurable(s, unlockSession(s, id)))
  ensures (inv(s) ==> canUnlockSession(s, id) ==> stepSettledCommandIsFinal(s, unlockSession(s, id)))
{
  if inv(s) && canUnlockSession(s, id) {
    SameRows(s, unlockSession(s, id));
  }
}

lemma lockCommand_ensures(s: Remote, command: int)
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysPairingCoordinates(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysTransientPairReplyKeepsCode(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysOneUnclaimedPairing(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysPendingHoldsOnlyVerifier(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysClaimedHasController(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysActivationIsConfirmed(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysCommittedBeforeDeadline(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysCommitTimeIsSetOnlyByCommit(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysCommandsNeedCommittedPairing(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysOnePairingPerId(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysOneCommandPerNumber(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysClaimedCommandHoldsItsClaim(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysLiveHostHasNoRevocationReceipt(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysCancelledCommandDropsClaim(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysStartedCommandBecomesAmbiguous(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysRevokedPairingHasNoVerifier(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysReceiptCoversOutstandingRows(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> alwaysRevokedHostKeepsOnlyLockedWork(lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> stepFinishedMintCannotBeRepeated(s, "lockCommand", lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> stepPairingOwnershipIsDurable(s, lockCommand(s, command)))
  ensures (inv(s) ==> canLockCommand(s, command) ==> stepSettledCommandIsFinal(s, lockCommand(s, command)))
{
  if inv(s) && canLockCommand(s, command) {
    SameRows(s, lockCommand(s, command));
  }
}

lemma unlockCommand_ensures(s: Remote, command: int)
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysPairingCoordinates(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysTransientPairReplyKeepsCode(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysOneUnclaimedPairing(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysPendingHoldsOnlyVerifier(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysClaimedHasController(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysActivationIsConfirmed(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysCommittedBeforeDeadline(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysCommitTimeIsSetOnlyByCommit(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysCommandsNeedCommittedPairing(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysOnePairingPerId(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysOneCommandPerNumber(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysClaimedCommandHoldsItsClaim(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysLiveHostHasNoRevocationReceipt(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysCancelledCommandDropsClaim(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysStartedCommandBecomesAmbiguous(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysRevokedPairingHasNoVerifier(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysReceiptCoversOutstandingRows(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> alwaysRevokedHostKeepsOnlyLockedWork(unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> stepFinishedMintCannotBeRepeated(s, "unlockCommand", unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> stepPairingOwnershipIsDurable(s, unlockCommand(s, command)))
  ensures (inv(s) ==> canUnlockCommand(s, command) ==> stepSettledCommandIsFinal(s, unlockCommand(s, command)))
{
  if inv(s) && canUnlockCommand(s, command) {
    SameRows(s, unlockCommand(s, command));
  }
}

lemma revokeHost_ensures(s: Remote, authorized: bool)
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysPairingCoordinates(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysTransientPairReplyKeepsCode(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysOneUnclaimedPairing(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysPendingHoldsOnlyVerifier(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysClaimedHasController(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysActivationIsConfirmed(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysCommittedBeforeDeadline(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysCommitTimeIsSetOnlyByCommit(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysCommandsNeedCommittedPairing(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysOnePairingPerId(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysOneCommandPerNumber(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysClaimedCommandHoldsItsClaim(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysLiveHostHasNoRevocationReceipt(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysCancelledCommandDropsClaim(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysStartedCommandBecomesAmbiguous(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysRevokedPairingHasNoVerifier(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysReceiptCoversOutstandingRows(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> alwaysRevokedHostKeepsOnlyLockedWork(revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> stepFinishedMintCannotBeRepeated(s, "revokeHost", revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> stepPairingOwnershipIsDurable(s, revokeHost(s, authorized)))
  ensures (inv(s) ==> canRevokeHost(s, authorized) ==> stepSettledCommandIsFinal(s, revokeHost(s, authorized)))
{
  if inv(s) && canRevokeHost(s, authorized) {
    var t := revokeHost(s, authorized);
    var f := (r: RemoteSession) => (if (openSession(r.status) && !((r.id in s.lockedSessions))) then ended(r, SessionStatus.SessionRevoked) else r);
    var g := (c: RemoteCommand) => (if (commandOpen(c.status) && !((c.command in s.lockedCommands))) then (if c.status.CommandStarted? then c.(status := CommandStatus.CommandAmbiguous, ended := true) else c.(status := CommandStatus.CommandCancelled, claimToken := false, ended := true)) else c);
    forall i | 0 <= i < |s.sessions|
      ensures t.sessions[i] == f(s.sessions[i]) && (unstaged(t.sessions[i].status) ==> unstaged(s.sessions[i].status))
    {
    }
    SessionsMapped(s, t, f);
    UnclaimedKept(s, t);
    CommandsMapped(s, t, g);
    forall x | x in t.commands
      ensures exists c :: c in s.commands && x == g(c)
    {
      var i :| 0 <= i < |t.commands| && t.commands[i] == x;
      assert s.commands[i] in s.commands;
    }
  }
}

lemma sweep_ensures(s: Remote, id: int)
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysPairingCoordinates(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysTransientPairReplyKeepsCode(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysOneUnclaimedPairing(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysPendingHoldsOnlyVerifier(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysClaimedHasController(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysActivationIsConfirmed(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysCommittedBeforeDeadline(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysCommitTimeIsSetOnlyByCommit(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysCommandsNeedCommittedPairing(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysOnePairingPerId(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysOneCommandPerNumber(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysClaimedCommandHoldsItsClaim(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysLiveHostHasNoRevocationReceipt(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysCancelledCommandDropsClaim(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysStartedCommandBecomesAmbiguous(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysRevokedPairingHasNoVerifier(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysReceiptCoversOutstandingRows(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> alwaysRevokedHostKeepsOnlyLockedWork(sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> stepFinishedMintCannotBeRepeated(s, "sweep", sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> stepPairingOwnershipIsDurable(s, sweep(s, id)))
  ensures (inv(s) ==> canSweep(s, id) ==> stepSettledCommandIsFinal(s, sweep(s, id)))
{
  if inv(s) && canSweep(s, id) {
    var t := sweep(s, id);
    var prev := sessionOf(s, id);
    SessionLookup(s, prev.id);
    PutSession(s, t, prev, prev.(status := SessionStatus.SessionExpired));
    CommandsNeedCommitted(s, t);
  }
}
