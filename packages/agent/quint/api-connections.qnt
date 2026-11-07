// Conversation connection reconciliation: per-descriptor generation fences and raw-write ownership.
// Bounds: two queued mutations, two generation changes, one room and one runtime.
// An observer timeout does not terminate underlying database I/O or release its lock.
module api_connections {
  var s: { generation: int, captured: int, queue: List[int], writing: bool, writingGeneration: int, timedOut: bool, blocked: bool, deleted: bool, published: bool, publishedGeneration: int }
  action init = s' = { generation: 0, captured: -1, queue: [], writing: false, writingGeneration: -1, timedOut: false, blocked: false, deleted: false, published: false, publishedGeneration: -1 }
  action capture = all { not(s.blocked), not(s.deleted), s' = s.with("captured", s.generation) }
  action enqueue = all { s.captured == s.generation, not(s.blocked), not(s.timedOut), s.queue.length() < 2, s' = s.with("queue", s.queue.append(s.captured)) }
  action beginWrite = all { s.queue.length() > 0, not(s.writing), not(s.timedOut), not(s.blocked), s.queue.head() == s.generation, s' = s.with("writing", true).with("writingGeneration", s.queue.head()) }
  action timeout = all { s.writing, not(s.timedOut), s.generation < 2, s' = s.with("timedOut", true).with("generation", s.generation + 1).with("published", false) }
  action invalidate = all { s.generation < 2, s' = s.with("generation", s.generation + 1).with("published", false) }
  action writeSettles = all { s.writing, s' = s.with("writing", false).with("queue", s.queue.tail()).with("timedOut", false).with("published", not(s.blocked) and s.writingGeneration == s.generation).with("publishedGeneration", s.writingGeneration).with("writingGeneration", -1) }
  action cancelQueued = all { s.queue.length() > 0, not(s.writing), s' = s.with("queue", s.queue.tail()) }
  action blockDeletion = all { not(s.blocked), s.generation < 2, s' = s.with("generation", s.generation + 1).with("blocked", true).with("published", false) }
  action finishDeletion = all { s.blocked, not(s.writing), s.queue.length() == 0, s' = s.with("blocked", false).with("deleted", true).with("captured", -1) }
  action recreate = all { s.deleted, s.generation < 2, s' = s.with("generation", s.generation + 1).with("deleted", false) }
  action idle = s' = s
  action step = any { capture, enqueue, beginWrite, timeout, invalidate, writeSettles, cancelQueued, blockDeletion, finishDeletion, recreate, idle }
  val safety = all {
    s.queue.length() <= 2,
    s.writing implies (s.queue.length() > 0 and s.writingGeneration == s.queue.head()),
    s.timedOut implies s.writing,
    s.published implies all { not(s.blocked), not(s.deleted), s.publishedGeneration == s.generation },
    s.deleted implies not(s.writing)
  }
  run timeoutRetainsRawOwnershipTest = init.then(capture).then(enqueue).then(beginWrite).then(timeout).expect(s.writing and s.timedOut).then(writeSettles).expect(not(s.published))
  run newCaptureCannotRefreshOldWriteTest = init.then(capture).then(enqueue).then(beginWrite).then(invalidate).then(capture).then(writeSettles).expect(not(s.published) and s.captured == s.generation)
  run staleQueuedDescriptorCannotRefreshTest = init.then(capture).then(enqueue).then(invalidate).then(capture).then(enqueue).then(cancelQueued).then(beginWrite).then(writeSettles).expect(s.published and safety)
  run deletionInvalidatesDescriptorTest = init.then(capture).then(enqueue).then(beginWrite).then(blockDeletion).then(writeSettles).then(finishDeletion).expect(s.deleted and not(s.published))
}
