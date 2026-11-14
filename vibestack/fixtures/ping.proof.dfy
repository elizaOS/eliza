lemma ask_ensures(p: Ping)
  ensures (inv(p) ==> canAsk(p) ==> alwaysOnlyTheQuestionIsInFlight(ask(p)))
{
  if inv(p) && canAsk(p) {
    net_lawABoundCanGrow_ensures(p.net, p.sent);
    net_lawSendingStaysBelow_ensures(p.net, 0, 1);
  }
}

lemma resend_ensures(p: Ping)
  ensures (inv(p) ==> canResend(p) ==> alwaysOnlyTheQuestionIsInFlight(resend(p)))
{
  if inv(p) && canResend(p) { net_lawSendingStaysBelow_ensures(p.net, 0, p.sent); }
}

lemma lose_ensures(p: Ping, i: int)
  ensures (inv(p) ==> canLose(p, i) ==> alwaysOnlyTheQuestionIsInFlight(lose(p, i)))
{
  if inv(p) && canLose(p, i) { net_lawTakingStaysBelow_ensures(p.net, i, p.sent); }
}

lemma repeat_ensures(p: Ping, i: int)
  ensures (inv(p) ==> canRepeat(p, i) ==> alwaysOnlyTheQuestionIsInFlight(repeat(p, i)))
{
  if inv(p) && canRepeat(p, i) { net_lawRepeatingStaysBelow_ensures(p.net, i, p.sent); }
}

lemma deliver_ensures(p: Ping, i: int)
  ensures (inv(p) ==> canDeliver(p, i) ==> alwaysOnlyTheQuestionIsInFlight(deliver(p, i)))
{
  if inv(p) && canDeliver(p, i) { net_lawTakingStaysBelow_ensures(p.net, i, p.sent); }
}
