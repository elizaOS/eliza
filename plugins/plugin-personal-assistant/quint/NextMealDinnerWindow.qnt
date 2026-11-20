// The schedule inspection (inspectLifeOpsSchedule in
// plugins/plugin-personal-assistant/src/lifeops/schedule-insight.ts) finds the
// meals of the day as gaps between activity windows (inferMealCandidates) and
// then reports the next meal (predictNextMeal): breakfast early after the
// wake, lunch from 11:00 to 15:00 or 3 hours after the latest meal, dinner
// from 17:00 to 22:00 or 4 hours after the latest meal, each only while that
// meal has not been found. A lunch that has not happened by 17:00 was
// skipped, so from 17:00 lunch is no longer reported; inferMealCandidates
// labels any meal eaten from 17:00 to 22:00 as dinner.
// Times are minutes after 00:00 UTC on 2026-11-16. An Oura reading puts the
// wake at 07:00. The owner uses the phone all day and puts it down for
// breakfast (08:00 to 08:35), maybe for lunch (12:15 to 12:50) and maybe for
// dinner (18:15 to 18:50). The schedule is inspected at the end of every hour
// from 09:00 to 23:00. Each meal is found at the middle of its gap.
module NextMealDinnerWindow {
  pure val FirstHour = 9
  pure val LastHour = 23
  pure val LunchHour = 13
  pure val DinnerHour = 19
  pure val BreakfastAt = 497
  pure val LunchAt = 752
  pure val DinnerAt = 1112
  pure val NoMeal = "none"

  // The hour whose phone use was stored last.
  var clock: int
  // The owner ate lunch (decided when the 13:00 hour is stored).
  var lunchEaten: bool
  // The owner ate dinner (decided when the 19:00 hour is stored).
  var dinnerEaten: bool
  // An hour was stored and the schedule has not been inspected since.
  var pending: bool
  // The next meal the newest inspection reported.
  var shown: str
  // Some inspection of the day has reported dinner.
  var dinnerShown: bool

  // predictNextMeal with breakfast found (the breakfast gap closes at 08:35).
  pure def nextMeal(hour: int, lunch: bool, dinner: bool): str = {
    val latest = if (dinner) DinnerAt else if (lunch) LunchAt else BreakfastAt
    val sinceMeal = hour * 60 - latest
    if (and {
      not(lunch),
      hour < 17,
      or { and { hour >= 11, hour < 15 }, sinceMeal >= 180 },
    }) "lunch"
    else if (and {
      not(dinner),
      or { and { hour >= 17, hour < 22 }, sinceMeal >= 240 },
    }) "dinner"
    else NoMeal
  }

  action init = all {
    clock' = FirstHour - 1,
    lunchEaten' = false,
    dinnerEaten' = false,
    pending' = false,
    shown' = NoMeal,
    dinnerShown' = false,
  }
  // The phone stores the sessions of the next hour (recordScreenTimeEvent).
  // The hour that holds lunch or dinner either has the 35-minute gap or not.
  action record = {
    nondet ate = Set(true, false).oneOf()
    val hour = clock + 1
    all {
      not(pending),
      clock < LastHour,
      clock' = hour,
      lunchEaten' = if (hour == LunchHour) ate else lunchEaten,
      dinnerEaten' = if (hour == DinnerHour) ate else dinnerEaten,
      pending' = true,
      shown' = shown,
      dinnerShown' = dinnerShown,
    }
  }
  // The schedule is inspected at the end of the stored hour.
  action inspect = {
    val found = nextMeal(clock, lunchEaten, dinnerEaten)
    all {
      pending,
      clock' = clock,
      lunchEaten' = lunchEaten,
      dinnerEaten' = dinnerEaten,
      pending' = false,
      shown' = found,
      dinnerShown' = (dinnerShown or found == "dinner"),
    }
  }
  // The inspection has not run yet.
  action stutter = all {
    clock' = clock,
    lunchEaten' = lunchEaten,
    dinnerEaten' = dinnerEaten,
    pending' = pending,
    shown' = shown,
    dinnerShown' = dinnerShown,
  }
  action step = any { record, inspect, stutter }

  val ModelState = {
    clock: clock,
    lunchEaten: lunchEaten,
    dinnerEaten: dinnerEaten,
    pending: pending,
    shown: shown,
    dinnerShown: dinnerShown,
  }
  val Inspected = clock >= FirstHour and not(pending)
  val Settled = not(pending)
  temporal SettlesWithoutFairness = not(Settled).leadsTo(Settled)
  temporal Settles = inspect.weakFair(ModelState)
    .implies(SettlesWithoutFairness)

  // Lunch is never reported from 17:00 on.
  val NoLunchFromDinnerWindow =
    not(Inspected) or shown != "lunch" or clock < 17
  // From 17:00 to 22:00, dinner is reported until it is found.
  val DinnerWhileDue =
    not(Inspected) or clock < 17 or clock >= 22 or dinnerEaten or
      shown == "dinner"
  // Once dinner was reported or found, lunch is not reported again that day.
  val NeverBackToLunch =
    not(Inspected) or shown != "lunch" or
      (not(dinnerShown) and not(dinnerEaten))
  // A meal that was already found is never reported as the next one.
  val OnlyMealsNotFound = and {
    not(Inspected) or shown != "lunch" or not(lunchEaten),
    not(Inspected) or shown != "dinner" or not(dinnerEaten),
  }
  val TypeOK = and {
    clock.in((FirstHour - 1).to(LastHour)),
    Set(NoMeal, "lunch", "dinner").contains(shown),
    clock >= LunchHour or not(lunchEaten),
    clock >= DinnerHour or not(dinnerEaten),
    clock >= FirstHour or not(pending),
  }
}
