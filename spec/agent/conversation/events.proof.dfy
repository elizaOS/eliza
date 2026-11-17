// Membership facts for the filters the transitions use on feeds, live ids and noticed codes.

lemma EndFeedMembers(feed: int, reason: EndReason, s: EventFeed)
  ensures forall f :: f in endFeed(feed, reason, s).state.feeds <==> f in s.feeds && f.id != feed
  ensures forall x :: x in endFeed(feed, reason, s).state.live <==> x in s.live && x != feed
{
  forall f: Feed
    ensures f in endFeed(feed, reason, s).state.feeds <==> f in s.feeds && f.id != feed
  {
    ProofLib.FilterMember((f: Feed) => (f.id != feed), s.feeds, f);
  }
  forall x: int
    ensures x in endFeed(feed, reason, s).state.live <==> x in s.live && x != feed
  {
    ProofLib.FilterMember((set_x: int) => !((set_x in [feed])), s.live, x);
  }
}

lemma SubscribeMembers(s: EventFeed, streams: seq<StreamName>, clientId: string)
  ensures forall x :: x in subscribe(s, streams, clientId).state.live <==> x in s.live || x == s.nextFeed
{
  forall x: int
    ensures x in subscribe(s, streams, clientId).state.live <==> x in s.live || x == s.nextFeed
  {
    ProofLib.FilterMember((set_x: int) => !((set_x in s.live)), [s.nextFeed], x);
  }
}

lemma NoticeMembers(code: string, s: EventFeed)
  ensures forall x :: x in raiseNotice(code, s).state.noticed <==> x in s.noticed || x == code
{
  forall x: string
    ensures x in raiseNotice(code, s).state.noticed <==> x in s.noticed || x == code
  {
    ProofLib.FilterMember((set_x: string) => !((set_x in s.noticed)), [code], x);
  }
}

lemma subscribe_ensures(s: EventFeed, streams: seq<StreamName>, clientId: string)
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> alwaysFeedsAskedValidly(subscribe(s, streams, clientId).state))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> alwaysAtMostFourLiveFeeds(subscribe(s, streams, clientId).state))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> alwaysFeedIdsAreFresh(subscribe(s, streams, clientId).state))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> alwaysFeedOrderWithinPublished(subscribe(s, streams, clientId).state))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> alwaysStoppedHasNoFeeds(subscribe(s, streams, clientId).state))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> stepSubscribeAnswersOnceWithoutReplay(s, "subscribe", subscribe(s, streams, clientId).state, subscribe(s, streams, clientId).out))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> stepEveryDeliveryIsTheNewestEvent(s, subscribe(s, streams, clientId).state, subscribe(s, streams, clientId).out))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> stepEndedFeedsAreAnnounced(s, subscribe(s, streams, clientId).state, subscribe(s, streams, clientId).out))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> stepOverflowCountsOneEndedFeed(s, subscribe(s, streams, clientId).state))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> stepStoppedStaysQuiet(s, subscribe(s, streams, clientId).state))
  ensures (inv(s) ==> canSubscribe(s, streams, clientId) ==> stepNoticeOncePerCode(s, subscribe(s, streams, clientId).state, subscribe(s, streams, clientId).out))
{
  if inv(s) && canSubscribe(s, streams, clientId) {
    var after := subscribe(s, streams, clientId);
    SubscribeMembers(s, streams, clientId);
    assert !(s.nextFeed in s.live);
    assert s.nextFeed in after.state.live;
    forall f | f in after.state.feeds
      ensures f.id in after.state.live
      ensures f.id == s.nextFeed ==> f.since == s.published && f.lastSeq == s.published
    {
      if f in s.feeds {
        assert f.id in s.live;
        assert f.id < s.nextFeed;
      } else {
        assert f == after.state.feeds[|after.state.feeds| - 1];
      }
    }
  }
}

lemma closeFeed_ensures(s: EventFeed, feed: int)
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> alwaysFeedsAskedValidly(closeFeed(s, feed).state))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> alwaysAtMostFourLiveFeeds(closeFeed(s, feed).state))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> alwaysFeedIdsAreFresh(closeFeed(s, feed).state))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> alwaysFeedOrderWithinPublished(closeFeed(s, feed).state))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> alwaysStoppedHasNoFeeds(closeFeed(s, feed).state))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> stepSubscribeAnswersOnceWithoutReplay(s, "closeFeed", closeFeed(s, feed).state, closeFeed(s, feed).out))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> stepEveryDeliveryIsTheNewestEvent(s, closeFeed(s, feed).state, closeFeed(s, feed).out))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> stepEndedFeedsAreAnnounced(s, closeFeed(s, feed).state, closeFeed(s, feed).out))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> stepOverflowCountsOneEndedFeed(s, closeFeed(s, feed).state))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> stepStoppedStaysQuiet(s, closeFeed(s, feed).state))
  ensures (inv(s) ==> canCloseFeed(s, feed) ==> stepNoticeOncePerCode(s, closeFeed(s, feed).state, closeFeed(s, feed).out))
{
  if inv(s) && canCloseFeed(s, feed) {
    var after := closeFeed(s, feed);
    EndFeedMembers(feed, EndReason.PeerClosed, s);
    assert after.out[0] in after.out && endsFeed(after.out[0], feed);
  }
}

lemma backlog_ensures(s: EventFeed, feed: int, waiting: int)
  ensures (inv(s) ==> canBacklog(s, feed, waiting) ==> alwaysFeedsAskedValidly(backlog(s, feed, waiting).state))
  ensures (inv(s) ==> canBacklog(s, feed, waiting) ==> alwaysAtMostFourLiveFeeds(backlog(s, feed, waiting).state))
  ensures (inv(s) ==> canBacklog(s, feed, waiting) ==> alwaysFeedIdsAreFresh(backlog(s, feed, waiting).state))
  ensures (inv(s) ==> canBacklog(s, feed, waiting) ==> alwaysFeedOrderWithinPublished(backlog(s, feed, waiting).state))
  ensures (inv(s) ==> canBacklog(s, feed, waiting) ==> alwaysStoppedHasNoFeeds(backlog(s, feed, waiting).state))
  ensures (inv(s) ==> canBacklog(s, feed, waiting) ==> stepSubscribeAnswersOnceWithoutReplay(s, "backlog", backlog(s, feed, waiting).state, backlog(s, feed, waiting).out))
  ensures (inv(s) ==> canBacklog(s, feed, waiting) ==> stepEveryDeliveryIsTheNewestEvent(s, backlog(s, feed, waiting).state, backlog(s, feed, waiting).out))
  ensures (inv(s) ==> canBacklog(s, feed, waiting) ==> stepEndedFeedsAreAnnounced(s, backlog(s, feed, waiting).state, backlog(s, feed, waiting).out))
  ensures (inv(s) ==> canBacklog(s, feed, waiting) ==> stepOverflowCountsOneEndedFeed(s, backlog(s, feed, waiting).state))
  ensures (inv(s) ==> canBacklog(s, feed, waiting) ==> stepStoppedStaysQuiet(s, backlog(s, feed, waiting).state))
  ensures (inv(s) ==> canBacklog(s, feed, waiting) ==> stepNoticeOncePerCode(s, backlog(s, feed, waiting).state, backlog(s, feed, waiting).out))
{
  if inv(s) && canBacklog(s, feed, waiting) {
    var after := backlog(s, feed, waiting);
    if waiting >= maxWaiting {
      EndFeedMembers(feed, EndReason.Overflowed, s);
      assert after == endFeed(feed, EndReason.Overflowed, s);
      assert after.out[0] in after.out && endsFeed(after.out[0], feed);
      assert feed in s.live && !(feed in after.state.live);
    }
  }
}

lemma stop_ensures(s: EventFeed)
  ensures (inv(s) ==> canStop(s) ==> alwaysFeedsAskedValidly(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> alwaysAtMostFourLiveFeeds(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> alwaysFeedIdsAreFresh(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> alwaysFeedOrderWithinPublished(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> alwaysStoppedHasNoFeeds(stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> stepSubscribeAnswersOnceWithoutReplay(s, "stop", stop(s).state, stop(s).out))
  ensures (inv(s) ==> canStop(s) ==> stepEveryDeliveryIsTheNewestEvent(s, stop(s).state, stop(s).out))
  ensures (inv(s) ==> canStop(s) ==> stepEndedFeedsAreAnnounced(s, stop(s).state, stop(s).out))
  ensures (inv(s) ==> canStop(s) ==> stepOverflowCountsOneEndedFeed(s, stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> stepStoppedStaysQuiet(s, stop(s).state))
  ensures (inv(s) ==> canStop(s) ==> stepNoticeOncePerCode(s, stop(s).state, stop(s).out))
{
  if inv(s) && canStop(s) {
    var after := stop(s);
    forall id | id in s.live
      ensures exists fr :: fr in after.out && endsFeed(fr, id)
    {
      assert |s.live| > 0;
      assert after.out[0] in after.out && endsFeed(after.out[0], id);
    }
  }
}

lemma reportError_ensures(s: EventFeed, code: string, quiet: bool)
  ensures (inv(s) ==> canReportError(s, code, quiet) ==> alwaysFeedsAskedValidly(reportError(s, code, quiet).state))
  ensures (inv(s) ==> canReportError(s, code, quiet) ==> alwaysAtMostFourLiveFeeds(reportError(s, code, quiet).state))
  ensures (inv(s) ==> canReportError(s, code, quiet) ==> alwaysFeedIdsAreFresh(reportError(s, code, quiet).state))
  ensures (inv(s) ==> canReportError(s, code, quiet) ==> alwaysFeedOrderWithinPublished(reportError(s, code, quiet).state))
  ensures (inv(s) ==> canReportError(s, code, quiet) ==> alwaysStoppedHasNoFeeds(reportError(s, code, quiet).state))
  ensures (inv(s) ==> canReportError(s, code, quiet) ==> stepSubscribeAnswersOnceWithoutReplay(s, "reportError", reportError(s, code, quiet).state, reportError(s, code, quiet).out))
  ensures (inv(s) ==> canReportError(s, code, quiet) ==> stepEveryDeliveryIsTheNewestEvent(s, reportError(s, code, quiet).state, reportError(s, code, quiet).out))
  ensures (inv(s) ==> canReportError(s, code, quiet) ==> stepEndedFeedsAreAnnounced(s, reportError(s, code, quiet).state, reportError(s, code, quiet).out))
  ensures (inv(s) ==> canReportError(s, code, quiet) ==> stepOverflowCountsOneEndedFeed(s, reportError(s, code, quiet).state))
  ensures (inv(s) ==> canReportError(s, code, quiet) ==> stepStoppedStaysQuiet(s, reportError(s, code, quiet).state))
  ensures (inv(s) ==> canReportError(s, code, quiet) ==> stepNoticeOncePerCode(s, reportError(s, code, quiet).state, reportError(s, code, quiet).out))
{
  if inv(s) && canReportError(s, code, quiet) {
    var after := reportError(s, code, quiet);
    if !(quiet || code in s.noticed) {
      NoticeMembers(code, s);
      assert after == raiseNotice(code, s);
      forall fr | fr in after.out
        ensures noticeCode(fr) == code
      {
        assert after.out == deliver(SystemNotice(code), s).out;
      }
    }
  }
}
