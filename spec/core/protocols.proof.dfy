lemma lawLocaleHintOccurrencesAreCounted_ensures(tokens: seq<string>, hints: seq<string>, marked: bool, word: string)
  ensures (lawLocaleHintOccurrencesAreCounted(tokens, hints, marked, word) == true)
{
  reveal lawLocaleHintOccurrencesAreCounted(), localeHintScore(), ProofLib.Filter();
  ProofLib.FilterAppend((word: string) => (word in hints), tokens, word);
}

lemma KeywordEmptyScan(text: seq<int>, remaining: seq<int>, position: int)
  ensures !Std.Collections.Seq.FoldLeft((scan: KeywordScan, unit: int) => KeywordScan((scan.position + 1), (scan.matched || keywordOccurrenceAt(text, [], scan.position, false))), KeywordScan(position, false), remaining).matched
  decreases |remaining|
{
  if |remaining| > 0 {
    KeywordEmptyScan(text, remaining[1..], position + 1);
  }
}

lemma lawKeywordMatchingUsesLiteralEndpoints_ensures(text: seq<int>, units: seq<int>)
  ensures (lawKeywordMatchingUsesLiteralEndpoints(text, units) == true)
{
  if |units| == 0 {
    KeywordEmptyScan(text, text, 0);
  }
}

lemma lawKeywordDocumentAppend_ensures(terms: seq<KeywordSourceTerm>, term: KeywordSourceTerm)
  ensures (lawKeywordDocumentAppend(terms, term) == true)
{
  ProofLib.FoldLeftAppend((document: KeywordDocument, term: KeywordSourceTerm) => appendKeywordDocument(document, term), KeywordDocument([], []), terms, term);
}

lemma lawPreparedKeywordAppend_ensures(terms: seq<KeywordSourceTerm>, term: KeywordSourceTerm)
  ensures (lawPreparedKeywordAppend(terms, term) == true)
{
  ProofLib.FoldLeftAppend((prepared: seq<PreparedKeyword>, term: KeywordSourceTerm) => appendPreparedKeyword(prepared, term), [], terms, term);
}

lemma lawLongestKeywordAppend_ensures(text: seq<int>, terms: seq<KeywordSourceTerm>, term: KeywordSourceTerm)
  ensures (lawLongestKeywordAppend(text, terms, term) == true)
{
  ProofLib.FoldLeftAppend((choice: KeywordChoice, term: KeywordSourceTerm) => chooseKeywordMatch(choice, text, term), KeywordChoice.NoKeyword, terms, term);
}

lemma lawCollectedKeywordTextAppend_ensures(texts: seq<seq<int>>, text: seq<int>, prepared: seq<PreparedKeyword>)
  ensures (lawCollectedKeywordTextAppend(texts, text, prepared) == true)
{
  ProofLib.FoldLeftAppend((matches: seq<seq<int>>, text: seq<int>) => collectKeywordText(matches, text, prepared), [], texts, text);
}

lemma KeywordCollectTextNonempty(found: seq<seq<int>>, text: seq<int>, prepared: seq<PreparedKeyword>)
  ensures (|collectKeywordText(found, text, prepared)| > 0) == (|found| > 0 || (|text| > 0 && exists entry :: entry in prepared && matchesKeywordPattern(text, entry.pattern)))
  decreases |prepared|
{
  if |prepared| > 0 {
    var first := prepared[0];
    var after := appendKeywordMatch(found, text, first);
    KeywordCollectTextNonempty(after, text, prepared[1..]);
    assert collectKeywordText(found, text, prepared) == collectKeywordText(after, text, prepared[1..]);
    assert (|after| > 0) == (|found| > 0 || (|text| > 0 && matchesKeywordPattern(text, first.pattern)));
    assert forall entry :: entry in prepared <==> entry == first || entry in prepared[1..];
  }
}

lemma KeywordCollectNonempty(found: seq<seq<int>>, texts: seq<seq<int>>, prepared: seq<PreparedKeyword>)
  ensures (|Std.Collections.Seq.FoldLeft((matches: seq<seq<int>>, text: seq<int>) => collectKeywordText(matches, text, prepared), found, texts)| > 0) == (|found| > 0 || hasKeywordMatch(texts, prepared))
  decreases |texts|
{
  if |texts| > 0 {
    var first := texts[0];
    var after := collectKeywordText(found, first, prepared);
    KeywordCollectTextNonempty(found, first, prepared);
    KeywordCollectNonempty(after, texts[1..], prepared);
    assert forall text :: text in texts <==> text == first || text in texts[1..];
  }
}

lemma lawKeywordExistenceMatchesCollection_ensures(texts: seq<seq<int>>, prepared: seq<PreparedKeyword>)
  ensures (lawKeywordExistenceMatchesCollection(texts, prepared) == true)
{
  KeywordCollectNonempty([], texts, prepared);
}

lemma KeywordLongestMaximal(text: seq<int>, terms: seq<KeywordSourceTerm>)
  ensures lawLongestKeywordIsAMaximalMatch(text, terms)
  decreases |terms|
{
  if |terms| > 0 {
    var prefix := terms[..|terms| - 1];
    var last := terms[|terms| - 1];
    KeywordLongestMaximal(text, prefix);
    ProofLib.FoldLeftAppend((choice: KeywordChoice, term: KeywordSourceTerm) => chooseKeywordMatch(choice, text, term), KeywordChoice.NoKeyword, prefix, last);
    var previous := longestKeywordMatch(text, prefix);
    var chosen := longestKeywordMatch(text, terms);
    assert terms == prefix + [last];
    assert chosen == chooseKeywordMatch(previous, text, last);
    assert forall term :: term in terms <==> term in prefix || term == last;
    if chosen.ChosenKeyword? {
      forall term | term in terms
        ensures !matchesKeywordPattern(text, compileKeywordPattern(term.normalized)) || |term.raw| <= |chosen.raw|
      {
        if term in prefix {
          if previous.NoKeyword? {
            assert !matchesKeywordPattern(text, compileKeywordPattern(term.normalized));
          } else {
            assert |previous.raw| <= |chosen.raw|;
          }
        }
      }
    }
  }
}

lemma lawLongestKeywordIsAMaximalMatch_ensures(text: seq<int>, terms: seq<KeywordSourceTerm>)
  ensures (lawLongestKeywordIsAMaximalMatch(text, terms) == true)
{
  KeywordLongestMaximal(text, terms);
}
