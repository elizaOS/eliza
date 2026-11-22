lemma CountStreamTerminalFrames(deltas: seq<int>, ending: StreamEnding, usageAsked: bool, usageReported: bool, frame: Frame)
  requires !frame.Delta?
  ensures countOf(streamFrames(deltas, ending, usageAsked, usageReported), frame) ==
    (if (frame.Done? && !ending.StreamHungUp?) || (frame.ErrorChunk? && ending.StreamFailed?) ||
      (frame.UsageChunk? && ending.StreamFinished? && usageAsked && usageReported) then 1 else 0)
{
  var body := streamFrames(deltas, StreamEnding.StreamHungUp, false, false);
  var frames := streamFrames(deltas, ending, usageAsked, usageReported);
  assert |body| == |deltas|;
  var matches := (candidate: Frame) => candidate == frame;
  forall i | 0 <= i < |body|
    ensures !matches(body[i])
  {
    assert body[i] == Delta(deltas[i]);
  }
  ProofLib.FilterNone(matches, body);
  assert |ProofLib.Filter(matches, body)| == 0;
  assert countOf(frames, frame) == |ProofLib.Filter(matches, frames)|;
  if ending.StreamFinished? {
    if usageAsked && usageReported {
      assert frames == body + [Frame.UsageChunk, Frame.Done];
      assert frames == (body + [Frame.UsageChunk]) + [Frame.Done];
      ProofLib.FilterAppend(matches, body, Frame.UsageChunk);
      ProofLib.FilterAppend(matches, body + [Frame.UsageChunk], Frame.Done);
    } else {
      assert frames == body + [Frame.Done];
      ProofLib.FilterAppend(matches, body, Frame.Done);
    }
  } else if ending.StreamFailed? {
    assert frames == body + [Frame.ErrorChunk, Frame.Done];
    assert frames == (body + [Frame.ErrorChunk]) + [Frame.Done];
    ProofLib.FilterAppend(matches, body, Frame.ErrorChunk);
    ProofLib.FilterAppend(matches, body + [Frame.ErrorChunk], Frame.Done);
  }
}

lemma lawOnlyAFailedStreamSendsAnError_ensures(deltas: seq<int>, ending: StreamEnding, usageAsked: bool, usageReported: bool)
  ensures (lawOnlyAFailedStreamSendsAnError(deltas, ending, usageAsked, usageReported) == true)
{
  CountStreamTerminalFrames(deltas, ending, usageAsked, usageReported, Frame.ErrorChunk);
}

lemma lawEveryUnbrokenStreamEndsInOneDone_ensures(deltas: seq<int>, ending: StreamEnding, usageAsked: bool, usageReported: bool)
  ensures (lawEveryUnbrokenStreamEndsInOneDone(deltas, ending, usageAsked, usageReported) == true)
{
  CountStreamTerminalFrames(deltas, ending, usageAsked, usageReported, Frame.Done);
}

lemma lawUsageIsSentOnceAndOnlyAsReported_ensures(deltas: seq<int>, ending: StreamEnding, usageAsked: bool, usageReported: bool)
  ensures (lawUsageIsSentOnceAndOnlyAsReported(deltas, ending, usageAsked, usageReported) == true)
{
  CountStreamTerminalFrames(deltas, ending, usageAsked, usageReported, Frame.UsageChunk);
}

lemma ReadChunkConcat(initial: SseReader, first: seq<int>, second: seq<int>)
  ensures readChunk(readChunk(initial, first), second) == readChunk(initial, first + second)
  decreases |second|
{
  if |second| == 0 {
    reveal Std.Collections.Seq.FoldLeft();
    assert first + second == first;
  } else {
    var prefix := second[..|second| - 1];
    var last := second[|second| - 1];
    var step := (reader: SseReader, symbol: int) => readSymbol(reader, symbol);
    assert second == prefix + [last];
    assert first + second == (first + prefix) + [last];
    ReadChunkConcat(initial, first, prefix);
    ProofLib.FoldLeftAppend(step, readChunk(initial, first), prefix, last);
    ProofLib.FoldLeftAppend(step, initial, first + prefix, last);
    calc {
      readChunk(readChunk(initial, first), second);
      == readSymbol(readChunk(readChunk(initial, first), prefix), last);
      == readSymbol(readChunk(initial, first + prefix), last);
      == readChunk(initial, first + second);
    }
  }
}

lemma lawChunkBoundariesDoNotChangeEvents_ensures(first: seq<int>, second: seq<int>)
  ensures (lawChunkBoundariesDoNotChangeEvents(first, second) == true)
{
  ReadChunkConcat(emptyReader, first, second);
}
