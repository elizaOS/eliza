// Provider edit time remains distinct from the time a cached feed was refreshed.
module ManagedCalendarRevision {
  var providerRevision: int
  var cachedRevision: int
  var synchronized: bool
  action init = {
    nondet initialRevision = Set(-1, 10).oneOf()
    all { providerRevision' = initialRevision, cachedRevision' = -1, synchronized' = false }
  }
  action refresh = all {
    providerRevision' = providerRevision,
    cachedRevision' = providerRevision, synchronized' = true
  }
  action edit = all {
    providerRevision' = if (providerRevision == 10) 20 else 10,
    cachedRevision' = cachedRevision, synchronized' = false
  }
  action step = any { refresh, edit }
  val CacheUsesProviderRevision = not(synchronized) or cachedRevision == providerRevision
  val NoRefreshTimeAsEditTime = Set(-1, 10, 20).contains(cachedRevision)
  val invariant = CacheUsesProviderRevision and NoRefreshTimeAsEditTime
}
