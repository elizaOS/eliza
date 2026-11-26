lemma beginPage_ensures(s: CatalogPaging, modern: bool, volumeCount: int)
  ensures (inv(s) ==> canBeginPage(s) ==> alwaysOnlyAPostedOrPublishedPageCarriesACursor(beginPage(s, modern, volumeCount)))
  ensures (inv(s) ==> canBeginPage(s) ==> alwaysCatalogCountersAreConsistent(beginPage(s, modern, volumeCount)))
  ensures (inv(s) ==> canBeginPage(s) ==> stepContinuationConsumesItsCursorBeforeProviderWork(s, "beginPage", beginPage(s, modern, volumeCount)))
  ensures (inv(s) ==> canBeginPage(s) ==> stepContinuationResumesOnlyItsQueryAndSnapshot(s, "beginPage", beginPage(s, modern, volumeCount)))
  ensures (inv(s) ==> canBeginPage(s) ==> stepEarlyRefusalLeavesTheCursorTable(s, "beginPage", beginPage(s, modern, volumeCount)))
  ensures (inv(s) ==> canBeginPage(s) ==> stepNewCursorIsFreshAndHeld(s, "beginPage", beginPage(s, modern, volumeCount)))
  ensures (inv(s) ==> canBeginPage(s) ==> stepRetirementAdvancesTheEpochAndClearsCursors(s, "beginPage", beginPage(s, modern, volumeCount)))
  ensures (inv(s) ==> canBeginPage(s) ==> stepEpochNeverGoesBack(s, beginPage(s, modern, volumeCount)))
  ensures (inv(s) ==> canBeginPage(s) ==> stepPageIsPostedOnlyOnItsAdmittingSnapshot(s, "beginPage", beginPage(s, modern, volumeCount)))
  ensures (inv(s) ==> canBeginPage(s) ==> stepPublishedPageHoldsItsAdmittingEpoch(s, "beginPage", beginPage(s, modern, volumeCount)))
{
  if inv(s) && canBeginPage(s) {
    CatalogBeginPageShape(s, modern, volumeCount);
    var after := beginPage(s, modern, volumeCount);
    var local_0 := s.read;
    if after.tokens != s.tokens {
      CatalogFilterKeepsTokens(s.tokens, (t: os__android__media__rows_OneShotToken) => (t.id != local_0.tokenId), s.lastCursorId);
      CatalogTokenIds(after.tokens);
    }
    if local_0.tokenId != 0 && after.read.phase.ReadRunning? {
      var binding := ProofLib.Filter((c: CatalogCursor) => (c.id == local_0.tokenId), s.cursors);
      var bound := binding[0];
      ProofLib.FilterMember((c: CatalogCursor) => (c.id == local_0.tokenId), s.cursors, bound);
      assert bound in s.cursors && bound.id == local_0.tokenId;
    }
  }
}

lemma finishPage_ensures(s: CatalogPaging, providerRows: seq<os__android__paging_RowKey>, providerOk: bool)
  ensures (inv(s) ==> canFinishPage(s) ==> alwaysOnlyAPostedOrPublishedPageCarriesACursor(finishPage(s, providerRows, providerOk)))
  ensures (inv(s) ==> canFinishPage(s) ==> alwaysCatalogCountersAreConsistent(finishPage(s, providerRows, providerOk)))
  ensures (inv(s) ==> canFinishPage(s) ==> stepContinuationConsumesItsCursorBeforeProviderWork(s, "finishPage", finishPage(s, providerRows, providerOk)))
  ensures (inv(s) ==> canFinishPage(s) ==> stepContinuationResumesOnlyItsQueryAndSnapshot(s, "finishPage", finishPage(s, providerRows, providerOk)))
  ensures (inv(s) ==> canFinishPage(s) ==> stepEarlyRefusalLeavesTheCursorTable(s, "finishPage", finishPage(s, providerRows, providerOk)))
  ensures (inv(s) ==> canFinishPage(s) ==> stepNewCursorIsFreshAndHeld(s, "finishPage", finishPage(s, providerRows, providerOk)))
  ensures (inv(s) ==> canFinishPage(s) ==> stepRetirementAdvancesTheEpochAndClearsCursors(s, "finishPage", finishPage(s, providerRows, providerOk)))
  ensures (inv(s) ==> canFinishPage(s) ==> stepEpochNeverGoesBack(s, finishPage(s, providerRows, providerOk)))
  ensures (inv(s) ==> canFinishPage(s) ==> stepPageIsPostedOnlyOnItsAdmittingSnapshot(s, "finishPage", finishPage(s, providerRows, providerOk)))
  ensures (inv(s) ==> canFinishPage(s) ==> stepPublishedPageHoldsItsAdmittingEpoch(s, "finishPage", finishPage(s, providerRows, providerOk)))
{
  if inv(s) && canFinishPage(s) {
    var after := finishPage(s, providerRows, providerOk);
    if after.lastCursorId != s.lastCursorId {
      CatalogIssueKeepsTokens(s);
      assert after.tokens == os__android__media__rows_issueToken(s.tokens, s.now, cursorCapacity, s.lastCursorId + 1, os__android__media__rows_tokenLifetimeMs);
    }
  }
}

lemma CatalogBeginPageShape(s: CatalogPaging, modern: bool, volumeCount: int)
  ensures var local_0 := s.read; var after := beginPage(s, modern, volumeCount);
    after.tokens == s.tokens || after.tokens == ProofLib.Filter((t: os__android__media__rows_OneShotToken) => (t.id != local_0.tokenId), s.tokens)
  ensures var local_0 := s.read; var after := beginPage(s, modern, volumeCount);
    var binding := ProofLib.Filter((c: CatalogCursor) => (c.id == local_0.tokenId), s.cursors);
    local_0.tokenId != 0 && after.read.phase.ReadRunning? ==>
      os__android__media__rows_takeToken(s.tokens, local_0.tokenId, s.now).live && |binding| > 0 &&
      binding[0].snapshot == currentSnapshot(s) && binding[0].query == local_0.query &&
      after.read.start == os__android__paging_PageStart.AfterRow(binding[0].last)
{
}

lemma CatalogTokenIds(tokens: seq<os__android__media__rows_OneShotToken>)
  ensures os__android__media__rows_distinctTokenIds(tokens) <==> ProofLib.DistinctBy(tokens, (t: os__android__media__rows_OneShotToken) => t.id)
{
  assert os__android__media__rows_distinctTokenIds(tokens) ==
    (forall t :: t in tokens ==> |ProofLib.Filter((other: os__android__media__rows_OneShotToken) => (other.id == t.id), tokens)| == 1);
  if os__android__media__rows_distinctTokenIds(tokens) {
    forall i, j | 0 <= i < |tokens| && 0 <= j < |tokens| && i != j ensures tokens[i].id != tokens[j].id {
      ProofLib.FilterCountOneIffUnique((other: os__android__media__rows_OneShotToken) => (other.id == tokens[i].id), tokens, (t: os__android__media__rows_OneShotToken) => t.id, i);
    }
  } else if ProofLib.DistinctBy(tokens, (t: os__android__media__rows_OneShotToken) => t.id) {
    forall t | t in tokens ensures |ProofLib.Filter((other: os__android__media__rows_OneShotToken) => (other.id == t.id), tokens)| == 1 {
      var i :| 0 <= i < |tokens| && tokens[i] == t;
      ProofLib.FilterOne((other: os__android__media__rows_OneShotToken) => (other.id == t.id), tokens, i);
    }
  }
}

lemma CatalogTokenFilterLength(tokens: seq<os__android__media__rows_OneShotToken>, keep: os__android__media__rows_OneShotToken -> bool)
  ensures |ProofLib.Filter(keep, tokens)| <= |tokens|
  decreases |tokens|
{
  if |tokens| == 0 {
    ProofLib.FilterNil(keep, tokens);
  } else {
    ProofLib.FilterCons(keep, tokens);
    CatalogTokenFilterLength(tokens[1..], keep);
  }
}

lemma CatalogFilterKeepsTokens(tokens: seq<os__android__media__rows_OneShotToken>, keep: os__android__media__rows_OneShotToken -> bool, lastId: int)
  requires os__android__media__rows_distinctTokenIds(tokens)
  requires forall t :: t in tokens ==> 1 <= t.id <= lastId
  ensures |ProofLib.Filter(keep, tokens)| <= |tokens|
  ensures ProofLib.DistinctBy(ProofLib.Filter(keep, tokens), (t: os__android__media__rows_OneShotToken) => t.id)
  ensures forall t :: t in ProofLib.Filter(keep, tokens) ==> 1 <= t.id <= lastId
{
  CatalogTokenIds(tokens);
  CatalogTokenFilterLength(tokens, keep);
  ProofLib.FilterKeepsDistinctBy(keep, tokens, (t: os__android__media__rows_OneShotToken) => t.id);
  forall t | t in ProofLib.Filter(keep, tokens) ensures 1 <= t.id <= lastId {
    ProofLib.FilterMember(keep, tokens, t);
  }
}

lemma CatalogIssueShape(s: CatalogPaging)
  ensures var at := s.now;
    var live := ProofLib.Filter((t: os__android__media__rows_OneShotToken) => (at <= t.until), s.tokens);
    os__android__media__rows_issueToken(s.tokens, at, cursorCapacity, s.lastCursorId + 1, os__android__media__rows_tokenLifetimeMs) ==
      (if |live| >= cursorCapacity then live[1..] else live) + [os__android__media__rows_OneShotToken(s.lastCursorId + 1, at + os__android__media__rows_tokenLifetimeMs)]
{
}

lemma CatalogIssueKeepsTokens(s: CatalogPaging)
  requires inv(s)
  ensures var issued := os__android__media__rows_issueToken(s.tokens, s.now, cursorCapacity, s.lastCursorId + 1, os__android__media__rows_tokenLifetimeMs);
    |issued| <= cursorCapacity && os__android__media__rows_distinctTokenIds(issued) &&
      (forall t :: t in issued ==> 1 <= t.id <= s.lastCursorId + 1)
{
  var at := s.now;
  var keep := (t: os__android__media__rows_OneShotToken) => (at <= t.until);
  var live := ProofLib.Filter(keep, s.tokens);
  CatalogFilterKeepsTokens(s.tokens, keep, s.lastCursorId);
  var room := if |live| >= cursorCapacity then live[1..] else live;
  if |live| >= cursorCapacity {
    forall i, j | 0 <= i < |room| && 0 <= j < |room| && i != j ensures room[i].id != room[j].id {
      assert room[i] == live[i + 1] && room[j] == live[j + 1];
    }
  }
  var issuedToken := os__android__media__rows_OneShotToken(s.lastCursorId + 1, at + os__android__media__rows_tokenLifetimeMs);
  assert forall t :: t in room ==> 1 <= t.id <= s.lastCursorId;
  ProofLib.DistinctByConcat(room, [issuedToken], (t: os__android__media__rows_OneShotToken) => t.id);
  CatalogTokenIds(room + [issuedToken]);
  CatalogIssueShape(s);
}
