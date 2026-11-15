// scripts/build-mobile-bundle.ts and mobile-bundle-dependencies.ts.
// Output files are written in stages, not an atomic directory publication.
// The successful process result requires each configured gate. Partial output
// can remain after failure; consumers must validate the hash-bound manifest.
// Bundler/compiler correctness, platform loaders and external files are assumptions.
module tooling_mobile_build {
  var s: { phase: str, bundle: bool, assets: bool, manifest: bool, requireSmoke: bool, smoke: bool }
  action init = {
    nondet required = Set(true, false).oneOf()
    s' = { phase: "prepare", bundle: false, assets: false, manifest: false, requireSmoke: required, smoke: false }
  }
  action bundle = all { s.phase == "prepare", s' = s.with("phase", "assets").with("bundle", true) }
  action copyAssets = all { s.phase == "assets", s' = s.with("phase", "manifest").with("assets", true) }
  action manifest = all { s.phase == "manifest", s' = s.with("phase", "verify").with("manifest", true) }
  action smokePass = all { s.phase == "verify", s.requireSmoke, s' = s.with("smoke", true) }
  action succeed = all { s.phase == "verify", s.smoke or not(s.requireSmoke), s' = s.with("phase", "complete") }
  action failure = all { s.phase.in(Set("prepare", "assets", "manifest", "verify")), s' = s.with("phase", "failed") }
  action idle = s' = s
  action step = any { bundle, copyAssets, manifest, smokePass, succeed, failure, idle }
  val safety = all { s.assets implies s.bundle, s.manifest implies s.assets, s.phase == "complete" implies s.bundle and s.assets and s.manifest and (not(s.requireSmoke) or s.smoke) }
  run failedLoadRetainsPartialFilesTest = init.then(bundle).then(copyAssets).then(manifest).then(failure).expect(s.phase == "failed" and s.manifest)
  run explicitGateCompletionTest = init.then(bundle).then(copyAssets).then(manifest).then(if (s.requireSmoke) smokePass else idle).then(succeed).expect(safety and s.phase == "complete")
}
