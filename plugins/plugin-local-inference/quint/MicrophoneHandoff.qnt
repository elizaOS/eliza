// One original native capture and one draft request, on the controller's serial worker.
module MicrophoneHandoff {
  const starting: bool
  var s: {
    old: str, oldOwns: bool, requested: bool, fence: bool,
    draft: bool, acknowledged: bool, refused: bool,
    staleQueued: bool, autoRefused: bool, hostOpen: bool,
    user: str, live: bool
  }
  action init = s' = {
    old: if (starting) "starting" else "running", oldOwns: not(starting),
    requested: false, fence: false, draft: false, acknowledged: false,
    refused: false, staleQueued: true, autoRefused: false,
    hostOpen: true, user: "idle", live: false
  }
  action requestDraft = all {
    not(s.requested), s.user == "idle",
    s' = s.with("requested", true).with("fence", true)
  }
  // An original source can finish opening after its cancellation fence.
  action finishStart = all {
    s.old == "starting",
    s' = s.with("old", "running").with("oldOwns", true)
  }
  action stopOld = all {
    s.requested, s.old == "running", s' = s.with("old", "stopping")
  }
  action releaseOld = all {
    s.old == "stopping", s' = s.with("old", "released").with("oldOwns", false)
  }
  action failRelease = all {
    s.old == "stopping", s' = s.with("old", "failed")
  }
  action settleDrain = all {
    s.requested, not(s.acknowledged), not(s.refused),
    Set("released", "failed").contains(s.old),
    s' = if (s.old == "released" and s.hostOpen)
      s.with("draft", true).with("acknowledged", true)
      else s.with("refused", true)
  }
  // A queued reservation cancelled by requestDraft does not clear its fence.
  action staleStart = all {
    s.requested, s.staleQueued, s' = s.with("staleQueued", false)
  }
  action automaticReopen = all {
    s.draft, s.fence, s' = s.with("autoRefused", true)
  }
  action requestUserLive = all {
    s.draft, s.hostOpen, s.user == "idle",
    s' = s.with("user", "finishing-draft").with("fence", false)
  }
  action finishDraft = all {
    s.user == "finishing-draft",
    s' = s.with("draft", false).with("user", "acquiring")
  }
  action acquireLive = all {
    s.user == "acquiring",
    s' = if (s.hostOpen) s.with("live", true).with("user", "done")
      else s.with("user", "refused")
  }
  action retireHost = s' = s.with("hostOpen", false)
  action step = any {
    requestDraft, finishStart, stopOld, releaseOld, failRelease, settleDrain,
    staleStart, automaticReopen, requestUserLive, finishDraft, acquireLive,
    retireHost, s' = s
  }
  val OneMicrophoneOwner = not(s.oldOwns and (s.draft or s.live)) and not(s.draft and s.live)
  val ReleaseReceipt = s.acknowledged implies s.old == "released" and not(s.oldOwns)
  val FailedCloseFenced = s.old == "failed" implies not(s.draft) and not(s.live) and not(s.acknowledged)
  val ReopenFenced = s.draft and s.user == "idle" implies s.fence
  val safety = OneMicrophoneOwner and ReleaseReceipt and FailedCloseFenced and ReopenFenced
  temporal DrainSettles = s.requested.leadsTo(s.acknowledged or s.refused)
  temporal FairDrainSettles = all {
    finishStart.weakFair(s), stopOld.weakFair(s), releaseOld.weakFair(s), settleDrain.weakFair(s)
  }.implies(DrainSettles)
}

module RunningMicrophoneHandoff { import MicrophoneHandoff(starting = false).* }
module StartingMicrophoneHandoff { import MicrophoneHandoff(starting = true).* }
