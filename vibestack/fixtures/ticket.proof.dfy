lemma issue_ensures(d: Desk)
  ensures (inv(d) ==> alwaysTheLastNumberIsNotNegative(issue(d)))
{
  highest_lawTheHighestIsAtLeastTheStart_ensures(d.issued, d.last);
}
