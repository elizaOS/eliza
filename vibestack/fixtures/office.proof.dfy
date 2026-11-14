lemma serve_ensures(o: Office)
  ensures (inv(o) ==> alwaysTheDeskKeepsItsRule(serve(o)))
{
  ticket_issue_ensures(o.desk);
}
