// Organization indexes can retain an ID after the global task key is replaced.
// Primary mutation ownership is checked by the RedisTaskLease module above.
module RedisTaskIndex {
  var index: { owner: int, members: Set[int], phase: str, reader: int,
    returnedOwner: int, foreignOverwrite: bool }
  action init = index' = {
    owner: 1, members: Set(1), phase: "initial", reader: 0, returnedOwner: 0,
    foreignOverwrite: false,
  }
  action attemptForeignWrite = all { index.phase == "initial", index' = index }
  action deletePrimary = all {
    index.phase == "initial",
    index' = { ...index, owner: 0, phase: "vacant" },
  }
  action replaceOwner = all {
    index.phase == "vacant",
    index' = { ...index, owner: 2, phase: "index" },
  }
  action finishIndex = {
    nondet succeeds = Set(false, true).oneOf()
    all { index.phase == "index", index' = {
      ...index, members: if (succeeds) index.members.union(Set(2)) else index.members,
      phase: "settled",
    } }
  }
  action list(reader: int): bool = index' = {
    ...index, reader: reader, returnedOwner:
      if (index.members.contains(reader) and index.owner == reader) index.owner else 0,
  }
  action step = any {
    attemptForeignWrite, deletePrimary, replaceOwner, finishIndex,
    list(1), list(2), index' = index,
  }
  val NoForeignPublication = index.returnedOwner == 0 or index.returnedOwner == index.reader
  val NoForeignOverwrite = not(index.foreignOverwrite)
  temporal IndexAttemptSettles = finishIndex.weakFair(index).implies(
    always((index.phase == "index").implies(eventually(index.phase == "settled"))))
  action legacyList(reader: int): bool = index' = {
    ...index, reader: reader,
    returnedOwner: if (index.members.contains(reader)) index.owner else 0,
  }
  action legacyForeignWrite = all {
    index.phase == "initial",
    index' = { ...index, owner: 2, foreignOverwrite: true },
  }
  run staleIndexCannotPublishForeignTaskTest = init.then(deletePrimary)
    .then(replaceOwner).then(list(1)).expect(NoForeignPublication and index.returnedOwner == 0)
  run legacyStaleIndexPublishesForeignTaskTest = init.then(deletePrimary)
    .then(replaceOwner).then(legacyList(1)).expect(not(NoForeignPublication))
  run liveOwnerCannotBeReplacedTest = init.then(attemptForeignWrite)
    .expect(NoForeignOverwrite and index.owner == 1)
  run legacyLiveOwnerIsReplacedTest = init.then(legacyForeignWrite)
    .expect(not(NoForeignOverwrite) and index.owner == 2)
}
