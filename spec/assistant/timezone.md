# Owner time zone

Reminders, check-ins, goals and the daily dossier fire at the owner's
local time. The owner states their zone in conversation ("my timezone is
America/New_York"), and the assistant stores it as an owner fact that the
calendar and the scheduler read. When a scheduler tick runs, its
preflight and its runner resolve the owner's clock with the one definition
below, from the facts as they stand at that tick, so they never disagree.

After each owner message a model reads whether it states the owner's own
zone, and writes the zone it names, or an empty name when it states none:
a zone named for an event, a place, another person or a trip is not the
owner's. The words are never matched against a pattern. A statement is
modeled as the zone the shared zone resolver maps the model's name to: an
IANA zone, the zone an alias such as "pacific" names, or the name itself
when it is no zone the resolver knows. Whether a name is a
zone the resolver knows is the host's IANA database, which the spec does
not model: any IANA zone the host knows can be stored, not only the zones
the simulator tries.

## Story: Run my day on my own clock

> As an owner, I want my reminders and check-ins to follow the time zone I
> told the agent, and the zone I am travelling in while I travel, and
> never a zone guessed from something I said that was not a zone.

### Whether a name is a zone is the host's zone database to say, and the empty name never is

```quint
const knownZone: (str) => bool
pure def lawTheEmptyNameIsNoZone(namedZone: str): bool = namedZone == "" implies not(knownZone(namedZone))
```

### A stated zone replaces the stored zone only when the resolver knows it

A statement that names no known zone leaves the stored zone as it was.

```quint
type OwnerTimezone = { storedZone: str }
pure val initial: OwnerTimezone = { storedZone: "" }
pure val namedZoneValues = Set("", "America/New_York", "America/Los_Angeles", "whatever the laptop says")
pure def stateTimezone(s: OwnerTimezone, namedZone: str): OwnerTimezone =
  if (knownZone(namedZone)) { storedZone: namedZone } else s
pure def alwaysStoredZoneIsKnown(s: OwnerTimezone): bool = s.storedZone == "" or knownZone(s.storedZone)
pure val storedZoneValues = Set("", "Europe/Berlin")
pure def lawUnknownStatementKeepsTheStoredZone(storedZone: str, namedZone: str): bool =
  not(knownZone(namedZone)) implies stateTimezone({ storedZone: storedZone }, namedZone).storedZone == storedZone
pure def lawKnownStatementReplacesTheStoredZone(storedZone: str, namedZone: str): bool =
  knownZone(namedZone) implies stateTimezone({ storedZone: storedZone }, namedZone).storedZone == namedZone
pure def sometimesZoneStated(s: OwnerTimezone): bool = s.storedZone == "America/Los_Angeles"
```

### The calendar reads the stored zone, or the agent's zone when none is stored

```quint
pure def calendarZone(s: OwnerTimezone, agentZone: str): str = if (s.storedZone != "") s.storedZone else agentZone
pure def lawCalendarFollowsTheStatedZone(namedZone: str, agentZone: str): bool =
  calendarZone(stateTimezone(initial, namedZone), agentZone) == (if (knownZone(namedZone)) namedZone else agentZone)
```

### At a tick, the owner's clock is the travel zone while travelling, else the first zone known

The tick's own owner facts decide whether the owner is travelling; the
host clock's date does not, so a trip the host's date says is under way
never overrides the tick. Otherwise the order is the owner's stored
zone, the scheduling zone, the runtime's zone, and the host's zone, which
always exists.

```quint
type ClockFacts = { ownerZone: str, schedulingZone: str, runtimeZone: str, hostZone: str, travellingAtTick: bool, hostTravelling: bool, travelZone: str }
pure def ownerClockZone(facts: ClockFacts): str =
  if (facts.travellingAtTick and facts.travelZone != "") facts.travelZone
  else if (facts.ownerZone != "") facts.ownerZone
  else if (facts.schedulingZone != "") facts.schedulingZone
  else if (facts.runtimeZone != "") facts.runtimeZone
  else facts.hostZone
pure val homeFacts: ClockFacts = { ownerZone: "Europe/Berlin", schedulingZone: "America/New_York", runtimeZone: "America/New_York", hostZone: "America/Los_Angeles", travellingAtTick: false, hostTravelling: false, travelZone: "" }
pure val factsValues: Set[ClockFacts] = List(
  homeFacts, { ...homeFacts, ownerZone: "" }, { ...homeFacts, ownerZone: "", schedulingZone: "" },
  { ...homeFacts, ownerZone: "", schedulingZone: "", runtimeZone: "" }, { ...homeFacts, travellingAtTick: true, travelZone: "America/New_York" },
  { ...homeFacts, travellingAtTick: true }, { ...homeFacts, hostTravelling: true, travelZone: "America/New_York" }
).foldl(Set(), (acc, f) => acc.union(Set(f)))
pure def lawTravelZoneWinsAtTheTick(facts: ClockFacts): bool =
  (facts.travellingAtTick and facts.travelZone != "") implies ownerClockZone(facts) == facts.travelZone
pure def lawStatedZoneWinsAtHome(facts: ClockFacts): bool =
  (not(facts.travellingAtTick) and facts.ownerZone != "") implies ownerClockZone(facts) == facts.ownerZone
pure def lawHostTravelNeverOverridesTheTick(facts: ClockFacts): bool =
  ownerClockZone(facts) == ownerClockZone({ ...facts, hostTravelling: not(facts.hostTravelling) })
pure def lawClockIsNeverMissing(facts: ClockFacts): bool =
  facts.hostZone != "" implies ownerClockZone(facts) != ""
```

### A phone reminder or Clock alarm uses the zone the phone reported for this turn

A Clock set is proposed only on the zone the turn's nonsensitive screen
reported, so the alarm the owner reviews rings at the wall time they asked
for; a set in any other zone offers nothing. A stated local reminder time
is placed in that zone, and a wall time the zone skips or repeats is
refused rather than moved. An empty repeat is a one-off alarm and carries
no days. A proposed reminder's time is shown to the owner in its repeat
zone, else in the zone the phone reported for this turn, else in UTC, named
every way, never in a zone guessed for the owner. A new reminder's pending
or settled result also gives the model its due and alert instants in UTC
and, when the phone reported a zone this turn, their wall times in that
zone, named, to repeat as they are.

```quint
pure def phoneZoneGrounded(sensitive: bool, observedZone: str, proposedZone: str): bool =
  not(sensitive) and observedZone != "" and observedZone == proposedZone
pure def localDueGrounded(phoneZoneKnown: bool, wallTimeExists: bool, wallTimeRepeats: bool): bool =
  phoneZoneKnown and wallTimeExists and not(wallTimeRepeats)
pure def reminderShownZone(repeatZone: str, phoneZone: str): str = if (repeatZone != "") repeatZone else if (phoneZone != "") phoneZone else "UTC"
pure val observedZoneValues = Set("", "Europe/Berlin", "America/New_York")
pure val proposedZoneValues = Set("", "Europe/Berlin", "UTC")
pure val repeatZoneValues = Set("", "Europe/Berlin")
pure val phoneZoneValues = Set("", "America/New_York")
pure def lawAClockSetNeverPicksItsOwnZone(sensitive: bool, observedZone: str, proposedZone: str): bool =
  phoneZoneGrounded(sensitive, observedZone, proposedZone) implies (proposedZone == observedZone and proposedZone != "")
pure def lawAShownTimeAlwaysNamesItsZone(repeatZone: str, phoneZone: str): bool = reminderShownZone(repeatZone, phoneZone) != ""
pure def lawAShownZoneIsNeverGuessed(repeatZone: str, phoneZone: str): bool =
  reminderShownZone(repeatZone, phoneZone) == repeatZone or reminderShownZone(repeatZone, phoneZone) == phoneZone or reminderShownZone(repeatZone, phoneZone) == "UTC"
```
