// applyOwnerPolicyConfigureEscalation (plugins/plugin-personal-assistant/src/
// actions/lib/owner-policy-writes.ts) sets the escalation steps of a named
// reminder, for example "call me if I don't respond in 30 minutes". Requested
// steps replace the steps on the same channel; the other steps stay unless
// the request says replace. The reminder's quiet hours and mute policy are
// not part of the request, so they stay as they were: the dispatcher reads
// them from the stored plan before it sends any step.
// A plan holds at most one step per channel: the offset in minutes, or -1 for
// no step. Request 0 is "call after 30 minutes" (in-app at +0, call at +30),
// 1 is the same request with replace, 2 is an explicit sms step at +15 and
// 3 is "call after a 20-minute timeout" (in-app at +0, call at +20).
module EscalationPlan {
  type Plan = { inApp: int, sms: int, voice: int }
  pure val NoRequest = -1
  pure val NoStep = -1
  pure val Requests = 0.to(3)
  pure val MaxRequests = 2

  // The stored plan, and the plan before the last request was applied.
  var plan: Plan
  var before: Plan
  // The stored plan's quiet hours (22:00-07:00 UTC) and mute policy
  // (muted until a set time), and their values when the reminder was saved.
  var quiet: bool
  var muted: bool
  var savedQuiet: bool
  var savedMuted: bool
  // The request the owner made and the assistant has not applied yet, the
  // last applied request and the number of applied requests.
  var asked: int
  var last: int
  var applied: int

  pure def requested(k: int): Plan =
    if (k == 2) { inApp: -1, sms: 15, voice: -1 }
    else if (k == 3) { inApp: 0, sms: -1, voice: 20 }
    else { inApp: 0, sms: -1, voice: 30 }
  pure def keep(old: int, req: int): int = if (req >= 0) req else old
  pure def apply(p: Plan, k: int): Plan =
    val r = requested(k)
    if (k == 1) r
    else { inApp: keep(p.inApp, r.inApp), sms: keep(p.sms, r.sms), voice: keep(p.voice, r.voice) }
  pure def hasStep(p: Plan): bool = p.inApp >= 0 or p.sms >= 0 or p.voice >= 0

  action init = {
    nondet inApp = Set(-1, 0).oneOf()
    nondet sms = Set(-1, 10).oneOf()
    nondet voice = Set(-1, 60).oneOf()
    nondet q = Bool.oneOf()
    nondet m = Bool.oneOf()
    val p = { inApp: inApp, sms: sms, voice: voice }
    all {
      hasStep(p),
      plan' = p, before' = p,
      quiet' = q, muted' = m, savedQuiet' = q, savedMuted' = m,
      asked' = NoRequest, last' = NoRequest, applied' = 0,
    }
  }
  action ask = {
    nondet k = Requests.oneOf()
    all {
      asked == NoRequest, applied < MaxRequests,
      plan' = plan, before' = before,
      quiet' = quiet, muted' = muted,
      savedQuiet' = savedQuiet, savedMuted' = savedMuted,
      asked' = k, last' = last, applied' = applied,
    }
  }
  action configure = all {
    asked != NoRequest,
    plan' = apply(plan, asked), before' = plan,
    quiet' = quiet, muted' = muted,
    savedQuiet' = savedQuiet, savedMuted' = savedMuted,
    asked' = NoRequest, last' = asked, applied' = applied + 1,
  }
  // The assistant may never act on a request.
  action stutter = all {
    plan' = plan, before' = before,
    quiet' = quiet, muted' = muted,
    savedQuiet' = savedQuiet, savedMuted' = savedMuted,
    asked' = asked, last' = last, applied' = applied,
  }
  action step = any { ask, configure, stutter }

  val ModelState = {
    plan: plan, before: before, quiet: quiet, muted: muted,
    savedQuiet: savedQuiet, savedMuted: savedMuted,
    asked: asked, last: last, applied: applied,
  }
  temporal RequestAppliedWithoutFairness =
    (asked != NoRequest).leadsTo(asked == NoRequest)
  temporal RequestApplied = configure.weakFair(ModelState)
    .implies(RequestAppliedWithoutFairness)

  val QuietHoursKept = quiet == savedQuiet
  val MutePolicyKept = muted == savedMuted
  val RequestedStepsSet =
    last == NoRequest or {
      val r = requested(last)
      and {
        r.inApp < 0 or plan.inApp == r.inApp,
        r.sms < 0 or plan.sms == r.sms,
        r.voice < 0 or plan.voice == r.voice,
      }
    }
  val OtherStepsFollowRequest =
    last == NoRequest or {
      val r = requested(last)
      // Replace drops the steps on channels it does not name.
      val other = if (last == 1) NoStep else before.sms
      and {
        r.inApp >= 0 or plan.inApp == before.inApp,
        r.sms >= 0 or plan.sms == other,
        r.voice >= 0 or plan.voice == before.voice,
      }
    }
  val TypeOK =
    Set(-1, 0).contains(plan.inApp) and Set(-1, 10, 15).contains(plan.sms) and
    Set(-1, 20, 30, 60).contains(plan.voice) and hasStep(plan) and
    (asked == NoRequest or Requests.contains(asked)) and
    (last == NoRequest or Requests.contains(last)) and
    0 <= applied and applied <= MaxRequests and
    (applied == 0 iff last == NoRequest)
}
