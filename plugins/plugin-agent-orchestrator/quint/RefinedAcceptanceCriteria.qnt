// OrchestratorTaskService.createTask gives a task created without acceptance
// criteria the criteria of generateDefaultAcceptanceCriteria
// (plugins/plugin-agent-orchestrator/src/services/acceptance-criteria.ts).
// It hands one model call the goal and the baseline template of the task's
// kind and asks it to keep the template lines that still apply and add checks
// for the goal. The answer keeps every criterion except one that names a file
// that neither the goal nor the template names, then tops the set up from the
// template to at least three lines. A failed answer, or one with no criteria,
// gives the template itself.
// kind: 0 coding (four template lines), 1 app-build, 2 view-create and
// 3 deploy (three lines each). Every goal names one file the worker changes.
// An answer lists the template lines it keeps (in template order), zero to
// two checks for the goal that name no file, and then at most one criterion
// that names a file: file 1 the goal's file, file 2 a file nobody named.
// Criterion ids: 0-3 template line i of the task's kind, 10 and 11 the goal
// checks, 20 the goal's file, 21 the file nobody named.
// phase: 0 the task is being created, 1 its criteria are stored.
module RefinedAcceptanceCriteria {
  pure val Kinds = 0.to(3)
  pure val Floor = 3
  pure val GoalFile = 20
  pure val UnnamedFile = 21
  type Answer = { answered: bool, keep: Set[int], checks: int, file: int }
  pure val NoAnswer: Answer = { answered: false, keep: Set(), checks: 0, file: 0 }

  var kind: int
  var answer: Answer
  var phase: int
  var criteria: List[int]

  pure def has(list: List[int], value: int): bool =
    list.indices().exists(i => list[i] == value)
  pure def lines(k: int): Set[int] = if (k == 0) 0.to(3) else 0.to(2)
  pure def template(k: int): List[int] = if (k == 0) range(0, 4) else range(0, 3)
  // The criteria of an answer in the order the model lists them.
  pure def listed(k: int, a: Answer): List[int] =
    template(k).select(i => a.keep.contains(i))
      .concat([10, 11].slice(0, a.checks))
      .concat(if (a.file == 0) [] else [19 + a.file])
  // Adds template lines in order until the set has at least three.
  pure def topUp(k: int, list: List[int]): List[int] =
    template(k).foldl(list, (out, i) =>
      if (out.length() >= Floor or has(out, i)) out else out.append(i))
  pure def stored(k: int, a: Answer): List[int] =
    if (not(a.answered) or listed(k, a).length() == 0) template(k)
    else topUp(k, listed(k, a).select(c => c != UnnamedFile))

  action init = {
    nondet chosen = Kinds.oneOf()
    all { kind' = chosen, answer' = NoAnswer, phase' = 0, criteria' = [] }
  }
  // The model answers with a list of criteria.
  action refine = {
    nondet keep = lines(kind).powerset().oneOf()
    nondet checks = 0.to(2).oneOf()
    nondet file = 0.to(2).oneOf()
    val a = { answered: true, keep: keep, checks: checks, file: file }
    all {
      phase == 0,
      kind' = kind, answer' = a, phase' = 1, criteria' = stored(kind, a)
    }
  }
  // The model call fails or returns no usable JSON.
  action failAnswer = all {
    phase == 0,
    kind' = kind, answer' = NoAnswer, phase' = 1, criteria' = template(kind)
  }
  action create = any { refine, failAnswer }
  // The model call may still be running.
  action stutter = all {
    kind' = kind, answer' = answer, phase' = phase, criteria' = criteria
  }
  action step = any { refine, failAnswer, stutter }

  val ModelState = { kind: kind, answer: answer, phase: phase, criteria: criteria }
  temporal CriteriaStoredWithoutFairness = (phase == 0).leadsTo(phase == 1)
  temporal CriteriaStored = create.weakFair(ModelState)
    .implies(CriteriaStoredWithoutFairness)

  // A template line the model kept is never dropped as an unnamed file.
  val KeptTemplateLinesStay =
    phase == 0 or not(answer.answered) or answer.keep.forall(i => has(criteria, i))
  val GoalChecksStay =
    phase == 0 or not(answer.answered) or
    [10, 11].slice(0, answer.checks).indices().forall(i => has(criteria, 10 + i))
  val GoalFileStays =
    phase == 0 or not(answer.answered) or answer.file != 1 or has(criteria, GoalFile)
  val UnnamedFileDropped = not(has(criteria, UnnamedFile))
  val FailedAnswerUsesTemplate =
    phase == 0 or answer.answered or criteria == template(kind)
  val AtLeastThree = phase == 0 or criteria.length() >= Floor
  val NoDuplicates =
    criteria.indices().forall(i => criteria.indices().forall(j => i == j or criteria[i] != criteria[j]))
  val TypeOK = and {
    Kinds.contains(kind),
    Set(0, 1).contains(phase),
    answer.checks.in(0.to(2)),
    answer.file.in(0.to(2)),
    answer.keep.subseteq(0.to(3)),
    phase == 0 implies (criteria.length() == 0 and answer == NoAnswer),
    criteria.indices().forall(i => Set(0, 1, 2, 3, 10, 11, GoalFile, UnnamedFile).contains(criteria[i])),
  }
}
