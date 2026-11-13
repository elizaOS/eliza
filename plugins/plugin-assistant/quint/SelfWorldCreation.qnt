module SelfWorldCreation {
  var scenario: int
  var phase: int
  var worldExists: bool
  var keys: int
  var metadataKept: bool
  action init = {
    nondet choice = Set(0, 1).oneOf()
    all { scenario' = choice, phase' = 0, worldExists' = choice == 1, keys' = 0, metadataKept' = true }
  }
  action ensureWorld = all {
    phase == 0, phase' = 1, scenario' = scenario,
    worldExists' = true, keys' = keys, metadataKept' = metadataKept
  }
  action store = all {
    phase == 1, phase' = 2, scenario' = scenario, worldExists' = worldExists,
    keys' = if (scenario == 0) 2 else 1, metadataKept' = metadataKept
  }
  action done = all {
    phase == 2, phase' = phase, scenario' = scenario, worldExists' = worldExists,
    keys' = keys, metadataKept' = metadataKept
  }
  action step = any { ensureWorld, store, done }
  val StorageHasWorld = keys == 0 or worldExists
  val PreservesWorldMetadata = metadataKept
  val BothConcurrentSecretsPersist = phase != 2 or keys == (if (scenario == 0) 2 else 1)
}
