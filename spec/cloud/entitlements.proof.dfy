lemma lawTokensStayInBounds_ensures(rates: BucketLimits, b: Bucket, clock: int)
  ensures (lawTokensStayInBounds(rates, b, clock) == true)
{
  var elapsed := maximum(b.at, clock) - b.at;
  if rates.burstRate >= 0 && rates.sustainedRate >= 0 {
    assert elapsed * rates.burstRate >= 0;
    assert elapsed * rates.sustainedRate >= 0;
  }
}
