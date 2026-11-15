// Capture-only v3 spool after sealing. The catalogue and local receipts can
// become durable separately. Reopening requires the exact publication claim.
module agent_backup_capture_handoff {
  type Phase = Sealed | Publishing | Published
  type State = {
    phase: Phase, catalogCaptured: bool, captureReceipt: bool,
    uploaded: Set[int], owner: int,
  }
  var s: State
  pure val writers = Set(1, 2)
  pure val chunks = Set(1, 2)

  action init = s' = {
    phase: Sealed, catalogCaptured: false, captureReceipt: false,
    uploaded: Set(), owner: 0,
  }
  action recordCatalog = all {
    not(s.catalogCaptured), s' = s.with("catalogCaptured", true),
  }
  action acknowledgeCapture = all {
    s.catalogCaptured, not(s.captureReceipt), s.owner == 0,
    s' = s.with("captureReceipt", true),
  }
  // The resolver checks execution, state and manifest identity before it
  // returns the source. Reopening repairs a missing local capture receipt.
  action resolveSource(writer: int, exactClaim: bool): bool =
    if (exactClaim and s.catalogCaptured and s.owner == 0)
      s' = { ...s, owner: writer, captureReceipt: true }
    else s' = s

  action begin(writer: int): bool = all {
    s.owner == writer, s.phase == Sealed,
    s' = s.with("phase", Publishing),
  }
  action recordUpload(writer: int, chunk: int): bool = all {
    s.owner == writer, s.phase == Publishing or s.phase == Published,
    chunks.contains(chunk),
    s' = s.with("uploaded", s.uploaded.union(Set(chunk))),
  }
  action complete(writer: int): bool = all {
    s.owner == writer, s.phase == Publishing, s.captureReceipt, s.uploaded == chunks,
    s' = s.with("phase", Published),
  }
  action close(writer: int): bool = all {
    s.owner == writer, s' = s.with("owner", 0),
  }
  action idle = s' = s
  action openFirst = resolveSource(1, true)
  action beginFirst = begin(1)
  action recordFirst = recordUpload(1, 1)
  action recordSecond = recordUpload(1, 2)
  action completeFirst = complete(1)
  action stableStep = any {
    recordCatalog, acknowledgeCapture, openFirst, beginFirst,
    recordFirst, recordSecond, completeFirst, idle,
  }
  action step = any {
    recordCatalog, acknowledgeCapture, idle,
    {
      nondet writer = writers.oneOf()
      nondet chunk = chunks.oneOf()
      nondet exactClaim = Set(false, true).oneOf()
      any { resolveSource(writer, exactClaim), begin(writer),
        recordUpload(writer, chunk), complete(writer), close(writer) }
    },
  }

  val ExactCaptureReceipt = s.captureReceipt implies s.catalogCaptured
  val PublicationNeedsCaptureReceipt = s.phase != Sealed implies s.captureReceipt
  val CompletePublicationReceipts = s.uploaded.subseteq(chunks) and
    (s.phase == Published implies s.uploaded == chunks)
  val OwnedSourceNeedsCaptureReceipt = s.owner != 0 implies s.captureReceipt
  temporal ExclusiveOwnerAndDurableReceipts = always(and {
    (s.owner != 0 and next(s.owner) != 0) implies next(s.owner) == s.owner,
    s.captureReceipt implies next(s.captureReceipt),
    s.uploaded.subseteq(next(s.uploaded)),
    (s.owner != 0 and next(s.owner) == 0) implies next(s.phase) == s.phase,
  }.orKeep(s))
  temporal CataloguedCapturePublishes =
    always(s.catalogCaptured implies eventually(s.phase == Published))
  temporal FairStablePublication =
    (openFirst.weakFair(s) and beginFirst.weakFair(s) and
      recordFirst.weakFair(s) and recordSecond.weakFair(s) and completeFirst.weakFair(s))
    implies CataloguedCapturePublishes

  run missingCatalogCannotOpenTest = init.then(openFirst)
    .expect(s.owner == 0 and not(s.captureReceipt))
  run lostCaptureReplyRecoversBeforePublicationTest = init.then(recordCatalog)
    .expect(s.catalogCaptured and not(s.captureReceipt) and s.phase == Sealed)
    .then(openFirst).expect(s.owner == 1 and s.captureReceipt and s.phase == Sealed)
    .then(beginFirst).expect(PublicationNeedsCaptureReceipt)
  run staleClaimCannotAcquireTest = init.then(recordCatalog).then(resolveSource(1, false))
    .expect(s.owner == 0 and not(s.captureReceipt)).then(openFirst)
    .expect(OwnedSourceNeedsCaptureReceipt)
  run partialReceiptsSurviveExclusiveOwnerHandoffTest = init.then(recordCatalog)
    .then(acknowledgeCapture).then(openFirst).then(beginFirst).then(recordFirst)
    .then(resolveSource(2, true)).expect(s.owner == 1 and s.uploaded == Set(1))
    .then(close(1)).then(resolveSource(2, true)).then(recordUpload(2, 2))
    .then(complete(2)).then(close(2)).then(resolveSource(1, true))
    .expect(s.owner == 1 and s.phase == Published and CompletePublicationReceipts)
}
