lemma ProseKept(xs: seq<ReplySegment>)
  ensures |ProofLib.Filter((segment: ReplySegment) => segment.ProseSegment?, ProofLib.Filter((segment: ReplySegment) => spoken(segment), xs))| == |ProofLib.Filter((segment: ReplySegment) => segment.ProseSegment?, xs)|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil((segment: ReplySegment) => spoken(segment), xs);
    ProofLib.FilterNil((segment: ReplySegment) => segment.ProseSegment?, xs);
    ProofLib.FilterNil((segment: ReplySegment) => segment.ProseSegment?, ProofLib.Filter((segment: ReplySegment) => spoken(segment), xs));
  } else {
    ProofLib.FilterCons((segment: ReplySegment) => spoken(segment), xs);
    ProofLib.FilterCons((segment: ReplySegment) => segment.ProseSegment?, xs);
    ProseKept(xs[1..]);
    var rest := ProofLib.Filter((segment: ReplySegment) => spoken(segment), xs[1..]);
    if spoken(xs[0]) {
      assert ProofLib.Filter((segment: ReplySegment) => spoken(segment), xs) == [xs[0]] + rest;
      ProofLib.FilterCons((segment: ReplySegment) => segment.ProseSegment?, [xs[0]] + rest);
      assert ([xs[0]] + rest)[1..] == rest;
    } else {
      assert ProofLib.Filter((segment: ReplySegment) => spoken(segment), xs) == rest;
      assert !xs[0].ProseSegment?;
    }
  }
}

lemma ProseBridge(reply: seq<ReplySegment>)
  ensures lawEveryProseSegmentIsSpoken(reply) == (|ProofLib.Filter((segment: ReplySegment) => segment.ProseSegment?, ProofLib.Filter((segment: ReplySegment) => spoken(segment), reply))| == |ProofLib.Filter((segment: ReplySegment) => segment.ProseSegment?, reply)|)
{
}

lemma lawEveryProseSegmentIsSpoken_ensures(reply: seq<ReplySegment>)
  ensures (lawEveryProseSegmentIsSpoken(reply) == true)
{
  ProseKept(reply);
  ProseBridge(reply);
}
