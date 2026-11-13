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
