# Browser surface profiles and purge

An isolated browser surface keeps its website storage in a WebView
profile. A surface created without a profile key gets a fresh profile of
its own, which is cleared and deleted when the surface closes. A surface
created with a profile key (an account id, never an email) shares one
persistent profile with every surface of the same owner and key, so
website sign-ins survive across openings. `purgeProfiles` removes keyed
profiles: one key now (account sign-out), every keyed profile idle for at
least an hour that no surface uses, or every surface profile of any owner
("Sign out of websites").

This spec models isolated surfaces only; a surface on the host's shared
storage is the surface lifecycle's (`lifecycle.md`), as are the
`surfaceClosed` reports. The shell names each profile by a digest of its
owner and key (never the key), checks the key's characters
(`[A-Za-z0-9._:@-]{1,128}`), records each keyed profile's last use, deletes
a profile directory once Android releases it (retrying, and at the next
process start), and refuses an isolated surface on a WebView without
multi-profile support. Here a profile's `name` stands for one life of a
profile: a keyed profile opened again after a purge starts a new life
with a new name. Sources: `GI:plugins/plugin-native-browser-surface`
(`BrowserProfilePolicy.java`, `purgeProfiles` in
`BrowserSurfacePlugin.kt`, `definitions.ts`).

## Story: Keep two sites' storage apart unless I share a profile

> As the owner, I want each web surface to keep its own website storage
> unless I open it with the same profile key, so that one site never sees
> another's sign-in and my account's sign-ins survive the next opening.

### Two surfaces share a profile only when it is the keyed profile of their owner and key

Creating a surface with a key reuses the owner's live profile for that
key, marked as used now, or starts one; without a key it starts a fresh
profile. Closing a surface deletes a fresh profile and keeps a keyed one,
marked as used now.

```quint
type Profile = { name: int, owner: str, key: str, usedAt: int }
type Surface = { id: int, profile: int }
type PurgeRequest = NoPurge | ByKey({ owner: str, key: str }) | ByIdle({ idleMs: int, now: int }) | Everything
type PurgeAnswer = NoAnswer | Counted({ purged: int }) | Cleared({ purged: int, clean: bool })
type ProfilePurge = { profiles: List[Profile], surfaces: List[Surface], lastProfile: int, lastSurface: int,
  request: PurgeRequest, clearing: List[int], purged: int, cookieLeft: bool, answer: PurgeAnswer }
pure val initial: ProfilePurge = { profiles: List(), surfaces: List(), lastProfile: 0, lastSurface: 0,
  request: NoPurge, clearing: List(), purged: 0, cookieLeft: false, answer: NoAnswer }
pure def inUse(s: ProfilePurge, name: int): bool = s.surfaces.some(x => x.profile == name)
pure def keyOf(s: ProfilePurge, name: int): str = s.profiles.foldl("", (k, p) => if (p.name == name) p.key else k)
pure def canCreateSurface(s: ProfilePurge, owner: str): bool = owner != ""
pure def createSurface(s: ProfilePurge, owner: str, key: str, now: int): ProfilePurge = {
  val fresh = s.lastProfile + 1
  val shared = s.profiles.select(p => key != "" and p.owner == owner and p.key == key)
  val name = shared.foldl(fresh, (n, p) => p.name)
  val touched = s.profiles.listMap(p => if (p.name == name) { ...p, usedAt: now } else p)
  { ...s,
    profiles: if (name == fresh) touched.append({ name: fresh, owner: owner, key: key, usedAt: now }) else touched,
    lastProfile: if (name == fresh) fresh else s.lastProfile,
    surfaces: s.surfaces.append({ id: s.lastSurface + 1, profile: name }),
    lastSurface: s.lastSurface + 1 }
}
pure def canCloseSurface(s: ProfilePurge, id: int): bool = s.surfaces.some(x => x.id == id)
pure def closeSurface(s: ProfilePurge, id: int, now: int): ProfilePurge = {
  val name = s.surfaces.foldl(0, (n, x) => if (x.id == id) x.profile else n)
  { ...s,
    surfaces: s.surfaces.select(x => x.id != id),
    profiles: s.profiles.select(p => p.name != name or p.key != "").listMap(p => if (p.name == name) { ...p, usedAt: now } else p) }
}
pure def alwaysOnlyKeyedProfilesAreShared(s: ProfilePurge): bool =
  s.surfaces.every(a => s.surfaces.every(b => a.id == b.id or a.profile != b.profile or keyOf(s, a.profile) != ""))
pure def alwaysOneProfilePerOwnerAndKey(s: ProfilePurge): bool =
  s.profiles.every(p => s.profiles.every(q => p.name == q.name or p.key == "" or p.owner != q.owner or p.key != q.key))
pure val ownerValues = Set("o1", "o2")
pure val keyValues = Set("", "account1", "account2")
pure val nowValues = Set(0, 3600000, 7200000)
pure def sometimesTwoSurfacesShareAKey(s: ProfilePurge): bool =
  s.surfaces.some(a => s.surfaces.some(b => a.id != b.id and a.profile == b.profile))
pure def sometimesFreshProfileBesideKeyed(s: ProfilePurge): bool =
  s.surfaces.some(x => keyOf(s, x.profile) == "") and s.surfaces.some(x => keyOf(s, x.profile) != "")
```

### Every surface uses a live profile, and each profile name and surface id is issued once

Discovered by the proof: without these facts a fresh profile could take
the name of one a surface still uses, and closing one surface could close
another with the same id.

```quint
pure def alwaysIssuedOnce(s: ProfilePurge): bool =
  s.lastProfile >= 0 and s.lastSurface >= 0 and
  s.profiles.every(p => p.name >= 1 and p.name <= s.lastProfile and s.profiles.select(q => q.name == p.name).length() == 1) and
  s.surfaces.every(a => a.id >= 1 and a.id <= s.lastSurface and s.surfaces.select(b => b.id == a.id).length() == 1)
pure def alwaysSurfacesUseLiveProfiles(s: ProfilePurge): bool =
  s.surfaces.every(x => s.profiles.some(p => p.name == x.profile))
```

### Only a purge removes a keyed profile

```quint
pure def isPurge(via: str): bool = via == "purgeKey" or via == "purgeIdle" or via == "purgeEverything"
pure def stepOnlyPurgeRemovesKeyedProfiles(before: ProfilePurge, via: str, after: ProfilePurge): bool =
  isPurge(via) or before.profiles.every(p => p.key == "" or after.profiles.some(q => q.name == p.name))
```

## Story: Sign the device out of websites

> As the owner signing out of an account, or out of every website, I want
> exactly the profiles holding those sign-ins removed and their surfaces
> closed, so that nothing else is lost and I am told signed out only when
> no cookie is left.

### A purge removes exactly the profiles its selector names

A key purge removes the owner's keyed profile for that key and closes its
surfaces. An idle purge needs an idle age of at least one hour, and
removes every keyed profile of any owner that no surface uses and that
has not been used for that long. A purge of everything removes every
surface profile of any owner and closes every isolated surface. The
host runs one purge at a time: a purge waits until the previous one has
answered.

```quint
pure val minIdleMs = 3600000
pure def selected(req: PurgeRequest, s: ProfilePurge, p: Profile): bool = match req {
  | ByKey(r) => p.owner == r.owner and p.key == r.key
  | ByIdle(r) => p.key != "" and not(inUse(s, p.name)) and r.now - p.usedAt >= r.idleMs
  | Everything => true
  | NoPurge => false
}
pure def removing(req: PurgeRequest, s: ProfilePurge, gone: List[int]): ProfilePurge =
  { ...s, request: req, purged: gone.length(), cookieLeft: false,
    profiles: s.profiles.select(p => not(gone.includes(p.name))),
    surfaces: s.surfaces.select(x => not(gone.includes(x.profile))) }
pure def clearingFor(req: PurgeRequest, s: ProfilePurge, gone: List[int]): ProfilePurge =
  { ...removing(req, s, gone), clearing: gone, answer: if (gone.length() == 0) Cleared({ purged: 0, clean: true }) else NoAnswer }
pure def canPurgeKey(s: ProfilePurge, owner: str, key: str): bool = owner != "" and key != "" and s.clearing == List()
pure def purgeKey(s: ProfilePurge, owner: str, key: str): ProfilePurge =
  clearingFor(ByKey({ owner: owner, key: key }), s, s.profiles.select(p => p.key == key and p.owner == owner).listMap(p => p.name))
pure def canPurgeEverything(s: ProfilePurge): bool = s.clearing == List()
pure def purgeEverything(s: ProfilePurge): ProfilePurge =
  clearingFor(Everything, s, s.profiles.listMap(p => p.name))
pure def canPurgeIdle(s: ProfilePurge, idleMs: int): bool = idleMs >= minIdleMs and s.clearing == List()
pure def purgeIdle(s: ProfilePurge, idleMs: int, now: int): ProfilePurge = {
  val gone = s.profiles.select(p => p.key != "" and now - p.usedAt >= idleMs and not(inUse(s, p.name))).listMap(p => p.name)
  { ...removing(ByIdle({ idleMs: idleMs, now: now }), s, gone), answer: Counted({ purged: gone.length() }) }
}
pure val idleMsValues = Set(60000, 3600000)
pure def stepPurgeRemovesExactlySelected(before: ProfilePurge, via: str, after: ProfilePurge): bool =
  isPurge(via) implies (
    after.profiles.every(p => before.profiles.includes(p)) and
    before.profiles.every(p => after.profiles.includes(p) iff not(selected(after.request, before, p))))
pure def stepIdlePurgeNeedsAnHour(before: ProfilePurge, via: str, after: ProfilePurge): bool = {
  val req = after.request
  via == "purgeIdle" implies (match req { | ByIdle(r) => r.idleMs >= minIdleMs | _ => false })
}
pure def countedPurged(a: PurgeAnswer): int = match a { | Counted(c) => c.purged | _ => -1 }
pure def sometimesIdlePurgeRemoved(s: ProfilePurge): bool = countedPurged(s.answer) >= 1
pure def sometimesIdlePurgeSparedAProfileInUse(s: ProfilePurge): bool =
  countedPurged(s.answer) >= 0 and s.profiles.some(p => p.key != "" and inUse(s, p.name))
```

### A key or everything purge answers only after the purged cookies are removed, and says clean only when none remain

Each purged profile's cookie removal reports whether a cookie is still
left. The purge answers with its count once the last report arrives, and
`clean` is true only when no report found a cookie; the app may tell the
owner they are signed out only on `clean`. A purge that found nothing
answers at once, clean. An idle purge answers at once with its count and
never claims clean.

```quint
pure def canCookiesRemoved(s: ProfilePurge): bool = s.clearing != List()
pure def cookiesRemoved(s: ProfilePurge, left: bool): ProfilePurge = {
  val anyLeft = s.cookieLeft or left
  { ...s, clearing: s.clearing.removeAt(0), cookieLeft: anyLeft,
    answer: if (s.clearing.length() == 1) Cleared({ purged: s.purged, clean: not(anyLeft) }) else s.answer }
}
pure def answeredAfterClearing(s: ProfilePurge): bool =
  if (s.clearing == List()) s.answer == Cleared({ purged: s.purged, clean: not(s.cookieLeft) }) else s.answer == NoAnswer
pure def alwaysAnswerFollowsCookieRemoval(s: ProfilePurge): bool = {
  val req = s.request
  match req {
    | NoPurge => s.answer == NoAnswer and s.clearing == List()
    | ByIdle(r) => s.clearing == List() and s.answer == Counted({ purged: s.purged })
    | ByKey(r) => answeredAfterClearing(s)
    | Everything => answeredAfterClearing(s)
  }
}
pure def sometimesSignedOutClean(s: ProfilePurge): bool = s.answer == Cleared({ purged: s.purged, clean: true }) and s.purged >= 1
pure def sometimesCookieLeft(s: ProfilePurge): bool = s.answer == Cleared({ purged: s.purged, clean: false })
pure def sometimesAwaitingCookies(s: ProfilePurge): bool = s.clearing.length() >= 2
```
