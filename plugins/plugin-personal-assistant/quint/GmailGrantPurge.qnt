// Two flows remove a Google account's local Gmail data: disconnecting the
// account with purgeImportedData runs GoogleDomain.clearGoogleGrantData
// (plugins/plugin-personal-assistant/src/lifeops/domains/google-service.ts),
// and an account handoff that removes the previous account's imports runs
// AccountHandoffDataDisposition.apply (src/lifeops/account-handoff-data-
// disposition.ts). Both remove the account's imported Gmail messages with
// their inbox cache copies and the Gmail sync state that holds the history
// cursor. Other accounts keep theirs. A reconnected Google account gets the
// same grant id (its connector account id derives from the Google subject
// and role), so the next Gmail sync reads whatever cursor was left behind.
// Grant 0 is the handoff's previous owner account, 1 the replacement owner
// account and 2 an agent-side account. Requests 0, 1 and 2 disconnect grant
// 0, 1 or 2 with purgeImportedData; request 3 is the handoff from grant 0 to
// grant 1 that removes the previous account's imports.
module GmailGrantPurge {
  type Rows = { mail: bool, cursor: bool }
  pure val Grants = 0.to(2)
  pure val Requests = 0.to(3)
  pure val Handoff = 3
  pure val NoRequest = -1
  pure val MaxPurges = 2
  pure val Empty: Rows = { mail: false, cursor: false }
  pure val CursorOnly: Rows = { mail: false, cursor: true }
  pure val Imported: Rows = { mail: true, cursor: true }
  pure val Saved = Set(Empty, CursorOnly, Imported)

  // The local Gmail rows of each grant, and their values before the last
  // purge (a later sync updates both).
  var rows: int -> Rows
  var before: int -> Rows
  // Connected grants. A purged grant stays disconnected until reconnected.
  var connected: int -> bool
  // Grants purged and not synchronized since then.
  var purged: int -> bool
  var handedOff: bool
  // The purge the owner asked for and the assistant has not run yet, the
  // last purge that ran and the number of purges.
  var asked: int
  var last: int
  var applied: int

  pure def target(k: int): int = if (k == Handoff) 0 else k
  def allowed(k: int): bool =
    if (k == Handoff) connected.get(0) and connected.get(1) and not(handedOff)
    else connected.get(k)

  action init = {
    nondet r0 = Saved.oneOf()
    nondet r1 = Saved.oneOf()
    nondet r2 = Saved.oneOf()
    val r = Map(0 -> r0, 1 -> r1, 2 -> r2)
    all {
      rows' = r, before' = r,
      connected' = Grants.mapBy(g => true),
      purged' = Grants.mapBy(g => false),
      handedOff' = false,
      asked' = NoRequest, last' = NoRequest, applied' = 0,
    }
  }
  action ask = {
    nondet k = Requests.oneOf()
    all {
      asked == NoRequest, applied < MaxPurges, allowed(k),
      rows' = rows, before' = before,
      connected' = connected, purged' = purged, handedOff' = handedOff,
      asked' = k, last' = last, applied' = applied,
    }
  }
  action purge = {
    nondet k = Requests.oneOf()
    val t = target(k)
    all {
      asked == k,
      rows' = rows.set(t, Empty), before' = rows,
      connected' = connected.set(t, false), purged' = purged.set(t, true),
      handedOff' = (handedOff or k == Handoff),
      asked' = NoRequest, last' = k, applied' = applied + 1,
    }
  }
  // A Gmail sync of a connected account imports its mail and saves a cursor.
  action sync = {
    nondet g = Grants.oneOf()
    all {
      asked == NoRequest, connected.get(g),
      rows' = rows.set(g, Imported), before' = before.set(g, Imported),
      connected' = connected, purged' = purged.set(g, false),
      handedOff' = handedOff,
      asked' = asked, last' = last, applied' = applied,
    }
  }
  // Reconnecting keeps the grant id and imports nothing by itself.
  action reconnect = {
    nondet g = Grants.oneOf()
    all {
      asked == NoRequest, not(connected.get(g)),
      rows' = rows, before' = before,
      connected' = connected.set(g, true), purged' = purged,
      handedOff' = handedOff,
      asked' = asked, last' = last, applied' = applied,
    }
  }
  // The assistant may never run a requested purge.
  action stutter = all {
    rows' = rows, before' = before,
    connected' = connected, purged' = purged, handedOff' = handedOff,
    asked' = asked, last' = last, applied' = applied,
  }
  action step = any { ask, purge, sync, reconnect, stutter }

  val ModelState = {
    rows: rows, before: before, connected: connected, purged: purged,
    handedOff: handedOff, asked: asked, last: last, applied: applied,
  }
  temporal PurgeAppliedWithoutFairness =
    (asked != NoRequest).leadsTo(asked == NoRequest)
  temporal PurgeApplied = purge.weakFair(ModelState)
    .implies(PurgeAppliedWithoutFairness)

  // A purged account keeps no imported mail and no sync cursor until a new
  // sync, even after it is reconnected with the same grant id.
  val PurgedGrantEmpty =
    Grants.forall(g => purged.get(g) implies rows.get(g) == Empty)
  val OtherGrantsKept =
    last == NoRequest or
      Grants.forall(g => g == target(last) or rows.get(g) == before.get(g))
  val TypeOK = and {
    Grants.forall(g => rows.get(g).mail implies rows.get(g).cursor),
    asked == NoRequest or Requests.contains(asked),
    last == NoRequest or Requests.contains(last),
    0 <= applied, applied <= MaxPurges,
    applied == 0 iff last == NoRequest,
    handedOff implies applied > 0,
  }
}
