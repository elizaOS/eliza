lemma lawTestMocksDoNotBind_ensures(present: bool, passed: bool)
  ensures (lawTestMocksDoNotBind(present, passed) == true)
{
  var qualifies := (row: CampaignReceipt) => !row.mockOnly || |row.appHashes| > 0;
  ProofLib.FilterNone(qualifies, [mockReceipt]);
}

lemma lawMissingSuiteRowCannotBind_ensures(present: bool, passed: bool)
  ensures (lawMissingSuiteRowCannotBind(present, passed) == true)
{
  var qualifies := (row: CampaignReceipt) => !row.mockOnly || |row.appHashes| > 0;
  ProofLib.FilterMember(qualifies, [plainReceipt, unreadableReceipt], unreadableReceipt);
  assert unreadableReceipt in Std.Collections.Seq.Filter(qualifies, [plainReceipt, unreadableReceipt]);
  assert |unreadableReceipt.appHashes| == 0;
}
