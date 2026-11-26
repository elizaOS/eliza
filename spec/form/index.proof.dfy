lemma AnswersBridge(s: FormSession)
  ensures alwaysOneAnswerPerField(s) <==> ProofLib.DistinctBy(s.answers, (b: FormAnswer) => b.question)
{
  var xs := s.answers;
  assert alwaysOneAnswerPerField(s) <==> forall a :: a in xs ==> |ProofLib.Filter((b: FormAnswer) => (a.question == b.question), xs)| == 1;
  forall i | 0 <= i < |xs|
    ensures |ProofLib.Filter((b: FormAnswer) => (xs[i].question == b.question), xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != i ==> xs[j].question != xs[i].question
  {
    ProofLib.FilterCountOneIffUnique((b: FormAnswer) => (xs[i].question == b.question), xs, (b: FormAnswer) => b.question, i);
  }
  if ProofLib.DistinctBy(xs, (b: FormAnswer) => b.question) {
    forall a | a in xs ensures |ProofLib.Filter((b: FormAnswer) => (a.question == b.question), xs)| == 1 {
      var i :| 0 <= i < |xs| && xs[i] == a;
    }
  }
}

lemma ConfirmFoldProps(acc: seq<FormAnswer>, xs: seq<FormAnswer>, question: string)
  ensures var res := Std.Collections.Seq.FoldLeft((entries: seq<FormAnswer>, a: FormAnswer) => (entries + [(if (a.question == question) then a.(certainty := AnswerState.ConfirmedAnswer) else a)]), acc, xs);
    |res| == |acc| + |xs|
    && (forall i :: 0 <= i < |acc| ==> res[i] == acc[i])
    && (forall i :: 0 <= i < |xs| ==> res[|acc| + i].question == xs[i].question && res[|acc| + i].answerText == xs[i].answerText)
  decreases |xs|
{
  if |xs| > 0 {
    var next := acc + [(if (xs[0].question == question) then xs[0].(certainty := AnswerState.ConfirmedAnswer) else xs[0])];
    ConfirmFoldProps(next, xs[1..], question);
    var res := Std.Collections.Seq.FoldLeft((entries: seq<FormAnswer>, a: FormAnswer) => (entries + [(if (a.question == question) then a.(certainty := AnswerState.ConfirmedAnswer) else a)]), next, xs[1..]);
    forall i | 0 <= i < |xs|
      ensures res[|acc| + i].question == xs[i].question && res[|acc| + i].answerText == xs[i].answerText
    {
      if i == 0 {
        assert res[|acc|] == next[|acc|];
      } else {
        assert xs[1..][i - 1] == xs[i];
        assert |next| + (i - 1) == |acc| + i;
      }
    }
  }
}

lemma recordAnswer_ensures(s: FormSession, ownerId: string, version: int, at: int, question: string, answerText: string, confirmed: bool, visible: seq<string>, required: seq<string>)
  ensures (inv(s) ==> canRecordAnswer(s, ownerId, version, at, question, answerText, visible, required) ==> alwaysAnswersVisible(recordAnswer(s, ownerId, version, at, question, answerText, confirmed, visible, required)))
  ensures (inv(s) ==> canRecordAnswer(s, ownerId, version, at, question, answerText, visible, required) ==> alwaysOneAnswerPerField(recordAnswer(s, ownerId, version, at, question, answerText, confirmed, visible, required)))
  ensures (inv(s) ==> canRecordAnswer(s, ownerId, version, at, question, answerText, visible, required) ==> alwaysSubmittedFormHasRequiredAnswers(recordAnswer(s, ownerId, version, at, question, answerText, confirmed, visible, required)))
  ensures (inv(s) ==> canRecordAnswer(s, ownerId, version, at, question, answerText, visible, required) ==> stepSubmittedAnswersDoNotChange(s, recordAnswer(s, ownerId, version, at, question, answerText, confirmed, visible, required)))
  ensures (inv(s) ==> canRecordAnswer(s, ownerId, version, at, question, answerText, visible, required) ==> stepStashAndResumeKeepAnswers(s, "recordAnswer", recordAnswer(s, ownerId, version, at, question, answerText, confirmed, visible, required)))
{
  if inv(s) && canRecordAnswer(s, ownerId, version, at, question, answerText, visible, required) {
    var after := recordAnswer(s, ownerId, version, at, question, answerText, confirmed, visible, required);
    var keep := (a: FormAnswer) => ((a.question != question) && (a.question in visible));
    var kept := ProofLib.Filter(keep, s.answers);
    var entry := FormAnswer(question, answerText, (if confirmed then AnswerState.ConfirmedAnswer else AnswerState.SuggestedAnswer));
    assert after.answers == kept + [entry];
    forall a | a in after.answers
      ensures (a.question in after.visibleFields) && (a.answerText != "")
    {
      if a in kept {
        ProofLib.FilterMember(keep, s.answers, a);
      }
    }
    var key := (b: FormAnswer) => b.question;
    AnswersBridge(s);
    AnswersBridge(after);
    ProofLib.FilterKeepsDistinctBy(keep, s.answers, key);
    forall x, y | x in kept && y in [entry]
      ensures key(x) != key(y)
    {
      ProofLib.FilterMember(keep, s.answers, x);
    }
    ProofLib.DistinctByConcat(kept, [entry], key);
  }
}

lemma confirmAnswer_ensures(s: FormSession, ownerId: string, version: int, at: int, question: string)
  ensures (inv(s) ==> canConfirmAnswer(s, ownerId, version, at, question) ==> alwaysAnswersVisible(confirmAnswer(s, ownerId, version, at, question)))
  ensures (inv(s) ==> canConfirmAnswer(s, ownerId, version, at, question) ==> alwaysOneAnswerPerField(confirmAnswer(s, ownerId, version, at, question)))
  ensures (inv(s) ==> canConfirmAnswer(s, ownerId, version, at, question) ==> alwaysSubmittedFormHasRequiredAnswers(confirmAnswer(s, ownerId, version, at, question)))
  ensures (inv(s) ==> canConfirmAnswer(s, ownerId, version, at, question) ==> stepSubmittedAnswersDoNotChange(s, confirmAnswer(s, ownerId, version, at, question)))
  ensures (inv(s) ==> canConfirmAnswer(s, ownerId, version, at, question) ==> stepStashAndResumeKeepAnswers(s, "confirmAnswer", confirmAnswer(s, ownerId, version, at, question)))
{
  if inv(s) && canConfirmAnswer(s, ownerId, version, at, question) {
    var after := confirmAnswer(s, ownerId, version, at, question);
    ConfirmFoldProps([], s.answers, question);
    forall a | a in after.answers
      ensures (a.question in after.visibleFields) && (a.answerText != "")
    {
      var i :| 0 <= i < |after.answers| && after.answers[i] == a;
      assert s.answers[i] in s.answers;
    }
    AnswersBridge(s);
    AnswersBridge(after);
    forall i, j | 0 <= i < |after.answers| && 0 <= j < |after.answers| && i != j
      ensures after.answers[i].question != after.answers[j].question
    {
      assert after.answers[i].question == s.answers[i].question;
      assert after.answers[j].question == s.answers[j].question;
    }
  }
}
