lemma createGoal_ensures(s: Goal, cadence: Cadence)
  ensures (inv(s) ==> canCreateGoal(s, cadence) ==> alwaysCheckinsOnlyForActiveGoals(createGoal(s, cadence)))
  ensures (inv(s) ==> canCreateGoal(s, cadence) ==> alwaysDismissedCheckinsStayDismissed(createGoal(s, cadence)))
  ensures (inv(s) ==> canCreateGoal(s, cadence) ==> alwaysFiredCheckinsAreLive(createGoal(s, cadence)))
  ensures (inv(s) ==> canCreateGoal(s, cadence) ==> stepDismissalsAreKept(s, createGoal(s, cadence)))
{
  if inv(s) {
    ReconcileHolds(GoalStatus.GoalActive, cadence, s);
  }
}

lemma updateGoal_ensures(s: Goal, status: GoalStatus, cadence: Cadence)
  ensures (inv(s) ==> canUpdateGoal(s, status, cadence) ==> alwaysCheckinsOnlyForActiveGoals(updateGoal(s, status, cadence)))
  ensures (inv(s) ==> canUpdateGoal(s, status, cadence) ==> alwaysDismissedCheckinsStayDismissed(updateGoal(s, status, cadence)))
  ensures (inv(s) ==> canUpdateGoal(s, status, cadence) ==> alwaysFiredCheckinsAreLive(updateGoal(s, status, cadence)))
  ensures (inv(s) ==> canUpdateGoal(s, status, cadence) ==> stepDismissalsAreKept(s, updateGoal(s, status, cadence)))
{
  if inv(s) {
    ReconcileHolds(status, cadence, s);
  }
}

lemma dismissCheckin_ensures(s: Goal, slot: int)
  ensures (inv(s) ==> canDismissCheckin(s, slot) ==> alwaysCheckinsOnlyForActiveGoals(dismissCheckin(s, slot)))
  ensures (inv(s) ==> canDismissCheckin(s, slot) ==> alwaysDismissedCheckinsStayDismissed(dismissCheckin(s, slot)))
  ensures (inv(s) ==> canDismissCheckin(s, slot) ==> alwaysFiredCheckinsAreLive(dismissCheckin(s, slot)))
  ensures (inv(s) ==> canDismissCheckin(s, slot) ==> stepDismissalsAreKept(s, dismissCheckin(s, slot)))
{
  if inv(s) && canDismissCheckin(s, slot) {
    var a := dismissCheckin(s, slot);
    ProofLib.FilterNone((set_x: int) => (set_x in s.dismissedSlots), s.liveSlots);
    forall v | v in a.dismissedSlots ensures v in s.dismissedSlots || v == slot {
      ProofLib.FilterMember((set_x: int) => !((set_x in s.dismissedSlots)), [slot], v);
    }
    forall v | v in a.liveSlots ensures v in s.liveSlots && v != slot && !(v in a.dismissedSlots) {
      ProofLib.FilterMember((set_x: int) => !((set_x in [slot])), s.liveSlots, v);
    }
    forall v | v in a.firedSlots ensures v in a.liveSlots {
      ProofLib.FilterMember((set_x: int) => !((set_x in [slot])), s.firedSlots, v);
      ProofLib.FilterMember((set_x: int) => !((set_x in [slot])), s.liveSlots, v);
    }
    ProofLib.FilterNone((set_x: int) => (set_x in a.dismissedSlots), a.liveSlots);
  }
}

lemma fireCheckin_ensures(s: Goal, slot: int)
  ensures (inv(s) ==> canFireCheckin(s, slot) ==> alwaysCheckinsOnlyForActiveGoals(fireCheckin(s, slot)))
  ensures (inv(s) ==> canFireCheckin(s, slot) ==> alwaysDismissedCheckinsStayDismissed(fireCheckin(s, slot)))
  ensures (inv(s) ==> canFireCheckin(s, slot) ==> alwaysFiredCheckinsAreLive(fireCheckin(s, slot)))
  ensures (inv(s) ==> canFireCheckin(s, slot) ==> stepDismissalsAreKept(s, fireCheckin(s, slot)))
{
  if inv(s) && canFireCheckin(s, slot) {
    forall v | v in fireCheckin(s, slot).firedSlots ensures v in s.liveSlots {
      ProofLib.FilterMember((set_x: int) => !((set_x in s.firedSlots)), [slot], v);
    }
  }
}

lemma answerCheckin_ensures(s: Goal, slot: int, progress: ReviewState)
  ensures (inv(s) ==> canAnswerCheckin(s, slot, progress) ==> alwaysCheckinsOnlyForActiveGoals(answerCheckin(s, slot, progress)))
  ensures (inv(s) ==> canAnswerCheckin(s, slot, progress) ==> alwaysDismissedCheckinsStayDismissed(answerCheckin(s, slot, progress)))
  ensures (inv(s) ==> canAnswerCheckin(s, slot, progress) ==> alwaysFiredCheckinsAreLive(answerCheckin(s, slot, progress)))
  ensures (inv(s) ==> canAnswerCheckin(s, slot, progress) ==> stepDismissalsAreKept(s, answerCheckin(s, slot, progress)))
{
  if inv(s) && canAnswerCheckin(s, slot, progress) {
    forall v | v in answerCheckin(s, slot, progress).firedSlots ensures v in s.firedSlots {
      ProofLib.FilterMember((set_x: int) => !((set_x in [slot])), s.firedSlots, v);
    }
  }
}

lemma ReconcileHolds(status: GoalStatus, cadence: Cadence, g: Goal)
  requires g.checkinLog >= 0 && g.checkinLog <= checkinLogLimit
  ensures alwaysCheckinsOnlyForActiveGoals(reconcileCheckins(status, cadence, g))
  ensures alwaysDismissedCheckinsStayDismissed(reconcileCheckins(status, cadence, g))
  ensures alwaysFiredCheckinsAreLive(reconcileCheckins(status, cadence, g))
  ensures stepDismissalsAreKept(g, reconcileCheckins(status, cadence, g))
{
  var a := reconcileCheckins(status, cadence, g);
  forall v | v in a.liveSlots ensures v in cadenceSlots(cadence) && !(v in a.dismissedSlots) {
    ProofLib.FilterMember((set_x: int) => !((set_x in g.dismissedSlots)), cadenceSlots(cadence), v);
  }
  forall v | v in a.firedSlots ensures v in a.liveSlots {
    ProofLib.FilterMember((set_x: int) => (set_x in a.liveSlots), g.firedSlots, v);
  }
  ProofLib.FilterNone((set_x: int) => (set_x in a.dismissedSlots), a.liveSlots);
}
