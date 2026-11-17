lemma lawOneOpaqueViewHidesTheSurfaceBelow_ensures(hostTransparent: bool, ancestors: seq<bool>)
  ensures (lawOneOpaqueViewHidesTheSurfaceBelow(hostTransparent, ancestors) == true)
{
  assert false in ancestors + [false];
  assert forall t :: t in ancestors + [true] <==> t in ancestors || t == true;
}
