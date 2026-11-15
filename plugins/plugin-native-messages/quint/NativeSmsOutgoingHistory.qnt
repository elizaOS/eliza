/// Two recipients, one reviewed operation. Rows denote only this app's prepared outbox rows.
module NativeSmsOutgoingHistory {
  var s: { phase: str, owns: bool, preparedOwner: bool, rows: Set[int], attempted: int, retired: bool }
  action init = s' = {phase:"idle",owns:true,preparedOwner:true,rows:Set(),attempted:0,retired:false}
  action begin(owner: bool): bool = all {s.phase=="idle",not(s.retired),s'={...s,phase:"preparing",owns:owner,preparedOwner:owner}}
  action prepare = all {s.phase=="preparing",s'={...s,phase:"prepared",rows:if(s.owns)Set(0,1)else Set()}}
  action refusePreparation = all {s.phase=="preparing",s'={...s,phase:"denied",rows:Set(),retired:true}}
  action preparation = any {prepare,refusePreparation}
  action roleChange = all {Set("prepared","dispatching").contains(s.phase),s'={...s,owns:not(s.owns)}}
  action attempt = all {Set("prepared","dispatching").contains(s.phase),s.attempted<2,s.owns==s.preparedOwner,
    s'={...s,phase:"dispatching",attempted:s.attempted+1}}
  action finish = all {Set("prepared","dispatching").contains(s.phase),
    s'={...s,phase:if(s.attempted==0)"denied"else if(s.attempted==2)"submitted"else "unknown",
      rows:s.rows.filter(i=>i<s.attempted),retired:true}}
  action step = any {begin(true),begin(false),preparation,roleChange,attempt,finish,s'=s}
  val terminal = Set("denied","submitted","unknown").contains(s.phase)
  val safety = s.attempted<=2 and
    (s.phase=="denied" implies s.attempted==0 and s.rows==Set()) and
    (s.preparedOwner and not(terminal) and s.attempted>0 implies s.rows==Set(0,1)) and
    (terminal implies s.retired and s.rows.forall(i=>i<s.attempted)) and
    (not(s.preparedOwner) implies s.rows==Set())
  temporal Settles = (preparation.weakFair(s) and finish.weakFair(s)) implies
    always(Set("preparing","prepared","dispatching").contains(s.phase) implies eventually(terminal))
  run ownRowsTest = init.then(begin(true)).then(prepare).then(attempt).then(attempt).then(finish).expect(s.rows==Set(0,1) and safety)
  run refusedTest = init.then(begin(true)).then(refusePreparation).expect(s.attempted==0 and s.retired and safety)
  run roleLossTest = init.then(begin(true)).then(prepare).then(roleChange).then(finish).expect(s.phase=="denied" and safety)
  run partialTest = init.then(begin(true)).then(prepare).then(attempt).then(finish).expect(s.phase=="unknown" and s.rows==Set(0) and safety)
  run platformRowsTest = init.then(begin(false)).then(prepare).then(attempt).then(attempt).then(finish).expect(s.rows==Set() and safety)
}
