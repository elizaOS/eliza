# Notes list filter

The agent can propose a filter for the owner's canonical Notes list. A
filter only changes what the list shows: it never moves, edits or
deletes a note. It applies only to the exact list the owner reviewed it
on, and only when the agent advertised the capability. The editor, Trash and private views are never filtered this way. The
proposal travels as a [device action](../agent/deviceActions/capabilities.md).

## Story: Let the agent narrow my Notes list only after I review it

> As the owner, I want the agent's suggested filter to change only the
> Notes list I reviewed it on, and to be refused anywhere else.

### A filter proposal is admitted only for the canonical list with the capability and a valid filter

A proposal is admitted only while the owner is current, the open view
is the canonical Notes list, the agent advertised the filter capability
and the filter is valid. A filter that would choose a folder or change
a note is not valid. Anything else ends the proposal without a review.

```quint
type NotesScope = CanonicalList | EditorOrTrash | PrivateView
type FilterPhase = FilterProposed | FilterReviewed | FilterEnded
type ListFilter = { phase: FilterPhase, started: bool, scope: NotesScope, epoch: int, reviewedEpoch: int, currentOwner: bool,
  capable: bool, validFilter: bool, proposalAdmitted: bool, applied: bool }
pure val initial: ListFilter = { phase: FilterProposed, started: false, scope: CanonicalList, epoch: 0, reviewedEpoch: -1,
  currentOwner: true, capable: true, validFilter: true, proposalAdmitted: false, applied: false }
pure def filterAllowed(s: ListFilter): bool = s.currentOwner and s.scope == CanonicalList and s.capable and s.validFilter
pure def canPropose(s: ListFilter): bool = s.phase == FilterProposed and not(s.started)
pure def propose(s: ListFilter, scope: NotesScope, capable: bool, validFilter: bool): ListFilter = {
  val asked = { ...s, started: true, scope: scope, capable: capable, validFilter: validFilter }
  { ...asked, proposalAdmitted: filterAllowed(asked), phase: if (filterAllowed(asked)) FilterProposed else FilterEnded }
}
pure def alwaysDisallowedInputNeverApplies(s: ListFilter): bool = not(s.validFilter) implies not(s.applied)
pure def sometimesRefusedProposal(s: ListFilter): bool = s.phase == FilterEnded and s.started and not(s.proposalAdmitted)
```

### A reviewed filter applies only to the same list it was reviewed on

The owner reviews an admitted proposal; the review records which list
it saw. Moving to another view and back before it applies makes a new
list. The filter
applies only if it is still allowed and the list is the one reviewed;
otherwise it ends without applying. An ended proposal never applies
again.

```quint
pure def canReviewFilter(s: ListFilter): bool = s.phase == FilterProposed and s.proposalAdmitted
pure def reviewFilter(s: ListFilter): ListFilter =
  if (filterAllowed(s)) { ...s, phase: FilterReviewed, reviewedEpoch: s.epoch } else { ...s, phase: FilterEnded }
pure def canApplyFilter(s: ListFilter): bool = s.phase == FilterReviewed
pure def applyFilter(s: ListFilter): ListFilter = { ...s, phase: FilterEnded, applied: filterAllowed(s) and s.reviewedEpoch == s.epoch }
pure def canMoveScope(s: ListFilter, scope: NotesScope): bool = s.started and s.phase != FilterEnded and s.scope != scope
pure def moveScope(s: ListFilter, scope: NotesScope): ListFilter = { ...s, scope: scope, epoch: s.epoch + 1 }
pure def canRetireOwner(s: ListFilter): bool = s.currentOwner
pure def retireOwner(s: ListFilter): ListFilter = { ...s, currentOwner: false }
pure def canDowngrade(s: ListFilter): bool = s.capable
pure def downgrade(s: ListFilter): ListFilter = { ...s, capable: false }
pure def alwaysOnlyExactListApplies(s: ListFilter): bool =
  s.applied implies s.proposalAdmitted and s.phase == FilterEnded and s.reviewedEpoch == s.epoch and s.scope == CanonicalList
pure def stepEndedNeverReapplies(before: ListFilter, after: ListFilter): bool =
  before.phase == FilterEnded implies after.phase == FilterEnded and after.applied == before.applied
pure def sometimesApplied(s: ListFilter): bool = s.applied
pure def sometimesChangedListRefused(s: ListFilter): bool = s.phase == FilterEnded and s.reviewedEpoch >= 0 and not(s.applied)
pure val fair_propose = "weak"
pure val fair_reviewFilter = "weak"
pure val fair_applyFilter = "weak"
pure def leadsToFilterSettles(s: ListFilter, later: ListFilter): bool = later.phase == FilterEnded
```
