// sanitizeSpawnEnv (packages/core/src/security/spawn-env-policy.ts) removes
// every BLOCKED_SPAWN_ENV_KEYS entry from the environment a spawn consumer
// hands to child_process (coding-tools processQueue and run-shell, the agent
// shell-execution-router and sandbox-engine). An untrusted overlay (config or
// API env, an MCP server env) may carry git helper-command variables:
// GIT_PROXY_COMMAND runs `<command> <host> <port>` for every git:// fetch, and
// GIT_EXEC_PATH names the directory git loads remote helpers such as
// git-remote-https from for every https fetch. GIT_SSH_COMMAND is an already
// blocked control, and GIT_AUTHOR_NAME is an ordinary key that must reach git.
// overlay: keys the untrusted overlay carries, each pointing at a planted
// script or directory. pending: the overlay changed since the last spawn.
// outcome: 0 no spawn yet, 1 git ran no planted helper, 2 a planted helper ran.
// child: the overlay keys the last spawned git received.
// last: the latest action, 0 none, 1 write, 2 fetchGit (git://),
// 3 fetchHttps (https).
module SpawnEnvGitHelpers {
  pure val KEYS = Set("GIT_PROXY_COMMAND", "GIT_EXEC_PATH", "GIT_SSH_COMMAND", "GIT_AUTHOR_NAME")
  pure val BLOCKED = Set("GIT_PROXY_COMMAND", "GIT_EXEC_PATH", "GIT_SSH_COMMAND")

  var overlay: Set[str]
  var pending: bool
  var outcome: int
  var child: Set[str]
  var last: int

  action init = all {
    overlay' = Set(), pending' = false, outcome' = 0, child' = Set(), last' = 0,
  }
  // A config, API or MCP env write adds one key to the untrusted overlay.
  action write = {
    nondet key = KEYS.oneOf()
    all {
      not(overlay.contains(key)),
      overlay' = overlay.union(Set(key)), pending' = true,
      outcome' = outcome, child' = child, last' = 1,
    }
  }
  // A spawned `git ls-remote git://…` with the sanitized environment.
  action fetchGit = {
    val sanitized = overlay.exclude(BLOCKED)
    all {
      overlay' = overlay, pending' = false,
      outcome' = if (sanitized.contains("GIT_PROXY_COMMAND")) 2 else 1,
      child' = sanitized, last' = 2,
    }
  }
  // A spawned `git ls-remote https://…` with the sanitized environment.
  action fetchHttps = {
    val sanitized = overlay.exclude(BLOCKED)
    all {
      overlay' = overlay, pending' = false,
      outcome' = if (sanitized.contains("GIT_EXEC_PATH")) 2 else 1,
      child' = sanitized, last' = 3,
    }
  }
  action fetch = any { fetchGit, fetchHttps }
  // Nothing happens: no write, and nobody has to run git.
  action stutter = all {
    overlay' = overlay, pending' = pending, outcome' = outcome,
    child' = child, last' = last,
  }
  action step = any { write, fetchGit, fetchHttps, stutter }

  val ModelState = {
    overlay: overlay, pending: pending, outcome: outcome, child: child,
    last: last,
  }
  // After an overlay write, a later git run uses it and runs nothing planted.
  temporal OverlayReachesCleanGitWithoutFairness =
    pending.leadsTo(not(pending) and outcome == 1)
  temporal OverlayReachesCleanGit = fetch.weakFair(ModelState)
    .implies(OverlayReachesCleanGitWithoutFairness)

  val NoPlantedHelperRuns = outcome != 2
  val HelperKeysNeverReachGit = child.intersect(BLOCKED) == Set()
  val OrdinaryKeysReachGit =
    not(Set(2, 3).contains(last)) or child == overlay.exclude(BLOCKED)
  val TypeOK =
    overlay.subseteq(KEYS) and child.subseteq(overlay) and
    Set(0, 1, 2).contains(outcome) and Set(0, 1, 2, 3).contains(last) and
    (outcome == 0 implies (child == Set() and not(Set(2, 3).contains(last)))) and
    (Set(2, 3).contains(last) implies (outcome != 0 and not(pending)))
}
