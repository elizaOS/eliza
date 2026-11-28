// spec/agent/voice/session.md, "Filler, sound annotations and the assistant's own echo are never a turn"
lemma overlapPercent_ensures(count: int, words: int)
  requires (0 <= count)
  requires (count <= words)
  ensures (0 <= overlapPercent(count, words))
  ensures (overlapPercent(count, words) <= 100)
  ensures ((words > 0) ==> ((overlapPercent(count, words) >= echoOverlapPercent) == ((count * 100) >= (echoOverlapPercent * words))))
{
  hide *;
  reveal overlapPercent, JSFloorDiv;
  if words > 0 {
    var numerator := count * 100;
    assert overlapPercent(count, words) == numerator / words;
    EchoOverlapThreshold(numerator, words, 0);
    EchoOverlapThreshold(numerator, words, 101);
    EchoOverlapThreshold(numerator, words, echoOverlapPercent);
  }
}

lemma EchoOverlapThreshold(numerator: int, words: int, threshold: int)
  requires words > 0
  ensures (numerator / words >= threshold) == (numerator >= threshold * words)
{
  hide *;
  var quotient := numerator / words;
  var remainder := numerator % words;
  assert numerator == quotient * words + remainder;
  assert 0 <= remainder < words;
  if quotient >= threshold {
    assert (quotient - threshold) * words >= 0;
    assert quotient * words == threshold * words + (quotient - threshold) * words;
  } else {
    assert (threshold - quotient - 1) * words >= 0;
    assert threshold * words == (quotient + 1) * words + (threshold - quotient - 1) * words;
    assert numerator < (quotient + 1) * words;
  }
}
