# Device source lock

The os package pins each device profile's platform source in
`aosp/aosp.lock.json`: the manifest revision, every project revision, every
recorded local change and ignored input, and for a physical device the
generated vendor files, the stock factory archive and the vendor API level
its kept vendor partition declares. The operator syncs and patches the
checkout out of band. Eliza only reads the checkout and the archive and
returns a verdict; it never repairs, rewrites or syncs them. Product
composition (`image/product.md`) and listener staging (`image/listener.md`)
build only on a matched verdict.

The shell (`src/image/source-lock.vibe`) reads the facts with `git` and
`repo` read-only and hashes files; this spec decides what they mean.

## Story: Build only from the source I pinned

> As a product maker, I want my image built only from the platform source,
> factory archive and reviewed patches the os package pinned for my device,
> so that a drifted checkout, an unreviewed change or a mismatched vendor
> never reaches a build.

### A verdict is Match only when the checkout shows no problem against its lock

The shell reports the manifest revision (a dirty manifest checkout or an
unlisted local manifest reads as a different one), the revision of each locked project
in lock order, every changed file and every ignored input of those projects,
and the generated vendor inventory, each file with its digest, sorted. Every
project revision must equal its lock entry, every changed file must be a
recorded override or the postimage of an admitted patch, every override must
be present with its bytes, and the ignored and generated inventories must
equal the lock's. The verdict is Mismatch exactly when a problem remains,
and the shell reports every problem `problemsOf` lists, not only the first.

```quint
type DeviceSource = PhysicalDevice({ archive: str, vendorApiLevel: int }) | VirtualDevice
type Project = { path: str, revision: str }
type SourceFile = { project: str, path: str, digest: str }
type PatchFile = { path: str, pre: str, post: str }
type PatchEnvelope = { name: str, project: str, revision: str, baseline: str, files: List[PatchFile], manifestSha256: str }
type SourceLock = { name: str, digest: str, device: DeviceSource, developmentOnly: bool, manifest: str, projects: List[Project], overrides: List[SourceFile], ignored: List[SourceFile], generated: List[SourceFile], targets: List[str] }
type SourceFacts = { manifest: str, projects: List[Project], changes: List[SourceFile], ignored: List[SourceFile], generated: List[SourceFile], heads: List[SourceFile], archive: str, boardApi: int, vintfApi: int }
type Problem = ManifestDiffers | RevisionDiffers | SourceChangeDiffers | GeneratedDiffers | ArchiveDiffers | BoardApiDiffers | VintfApiDiffers | PatchRefused
type Verdict = Unverified | Match | Mismatch
type BuildPurpose = Development | Production
type ProductName = { brand: str, target: str }
type Admission = { brand: str, product: ProductName, purpose: BuildPurpose }
type SourceVerdict = { checkout: int, verified: int, verdict: Verdict, lock: SourceLock, read: SourceFacts, patches: List[PatchEnvelope], admitted: List[Admission] }

pure val noLock: SourceLock = { name: "", digest: "", device: VirtualDevice, developmentOnly: true, manifest: "", projects: List(), overrides: List(), ignored: List(), generated: List(), targets: List() }
pure val noFacts: SourceFacts = { manifest: "", projects: List(), changes: List(), ignored: List(), generated: List(), heads: List(), archive: "", boardApi: 0, vintfApi: 0 }
pure val initial: SourceVerdict = { checkout: 1, verified: 0, verdict: Unverified, lock: noLock, read: noFacts, patches: List(), admitted: List() }

pure def problemIf(found: bool, p: Problem): List[Problem] = if (found) List(p) else List()
pure def expectedChange(lock: SourceLock, patches: List[PatchEnvelope], c: SourceFile): bool =
  lock.overrides.includes(c) or patches.some(e => e.project == c.project and e.files.some(f => f.path == c.path and f.post == c.digest))
pure def changesMatch(lock: SourceLock, facts: SourceFacts, patches: List[PatchEnvelope]): bool =
  facts.changes.every(c => expectedChange(lock, patches, c)) and lock.overrides.every(o => facts.changes.includes(o)) and facts.ignored == lock.ignored
pure def problemsOf(lock: SourceLock, facts: SourceFacts, patches: List[PatchEnvelope]): List[Problem] =
  problemIf(facts.manifest != lock.manifest, ManifestDiffers)
    .concat(problemIf(facts.projects != lock.projects, RevisionDiffers))
    .concat(problemIf(not(changesMatch(lock, facts, patches)), SourceChangeDiffers))
    .concat(problemIf(facts.generated != lock.generated, GeneratedDiffers))
    .concat(stockVendorProblems(lock.device, facts))
    .concat(problemIf(not(patchesAdmitted(lock, facts, patches)), PatchRefused))
pure def lockWellFormed(lock: SourceLock): bool = {
  val device = lock.device
  lock.digest != "" and lock.manifest != "" and lock.projects.length() > 0 and lock.targets.length() > 0 and
  match device { | PhysicalDevice(d) => d.archive != "" and d.vendorApiLevel >= 100000 and d.vendorApiLevel <= 999999 and lock.generated.length() > 0 | VirtualDevice => true }
}

pure def canVerify(s: SourceVerdict, lock: SourceLock): bool = lockWellFormed(lock)
pure def verify(s: SourceVerdict, lock: SourceLock, facts: SourceFacts, patches: List[PatchEnvelope]): SourceVerdict =
  { ...s, verified: s.checkout, verdict: if (problemsOf(lock, facts, patches) == List()) Match else Mismatch, lock: lock, read: facts, patches: patches, admitted: List() }

pure def alwaysMatchExactlyWithoutProblems(s: SourceVerdict): bool =
  s.verdict != Unverified implies (s.verdict == Match iff problemsOf(s.lock, s.read, s.patches) == List())

pure val lockValues = {
  val physical: SourceLock = { name: "pixel10a", digest: "lockA", device: PhysicalDevice({ archive: "z1", vendorApiLevel: 202604 }), developmentOnly: false, manifest: "m1",
    projects: List({ path: "frameworks/base", revision: "r1" }), overrides: List({ project: "frameworks/base", path: "o.mk", digest: "d1" }), ignored: List(),
    generated: List({ project: "vendor/google_devices", path: "manifest.xml", digest: "g1" }), targets: List("stallion") }
  Set(physical).union(Set({ ...physical, digest: "lockD", developmentOnly: true }))
    .union(Set({ ...noLock, name: "cuttlefish", digest: "lockV", developmentOnly: false, manifest: "m1", projects: List({ path: "device/google/cuttlefish", revision: "r1" }), targets: List("cf_x86_64_phone") }))
}
pure val factsValues = {
  val physical: SourceFacts = { manifest: "m1", projects: List({ path: "frameworks/base", revision: "r1" }), changes: List({ project: "frameworks/base", path: "o.mk", digest: "d1" }), ignored: List(),
    generated: List({ project: "vendor/google_devices", path: "manifest.xml", digest: "g1" }), heads: List(), archive: "z1", boardApi: 202604, vintfApi: 202604 }
  Set(physical).union(Set({ ...physical, projects: List({ path: "frameworks/base", revision: "r9" }) })).union(Set({ ...physical, boardApi: 202504 }))
    .union(Set({ ...physical, changes: physical.changes.append({ project: "frameworks/base", path: "Ui.java", digest: "post1" }), heads: List({ project: "frameworks/base", path: "Ui.java", digest: "pre1" }) }))
    .union(Set({ ...noFacts, manifest: "m1", projects: List({ path: "device/google/cuttlefish", revision: "r1" }) }))
}
pure val patchesValues = {
  val reviewed: PatchEnvelope = { name: "chip", project: "frameworks/base", revision: "r1", baseline: "lockA", files: List({ path: "Ui.java", pre: "pre1", post: "post1" }), manifestSha256: "p1" }
  Set(List()).union(Set(List(reviewed))).union(Set(List({ ...reviewed, baseline: "lockOld" })))
}
pure def sometimesPhysicalSourceMatched(s: SourceVerdict): bool = s.verdict == Match and s.lock.generated.length() > 0 and s.patches == List()
pure def sometimesVirtualSourceMatched(s: SourceVerdict): bool = s.verdict == Match and s.lock.device == VirtualDevice
pure def sometimesRevisionDriftRefused(s: SourceVerdict): bool = s.verdict == Mismatch and problemsOf(s.lock, s.read, s.patches) == List(RevisionDiffers)
```

### A physical device matches only with its factory archive and the vendor API level its stock vendor declares

A physical product keeps the factory vendor partition. The factory archive's
digest must equal the lock's, and the lunch release's single
`RELEASE_BOARD_API_LEVEL` and the generated vendor VINTF sepolicy version
must both equal the lock's six-digit `vendorApiLevel`. A mismatch is
corrected in the release configuration by the operator, never by rewriting
the vendor manifest. A virtual device keeps no vendor partition and has none
of these checks.

```quint
pure def stockVendorProblems(device: DeviceSource, facts: SourceFacts): List[Problem] =
  match device {
    | PhysicalDevice(d) => problemIf(facts.archive != d.archive, ArchiveDiffers)
        .concat(problemIf(facts.boardApi != d.vendorApiLevel, BoardApiDiffers))
        .concat(problemIf(facts.vintfApi != d.vendorApiLevel, VintfApiDiffers))
    | VirtualDevice => List()
  }
pure def sometimesBoardApiRefused(s: SourceVerdict): bool = s.verdict == Mismatch and problemsOf(s.lock, s.read, s.patches) == List(BoardApiDiffers)
```

### A reviewed patch is admitted only when every file has its preimage at the pinned revision and its postimage in the checkout

A patch envelope `{name, project, revision, baseline, files, manifestSha256}`
is reviewed against one lock: its baseline is the lock's digest and its
project and revision are a locked project entry. Each listed file must read
its preimage at the project's `HEAD` (an empty digest for a new file) and
its postimage in the working tree. No patched file is also an override, and
no two envelopes patch the same file. The caller authenticates the patch
and manifest bytes; the verdict binds each admitted envelope by its
`manifestSha256`.

```quint
pure def patchAdmitted(lock: SourceLock, facts: SourceFacts, e: PatchEnvelope): bool =
  e.baseline == lock.digest and lock.projects.includes({ path: e.project, revision: e.revision }) and
  e.files.every(f => facts.heads.includes({ project: e.project, path: f.path, digest: f.pre }) and
    facts.changes.includes({ project: e.project, path: f.path, digest: f.post }) and
    not(lock.overrides.some(o => o.project == e.project and o.path == f.path)))
pure def patchesDisjoint(patches: List[PatchEnvelope]): bool =
  patches.every(a => patches.every(b => a == b or a.project != b.project or not(a.files.some(f => b.files.some(g => g.path == f.path)))))
pure def patchesAdmitted(lock: SourceLock, facts: SourceFacts, patches: List[PatchEnvelope]): bool =
  patchesDisjoint(patches) and patches.every(e => patchAdmitted(lock, facts, e))
pure def sometimesPatchedSourceMatched(s: SourceVerdict): bool = s.verdict == Match and s.patches.length() > 0
pure def sometimesStalePatchRefused(s: SourceVerdict): bool = s.verdict == Mismatch and problemsOf(s.lock, s.read, s.patches) == List(PatchRefused)
```

### Only the operator's sync changes the checkout, and it retires the verdict and every admission

Verification and admission only read: the shell opens the checkout and the
archive read-only and has no write path to them. A sync by the operator
(seen as a new checkout generation) retires what was said about the bytes
before it, so a verdict always describes the checkout it read.

```quint
pure def canSync(s: SourceVerdict, checkout: int): bool = checkout > 0 and checkout != s.checkout
pure def sync(s: SourceVerdict, checkout: int): SourceVerdict =
  { ...s, checkout: checkout, verdict: Unverified, admitted: List() }
pure val checkoutValues = Set(1, 2)
pure def alwaysVerdictDescribesTheCheckoutItRead(s: SourceVerdict): bool =
  (s.verdict != Unverified implies s.verified == s.checkout) and (s.verdict == Unverified implies s.admitted == List())
pure def sometimesSyncRetiredVerdict(s: SourceVerdict): bool = s.verdict == Unverified and s.verified == 1 and s.checkout == 2
```

### A product is admitted only from a matched source, named for the descriptor brand and one of the profile's targets

A composition target is not looked up in a fixed product list. The shell
splits it at its first underscore into a brand token and a target
(`<brand>_cf_x86_64_phone`, `<brand>_stallion`); the token must be the
descriptor brand, lowercased, and the target one the profile lists.

```quint
pure def canAdmitProduct(s: SourceVerdict, brand: str, product: ProductName, purpose: BuildPurpose): bool =
  s.verdict == Match and brand != "" and product.brand == brand and s.lock.targets.includes(product.target) and
  (purpose == Production implies not(s.lock.developmentOnly))
pure def admitProduct(s: SourceVerdict, brand: str, product: ProductName, purpose: BuildPurpose): SourceVerdict =
  { ...s, admitted: s.admitted.append({ brand: brand, product: product, purpose: purpose }) }
pure val brandValues = Set("acme", "other")
pure val productValues = Set({ brand: "acme", target: "stallion" }, { brand: "acme", target: "cf_x86_64_phone" }, { brand: "other", target: "stallion" })
pure def alwaysAdmittedProductsMatchTheirSource(s: SourceVerdict): bool =
  s.admitted.every(a => s.verdict == Match and a.brand != "" and a.product.brand == a.brand and s.lock.targets.includes(a.product.target))
pure def sometimesVirtualProductAdmitted(s: SourceVerdict): bool = s.admitted.some(a => a.product.target == "cf_x86_64_phone")
```

### A development-only lock is refused for a production build

```quint
pure def alwaysProductionNeedsAReleaseLock(s: SourceVerdict): bool =
  s.admitted.every(a => a.purpose == Production implies not(s.lock.developmentOnly))
pure def sometimesProductionProductAdmitted(s: SourceVerdict): bool = s.admitted.some(a => a.purpose == Production)
pure def sometimesDevelopmentLockAdmittedForDevelopment(s: SourceVerdict): bool = s.lock.developmentOnly and s.admitted.length() > 0
```
