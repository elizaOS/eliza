// Hono request-body cap and rejection delivery on an HTTP/1.1 keep-alive connection.
// Three abstract chunks and a cap of two cover declared and discovered overflow.
// Response flush is a local transport event, not proof that a remote client read it.
// Peer aborts are external failures. Server-owned close waits for drain and flush.
module api_http_body {
  var s: { received: int, retained: int, oversized: bool, discarding: bool, requestDone: bool, response: int, flushed: bool, closed: bool, peerAborted: bool, resetError: bool, dispatched: bool }
  action init = s' = { received: 0, retained: 0, oversized: false, discarding: false, requestDone: false, response: 0, flushed: false, closed: false, peerAborted: false, resetError: false, dispatched: false }
  action declaredTooLarge = all { s.received == 0, s.response == 0, not(s.closed or s.requestDone), s' = s.with("oversized", true).with("discarding", true) }
  action receiveChunk = all {
    s.received < 3, not(s.closed or s.requestDone),
    s' = s.with("received", s.received + 1)
      .with("oversized", s.oversized or s.received + 1 > 2)
      .with("discarding", s.oversized or s.received + 1 > 2)
      .with("retained", if (s.oversized or s.received + 1 > 2) s.retained else s.retained + 1)
  }
  action requestEnds = all { s.received > 0, not(s.closed or s.requestDone), s' = s.with("requestDone", true) }
  action dispatch = all { s.requestDone, not(s.closed or s.oversized), s.response == 0, s' = s.with("dispatched", true) }
  action queueSuccess = all { s.dispatched, not(s.closed), s.response == 0, s' = s.with("response", 200) }
  action queueRejection = all { s.oversized, not(s.closed), s.response == 0, s' = s.with("response", 413) }
  action flush = all { s.response != 0, not(s.closed), s' = s.with("flushed", true) }
  action close = all { s.requestDone, s.flushed, s' = s.with("closed", true) }
  action peerAbort = s' = s.with("closed", true).with("peerAborted", true)
  action legacyClose = all { s.response != 0, s' = s.with("closed", true).with("resetError", not(s.requestDone)) }
  action idle = s' = s
  action step = any { declaredTooLarge, receiveChunk, requestEnds, dispatch, queueSuccess, queueRejection, flush, close, peerAbort, idle }
  action legacyStep = any { step, legacyClose }
  val safety = all {
    s.received >= 0, s.received <= 3, s.retained >= 0, s.retained <= 2,
    s.response == 413 implies s.oversized,
    s.dispatched implies (s.requestDone and not(s.oversized)),
    s.closed and not(s.peerAborted) implies (s.requestDone and s.flushed),
    not(s.resetError)
  }
  run declaredOverflowDrainsAfterRejectionTest = init.then(declaredTooLarge).then(queueRejection).then(flush).then(receiveChunk).then(receiveChunk).then(receiveChunk).then(requestEnds).then(close).expect(safety and s.retained == 0)
  run chunkedOverflowStaysBoundedTest = init.then(receiveChunk).then(receiveChunk).then(receiveChunk).then(queueRejection).then(flush).then(requestEnds).then(close).expect(safety and s.retained == 2 and not(s.dispatched))
  run validBodyReachesHandlerTest = init.then(receiveChunk).then(requestEnds).then(dispatch).then(queueSuccess).then(flush).then(close).expect(safety and s.response == 200)
  run peerCancellationIsNotSuccessTest = init.then(receiveChunk).then(peerAbort).expect(safety and not(s.flushed))
  run prematureCloseMasksRejectionTest = init.then(declaredTooLarge).then(queueRejection).then(flush).then(legacyClose).expect(not(safety))
}
