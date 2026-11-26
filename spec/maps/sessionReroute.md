# Maps reroute of the session the owner started

Guidance runs from the owner's own Start on the Maps screen, for a route the
agent prepared ([Maps navigation](./navigation.md)) or one the owner planned
on the screen. The agent may ask the phone to plan that session again from
its current position; it never starts or replaces a session itself.

## Story: Reroute the navigation I started, whoever planned the route

> As the owner, I want the agent to replan the navigation I am following
> from where I am now, also when I planned the route myself on the phone.

### Only the owner's Start begins a session, and a reroute keeps its route until the same session's new route arrives

A session begins only from the owner's Start on the screen, for a route the
screen shows, and holds that route. The session counter is never negative, so
each started session has a positive identifier. The agent's reroute needs the session to
be guiding and a fresh precise fix by the planning rules of navigation; while
the replan is pending the session keeps its current route. Only the reply to
the latest reroute settles it, and the new route replaces the old one only
when it belongs to the same session. Ending the session retires any pending
reroute.

```quint
import navigation as N from "./navigation"
type SessionPhase = NoSession | SessionGuiding | SessionRerouting
type GuidedSession = { phase: SessionPhase, session: int, route: int, ticket: int, starts: int }
pure val initial: GuidedSession = { phase: NoSession, session: 0, route: 0, ticket: 0, starts: 0 }
pure def canOwnerStarts(s: GuidedSession, session: int, route: int): bool = s.phase == NoSession and session > s.session and route > 0
pure def ownerStarts(s: GuidedSession, session: int, route: int): GuidedSession =
  { ...s, phase: SessionGuiding, session: session, route: route, starts: s.starts + 1 }
pure def canStartSessionReroute(s: GuidedSession, fix: N::Fix): bool = s.phase == SessionGuiding and N::usableFix(fix)
pure def startSessionReroute(s: GuidedSession, fix: N::Fix): GuidedSession = { ...s, phase: SessionRerouting, ticket: s.ticket + 1 }
pure def canSessionRerouteSettles(s: GuidedSession, ticket: int): bool = s.phase == SessionRerouting and ticket == s.ticket
pure def sessionRerouteSettles(s: GuidedSession, ticket: int, route: int, sameSession: bool): GuidedSession =
  { ...s, phase: SessionGuiding, route: if (sameSession and route > 0) route else s.route }
pure def canSessionEnds(s: GuidedSession): bool = s.phase != NoSession
pure def sessionEnds(s: GuidedSession): GuidedSession = { ...s, phase: NoSession, route: 0, ticket: s.ticket + 1 }
pure val sessionValues = Set(1, 2, 3)
pure val routeValues = Set(0, 1, 2)
pure val ticketValues = Set(1, 2, 3, 4)
pure val weight_startSessionReroute = 4
pure val weight_sessionRerouteSettles = 4
pure def alwaysSessionHoldsItsRoute(s: GuidedSession): bool =
  s.session >= 0 and (s.phase != NoSession implies s.route > 0 and s.session > 0) and (s.phase == NoSession implies s.route == 0)
pure def stepOnlyOwnerStartBeginsSession(before: GuidedSession, via: str, after: GuidedSession): bool =
  (before.phase == NoSession and after.phase != NoSession) implies via == "ownerStarts"
pure def stepPendingRerouteKeepsRoute(before: GuidedSession, via: str, after: GuidedSession): bool =
  via == "startSessionReroute" implies after.route == before.route
pure def sometimesOwnerSessionRerouted(s: GuidedSession): bool = s.phase == SessionGuiding and s.ticket > 0 and s.starts == 1
```
