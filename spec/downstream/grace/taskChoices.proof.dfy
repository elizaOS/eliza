lemma ChoiceFoldChecksEveryWidget(batch: ChoiceBatch, prior: ChoiceAdmission, widgets: seq<ChoiceEnvelope>)
  ensures Std.Collections.Seq.FoldLeft((prior: ChoiceAdmission, widget: ChoiceEnvelope) => firstAdmission(batch, prior, widget), prior, widgets).ShowChoices? ==>
    prior.ShowChoices? && (forall widget :: widget in widgets ==> widget.widgetValid && choiceMatches(batch, widget))
  decreases |widgets|
{
  if |widgets| > 0 {
    var first := widgets[0];
    var advanced := firstAdmission(batch, prior, first);
    ChoiceFoldChecksEveryWidget(batch, advanced, widgets[1..]);
    assert Std.Collections.Seq.FoldLeft((prior: ChoiceAdmission, widget: ChoiceEnvelope) => firstAdmission(batch, prior, widget), prior, widgets) ==
      Std.Collections.Seq.FoldLeft((prior: ChoiceAdmission, widget: ChoiceEnvelope) => firstAdmission(batch, prior, widget), advanced, widgets[1..]);
    if Std.Collections.Seq.FoldLeft((prior: ChoiceAdmission, widget: ChoiceEnvelope) => firstAdmission(batch, prior, widget), prior, widgets).ShowChoices? {
      assert advanced.ShowChoices?;
      assert prior.ShowChoices? && first.widgetValid && choiceMatches(batch, first);
      forall widget | widget in widgets ensures widget.widgetValid && choiceMatches(batch, widget) {
        if widget != first { assert widget in widgets[1..]; }
      }
    }
  }
}

lemma lawEachShownWidgetMatches_ensures(batch: ChoiceBatch)
  ensures (lawEachShownWidgetMatches(batch) == true)
{
  if batchHeadersValid(batch) {
    ChoiceFoldChecksEveryWidget(batch, showChoicesDecision, batch.widgets);
  }
}
