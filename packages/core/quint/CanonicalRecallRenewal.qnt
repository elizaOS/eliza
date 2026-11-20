// searchCanonicalConversationMemories
// (packages/core/src/access-control/provenance-envelope.ts) recalls stored
// rows for one delivery turn only while the turn's trusted delivery-audience
// evidence (packages/core/src/security/trusted-delivery-audience.ts) is valid.
// Evidence expires after a fixed TTL. A turn that is still active renews
// expired evidence from current room authority before the recall gate, and
// the renewal succeeds only while the room census is unchanged. An ended turn
// or cancelled turn, or a changed census, keeps expired evidence denied.
// Unexpired evidence keeps serving until it expires. The room is a group
// room, so recall is same-room.
// fresh: the evidence has not expired. active: the turn has neither ended
// nor been cancelled.
// changed: a participant joined after the evidence was minted.
// outcome: 0 no search yet, 1 complete with the stored row, 2 unavailable.
// atFresh, atActive, atChanged: what the latest search saw.
// last: the latest action, 0 none, 1 expire, 2 end, 3 join, 4 search,
// 5 cancel.
module CanonicalRecallRenewal {
  var fresh: bool
  var active: bool
  var changed: bool
  var outcome: int
  var atFresh: bool
  var atActive: bool
  var atChanged: bool
  var last: int

  action init = all {
    fresh' = true, active' = true, changed' = false, outcome' = 0,
    atFresh' = true, atActive' = true, atChanged' = false, last' = 0,
  }
  // The clock passes the evidence TTL.
  action expire = all {
    fresh,
    fresh' = false, active' = active, changed' = changed, outcome' = outcome,
    atFresh' = atFresh, atActive' = atActive, atChanged' = atChanged,
    last' = 1,
  }
  // The turn completes.
  action end = all {
    active,
    fresh' = fresh, active' = false, changed' = changed, outcome' = outcome,
    atFresh' = atFresh, atActive' = atActive, atChanged' = atChanged,
    last' = 2,
  }
  // The turn's abort signal fires.
  action cancel = all {
    active,
    fresh' = fresh, active' = false, changed' = changed, outcome' = outcome,
    atFresh' = atFresh, atActive' = atActive, atChanged' = atChanged,
    last' = 5,
  }
  // Another participant joins the room.
  action join = all {
    not(changed),
    fresh' = fresh, active' = active, changed' = true, outcome' = outcome,
    atFresh' = atFresh, atActive' = atActive, atChanged' = atChanged,
    last' = 3,
  }
  // Recall renews expired evidence of an active turn whose census is
  // unchanged, then serves the room; otherwise expired evidence is denied.
  action search = {
    val renews = not(fresh) and active and not(changed)
    all {
      fresh' = (fresh or renews), active' = active, changed' = changed,
      outcome' = if (fresh or renews) 1 else 2,
      atFresh' = fresh, atActive' = active, atChanged' = changed,
      last' = 4,
    }
  }
  // Nothing happens: the turn may sit idle, and nobody has to search.
  action stutter = all {
    fresh' = fresh, active' = active, changed' = changed, outcome' = outcome,
    atFresh' = atFresh, atActive' = atActive, atChanged' = atChanged,
    last' = last,
  }
  action step = any { expire, end, cancel, join, search, stutter }

  val ModelState = {
    fresh: fresh, active: active, changed: changed, outcome: outcome,
    atFresh: atFresh, atActive: atActive, atChanged: atChanged, last: last,
  }
  // An active turn whose census is unchanged gets its recall served.
  temporal ActiveTurnRecallsWithoutFairness =
    (active and not(changed) and outcome != 1)
      .leadsTo(outcome == 1 or not(active) or changed)
  temporal ActiveTurnRecalls = search.weakFair(ModelState)
    .implies(ActiveTurnRecallsWithoutFairness)

  val FreshEvidenceRecalls = outcome == 0 or not(atFresh) or outcome == 1
  val ActiveTurnRenews =
    outcome == 0 or atFresh or not(atActive) or atChanged or outcome == 1
  val EndedTurnStaysDenied =
    outcome == 0 or atFresh or atActive or outcome == 2
  val ChangedCensusStaysDenied =
    outcome == 0 or atFresh or not(atChanged) or outcome == 2
  val RenewalOnlyForActiveUnchangedTurn =
    last != 4 or atFresh or fresh == (atActive and not(atChanged))
  val TypeOK =
    Set(0, 1, 2).contains(outcome) and Set(0, 1, 2, 3, 4, 5).contains(last) and
    (last == 4 implies outcome != 0) and
    (outcome == 0 implies (atFresh and atActive and not(atChanged)))
}
