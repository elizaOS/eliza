lemma lawAdmittedRunnersTargetTheApp_ensures(declared: seq<RunnerDeclaration>, reviewed: seq<string>, app: string)
  ensures (lawAdmittedRunnersTargetTheApp(declared, reviewed, app) == true)
{
  if runnersAdmitted(declared, reviewed, app) {
    forall n | n in reviewed
      ensures exists d :: d in declared && d.name == n
    {
      var matches := ProofLib.Filter((d: RunnerDeclaration) => (d.name == n), declared);
      assert |matches| == 1;
      ProofLib.FilterMember((d: RunnerDeclaration) => (d.name == n), declared, matches[0]);
      assert matches[0] in declared && matches[0].name == n;
    }
  }
}
