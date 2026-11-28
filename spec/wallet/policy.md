# Wallet spend policy and audit log

## Story: Enforce spend policy, slippage limits, and a tamper-evident audit chain

> As the owner, I want every wallet trade and payment gated by daily spend caps, slippage ceilings, and an append-only hash-chained audit trail so that paused or excessive operations never execute and every decision is auditable.

### Policy spend state tracks daily totals, trade counts, pause status, and monotonic audit depth

Each accepted spend (`recordSpend`) requires the policy to be unpaused, `amount > 0` within `perTxLimit`, `dailySpent + amount <= dailyLimit`, `dailyTxCount < maxDailyTxs`, and `0 <= slippageBps <= maxSlippageBps`, incrementing `dailySpent`, `dailyTxCount`, and `auditHeight`. Pausing (`pausePolicy`), resuming (`resumePolicy`), and resetting a non-empty daily window (`resetDailyWindow`) each strictly increment `auditHeight`, ensuring paused policies block all spend and excessive slippage is always refused.

```quint
type PolicyState = {
  paused: bool,
  dailyLimit: int,
  perTxLimit: int,
  dailySpent: int,
  dailyTxCount: int,
  maxDailyTxs: int,
  maxSlippageBps: int,
  auditHeight: int,
}

pure val initial: PolicyState = {
  paused: false,
  dailyLimit: 1000,
  perTxLimit: 250,
  dailySpent: 0,
  dailyTxCount: 0,
  maxDailyTxs: 25,
  maxSlippageBps: 300,
  auditHeight: 0,
}

pure def slippageAllowed(slippageBps: int, maxSlippageBps: int): bool =
  slippageBps >= 0 and maxSlippageBps >= 0 and slippageBps <= maxSlippageBps

pure def canRecordSpend(s: PolicyState, amount: int, slippageBps: int): bool =
  not(s.paused) and amount > 0 and amount <= s.perTxLimit and
    s.dailySpent + amount <= s.dailyLimit and
    s.dailyTxCount < s.maxDailyTxs and
    slippageAllowed(slippageBps, s.maxSlippageBps)

pure def recordSpend(s: PolicyState, amount: int, slippageBps: int): PolicyState = {
  ...s,
  dailySpent: s.dailySpent + amount,
  dailyTxCount: s.dailyTxCount + 1,
  auditHeight: s.auditHeight + 1,
}

pure def canResetDailyWindow(s: PolicyState): bool =
  s.dailySpent > 0 or s.dailyTxCount > 0

pure def resetDailyWindow(s: PolicyState): PolicyState = {
  ...s,
  dailySpent: 0,
  dailyTxCount: 0,
  auditHeight: s.auditHeight + 1,
}

pure def canPausePolicy(s: PolicyState): bool = not(s.paused)

pure def pausePolicy(s: PolicyState): PolicyState = {
  ...s,
  paused: true,
  auditHeight: s.auditHeight + 1,
}

pure def canResumePolicy(s: PolicyState): bool = s.paused

pure def resumePolicy(s: PolicyState): PolicyState = {
  ...s,
  paused: false,
  auditHeight: s.auditHeight + 1,
}

pure def alwaysSpentWithinDailyLimit(s: PolicyState): bool =
  s.dailySpent >= 0 and s.dailySpent <= s.dailyLimit

pure def alwaysDailyCountWithinCap(s: PolicyState): bool =
  s.dailyTxCount >= 0 and s.dailyTxCount <= s.maxDailyTxs

pure def alwaysAuditHeightNonnegative(s: PolicyState): bool =
  s.auditHeight >= 0

pure def stepAuditChainStrictlyGrows(before: PolicyState, after: PolicyState): bool =
  after.auditHeight > before.auditHeight

pure def lawPausedPolicyBlocksSpend(s: PolicyState, amount: int, slippageBps: int): bool =
  s.paused implies not(canRecordSpend(s, amount, slippageBps))

pure def lawExcessiveSlippageRefused(s: PolicyState, amount: int, slippageBps: int): bool =
  slippageBps > s.maxSlippageBps implies not(canRecordSpend(s, amount, slippageBps))

pure def sometimesSpentAndReset(s: PolicyState): bool =
  s.auditHeight >= 2 and s.dailySpent == 0 and s.dailyTxCount == 0

pure def sometimesPausedPolicy(s: PolicyState): bool =
  s.paused and s.auditHeight >= 1

pure val amountValues = Set(0, 50, 250, 300)
pure val slippageBpsValues = Set(-1, 0, 50, 300, 500)
```
