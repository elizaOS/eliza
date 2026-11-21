lemma normalizeSubscriptionCode_ensures(text: string)
  ensures allCrockford(normalizeSubscriptionCode(text))
  ensures ((|normalizeSubscriptionCode(text)| == grantCodeLength) || (|normalizeSubscriptionCode(text)| == 0))
  ensures (readable(text) ==> (|canonical(text)| == grantCodeLength) ==> (normalizeSubscriptionCode(text) == canonical(text)))
  ensures (!((readable(text) && (|canonical(text)| == grantCodeLength))) ==> (|normalizeSubscriptionCode(text)| == 0))
{
  canonical_ensures(text);
}
