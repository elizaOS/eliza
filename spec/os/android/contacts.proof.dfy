lemma lawAnAnswerNamesOnlyTheNumbersAsked_ensures(asked: seq<int>, answer: seq<NamedNumber>)
  ensures (lawAnAnswerNamesOnlyTheNumbersAsked(asked, answer) == true)
{
  if answerMatchesAsk(asked, answer) {
    var mapped := seq(|answer|, i_map requires 0 <= i_map < |answer| => var n := answer[i_map]; n.asked);
    assert mapped == asked;
    forall n | n in answer
      ensures n.asked in asked
    {
      var i :| 0 <= i < |answer| && answer[i] == n;
      assert mapped[i] == n.asked;
      assert asked[i] == n.asked;
    }
  }
}
