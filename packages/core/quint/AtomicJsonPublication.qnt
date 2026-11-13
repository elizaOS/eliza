// utils/atomic-json.ts. A complete JSON body is written to an exclusive sibling
// temporary file before rename publishes it. Cleanup and the caller receipt follow.
module AtomicJsonPublication {
  pure val Writers = Set(1, 2)
  type Writer = { stage: str, temporary: str, renamed: bool, result: str, receipt: str }
  type State = { file: int, serial: bool, writers: int -> Writer }
  pure val queued: Writer = {
    stage: "queued", temporary: "absent", renamed: false,
    result: "pending", receipt: "pending",
  }
  pure def initial(serial: bool): State = {
    file: 0, serial: serial, writers: Writers.mapBy(_ => queued),
  }
  var s: State

  action init = s' = initial(false)
  action serialInit = s' = initial(true)

  // Same-process async calls are admitted in invocation order. Distinct
  // processes, or a synchronous call beside an async one, have no shared tail.
  action admit(writer: int, created: bool): bool = {
    val own = s.writers.get(writer)
    all {
      own.stage == "queued",
      not(s.serial) or writer == 1 or s.writers.get(1).stage == "settled",
      s' = s.with("writers", s.writers.set(writer, {
        ...own, stage: if (created) "writing" else "cleanup",
        temporary: if (created) "partial" else "absent",
        result: if (created) "pending" else "failure",
      })),
    }
  }

  action finishWrite(writer: int, success: bool): bool = {
    val own = s.writers.get(writer)
    all {
      own.stage == "writing",
      s' = s.with("writers", s.writers.set(writer, {
        ...own, stage: if (success) "renaming" else "cleanup",
        temporary: if (success) "complete" else "partial",
        result: if (success) "pending" else "failure",
      })),
    }
  }

  action rename(writer: int, success: bool): bool = {
    val own = s.writers.get(writer)
    all {
      own.stage == "renaming", own.temporary == "complete",
      s' = { ...s, file: if (success) writer else s.file,
        writers: s.writers.set(writer, {
          ...own, stage: "cleanup", renamed: success,
          temporary: if (success) "absent" else "complete",
          result: if (success) "success" else "failure",
        }),
      },
    }
  }

  // A failed rm is diagnostic and cannot replace the publication outcome.
  action cleanup(writer: int, removed: bool): bool = {
    val own = s.writers.get(writer)
    all {
      own.stage == "cleanup",
      s' = s.with("writers", s.writers.set(writer, {
        ...own, stage: "settled", receipt: own.result,
        temporary: if (removed) "absent" else own.temporary,
      })),
    }
  }

  // Process death skips finally. A published rename can outlive an absent
  // caller receipt, and a pre-rename temporary file can remain on disk.
  action crash(writer: int): bool = {
    val own = s.writers.get(writer)
    all {
      not(s.serial), Set("writing", "renaming", "cleanup").contains(own.stage),
      s' = s.with("writers", s.writers.set(writer,
        { ...own, stage: "crashed", receipt: "unknown" })),
    }
  }

  action advance(writer: int): bool = {
    nondet success = Set(false, true).oneOf()
    any { admit(writer, success), finishWrite(writer, success),
      rename(writer, success), cleanup(writer, success) }
  }
  action step = any { advance(1), advance(2), crash(1), crash(2), s' = s }

  val ReadersSeePublishedSnapshot = s.file == 0 or s.writers.get(s.file).renamed
  val ReceiptRequiresRename = Writers.forall(writer => {
    val own = s.writers.get(writer)
    (own.receipt == "success" implies own.renamed) and
      (own.receipt == "failure" implies not(own.renamed)) and
      (own.receipt == "unknown" implies own.stage == "crashed")
  })
  val QueueRetainsOrder = s.serial and s.writers.get(1).stage != "settled"
    implies s.writers.get(2) == queued

  temporal PublishedDataSurvivesCleanup = always(and {
    s.file != next(s.file) implies Writers.exists(writer =>
      s.writers.get(writer).stage == "renaming" and next(s.file) == writer
        and next(s.writers.get(writer).renamed)),
    Writers.forall(writer =>
      s.writers.get(writer).renamed implies next(s.writers.get(writer).renamed)),
    Writers.forall(writer =>
      s.writers.get(writer).stage == "crashed" implies
        next(s.writers.get(writer)) == s.writers.get(writer)),
  }.orKeep(s))
  temporal WritesSettle = eventually(Writers.forall(writer =>
    Set("settled", "crashed").contains(s.writers.get(writer).stage)))
  temporal FairWritesSettle =
    (advance(1).weakFair(s) and advance(2).weakFair(s)) implies WritesSettle

  run OrderedAsyncCallsTest = serialInit.then(admit(1, true)).then(finishWrite(1, true))
    .expect(s.file == 0 and s.writers.get(2) == queued)
    .then(rename(1, true)).then(cleanup(1, true)).then(admit(2, true))
    .then(finishWrite(2, true)).then(rename(2, true)).then(cleanup(2, true))
    .expect(s.file == 2 and ReceiptRequiresRename)
  run FailedRenameDoesNotPoisonNextCallTest = serialInit.then(admit(1, true))
    .then(finishWrite(1, true)).then(rename(1, false)).then(cleanup(1, true))
    .expect(s.file == 0 and s.writers.get(1).receipt == "failure")
    .then(admit(2, true)).then(finishWrite(2, true)).then(rename(2, true)).then(cleanup(2, true))
    .expect(s.file == 2 and s.writers.get(2).receipt == "success")
  run IndependentWritersPublishWholeSnapshotsTest = init.then(admit(1, true)).then(admit(2, true))
    .then(finishWrite(2, true)).then(rename(2, true)).then(finishWrite(1, true))
    .then(rename(1, true)).then(cleanup(2, true)).then(cleanup(1, true))
    .expect(s.file == 1 and ReadersSeePublishedSnapshot and ReceiptRequiresRename)
  run PreRenameDeathLeavesOwnTemporaryFileTest = init.then(admit(1, true))
    .then(finishWrite(1, true)).then(crash(1))
    .expect(s.file == 0 and s.writers.get(1).temporary == "complete")
    .then(admit(2, true)).then(finishWrite(2, true)).then(rename(2, true)).then(cleanup(2, true))
    .expect(s.file == 2 and s.writers.get(1).temporary == "complete")
  run PostRenameDeathLeavesUnknownCallerReceiptTest = init.then(admit(1, true))
    .then(finishWrite(1, true)).then(rename(1, true)).then(crash(1))
    .expect(s.file == 1 and s.writers.get(1).receipt == "unknown" and ReceiptRequiresRename)
  run CleanupFailurePreservesWriteFailureTest = init.then(admit(1, true))
    .then(finishWrite(1, false)).then(cleanup(1, false))
    .expect(s.file == 0 and s.writers.get(1).receipt == "failure"
      and s.writers.get(1).temporary == "partial")
}
