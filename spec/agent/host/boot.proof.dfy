lemma settleTask_ensures(b: Boot, id: int)
  ensures (inv(b) ==> canSettleTask(b, id) ==> alwaysPhaseWithinPipeline(settleTask(b, id)))
  ensures (inv(b) ==> canSettleTask(b, id) ==> alwaysDisposedOnceWhenClosed(settleTask(b, id)))
  ensures (inv(b) ==> canSettleTask(b, id) ==> stepNoTaskRegisteredWhileClosing(b, settleTask(b, id)))
{
  SettledTasks(b, id);
  forall x | x in settleTask(b, id).tasks ensures x in b.tasks {
    ProofLib.FilterMember((set_x: int) => !((set_x in [id])), b.tasks, x);
  }
}

lemma SettledTasks(b: Boot, id: int)
  ensures settleTask(b, id).tasks == ProofLib.Filter((set_x: int) => !((set_x in [id])), b.tasks)
{
}
