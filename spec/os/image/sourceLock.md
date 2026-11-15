# Device source lock

The os package pins each device profile's platform source in a lock
profile: every project revision, every local override and every generated
file, and for a physical device the stock factory archive whose vendor
partition the image keeps. Verification reads the checkout and the archive
and reports problems; it never repairs them. The
[product composition](./product.md) refuses a profile whose source does
not verify.

## Story: Build from exactly the pinned device source and factory archive

> As a consumer, I want my image built from exactly the platform source
> and factory archive the os package pinned for my device, so that a
> drifted checkout or a mismatched vendor never reaches a build.

### A source verdict matches only when every revision, override and generated file matches the lock profile

The verifier compares every project revision, every override and every
generated file of the checkout, and the factory archive's digest, with
the lock profile. One mismatch fails the verdict; the verdict lists every
problem it found.

```quint
type LockVerdict = Unverified | LockMatched | LockMismatched
type LockFacts = { revisionsMatch: bool, overridesMatch: bool, generatedMatch: bool, archiveMatches: bool, vendorApiMatches: bool }
type SourceLock = { checkout: int, archive: int, verdict: LockVerdict, verifiedCheckout: int, verifiedArchive: int, facts: LockFacts }
pure val noFacts: LockFacts = { revisionsMatch: false, overridesMatch: false, generatedMatch: false, archiveMatches: false, vendorApiMatches: false }
pure val initial: SourceLock = { checkout: 1, archive: 1, verdict: Unverified, verifiedCheckout: 0, verifiedArchive: 0, facts: noFacts }
pure def lockMatches(f: LockFacts): bool = f.revisionsMatch and f.overridesMatch and f.generatedMatch and f.archiveMatches and f.vendorApiMatches
pure def verifyLock(s: SourceLock, observed: LockFacts): SourceLock =
  { ...s, verdict: if (lockMatches(observed)) LockMatched else LockMismatched, verifiedCheckout: s.checkout, verifiedArchive: s.archive, facts: observed }
pure val allMatch: LockFacts = { revisionsMatch: true, overridesMatch: true, generatedMatch: true, archiveMatches: true, vendorApiMatches: true }
pure val observedValues = Set(allMatch, { ...allMatch, revisionsMatch: false }, { ...allMatch, overridesMatch: false },
  { ...allMatch, generatedMatch: false }, { ...allMatch, archiveMatches: false }, { ...allMatch, vendorApiMatches: false })
pure def alwaysMatchedVerdictHasEveryFact(s: SourceLock): bool = s.verdict == LockMatched implies lockMatches(s.facts)
pure def sometimesSourceMatched(s: SourceLock): bool = s.verdict == LockMatched
pure def sometimesSourceMismatched(s: SourceLock): bool = s.verdict == LockMismatched and s.facts.revisionsMatch
```

### Verification never writes to the checkout or the archive

Only the operator's own sync changes the checkout or the archive. A sync
retires the verdict about what was there before, so a verdict always
describes the bytes it read.

```quint
pure def syncSource(s: SourceLock, checkout: int, archive: int): SourceLock =
  { ...s, checkout: checkout, archive: archive, verdict: Unverified, facts: noFacts }
pure def canSyncSource(s: SourceLock, checkout: int, archive: int): bool = checkout > 0 and archive > 0 and (checkout != s.checkout or archive != s.archive)
pure val checkoutValues = Set(1, 2)
pure val archiveValues = Set(1, 2)
pure def stepVerificationNeverWrites(before: SourceLock, via: str, after: SourceLock): bool =
  via == "verifyLock" implies after.checkout == before.checkout and after.archive == before.archive
pure def alwaysVerdictDescribesWhatItRead(s: SourceLock): bool =
  s.verdict != Unverified implies s.verifiedCheckout == s.checkout and s.verifiedArchive == s.archive
pure def sometimesSyncRetiresVerdict(s: SourceLock): bool = s.verdict == Unverified and s.checkout == 2
```

### A physical device's platform declares the stock vendor's board API level

A product keeps the factory vendor partition, so the platform's single
board API level must be a six-digit level equal to the vendor's VINTF
sepolicy version. A mismatched release is corrected in the build
configuration, never by rewriting the vendor manifest.

```quint
pure def boardApiMatchesVendor(boardApi: int, vendorApi: int): bool = boardApi >= 100000 and boardApi <= 999999 and boardApi == vendorApi
pure val boardApiValues = Set(0, 202404, 202504)
pure val vendorApiValues = Set(202404, 202504)
pure def lawVendorApiIsExact(boardApi: int, vendorApi: int): bool =
  boardApiMatchesVendor(boardApi, vendorApi) implies boardApi == vendorApi and boardApi >= 100000
```
