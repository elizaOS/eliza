lemma lawProjectionAccountsForEveryConstraint_ensures(constraints: seq<SchemaConstraint>, omitted: seq<SchemaConstraint>)
  ensures (lawProjectionAccountsForEveryConstraint(constraints, omitted) == true)
{
  var local_0 := projectToolSchema(constraints, omitted);
  var pw := (set_x: SchemaConstraint) => !((set_x in omitted));
  var pi := (set_x: SchemaConstraint) => (set_x in omitted);
  var pu := (set_x: SchemaConstraint) => !((set_x in local_0.wireConstraints));
  var pd := (set_x: SchemaConstraint) => (set_x in local_0.instructionConstraints);
  assert local_0.wireConstraints == ProofLib.Filter(pw, constraints);
  assert local_0.instructionConstraints == ProofLib.Filter(pi, constraints);
  var rhs := ProofLib.Filter(pu, local_0.instructionConstraints);
  var combined := local_0.wireConstraints + rhs;
  forall x | x in constraints
    ensures x in combined
  {
    ProofLib.FilterMember(pw, constraints, x);
    ProofLib.FilterMember(pi, constraints, x);
    if !(x in local_0.wireConstraints) {
      ProofLib.FilterMember(pu, local_0.instructionConstraints, x);
    }
  }
  forall x | x in combined
    ensures x in constraints
  {
    if x in local_0.wireConstraints {
      ProofLib.FilterMember(pw, constraints, x);
    } else {
      ProofLib.FilterMember(pu, local_0.instructionConstraints, x);
      ProofLib.FilterMember(pi, constraints, x);
    }
  }
  forall i | 0 <= i < |local_0.wireConstraints|
    ensures !pd(local_0.wireConstraints[i])
  {
    var x := local_0.wireConstraints[i];
    ProofLib.FilterMember(pw, constraints, x);
    ProofLib.FilterMember(pi, constraints, x);
  }
  ProofLib.FilterNone(pd, local_0.wireConstraints);
  assert |ProofLib.Filter(pd, local_0.wireConstraints)| == 0;
}
