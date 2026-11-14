// An owner "my timezone is ..." statement replaces the stored calendar zone
// only when it names a zone the shared resolver knows.
module OwnerProfileTimezone {
  // Zones: -1 none stored, 0 Europe/Berlin, 1 America/New_York,
  // 2 America/Los_Angeles, 9 text that names no zone.
  // Statements: 0 "My timezone is America/New_York", 1 the same sentence
  // ending with a period, 2 "my timezone is pacific.", 3 "my timezone is
  // whatever the laptop says." (names no zone).
  // readZone: -1 not read or refused, a zone from the owner fact, or 8 for
  // the non-owner fallback (agent setting or runtime default).
  var prior: int
  var statement: int
  var phase: int
  var stored: int
  var readZone: int
  var readFailed: bool

  pure def namedZone(s: int): int =
    if (s == 0 or s == 1) 1 else if (s == 2) 2 else -1
  pure def knownZone(zone: int): bool = Set(0, 1, 2).contains(zone)

  action init = {
    nondet chosenPrior = Set(-1, 0).oneOf()
    nondet chosenStatement = Set(0, 1, 2, 3).oneOf()
    all {
      prior' = chosenPrior, statement' = chosenStatement, phase' = 0,
      stored' = chosenPrior, readZone' = -1, readFailed' = false
    }
  }
  // owner.profile_extraction: keep the named zone, or leave the stored zone.
  action extract = all {
    phase == 0, phase' = 1, prior' = prior, statement' = statement,
    stored' = if (namedZone(statement) >= 0) namedZone(statement) else stored,
    readZone' = readZone, readFailed' = readFailed
  }
  // resolveCalendarTimeZone: the owner fact when set, refused when it is not
  // a zone, otherwise the non-owner fallback.
  action read = all {
    phase == 1, phase' = 2, prior' = prior, statement' = statement,
    stored' = stored,
    readZone' = if (knownZone(stored)) stored else if (stored == -1) 8 else -1,
    readFailed' = not(knownZone(stored) or stored == -1)
  }
  action stay = all {
    phase == 2, phase' = phase, prior' = prior, statement' = statement,
    stored' = stored, readZone' = readZone, readFailed' = readFailed
  }
  action step = any { extract, read, stay }

  val StoredZoneKnown = stored == -1 or knownZone(stored)
  val NamedZoneReplaces =
    phase == 0 or namedZone(statement) == -1 or stored == namedZone(statement)
  val UnnamedKeepsPrior =
    phase == 0 or namedZone(statement) >= 0 or stored == prior
  val CalendarReadsStoredZone =
    phase != 2 or (not(readFailed) and readZone == (if (stored == -1) 8 else stored))
}

// A parsed return date ends an owner's travel window at the stated local day.
module OwnerTravelReturn {
  // Statements 0 and 1 name ordinal days, 2 and 3 name plain and ISO dates,
  // 4 omits the date, and 5 names an impossible ordinal calendar date.
  // End 0 is November 21, 1 is December 3, and 2 is the 30-day fallback.
  var statement: int
  var phase: int
  var end: int
  var activeAtTick: bool

  action init = {
    nondet chosen = 0.to(5).oneOf()
    all { statement' = chosen, phase' = 0, end' = -1, activeAtTick' = false }
  }
  action extract = all {
    phase == 0, statement' = statement, phase' = 1,
    end' = if (statement == 1) 1 else if (statement < 4) 0 else 2,
    activeAtTick' = activeAtTick
  }
  // The schedule reads its owner facts on December 4.
  action tick = all {
    phase == 1, statement' = statement, phase' = 2,
    end' = end, activeAtTick' = end == 2
  }
  action stay = all {
    statement' = statement, phase' = phase,
    end' = end, activeAtTick' = activeAtTick
  }
  action step = any { extract, tick, stay }

  val ExplicitReturnStored = phase == 0 or statement >= 4 or
    end == (if (statement == 1) 1 else 0)
  val UnresolvedReturnIsBounded = phase == 0 or statement < 4 or end == 2
  val ScheduleSeesExpiry = phase != 2 or activeAtTick == (statement >= 4)
  temporal TickObserved = eventually(phase == 2)
  temporal FairTickObserved =
    (extract.weakFair(phase) and tick.weakFair(phase)) implies TickObserved
}
