// One package of an exact release cohort; metadata checks do not depend on the channel.
module ReleasePackedProvenance {
  const requireRegistryProvenance: bool
  var s: {
    phase: str, originalManifest: bool, archiveIdentity: bool,
    sourceStable: bool, admitted: bool, verified: bool, settled: bool,
    registrySource: str, registryPublisher: str, metadataIdentity: bool, registryIntegrity: bool, matched: bool
  }
  action init = s' = {
    phase: "idle", originalManifest: true, archiveIdentity: false,
    sourceStable: true, admitted: false, verified: false, settled: false,
    registrySource: "unread", registryPublisher: "unread", metadataIdentity: false, registryIntegrity: false, matched: false
  }
  action begin = all {s.phase == "idle", s' = s.with("phase", "writing")}
  // A failed filesystem write can leave changed bytes. It never admits a candidate.
  action writeTemporary = all {
    s.phase == "writing", s' = s.with("originalManifest", false).with("phase", "packing")
  }
  action failWrite = all {
    s.phase == "writing", s' = s.with("originalManifest", false).with("phase", "rejected").with("settled", true)
  }
  action finishPack = all {
    s.phase == "packing",
    nondet valid = Set(false, true).oneOf()
    s' = s.with("archiveIdentity", valid).with("phase", "restoring")
  }
  action failPack = all {s.phase == "packing", s' = s.with("phase", "restoring")}
  // The real finally block restores exact source bytes, also after pack validation fails.
  action restore = all {
    s.phase == "restoring", s' = s.with("originalManifest", true).with("phase", "checking")
  }
  action failRestore = all {
    s.phase == "restoring", s' = s.with("phase", "rejected").with("settled", true)
  }
  action admit = all {
    s.phase == "checking",
    s' = if (s.archiveIdentity and s.sourceStable and s.originalManifest)
      s.with("phase", "candidate").with("admitted", true).with("settled", true)
      else s.with("phase", "rejected").with("settled", true)
  }
  action sourceChange = all {
    Set("writing", "packing", "restoring", "checking", "candidate").contains(s.phase),
    s' = s.with("sourceStable", false)
  }
  action mutateArchive = all {
    s.phase == "candidate", s' = s.with("archiveIdentity", false).with("phase", "modified")
  }
  action verify = all {
    Set("candidate", "modified").contains(s.phase),
    s' = if (s.archiveIdentity and s.sourceStable and s.originalManifest)
      s.with("phase", "verified").with("verified", true)
      else s.with("phase", "rejected")
  }
  // Missing means JavaScript undefined only. Null, empty and incorrect values are wrong.
  action inspectRegistry = all {
    s.phase == "verified",
    nondet source = Set("missing", "match", "wrong").oneOf()
    nondet publisher = Set("missing", "match", "wrong").oneOf()
    nondet identity = Set(false, true).oneOf()
    nondet integrity = Set(false, true).oneOf()
    val allowed = identity and integrity and source != "wrong" and publisher != "wrong" and
      (not(requireRegistryProvenance) or (source == "match" and publisher == "match"))
    s' = s.with("registrySource", source).with("registryPublisher", publisher)
      .with("metadataIdentity", identity).with("registryIntegrity", integrity)
      .with("matched", allowed).with("phase", "inspected")
  }
  action step = any {
    begin, writeTemporary, failWrite, finishPack, failPack, restore, failRestore,
    admit, sourceChange, mutateArchive, verify, inspectRegistry, s' = s
  }
  val AdmittedOnlyAfterRestore = s.admitted implies s.originalManifest
  val VerifiedArchiveIdentity = s.verified implies s.archiveIdentity and s.sourceStable and s.admitted
  val ProvidedMismatchRejected = s.matched implies s.registrySource != "wrong" and s.registryPublisher != "wrong"
  val PublicNeedsBothFields = s.matched and requireRegistryProvenance implies
    s.registrySource == "match" and s.registryPublisher == "match"
  val RegistryIdentityRequired = s.matched implies s.metadataIdentity and s.registryIntegrity
  val RegistryNeedsVerifiedCandidate = s.matched implies s.verified and s.originalManifest
  temporal PackSettles = (s.phase != "idle").leadsTo(s.settled)
  temporal FairPackSettles = all {
    writeTemporary.weakFair(s), finishPack.weakFair(s), restore.weakFair(s), admit.weakFair(s)
  }.implies(PackSettles)
}
module PublicReleaseProvenance { import ReleasePackedProvenance(requireRegistryProvenance = true).* }
module PrivateReleaseProvenance { import ReleasePackedProvenance(requireRegistryProvenance = false).* }
