# One project's sheet

The tasks of one project and the people responsible for them. Everything is
stored in a shared spreadsheet that anyone may edit directly, so changes come
from two kinds of writer: the dashboard, which checks its edits, and a person
editing the spreadsheet, who is not checked. Task numbers are plain integers
here (task `#12` is 12) and time is counted in ticks.

## Domain

### Tasks, owners and notes

Each task lists its owners, the tasks it waits on (its parents) and the tasks
linked to it as related. Children are derived from parents and not stored. A
note is a single message to a single person. `by` names the editor an
announced edit came from and is empty for a reminder. `authorIsMember`
distinguishes a current member from a former member or the spreadsheet
editor, even when their names coincide. Notes retain that distinction as
it stood when they were sent.

```quint
import kernel.* from "./kernel"

type Status = Blocked | Review | Todo | Doing | Done
type Writer = App | Sheet | Fix | Clock | Notifier
type Task = {
  id: int, status: Status, owners: List[str], parents: List[int], related: List[int], due: int,
  updatedAt: int, updatedBy: str, authorIsMember: bool, notifiedAt: int, toldSoon: List[int], toldDue: List[int],
}
type NoteKind = Update | Soon | Today
type Note = { kind: NoteKind, task: int, to: str, version: int, at: int, by: str, authorIsMember: bool }
type Tracker = { tasks: List[Task], owners: List[str], lastId: int, now: int, sent: List[Note], last: Writer }
```

### A new project starts with its team and no tasks

The names are an example.

```quint
pure val initial: Tracker =
  { tasks: List(), owners: List("ana", "ben", "cal"), lastId: 0, now: 0, sent: List(), last: Clock }
```

### Timing

A tick is 12 hours, so a day lasts 2 ticks. An edit is announced once 3 ticks
pass without further changes. Reminders are sent up to 3 days early, and a
missed reminder for the day itself up to 2 days late.

```quint
pure val debounce = 3
pure val ticksPerDay = 2
pure val soonDays = 3
pure val lateDays = 2
pure def today(at: int): int = at / ticksPerDay
```

### What the simulator tries

Four task numbers, the three team members and one misspelling, and a few
small spreadsheets that between them show every kind of problem.
Clock and notifier steps are sampled more often so a quiet period can pass
before another edit resets it.

```quint
pure val idValues = Set(1, 2, 3, 4)
pure val otherValues = idValues
pure val ownerValues = Set("ana", "ben", "cal", "ama")
pure val actorValues = ownerValues
pure val nameValues = ownerValues
pure val weight_tick = 5
pure val weight_notify = 5

pure val sValues =
  val blank = {
    id: 1, status: Todo, owners: List("ana"), parents: List(), related: List(), due: 0,
    updatedAt: 0, updatedBy: "ana", authorIsMember: true, notifiedAt: -1, toldSoon: List(), toldDue: List(),
  }
  Set(
    initial,
    { ...initial, lastId: 2, tasks: List(
      { ...blank, related: List(2) },
      { ...blank, id: 2, parents: List(1), related: List(1) }) },
    { ...initial, lastId: 1, tasks: List({ ...blank, owners: List("ama"), parents: List(5), related: List(6) }) },
    { ...initial, lastId: 1, tasks: List({ ...blank, parents: List(1), related: List(1) }) },
    { ...initial, lastId: 2, tasks: List(
      { ...blank, parents: List(2), related: List(2) },
      { ...blank, id: 2, parents: List(1) }) },
  )
```

### Small helpers

```quint
pure def hasTask(s: Tracker, id: int): bool = s.tasks.some(t => t.id == id)
pure def add(xs: List[int], x: int): List[int] = if (xs.includes(x)) xs else xs.append(x)
pure def drop(xs: List[int], x: int): List[int] = xs.select(y => y != x)
pure def addName(xs: List[str], x: str): List[str] = if (xs.includes(x)) xs else xs.append(x)
pure def dropName(xs: List[str], x: str): List[str] = xs.select(y => y != x)
pure def distinctNames(xs: List[str]): List[str] =
  xs.foldl(List(), (acc, x) => if (acc.includes(x)) acc else acc.append(x))
pure def touched(t: Task, actor: str, at: int, member: bool): Task =
  { ...t, updatedAt: at, updatedBy: actor, authorIsMember: member }
```

## Story: See what is wrong with the data

> As the person keeping a project tidy, I want each broken reference shown
> together with a fix, so that direct spreadsheet edits do not silently
> degrade the data.

### Everything a task depends on, however far back

A task that names itself is flagged as a separate problem, so links to itself
are skipped here. The search runs once for each task in the spreadsheet,
which is enough rounds to find every ancestor.

```quint
pure def parentsOfAll(s: Tracker, ids: List[int]): List[int] =
  s.tasks.select(t => ids.includes(t.id))
    .foldl(List(), (acc, t) => acc.concat(t.parents.select(p => p != t.id and not(acc.includes(p)))))

pure def ancestors(s: Tracker, id: int): List[int] =
  s.tasks.foldl(parentsOfAll(s, List(id)), (acc, t) => acc.concat(parentsOfAll(s, acc).select(p => not(acc.includes(p)))))
```

### The problems of one task

An owner who is not a member of the project; a parent or related task that is
missing; a task that waits on or is related to itself; a chain of dependencies
that loops back to the task; a related link that the other task does not link
back.

```quint
type Code = UnknownOwner | UnknownParent | UnknownRelated | SelfParent | SelfRelated | Cycle | OneSided
type Problem = { code: Code, task: int, ref: int, name: str }

pure def linksBack(s: Tracker, other: int, id: int): bool =
  s.tasks.some(t => t.id == other and t.related.includes(id))

pure def problemsOf(s: Tracker, t: Task): List[Problem] =
  t.owners.select(o => not(s.owners.includes(o))).listMap(o => { code: UnknownOwner, task: t.id, ref: 0, name: o })
    .concat(t.parents.select(p => p != t.id and not(hasTask(s, p))).listMap(p => { code: UnknownParent, task: t.id, ref: p, name: "" }))
    .concat(t.related.select(r => r != t.id and not(hasTask(s, r))).listMap(r => { code: UnknownRelated, task: t.id, ref: r, name: "" }))
    .concat(if (t.parents.includes(t.id)) List({ code: SelfParent, task: t.id, ref: t.id, name: "" }) else List())
    .concat(if (t.related.includes(t.id)) List({ code: SelfRelated, task: t.id, ref: t.id, name: "" }) else List())
    .concat(if (ancestors(s, t.id).includes(t.id)) List({ code: Cycle, task: t.id, ref: t.id, name: "" }) else List())
    .concat(t.related.select(r => r != t.id and hasTask(s, r) and not(linksBack(s, r, t.id))).listMap(r => { code: OneSided, task: t.id, ref: r, name: "" }))

pure def problems(s: Tracker): List[Problem] =
  s.tasks.foldl(List(), (acc, t) => acc.concat(problemsOf(s, t)))
```

### The warning list is empty exactly when the data is well formed

Well formed, stated directly: each owner is a member, each link leads to an
existing task, no task links to itself, no dependency chain loops, and each
related link is mirrored. This holds of every spreadsheet, not only of those
the dashboard can reach.

```quint
pure def wellFormed(s: Tracker): bool =
  s.tasks.every(t => and {
    t.owners.every(o => s.owners.includes(o)),
    t.parents.every(p => hasTask(s, p)),
    t.related.every(r => hasTask(s, r)),
    not(t.parents.includes(t.id)),
    not(t.related.includes(t.id)),
    not(ancestors(s, t.id).includes(t.id)),
    t.related.every(r => linksBack(s, r, t.id)),
  })

pure def lawTheWarningListIsTheTruth(s: Tracker): bool =
  (problems(s).length() == 0) iff wellFormed(s)
```

## Story: Edit through the dashboard

> As a team member, I want to edit tasks from the chat app or the web
> dashboard and be stopped when an edit would break a reference, so that the
> dashboard itself never damages the data.

### Only a project member can edit through the dashboard

Every edit made through the dashboard names the person making it, and is
refused unless that person is on the project's team.

```quint
pure def isMember(s: Tracker, actor: str): bool = s.owners.includes(actor)
```

### A task edited through the dashboard is signed by a member

After any edit through the dashboard, each task either carries a signature
(when and by whom it was last updated) that a task of the same number had
before the edit, or is signed by someone who is on the team after the edit.
The rule does not say which member signs, nor that only the edited task's
signature changes: it rules out an edit through the dashboard leaving a task
signed by someone outside the team. A fix, a hand edit and the notifier are
not edits through the dashboard. This rule sees only signatures, so deleting
a task, renaming or removing a person, and a fix are kept to members by their
guards alone.

```quint
pure def keepsItsSignature(before: Tracker, t: Task): bool =
  before.tasks.some(b => b.id == t.id and b.updatedAt == t.updatedAt and b.updatedBy == t.updatedBy)

pure def stepADashboardEditIsSignedByAMember(before: Tracker, after: Tracker): bool =
  after.last == App implies after.tasks.every(t => keepsItsSignature(before, t) or isMember(after, t.updatedBy))
```

### Only a hand edit can make the data worse

An edit made through the dashboard never introduces a problem, even when the
data is already broken. Neither do the clock, the notifier or a fix.

```quint
pure def sameProblem(a: Problem, b: Problem): bool =
  a.code == b.code and a.task == b.task and a.ref == b.ref and a.name == b.name

pure def addsNoProblem(before: Tracker, after: Tracker): bool =
  val old = problems(before)
  problems(after).every(p => old.some(q => sameProblem(p, q)))

pure def stepOnlyAHandEditCorrupts(before: Tracker, after: Tracker): bool =
  after.last != Sheet implies addsNoProblem(before, after)
```

### A new task gets a number that was never issued and that nothing points at

Otherwise a dangling reference left by a direct edit, or an old message
mentioning a deleted task, would suddenly refer to the new task.

```quint
pure def numbersInUse(s: Tracker): List[int] =
  s.tasks.foldl(List(), (acc, t) => acc.append(t.id).concat(t.parents).concat(t.related))

pure def canCreate(s: Tracker, actor: str): bool = isMember(s, actor)

pure def create(s: Tracker, actor: str): Tracker =
  val id = nextNumber(numbersInUse(s), s.lastId)
  { ...s, last: App, lastId: id, tasks: s.tasks.append({
    id: id, status: Todo, owners: List(), parents: List(), related: List(), due: 0,
    updatedAt: s.now, updatedBy: actor, authorIsMember: true, notifiedAt: -1, toldSoon: List(), toldDue: List(),
  }) }

pure def stepANewNumberIsUnreferenced(before: Tracker, after: Tracker): bool =
  after.tasks.every(t => hasTask(before, t.id) or not(numbersInUse(before).includes(t.id)))
```

### Task numbers are unique, and the counter is never negative and never below a task number

```quint
pure def alwaysTaskNumbersAreUnique(s: Tracker): bool =
  s.tasks.every(a => s.tasks.select(b => b.id == a.id).length() == 1)

pure def alwaysTheCounterCoversEveryTask(s: Tracker): bool =
  s.lastId >= 0 and s.tasks.every(t => t.id <= s.lastId)
```

### The counter never goes back, and a number is never reissued

```quint
pure def stepTheCounterNeverGoesBack(before: Tracker, after: Tracker): bool =
  after.lastId >= before.lastId

pure def stepANumberIsNeverReissued(before: Tracker, after: Tracker): bool =
  after.tasks.every(t => before.tasks.some(b => b.id == t.id) or t.id > before.lastId)
```

### Status and due date can be changed on any task that exists

```quint
pure def canSetStatus(s: Tracker, id: int, status: Status, actor: str): bool = isMember(s, actor) and hasTask(s, id)

pure def setStatus(s: Tracker, id: int, status: Status, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, status: status }, actor, s.now, true) else t) }

pure def canSetDue(s: Tracker, id: int, due: int, actor: str): bool = isMember(s, actor) and hasTask(s, id)

pure def setDue(s: Tracker, id: int, due: int, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, due: due }, actor, s.now, true) else t) }
```

### An owner added through the dashboard must be a project member

A misspelled name that is already in the cell may remain until someone fixes
it.

```quint
pure def canAddOwner(s: Tracker, id: int, owner: str, actor: str): bool =
  isMember(s, actor) and hasTask(s, id) and s.owners.includes(owner)

pure def addOwner(s: Tracker, id: int, owner: str, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, owners: addName(t.owners, owner) }, actor, s.now, true) else t) }

pure def canRemoveOwner(s: Tracker, id: int, owner: str, actor: str): bool = isMember(s, actor) and hasTask(s, id)

pure def removeOwner(s: Tracker, id: int, owner: str, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, owners: dropName(t.owners, owner) }, actor, s.now, true) else t) }
```

### A parent must exist and must not already depend on the task

The parent must be another task. Any parent link can be removed, including one
to a missing task or to the task itself.

```quint
pure def canAddParent(s: Tracker, id: int, other: int, actor: str): bool =
  isMember(s, actor) and hasTask(s, id) and hasTask(s, other) and id != other and not(ancestors(s, other).includes(id))

pure def addParent(s: Tracker, id: int, other: int, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, parents: add(t.parents, other) }, actor, s.now, true) else t) }

pure def canRemoveParent(s: Tracker, id: int, other: int, actor: str): bool = isMember(s, actor) and hasTask(s, id)

pure def removeParent(s: Tracker, id: int, other: int, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, parents: drop(t.parents, other) }, actor, s.now, true) else t) }
```

### Related is written on both tasks at once

A link is added only to another task that exists. Only the task the person
edits counts as edited, so the other task's owners are not told. Any related link can be removed, including one to a missing
task or to the task itself.

```quint
pure def canRelate(s: Tracker, id: int, other: int, actor: str): bool =
  isMember(s, actor) and hasTask(s, id) and hasTask(s, other) and id != other

pure def relate(s: Tracker, id: int, other: int, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.listMap(t =>
    if (t.id == id) touched({ ...t, related: add(t.related, other) }, actor, s.now, true)
    else if (t.id == other) { ...t, related: add(t.related, id) }
    else t) }

pure def canUnrelate(s: Tracker, id: int, other: int, actor: str): bool = isMember(s, actor) and hasTask(s, id)

pure def unrelate(s: Tracker, id: int, other: int, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.listMap(t =>
    if (t.id == id) touched({ ...t, related: drop(t.related, other) }, actor, s.now, true)
    else if (t.id == other) { ...t, related: drop(t.related, id) }
    else t) }
```

### Deleting a task through the dashboard removes every link to it

```quint
pure def canDeleteTask(s: Tracker, id: int, actor: str): bool = isMember(s, actor) and hasTask(s, id)

pure def deleteTask(s: Tracker, id: int, actor: str): Tracker =
  { ...s, last: App, tasks: s.tasks.select(t => t.id != id)
    .listMap(t => { ...t, parents: drop(t.parents, id), related: drop(t.related, id) }) }
```

### Renaming or removing a person through the dashboard rewrites every cell that names them

A person can be renamed only to a name no team member has. Renaming a person
removes duplicate names from every owners cell, even if the new name had
already been entered there directly. It also renames them as the author of
each task's last edit: every task they last edited is signed with the name
that joined the team, and every other task keeps its author, so they are
still not told of their own edits and no one else is left out instead.
Removing a person takes them off the team and out of every owners cell.
Their recorded author name stays, with `authorIsMember` set to false, so
reusing that name does not suppress another member's notifications. A later
rename changes author names only for current members.

```quint
pure def canRenameOwner(s: Tracker, owner: str, name: str, actor: str): bool =
  isMember(s, actor) and s.owners.includes(owner) and not(s.owners.includes(name))

pure def renameOwner(s: Tracker, owner: str, name: str, actor: str): Tracker =
  { ...s, last: App,
    owners: s.owners.listMap(o => if (o == owner) name else o),
    tasks: s.tasks.listMap(t => { ...t,
      owners: distinctNames(t.owners.listMap(o => if (o == owner) name else o)),
      updatedBy: if (t.authorIsMember and t.updatedBy == owner) name else t.updatedBy }) }

pure def stepARenamedPersonSignsTheirEditsUnderTheNewName(before: Tracker, via: str, after: Tracker): bool =
  via == "renameOwner" implies after.tasks.every(t => before.tasks.some(b => b.id == t.id and
    (if (b.authorIsMember and isMember(before, b.updatedBy) and not(isMember(after, b.updatedBy)))
       isMember(after, t.updatedBy) and not(isMember(before, t.updatedBy))
     else t.updatedBy == b.updatedBy)))

pure def canDeleteOwner(s: Tracker, owner: str, actor: str): bool = isMember(s, actor) and s.owners.includes(owner)

pure def deleteOwner(s: Tracker, owner: str, actor: str): Tracker =
  { ...s, last: App, owners: dropName(s.owners, owner),
    tasks: s.tasks.listMap(t => { ...t, owners: dropName(t.owners, owner),
      authorIsMember: t.authorIsMember and t.updatedBy != owner }) }
```

## Story: Edit the spreadsheet directly

> As someone who prefers working in the spreadsheet, I want to edit it
> directly, mistakes included, and have the dashboard take it and point out
> what needs fixing.

### A hand edit is accepted whatever it says

Any name may be entered as an owner, including one already present, and any
number as a link. Rows may be removed, leaving references to them dangling,
and a person may be removed from the team, leaving their name in owners cells.
Rows are added only through the dashboard. The task number and bookkeeping
columns (last edit, last announcement, reminders sent) are protected from
direct edits; when a hand edit to a row arrives, the system records the time,
and `sheet` as the editor, with `authorIsMember` false. Every current owner
is eligible for its announcement, including a member named `sheet`.

```quint
pure def canHandAddOwner(s: Tracker, id: int, name: str): bool = hasTask(s, id)

pure def handAddOwner(s: Tracker, id: int, name: str): Tracker =
  { ...s, last: Sheet, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, owners: t.owners.append(name) }, "sheet", s.now, false) else t) }

pure def canHandAddParent(s: Tracker, id: int, other: int): bool = hasTask(s, id)

pure def handAddParent(s: Tracker, id: int, other: int): Tracker =
  { ...s, last: Sheet, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, parents: add(t.parents, other) }, "sheet", s.now, false) else t) }

pure def canHandAddRelated(s: Tracker, id: int, other: int): bool = hasTask(s, id)

pure def handAddRelated(s: Tracker, id: int, other: int): Tracker =
  { ...s, last: Sheet, tasks: s.tasks.listMap(t => if (t.id == id) touched({ ...t, related: add(t.related, other) }, "sheet", s.now, false) else t) }

pure def canHandDeleteTask(s: Tracker, id: int): bool = hasTask(s, id)

pure def handDeleteTask(s: Tracker, id: int): Tracker =
  { ...s, last: Sheet, tasks: s.tasks.select(t => t.id != id) }

pure def canHandDeleteOwner(s: Tracker, owner: str): bool = s.owners.includes(owner)

pure def handDeleteOwner(s: Tracker, owner: str): Tracker =
  { ...s, last: Sheet, owners: dropName(s.owners, owner),
    tasks: s.tasks.listMap(t => { ...t, authorIsMember: t.authorIsMember and t.updatedBy != owner }) }
```

### A hand edit can leave a problem behind

```quint
pure def sometimesTheDataHasAProblem(s: Tracker): bool = problems(s).length() > 0
```

### A one-click fix removes a problem and adds none

A fix is picked by its position in the warning list; a position outside the
list fixes nothing. A loop has no automatic fix, because someone must decide
which link to remove. Every other problem is fixed by deleting the faulty
link, except a one-sided related link, which is fixed by adding the missing
link on the other task. A fix leaves fewer problems than before and adds
none, and sometimes a fix clears the list.

```quint
pure val noProblem: Problem = { code: Cycle, task: 0, ref: 0, name: "" }

pure def problemAt(s: Tracker, index: int): Problem =
  val found = problems(s)
  if (index >= 0 and index < found.length()) found.nth(index) else noProblem

pure def canFix(s: Tracker, index: int, actor: str): bool =
  isMember(s, actor) and problemAt(s, index).code != Cycle

pure def fix(s: Tracker, index: int, actor: str): Tracker =
  val p = problemAt(s, index)
  { ...s, last: Fix, tasks: s.tasks.listMap(t =>
    if (p.code == OneSided and t.id == p.ref) { ...t, related: add(t.related, p.task) }
    else if (t.id != p.task) t
    else if (p.code == UnknownOwner) { ...t, owners: dropName(t.owners, p.name) }
    else if (p.code == UnknownParent or p.code == SelfParent) { ...t, parents: drop(t.parents, p.ref) }
    else if (p.code == UnknownRelated or p.code == SelfRelated) { ...t, related: drop(t.related, p.ref) }
    else t) }

pure def stepAFixRemovesAProblem(before: Tracker, after: Tracker): bool =
  after.last == Fix implies problems(after).length() < problems(before).length()

pure def sometimesAProblemIsFixed(s: Tracker): bool = s.last == Fix and problems(s).length() == 0
```

## Story: Be told what changed and what is due

> As a task owner, I want a message when another person changes my task, a
> few days ahead of its due date and on the date itself, each exactly once.

### Time passes

```quint
pure def tick(s: Tracker): Tracker = { ...s, last: Clock, now: s.now + 1 }
```

### One pass of the notifier sends everything that is due and records that it was sent

An edit is announced to the task's owners who are project members, apart from
the current member who made it. A hand edit is announced with `sheet` as its
editor and reaches every such owner. An edit by a former member also reaches
every current owner, including someone who now uses that former name. When two people
edit a task within the quiet period, only the last of them is left out.
Deleting a task, renaming or removing a person, and a fix are not announced.
A reminder goes to all such owners. A finished task, or one without a due date
(a due date of 0 or less), gets no reminder.

```quint
pure def knownOwners(s: Tracker, t: Task): List[str] = distinctNames(t.owners.select(o => s.owners.includes(o)))

pure def updateIsDue(t: Task, at: int): bool = editIsDue(t.updatedAt, t.notifiedAt, at, debounce)

pure def reminder(t: Task, at: int): Reminder =
  if (t.status == Done or t.due <= 0) NoReminder
  else reminderFor(t.due - today(at), lateDays, soonDays, t.toldDue.includes(t.due), t.toldSoon.includes(t.due))

pure def notesFor(s: Tracker, t: Task): List[Note] =
  (if (updateIsDue(t, s.now))
     knownOwners(s, t).select(o => not(t.authorIsMember) or o != t.updatedBy).listMap(o => { kind: Update, task: t.id, to: o, version: t.updatedAt, at: s.now, by: t.updatedBy, authorIsMember: t.authorIsMember })
   else List())
    .concat(if (reminder(t, s.now) == DueSoon) knownOwners(s, t).listMap(o => { kind: Soon, task: t.id, to: o, version: t.due, at: s.now, by: "", authorIsMember: false }) else List())
    .concat(if (reminder(t, s.now) == DueToday) knownOwners(s, t).listMap(o => { kind: Today, task: t.id, to: o, version: t.due, at: s.now, by: "", authorIsMember: false }) else List())

pure def recorded(t: Task, at: int): Task =
  { ...t,
    notifiedAt: if (updateIsDue(t, at)) t.updatedAt else t.notifiedAt,
    toldSoon: if (reminder(t, at) == DueSoon) t.toldSoon.append(t.due) else t.toldSoon,
    toldDue: if (reminder(t, at) == DueToday) t.toldDue.append(t.due) else t.toldDue }

type Notified = { state: Tracker, out: List[Note] }

pure def notify(s: Tracker): Notified =
  val notes = s.tasks.foldl(List(), (acc, t) => acc.concat(notesFor(s, t)))
  { state: { ...s, last: Notifier, sent: s.sent.concat(notes), tasks: s.tasks.listMap(t => recorded(t, s.now)) }, out: notes }
```

### A pass sends exactly the notes it records

The notes a pass of the notifier hands to the shell to post are the ones it
adds to the record of what was sent, in the same order. No other change
sends anything or changes that record. The record is written before anything is posted, so a note
is recorded as sent whether or not the chat app takes it.

```quint
pure def stepAPassSendsWhatItRecords(before: Tracker, via: str, after: Tracker, out: List[Note]): bool =
  after.sent == before.sent.concat(out) and (via == "notify" or out.length() == 0)
```

### No one is told of their own edit

A notification skips its author while that author is still a member.
Former authors and spreadsheet edits retain their recorded labels without
excluding a current member who happens to use the same name.

```quint
pure def alwaysNoOneIsToldOfTheirOwnEdit(s: Tracker): bool =
  s.sent.every(n => (n.kind == Update and n.authorIsMember) implies n.to != n.by)
```

### Owners hear about an edit only after the quiet period

```quint
pure def alwaysAnEditIsAnnouncedAfterTheQuietPeriod(s: Tracker): bool =
  s.sent.every(n => n.kind == Update implies n.at - n.version >= debounce)

pure def sometimesAnOwnerIsToldOfAnEdit(s: Tracker): bool = s.sent.some(n => n.kind == Update)
```

### Nothing is sent twice

Each settled version of an edit is announced to each person once. Each kind of
reminder goes to each person once per due date, even when the date is changed and later
changed back, because the spreadsheet keeps every date already reminded for.

Discovered by simulation: when a name appeared twice in an owners cell, the
notifier sent that person an identical message twice. The notifier now treats
each cell as a set of people, in which each name is listed once.

```quint
pure def alwaysNothingIsSentTwice(s: Tracker): bool =
  s.sent.every(a => s.sent.select(b => a.kind == b.kind and a.task == b.task and a.to == b.to and a.version == b.version).length() == 1)

pure def lawEachNameIsListedOnce(xs: List[str]): bool =
  distinctNames(xs).every(o => distinctNames(xs).select(x => x == o).length() == 1)
```

### Every note sent is recorded on its task

A note only ever names a task number no higher than the last one issued, and
while that task exists it records the note: an announced edit is no newer than the task's last
announced version, and a reminder's date is among the dates already reminded
for, ahead or on the day.

Discovered by the proof: without it, "Nothing is sent twice" can be broken by
the notifier from a state that satisfies every other rule, one where a note for
a task was sent but the task does not record it, so the same note goes out again.

```quint
pure def alwaysWhatWasSentIsRecorded(s: Tracker): bool =
  s.sent.every(n => n.task <= s.lastId and s.tasks.every(t => t.id == n.task implies and {
    n.kind == Update implies n.version <= t.notifiedAt,
    n.kind == Soon implies t.toldSoon.includes(n.version),
    n.kind == Today implies t.toldDue.includes(n.version),
  }))
```

### Reminders go out at the right distance from the due date

A heads-up goes out 1 to `soonDays` days before the due date, and a due-day
reminder on the day or up to `lateDays` days after it. Both kinds of reminder
do go out.

```quint
pure def alwaysRemindersAreTimely(s: Tracker): bool =
  s.sent.every(n => and {
    n.kind == Today implies (n.version <= today(n.at) and today(n.at) - n.version <= lateDays),
    n.kind == Soon implies (n.version - today(n.at) >= 1 and n.version - today(n.at) <= soonDays),
  })

pure def sometimesADueDayReminderGoesOut(s: Tracker): bool = s.sent.some(n => n.kind == Today)

pure def sometimesAHeadsUpGoesOut(s: Tracker): bool = s.sent.some(n => n.kind == Soon)
```

### The bookkeeping never runs ahead of the clock

A task's last announced version is never newer than its last edit, and its
last edit is never later than now.

```quint
pure def alwaysTheBookkeepingIsSane(s: Tracker): bool =
  s.tasks.every(t => t.notifiedAt <= t.updatedAt and t.updatedAt <= s.now)
```

### The clock never reads below zero

Discovered by the proof: without it, "The bookkeeping never runs ahead of the
clock" can be broken by creating a task in a state whose clock is negative,
since a new task counts as never announced and so is announced before it was
written.

```quint
pure def alwaysTheClockIsNeverNegative(s: Tracker): bool = s.now >= 0
```
