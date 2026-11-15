/// Completed profile and native env projections; not atomic cross-process writes.
module NativeMediaRouting {
  var s: { mode: str, media: str, mediaBackend: str, cloudImageModel: str, speech: str, ownerData: int }
  action init = s' = { mode: "unbound", media: "unset", mediaBackend: "unset", cloudImageModel: "unset", speech: "local-only", ownerData: 1 }
  action cloud = s' = { ...s, mode: "cloud", media: "cloud-proxy", mediaBackend: "elizacloud", cloudImageModel: "cerebras/qwen-3.8-27b" }
  action direct = s' = { ...s, mode: "direct", media: "direct", mediaBackend: "cerebras", cloudImageModel: "unset" }
  /// Unbound is retired native admission, not deletion of persisted TS routing.
  action unbind = s' = { ...s, mode: "unbound", media: "unset", mediaBackend: "unset", cloudImageModel: "unset" }
  action rejectBinding = s' = s
  action step = any { cloud, direct, unbind, rejectBinding }
  val safety = s.ownerData == 1 and s.speech == "local-only" and
    (s.mode == "cloud" implies s.media == "cloud-proxy" and s.mediaBackend == "elizacloud") and
    (s.mode == "direct" implies s.media == "direct" and s.mediaBackend == "cerebras")
  val SelectedCloudImage =
    (s.mode == "cloud" implies s.cloudImageModel == "cerebras/qwen-3.8-27b") and
    (s.mode != "cloud" implies s.cloudImageModel == "unset")
  temporal CanBind = cloud.weakFair(s) implies eventually(s.mode == "cloud")
  run switchTest = init.then(cloud).then(direct).then(cloud).expect(safety and SelectedCloudImage)
  run rejectedTest = init.then(rejectBinding).expect(s.mode == "unbound" and safety and SelectedCloudImage)
  run imageModelRetirementTest = init.then(cloud).then(direct).then(cloud).then(unbind)
    .expect(s.mode == "unbound" and safety and SelectedCloudImage)
}
