// Provider edit time remains distinct from the time a cached feed was refreshed.
module ManagedCalendarRevision {
  var providerRevision: int
  var legacyRevision: int
  var cachedRevision: int
  var refreshTime: int
  var synchronized: bool
  pure def revision(primary: int, legacy: int, refreshed: int): int =
    if (primary >= 0) primary else if (legacy >= 0) legacy else refreshed
  action init = {
    nondet primary = Set(-1, 10).oneOf()
    nondet legacy = Set(-1, 20).oneOf()
    all {
      providerRevision' = primary, legacyRevision' = legacy,
      cachedRevision' = -1, refreshTime' = 100, synchronized' = false
    }
  }
  action refresh = {
    nondet observed = Set(100, 200).oneOf()
    all {
      providerRevision' = providerRevision, legacyRevision' = legacyRevision,
      cachedRevision' = revision(providerRevision, legacyRevision, observed),
      refreshTime' = observed, synchronized' = true
    }
  }
  action edit = all {
    providerRevision' = if (providerRevision == 10) 30 else 10,
    legacyRevision' = legacyRevision, cachedRevision' = cachedRevision,
    refreshTime' = refreshTime, synchronized' = false
  }
  action step = any { refresh, edit }
  val CacheUsesProviderRevision =
    not(synchronized) or cachedRevision == revision(providerRevision, legacyRevision, refreshTime)
  val NoRefreshTimeAsEditTime =
    not(synchronized) or (providerRevision < 0 and legacyRevision < 0) or cachedRevision != refreshTime
  val invariant = CacheUsesProviderRevision and NoRefreshTimeAsEditTime
}
