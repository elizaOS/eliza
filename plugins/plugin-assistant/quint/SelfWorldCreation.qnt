module SelfWorldCreation {
  var scenario: int
  var phase: int
  var worldExists: bool
  var storedCount: int
  var metadataKept: bool
  action init = {
    nondet choice = Set(0, 1).oneOf()
    all { scenario' = choice, phase' = 0, worldExists' = choice == 1, storedCount' = 0, metadataKept' = true }
  }
  action ensureWorld = all {
    phase == 0, phase' = 1, scenario' = scenario,
    worldExists' = true, storedCount' = storedCount, metadataKept' = metadataKept
  }
  action store = all {
    phase == 1, phase' = 2, scenario' = scenario, worldExists' = worldExists,
    storedCount' = if (scenario == 0) 2 else 1, metadataKept' = metadataKept
  }
  action done = all {
    phase == 2, phase' = phase, scenario' = scenario, worldExists' = worldExists,
    storedCount' = storedCount, metadataKept' = metadataKept
  }
  action step = any { ensureWorld, store, done }
  val StorageHasWorld = storedCount == 0 or worldExists
  val PreservesWorldMetadata = metadataKept
  val BothConcurrentSecretsPersist = phase != 2 or storedCount == (if (scenario == 0) 2 else 1)
}
