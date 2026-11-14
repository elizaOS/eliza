lemma TimingRegistryFilters(r: Registry)
  ensures alwaysHistogramIdentity(r) == (forall row :: row in r.histograms ==> |ProofLib.Filter((other: SampleRow) => ((other.kind == row.kind) && (other.name == row.name)), r.histograms)| == 1)
{}

lemma BoundedTimingSample(values: seq<int>, sample: int)
  requires |values| <= 256
  ensures |boundedSample(values, sample)| <= 256
{}

lemma AppendMeasurementPreserves(r: Registry, input: MetricInput)
  requires inv(r)
  ensures inv(appendMeasurement(input, r))
  ensures appendMeasurement(input, r).counter == r.counter
  ensures appendMeasurement(input, r).recent == r.recent
{
  var after := appendMeasurement(input, r);
  TimingRegistryFilters(r); TimingRegistryFilters(after);
  match input.measurement {
    case Missing =>
    case Measured(amount) =>
      if exists row :: row in r.histograms && row.kind == input.kind && row.name == input.name {
        assert |after.histograms| == |r.histograms|;
        forall i | 0 <= i < |r.histograms|
          ensures after.histograms[i].kind == r.histograms[i].kind
          ensures after.histograms[i].name == r.histograms[i].name
          ensures |after.histograms[i].values| <= 256
        {
          BoundedTimingSample(r.histograms[i].values, amount);
        }
        forall row | row in after.histograms
          ensures |ProofLib.Filter((other: SampleRow) => ((other.kind == row.kind) && (other.name == row.name)), after.histograms)| == 1
        {
          var i :| 0 <= i < |after.histograms| && after.histograms[i] == row;
          assert r.histograms[i].kind == row.kind && r.histograms[i].name == row.name;
          ProofLib.FilterLengthPointwise((other: SampleRow) => ((other.kind == row.kind) && (other.name == row.name)), (other: SampleRow) => ((other.kind == row.kind) && (other.name == row.name)), r.histograms, after.histograms);
        }
      } else {
        var appended := SampleRow(input.kind, input.name, [amount]);
        assert after.histograms == r.histograms + [appended];
        forall row | row in after.histograms
          ensures |ProofLib.Filter((other: SampleRow) => ((other.kind == row.kind) && (other.name == row.name)), after.histograms)| == 1
        {
          ProofLib.FilterAppend((other: SampleRow) => ((other.kind == row.kind) && (other.name == row.name)), r.histograms, appended);
          if row.kind == input.kind && row.name == input.name {
            ProofLib.FilterNone((other: SampleRow) => ((other.kind == row.kind) && (other.name == row.name)), r.histograms);
          } else { assert row in r.histograms; }
        }
      }
  }
}

lemma TimingMeasurementFold(r: Registry, inputs: seq<MetricInput>)
  requires inv(r)
  ensures inv(Std.Collections.Seq.FoldLeft((previous: Registry, input: MetricInput) => appendMeasurement(input, previous), r, inputs))
  ensures Std.Collections.Seq.FoldLeft((previous: Registry, input: MetricInput) => appendMeasurement(input, previous), r, inputs).counter == r.counter
  ensures Std.Collections.Seq.FoldLeft((previous: Registry, input: MetricInput) => appendMeasurement(input, previous), r, inputs).recent == r.recent
  decreases |inputs|
{
  if |inputs| > 0 {
    AppendMeasurementPreserves(r, inputs[0]);
    TimingMeasurementFold(appendMeasurement(inputs[0], r), inputs[1..]);
  }
}

lemma recordTurn_ensures(r: Registry, summary: TurnSummary)
  ensures (inv(r) ==> alwaysRetentionBounds(recordTurn(r, summary)))
  ensures (inv(r) ==> alwaysHistogramIdentity(recordTurn(r, summary)))
  ensures (inv(r) ==> alwaysCounterNonnegative(recordTurn(r, summary)))
  ensures (inv(r) ==> stepCounterNeverRewinds(r, recordTurn(r, summary)))
{
  if inv(r) { TimingMeasurementFold(r, measurementInputs(summary)); }
}
