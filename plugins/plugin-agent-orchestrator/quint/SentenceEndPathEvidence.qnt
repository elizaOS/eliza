// OrchestratorTaskService.collectEvidenceBundle
// (plugins/plugin-agent-orchestrator/src/services/orchestrator-task-service.ts)
// recovers completion evidence for a session without a write ledger: it mines
// file paths from the task_complete summary and the sub-agent's stdout
// messages with mineCandidatePaths
// (plugins/plugin-agent-orchestrator/src/services/quick-app-evidence.ts),
// stats each candidate inside the session workdir, and lists a file written
// after the session started in fsVerifiedFiles.
// One session writes data/apps/echo-fade/index.html and names it once in one
// reply. The path is followed by a mark and then by what comes after it.
// mark: 0 none, 1 ".", 2 ":", 3 ";", 4 "!", 5 "?", 6 "...".
// after: 0 the end of the reply, 1 a space and the next sentence, 2 a newline
// and the next line, 3 ")" (the path opened with "("), 4 a closing double
// quote (the path opened with one), 5 more name characters ("bak"), so the
// reply names a longer file that does not exist.
// form: 0 workdir-relative, 1 absolute inside the workdir.
// channel: 0 the task_complete summary, 1 a sub-agent stdout message.
// phase: 0 the session completed and the evidence is not built yet,
// 1 the evidence bundle is built.
module SentenceEndPathEvidence {
  pure val Marks = 0.to(6)
  pure val Afters = 0.to(5)
  pure val RunsOn = 5
  type Reply = { mark: int, after: int, form: int, channel: int }

  var reply: Reply
  var phase: int
  var observed: bool

  // The path token ends where the written file's name ends, whatever
  // sentence punctuation follows it.
  pure def namesFile(r: Reply): bool = r.after != RunsOn

  action init = {
    nondet mark = Marks.oneOf()
    nondet after = Afters.oneOf()
    nondet form = 0.to(1).oneOf()
    nondet channel = 0.to(1).oneOf()
    all {
      reply' = { mark: mark, after: after, form: form, channel: channel },
      phase' = 0,
      observed' = false,
    }
  }
  // collectEvidenceBundle builds the bundle once.
  action collect = all {
    phase == 0,
    reply' = reply,
    phase' = 1,
    observed' = namesFile(reply),
  }
  // The completion handler may not have built the bundle yet.
  action stutter = all { reply' = reply, phase' = phase, observed' = observed }
  action step = any { collect, stutter }

  val ModelState = { reply: reply, phase: phase, observed: observed }
  temporal EvidenceBuiltWithoutFairness = (phase == 0).leadsTo(phase == 1)
  temporal EvidenceBuilt = collect.weakFair(ModelState)
    .implies(EvidenceBuiltWithoutFairness)

  // A file named at the end of a sentence is still observed.
  val SentencePunctuationKeepsFile =
    phase == 0 or reply.after == RunsOn or observed
  // A longer name is never cut down to the written file.
  val LongerNameNotObserved =
    phase == 0 or reply.after != RunsOn or not(observed)
  val NothingObservedBeforeCollect = phase == 1 or not(observed)
  val TypeOK = and {
    Marks.contains(reply.mark),
    Afters.contains(reply.after),
    Set(0, 1).contains(reply.form),
    Set(0, 1).contains(reply.channel),
    Set(0, 1).contains(phase),
  }
}
