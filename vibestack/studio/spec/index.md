# Spec Studio

A local page for building an application from its stories. A person edits
the stories and rules of a project's specs, publishes them, has an agent
bring the rules and Quint in step, checks, and signs off. This spec is the
session around that work: what may happen when. Editing one spec is
[the outline](./outline.md).

The [component catalog](./components.md) shows the project's reusable
components and selects which story to preview.

The session is shared by the page, which knows whether there are edits not
yet published, and the server, which runs one job at a time, remembers
what the last check found, and runs the application beside them.

## Domain

### A session

`waiting` is how many published changes the agent has not synced yet: the
length of the manifest. The verdict is what the last finished check found.
It is unknown while a check runs and once the specs change, until a check
finishes. A check that was already running when they changed reports on what
it read; a sign-off checks again before it records anything (`pnpm accept`),
so nothing unchecked is signed off. `previewing` is whether the project's app is
running beside the studio.

```quint
type Job = Idle | Checking | Syncing | SigningOff | Building
type Verdict = Unknown | Failing | Reviewable | Green
type Session = { unpublished: bool, waiting: int, job: Job, verdict: Verdict, previewing: bool }
```

### A new session has nothing to do

```quint
pure val initial: Session = { unpublished: false, waiting: 0, job: Idle, verdict: Unknown, previewing: false }
```

### What the simulator tries

```quint
pure val changesValues = Set(0, 1, 3)
```

## Story: Edit, then publish

> As a spec author, I want my edits kept in the page until I publish them,
> and publishing to hand them to the agent and check them, so that nothing
> half-done reaches the specs and nothing published goes unchecked.

### Edits stay in the page until they are published or discarded

```quint
pure def edit(s: Session): Session = { ...s, unpublished: true }
pure def canDiscard(s: Session): bool = s.unpublished
pure def discard(s: Session): Session = { ...s, unpublished: false }
pure def stepEditsLeaveOnlyByPublishOrDiscard(before: Session, via: str, after: Session): bool =
  (before.unpublished and not(after.unpublished)) implies (via == "publish" or via == "discard")
```

### Only edits can be published, and not while a job runs

Publishing writes the specs that changed, records how many changes now wait
for the agent, and starts a check.

```quint
pure def canPublish(s: Session, changes: int): bool = s.unpublished and s.job == Idle and changes >= 0
pure def publish(s: Session, changes: int): Session =
  { ...s, unpublished: false, waiting: changes, job: Checking, verdict: Unknown }
```

### Publishing always starts a check

It also leaves no edit unpublished.

```quint
pure def stepPublishingChecks(before: Session, via: str, after: Session): bool =
  via == "publish" implies (after.job == Checking and not(after.unpublished))
```

### Edits can wait in the page while a check runs

```quint
pure def sometimesEditingWhileChecking(s: Session): bool = s.unpublished and s.job == Checking
```

### A change to the specs on disk makes the last verdict unknown

An agent or an editor may change a spec while the page is open.

```quint
pure def touch(s: Session): Session = { ...s, verdict: Unknown }
```

## Story: Sync with an agent

> As a spec author, I want an agent to bring the rules and Quint in step with
> what I published, and to see when that is done, so that I review a spec
> that checks rather than one in pieces.

### An agent syncs only what is published, and not while a job runs

```quint
pure def canSync(s: Session): bool = not(s.unpublished) and s.job == Idle
pure def sync(s: Session): Session = { ...s, job: Syncing }
```

### A sync that ends well leaves nothing waiting and checks again

A sync that fails leaves what was waiting and starts no check; what the agent
did leaves the verdict unknown either way.

```quint
pure def canSynced(s: Session): bool = s.job == Syncing
pure def synced(s: Session, ok: bool): Session =
  if (ok) { ...s, waiting: 0, job: Checking, verdict: Unknown }
  else { ...s, job: Idle, verdict: Unknown }
```

### What is waiting can be marked as synced by hand, when no job runs

For a sync done outside the studio.

```quint
pure def canMarkSynced(s: Session): bool = s.job == Idle and s.waiting > 0
pure def markSynced(s: Session): Session = { ...s, waiting: 0 }
```

### What is waiting goes down only by a sync, by hand, or by publishing what undoes a change

What waits is measured against the specs as last synced, so publishing an
edit that puts a story back as it was leaves less to sync.

```quint
pure def stepWaitingGoesDownOnlyBySyncOrUndo(before: Session, via: str, after: Session): bool =
  (after.waiting < before.waiting) implies (via == "synced" or via == "markSynced" or via == "publish")
```

### A studio that starts again picks up what was waiting

It does so once, as a fresh session: with no job running and nothing yet
waiting.

```quint
pure def canResume(s: Session, changes: int): bool = s.job == Idle and s.waiting == 0 and changes >= 0
pure def resume(s: Session, changes: int): Session = { ...s, waiting: changes }
```

### A sync of published changes can be under way

```quint
pure def sometimesSyncing(s: Session): bool = s.job == Syncing and s.waiting > 0
```

## Story: Check

> As a spec author, I want to check the project whenever I like and see what
> the check found, so that I know what is left to do.

### A check can start whenever no job runs

```quint
pure def canCheck(s: Session): bool = s.job == Idle
pure def check(s: Session): Session = { ...s, job: Checking, verdict: Unknown }
```

### A finished check gives its verdict

`Reviewable` means only review is left and every story has rules and every
rule has Quint, so the review can be recorded.

```quint
pure def canChecked(s: Session, verdict: Verdict): bool = s.job == Checking and verdict != Unknown
pure def checked(s: Session, verdict: Verdict): Session = { ...s, job: Idle, verdict: verdict }
```

### A running job can be stopped, and then nothing is known of its result

```quint
pure def canStop(s: Session): bool = s.job != Idle
pure def stop(s: Session): Session = { ...s, job: Idle, verdict: Unknown }
```

### While a check runs, its verdict is unknown

```quint
pure def alwaysNoVerdictWhileChecking(s: Session): bool = s.job == Checking implies s.verdict == Unknown
```

### A job starts only when none is running

Except that one job's end starts the next: a sync that ends well, and a
sign-off, each start a check.

```quint
pure def stepOneJobAtATime(before: Session, via: str, after: Session): bool =
  (before.job != Idle and after.job != Idle and after.job != before.job)
    implies (via == "synced" or via == "signedOff")
```

### A check can find everything green

```quint
pure def sometimesGreen(s: Session): bool = s.verdict == Green
```

## Story: Sign off

> As a spec author, I want to record my review once only review is left, so
> that the spec I sign off is the one that was checked.

### Sign-off needs a check that left only review, nothing unpublished and nothing waiting

No job may be running either.

```quint
pure def canSignOff(s: Session): bool =
  s.job == Idle and s.verdict == Reviewable and not(s.unpublished) and s.waiting == 0
pure def signOff(s: Session): Session = { ...s, job: SigningOff }
```

### A sign-off is checked again when it ends

```quint
pure def canSignedOff(s: Session): bool = s.job == SigningOff
pure def signedOff(s: Session): Session = { ...s, job: Checking, verdict: Unknown }
```

### A sign-off starts only from a reviewable check

```quint
pure def stepSignOffFollowsReview(before: Session, via: str, after: Session): bool =
  via == "signOff" implies (before.verdict == Reviewable and before.waiting == 0 and not(before.unpublished))
```

### A sign-off can be under way

```quint
pure def sometimesSigningOff(s: Session): bool = s.job == SigningOff
```

## Story: Build the app

> As a spec author, I want to build the application the specs describe from
> the studio, so that I have what ships, built from what was checked.

### The app is built from published specs, when no job runs

The build is the project's own `build` script, or, at the root of a workspace,
the `build` script of every app under `apps/`.

```quint
pure def canBuild(s: Session): bool = s.job == Idle and not(s.unpublished)
pure def build(s: Session): Session = { ...s, job: Building }
```

### A build ends, and then no job runs

Whether it worked is in its log.

```quint
pure def canBuilt(s: Session): bool = s.job == Building
pure def built(s: Session): Session = { ...s, job: Idle }
```

### Building changes nothing but the job

```quint
pure def stepBuildChangesOnlyTheJob(before: Session, via: str, after: Session): bool =
  (via == "build" or via == "built") implies
    (after.unpublished == before.unpublished and after.waiting == before.waiting
      and after.verdict == before.verdict and after.previewing == before.previewing)
```

### A build can be under way

```quint
pure def sometimesBuilding(s: Session): bool = s.job == Building
```

## Story: Preview the app

> As a spec author, I want to run the application the specs describe beside
> the studio, so that I see what I am building while I build it.

### The app can be started and stopped whenever, beside any job

The app is the project's own development server: its `start` script, or its
`dev` script when that is not the studio.

```quint
pure def canPreview(s: Session): bool = not(s.previewing)
pure def preview(s: Session): Session = { ...s, previewing: true }
pure def canEndPreview(s: Session): bool = s.previewing
pure def endPreview(s: Session): Session = { ...s, previewing: false }
```

### Running the app changes nothing else

```quint
pure def stepPreviewChangesNothingElse(before: Session, via: str, after: Session): bool =
  (via == "preview" or via == "endPreview") implies
    (after.unpublished == before.unpublished and after.waiting == before.waiting
      and after.job == before.job and after.verdict == before.verdict)
```

### The app can run while an agent syncs

```quint
pure def sometimesPreviewingWhileSyncing(s: Session): bool = s.previewing and s.job == Syncing
```
