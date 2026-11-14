lemma ensureWorker_ensures(s: ApprovalWorkers, name: string, registrationSucceeds: bool)
  ensures (inv(s) ==> alwaysCountMatchesDistinctWorkers(ensureWorker(s, name, registrationSucceeds)))
  ensures (inv(s) ==> stepWorkerNamesAreRetained(s, "ensureWorker", ensureWorker(s, name, registrationSucceeds)))
{
  if inv(s) && !(name in s.registered) && registrationSucceeds {
    ProofLib.FilterCons((set_x: string) => !((set_x in s.registered)), [name]);
    ProofLib.FilterNil((set_x: string) => !((set_x in s.registered)), []);
  }
}
