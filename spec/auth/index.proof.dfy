lemma lawInvalidBindingSendsNothing_ensures(b: AppBinding)
  ensures (lawInvalidBindingSendsNothing(b) == true)
{
  InvalidBindingFilter(b);
  ProofLib.FilterNone((planned: SignInStep) => planned.ContactIdentityService?, signInPlan(b));
}

lemma InvalidBindingFilter(b: AppBinding)
  ensures lawInvalidBindingSendsNothing(b) == (!(!(bindingValid(b))) || (|ProofLib.Filter((planned: SignInStep) => planned.ContactIdentityService?, signInPlan(b))| == 0))
{
}
