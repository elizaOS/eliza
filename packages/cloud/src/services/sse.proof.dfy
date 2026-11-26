// spec/cloud/index.md, "A streamed answer sends complete OpenAI frames and settles the same hold"

lemma lawEventsDoNotDependOnChunking_ensures(s: Segmenter, a: seq<int>, b: seq<int>)
  ensures (fed(s, (a + b)).segmenter == fed(fed(s, a).segmenter, b).segmenter)
  ensures (fed(s, (a + b)).events == (fed(s, a).events + fed(fed(s, a).segmenter, b).events))
{
  if |b| == 0 {
    assert a + b == a;
  } else {
    var front := b[0..(|b| - 1)];
    assert (a + b)[0..(|a + b| - 1)] == a + front;
    assert (a + b)[(|a + b| - 1)] == b[(|b| - 1)];
    lawEventsDoNotDependOnChunking_ensures(s, a, front);
  }
}
lemma lawDecodingDoesNotDependOnChunking_ensures(d: Utf8, a: seq<int>, b: seq<int>)
  ensures (decoded(d, (a + b)).decoder == decoded(decoded(d, a).decoder, b).decoder)
  ensures (decoded(d, (a + b)).codePoints == (decoded(d, a).codePoints + decoded(decoded(d, a).decoder, b).codePoints))
{
  if |b| == 0 {
    assert a + b == a;
    var z := decoded(d, a);
    assert decoded(z.decoder, b) == Decoded(z.decoder, []);
    assert z.codePoints + [] == z.codePoints;
  } else {
    var front := b[0..(|b| - 1)];
    var last := b[(|b| - 1)];
    assert (a + b)[0..(|a + b| - 1)] == a + front;
    assert (a + b)[(|a + b| - 1)] == last;
    lawDecodingDoesNotDependOnChunking_ensures(d, a, front);
    var x := decoded(d, a + front);
    var y := decoded(decoded(d, a).decoder, front);
    var p := pushUtf8(x.decoder, last);
    assert decoded(d, a + b) == Decoded(p.decoder, x.codePoints + p.codePoints);
    assert decoded(decoded(d, a).decoder, b) == Decoded(p.decoder, y.codePoints + p.codePoints);
    assert x.codePoints == decoded(d, a).codePoints + y.codePoints;
    assert (decoded(d, a).codePoints + y.codePoints) + p.codePoints == decoded(d, a).codePoints + (y.codePoints + p.codePoints);
  }
}
