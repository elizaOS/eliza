lemma ReminderIdentityShape(s: ReminderAuthority)
  ensures alwaysIssuedIdentityUnique(s) == (forall presentation :: presentation in s.issued ==> |ProofLib.Filter((other: ReminderPresentation) => (other.identity == presentation.identity), s.issued)| == 1)
{}

lemma ReminderIdentitiesDistinct(rows: seq<ReminderPresentation>)
  ensures (forall presentation :: presentation in rows ==> |ProofLib.Filter((other: ReminderPresentation) => (other.identity == presentation.identity), rows)| == 1) <==> ProofLib.DistinctBy(rows, (presentation: ReminderPresentation) => presentation.identity)
{
  if forall presentation :: presentation in rows ==> |ProofLib.Filter((other: ReminderPresentation) => (other.identity == presentation.identity), rows)| == 1 {
    forall i, j | 0 <= i < |rows| && 0 <= j < |rows| && i != j ensures rows[i].identity != rows[j].identity {
      ProofLib.FilterCountOneIffUnique((other: ReminderPresentation) => (other.identity == rows[i].identity), rows, (presentation: ReminderPresentation) => presentation.identity, i);
    }
  } else if ProofLib.DistinctBy(rows, (presentation: ReminderPresentation) => presentation.identity) {
    forall presentation | presentation in rows ensures |ProofLib.Filter((other: ReminderPresentation) => (other.identity == presentation.identity), rows)| == 1 {
      var i :| 0 <= i < |rows| && rows[i] == presentation;
      ProofLib.FilterOne((other: ReminderPresentation) => (other.identity == presentation.identity), rows, i);
    }
  }
}

lemma issue_ensures(s: ReminderAuthority, identity: string, body: string, chatText: string, title: string, bodyPresent: bool, titlePresent: bool, startsWithBody: bool)
  ensures (inv(s) ==> canIssue(s, identity, bodyPresent, titlePresent, startsWithBody) ==> alwaysIssuedIdentityUnique(issue(s, identity, body, chatText, title, bodyPresent, titlePresent, startsWithBody)))
  ensures (inv(s) ==> canIssue(s, identity, bodyPresent, titlePresent, startsWithBody) ==> stepPresentationsStayFrozen(s, issue(s, identity, body, chatText, title, bodyPresent, titlePresent, startsWithBody)))
{
  if inv(s) && canIssue(s, identity, bodyPresent, titlePresent, startsWithBody) {
    ReminderIdentityShape(s);
    ReminderIdentitiesDistinct(s.issued);
    ProofLib.DistinctByConcat(s.issued, [ReminderPresentation(identity, body, chatText, title)], (presentation: ReminderPresentation) => presentation.identity);
    var after := issue(s, identity, body, chatText, title, bodyPresent, titlePresent, startsWithBody);
    ReminderIdentitiesDistinct(after.issued);
    ReminderIdentityShape(after);
  }
}
