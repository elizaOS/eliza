# Reminder escalation

A saved [reminder](./reminders.md) alerts once when it comes due. The
owner may ask for more when they do not answer it: "for my medication
reminder, nudge me again if I don't respond in 30 minutes". Each step of a
reminder's escalation plan is a channel and the minutes after the reminder
fired; when a step comes due and the owner has not answered that firing,
the assistant says the reminder still needs their attention on that
channel. A phone notification reaches the owner as the first alert did,
with its message in the conversation; the conversation alone adds only
the message. These are the channels the assistant reaches on the owner's
phone, and a step on any other, such as a call or a text message, is
refused when the owner asks for it, with the channels it can use, so a
reminder never texts or calls the owner.

A plan may also keep quiet hours, a span of the day on the owner's clock
in which no step notifies the phone. The zone is the owner's clock when
the quiet hours were set. Escalation is only for one named reminder: a
request that names none is refused, and nothing is stored for it.

## Story: Nudge me again about a reminder I did not answer, never in my quiet hours

> As an owner, I want a reminder I named to come back on the channels I
> chose while I have not answered it, to stop once I answer, and to keep
> quiet in the hours I asked for.

### A requested channel takes only the requested steps, and every other channel keeps its steps

Asking for steps on a channel replaces that channel's earlier steps; the
steps of a channel the request does not name stay, unless the owner asked
to replace the whole plan.

```quint
type QuietHours = NoQuietHours | QuietBetween({ startMinute: int, endMinute: int })
type EscalationPlan = { inAppAfter: List[int], pushAfter: List[int], quiet: QuietHours }
type EscalationRequest = { askedInApp: List[int], askedPush: List[int], replaceAll: bool, askedQuiet: QuietHours, quietGiven: bool }
pure val noEscalation: EscalationPlan = { inAppAfter: List(), pushAfter: List(), quiet: NoQuietHours }
pure def offsetsAfter(existing: List[int], requested: List[int], replaceAll: bool): List[int] =
  if (replaceAll or requested.length() > 0) requested else existing
pure def configureEscalation(plan: EscalationPlan, request: EscalationRequest): EscalationPlan = {
  inAppAfter: offsetsAfter(plan.inAppAfter, request.askedInApp, request.replaceAll),
  pushAfter: offsetsAfter(plan.pushAfter, request.askedPush, request.replaceAll),
  quiet: if (request.quietGiven) request.askedQuiet else plan.quiet
}
pure val nightQuiet: QuietHours = QuietBetween({ startMinute: 1320, endMinute: 420 })
pure val planValues: Set[EscalationPlan] = List(
  noEscalation, { inAppAfter: List(10), pushAfter: List(30), quiet: nightQuiet }, { inAppAfter: List(), pushAfter: List(5, 60), quiet: NoQuietHours }
).foldl(Set(), (acc, p) => acc.union(Set(p)))
pure val requestValues: Set[EscalationRequest] = List(
  { askedInApp: List(), askedPush: List(30), replaceAll: false, askedQuiet: NoQuietHours, quietGiven: false },
  { askedInApp: List(15), askedPush: List(), replaceAll: true, askedQuiet: NoQuietHours, quietGiven: false },
  { askedInApp: List(), askedPush: List(), replaceAll: false, askedQuiet: nightQuiet, quietGiven: true },
  { askedInApp: List(), askedPush: List(), replaceAll: false, askedQuiet: NoQuietHours, quietGiven: true }
).foldl(Set(), (acc, r) => acc.union(Set(r)))
pure def lawARequestedChannelTakesOnlyTheRequestedSteps(plan: EscalationPlan, request: EscalationRequest): bool =
  (request.askedPush.length() > 0 implies configureEscalation(plan, request).pushAfter == request.askedPush)
  and (request.askedInApp.length() > 0 implies configureEscalation(plan, request).inAppAfter == request.askedInApp)
pure def lawAnUnnamedChannelKeepsItsSteps(plan: EscalationPlan, request: EscalationRequest): bool =
  not(request.replaceAll) implies (
    (request.askedPush.length() == 0 implies configureEscalation(plan, request).pushAfter == plan.pushAfter)
    and (request.askedInApp.length() == 0 implies configureEscalation(plan, request).inAppAfter == plan.inAppAfter))
```

### New steps keep the quiet hours of the reminder

A request that sets steps and says nothing of quiet hours leaves the
quiet hours the plan had, so a new phone step can never ring inside them.

```quint
pure def lawStepsKeepTheQuietHours(plan: EscalationPlan, request: EscalationRequest): bool =
  not(request.quietGiven) implies configureEscalation(plan, request).quiet == plan.quiet
```

### A step nudges only while its firing is unanswered, and a phone step inside quiet hours is held

The reminder is unanswered while it is still fired from the firing that
scheduled the step: an acknowledgment, a completion, a dismissal or a
snooze answers it, and a later firing schedules steps of its own. Quiet
hours that start and end at the same minute are none; quiet hours that
start after they end wrap past midnight. A held step is not sent later.

```quint
type ReminderChannel = InApp | Push
type StepOutcome = NudgeSent | HeldForQuietHours | NoLongerOpen
pure def inQuietHours(quiet: QuietHours, minuteOfDay: int): bool = match quiet {
  | NoQuietHours => false
  | QuietBetween(q) =>
      if (q.startMinute == q.endMinute) false
      else if (q.startMinute < q.endMinute) q.startMinute <= minuteOfDay and minuteOfDay < q.endMinute
      else minuteOfDay >= q.startMinute or minuteOfDay < q.endMinute
}
pure def escalationOutcome(channel: ReminderChannel, quiet: QuietHours, minuteOfDay: int, unanswered: bool): StepOutcome =
  if (not(unanswered)) NoLongerOpen
  else if (channel == Push and inQuietHours(quiet, minuteOfDay)) HeldForQuietHours
  else NudgeSent
pure val quietValues: Set[QuietHours] = List(NoQuietHours, nightQuiet, QuietBetween({ startMinute: 60, endMinute: 300 }), QuietBetween({ startMinute: 5, endMinute: 5 }))
  .foldl(Set(), (acc, q) => acc.union(Set(q)))
pure val minuteOfDayValues = Set(0, 60, 299, 300, 420, 600, 1319, 1320, 1439)
pure def lawAnAnsweredReminderIsNeverNudged(channel: ReminderChannel, quiet: QuietHours, minuteOfDay: int): bool =
  escalationOutcome(channel, quiet, minuteOfDay, false) == NoLongerOpen
pure def lawTheConversationIsNeverHeld(quiet: QuietHours, minuteOfDay: int): bool =
  escalationOutcome(InApp, quiet, minuteOfDay, true) == NudgeSent
pure def lawAPhoneStepInsideQuietHoursIsHeld(quiet: QuietHours, minuteOfDay: int): bool =
  inQuietHours(quiet, minuteOfDay) implies escalationOutcome(Push, quiet, minuteOfDay, true) == HeldForQuietHours
pure def lawAPhoneStepOutsideQuietHoursIsSent(quiet: QuietHours, minuteOfDay: int): bool =
  not(inQuietHours(quiet, minuteOfDay)) implies escalationOutcome(Push, quiet, minuteOfDay, true) == NudgeSent
pure def lawQuietHoursWrapPastMidnight(minuteOfDay: int): bool =
  inQuietHours(nightQuiet, minuteOfDay) iff (minuteOfDay >= 1320 or minuteOfDay < 420)
```

### A reminder, nudge or check-in that may have reached the owner is never sent again

A delivery that failed before anything left, with no conversation to post
in or no notification service, is tried again later. One that failed once
the notice was handed to the phone's notifications, or after it was
shown, may already have reached the owner: it counts as sent and is never
sent again, so a lost answer never repeats a nudge.

```quint
type DeliveryEnd = DeliveryShown | NothingSent | AcceptanceUnknown
pure def sentAgain(ending: DeliveryEnd): bool = ending == NothingSent
pure def lawADeliveryThatMayHaveReachedTheOwnerIsNeverSentAgain(ending: DeliveryEnd): bool =
  (ending == DeliveryShown or ending == AcceptanceUnknown) implies not(sentAgain(ending))
pure def lawOnlyADeliveryThatNeverLeftIsTriedAgain(ending: DeliveryEnd): bool = sentAgain(ending) iff ending == NothingSent
```

## Story: Chase me about my reminders only as hard as I asked

> As an owner, I want to say how persistently my reminders and routines
> follow up, for all of them or for one, to still get each first alert,
> and to be chased less while I have stopped answering.

### A reminder's own intensity wins over the owner's, and an unset one is normal

The owner sets an intensity, minimal, normal, persistent or high priority
only, for every reminder and routine or for one they name: a live
reminder by its title or id, else a routine by its title or id. A name
that matches none, or several, sets nothing. When the request gives no
intensity, it is read from the owner's own message, and a message that
names none sets nothing; a reading the model's own maximum cut off fails
the request with that error and sets nothing. Intensity is read when a
reminder fires or a routine shows, so a change applies from its next
firing.

```quint
type ReminderIntensity = IntensityUnset | IntensityMinimal | IntensityNormal | IntensityPersistent | IntensityHighPriorityOnly
pure def effectiveIntensity(own: ReminderIntensity, owners: ReminderIntensity): ReminderIntensity =
  if (own != IntensityUnset) own else if (owners != IntensityUnset) owners else IntensityNormal
pure def lawAReminderOwnIntensityWins(own: ReminderIntensity, owners: ReminderIntensity): bool =
  own != IntensityUnset implies effectiveIntensity(own, owners) == own
pure def lawAnUnsetIntensityIsNormal(owners: ReminderIntensity): bool =
  effectiveIntensity(IntensityUnset, owners) == (if (owners == IntensityUnset) IntensityNormal else owners)
```

### Intensity shapes only the follow-ups: minimal drops them, persistent adds one, and high priority only keeps them for a high-priority reminder

A reminder's first alert always comes. Minimal schedules no follow-up, and
high priority only schedules them only for a reminder the owner said was
high priority. Persistent adds one more nudge in the conversation an hour
after the plan's last step, or an hour after the reminder fired when it
has none. Normal keeps the plan, and every intensity keeps its quiet hours.
A routine has no plan of its own, so only persistent gives it a nudge, an
hour after its occurrence was shown and only while that occurrence is
still unanswered.

```quint
pure val persistentNudgeMinutes = 60
pure def lastStepMinute(plan: EscalationPlan): int =
  plan.inAppAfter.concat(plan.pushAfter).foldl(0, (latest, minute) => if (minute > latest) minute else latest)
pure def followupsUnder(plan: EscalationPlan, intensity: ReminderIntensity, highPriority: bool): EscalationPlan = {
  val nudge = lastStepMinute(plan) + persistentNudgeMinutes
  if (intensity == IntensityMinimal or (intensity == IntensityHighPriorityOnly and not(highPriority))) { ...plan, inAppAfter: List(), pushAfter: List() }
  else if (intensity == IntensityPersistent and not(plan.inAppAfter.includes(nudge))) { ...plan, inAppAfter: plan.inAppAfter.append(nudge) }
  else plan
}
pure def lawMinimalSendsNoFollowup(plan: EscalationPlan, highPriority: bool): bool =
  followupsUnder(plan, IntensityMinimal, highPriority).inAppAfter.length() == 0 and followupsUnder(plan, IntensityMinimal, highPriority).pushAfter.length() == 0
pure def lawHighPriorityOnlyKeepsAHighPriorityPlan(plan: EscalationPlan): bool = followupsUnder(plan, IntensityHighPriorityOnly, true) == plan
pure def lawHighPriorityOnlyDropsAnOrdinaryPlan(plan: EscalationPlan): bool =
  followupsUnder(plan, IntensityHighPriorityOnly, false) == { ...plan, inAppAfter: List(), pushAfter: List() }
pure def lawPersistentNudgesAnHourAfterTheLastStep(plan: EscalationPlan, highPriority: bool): bool =
  followupsUnder(plan, IntensityPersistent, highPriority).inAppAfter.includes(lastStepMinute(plan) + persistentNudgeMinutes)
pure def lawNormalKeepsThePlan(plan: EscalationPlan, highPriority: bool): bool = followupsUnder(plan, IntensityNormal, highPriority) == plan
pure def lawIntensityKeepsTheQuietHours(plan: EscalationPlan, intensity: ReminderIntensity, highPriority: bool): bool =
  followupsUnder(plan, intensity, highPriority).quiet == plan.quiet
```

### A quiet owner is chased one notch less

An owner who has answered none of their reminders, routines or goal
check-ins for three days is quiet: what fires next follows up as if they
had asked for one notch less. Persistent becomes normal, normal or unset
becomes minimal, and minimal and high priority only stay as they are. An
owner who has never answered anything is not quiet, and their next
answer ends the quiet.

```quint
pure val quietStreakMs = 259200000
pure def ownerQuiet(lastAnswerAt: int, now: int): bool = lastAnswerAt > 0 and now - lastAnswerAt >= quietStreakMs
pure def quietIntensity(intensity: ReminderIntensity, ownerIsQuiet: bool): ReminderIntensity =
  if (not(ownerIsQuiet)) intensity
  else if (intensity == IntensityPersistent) IntensityNormal
  else if (intensity == IntensityHighPriorityOnly) IntensityHighPriorityOnly
  else IntensityMinimal
pure def lawAnAnsweringOwnerKeepsTheirIntensity(intensity: ReminderIntensity): bool = quietIntensity(intensity, false) == intensity
pure def lawAQuietOwnerIsNeverChasedPersistently(intensity: ReminderIntensity): bool = quietIntensity(intensity, true) != IntensityPersistent
pure def lawAQuietOwnerLosesOneNotch(intensity: ReminderIntensity): bool =
  (intensity == IntensityPersistent implies quietIntensity(intensity, true) == IntensityNormal)
  and ((intensity == IntensityNormal or intensity == IntensityUnset) implies quietIntensity(intensity, true) == IntensityMinimal)
pure def lawAnOwnerWhoNeverAnsweredIsNotQuiet(now: int): bool = not(ownerQuiet(0, now))
```
