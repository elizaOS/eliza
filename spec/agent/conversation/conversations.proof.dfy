lemma create_ensures(s: Conversations, title: string, titleUnits: int)
  ensures (inv(s) ==> canCreate(s, title, titleUnits) ==> alwaysIdsAreFresh(create(s, title, titleUnits)))
  ensures (inv(s) ==> canCreate(s, title, titleUnits) ==> alwaysOneRecordPerConversation(create(s, title, titleUnits)))
  ensures (inv(s) ==> canCreate(s, title, titleUnits) ==> alwaysOneForkPerRequest(create(s, title, titleUnits)))
  ensures (inv(s) ==> canCreate(s, title, titleUnits) ==> alwaysForkHoldsTheWholePrefix(create(s, title, titleUnits)))
  ensures (inv(s) ==> canCreate(s, title, titleUnits) ==> alwaysPendingForkHoldsOnlyCopies(create(s, title, titleUnits)))
  ensures (inv(s) ==> canCreate(s, title, titleUnits) ==> stepOnlyRedactionChangesStoredText(s, "create", create(s, title, titleUnits)))
{
  if inv(s) && canCreate(s, title, titleUnits) {
    ConvCreate(s, title, titleUnits);
  }
}

lemma receive_ensures(s: Conversations, conversationId: int, author: Author, text: string, at: int)
  ensures (inv(s) ==> canReceive(s, conversationId, author, text, at) ==> alwaysIdsAreFresh(receive(s, conversationId, author, text, at)))
  ensures (inv(s) ==> canReceive(s, conversationId, author, text, at) ==> alwaysOneRecordPerConversation(receive(s, conversationId, author, text, at)))
  ensures (inv(s) ==> canReceive(s, conversationId, author, text, at) ==> alwaysOneForkPerRequest(receive(s, conversationId, author, text, at)))
  ensures (inv(s) ==> canReceive(s, conversationId, author, text, at) ==> alwaysForkHoldsTheWholePrefix(receive(s, conversationId, author, text, at)))
  ensures (inv(s) ==> canReceive(s, conversationId, author, text, at) ==> alwaysPendingForkHoldsOnlyCopies(receive(s, conversationId, author, text, at)))
  ensures (inv(s) ==> canReceive(s, conversationId, author, text, at) ==> stepOnlyRedactionChangesStoredText(s, "receive", receive(s, conversationId, author, text, at)))
{
  if inv(s) && canReceive(s, conversationId, author, text, at) {
    ConvReceive(s, conversationId, author, text, at);
  }
}

lemma finishFork_ensures(s: Conversations, forkId: int)
  ensures (inv(s) ==> canFinishFork(s, forkId) ==> alwaysIdsAreFresh(finishFork(s, forkId)))
  ensures (inv(s) ==> canFinishFork(s, forkId) ==> alwaysOneRecordPerConversation(finishFork(s, forkId)))
  ensures (inv(s) ==> canFinishFork(s, forkId) ==> alwaysOneForkPerRequest(finishFork(s, forkId)))
  ensures (inv(s) ==> canFinishFork(s, forkId) ==> alwaysForkHoldsTheWholePrefix(finishFork(s, forkId)))
  ensures (inv(s) ==> canFinishFork(s, forkId) ==> alwaysPendingForkHoldsOnlyCopies(finishFork(s, forkId)))
  ensures (inv(s) ==> canFinishFork(s, forkId) ==> stepOnlyRedactionChangesStoredText(s, "finishFork", finishFork(s, forkId)))
{
  if inv(s) && canFinishFork(s, forkId) {
    ConvFinishFork(s, forkId);
  }
}

lemma fork_ensures(s: Conversations, conversationId: int, messageId: int, requestId: string, expectedText: string, textDigest: int)
  ensures (inv(s) ==> canFork(s, conversationId, messageId, requestId, expectedText, textDigest) ==> alwaysIdsAreFresh(fork(s, conversationId, messageId, requestId, expectedText, textDigest)))
  ensures (inv(s) ==> canFork(s, conversationId, messageId, requestId, expectedText, textDigest) ==> alwaysOneRecordPerConversation(fork(s, conversationId, messageId, requestId, expectedText, textDigest)))
  ensures (inv(s) ==> canFork(s, conversationId, messageId, requestId, expectedText, textDigest) ==> alwaysOneForkPerRequest(fork(s, conversationId, messageId, requestId, expectedText, textDigest)))
  ensures (inv(s) ==> canFork(s, conversationId, messageId, requestId, expectedText, textDigest) ==> alwaysForkHoldsTheWholePrefix(fork(s, conversationId, messageId, requestId, expectedText, textDigest)))
  ensures (inv(s) ==> canFork(s, conversationId, messageId, requestId, expectedText, textDigest) ==> alwaysPendingForkHoldsOnlyCopies(fork(s, conversationId, messageId, requestId, expectedText, textDigest)))
  ensures (inv(s) ==> canFork(s, conversationId, messageId, requestId, expectedText, textDigest) ==> stepOnlyRedactionChangesStoredText(s, "fork", fork(s, conversationId, messageId, requestId, expectedText, textDigest)))
{
  if inv(s) && canFork(s, conversationId, messageId, requestId, expectedText, textDigest) {
    ConvFork(s, conversationId, messageId, requestId, expectedText, textDigest);
  }
}

lemma redact_ensures(s: Conversations, conversationId: int, messageId: int, expectedText: string)
  ensures (inv(s) ==> canRedact(s, conversationId, messageId, expectedText) ==> alwaysIdsAreFresh(redact(s, conversationId, messageId, expectedText)))
  ensures (inv(s) ==> canRedact(s, conversationId, messageId, expectedText) ==> alwaysOneRecordPerConversation(redact(s, conversationId, messageId, expectedText)))
  ensures (inv(s) ==> canRedact(s, conversationId, messageId, expectedText) ==> alwaysOneForkPerRequest(redact(s, conversationId, messageId, expectedText)))
  ensures (inv(s) ==> canRedact(s, conversationId, messageId, expectedText) ==> alwaysForkHoldsTheWholePrefix(redact(s, conversationId, messageId, expectedText)))
  ensures (inv(s) ==> canRedact(s, conversationId, messageId, expectedText) ==> alwaysPendingForkHoldsOnlyCopies(redact(s, conversationId, messageId, expectedText)))
  ensures (inv(s) ==> canRedact(s, conversationId, messageId, expectedText) ==> stepOnlyRedactionChangesStoredText(s, "redact", redact(s, conversationId, messageId, expectedText)))
{
  if inv(s) && canRedact(s, conversationId, messageId, expectedText) {
    ConvRedact(s, conversationId, messageId, expectedText);
  }
}

lemma lawPageIsTheNewest_ensures(rows: seq<Row>, n: int)
  ensures (lawPageIsTheNewest(rows, n) == true)
{
  ConvPageIsTheNewestFilter(rows, n);
  forall r, q | r in rows && !(r in newest(rows, n)) && q in newest(rows, n)
    ensures precedes(r, q)
  {
    ConvNewestMember(rows, n, r);
    ConvNewestMember(rows, n, q);
    if !precedes(r, q) {
      assert r != q;
      assert precedes(q, r);
      ProofLib.FilterImpLength((x: Row) => precedes(r, x), (x: Row) => precedes(q, x), rows);
    }
  }
}

lemma lawOlderPageIsOlderThanItsCursor_ensures(rows: seq<Row>, c: Cursor, limit: int)
  ensures (lawOlderPageIsOlderThanItsCursor(rows, c, limit) == true)
{
  ConvOlderPageFilter(rows, c, limit);
  var older := ProofLib.Filter((r: Row) => olderThan(r, c), rows);
  forall y | y in olderPage(rows, c, limit).rows
    ensures olderThan(y, c)
  {
    ConvNewestMember(older, pageSize(limit), y);
    ProofLib.FilterMember((r: Row) => olderThan(r, c), rows, y);
  }
}

lemma lawLastPageHoldsEveryOlderMessage_ensures(rows: seq<Row>, c: Cursor, limit: int)
  ensures (lawLastPageHoldsEveryOlderMessage(rows, c, limit) == true)
{
  ConvOlderPageFilter(rows, c, limit);
  var older := ProofLib.Filter((r: Row) => olderThan(r, c), rows);
  if !olderPage(rows, c, limit).hasMore {
    forall y | y in rows && olderThan(y, c)
      ensures y in olderPage(rows, c, limit).rows
    {
      ProofLib.FilterMember((r: Row) => olderThan(r, c), rows, y);
      ConvNewestMember(older, pageSize(limit), y);
      ConvFilterLength((x: Row) => true, older);
      var i :| 0 <= i < |older| && older[i] == y;
      ProofLib.FilterImpLength((x: Row) => precedes(y, x), (x: Row) => true, older);
    }
  }
}

lemma lawAroundHoldsThePivotAndAtMostNEachSide_ensures(rows: seq<Row>, pivot: Row, n: int)
  ensures (lawAroundHoldsThePivotAndAtMostNEachSide(rows, pivot, n) == true)
{
  ConvAroundFilterLaw(rows, pivot, n);
  ConvAroundFilter(rows, pivot, n);
  if n >= 0 && !((exists r :: r in rows && !((|ProofLib.Filter((x: Row) => (x == r), rows)| == 1)))) {
    ConvDistinctRows(rows);
    var before := ProofLib.Filter((r: Row) => precedes(r, pivot), rows);
    var after := ProofLib.Filter((r: Row) => precedes(pivot, r), rows);
    var a := newest(before, n);
    var b := oldest(after, n);
    ConvDistinctFilter((r: Row) => precedes(r, pivot), rows);
    ConvDistinctFilter((r: Row) => precedes(pivot, r), rows);
    ConvNewestAtMost(before, n);
    ConvOldestAtMost(after, n);
    var shown := around(rows, pivot, n);
    assert shown == (a + [pivot]) + b;
    assert pivot in shown;
    forall x | x in a ensures precedes(x, pivot) {
      ConvNewestMember(before, n, x);
      ProofLib.FilterMember((r: Row) => precedes(r, pivot), rows, x);
    }
    forall x | x in b ensures precedes(pivot, x) {
      ConvOldestMember(after, n, x);
      ProofLib.FilterMember((r: Row) => precedes(pivot, r), rows, x);
    }
    ConvAroundSide(a, pivot, b, n);
    assert |ProofLib.Filter((r: Row) => precedes(r, pivot), shown)| <= n;
    assert |ProofLib.Filter((r: Row) => precedes(pivot, r), shown)| <= n;
  }
}

lemma lawConsecutivePagesJoin_ensures(xs: seq<int>, split: int, more: int)
  ensures (lawConsecutivePagesJoin(xs, split, more) == true)
{
  if split >= 0 && more >= 0 {
    ConvTake(xs, 0, split, 0, []);
    ConvTake(xs, split, more, 0, []);
    ConvTake(xs, 0, split + more, 0, []);
  }
}

lemma ConvAlwaysOneRecordPerConversationFilter(s: Conversations)
  ensures alwaysOneRecordPerConversation(s) == (!((exists c :: c in s.conversations && !((|ProofLib.Filter((d: Conversation) => (d.id == c.id), s.conversations)| == 1)))))
{
}

lemma ConvAlwaysOneForkPerRequestFilter(s: Conversations)
  ensures alwaysOneForkPerRequest(s) == (!((exists f :: f in s.forks && !(((f.forkId >= 1) && (|ProofLib.Filter((g: Fork) => ((g.source == f.source) && (g.requestId == f.requestId)), s.forks)| == 1))))))
{
}

lemma ConvConversationOfFilter(s: Conversations, conversationId: int)
  ensures conversationOf(s, conversationId) == (if ((0 <= 0) && (0 < |ProofLib.Filter((c: Conversation) => (c.id == conversationId), s.conversations)|)) then
    ProofLib.Filter((c: Conversation) => (c.id == conversationId), s.conversations)[0]
  else
    noConversation)
{
}

lemma ConvMessageAtFilter(s: Conversations, messageId: int)
  ensures messageAt(s, messageId) == (if ((0 <= 0) && (0 < |ProofLib.Filter((m: Message) => (m.id == messageId), s.messages)|)) then
    ProofLib.Filter((m: Message) => (m.id == messageId), s.messages)[0]
  else
    noMessage)
{
}

lemma ConvOlderPageFilter(rows: seq<Row>, c: Cursor, limit: int)
  ensures olderPage(rows, c, limit) == (Page(newest(ProofLib.Filter((r: Row) => olderThan(r, c), rows), pageSize(limit)), (|ProofLib.Filter((r: Row) => olderThan(r, c), rows)| > pageSize(limit))))
{
}

lemma ConvAroundFilter(rows: seq<Row>, pivot: Row, n: int)
  ensures around(rows, pivot, n) == (((newest(ProofLib.Filter((r: Row) => precedes(r, pivot), rows), n) + [pivot]) + oldest(ProofLib.Filter((r: Row) => precedes(pivot, r), rows), n)))
{
}

lemma ConvForkFilter(s: Conversations, conversationId: int, messageId: int, requestId: string, expectedText: string, textDigest: int)
  ensures fork(s, conversationId, messageId, requestId, expectedText, textDigest) == (var local_3 := messageAt(s, messageId);
  var local_4 := s.nextConversation;
  var local_5 := conversationOf(s, conversationId);
  var local_6 := ProofLib.Filter((m: Message) => ((m.conversationId == conversationId) && precedes(rowOf(m), rowOf(local_3))), s.messages);
  var local_7 := Std.Collections.Seq.FoldLeft((acc: seq<Message>, m: Message) => (acc + [m.(id := (s.nextMessage + |acc|), conversationId := local_4, origin := Copied(m.id))]), [], local_6);
  s.(conversations := (s.conversations + [Conversation(local_4, Title(local_5.title.text, (local_5.title.edits + 1)), s.now, s.now, Publication.ForkPending)]), messages := (s.messages + local_7), forks := (s.forks + [Fork(local_4, conversationId, requestId, messageId, local_3.at, textDigest)]), nextConversation := (s.nextConversation + 1), nextMessage := (s.nextMessage + |local_6|)))
{
}

lemma ConvForkAnswerFilter(s: Conversations, conversationId: int, messageId: int, requestId: string, expectedText: string, textDigest: int)
  ensures forkAnswer(s, conversationId, messageId, requestId, expectedText, textDigest) == (var local_1 := (if ((0 <= 0) && (0 < |ProofLib.Filter((f: Fork) => ((f.source == conversationId) && (f.requestId == requestId)), s.forks)|)) then ProofLib.Filter((f: Fork) => ((f.source == conversationId) && (f.requestId == requestId)), s.forks)[0] else noFork);
  var local_2 := messageAt(s, messageId);
  if !(isPublished(s, conversationId)) then
    ForkAnswer.ForkUnknown
  else
    if (local_1.forkId != 0) then
      if ((local_1.boundary == messageId) && (local_1.textDigest == textDigest)) then
        ForkExisting(local_1.forkId)
      else
        ForkAnswer.ForkRequestChanged
    else
      if ((local_2.conversationId != conversationId) || (!local_2.author.User?)) then
        ForkAnswer.ForkUnknown
      else
        if (local_2.body != typed0_agent__conversation__conversations(Said(expectedText))) then
          ForkAnswer.ForkTextChanged
        else
          ForkAnswer.ForkNew)
{
}

lemma ConvOnly<T>(p: T -> bool, xs: seq<T>, x: T)
  requires |ProofLib.Filter(p, xs)| == 1 && x in xs && p(x)
  ensures ProofLib.Filter(p, xs) == [x]
  ensures forall y :: y in xs && p(y) ==> y == x
{
  ProofLib.FilterMember(p, xs, x);
  assert ProofLib.Filter(p, xs)[0] == x;
  forall y | y in xs && p(y)
    ensures y == x
  {
    ProofLib.FilterMember(p, xs, y);
  }
}

lemma ConvAppendCount<T>(p: T -> bool, xs: seq<T>, n: T)
  ensures |ProofLib.Filter(p, xs + [n])| == |ProofLib.Filter(p, xs)| + (if p(n) then 1 else 0)
{
  ProofLib.FilterAppend(p, xs, n);
}

lemma ConvLookup(s: Conversations, cid: int)
  requires alwaysOneRecordPerConversation(s)
  ensures forall c :: c in s.conversations && c.id == cid ==> conversationOf(s, cid) == c
  ensures (forall c :: c in s.conversations ==> c.id != cid) ==> conversationOf(s, cid) == noConversation
{
  ConvAlwaysOneRecordPerConversationFilter(s);
  ConvConversationOfFilter(s, cid);
  var p := (c: Conversation) => (c.id == cid);
  forall c | c in s.conversations && c.id == cid
    ensures conversationOf(s, cid) == c
  {
    ProofLib.FilterSamePredicate(p, (d: Conversation) => (d.id == c.id), s.conversations);
    ConvOnly(p, s.conversations, c);
  }
  if forall c :: c in s.conversations ==> c.id != cid {
    ProofLib.FilterNone(p, s.conversations);
  }
}

lemma ConvMapped(s: Conversations, after: Conversations)
  requires alwaysOneRecordPerConversation(s)
  requires |after.conversations| == |s.conversations| && forall i :: 0 <= i < |s.conversations| ==> after.conversations[i].id == s.conversations[i].id
  ensures alwaysOneRecordPerConversation(after)
  ensures forall i :: 0 <= i < |s.conversations| ==> conversationOf(after, s.conversations[i].id) == after.conversations[i] && conversationOf(s, s.conversations[i].id) == s.conversations[i]
  ensures forall cid :: (forall c :: c in s.conversations ==> c.id != cid) ==> conversationOf(after, cid) == noConversation && conversationOf(s, cid) == noConversation
{
  ConvAlwaysOneRecordPerConversationFilter(s);
  ConvAlwaysOneRecordPerConversationFilter(after);
  forall c | c in after.conversations
    ensures |ProofLib.Filter((d: Conversation) => (d.id == c.id), after.conversations)| == 1
  {
    var i :| 0 <= i < |after.conversations| && after.conversations[i] == c;
    var o := s.conversations[i];
    assert o in s.conversations;
    ProofLib.FilterLengthPointwise((d: Conversation) => (d.id == c.id), (d: Conversation) => (d.id == o.id), after.conversations, s.conversations);
  }
  forall i | 0 <= i < |s.conversations|
    ensures conversationOf(after, s.conversations[i].id) == after.conversations[i] && conversationOf(s, s.conversations[i].id) == s.conversations[i]
  {
    ConvLookup(s, s.conversations[i].id);
    ConvLookup(after, s.conversations[i].id);
    assert after.conversations[i] in after.conversations;
  }
  forall cid | forall c :: c in s.conversations ==> c.id != cid
    ensures conversationOf(after, cid) == noConversation && conversationOf(s, cid) == noConversation
  {
    ConvLookup(s, cid);
    ConvLookup(after, cid);
    forall c | c in after.conversations ensures c.id != cid {
      var i :| 0 <= i < |after.conversations| && after.conversations[i] == c;
      assert s.conversations[i] in s.conversations;
    }
  }
}

lemma ConvAppended(s: Conversations, after: Conversations, n: Conversation)
  requires alwaysOneRecordPerConversation(s) && alwaysIdsAreFresh(s)
  requires after.conversations == s.conversations + [n] && n.id == s.nextConversation
  ensures alwaysOneRecordPerConversation(after)
  ensures forall cid :: cid != n.id ==> conversationOf(after, cid) == conversationOf(s, cid)
{
  ConvAlwaysOneRecordPerConversationFilter(s);
  ConvAlwaysOneRecordPerConversationFilter(after);
  forall c | c in after.conversations
    ensures |ProofLib.Filter((d: Conversation) => (d.id == c.id), after.conversations)| == 1
  {
    ConvAppendCount((d: Conversation) => (d.id == c.id), s.conversations, n);
    if c != n {
      assert c in s.conversations;
    } else {
      forall d | d in s.conversations ensures d.id != c.id { }
      ProofLib.FilterNone((d: Conversation) => (d.id == c.id), s.conversations);
    }
  }
  forall cid | cid != n.id
    ensures conversationOf(after, cid) == conversationOf(s, cid)
  {
    ConvConversationOfFilter(s, cid);
    ConvConversationOfFilter(after, cid);
    ProofLib.FilterAppend((c: Conversation) => (c.id == cid), s.conversations, n);
  }
}

lemma ConvCreate(s: Conversations, title: string, titleUnits: int)
  requires inv(s)
  ensures alwaysOneRecordPerConversation(create(s, title, titleUnits))
  ensures alwaysPendingForkHoldsOnlyCopies(create(s, title, titleUnits))
{
  var after := create(s, title, titleUnits);
  ConvAppended(s, after, after.conversations[|s.conversations|]);
  forall m | m in after.messages
    ensures conversationOf(after, m.conversationId) == conversationOf(s, m.conversationId)
  {
    assert m in s.messages;
  }
}

lemma ConvReceive(s: Conversations, conversationId: int, author: Author, text: string, at: int)
  requires inv(s) && canReceive(s, conversationId, author, text, at)
  ensures alwaysOneRecordPerConversation(receive(s, conversationId, author, text, at))
  ensures alwaysPendingForkHoldsOnlyCopies(receive(s, conversationId, author, text, at))
  ensures stepOnlyRedactionChangesStoredText(s, "receive", receive(s, conversationId, author, text, at))
{
  var after := receive(s, conversationId, author, text, at);
  var n := Message(s.nextMessage, conversationId, at, author, Said(text), Origin.Original);
  assert after.messages == s.messages + [n];
  ConvMapped(s, after);
  forall i | 0 <= i < |s.conversations|
    ensures after.conversations[i].publication == s.conversations[i].publication
  {
  }
  forall m | m in after.messages && conversationOf(after, m.conversationId).publication.ForkPending?
    ensures !m.origin.Original?
  {
    if exists i :: 0 <= i < |s.conversations| && s.conversations[i].id == m.conversationId {
      var i :| 0 <= i < |s.conversations| && s.conversations[i].id == m.conversationId;
      if m == n {
        var c :| c in s.conversations && c.id == conversationId && c.publication.Published?;
        ConvLookup(s, conversationId);
      } else {
        assert m in s.messages;
      }
    } else {
      forall c | c in s.conversations ensures c.id != m.conversationId {
        var i :| 0 <= i < |s.conversations| && s.conversations[i] == c;
      }
      if m == n {
        var c :| c in s.conversations && c.id == conversationId && c.publication.Published?;
      }
      assert m in s.messages;
    }
  }
  forall m | m in s.messages
    ensures m in after.messages
  {
  }
}

lemma ConvFinishFork(s: Conversations, forkId: int)
  requires inv(s) && canFinishFork(s, forkId)
  ensures alwaysOneRecordPerConversation(finishFork(s, forkId))
  ensures alwaysPendingForkHoldsOnlyCopies(finishFork(s, forkId))
{
  var after := finishFork(s, forkId);
  ConvMapped(s, after);
  forall m | m in after.messages && conversationOf(after, m.conversationId).publication.ForkPending?
    ensures !m.origin.Original?
  {
    assert m in s.messages;
    if exists i :: 0 <= i < |s.conversations| && s.conversations[i].id == m.conversationId {
      var i :| 0 <= i < |s.conversations| && s.conversations[i].id == m.conversationId;
      assert conversationOf(s, m.conversationId).publication.ForkPending?;
    } else {
      forall c | c in s.conversations ensures c.id != m.conversationId {
        var i :| 0 <= i < |s.conversations| && s.conversations[i] == c;
      }
    }
  }
}

lemma ConvRedact(s: Conversations, conversationId: int, messageId: int, expectedText: string)
  requires inv(s)
  ensures alwaysForkHoldsTheWholePrefix(redact(s, conversationId, messageId, expectedText))
  ensures stepOnlyRedactionChangesStoredText(s, "redact", redact(s, conversationId, messageId, expectedText))
{
  var after := redact(s, conversationId, messageId, expectedText);
  ConvScrubFacts(s.messages, conversationId, expectedText);
  assert after.messages == scrub(s.messages, conversationId, expectedText) && after.forks == s.forks && |after.log| == |s.log|;
  ConvBodiesOnly(s, after);
  ConvBodiesOnlyStep(s, after);
}

lemma {:induction false} ConvCopies(base: int, forkId: int, xs: seq<Message>)
  ensures var f := (acc: seq<Message>, m: Message) => (acc + [m.(id := (base + |acc|), conversationId := forkId, origin := Copied(m.id))]);
    var r := Std.Collections.Seq.FoldLeft(f, [], xs);
    |r| == |xs| && forall i :: 0 <= i < |xs| ==> r[i] == xs[i].(id := (base + i), conversationId := forkId, origin := Copied(xs[i].id))
  decreases |xs|
{
  hide *;
  var f := (acc: seq<Message>, m: Message) => (acc + [m.(id := (base + |acc|), conversationId := forkId, origin := Copied(m.id))]);
  if |xs| == 0 {
    reveal Std.Collections.Seq.FoldLeft();
    assert Std.Collections.Seq.FoldLeft(f, [], xs) == [];
  } else {
    var prefix := xs[..|xs| - 1];
    var last := xs[|xs| - 1];
    assert xs == prefix + [last];
    ConvCopies(base, forkId, prefix);
    ProofLib.FoldLeftAppend(f, [], prefix, last);
    var prev := Std.Collections.Seq.FoldLeft(f, [], prefix);
    var r := Std.Collections.Seq.FoldLeft(f, [], xs);
    assert r == prev + [last.(id := (base + |prev|), conversationId := forkId, origin := Copied(last.id))];
    forall i | 0 <= i < |xs|
      ensures r[i] == xs[i].(id := (base + i), conversationId := forkId, origin := Copied(xs[i].id))
    {
      if i < |prefix| {
        assert r[i] == prev[i] && prefix[i] == xs[i];
      } else {
        assert i == |prefix| && r[i] == last.(id := (base + |prefix|), conversationId := forkId, origin := Copied(last.id));
      }
    }
  }
}

lemma ConvFork(s: Conversations, conversationId: int, messageId: int, requestId: string, expectedText: string, textDigest: int)
  requires inv(s) && canFork(s, conversationId, messageId, requestId, expectedText, textDigest)
  ensures alwaysIdsAreFresh(fork(s, conversationId, messageId, requestId, expectedText, textDigest))
  ensures alwaysOneRecordPerConversation(fork(s, conversationId, messageId, requestId, expectedText, textDigest))
  ensures alwaysOneForkPerRequest(fork(s, conversationId, messageId, requestId, expectedText, textDigest))
  ensures alwaysForkHoldsTheWholePrefix(fork(s, conversationId, messageId, requestId, expectedText, textDigest))
  ensures alwaysPendingForkHoldsOnlyCopies(fork(s, conversationId, messageId, requestId, expectedText, textDigest))
  ensures stepOnlyRedactionChangesStoredText(s, "fork", fork(s, conversationId, messageId, requestId, expectedText, textDigest))
{
  var after := fork(s, conversationId, messageId, requestId, expectedText, textDigest);
  var local_3 := messageAt(s, messageId);
  var local_4 := s.nextConversation;
  var local_5 := conversationOf(s, conversationId);
  var pf := (m: Message) => ((m.conversationId == conversationId) && precedes(rowOf(m), rowOf(local_3)));
  var local_6 := ProofLib.Filter(pf, s.messages);
  var lam := (acc: seq<Message>, m: Message) => (acc + [m.(id := (s.nextMessage + |acc|), conversationId := local_4, origin := Copied(m.id))]);
  var local_7 := Std.Collections.Seq.FoldLeft(lam, [], local_6);
  var nc := Conversation(local_4, Title(local_5.title.text, (local_5.title.edits + 1)), s.now, s.now, Publication.ForkPending);
  var nf := Fork(local_4, conversationId, requestId, messageId, local_3.at, textDigest);
  ConvForkFilter(s, conversationId, messageId, requestId, expectedText, textDigest);
  ConvForkAnswerFacts(s, conversationId, messageId, requestId, expectedText, textDigest);
  assert local_3 in s.messages && local_3.id == messageId && local_3.conversationId == conversationId;
  assert after == s.(conversations := s.conversations + [nc], messages := s.messages + local_7, forks := s.forks + [nf], nextConversation := s.nextConversation + 1, nextMessage := s.nextMessage + |local_6|);
  var f := (acc: seq<Message>, m: Message) => (acc + [m.(id := (s.nextMessage + |acc|), conversationId := local_4, origin := Copied(m.id))]);
  ProofLib.FoldLeftPointwise(lam, f, [], local_6, local_6);
  ConvCopies(s.nextMessage, local_4, local_6);
  forall i | 0 <= i < |local_6|
    ensures local_7[i] == local_6[i].(id := (s.nextMessage + i), conversationId := local_4, origin := Copied(local_6[i].id))
    ensures local_6[i] in s.messages && local_6[i].conversationId == nf.source && beforeBoundary(local_6[i], nf)
  {
    ProofLib.FilterMember(pf, s.messages, local_6[i]);
  }
  forall m | m in s.messages && m.conversationId == nf.source && beforeBoundary(m, nf)
    ensures m in local_6
  {
    ProofLib.FilterMember(pf, s.messages, m);
  }
  ConvForkIds(s, after, local_6, local_7, nc, nf);
  ConvAppended(s, after, nc);
  ConvForkOnePerRequest(s, after, nf);
  ConvForkPrefix(s, after, local_6, local_7, nf);
  ConvForkPending(s, after, nc, local_6, local_7);
  ConvGrowsStep(s, after, local_7);
}

lemma ConvNewestMember(rows: seq<Row>, n: int, y: Row)
  ensures (y in newest(rows, n)) == (y in rows && |ProofLib.Filter((x: Row) => precedes(y, x), rows)| < n)
{
  var p := (r: Row) => (|Std.Collections.Seq.Filter((x: Row) => precedes(r, x), rows)| < n);
  assert newest(rows, n) == ProofLib.Filter(p, rows);
  ProofLib.FilterMember(p, rows, y);
}

lemma ConvOldestMember(rows: seq<Row>, n: int, y: Row)
  ensures (y in oldest(rows, n)) == (y in rows && |ProofLib.Filter((x: Row) => precedes(x, y), rows)| < n)
{
  var p := (r: Row) => (|Std.Collections.Seq.Filter((x: Row) => precedes(x, r), rows)| < n);
  assert oldest(rows, n) == ProofLib.Filter(p, rows);
  ProofLib.FilterMember(p, rows, y);
}

lemma ConvFilterLength<T>(p: T -> bool, xs: seq<T>)
  ensures |ProofLib.Filter(p, xs)| <= |xs|
  ensures (forall x :: x in xs ==> p(x)) ==> |ProofLib.Filter(p, xs)| == |xs|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    ConvFilterLength(p, xs[1..]);
    if forall x :: x in xs ==> p(x) {
      forall x | x in xs[1..] ensures p(x) { }
    }
  }
}

lemma ConvFilterConcat<T>(p: T -> bool, a: seq<T>, b: seq<T>)
  ensures ProofLib.Filter(p, a + b) == ProofLib.Filter(p, a) + ProofLib.Filter(p, b)
  decreases |b|
{
  if |b| == 0 {
    assert a + b == a;
    ProofLib.FilterNil(p, b);
  } else {
    var c := b[..|b| - 1];
    var last := b[|b| - 1];
    assert b == c + [last];
    assert a + b == (a + c) + [last];
    ProofLib.FilterAppend(p, a + c, last);
    ProofLib.FilterAppend(p, c, last);
    ConvFilterConcat(p, a, c);
  }
}

lemma ConvSplit<T>(p: T -> bool, q: T -> bool, xs: seq<T>)
  ensures |ProofLib.Filter(p, xs)| == |ProofLib.Filter((x: T) => p(x) && q(x), xs)| + |ProofLib.Filter((x: T) => p(x) && !q(x), xs)|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
    ProofLib.FilterNil((x: T) => p(x) && q(x), xs);
    ProofLib.FilterNil((x: T) => p(x) && !q(x), xs);
  } else {
    ProofLib.FilterCons(p, xs);
    ProofLib.FilterCons((x: T) => p(x) && q(x), xs);
    ProofLib.FilterCons((x: T) => p(x) && !q(x), xs);
    ConvSplit(p, q, xs[1..]);
  }
}

lemma ConvMinimal(xs: seq<Row>)
  requires |xs| > 0
  ensures exists o :: o in xs && forall x :: x in xs ==> x == o || precedes(o, x)
  decreases |xs|
{
  if |xs| == 1 {
    var m := xs[0];
    assert m in xs;
    forall x | x in xs ensures x == m || precedes(m, x) { }
    assert m in xs && forall x :: x in xs ==> x == m || precedes(m, x);
  } else {
    var t := xs[1..];
    assert xs == [xs[0]] + t;
    ConvMinimal(t);
    var o :| o in t && forall x :: x in t ==> x == o || precedes(o, x);
    var m := if precedes(xs[0], o) then xs[0] else o;
    assert m in xs;
    forall x | x in xs ensures x == m || precedes(m, x) {
      if x != xs[0] {
        assert x in t;
      } else {
        assert x == Row(x.id, x.at) && o == Row(o.id, o.at);
      }
    }
    assert m in xs && forall x :: x in xs ==> x == m || precedes(m, x);
  }
}

lemma ConvMaximal(xs: seq<Row>)
  requires |xs| > 0
  ensures exists o :: o in xs && forall x :: x in xs ==> x == o || precedes(x, o)
  decreases |xs|
{
  if |xs| == 1 {
    var m := xs[0];
    assert m in xs;
    forall x | x in xs ensures x == m || precedes(x, m) { }
    assert m in xs && forall x :: x in xs ==> x == m || precedes(x, m);
  } else {
    var t := xs[1..];
    assert xs == [xs[0]] + t;
    ConvMaximal(t);
    var o :| o in t && forall x :: x in t ==> x == o || precedes(x, o);
    var m := if precedes(o, xs[0]) then xs[0] else o;
    assert m in xs;
    forall x | x in xs ensures x == m || precedes(x, m) {
      if x != xs[0] {
        assert x in t;
      } else {
        assert x == Row(x.id, x.at) && o == Row(o.id, o.at);
      }
    }
    assert m in xs && forall x :: x in xs ==> x == m || precedes(x, m);
  }
}

lemma ConvNewestAtMost(rows: seq<Row>, n: int)
  requires ProofLib.Distinct(rows) && n >= 0
  ensures |newest(rows, n)| <= n
{
  var nn := newest(rows, n);
  if |nn| > 0 {
    ConvMinimal(nn);
    var o :| o in nn && forall x :: x in nn ==> x == o || precedes(o, x);
    ConvNewestMember(rows, n, o);
    var pN := (r: Row) => (|Std.Collections.Seq.Filter((x: Row) => precedes(r, x), rows)| < n);
    assert nn == ProofLib.Filter(pN, rows);
    forall x | x in rows && pN(x) ensures x == o || precedes(o, x) {
      ProofLib.FilterMember(pN, rows, x);
    }
    ConvCountAbove(pN, rows, o);
  }
}

lemma ConvOldestAtMost(rows: seq<Row>, n: int)
  requires ProofLib.Distinct(rows) && n >= 0
  ensures |oldest(rows, n)| <= n
{
  var nn := oldest(rows, n);
  if |nn| > 0 {
    ConvMaximal(nn);
    var o :| o in nn && forall x :: x in nn ==> x == o || precedes(x, o);
    ConvOldestMember(rows, n, o);
    var pN := (r: Row) => (|Std.Collections.Seq.Filter((x: Row) => precedes(x, r), rows)| < n);
    assert nn == ProofLib.Filter(pN, rows);
    forall x | x in rows && pN(x) ensures x == o || precedes(x, o) {
      ProofLib.FilterMember(pN, rows, x);
    }
    ConvCountBelow(pN, rows, o);
  }
}

lemma ConvDistinctRows(rows: seq<Row>)
  requires !((exists r :: r in rows && !((|ProofLib.Filter((x: Row) => (x == r), rows)| == 1))))
  ensures ProofLib.Distinct(rows)
{
  forall i, j | 0 <= i < j < |rows|
    ensures rows[i] != rows[j]
  {
    if rows[i] == rows[j] {
      var r := rows[i];
      assert r in rows;
      ProofLib.FilterTwo((x: Row) => (x == r), rows, i, j);
    }
  }
}

lemma ConvDistinctFilter(p: Row -> bool, rows: seq<Row>)
  requires ProofLib.Distinct(rows)
  ensures ProofLib.Distinct(ProofLib.Filter(p, rows))
{
  ProofLib.FilterKeepsDistinctBy(p, rows, (x: Row) => x);
}

lemma ConvAroundFilterLaw(rows: seq<Row>, pivot: Row, n: int)
  ensures lawAroundHoldsThePivotAndAtMostNEachSide(rows, pivot, n) == (!(((n >= 0) && !((exists r :: r in rows && !((|ProofLib.Filter((x: Row) => (x == r), rows)| == 1)))))) || (((pivot in around(rows, pivot, n)) && (|ProofLib.Filter((r: Row) => precedes(r, pivot), around(rows, pivot, n))| <= n)) && (|ProofLib.Filter((r: Row) => precedes(pivot, r), around(rows, pivot, n))| <= n)))
{
}

lemma ConvPageIsTheNewestFilter(rows: seq<Row>, n: int)
  ensures lawPageIsTheNewest(rows, n) == !((exists r :: r in rows && !(((r in newest(rows, n)) || !((exists q :: q in newest(rows, n) && !(precedes(r, q))))))))
{
}

lemma {:induction false} ConvTake(xs: seq<int>, offset: int, n: int, i: int, acc: seq<int>)
  requires i >= 0 && offset >= 0 && n >= 0
  ensures Std.Collections.Seq.FoldLeft((w: Taking, x: int) => Taking((w.index + 1), (if ((w.index >= offset) && (w.index < (offset + n))) then (w.taken + [x]) else w.taken)), Taking(i, acc), xs).taken
    == acc + xs[(if offset - i < 0 then 0 else if offset - i > |xs| then |xs| else offset - i)..(if offset + n - i < 0 then 0 else if offset + n - i > |xs| then |xs| else offset + n - i)]
  decreases |xs|
{
  var f := (w: Taking, x: int) => Taking((w.index + 1), (if ((w.index >= offset) && (w.index < (offset + n))) then (w.taken + [x]) else w.taken));
  if |xs| > 0 {
    var next := f(Taking(i, acc), xs[0]);
    assert Std.Collections.Seq.FoldLeft(f, Taking(i, acc), xs) == Std.Collections.Seq.FoldLeft(f, next, xs[1..]);
    ConvTake(xs[1..], offset, n, i + 1, next.taken);
    var lo := (if offset - i < 0 then 0 else if offset - i > |xs| then |xs| else offset - i);
    var hi := (if offset + n - i < 0 then 0 else if offset + n - i > |xs| then |xs| else offset + n - i);
    if offset <= i < offset + n {
      assert xs[lo..hi] == [xs[0]] + xs[1..][0..hi - 1];
    } else if i < offset {
      assert xs[lo..hi] == xs[1..][lo - 1..hi - 1];
    }
  }
}

lemma ConvScrubFacts(messages: seq<Message>, conversationId: int, text: string)
  ensures |scrub(messages, conversationId, text)| == |messages|
  ensures forall i :: 0 <= i < |messages| ==> sameExceptBody(messages[i], scrub(messages, conversationId, text)[i])
{
}

lemma ConvBodiesOnly(s: Conversations, after: Conversations)
  requires alwaysForkHoldsTheWholePrefix(s)
  requires after.forks == s.forks && |after.messages| == |s.messages|
  requires forall i :: 0 <= i < |s.messages| ==> sameExceptBody(s.messages[i], after.messages[i])
  ensures alwaysForkHoldsTheWholePrefix(after)
{
  hide *;
  ConvWholePrefixIs(s);
  ConvWholePrefixIs(after);
  ConvBodiesOnlyCopies(s, after);
  ConvBodiesOnlySources(s, after);
}

lemma ConvBodiesOnlyStep(s: Conversations, after: Conversations)
  requires |after.messages| == |s.messages| && |after.log| == |s.log|
  requires forall i :: 0 <= i < |s.messages| ==> sameExceptBody(s.messages[i], after.messages[i])
  ensures stepOnlyRedactionChangesStoredText(s, "redact", after)
{
  forall m | m in s.messages
    ensures exists n :: n in after.messages && sameExceptBody(m, n)
  {
    var i :| 0 <= i < |s.messages| && s.messages[i] == m;
    assert after.messages[i] in after.messages;
  }
}

lemma ConvForkAnswerFacts(s: Conversations, conversationId: int, messageId: int, requestId: string, expectedText: string, textDigest: int)
  requires alwaysOneForkPerRequest(s) && alwaysIdsAreFresh(s)
  requires canFork(s, conversationId, messageId, requestId, expectedText, textDigest)
  ensures conversationId >= 1 && conversationId < s.nextConversation
  ensures forall g :: g in s.forks ==> !(g.source == conversationId && g.requestId == requestId)
  ensures messageAt(s, messageId) in s.messages && messageAt(s, messageId).id == messageId && messageAt(s, messageId).conversationId == conversationId
{
  ConvForkAnswerFilter(s, conversationId, messageId, requestId, expectedText, textDigest);
  var pr := (f: Fork) => ((f.source == conversationId) && (f.requestId == requestId));
  assert isPublished(s, conversationId);
  var src :| src in s.conversations && src.id == conversationId && src.publication.Published?;
  forall g | g in s.forks
    ensures !(g.source == conversationId && g.requestId == requestId)
  {
    ConvAlwaysOneForkPerRequestFilter(s);
    ProofLib.FilterMember(pr, s.forks, g);
    if g.source == conversationId && g.requestId == requestId {
      assert |ProofLib.Filter(pr, s.forks)| > 0;
      ProofLib.FilterMember(pr, s.forks, ProofLib.Filter(pr, s.forks)[0]);
    }
  }
  var local_3 := messageAt(s, messageId);
  assert local_3.conversationId == conversationId;
  ConvMessageAtFilter(s, messageId);
  assert |ProofLib.Filter((m: Message) => (m.id == messageId), s.messages)| > 0;
  ProofLib.FilterMember((m: Message) => (m.id == messageId), s.messages, local_3);
}

lemma ConvForkIds(s: Conversations, after: Conversations, sel: seq<Message>, copies: seq<Message>, nc: Conversation, nf: Fork)
  requires alwaysIdsAreFresh(s)
  requires after.conversations == s.conversations + [nc] && after.messages == s.messages + copies && after.forks == s.forks + [nf]
  requires after.nextConversation == s.nextConversation + 1 && after.nextMessage == s.nextMessage + |sel| && after.now == s.now
  requires nc.id == s.nextConversation && nc.createdAt == s.now && nc.updatedAt == s.now
  requires nf.forkId == s.nextConversation && nf.source >= 1 && nf.source < s.nextConversation && nf.boundary < s.nextMessage && nf.boundaryAt <= s.now
  requires |copies| == |sel|
  requires forall i :: 0 <= i < |sel| ==> copies[i] == sel[i].(id := (s.nextMessage + i), conversationId := s.nextConversation, origin := Copied(sel[i].id)) && sel[i] in s.messages
  ensures alwaysIdsAreFresh(after)
{
  forall m | m in after.messages
    ensures m.id >= 1 && m.id < after.nextMessage && m.at <= after.now && m.conversationId >= 1 && m.conversationId < after.nextConversation
  {
    if !(m in s.messages) {
      var k :| 0 <= k < |copies| && copies[k] == m;
      assert sel[k] in s.messages;
    }
  }
  forall c | c in after.conversations
    ensures c.id >= 1 && c.id < after.nextConversation && c.createdAt <= c.updatedAt && c.updatedAt <= after.now
  {
    if c != nc { assert c in s.conversations; }
  }
  forall f | f in after.forks
    ensures f.source >= 1 && f.source < f.forkId && f.forkId < after.nextConversation && f.boundary < after.nextMessage && f.boundaryAt <= after.now
  {
    if f != nf { assert f in s.forks; }
  }
}

lemma ConvForkOnePerRequest(s: Conversations, after: Conversations, nf: Fork)
  requires alwaysOneForkPerRequest(s)
  requires after.forks == s.forks + [nf] && nf.forkId >= 1
  requires forall g :: g in s.forks ==> !(g.source == nf.source && g.requestId == nf.requestId)
  ensures alwaysOneForkPerRequest(after)
{
  ConvAlwaysOneForkPerRequestFilter(s);
  ConvAlwaysOneForkPerRequestFilter(after);
  forall g | g in after.forks
    ensures g.forkId >= 1 && |ProofLib.Filter((h: Fork) => ((h.source == g.source) && (h.requestId == g.requestId)), after.forks)| == 1
  {
    ConvAppendCount((h: Fork) => ((h.source == g.source) && (h.requestId == g.requestId)), s.forks, nf);
    if g != nf {
      assert g in s.forks;
    } else {
      ProofLib.FilterNone((h: Fork) => ((h.source == g.source) && (h.requestId == g.requestId)), s.forks);
    }
  }
}

lemma ConvForkPrefix(s: Conversations, after: Conversations, sel: seq<Message>, copies: seq<Message>, nf: Fork)
  requires alwaysForkHoldsTheWholePrefix(s) && alwaysIdsAreFresh(s)
  requires after.messages == s.messages + copies && after.forks == s.forks + [nf]
  requires nf.forkId == s.nextConversation && nf.source < s.nextConversation
  requires |copies| == |sel|
  requires forall i :: 0 <= i < |sel| ==> copies[i] == sel[i].(id := (s.nextMessage + i), conversationId := s.nextConversation, origin := Copied(sel[i].id))
  requires forall i :: 0 <= i < |sel| ==> sel[i] in s.messages && sel[i].conversationId == nf.source && beforeBoundary(sel[i], nf)
  requires forall m :: m in s.messages && m.conversationId == nf.source && beforeBoundary(m, nf) ==> m in sel
  ensures alwaysForkHoldsTheWholePrefix(after)
{
  hide *;
  ConvWholePrefixIs(s);
  ConvWholePrefixIs(after);
  reveal alwaysIdsAreFresh;
  forall m | m in s.messages ensures m.conversationId < s.nextConversation { }
  forall g | g in s.forks ensures g.source < g.forkId && g.forkId < s.nextConversation { }
  reveal beforeBoundary, copiedFrom, rowOf, typed1_agent__conversation__conversations;
  forall g, m | g in after.forks && m in after.messages && m.conversationId == g.source && beforeBoundary(m, g)
    ensures exists c :: c in after.messages && c.conversationId == g.forkId && copiedFrom(c, m)
  {
    if !(m in s.messages) {
      var k :| 0 <= k < |copies| && copies[k] == m;
      if g != nf { assert g in s.forks; }
      assert false;
    }
    if g == nf {
      var k :| 0 <= k < |sel| && sel[k] == m;
      assert copies[k] in after.messages && copies[k].conversationId == g.forkId && copiedFrom(copies[k], m);
    } else {
      assert g in s.forks;
      var c :| c in s.messages && c.conversationId == g.forkId && copiedFrom(c, m);
      assert c in after.messages;
    }
  }
  forall g, c | g in after.forks && c in after.messages && c.conversationId == g.forkId && !c.origin.Original?
    ensures exists m :: m in after.messages && m.conversationId == g.source && beforeBoundary(m, g) && copiedFrom(c, m)
  {
    if g == nf {
      assert !(c in s.messages);
      var k :| 0 <= k < |copies| && copies[k] == c;
      assert sel[k] in after.messages && sel[k].conversationId == g.source && beforeBoundary(sel[k], g) && copiedFrom(c, sel[k]);
    } else {
      assert g in s.forks;
      if !(c in s.messages) {
        var k :| 0 <= k < |copies| && copies[k] == c;
        assert false;
      }
      var m :| m in s.messages && m.conversationId == g.source && beforeBoundary(m, g) && copiedFrom(c, m);
      assert m in after.messages;
    }
  }
}

lemma ConvForkPending(s: Conversations, after: Conversations, nc: Conversation, sel: seq<Message>, copies: seq<Message>)
  requires alwaysPendingForkHoldsOnlyCopies(s) && alwaysOneRecordPerConversation(s) && alwaysIdsAreFresh(s)
  requires after.conversations == s.conversations + [nc] && nc.id == s.nextConversation && after.messages == s.messages + copies
  requires |copies| == |sel|
  requires forall i :: 0 <= i < |sel| ==> copies[i] == sel[i].(id := (s.nextMessage + i), conversationId := s.nextConversation, origin := Copied(sel[i].id))
  ensures alwaysPendingForkHoldsOnlyCopies(after)
{
  ConvAppended(s, after, nc);
  forall m | m in after.messages && conversationOf(after, m.conversationId).publication.ForkPending?
    ensures !m.origin.Original?
  {
    if m in s.messages {
      assert conversationOf(after, m.conversationId) == conversationOf(s, m.conversationId);
    } else {
      var k :| 0 <= k < |copies| && copies[k] == m;
    }
  }
}

lemma ConvGrowsStep(s: Conversations, after: Conversations, added: seq<Message>)
  requires after.messages == s.messages + added && after.log == s.log
  ensures stepOnlyRedactionChangesStoredText(s, "fork", after)
{
  forall m | m in s.messages
    ensures m in after.messages && sameExceptBody(m, m)
  {
  }
}

lemma ConvCountAbove(p: Row -> bool, rows: seq<Row>, y: Row)
  requires ProofLib.Distinct(rows)
  requires forall x :: x in rows && p(x) ==> x == y || precedes(y, x)
  ensures |ProofLib.Filter(p, rows)| <= |ProofLib.Filter((x: Row) => precedes(y, x), rows)| + (if y in rows then 1 else 0)
  decreases |rows|
{
  if |rows| == 0 {
    ProofLib.FilterNil(p, rows);
    ProofLib.FilterNil((x: Row) => precedes(y, x), rows);
  } else {
    var t := rows[1..];
    assert rows == [rows[0]] + t;
    forall i, j | 0 <= i < j < |t| ensures t[i] != t[j] {
      assert t[i] == rows[i + 1] && t[j] == rows[j + 1];
    }
    if rows[0] == y {
      forall k | 0 <= k < |t| ensures t[k] != y {
        assert t[k] == rows[k + 1];
      }
    }
    ConvCountAbove(p, t, y);
    ProofLib.FilterCons(p, rows);
    ProofLib.FilterCons((x: Row) => precedes(y, x), rows);
  }
}

lemma ConvCountBelow(p: Row -> bool, rows: seq<Row>, y: Row)
  requires ProofLib.Distinct(rows)
  requires forall x :: x in rows && p(x) ==> x == y || precedes(x, y)
  ensures |ProofLib.Filter(p, rows)| <= |ProofLib.Filter((x: Row) => precedes(x, y), rows)| + (if y in rows then 1 else 0)
  decreases |rows|
{
  if |rows| == 0 {
    ProofLib.FilterNil(p, rows);
    ProofLib.FilterNil((x: Row) => precedes(x, y), rows);
  } else {
    var t := rows[1..];
    assert rows == [rows[0]] + t;
    forall i, j | 0 <= i < j < |t| ensures t[i] != t[j] {
      assert t[i] == rows[i + 1] && t[j] == rows[j + 1];
    }
    if rows[0] == y {
      forall k | 0 <= k < |t| ensures t[k] != y {
        assert t[k] == rows[k + 1];
      }
    }
    ConvCountBelow(p, t, y);
    ProofLib.FilterCons(p, rows);
    ProofLib.FilterCons((x: Row) => precedes(x, y), rows);
  }
}

lemma ConvWholePrefixIs(s: Conversations)
  ensures alwaysForkHoldsTheWholePrefix(s) <==> (forall f, m :: f in s.forks && m in s.messages && m.conversationId == f.source && beforeBoundary(m, f) ==> exists c :: c in s.messages && c.conversationId == f.forkId && copiedFrom(c, m)) && (forall f, c :: f in s.forks && c in s.messages && c.conversationId == f.forkId && !c.origin.Original? ==> exists m :: m in s.messages && m.conversationId == f.source && beforeBoundary(m, f) && copiedFrom(c, m))
{
}

lemma ConvAroundSide(a: seq<Row>, pivot: Row, b: seq<Row>, n: int)
  requires |a| <= n && |b| <= n
  requires forall x :: x in a ==> precedes(x, pivot)
  requires forall x :: x in b ==> precedes(pivot, x)
  ensures |ProofLib.Filter((r: Row) => precedes(r, pivot), (a + [pivot]) + b)| <= n
  ensures |ProofLib.Filter((r: Row) => precedes(pivot, r), (a + [pivot]) + b)| <= n
{
  ConvFilterConcat((r: Row) => precedes(r, pivot), a + [pivot], b);
  ConvFilterConcat((r: Row) => precedes(r, pivot), a, [pivot]);
  ConvFilterConcat((r: Row) => precedes(pivot, r), a + [pivot], b);
  ConvFilterConcat((r: Row) => precedes(pivot, r), a, [pivot]);
  ConvFilterLength((r: Row) => precedes(r, pivot), a);
  ConvFilterLength((r: Row) => precedes(pivot, r), b);
  assert !precedes(pivot, pivot);
  forall i | 0 <= i < |b| ensures !precedes(b[i], pivot) { assert b[i] in b; }
  forall i | 0 <= i < |a| ensures !precedes(pivot, a[i]) { assert a[i] in a; }
  forall i | 0 <= i < |[pivot]| ensures !precedes([pivot][i], pivot) && !precedes(pivot, [pivot][i]) { }
  ProofLib.FilterNone((r: Row) => precedes(r, pivot), b);
  ProofLib.FilterNone((r: Row) => precedes(pivot, r), a);
  ProofLib.FilterNone((r: Row) => precedes(r, pivot), [pivot]);
  ProofLib.FilterNone((r: Row) => precedes(pivot, r), [pivot]);
}

lemma ConvBodiesOnlyCopies(s: Conversations, after: Conversations)
  requires forall f, m :: f in s.forks && m in s.messages && m.conversationId == f.source && beforeBoundary(m, f) ==> exists c :: c in s.messages && c.conversationId == f.forkId && copiedFrom(c, m)
  requires after.forks == s.forks && |after.messages| == |s.messages|
  requires forall i :: 0 <= i < |s.messages| ==> sameExceptBody(s.messages[i], after.messages[i])
  ensures forall f, m :: f in after.forks && m in after.messages && m.conversationId == f.source && beforeBoundary(m, f) ==> exists c :: c in after.messages && c.conversationId == f.forkId && copiedFrom(c, m)
{
  hide *;
  reveal sameExceptBody, beforeBoundary, copiedFrom, rowOf, typed1_agent__conversation__conversations;
  forall f, m | f in after.forks && m in after.messages && m.conversationId == f.source && beforeBoundary(m, f)
    ensures exists c :: c in after.messages && c.conversationId == f.forkId && copiedFrom(c, m)
  {
    var i :| 0 <= i < |after.messages| && after.messages[i] == m;
    var o := s.messages[i];
    assert sameExceptBody(o, m);
    assert o in s.messages && o.conversationId == f.source && beforeBoundary(o, f);
    var c :| c in s.messages && c.conversationId == f.forkId && copiedFrom(c, o);
    var j :| 0 <= j < |s.messages| && s.messages[j] == c;
    assert sameExceptBody(c, after.messages[j]);
    assert after.messages[j] in after.messages && after.messages[j].conversationId == f.forkId && copiedFrom(after.messages[j], m);
  }
}

lemma ConvBodiesOnlySources(s: Conversations, after: Conversations)
  requires forall f, c :: f in s.forks && c in s.messages && c.conversationId == f.forkId && !c.origin.Original? ==> exists m :: m in s.messages && m.conversationId == f.source && beforeBoundary(m, f) && copiedFrom(c, m)
  requires after.forks == s.forks && |after.messages| == |s.messages|
  requires forall i :: 0 <= i < |s.messages| ==> sameExceptBody(s.messages[i], after.messages[i])
  ensures forall f, c :: f in after.forks && c in after.messages && c.conversationId == f.forkId && !c.origin.Original? ==> exists m :: m in after.messages && m.conversationId == f.source && beforeBoundary(m, f) && copiedFrom(c, m)
{
  hide *;
  reveal sameExceptBody, beforeBoundary, copiedFrom, rowOf, typed1_agent__conversation__conversations;
  forall f, c | f in after.forks && c in after.messages && c.conversationId == f.forkId && !c.origin.Original?
    ensures exists m :: m in after.messages && m.conversationId == f.source && beforeBoundary(m, f) && copiedFrom(c, m)
  {
    var j :| 0 <= j < |after.messages| && after.messages[j] == c;
    var oc := s.messages[j];
    assert sameExceptBody(oc, c);
    assert oc in s.messages && oc.conversationId == f.forkId && !oc.origin.Original?;
    var m :| m in s.messages && m.conversationId == f.source && beforeBoundary(m, f) && copiedFrom(oc, m);
    var i :| 0 <= i < |s.messages| && s.messages[i] == m;
    assert sameExceptBody(m, after.messages[i]);
    assert after.messages[i] in after.messages && after.messages[i].conversationId == f.source && beforeBoundary(after.messages[i], f) && copiedFrom(c, after.messages[i]);
  }
}
