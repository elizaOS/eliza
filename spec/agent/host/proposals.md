# Runtime-management proposals

A runtime-management proposal is a file naming a runtime operation that a
consumer may carry out. Two consumers may race to claim it: a claim
renames the file atomically, and the claim is checked again after the
rename, so a proposal that expired or stopped matching in between is
never granted.

## Story: Claim a runtime-management proposal

> As the owner, when two consumers race for the same proposal, at most one
> is granted it, and never after it expired or stopped matching.

### At most one consumer is granted a proposal, and only after the claimed file is consumed

```quint
type ProposalFile = NoProposal | LiveProposal | ClaimedProposal | ConsumedProposal
type Proposals = { proposal: ProposalFile, proposalExpired: bool, proposalMatches: bool, checkedBy: Set[int], claimedBy: int, granted: Set[int] }
pure val initial: Proposals = { proposal: NoProposal, proposalExpired: false, proposalMatches: true, checkedBy: Set(), claimedBy: 0, granted: Set() }
pure val consumerValues = Set(1, 2)
pure def canCreateProposal(p: Proposals): bool = p.proposal == NoProposal
pure def createProposal(p: Proposals): Proposals = { ...p, proposal: LiveProposal }
pure def canExpireProposal(p: Proposals): bool = p.proposal != NoProposal and not(p.proposalExpired)
pure def expireProposal(p: Proposals): Proposals = { ...p, proposalExpired: true }
pure def canMismatchProposal(p: Proposals): bool = p.proposal != NoProposal and p.proposalMatches
pure def mismatchProposal(p: Proposals): Proposals = { ...p, proposalMatches: false }
pure def canCheckProposal(p: Proposals, consumer: int): bool = p.proposal == LiveProposal and not(p.proposalExpired) and p.proposalMatches and consumer > 0
pure def checkProposal(p: Proposals, consumer: int): Proposals = { ...p, checkedBy: p.checkedBy.union(Set(consumer)) }
pure def canClaimProposal(p: Proposals, consumer: int): bool = p.proposal == LiveProposal and p.checkedBy.contains(consumer)
pure def claimProposal(p: Proposals, consumer: int): Proposals = { ...p, proposal: ClaimedProposal, claimedBy: consumer }
pure def alwaysAtMostOneGrant(p: Proposals): bool =
  p.granted.size() <= 1 and (p.granted.size() > 0 implies p.proposal == ConsumedProposal and p.granted.contains(p.claimedBy))
```

### A claim is granted only if the proposal still matches and has not expired after the rename

```quint
pure def canValidateClaim(p: Proposals): bool = p.proposal == ClaimedProposal
pure def validateClaim(p: Proposals): Proposals =
  { ...p, proposal: ConsumedProposal, granted: if (p.proposalMatches and not(p.proposalExpired)) p.granted.union(Set(p.claimedBy)) else p.granted }
pure def canDiscardExpired(p: Proposals): bool = p.proposal == LiveProposal and p.proposalExpired
pure def discardExpired(p: Proposals): Proposals = { ...p, proposal: ConsumedProposal }
pure def stepGrantNeedsValidProposal(before: Proposals, after: Proposals): bool =
  after.granted.size() > before.granted.size() implies before.proposalMatches and not(before.proposalExpired)
pure def sometimesGranted(p: Proposals): bool = p.granted.size() == 1
pure def sometimesExpiredAfterCheckNotGranted(p: Proposals): bool = p.proposal == ConsumedProposal and p.granted.size() == 0 and p.checkedBy.size() > 0
```
