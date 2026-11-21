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

// Hex: the separator filter, the digits of one byte, and decoding what encoding wrote.

lemma HexStripFilter(hexText: seq<int>)
  ensures stripHexSeparators(hexText) == ProofLib.Filter((code: int) => isHexCode(code), hexText)
{
}

lemma HexFilterConcat(xs: seq<int>, ys: seq<int>)
  ensures ProofLib.Filter((code: int) => isHexCode(code), xs + ys) == ProofLib.Filter((code: int) => isHexCode(code), xs) + ProofLib.Filter((code: int) => isHexCode(code), ys)
  decreases |ys|
{
  if |ys| == 0 {
    assert xs + ys == xs;
    ProofLib.FilterNil((code: int) => isHexCode(code), ys);
  } else {
    var prefix := ys[..|ys| - 1];
    var last := ys[|ys| - 1];
    assert ys == prefix + [last];
    assert xs + ys == (xs + prefix) + [last];
    HexFilterConcat(xs, prefix);
    ProofLib.FilterAppend((code: int) => isHexCode(code), xs + prefix, last);
    ProofLib.FilterAppend((code: int) => isHexCode(code), prefix, last);
  }
}

lemma lawHexSeparatorIsIgnored_ensures(before: seq<int>, after: seq<int>, separator: int)
  ensures (lawHexSeparatorIsIgnored(before, after, separator) == true)
{
  if !isHexCode(separator) {
    HexStripFilter((before + [separator]) + after);
    HexStripFilter(before + after);
    HexFilterConcat(before + [separator], after);
    HexFilterConcat(before, after);
    ProofLib.FilterAppend((code: int) => isHexCode(code), before, separator);
    assert stripHexSeparators((before + [separator]) + after) == stripHexSeparators(before + after);
  }
}

lemma HexByteDigits(value: int)
  requires 0 <= value <= 255
  ensures 0 <= quotient_core__protocols(value, 16) < 16
  ensures 0 <= remainder_core__protocols(value, 16) < 16
  ensures quotient_core__protocols(value, 16) * 16 + remainder_core__protocols(value, 16) == value
  ensures isHexCode(hexDigitCode(quotient_core__protocols(value, 16)))
  ensures isHexCode(hexDigitCode(remainder_core__protocols(value, 16)))
  ensures hexCodeValue(hexDigitCode(quotient_core__protocols(value, 16))) == quotient_core__protocols(value, 16)
  ensures hexCodeValue(hexDigitCode(remainder_core__protocols(value, 16))) == remainder_core__protocols(value, 16)
{
  assert quotient_core__protocols(value, 16) == value / 16;
}

lemma HexEncodeAppend(byteList: seq<int>, byte: int)
  ensures encodeHex(byteList + [byte]) == encodeHex(byteList) + [hexDigitCode(quotient_core__protocols(byte, 16)), hexDigitCode(remainder_core__protocols(byte, 16))]
{
  ProofLib.FoldLeftAppend((codes: seq<int>, value: int) => (codes + [hexDigitCode(quotient_core__protocols(value, 16)), hexDigitCode(remainder_core__protocols(value, 16))]), [], byteList, byte);
}

lemma HexEncodeDecodes(byteList: seq<int>)
  requires allBytes(byteList)
  ensures forall code :: code in encodeHex(byteList) ==> isHexCode(code)
  ensures Std.Collections.Seq.FoldLeft((decoding: HexDecoding, code: int) => decodeHexDigit(decoding, code), HexDecoding([], -1), encodeHex(byteList)) == HexDecoding(byteList, -1)
  decreases |byteList|
{
  if |byteList| > 0 {
    var prefix := byteList[..|byteList| - 1];
    var value := byteList[|byteList| - 1];
    assert byteList == prefix + [value];
    assert value in byteList;
    assert forall v :: v in prefix ==> v in byteList;
    HexEncodeDecodes(prefix);
    HexEncodeAppend(prefix, value);
    HexByteDigits(value);
    var high := hexDigitCode(quotient_core__protocols(value, 16));
    var low := hexDigitCode(remainder_core__protocols(value, 16));
    assert encodeHex(byteList) == (encodeHex(prefix) + [high]) + [low];
    ProofLib.FoldLeftAppend((decoding: HexDecoding, code: int) => decodeHexDigit(decoding, code), HexDecoding([], -1), encodeHex(prefix) + [high], low);
    ProofLib.FoldLeftAppend((decoding: HexDecoding, code: int) => decodeHexDigit(decoding, code), HexDecoding([], -1), encodeHex(prefix), high);
  }
}

lemma HexFilterKeepsAll(hexText: seq<int>)
  requires forall code :: code in hexText ==> isHexCode(code)
  ensures ProofLib.Filter((code: int) => isHexCode(code), hexText) == hexText
  decreases |hexText|
{
  if |hexText| == 0 {
    ProofLib.FilterNil((code: int) => isHexCode(code), hexText);
  } else {
    var prefix := hexText[..|hexText| - 1];
    var last := hexText[|hexText| - 1];
    assert hexText == prefix + [last];
    assert last in hexText;
    assert forall code :: code in prefix ==> code in hexText;
    HexFilterKeepsAll(prefix);
    ProofLib.FilterAppend((code: int) => isHexCode(code), prefix, last);
  }
}

lemma lawHexRoundTripReturnsTheBytes_ensures(byteList: seq<int>)
  ensures (lawHexRoundTripReturnsTheBytes(byteList) == true)
{
  if allBytes(byteList) {
    HexEncodeDecodes(byteList);
    HexFilterKeepsAll(encodeHex(byteList));
    HexStripFilter(encodeHex(byteList));
  }
}

// UUID: the derived bytes stay bytes, so every digit is a hex digit.

lemma UuidDerivedBytes(digest: seq<int>)
  requires allBytes(digest)
  ensures |uuidBytesFromDigest(digest)| == 16
  ensures forall i :: 0 <= i < 16 ==> 0 <= uuidBytesFromDigest(digest)[i] <= 255
  ensures 0 <= uuidBytesFromDigest(digest)[6] < 16
  ensures 128 <= uuidBytesFromDigest(digest)[8] < 192
{
  forall i | 0 <= i < 16 && i < |digest|
    ensures 0 <= digest[i] <= 255
  {
    assert digest[i] in digest;
  }
  var six := if 6 < |digest| then digest[6] else 0;
  var eight := if 8 < |digest| then digest[8] else 0;
  assert quotient_core__protocols(six, 16) == six / 16;
  assert quotient_core__protocols(eight, 64) == eight / 64;
}

lemma lawDerivedUuidHasVersionZeroAndVariantBits_ensures(digest: seq<int>)
  ensures (lawDerivedUuidHasVersionZeroAndVariantBits(digest) == true)
{
  if allBytes(digest) {
    UuidDerivedBytes(digest);
  }
}

lemma UuidFormattedIsValid(uuidBytes: seq<int>)
  requires |uuidBytes| == 16
  requires forall i :: 0 <= i < 16 ==> 0 <= uuidBytes[i] <= 255
  ensures isUuidText(formatUuidBytes(uuidBytes))
{
  forall i | 0 <= i < 16
    ensures isHexCode(hexDigitCode(quotient_core__protocols(uuidBytes[i], 16)))
    ensures isHexCode(hexDigitCode(remainder_core__protocols(uuidBytes[i], 16)))
  {
    HexByteDigits(uuidBytes[i]);
  }
  var text := formatUuidBytes(uuidBytes);
  forall index | index in uuidPositions
    ensures (if uuidHyphenAt(index) then ((if ((0 <= index) && (index < |text|)) then text[index] else -1) == 45) else isHexCode((if ((0 <= index) && (index < |text|)) then text[index] else -1)))
  {
  }
}

lemma lawDerivedUuidIsAValidUuid_ensures(digest: seq<int>)
  ensures (lawDerivedUuidIsAValidUuid(digest) == true)
{
  if allBytes(digest) {
    UuidDerivedBytes(digest);
    UuidFormattedIsValid(uuidBytesFromDigest(digest));
  }
}

lemma lawUuidDerivationIsIdempotent_ensures(uuidText: seq<int>, digest: seq<int>, again: seq<int>)
  ensures (lawUuidDerivationIsIdempotent(uuidText, digest, again) == true)
{
  if allBytes(digest) {
    lawDerivedUuidIsAValidUuid_ensures(digest);
  }
}

// Shuffle: a swap exchanges two in-range slots or changes nothing, so the multiset of items is kept.

lemma ShuffleSwapScan(items: seq<string>, slot: int, pick: int, k: int)
  requires 0 <= k <= |items|
  ensures Std.Collections.Seq.FoldLeft((scan: ShuffleScan, member: string) => ShuffleScan((scan.slotIndex + 1), (scan.swapped + [(if (scan.slotIndex == slot) then (if ((0 <= pick) && (pick < |items|)) then items[pick] else member) else (if (scan.slotIndex == pick) then (if ((0 <= slot) && (slot < |items|)) then items[slot] else member) else member))])), ShuffleScan(0, []), items[..k]).slotIndex == k
  ensures |Std.Collections.Seq.FoldLeft((scan: ShuffleScan, member: string) => ShuffleScan((scan.slotIndex + 1), (scan.swapped + [(if (scan.slotIndex == slot) then (if ((0 <= pick) && (pick < |items|)) then items[pick] else member) else (if (scan.slotIndex == pick) then (if ((0 <= slot) && (slot < |items|)) then items[slot] else member) else member))])), ShuffleScan(0, []), items[..k]).swapped| == k
  ensures forall i :: 0 <= i < k ==> Std.Collections.Seq.FoldLeft((scan: ShuffleScan, member: string) => ShuffleScan((scan.slotIndex + 1), (scan.swapped + [(if (scan.slotIndex == slot) then (if ((0 <= pick) && (pick < |items|)) then items[pick] else member) else (if (scan.slotIndex == pick) then (if ((0 <= slot) && (slot < |items|)) then items[slot] else member) else member))])), ShuffleScan(0, []), items[..k]).swapped[i] == (if i == slot then (if 0 <= pick < |items| then items[pick] else items[i]) else (if i == pick then (if 0 <= slot < |items| then items[slot] else items[i]) else items[i]))
  decreases k
{
  if k > 0 {
    ShuffleSwapScan(items, slot, pick, k - 1);
    assert items[..k] == items[..k - 1] + [items[k - 1]];
    ProofLib.FoldLeftAppend((scan: ShuffleScan, member: string) => ShuffleScan((scan.slotIndex + 1), (scan.swapped + [(if (scan.slotIndex == slot) then (if ((0 <= pick) && (pick < |items|)) then items[pick] else member) else (if (scan.slotIndex == pick) then (if ((0 <= slot) && (slot < |items|)) then items[slot] else member) else member))])), ShuffleScan(0, []), items[..k - 1], items[k - 1]);
  }
}

lemma lawSwapKeepsLength_ensures(items: seq<string>, slot: int, pick: int)
  ensures (lawSwapKeepsLength(items, slot, pick) == true)
{
  ShuffleSwapScan(items, slot, pick, |items|);
  assert items[..|items|] == items;
}

lemma ShuffleSwapMultiset(items: seq<string>, slot: int, pick: int)
  ensures multiset(swapItems(items, slot, pick)) == multiset(items)
{
  ShuffleSwapScan(items, slot, pick, |items|);
  assert items[..|items|] == items;
  var swapped := swapItems(items, slot, pick);
  if 0 <= slot < |items| && 0 <= pick < |items| {
    assert swapped == items[slot := items[pick]][pick := items[slot]];
  } else {
    assert swapped == items;
  }
}

lemma ShuffleMultiset(items: seq<string>, swaps: seq<ShuffleSwap>)
  ensures multiset(shuffleItems(items, swaps)) == multiset(items)
  decreases |swaps|
{
  if |swaps| > 0 {
    var prefix := swaps[..|swaps| - 1];
    var last := swaps[|swaps| - 1];
    assert swaps == prefix + [last];
    ShuffleMultiset(items, prefix);
    ProofLib.FoldLeftAppend((arranged: seq<string>, swap: ShuffleSwap) => swapItems(arranged, swap.slot, swap.pick), items, prefix, last);
    ShuffleSwapMultiset(shuffleItems(items, prefix), last.slot, last.pick);
  }
}

lemma ShuffleCountFilter(items: seq<string>, member: string)
  ensures itemCount(items, member) == |ProofLib.Filter((entry: string) => (entry == member), items)|
  ensures |ProofLib.Filter((entry: string) => (entry == member), items)| == multiset(items)[member]
  decreases |items|
{
  if |items| == 0 {
    ProofLib.FilterNil((entry: string) => (entry == member), items);
  } else {
    var prefix := items[..|items| - 1];
    var last := items[|items| - 1];
    assert items == prefix + [last];
    ShuffleCountFilter(prefix, member);
    ProofLib.FilterAppend((entry: string) => (entry == member), prefix, last);
  }
}

lemma lawShuffleKeepsEveryItemCount_ensures(items: seq<string>, swaps: seq<ShuffleSwap>, member: string)
  ensures (lawShuffleKeepsEveryItemCount(items, swaps, member) == true)
{
  ShuffleMultiset(items, swaps);
  ShuffleCountFilter(shuffleItems(items, swaps), member);
  ShuffleCountFilter(items, member);
}

lemma SampleTaken(shuffled: seq<string>, count: int)
  requires count > 0
  ensures |Std.Collections.Seq.FoldLeft((taken: seq<string>, member: string) => (if (|taken| < count) then (taken + [member]) else taken), [], shuffled)| == (if count < |shuffled| then count else |shuffled|)
  ensures forall x :: x in Std.Collections.Seq.FoldLeft((taken: seq<string>, member: string) => (if (|taken| < count) then (taken + [member]) else taken), [], shuffled) ==> x in shuffled
  decreases |shuffled|
{
  if |shuffled| > 0 {
    var prefix := shuffled[..|shuffled| - 1];
    var last := shuffled[|shuffled| - 1];
    assert shuffled == prefix + [last];
    SampleTaken(prefix, count);
    ProofLib.FoldLeftAppend((taken: seq<string>, member: string) => (if (|taken| < count) then (taken + [member]) else taken), [], prefix, last);
  }
}

lemma lawSampleLengthIsBounded_ensures(shuffled: seq<string>, count: int)
  ensures (lawSampleLengthIsBounded(shuffled, count) == true)
{
  if count > 0 {
    SampleTaken(shuffled, count);
  }
}

lemma lawSampledItemsComeFromTheInput_ensures(items: seq<string>, swaps: seq<ShuffleSwap>, count: int, member: string)
  ensures (lawSampledItemsComeFromTheInput(items, swaps, count, member) == true)
{
  var shuffled := shuffleItems(items, swaps);
  if count > 0 {
    SampleTaken(shuffled, count);
  }
  ShuffleMultiset(items, swaps);
  if member in sampleItems(shuffled, count) {
    assert member in shuffled;
    assert member in multiset(shuffled);
    assert member in multiset(items);
  }
}

lemma lawPickedItemComesFromTheInput_ensures(items: seq<string>, swaps: seq<ShuffleSwap>)
  ensures (lawPickedItemComesFromTheInput(items, swaps) == true)
{
  var shuffled := shuffleItems(items, swaps);
  ShuffleMultiset(items, swaps);
  assert |multiset(shuffled)| == |multiset(items)|;
  if |shuffled| > 0 {
    assert shuffled[0] in shuffled;
    assert shuffled[0] in multiset(items);
  }
}

lemma SeedPartsFilter(parts: seq<string>)
  ensures seedParts(parts) == (if |ProofLib.Filter((part: string) => (part != ""), parts)| == 0 then ["default"] else ProofLib.Filter((part: string) => (part != ""), parts))
{
}

lemma lawSeedHasAPart_ensures(parts: seq<string>)
  ensures (lawSeedHasAPart(parts) == true)
{
  SeedPartsFilter(parts);
  ProofLib.FilterMember((part: string) => (part != ""), parts, "");
}

// The artwork hash: every step wraps to a signed 32-bit value.

lemma WrapRemainder(wide: int)
  ensures -4294967296 < remainder_core__protocols(wide, 4294967296) < 4294967296
  ensures wide >= 0 ==> remainder_core__protocols(wide, 4294967296) >= 0
{
  if wide >= 0 {
    assert quotient_core__protocols(wide, 4294967296) == wide / 4294967296;
  } else {
    assert quotient_core__protocols(wide, 4294967296) == -((-wide) / 4294967296);
  }
}

lemma lawWrappedValueIsSigned32Bit_ensures(wide: int)
  ensures (lawWrappedValueIsSigned32Bit(wide) == true)
{
  WrapRemainder(wide);
  WrapRemainder(remainder_core__protocols(wide, 4294967296) + 4294967296);
}

lemma lawArtworkSeedIsNonNegative_ensures(codes: seq<int>)
  ensures (lawArtworkSeedIsNonNegative(codes) == true)
{
  if |codes| > 0 {
    var prefix := codes[..|codes| - 1];
    var last := codes[|codes| - 1];
    assert codes == prefix + [last];
    ProofLib.FoldLeftAppend((running: int, code: int) => wrapInt32(((running * 31) + code)), 0, prefix, last);
    var before := Std.Collections.Seq.FoldLeft((running: int, code: int) => wrapInt32(((running * 31) + code)), 0, prefix);
    lawWrappedValueIsSigned32Bit_ensures(before * 31 + last);
  }
}
