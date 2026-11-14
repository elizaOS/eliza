# Dashboard arithmetic

The small calculations behind the dashboard's promises: the number a new task
row receives, when a task's owners hear about a change, which due-date reminder
is next, and where a page of a list begins. Whole numbers only.
`spec/tracker.md` imports it. Paging and request freshness serve a chat shell
this example does not include.

## Story: An ID is never issued twice

> As a team member who mentions task numbers in chat, I want a number to
> stand for one task forever, so that an old message never leads to another task.

### A new number is above the stored counter and above every number seen

The caller must pass as `seen` every number in the spreadsheet and every
number a link refers to, dangling links included, and as `stored` the highest
number ever handed out, which survives row deletions.

```quint
pure def nextNumber(seen: List[int], stored: int): int =
  seen.foldl(stored, (top, x) => if (x > top) x else top) + 1

pure def lawNextIsAboveTheCounter(seen: List[int], stored: int): bool =
  nextNumber(seen, stored) > stored

pure def lawNextIsAboveEverythingSeen(seen: List[int], stored: int): bool =
  seen.every(x => nextNumber(seen, stored) > x)
```

## Story: Owners hear about an edit once it has settled

> As a task owner, I want to hear about a change only once the editing has
> paused, so that a burst of small edits becomes a single message.

### An edit is due when it is unannounced and has been quiet for the whole debounce period

```quint
pure def editIsDue(updatedAt: int, notifiedAt: int, at: int, debounce: int): bool =
  updatedAt > notifiedAt and at - updatedAt >= debounce

pure def lawAnAnnouncedEditIsNeverDue(updatedAt: int, at: int, debounce: int): bool =
  not(editIsDue(updatedAt, updatedAt, at, debounce))

pure def lawAFreshEditIsNotDue(updatedAt: int, notifiedAt: int, debounce: int): bool =
  debounce > 0 implies not(editIsDue(updatedAt, notifiedAt, updatedAt, debounce))
```

## Story: A due date is reminded about once

> As a task owner, I want one heads-up a few days before a due date and one
> on the date itself, so that I am reminded without being pestered.

### A reminder that was sent is not sent again, and each goes out only at its distance from the due date

`left` counts the days until the due date; a negative value means overdue. A
reminder for the day itself that was missed still goes out up to `lateDays`
days afterwards.

```quint
type Reminder = NoReminder | DueToday | DueSoon

pure def reminderFor(left: int, lateDays: int, soonDays: int, toldDue: bool, toldSoon: bool): Reminder =
  if (left <= 0 and left >= 0 - lateDays and not(toldDue)) DueToday
  else if (left >= 1 and left <= soonDays and not(toldSoon)) DueSoon
  else NoReminder

pure def lawNothingIsRepeated(left: int, lateDays: int, soonDays: int, toldDue: bool, toldSoon: bool): bool =
  (toldDue implies reminderFor(left, lateDays, soonDays, toldDue, toldSoon) != DueToday)
    and (toldSoon implies reminderFor(left, lateDays, soonDays, toldDue, toldSoon) != DueSoon)

pure def lawDueTodayMeansOnOrAfterTheDay(left: int, lateDays: int, soonDays: int, toldDue: bool, toldSoon: bool): bool =
  reminderFor(left, lateDays, soonDays, toldDue, toldSoon) == DueToday implies (left <= 0 and left >= 0 - lateDays)

pure def lawDueSoonMeansAhead(left: int, lateDays: int, soonDays: int, toldDue: bool, toldSoon: bool): bool =
  reminderFor(left, lateDays, soonDays, toldDue, toldSoon) == DueSoon implies (left >= 1 and left <= soonDays)
```

## Story: A list page never comes up empty

> As someone paging through tasks in the chat app, I want an outdated "next
> page" button to show the final page, so that I never get an empty list.

### A page starts inside the list: an existing page where it is, a page beyond the end at the final page

A page number beyond the end, because the list got shorter after the button
was shown, falls back to the final page. A page number of 0 or below gives the
first page.

```quint
pure def pageStart(total: int, page: int, pageSize: int): int =
  if (total <= 0 or page <= 0 or pageSize <= 0) 0
  else if (page * pageSize < total) page * pageSize
  else ((total - 1) / pageSize) * pageSize

pure def lawAPageStartsInsideTheList(total: int, page: int, pageSize: int): bool =
  (total > 0 and pageSize >= 1) implies (pageStart(total, page, pageSize) >= 0 and pageStart(total, page, pageSize) < total)

pure def lawAnExistingPageIsNotMoved(total: int, page: int, pageSize: int): bool =
  (page >= 0 and pageSize >= 1 and page * pageSize < total) implies pageStart(total, page, pageSize) == page * pageSize

pure def lawAPageBeyondTheEndIsTheFinalPage(total: int, page: int, pageSize: int): bool =
  (total > 0 and pageSize >= 1 and page * pageSize >= total)
    implies (pageStart(total, page, pageSize) + pageSize >= total and pageStart(total, page, pageSize) % pageSize == 0)
```

## Story: Only recent requests are accepted

> As the operator, I want a request from the chat app accepted only when its
> timestamp is near the current time, so that a recorded request cannot be
> replayed once the window has passed.

### A request is fresh within the window, either way

```quint
pure def isFresh(at: int, stamp: int, window: int): bool =
  at - stamp <= window and stamp - at <= window

pure def lawAnOldRequestIsRefused(at: int, stamp: int, window: int): bool =
  at - stamp > window implies not(isFresh(at, stamp, window))
```
