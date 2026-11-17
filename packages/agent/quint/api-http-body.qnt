// hono-mount.ts rejects oversized bodies without closing an upload in progress.
// Three abstract body increments and a retained cap of two bound this case.
// A local response flush and peer receipt are separate transport events.
module api_http_body {
  var s: {
    received: int,
    retained: int,
    oversized: bool,
    discarding: bool,
    requestDone: bool,
    response: int,
    flushed: bool,
    closed: bool,
    peerAborted: bool,
    resetError: bool,
    dispatched: bool
  }

  action init = s' = {
    received: 0,
    retained: 0,
    oversized: false,
    discarding: false,
    requestDone: false,
    response: 0,
    flushed: false,
    closed: false,
    peerAborted: false,
    resetError: false,
    dispatched: false
  }

  // A declared Content-Length over the route cap starts draining immediately.
  action declaredTooLarge = all {
    s.received == 0,
    s.response == 0,
    not(s.closed or s.requestDone),
    s' = { ...s, oversized: true, discarding: true }
  }

  // readNodeBody stops retaining bytes as soon as the accumulated cap is crossed.
  action receiveChunk = {
    val overflow = s.oversized or s.received + 1 > 2
    all {
      s.received < 3,
      not(s.closed or s.requestDone),
      s' = {
        ...s,
        received: s.received + 1,
        oversized: overflow,
        discarding: overflow,
        retained: if (overflow) s.retained else s.retained + 1
      }
    }
  }

  action requestEnds = all {
    s.received > 0,
    not(s.closed or s.requestDone),
    s' = { ...s, requestDone: true }
  }

  // The runtime handler is reached only after a bounded body has completed.
  action dispatch = all {
    s.requestDone,
    not(s.closed or s.oversized),
    s.response == 0,
    s' = { ...s, dispatched: true }
  }

  action queueSuccess = all {
    s.dispatched,
    not(s.closed),
    s.response == 0,
    s' = { ...s, response: 200 }
  }

  action queueRejection = all {
    s.oversized,
    not(s.closed),
    s.response == 0,
    s' = { ...s, response: 413 }
  }

  action flush = all {
    s.response != 0,
    not(s.closed),
    s' = { ...s, flushed: true }
  }

  // This bounded case includes normal close after drain and local flush.
  action close = all {
    s.requestDone,
    s.flushed,
    s' = { ...s, closed: true }
  }

  action peerAbort = s' = { ...s, closed: true, peerAborted: true }

  // The previous Connection: close path could reset a still-writing peer.
  action legacyClose = all {
    s.response != 0,
    s' = { ...s, closed: true, resetError: not(s.requestDone) }
  }
  action idle = s' = s
  action step = any {
    declaredTooLarge, receiveChunk, requestEnds, dispatch, queueSuccess,
    queueRejection, flush, close, peerAbort, idle
  }
  action legacyStep = any { step, legacyClose }

  val safety = all {
    s.received >= 0,
    s.received <= 3,
    s.retained >= 0,
    s.retained <= 2,
    s.response == 413 implies s.oversized,
    s.dispatched implies (s.requestDone and not(s.oversized)),
    s.closed and not(s.peerAborted) implies (s.requestDone and s.flushed),
    not(s.resetError)
  }

  run declaredOverflowDrainsAfterRejectionTest = init
    .then(declaredTooLarge).then(queueRejection).then(flush)
    .then(receiveChunk).then(receiveChunk).then(receiveChunk)
    .then(requestEnds).then(close).expect(safety and s.retained == 0)
  run chunkedOverflowStaysBoundedTest = init
    .then(receiveChunk).then(receiveChunk).then(receiveChunk)
    .then(queueRejection).then(flush).then(requestEnds).then(close)
    .expect(safety and s.retained == 2 and not(s.dispatched))
  run validBodyReachesHandlerTest = init.then(receiveChunk).then(requestEnds)
    .then(dispatch).then(queueSuccess).then(flush).then(close)
    .expect(safety and s.response == 200)
  run peerCancellationIsNotSuccessTest = init.then(receiveChunk)
    .then(peerAbort).expect(safety and not(s.flushed))
  run prematureCloseMasksRejectionTest = init.then(declaredTooLarge)
    .then(queueRejection).then(flush).then(legacyClose).expect(not(safety))
}

// IPC serializes a body before the legacy route reads its HTTP-shaped headers.
// Explicit framing stays authoritative. Positive unframed bytes acquire a length.
module ipc_body_framing {
  var s: {bytes: int, supplied: str, header: str, prepared: bool, read: bool, seen: int}
  action initCase(bytes: int, header: str): bool = s' = {
    bytes: bytes, supplied: header, header: header, prepared: false, read: false, seen: 0
  }
  action init = {
    nondet bytes = Set(0, 1, 2).oneOf()
    nondet header = Set("none", "length", "zero", "chunked").oneOf()
    initCase(bytes, header)
  }
  action prepare = all {
    not(s.prepared),
    s' = {...s, prepared: true,
      header: if (s.bytes > 0 and s.supplied == "none") "length" else s.supplied}
  }
  action read = all {
    s.prepared, not(s.read),
    s' = {...s, read: true,
      seen: if (s.header.in(Set("length", "chunked"))) s.bytes else 0}
  }
  action idle = s' = s
  action step = any {prepare, read, idle}
  val safety = all {
    s.supplied != "none" implies s.header == s.supplied,
    (s.prepared and s.bytes == 0 and s.supplied == "none") implies s.header == "none",
    (s.read and s.bytes > 0 and s.supplied == "none") implies s.seen == s.bytes
  }
  temporal FairReadCompletes = (prepare.weakFair(s) and read.weakFair(s)) implies eventually(s.read)
  temporal ReadCompletes = eventually(s.read)
  run missingLengthPreservesBodyTest = initCase(2, "none").then(prepare).then(read)
    .expect(safety and s.seen == 2)
  run explicitEmptyRemainsEmptyTest = initCase(2, "zero").then(prepare).then(read)
    .expect(safety and s.seen == 0)
  run chunkedRemainsChunkedTest = initCase(2, "chunked").then(prepare).then(read)
    .expect(safety and s.header == "chunked" and s.seen == 2)
}
