// spec/cloud/index.md, "A streamed answer sends complete OpenAI frames and settles the same hold"

lemma lawEventsDoNotDependOnChunking_ensures(i_s: Segmenter, i_a: seq<int>, i_b: seq<int>)
  ensures (fed(i_s, (i_a + i_b)).segmenter == fed(fed(i_s, i_a).segmenter, i_b).segmenter)
  ensures (fed(i_s, (i_a + i_b)).events == (fed(i_s, i_a).events + fed(fed(i_s, i_a).segmenter, i_b).events))
{
  if |i_b| == 0 {
    assert i_a + i_b == i_a;
  } else {
    var front := i_b[0..(|i_b| - 1)];
    assert (i_a + i_b)[0..(|i_a + i_b| - 1)] == i_a + front;
    assert (i_a + i_b)[(|i_a + i_b| - 1)] == i_b[(|i_b| - 1)];
    lawEventsDoNotDependOnChunking_ensures(i_s, i_a, front);
  }
}
lemma lawDecodingDoesNotDependOnChunking_ensures(i_d: Utf8, i_a: seq<int>, i_b: seq<int>)
  ensures (decoded(i_d, (i_a + i_b)).decoder == decoded(decoded(i_d, i_a).decoder, i_b).decoder)
  ensures (decoded(i_d, (i_a + i_b)).codePoints == (decoded(i_d, i_a).codePoints + decoded(decoded(i_d, i_a).decoder, i_b).codePoints))
{
  if |i_b| == 0 {
    assert i_a + i_b == i_a;
    var z := decoded(i_d, i_a);
    assert decoded(z.decoder, i_b) == Decoded(z.decoder, []);
    assert z.codePoints + [] == z.codePoints;
  } else {
    var front := i_b[0..(|i_b| - 1)];
    var last := i_b[(|i_b| - 1)];
    assert (i_a + i_b)[0..(|i_a + i_b| - 1)] == i_a + front;
    assert (i_a + i_b)[(|i_a + i_b| - 1)] == last;
    lawDecodingDoesNotDependOnChunking_ensures(i_d, i_a, front);
    var x := decoded(i_d, i_a + front);
    var y := decoded(decoded(i_d, i_a).decoder, front);
    var p := pushUtf8(x.decoder, last);
    assert decoded(i_d, i_a + i_b) == Decoded(p.decoder, x.codePoints + p.codePoints);
    assert decoded(decoded(i_d, i_a).decoder, i_b) == Decoded(p.decoder, y.codePoints + p.codePoints);
    assert x.codePoints == decoded(i_d, i_a).codePoints + y.codePoints;
    assert (decoded(i_d, i_a).codePoints + y.codePoints) + p.codePoints == decoded(i_d, i_a).codePoints + (y.codePoints + p.codePoints);
  }
}
