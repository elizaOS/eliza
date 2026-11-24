lemma accept_ensures(s: Transport, conn: int)
  ensures (inv(s) ==> canAccept(s, conn) ==> alwaysConnectionsDistinct(accept(s, conn)))
  ensures (inv(s) ==> canAccept(s, conn) ==> alwaysAtMostTwoFeeds(accept(s, conn)))
  ensures (inv(s) ==> canAccept(s, conn) ==> alwaysListensLocallyOnce(accept(s, conn)))
  ensures (inv(s) ==> canAccept(s, conn) ==> alwaysExchangesCameThroughAListener(accept(s, conn)))
  ensures (inv(s) ==> canAccept(s, conn) ==> alwaysNothingOpenOnceClosed(accept(s, conn)))
  ensures (inv(s) ==> canAccept(s, conn) ==> stepEffectsOnlyForLiveExchanges(s, accept(s, conn), []))
  ensures (inv(s) ==> canAccept(s, conn) ==> stepEndedIsFinal(s, accept(s, conn)))
  ensures (inv(s) ==> canAccept(s, conn) ==> stepDispatchedOnce(s, accept(s, conn), []))
  ensures (inv(s) ==> canAccept(s, conn) ==> stepAnsweredOnce(s, accept(s, conn), []))
  ensures (inv(s) ==> canAccept(s, conn) ==> stepTimeoutAnswers504ThenAborts(s, "accept", accept(s, conn), []))
  ensures (inv(s) ==> canAccept(s, conn) ==> stepAbortExactlyWhenCutShort(s, accept(s, conn), []))
  ensures (inv(s) ==> canAccept(s, conn) ==> stepFramesFollowTheProtocol(s, accept(s, conn), []))
{
  if inv(s) && canAccept(s, conn) {
    TransportAccept(s, conn);
  }
}

lemma receive_ensures(s: Transport, conn: int, inbound: Inbound)
  ensures (inv(s) ==> canReceive(s, conn) ==> alwaysConnectionsDistinct(receive(s, conn, inbound).state))
  ensures (inv(s) ==> canReceive(s, conn) ==> alwaysAtMostTwoFeeds(receive(s, conn, inbound).state))
  ensures (inv(s) ==> canReceive(s, conn) ==> alwaysListensLocallyOnce(receive(s, conn, inbound).state))
  ensures (inv(s) ==> canReceive(s, conn) ==> alwaysExchangesCameThroughAListener(receive(s, conn, inbound).state))
  ensures (inv(s) ==> canReceive(s, conn) ==> alwaysNothingOpenOnceClosed(receive(s, conn, inbound).state))
  ensures (inv(s) ==> canReceive(s, conn) ==> stepEffectsOnlyForLiveExchanges(s, receive(s, conn, inbound).state, receive(s, conn, inbound).out))
  ensures (inv(s) ==> canReceive(s, conn) ==> stepEndedIsFinal(s, receive(s, conn, inbound).state))
  ensures (inv(s) ==> canReceive(s, conn) ==> stepDispatchedOnce(s, receive(s, conn, inbound).state, receive(s, conn, inbound).out))
  ensures (inv(s) ==> canReceive(s, conn) ==> stepAnsweredOnce(s, receive(s, conn, inbound).state, receive(s, conn, inbound).out))
  ensures (inv(s) ==> canReceive(s, conn) ==> stepTimeoutAnswers504ThenAborts(s, "receive", receive(s, conn, inbound).state, receive(s, conn, inbound).out))
  ensures (inv(s) ==> canReceive(s, conn) ==> stepAbortExactlyWhenCutShort(s, receive(s, conn, inbound).state, receive(s, conn, inbound).out))
  ensures (inv(s) ==> canReceive(s, conn) ==> stepFramesFollowTheProtocol(s, receive(s, conn, inbound).state, receive(s, conn, inbound).out))
{
  if inv(s) && canReceive(s, conn) {
    var e0 :| e0 in s.exchanges && e0.conn == conn && e0.stage == Stage.Reading;
    var o := admit(conn, inbound, feedCount(s));
    TransportCount3(o.out, conn);
    TransportMove(s, conn, e0, o.stage, o.out);
  }
}

lemma respond_ensures(s: Transport, conn: int, status: int)
  ensures (inv(s) ==> canRespond(s, conn) ==> alwaysConnectionsDistinct(respond(s, conn, status).state))
  ensures (inv(s) ==> canRespond(s, conn) ==> alwaysAtMostTwoFeeds(respond(s, conn, status).state))
  ensures (inv(s) ==> canRespond(s, conn) ==> alwaysListensLocallyOnce(respond(s, conn, status).state))
  ensures (inv(s) ==> canRespond(s, conn) ==> alwaysExchangesCameThroughAListener(respond(s, conn, status).state))
  ensures (inv(s) ==> canRespond(s, conn) ==> alwaysNothingOpenOnceClosed(respond(s, conn, status).state))
  ensures (inv(s) ==> canRespond(s, conn) ==> stepEffectsOnlyForLiveExchanges(s, respond(s, conn, status).state, respond(s, conn, status).out))
  ensures (inv(s) ==> canRespond(s, conn) ==> stepEndedIsFinal(s, respond(s, conn, status).state))
  ensures (inv(s) ==> canRespond(s, conn) ==> stepDispatchedOnce(s, respond(s, conn, status).state, respond(s, conn, status).out))
  ensures (inv(s) ==> canRespond(s, conn) ==> stepAnsweredOnce(s, respond(s, conn, status).state, respond(s, conn, status).out))
  ensures (inv(s) ==> canRespond(s, conn) ==> stepTimeoutAnswers504ThenAborts(s, "respond", respond(s, conn, status).state, respond(s, conn, status).out))
  ensures (inv(s) ==> canRespond(s, conn) ==> stepAbortExactlyWhenCutShort(s, respond(s, conn, status).state, respond(s, conn, status).out))
  ensures (inv(s) ==> canRespond(s, conn) ==> stepFramesFollowTheProtocol(s, respond(s, conn, status).state, respond(s, conn, status).out))
{
  if inv(s) && canRespond(s, conn) {
    var e0 :| e0 in s.exchanges && e0.conn == conn && e0.stage == Stage.Buffering;
    TransportCount3([Write(conn, Result(status))], conn);
    TransportMove(s, conn, e0, Ended(End.Answered), [Write(conn, Result(status))]);
  }
}

lemma handlerFails_ensures(s: Transport, conn: int)
  ensures (inv(s) ==> canHandlerFails(s, conn) ==> alwaysConnectionsDistinct(handlerFails(s, conn).state))
  ensures (inv(s) ==> canHandlerFails(s, conn) ==> alwaysAtMostTwoFeeds(handlerFails(s, conn).state))
  ensures (inv(s) ==> canHandlerFails(s, conn) ==> alwaysListensLocallyOnce(handlerFails(s, conn).state))
  ensures (inv(s) ==> canHandlerFails(s, conn) ==> alwaysExchangesCameThroughAListener(handlerFails(s, conn).state))
  ensures (inv(s) ==> canHandlerFails(s, conn) ==> alwaysNothingOpenOnceClosed(handlerFails(s, conn).state))
  ensures (inv(s) ==> canHandlerFails(s, conn) ==> stepEffectsOnlyForLiveExchanges(s, handlerFails(s, conn).state, handlerFails(s, conn).out))
  ensures (inv(s) ==> canHandlerFails(s, conn) ==> stepEndedIsFinal(s, handlerFails(s, conn).state))
  ensures (inv(s) ==> canHandlerFails(s, conn) ==> stepDispatchedOnce(s, handlerFails(s, conn).state, handlerFails(s, conn).out))
  ensures (inv(s) ==> canHandlerFails(s, conn) ==> stepAnsweredOnce(s, handlerFails(s, conn).state, handlerFails(s, conn).out))
  ensures (inv(s) ==> canHandlerFails(s, conn) ==> stepTimeoutAnswers504ThenAborts(s, "handlerFails", handlerFails(s, conn).state, handlerFails(s, conn).out))
  ensures (inv(s) ==> canHandlerFails(s, conn) ==> stepAbortExactlyWhenCutShort(s, handlerFails(s, conn).state, handlerFails(s, conn).out))
  ensures (inv(s) ==> canHandlerFails(s, conn) ==> stepFramesFollowTheProtocol(s, handlerFails(s, conn).state, handlerFails(s, conn).out))
{
  if inv(s) && canHandlerFails(s, conn) {
    var x := (if inStage(s, conn, Stage.Buffering) then Stage.Buffering else (if inStage(s, conn, Stage.Heading) then Stage.Heading else Stage.Streaming));
    var e0 :| e0 in s.exchanges && e0.conn == conn && e0.stage == x;
    TransportCount3(cutOff(conn, x, 500), conn);
    TransportMove(s, conn, e0, Ended(End.Failed), cutOff(conn, x, 500));
  }
}

lemma expire_ensures(s: Transport, conn: int)
  ensures (inv(s) ==> canExpire(s, conn) ==> alwaysConnectionsDistinct(expire(s, conn).state))
  ensures (inv(s) ==> canExpire(s, conn) ==> alwaysAtMostTwoFeeds(expire(s, conn).state))
  ensures (inv(s) ==> canExpire(s, conn) ==> alwaysListensLocallyOnce(expire(s, conn).state))
  ensures (inv(s) ==> canExpire(s, conn) ==> alwaysExchangesCameThroughAListener(expire(s, conn).state))
  ensures (inv(s) ==> canExpire(s, conn) ==> alwaysNothingOpenOnceClosed(expire(s, conn).state))
  ensures (inv(s) ==> canExpire(s, conn) ==> stepEffectsOnlyForLiveExchanges(s, expire(s, conn).state, expire(s, conn).out))
  ensures (inv(s) ==> canExpire(s, conn) ==> stepEndedIsFinal(s, expire(s, conn).state))
  ensures (inv(s) ==> canExpire(s, conn) ==> stepDispatchedOnce(s, expire(s, conn).state, expire(s, conn).out))
  ensures (inv(s) ==> canExpire(s, conn) ==> stepAnsweredOnce(s, expire(s, conn).state, expire(s, conn).out))
  ensures (inv(s) ==> canExpire(s, conn) ==> stepTimeoutAnswers504ThenAborts(s, "expire", expire(s, conn).state, expire(s, conn).out))
  ensures (inv(s) ==> canExpire(s, conn) ==> stepAbortExactlyWhenCutShort(s, expire(s, conn).state, expire(s, conn).out))
  ensures (inv(s) ==> canExpire(s, conn) ==> stepFramesFollowTheProtocol(s, expire(s, conn).state, expire(s, conn).out))
{
  if inv(s) && canExpire(s, conn) {
    var x := (if inStage(s, conn, Stage.Buffering) then Stage.Buffering else (if inStage(s, conn, Stage.Heading) then Stage.Heading else Stage.Streaming));
    var e0 :| e0 in s.exchanges && e0.conn == conn && e0.stage == x;
    TransportCount3(cutOff(conn, x, 504) + [Abort(conn)], conn);
    assert Abort(conn) in cutOff(conn, x, 504) + [Abort(conn)];
    TransportMove(s, conn, e0, Ended(End.TimedOut), cutOff(conn, x, 504) + [Abort(conn)]);
  }
}

lemma peerClose_ensures(s: Transport, conn: int)
  ensures (inv(s) ==> canPeerClose(s, conn) ==> alwaysConnectionsDistinct(peerClose(s, conn).state))
  ensures (inv(s) ==> canPeerClose(s, conn) ==> alwaysAtMostTwoFeeds(peerClose(s, conn).state))
  ensures (inv(s) ==> canPeerClose(s, conn) ==> alwaysListensLocallyOnce(peerClose(s, conn).state))
  ensures (inv(s) ==> canPeerClose(s, conn) ==> alwaysExchangesCameThroughAListener(peerClose(s, conn).state))
  ensures (inv(s) ==> canPeerClose(s, conn) ==> alwaysNothingOpenOnceClosed(peerClose(s, conn).state))
  ensures (inv(s) ==> canPeerClose(s, conn) ==> stepEffectsOnlyForLiveExchanges(s, peerClose(s, conn).state, peerClose(s, conn).out))
  ensures (inv(s) ==> canPeerClose(s, conn) ==> stepEndedIsFinal(s, peerClose(s, conn).state))
  ensures (inv(s) ==> canPeerClose(s, conn) ==> stepDispatchedOnce(s, peerClose(s, conn).state, peerClose(s, conn).out))
  ensures (inv(s) ==> canPeerClose(s, conn) ==> stepAnsweredOnce(s, peerClose(s, conn).state, peerClose(s, conn).out))
  ensures (inv(s) ==> canPeerClose(s, conn) ==> stepTimeoutAnswers504ThenAborts(s, "peerClose", peerClose(s, conn).state, peerClose(s, conn).out))
  ensures (inv(s) ==> canPeerClose(s, conn) ==> stepAbortExactlyWhenCutShort(s, peerClose(s, conn).state, peerClose(s, conn).out))
  ensures (inv(s) ==> canPeerClose(s, conn) ==> stepFramesFollowTheProtocol(s, peerClose(s, conn).state, peerClose(s, conn).out))
{
  if inv(s) && canPeerClose(s, conn) {
    var e0 :| e0 in s.exchanges && e0.conn == conn && isLive(e0.stage);
    TransportAt(s, e0);
    TransportCount3(abortIfDispatched(conn, s), conn);
    if dispatchedIn(s, conn) {
      assert Abort(conn) in abortIfDispatched(conn, s);
    }
    TransportMove(s, conn, e0, Ended(End.PeerClosed), abortIfDispatched(conn, s));
  }
}

lemma sendHead_ensures(s: Transport, conn: int, status: int)
  ensures (inv(s) ==> canSendHead(s, conn) ==> alwaysConnectionsDistinct(sendHead(s, conn, status).state))
  ensures (inv(s) ==> canSendHead(s, conn) ==> alwaysAtMostTwoFeeds(sendHead(s, conn, status).state))
  ensures (inv(s) ==> canSendHead(s, conn) ==> alwaysListensLocallyOnce(sendHead(s, conn, status).state))
  ensures (inv(s) ==> canSendHead(s, conn) ==> alwaysExchangesCameThroughAListener(sendHead(s, conn, status).state))
  ensures (inv(s) ==> canSendHead(s, conn) ==> alwaysNothingOpenOnceClosed(sendHead(s, conn, status).state))
  ensures (inv(s) ==> canSendHead(s, conn) ==> stepEffectsOnlyForLiveExchanges(s, sendHead(s, conn, status).state, sendHead(s, conn, status).out))
  ensures (inv(s) ==> canSendHead(s, conn) ==> stepEndedIsFinal(s, sendHead(s, conn, status).state))
  ensures (inv(s) ==> canSendHead(s, conn) ==> stepDispatchedOnce(s, sendHead(s, conn, status).state, sendHead(s, conn, status).out))
  ensures (inv(s) ==> canSendHead(s, conn) ==> stepAnsweredOnce(s, sendHead(s, conn, status).state, sendHead(s, conn, status).out))
  ensures (inv(s) ==> canSendHead(s, conn) ==> stepTimeoutAnswers504ThenAborts(s, "sendHead", sendHead(s, conn, status).state, sendHead(s, conn, status).out))
  ensures (inv(s) ==> canSendHead(s, conn) ==> stepAbortExactlyWhenCutShort(s, sendHead(s, conn, status).state, sendHead(s, conn, status).out))
  ensures (inv(s) ==> canSendHead(s, conn) ==> stepFramesFollowTheProtocol(s, sendHead(s, conn, status).state, sendHead(s, conn, status).out))
{
  if inv(s) && canSendHead(s, conn) {
    var e0 :| e0 in s.exchanges && e0.conn == conn && e0.stage == Stage.Heading;
    TransportCount3([Write(conn, Head(status))], conn);
    TransportMove(s, conn, e0, Stage.Streaming, [Write(conn, Head(status))]);
  }
}

lemma sendChunk_ensures(s: Transport, conn: int)
  ensures (inv(s) ==> canSendChunk(s, conn) ==> alwaysConnectionsDistinct(sendChunk(s, conn).state))
  ensures (inv(s) ==> canSendChunk(s, conn) ==> alwaysAtMostTwoFeeds(sendChunk(s, conn).state))
  ensures (inv(s) ==> canSendChunk(s, conn) ==> alwaysListensLocallyOnce(sendChunk(s, conn).state))
  ensures (inv(s) ==> canSendChunk(s, conn) ==> alwaysExchangesCameThroughAListener(sendChunk(s, conn).state))
  ensures (inv(s) ==> canSendChunk(s, conn) ==> alwaysNothingOpenOnceClosed(sendChunk(s, conn).state))
  ensures (inv(s) ==> canSendChunk(s, conn) ==> stepEffectsOnlyForLiveExchanges(s, sendChunk(s, conn).state, sendChunk(s, conn).out))
  ensures (inv(s) ==> canSendChunk(s, conn) ==> stepEndedIsFinal(s, sendChunk(s, conn).state))
  ensures (inv(s) ==> canSendChunk(s, conn) ==> stepDispatchedOnce(s, sendChunk(s, conn).state, sendChunk(s, conn).out))
  ensures (inv(s) ==> canSendChunk(s, conn) ==> stepAnsweredOnce(s, sendChunk(s, conn).state, sendChunk(s, conn).out))
  ensures (inv(s) ==> canSendChunk(s, conn) ==> stepTimeoutAnswers504ThenAborts(s, "sendChunk", sendChunk(s, conn).state, sendChunk(s, conn).out))
  ensures (inv(s) ==> canSendChunk(s, conn) ==> stepAbortExactlyWhenCutShort(s, sendChunk(s, conn).state, sendChunk(s, conn).out))
  ensures (inv(s) ==> canSendChunk(s, conn) ==> stepFramesFollowTheProtocol(s, sendChunk(s, conn).state, sendChunk(s, conn).out))
{
  if inv(s) && canSendChunk(s, conn) {
    var e0 :| e0 in s.exchanges && e0.conn == conn && e0.stage == Stage.Streaming;
    TransportCount3([Write(conn, Frame.Chunk)], conn);
    TransportMove(s, conn, e0, Stage.Streaming, [Write(conn, Frame.Chunk)]);
  }
}

lemma complete_ensures(s: Transport, conn: int)
  ensures (inv(s) ==> canComplete(s, conn) ==> alwaysConnectionsDistinct(complete(s, conn).state))
  ensures (inv(s) ==> canComplete(s, conn) ==> alwaysAtMostTwoFeeds(complete(s, conn).state))
  ensures (inv(s) ==> canComplete(s, conn) ==> alwaysListensLocallyOnce(complete(s, conn).state))
  ensures (inv(s) ==> canComplete(s, conn) ==> alwaysExchangesCameThroughAListener(complete(s, conn).state))
  ensures (inv(s) ==> canComplete(s, conn) ==> alwaysNothingOpenOnceClosed(complete(s, conn).state))
  ensures (inv(s) ==> canComplete(s, conn) ==> stepEffectsOnlyForLiveExchanges(s, complete(s, conn).state, complete(s, conn).out))
  ensures (inv(s) ==> canComplete(s, conn) ==> stepEndedIsFinal(s, complete(s, conn).state))
  ensures (inv(s) ==> canComplete(s, conn) ==> stepDispatchedOnce(s, complete(s, conn).state, complete(s, conn).out))
  ensures (inv(s) ==> canComplete(s, conn) ==> stepAnsweredOnce(s, complete(s, conn).state, complete(s, conn).out))
  ensures (inv(s) ==> canComplete(s, conn) ==> stepTimeoutAnswers504ThenAborts(s, "complete", complete(s, conn).state, complete(s, conn).out))
  ensures (inv(s) ==> canComplete(s, conn) ==> stepAbortExactlyWhenCutShort(s, complete(s, conn).state, complete(s, conn).out))
  ensures (inv(s) ==> canComplete(s, conn) ==> stepFramesFollowTheProtocol(s, complete(s, conn).state, complete(s, conn).out))
{
  if inv(s) && canComplete(s, conn) {
    var e0 :| e0 in s.exchanges && e0.conn == conn && e0.stage == Stage.Streaming;
    TransportCount3([Write(conn, Frame.Complete)], conn);
    TransportMove(s, conn, e0, Ended(End.Answered), [Write(conn, Frame.Complete)]);
  }
}

lemma publish_ensures(s: Transport, conn: int)
  ensures (inv(s) ==> canPublish(s, conn) ==> alwaysConnectionsDistinct(publish(s, conn).state))
  ensures (inv(s) ==> canPublish(s, conn) ==> alwaysAtMostTwoFeeds(publish(s, conn).state))
  ensures (inv(s) ==> canPublish(s, conn) ==> alwaysListensLocallyOnce(publish(s, conn).state))
  ensures (inv(s) ==> canPublish(s, conn) ==> alwaysExchangesCameThroughAListener(publish(s, conn).state))
  ensures (inv(s) ==> canPublish(s, conn) ==> alwaysNothingOpenOnceClosed(publish(s, conn).state))
  ensures (inv(s) ==> canPublish(s, conn) ==> stepEffectsOnlyForLiveExchanges(s, publish(s, conn).state, publish(s, conn).out))
  ensures (inv(s) ==> canPublish(s, conn) ==> stepEndedIsFinal(s, publish(s, conn).state))
  ensures (inv(s) ==> canPublish(s, conn) ==> stepDispatchedOnce(s, publish(s, conn).state, publish(s, conn).out))
  ensures (inv(s) ==> canPublish(s, conn) ==> stepAnsweredOnce(s, publish(s, conn).state, publish(s, conn).out))
  ensures (inv(s) ==> canPublish(s, conn) ==> stepTimeoutAnswers504ThenAborts(s, "publish", publish(s, conn).state, publish(s, conn).out))
  ensures (inv(s) ==> canPublish(s, conn) ==> stepAbortExactlyWhenCutShort(s, publish(s, conn).state, publish(s, conn).out))
  ensures (inv(s) ==> canPublish(s, conn) ==> stepFramesFollowTheProtocol(s, publish(s, conn).state, publish(s, conn).out))
{
  if inv(s) && canPublish(s, conn) {
    TransportQuiet(s, s, [Write(conn, Frame.AgentEvent)]);
  }
}

lemma close_ensures(s: Transport)
  ensures (inv(s) ==> alwaysConnectionsDistinct(close(s)))
  ensures (inv(s) ==> alwaysAtMostTwoFeeds(close(s)))
  ensures (inv(s) ==> alwaysListensLocallyOnce(close(s)))
  ensures (inv(s) ==> alwaysExchangesCameThroughAListener(close(s)))
  ensures (inv(s) ==> alwaysNothingOpenOnceClosed(close(s)))
  ensures (inv(s) ==> stepEffectsOnlyForLiveExchanges(s, close(s), []))
  ensures (inv(s) ==> stepEndedIsFinal(s, close(s)))
  ensures (inv(s) ==> stepDispatchedOnce(s, close(s), []))
  ensures (inv(s) ==> stepAnsweredOnce(s, close(s), []))
  ensures (inv(s) ==> stepTimeoutAnswers504ThenAborts(s, "close", close(s), []))
  ensures (inv(s) ==> stepAbortExactlyWhenCutShort(s, close(s), []))
  ensures (inv(s) ==> stepFramesFollowTheProtocol(s, close(s), []))
{
  if inv(s) {
    TransportClose(s);
  }
}

lemma drop_ensures(s: Transport, conn: int)
  ensures (inv(s) ==> canDrop(s, conn) ==> alwaysConnectionsDistinct(drop(s, conn).state))
  ensures (inv(s) ==> canDrop(s, conn) ==> alwaysAtMostTwoFeeds(drop(s, conn).state))
  ensures (inv(s) ==> canDrop(s, conn) ==> alwaysListensLocallyOnce(drop(s, conn).state))
  ensures (inv(s) ==> canDrop(s, conn) ==> alwaysExchangesCameThroughAListener(drop(s, conn).state))
  ensures (inv(s) ==> canDrop(s, conn) ==> alwaysNothingOpenOnceClosed(drop(s, conn).state))
  ensures (inv(s) ==> canDrop(s, conn) ==> stepEffectsOnlyForLiveExchanges(s, drop(s, conn).state, drop(s, conn).out))
  ensures (inv(s) ==> canDrop(s, conn) ==> stepEndedIsFinal(s, drop(s, conn).state))
  ensures (inv(s) ==> canDrop(s, conn) ==> stepDispatchedOnce(s, drop(s, conn).state, drop(s, conn).out))
  ensures (inv(s) ==> canDrop(s, conn) ==> stepAnsweredOnce(s, drop(s, conn).state, drop(s, conn).out))
  ensures (inv(s) ==> canDrop(s, conn) ==> stepTimeoutAnswers504ThenAborts(s, "drop", drop(s, conn).state, drop(s, conn).out))
  ensures (inv(s) ==> canDrop(s, conn) ==> stepAbortExactlyWhenCutShort(s, drop(s, conn).state, drop(s, conn).out))
  ensures (inv(s) ==> canDrop(s, conn) ==> stepFramesFollowTheProtocol(s, drop(s, conn).state, drop(s, conn).out))
{
  if inv(s) && canDrop(s, conn) {
    var e0 :| e0 in s.exchanges && e0.conn == conn && isLive(e0.stage);
    TransportAt(s, e0);
    TransportCount3(abortIfDispatched(conn, s), conn);
    if dispatchedIn(s, conn) {
      assert Abort(conn) in abortIfDispatched(conn, s);
    }
    TransportMove(s, conn, e0, Ended(End.Stopped), abortIfDispatched(conn, s));
  }
}

// spec/agent/access/transport.md: the rules of the transport, read with the filters of the proof library.
lemma TransportAlwaysConnectionsDistinctFilter(s: Transport)
  ensures alwaysConnectionsDistinct(s) == (!((exists e :: e in s.exchanges && !((|ProofLib.Filter((f: Exchange) => (f.conn == e.conn), s.exchanges)| == 1)))))
{
}

lemma TransportFeedCountFilter(s: Transport)
  ensures feedCount(s) == (|ProofLib.Filter((e: Exchange) => e.stage.Feeding?, s.exchanges)|)
{
}

// spec/agent/access/transport.md: each connection has one exchange.
lemma TransportAt(s: Transport, e: Exchange)
  requires alwaysConnectionsDistinct(s) && e in s.exchanges
  ensures forall f :: f in s.exchanges && f.conn == e.conn ==> f == e
  ensures liveIn(s, e.conn) == isLive(e.stage)
  ensures dispatchedIn(s, e.conn) == isDispatched(e.stage)
  ensures forall st :: inStage(s, e.conn, st) == (e.stage == st)
{
  TransportAlwaysConnectionsDistinctFilter(s);
  var p := (f: Exchange) => (f.conn == e.conn);
  ProofLib.FilterMember(p, s.exchanges, e);
  forall f | f in s.exchanges && f.conn == e.conn
    ensures f == e
  {
    ProofLib.FilterMember(p, s.exchanges, f);
    assert ProofLib.Filter(p, s.exchanges)[0] == e;
  }
}

// spec/agent/access/transport.md: the terminal frames an answer writes, counted.
lemma {:induction false} TransportShift(k: int, out: seq<Effect>, conn: int)
  ensures Std.Collections.Seq.FoldLeft((n: int, x: Effect) => (if x.Write? then (if ((x.conn == conn) && isTerminal(x.frame)) then (n + 1) else n) else n), k, out)
    == k + Std.Collections.Seq.FoldLeft((n: int, x: Effect) => (if x.Write? then (if ((x.conn == conn) && isTerminal(x.frame)) then (n + 1) else n) else n), 0, out)
  decreases |out|
{
  var f := (n: int, x: Effect) => (if x.Write? then (if ((x.conn == conn) && isTerminal(x.frame)) then (n + 1) else n) else n);
  if |out| > 0 {
    assert Std.Collections.Seq.FoldLeft(f, k, out) == Std.Collections.Seq.FoldLeft(f, f(k, out[0]), out[1..]);
    assert Std.Collections.Seq.FoldLeft(f, 0, out) == Std.Collections.Seq.FoldLeft(f, f(0, out[0]), out[1..]);
    TransportShift(f(k, out[0]), out[1..], conn);
    TransportShift(f(0, out[0]), out[1..], conn);
  }
}

lemma TransportCount(out: seq<Effect>, conn: int)
  ensures terminalCount(out, conn) == (if |out| == 0 then 0 else (if out[0].Write? && out[0].conn == conn && isTerminal(out[0].frame) then 1 else 0) + terminalCount(out[1..], conn))
{
  var f := (n: int, x: Effect) => (if x.Write? then (if ((x.conn == conn) && isTerminal(x.frame)) then (n + 1) else n) else n);
  if |out| > 0 {
    assert Std.Collections.Seq.FoldLeft(f, 0, out) == Std.Collections.Seq.FoldLeft(f, f(0, out[0]), out[1..]);
    TransportShift(f(0, out[0]), out[1..], conn);
  }
}

lemma TransportCountOther(out: seq<Effect>, conn: int)
  requires forall x :: x in out ==> effectConn(x) != conn
  ensures terminalCount(out, conn) == 0 && !abortedIn(out, conn)
  decreases |out|
{
  TransportCount(out, conn);
  if |out| > 0 {
    assert out[0] in out;
    forall x | x in out[1..] ensures x in out { }
    TransportCountOther(out[1..], conn);
  }
}

lemma TransportCount3(out: seq<Effect>, conn: int)
  requires |out| <= 3
  ensures terminalCount(out, conn) == (if |out| > 0 && out[0].Write? && out[0].conn == conn && isTerminal(out[0].frame) then 1 else 0)
    + (if |out| > 1 && out[1].Write? && out[1].conn == conn && isTerminal(out[1].frame) then 1 else 0)
    + (if |out| > 2 && out[2].Write? && out[2].conn == conn && isTerminal(out[2].frame) then 1 else 0)
{
  TransportCount(out, conn);
  if |out| > 0 {
    TransportCount(out[1..], conn);
    if |out| > 1 {
      TransportCount(out[2..], conn);
      if |out| > 2 {
        TransportCount(out[3..], conn);
      }
    }
  }
}

// spec/agent/access/transport.md: a step that writes no answer leaves every exchange as it was.
lemma TransportQuiet(s: Transport, after: Transport, out: seq<Effect>)
  requires alwaysConnectionsDistinct(s) && after.exchanges == s.exchanges && |out| <= 3
  requires forall x :: x in out ==> !isDispatch(x) && !isAbort(x) && !(x.Write? && isTerminal(x.frame))
  ensures stepDispatchedOnce(s, after, out)
  ensures stepAnsweredOnce(s, after, out)
  ensures stepAbortExactlyWhenCutShort(s, after, out)
{
  forall e | e in s.exchanges
    ensures terminalCount(out, e.conn) == 0
    ensures !abortedIn(out, e.conn)
    ensures !(liveIn(s, e.conn) && endsAnswered(e.stage))
    ensures !(dispatchedIn(s, e.conn) && cutShort(e.stage))
    ensures !e.stage.Reading? ==> !inStage(after, e.conn, Stage.Reading)
  {
    TransportAt(s, e);
    if |out| <= 3 {
      TransportCount3(out, e.conn);
    }
  }
}

// spec/agent/access/transport.md: a step on one exchange moves only that exchange.
lemma TransportFeeds(xs: seq<Exchange>, ys: seq<Exchange>, k: int)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| && i != k ==> ys[i].stage.Feeding? == xs[i].stage.Feeding?
  ensures |ProofLib.Filter((e: Exchange) => e.stage.Feeding?, ys)| <= |ProofLib.Filter((e: Exchange) => e.stage.Feeding?, xs)| + (if 0 <= k < |xs| && ys[k].stage.Feeding? && !xs[k].stage.Feeding? then 1 else 0)
  decreases |xs|
{
  var p := (e: Exchange) => e.stage.Feeding?;
  if |xs| == 0 {
    ProofLib.FilterNil(p, ys);
  } else {
    ProofLib.FilterCons(p, xs);
    ProofLib.FilterCons(p, ys);
    TransportFeeds(xs[1..], ys[1..], k - 1);
  }
}

lemma TransportMove(s: Transport, conn: int, e0: Exchange, st: Stage, out: seq<Effect>)
  requires inv(s) && e0 in s.exchanges && e0.conn == conn && isLive(e0.stage) && !st.Reading?
  requires forall x :: x in out ==> effectConn(x) == conn
  requires forall x :: x in out && isDispatch(x) ==> e0.stage.Reading?
  requires terminalCount(out, conn) == (if endsAnswered(st) then 1 else 0)
  requires abortedIn(out, conn) == (isDispatched(e0.stage) && cutShort(st))
  requires st.Feeding? ==> feedCount(s) < feedLimit && !e0.stage.Feeding?
  ensures alwaysConnectionsDistinct(moveTo(conn, s, st, out).state)
  ensures alwaysAtMostTwoFeeds(moveTo(conn, s, st, out).state)
  ensures stepEndedIsFinal(s, moveTo(conn, s, st, out).state)
  ensures stepDispatchedOnce(s, moveTo(conn, s, st, out).state, out)
  ensures stepAnsweredOnce(s, moveTo(conn, s, st, out).state, out)
  ensures stepAbortExactlyWhenCutShort(s, moveTo(conn, s, st, out).state, out)
{
  var after := moveTo(conn, s, st, out).state;
  var xs := s.exchanges;
  var ys := after.exchanges;
  assert |ys| == |xs|;
  TransportAt(s, e0);
  TransportAlwaysConnectionsDistinctFilter(s);
  TransportAlwaysConnectionsDistinctFilter(after);
  forall i | 0 <= i < |xs|
    ensures ys[i] == (if xs[i].conn == conn then xs[i].(stage := st) else xs[i])
    ensures xs[i].conn == conn ==> xs[i] == e0
  {
    assert xs[i] in xs;
  }
  forall e | e in ys
    ensures |ProofLib.Filter((f: Exchange) => (f.conn == e.conn), ys)| == 1
  {
    var i :| 0 <= i < |ys| && ys[i] == e;
    var o := xs[i];
    assert o in xs;
    ProofLib.FilterLengthPointwise((f: Exchange) => (f.conn == e.conn), (f: Exchange) => (f.conn == o.conn), ys, xs);
  }
  var k :| 0 <= k < |xs| && xs[k] == e0;
  forall i | 0 <= i < |xs| && i != k
    ensures xs[i].conn != conn
  {
    if xs[i].conn == conn {
      ProofLib.FilterTwo((f: Exchange) => (f.conn == e0.conn), xs, i, k);
    }
  }
  TransportFeeds(xs, ys, k);
  TransportFeedCountFilter(s);
  TransportFeedCountFilter(after);
  forall e | e in xs
    ensures known(after, e.conn)
    ensures isLive(e.stage) || e in ys
    ensures !e.stage.Reading? ==> !inStage(after, e.conn, Stage.Reading)
  {
    var i :| 0 <= i < |xs| && xs[i] == e;
    assert ys[i] in ys;
    forall j | 0 <= j < |ys| && ys[j].conn == e.conn
      ensures !e.stage.Reading? ==> !ys[j].stage.Reading?
    {
      assert xs[j] in xs;
      TransportAt(s, e);
    }
  }
  forall e | e in ys
    ensures terminalCount(out, e.conn) == (if (liveIn(s, e.conn) && endsAnswered(e.stage)) then 1 else 0)
    ensures abortedIn(out, e.conn) == (dispatchedIn(s, e.conn) && cutShort(e.stage))
  {
    var i :| 0 <= i < |ys| && ys[i] == e;
    var o := xs[i];
    assert o in xs;
    TransportAt(s, o);
    if o.conn != conn {
      TransportCountOther(out, e.conn);
    }
  }
  forall x | x in out && isDispatch(x)
    ensures inStage(s, effectConn(x), Stage.Reading) && !inStage(after, effectConn(x), Stage.Reading)
  {
    forall j | 0 <= j < |ys| && ys[j].conn == conn
      ensures !ys[j].stage.Reading?
    {
    }
  }
}

// spec/agent/access/transport.md: a new connection is read first, under a connection number not yet known.
lemma TransportAccept(s: Transport, conn: int)
  requires inv(s) && canAccept(s, conn)
  ensures alwaysConnectionsDistinct(accept(s, conn))
  ensures alwaysAtMostTwoFeeds(accept(s, conn))
  ensures stepDispatchedOnce(s, accept(s, conn), [])
  ensures stepAnsweredOnce(s, accept(s, conn), [])
  ensures stepAbortExactlyWhenCutShort(s, accept(s, conn), [])
{
  var after := accept(s, conn);
  var n := Exchange(conn, Stage.Reading);
  assert after.exchanges == s.exchanges + [n];
  TransportAlwaysConnectionsDistinctFilter(s);
  TransportAlwaysConnectionsDistinctFilter(after);
  TransportFeedCountFilter(s);
  TransportFeedCountFilter(after);
  ProofLib.FilterAppend((e: Exchange) => e.stage.Feeding?, s.exchanges, n);
  forall e | e in s.exchanges ensures e.conn != conn { }
  forall e | e in after.exchanges
    ensures |ProofLib.Filter((f: Exchange) => (f.conn == e.conn), after.exchanges)| == 1
    ensures terminalCount([], e.conn) == 0 && !(liveIn(s, e.conn) && endsAnswered(e.stage))
    ensures !(dispatchedIn(s, e.conn) && cutShort(e.stage))
  {
    ProofLib.FilterAppend((f: Exchange) => (f.conn == e.conn), s.exchanges, n);
    TransportCount([], e.conn);
    if e != n {
      assert e in s.exchanges;
      TransportAt(s, e);
    } else {
      ProofLib.FilterNone((f: Exchange) => (f.conn == e.conn), s.exchanges);
    }
  }
  forall e | e in s.exchanges && !e.stage.Reading?
    ensures !inStage(after, e.conn, Stage.Reading)
  {
    TransportAt(s, e);
  }
}

// spec/agent/access/transport.md: once the listeners are closed, no exchange is open.
lemma {:induction false} TransportNewestFirst(start: seq<string>, xs: seq<string>)
  ensures |Std.Collections.Seq.FoldLeft((acc: seq<string>, x: string) => ([x] + acc), start, xs)| == |start| + |xs|
  decreases |xs|
{
  var f := (acc: seq<string>, x: string) => ([x] + acc);
  if |xs| > 0 {
    assert Std.Collections.Seq.FoldLeft(f, start, xs) == Std.Collections.Seq.FoldLeft(f, f(start, xs[0]), xs[1..]);
    TransportNewestFirst(f(start, xs[0]), xs[1..]);
  }
}

lemma TransportClose(s: Transport)
  requires inv(s)
  ensures alwaysNothingOpenOnceClosed(close(s))
  ensures stepDispatchedOnce(s, close(s), [])
  ensures stepAnsweredOnce(s, close(s), [])
  ensures stepAbortExactlyWhenCutShort(s, close(s), [])
{
  TransportNewestFirst([], s.listeners.held);
  TransportQuiet(s, close(s), []);
}
