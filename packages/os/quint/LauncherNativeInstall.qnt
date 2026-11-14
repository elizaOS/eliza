/// One completed launcher staging call. Admission stands for the existing
/// signer, APK/JNI byte, descriptor and source-patch checks, not cryptography.
module LauncherNativeInstall {
  type State = {
    phase: str, privileged: bool, soong: bool, valid: bool, existing: bool,
    nativePrivileged: bool, patchRecorded: bool, bytesPreserved: bool,
    companionsPlain: bool, ownersPreserved: bool, qualified: bool, output: bool, writes: int
  }
  var s: State

  pure def initial(privileged: bool, soong: bool, valid: bool, existing: bool): State =
    {phase: "pending", privileged: privileged, soong: soong,
      valid: valid, existing: existing, nativePrivileged: false,
      patchRecorded: false, bytesPreserved: true, companionsPlain: true,
      ownersPreserved: true, qualified: false, output: existing, writes: 0}
  action begin(privileged: bool, soong: bool, valid: bool, existing: bool): bool =
    s' = initial(privileged, soong, valid, existing)
  action init = {
    nondet privileged = Set(false, true).oneOf()
    nondet soong = Set(false, true).oneOf()
    nondet valid = Set(false, true).oneOf()
    nondet existing = Set(false, true).oneOf()
    begin(privileged, soong, valid, existing)
  }
  action admit = all {s.phase == "pending", s.valid, not(s.existing),
    s' = {...s, phase: "admitted"}}
  action render = all {s.phase == "admitted",
    s' = {...s, phase: "rendered", nativePrivileged: s.privileged,
      patchRecorded: s.soong}}
  action publish = all {s.phase == "rendered",
    s' = {...s, phase: "published", output: true, writes: 1}}
  action reject = all {s.phase == "pending", not(s.valid) or s.existing,
    s' = {...s, phase: "refused"}}
  // A caught failure before publication discards the private staging directory.
  action discard = all {Set("admitted", "rendered").contains(s.phase),
    s' = {...s, phase: "refused"}}
  action retry = all {s.phase == "refused", not(s.existing),
    s' = initial(s.privileged, s.soong, s.valid, false)}
  action stableStep = any {admit, render, publish, reject, s' = s}
  action step = any {stableStep, discard, retry}

  val safety = all {
    s.writes <= 1,
    s.existing implies (s.output and s.writes == 0),
    s.writes == 1 implies (s.phase == "published" and s.valid and not(s.existing)),
    Set("rendered", "published").contains(s.phase) implies all {
      s.nativePrivileged == s.privileged, s.patchRecorded == s.soong,
      s.bytesPreserved, s.companionsPlain, s.ownersPreserved, not(s.qualified)
    },
    s.phase == "refused" implies (s.writes == 0 and s.output == s.existing)
  }
  temporal Settles = eventually(Set("published", "refused").contains(s.phase))
  temporal FairSettles = (admit.weakFair(s) and render.weakFair(s)
    and publish.weakFair(s) and reject.weakFair(s)) implies Settles

  run privilegedSoongTest = begin(true, true, true, false)
    .then(admit).then(render).then(publish)
    .expect(safety and s.nativePrivileged and s.patchRecorded and not(s.qualified))
  run refusedOwnerTest = begin(true, true, true, true).then(reject)
    .expect(safety and s.output and s.writes == 0)
  run failedCallCanRetryTest = begin(false, true, true, false)
    .then(admit).then(discard).then(retry).then(admit).then(render).then(publish)
    .expect(safety and s.phase == "published")
}
