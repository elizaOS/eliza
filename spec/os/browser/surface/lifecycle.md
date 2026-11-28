# Browser surface lifecycle

The surface manager puts one native web page per browser tab beside the
app's WebView. This spec owns which surfaces exist, which renderer realm
may command them, where a page draws and takes input, closures, load state
and the keyboard; `commands.md`, `pageRequests.md`, `profiles.md` and
`dock.md` build on it. The shell parses every call, runs it on the main
thread and converts host CSS pixels. Sources: `BrowserSurfacePlugin.kt`,
`BelowHostLayer.kt`, `definitions.ts` of `plugin-native-browser-surface`.

## Story: Keep each web surface owned by the current screen

> As the app's renderer, I want a reload to take over my own surfaces
> cleanly, so that a stale realm's commands never act on a website.

### A command applies only with the owner's current session and epoch, and reconciling an owner destroys every surface it does not list

Each owner holds one lease: the session token and epoch of its live realm.
`reconcileOwner` takes the lease with a newer epoch, or the same epoch and
session again, hides every surface of the owner and destroys each one of
another realm or not in `desiredIds`; another session at the same epoch, or
an older epoch, is refused. Every other command names the lease's session
and epoch and a surface of that realm. A replaced realm can never command
again, because a lease only moves to a newer epoch.

```quint
import address.* from "../address"
type Realm = { owner: str, session: str, epoch: int }
type ProcessPolicy = IsolatedProcess | SharedProcess
type SurfaceStorage = HostStorage | FreshProfile | KeyedProfile({ key: str })
type SurfaceLayer = AboveHost | BelowHost
type SurfacePolicy = { process: ProcessPolicy, storage: SurfaceStorage, layer: SurfaceLayer, answersRequests: bool, interceptsNavigation: bool }
type HostRect = { x: int, y: int, width: int, height: int }
type OuterClip = { x: int, y: int, width: int, height: int, topLeft: int, topRight: int, bottomRight: int, bottomLeft: int }
type HostChrome = { x: int, y: int, width: int, height: int, cornerRadius: int }
type PageResult = PageLoading | PageLoaded | PageFailed | PageBlocked
type Page = { href: str, result: PageResult }
type NativeSurface = { id: str, realm: Realm, gen: int, policy: SurfacePolicy, presented: bool, paused: bool,
  hostRectsSet: bool, bounds: HostRect, clip: OuterClip, hostRects: List[HostChrome], page: Page }
type DeviceSupport = SupportUnknown | Supports({ isolatedRenderer: bool, multiProfile: bool })
type Keyboard = { visible: bool, height: int }
type SurfaceHost = { support: DeviceSupport, leases: List[Realm], surfaces: List[NativeSurface], issued: int, keyboard: Keyboard }
pure val initial: SurfaceHost = { support: SupportUnknown, leases: List(), surfaces: List(), issued: 0, keyboard: { visible: false, height: 0 } }
pure def admits(s: SurfaceHost, realm: Realm): bool = s.leases.includes(realm)
pure def owns(s: SurfaceHost, realm: Realm, id: str): bool = admits(s, realm) and s.surfaces.some(x => x.id == id and x.realm == realm)
pure def hasSurface(s: SurfaceHost, id: str): bool = s.surfaces.some(x => x.id == id)
pure def canReconcileOwner(s: SurfaceHost, realm: Realm, desiredIds: Set[str]): bool =
  realm.owner != "" and realm.session != "" and realm.epoch > 0 and
    s.leases.every(c => c.owner != realm.owner or realm.epoch > c.epoch or (realm.epoch == c.epoch and realm.session == c.session))
pure def reconcileOwner(s: SurfaceHost, realm: Realm, desiredIds: Set[str]): SurfaceHost =
  { ...s, leases: s.leases.select(c => c.owner != realm.owner).append(realm),
    surfaces: s.surfaces.select(x => x.realm.owner != realm.owner or (x.realm == realm and desiredIds.contains(x.id)))
      .listMap(x => if (x.realm.owner == realm.owner) { ...x, presented: false } else x) }
pure def canDestroySurface(s: SurfaceHost, realm: Realm, id: str): bool = owns(s, realm, id)
pure def destroySurface(s: SurfaceHost, realm: Realm, id: str): SurfaceHost = { ...s, surfaces: s.surfaces.select(x => x.id != id) }
pure def alwaysOneLeasePerOwner(s: SurfaceHost): bool =
  s.leases.every(a => a.owner != "" and a.epoch > 0 and s.leases.every(b => a.owner != b.owner or a == b))
pure def alwaysSurfacesBelongToTheirOwnersLease(s: SurfaceHost): bool = s.surfaces.every(x => admits(s, x.realm))
pure def stepLeaseMovesOnlyToANewerEpoch(before: SurfaceHost, after: SurfaceHost): bool =
  before.leases.every(a => after.leases.some(b => b == a or (b.owner == a.owner and b.epoch > a.epoch)))
pure val appRealm: Realm = { owner: "app", session: "s1", epoch: 1 }
pure val realmValues: Set[Realm] = List(appRealm, { ...appRealm, session: "s2" }, { ...appRealm, session: "s2", epoch: 2 },
  { owner: "dock", session: "s1", epoch: 1 }).foldl(Set(), (acc, r) => acc.union(Set(r)))
pure val idValues = Set("", "t1", "t2")
pure val desiredIdsValues = Set(Set(), Set("t1"), Set("t1", "t2"))
pure def sometimesReloadedRealmOwnsASurface(s: SurfaceHost): bool = s.surfaces.some(x => x.realm.epoch >= 2)
pure def sometimesTwoOwnersShowPages(s: SurfaceHost): bool = s.surfaces.some(a => s.surfaces.some(b => a.presented and b.presented and a.realm.owner != b.realm.owner))
```

### A surface is created with an explicit process and storage policy the device honours, and each id and generation names one surface

The device's support is read once when the plugin loads. An isolated
process needs a renderer outside the app's process, and any storage of its
own needs WebView profiles: the surface is refused, never quietly shared.
A keyed profile is shared only by the same owner and key (`profiles.md`),
a fresh one by no one. The layer and flags are fixed for the surface's life.

```quint
pure def canLearnSupport(s: SurfaceHost): bool = s.support == SupportUnknown
pure def learnSupport(s: SurfaceHost, isolatedRenderer: bool, multiProfile: bool): SurfaceHost =
  { ...s, support: Supports({ isolatedRenderer: isolatedRenderer, multiProfile: multiProfile }) }
pure def honoured(support: DeviceSupport, policy: SurfacePolicy): bool = match support {
  | SupportUnknown => false
  | Supports(d) => (policy.process == IsolatedProcess implies d.isolatedRenderer) and (policy.storage != HostStorage implies d.multiProfile)
}
pure def validStorage(policy: SurfacePolicy): bool = policy.storage != KeyedProfile({ key: "" })
pure def canCreateSurface(s: SurfaceHost, realm: Realm, id: str, policy: SurfacePolicy, url: str): bool =
  admits(s, realm) and id != "" and not(hasSurface(s, id)) and honoured(s.support, policy) and validStorage(policy)
pure def createSurface(s: SurfaceHost, realm: Realm, id: str, policy: SurfacePolicy, url: str): SurfaceHost =
  { ...s, issued: s.issued + 1, surfaces: s.surfaces.append({ id: id, realm: realm, gen: s.issued + 1, policy: policy,
    presented: false, paused: false, hostRectsSet: false, bounds: { x: 0, y: 0, width: 0, height: 0 },
    clip: { x: 0, y: 0, width: 0, height: 0, topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
    hostRects: List(), page: { href: url, result: PageLoading } }) }
pure def alwaysIsolationIsHonoured(s: SurfaceHost): bool = s.surfaces.every(x => honoured(s.support, x.policy) and validStorage(x.policy))
pure def alwaysIssuedOnce(s: SurfaceHost): bool =
  s.issued >= 0 and s.surfaces.every(a => a.gen >= 1 and a.gen <= s.issued and s.surfaces.every(b => (a.id == b.id or a.gen == b.gen) implies a == b))
pure val keyedPolicy: SurfacePolicy = { process: IsolatedProcess, storage: KeyedProfile({ key: "account1" }), layer: BelowHost, answersRequests: true, interceptsNavigation: false }
pure val policyValues: Set[SurfacePolicy] = List(keyedPolicy, { ...keyedPolicy, storage: FreshProfile, layer: AboveHost },
  { ...keyedPolicy, process: SharedProcess, storage: HostStorage, answersRequests: false, interceptsNavigation: true },
  { ...keyedPolicy, storage: KeyedProfile({ key: "" }) }).foldl(Set(), (acc, p) => acc.union(Set(p)))
pure val urlValues = Set("", "https://example.test/")
pure def sometimesIsolatedKeyedSurface(s: SurfaceHost): bool = s.surfaces.some(x => x.policy == keyedPolicy)
pure def sometimesHostStorageWithoutProfiles(s: SurfaceHost): bool =
  s.support == Supports({ isolatedRenderer: true, multiProfile: false }) and s.surfaces.some(x => x.policy.storage == HostStorage)
```

## Story: Let the page take input only where and when I can see it

> As the person, I want taps to reach a website only when its page is
> shown, running and not under the app's own controls.

### Presenting one surface hides its owner's other surfaces and never resumes a paused page

`presentSurface` hides every surface of the owner and shows the named one,
or none to show the app. `pauseSurface` treats the page as hidden, takes
focus and the keyboard from it and keeps its touches from it until
`resumeSurface`; presenting does not resume it.

```quint
pure def canPresentSurface(s: SurfaceHost, realm: Realm, id: str): bool = admits(s, realm) and (id == "" or owns(s, realm, id))
pure def presentSurface(s: SurfaceHost, realm: Realm, id: str): SurfaceHost =
  { ...s, surfaces: s.surfaces.listMap(x => if (x.realm.owner == realm.owner) { ...x, presented: x.id == id } else x) }
pure def canPauseSurface(s: SurfaceHost, realm: Realm, id: str): bool = owns(s, realm, id)
pure def pauseSurface(s: SurfaceHost, realm: Realm, id: str): SurfaceHost = { ...s, surfaces: s.surfaces.listMap(x => if (x.id == id) { ...x, paused: true } else x) }
pure def canResumeSurface(s: SurfaceHost, realm: Realm, id: str): bool = owns(s, realm, id)
pure def resumeSurface(s: SurfaceHost, realm: Realm, id: str): SurfaceHost = { ...s, surfaces: s.surfaces.listMap(x => if (x.id == id) { ...x, paused: false } else x) }
pure def alwaysOnePresentedPerOwner(s: SurfaceHost): bool =
  s.surfaces.every(a => s.surfaces.every(b => a.id == b.id or a.realm.owner != b.realm.owner or not(a.presented and b.presented)))
pure def stepPresentingNeverResumes(before: SurfaceHost, via: str, after: SurfaceHost): bool =
  via == "presentSurface" implies after.surfaces.every(x => before.surfaces.some(y => y.gen == x.gen and y.paused == x.paused))
pure def sometimesPresentedButPaused(s: SurfaceHost): bool = s.surfaces.some(x => x.presented and x.paused)
```

### A page draws only inside its outer clip and takes input only where it draws, while shown, running and told the host's rects, and never on a rounded host rect

`setBounds` places the page and its outer clip, with four corner radii,
together in host pixels. An above-host page is clipped to the rounded clip
with every host rect cut out. A below-host page is drawn under the app's
WebView, clipped to the clip's rectangle: the app must be transparent over
it and paints the corners and its own controls. `setOcclusionRects` names
the host's rects, each with a corner radius; the page takes no input until
the first call after it was created, and the app awaits the call before it
shows new controls over the page. A gesture that starts on the page goes to
it for the whole gesture.

```quint
type HostPoint = { x: int, y: int }
pure def canSetBounds(s: SurfaceHost, realm: Realm, id: str, bounds: HostRect, clip: OuterClip): bool =
  owns(s, realm, id) and bounds.width >= 0 and bounds.height >= 0 and clip.width >= 0 and clip.height >= 0 and
    clip.topLeft >= 0 and clip.topRight >= 0 and clip.bottomRight >= 0 and clip.bottomLeft >= 0
pure def setBounds(s: SurfaceHost, realm: Realm, id: str, bounds: HostRect, clip: OuterClip): SurfaceHost =
  { ...s, surfaces: s.surfaces.listMap(x => if (x.id == id) { ...x, bounds: bounds, clip: clip } else x) }
pure def canSetOcclusionRects(s: SurfaceHost, realm: Realm, id: str, rects: List[HostChrome]): bool =
  owns(s, realm, id) and rects.every(r => r.width >= 0 and r.height >= 0 and r.cornerRadius >= 0)
pure def setOcclusionRects(s: SurfaceHost, realm: Realm, id: str, rects: List[HostChrome]): SurfaceHost =
  { ...s, surfaces: s.surfaces.listMap(x => if (x.id == id) { ...x, hostRects: rects, hostRectsSet: true } else x) }
pure def inBox(x: int, y: int, width: int, height: int, p: HostPoint): bool = p.x >= x and p.y >= y and p.x < x + width and p.y < y + height
pure def onArc(p: HostPoint, cx: int, cy: int, r: int): bool = (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy) <= r * r
pure def inRoundedBox(x: int, y: int, width: int, height: int, tl: int, tr: int, br: int, bl: int, p: HostPoint): bool =
  inBox(x, y, width, height, p) and
  (not(p.x < x + tl and p.y < y + tl) or onArc(p, x + tl, y + tl, tl)) and
  (not(p.x >= x + width - tr and p.y < y + tr) or onArc(p, x + width - tr, y + tr, tr)) and
  (not(p.x >= x + width - br and p.y >= y + height - br) or onArc(p, x + width - br, y + height - br, br)) and
  (not(p.x < x + bl and p.y >= y + height - bl) or onArc(p, x + bl, y + height - bl, bl))
pure def inClip(c: OuterClip, p: HostPoint): bool = inRoundedBox(c.x, c.y, c.width, c.height, c.topLeft, c.topRight, c.bottomRight, c.bottomLeft, p)
pure def onChrome(x: NativeSurface, p: HostPoint): bool =
  x.hostRects.some(r => inRoundedBox(r.x, r.y, r.width, r.height, r.cornerRadius, r.cornerRadius, r.cornerRadius, r.cornerRadius, p))
pure def takesInput(x: NativeSurface): bool = x.presented and not(x.paused) and x.hostRectsSet
pure def pageOwnsPoint(x: NativeSurface, p: HostPoint): bool =
  takesInput(x) and inBox(x.bounds.x, x.bounds.y, x.bounds.width, x.bounds.height, p) and inClip(x.clip, p) and not(onChrome(x, p))
pure def drawsAt(x: NativeSurface, p: HostPoint): bool =
  x.presented and inBox(x.bounds.x, x.bounds.y, x.bounds.width, x.bounds.height, p) and inBox(x.clip.x, x.clip.y, x.clip.width, x.clip.height, p) and
    (x.policy.layer == BelowHost or (inClip(x.clip, p) and not(onChrome(x, p))))
pure def lawInputOnlyWhereThePageDrawsInsideItsClip(surface: NativeSurface, point: HostPoint): bool =
  (pageOwnsPoint(surface, point) implies drawsAt(surface, point)) and
  ((surface.clip.topLeft > 0 and point == { x: surface.clip.x, y: surface.clip.y }) implies not(pageOwnsPoint(surface, point)))
pure val shownSurface: NativeSurface = { id: "t1", realm: appRealm, gen: 1, policy: keyedPolicy, presented: true, paused: false, hostRectsSet: true,
  bounds: { x: 0, y: 0, width: 100, height: 100 }, clip: { x: 0, y: 0, width: 100, height: 100, topLeft: 16, topRight: 16, bottomRight: 0, bottomLeft: 0 },
  hostRects: List({ x: 0, y: 80, width: 100, height: 20, cornerRadius: 8 }), page: { href: "https://example.test/", result: PageLoaded } }
pure val surfaceValues: Set[NativeSurface] = List(shownSurface, { ...shownSurface, paused: true }, { ...shownSurface, hostRectsSet: false },
  { ...shownSurface, policy: { ...keyedPolicy, layer: AboveHost } }).foldl(Set(), (acc, x) => acc.union(Set(x)))
pure val pointValues: Set[HostPoint] = List({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 50, y: 50 }, { x: 50, y: 90 }, { x: 120, y: 50 }).foldl(Set(), (acc, p) => acc.union(Set(p)))
pure val boundsValues: Set[HostRect] = List({ x: 0, y: 0, width: 360, height: 640 }, { x: 0, y: 0, width: -1, height: 640 }).foldl(Set(), (acc, b) => acc.union(Set(b)))
pure val clipValues: Set[OuterClip] = List(shownSurface.clip, { ...shownSurface.clip, width: 360, height: 640 }).foldl(Set(), (acc, c) => acc.union(Set(c)))
pure val rectsValues: Set[List[HostChrome]] = Set(List(), shownSurface.hostRects)
pure def sometimesPageTakesInput(s: SurfaceHost): bool = s.surfaces.some(x => takesInput(x))
pure def sometimesShownPageAwaitsHostRects(s: SurfaceHost): bool = s.surfaces.some(x => x.presented and not(x.paused) and not(x.hostRectsSet))
```

## Story: Hear once when a page closed by itself, and what it shows

> As the app's renderer, I want to hear exactly once that a surface closed
> by itself, and to see each page's load state as it was when sent, so I
> can recreate the page or show that it is gone or blocked.

### A surface that crashed or lost its profile is closed before it is reported, once, to its owner's live realm

When a page's renderer crashes or Android reclaims it, the surface is
already closed and its id free when `surfaceCrashed` is sent; the app keeps
running, and a later callback for that page reports nothing. A purge of a
keyed profile, or of every profile, closes each surface on it and reports
`surfaceClosed` with reason `profile-purged`. Destroying or reconciling,
which the renderer asked for, reports nothing.

```quint
type SurfaceEvent = { id: str, realm: Realm }
type NavigationReport = { id: str, realm: Realm, href: str, result: PageResult, presented: bool, paused: bool }
type SurfaceNotice = SurfaceCrashed(SurfaceEvent) | SurfaceClosed(SurfaceEvent) | NavigationChanged(NavigationReport) | KeyboardChanged(Keyboard)
type SurfaceChange = { state: SurfaceHost, out: List[SurfaceNotice] }
pure def rendererGone(s: SurfaceHost, id: str): SurfaceChange =
  { state: { ...s, surfaces: s.surfaces.select(x => x.id != id) },
    out: s.surfaces.select(x => x.id == id).listMap(x => SurfaceCrashed({ id: x.id, realm: x.realm })) }
pure def closeOnPurge(gone: List[NativeSurface], s: SurfaceHost): SurfaceChange =
  { state: { ...s, surfaces: s.surfaces.select(x => not(gone.includes(x))) }, out: gone.listMap(x => SurfaceClosed({ id: x.id, realm: x.realm })) }
pure def keyedProfilePurged(s: SurfaceHost, owner: str, key: str): SurfaceChange =
  closeOnPurge(s.surfaces.select(x => x.realm.owner == owner and x.policy.storage == KeyedProfile({ key: key })), s)
pure def allProfilesPurged(s: SurfaceHost): SurfaceChange = closeOnPurge(s.surfaces.select(x => x.policy.storage != HostStorage), s)
pure def closedAndLive(before: SurfaceHost, after: SurfaceHost, ev: SurfaceEvent): bool =
  admits(before, ev.realm) and before.surfaces.some(x => x.id == ev.id and x.realm == ev.realm) and not(hasSurface(after, ev.id))
pure def closureReported(n: SurfaceNotice, before: SurfaceHost, after: SurfaceHost): bool = match n {
  | SurfaceCrashed(ev) => closedAndLive(before, after, { id: ev.id, realm: ev.realm })
  | SurfaceClosed(ev) => closedAndLive(before, after, { id: ev.id, realm: ev.realm })
  | _ => true
}
pure def stepClosedSurfaceIsReportedOnceAfterItCloses(before: SurfaceHost, via: str, after: SurfaceHost, out: List[SurfaceNotice]): bool =
  out.every(n => closureReported(n, before, after)) and
    ((via == "rendererGone" or via == "keyedProfilePurged" or via == "allProfilesPurged") implies out.length() == before.surfaces.length() - after.surfaces.length())
pure val ownerValues = Set("app", "dock")
pure val keyValues = Set("account1", "account2")
```

### Navigation reports the page's current load state and a refused certificate blocks that load

A certificate error is never passed. One on the main-frame request, an
HTTPS address, makes the page a security block at that address, reported
at once; one on a subresource only fails that resource (shell). A
main-frame load error makes the page failed; a finished load reports the
page. A new page start at another address ends the block; the error page
of the blocked address, which starts at that address, keeps it. The
native shell also clears its security block on an explicit navigate or
reload from the renderer, before it asks WebView to load again.

```quint
pure def reported(s: SurfaceHost, id: str): List[SurfaceNotice] = s.surfaces.select(x => x.id == id).listMap(x =>
  NavigationChanged({ id: x.id, realm: x.realm, href: x.page.href, result: x.page.result, presented: x.presented, paused: x.paused }))
pure def canPageStarted(s: SurfaceHost, id: str, href: str): bool = hasSurface(s, id)
pure def pageStarted(s: SurfaceHost, id: str, href: str): SurfaceHost = { ...s, surfaces: s.surfaces.listMap(x => if (x.id != id) x
  else { ...x, page: { href: href, result: if (x.page.result == PageBlocked and x.page.href == href) PageBlocked else PageLoading } }) }
pure def canMainFrameFailed(s: SurfaceHost, id: str): bool = s.surfaces.some(x => x.id == id and x.page.result == PageLoading)
pure def mainFrameFailed(s: SurfaceHost, id: str): SurfaceHost =
  { ...s, surfaces: s.surfaces.listMap(x => if (x.id == id) { ...x, page: { ...x.page, result: PageFailed } } else x) }
pure def canCertificateRefused(s: SurfaceHost, id: str, address: WebAddress): bool = isSecureWebAddress(address) and hasSurface(s, id)
pure def certificateRefused(s: SurfaceHost, id: str, address: WebAddress): SurfaceChange = {
  val changed = { ...s, surfaces: s.surfaces.listMap(x => if (x.id == id) { ...x, page: { href: address.href, result: PageBlocked } } else x) }
  { state: changed, out: reported(changed, id) }
}
pure def canPageFinished(s: SurfaceHost, id: str): bool = hasSurface(s, id)
pure def pageFinished(s: SurfaceHost, id: str): SurfaceChange = {
  val changed = { ...s, surfaces: s.surfaces.listMap(x => if (x.id == id and x.page.result == PageLoading) { ...x, page: { ...x.page, result: PageLoaded } } else x) }
  { state: changed, out: reported(changed, id) }
}
pure def sentAsIs(n: SurfaceNotice, after: SurfaceHost): bool = match n {
  | NavigationChanged(r) => after.surfaces.some(x => admits(after, x.realm) and x.id == r.id and x.realm == r.realm and
    x.page == { href: r.href, result: r.result } and x.presented == r.presented and x.paused == r.paused)
  | _ => true
}
pure def stepNavigationReportsTheStateAsSent(before: SurfaceHost, via: str, after: SurfaceHost, out: List[SurfaceNotice]): bool = out.every(n => sentAsIs(n, after))
pure def stepSecurityBlockEndsOnlyAtANewAddress(before: SurfaceHost, via: str, after: SurfaceHost): bool =
  before.surfaces.every(x => x.page.result != PageBlocked or after.surfaces.every(y => y.gen != x.gen or y.page.result == PageBlocked or
    (via == "pageStarted" and y.page.href != x.page.href)))
pure val hrefValues = Set("https://example.test/", "https://other.test/")
pure def sometimesSecurityBlocked(s: SurfaceHost): bool = s.surfaces.some(x => x.page.result == PageBlocked)
pure def sometimesPageLoaded(s: SurfaceHost): bool = s.surfaces.some(x => x.page.result == PageLoaded and x.presented)
pure def sometimesPageFailed(s: SurfaceHost): bool = s.surfaces.some(x => x.page.result == PageFailed)
```

## Story: Make room for the keyboard

> As the person, I want the app to move its controls above the on-screen
> keyboard, so that what I type is never hidden.

### Each time the keyboard opens or closes it is reported once, with its height in host pixels

The shell reads the keyboard's inset and divides it by the screen density.
A change of height while the keyboard stays open sends nothing.

```quint
pure def canImeChanged(s: SurfaceHost, visible: bool, height: int): bool = height >= 0
pure def imeChanged(s: SurfaceHost, visible: bool, height: int): SurfaceChange = {
  val shown = if (visible) height else 0
  if (visible == s.keyboard.visible) { state: s, out: List() }
  else { state: { ...s, keyboard: { visible: visible, height: shown } }, out: List(KeyboardChanged({ visible: visible, height: shown })) }
}
pure def alwaysHiddenKeyboardHasNoHeight(s: SurfaceHost): bool = s.keyboard.height >= 0 and (not(s.keyboard.visible) implies s.keyboard.height == 0)
pure def keyboardNotices(out: List[SurfaceNotice]): List[SurfaceNotice] = out.select(n => match n { | KeyboardChanged(k) => true | _ => false })
pure def stepKeyboardReportedOncePerChange(before: SurfaceHost, via: str, after: SurfaceHost, out: List[SurfaceNotice]): bool =
  keyboardNotices(out) == (if (after.keyboard == before.keyboard) List() else List(KeyboardChanged({ visible: after.keyboard.visible, height: after.keyboard.height })))
pure val heightValues = Set(0, 280)
pure def sometimesKeyboardShown(s: SurfaceHost): bool = s.keyboard.visible and s.keyboard.height > 0
```
