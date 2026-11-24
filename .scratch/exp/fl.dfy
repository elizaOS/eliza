// A step answers with at most two effects, and a receipt is kept where it stands among them.
lemma FlowReceipts(out: seq<SignInEffect>)
  requires |out| <= 2
  ensures Std.Collections.Seq.Filter((e: SignInEffect) => isSettled(e), out) ==
    (if |out| == 0 then [] else (if isSettled(out[0]) then [out[0]] else []) + (if |out| == 2 && isSettled(out[1]) then [out[1]] else []))
{
  reveal Std.Collections.Seq.Filter();
  if |out| >= 1 {
    assert Std.Collections.Seq.Filter((e: SignInEffect) => isSettled(e), out) ==
      (if isSettled(out[0]) then [out[0]] else []) + Std.Collections.Seq.Filter((e: SignInEffect) => isSettled(e), out[1..]);
    if |out| == 2 {
      assert Std.Collections.Seq.Filter((e: SignInEffect) => isSettled(e), out[1..]) ==
        (if isSettled(out[1]) then [out[1]] else []) + Std.Collections.Seq.Filter((e: SignInEffect) => isSettled(e), out[1..][1..]);
      assert out[1..][1..] == [];
    }
    assert out[1..] == [] || |out| == 2;
  }
}
