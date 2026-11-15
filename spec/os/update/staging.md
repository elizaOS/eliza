# System updater staging

A product may include the inactive [system updater](./updater.md) in its
image by setting the descriptor's updater flag; the flag is a boolean,
and enrollment is never a staging option. Staging copies the updater's
reviewed sources, including its SELinux policy and permission allow-lists,
into the product's staging transaction. Activation is a separate
enrollment gate: a staged updater with the generic configuration disables
every entry point and schedules nothing.

## Story: Include the system updater in a product image only when selected and enrolled

> As a consumer, I want the system updater in my image only when I ask for
> it, staged from reviewed sources with its policy, and active only after
> my device is enrolled in an update channel, so that an image never
> carries an updater that installs from nowhere.

### The updater is staged only when selected, admitted with its policy, and free of collisions

The consumer selects the updater explicitly. Admission checks every
reviewed source digest, including the SELinux policy and the permission
allow-lists. A collision with an existing file of the staging transaction
refuses staging and leaves the existing file. An updater the consumer did
not select is never staged, so its absence installs nothing. A staged
updater is published with the rest of the transaction.

```quint
type UpdaterStaging = { selected: bool, admitted: bool, collision: bool, staged: bool, published: bool, enrolled: bool, enabled: bool }
pure val initial: UpdaterStaging = { selected: false, admitted: false, collision: false, staged: false, published: false, enrolled: false, enabled: false }
pure def canSelectUpdater(s: UpdaterStaging): bool = not(s.staged) and not(s.published)
pure def selectUpdater(s: UpdaterStaging): UpdaterStaging = { ...s, selected: true }
pure def canAdmitSources(s: UpdaterStaging, sourcesMatch: bool, policyPresent: bool): bool = s.selected and not(s.staged) and sourcesMatch and policyPresent
pure def admitSources(s: UpdaterStaging, sourcesMatch: bool, policyPresent: bool): UpdaterStaging = { ...s, admitted: true }
pure def canCollide(s: UpdaterStaging): bool = not(s.staged)
pure def collide(s: UpdaterStaging): UpdaterStaging = { ...s, collision: true }
pure def canStageUpdater(s: UpdaterStaging): bool = s.selected and s.admitted and not(s.collision) and not(s.staged)
pure def stageUpdater(s: UpdaterStaging): UpdaterStaging = { ...s, staged: true }
pure def canPublishStaging(s: UpdaterStaging): bool = s.staged and s.admitted and not(s.collision) and not(s.published)
pure def publishStaging(s: UpdaterStaging): UpdaterStaging = { ...s, published: true }
pure def alwaysStagedOnlyWhenAdmitted(s: UpdaterStaging): bool =
  (s.staged implies s.selected and s.admitted and not(s.collision)) and (s.published implies s.staged)
pure def sometimesUpdaterPublished(s: UpdaterStaging): bool = s.published and not(s.enabled)
pure def sometimesCollisionRefusesStaging(s: UpdaterStaging): bool = s.selected and s.collision and not(s.staged)
```

### A staged updater stays inactive until the device is enrolled

Staging and publication never enable the updater. Only an enrollment of a
published updater in an update channel lets it be activated.

```quint
pure def canEnroll(s: UpdaterStaging): bool = s.published and not(s.enrolled)
pure def enroll(s: UpdaterStaging): UpdaterStaging = { ...s, enrolled: true }
pure def canActivate(s: UpdaterStaging): bool = s.enrolled and not(s.enabled)
pure def activate(s: UpdaterStaging): UpdaterStaging = { ...s, enabled: true }
pure def alwaysEnabledOnlyWhenEnrolled(s: UpdaterStaging): bool = (s.enabled implies s.enrolled and s.published) and (s.enrolled implies s.published)
pure def stepStagingNeverEnables(before: UpdaterStaging, via: str, after: UpdaterStaging): bool =
  (via == "selectUpdater" or via == "admitSources" or via == "stageUpdater" or via == "publishStaging") implies after.enabled == before.enabled
pure def sometimesEnrolledUpdaterActive(s: UpdaterStaging): bool = s.enabled
```

### A staged updater is eventually published

Publication is the staging run's own step and is assumed fair. A
collision is found before staging, never after it.

```quint
pure val fair_publishStaging = "weak"
pure def leadsToUpdaterPublished(s: UpdaterStaging, later: UpdaterStaging): bool =
  (s.staged and s.admitted and not(s.collision)) implies later.published
```
