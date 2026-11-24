// A step answers with at most two effects, and a receipt is kept where it stands among them.
lemma FlowReceipts(out: seq<SignInEffect>)
  requires |out| <= 2
  ensures Std.Collections.Seq.Filter((e: SignInEffect) => isSettled(e), out) ==
    (if |out| == 0 then [] else (if isSettled(out[0]) then [out[0]] else []) + (if |out| == 2 && isSettled(out[1]) then [out[1]] else []))
{
  var p := (e: SignInEffect) => isSettled(e);
  if |out| == 0 {
    ProofLib.FilterNil(p, out);
  } else {
    ProofLib.FilterCons(p, out);
    if |out| == 1 {
      ProofLib.FilterNil(p, out[1..]);
    } else {
      ProofLib.FilterCons(p, out[1..]);
      ProofLib.FilterNil(p, out[1..][1..]);
    }
  }
}
