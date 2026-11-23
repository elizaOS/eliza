// Source lease freezes the prefix. A private pending room is not restored.
// Publication follows a complete atomic memory batch. Retries share an id.
module ConversationFork {
  var phase: str
  var original: int
  var copied: int
  var published: bool
  var calls: int
  action init = all {phase'="idle",original'=3,copied'=0,published'=false,calls'=0}
  action begin = all {phase.in(Set("idle","failed","done")),calls<2,phase'=if(published)"done"else"copy",calls'=calls+1,original'=original,copied'=copied,published'=published}
  action copy = all {phase=="copy",phase'="publish",copied'=2,original'=original,published'=published,calls'=calls}
  action publish = all {phase=="publish",phase'="done",published'=true,original'=original,copied'=copied,calls'=calls}
  action copyFailure = all {phase.in(Set("copy","publish")),phase'="failed",original'=original,copied'=copied,published'=published,calls'=calls}
  action step = any {begin,copy,publish,copyFailure,all {phase'=phase,original'=original,copied'=copied,published'=published,calls'=calls}}
  val OriginalPreserved = original==3
  val CompleteBeforeVisible = published.implies(copied==2)
  val Bounded = calls<=2 and copied.in(Set(0,2))
  run copyBeforePublishTest = init.then(begin).then(copy).expect(not(published)).then(publish).expect(CompleteBeforeVisible)
  run retryTest = init.then(begin).then(copy).then(copyFailure).then(begin).then(copy).then(publish).expect(OriginalPreserved and CompleteBeforeVisible)
}
