lemma FeedIdsFilter(s: EventFeed)
  ensures alwaysFeedIdsAreFresh(s) == ((s.nextFeed > 0) && !((exists f :: f in s.feeds && !((((f.id > 0) && (f.id < s.nextFeed)) && (|ProofLib.Filter((g: Feed) => (g.id == f.id), s.feeds)| == 1))))))
{}

lemma StrikeInvariantFilter(s: EventFeed)
  ensures alwaysStrikesBelowThreshold(s) == !((exists x :: x in s.strikes && !((((x.count > 0) && (x.count < escalationThreshold)) && (|ProofLib.Filter((y: Strike) => (y.code == x.code), s.strikes)| == 1)))))
{}

lemma NoticeThresholdFilter(before: EventFeed, after: EventFeed, out: seq<Frame>)
  ensures stepNoticeOnlyAtThreshold(before, after, out) == (((|ProofLib.Filter((fr: Frame) => isStore(fr), out)| <= 1) && (!((exists fr :: fr in out && announcesNotice(fr))) || (exists fr :: fr in out && isStore(fr)))) && (!((exists fr :: fr in out && isStore(fr))) || (exists x :: x in before.strikes && ((x.count == (escalationThreshold - 1)) && (strikeCount(after, x.code) == 0)))))
{}

lemma StrikeCountFilter(s: EventFeed, code: string)
  ensures strikeCount(s, code) == (if ((0 <= 0) && (0 < |ProofLib.Filter((x: Strike) => (x.code == code), s.strikes)|)) then ProofLib.Filter((x: Strike) => (x.code == code), s.strikes)[0] else Strike(code, 0)).count
{}

lemma EndFeedFilter(feed: int, reason: EndReason, s: EventFeed)
  ensures endFeed(feed, reason, s).state.feeds == ProofLib.Filter((f: Feed) => (f.id != feed), s.feeds)
{}

lemma HearersFilter(s: EventFeed, news: FeedEvent)
  ensures hearersOf(s, news) == idsOf(ProofLib.Filter((f: Feed) => wants(f, news), s.feeds))
{}

lemma ChangeStrikeFilter(code: string, n: int, s: EventFeed)
  ensures withStrikes(code, n, s).strikes == (if n > 0 then ProofLib.Filter((x: Strike) => (x.code != code), s.strikes) + [Strike(code, n)] else ProofLib.Filter((x: Strike) => (x.code != code), s.strikes))
{}

lemma FilteredMemberCount<T>(items: seq<T>, kept: T -> bool, same: T -> bool, x: T)
  requires x in items && kept(x) && same(x)
  requires |ProofLib.Filter(same, items)| == 1
  ensures |ProofLib.Filter(same, ProofLib.Filter(kept, items))| == 1
{
  var filtered := ProofLib.Filter(kept, items);
  var matched := ProofLib.Filter(same, filtered);
  ProofLib.FilterMember(kept, items, x);
  assert x in filtered;
  ProofLib.FilterMember(same, filtered, x);
  assert x in matched;
  assert |matched| != 0;
  ProofLib.FilterOfFilterLength(kept, same, same, items);
  assert |matched| <= 1;
}

lemma RemovedFeed(s: EventFeed, feed: int, reason: EndReason)
  requires inv(s)
  ensures alwaysFeedsAskedValidly(endFeed(feed, reason, s).state)
  ensures alwaysFeedIdsAreFresh(endFeed(feed, reason, s).state)
  ensures alwaysFeedOrderWithinPublished(endFeed(feed, reason, s).state)
  ensures stepEndedFeedsAreAnnounced(s, endFeed(feed, reason, s).state, endFeed(feed, reason, s).out)
{
  var after := endFeed(feed, reason, s);
  var kept: Feed -> bool := (f: Feed) => f.id != feed;
  EndFeedFilter(feed, reason, s);
  FeedIdsFilter(s);
  FeedIdsFilter(after.state);
  assert after.state.feeds == ProofLib.Filter(kept, s.feeds);
  forall f | f in after.state.feeds
    ensures kindValid(f.kind) && f.id > 0 && f.id < after.state.nextFeed
    ensures |ProofLib.Filter((g: Feed) => g.id == f.id, after.state.feeds)| == 1
    ensures 0 <= f.since <= f.lastSeq <= after.state.published
  {
    ProofLib.FilterMember(kept, s.feeds, f);
    assert f in s.feeds && f.id != feed;
    var same: Feed -> bool := (g: Feed) => g.id == f.id;
    assert |ProofLib.Filter(same, s.feeds)| == 1;
    FilteredMemberCount(s.feeds, kept, same, f);
  }
  forall f | f in s.feeds
    ensures isLive(after.state, f.id) || (exists fr :: fr in after.out && endsFeed(fr, f.id))
  {
    if f.id != feed {
      ProofLib.FilterMember(kept, s.feeds, f);
    } else {
      assert Ended([feed], reason) in after.out;
    }
  }
}

lemma IdMembership(feeds: seq<Feed>, id: int)
  ensures id in idsOf(feeds) <==> exists f :: f in feeds && f.id == id
  decreases |feeds|
{
  if |feeds| != 0 {
    var prefix := feeds[..|feeds| - 1];
    var last := feeds[|feeds| - 1];
    assert feeds == prefix + [last];
    IdMembership(prefix, id);
    ProofLib.FoldLeftAppend((acc: seq<int>, f: Feed) =>
      acc + Std.Collections.Seq.Filter((x: int) => !(x in acc), [f.id]), [], prefix, last);
    ProofLib.FilterMember((x: int) => !(x in idsOf(prefix)), [last.id], id);
  }
}

lemma DeliveryFacts(s: EventFeed, news: FeedEvent)
  requires alwaysFeedsAskedValidly(s) && alwaysFeedIdsAreFresh(s) && alwaysFeedOrderWithinPublished(s)
  ensures alwaysFeedsAskedValidly(deliver(news, s).state)
  ensures alwaysFeedIdsAreFresh(deliver(news, s).state)
  ensures alwaysFeedOrderWithinPublished(deliver(news, s).state)
  ensures stepDeliveryReachesExactlyTheAskers(s, deliver(news, s).state, deliver(news, s).out)
  ensures stepEndedFeedsAreAnnounced(s, deliver(news, s).state, deliver(news, s).out)
{
  var after := deliver(news, s);
  var interested: Feed -> bool := (f: Feed) => wants(f, news);
  var asked := ProofLib.Filter(interested, s.feeds);
  HearersFilter(s, news);
  FeedIdsFilter(s);
  FeedIdsFilter(after.state);
  assert hearersOf(s, news) == idsOf(asked);
  assert |after.state.feeds| == |s.feeds|;
  forall i | 0 <= i < |s.feeds|
    ensures after.state.feeds[i].id == s.feeds[i].id
    ensures after.state.feeds[i].kind == s.feeds[i].kind
    ensures 0 <= after.state.feeds[i].since <= after.state.feeds[i].lastSeq <= after.state.published
  {
  }
  forall f | f in after.state.feeds
    ensures kindValid(f.kind) && 0 < f.id < after.state.nextFeed
    ensures |ProofLib.Filter((g: Feed) => g.id == f.id, after.state.feeds)| == 1
    ensures 0 <= f.since <= f.lastSeq <= after.state.published
  {
    var i :| 0 <= i < |after.state.feeds| && f == after.state.feeds[i];
    assert s.feeds[i] in s.feeds;
    assert s.feeds[i].id == f.id;
    var same: Feed -> bool := (g: Feed) => g.id == f.id;
    assert |ProofLib.Filter(same, s.feeds)| == 1;
    ProofLib.FilterLengthPointwise(same, same, s.feeds, after.state.feeds);
  }
  forall f | f in s.feeds
    ensures isLive(after.state, f.id)
  {
    var i :| 0 <= i < |s.feeds| && f == s.feeds[i];
    assert after.state.feeds[i] in after.state.feeds;
  }
  forall id | id in hearersOf(s, news)
    ensures exists f :: f in s.feeds && f.id == id
  {
    IdMembership(asked, id);
    assert id in idsOf(asked);
    var f :| f in asked && f.id == id;
    ProofLib.FilterMember(interested, s.feeds, f);
    assert f in s.feeds;
    assert exists f' :: f' in s.feeds && f'.id == id;
  }
  forall f | f in s.feeds
    ensures (f.id in hearersOf(s, news)) == wants(f, news)
  {
    IdMembership(asked, f.id);
    ProofLib.FilterMember(interested, s.feeds, f);
    if f.id in hearersOf(s, news) {
      assert f.id in idsOf(asked);
      var g :| g in asked && g.id == f.id;
      ProofLib.FilterMember(interested, s.feeds, g);
      assert g in s.feeds && wants(g, news);
      if g != f {
        var left :| 0 <= left < |s.feeds| && s.feeds[left] == f;
        var right :| 0 <= right < |s.feeds| && s.feeds[right] == g;
        ProofLib.FilterTwo((h: Feed) => h.id == f.id, s.feeds, left, right);
      }
    }
  }
}

lemma StrikeFacts(s: EventFeed, code: string)
  requires alwaysStrikesBelowThreshold(s)
  ensures 0 <= strikeCount(s, code) < escalationThreshold
  ensures strikeCount(s, code) != 0 ==> exists x :: x in s.strikes && x.code == code && x.count == strikeCount(s, code)
{
  var same: Strike -> bool := (x: Strike) => x.code == code;
  var matched := ProofLib.Filter(same, s.strikes);
  StrikeCountFilter(s, code);
  if |matched| > 0 {
    assert matched[0] in matched;
    ProofLib.FilterMember(same, s.strikes, matched[0]);
    var x := matched[0];
    assert x in s.strikes && x.code == code;
    assert strikeCount(s, code) == x.count;
    assert 0 < x.count < escalationThreshold;
    assert exists present :: present in s.strikes && present.code == code && present.count == strikeCount(s, code);
  } else {
    assert strikeCount(s, code) == 0;
  }
}

lemma ChangeStrike(s: EventFeed, code: string, count: int)
  requires alwaysStrikesBelowThreshold(s)
  requires count < escalationThreshold
  ensures alwaysStrikesBelowThreshold(withStrikes(code, count, s))
  ensures strikeCount(withStrikes(code, count, s), code) == (if count > 0 then count else 0)
{
  var kept: Strike -> bool := (x: Strike) => x.code != code;
  var remaining := ProofLib.Filter(kept, s.strikes);
  var after := withStrikes(code, count, s);
  ChangeStrikeFilter(code, count, s);
  StrikeInvariantFilter(s);
  StrikeInvariantFilter(after);
  StrikeCountFilter(after, code);
  assert after.strikes == (if count > 0 then remaining + [Strike(code, count)] else remaining);
  forall x | x in after.strikes
    ensures 0 < x.count < escalationThreshold
    ensures |ProofLib.Filter((y: Strike) => y.code == x.code, after.strikes)| == 1
  {
    var same: Strike -> bool := (y: Strike) => y.code == x.code;
    if x in remaining {
      ProofLib.FilterMember(kept, s.strikes, x);
      assert x in s.strikes && x.code != code;
      assert |ProofLib.Filter(same, s.strikes)| == 1;
      FilteredMemberCount(s.strikes, kept, same, x);
      if count > 0 {
        ProofLib.FilterAppend(same, remaining, Strike(code, count));
      }
    } else {
      assert count > 0 && x == Strike(code, count);
      var matching := ProofLib.Filter(same, remaining);
      if |matching| != 0 {
        ProofLib.FilterMember(same, remaining, matching[0]);
        assert matching[0] in remaining && matching[0].code == code;
        ProofLib.FilterMember(kept, s.strikes, matching[0]);
        assert matching[0].code != code;
      }
      ProofLib.FilterAppend(same, remaining, Strike(code, count));
    }
  }
  var sameCode: Strike -> bool := (y: Strike) => y.code == code;
  var keptMatching := ProofLib.Filter(sameCode, remaining);
  if |keptMatching| != 0 {
    ProofLib.FilterMember(sameCode, remaining, keptMatching[0]);
    assert keptMatching[0] in remaining && keptMatching[0].code == code;
    ProofLib.FilterMember(kept, s.strikes, keptMatching[0]);
    assert keptMatching[0].code != code;
  }
  if count > 0 {
    ProofLib.FilterAppend(sameCode, remaining, Strike(code, count));
    assert ProofLib.Filter(sameCode, after.strikes) == [Strike(code, count)];
  }
}

lemma subscribe_ensures(s: EventFeed, streams: seq<StreamName>, clientId: string)
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> alwaysFeedsAskedValidly(subscribe(s, streams, clientId).state))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> alwaysFeedIdsAreFresh(subscribe(s, streams, clientId).state))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> alwaysFeedOrderWithinPublished(subscribe(s, streams, clientId).state))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> alwaysStoppedHasNoFeeds(subscribe(s, streams, clientId).state))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> alwaysStrikesBelowThreshold(subscribe(s, streams, clientId).state))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> stepSubscribeAnswersOnceWithoutReplay(s, "subscribe", subscribe(s, streams, clientId).state, subscribe(s, streams, clientId).out))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> stepDeliveryReachesExactlyTheAskers(s, subscribe(s, streams, clientId).state, subscribe(s, streams, clientId).out))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> stepPublicationOrderGrows(s, subscribe(s, streams, clientId).state))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> stepEndedFeedsAreAnnounced(s, subscribe(s, streams, clientId).state, subscribe(s, streams, clientId).out))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> stepNoticeOnlyAtThreshold(s, subscribe(s, streams, clientId).state, subscribe(s, streams, clientId).out))
{
  if inv(s) && canSubscribe(s, streams, clientId) {
    var after := subscribe(s, streams, clientId);
    var added := after.state.feeds[|after.state.feeds| - 1];
    assert after.state.feeds == s.feeds + [added];
    assert added.id == s.nextFeed;
    FeedIdsFilter(s);
    FeedIdsFilter(after.state);
    forall f | f in after.state.feeds
      ensures 0 < f.id < after.state.nextFeed
      ensures |ProofLib.Filter((g: Feed) => g.id == f.id, after.state.feeds)| == 1
    {
      var same: Feed -> bool := (g: Feed) => g.id == f.id;
      if f in s.feeds {
        assert f.id < s.nextFeed;
      } else {
        assert f == added;
        var found := ProofLib.Filter(same, s.feeds);
        if |found| != 0 {
          ProofLib.FilterMember(same, s.feeds, found[0]);
          assert found[0] in s.feeds && found[0].id == added.id;
          assert found[0].id < s.nextFeed;
        }
      }
      ProofLib.FilterAppend(same, s.feeds, added);
    }
  }
}

lemma publish_ensures(s: EventFeed, source: Source, news: FeedEvent)
  ensures (inv(s) ==> canPublish(s, source, news) ==> alwaysFeedsAskedValidly(publish(s, source, news).state))
  ensures (inv(s) ==> canPublish(s, source, news) ==> alwaysFeedIdsAreFresh(publish(s, source, news).state))
  ensures (inv(s) ==> canPublish(s, source, news) ==> alwaysFeedOrderWithinPublished(publish(s, source, news).state))
  ensures (inv(s) ==> canPublish(s, source, news) ==> alwaysStoppedHasNoFeeds(publish(s, source, news).state))
  ensures (inv(s) ==> canPublish(s, source, news) ==> alwaysStrikesBelowThreshold(publish(s, source, news).state))
  ensures (inv(s) ==> canPublish(s, source, news) ==> stepSubscribeAnswersOnceWithoutReplay(s, "publish", publish(s, source, news).state, publish(s, source, news).out))
  ensures (inv(s) ==> canPublish(s, source, news) ==> stepDeliveryReachesExactlyTheAskers(s, publish(s, source, news).state, publish(s, source, news).out))
  ensures (inv(s) ==> canPublish(s, source, news) ==> stepPublicationOrderGrows(s, publish(s, source, news).state))
  ensures (inv(s) ==> canPublish(s, source, news) ==> stepEndedFeedsAreAnnounced(s, publish(s, source, news).state, publish(s, source, news).out))
  ensures (inv(s) ==> canPublish(s, source, news) ==> stepNoticeOnlyAtThreshold(s, publish(s, source, news).state, publish(s, source, news).out))
{
  if inv(s) && canPublish(s, source, news) {
    var after := publish(s, source, news);
    DeliveryFacts(s, news);
  }
}

lemma closeFeed_ensures(s: EventFeed, feed: int)
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> alwaysFeedsAskedValidly(closeFeed(s, feed).state))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> alwaysFeedIdsAreFresh(closeFeed(s, feed).state))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> alwaysFeedOrderWithinPublished(closeFeed(s, feed).state))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> alwaysStoppedHasNoFeeds(closeFeed(s, feed).state))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> alwaysStrikesBelowThreshold(closeFeed(s, feed).state))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> stepSubscribeAnswersOnceWithoutReplay(s, "closeFeed", closeFeed(s, feed).state, closeFeed(s, feed).out))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> stepDeliveryReachesExactlyTheAskers(s, closeFeed(s, feed).state, closeFeed(s, feed).out))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> stepPublicationOrderGrows(s, closeFeed(s, feed).state))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> stepEndedFeedsAreAnnounced(s, closeFeed(s, feed).state, closeFeed(s, feed).out))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> stepNoticeOnlyAtThreshold(s, closeFeed(s, feed).state, closeFeed(s, feed).out))
{
  if inv(s) && canCloseFeed(s, feed) {
    var after := closeFeed(s, feed);
    RemovedFeed(s, feed, EndReason.PeerClosed);
  }
}

lemma backlog_ensures(s: EventFeed, feed: int, queuedBytes: int, frameBytes: int)
  ensures (inv(s) ==> canBacklog(s, feed, queuedBytes, frameBytes) ==> alwaysFeedsAskedValidly(backlog(s, feed, queuedBytes, frameBytes).state))
  ensures (inv(s) ==> canBacklog(s, feed, queuedBytes, frameBytes) ==> alwaysFeedIdsAreFresh(backlog(s, feed, queuedBytes, frameBytes).state))
  ensures (inv(s) ==> canBacklog(s, feed, queuedBytes, frameBytes) ==> alwaysFeedOrderWithinPublished(backlog(s, feed, queuedBytes, frameBytes).state))
  ensures (inv(s) ==> canBacklog(s, feed, queuedBytes, frameBytes) ==> alwaysStoppedHasNoFeeds(backlog(s, feed, queuedBytes, frameBytes).state))
  ensures (inv(s) ==> canBacklog(s, feed, queuedBytes, frameBytes) ==> alwaysStrikesBelowThreshold(backlog(s, feed, queuedBytes, frameBytes).state))
  ensures (inv(s) ==> canBacklog(s, feed, queuedBytes, frameBytes) ==> stepSubscribeAnswersOnceWithoutReplay(s, "backlog", backlog(s, feed, queuedBytes, frameBytes).state, backlog(s, feed, queuedBytes, frameBytes).out))
  ensures (inv(s) ==> canBacklog(s, feed, queuedBytes, frameBytes) ==> stepDeliveryReachesExactlyTheAskers(s, backlog(s, feed, queuedBytes, frameBytes).state, backlog(s, feed, queuedBytes, frameBytes).out))
  ensures (inv(s) ==> canBacklog(s, feed, queuedBytes, frameBytes) ==> stepPublicationOrderGrows(s, backlog(s, feed, queuedBytes, frameBytes).state))
  ensures (inv(s) ==> canBacklog(s, feed, queuedBytes, frameBytes) ==> stepEndedFeedsAreAnnounced(s, backlog(s, feed, queuedBytes, frameBytes).state, backlog(s, feed, queuedBytes, frameBytes).out))
  ensures (inv(s) ==> canBacklog(s, feed, queuedBytes, frameBytes) ==> stepNoticeOnlyAtThreshold(s, backlog(s, feed, queuedBytes, frameBytes).state, backlog(s, feed, queuedBytes, frameBytes).out))
{
  if inv(s) && canBacklog(s, feed, queuedBytes, frameBytes) {
    var after := backlog(s, feed, queuedBytes, frameBytes);
    if frameBytes > maxFrameBytes {
      RemovedFeed(s, feed, EndReason.FrameTooLarge);
    } else if queuedBytes + frameBytes > maxQueuedBytes {
      RemovedFeed(s, feed, EndReason.Overflowed);
    }
  }
}

lemma stop_ensures(s: EventFeed)
  ensures (inv(s) ==> canStop(s) ==> alwaysFeedsAskedValidly(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> alwaysFeedIdsAreFresh(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> alwaysFeedOrderWithinPublished(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> alwaysStoppedHasNoFeeds(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> alwaysStrikesBelowThreshold(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> stepSubscribeAnswersOnceWithoutReplay(s, "stop", stop(s).state, stop(s).out))
  ensures (inv(s) ==> canStop(s) ==> stepDeliveryReachesExactlyTheAskers(s, stop(s).state, stop(s).out))
  ensures (inv(s) ==> canStop(s) ==> stepPublicationOrderGrows(s, stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> stepEndedFeedsAreAnnounced(s, stop(s).state, stop(s).out))
  ensures (inv(s) ==> canStop(s) ==> stepNoticeOnlyAtThreshold(s, stop(s).state, stop(s).out))
{
  if inv(s) && canStop(s) {
    var after := stop(s);
    forall f | f in s.feeds
      ensures exists fr :: fr in after.out && endsFeed(fr, f.id)
    {
      IdMembership(s.feeds, f.id);
      assert Ended(idsOf(s.feeds), EndReason.Stopped) in after.out;
    }
  }
}

lemma expireStrike_ensures(s: EventFeed, code: string)
  ensures (inv(s) ==> canExpireStrike(s, code) ==> alwaysFeedsAskedValidly(expireStrike(s, code).state))
  ensures (inv(s) ==> canExpireStrike(s, code) ==> alwaysFeedIdsAreFresh(expireStrike(s, code).state))
  ensures (inv(s) ==> canExpireStrike(s, code) ==> alwaysFeedOrderWithinPublished(expireStrike(s, code).state))
  ensures (inv(s) ==> canExpireStrike(s, code) ==> alwaysStoppedHasNoFeeds(expireStrike(s, code).state))
  ensures (inv(s) ==> canExpireStrike(s, code) ==> alwaysStrikesBelowThreshold(expireStrike(s, code).state))
  ensures (inv(s) ==> canExpireStrike(s, code) ==> stepSubscribeAnswersOnceWithoutReplay(s, "expireStrike", expireStrike(s, code).state, expireStrike(s, code).out))
  ensures (inv(s) ==> canExpireStrike(s, code) ==> stepDeliveryReachesExactlyTheAskers(s, expireStrike(s, code).state, expireStrike(s, code).out))
  ensures (inv(s) ==> canExpireStrike(s, code) ==> stepPublicationOrderGrows(s, expireStrike(s, code).state))
  ensures (inv(s) ==> canExpireStrike(s, code) ==> stepEndedFeedsAreAnnounced(s, expireStrike(s, code).state, expireStrike(s, code).out))
  ensures (inv(s) ==> canExpireStrike(s, code) ==> stepNoticeOnlyAtThreshold(s, expireStrike(s, code).state, expireStrike(s, code).out))
{
  if inv(s) && canExpireStrike(s, code) {
    var after := expireStrike(s, code);
    StrikeFacts(s, code);
    ChangeStrike(s, code, strikeCount(s, code) - 1);
  }
}

lemma reportError_ensures(s: EventFeed, code: string, cause: string, quiet: bool)
  ensures (inv(s) ==> canReportError(s, code, cause, quiet) ==> alwaysFeedsAskedValidly(reportError(s, code, cause, quiet).state))
  ensures (inv(s) ==> canReportError(s, code, cause, quiet) ==> alwaysFeedIdsAreFresh(reportError(s, code, cause, quiet).state))
  ensures (inv(s) ==> canReportError(s, code, cause, quiet) ==> alwaysFeedOrderWithinPublished(reportError(s, code, cause, quiet).state))
  ensures (inv(s) ==> canReportError(s, code, cause, quiet) ==> alwaysStoppedHasNoFeeds(reportError(s, code, cause, quiet).state))
  ensures (inv(s) ==> canReportError(s, code, cause, quiet) ==> alwaysStrikesBelowThreshold(reportError(s, code, cause, quiet).state))
  ensures (inv(s) ==> canReportError(s, code, cause, quiet) ==> stepSubscribeAnswersOnceWithoutReplay(s, "reportError", reportError(s, code, cause, quiet).state, reportError(s, code, cause, quiet).out))
  ensures (inv(s) ==> canReportError(s, code, cause, quiet) ==> stepDeliveryReachesExactlyTheAskers(s, reportError(s, code, cause, quiet).state, reportError(s, code, cause, quiet).out))
  ensures (inv(s) ==> canReportError(s, code, cause, quiet) ==> stepPublicationOrderGrows(s, reportError(s, code, cause, quiet).state))
  ensures (inv(s) ==> canReportError(s, code, cause, quiet) ==> stepEndedFeedsAreAnnounced(s, reportError(s, code, cause, quiet).state, reportError(s, code, cause, quiet).out))
  ensures (inv(s) ==> canReportError(s, code, cause, quiet) ==> stepNoticeOnlyAtThreshold(s, reportError(s, code, cause, quiet).state, reportError(s, code, cause, quiet).out))
{
  if inv(s) && canReportError(s, code, cause, quiet) {
    var after := reportError(s, code, cause, quiet);
    NoticeThresholdFilter(s, after.state, after.out);
    if !quiet {
      StrikeFacts(s, code);
      var next := strikeCount(s, code) + 1;
      if next < escalationThreshold {
        ChangeStrike(s, code, next);
        assert after.out == [];
        ProofLib.FilterNil((fr: Frame) => isStore(fr), after.out);
      } else {
        ChangeStrike(s, code, 0);
        var cleared := withStrikes(code, 0, s);
        var kind := noticeKind(code, cause);
        DeliveryFacts(cleared, SystemNotice(kind));
        var published := deliver(SystemNotice(kind), cleared).out;
        assert after.out == [StoreNotice(kind)] + published;
        assert forall frame :: frame in published ==> !isStore(frame);
        ProofLib.FilterNone((fr: Frame) => isStore(fr), published);
        ProofLib.FilterCons((fr: Frame) => isStore(fr), after.out);
        assert exists x :: x in s.strikes && x.code == code && x.count == next - 1;
        assert strikeCount(after.state, code) == strikeCount(cleared, code);
        assert (exists x :: x in s.strikes && x.count == escalationThreshold - 1 && strikeCount(after.state, x.code) == 0);
      }
    } else {
      assert after.out == [];
      ProofLib.FilterNil((fr: Frame) => isStore(fr), after.out);
    }
  }
}
