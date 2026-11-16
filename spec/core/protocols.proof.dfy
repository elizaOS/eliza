lemma lawLocaleHintOccurrencesAreCounted_ensures(tokens: seq<string>, hints: seq<string>, marked: bool, word: string)
  ensures (lawLocaleHintOccurrencesAreCounted(tokens, hints, marked, word) == true)
{
  reveal lawLocaleHintOccurrencesAreCounted(), localeHintScore(), ProofLib.Filter();
  ProofLib.FilterAppend((word: string) => (word in hints), tokens, word);
}
