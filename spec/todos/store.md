# To-do store validation and boundaries

Boundary validation rules for batch writes, scoped room mutations, list limits,
and content-matching precedence shared by the `TODO` action and durable store.

## Story: Reject invalid batch writes and keep list queries bounded

> As an owner, I want batch todo writes to refuse duplicate identifiers or
> missing room scope, and list queries to enforce positive limits.

### Batch writes reject duplicate identifiers and missing room scope

Replacing or clearing a room's todo list requires a valid room identifier and
non-empty trimmed item content for every item, with no duplicate item
identifiers in the batch.

```quint
type TodoBatchOp = BatchWrite | BatchClear | BatchCreate | BatchList
pure def roomScopeValid(op: TodoBatchOp, hasValidRoom: bool): bool =
  if (op == BatchWrite or op == BatchClear) hasValidRoom else true
pure def batchWriteAdmitted(hasValidRoom: bool, allNonEmpty: bool, hasDuplicateId: bool): bool =
  hasValidRoom and allNonEmpty and not(hasDuplicateId)
pure def lawDuplicateBatchIdIsRefused(hasValidRoom: bool, allNonEmpty: bool): bool =
  not(batchWriteAdmitted(hasValidRoom, allNonEmpty, true))
pure def lawWriteAndClearRequireRoom(op: TodoBatchOp): bool =
  (op == BatchWrite or op == BatchClear) implies not(roomScopeValid(op, false))
```

### List limits must be positive integers and exact matches outrank paraphrases

An explicit list limit must be at least one; zero or negative limits are
refused. When resolving a user-visible target phrase, exact normalized matches
outrank same-token matches, which outrank paraphrase matches, and within the
same stage open items outrank closed items.

```quint
type MatchStage = StageExact | StageSameTokens | StageParaphrase | StageNone
pure def validListLimit(limit: int): bool = limit >= 1
pure def stageRank(stage: MatchStage): int = match stage {
  | StageExact => 3
  | StageSameTokens => 2
  | StageParaphrase => 1
  | StageNone => 0
}
pure def winningStage(exactCount: int, tokenCount: int, paraphraseCount: int): MatchStage =
  if (exactCount > 0) StageExact
  else if (tokenCount > 0) StageSameTokens
  else if (paraphraseCount > 0) StageParaphrase
  else StageNone
pure val exactCountValues = Set(0, 1, 2)
pure val tokenCountValues = Set(0, 1, 2)
pure val paraphraseCountValues = Set(0, 1, 2)
pure val limitValues = Set(-1, 0, 1, 25)
pure def lawNonPositiveLimitIsRefused(limit: int): bool =
  limit <= 0 implies not(validListLimit(limit))
pure def lawExactMatchAlwaysOutranksWeakerStages(exactCount: int, tokenCount: int, paraphraseCount: int): bool =
  exactCount > 0 implies winningStage(exactCount, tokenCount, paraphraseCount) == StageExact
pure def lawStageRankOrderPreserved(stage: MatchStage): bool =
  stageRank(stage) >= 0 and (stage == StageExact implies stageRank(stage) == 3) and (stage == StageNone implies stageRank(stage) == 0)
```
