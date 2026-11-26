lemma lawRequiredNeverWarns_ensures(results: seq<RequirementResult>, extra: RequirementResult)
  ensures (lawRequiredNeverWarns(results, extra) == true)
{
  if extra.level.Required? {
    ProofLib.FilterAppend((r: RequirementResult) => (r.level.Preferred? && (!r.checkOutcome.Met?)), results, extra);
  }
}
