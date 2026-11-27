lemma lawCalendarFollowsTheStatedZone_ensures(namedZone: string, agentZone: string)
  ensures (lawCalendarFollowsTheStatedZone(namedZone, agentZone) == true)
{
  lawTheEmptyNameIsNoZone_ensures(namedZone);
}
