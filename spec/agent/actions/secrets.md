# Secrets and plugin activation

The owner gives the agent secrets, such as an API key for a plugin, through
the secret actions. Only the owner sets or deletes a secret, each name holds
one value, and listing shows names and a mask, never a value. A plugin that
needs a secret it does not have yet waits: the plugin activator polls for
its requirements and activates the plugin once they are present. Stopping
the activator retires its timer and polls, so a late answer cannot activate
a plugin after stop; a callback that already began may still finish. Device
credential storage is in [auth secure slots](../../auth/secureSlots.md).

## Story: Keep the owner's secrets

> As the owner, I tell my agent a key once; only I can change or remove
> it, and it is never shown back to anyone in full.

### Only the owner sets or deletes a secret, and each name holds one value

Names are public and values are kept apart from them, so no decision and
no listing is computed from a value.

```quint
type SecretValue = str
type Activation = Idle | Scheduled | Running | Finished | Cancelled
type RegistrationPhase = NotRegistered | Checking | Registered | Retired | CheckFailed
type PollPhase = PollIdle | Polling | Activating
type ActivatorPhase = Open | Stopping | Stopped
type Secrets = { names: List[str], values: str -> SecretValue, listed: List[ListedSecret], required: str, phase: ActivatorPhase, generation: int, registration: RegistrationPhase, registrationGeneration: int, pending: bool, timer: bool, poll: PollPhase, pollGeneration: int, pollFailures: int, activation: Activation, callbacks: int, lateCallback: bool }
pure val ownerId = 1
pure val initial: Secrets = { names: List(), values: Map(), listed: List(), required: "apiKey", phase: Open, generation: 0, registration: NotRegistered, registrationGeneration: -1, pending: false, timer: false, poll: PollIdle, pollGeneration: -1, pollFailures: 0, activation: Idle, callbacks: 0, lateCallback: false }
pure val nameValues = Set("apiKey", "token")
pure val valueValues = Set("v1", "v2")
pure val actorValues = Set(1, 2)
pure def holds(s: Secrets, name: str): bool = s.names.includes(name)
pure def canSetSecret(s: Secrets, actor: int, name: str, value: SecretValue): bool = actor == ownerId and name != ""
pure def setSecret(s: Secrets, actor: int, name: str, value: SecretValue): Secrets =
  { ...s, names: if (s.names.includes(name)) s.names else s.names.append(name), values: s.values.put(name, value) }
pure def canDeleteSecret(s: Secrets, actor: int, name: str): bool = actor == ownerId and holds(s, name)
pure def deleteSecret(s: Secrets, actor: int, name: str): Secrets = { ...s, names: s.names.select(n => n != name), values: s.values.put(name, "") }
pure def stepNamesChangeOnlyBySecretActions(before: Secrets, via: str, after: Secrets): bool =
  (via != "setSecret" and via != "deleteSecret") implies (after.names == before.names)
pure def alwaysOneValuePerName(s: Secrets): bool = s.names.every(n => n != "" and s.names.select(m => m == n).length() == 1)
pure def sometimesTwoSecretsHeld(s: Secrets): bool = s.names.length() == 2
```

### Listing shows names and a mask, never a value

Each held name is listed with the same fixed mask in place of its value.

```quint
type ListedSecret = { name: str, mask: str }
pure def declassifyMasked(value: SecretValue): str = "****"
pure def heldValue(s: Secrets, name: str): SecretValue = if (s.values.keys().contains(name)) s.values.get(name) else ""
pure def maskedListing(s: Secrets): List[ListedSecret] =
  s.names.foldl(List(), (entries, n) => entries.append({ name: n, mask: declassifyMasked(heldValue(s, n)) }))
pure def listSecrets(s: Secrets): Secrets = { ...s, listed: maskedListing(s) }
pure def alwaysListingShowsOnlyNames(s: Secrets): bool = s.listed.every(e => e.name != "" and e.mask == "****")
pure def stepListingIsExactlyTheHeldNames(before: Secrets, via: str, after: Secrets): bool =
  via == "listSecrets" implies after.listed == maskedListing(before)
pure def sometimesListed(s: Secrets): bool = s.listed.length() > 0
```

## Story: Activate a plugin when its secrets arrive

> As the owner, a plugin waiting for a key starts working as soon as I give
> the key, and once I stop the agent nothing activates behind my back.

### A registration checks the plugin's requirements in the generation that began it

```quint
pure def canRegisterPlugin(s: Secrets): bool = s.phase == Open and s.registration == NotRegistered
pure def registerPlugin(s: Secrets): Secrets = { ...s, registration: Checking, registrationGeneration: s.generation }
pure def canRequirementsChecked(s: Secrets): bool = s.registration == Checking
pure def requirementsChecked(s: Secrets): Secrets =
  if (s.phase != Open or s.registrationGeneration != s.generation) { ...s, registration: Retired }
  else if (holds(s, s.required)) { ...s, registration: Registered, activation: Scheduled }
  else { ...s, registration: Registered, pending: true, timer: true }
pure def canRequirementsFailed(s: Secrets): bool = s.registration == Checking
pure def requirementsFailed(s: Secrets): Secrets = { ...s, registration: CheckFailed }
pure def alwaysRetiredActivatorHasNoTimer(s: Secrets): bool = s.phase != Open implies not(s.timer)
pure def sometimesLateRegistrationRetired(s: Secrets): bool = s.registration == Retired and s.phase == Stopped
```

### A poll activates the plugin only while the activator is open and in the generation that began the poll

A failed poll is retried once by the next timer tick.

```quint
pure val weight_pollRequirements = 4
pure val weight_pollAnswered = 4
pure def canPollRequirements(s: Secrets): bool = s.phase == Open and s.timer and s.poll == PollIdle
pure def pollRequirements(s: Secrets): Secrets = if (s.pending) { ...s, poll: Polling, pollGeneration: s.generation } else { ...s, timer: false }
pure def canPollAnswered(s: Secrets): bool = s.poll == Polling
pure def pollAnswered(s: Secrets): Secrets =
  if (s.phase != Open or s.pollGeneration != s.generation or not(s.pending)) { ...s, poll: PollIdle, timer: false }
  else if (holds(s, s.required)) { ...s, poll: Activating, activation: Scheduled }
  else { ...s, poll: PollIdle }
pure def canPollFailed(s: Secrets): bool = s.poll == Polling and s.pollFailures == 0
pure def pollFailed(s: Secrets): Secrets = { ...s, poll: PollIdle, pollFailures: 1 }
pure def canActivationSettled(s: Secrets): bool = s.poll == Activating and (s.activation == Finished or s.activation == Cancelled)
pure def activationSettled(s: Secrets): Secrets = { ...s, poll: PollIdle, timer: s.phase == Open and s.pending }
pure def canUnregister(s: Secrets): bool = s.phase == Open and s.pending and s.activation != Running
pure def unregister(s: Secrets): Secrets = { ...s, pending: false }
pure def sometimesActivatedAfterSecretArrived(s: Secrets): bool = s.poll == Activating and s.activation != Idle
```

### A scheduled activation checks again that the activator is open, so no callback starts after stop

```quint
pure def canDispatchActivation(s: Secrets): bool = s.activation == Scheduled
pure def dispatchActivation(s: Secrets): Secrets =
  if (s.phase == Open) { ...s, activation: Running, callbacks: s.callbacks + 1, lateCallback: s.lateCallback or s.phase != Open }
  else { ...s, activation: Cancelled }
pure def canActivationDone(s: Secrets): bool = s.activation == Running
pure def activationDone(s: Secrets): Secrets = { ...s, activation: Finished, pending: false }
pure def alwaysNoCallbackAfterStop(s: Secrets): bool = not(s.lateCallback) and s.callbacks <= 1
pure def sometimesBegunCallbackFinishedDuringStop(s: Secrets): bool = s.phase == Stopped and s.callbacks == 1
```

### Stop retires the timer at once and finishes only when no poll or activation is in flight

```quint
pure def canStopActivator(s: Secrets): bool = s.phase == Open
pure def stopActivator(s: Secrets): Secrets = { ...s, phase: Stopping, generation: s.generation + 1, timer: false }
pure def canFinishStop(s: Secrets): bool = s.phase == Stopping and s.poll == PollIdle and s.activation != Scheduled and s.activation != Running
pure def finishStop(s: Secrets): Secrets = { ...s, phase: Stopped, pending: false }
pure def alwaysStoppedReleasesEverything(s: Secrets): bool =
  s.phase == Stopped implies not(s.pending) and s.poll == PollIdle and s.activation != Scheduled and s.activation != Running
```
