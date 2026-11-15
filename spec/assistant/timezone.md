# Owner time zone

Reminders, check-ins, goals and the daily dossier fire at the owner's
local time. The owner states their zone in conversation ("my timezone is
America/New_York"), and the assistant stores it as an owner fact that the
calendar and the scheduler read. When a scheduler tick runs, its
preflight and its runner resolve the owner's clock with the one definition
below, from the facts as they stand at that tick, so they never disagree.

A statement is modeled as the zone the shared zone resolver maps it to:
an IANA zone, the zone an alias such as "pacific" names, or nothing when
the statement names no zone the resolver knows.

## Story: Run my day on my own clock

> As an owner, I want my reminders and check-ins to follow the time zone I
> told the agent, and the zone I am travelling in while I travel, and
> never a zone guessed from something I said that was not a zone.

### A stated zone replaces the stored zone only when the resolver knows it

A statement that names no known zone leaves the stored zone as it was.

```quint
type OwnerTimezone = { storedZone: str }
pure val initial: OwnerTimezone = { storedZone: "" }
pure val knownZones = Set("Europe/Berlin", "America/New_York", "America/Los_Angeles")
pure val namedZoneValues = Set("", "America/New_York", "America/Los_Angeles", "whatever the laptop says")
pure def stateTimezone(s: OwnerTimezone, namedZone: str): OwnerTimezone =
  if (knownZones.contains(namedZone)) { storedZone: namedZone } else s
pure def alwaysStoredZoneIsKnown(s: OwnerTimezone): bool = s.storedZone == "" or knownZones.contains(s.storedZone)
pure val storedZoneValues = Set("", "Europe/Berlin")
pure def lawUnknownStatementKeepsTheStoredZone(storedZone: str, namedZone: str): bool =
  not(knownZones.contains(namedZone)) implies stateTimezone({ storedZone: storedZone }, namedZone).storedZone == storedZone
pure def lawKnownStatementReplacesTheStoredZone(storedZone: str, namedZone: str): bool =
  knownZones.contains(namedZone) implies stateTimezone({ storedZone: storedZone }, namedZone).storedZone == namedZone
pure def sometimesZoneStated(s: OwnerTimezone): bool = s.storedZone == "America/Los_Angeles"
```

### The calendar reads the stored zone, or the agent's zone when none is stored

```quint
pure def calendarZone(s: OwnerTimezone, agentZone: str): str = if (s.storedZone != "") s.storedZone else agentZone
pure def lawCalendarFollowsTheStatedZone(namedZone: str, agentZone: str): bool =
  calendarZone(stateTimezone(initial, namedZone), agentZone) == (if (knownZones.contains(namedZone)) namedZone else agentZone)
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
