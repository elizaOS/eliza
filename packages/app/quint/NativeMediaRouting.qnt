/// Explicit model-free native profile. Completed boot projections, not concurrent writes.
module NativeMediaRouting {
  var s: { mode: str, media: str, imageProvider: str, speech: str, ownerData: int }
  action init = s' = { mode: "unbound", media: "unset", imageProvider: "unset", speech: "local-only", ownerData: 1 }
  action cloud = s' = { ...s, mode: "cloud", media: "cloud-proxy", imageProvider: "elizaOSCloud" }
  action direct = s' = { ...s, mode: "direct", media: "direct", imageProvider: "openai" }
  action rejectBinding = s' = s
  action step = any { cloud, direct, rejectBinding }
  val safety = s.ownerData == 1 and s.speech == "local-only" and
    (s.mode == "cloud" implies s.media == "cloud-proxy" and s.imageProvider == "elizaOSCloud") and
    (s.mode == "direct" implies s.media == "direct" and s.imageProvider == "openai")
  temporal CanBind = cloud.weakFair(s) implies eventually(s.mode == "cloud")
  run switchTest = init.then(cloud).then(direct).then(cloud).expect(safety)
  run rejectedTest = init.then(rejectBinding).expect(s.mode == "unbound" and safety)
}
