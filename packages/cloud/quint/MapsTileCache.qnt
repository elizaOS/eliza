// One caller and one tile. HTTP caches must obey no-store; rendering memory is outside this model.
module maps_tile_cache {
  const NoStore: bool
  var authorized: bool
  var cached: bool
  var servedWithoutAdmission: bool

  action init = all {
    authorized' = true,
    cached' = false,
    servedWithoutAdmission' = false,
  }

  action authorize = all {
    authorized' = true,
    cached' = cached,
    servedWithoutAdmission' = servedWithoutAdmission,
  }

  action revoke = all {
    authorized' = false,
    cached' = cached,
    servedWithoutAdmission' = servedWithoutAdmission,
  }

  action request = all {
    authorized' = authorized,
    cached' = (cached or (authorized and not(NoStore))),
    servedWithoutAdmission' = (cached and not(authorized)),
  }

  action step = any { authorize, revoke, request }
  val safety = not(servedWithoutAdmission)
  val noRetainedTile = not(cached)

  run revokedRequestRequiresAdmissionTest = init.then(request).then(revoke).then(request)
    .expect(NoStore implies (safety and noRetainedTile))
  run oldCacheBypassesAdmissionTest = init.then(request).then(revoke).then(request)
    .expect(NoStore or not(safety))
}

module MapsTileCache {
  import maps_tile_cache(NoStore = true).*
}
