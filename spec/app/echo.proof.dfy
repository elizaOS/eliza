// Taking or repeating a copy keeps every number in flight below the hellos sent: the laws of std/net say so, and
// Dafny cannot see it through their folds on its own.
lemma lose_ensures(e: Echo, i: int)
  ensures (inv(e) ==> canLose(e, i) ==> alwaysOnlyTheHelloIsInFlight(lose(e, i)))
{
  if inv(e) && canLose(e, i) { net_lawTakingStaysBelow_ensures(e.net, i, e.sent); }
}

lemma repeat_ensures(e: Echo, i: int)
  ensures (inv(e) ==> canRepeat(e, i) ==> alwaysOnlyTheHelloIsInFlight(repeat(e, i)))
{
  if inv(e) && canRepeat(e, i) { net_lawRepeatingStaysBelow_ensures(e.net, i, e.sent); }
}

lemma deliver_ensures(e: Echo, i: int)
  ensures (inv(e) ==> canDeliver(e, i) ==> alwaysOnlyTheHelloIsInFlight(deliver(e, i)))
{
  if inv(e) && canDeliver(e, i) { net_lawTakingStaysBelow_ensures(e.net, i, e.sent); }
}
