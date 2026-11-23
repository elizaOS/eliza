# GitHub device sign-in

The shell starts GitHub's device flow, keeps the device code and returned token inside the credential boundary, and exposes only the public verification code, verification URL and an opaque flow ID. These rules follow `plugins/plugin-github/src/device-flow.ts` on `develop` at `51aad7ee8a82e1b8e6fa1908ed76d0c344c75d55`.

## Story: Sign in to GitHub from the account setup screen

> As an owner, I want GitHub's sign-in to remain bound to my agent, and to poll only as often as GitHub allows.

### The owning agent can poll its pending flow only after the provider interval, before expiry

A host-authenticated agent starts a flow with a new opaque flow ID, deadline and positive poll interval. The first poll is available immediately. A later early poll returns the time remaining without a network effect. A claim immediately moves the next polling time and blocks overlapping attempts until the adapter observes settlement. A foreign agent or flow has no access to the polling effect. An expired flow may be retired without polling it.

```quint
type GithubDeviceCaller = GitHubDeviceHost | GitHubDeviceAdapter | GitHubDeviceExternal
type GithubDeviceState = GitHubDeviceIdle | GitHubDevicePending | GitHubDevicePolling | GitHubDeviceComplete | GitHubDeviceDenied | GitHubDeviceExpired | GitHubDeviceFailed
type GithubDeviceBinding = { flowId: str, agentKey: str }
type GithubDeviceFlow = { binding: GithubDeviceBinding, phase: GithubDeviceState, expiresAt: int, nextPollAt: int, intervalSeconds: int, pollStartedAt: int }
type GithubDeviceEffect = PollGitHubDevice({ agentFlow: GithubDeviceBinding })
type GithubDeviceStep = { state: GithubDeviceFlow, out: List[GithubDeviceEffect] }
pure val sampleBinding: GithubDeviceBinding = { flowId: "flow-1", agentKey: "agent-1" }
pure val initial: GithubDeviceFlow = { binding: { flowId: "", agentKey: "" }, phase: GitHubDeviceIdle, expiresAt: 0, nextPollAt: 0, intervalSeconds: 0, pollStartedAt: 0 }
pure val bindingValues = Set(sampleBinding, { flowId: "flow-1", agentKey: "other-agent" }, { flowId: "", agentKey: "" })
pure val nowMsValues = Set(1000, 5000, 10000, 20000, 50000)
pure val deadlineValues = Set(20000, 50000)
pure val intervalSecondsValues = Set(0, 1, 5)
pure def canStartGitHubDevice(s: GithubDeviceFlow, by: GithubDeviceCaller, binding: GithubDeviceBinding, nowMs: int, deadline: int, intervalSeconds: int): bool = by == GitHubDeviceHost and s.phase == GitHubDeviceIdle and binding.flowId != "" and binding.agentKey != "" and nowMs >= 0 and deadline > nowMs and intervalSeconds > 0
pure def startGitHubDevice(s: GithubDeviceFlow, by: GithubDeviceCaller, binding: GithubDeviceBinding, nowMs: int, deadline: int, intervalSeconds: int): GithubDeviceFlow = { binding: binding, phase: GitHubDevicePending, expiresAt: deadline, nextPollAt: nowMs, intervalSeconds: intervalSeconds, pollStartedAt: 0 }
pure def canPollGitHubDevice(s: GithubDeviceFlow, by: GithubDeviceCaller, binding: GithubDeviceBinding, nowMs: int): bool = by == GitHubDeviceHost and s.phase == GitHubDevicePending and s.binding == binding and nowMs >= s.nextPollAt and nowMs < s.expiresAt
pure def pollGitHubDevice(s: GithubDeviceFlow, by: GithubDeviceCaller, binding: GithubDeviceBinding, nowMs: int): GithubDeviceStep = { state: { ...s, phase: GitHubDevicePolling, nextPollAt: nowMs + s.intervalSeconds * 1000, pollStartedAt: nowMs }, out: List(PollGitHubDevice({ agentFlow: binding })) }
pure def canExpireGitHubDevice(s: GithubDeviceFlow, by: GithubDeviceCaller, nowMs: int): bool = by == GitHubDeviceHost and (s.phase == GitHubDevicePending or s.phase == GitHubDevicePolling) and nowMs >= s.expiresAt
pure def expireGitHubDevice(s: GithubDeviceFlow, by: GithubDeviceCaller, nowMs: int): GithubDeviceFlow = { ...s, phase: GitHubDeviceExpired }
pure def stepGitHubDevicePollsItsFlow(before: GithubDeviceFlow, after: GithubDeviceFlow, out: List[GithubDeviceEffect]): bool = out.length() > 0 implies (before.phase == GitHubDevicePending and after.pollStartedAt >= before.nextPollAt and after.pollStartedAt < before.expiresAt and out == List(PollGitHubDevice({ agentFlow: before.binding })))
```

### A slow-down response delays the same flow by another five seconds

Only a trusted response for the current polling attempt can update the flow. Pending and transport failure release the attempt within the current interval. Slow-down raises the interval by five seconds. Accepted, denied, expired and terminal failures consume the flow. The adapter records acceptance only when its credential service has stored the account token.

```quint
type GithubDeviceObservation = GitHubDeviceStillPending | GitHubDeviceSlowDown | GitHubDeviceTransportFailure | GitHubDeviceTokenStored | GitHubDeviceAccessDenied | GitHubDeviceCodeExpired | GitHubDeviceInvalid
pure val pollAtValues = Set(5000, 10000, 20000)
pure def canObserveGitHubDevice(s: GithubDeviceFlow, by: GithubDeviceCaller, binding: GithubDeviceBinding, pollAt: int, observation: GithubDeviceObservation): bool = by == GitHubDeviceAdapter and s.phase == GitHubDevicePolling and s.binding == binding and s.pollStartedAt == pollAt
pure def observeGitHubDevice(s: GithubDeviceFlow, by: GithubDeviceCaller, binding: GithubDeviceBinding, pollAt: int, observation: GithubDeviceObservation): GithubDeviceFlow = match observation {
  | GitHubDeviceStillPending => { ...s, phase: GitHubDevicePending }
  | GitHubDeviceSlowDown => { ...s, phase: GitHubDevicePending, intervalSeconds: s.intervalSeconds + 5, nextPollAt: s.pollStartedAt + (s.intervalSeconds + 5) * 1000 }
  | GitHubDeviceTransportFailure => { ...s, phase: GitHubDevicePending }
  | GitHubDeviceTokenStored => { ...s, phase: GitHubDeviceComplete }
  | GitHubDeviceAccessDenied => { ...s, phase: GitHubDeviceDenied }
  | GitHubDeviceCodeExpired => { ...s, phase: GitHubDeviceExpired }
  | GitHubDeviceInvalid => { ...s, phase: GitHubDeviceFailed }
}
pure def alwaysGitHubDeviceActiveHasInterval(s: GithubDeviceFlow): bool = (s.phase == GitHubDevicePending or s.phase == GitHubDevicePolling) implies s.intervalSeconds > 0
pure def sometimesGitHubDeviceSlowsPolling(s: GithubDeviceFlow): bool = s.phase == GitHubDevicePending and s.intervalSeconds == 6
pure val eval_witness_sometimesGitHubDeviceSlowsPolling = (("startGitHubDevice", GitHubDeviceHost, sampleBinding, 1000, 50000, 1), ("pollGitHubDevice", GitHubDeviceHost, sampleBinding, 5000), ("observeGitHubDevice", GitHubDeviceAdapter, sampleBinding, 5000, GitHubDeviceSlowDown))
```
