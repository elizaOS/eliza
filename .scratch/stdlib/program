// the_program


module Std.Actions {
  function InputsOf<I, O>(history: seq<(I, O)>): seq<I>
  {
    Seq.Map((e: (I, O)) => e.0, history)
  }

  function OutputsOf<I, O>(history: seq<(I, O)>): seq<O>
  {
    Seq.Map((e: (I, O)) => e.1, history)
  }

  ghost predicate OnlyOutputs<I, O>(i: Action<I, O>, history: seq<(I, O)>, c: O)
  {
    i.ValidHistory(history) <==> forall e | e in history :: e.1 == c
  }

  import opened Wrappers

  import opened Frames

  import opened GenericActions

  import opened Termination

  import opened DynamicArray

  import opened Math

  import Seq = Collections.Seq

  @AssumeCrossModuleTermination trait Action<I, O> extends GenericAction<I, O>, Validatable {
    ghost var history: seq<(I, O)>

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0

    twostate predicate ValidChange()
      reads this, Repr
      ensures ValidChange() ==> old(Valid()) && Valid()
      ensures ValidChange() ==> fresh(Repr - old(Repr))
      ensures ValidChange() ==> old(history) <= history

    ghost predicate ValidHistory(history: seq<(I, O)>)
      decreases Repr

    ghost predicate ValidInput(history: seq<(I, O)>, next: I)
      requires ValidHistory(history)
      decreases Repr

    ghost predicate Requires(i: I)
      reads Reads(i)
    {
      Valid() &&
      ValidInput(history, i)
    }

    ghost function Reads(i: I): set<object>
      reads this
      ensures this in Reads(i)
    {
      {this} + Repr
    }

    ghost function Modifies(i: I): set<object>
      reads Reads(i)
    {
      Repr
    }

    twostate predicate Ensures(i: I, new o: O)
      requires old(Requires(i))
      reads Reads(i)
    {
      ValidChange() &&
      history == old(history) + [(i, o)]
    }

    ghost method UpdateHistory(i: I, o: O)
      reads `history
      modifies `history
      ensures history == old(history) + [(i, o)]
    {
      history := history + [(i, o)];
    }

    ghost function Inputs(): seq<I>
      reads this
    {
      InputsOf(history)
    }

    twostate function NewInputs(): seq<I>
      requires old(history) <= history
      reads this, Repr
    {
      Inputs()[|old(Inputs())|..]
    }

    ghost function Outputs(): seq<O>
      reads this
    {
      OutputsOf(history)
    }

    twostate function NewOutputs(): seq<O>
      requires old(history) <= history
      reads this, Repr
    {
      Outputs()[|old(Outputs())|..]
    }
  }

  @AssumeCrossModuleTermination trait TotalActionProof<I, O> extends Validatable {
    ghost function Action(): Action<I, O>

    lemma AnyInputIsValid(history: seq<(I, O)>, next: I)
      requires Valid()
      requires Action().ValidHistory(history)
      ensures Action().ValidInput(history, next)
  }

  @AssumeCrossModuleTermination class DefaultTotalActionProof<I(!new), O(!new)> extends TotalActionProof<I, O> {
    const action: Action<I, O>

    ghost constructor (action: Action<I, O>)
      requires action.Valid()
      requires forall history: seq<(I, O)>, input: I | action.ValidHistory(history) :: action.ValidInput(history, input)
      ensures this.action == action
      ensures Valid()
      ensures fresh(Repr)
    {
      this.action := action;
      Repr := {this};
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      decreases Repr, 0
    {
      Repr == {this} &&
      forall history: seq<(I, O)>, input: I | action.ValidHistory(history) :: 
        action.ValidInput(history, input)
    }

    twostate predicate ValidChange()
      reads this, Repr
      ensures ValidChange() ==> old(Valid()) && Valid()
      decreases Repr, 0
    {
      old(Valid()) &&
      Valid()
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost function Action(): Action<I, O>
    {
      action
    }

    lemma AnyInputIsValid(history: seq<(I, O)>, next: I)
      requires Valid()
      requires Action().ValidHistory(history)
      ensures Action().ValidInput(history, next)
    {
    }
  }

  class FunctionAction<I, O> extends Action<I, O> {
    const f: I --> O

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> true && ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      ValidHistory(history) &&
      Outputs() == Seq.MapPartialFunction(f, Inputs())
    }

    twostate predicate ValidChange()
      reads this, Repr
      ensures ValidChange() ==> old(Valid()) && Valid()
      ensures ValidChange() ==> fresh(Repr - old(Repr))
      ensures ValidChange() ==> old(history) <= history
    {
      fresh(Repr - old(Repr)) &&
      old(Valid()) &&
      Valid() &&
      old(history) <= history
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    constructor (f: I -> O)
      reads {}
      ensures Valid()
      ensures this.f == f
      ensures fresh(Repr)
      ensures history == []
    {
      this.f := f;
      history := [];
      Repr := {this};
    }

    ghost predicate ValidHistory(history: seq<(I, O)>)
      decreases Repr
    {
      forall e | e in history :: 
        f.requires(e.0) &&
        e.1 == f(e.0)
    }

    ghost predicate ValidInput(history: seq<(I, O)>, next: I)
      requires ValidHistory(history)
      decreases Repr
    {
      f.requires(next)
    }

    ghost function Decreases(i: I): ORDINAL
      reads Reads(i)
    {
      0
    }

    method Invoke(i: I) returns (o: O)
      requires Requires(i)
      reads Reads(i)
      modifies Modifies(i)
      ensures Ensures(i, o)
      decreases Decreases(i), 0
    {
      assert Requires(i);
      assert Valid();
      o := f(i);
      UpdateHistory(i, o);
      calc {
        Outputs();
        old(Outputs()) + [o];
        old(Seq.MapPartialFunction(f, Inputs())) + [f(i)];
        Seq.MapPartialFunction(f, old(Inputs())) + [f(i)];
        Seq.MapPartialFunction(f, old(Inputs())) + Seq.MapPartialFunction(f, [i]);
        {
          Seq.LemmaMapPartialFunctionDistributesOverConcat(f, old(Inputs()), [i]);
        }
        Seq.MapPartialFunction(f, old(Inputs()) + [i]);
        Seq.MapPartialFunction(f, Inputs());
      }
      assert Valid();
    }
  }

  class TotalFunctionActionProof<I, O> extends TotalActionProof<I, O> {
    ghost const action: FunctionAction<I, O>
    ghost const f: I -> O

    ghost constructor (action: FunctionAction<I, O>, f: I -> O)
      requires action.f == f
      reads {}
      ensures Valid()
      ensures fresh(Repr)
      ensures Action() == action
      ensures this.f == f
    {
      this.action := action;
      this.f := f;
      this.Repr := {this};
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      decreases Repr, 0
    {
      this in Repr &&
      action.f == f
    }

    twostate predicate ValidChange()
      reads this, Repr
      ensures ValidChange() ==> old(Valid()) && Valid() && fresh(Repr - old(Repr))
      decreases Repr, 0
    {
      old(Valid()) &&
      Valid() &&
      fresh(Repr - old(Repr))
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost function Action(): Action<I, O>
    {
      action
    }

    lemma AnyInputIsValid(history: seq<(I, O)>, next: I)
      requires Valid()
      requires Action().ValidHistory(history)
      ensures Action().ValidInput(history, next)
    {
    }
  }

  class ComposedAction<I, M, O> extends Action<I, O> {
    const first: Action<I, M>
    const second: Action<M, O>
    ghost const compositionProof: ActionCompositionProof<I, M, O>

    constructor (first: Action<I, M>, second: Action<M, O>, ghost compositionProof: ActionCompositionProof<I, M, O>)
      requires first.Valid()
      requires first.history == []
      requires second.Valid()
      requires second.history == []
      requires first.Repr !! second.Repr
      requires compositionProof.FirstAction() == first
      requires compositionProof.SecondAction() == second
      ensures Valid()
      ensures history == []
      ensures this.compositionProof == compositionProof
    {
      this.first := first;
      this.second := second;
      this.compositionProof := compositionProof;
      history := [];
      Repr := {this} + first.Repr + second.Repr;
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      ValidComponent(first) &&
      ValidComponent(second) &&
      first.Repr !! second.Repr &&
      ValidHistory(history) &&
      InputsOf(history) == InputsOf(first.history) &&
      OutputsOf(first.history) == InputsOf(second.history) &&
      OutputsOf(second.history) == OutputsOf(history) &&
      compositionProof.FirstAction() == first &&
      compositionProof.SecondAction() == second
    }

    twostate predicate ValidChange()
      reads this, Repr
      ensures ValidChange() ==> old(Valid()) && Valid()
      ensures ValidChange() ==> fresh(Repr - old(Repr))
      ensures ValidChange() ==> old(history) <= history
    {
      fresh(Repr - old(Repr)) &&
      old(Valid()) &&
      Valid() &&
      old(history) <= history
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost predicate ValidHistory(history: seq<(I, O)>)
      decreases Repr
    {
      compositionProof.ComposedValidHistory(history)
    }

    ghost predicate ValidInput(history: seq<(I, O)>, next: I)
      decreases Repr
    {
      compositionProof.ComposedValidInput(history, next)
    }

    ghost function Decreases(i: I): ORDINAL
      reads Reads(i)
    {
      ReprTerminationMetric().Ordinal()
    }

    @IsolateAssertions @ResourceLimit("0") method Invoke(i: I) returns (o: O)
      requires Requires(i)
      reads this, Repr
      modifies Modifies(i)
      ensures Ensures(i, o)
      decreases Decreases(i), 0
    {
      assert Requires(i);
      assert first.Valid();
      assert first.ValidHistory(first.history);
      compositionProof.CanInvokeFirst(first.history, history, i);
      var m := first.Invoke(i);
      assert second.Valid();
      compositionProof.CanInvokeSecond(second.history, history, i, m);
      o := second.Invoke(m);
      UpdateHistory(i, o);
      Repr := {this} + first.Repr + second.Repr;
      assert InputsOf(history) == old(InputsOf(first.history)) + [i];
      assert InputsOf(history) == InputsOf(first.history);
      assert OutputsOf(first.history) == old(OutputsOf(first.history)) + [m];
      assert InputsOf(second.history) == old(InputsOf(second.history)) + [m];
      assert OutputsOf(first.history) == InputsOf(second.history);
      assert OutputsOf(history) == old(OutputsOf(second.history)) + [o];
      assert OutputsOf(second.history) == OutputsOf(history);
      compositionProof.CanReturn(first.history, second.history, history);
      assert history == old(history) + [(i, o)];
      assert compositionProof.ComposedValidHistory(history);
      assert ValidHistory(history);
    }
  }

  trait ActionCompositionProof<I, M, O> {
    ghost function FirstAction(): Action<I, M>

    ghost function SecondAction(): Action<M, O>

    ghost predicate ComposedValidInput(composedHistory: seq<(I, O)>, next: I)

    lemma CanInvokeFirst(firstHistory: seq<(I, M)>, composedHistory: seq<(I, O)>, next: I)
      requires FirstAction().ValidHistory(firstHistory)
      requires ComposedValidInput(composedHistory, next)
      requires InputsOf(firstHistory) == InputsOf(composedHistory)
      ensures FirstAction().ValidInput(firstHistory, next)

    lemma CanInvokeSecond(secondHistory: seq<(M, O)>, composedHistory: seq<(I, O)>, nextT: I, nextM: M)
      requires SecondAction().ValidHistory(secondHistory)
      requires OutputsOf(secondHistory) == OutputsOf(composedHistory)
      ensures SecondAction().ValidInput(secondHistory, nextM)

    lemma CanReturn(firstHistory: seq<(I, M)>, secondHistory: seq<(M, O)>, composedHistory: seq<(I, O)>)
      requires FirstAction().ValidHistory(firstHistory)
      requires SecondAction().ValidHistory(secondHistory)
      ensures ComposedValidHistory(composedHistory)

    ghost predicate ComposedValidHistory(composedHistory: seq<(I, O)>): (result: bool)
      ensures composedHistory == [] ==> result
  }
}

module Std.BulkActions {
  function ToBatched<T, E>(t: T): Batched<T, E>
  {
    BatchValue(t)
  }

  method ToBatchedProducer<T, E>(values: seq<T>) returns (result: Producer<Batched<T, E>>)
    reads {}
    ensures result.Valid()
    ensures fresh(result.Repr)
    ensures result.history == []
  {
    var chunkProducer := new SeqReader(values);
    var mapping := new FunctionAction(ToBatched);
    var mappingTotalProof := new TotalFunctionActionProof(mapping, ToBatched);
    result := new MappedProducer(chunkProducer, mapping, mappingTotalProof);
  }

  import opened Actions

  import opened Consumers

  import opened Producers

  import opened Wrappers

  import opened BoundedInts

  import opened Termination

  datatype Batched<T, E> = BatchValue(value: T) | BatchError(error: E) | EndOfInput

  type BatchedByte<E> = Batched<uint8, E>

  @AssumeCrossModuleTermination trait BulkAction<I, O> extends Action<I, O> {
    method Map(input: Producer<I>, output: IConsumer<O>, ghost thisTotalProof: TotalActionProof<I, O>, ghost outputTotalProof: TotalActionProof<O, ()>)
      requires Valid()
      requires input.Valid()
      requires output.Valid()
      requires thisTotalProof.Valid()
      requires thisTotalProof.Action() == this
      requires outputTotalProof.Valid()
      requires outputTotalProof.Action() == output
      requires Repr !! input.Repr !! output.Repr !! thisTotalProof.Repr !! outputTotalProof.Repr
      reads this, Repr, input, input.Repr, output, output.Repr, thisTotalProof, thisTotalProof.Repr, outputTotalProof, outputTotalProof.Repr
      modifies Repr, input.Repr, output.Repr, outputTotalProof.Repr
      ensures ValidChange()
      ensures input.ValidChange()
      ensures output.ValidChange()
      ensures input.Done()
      ensures |input.NewProduced()| == |output.NewInputs()|
      ensures history == old(history) + Seq.Zip(input.NewProduced(), output.NewInputs())
  }

  @AssumeCrossModuleTermination class BatchReader<T, E> extends Producer<Batched<T, E>> {
    const elements: seq<T>
    var index: nat

    constructor (elements: seq<T>)
      reads {}
      ensures Valid()
      ensures history == []
      ensures fresh(Repr)
      ensures this.elements == elements
      ensures index == 0
    {
      this.elements := elements;
      this.index := 0;
      Repr := {this};
      history := [];
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      ValidHistory(history) &&
      (Done() ==>
        index == |elements|) &&
      index <= |elements| &&
      Produced() == Seq.Map(ToBatched, elements[..index]) &&
      |Produced()| == index &&
      (index < |elements| ==>
        Seq.All(Outputs(), IsSome))
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost predicate ValidOutputs(outputs: seq<Option<Batched<T, E>>>)
      requires Seq.Partitioned(outputs, IsSome)
      decreases Repr
    {
      true
    }

    function ProducedCount(): nat
      requires Valid()
      reads this, Repr
      ensures ProducedCount() == |Produced()|
    {
      index
    }

    function Remaining(): Option<nat>
      requires Valid()
      reads this, Repr
    {
      Some(|elements| - index)
    }

    ghost function DecreasesMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      decreases Repr, 3
    {
      TMNat(|elements| - index)
    }

    @IsolateAssertions method Invoke(t: ()) returns (value: Option<Batched<T, E>>)
      requires Requires(t)
      reads Reads(t)
      modifies Modifies(t)
      ensures Ensures(t, value)
      ensures DecreasedBy(value)
      decreases Decreases(t), 0
    {
      assert Requires(t);
      assert Valid();
      reveal TerminationMetric.Ordinal();
      if |elements| == index {
        value := None;
        OutputsPartitionedAfterOutputtingNone();
        ProduceNone();
      } else {
        value := Some(BatchValue(elements[index]));
        OutputsPartitionedAfterOutputtingSome(value.value);
        ProduceSome(value.value);
        index := index + 1;
      }
      assert Valid();
      assert ValidChange();
    }

    @IsolateAssertions method ForEach(consumer: IConsumer<Batched<T, E>>, ghost totalActionProof: TotalActionProof<Batched<T, E>, ()>)
      requires Valid()
      requires consumer.Valid()
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      reads this, Repr, consumer, consumer.Repr, totalActionProof, totalActionProof.Repr
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done()
      ensures NewProduced() == consumer.NewInputs()
    {
      if consumer is BatchSeqWriter<T, E> {
        var writer := consumer as BatchSeqWriter<T, E>;
        var s := Read();
        assert NewProduced() == Seq.Map(ToBatched, s);
        writer.elements := writer.elements + s;
        writer.history := writer.history + Seq.Zip(NewProduced(), Seq.Repeat((), |s|));
        return;
      }
      DefaultForEach(this, consumer, totalActionProof);
    }

    method Fill(consumer: Consumer<Batched<T, E>>, ghost totalActionProof: TotalActionProof<Batched<T, E>, bool>)
      requires Valid()
      requires consumer.Valid()
      requires consumer.Capacity().Some?
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done() || consumer.Capacity() == Some(0)
      ensures NewProduced() == consumer.NewConsumed()
    {
      DefaultFill(this, consumer, totalActionProof);
    }

    @IsolateAssertions method Read() returns (s: seq<T>)
      requires Valid()
      reads this, Repr
      modifies Repr
      ensures ValidAndDisjoint()
      ensures Done()
      ensures ValidChange()
      ensures NewProduced() == Seq.Map(ToBatched, s)
    {
      if index == 0 {
        s := elements;
      } else {
        s := elements[index..];
      }
      index := |elements|;
      var produced := Seq.Map(ToBatched, s);
      var outputs := OutputsForProduced(produced, |s| + 1);
      history := history + Seq.Zip(Seq.Repeat((), |s| + 1), outputs);
      assert Seq.Last(Outputs()) == None;
      assert Outputs() == old(Outputs()) + outputs;
      if |s| == 0 {
        assert Seq.AllNot(outputs, IsSome);
        Seq.PartitionedCompositionRight(old(Outputs()), outputs, IsSome);
      } else {
        assert Seq.All(old(Outputs()), IsSome);
        Seq.PartitionedCompositionLeft(old(Outputs()), outputs, IsSome);
      }
      ProducedComposition(old(Outputs()), outputs);
      assert Valid();
    }
  }

  @AssumeCrossModuleTermination class BatchSeqWriter<T, E> extends IConsumer<Batched<T, E>> {
    var elements: seq<T>
    var state: Result<bool, E>

    constructor ()
      reads {}
      ensures Valid()
      ensures history == []
      ensures fresh(Repr)
      ensures this.elements == []
      ensures state == Success(true)
    {
      this.elements := [];
      this.state := Success(true);
      Repr := {this};
      history := [];
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      ValidHistory(history)
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost predicate ValidHistory(history: seq<(Batched<T, E>, ())>)
      decreases Repr
    {
      true
    }

    ghost predicate ValidInput(history: seq<(Batched<T, E>, ())>, next: Batched<T, E>)
      requires ValidHistory(history)
      decreases Repr
    {
      true
    }

    ghost function Decreases(t: Batched<T, E>): ORDINAL
      reads Reads(t)
    {
      0
    }

    @IsolateAssertions method Invoke(t: Batched<T, E>) returns (r: ())
      requires Requires(t)
      reads Reads(t)
      modifies Modifies(t)
      ensures Ensures(t, r)
      decreases Decreases(t), 0
    {
      assert Requires(t);
      assert Valid();
      reveal TerminationMetric.Ordinal();
      match t {
        case {:split false} BatchValue(t) =>
          elements := elements + [t];
        case {:split false} BatchError(e) =>
          state := Failure(e);
        case {:split false} EndOfInput =>
          state := Success(false);
      }
      r := ();
      UpdateHistory(t, r);
      assert Valid();
    }

    function Values(): seq<T>
      requires Valid()
      reads this, Repr
    {
      elements
    }
  }

  @AssumeCrossModuleTermination class BatchSeqWriterTotalProof<T, E> extends TotalActionProof<Batched<T, E>, ()> {
    ghost const action: BatchSeqWriter<T, E>

    ghost constructor (action: BatchSeqWriter<T, E>)
      reads {}
      ensures Valid()
      ensures fresh(Repr)
      ensures Action() == action
    {
      this.action := action;
      this.Repr := {this};
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      decreases Repr, 0
    {
      true &&
      this in Repr
    }

    twostate predicate ValidChange()
      reads this, Repr
      ensures ValidChange() ==> old(Valid()) && Valid() && fresh(Repr - old(Repr))
      decreases Repr, 0
    {
      old(Valid()) &&
      Valid() &&
      fresh(Repr - old(Repr))
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost function Action(): Action<Batched<T, E>, ()>
    {
      action
    }

    lemma AnyInputIsValid(history: seq<(Batched<T, E>, ())>, next: Batched<T, E>)
      requires Valid()
      requires Action().ValidHistory(history)
      ensures Action().ValidInput(history, next)
    {
    }
  }

  @AssumeCrossModuleTermination class BatchArrayWriter<T, E> extends Consumer<Batched<T, E>> {
    var storage: array<T>
    var size: nat
    var otherInputs: nat
    var state: Result<bool, E>

    constructor (storage: array<T>)
      reads {}
      ensures Valid()
      ensures history == []
      ensures fresh(Repr - {storage})
      ensures this.storage == storage
      ensures state == Success(true)
    {
      this.storage := storage;
      this.size := 0;
      this.otherInputs := 0;
      this.state := Success(true);
      Repr := {this, storage};
      history := [];
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      ValidHistory(history) &&
      storage in Repr &&
      size + otherInputs <= storage.Length &&
      (Done() ==>
        size + otherInputs == storage.Length) &&
      |Consumed()| == size + otherInputs &&
      (size + otherInputs < storage.Length ==>
        Seq.All(history, WasConsumed))
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost predicate ValidInput(history: seq<(Batched<T, E>, bool)>, next: Batched<T, E>)
      requires ValidHistory(history)
      decreases Repr
    {
      true
    }

    ghost function DecreasesMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      decreases Repr, 3
    {
      TMNat(storage.Length - size - otherInputs)
    }

    function Capacity(): Option<nat>
      requires Valid()
      reads this, Repr
    {
      Some(storage.Length - size - otherInputs)
    }

    @IsolateAssertions method Invoke(t: Batched<T, E>) returns (r: bool)
      requires Requires(t)
      reads Reads(t)
      modifies Modifies(t)
      ensures Ensures(t, r)
      ensures DecreasedBy(r)
      decreases Decreases(t), 0
    {
      assert Requires(t);
      assert Valid();
      reveal TerminationMetric.Ordinal();
      if size + otherInputs == storage.Length {
        r := false;
        UpdateHistory(t, r);
        Seq.PartitionedCompositionRight(old(history), [(t, false)], WasConsumed);
        ConsumedComposition(old(history), [(t, r)]);
      } else {
        match t {
          case {:split false} BatchValue(value) =>
            storage[size] := value;
            size := size + 1;
          case {:split false} BatchError(e) =>
            state := Failure(e);
            otherInputs := otherInputs + 1;
          case {:split false} EndOfInput =>
            state := Success(false);
            otherInputs := otherInputs + 1;
        }
        r := true;
        UpdateHistory(t, r);
        Seq.PartitionedCompositionLeft(old(history), [(t, true)], WasConsumed);
        ConsumedComposition(old(history), [(t, r)]);
        calc {
          |Consumed()|;
          old(|Consumed()|) + |ConsumedOf([(t, r)])|;
          old(size + otherInputs) + 1;
          size + otherInputs;
        }
      }
      assert Valid();
      assert ValidChange();
    }

    function Values(): seq<T>
      requires Valid()
      reads this, Repr
    {
      storage[..size]
    }
  }

  @AssumeCrossModuleTermination class BatchArrayWriterTotalProof<T, E> extends TotalActionProof<Batched<T, E>, bool> {
    ghost const action: BatchArrayWriter<T, E>

    ghost constructor (action: BatchArrayWriter<T, E>)
      reads {}
      ensures Valid()
      ensures fresh(Repr)
      ensures Action() == action
    {
      this.action := action;
      this.Repr := {this};
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      decreases Repr, 0
    {
      true &&
      this in Repr
    }

    twostate predicate ValidChange()
      reads this, Repr
      ensures ValidChange() ==> old(Valid()) && Valid() && fresh(Repr - old(Repr))
      decreases Repr, 0
    {
      old(Valid()) &&
      Valid() &&
      fresh(Repr - old(Repr))
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost function Action(): Action<Batched<T, E>, bool>
    {
      action
    }

    lemma AnyInputIsValid(history: seq<(Batched<T, E>, bool)>, next: Batched<T, E>)
      requires Valid()
      requires Action().ValidHistory(history)
      ensures Action().ValidInput(history, next)
    {
    }
  }
}

module Std.Consumers {
  predicate IsTrue(b: bool)
  {
    b == true
  }

  predicate IsFalse(b: bool)
  {
    b == false
  }

  predicate WasConsumed<T>(pair: (T, bool))
  {
    pair.1
  }

  predicate WasNotConsumed<T>(pair: (T, bool))
  {
    !pair.1
  }

  ghost function ConsumedOf<T>(history: seq<(T, bool)>): seq<T>
    requires Seq.Partitioned(history, WasConsumed)
  {
    if history == [] then
      []
    else
      var (input, accepted) := history[0]; if accepted then [input] + ConsumedOf(history[1..]) else ConsumedOf(history[1..])
  }

  lemma ConsumedOfAllNotConsumedEmpty<T>(history: seq<(T, bool)>)
    requires Seq.AllNot(history, WasConsumed)
    ensures ConsumedOf(history) == []
  {
  }

  lemma ConsumedOfMaxCardinality<T>(history: seq<(T, bool)>)
    requires Seq.Partitioned(history, WasConsumed)
    ensures |ConsumedOf(history)| <= |history|
  {
  }

  lemma ConsumedOfAllAccepted<T>(history: seq<(T, bool)>)
    requires Seq.Partitioned(history, WasConsumed)
    requires |ConsumedOf(history)| == |history|
    ensures OutputsOf(history) == Seq.Repeat(true, |history|)
  {
    if history == [] {
    } else {
      var first := history[0];
      var rest := history[1..];
      ConsumedComposition([first], rest);
      Seq.PartitionedDecomposition([first], rest, WasConsumed);
      assert ConsumedOf(history) == ConsumedOf([first]) + ConsumedOf(rest);
      ConsumedOfMaxCardinality(rest);
      reveal Seq.Repeat();
    }
  }

  @IsolateAssertions lemma ConsumedComposition<T>(left: seq<(T, bool)>, right: seq<(T, bool)>)
    requires Seq.Partitioned(left, WasConsumed)
    requires Seq.Partitioned(right, WasConsumed)
    requires Seq.Partitioned(left + right, WasConsumed)
    ensures ConsumedOf(left + right) == ConsumedOf(left) + ConsumedOf(right)
  {
    var combined := left + right;
    if left == [] {
      assert left + right == right;
    } else {
      if !left[0].1 {
        assert !combined[0].1;
        Seq.PartitionedFirstFalseImpliesAllNot(combined, WasConsumed);
        Seq.AllNotDecomposition(left, right, WasConsumed);
        ConsumedOfAllNotConsumedEmpty(left);
        ConsumedOfAllNotConsumedEmpty(right);
        ConsumedOfAllNotConsumedEmpty(left + right);
        assert ConsumedOf(left) == ConsumedOf(right) == [];
        assert ConsumedOf(left + right) == ConsumedOf(left) + ConsumedOf(right);
      } else {
        assert ConsumedOf(left) == [left[0].0] + ConsumedOf(left[1..]);
        assert Seq.Partitioned(left[1..], WasConsumed);
        assert left + right == [left[0]] + (left[1..] + right);
        assert Seq.Partitioned([left[0]] + (left[1..] + right), WasConsumed);
        Seq.PartitionedDecomposition([left[0]], left[1..] + right, WasConsumed);
        assert Seq.Partitioned(left[1..] + right, WasConsumed);
        assert ConsumedOf(left + right) == [left[0].0] + ConsumedOf(left[1..] + right);
        assert Seq.Partitioned(left[1..] + right, WasConsumed);
        ConsumedComposition(left[1..], right);
        assert ConsumedOf(left + right) == ConsumedOf(left) + ConsumedOf(right);
      }
    }
  }

  import opened Actions

  import opened Wrappers

  import opened DynamicArray

  import opened Termination

  import Seq = Collections.Seq

  @AssumeCrossModuleTermination trait IConsumer<T> extends Action<T, ()> {
    twostate predicate ValidChange()
      reads this, Repr
      ensures ValidChange() ==> old(Valid()) && Valid()
      ensures ValidChange() ==> fresh(Repr - old(Repr))
      ensures ValidChange() ==> old(history) <= history
    {
      fresh(Repr - old(Repr)) &&
      old(Valid()) &&
      Valid() &&
      old(history) <= history
    }

    method Accept(t: T)
      requires Requires(t)
      reads Reads(t)
      modifies Modifies(t)
      ensures Ensures(t, ())
      decreases Decreases(t)
    {
      assert Requires(t);
      var r := Invoke(t);
      assert r == ();
    }
  }

  datatype ConsumerState<T> = ConsumerState(consumer: Consumer<T>, capacity: Option<nat>, history: seq<(T, bool)>) {
    ghost predicate Valid()
    {
      Seq.Partitioned(history, WasConsumed) &&
      (!Seq.All(history, WasConsumed) &&
      capacity.Some? ==>
        capacity.value == 0)
    }

    ghost predicate ValidChange(newer: ConsumerState<T>)
    {
      newer.consumer == consumer &&
      Valid() &&
      newer.Valid() &&
      history <= newer.history &&
      var newHistory := newer.history[|history|..]; assert newer.history == history + newHistory; Seq.PartitionedDecomposition(history, newHistory, WasConsumed); ConsumedComposition(history, newHistory); true && var newConsumed := ConsumedOf(newHistory); true && capacity.Some? ==> |newConsumed| <= capacity.value && (!Seq.All(newer.history, WasConsumed) ==> |newConsumed| == capacity.value) && newer.capacity == Some(capacity.value - |newConsumed|)
    }

    @ResourceLimit("0") @IsolateAssertions lemma ValidChangeTransitive(newer: ConsumerState<T>, now: ConsumerState<T>)
      requires ValidChange(newer) && newer.ValidChange(now)
      ensures ValidChange(now)
      ensures NewConsumed(now) == NewConsumed(newer) + newer.NewConsumed(now)
    {
      var newerHistory := newer.history[|history|..];
      var nowHistory := now.history[|newer.history|..];
      var newHistory := now.history[|history|..];
      assert now.history == history + newerHistory + nowHistory;
      assert now.history == history + (newerHistory + nowHistory);
      assert newHistory == newerHistory + nowHistory;
      assert now.history == history + newHistory;
      Seq.PartitionedDecomposition(history, newHistory, WasConsumed);
      assert Seq.Partitioned(history + newerHistory + nowHistory, WasConsumed);
      Seq.PartitionedDecomposition(history + newerHistory, nowHistory, WasConsumed);
      Seq.PartitionedDecomposition(history, newerHistory, WasConsumed);
      Seq.PartitionedDecomposition(history, newerHistory + nowHistory, WasConsumed);
      assert Seq.Partitioned(newHistory, WasConsumed);
      var newerConsumed := ConsumedOf(newerHistory);
      var nowConsumed := ConsumedOf(nowHistory);
      var newConsumed := ConsumedOf(newHistory);
      ConsumedComposition(history, newHistory);
      ConsumedComposition(newerHistory, nowHistory);
      ConsumedComposition(history + newerHistory, nowHistory);
      assert newConsumed == newerConsumed + nowConsumed;
      Seq.PartitionedDecomposition(history, newHistory, WasConsumed);
      ConsumedComposition(history, newHistory);
      if capacity.Some? {
        assert |newConsumed| <= capacity.value;
        assert !Seq.All(history, WasConsumed) ==> |newConsumed| == capacity.value;
        assert now.capacity == Some(capacity.value - |newConsumed|);
      }
    }

    ghost function NewConsumed(newer: ConsumerState<T>): seq<T>
      requires ValidChange(newer)
    {
      var newHistory := newer.history[|history|..];
      assert newer.history == history + newHistory;
      Seq.PartitionedDecomposition(history, newHistory, WasConsumed);
      ConsumedOf(newHistory)
    }
  }

  @AssumeCrossModuleTermination trait Consumer<T> extends Action<T, bool> {
    ghost function State(): ConsumerState<T>
      requires Valid()
      reads this, Repr
    {
      ConsumerState(this, Capacity(), history)
    }

    twostate predicate ValidChange()
      reads this, Repr
      ensures ValidChange() ==> old(Valid()) && Valid()
      ensures ValidChange() ==> fresh(Repr - old(Repr))
      ensures ValidChange() ==> old(history) <= history
    {
      old(Valid()) &&
      Valid() &&
      fresh(Repr - old(Repr)) &&
      old(history) <= history &&
      old(State()).ValidChange(State())
    }

    ghost function DecreasesMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      decreases Repr, 3

    ghost function Decreases(t: T): ORDINAL
      requires Requires(t)
      reads Reads(t)
    {
      Decreasing()
    }

    ghost function Decreasing(): ORDINAL
      requires Valid()
      reads this, Repr
    {
      DecreasesMetric().Ordinal()
    }

    twostate predicate DecreasedBy(new result: bool)
      requires old(Valid())
      requires Valid()
      reads this, Repr
    {
      if result then
        old(DecreasesMetric()).DecreasesTo(DecreasesMetric())
      else
        old(DecreasesMetric()).NonIncreasesTo(DecreasesMetric())
    }

    ghost predicate Done()
      reads this
      decreases Repr, 2
    {
      !Seq.All(Outputs(), IsTrue)
    }

    ghost predicate ValidHistory(history: seq<(T, bool)>)
      decreases Repr
    {
      Seq.Partitioned(history, WasConsumed)
    }

    function Capacity(): Option<nat>
      requires Valid()
      reads this, Repr

    ghost function Consumed(): seq<T>
      requires ValidHistory(history)
      reads this, Repr
    {
      ConsumedOf(history)
    }

    twostate function NewConsumed(): seq<T>
      requires ValidChange()
      reads this, Repr
    {
      old(State()).NewConsumed(State())
    }

    method Invoke(t: T) returns (r: bool)
      requires Requires(t)
      reads Reads(t)
      modifies Modifies(t)
      ensures Ensures(t, r)
      ensures DecreasedBy(r)
      decreases Decreases(t), 0

    method Accept(t: T) returns (o: bool)
      requires Requires(t)
      reads Reads(t)
      modifies Modifies(t)
      ensures Ensures(t, o)
      ensures DecreasedBy(o)
      decreases Decreases(t), 0
    {
      assert Requires(t);
      o := Invoke(t);
    }
  }

  class IgnoreNConsumer<T> extends Consumer<T> {
    const n: nat
    var consumedCount: nat

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> true && ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      ValidHistory(history) &&
      consumedCount <= n &&
      (consumedCount < n ==>
        Seq.All(history, WasConsumed))
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    constructor (n: nat)
      ensures Valid()
      ensures history == []
    {
      history := [];
      Repr := {this};
      this.n := n;
      this.consumedCount := 0;
      new;
      assert ConsumedOf(history) == [];
    }

    ghost predicate ValidInput(history: seq<(T, bool)>, next: T)
      decreases Repr
    {
      true
    }

    ghost function DecreasesMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      decreases Repr, 3
    {
      TMNat(n - consumedCount)
    }

    function Capacity(): Option<nat>
      requires Valid()
      reads this, Repr
    {
      Some(n - consumedCount)
    }

    @IsolateAssertions method Invoke(t: T) returns (r: bool)
      requires Requires(t)
      reads Reads(t)
      modifies Modifies(t)
      ensures Ensures(t, r)
      ensures DecreasedBy(r)
      decreases Decreases(t), 0
    {
      assert Requires(t);
      if consumedCount == n {
        r := false;
        UpdateHistory(t, r);
        Seq.PartitionedCompositionRight(old(history), [(t, false)], WasConsumed);
      } else {
        r := true;
        consumedCount := consumedCount + 1;
        UpdateHistory(t, r);
        Seq.PartitionedCompositionLeft(old(history), [(t, true)], WasConsumed);
      }
      ConsumedComposition(old(history), [(t, r)]);
      reveal TerminationMetric.Ordinal();
    }
  }

  @AssumeCrossModuleTermination class ArrayWriter<T> extends Consumer<T> {
    const storage: array<T>
    var size: nat

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> true && ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      ValidHistory(history) &&
      storage in Repr &&
      size <= storage.Length &&
      (Done() ==>
        size == storage.Length) &&
      Consumed() == storage[..size] &&
      (size < storage.Length ==>
        Seq.All(history, WasConsumed))
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    constructor (storage: array<T>)
      ensures Valid()
      ensures history == []
    {
      history := [];
      Repr := {this} + {storage};
      this.storage := storage;
      this.size := 0;
      new;
      assert ConsumedOf(history) == [];
      assert storage[..size] == [];
    }

    ghost predicate ValidInput(history: seq<(T, bool)>, next: T)
      decreases Repr
    {
      true
    }

    ghost function DecreasesMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      decreases Repr, 3
    {
      TMNat(storage.Length - size)
    }

    function Capacity(): Option<nat>
      requires Valid()
      reads this, Repr
    {
      Some(storage.Length - size)
    }

    @IsolateAssertions method Invoke(t: T) returns (r: bool)
      requires Requires(t)
      reads Reads(t)
      modifies Modifies(t)
      ensures Ensures(t, r)
      ensures DecreasedBy(r)
      decreases Decreases(t), 0
    {
      assert Requires(t);
      if size == storage.Length {
        r := false;
        UpdateHistory(t, r);
        Seq.PartitionedCompositionRight(old(history), [(t, false)], WasConsumed);
      } else {
        storage[size] := t;
        size := size + 1;
        r := true;
        UpdateHistory(t, r);
        Seq.PartitionedCompositionLeft(old(history), [(t, true)], WasConsumed);
      }
      ConsumedComposition(old(history), [(t, r)]);
      reveal TerminationMetric.Ordinal();
    }
  }

  @AssumeCrossModuleTermination class DynamicArrayWriter<T> extends IConsumer<T>, TotalActionProof<T, ()> {
    var storage: DynamicArray<T>

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> true && ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      storage in Repr &&
      this !in storage.Repr &&
      storage.Repr <= Repr &&
      storage.Valid?() &&
      Inputs() == storage.items
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    constructor ()
      ensures Valid()
      ensures fresh(Repr - {this})
      ensures history == []
    {
      var a := new DynamicArray();
      history := [];
      Repr := {this} + {a} + a.Repr;
      this.storage := a;
    }

    ghost predicate ValidHistory(history: seq<(T, ())>)
      decreases Repr
    {
      true
    }

    ghost predicate ValidInput(history: seq<(T, ())>, next: T)
      decreases Repr
    {
      true
    }

    ghost function Decreases(t: T): ORDINAL
      reads Reads(t)
    {
      0
    }

    method Invoke(t: T) returns (r: ())
      requires Requires(t)
      reads Reads(t)
      modifies Modifies(t)
      ensures Ensures(t, r)
      decreases Decreases(t), 0
    {
      assert Requires(t);
      assert Inputs() == storage.items;
      storage.Push(t);
      r := ();
      UpdateHistory(t, r);
      Repr := {this} + {storage} + storage.Repr;
      assert Inputs() == old(Inputs()) + [t];
      assert Valid();
    }

    ghost function Action(): Action<T, ()>
    {
      this
    }

    lemma AnyInputIsValid(history: seq<(T, ())>, next: T)
      requires Action().ValidHistory(history)
      ensures Action().ValidInput(history, next)
    {
    }
  }

  class FoldingConsumer<T, R> extends IConsumer<T> {
    ghost const init: R
    const f: (R, T) -> R
    var value: R

    constructor (init: R, f: (R, T) -> R)
      ensures Valid()
      ensures fresh(Repr)
    {
      this.init := init;
      this.f := f;
      this.value := init;
      this.Repr := {this};
      this.history := [];
      new;
      reveal Seq.FoldLeft();
      assert value == Seq.FoldLeft(f, init, Inputs());
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> true && ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      value == Seq.FoldLeft(f, init, Inputs())
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost predicate ValidHistory(history: seq<(T, ())>)
      decreases Repr
    {
      true
    }

    ghost predicate ValidInput(history: seq<(T, ())>, next: T)
      decreases Repr
    {
      true
    }

    ghost function Decreases(t: T): ORDINAL
      reads Reads(t)
    {
      0
    }

    method Invoke(t: T) returns (r: ())
      requires Requires(t)
      reads Reads(t)
      modifies Modifies(t)
      ensures Ensures(t, r)
      decreases Decreases(t), 0
    {
      assert Requires(t);
      value := f(value, t);
      r := ();
      UpdateHistory(t, ());
      assert old(value) == Seq.FoldLeft(f, init, old(Inputs()));
      assert Inputs() == old(Inputs()) + [t];
      reveal Seq.FoldLeft();
      Seq.LemmaFoldLeftDistributesOverConcat(f, init, old(Inputs()), [t]);
      assert value == Seq.FoldLeft(f, init, Inputs());
      assert Valid();
    }

    ghost function Action(): Action<T, ()>
    {
      this
    }

    lemma AnyInputIsValid(history: seq<(T, ())>, next: T)
      requires Action().ValidHistory(history)
      ensures Action().ValidInput(history, next)
    {
    }
  }

  @AssumeCrossModuleTermination class FoldingConsumerTotalActionProof<I, O> extends TotalActionProof<I, ()> {
    ghost const action: FoldingConsumer<I, O>

    constructor (action: FoldingConsumer<I, O>)
      ensures Valid()
      ensures fresh(Repr)
      ensures Action() == action
    {
      this.action := action;
      this.Repr := {this};
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      decreases Repr, 0
    {
      this in Repr
    }

    twostate predicate ValidChange()
      reads this, Repr
      ensures ValidChange() ==> old(Valid()) && Valid() && fresh(Repr - old(Repr))
      decreases Repr, 0
    {
      old(Valid()) &&
      Valid() &&
      fresh(Repr - old(Repr))
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost function Action(): Action<I, ()>
    {
      action
    }

    lemma AnyInputIsValid(history: seq<(I, ())>, next: I)
      requires Action().ValidHistory(history)
      ensures Action().ValidInput(history, next)
    {
    }
  }

  @AssumeCrossModuleTermination class SeqWriter<T> extends IConsumer<T> {
    var values: seq<T>

    constructor ()
      reads {}
      ensures Valid()
      ensures fresh(Repr)
      ensures history == []
    {
      values := [];
      history := [];
      Repr := {this};
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      values == Inputs()
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost predicate ValidHistory(history: seq<(T, ())>)
      decreases Repr
    {
      true
    }

    ghost predicate ValidInput(history: seq<(T, ())>, next: T)
      requires ValidHistory(history)
      decreases Repr
    {
      true
    }

    ghost function Decreases(t: T): ORDINAL
      reads Reads(t)
    {
      0
    }

    method Invoke(t: T) returns (r: ())
      requires Requires(t)
      reads Repr
      modifies Modifies(t)
      ensures Ensures(t, r)
      decreases Decreases(t), 0
    {
      values := values + [t];
      r := ();
      UpdateHistory(t, r);
      assert Valid();
    }

    ghost method totalActionProof() returns (p: TotalActionProof<T, ()>)
      reads {}
      ensures p.Valid()
      ensures fresh(p.Repr)
      ensures p.Action() == this
    {
      p := new SeqWriterTotalActionProof(this);
    }
  }

  @AssumeCrossModuleTermination class SeqWriterTotalActionProof<T> extends TotalActionProof<T, ()> {
    ghost const action: SeqWriter<T>

    ghost constructor (action: SeqWriter<T>)
      reads {}
      ensures Valid()
      ensures fresh(Repr)
      ensures Action() == action
    {
      this.action := action;
      this.Repr := {this};
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      decreases Repr, 0
    {
      this in Repr
    }

    twostate predicate ValidChange()
      reads this, Repr
      ensures ValidChange() ==> old(Valid()) && Valid() && fresh(Repr - old(Repr))
      decreases Repr, 0
    {
      old(Valid()) &&
      Valid() &&
      fresh(Repr - old(Repr))
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost function Action(): Action<T, ()>
    {
      action
    }

    lemma AnyInputIsValid(history: seq<(T, ())>, next: T)
      requires Action().ValidHistory(history)
      ensures Action().ValidInput(history, next)
    {
    }
  }
}

module Std.GenericActions {

  import opened Termination
  trait GenericAction<I, O> extends object {
    ghost predicate Requires(i: I)
      reads Reads(i)

    ghost function Reads(i: I): set<object>
      reads this
      ensures this in Reads(i)

    ghost function Modifies(i: I): set<object>
      reads Reads(i)

    ghost function Decreases(i: I): ORDINAL
      requires Requires(i)
      reads Reads(i)

    twostate predicate Ensures(i: I, new o: O)
      requires old(Requires(i))
      reads Reads(i)

    method Invoke(i: I) returns (o: O)
      requires Requires(i)
      reads Reads(i)
      modifies Modifies(i)
      ensures Ensures(i, o)
      decreases Decreases(i), 0
  }
}

module Std.Producers {
  @ResourceLimit("1e7") @IsolateAssertions method DefaultForEach<T>(producer: Producer<T>, consumer: IConsumer<T>, ghost totalActionProof: TotalActionProof<T, ()>)
    requires producer.Valid()
    requires consumer.Valid()
    requires producer.Repr !! consumer.Repr !! totalActionProof.Repr
    requires totalActionProof.Valid()
    requires totalActionProof.Action() == consumer
    reads producer, producer.Repr, consumer, consumer.Repr, totalActionProof, totalActionProof.Repr
    modifies producer.Repr, consumer.Repr
    ensures producer.ValidChange()
    ensures consumer.ValidChange()
    ensures producer.Done()
    ensures producer.NewProduced() == consumer.NewInputs()
  {
    producer.ValidImpliesValidChange();
    consumer.ValidImpliesValidChange();
    while true
      invariant fresh(producer.Repr - old(producer.Repr))
      invariant fresh(consumer.Repr - old(consumer.Repr))
      invariant producer.Repr !! consumer.Repr
      invariant totalActionProof.Valid()
      invariant producer.ValidChange()
      invariant consumer.ValidChange()
      invariant producer.NewProduced() == consumer.NewInputs()
      decreases producer.Decreasing()
    {
      label before:
      var t := producer.Next();
      assert Seq.Partitioned(producer.Outputs(), IsSome);
      assert producer.Outputs() == old@before(producer.Outputs()) + [t];
      Seq.PartitionedDecomposition(old@before(producer.Outputs()), [t], IsSome);
      ProducedComposition(old@before(producer.Outputs()), [t]);
      old(producer.State()).ValidChangeTransitive(old@before(producer.State()), producer.State());
      if t == None {
        assert Seq.Last(producer.Outputs()).None?;
        assert producer.Done();
        break;
      }
      totalActionProof.AnyInputIsValid(consumer.history, t.value);
      consumer.Accept(t.value);
      assert Seq.Last(consumer.Inputs()) == t.value;
    }
  }

  @ResourceLimit("1e7") @IsolateAssertions method DefaultFill<T>(producer: Producer<T>, consumer: Consumer<T>, ghost totalActionProof: TotalActionProof<T, bool>)
    requires producer.Valid()
    requires consumer.Valid()
    requires consumer.Capacity().Some?
    requires producer.Repr !! consumer.Repr !! totalActionProof.Repr
    requires totalActionProof.Valid()
    requires totalActionProof.Action() == consumer
    modifies producer.Repr, consumer.Repr
    ensures producer.ValidChange()
    ensures consumer.ValidChange()
    ensures producer.Done() || consumer.Capacity() == Some(0)
    ensures producer.NewProduced() == consumer.NewConsumed()
  {
    producer.ValidImpliesValidChange();
    consumer.ValidImpliesValidChange();
    for c := consumer.Capacity().value downto 0
      invariant fresh(producer.Repr - old(producer.Repr))
      invariant fresh(consumer.Repr - old(consumer.Repr))
      invariant producer.ValidChange()
      invariant consumer.ValidChange()
      invariant producer.Repr !! consumer.Repr
      invariant totalActionProof.Valid()
      invariant old(producer.Produced()) <= producer.Produced()
      invariant old(consumer.Inputs()) <= consumer.Inputs()
      invariant producer.NewProduced() == consumer.NewConsumed()
      invariant c == consumer.Capacity().value
    {
      label before:
      var t := producer.Next();
      assert Seq.Partitioned(producer.Outputs(), IsSome);
      assert producer.Outputs() == old@before(producer.Outputs()) + [t];
      Seq.PartitionedDecomposition(old@before(producer.Outputs()), [t], IsSome);
      ProducedComposition(old@before(producer.Outputs()), [t]);
      old(producer.State()).ValidChangeTransitive(old@before(producer.State()), producer.State());
      assert producer.ValidChange();
      if t == None {
        assert Seq.Last(producer.Outputs()).None?;
        assert producer.Done();
        assert ProducedOf([t]) == [];
        assert producer.Produced() == old@before(producer.Produced());
        assert producer.NewProduced() == consumer.NewConsumed();
        break;
      }
      totalActionProof.AnyInputIsValid(consumer.history, t.value);
      assert 0 < consumer.Capacity().value;
      assert !consumer.Done();
      label beforeAccept:
      var accepted := consumer.Accept(t.value);
      old(consumer.State()).ValidChangeTransitive(old@before(consumer.State()), consumer.State());
      assert |old@beforeAccept(consumer.State()).NewConsumed(consumer.State())| >= 1;
      assert |consumer.NewConsumed@beforeAccept()| >= 1;
      assert consumer.NewConsumed@beforeAccept() == ConsumedOf([(t.value, accepted)]);
      assert ConsumedOf([(t.value, accepted)]) == [t.value];
      ConsumedOfAllAccepted([(t.value, accepted)]);
      assert OutputsOf([(t.value, accepted)]) == [accepted];
      assert OutputsOf([(t.value, accepted)]) == Seq.Repeat(true, 1);
      reveal Seq.Repeat();
      assert [accepted] == [true];
      assert accepted == true;
      assert Seq.Last(consumer.Inputs()) == t.value;
      assert producer.NewProduced() == consumer.NewConsumed();
    }
  }

  predicate IsNone<T>(o: Option<T>)
  {
    o.None?
  }

  predicate IsSome<T>(o: Option<T>)
  {
    o.Some?
  }

  function ProducedOf<T>(outputs: seq<Option<T>>): seq<T>
    requires Seq.Partitioned(outputs, IsSome)
  {
    if |outputs| == 0 || outputs[0].None? then
      []
    else
      [outputs[0].value] + ProducedOf(outputs[1..])
  }

  lemma ProducedOfMapSome<T>(values: seq<T>)
    ensures Seq.Partitioned(Seq.Map(x => Some(x), values), IsSome)
    ensures ProducedOf(Seq.Map(x => Some(x), values)) == values
  {
    reveal Seq.Map();
    var somes := Seq.Map(x => Some(x), values);
    assert Seq.All(somes, IsSome);
    Seq.AllImpliesPartitioned(somes, IsSome);
    var produced := ProducedOf(Seq.Map(x => Some(x), values));
    if values == [] {
    } else {
      assert produced[0] == values[0];
      ProducedOfMapSome(values[1..]);
    }
  }

  ghost function OutputsForProduced<T>(values: seq<T>, n: nat): (result: seq<Option<T>>)
    ensures Seq.Partitioned(result, IsSome)
    ensures ProducedOf(result) <= values
    ensures |values| <= n ==> ProducedOf(result) == values
  {
    var index := Min(|values|, n);
    var produced := values[..index];
    var somes := Seq.Map(x => Some(x), produced);
    Seq.AllImpliesPartitioned(somes, IsSome);
    var nones := Seq.Repeat(None, n - index);
    Seq.AllNotImpliesPartitioned(nones, IsSome);
    Seq.PartitionedCompositionRight(somes, nones, IsSome);
    ProducedOfMapSome(produced);
    assert ProducedOf(somes) == produced;
    assert ProducedOf(nones) == [];
    ProducedComposition(somes, nones);
    somes + nones
  }

  lemma OutputsForProducedNextIsSome<T>(values: seq<T>, n: nat)
    requires n < |values|
    ensures OutputsForProduced(values, n + 1) == OutputsForProduced(values, n) + [Some(values[n])]
  {
  }

  lemma OutputsForProducedNextIsNone<T>(values: seq<T>, n: nat)
    requires |values| <= n
    ensures OutputsForProduced(values, n + 1) == OutputsForProduced(values, n) + [None]
  {
  }

  lemma ProducedOfAllNonesEmpty<T>(outputs: seq<Option<T>>)
    requires Seq.All(outputs, IsNone)
    ensures ProducedOf(outputs) == []
  {
  }

  @IsolateAssertions lemma ProducedComposition<T>(left: seq<Option<T>>, right: seq<Option<T>>)
    requires Seq.Partitioned(left, IsSome)
    requires Seq.Partitioned(right, IsSome)
    requires Seq.Partitioned(left + right, IsSome)
    ensures ProducedOf(left + right) == ProducedOf(left) + ProducedOf(right)
  {
    var combined := left + right;
    if left == [] {
      assert left + right == right;
    } else {
      if left[0].None? {
        assert combined[0].None?;
        Seq.PartitionedFirstFalseImpliesAllNot(combined, IsSome);
        Seq.AllDecomposition(left, right, IsNone);
        assert ProducedOf(left) == ProducedOf(right) == [];
        ProducedOfAllNonesEmpty(left);
        assert ProducedOf(left + right) == ProducedOf(left) + ProducedOf(right);
      } else {
        assert ProducedOf(left) == [left[0].value] + ProducedOf(left[1..]);
        assert Seq.Partitioned(left[1..], IsSome);
        assert left + right == [left[0]] + (left[1..] + right);
        assert Seq.Partitioned([left[0]] + (left[1..] + right), IsSome);
        Seq.PartitionedDecomposition([left[0]], left[1..] + right, IsSome);
        assert Seq.Partitioned(left[1..] + right, IsSome);
        assert ProducedOf(left + right) == [left[0].value] + ProducedOf(left[1..] + right);
        assert Seq.Partitioned(left[1..] + right, IsSome);
        ProducedComposition(left[1..], right);
        assert ProducedOf(left + right) == ProducedOf(left) + ProducedOf(right);
      }
    }
  }

  method CollectToSeq<T>(p: Producer<T>) returns (s: seq<T>)
    requires p.Valid()
    requires p.history == []
    reads p, p.Repr
    modifies p.Repr
    ensures p.Valid()
    ensures p.Done()
    ensures p.Produced() == s
  {
    var seqWriter := new SeqWriter<T>();
    var writerTotalProof := seqWriter.totalActionProof();
    p.ForEach(seqWriter, writerTotalProof);
    return seqWriter.values;
  }

  import opened Actions

  import opened BoundedInts

  import opened Consumers

  import opened Wrappers

  import opened Math

  import opened Frames

  import opened Termination

  import opened Ordinal

  import Seq = Collections.Seq

  @AssumeCrossModuleTermination trait IProducer<T> extends Action<(), T> {
    method Next() returns (r: T)
      requires Requires(())
      reads Reads(())
      modifies Modifies(())
      ensures Ensures((), r)
      decreases Decreases(())
    {
      assert Requires(());
      r := Invoke(());
    }
  }

  trait ProducesSetProof<I> {
    ghost function Action(): Action<(), I>

    ghost function Set(): set<I>

    lemma ProducesSet(history: seq<((), I)>)
      requires Action().ValidHistory(history)
      ensures |history| <= |Set()|
      ensures |history| < |Set()| ==> Action().ValidInput(history, ())
      ensures Seq.HasNoDuplicates(OutputsOf(history))
      ensures Seq.ToSet(OutputsOf(history)) <= Set()
  }

  @AssumeCrossModuleTermination class FunctionalIProducer<S, T> extends IProducer<T>, TotalActionProof<(), T> {
    const stepFn: S -> (S, T)
    var state: S

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr
    }

    twostate predicate ValidChange()
      reads this, Repr
      ensures ValidChange() ==> old(Valid()) && Valid()
      ensures ValidChange() ==> fresh(Repr - old(Repr))
      ensures ValidChange() ==> old(history) <= history
    {
      fresh(Repr - old(Repr)) &&
      old(Valid()) &&
      Valid() &&
      old(history) <= history
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    constructor (state: S, stepFn: S -> (S, T))
      ensures Valid()
    {
      this.state := state;
      this.stepFn := stepFn;
      this.Repr := {this};
      this.history := [];
    }

    ghost function Action(): Action<(), T>
    {
      this
    }

    ghost predicate ValidHistory(history: seq<((), T)>)
      decreases Repr
    {
      true
    }

    ghost predicate ValidInput(history: seq<((), T)>, next: ())
      decreases Repr
    {
      true
    }

    ghost function Decreases(t: ()): ORDINAL
      reads Reads(t)
    {
      0
    }

    method Invoke(i: ()) returns (o: T)
      requires Requires(i)
      reads Repr
      modifies Modifies(i)
      ensures Ensures(i, o)
      decreases Decreases(i), 0
    {
      var (newState, result') := stepFn(state);
      state := newState;
      o := result';
      UpdateHistory(i, o);
    }

    lemma AnyInputIsValid(history: seq<((), T)>, next: ())
      requires Action().ValidHistory(history)
      ensures Action().ValidInput(history, next)
    {
    }
  }

  datatype ProducerState<T> = ProducerState(producer: Producer<T>, remaining: Option<nat>, outputs: seq<Option<T>>) {
    ghost predicate Valid()
    {
      Seq.Partitioned(outputs, IsSome) &&
      (!Seq.All(outputs, IsSome) &&
      remaining.Some? ==>
        remaining.value == 0)
    }

    ghost predicate ValidChange(newer: ProducerState<T>)
    {
      newer.producer == producer &&
      Valid() &&
      newer.Valid() &&
      outputs <= newer.outputs &&
      var newOutputs := newer.outputs[|outputs|..]; assert newer.outputs == outputs + newOutputs; Seq.PartitionedDecomposition(outputs, newOutputs, IsSome); ProducedComposition(outputs, newOutputs); true && var newProduced := ProducedOf(newOutputs); true && remaining.Some? ==> |newProduced| <= remaining.value && (!Seq.All(newer.outputs, IsSome) ==> |newProduced| == remaining.value) && newer.remaining == Some(remaining.value - |newProduced|)
    }

    @ResourceLimit("0") @IsolateAssertions lemma ValidChangeTransitive(newer: ProducerState<T>, now: ProducerState<T>)
      requires ValidChange(newer) && newer.ValidChange(now)
      ensures ValidChange(now)
      ensures NewProduced(now) == NewProduced(newer) + newer.NewProduced(now)
    {
      var newerOutputs := newer.outputs[|outputs|..];
      var nowOutputs := now.outputs[|newer.outputs|..];
      var newOutputs := now.outputs[|outputs|..];
      assert now.outputs == outputs + newerOutputs + nowOutputs;
      assert now.outputs == outputs + (newerOutputs + nowOutputs);
      assert newOutputs == newerOutputs + nowOutputs;
      assert now.outputs == outputs + newOutputs;
      Seq.PartitionedDecomposition(outputs, newOutputs, IsSome);
      assert Seq.Partitioned(outputs + newerOutputs + nowOutputs, IsSome);
      Seq.PartitionedDecomposition(outputs + newerOutputs, nowOutputs, IsSome);
      Seq.PartitionedDecomposition(outputs, newerOutputs, IsSome);
      Seq.PartitionedDecomposition(outputs, newerOutputs + nowOutputs, IsSome);
      assert Seq.Partitioned(newOutputs, IsSome);
      var newerProduced := ProducedOf(newerOutputs);
      var nowProduced := ProducedOf(nowOutputs);
      var newProduced := ProducedOf(newOutputs);
      ProducedComposition(outputs, newOutputs);
      ProducedComposition(newerOutputs, nowOutputs);
      ProducedComposition(outputs + newerOutputs, nowOutputs);
      assert newProduced == newerProduced + nowProduced;
      Seq.PartitionedDecomposition(outputs, newOutputs, IsSome);
      ProducedComposition(outputs, newOutputs);
      if remaining.Some? {
        assert |newProduced| <= remaining.value;
        assert !Seq.All(outputs, IsSome) ==> |newProduced| == remaining.value;
        assert now.remaining == Some(remaining.value - |newProduced|);
      }
    }

    ghost function NewProduced(newer: ProducerState<T>): seq<T>
      requires ValidChange(newer)
    {
      var newOutputs := newer.outputs[|outputs|..];
      assert newer.outputs == outputs + newOutputs;
      Seq.PartitionedDecomposition(outputs, newOutputs, IsSome);
      ProducedOf(newOutputs)
    }
  }

  @AssumeCrossModuleTermination trait Producer<T> extends Action<(), Option<T>>, TotalActionProof<(), Option<T>> {
    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0

    ghost function Action(): Action<(), Option<T>>
    {
      this
    }

    ghost function State(): ProducerState<T>
      requires Valid()
      reads this, Repr
    {
      ProducerState(this, Remaining(), Outputs())
    }

    twostate predicate ValidChange()
      reads this, Repr
      ensures ValidChange() ==> old(Valid()) && Valid()
      ensures ValidChange() ==> fresh(Repr - old(Repr))
      ensures ValidChange() ==> old(history) <= history
    {
      old(Valid()) &&
      Valid() &&
      fresh(Repr - old(Repr)) &&
      old(history) <= history &&
      old(State()).ValidChange(State())
    }

    ghost predicate ValidInput(history: seq<((), Option<T>)>, next: ())
      requires ValidHistory(history)
      decreases Repr
    {
      true
    }

    ghost predicate ValidHistory(history: seq<((), Option<T>)>)
      decreases Repr
    {
      var outputs := OutputsOf(history);
      Seq.Partitioned(outputs, IsSome) &&
      ValidOutputs(outputs)
    }

    ghost function Produced(): seq<T>
      requires ValidHistory(history)
      reads this, Repr
    {
      ProducedOf(OutputsOf(history))
    }

    twostate lemma ProducedPrefix()
      requires old(ValidHistory(history))
      requires ValidHistory(history)
      requires old(history) <= history
      ensures Seq.Partitioned(old(Outputs()), IsSome)
      ensures Seq.Partitioned(Outputs(), IsSome)
      ensures old(Produced()) <= Produced()
    {
      assert Outputs() == old(Outputs()) + NewOutputs();
      Seq.PartitionedDecomposition(old(Outputs()), NewOutputs(), IsSome);
      ProducedComposition(old(Outputs()), NewOutputs());
    }

    twostate function NewProduced(): seq<T>
      requires ValidChange()
      reads this, Repr
    {
      old(State()).NewProduced(State())
    }

    twostate lemma NewProducedAfterInvoke(new r: Option<T>)
      requires ValidChange()
      requires history == old(history) + [((), r)]
      ensures if r.Some? then NewProduced() == [r.value] else NewProduced() == []
    {
      assert Outputs() == old(Outputs()) + NewOutputs();
      Seq.PartitionedDecomposition(old(Outputs()), NewOutputs(), IsSome);
      ProducedComposition(old(Outputs()), NewOutputs());
    }

    twostate lemma ProducedAndNewProduced()
      requires ValidChange()
      ensures Produced() == old(Produced()) + NewProduced()
    {
      assert Outputs() == old(Outputs()) + NewOutputs();
      Seq.PartitionedDecomposition(old(Outputs()), NewOutputs(), IsSome);
      ProducedComposition(old(Outputs()), NewOutputs());
    }

    function ProducedCount(): nat
      requires Valid()
      reads this, Repr
      ensures ProducedCount() == |Produced()|

    twostate function NewProducedCount(): nat
      requires ValidChange()
      reads this, Repr
      ensures NewProducedCount() == |NewProduced()|
    {
      var newOutputs := Outputs()[|old(Outputs())|..];
      assert Outputs() == old(Outputs()) + newOutputs;
      Seq.PartitionedDecomposition(old(Outputs()), newOutputs, IsSome);
      ProducedComposition(old(Outputs()), newOutputs);
      ProducedCount() - old(ProducedCount())
    }

    function Remaining(): Option<nat>
      requires Valid()
      reads this, Repr

    ghost predicate ValidOutputs(outputs: seq<Option<T>>)
      requires Seq.Partitioned(outputs, IsSome)
      decreases Repr

    lemma AnyInputIsValid(history: seq<((), Option<T>)>, next: ())
      requires Action().ValidHistory(history)
      ensures Action().ValidInput(history, next)
    {
    }

    ghost function DecreasesMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      decreases Repr, 3

    ghost function Decreasing(): ORDINAL
      requires Valid()
      reads this, Repr
    {
      DecreasesMetric().Ordinal()
    }

    twostate predicate DecreasedBy(new result: Option<T>)
      requires old(Valid())
      requires Valid()
      reads this, Repr
    {
      if result.Some? then
        old(DecreasesMetric()).DecreasesTo(DecreasesMetric())
      else
        old(DecreasesMetric()).NonIncreasesTo(DecreasesMetric())
    }

    ghost function Decreases(t: ()): ORDINAL
      requires Requires(t)
      reads Reads(t)
    {
      Decreasing()
    }

    method Invoke(i: ()) returns (r: Option<T>)
      requires Requires(i)
      reads Reads(i)
      modifies Modifies(i)
      ensures Ensures(i, r)
      ensures DecreasedBy(r)
      decreases Decreases(i), 0

    method Next() returns (r: Option<T>)
      requires Requires(())
      reads Reads(())
      modifies Modifies(())
      ensures Ensures((), r)
      ensures DecreasedBy(r)
      decreases Decreases(())
    {
      assert Requires(());
      AnyInputIsValid(history, ());
      r := Invoke(());
    }

    method ForEach(consumer: IConsumer<T>, ghost totalActionProof: TotalActionProof<T, ()>)
      requires Valid()
      requires consumer.Valid()
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      reads this, Repr, consumer, consumer.Repr, totalActionProof, totalActionProof.Repr
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done()
      ensures NewProduced() == consumer.NewInputs()

    method Fill(consumer: Consumer<T>, ghost totalActionProof: TotalActionProof<T, bool>)
      requires Valid()
      requires consumer.Valid()
      requires consumer.Capacity().Some?
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done() || consumer.Capacity() == Some(0)
      ensures NewProduced() == consumer.NewConsumed()

    ghost predicate Done()
      reads this
      decreases Repr, 2
    {
      !Seq.All(Outputs(), IsSome)
    }

    lemma OutputsPartitionedAfterOutputtingNone()
      requires ValidHistory(history)
      ensures Seq.Partitioned(OutputsOf(history + [((), None)]), IsSome)
    {
      assert Seq.Partitioned(Outputs(), IsSome);
      assert Seq.AllNot<Option<T>>([None], IsSome);
      Seq.PartitionedCompositionRight(Outputs(), [None], IsSome);
      assert OutputsOf(history + [((), None)]) == Outputs() + [None];
    }

    lemma OutputsPartitionedAfterOutputtingSome(value: T)
      requires ValidHistory(history)
      requires Seq.All<Option<T>>(OutputsOf(history), IsSome)
      ensures Seq.Partitioned(OutputsOf(history + [((), Some(value))]), IsSome)
    {
      assert Seq.Partitioned(Outputs(), IsSome);
      assert Seq.All<Option<T>>([Some(value)], IsSome);
      Seq.PartitionedCompositionLeft(Outputs(), [Some(value)], IsSome);
      assert OutputsOf(history + [((), Some(value))]) == Outputs() + [Some(value)];
    }

    twostate lemma DoneIsOneWay()
      requires old(Valid())
      requires Valid()
      requires old(history) <= history
      ensures !Done() ==> old(!Done())
    {
      if !Done() {
        assert Seq.All(Outputs(), IsSome);
        assert old(Outputs()) <= Outputs();
      }
    }

    twostate lemma OutputtingSomeMeansAllSome(new value: T)
      requires history == old(history) + [((), Some(value))]
      requires ValidHistory(history)
      ensures Seq.All(old(Outputs()), IsSome)
      ensures Seq.All(Outputs(), IsSome)
    {
      var result := Seq.Last(Outputs());
      Seq.PartitionedLastTrueImpliesAll(Outputs(), IsSome);
      assert Seq.All(Outputs(), IsSome);
      assert Outputs() == old(Outputs()) + [Some(value)];
      Seq.AllDecomposition(old(Outputs()), [Some(value)], IsSome);
      assert Seq.All(Outputs(), IsSome) == old(Seq.All(Outputs(), IsSome));
      assert Seq.All(Outputs(), IsSome);
      assert old(Outputs()) <= Outputs();
      assert old(Seq.All(Outputs(), IsSome));
      assert Seq.All(Outputs(), IsSome);
    }

    twostate lemma OutputtingNoneMeansNotAllSome()
      requires history == old(history) + [((), None)]
      requires ValidHistory(history)
      ensures !Seq.All(Outputs(), IsSome)
    {
      assert !IsSome(Seq.Last(Outputs()));
    }

    ghost method ProduceNone()
      requires ValidHistory(history)
      requires ValidHistory(history + [((), None)])
      reads this, Repr
      modifies this`history
      ensures history == old(history) + [((), None)]
      ensures Produced() == old(Produced())
    {
      UpdateHistory((), None);
      Seq.PartitionedCompositionRight(old(Outputs()), [None], IsSome);
      assert Seq.Partitioned(old(Outputs()), IsSome);
      ProducedComposition(old(Outputs()), [None]);
      assert OutputsOf(history) == old(OutputsOf(history)) + [None];
      calc {
        Produced();
        ProducedOf(OutputsOf(history));
        ProducedOf(old(OutputsOf(history)) + [None]);
        ProducedOf(old(OutputsOf(history))) + ProducedOf(OutputsOf([((), None)]));
        old(Produced()) + ProducedOf([None]);
        old(Produced());
      }
    }

    ghost method ProduceSome(value: T)
      requires ValidHistory(history)
      requires ValidHistory(history + [((), Some(value))])
      reads this, Repr
      modifies this`history
      ensures history == old(history) + [((), Some(value))]
      ensures Produced() == old(Produced()) + [value]
      ensures Seq.All(Outputs(), IsSome)
    {
      UpdateHistory((), Some(value));
      assert ValidHistory(old(history));
      assert Seq.Partitioned(old(Outputs()), IsSome);
      Seq.PartitionedLastTrueImpliesAll(Outputs(), IsSome);
      assert Seq.All(Outputs(), IsSome);
      assert Outputs() == old(Outputs()) + [Some(value)];
      Seq.AllDecomposition(old(Outputs()), [Some(value)], IsSome);
      assert Seq.All(old(Outputs()), IsSome);
      Seq.PartitionedCompositionLeft(old(Outputs()), [Some(value)], IsSome);
      assert Seq.Partitioned(old(Outputs()), IsSome);
      ProducedComposition(old(Outputs()), [Some(value)]);
      assert OutputsOf(history) == old(OutputsOf(history)) + [Some(value)];
      calc {
        Produced();
        ProducedOf(OutputsOf(history));
        ProducedOf(old(OutputsOf(history)) + [Some(value)]);
        ProducedOf(old(OutputsOf(history))) + ProducedOf(OutputsOf([((), Some(value))]));
        old(Produced()) + ProducedOf([Some(value)]);
        old(Produced()) + [value];
      }
    }
  }

  class EmptyProducer<T> extends Producer<T> {
    constructor ()
      reads {}
      ensures Valid()
      ensures history == []
      ensures fresh(Repr)
    {
      Repr := {this};
      history := [];
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      ValidHistory(history) &&
      |Produced()| == 0
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost predicate ValidOutputs(outputs: seq<Option<T>>)
      requires Seq.Partitioned(outputs, IsSome)
      decreases Repr
    {
      Seq.All(outputs, IsNone)
    }

    function ProducedCount(): nat
      requires Valid()
      reads this, Repr
      ensures ProducedCount() == |Produced()|
    {
      0
    }

    function Remaining(): Option<nat>
      requires Valid()
      reads this, Repr
    {
      Some(0)
    }

    ghost function DecreasesMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      decreases Repr, 3
    {
      TMNat(0)
    }

    @IsolateAssertions method Invoke(t: ()) returns (value: Option<T>)
      requires Requires(t)
      reads Reads(t)
      modifies Modifies(t)
      ensures Ensures(t, value)
      ensures DecreasedBy(value)
      decreases Decreases(t), 0
    {
      assert Requires(t);
      value := None;
      OutputsPartitionedAfterOutputtingNone();
      ProduceNone();
      assert Valid();
    }

    method ForEach(consumer: IConsumer<T>, ghost totalActionProof: TotalActionProof<T, ()>)
      requires Valid()
      requires consumer.Valid()
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      reads this, Repr, consumer, consumer.Repr, totalActionProof, totalActionProof.Repr
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done()
      ensures NewProduced() == consumer.NewInputs()
    {
      DefaultForEach(this, consumer, totalActionProof);
    }

    method Fill(consumer: Consumer<T>, ghost totalActionProof: TotalActionProof<T, bool>)
      requires Valid()
      requires consumer.Valid()
      requires consumer.Capacity().Some?
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      modifies Repr, consumer.Repr
      ensures Valid()
      ensures consumer.Valid()
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done() || consumer.Capacity() == Some(0)
      ensures NewProduced() == consumer.NewConsumed()
    {
      DefaultFill(this, consumer, totalActionProof);
    }
  }

  class RepeatProducer<T> extends Producer<T> {
    const n: nat
    const t: T
    var producedCount: nat

    constructor (n: nat, t: T)
      reads {}
      ensures Valid()
      ensures history == []
      ensures fresh(Repr)
      ensures this.n == n
      ensures this.t == t
      ensures history == []
    {
      this.n := n;
      this.t := t;
      this.producedCount := 0;
      Repr := {this};
      history := [];
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      ValidHistory(history) &&
      |Produced()| == producedCount &&
      producedCount <= n &&
      (producedCount < n ==>
        Seq.All(Outputs(), IsSome))
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost predicate ValidOutputs(outputs: seq<Option<T>>)
      requires Seq.Partitioned(outputs, IsSome)
      decreases Repr
    {
      true
    }

    function ProducedCount(): nat
      requires Valid()
      reads this, Repr
      ensures ProducedCount() == |Produced()|
    {
      producedCount
    }

    function Remaining(): Option<nat>
      requires Valid()
      reads this, Repr
    {
      Some(n - producedCount)
    }

    ghost function DecreasesMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      decreases Repr, 3
    {
      TMNat(n - producedCount)
    }

    @IsolateAssertions method Invoke(i: ()) returns (value: Option<T>)
      requires Requires(i)
      reads Reads(i)
      modifies Modifies(i)
      ensures Ensures(i, value)
      ensures DecreasedBy(value)
      decreases Decreases(i), 0
    {
      assert Requires(i);
      assert Valid();
      if producedCount == n {
        value := None;
        OutputsPartitionedAfterOutputtingNone();
        ProduceNone();
        old(DecreasesMetric()).NatNonIncreasesToNat(DecreasesMetric());
      } else {
        value := Some(t);
        OutputsPartitionedAfterOutputtingSome(t);
        ProduceSome(value.value);
        producedCount := producedCount + 1;
        old(DecreasesMetric()).NatDecreasesToNat(DecreasesMetric());
      }
      assert Valid();
      assert old(State()).ValidChange(State());
    }

    method ForEach(consumer: IConsumer<T>, ghost totalActionProof: TotalActionProof<T, ()>)
      requires Valid()
      requires consumer.Valid()
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      reads this, Repr, consumer, consumer.Repr, totalActionProof, totalActionProof.Repr
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done()
      ensures NewProduced() == consumer.NewInputs()
    {
      DefaultForEach(this, consumer, totalActionProof);
    }

    method Fill(consumer: Consumer<T>, ghost totalActionProof: TotalActionProof<T, bool>)
      requires Valid()
      requires consumer.Valid()
      requires consumer.Capacity().Some?
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done() || consumer.Capacity() == Some(0)
      ensures NewProduced() == consumer.NewConsumed()
    {
      DefaultFill(this, consumer, totalActionProof);
    }
  }

  class SeqReader<T> extends Producer<T> {
    const elements: seq<T>
    var index: nat

    constructor (elements: seq<T>)
      reads {}
      ensures Valid()
      ensures history == []
      ensures fresh(Repr)
      ensures this.elements == elements
      ensures index == 0
    {
      this.elements := elements;
      this.index := 0;
      Repr := {this};
      history := [];
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      ValidHistory(history) &&
      (Done() ==>
        index == |elements|) &&
      index <= |elements| &&
      Produced() == elements[..index] &&
      (index < |elements| ==>
        Seq.All(Outputs(), IsSome))
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost predicate ValidOutputs(outputs: seq<Option<T>>)
      requires Seq.Partitioned(outputs, IsSome)
      decreases Repr
    {
      true
    }

    function ProducedCount(): nat
      requires Valid()
      reads this, Repr
      ensures ProducedCount() == |Produced()|
    {
      index
    }

    function Remaining(): Option<nat>
      requires Valid()
      reads this, Repr
    {
      Some(|elements| - index)
    }

    ghost function DecreasesMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      decreases Repr, 3
    {
      TMNat(|elements| - index)
    }

    @IsolateAssertions method Invoke(t: ()) returns (value: Option<T>)
      requires Requires(t)
      reads Reads(t)
      modifies Modifies(t)
      ensures Ensures(t, value)
      ensures DecreasedBy(value)
      decreases Decreases(t), 0
    {
      assert Requires(t);
      assert Valid();
      reveal TerminationMetric.Ordinal();
      if |elements| == index {
        value := None;
        OutputsPartitionedAfterOutputtingNone();
        ProduceNone();
      } else {
        value := Some(elements[index]);
        OutputsPartitionedAfterOutputtingSome(elements[index]);
        ProduceSome(value.value);
        index := index + 1;
      }
      assert Valid();
      assert old(State()).ValidChange(State());
    }

    method ForEach(consumer: IConsumer<T>, ghost totalActionProof: TotalActionProof<T, ()>)
      requires Valid()
      requires consumer.Valid()
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      reads this, Repr, consumer, consumer.Repr, totalActionProof, totalActionProof.Repr
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done()
      ensures NewProduced() == consumer.NewInputs()
    {
      DefaultForEach(this, consumer, totalActionProof);
    }

    method Fill(consumer: Consumer<T>, ghost totalActionProof: TotalActionProof<T, bool>)
      requires Valid()
      requires consumer.Valid()
      requires consumer.Capacity().Some?
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done() || consumer.Capacity() == Some(0)
      ensures NewProduced() == consumer.NewConsumed()
    {
      DefaultFill(this, consumer, totalActionProof);
    }
  }

  trait ProducerOfSetProof<T> {
    ghost function Producer(): Producer<T>

    ghost function Set(): set<T>

    lemma ProducesSet(history: seq<((), Option<T>)>)
      requires Producer().ValidHistory(history)
      ensures var produced := ProducedOf(OutputsOf(history)); Seq.HasNoDuplicates(produced) && Seq.ToSet(produced) <= Set() && (!Seq.All(OutputsOf(history), IsSome) ==> Seq.ToSet(produced) == Set())
  }

  class LimitedProducer<T> extends Producer<T> {
    const original: IProducer<T>
    var produced: nat
    const max: nat
    ghost const originalTotalAction: TotalActionProof<(), T>

    constructor (original: IProducer<T>, max: nat, ghost originalTotalAction: TotalActionProof<(), T>)
      requires original.Valid()
      requires originalTotalAction.Valid()
      requires originalTotalAction.Action() == original
      requires original.Repr !! originalTotalAction.Repr
      ensures Valid()
      ensures history == []
      ensures fresh(Repr - original.Repr - originalTotalAction.Repr)
    {
      this.original := original;
      this.max := max;
      this.produced := 0;
      this.originalTotalAction := originalTotalAction;
      Repr := {this} + original.Repr + originalTotalAction.Repr;
      history := [];
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      ValidComponent(original) &&
      ValidComponent(originalTotalAction) &&
      original.Repr !! originalTotalAction.Repr &&
      originalTotalAction.Action() == original &&
      ValidHistory(history) &&
      produced == |Produced()| &&
      produced <= max &&
      (produced < max ==>
        Seq.All(Outputs(), IsSome))
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost predicate ValidOutputs(outputs: seq<Option<T>>)
      requires Seq.Partitioned(outputs, IsSome)
      decreases Repr
    {
      true
    }

    function ProducedCount(): nat
      requires Valid()
      reads this, Repr
      ensures ProducedCount() == |Produced()|
    {
      produced
    }

    function Remaining(): Option<nat>
      requires Valid()
      reads this, Repr
    {
      Some(max - produced)
    }

    ghost function DecreasesMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      decreases Repr, 3
    {
      TMNat(max - produced)
    }

    @ResourceLimit("1e7") method Invoke(t: ()) returns (value: Option<T>)
      requires Requires(t)
      reads this, Repr
      modifies Modifies(t)
      ensures Ensures(t, value)
      ensures DecreasedBy(value)
      decreases Decreases(t), 0
    {
      assert Requires(t);
      assert Valid();
      reveal TerminationMetric.Ordinal();
      if produced == max {
        value := None;
        OutputsPartitionedAfterOutputtingNone();
        ProduceNone();
      } else {
        originalTotalAction.AnyInputIsValid(original.history, ());
        var v := original.Invoke(());
        value := Some(v);
        produced := produced + 1;
        OutputsPartitionedAfterOutputtingSome(v);
        ProduceSome(v);
      }
      Repr := {this} + original.Repr + originalTotalAction.Repr;
      assert Valid();
      assert old(State()).ValidChange(State());
    }

    method ForEach(consumer: IConsumer<T>, ghost totalActionProof: TotalActionProof<T, ()>)
      requires Valid()
      requires consumer.Valid()
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      reads this, Repr, consumer, consumer.Repr, totalActionProof, totalActionProof.Repr
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done()
      ensures NewProduced() == consumer.NewInputs()
    {
      DefaultForEach(this, consumer, totalActionProof);
    }

    method Fill(consumer: Consumer<T>, ghost totalActionProof: TotalActionProof<T, bool>)
      requires Valid()
      requires consumer.Valid()
      requires consumer.Capacity().Some?
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done() || consumer.Capacity() == Some(0)
      ensures NewProduced() == consumer.NewConsumed()
    {
      DefaultFill(this, consumer, totalActionProof);
    }
  }

  class FilteredProducer<T> extends Producer<T> {
    const source: Producer<T>
    const filter: T -> bool
    var producedCount: nat

    constructor (source: Producer<T>, filter: T -> bool)
      requires source.Valid()
      ensures Valid()
      ensures history == []
      ensures fresh(Repr - source.Repr)
    {
      this.source := source;
      this.filter := filter;
      this.producedCount := 0;
      Repr := {this} + source.Repr;
      history := [];
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      ValidComponent(source) &&
      ValidHistory(history) &&
      (!source.Done() ==>
        !Done()) &&
      producedCount == |Produced()|
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost predicate ValidOutputs(outputs: seq<Option<T>>)
      requires Seq.Partitioned(outputs, IsSome)
      decreases Repr
    {
      true
    }

    function ProducedCount(): nat
      requires Valid()
      reads this, Repr
      ensures ProducedCount() == |Produced()|
    {
      producedCount
    }

    function Remaining(): Option<nat>
      requires Valid()
      reads this, Repr
    {
      None
    }

    ghost function DecreasesMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      decreases Repr, 3
    {
      TMSucc(source.DecreasesMetric())
    }

    @ResourceLimit("1e7") method Invoke(t: ()) returns (result: Option<T>)
      requires Requires(t)
      reads Reads(t)
      modifies Modifies(t)
      ensures Ensures(t, result)
      ensures DecreasedBy(result)
      decreases Decreases(t), 0
    {
      assert Requires(t);
      assert Valid();
      result := None;
      var notFirstLoop := false;
      while true
        invariant fresh(Repr - old(Repr))
        invariant Valid()
        invariant history == old(history)
        invariant notFirstLoop ==> 0 < |source.Outputs()| && result == Seq.Last(source.Outputs())
        invariant source.DecreasedBy(result)
        invariant old(source.history) <= source.history
        invariant old(DecreasesMetric()).NonIncreasesTo(DecreasesMetric())
        decreases source.Decreasing()
      {
        notFirstLoop := true;
        old(DecreasesMetric()).SuccDecreasesToOriginal();
        result := source.Next();
        Repr := {this} + source.Repr;
        if result.None? || filter(result.value) {
          break;
        }
        if result.Some? {
          source.DoneIsOneWay();
        }
        old(DecreasesMetric()).SuccDecreasesToSucc(DecreasesMetric());
      }
      if result.Some? {
        assert Seq.Last(source.Outputs()) == result;
        Seq.PartitionedLastTrueImpliesAll(source.Outputs(), IsSome);
        var sourceNewOutputs := source.Outputs()[|old(source.Outputs())|..];
        assert Seq.All(Outputs(), IsSome);
        source.DoneIsOneWay();
        assert old(!source.Done());
        OutputsPartitionedAfterOutputtingSome(result.value);
        ProduceSome(result.value);
        assert Seq.All(source.Outputs(), IsSome) ==> Seq.All(Outputs(), IsSome);
        producedCount := producedCount + 1;
        old(DecreasesMetric()).SuccDecreasesToSucc(DecreasesMetric());
      } else {
        OutputsPartitionedAfterOutputtingNone();
        ProduceNone();
        assert !IsSome(Seq.Last(source.Outputs()));
        assert !Seq.All(source.Outputs(), IsSome);
        assert Seq.All(source.Outputs(), IsSome) ==> Seq.All(Outputs(), IsSome);
        old(DecreasesMetric()).SuccNonIncreasesToSucc(DecreasesMetric());
      }
      assert Valid();
    }

    method ForEach(consumer: IConsumer<T>, ghost totalActionProof: TotalActionProof<T, ()>)
      requires Valid()
      requires consumer.Valid()
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      reads this, Repr, consumer, consumer.Repr, totalActionProof, totalActionProof.Repr
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done()
      ensures NewProduced() == consumer.NewInputs()
    {
      DefaultForEach(this, consumer, totalActionProof);
    }

    method Fill(consumer: Consumer<T>, ghost totalActionProof: TotalActionProof<T, bool>)
      requires Valid()
      requires consumer.Valid()
      requires consumer.Capacity().Some?
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done() || consumer.Capacity() == Some(0)
      ensures NewProduced() == consumer.NewConsumed()
    {
      DefaultFill(this, consumer, totalActionProof);
    }
  }

  class ConcatenatedProducer<T> extends Producer<T> {
    const first: Producer<T>
    const second: Producer<T>
    ghost const base: TerminationMetric

    constructor (first: Producer<T>, second: Producer<T>)
      requires first.Valid()
      requires first.history == []
      requires second.Valid()
      requires second.history == []
      requires first.Repr !! second.Repr
      reads first, first.Repr, second, second.Repr
      ensures Valid()
      ensures history == []
      ensures fresh(Repr - first.Repr - second.Repr)
      ensures this.first == first
      ensures this.second == second
    {
      this.first := first;
      this.second := second;
      this.base := TMSucc(second.DecreasesMetric());
      Repr := {this} + first.Repr + second.Repr;
      history := [];
      new;
      this.base.SuccDecreasesToOriginal();
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      ValidComponent(first) &&
      ValidComponent(second) &&
      first.Repr !! second.Repr &&
      base.DecreasesTo(second.DecreasesMetric()) &&
      ValidHistory(history) &&
      Produced() == first.Produced() + second.Produced() &&
      (!first.Done() ==>
        second.history == []) &&
      (!first.Done() || !second.Done() ==>
        !Done()) &&
      (Done() ==>
        (first.Remaining() == None || first.Remaining() == Some(0)) &&
        (second.Remaining() == None || second.Remaining() == Some(0)))
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost predicate ValidOutputs(outputs: seq<Option<T>>)
      requires Seq.Partitioned(outputs, IsSome)
      decreases Repr
    {
      true
    }

    function ProducedCount(): nat
      requires Valid()
      reads this, Repr
      ensures ProducedCount() == |Produced()|
    {
      first.ProducedCount() + second.ProducedCount()
    }

    function Remaining(): Option<nat>
      requires Valid()
      reads this, Repr
    {
      var left := first.Remaining();
      var right := second.Remaining();
      if left.Some? && right.Some? then
        Some(left.value + right.value)
      else
        None
    }

    ghost function DecreasesMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      decreases Repr, 3
    {
      TMTuple(base, first.DecreasesMetric(), second.DecreasesMetric())
    }

    @ResourceLimit("1e8") @IsolateAssertions method Invoke(t: ()) returns (result: Option<T>)
      requires Requires(t)
      reads Reads(t)
      modifies Modifies(t)
      ensures Ensures(t, result)
      ensures DecreasedBy(result)
      decreases Decreases(t), 0
    {
      assert Requires(t);
      assert Valid();
      DecreasesMetric().TupleDecreasesToFirst();
      assert (Decreases(t), 0 decreases to first.Decreases(t), 0);
      result := first.Next();
      Repr := {this} + first.Repr + second.Repr;
      first.NewProducedAfterInvoke(result);
      first.ProducedAndNewProduced();
      if result.Some? {
        first.OutputtingSomeMeansAllSome(result.value);
        OutputsPartitionedAfterOutputtingSome(result.value);
        ProduceSome(result.value);
        old(DecreasesMetric()).TupleDecreasesToTuple(DecreasesMetric());
      } else {
        first.OutputtingNoneMeansNotAllSome();
        label before:
        old(DecreasesMetric()).TupleDecreasesToSecond();
        result := second.Next();
        Repr := {this} + first.Repr + second.Repr;
        second.NewProducedAfterInvoke@before(result);
        second.ProducedAndNewProduced@before();
        if result.Some? {
          second.OutputtingSomeMeansAllSome(result.value);
          OutputsPartitionedAfterOutputtingSome(result.value);
          ProduceSome(result.value);
          old(DecreasesMetric()).TupleDecreasesToTuple(DecreasesMetric());
        } else {
          second.OutputtingNoneMeansNotAllSome();
          OutputsPartitionedAfterOutputtingNone();
          ProduceNone();
          assert Valid();
          old(DecreasesMetric()).TupleNonIncreasesToTuple(DecreasesMetric());
        }
      }
      assert old(State()).ValidChange(State());
      assert Ensures(t, result);
    }

    method ForEach(consumer: IConsumer<T>, ghost totalActionProof: TotalActionProof<T, ()>)
      requires Valid()
      requires consumer.Valid()
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      reads this, Repr, consumer, consumer.Repr, totalActionProof, totalActionProof.Repr
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done()
      ensures NewProduced() == consumer.NewInputs()
    {
      DefaultForEach(this, consumer, totalActionProof);
    }

    method Fill(consumer: Consumer<T>, ghost totalActionProof: TotalActionProof<T, bool>)
      requires Valid()
      requires consumer.Valid()
      requires consumer.Capacity().Some?
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done() || consumer.Capacity() == Some(0)
      ensures NewProduced() == consumer.NewConsumed()
    {
      DefaultFill(this, consumer, totalActionProof);
    }
  }

  class MappedProducer<I, O> extends Producer<O> {
    const original: Producer<I>
    const mapping: Action<I, O>
    ghost const mappingTotalProof: TotalActionProof<I, O>
    ghost const base: TerminationMetric

    constructor (original: Producer<I>, mapping: Action<I, O>, ghost mappingTotalProof: TotalActionProof<I, O>)
      requires original.Valid()
      requires original.history == []
      requires mapping.Valid()
      requires mapping.history == []
      requires mappingTotalProof.Valid()
      requires mappingTotalProof.Action() == mapping
      requires original.Repr !! mapping.Repr !! mappingTotalProof.Repr
      reads original, original.Repr, mapping, mapping.Repr, mappingTotalProof, mappingTotalProof.Repr
      ensures Valid()
      ensures history == []
      ensures fresh(Repr - original.Repr - mapping.Repr - mappingTotalProof.Repr)
    {
      this.original := original;
      this.mapping := mapping;
      this.mappingTotalProof := mappingTotalProof;
      this.base := TMSucc(original.DecreasesMetric());
      Repr := {this} + original.Repr + mapping.Repr + mappingTotalProof.Repr;
      history := [];
      new;
      this.base.SuccDecreasesToOriginal();
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      ValidComponent(original) &&
      ValidComponent(mapping) &&
      ValidComponent(mappingTotalProof) &&
      mappingTotalProof.Action() == mapping &&
      original.Repr !! mapping.Repr !! mappingTotalProof.Repr &&
      ValidHistory(history) &&
      base.DecreasesTo(original.DecreasesMetric()) &&
      (!original.Done() <==> !Done()) &&
      |Produced()| == |original.Produced()|
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost predicate ValidOutputs(outputs: seq<Option<O>>)
      requires Seq.Partitioned(outputs, IsSome)
      decreases Repr
    {
      true
    }

    function ProducedCount(): nat
      requires Valid()
      reads this, Repr
      ensures ProducedCount() == |Produced()|
    {
      original.ProducedCount()
    }

    function Remaining(): Option<nat>
      requires Valid()
      reads this, Repr
    {
      None
    }

    ghost function DecreasesMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      decreases Repr, 3
    {
      TMTuple(base, TMNat(0), original.DecreasesMetric())
    }

    @ResourceLimit("1e7") method Invoke(t: ()) returns (result: Option<O>)
      requires Requires(t)
      reads Reads(t)
      modifies Modifies(t)
      ensures Ensures(t, result)
      ensures DecreasedBy(result)
      decreases Decreases(t), 0
    {
      assert Requires(t);
      assert Valid();
      DecreasesMetric().TupleDecreasesToSecond();
      assert Decreasing() > original.Decreasing();
      var next := original.Next();
      if next.Some? {
        original.NewProducedAfterInvoke(next);
        assert original.NewProducedCount() == 1;
        mappingTotalProof.AnyInputIsValid(mapping.history, next.value);
        var nextValue := mapping.Invoke(next.value);
        result := Some(nextValue);
        original.OutputtingSomeMeansAllSome(next.value);
        OutputsPartitionedAfterOutputtingSome(result.value);
        ProduceSome(result.value);
      } else {
        result := None;
        original.OutputtingNoneMeansNotAllSome();
        OutputsPartitionedAfterOutputtingNone();
        ProduceNone();
        assert original.NewProducedCount() == 0;
        assert !IsSome(Seq.Last(Outputs()));
      }
      Repr := {this} + original.Repr + mapping.Repr + mappingTotalProof.Repr;
      assert Valid();
      assert original.DecreasedBy(next);
      if next.Some? {
        old(DecreasesMetric()).TupleDecreasesToTuple(DecreasesMetric());
      } else {
        old(DecreasesMetric()).TupleNonIncreasesToTuple(DecreasesMetric());
      }
    }

    method ForEach(consumer: IConsumer<O>, ghost totalActionProof: TotalActionProof<O, ()>)
      requires Valid()
      requires consumer.Valid()
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      reads this, Repr, consumer, consumer.Repr, totalActionProof, totalActionProof.Repr
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done()
      ensures NewProduced() == consumer.NewInputs()
    {
      DefaultForEach(this, consumer, totalActionProof);
    }

    method Fill(consumer: Consumer<O>, ghost totalActionProof: TotalActionProof<O, bool>)
      requires Valid()
      requires consumer.Valid()
      requires consumer.Capacity().Some?
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done() || consumer.Capacity() == Some(0)
      ensures NewProduced() == consumer.NewConsumed()
    {
      DefaultFill(this, consumer, totalActionProof);
    }
  }

  trait ProducerOfNewProducers<T> extends Producer<Producer<T>> {
    ghost function MaxProduced(): TerminationMetric

    method Invoke(i: ()) returns (r: Option<Producer<T>>)
      requires Requires(())
      reads Reads(())
      modifies Modifies(())
      ensures Ensures((), r)
      ensures DecreasedBy(r)
      ensures r.Some? ==> ProducedFresh(r.value)
      decreases Decreases(()), 0

    twostate predicate ProducedFresh(new produced: Producer<T>)
      reads this, produced, produced.Repr
    {
      produced.Valid() &&
      fresh(produced.Repr) &&
      Repr !! produced.Repr &&
      produced.history == [] &&
      MaxProduced().DecreasesTo(produced.DecreasesMetric())
    }
  }

  @AssumeCrossModuleTermination trait OutputterOfNewProducers<I, O> extends Action<I, Producer<O>>, TotalActionProof<I, Producer<O>> {
    ghost function MaxProduced(): TerminationMetric

    ghost function Action(): Action<I, Producer<O>>
    {
      this
    }

    method Invoke(i: I) returns (r: Producer<O>)
      requires Requires(i)
      reads Reads(i)
      modifies Modifies(i)
      ensures Ensures(i, r)
      ensures OutputFresh(r)
      decreases Decreases(i), 0

    twostate predicate OutputFresh(new output: Producer<O>)
      reads this, output, output.Repr
    {
      output.Valid() &&
      fresh(output.Repr) &&
      Repr !! output.Repr &&
      output.history == [] &&
      MaxProduced().DecreasesTo(output.DecreasesMetric())
    }
  }

  class MappedProducerOfNewProducers<I, O> extends ProducerOfNewProducers<O> {
    const original: Producer<I>
    const mapping: OutputterOfNewProducers<I, O>
    ghost const base: TerminationMetric

    constructor (original: Producer<I>, mapping: OutputterOfNewProducers<I, O>)
      requires original.Valid()
      requires original.history == []
      requires mapping.Valid()
      requires mapping.history == []
      requires original.Repr !! mapping.Repr
      reads original, original.Repr, mapping, mapping.Repr
      ensures Valid()
      ensures history == []
      ensures fresh(Repr - original.Repr - mapping.Repr)
    {
      this.original := original;
      this.mapping := mapping;
      this.base := TMSucc(original.DecreasesMetric());
      Repr := {this} + original.Repr + mapping.Repr;
      history := [];
      new;
      this.base.SuccDecreasesToOriginal();
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      ValidComponent(original) &&
      ValidComponent(mapping) &&
      original.Repr !! mapping.Repr &&
      ValidHistory(history) &&
      base.DecreasesTo(original.DecreasesMetric()) &&
      (!original.Done() <==> !Done()) &&
      |Produced()| == |original.Produced()|
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost predicate ValidOutputs(outputs: seq<Option<Producer<O>>>)
      requires Seq.Partitioned(outputs, IsSome<Producer<O>>)
      decreases Repr
    {
      true
    }

    ghost function MaxProduced(): TerminationMetric
    {
      mapping.MaxProduced()
    }

    function ProducedCount(): nat
      requires Valid()
      reads this, Repr
      ensures ProducedCount() == |Produced()|
    {
      original.ProducedCount()
    }

    function Remaining(): Option<nat>
      requires Valid()
      reads this, Repr
    {
      None
    }

    ghost function DecreasesMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      decreases Repr, 3
    {
      TMTuple(base, TMNat(0), original.DecreasesMetric())
    }

    @ResourceLimit("1e7") method Invoke(t: ()) returns (result: Option<Producer<O>>)
      requires Requires(t)
      reads Reads(t)
      modifies Modifies(t)
      ensures Ensures(t, result)
      ensures DecreasedBy(result)
      ensures result.Some? ==> ProducedFresh(result.value)
      decreases Decreases(t), 0
    {
      assert Requires(t);
      assert Valid();
      DecreasesMetric().TupleDecreasesToSecond();
      assert Decreasing() > original.Decreasing();
      var next := original.Next();
      if next.Some? {
        original.NewProducedAfterInvoke(next);
        assert original.NewProducedCount() == 1;
        mapping.AnyInputIsValid(mapping.history, next.value);
        var nextValue := mapping.Invoke(next.value);
        result := Some(nextValue);
        original.OutputtingSomeMeansAllSome(next.value);
        OutputsPartitionedAfterOutputtingSome(result.value);
        ProduceSome(result.value);
      } else {
        result := None;
        original.OutputtingNoneMeansNotAllSome();
        OutputsPartitionedAfterOutputtingNone();
        ProduceNone();
        assert original.NewProducedCount() == 0;
        assert !IsSome(Seq.Last(Outputs()));
      }
      Repr := {this} + original.Repr + mapping.Repr;
      assert Valid();
      assert original.DecreasedBy(next);
      if next.Some? {
        old(DecreasesMetric()).TupleDecreasesToTuple(DecreasesMetric());
      } else {
        old(DecreasesMetric()).TupleNonIncreasesToTuple(DecreasesMetric());
      }
    }

    method ForEach(consumer: IConsumer<Producer<O>>, ghost totalActionProof: TotalActionProof<Producer<O>, ()>)
      requires Valid()
      requires consumer.Valid()
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      reads this, Repr, consumer, consumer.Repr, totalActionProof, totalActionProof.Repr
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done()
      ensures NewProduced() == consumer.NewInputs()
    {
      DefaultForEach(this, consumer, totalActionProof);
    }

    method Fill(consumer: Consumer<Producer<O>>, ghost totalActionProof: TotalActionProof<Producer<O>, bool>)
      requires Valid()
      requires consumer.Valid()
      requires consumer.Capacity().Some?
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done() || consumer.Capacity() == Some(0)
      ensures NewProduced() == consumer.NewConsumed()
    {
      DefaultFill(this, consumer, totalActionProof);
    }
  }

  class FlattenedProducer<T> extends Producer<T> {
    const original: ProducerOfNewProducers<T>
    var currentInner: Option<Producer<T>>
    var producedCount: nat

    constructor (original: ProducerOfNewProducers<T>)
      requires original.Valid()
      ensures Valid()
      ensures fresh(Repr - original.Repr)
      ensures history == []
    {
      this.original := original;
      this.currentInner := None;
      this.producedCount := 0;
      this.history := [];
      this.Repr := {this} + original.Repr;
    }

    ghost function BaseMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      decreases Repr, 1
    {
      TMSucc(original.MaxProduced())
    }

    ghost function InnerDecreasesMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      ensures BaseMetric().DecreasesTo(InnerDecreasesMetric())
      decreases Repr, 2
    {
      reveal TerminationMetric.Ordinal();
      if currentInner.Some? then
        var result := TMSucc(currentInner.value.DecreasesMetric());
        BaseMetric().SuccDecreasesToSucc(result);
        result
      else
        TMNat(0)
    }

    twostate lemma InnerDecreasesMetricNonIncreases()
      requires old(Valid())
      requires old(currentInner.Some?)
      requires Valid()
      requires currentInner.Some?
      requires old(currentInner.value) == currentInner.value
      requires old(currentInner.value.DecreasesMetric()).NonIncreasesTo(currentInner.value.DecreasesMetric())
      ensures old(InnerDecreasesMetric()).NonIncreasesTo(InnerDecreasesMetric())
    {
      old(InnerDecreasesMetric()).SuccNonIncreasesToSucc(InnerDecreasesMetric());
    }

    twostate lemma InnerDecreasesMetricDecreases()
      requires old(Valid())
      requires old(currentInner.Some?)
      requires Valid()
      requires currentInner.Some?
      requires old(currentInner.value) == currentInner.value
      requires old(currentInner.value.DecreasesMetric()).DecreasesTo(currentInner.value.DecreasesMetric())
      ensures old(InnerDecreasesMetric()).DecreasesTo(InnerDecreasesMetric())
    {
      old(InnerDecreasesMetric()).SuccDecreasesToSucc(InnerDecreasesMetric());
    }

    twostate lemma InnerDecreasesMetricDecreases2()
      requires old(Valid())
      requires old(currentInner.Some?)
      requires Valid()
      requires currentInner.None?
      ensures old(InnerDecreasesMetric()).DecreasesTo(InnerDecreasesMetric())
    {
      reveal TerminationMetric.Ordinal();
    }

    ghost function DecreasesMetric(): TerminationMetric
      requires Valid()
      reads this, Repr
      decreases Repr, 3
    {
      TMTuple(BaseMetric(), original.DecreasesMetric(), InnerDecreasesMetric())
    }

    twostate lemma DecreasesMetricDoesntReadHistory()
      requires old(Valid())
      requires Valid()
      requires old(BaseMetric()) == BaseMetric()
      requires old(original.DecreasesMetric()) == original.DecreasesMetric()
      requires old(InnerDecreasesMetric()) == InnerDecreasesMetric()
      ensures old(DecreasesMetric()) == DecreasesMetric()
    {
    }

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      ensures Valid() ==> ValidHistory(history)
      decreases Repr, 0
    {
      this in Repr &&
      ValidComponent(original) &&
      (currentInner.Some? ==>
        ValidComponent(currentInner.value)) &&
      original.Repr !! (if currentInner.Some? then currentInner.value.Repr else {}) &&
      ValidHistory(history) &&
      (currentInner.Some? ==>
        0 < |original.Outputs()| &&
        currentInner == Seq.Last(original.Outputs()) &&
        original.MaxProduced().DecreasesTo(currentInner.value.DecreasesMetric())) &&
      (!original.Done() &&
      currentInner.Some? &&
      !currentInner.value.Done() ==>
        !Done()) &&
      (Done() ==>
        original.Done() &&
        currentInner.None?) &&
      producedCount == |Produced()|
    }

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()
    {
    }

    ghost predicate ValidOutputs(outputs: seq<Option<T>>)
      requires Seq.Partitioned(outputs, IsSome)
      decreases Repr
    {
      true
    }

    function ProducedCount(): nat
      requires Valid()
      reads this, Repr
      ensures ProducedCount() == |Produced()|
    {
      producedCount
    }

    function Remaining(): Option<nat>
      requires Valid()
      reads this, Repr
    {
      None
    }

    @ResourceLimit("1e8") method Invoke(t: ()) returns (result: Option<T>)
      requires Requires(t)
      reads this, Repr
      modifies Modifies(t)
      ensures Ensures(t, result)
      ensures DecreasedBy(result)
      decreases Decreases(t), 0
    {
      assert Valid();
      result := None;
      while result.None?
        invariant fresh(Repr - old(Repr))
        invariant Valid()
        invariant history == old(history)
        invariant fresh(original.Repr - old(original.Repr))
        invariant currentInner.Some? ==> fresh(currentInner.value.Repr - old(Repr))
        invariant result.Some? ==> !original.Done() && currentInner.Some? && !currentInner.value.Done()
        invariant old(original.history) <= original.history
        invariant old(Done()) == Done()
        invariant DecreasedBy(result)
        decreases original.Decreasing(), currentInner.Some?, if currentInner.Some? then currentInner.value.Decreasing() else 0
      {
        if currentInner.None? {
          label beforeOriginalNext:
          ghost var historyBefore := original.history;
          old(DecreasesMetric()).TupleDecreasesToFirst();
          currentInner := original.Invoke(());
          assert fresh(original.Repr - old@beforeOriginalNext(Repr));
          if currentInner.Some? {
            Repr := {this} + original.Repr + currentInner.value.Repr;
            assert ValidComponent(currentInner.value);
            assert old@beforeOriginalNext(original.Valid());
            assert currentInner.value.history == [];
            assert currentInner == Seq.Last(original.Outputs());
            Seq.PartitionedLastTrueImpliesAll(original.Outputs(), IsSome<Producer<T>>);
            assert !original.Done() && currentInner.Some? && !currentInner.value.Done();
            original.DoneIsOneWay();
            old(DecreasesMetric()).TupleDecreasesToTuple(DecreasesMetric());
            assert old(Decreasing()) >= Decreasing();
          } else {
            Repr := {this} + original.Repr;
            assert currentInner == Seq.Last(original.Outputs());
            assert original.Done() && currentInner.None?;
            old@beforeOriginalNext(DecreasesMetric()).TupleNonIncreasesToTuple(DecreasesMetric()) by {
              assert old@beforeOriginalNext(InnerDecreasesMetric()) == InnerDecreasesMetric();
            }
            break;
          }
        } else {
          label beforeCurrentInnerNext:
          DecreasesMetric().TupleDecreasesToSecond();
          assert DecreasesMetric().second == TMSucc(currentInner.value.DecreasesMetric());
          DecreasesMetric().second.SuccDecreasesToOriginal();
          result := currentInner.value.Next();
          this.Repr := {this} + original.Repr + currentInner.value.Repr;
          assert old@beforeCurrentInnerNext(currentInner.value.DecreasesMetric()).NonIncreasesTo(currentInner.value.DecreasesMetric());
          InnerDecreasesMetricNonIncreases@beforeCurrentInnerNext();
          old@beforeCurrentInnerNext(DecreasesMetric()).TupleNonIncreasesToTuple(DecreasesMetric());
          label afterCurrentInnerNext:
          if result.None? {
            var oldCurrentInner := currentInner;
            currentInner := None;
            InnerDecreasesMetricDecreases2@afterCurrentInnerNext();
            old@afterCurrentInnerNext(DecreasesMetric()).TupleDecreasesToTuple(DecreasesMetric());
            assert old(Decreasing()) >= Decreasing();
          } else {
            assert currentInner == Seq.Last(original.Outputs());
            assert original.ValidHistory(original.history);
            assert Seq.Partitioned(original.Outputs(), IsSome<Producer<T>>);
            Seq.PartitionedLastTrueImpliesAll(original.Outputs(), IsSome<Producer<T>>);
            assert result == Seq.Last(currentInner.value.Outputs());
            Seq.PartitionedLastTrueImpliesAll(currentInner.value.Outputs(), IsSome<T>);
            assert !original.Done() && currentInner.Some? && !currentInner.value.Done();
            original.DoneIsOneWay();
            assert !old(original.Done());
            currentInner.value.DoneIsOneWay@beforeCurrentInnerNext();
            InnerDecreasesMetricDecreases@beforeCurrentInnerNext();
            old@beforeCurrentInnerNext(DecreasesMetric()).TupleDecreasesToTuple(DecreasesMetric());
            assert old(Decreasing()) > Decreasing();
          }
        }
      }
      label beforeUpdatingHistory:
      if result.Some? {
        OutputsPartitionedAfterOutputtingSome(result.value);
        ProduceSome(result.value);
        producedCount := producedCount + 1;
        DecreasesMetricDoesntReadHistory@beforeUpdatingHistory();
      } else {
        OutputsPartitionedAfterOutputtingNone();
        ProduceNone();
        DecreasesMetricDoesntReadHistory@beforeUpdatingHistory();
      }
      assert Valid();
    }

    method ForEach(consumer: IConsumer<T>, ghost totalActionProof: TotalActionProof<T, ()>)
      requires Valid()
      requires consumer.Valid()
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      reads this, Repr, consumer, consumer.Repr, totalActionProof, totalActionProof.Repr
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done()
      ensures NewProduced() == consumer.NewInputs()
    {
      DefaultForEach(this, consumer, totalActionProof);
    }

    method Fill(consumer: Consumer<T>, ghost totalActionProof: TotalActionProof<T, bool>)
      requires Valid()
      requires consumer.Valid()
      requires consumer.Capacity().Some?
      requires Repr !! consumer.Repr !! totalActionProof.Repr
      requires totalActionProof.Valid()
      requires totalActionProof.Action() == consumer
      modifies Repr, consumer.Repr
      ensures ValidChange()
      ensures consumer.ValidChange()
      ensures Done() || consumer.Capacity() == Some(0)
      ensures NewProduced() == consumer.NewConsumed()
    {
      DefaultFill(this, consumer, totalActionProof);
    }
  }
}

@DisableNonlinearArithmetic
module Std.Arithmetic.DivMod {
  lemma LemmaDivIsDivRecursive(x: int, d: int)
    requires 0 < d
    ensures DivRecursive(x, d) == x / d
  {
    LemmaDivInductionAuto(d, x, u => DivRecursive(u, d) == u / d);
  }

  lemma LemmaDivIsDivRecursiveAuto()
    ensures forall x: int, d: int {:trigger x / d} :: d > 0 ==> DivRecursive(x, d) == x / d
  {
    forall x: int, d: int | d > 0
      ensures DivRecursive(x, d) == x / d
    {
      LemmaDivIsDivRecursive(x, d);
    }
  }

  lemma LemmaDivBySelf(d: int)
    requires d != 0
    ensures d / d == 1
  {
    DivINL.LemmaDivBySelf(d);
  }

  lemma LemmaDivOf0(d: int)
    requires d != 0
    ensures 0 / d == 0
  {
    DivINL.LemmaDivOf0(d);
  }

  lemma LemmaDivBasics(x: int)
    ensures x != 0 ==> 0 / x == 0
    ensures x / 1 == x
    ensures x != 0 ==> x / x == 1
  {
    if x != 0 {
      LemmaDivBySelf(x);
      LemmaDivOf0(x);
    }
  }

  lemma LemmaDivBasicsAuto()
    ensures forall x {:trigger 0 / x} :: x != 0 ==> 0 / x == 0
    ensures forall x {:trigger x / 1} :: x / 1 == x
    ensures forall x, y {:trigger x / y} :: x >= 0 && y > 0 ==> x / y >= 0
    ensures forall x, y {:trigger x / y} :: x >= 0 && y > 0 ==> x / y <= x
  {
    forall x: int | true
      ensures x != 0 ==> 0 / x == 0
      ensures x / 1 == x
    {
      LemmaDivBasics(x);
    }
    forall x: int, y: int | x >= 0 && y > 0
      ensures 0 <= x / y <= x
    {
      LemmaDivPosIsPos(x, y);
      LemmaDivIsOrderedByDenominator(x, 1, y);
    }
  }

  lemma LemmaSmallDivConverseAuto()
    ensures forall x, d {:trigger x / d} :: 0 <= x && 0 < d && x / d == 0 ==> x < d
  {
    forall x, d | 0 <= x && 0 < d && x / d == 0
      ensures x < d
    {
      LemmaDivInductionAuto(d, x, u => 0 <= u && 0 < d && u / d == 0 ==> u < d);
    }
  }

  lemma LemmaDivNonZero(x: int, d: int)
    requires x >= d > 0
    ensures x / d > 0
  {
    LemmaDivPosIsPosAuto();
    if x / d == 0 {
      LemmaSmallDivConverseAuto();
    }
  }

  lemma LemmaDivNonZeroAuto()
    ensures forall x, d {:trigger x / d} | x >= d > 0 :: x / d > 0
  {
    forall x, d | x >= d > 0 {
      LemmaDivNonZero(x, d);
    }
  }

  lemma LemmaDivIsOrderedByDenominator(x: int, y: int, z: int)
    requires 0 <= x
    requires 1 <= y <= z
    ensures x / y >= x / z
    decreases x
  {
    LemmaDivIsDivRecursiveAuto();
    assert forall u: int, d: int {:trigger u / d} {:trigger DivRecursive(u, d)} :: d > 0 ==> DivRecursive(u, d) == u / d;
    if x < z {
      LemmaDivIsOrdered(0, x, y);
    } else {
      LemmaDivIsOrdered(x - z, x - y, y);
      LemmaDivIsOrderedByDenominator(x - z, y, z);
    }
  }

  lemma LemmaDivIsOrderedByDenominatorAuto()
    ensures forall x: int, y: int, z: int {:trigger x / y, x / z} :: 0 <= x && 1 <= y <= z ==> x / y >= x / z
  {
    forall x: int, y: int, z: int | 0 <= x && 1 <= y <= z
      ensures x / y >= x / z
    {
      LemmaDivIsOrderedByDenominator(x, y, z);
    }
  }

  lemma LemmaDivIsStrictlyOrderedByDenominator(x: int, d: int)
    requires 0 < x
    requires 1 < d
    ensures x / d < x
    decreases x
  {
    LemmaDivInductionAuto(d, x, u => 0 < u ==> u / d < u);
  }

  lemma LemmaDivIsStrictlyOrderedByDenominatorAuto()
    ensures forall x: int, d: int {:trigger x / d} :: 0 < x && 1 < d ==> x / d < x
  {
    forall x: int, d: int | 0 < x && 1 < d
      ensures x / d < x
    {
      LemmaDivIsStrictlyOrderedByDenominator(x, d);
    }
  }

  lemma LemmaDividingSums(a: int, b: int, d: int, R: int)
    requires 0 < d
    requires R == a % d + b % d - (a + b) % d
    ensures d * ((a + b) / d) - R == d * (a / d) + d * (b / d)
  {
    calc ==> {
      a % d + b % d == R + (a + b) % d;
      a + b - (a + b) % d - R == a - a % d + b - b % d;
      {
        LemmaFundamentalDivMod(a + b, d);
        LemmaFundamentalDivMod(a, d);
        LemmaFundamentalDivMod(b, d);
      }
      d * ((a + b) / d) - R == d * (a / d) + d * (b / d);
    }
  }

  lemma LemmaDividingSumsAuto()
    ensures forall a: int, b: int, d: int, R: int {:trigger d * ((a + b) / d) - R, d * (a / d) + d * (b / d)} :: 0 < d && R == a % d + b % d - (a + b) % d ==> d * ((a + b) / d) - R == d * (a / d) + d * (b / d)
  {
    forall a: int, b: int, d: int, R: int {:trigger d * ((a + b) / d) - R, d * (a / d) + d * (b / d)} | 0 < d && R == a % d + b % d - (a + b) % d
      ensures d * ((a + b) / d) - R == d * (a / d) + d * (b / d)
    {
      LemmaDividingSums(a, b, d, R);
    }
  }

  lemma LemmaDivPosIsPos(x: int, d: int)
    requires 0 <= x
    requires 0 < d
    ensures 0 <= x / d
  {
    LemmaDivInductionAuto(d, x, u => 0 <= u ==> u / d >= 0);
  }

  lemma LemmaDivPosIsPosAuto()
    ensures forall x: int, d: int {:trigger x / d} :: 0 <= x && 0 < d ==> 0 <= x / d
  {
    forall x: int, d: int | 0 <= x && 0 < d
      ensures 0 <= x / d
    {
      LemmaDivPosIsPos(x, d);
    }
  }

  lemma LemmaDivPlusOne(x: int, d: int)
    requires 0 < d
    ensures 1 + x / d == (d + x) / d
  {
    LemmaDivAuto(d);
  }

  lemma LemmaDivPlusOneAuto()
    ensures forall x: int, d: int {:trigger 1 + x / d, (d + x) / d} :: 0 < d ==> 1 + x / d == (d + x) / d
  {
    forall x: int, d: int | 0 < d
      ensures 1 + x / d == (d + x) / d
    {
      LemmaDivPlusOne(x, d);
    }
  }

  lemma LemmaDivMinusOne(x: int, d: int)
    requires 0 < d
    ensures -1 + x / d == (-d + x) / d
  {
    LemmaDivAuto(d);
  }

  lemma LemmaDivMinusOneAuto()
    ensures forall x: int, d: int {:trigger -1 + x / d, (-d + x) / d} :: 0 < d ==> -1 + x / d == (-d + x) / d
  {
    forall x: int, d: int | 0 < d
      ensures -1 + x / d == (-d + x) / d
    {
      LemmaDivMinusOne(x, d);
    }
  }

  lemma LemmaBasicDiv(d: int)
    requires 0 < d
    ensures forall x {:trigger x / d} :: 0 <= x < d ==> x / d == 0
  {
    LemmaDivAuto(d);
  }

  lemma LemmaBasicDivAuto()
    ensures forall x: int, d: int {:trigger x / d} :: 0 <= x < d ==> x / d == 0
  {
    forall x: int, d: int | 0 <= x < d
      ensures x / d == 0
    {
      LemmaBasicDiv(d);
    }
  }

  lemma LemmaDivIsOrdered(x: int, y: int, z: int)
    requires x <= y
    requires 0 < z
    ensures x / z <= y / z
  {
    LemmaDivInductionAuto(z, x - y, xy => xy <= 0 ==> (xy + y) / z <= y / z);
  }

  lemma LemmaDivIsOrderedAuto()
    ensures forall x: int, y: int, z: int {:trigger x / z, y / z} :: x <= y && 0 < z ==> x / z <= y / z
  {
    forall x: int, y: int, z: int | x <= y && 0 < z
      ensures x / z <= y / z
    {
      LemmaDivIsOrdered(x, y, z);
    }
  }

  lemma LemmaDivDecreases(x: int, d: int)
    requires 0 < x
    requires 1 < d
    ensures x / d < x
  {
    LemmaDivInductionAuto(d, x, u => 0 < u ==> u / d < u);
  }

  lemma LemmaDivDecreasesAuto()
    ensures forall x: int, d: int {:trigger x / d} :: 0 < x && 1 < d ==> x / d < x
  {
    forall x: int, d: int | 0 < x && 1 < d
      ensures x / d < x
    {
      LemmaDivDecreases(x, d);
    }
  }

  lemma LemmaDivNonincreasing(x: int, d: int)
    requires 0 <= x
    requires 0 < d
    ensures x / d <= x
  {
    LemmaDivInductionAuto(d, x, u => 0 <= u ==> u / d <= u);
  }

  lemma LemmaDivNonincreasingAuto()
    ensures forall x: int, d: int {:trigger x / d} :: 0 <= x && 0 < d ==> x / d <= x
  {
    forall x: int, d: int | 0 <= x && 0 < d
      ensures x / d <= x
    {
      LemmaDivNonincreasing(x, d);
    }
  }

  lemma LemmaSmallMod(x: nat, m: nat)
    requires x < m
    requires 0 < m
    ensures x % m == x
  {
    ModINL.LemmaSmallMod(x, m);
  }

  lemma LemmaBreakdown(x: int, y: int, z: int)
    requires 0 <= x
    requires 0 < y
    requires 0 < z
    ensures 0 < y * z
    ensures x % (y * z) == y * (x / y % z) + x % y
  {
    LemmaMulStrictlyPositiveAuto();
    LemmaDivPosIsPos(x, y);
    assert 0 <= x / y;
    calc {
      y * (x / y) % (y * z) + x % y % (y * z);
    <=
      {
        LemmaPartBound1(x, y, z);
      }
      y * (z - 1) + x % y % (y * z);
    <
      {
        LemmaPartBound2(x, y, z);
      }
      y * (z - 1) + y;
      {
        LemmaMulBasicsAuto();
      }
      y * (z - 1) + y * 1;
      {
        LemmaMulIsDistributiveAuto();
      }
      y * (z - 1 + 1);
      y * z;
    }
    calc {
      x % (y * z);
      {
        LemmaFundamentalDivMod(x, y);
      }
      (y * (x / y) + x % y) % (y * z);
      {
        LemmaModPropertiesAuto();
        assert 0 <= x % y;
        LemmaMulNonnegative(y, x / y);
        assert y * (x / y) % (y * z) + x % y % (y * z) < y * z;
        LemmaModAdds(y * (x / y), x % y, y * z);
      }
      y * (x / y) % (y * z) + x % y % (y * z);
      {
        LemmaModPropertiesAuto();
        LemmaMulIncreases(z, y);
        LemmaMulIsCommutativeAuto();
        assert x % y < y <= y * z;
        LemmaSmallMod(x % y, y * z);
        assert x % y % (y * z) == x % y;
      }
      y * (x / y) % (y * z) + x % y;
      {
        LemmaTruncateMiddle(x / y, y, z);
      }
      y * (x / y % z) + x % y;
    }
  }

  lemma LemmaBreakdownAuto()
    ensures forall x: int, y: int, z: int {:trigger y * z, x % (y * z), y * (x / y % z) + x % y} :: 0 <= x && 0 < y && 0 < z ==> 0 < y * z && x % (y * z) == y * (x / y % z) + x % y
  {
    forall x: int, y: int, z: int | 0 <= x && 0 < y && 0 < z
      ensures 0 < y * z && x % (y * z) == y * (x / y % z) + x % y
    {
      LemmaBreakdown(x, y, z);
    }
  }

  lemma LemmaRemainderUpper(x: int, d: int)
    requires 0 <= x
    requires 0 < d
    ensures x - d < x / d * d
  {
    LemmaMulAuto();
    LemmaDivInductionAuto(d, x, u => 0 <= u ==> u - d < u / d * d);
  }

  lemma LemmaRemainderUpperAuto()
    ensures forall x: int, d: int {:trigger x - d, d * d} :: 0 <= x && 0 < d ==> x - d < x / d * d
  {
    forall x: int, d: int | 0 <= x && 0 < d
      ensures x - d < x / d * d
    {
      LemmaRemainderUpper(x, d);
    }
  }

  lemma LemmaRemainderLower(x: int, d: int)
    requires 0 <= x
    requires 0 < d
    ensures x >= x / d * d
  {
    LemmaMulAuto();
    LemmaDivInductionAuto(d, x, u => 0 <= u ==> u >= u / d * d);
  }

  lemma LemmaRemainderLowerAuto()
    ensures forall x: int, d: int {:trigger x / d * d} :: 0 <= x && 0 < d ==> x >= x / d * d
  {
    forall x: int, d: int | 0 <= x && 0 < d
      ensures x >= x / d * d
    {
      LemmaRemainderLower(x, d);
    }
  }

  lemma LemmaRemainder(x: int, d: int)
    requires 0 <= x
    requires 0 < d
    ensures 0 <= x - x / d * d < d
  {
    LemmaMulAuto();
    LemmaDivInductionAuto(d, x, u => 0 <= u - u / d * d < d);
  }

  lemma LemmaRemainderAuto()
    ensures forall x: int, d: int {:trigger x - x / d * d} :: 0 <= x && 0 < d ==> 0 <= x - x / d * d < d
  {
    forall x: int, d: int | 0 <= x && 0 < d
      ensures 0 <= x - x / d * d < d
    {
      LemmaRemainder(x, d);
    }
  }

  lemma LemmaFundamentalDivMod(x: int, d: int)
    requires d != 0
    ensures x == d * (x / d) + x % d
  {
    ModINL.LemmaFundamentalDivMod(x, d);
  }

  lemma LemmaFundamentalDivModAuto()
    ensures forall x: int, d: int {:trigger d * (x / d) + x % d} :: d != 0 ==> x == d * (x / d) + x % d
  {
    forall x: int, d: int | d != 0
      ensures x == d * (x / d) + x % d
    {
      LemmaFundamentalDivMod(x, d);
    }
  }

  lemma LemmaDivDenominator(x: int, c: nat, d: nat)
    requires 0 <= x
    requires 0 < c
    requires 0 < d
    ensures c * d != 0
    ensures x / c / d == x / (c * d)
  {
    LemmaMulStrictlyPositiveAuto();
    var R := x % (c * d);
    LemmaModPropertiesAuto();
    LemmaDivPosIsPos(R, c);
    if R / c >= d {
      LemmaFundamentalDivMod(R, c);
      LemmaMulInequality(d, R / c, c);
      LemmaMulIsCommutativeAuto();
      assert false;
    }
    assert R / c < d;
    LemmaMulBasicsAuto();
    LemmaFundamentalDivModConverse(R / c, d, 0, R / c);
    assert R / c % d == R / c;
    LemmaFundamentalDivMod(R, c);
    assert c * (R / c) + R % c == R;
    assert c * (R / c % d) + R % c == R;
    var k := x / (c * d);
    LemmaFundamentalDivMod(x, c * d);
    assert x == c * d * (x / (c * d)) + x % (c * d);
    assert R == x - c * d * (x / (c * d));
    assert R == x - c * d * k;
    calc {
      c * (x / c % d) + x % c;
      {
        LemmaModMultiplesVanish(-k, x / c, d);
        LemmaMulIsCommutativeAuto();
      }
      c * ((x / c + -k * d) % d) + x % c;
      {
        LemmaHoistOverDenominator(x, -k * d, c);
      }
      c * ((x + -k * d * c) / c % d) + x % c;
      {
        LemmaMulIsAssociative(-k, d, c);
      }
      c * ((x + -k * (d * c)) / c % d) + x % c;
      {
        LemmaMulUnaryNegation(k, d * c);
      }
      c * ((x + -(k * (d * c))) / c % d) + x % c;
      {
        LemmaMulIsAssociative(k, d, c);
      }
      c * ((x + -(k * d * c)) / c % d) + x % c;
      c * ((x - k * d * c) / c % d) + x % c;
      {
        LemmaMulIsAssociativeAuto();
        LemmaMulIsCommutativeAuto();
      }
      c * (R / c % d) + x % c;
      c * (R / c) + x % c;
      {
        LemmaFundamentalDivMod(R, c);
        assert R == c * (R / c) + R % c;
        LemmaModMod(x, c, d);
        assert R % c == x % c;
      }
      R;
      {
        LemmaModIsModRecursiveAuto();
      }
      R % (c * d);
      (x - c * d * k) % (c * d);
      {
        LemmaMulUnaryNegation(c * d, k);
      }
      (x + c * d * -k) % (c * d);
      {
        LemmaModMultiplesVanish(-k, x, c * d);
      }
      x % (c * d);
    }
    calc ==> {
      c * (x / c) + x % c - R == c * (x / c) - c * (x / c % d);
      {
        LemmaFundamentalDivMod(x, c);
      }
      x - R == c * (x / c) - c * (x / c % d);
    }
    calc ==> {
      true;
      {
        LemmaFundamentalDivMod(x / c, d);
      }
      d * (x / c / d) == x / c - x / c % d;
      c * (d * (x / c / d)) == c * (x / c - x / c % d);
      {
        LemmaMulIsAssociativeAuto();
      }
      c * d * (x / c / d) == c * (x / c - x / c % d);
      {
        LemmaMulIsDistributiveAuto();
      }
      c * d * (x / c / d) == c * (x / c) - c * (x / c % d);
      c * d * (x / c / d) == x - R;
      {
        LemmaFundamentalDivMod(x, c * d);
      }
      c * d * (x / c / d) == c * d * (x / (c * d)) + x % (c * d) - R;
      c * d * (x / c / d) == c * d * (x / (c * d));
      {
        LemmaMulEqualityConverse(c * d, x / c / d, x / (c * d));
      }
      x / c / d == x / (c * d);
    }
  }

  lemma LemmaDivDenominatorAuto()
    ensures forall c: nat, d: nat {:trigger c * d} :: 0 < c && 0 < d ==> c * d != 0
    ensures forall x: int, c: nat, d: nat {:trigger x / c / d} :: 0 <= x && 0 < c && 0 < d ==> x / c / d == x / (c * d)
  {
    LemmaMulNonzeroAuto();
    forall x: int, c: nat, d: nat | 0 <= x && 0 < c && 0 < d
      ensures x / c / d == x / (c * d)
    {
      LemmaDivDenominator(x, c, d);
    }
  }

  lemma LemmaMulHoistInequality(x: int, y: int, z: int)
    requires 0 <= x
    requires 0 < z
    ensures x * (y / z) <= x * y / z
  {
    calc {
      x * y / z;
      {
        LemmaFundamentalDivMod(y, z);
      }
      x * (z * (y / z) + y % z) / z;
      {
        LemmaMulIsDistributiveAuto();
      }
      (x * (z * (y / z)) + x * (y % z)) / z;
    >=
      {
        LemmaModPropertiesAuto();
        LemmaMulNonnegative(x, y % z);
        LemmaDivIsOrdered(x * (z * (y / z)), x * (z * (y / z)) + x * (y % z), z);
      }
      x * (z * (y / z)) / z;
      {
        LemmaMulIsAssociativeAuto();
        LemmaMulIsCommutativeAuto();
      }
      z * (x * (y / z)) / z;
      {
        LemmaDivMultiplesVanish(x * (y / z), z);
      }
      x * (y / z);
    }
  }

  lemma LemmaMulHoistInequalityAuto()
    ensures forall x: int, y: int, z: int {:trigger x * (y / z), x * y / z} :: 0 <= x && 0 < z ==> x * (y / z) <= x * y / z
  {
    forall x: int, y: int, z: int | 0 <= x && 0 < z
      ensures x * (y / z) <= x * y / z
    {
      LemmaMulHoistInequality(x, y, z);
    }
  }

  lemma {:induction false} LemmaIndistinguishableQuotients(a: int, b: int, d: int)
    requires 0 < d
    requires 0 <= a - a % d <= b < a + d - a % d
    ensures a / d == b / d
  {
    var f := ab => var u := ab + b; 0 <= u - u % d <= b < u + d - u % d ==> u / d == b / d;
    assert f(a - b) by {
      LemmaDivInductionAuto(d, a - b, f);
    }
  }

  lemma LemmaIndistinguishableQuotientsAuto()
    ensures forall a: int, b: int, d: int {:trigger a / d, b / d} :: 0 < d && 0 <= a - a % d <= b < a + d - a % d ==> a / d == b / d
  {
    forall a: int, b: int, d: int | 0 < d && 0 <= a - a % d <= b < a + d - a % d
      ensures a / d == b / d
    {
      LemmaIndistinguishableQuotients(a, b, d);
    }
  }

  lemma LemmaTruncateMiddle(x: int, b: int, c: int)
    requires 0 <= x
    requires 0 < b
    requires 0 < c
    ensures 0 < b * c
    ensures b * x % (b * c) == b * (x % c)
  {
    LemmaMulStrictlyPositiveAuto();
    LemmaMulNonnegativeAuto();
    calc {
      b * x;
      {
        LemmaFundamentalDivMod(b * x, b * c);
      }
      b * c * (b * x / (b * c)) + b * x % (b * c);
      {
        LemmaDivDenominator(b * x, b, c);
      }
      b * c * (b * x / b / c) + b * x % (b * c);
      {
        LemmaMulIsCommutativeAuto();
        LemmaDivByMultiple(x, b);
      }
      b * c * (x / c) + b * x % (b * c);
    }
    calc ==> {
      true;
      {
        LemmaFundamentalDivMod(x, c);
      }
      x == c * (x / c) + x % c;
      b * x == b * (c * (x / c) + x % c);
      {
        LemmaMulIsDistributiveAuto();
      }
      b * x == b * (c * (x / c)) + b * (x % c);
      {
        LemmaMulIsAssociativeAuto();
      }
      b * x == b * c * (x / c) + b * (x % c);
    }
  }

  lemma LemmaTruncateMiddleAuto()
    ensures forall x: int, b: int, c: int {:trigger b * (x % c)} :: 0 <= x && 0 < b && 0 < c && 0 < b * c ==> b * x % (b * c) == b * (x % c)
  {
    forall x: int, b: int, c: int | 0 <= x && 0 < b && 0 < c && 0 < b * c
      ensures b * x % (b * c) == b * (x % c)
    {
      LemmaTruncateMiddle(x, b, c);
    }
  }

  lemma LemmaDivMultiplesVanishQuotient(x: int, a: int, d: int)
    requires 0 < x
    requires 0 <= a
    requires 0 < d
    ensures 0 < x * d
    ensures a / d == x * a / (x * d)
  {
    LemmaMulStrictlyPositive(x, d);
    calc {
      x * a / (x * d);
      {
        LemmaMulNonnegative(x, a);
        LemmaDivDenominator(x * a, x, d);
      }
      x * a / x / d;
      {
        LemmaDivMultiplesVanish(a, x);
      }
      a / d;
    }
  }

  lemma LemmaDivMultiplesVanishQuotientAuto()
    ensures forall x: int, a: int, d: int {:trigger a / d, x * d, x * a} :: 0 < x && 0 <= a && 0 < d ==> 0 < x * d && a / d == x * a / (x * d)
  {
    forall x: int, a: int, d: int {:trigger x * d, 0 <= a} | 0 < x && 0 <= a && 0 < d
      ensures 0 < x * d && a / d == x * a / (x * d)
    {
      LemmaDivMultiplesVanishQuotient(x, a, d);
    }
  }

  lemma LemmaRoundDown(a: int, r: int, d: int)
    requires 0 < d
    requires a % d == 0
    requires 0 <= r < d
    ensures a == d * ((a + r) / d)
  {
    LemmaMulAuto();
    LemmaDivInductionAuto(d, a, u => u % d == 0 ==> u == d * ((u + r) / d));
  }

  lemma LemmaRoundDownAuto()
    ensures forall a: int, r: int, d: int {:trigger d * ((a + r) / d)} :: 0 < d && a % d == 0 && 0 <= r < d ==> a == d * ((a + r) / d)
  {
    forall a: int, r: int, d: int {:trigger a + r, r < d} {:trigger a + r, 0 < d} {:trigger 0 <= r, a % d} | 0 < d && a % d == 0 && 0 <= r < d
      ensures a == d * ((a + r) / d)
    {
      LemmaRoundDown(a, r, d);
    }
  }

  @IsolateAssertions lemma LemmaDivMultiplesVanishFancy(x: int, b: int, d: int)
    requires 0 < d
    requires 0 <= b < d
    ensures (d * x + b) / d == x
  {
    assert b / d == 0 by {
      LemmaDivAuto(d);
    }
    var f := u => (d * u + b) / d == u;
    assert f(0);
    forall i | true
      ensures IsLe(0, i) && f(i) ==> f(i + 1)
    {
      if f(i) {
        var z := (d * i + b) % d + d % d;
        assert 0 <= z < d;
        assert f(i + 1) by {
          calc {
            i + 1;
            (d * i + b) / d + d / d;
            {
              assert DivPlus(d, d * i + b, d) by {
                LemmaDivAuto(d);
              }
            }
            (d * i + b + d) / d;
            {
              LemmaMulAuto();
            }
            (d * (i + 1) + b) / d;
          }
        }
      }
    }
    forall i | true
      ensures IsLe(i, 0) && f(i) ==> f(i - 1)
    {
      if f(i) {
        var z := (d * i + b) % d - d % d;
        assert 0 <= z < d;
        assert f(i - 1) by {
          calc {
            i - 1;
            (d * i + b) / d - d / d;
            {
              assert DivMinus(d, d * i + b, d) by {
                LemmaDivAuto(d);
              }
            }
            (d * i + b - d) / d;
            {
              LemmaMulAuto();
            }
            (d * (i - 1) + b) / d;
          }
        }
      }
    }
    LemmaMulInductionAuto(x, f);
  }

  lemma LemmaDivMultiplesVanishFancyAuto()
    ensures forall x: int, b: int, d: int {:trigger (d * x + b) / d} :: 0 < d && 0 <= b < d ==> (d * x + b) / d == x
  {
    forall x: int, b: int, d: int {:trigger d * x, b < d} {:trigger d * x, 0 <= b} | 0 < d && 0 <= b < d
      ensures (d * x + b) / d == x
    {
      LemmaDivMultiplesVanishFancy(x, b, d);
    }
  }

  lemma LemmaDivMultiplesVanish(x: int, d: int)
    requires 0 < d
    ensures d * x / d == x
  {
    LemmaDivMultiplesVanishFancy(x, 0, d);
  }

  lemma LemmaDivMultiplesVanishAuto()
    ensures forall x: int, d: int {:trigger d * x / d} :: 0 < d ==> d * x / d == x
  {
    forall x: int, d: int | 0 < d
      ensures d * x / d == x
    {
      LemmaDivMultiplesVanish(x, d);
    }
  }

  lemma LemmaDivByMultiple(b: int, d: int)
    requires 0 <= b
    requires 0 < d
    ensures b * d / d == b
  {
    LemmaDivMultiplesVanish(b, d);
  }

  lemma LemmaDivByMultipleAuto()
    ensures forall b: int, d: int {:trigger b * d / d} :: 0 <= b && 0 < d ==> b * d / d == b
  {
    forall b: int, d: int | 0 <= b && 0 < d
      ensures b * d / d == b
    {
      LemmaDivByMultiple(b, d);
    }
  }

  lemma LemmaDivByMultipleIsStronglyOrdered(x: int, y: int, m: int, z: int)
    requires x < y
    requires y == m * z
    requires 0 < z
    ensures x / z < y / z
  {
    LemmaModMultiplesBasic(m, z);
    LemmaDivInductionAuto(z, y - x, yx => var u := yx + x; x < u && u % z == 0 ==> x / z < u / z);
  }

  lemma LemmaDivByMultipleIsStronglyOrderedAuto()
    ensures forall x: int, y: int, m: int, z: int {:trigger x / z, m * z, y / z} :: x < y && y == m * z && 0 < z ==> x / z < y / z
  {
    forall x: int, y: int, m: int, z: int | x < y && y == m * z && 0 < z
      ensures x / z < y / z
    {
      LemmaDivByMultipleIsStronglyOrdered(x, y, m, z);
    }
  }

  lemma LemmaMultiplyDivideLe(a: int, b: int, c: int)
    requires 0 < b
    requires a <= b * c
    ensures a / b <= c
  {
    LemmaModMultiplesBasic(c, b);
    LemmaDivInductionAuto(b, b * c - a, i => 0 <= i && (i + a) % b == 0 ==> a / b <= (i + a) / b);
    LemmaDivMultiplesVanish(c, b);
  }

  lemma LemmaMultiplyDivideLeAuto()
    ensures forall a: int, b: int, c: int {:trigger a / b, b * c} :: 0 < b && a <= b * c ==> a / b <= c
  {
    forall a: int, b: int, c: int | 0 < b && a <= b * c
      ensures a / b <= c
    {
      LemmaMultiplyDivideLe(a, b, c);
    }
  }

  lemma LemmaMultiplyDivideLt(a: int, b: int, c: int)
    requires 0 < b
    requires a < b * c
    ensures a / b < c
  {
    LemmaModMultiplesBasic(c, b);
    LemmaDivInductionAuto(b, b * c - a, i => 0 < i && (i + a) % b == 0 ==> a / b < (i + a) / b);
    LemmaDivMultiplesVanish(c, b);
  }

  lemma LemmaMultiplyDivideLtAuto()
    ensures forall a: int, b: int, c: int {:trigger a / b, b * c} :: 0 < b && a < b * c ==> a / b < c
  {
    forall a: int, b: int, c: int | 0 < b && a < b * c
      ensures a / b < c
    {
      LemmaMultiplyDivideLt(a, b, c);
    }
  }

  lemma LemmaHoistOverDenominator(x: int, j: int, d: nat)
    requires 0 < d
    ensures x / d + j == (x + j * d) / d
  {
    LemmaDivAuto(d);
    LemmaMulInductionAuto(j, u => x / d + u == (x + u * d) / d);
  }

  lemma LemmaHoistOverDenominatorAuto()
    ensures forall x: int, j: int, d: nat {:trigger x / d + j} :: 0 < d ==> x / d + j == (x + j * d) / d
  {
    forall x: int, j: int, d: nat | 0 < d
      ensures x / d + j == (x + j * d) / d
    {
      LemmaHoistOverDenominator(x, j, d);
    }
  }

  lemma LemmaPartBound1(a: int, b: int, c: int)
    requires 0 <= a
    requires 0 < b
    requires 0 < c
    ensures 0 < b * c
    ensures b * (a / b) % (b * c) <= b * (c - 1)
  {
    LemmaMulStrictlyPositiveAuto();
    calc {
      b * (a / b) % (b * c);
      {
        LemmaFundamentalDivMod(b * (a / b), b * c);
      }
      b * (a / b) - b * c * (b * (a / b) / (b * c));
      {
        LemmaMulIsAssociativeAuto();
      }
      b * (a / b) - b * (c * (b * (a / b) / (b * c)));
      {
        LemmaMulIsDistributiveAuto();
      }
      b * (a / b - c * (b * (a / b) / (b * c)));
    }
    calc ==> {
      true;
      {
        LemmaModPropertiesAuto();
      }
      b * (a / b) % (b * c) < b * c;
      b * (a / b - c * (b * (a / b) / (b * c))) < b * c;
      {
        LemmaMulIsCommutativeAuto();
        LemmaMulStrictInequalityConverseAuto();
      }
      a / b - c * (b * (a / b) / (b * c)) < c;
      a / b - c * (b * (a / b) / (b * c)) <= c - 1;
      {
        LemmaMulIsCommutativeAuto();
        LemmaMulInequalityAuto();
      }
      b * (a / b - c * (b * (a / b) / (b * c))) <= b * (c - 1);
      b * (a / b) % (b * c) <= b * (c - 1);
    }
  }

  lemma LemmaPartBound1Auto()
    ensures forall a: int, b: int, c: int {:trigger b * (a / b) % (b * c)} :: 0 <= a && 0 < b && 0 < c ==> 0 < b * c && b * (a / b) % (b * c) <= b * (c - 1)
  {
    forall a: int, b: int, c: int {:trigger b * c, 0 <= a} | 0 <= a && 0 < b && 0 < c
      ensures 0 < b * c && b * (a / b) % (b * c) <= b * (c - 1)
    {
      LemmaPartBound1(a, b, c);
    }
  }

  lemma LemmaModIsModRecursive(x: int, m: int)
    requires m > 0
    ensures ModRecursive(x, m) == x % m
    decreases if x < 0 then -x + m else x
  {
    if x < 0 {
      calc {
        ModRecursive(x, m);
        ModRecursive(x + m, m);
        {
          LemmaModIsModRecursive(x + m, m);
        }
        (x + m) % m;
        {
          LemmaAddModNoop(x, m, m);
        }
        (x % m + m % m) % m;
        {
          LemmaModBasicsAuto();
        }
        x % m % m;
        {
          LemmaModBasicsAuto();
        }
        x % m;
      }
    } else if x < m {
      LemmaSmallMod(x, m);
    } else {
      calc {
        ModRecursive(x, m);
        ModRecursive(x - m, m);
        {
          LemmaModIsModRecursive(x - m, m);
        }
        (x - m) % m;
        {
          LemmaSubModNoop(x, m, m);
        }
        (x % m - m % m) % m;
        {
          LemmaModBasicsAuto();
        }
        x % m % m;
        {
          LemmaModBasicsAuto();
        }
        x % m;
      }
    }
  }

  lemma LemmaModIsModRecursiveAuto()
    ensures forall x: int, d: int {:trigger x % d} :: d > 0 ==> ModRecursive(x, d) == x % d
  {
    forall x: int, d: int | d > 0
      ensures ModRecursive(x, d) == x % d
    {
      LemmaModIsModRecursive(x, d);
    }
  }

  lemma LemmaModBasicsAuto()
    ensures forall m: int {:trigger m % m} :: m > 0 ==> m % m == 0
    ensures forall x: int, m: int {:trigger x % m % m} :: m > 0 ==> x % m % m == x % m
  {
    forall m: int | m > 0
      ensures m % m == 0
    {
      LemmaModAuto(m);
    }
    forall x: int, m: int | m > 0
      ensures x % m % m == x % m
    {
      LemmaModAuto(m);
    }
  }

  lemma LemmaModPropertiesAuto()
    ensures forall m: int {:trigger m % m} :: m > 0 ==> m % m == 0
    ensures forall x: int, m: int {:trigger x % m % m} :: m > 0 ==> x % m % m == x % m
    ensures forall x: int, m: int {:trigger x % m} :: m > 0 ==> 0 <= x % m < m
  {
    LemmaModBasicsAuto();
    forall x: int, m: int | m > 0
      ensures 0 <= x % m < m
    {
      LemmaModAuto(m);
    }
  }

  lemma LemmaModDecreases(x: nat, m: nat)
    requires 0 < m
    ensures x % m <= x
  {
    LemmaModAuto(m);
  }

  lemma LemmaModDecreasesAuto()
    ensures forall x: nat, m: nat {:trigger x % m} :: 0 < m ==> x % m <= x
  {
    forall x: nat, m: nat | 0 < m
      ensures x % m <= x
    {
      LemmaModDecreases(x, m);
    }
  }

  lemma LemmaModIsZero(x: nat, m: nat)
    requires x > 0 && m > 0
    requires x % m == 0
    ensures x >= m
  {
    if x < m {
      assert x % m == x by {
        LemmaSmallMod(x, m);
      }
      assert false;
    }
  }

  lemma LemmaModIsZeroAuto()
    ensures forall x: nat, m: nat {:trigger x % m} :: x > 0 && m > 0 && x % m == 0 ==> x >= m
  {
    forall x: nat, m: nat | x > 0 && m > 0 && x % m == 0
      ensures x >= m
    {
      LemmaModIsZero(x, m);
    }
  }

  lemma LemmaModMultiplesBasic(x: int, m: int)
    requires m > 0
    ensures x * m % m == 0
  {
    LemmaModAuto(m);
    LemmaMulInductionAuto(x, u => u * m % m == 0);
  }

  lemma LemmaModMultiplesBasicAuto()
    ensures forall x: int, m: int {:trigger x * m % m} :: m > 0 ==> x * m % m == 0
  {
    forall x: int, m: int | m > 0
      ensures x * m % m == 0
    {
      LemmaModMultiplesBasic(x, m);
    }
  }

  lemma LemmaModAddMultiplesVanish(b: int, m: int)
    requires 0 < m
    ensures (m + b) % m == b % m
  {
    LemmaModAuto(m);
  }

  lemma LemmaModAddMultiplesVanishAuto()
    ensures forall b: int, m: int {:trigger b % m} :: 0 < m ==> (m + b) % m == b % m
  {
    forall b: int, m: int | 0 < m
      ensures (m + b) % m == b % m
    {
      LemmaModAddMultiplesVanish(b, m);
    }
  }

  lemma LemmaModSubMultiplesVanish(b: int, m: int)
    requires 0 < m
    ensures (-m + b) % m == b % m
  {
    LemmaModAuto(m);
  }

  lemma LemmaModSubMultiplesVanishAuto()
    ensures forall b: int, m: int {:trigger b % m} :: 0 < m ==> (-m + b) % m == b % m
  {
    forall b: int, m: int | 0 < m
      ensures (-m + b) % m == b % m
    {
      LemmaModSubMultiplesVanish(b, m);
    }
  }

  predicate MultiplesVanish(a: int, b: int, m: int)
    requires 0 < m
  {
    (m * a + b) % m == b % m
  }

  lemma LemmaModMultiplesVanish(a: int, b: int, m: int)
    requires 0 < m
    ensures MultiplesVanish(a, b, m)
    decreases if a > 0 then a else -a
  {
    LemmaModAuto(m);
    LemmaMulAuto();
    assert MultiplesVanish(0, b, m);
    LemmaMulInductionAuto(a, u => MultiplesVanish(u, b, m));
  }

  lemma LemmaModMultiplesVanishAuto()
    ensures forall a: int, b: int, m: int {:trigger (m * a + b) % m} :: 0 < m ==> MultiplesVanish(a, b, m)
  {
    forall a: int, b: int, m: int | 0 < m
      ensures MultiplesVanish(a, b, m)
    {
      LemmaModMultiplesVanish(a, b, m);
    }
  }

  lemma LemmaModSubtraction(x: nat, s: nat, d: nat)
    requires 0 < d
    requires 0 <= s <= x % d
    ensures x % d - s % d == (x - s) % d
  {
    LemmaModAuto(d);
  }

  lemma LemmaModSubtractionAuto()
    ensures forall x: nat, s: nat, d: nat {:trigger (x - s) % d} :: 0 < d && 0 <= s <= x % d ==> x % d - s % d == (x - s) % d
  {
    forall x: nat, s: nat, d: nat | 0 < d && 0 <= s <= x % d
      ensures x % d - s % d == (x - s) % d
    {
      LemmaModSubtraction(x, s, d);
    }
  }

  lemma LemmaAddModNoop(x: int, y: int, m: int)
    requires 0 < m
    ensures (x % m + y % m) % m == (x + y) % m
  {
    LemmaModAuto(m);
  }

  lemma LemmaAddModNoopAuto()
    ensures forall x: int, y: int, m: int {:trigger (x + y) % m} :: 0 < m ==> (x % m + y % m) % m == (x + y) % m
  {
    forall x: int, y: int, m: int | 0 < m
      ensures (x % m + y % m) % m == (x + y) % m
    {
      LemmaAddModNoop(x, y, m);
    }
  }

  lemma LemmaAddModNoopRight(x: int, y: int, m: int)
    requires 0 < m
    ensures (x + y % m) % m == (x + y) % m
  {
    LemmaModAuto(m);
  }

  lemma LemmaAddModNoopRightAuto()
    ensures forall x: int, y: int, m: int {:trigger (x + y) % m} :: 0 < m ==> (x + y % m) % m == (x + y) % m
  {
    forall x: int, y: int, m: int {:trigger x + y % m} | 0 < m
      ensures (x + y % m) % m == (x + y) % m
    {
      LemmaAddModNoopRight(x, y, m);
    }
  }

  lemma LemmaSubModNoop(x: int, y: int, m: int)
    requires 0 < m
    ensures (x % m - y % m) % m == (x - y) % m
  {
    LemmaModAuto(m);
  }

  lemma LemmaSubModNoopAuto()
    ensures forall x: int, y: int, m: int {:trigger (x - y) % m} :: 0 < m ==> (x % m - y % m) % m == (x - y) % m
  {
    forall x: int, y: int, m: int {:trigger x % m - y % m} | 0 < m
      ensures (x % m - y % m) % m == (x - y) % m
    {
      LemmaSubModNoop(x, y, m);
    }
  }

  lemma LemmaSubModNoopRight(x: int, y: int, m: int)
    requires 0 < m
    ensures (x - y % m) % m == (x - y) % m
  {
    LemmaModAuto(m);
  }

  lemma LemmaSubModNoopRightAuto()
    ensures forall x: int, y: int, m: int {:trigger (x - y) % m} :: 0 < m ==> (x - y % m) % m == (x - y) % m
  {
    forall x: int, y: int, m: int {:trigger x - y % m} | 0 < m
      ensures (x - y % m) % m == (x - y) % m
    {
      LemmaSubModNoopRight(x, y, m);
    }
  }

  lemma LemmaModAdds(a: int, b: int, d: int)
    requires 0 < d
    ensures a % d + b % d == (a + b) % d + d * ((a % d + b % d) / d)
    ensures a % d + b % d < d ==> a % d + b % d == (a + b) % d
  {
    LemmaMulAuto();
    LemmaDivAuto(d);
  }

  lemma LemmaModAddsAuto()
    ensures forall a: int, b: int, d: int {:trigger (a + b) % d} :: 0 < d ==> a % d + b % d == (a + b) % d + d * ((a % d + b % d) / d) && (a % d + b % d < d ==> a % d + b % d == (a + b) % d)
  {
    forall a: int, b: int, d: int | 0 < d
      ensures a % d + b % d == (a + b) % d + d * ((a % d + b % d) / d) && (a % d + b % d < d ==> a % d + b % d == (a + b) % d)
    {
      LemmaModAdds(a, b, d);
    }
  }

  @IsolateAssertions lemma LemmaModNegNeg(x: int, d: int)
    requires 0 < d
    ensures x % d == x * (1 - d) % d
  {
    assert (x - x * d) % d == x % d by {
      LemmaModAuto(d);
      var f := i => (x - i * d) % d == x % d;
      assert MulAuto() ==> f(0) && (forall i {:trigger IsLe(0, i)} :: IsLe(0, i) && f(i) ==> f(i + 1)) && forall i {:trigger IsLe(i, 0)} :: IsLe(i, 0) && f(i) ==> f(i - 1);
      LemmaMulInductionAuto(x, f);
    }
    LemmaMulAuto();
  }

  @ResourceLimit("2200000") @TimeLimitMultiplier(10) lemma LemmaFundamentalDivModConverse(x: int, d: int, q: int, r: int)
    requires d != 0
    requires 0 <= r < d
    requires x == q * d + r
    ensures q == x / d
    ensures r == x % d
  {
    LemmaDivAuto(d);
    LemmaMulInductionAuto(q, u => u == (u * d + r) / d);
    LemmaMulInductionAuto(q, u => r == (u * d + r) % d);
  }

  @TimeLimitMultiplier(5) lemma LemmaFundamentalDivModConverseAuto()
    ensures forall x: int, d: int, q: int, r: int {:trigger q * d + r, x % d} :: d != 0 && 0 <= r < d && x == q * d + r ==> q == x / d && r == x % d
  {
    forall x: int, d: int, q: int, r: int {:trigger x / d, q * d, r < d} {:trigger x / d, q * d, 0 <= r} | d != 0 && 0 <= r < d && x == q * d + r
      ensures q == x / d && r == x % d
    {
      LemmaFundamentalDivModConverse(x, d, q, r);
    }
  }

  lemma LemmaModPosBound(x: int, m: int)
    requires 0 <= x
    requires 0 < m
    ensures 0 <= x % m < m
    decreases x
  {
    LemmaModAuto(m);
  }

  lemma LemmaModPosBoundAuto()
    ensures forall x: int, m: int {:trigger x % m} :: 0 <= x && 0 < m ==> 0 <= x % m < m
  {
    forall x: int, m: int | 0 <= x && 0 < m
      ensures 0 <= x % m < m
    {
      LemmaModPosBound(x, m);
    }
  }

  lemma LemmaMulModNoopLeft(x: int, y: int, m: int)
    requires 0 < m
    ensures x % m * y % m == x * y % m
  {
    LemmaModAuto(m);
    LemmaMulInductionAuto(y, u => x % m * u % m == x * u % m);
  }

  lemma LemmaMulModNoopLeftAuto()
    ensures forall x: int, y: int, m: int {:trigger x * y % m} :: 0 < m ==> x % m * y % m == x * y % m
  {
    forall x: int, y: int, m: int | 0 < m
      ensures x % m * y % m == x * y % m
    {
      LemmaMulModNoopLeft(x, y, m);
    }
  }

  lemma LemmaMulModNoopRight(x: int, y: int, m: int)
    requires 0 < m
    ensures x * (y % m) % m == x * y % m
  {
    LemmaModAuto(m);
    LemmaMulInductionAuto(x, u => u * (y % m) % m == u * y % m);
  }

  lemma LemmaMulModNoopRightAuto()
    ensures forall x: int, y: int, m: int {:trigger x * y % m} :: 0 < m ==> x * (y % m) % m == x * y % m
  {
    forall x: int, y: int, m: int | 0 < m
      ensures x * (y % m) % m == x * y % m
    {
      LemmaMulModNoopRight(x, y, m);
    }
  }

  lemma LemmaMulModNoopGeneral(x: int, y: int, m: int)
    requires 0 < m
    ensures x % m * y % m == x * y % m
    ensures x * (y % m) % m == x * y % m
    ensures x % m * (y % m) % m == x * y % m
  {
    LemmaModPropertiesAuto();
    LemmaMulModNoopLeft(x, y, m);
    LemmaMulModNoopRight(x, y, m);
    LemmaMulModNoopRight(x % m, y, m);
  }

  lemma LemmaMulModNoopGeneralAuto()
    ensures forall x: int, y: int, m: int {:trigger x * y % m} :: 0 < m ==> x % m * y % m == x * (y % m) % m == x % m * (y % m) % m == x * y % m
  {
    forall x: int, y: int, m: int | 0 < m
      ensures x % m * y % m == x * (y % m) % m == x % m * (y % m) % m == x * y % m
    {
      LemmaMulModNoopGeneral(x, y, m);
    }
  }

  lemma LemmaMulModNoop(x: int, y: int, m: int)
    requires 0 < m
    ensures x % m * (y % m) % m == x * y % m
  {
    LemmaMulModNoopGeneral(x, y, m);
  }

  lemma LemmaMulModNoopAuto()
    ensures forall x: int, y: int, m: int {:trigger x * y % m} :: 0 < m ==> x % m * (y % m) % m == x * y % m
  {
    forall x: int, y: int, m: int | 0 < m
      ensures x % m * (y % m) % m == x * y % m
    {
      LemmaMulModNoop(x, y, m);
    }
  }

  lemma LemmaModEquivalence(x: int, y: int, m: int)
    requires 0 < m
    ensures x % m == y % m <==> (x - y) % m == 0
  {
    LemmaModAuto(m);
  }

  lemma LemmaModEquivalenceAuto()
    ensures forall x: int, y: int, m: int {:trigger x % m, y % m} :: 0 < m && x % m == y % m <==> 0 < m && (x - y) % m == 0
  {
    forall x: int, y: int, m: int | 0 < m
      ensures x % m == y % m <==> 0 < m && (x - y) % m == 0
    {
      LemmaModEquivalence(x, y, m);
    }
  }

  ghost predicate IsModEquivalent(x: int, y: int, m: int)
    requires m > 0
    ensures x % m == y % m <==> (x - y) % m == 0
  {
    LemmaModEquivalence(x, y, m);
    (x - y) % m == 0
  }

  lemma LemmaModMulEquivalent(x: int, y: int, z: int, m: int)
    requires m > 0
    requires IsModEquivalent(x, y, m)
    ensures IsModEquivalent(x * z, y * z, m)
  {
    LemmaMulModNoopLeft(x, z, m);
    LemmaMulModNoopLeft(y, z, m);
  }

  lemma LemmaModMulEquivalentAuto()
    ensures forall x: int, y: int, z: int, m: int {:trigger IsModEquivalent(x * z, y * z, m)} :: m > 0 && IsModEquivalent(x, y, m) ==> IsModEquivalent(x * z, y * z, m)
  {
    forall x: int, y: int, z: int, m: int | m > 0 && IsModEquivalent(x, y, m)
      ensures IsModEquivalent(x * z, y * z, m)
    {
      LemmaModMulEquivalent(x, y, z, m);
    }
  }

  lemma LemmaModOrdering(x: int, k: int, d: int)
    requires 1 < d
    requires 0 < k
    ensures 0 < d * k
    ensures x % d <= x % (d * k)
  {
    LemmaMulStrictlyIncreases(d, k);
    calc {
      x % d + d * (x / d);
      {
        LemmaFundamentalDivMod(x, d);
      }
      x;
      {
        LemmaFundamentalDivMod(x, d * k);
      }
      x % (d * k) + d * k * (x / (d * k));
      {
        LemmaMulIsAssociativeAuto();
      }
      x % (d * k) + d * (k * (x / (d * k)));
    }
    calc {
      x % d;
      {
        LemmaModPropertiesAuto();
      }
      x % d % d;
      {
        LemmaModMultiplesVanish(x / d - k * (x / (d * k)), x % d, d);
      }
      (x % d + d * (x / d - k * (x / (d * k)))) % d;
      {
        LemmaMulIsDistributiveSubAuto();
      }
      (x % d + d * (x / d) - d * (k * (x / (d * k)))) % d;
      x % (d * k) % d;
    <=
      {
        LemmaModPropertiesAuto();
        LemmaModDecreases(x % (d * k), d);
      }
      x % (d * k);
    }
  }

  lemma LemmaModOrderingAuto()
    ensures forall k: int, d: int {:trigger d * k} :: 1 < d && 0 < k ==> 0 < d * k
    ensures forall x: int, k: int, d: int {:trigger x % (d * k)} :: 1 < d && 0 < k ==> x % d <= x % (d * k)
  {
    forall k: int, d: int {:trigger d * k} | 1 < d && 0 < k
      ensures 1 < d && 0 < k ==> 0 < d * k
    {
      LemmaMulStrictlyIncreases(d, k);
    }
    forall x: int, k: int, d: int {:trigger x % (d * k)} | 1 < d && 0 < k
      ensures 1 < d && 0 < k ==> x % d <= x % (d * k)
    {
      LemmaModOrdering(x, k, d);
    }
  }

  lemma LemmaModMod(x: int, a: int, b: int)
    requires 0 < a
    requires 0 < b
    ensures 0 < a * b
    ensures x % (a * b) % a == x % a
  {
    LemmaMulStrictlyPositiveAuto();
    calc {
      x;
      {
        LemmaFundamentalDivMod(x, a * b);
      }
      a * b * (x / (a * b)) + x % (a * b);
      {
        LemmaMulIsAssociativeAuto();
      }
      a * (b * (x / (a * b))) + x % (a * b);
      {
        LemmaFundamentalDivMod(x % (a * b), a);
      }
      a * (b * (x / (a * b))) + a * (x % (a * b) / a) + x % (a * b) % a;
      {
        LemmaMulIsDistributiveAuto();
      }
      a * (b * (x / (a * b)) + x % (a * b) / a) + x % (a * b) % a;
    }
    LemmaModPropertiesAuto();
    LemmaMulIsCommutativeAuto();
    LemmaFundamentalDivModConverse(x, a, b * (x / (a * b)) + x % (a * b) / a, x % (a * b) % a);
  }

  lemma LemmaModModAuto()
    ensures forall a: int, b: int {:trigger a * b} :: 0 < a && 0 < b ==> 0 < a * b
    ensures forall x: int, a: int, b: int {:trigger x % (a * b) % a, x % a} :: 0 < a && 0 < b ==> x % (a * b) % a == x % a
  {
    forall a: int, b: int {:trigger a * b} | 0 < a && 0 < b
      ensures 0 < a * b
    {
      LemmaMulStrictlyPositiveAuto();
    }
    forall x: int, a: int, b: int | 0 < a && 0 < b
      ensures x % (a * b) % a == x % a
    {
      LemmaModMod(x, a, b);
    }
  }

  lemma LemmaPartBound2(x: int, y: int, z: int)
    requires 0 <= x
    requires 0 < y
    requires 0 < z
    ensures y * z > 0
    ensures x % y % (y * z) < y
  {
    LemmaMulStrictlyPositiveAuto();
    LemmaModPropertiesAuto();
    assert x % y < y;
    LemmaMulIncreasesAuto();
    LemmaMulIsCommutativeAuto();
    assert y <= y * z;
    assert 0 <= x % y < y * z;
    LemmaModPropertiesAuto();
    LemmaSmallMod(x % y, y * z);
    assert x % y % (y * z) == x % y;
  }

  lemma LemmaPartBound2Auto()
    ensures forall x: int, y: int, z: int {:trigger y * z, x % y} :: 0 <= x && 0 < y && 0 < z ==> y * z > 0 && x % y % (y * z) < y
  {
    forall x: int, y: int, z: int {:trigger y * z, 0 <= x} {:trigger 0 < z, 0 < y, 0 <= x} | 0 <= x && 0 < y && 0 < z
      ensures y * z > 0 && x % y % (y * z) < y
    {
      LemmaPartBound2(x, y, z);
    }
  }

  lemma LemmaModBreakdown(x: int, y: int, z: int)
    requires 0 <= x
    requires 0 < y
    requires 0 < z
    ensures y * z > 0
    ensures x % (y * z) == y * (x / y % z) + x % y
  {
    LemmaMulStrictlyPositiveAuto();
    LemmaDivPosIsPos(x, y);
    assert 0 <= x / y;
    calc {
      y * (x / y) % (y * z) + x % y % (y * z);
    <=
      {
        LemmaPartBound1(x, y, z);
      }
      y * (z - 1) + x % y % (y * z);
    <
      {
        LemmaPartBound2(x, y, z);
      }
      y * (z - 1) + y;
      {
        LemmaMulBasicsAuto();
      }
      y * (z - 1) + y * 1;
      {
        LemmaMulIsDistributiveAuto();
      }
      y * (z - 1 + 1);
      y * z;
    }
    calc {
      x % (y * z);
      {
        LemmaFundamentalDivMod(x, y);
      }
      (y * (x / y) + x % y) % (y * z);
      {
        LemmaModPropertiesAuto();
        assert 0 <= x % y;
        LemmaMulNonnegative(y, x / y);
        assert y * (x / y) % (y * z) + x % y % (y * z) < y * z;
        LemmaModAdds(y * (x / y), x % y, y * z);
      }
      y * (x / y) % (y * z) + x % y % (y * z);
      {
        LemmaModPropertiesAuto();
        LemmaMulIncreases(z, y);
        LemmaMulIsCommutativeAuto();
        assert x % y < y <= y * z;
        LemmaSmallMod(x % y, y * z);
        assert x % y % (y * z) == x % y;
      }
      y * (x / y) % (y * z) + x % y;
      {
        LemmaTruncateMiddle(x / y, y, z);
      }
      y * (x / y % z) + x % y;
    }
  }

  lemma LemmaModBreakdownAuto()
    ensures forall x: int, y: int, z: int {:trigger x % (y * z)} :: 0 <= x && 0 < y && 0 < z ==> y * z > 0 && x % (y * z) == y * (x / y % z) + x % y
  {
    forall x: int, y: int, z: int | 0 <= x && 0 < y && 0 < z
      ensures y * z > 0 && x % (y * z) == y * (x / y % z) + x % y
    {
      LemmaModBreakdown(x, y, z);
    }
  }

  import opened DivInternals

  import DivINL = DivInternalsNonlinear

  import opened ModInternals

  import ModINL = ModInternalsNonlinear

  import opened MulInternals

  import opened Mul

  import opened GeneralInternals
}

@DisableNonlinearArithmetic
module Std.Arithmetic.DivInternals {
  function DivPos(x: int, d: int): int
    requires d > 0
    decreases if x < 0 then d - x else x
  {
    if x < 0 then
      -1 + DivPos(x + d, d)
    else if x < d then
      0
    else
      1 + DivPos(x - d, d)
  }

  function DivRecursive(x: int, d: int): int
    requires d != 0
  {
    if d > 0 then
      DivPos(x, d)
    else
      -1 * DivPos(x, -1 * d)
  }

  lemma LemmaDivBasics(n: int)
    requires n > 0
    ensures n / n == -(-n / n) == 1
    ensures forall x: int {:trigger x / n} :: 0 <= x < n <==> x / n == 0
    ensures forall x: int {:trigger (x + n) / n} :: (x + n) / n == x / n + 1
    ensures forall x: int {:trigger (x - n) / n} :: (x - n) / n == x / n - 1
  {
    LemmaModAuto(n);
    LemmaModBasics(n);
    LemmaSmallDiv();
    LemmaDivBySelf(n);
    forall x: int | x / n == 0
      ensures 0 <= x < n
    {
      LemmaFundamentalDivMod(x, n);
    }
  }

  ghost predicate DivAuto(n: int)
    requires n > 0
  {
    ModAuto(n) &&
    n / n == -(-n / n) == 1 &&
    (forall x: int {:trigger x / n} :: 
      0 <= x < n <==> x / n == 0) &&
    DivAutoMinus(n) &&
    DivAutoPlus(n)
  }

  ghost predicate DivAutoPlus(n: int)
    requires n > 0
  {
    forall x: int, y: int {:trigger (x + y) / n} :: 
      DivPlus(n, x, y)
  }

  ghost predicate DivPlus(n: int, x: int, y: int)
    requires n > 0
  {
    var z := x % n + y % n;
    (0 <= z < n && (x + y) / n == x / n + y / n) || (n <= z < n + n && (x + y) / n == x / n + y / n + 1)
  }

  ghost predicate DivAutoMinus(n: int)
    requires n > 0
  {
    forall x: int, y: int {:trigger (x - y) / n} :: 
      DivMinus(n, x, y)
  }

  ghost predicate DivMinus(n: int, x: int, y: int)
    requires n > 0
  {
    var z := x % n - y % n;
    (0 <= z < n && (x - y) / n == x / n - y / n) || (-n <= z < 0 && (x - y) / n == x / n - y / n - 1)
  }

  @IsolateAssertions lemma LemmaDivAutoAuxPlus(n: int)
    requires n > 0 && ModAuto(n)
    ensures DivAutoPlus(n)
  {
    LemmaModAuto(n);
    LemmaDivBasics(n);
    var f := (x: int, y: int) => DivPlus(n, x, y);
    forall i, j | true
      ensures j >= 0 && f(i, j) ==> f(i, j + n)
      ensures i < n && f(i, j) ==> f(i - n, j)
      ensures j < n && f(i, j) ==> f(i, j - n)
      ensures i >= 0 && f(i, j) ==> f(i + n, j)
      ensures 0 <= i < n && 0 <= j < n ==> f(i, j)
    {
      assert (i + n + j) / n == (i + j + n) / n;
      assert (i + (j + n)) / n == (i + j + n) / n;
      assert i - n + j == i + j - n;
      assert (i - n + j) / n == (i + j - n) / n;
      assert (i + (j - n)) / n == (i + j - n) / n;
    }
    forall x: int, y: int | true
      ensures DivPlus(n, x, y)
    {
      LemmaModInductionForall2(n, f);
      assert f(x, y);
    }
  }

  @IsolateAssertions lemma LemmaDivAutoAuxMinusHelper(n: int)
    requires n > 0 && ModAuto(n)
    ensures forall i, j :: (j >= 0 && DivMinus(n, i, j) ==> DivMinus(n, i, j + n)) && (i < n && DivMinus(n, i, j) ==> DivMinus(n, i - n, j)) && (j < n && DivMinus(n, i, j) ==> DivMinus(n, i, j - n)) && (i >= 0 && DivMinus(n, i, j) ==> DivMinus(n, i + n, j)) && (0 <= i < n && 0 <= j < n ==> DivMinus(n, i, j))
  {
    LemmaModAuto(n);
    LemmaDivBasics(n);
    forall i, j | true
      ensures j >= 0 && DivMinus(n, i, j) ==> DivMinus(n, i, j + n)
      ensures i < n && DivMinus(n, i, j) ==> DivMinus(n, i - n, j)
      ensures j < n && DivMinus(n, i, j) ==> DivMinus(n, i, j - n)
      ensures i >= 0 && DivMinus(n, i, j) ==> DivMinus(n, i + n, j)
      ensures 0 <= i < n && 0 <= j < n ==> DivMinus(n, i, j)
    {
      assert (i + n - j) / n == (i - j + n) / n;
      assert (i - (j - n)) / n == (i - j + n) / n;
      assert (i - n - j) / n == (i - j - n) / n;
      assert (i - (j + n)) / n == (i - j - n) / n;
    }
  }

  lemma LemmaDivAutoAuxMinus(n: int)
    requires n > 0 && ModAuto(n)
    ensures DivAutoMinus(n)
  {
    LemmaDivAutoAuxMinusHelper(n);
    var f := (x: int, y: int) => DivMinus(n, x, y);
    LemmaModInductionForall2(n, f);
    forall x: int, y: int | true
      ensures DivMinus(n, x, y)
    {
      assert f(x, y);
    }
  }

  lemma LemmaDivAutoAux(n: int)
    requires n > 0 && ModAuto(n)
    ensures DivAuto(n)
  {
    LemmaDivBasics(n);
    assert (0 + n) / n == 1;
    assert (0 - n) / n == -1;
    LemmaDivAutoAuxPlus(n);
    LemmaDivAutoAuxMinus(n);
  }

  lemma LemmaDivAuto(n: int)
    requires n > 0
    ensures DivAuto(n)
  {
    LemmaModAuto(n);
    LemmaDivAutoAux(n);
  }

  lemma LemmaDivInductionAuto(n: int, x: int, f: int -> bool)
    requires n > 0
    requires DivAuto(n) ==> (forall i {:trigger IsLe(0, i)} :: IsLe(0, i) && i < n ==> f(i)) && (forall i {:trigger IsLe(0, i)} :: IsLe(0, i) && f(i) ==> f(i + n)) && forall i {:trigger IsLe(i + 1, n)} :: IsLe(i + 1, n) && f(i) ==> f(i - n)
    ensures DivAuto(n)
    ensures f(x)
  {
    LemmaDivAuto(n);
    assert forall i :: IsLe(0, i) && i < n ==> f(i);
    assert forall i {:trigger f(i), f(i + n)} :: IsLe(0, i) && f(i) ==> f(i + n);
    assert forall i {:trigger f(i), f(i - n)} :: IsLe(i + 1, n) && f(i) ==> f(i - n);
    LemmaModInductionForall(n, f);
    assert f(x);
  }

  lemma LemmaDivInductionAutoForall(n: int, f: int -> bool)
    requires n > 0
    requires DivAuto(n) ==> (forall i {:trigger IsLe(0, i)} :: IsLe(0, i) && i < n ==> f(i)) && (forall i {:trigger IsLe(0, i)} :: IsLe(0, i) && f(i) ==> f(i + n)) && forall i {:trigger IsLe(i + 1, n)} :: IsLe(i + 1, n) && f(i) ==> f(i - n)
    ensures DivAuto(n)
    ensures forall i {:trigger f(i)} :: f(i)
  {
    LemmaDivAuto(n);
    assert forall i :: IsLe(0, i) && i < n ==> f(i);
    assert forall i {:trigger f(i), f(i + n)} :: IsLe(0, i) && f(i) ==> f(i + n);
    assert forall i {:trigger f(i), f(i - n)} :: IsLe(i + 1, n) && f(i) ==> f(i - n);
    LemmaModInductionForall(n, f);
  }

  import opened GeneralInternals

  import opened ModInternals

  import opened ModInternalsNonlinear

  import opened DivInternalsNonlinear

  import opened MulInternals
}

module {:z3ArithmeticSolver 6} Std.Arithmetic.DivInternalsNonlinear {
  lemma LemmaDivOf0(d: int)
    requires d != 0
    ensures 0 / d == 0
  {
  }

  lemma LemmaDivBySelf(d: int)
    requires d != 0
    ensures d / d == 1
  {
  }

  lemma LemmaSmallDiv()
    ensures forall x, d {:trigger x / d} :: 0 <= x < d && d > 0 ==> x / d == 0
  {
  }

  lemma LemmaRealDivGt(x: real, y: real)
    requires x > y
    requires y > 0.0
    ensures x / y > 1 as real
  {
  }
}

@DisableNonlinearArithmetic
module Std.Arithmetic.GeneralInternals {
  ghost predicate IsLe(x: int, y: int)
  {
    x <= y
  }

  lemma LemmaInductionHelper(n: int, f: int -> bool, x: int)
    requires n > 0
    requires forall i :: 0 <= i < n ==> f(i)
    requires forall i {:trigger f(i), f(i + n)} :: i >= 0 && f(i) ==> f(i + n)
    requires forall i {:trigger f(i), f(i - n)} :: i < n && f(i) ==> f(i - n)
    ensures f(x)
    decreases if x >= n then x else -x
  {
    if x >= n {
      LemmaInductionHelper(n, f, x - n);
      assert f(x - n + n);
    } else if x < 0 {
      LemmaInductionHelper(n, f, x + n);
      assert f(x + n - n);
    }
  }
}

@DisableNonlinearArithmetic
module Std.Arithmetic.ModInternals {
  function ModRecursive(x: int, d: int): int
    requires d > 0
    decreases if x < 0 then d - x else x
  {
    if x < 0 then
      ModRecursive(d + x, d)
    else if x < d then
      x
    else
      ModRecursive(x - d, d)
  }

  lemma LemmaModInductionForall(n: int, f: int -> bool)
    requires n > 0
    requires forall i :: 0 <= i < n ==> f(i)
    requires forall i {:trigger f(i), f(i + n)} :: i >= 0 && f(i) ==> f(i + n)
    requires forall i {:trigger f(i), f(i - n)} :: i < n && f(i) ==> f(i - n)
    ensures forall i :: f(i)
  {
    forall i | true
      ensures f(i)
    {
      LemmaInductionHelper(n, f, i);
    }
  }

  lemma LemmaModInductionForall2(n: int, f: (int, int) -> bool)
    requires n > 0
    requires forall i, j :: 0 <= i < n && 0 <= j < n ==> f(i, j)
    requires forall i, j {:trigger f(i, j), f(i + n, j)} :: i >= 0 && f(i, j) ==> f(i + n, j)
    requires forall i, j {:trigger f(i, j), f(i, j + n)} :: j >= 0 && f(i, j) ==> f(i, j + n)
    requires forall i, j {:trigger f(i, j), f(i - n, j)} :: i < n && f(i, j) ==> f(i - n, j)
    requires forall i, j {:trigger f(i, j), f(i, j - n)} :: j < n && f(i, j) ==> f(i, j - n)
    ensures forall i, j :: f(i, j)
  {
    forall x, y | true
      ensures f(x, y)
    {
      forall i | 0 <= i < n
        ensures f(i, y)
      {
        var fj := j => f(i, j);
        LemmaModInductionForall(n, fj);
        assert fj(y);
      }
      var fi := i => f(i, y);
      LemmaModInductionForall(n, fi);
      assert fi(x);
    }
  }

  @IsolateAssertions lemma HelperAddDenom(n: int, x: int)
    requires n > 0
    ensures var zp := (x + n) / n - x / n - 1; 0 == n * zp + (x + n) % n - x % n
  {
    var zp := (x + n) / n - x / n - 1;
    assert 0 == n * zp + (x + n) % n - x % n by {
      assert x == n * (x / n) + x % n by {
        LemmaFundamentalDivMod(x, n);
      }
      assert x + n == n * ((x + n) / n) + (x + n) % n by {
        LemmaFundamentalDivMod(x + n, n);
      }
      calc {
        n;
        n * ((x + n) / n) - n * (x / n) + (x + n) % n - x % n;
        {
          LemmaMulDistributesSpecific((x + n) / n, x / n, n);
          assert n * ((x + n) / n) - n * (x / n) == ((x + n) / n - x / n) * n;
        }
        n * ((x + n) / n - x / n) + (x + n) % n - x % n;
        n * (zp + 1) + (x + n) % n - x % n;
      }
      calc {
        0;
        n * (zp + 1) + (x + n) % n - x % n - n;
        {
          LemmaMulDistributesSpecific(zp, 1, n);
          assert (zp + 1) * n == n * zp + 1 * n;
        }
        n * zp + n + (x + n) % n - x % n - n;
        n * zp + (x + n) % n - x % n;
      }
    }
  }

  @IsolateAssertions lemma HelperSubDenom(n: int, x: int)
    requires n > 0
    ensures var zm := (x - n) / n - x / n + 1; 0 == n * zm + (x - n) % n - x % n
  {
    var zm := (x - n) / n - x / n + 1;
    assert 0 == n * zm + (x - n) % n - x % n by {
      assert x == n * (x / n) + x % n by {
        LemmaFundamentalDivMod(x, n);
      }
      assert x - n == n * ((x - n) / n) + (x - n) % n by {
        LemmaFundamentalDivMod(x - n, n);
      }
      calc {
        n;
        n * (x / n) - n * ((x - n) / n) + x % n - (x - n) % n;
        {
          LemmaMulDistributesSpecific(x / n, (x - n) / n, n);
          assert n * (x / n) - n * ((x - n) / n) == n * (x / n - (x - n) / n);
        }
        n * (x / n - (x - n) / n) + x % n - (x - n) % n;
        n * (1 - zm) + x % n - (x - n) % n;
      }
      calc {
        0;
        n * (1 - zm) + x % n - (x - n) % n - n;
        {
          LemmaMulDistributesSpecific(1, zm, n);
          assert (1 - zm) * n == 1 * n - zm * n;
        }
        n - n * zm + x % n - (x - n) % n - n;
        x % n - (x - n) % n - n * zm;
      }
    }
  }

  @IsolateAssertions lemma LemmaDivAddDenominator(n: int, x: int)
    requires n > 0
    ensures (x + n) / n == x / n + 1
  {
    var zp := (x + n) / n - x / n - 1;
    assert 0 == n * zp + (x + n) % n - x % n by {
      HelperAddDenom(n, x);
    }
    assert zp == 0 by {
      if zp > 0 {
        LemmaMulInequality(1, zp, n);
        assert zp == 0;
      } else if zp < 0 {
        LemmaMulInequality(zp, -1, n);
        assert zp == 0;
      }
    }
  }

  @IsolateAssertions lemma LemmaDivSubDenominator(n: int, x: int)
    requires n > 0
    ensures (x - n) / n == x / n - 1
  {
    LemmaFundamentalDivMod(x, n);
    LemmaFundamentalDivMod(x - n, n);
    var zm := (x - n) / n - x / n + 1;
    assert 0 == n * zm + (x - n) % n - x % n by {
      HelperSubDenom(n, x);
    }
    assert zm == 0 by {
      if zm > 0 {
        LemmaMulInequality(1, zm, n);
        assert zm == 0;
      } else if zm < 0 {
        LemmaMulInequality(zm, -1, n);
        assert zm == 0;
      }
    }
  }

  @IsolateAssertions lemma LemmaModAddDenominator(n: int, x: int)
    requires n > 0
    ensures (x + n) % n == x % n
  {
    var zp := (x + n) / n - x / n - 1;
    assert 0 == n * zp + (x + n) % n - x % n by {
      HelperAddDenom(n, x);
    }
    if zp > 0 {
      assert (x + n) % n == x % n by {
        LemmaMulInequality(1, zp, n);
      }
    }
    if zp < 0 {
      assert (x + n) % n == x % n by {
        LemmaMulInequality(zp, -1, n);
      }
    }
  }

  @IsolateAssertions lemma LemmaModSubDenominator(n: int, x: int)
    requires n > 0
    ensures (x - n) % n == x % n
  {
    LemmaFundamentalDivMod(x, n);
    LemmaFundamentalDivMod(x - n, n);
    var zm := (x - n) / n - x / n + 1;
    assert 0 == n * zm + (x - n) % n - x % n by {
      HelperSubDenom(n, x);
    }
    if zm > 0 {
      assert (x - n) % n == x % n by {
        LemmaMulInequality(1, zm, n);
      }
    }
    if zm < 0 {
      assert (x - n) % n == x % n by {
        LemmaMulInequality(zm, -1, n);
      }
    }
  }

  lemma LemmaModBelowDenominator(n: int, x: int)
    requires n > 0
    ensures 0 <= x < n <==> x % n == x
  {
    forall x: int | true
      ensures 0 <= x < n <==> x % n == x
    {
      if 0 <= x < n {
        LemmaSmallMod(x, n);
      }
      LemmaModRange(x, n);
    }
  }

  lemma LemmaModBasics(n: int)
    requires n > 0
    ensures forall x: int {:trigger (x + n) % n} :: (x + n) % n == x % n
    ensures forall x: int {:trigger (x - n) % n} :: (x - n) % n == x % n
    ensures forall x: int {:trigger (x + n) / n} :: (x + n) / n == x / n + 1
    ensures forall x: int {:trigger (x - n) / n} :: (x - n) / n == x / n - 1
    ensures forall x: int {:trigger x % n} :: 0 <= x < n <==> x % n == x
  {
    forall x: int | true
      ensures (x + n) % n == x % n
      ensures (x - n) % n == x % n
      ensures (x + n) / n == x / n + 1
      ensures (x - n) / n == x / n - 1
      ensures 0 <= x < n <==> x % n == x
    {
      LemmaModBelowDenominator(n, x);
      LemmaModAddDenominator(n, x);
      LemmaModSubDenominator(n, x);
      LemmaDivAddDenominator(n, x);
      LemmaDivSubDenominator(n, x);
    }
  }

  @IsolateAssertions lemma LemmaQuotientAndRemainder(x: int, q: int, r: int, n: int)
    requires n > 0
    requires 0 <= r < n
    requires x == q * n + r
    ensures q == x / n
    ensures r == x % n
    decreases if q > 0 then q else -q
  {
    LemmaModBasics(n);
    if q > 0 {
      MulInternalsNonlinear.LemmaMulIsDistributiveAdd(n, q - 1, 1);
      LemmaMulIsCommutativeAuto();
      assert q * n + r == (q - 1) * n + n + r;
      LemmaQuotientAndRemainder(x - n, q - 1, r, n);
    } else if q < 0 {
      Mul.LemmaMulIsDistributiveSub(n, q + 1, 1);
      LemmaMulIsCommutativeAuto();
      assert q * n + r == (q + 1) * n - n + r;
      LemmaQuotientAndRemainder(x + n, q + 1, r, n);
    } else {
      LemmaSmallDiv();
      assert r / n == 0;
    }
  }

  ghost predicate ModAuto(n: int)
    requires n > 0
  {
    n % n == -n % n == 0 &&
    (forall x: int {:trigger x % n % n} :: 
      x % n % n == x % n) &&
    (forall x: int {:trigger x % n} :: 
      0 <= x < n <==> x % n == x) &&
    ModAutoPlus(n) &&
    ModAutoMinus(n)
  }

  ghost predicate ModAutoPlus(n: int)
    requires n > 0
  {
    forall x: int, y: int {:trigger (x + y) % n} :: 
      var z := x % n + y % n; (0 <= z < n && (x + y) % n == z) || (n <= z < n + n && (x + y) % n == z - n)
  }

  ghost predicate ModAutoMinus(n: int)
    requires n > 0
  {
    forall x: int, y: int {:trigger (x - y) % n} :: 
      var z := x % n - y % n; (0 <= z < n && (x - y) % n == z) || (-n <= z < 0 && (x - y) % n == z + n)
  }

  lemma LemmaModAuto(n: int)
    requires n > 0
    ensures ModAuto(n)
  {
    LemmaModBasics(n);
    LemmaModAutoPlus(n);
    LemmaModAutoMinus(n);
  }

  @ResourceLimit("2e6") lemma LemmaModAutoMinus(n: int)
    requires n > 0
    ensures ModAutoMinus(n)
  {
    LemmaModBasics(n);
    LemmaMulIsCommutativeAuto();
    LemmaMulIsDistributiveSubAuto();
    forall x: int, y: int {:trigger (x - y) % n} | true
      ensures var z := x % n - y % n; (0 <= z < n && (x - y) % n == z) || (-n <= z < 0 && (x - y) % n == z + n)
    {
      var xq, xr := x / n, x % n;
      LemmaFundamentalDivMod(x, n);
      assert x == xq * n + xr;
      var yq, yr := y / n, y % n;
      LemmaFundamentalDivMod(y, n);
      assert y == yq * n + yr;
      if xr - yr >= 0 {
        LemmaQuotientAndRemainder(x - y, xq - yq, xr - yr, n);
      } else {
        LemmaQuotientAndRemainder(x - y, xq - yq - 1, xr - yr + n, n);
      }
    }
  }

  lemma LemmaModAutoPlus(n: int)
    requires n > 0
    ensures ModAutoPlus(n)
  {
    LemmaMulIsCommutativeAuto();
    LemmaMulIsDistributiveAddAuto();
    forall x: int, y: int {:trigger (x + y) % n} | true
      ensures var z := x % n + y % n; (0 <= z < n && (x + y) % n == z) || (n <= z < 2 * n && (x + y) % n == z - n)
    {
      var xq, xr := x / n, x % n;
      LemmaFundamentalDivMod(x, n);
      assert x == xq * n + xr;
      var yq, yr := y / n, y % n;
      LemmaFundamentalDivMod(y, n);
      assert y == yq * n + yr;
      if xr + yr < n {
        LemmaQuotientAndRemainder(x + y, xq + yq, xr + yr, n);
      } else {
        LemmaQuotientAndRemainder(x + y, xq + yq + 1, xr + yr - n, n);
      }
    }
  }

  lemma LemmaModInductionAuto(n: int, x: int, f: int -> bool)
    requires n > 0
    requires ModAuto(n) ==> (forall i {:trigger IsLe(0, i)} :: IsLe(0, i) && i < n ==> f(i)) && (forall i {:trigger IsLe(0, i)} :: IsLe(0, i) && f(i) ==> f(i + n)) && forall i {:trigger IsLe(i + 1, n)} :: IsLe(i + 1, n) && f(i) ==> f(i - n)
    ensures ModAuto(n)
    ensures f(x)
  {
    LemmaModAuto(n);
    assert forall i :: IsLe(0, i) && i < n ==> f(i);
    assert forall i {:trigger f(i), f(i + n)} :: IsLe(0, i) && f(i) ==> f(i + n);
    assert forall i {:trigger f(i), f(i - n)} :: IsLe(i + 1, n) && f(i) ==> f(i - n);
    LemmaModInductionForall(n, f);
    assert f(x);
  }

  lemma LemmaModInductionAutoForall(n: int, f: int -> bool)
    requires n > 0
    requires ModAuto(n) ==> (forall i {:trigger IsLe(0, i)} :: IsLe(0, i) && i < n ==> f(i)) && (forall i {:trigger IsLe(0, i)} :: IsLe(0, i) && f(i) ==> f(i + n)) && forall i {:trigger IsLe(i + 1, n)} :: IsLe(i + 1, n) && f(i) ==> f(i - n)
    ensures ModAuto(n)
    ensures forall i {:trigger f(i)} :: f(i)
  {
    LemmaModAuto(n);
    assert forall i :: IsLe(0, i) && i < n ==> f(i);
    assert forall i {:trigger f(i), f(i + n)} :: IsLe(0, i) && f(i) ==> f(i + n);
    assert forall i {:trigger f(i), f(i - n)} :: IsLe(i + 1, n) && f(i) ==> f(i - n);
    LemmaModInductionForall(n, f);
  }

  import opened GeneralInternals

  import opened Mul

  import opened MulInternalsNonlinear

  import opened MulInternals

  import opened ModInternalsNonlinear

  import opened DivInternalsNonlinear
}

module {:z3ArithmeticSolver 6} Std.Arithmetic.ModInternalsNonlinear {
  lemma LemmaModOfZeroIsZero(m: int)
    requires 0 < m
    ensures 0 % m == 0
  {
  }

  lemma LemmaFundamentalDivMod(x: int, d: int)
    requires d != 0
    ensures x == d * (x / d) + x % d
  {
  }

  lemma Lemma0ModAnything()
    ensures forall m: int {:trigger 0 % m} :: m > 0 ==> 0 % m == 0
  {
  }

  lemma LemmaSmallMod(x: nat, m: nat)
    requires x < m
    requires 0 < m
    ensures x % m == x
  {
  }

  lemma LemmaModRange(x: int, m: int)
    requires m > 0
    ensures 0 <= x % m < m
  {
  }
}

@DisableNonlinearArithmetic
module Std.Arithmetic.MulInternals {
  function MulPos(x: int, y: int): int
    requires x >= 0
  {
    if x == 0 then
      0
    else
      y + MulPos(x - 1, y)
  }

  function MulRecursive(x: int, y: int): int
  {
    if x >= 0 then
      MulPos(x, y)
    else
      -1 * MulPos(-1 * x, y)
  }

  lemma LemmaMulInduction(f: int -> bool)
    requires f(0)
    requires forall i {:trigger f(i), f(i + 1)} :: i >= 0 && f(i) ==> f(i + 1)
    requires forall i {:trigger f(i), f(i - 1)} :: i <= 0 && f(i) ==> f(i - 1)
    ensures forall i {:trigger f(i)} :: f(i)
  {
    forall i | true
      ensures f(i)
    {
      LemmaInductionHelper(1, f, i);
    }
  }

  lemma LemmaMulCommutes()
    ensures forall x: int, y: int {:trigger x * y} :: x * y == y * x
  {
    forall x: int, y: int | true
      ensures x * y == y * x
    {
      LemmaMulInduction(i => x * i == i * x);
    }
  }

  lemma LemmaMulSuccessor()
    ensures forall x: int, y: int {:trigger (x + 1) * y} :: (x + 1) * y == x * y + y
    ensures forall x: int, y: int {:trigger (x - 1) * y} :: (x - 1) * y == x * y - y
  {
    LemmaMulCommutes();
    forall x: int, y: int | true
      ensures (x + 1) * y == x * y + y
      ensures (x - 1) * y == x * y - y
    {
      LemmaMulIsDistributiveAdd(y, x, 1);
      LemmaMulIsDistributiveAdd(y, x, -1);
    }
  }

  lemma LemmaMulDistributes()
    ensures forall x: int, y: int, z: int {:trigger (x + y) * z} :: (x + y) * z == x * z + y * z
    ensures forall x: int, y: int, z: int {:trigger (x - y) * z} :: (x - y) * z == x * z - y * z
  {
    LemmaMulSuccessor();
    forall x: int, y: int, z: int | true
      ensures (x + y) * z == x * z + y * z
      ensures (x - y) * z == x * z - y * z
    {
      var f1 := i => (x + i) * z == x * z + i * z;
      var f2 := i => (x - i) * z == x * z - i * z;
      assert forall i {:trigger (x + (i + 1)) * z} :: (x + (i + 1)) * z == (x + i + 1) * z == (x + i) * z + z;
      assert forall i {:trigger (x + (i - 1)) * z} :: (x + (i - 1)) * z == (x + i - 1) * z == (x + i) * z - z;
      assert forall i {:trigger (x - (i + 1)) * z} :: (x - (i + 1)) * z == (x - i - 1) * z == (x - i) * z - z;
      assert forall i {:trigger (x - (i - 1)) * z} :: (x - (i - 1)) * z == (x - i + 1) * z == (x - i) * z + z;
      LemmaMulInduction(f1);
      LemmaMulInduction(f2);
      assert f1(y);
      assert f2(y);
    }
  }

  lemma LemmaMulDistributesSpecific(x: int, y: int, z: int)
    ensures (x + y) * z == x * z + y * z
    ensures (x - y) * z == x * z - y * z
  {
    LemmaMulDistributes();
  }

  ghost predicate MulAuto()
  {
    (forall x: int, y: int {:trigger x * y} :: 
      x * y == y * x) &&
    (forall x: int, y: int, z: int {:trigger (x + y) * z} :: 
      (x + y) * z == x * z + y * z) &&
    forall x: int, y: int, z: int {:trigger (x - y) * z} :: 
      (x - y) * z == x * z - y * z
  }

  lemma LemmaMulAuto()
    ensures MulAuto()
  {
    LemmaMulCommutes();
    LemmaMulDistributes();
  }

  lemma LemmaMulInductionAuto(x: int, f: int -> bool)
    requires MulAuto() ==> f(0) && (forall i {:trigger IsLe(0, i)} :: IsLe(0, i) && f(i) ==> f(i + 1)) && forall i {:trigger IsLe(i, 0)} :: IsLe(i, 0) && f(i) ==> f(i - 1)
    ensures MulAuto()
    ensures f(x)
  {
    LemmaMulCommutes();
    LemmaMulDistributes();
    assert forall i {:trigger f(i)} :: IsLe(0, i) && f(i) ==> f(i + 1);
    assert forall i {:trigger f(i)} :: IsLe(i, 0) && f(i) ==> f(i - 1);
    LemmaMulInduction(f);
    assert f(x);
  }

  lemma LemmaMulInductionAutoForall(f: int -> bool)
    requires MulAuto() ==> f(0) && (forall i {:trigger IsLe(0, i)} :: IsLe(0, i) && f(i) ==> f(i + 1)) && forall i {:trigger IsLe(i, 0)} :: IsLe(i, 0) && f(i) ==> f(i - 1)
    ensures MulAuto()
    ensures forall i {:trigger f(i)} :: f(i)
  {
    LemmaMulCommutes();
    LemmaMulDistributes();
    assert forall i {:trigger f(i)} :: IsLe(0, i) && f(i) ==> f(i + 1);
    assert forall i {:trigger f(i)} :: IsLe(i, 0) && f(i) ==> f(i - 1);
    LemmaMulInduction(f);
  }

  import opened GeneralInternals

  import opened MulInternalsNonlinear
}

module {:z3ArithmeticSolver 6} Std.Arithmetic.MulInternalsNonlinear {
  lemma LemmaMulStrictlyPositive(x: int, y: int)
    ensures 0 < x && 0 < y ==> 0 < x * y
  {
  }

  lemma LemmaMulNonzero(x: int, y: int)
    ensures x * y != 0 <==> x != 0 && y != 0
  {
  }

  lemma LemmaMulIsAssociative(x: int, y: int, z: int)
    ensures x * (y * z) == x * y * z
  {
  }

  lemma LemmaMulIsDistributiveAdd(x: int, y: int, z: int)
    ensures x * (y + z) == x * y + x * z
  {
  }

  lemma LemmaMulOrdering(x: int, y: int)
    requires x != 0
    requires y != 0
    requires 0 <= x * y
    ensures x * y >= x && x * y >= y
  {
  }

  lemma LemmaMulStrictInequality(x: int, y: int, z: int)
    requires x < y
    requires z > 0
    ensures x * z < y * z
  {
  }
}

@DisableNonlinearArithmetic
abstract module Std.Arithmetic.LittleEndianNat {
  function BASE(): nat
    ensures BASE() > 1

  function ToNatRight(xs: seq<digit>): nat
  {
    if |xs| == 0 then
      0
    else
      LemmaMulNonnegativeAuto(); ToNatRight(DropFirst(xs)) * BASE() + First(xs)
  }

  function ToNatLeft(xs: seq<digit>): nat
  {
    if |xs| == 0 then
      0
    else
      LemmaPowPositiveAuto(); LemmaMulNonnegativeAuto(); ToNatLeft(DropLast(xs)) + Last(xs) * Pow(BASE(), |xs| - 1)
  }

  @IsolateAssertions lemma LemmaToNatLeftEqToNatRight(xs: seq<digit>)
    ensures ToNatRight(xs) == ToNatLeft(xs)
  {
    if xs == [] {
    } else {
      if DropLast(xs) == [] {
        calc {
          ToNatLeft(xs);
          Last(xs) * Pow(BASE(), |xs| - 1);
          {
          }
          Last(xs);
          First(xs);
          {
            assert ToNatRight(DropFirst(xs)) == 0;
          }
          ToNatRight(xs);
        }
      } else {
        calc {
          ToNatLeft(xs);
          ToNatLeft(DropLast(xs)) + Last(xs) * Pow(BASE(), |xs| - 1);
          {
            LemmaToNatLeftEqToNatRight(DropLast(xs));
          }
          ToNatRight(DropLast(xs)) + Last(xs) * Pow(BASE(), |xs| - 1);
          ToNatRight(DropFirst(DropLast(xs))) * BASE() + First(xs) + Last(xs) * Pow(BASE(), |xs| - 1);
          {
            LemmaToNatLeftEqToNatRight(DropFirst(DropLast(xs)));
          }
          ToNatLeft(DropFirst(DropLast(xs))) * BASE() + First(xs) + Last(xs) * Pow(BASE(), |xs| - 1);
          {
            assert DropFirst(DropLast(xs)) == DropLast(DropFirst(xs));
            LemmaMulProperties();
          }
          ToNatLeft(DropLast(DropFirst(xs))) * BASE() + First(xs) + Last(xs) * Pow(BASE(), |xs| - 2) * BASE();
          {
            LemmaMulIsDistributiveAddOtherWayAuto();
          }
          ToNatLeft(DropFirst(xs)) * BASE() + First(xs);
          {
            LemmaToNatLeftEqToNatRight(DropFirst(xs));
          }
          ToNatRight(xs);
        }
      }
    }
  }

  lemma LemmaToNatLeftEqToNatRightAuto()
    ensures forall xs: seq<digit> :: ToNatRight(xs) == ToNatLeft(xs)
  {
    forall xs: seq<digit> | true
      ensures ToNatRight(xs) == ToNatLeft(xs)
    {
      LemmaToNatLeftEqToNatRight(xs);
    }
  }

  lemma LemmaSeqLen1(xs: seq<digit>)
    requires |xs| == 1
    ensures ToNatRight(xs) == First(xs)
  {
    assert ToNatRight(DropFirst(xs)) == 0;
  }

  lemma LemmaSeqLen2(xs: seq<digit>)
    requires |xs| == 2
    ensures ToNatRight(xs) == First(xs) + xs[1] * BASE()
  {
    var xs1 := DropFirst(xs);
    calc {
      ToNatRight(xs);
      ToNatRight(xs1) * BASE() + First(xs);
      (ToNatRight([]) * BASE() + First(xs1)) * BASE() + First(xs);
      (0 * BASE() + First(xs1)) * BASE() + First(xs);
    }
  }

  lemma LemmaSeqAppendZero(xs: seq<digit>)
    ensures ToNatRight(xs + [0]) == ToNatRight(xs)
  {
    LemmaToNatLeftEqToNatRightAuto();
    calc {
      ToNatRight(xs + [0]);
      ToNatLeft(xs + [0]);
      ToNatLeft(xs) + 0 * Pow(BASE(), |xs|);
      {
        LemmaMulBasicsAuto();
      }
      ToNatLeft(xs);
      ToNatRight(xs);
    }
  }

  lemma LemmaSeqNatBound(xs: seq<digit>)
    ensures ToNatRight(xs) < Pow(BASE(), |xs|)
  {
    if |xs| == 0 {
    } else {
      var len' := |xs| - 1;
      var pow := Pow(BASE(), len');
      calc {
        ToNatRight(xs);
        {
          LemmaToNatLeftEqToNatRight(xs);
        }
        ToNatLeft(xs);
        {
        }
        ToNatLeft(DropLast(xs)) + Last(xs) * pow;
      <
        {
          LemmaToNatLeftEqToNatRight(DropLast(xs));
          LemmaSeqNatBound(DropLast(xs));
        }
        pow + Last(xs) * pow;
      <=
        {
          LemmaPowPositiveAuto();
          LemmaMulInequalityAuto();
        }
        pow + (BASE() - 1) * pow;
        {
          LemmaMulIsDistributiveAuto();
        }
        Pow(BASE(), len' + 1);
      }
    }
  }

  @IsolateAssertions lemma LemmaSeqPrefix(xs: seq<digit>, i: nat)
    requires 0 <= i <= |xs|
    ensures ToNatRight(xs[..i]) + ToNatRight(xs[i..]) * Pow(BASE(), i) == ToNatRight(xs)
  {
    if i == 1 {
      assert ToNatRight(xs[..1]) == First(xs);
    } else if i > 1 {
      calc {
        ToNatRight(xs[..i]) + ToNatRight(xs[i..]) * Pow(BASE(), i);
        ToNatRight(DropFirst(xs[..i])) * BASE() + First(xs) + ToNatRight(xs[i..]) * Pow(BASE(), i);
        {
          assert DropFirst(xs[..i]) == DropFirst(xs)[..i - 1];
          LemmaMulProperties();
        }
        ToNatRight(DropFirst(xs)[..i - 1]) * BASE() + First(xs) + ToNatRight(xs[i..]) * Pow(BASE(), i - 1) * BASE();
        {
          LemmaMulIsDistributiveAddOtherWayAuto();
        }
        (ToNatRight(DropFirst(xs)[..i - 1]) + ToNatRight(DropFirst(xs)[i - 1..]) * Pow(BASE(), i - 1)) * BASE() + First(xs);
        {
          LemmaSeqPrefix(DropFirst(xs), i - 1);
        }
        ToNatRight(xs);
      }
    }
  }

  lemma LemmaSeqMswInequality(xs: seq<digit>, ys: seq<digit>)
    requires |xs| == |ys| > 0
    requires Last(xs) < Last(ys)
    ensures ToNatRight(xs) < ToNatRight(ys)
  {
    LemmaToNatLeftEqToNatRightAuto();
    var len' := |xs| - 1;
    calc {
      ToNatRight(xs);
      ToNatLeft(xs);
    <
      {
        LemmaSeqNatBound(DropLast(xs));
      }
      Pow(BASE(), len') + Last(xs) * Pow(BASE(), len');
    ==
      {
        LemmaMulIsDistributiveAuto();
      }
      (1 + Last(xs)) * Pow(BASE(), len');
    <=
      {
        LemmaPowPositiveAuto();
        LemmaMulInequalityAuto();
      }
      ToNatLeft(ys);
      ToNatRight(ys);
    }
  }

  @IsolateAssertions lemma LemmaSeqPrefixNeq(xs: seq<digit>, ys: seq<digit>, i: nat)
    requires 0 <= i <= |xs| == |ys|
    requires ToNatRight(xs[..i]) != ToNatRight(ys[..i])
    ensures ToNatRight(xs) != ToNatRight(ys)
    decreases |xs| - i
  {
    if i == |xs| {
      assert xs[..i] == xs;
      assert ys[..i] == ys;
    } else {
      if xs[i] == ys[i] {
        assert DropLast(xs[..i + 1]) == xs[..i];
        assert DropLast(ys[..i + 1]) == ys[..i];
        LemmaToNatLeftEqToNatRightAuto();
        assert ToNatRight(xs[..i + 1]) == ToNatLeft(xs[..i + 1]);
      } else if xs[i] < ys[i] {
        LemmaSeqMswInequality(xs[..i + 1], ys[..i + 1]);
      } else {
        LemmaSeqMswInequality(ys[..i + 1], xs[..i + 1]);
      }
      LemmaSeqPrefixNeq(xs, ys, i + 1);
    }
  }

  lemma LemmaSeqNeq(xs: seq<digit>, ys: seq<digit>)
    requires |xs| == |ys|
    requires xs != ys
    ensures ToNatRight(xs) != ToNatRight(ys)
  {
    ghost var i: nat, n: nat := 0, |xs|;
    while i < n
      invariant 0 <= i < n
      invariant xs[..i] == ys[..i]
    {
      if xs[i] != ys[i] {
        break;
      }
      i := i + 1;
    }
    assert ToNatLeft(xs[..i]) == ToNatLeft(ys[..i]);
    assert xs[..i + 1][..i] == xs[..i];
    assert ys[..i + 1][..i] == ys[..i];
    LemmaPowPositiveAuto();
    LemmaMulStrictInequalityAuto();
    assert ToNatLeft(xs[..i + 1]) != ToNatLeft(ys[..i + 1]);
    LemmaToNatLeftEqToNatRightAuto();
    LemmaSeqPrefixNeq(xs, ys, i + 1);
  }

  lemma LemmaSeqEq(xs: seq<digit>, ys: seq<digit>)
    requires |xs| == |ys|
    requires ToNatRight(xs) == ToNatRight(ys)
    ensures xs == ys
  {
    calc ==> {
      xs != ys;
      {
        LemmaSeqNeq(xs, ys);
      }
      ToNatRight(xs) != ToNatRight(ys);
      false;
    }
  }

  @IsolateAssertions lemma LemmaSeqLswModEquivalence(xs: seq<digit>)
    requires |xs| >= 1
    ensures IsModEquivalent(ToNatRight(xs), First(xs), BASE())
  {
    if |xs| == 1 {
      LemmaSeqLen1(xs);
      LemmaModEquivalenceAuto();
    } else {
      assert IsModEquivalent(ToNatRight(xs), First(xs), BASE()) by {
        calc ==> {
          true;
          {
            LemmaModEquivalence(ToNatRight(xs), ToNatRight(DropFirst(xs)) * BASE() + First(xs), BASE());
          }
          IsModEquivalent(ToNatRight(xs), ToNatRight(DropFirst(xs)) * BASE() + First(xs), BASE());
          {
            LemmaModMultiplesBasicAuto();
          }
          IsModEquivalent(ToNatRight(xs), First(xs), BASE());
        }
      }
    }
  }

  function FromNat(n: nat): (xs: seq<digit>)
  {
    if n == 0 then
      []
    else
      LemmaDivBasicsAuto(); LemmaDivDecreasesAuto(); [n % BASE()] + FromNat(n / BASE())
  }

  lemma LemmaFromNatLen2(n: nat)
    ensures n == 0 ==> |FromNat(n)| == 0
    ensures n > 0 ==> |FromNat(n)| == Log(BASE(), n) + 1
  {
    var digits := FromNat(n);
    if n == 0 {
    } else {
      assert |digits| == Log(BASE(), n) + 1 by {
        LemmaDivBasicsAuto();
        var digits' := FromNat(n / BASE());
        assert |digits| == |digits'| + 1;
        if n < BASE() {
          LemmaLog0(BASE(), n);
          assert n / BASE() == 0 by {
            LemmaBasicDiv(BASE());
          }
        } else {
          LemmaLogS(BASE(), n);
          assert n / BASE() > 0 by {
            LemmaDivNonZeroAuto();
          }
        }
      }
    }
  }

  lemma LemmaFromNatLen(n: nat, len: nat)
    requires Pow(BASE(), len) > n
    ensures |FromNat(n)| <= len
  {
    if n == 0 {
    } else {
      calc {
        |FromNat(n)|;
      ==
        {
          LemmaDivBasicsAuto();
        }
        1 + |FromNat(n / BASE())|;
      <=
        {
          LemmaMultiplyDivideLtAuto();
          LemmaDivDecreasesAuto();
          LemmaFromNatLen(n / BASE(), len - 1);
        }
        len;
      }
    }
  }

  lemma LemmaNatSeqNat(n: nat)
    ensures ToNatRight(FromNat(n)) == n
    decreases n
  {
    if n == 0 {
    } else {
      calc {
        ToNatRight(FromNat(n));
        {
          LemmaDivBasicsAuto();
        }
        ToNatRight([n % BASE()] + FromNat(n / BASE()));
        n % BASE() + ToNatRight(FromNat(n / BASE())) * BASE();
        {
          LemmaDivDecreasesAuto();
          LemmaNatSeqNat(n / BASE());
        }
        n % BASE() + n / BASE() * BASE();
        {
          LemmaFundamentalDivMod(n, BASE());
        }
        n;
      }
    }
  }

  opaque function SeqExtend(xs: seq<digit>, n: nat): (ys: seq<digit>)
    requires |xs| <= n
    ensures |ys| == n
    ensures ToNatRight(ys) == ToNatRight(xs)
    decreases n - |xs|
  {
    if |xs| >= n then
      xs
    else
      LemmaSeqAppendZero(xs); SeqExtend(xs + [0], n)
  }

  opaque function SeqExtendMultiple(xs: seq<digit>, n: nat): (ys: seq<digit>)
    requires n > 0
    ensures |ys| % n == 0
    ensures ToNatRight(ys) == ToNatRight(xs)
  {
    var newLen := |xs| + n - |xs| % n;
    LemmaSubModNoopRight(|xs| + n, |xs|, n);
    LemmaModBasicsAuto();
    assert newLen % n == 0;
    LemmaSeqNatBound(xs);
    LemmaPowIncreasesAuto();
    SeqExtend(xs, newLen)
  }

  function FromNatWithLen(n: nat, len: nat): (xs: seq<digit>)
    requires Pow(BASE(), len) > n
    ensures |xs| == len
    ensures ToNatRight(xs) == n
  {
    LemmaFromNatLen(n, len);
    LemmaNatSeqNat(n);
    SeqExtend(FromNat(n), len)
  }

  @ResourceLimit("10e6") lemma LemmaSeqZero(xs: seq<digit>)
    requires ToNatRight(xs) == 0
    ensures forall i :: 0 <= i < |xs| ==> xs[i] == 0
  {
    if |xs| == 0 {
    } else {
      LemmaMulNonnegativeAuto();
      assert First(xs) == 0;
      LemmaMulNonzeroAuto();
      LemmaSeqZero(DropFirst(xs));
    }
  }

  opaque function SeqZero(len: nat): (xs: seq<digit>)
    ensures |xs| == len
    ensures forall i :: 0 <= i < |xs| ==> xs[i] == 0
    ensures ToNatRight(xs) == 0
  {
    LemmaPowPositive(BASE(), len);
    var xs := FromNatWithLen(0, len);
    LemmaSeqZero(xs);
    xs
  }

  lemma LemmaSeqNatSeq(xs: seq<digit>)
    ensures Pow(BASE(), |xs|) > ToNatRight(xs)
    ensures FromNatWithLen(ToNatRight(xs), |xs|) == xs
  {
    LemmaSeqNatBound(xs);
    if |xs| > 0 {
      calc {
        FromNatWithLen(ToNatRight(xs), |xs|) != xs;
        {
          LemmaSeqNeq(FromNatWithLen(ToNatRight(xs), |xs|), xs);
        }
        ToNatRight(FromNatWithLen(ToNatRight(xs), |xs|)) != ToNatRight(xs);
        ToNatRight(xs) != ToNatRight(xs);
        false;
      }
    }
  }

  function SeqAdd(xs: seq<digit>, ys: seq<digit>): (seq<digit>, nat)
    requires |xs| == |ys|
    ensures var (zs, cout) := SeqAdd(xs, ys); |zs| == |xs| && 0 <= cout <= 1
    decreases xs
  {
    if |xs| == 0 then
      ([], 0)
    else
      var (zs', cin) := SeqAdd(DropLast(xs), DropLast(ys)); var sum: int := Last(xs) + Last(ys) + cin; var (sum_out, cout) := if sum < BASE() then (sum, 0) else (sum - BASE(), 1); (zs' + [sum_out], cout)
  }

  @IsolateAssertions lemma LemmaSeqAdd(xs: seq<digit>, ys: seq<digit>, zs: seq<digit>, cout: nat)
    requires |xs| == |ys|
    requires SeqAdd(xs, ys) == (zs, cout)
    ensures ToNatRight(xs) + ToNatRight(ys) == ToNatRight(zs) + cout * Pow(BASE(), |xs|)
  {
    if |xs| == 0 {
    } else {
      var pow := Pow(BASE(), |xs| - 1);
      var (zs', cin) := SeqAdd(DropLast(xs), DropLast(ys));
      var sum: int := Last(xs) + Last(ys) + cin;
      var z := if sum < BASE() then sum else sum - BASE();
      assert sum == z + cout * BASE();
      LemmaToNatLeftEqToNatRightAuto();
      calc {
        ToNatRight(zs);
        ToNatLeft(zs);
        ToNatLeft(zs') + z * pow;
        {
          LemmaSeqAdd(DropLast(xs), DropLast(ys), zs', cin);
        }
        ToNatLeft(DropLast(xs)) + ToNatLeft(DropLast(ys)) - cin * pow + z * pow;
        {
          LemmaMulEquality(sum, z + cout * BASE(), pow);
          assert sum * pow == (z + cout * BASE()) * pow;
          LemmaMulIsDistributiveAuto();
        }
        ToNatLeft(xs) + ToNatLeft(ys) - cout * BASE() * pow;
        {
          LemmaMulIsAssociative(cout, BASE(), pow);
        }
        ToNatLeft(xs) + ToNatLeft(ys) - cout * Pow(BASE(), |xs|);
        ToNatRight(xs) + ToNatRight(ys) - cout * Pow(BASE(), |xs|);
      }
    }
  }

  function SeqSub(xs: seq<digit>, ys: seq<digit>): (seq<digit>, nat)
    requires |xs| == |ys|
    ensures var (zs, cout) := SeqSub(xs, ys); |zs| == |xs| && 0 <= cout <= 1
    decreases xs
  {
    if |xs| == 0 then
      ([], 0)
    else
      var (zs, cin) := SeqSub(DropLast(xs), DropLast(ys)); var (diff_out, cout) := if Last(xs) >= Last(ys) + cin then (Last(xs) - Last(ys) - cin, 0) else (BASE() + Last(xs) - Last(ys) - cin, 1); (zs + [diff_out], cout)
  }

  @IsolateAssertions lemma LemmaSeqSub(xs: seq<digit>, ys: seq<digit>, zs: seq<digit>, cout: nat)
    requires |xs| == |ys|
    requires SeqSub(xs, ys) == (zs, cout)
    ensures ToNatRight(xs) - ToNatRight(ys) + cout * Pow(BASE(), |xs|) == ToNatRight(zs)
  {
    if |xs| == 0 {
    } else {
      var pow := Pow(BASE(), |xs| - 1);
      var (zs', cin) := SeqSub(DropLast(xs), DropLast(ys));
      var z := if Last(xs) >= Last(ys) + cin then Last(xs) - Last(ys) - cin else BASE() + Last(xs) - Last(ys) - cin;
      assert cout * BASE() + Last(xs) - cin - Last(ys) == z;
      LemmaToNatLeftEqToNatRightAuto();
      calc {
        ToNatRight(zs);
        ToNatLeft(zs);
        ToNatLeft(zs') + z * pow;
        {
          LemmaSeqSub(DropLast(xs), DropLast(ys), zs', cin);
        }
        ToNatLeft(DropLast(xs)) - ToNatLeft(DropLast(ys)) + cin * pow + z * pow;
        {
          LemmaMulEquality(cout * BASE() + Last(xs) - cin - Last(ys), z, pow);
          assert pow * (cout * BASE() + Last(xs) - cin - Last(ys)) == pow * z;
          LemmaMulIsDistributiveAuto();
        }
        ToNatLeft(xs) - ToNatLeft(ys) + cout * BASE() * pow;
        {
          LemmaMulIsAssociative(cout, BASE(), pow);
        }
        ToNatLeft(xs) - ToNatLeft(ys) + cout * Pow(BASE(), |xs|);
        ToNatRight(xs) - ToNatRight(ys) + cout * Pow(BASE(), |xs|);
      }
    }
  }

  import opened DivMod

  import opened Mul

  import opened Power

  import opened Seq = Collections.Seq

  import opened Logarithm

  type digit = i: nat
    | 0 <= i < BASE()
}

@DisableNonlinearArithmetic
module Std.Arithmetic.Logarithm {
  function Log(base: nat, pow: nat): nat
    requires base > 1
    decreases pow
  {
    if pow < base then
      0
    else
      LemmaDivPosIsPosAuto(); LemmaDivDecreasesAuto(); 1 + Log(base, pow / base)
  }

  lemma {:induction false} LemmaLog0(base: nat, pow: nat)
    requires base > 1
    requires pow < base
    ensures Log(base, pow) == 0
  {
  }

  lemma {:induction false} LemmaLogS(base: nat, pow: nat)
    requires base > 1
    requires pow >= base
    ensures pow / base >= 0
    ensures Log(base, pow) == 1 + Log(base, pow / base)
  {
    LemmaDivPosIsPosAuto();
  }

  lemma {:induction false} LemmaLogSAuto()
    ensures forall base: nat, pow: nat {:trigger Log(base, pow / base)} | base > 1 && pow >= base :: pow / base >= 0 && Log(base, pow) == 1 + Log(base, pow / base)
  {
    forall base: nat, pow: nat | base > 1 && pow >= base
      ensures pow / base >= 0 && Log(base, pow) == 1 + Log(base, pow / base)
    {
      LemmaLogS(base, pow);
    }
  }

  lemma {:induction false} LemmaLogIsOrdered(base: nat, pow: nat, pow': nat)
    requires base > 1
    requires pow <= pow'
    ensures Log(base, pow) <= Log(base, pow')
    decreases pow
  {
    if pow' < base {
      assert Log(base, pow) == 0 == Log(base, pow');
    } else if pow < base {
      assert Log(base, pow) == 0;
    } else {
      LemmaDivPosIsPosAuto();
      LemmaDivDecreasesAuto();
      LemmaDivIsOrderedAuto();
      LemmaLogIsOrdered(base, pow / base, pow' / base);
    }
  }

  lemma {:induction false} LemmaLogPow(base: nat, n: nat)
    requires base > 1
    ensures (LemmaPowPositive(base, n); Log(base, Pow(base, n)) == n)
  {
    if n == 0 {
    } else {
      LemmaPowPositive(base, n);
      calc {
        Log(base, Pow(base, n));
        {
        }
        Log(base, base * Pow(base, n - 1));
        {
          LemmaPowPositive(base, n - 1);
          LemmaMulIncreases(Pow(base, n - 1), base);
          LemmaMulIsCommutative(Pow(base, n - 1), base);
          LemmaLogS(base, base * Pow(base, n - 1));
        }
        1 + Log(base, base * Pow(base, n - 1) / base);
        {
          LemmaDivMultiplesVanish(Pow(base, n - 1), base);
        }
        1 + Log(base, Pow(base, n - 1));
        {
          LemmaLogPow(base, n - 1);
        }
        1 + (n - 1);
      }
    }
  }

  import opened Mul

  import opened DivMod

  import opened Power
}

@DisableNonlinearArithmetic
module Std.Arithmetic.Mul {
  lemma LemmaMulIsMulRecursive(x: int, y: int)
    ensures x * y == MulRecursive(x, y)
  {
    if x >= 0 {
      LemmaMulIsMulPos(x, y);
    }
    if x <= 0 {
      LemmaMulIsMulPos(-x, y);
    }
    LemmaMulAuto();
  }

  lemma LemmaMulIsMulRecursiveAuto()
    ensures forall x: int, y: int :: x * y == MulRecursive(x, y)
  {
    forall x: int, y: int | true
      ensures x * y == MulRecursive(x, y)
    {
      LemmaMulIsMulRecursive(x, y);
    }
  }

  lemma LemmaMulIsMulPos(x: int, y: int)
    requires x >= 0
    ensures x * y == MulPos(x, y)
  {
    if x == 0 {
      assert MulPos(x, y) == 0;
    } else {
      calc {
        MulPos(x, y);
        y + MulPos(x - 1, y);
        {
          LemmaMulIsMulPos(x - 1, y);
        }
        y + (x - 1) * y;
        {
          LemmaMulDistributes();
        }
        x * y;
      }
    }
  }

  lemma LemmaMulBasics(x: int)
    ensures 0 * x == 0
    ensures x * 0 == 0
    ensures 1 * x == x
    ensures x * 1 == x
  {
  }

  lemma LemmaMulBasicsAuto()
    ensures forall x: int {:trigger 0 * x} :: 0 * x == 0
    ensures forall x: int {:trigger x * 0} :: x * 0 == 0
    ensures forall x: int {:trigger 1 * x} :: 1 * x == x
    ensures forall x: int {:trigger x * 1} :: x * 1 == x
  {
  }

  lemma LemmaMulNonzero(x: int, y: int)
    ensures x * y != 0 <==> x != 0 && y != 0
  {
    MulINL.LemmaMulNonzero(x, y);
  }

  lemma LemmaMulNonzeroAuto()
    ensures forall x: int, y: int {:trigger x * y} :: x * y != 0 <==> x != 0 && y != 0
  {
    forall x: int, y: int | true
      ensures x * y != 0 <==> x != 0 && y != 0
    {
      LemmaMulNonzero(x, y);
    }
  }

  lemma LemmaMulByZeroIsZeroAuto()
    ensures forall x: int {:trigger 0 * x} {:trigger x * 0} :: x * 0 == 0 * x == 0
  {
    forall x: int {:trigger 0 * x} {:trigger x * 0} | true
      ensures x * 0 == 0 * x == 0
    {
      LemmaMulBasics(x);
    }
  }

  lemma LemmaMulIsAssociative(x: int, y: int, z: int)
    ensures x * (y * z) == x * y * z
  {
    MulINL.LemmaMulIsAssociative(x, y, z);
  }

  lemma LemmaMulIsAssociativeAuto()
    ensures forall x: int, y: int, z: int {:trigger x * (y * z)} {:trigger x * y * z} :: x * (y * z) == x * y * z
  {
    forall x: int, y: int, z: int | true
      ensures x * (y * z) == x * y * z
    {
      LemmaMulIsAssociative(x, y, z);
    }
  }

  lemma LemmaMulIsCommutative(x: int, y: int)
    ensures x * y == y * x
  {
  }

  lemma LemmaMulIsCommutativeAuto()
    ensures forall x: int, y: int {:trigger x * y} :: x * y == y * x
  {
  }

  lemma LemmaMulOrdering(x: int, y: int)
    requires x != 0
    requires y != 0
    requires 0 <= x * y
    ensures x * y >= x && x * y >= y
  {
    MulINL.LemmaMulOrdering(x, y);
  }

  lemma LemmaMulOrderingAuto()
    ensures forall x: int, y: int {:trigger x * y} :: 0 != x && 0 != y && x * y >= 0 ==> x * y >= x && x * y >= y
  {
    forall x: int, y: int | 0 != x && 0 != y && x * y >= 0
      ensures x * y >= x && x * y >= y
    {
      LemmaMulOrdering(x, y);
    }
  }

  lemma LemmaMulEquality(x: int, y: int, z: int)
    requires x == y
    ensures x * z == y * z
  {
  }

  lemma LemmaMulEqualityAuto()
    ensures forall x: int, y: int, z: int {:trigger x * z, y * z} :: x == y ==> x * z == y * z
  {
    forall x: int, y: int, z: int | x == y
      ensures x * z == y * z
    {
      LemmaMulEquality(x, y, z);
    }
  }

  lemma LemmaMulInequality(x: int, y: int, z: int)
    requires x <= y
    requires z >= 0
    ensures x * z <= y * z
  {
    LemmaMulInductionAuto(z, u => u >= 0 ==> x * u <= y * u);
  }

  lemma LemmaMulInequalityAuto()
    ensures forall x: int, y: int, z: int {:trigger x * z, y * z} :: x <= y && z >= 0 ==> x * z <= y * z
  {
    forall x: int, y: int, z: int | x <= y && z >= 0
      ensures x * z <= y * z
    {
      LemmaMulInequality(x, y, z);
    }
  }

  lemma LemmaMulStrictInequality(x: int, y: int, z: int)
    requires x < y
    requires z > 0
    ensures x * z < y * z
  {
    MulINL.LemmaMulStrictInequality(x, y, z);
  }

  lemma LemmaMulStrictInequalityAuto()
    ensures forall x: int, y: int, z: int {:trigger x * z, y * z} :: x < y && z > 0 ==> x * z < y * z
  {
    forall x: int, y: int, z: int | x < y && z > 0
      ensures x * z < y * z
    {
      LemmaMulStrictInequality(x, y, z);
    }
  }

  lemma LemmaMulUpperBound(x: int, XBound: int, y: int, YBound: int)
    requires x <= XBound
    requires y <= YBound
    requires 0 <= x
    requires 0 <= y
    ensures x * y <= XBound * YBound
  {
    LemmaMulInequality(x, XBound, y);
    LemmaMulInequality(y, YBound, XBound);
  }

  lemma LemmaMulUpperBoundAuto()
    ensures forall x: int, XBound: int, y: int, YBound: int {:trigger x * y, XBound * YBound} :: x <= XBound && y <= YBound && 0 <= x && 0 <= y ==> x * y <= XBound * YBound
  {
    forall x: int, XBound: int, y: int, YBound: int | x <= XBound && y <= YBound && 0 <= x && 0 <= y
      ensures x * y <= XBound * YBound
    {
      LemmaMulUpperBound(x, XBound, y, YBound);
    }
  }

  lemma LemmaMulStrictUpperBound(x: int, XBound: int, y: int, YBound: int)
    requires x < XBound
    requires y < YBound
    requires 0 < x
    requires 0 < y
    ensures x * y <= (XBound - 1) * (YBound - 1)
  {
    LemmaMulInequality(x, XBound - 1, y);
    LemmaMulInequality(y, YBound - 1, XBound - 1);
  }

  lemma LemmaMulStrictUpperBoundAuto()
    ensures forall x: int, XBound: int, y: int, YBound: int {:trigger x * y, (XBound - 1) * (YBound - 1)} :: x < XBound && y < YBound && 0 < x && 0 < y ==> x * y <= (XBound - 1) * (YBound - 1)
  {
    forall x: int, XBound: int, y: int, YBound: int {:trigger (XBound - 1) * (YBound - 1), x * y} {:trigger YBound - 1, XBound - 1, 0 < y, 0 < x} {:trigger YBound - 1, 0 < y, x < XBound} {:trigger XBound - 1, 0 < x, y < YBound} {:trigger y < YBound, x < XBound} | x < XBound && y < YBound && 0 < x && 0 < y
      ensures x * y <= (XBound - 1) * (YBound - 1)
    {
      LemmaMulStrictUpperBound(x, XBound, y, YBound);
    }
  }

  lemma LemmaMulLeftInequality(x: int, y: int, z: int)
    requires 0 < x
    ensures y <= z ==> x * y <= x * z
    ensures y < z ==> x * y < x * z
  {
    LemmaMulInductionAuto(x, u => u > 0 ==> y <= z ==> u * y <= u * z);
    LemmaMulInductionAuto(x, u => u > 0 ==> y < z ==> u * y < u * z);
  }

  lemma LemmaMulLeftInequalityAuto()
    ensures forall x: int, y: int, z: int {:trigger x * y, x * z} :: x > 0 ==> (y <= z ==> x * y <= x * z) && (y < z ==> x * y < x * z)
  {
    forall x: int, y: int, z: int | (y <= z || y < z) && 0 < x
      ensures (y <= z ==> x * y <= x * z) && (y < z ==> x * y < x * z)
    {
      LemmaMulLeftInequality(x, y, z);
    }
  }

  lemma LemmaMulEqualityConverse(m: int, x: int, y: int)
    requires m != 0
    requires m * x == m * y
    ensures x == y
  {
    LemmaMulInductionAuto(m, u => x > y && 0 < u ==> x * u > y * u);
    LemmaMulInductionAuto(m, u => x > y && 0 > u ==> x * u < y * u);
    LemmaMulInductionAuto(m, u => x < y && 0 < u ==> x * u < y * u);
    LemmaMulInductionAuto(m, u => x < y && 0 > u ==> x * u > y * u);
  }

  lemma LemmaMulEqualityConverseAuto()
    ensures forall m: int, x: int, y: int {:trigger m * x, m * y} :: m != 0 && m * x == m * y ==> x == y
  {
    forall m: int, x: int, y: int | m != 0 && m * x == m * y
      ensures x == y
    {
      LemmaMulEqualityConverse(m, x, y);
    }
  }

  lemma LemmaMulInequalityConverse(x: int, y: int, z: int)
    requires x * z <= y * z
    requires z > 0
    ensures x <= y
  {
    LemmaMulInductionAuto(z, u => x * u <= y * u && u > 0 ==> x <= y);
  }

  lemma LemmaMulInequalityConverseAuto()
    ensures forall x: int, y: int, z: int {:trigger x * z, y * z} :: x * z <= y * z && z > 0 ==> x <= y
  {
    forall x: int, y: int, z: int | x * z <= y * z && z > 0
      ensures x <= y
    {
      LemmaMulInequalityConverse(x, y, z);
    }
  }

  lemma LemmaMulStrictInequalityConverse(x: int, y: int, z: int)
    requires x * z < y * z
    requires z >= 0
    ensures x < y
  {
    LemmaMulInductionAuto(z, u => x * u < y * u && u >= 0 ==> x < y);
  }

  lemma LemmaMulStrictInequalityConverseAuto()
    ensures forall x: int, y: int, z: int {:trigger x * z, y * z} :: x * z < y * z && z >= 0 ==> x < y
  {
    forall x: int, y: int, z: int | x * z < y * z && z >= 0
      ensures x < y
    {
      LemmaMulStrictInequalityConverse(x, y, z);
    }
  }

  lemma LemmaMulIsDistributiveAdd(x: int, y: int, z: int)
    ensures x * (y + z) == x * y + x * z
  {
    MulINL.LemmaMulIsDistributiveAdd(x, y, z);
  }

  lemma LemmaMulIsDistributiveAddAuto()
    ensures forall x: int, y: int, z: int {:trigger x * (y + z)} :: x * (y + z) == x * y + x * z
  {
    forall x: int, y: int, z: int | true
      ensures x * (y + z) == x * y + x * z
    {
      LemmaMulIsDistributiveAdd(x, y, z);
    }
  }

  lemma LemmaMulIsDistributiveAddOtherWay(x: int, y: int, z: int)
    ensures (y + z) * x == y * x + z * x
  {
    LemmaMulAuto();
  }

  lemma LemmaMulIsDistributiveAddOtherWayAuto()
    ensures forall x: int, y: int, z: int {:trigger (y + z) * x} :: (y + z) * x == y * x + z * x
  {
    forall x: int, y: int, z: int | true
      ensures (y + z) * x == y * x + z * x
    {
      LemmaMulIsDistributiveAddOtherWay(x, y, z);
    }
  }

  lemma LemmaMulIsDistributiveSub(x: int, y: int, z: int)
    ensures x * (y - z) == x * y - x * z
  {
    LemmaMulAuto();
  }

  lemma LemmaMulIsDistributiveSubAuto()
    ensures forall x: int, y: int, z: int {:trigger x * (y - z)} :: x * (y - z) == x * y - x * z
  {
    forall x: int, y: int, z: int | true
      ensures x * (y - z) == x * y - x * z
    {
      LemmaMulIsDistributiveSub(x, y, z);
    }
  }

  lemma LemmaMulIsDistributive(x: int, y: int, z: int)
    ensures x * (y + z) == x * y + x * z
    ensures x * (y - z) == x * y - x * z
    ensures (y + z) * x == y * x + z * x
    ensures (y - z) * x == y * x - z * x
    ensures x * (y + z) == (y + z) * x
    ensures x * (y - z) == (y - z) * x
    ensures x * y == y * x
    ensures x * z == z * x
  {
    LemmaMulAuto();
  }

  lemma LemmaMulIsDistributiveAuto()
    ensures forall x: int, y: int, z: int {:trigger x * (y + z)} :: x * (y + z) == x * y + x * z
    ensures forall x: int, y: int, z: int {:trigger x * (y - z)} :: x * (y - z) == x * y - x * z
    ensures forall x: int, y: int, z: int {:trigger (y + z) * x} :: (y + z) * x == y * x + z * x
    ensures forall x: int, y: int, z: int {:trigger (y - z) * x} :: (y - z) * x == y * x - z * x
  {
    LemmaMulIsDistributiveAddAuto();
    LemmaMulIsDistributiveSubAuto();
    LemmaMulIsCommutativeAuto();
  }

  lemma LemmaMulStrictlyPositive(x: int, y: int)
    ensures 0 < x && 0 < y ==> 0 < x * y
  {
    MulINL.LemmaMulStrictlyPositive(x, y);
  }

  lemma LemmaMulStrictlyPositiveAuto()
    ensures forall x: int, y: int {:trigger x * y} :: 0 < x && 0 < y ==> 0 < x * y
  {
    forall x: int, y: int | 0 < x && 0 < y
      ensures 0 < x * y
    {
      LemmaMulStrictlyPositive(x, y);
    }
  }

  lemma LemmaMulStrictlyIncreases(x: int, y: int)
    requires 1 < x
    requires 0 < y
    ensures y < x * y
  {
    LemmaMulInductionAuto(x, u => 1 < u ==> y < u * y);
  }

  lemma LemmaMulStrictlyIncreasesAuto()
    ensures forall x: int, y: int {:trigger x * y} :: 1 < x && 0 < y ==> y < x * y
  {
    forall x: int, y: int | 1 < x && 0 < y
      ensures y < x * y
    {
      LemmaMulStrictlyIncreases(x, y);
    }
  }

  lemma LemmaMulIncreases(x: int, y: int)
    requires 0 < x
    requires 0 < y
    ensures y <= x * y
  {
    LemmaMulInductionAuto(x, u => 0 < u ==> y <= u * y);
  }

  lemma LemmaMulIncreasesAuto()
    ensures forall x: int, y: int {:trigger x * y} :: 0 < x && 0 < y ==> y <= x * y
  {
    forall x: int, y: int | 0 < x && 0 < y
      ensures y <= x * y
    {
      LemmaMulIncreases(x, y);
    }
  }

  lemma LemmaMulNonnegative(x: int, y: int)
    requires 0 <= x
    requires 0 <= y
    ensures 0 <= x * y
  {
    LemmaMulInductionAuto(x, u => 0 <= u ==> 0 <= u * y);
  }

  lemma LemmaMulNonnegativeAuto()
    ensures forall x: int, y: int {:trigger x * y} :: 0 <= x && 0 <= y ==> 0 <= x * y
  {
    forall x: int, y: int | 0 <= x && 0 <= y
      ensures 0 <= x * y
    {
      LemmaMulNonnegative(x, y);
    }
  }

  lemma LemmaMulUnaryNegation(x: int, y: int)
    ensures -x * y == -(x * y) == x * -y
  {
    LemmaMulInductionAuto(x, u => -u * y == -(u * y) == u * -y);
  }

  lemma LemmaMulUnaryNegationAuto()
    ensures forall x: int, y: int {:trigger -x * y} {:trigger x * -y} :: -x * y == -(x * y) == x * -y
  {
    forall x: int, y: int | true
      ensures -x * y == -(x * y) == x * -y
    {
      LemmaMulUnaryNegation(x, y);
    }
  }

  lemma LemmaMulCancelsNegatives(x: int, y: int)
    ensures x * y == -x * -y
  {
    LemmaMulUnaryNegationAuto();
  }

  lemma LemmaMulCancelsNegativesAuto()
    ensures forall x: int, y: int {:trigger x * y} :: x * y == -x * -y
  {
    forall x: int, y: int | true
      ensures x * y == -x * -y
    {
      LemmaMulCancelsNegatives(x, y);
    }
  }

  lemma LemmaMulProperties()
    ensures forall x: int, y: int {:trigger x * y} :: x * y == y * x
    ensures forall x: int {:trigger x * 1} {:trigger 1 * x} :: x * 1 == 1 * x == x
    ensures forall x: int, y: int, z: int {:trigger x * z, y * z} :: x < y && z > 0 ==> x * z < y * z
    ensures forall x: int, y: int, z: int {:trigger x * z, y * z} :: x <= y && z >= 0 ==> x * z <= y * z
    ensures forall x: int, y: int, z: int {:trigger x * (y + z)} :: x * (y + z) == x * y + x * z
    ensures forall x: int, y: int, z: int {:trigger x * (y - z)} :: x * (y - z) == x * y - x * z
    ensures forall x: int, y: int, z: int {:trigger (y + z) * x} :: (y + z) * x == y * x + z * x
    ensures forall x: int, y: int, z: int {:trigger (y - z) * x} :: (y - z) * x == y * x - z * x
    ensures forall x: int, y: int, z: int {:trigger x * (y * z)} {:trigger x * y * z} :: x * (y * z) == x * y * z
    ensures forall x: int, y: int {:trigger x * y} :: x * y != 0 <==> x != 0 && y != 0
    ensures forall x: int, y: int {:trigger x * y} :: 0 <= x && 0 <= y ==> 0 <= x * y
    ensures forall x: int, y: int {:trigger x * y} :: 0 < x && 0 < y && 0 <= x * y ==> x <= x * y && y <= x * y
    ensures forall x: int, y: int {:trigger x * y} :: 1 < x && 0 < y ==> y < x * y
    ensures forall x: int, y: int {:trigger x * y} :: 0 < x && 0 < y ==> y <= x * y
    ensures forall x: int, y: int {:trigger x * y} :: 0 < x && 0 < y ==> 0 < x * y
  {
    LemmaMulStrictInequalityAuto();
    LemmaMulInequalityAuto();
    LemmaMulIsDistributiveAuto();
    LemmaMulIsAssociativeAuto();
    LemmaMulOrderingAuto();
    LemmaMulNonzeroAuto();
    LemmaMulNonnegativeAuto();
    LemmaMulStrictlyIncreasesAuto();
    LemmaMulIncreasesAuto();
  }

  import MulINL = MulInternalsNonlinear

  import opened MulInternals
}

@DisableNonlinearArithmetic
module Std.Arithmetic.Power {
  function Pow(b: int, e: nat): int
    decreases e
  {
    if e == 0 then
      1
    else
      b * Pow(b, e - 1)
  }

  lemma LemmaPow0(b: int)
    ensures Pow(b, 0) == 1
  {
  }

  lemma LemmaPow0Auto()
    ensures forall b: nat {:trigger Pow(b, 0)} :: Pow(b, 0) == 1
  {
    forall b: nat {:trigger Pow(b, 0)} | true
      ensures Pow(b, 0) == 1
    {
      LemmaPow0(b);
    }
  }

  lemma LemmaPow1(b: int)
    ensures Pow(b, 1) == b
  {
    calc {
      Pow(b, 1);
      {
      }
      b * Pow(b, 0);
      {
        LemmaPow0(b);
      }
      b * 1;
      {
        LemmaMulBasicsAuto();
      }
      b;
    }
  }

  lemma LemmaPow1Auto()
    ensures forall b: nat {:trigger Pow(b, 1)} :: Pow(b, 1) == b
  {
    forall b: nat {:trigger Pow(b, 1)} | true
      ensures Pow(b, 1) == b
    {
      LemmaPow1(b);
    }
  }

  lemma Lemma0Pow(e: nat)
    requires e > 0
    ensures Pow(0, e) == 0
  {
    LemmaMulBasicsAuto();
    if e != 1 {
      Lemma0Pow(e - 1);
    }
  }

  lemma Lemma0PowAuto()
    ensures forall e: nat {:trigger Pow(0, e)} :: e > 0 ==> Pow(0, e) == 0
  {
    forall e: nat {:trigger Pow(0, e)} | e > 0
      ensures Pow(0, e) == 0
    {
      Lemma0Pow(e);
    }
  }

  lemma Lemma1Pow(e: nat)
    ensures Pow(1, e) == 1
  {
    LemmaMulBasicsAuto();
    if e != 0 {
      Lemma1Pow(e - 1);
    }
  }

  lemma Lemma1PowAuto()
    ensures forall e: nat {:trigger Pow(1, e)} :: Pow(1, e) == 1
  {
    forall e: nat {:trigger Pow(1, e)} | true
      ensures Pow(1, e) == 1
    {
      Lemma1Pow(e);
    }
  }

  lemma LemmaSquareIsPow2(x: nat)
    ensures Pow(x, 2) == x * x
  {
  }

  lemma LemmaSquareIsPow2Auto()
    ensures forall x: nat {:trigger Pow(x, 2)} :: Pow(x, 2) == x * x
  {
    forall x: nat {:trigger Pow(x, 2)} | true
      ensures Pow(x, 2) == x * x
    {
    }
  }

  lemma LemmaPowPositive(b: int, e: nat)
    requires b > 0
    ensures 0 < Pow(b, e)
  {
    LemmaMulIncreasesAuto();
    LemmaPow0Auto();
    LemmaMulInductionAuto(e, u => 0 <= u ==> 0 < Pow(b, u));
  }

  lemma LemmaPowPositiveAuto()
    ensures forall b: int, e: nat {:trigger Pow(b, e)} :: b > 0 ==> 0 < Pow(b, e)
  {
    forall b: int, e: nat {:trigger Pow(b, e)} | b > 0
      ensures 0 < Pow(b, e)
    {
      LemmaPowPositive(b, e);
    }
  }

  lemma LemmaPowAdds(b: int, e1: nat, e2: nat)
    ensures Pow(b, e1 + e2) == Pow(b, e1) * Pow(b, e2)
    decreases e1
  {
    if e1 == 0 {
      calc {
        Pow(b, e1) * Pow(b, e2);
        {
          LemmaPow0(b);
        }
        1 * Pow(b, e2);
        {
          LemmaMulBasicsAuto();
        }
        Pow(b, 0 + e2);
      }
    } else {
      calc {
        Pow(b, e1) * Pow(b, e2);
        {
        }
        b * Pow(b, e1 - 1) * Pow(b, e2);
        {
          LemmaMulIsAssociativeAuto();
        }
        b * (Pow(b, e1 - 1) * Pow(b, e2));
        {
          LemmaPowAdds(b, e1 - 1, e2);
        }
        b * Pow(b, e1 - 1 + e2);
        {
        }
        Pow(b, e1 + e2);
      }
    }
  }

  lemma LemmaPowAddsAuto()
    ensures forall b: int, e1: nat, e2: nat {:trigger Pow(b, e1 + e2)} :: Pow(b, e1 + e2) == Pow(b, e1) * Pow(b, e2)
  {
    forall b: int, e1: nat, e2: nat {:trigger Pow(b, e1 + e2)} | true
      ensures Pow(b, e1 + e2) == Pow(b, e1) * Pow(b, e2)
    {
      LemmaPowAdds(b, e1, e2);
    }
  }

  lemma LemmaPowSubAddCancel(b: int, e1: nat, e2: nat)
    requires e1 >= e2
    ensures Pow(b, e1 - e2) * Pow(b, e2) == Pow(b, e1)
    decreases e1
  {
    LemmaPowAdds(b, e1 - e2, e2);
  }

  lemma LemmaPowSubAddCancelAuto()
    ensures forall b: int, e1: nat, e2: nat {:trigger Pow(b, e1 - e2)} | e1 >= e2 :: Pow(b, e1 - e2) * Pow(b, e2) == Pow(b, e1)
  {
    forall b: int, e1: nat, e2: nat | e1 >= e2 {
      LemmaPowSubAddCancel(b, e1, e2);
    }
  }

  lemma LemmaPowSubtracts(b: nat, e1: nat, e2: nat)
    requires b > 0
    requires e1 <= e2
    ensures Pow(b, e1) > 0
    ensures Pow(b, e2 - e1) == Pow(b, e2) / Pow(b, e1) > 0
  {
    LemmaPowPositiveAuto();
    calc {
      Pow(b, e2) / Pow(b, e1);
      {
        LemmaPowSubAddCancel(b, e2, e1);
      }
      Pow(b, e2 - e1) * Pow(b, e1) / Pow(b, e1);
      {
        LemmaDivByMultiple(Pow(b, e2 - e1), Pow(b, e1));
      }
      Pow(b, e2 - e1);
    }
  }

  lemma LemmaPowSubtractsAuto()
    ensures forall b: nat, e1: nat :: b > 0 ==> Pow(b, e1) > 0
    ensures forall b: nat, e1: nat, e2: nat {:trigger Pow(b, e2 - e1)} :: b > 0 && e1 <= e2 ==> Pow(b, e2 - e1) == Pow(b, e2) / Pow(b, e1) > 0
  {
    LemmaPowPositiveAuto();
    forall b: nat, e1: nat, e2: nat {:trigger Pow(b, e2 - e1)} | b > 0 && e1 <= e2
      ensures Pow(b, e2 - e1) == Pow(b, e2) / Pow(b, e1) > 0
    {
      LemmaPowSubtracts(b, e1, e2);
    }
  }

  lemma LemmaPowMultiplies(a: int, b: nat, c: nat)
    ensures 0 <= b * c
    ensures Pow(Pow(a, b), c) == Pow(a, b * c)
    decreases c
  {
    LemmaMulNonnegative(b, c);
    if c == 0 {
      LemmaMulBasicsAuto();
      calc {
        Pow(a, b * c);
        {
          LemmaPow0(a);
        }
        1;
        {
          LemmaPow0(Pow(a, b));
        }
        Pow(Pow(a, b), c);
      }
    } else {
      calc {
        b * c - b;
        {
          LemmaMulBasicsAuto();
        }
        b * c - b * 1;
        {
          LemmaMulIsDistributiveAuto();
        }
        b * (c - 1);
      }
      LemmaMulNonnegative(b, c - 1);
      assert 0 <= b * c - b;
      calc {
        Pow(a, b * c);
        Pow(a, b + b * c - b);
        {
          LemmaPowAdds(a, b, b * c - b);
        }
        Pow(a, b) * Pow(a, b * c - b);
        Pow(a, b) * Pow(a, b * (c - 1));
        {
          LemmaPowMultiplies(a, b, c - 1);
        }
        Pow(a, b) * Pow(Pow(a, b), c - 1);
        {
        }
        Pow(Pow(a, b), c);
      }
    }
  }

  lemma LemmaPowMultipliesAuto()
    ensures forall b: nat, c: nat {:trigger b * c} :: 0 <= b * c
    ensures forall a: int, b: nat, c: nat {:trigger Pow(a, b * c)} :: Pow(Pow(a, b), c) == Pow(a, b * c)
  {
    LemmaMulNonnegativeAuto();
    forall a: int, b: nat, c: nat {:trigger Pow(a, b * c)} | true
      ensures Pow(Pow(a, b), c) == Pow(a, b * c)
    {
      LemmaPowMultiplies(a, b, c);
    }
  }

  lemma LemmaPowDistributes(a: int, b: int, e: nat)
    ensures Pow(a * b, e) == Pow(a, e) * Pow(b, e)
    decreases e
  {
    LemmaMulBasicsAuto();
    if e > 0 {
      calc {
        Pow(a * b, e);
        a * b * Pow(a * b, e - 1);
        {
          LemmaPowDistributes(a, b, e - 1);
        }
        a * b * (Pow(a, e - 1) * Pow(b, e - 1));
        {
          LemmaMulIsAssociativeAuto();
          LemmaMulIsCommutativeAuto();
        }
        a * Pow(a, e - 1) * (b * Pow(b, e - 1));
        Pow(a, e) * Pow(b, e);
      }
    }
  }

  lemma LemmaPowDistributesAuto()
    ensures forall a: int, b: int, e: nat {:trigger Pow(a * b, e)} :: Pow(a * b, e) == Pow(a, e) * Pow(b, e)
  {
    forall a: int, b: int, e: nat {:trigger Pow(a * b, e)} | true
      ensures Pow(a * b, e) == Pow(a, e) * Pow(b, e)
    {
      LemmaPowDistributes(a, b, e);
    }
  }

  lemma LemmaPowAuto()
    ensures forall x: int {:trigger Pow(x, 0)} :: Pow(x, 0) == 1
    ensures forall x: int {:trigger Pow(x, 1)} :: Pow(x, 1) == x
    ensures forall x: int, y: int {:trigger Pow(x, y)} :: y == 0 ==> Pow(x, y) == 1
    ensures forall x: int, y: int {:trigger Pow(x, y)} :: y == 1 ==> Pow(x, y) == x
    ensures forall x: int, y: int {:trigger x * y} :: 0 < x && 0 < y ==> x <= x * y
    ensures forall x: int, y: int {:trigger x * y} :: 0 < x && 1 < y ==> x < x * y
    ensures forall x: int, y: nat, z: nat {:trigger Pow(x, y + z)} :: Pow(x, y + z) == Pow(x, y) * Pow(x, z)
    ensures forall x: int, y: nat, z: nat {:trigger Pow(x, y - z)} :: y >= z ==> Pow(x, y - z) * Pow(x, z) == Pow(x, y)
    ensures forall x: int, y: int, z: nat {:trigger Pow(x * y, z)} :: Pow(x * y, z) == Pow(x, z) * Pow(y, z)
  {
    LemmaPow0Auto();
    LemmaPow1Auto();
    LemmaPowDistributesAuto();
    LemmaPowAddsAuto();
    LemmaPowSubAddCancelAuto();
    LemmaMulAuto();
    LemmaMulIncreasesAuto();
    LemmaMulStrictlyIncreasesAuto();
  }

  lemma LemmaPowStrictlyIncreases(b: nat, e1: nat, e2: nat)
    requires 1 < b
    requires e1 < e2
    ensures Pow(b, e1) < Pow(b, e2)
  {
    LemmaPowAuto();
    var f := e => 0 < e ==> Pow(b, e1) < Pow(b, e1 + e);
    forall i {:trigger IsLe(0, i)} | IsLe(0, i) && f(i)
      ensures f(i + 1)
    {
      assert 0 < i ==> Pow(b, e1) < Pow(b, e1 + i);
      calc {
        Pow(b, e1 + i);
      <=
        {
          LemmaPowPositive(b, e1 + i);
          LemmaMulLeftInequality(Pow(b, e1 + i), 1, b);
        }
        Pow(b, e1 + i) * b;
      ==
        {
          LemmaPow1(b);
        }
        Pow(b, e1 + i) * Pow(b, 1);
      ==
        {
          LemmaPowAdds(b, e1 + i, 1);
        }
        Pow(b, e1 + i + 1);
      ==
        calc {
          e1 + i + 1;
          e1 + (i + 1);
        }
        Pow(b, e1 + (i + 1));
      }
      assert f(i + 1);
    }
    LemmaMulInductionAuto(e2 - e1, f);
    assert Pow(b, e1) < Pow(b, e1 + (e2 - e1)) == Pow(b, e2) by {
      assert 0 < e2 - e1;
    }
  }

  lemma LemmaPowStrictlyIncreasesAuto()
    ensures forall b: nat, e1: nat, e2: nat {:trigger Pow(b, e1), Pow(b, e2)} :: 1 < b && e1 < e2 ==> Pow(b, e1) < Pow(b, e2)
  {
    forall b: nat, e1: nat, e2: nat {:trigger Pow(b, e1), Pow(b, e2)} | 1 < b && e1 < e2
      ensures Pow(b, e1) < Pow(b, e2)
    {
      LemmaPowStrictlyIncreases(b, e1, e2);
    }
  }

  lemma LemmaPowIncreases(b: nat, e1: nat, e2: nat)
    requires b > 0
    requires e1 <= e2
    ensures Pow(b, e1) <= Pow(b, e2)
  {
    var f := e => 0 <= e ==> Pow(b, e1) <= Pow(b, e1 + e);
    forall i | IsLe(0, i) && f(i)
      ensures f(i + 1)
    {
      calc {
        Pow(b, e1 + i);
      <=
        {
          LemmaPowPositive(b, e1 + i);
          LemmaMulLeftInequality(Pow(b, e1 + i), 1, b);
        }
        Pow(b, e1 + i) * b;
      ==
        {
          LemmaPow1(b);
        }
        Pow(b, e1 + i) * Pow(b, 1);
      ==
        {
          LemmaPowAdds(b, e1 + i, 1);
        }
        Pow(b, e1 + i + 1);
      }
    }
    LemmaMulInductionAuto(e2 - e1, f);
    assert Pow(b, e1) <= Pow(b, e1 + (e2 - e1)) by {
      assert 0 <= e2 - e1;
    }
  }

  lemma LemmaPowIncreasesAuto()
    ensures forall b: nat, e1: nat, e2: nat {:trigger Pow(b, e1), Pow(b, e2)} :: 1 < b && e1 <= e2 ==> Pow(b, e1) <= Pow(b, e2)
  {
    forall b: nat, e1: nat, e2: nat {:trigger Pow(b, e1), Pow(b, e2)} | 1 < b && e1 <= e2
      ensures Pow(b, e1) <= Pow(b, e2)
    {
      LemmaPowIncreases(b, e1, e2);
    }
  }

  lemma LemmaPowStrictlyIncreasesConverse(b: nat, e1: nat, e2: nat)
    requires b > 0
    requires Pow(b, e1) < Pow(b, e2)
    ensures e1 < e2
  {
    if e1 >= e2 {
      LemmaPowIncreases(b, e2, e1);
      assert false;
    }
  }

  lemma LemmaPowStrictlyIncreasesConverseAuto()
    ensures forall b: nat, e1: nat, e2: nat {:trigger Pow(b, e1), Pow(b, e2)} :: b > 0 && Pow(b, e1) < Pow(b, e2) ==> e1 < e2
  {
    forall b: nat, e1: nat, e2: nat {:trigger Pow(b, e1), Pow(b, e2)} | b > 0 && Pow(b, e1) < Pow(b, e2)
      ensures e1 < e2
    {
      LemmaPowStrictlyIncreasesConverse(b, e1, e2);
    }
  }

  lemma LemmaPowIncreasesConverse(b: nat, e1: nat, e2: nat)
    requires 1 < b
    requires Pow(b, e1) <= Pow(b, e2)
    ensures e1 <= e2
  {
    if e1 > e2 {
      LemmaPowStrictlyIncreases(b, e2, e1);
      assert false;
    }
  }

  lemma LemmaPowIncreasesConverseAuto()
    ensures forall b: nat, e1: nat, e2: nat {:trigger Pow(b, e1), Pow(b, e2)} :: 1 < b && Pow(b, e1) <= Pow(b, e2) ==> e1 <= e2
  {
    forall b: nat, e1: nat, e2: nat {:trigger Pow(b, e1), Pow(b, e2)} | 1 < b && Pow(b, e1) <= Pow(b, e2)
      ensures e1 <= e2
    {
      LemmaPowIncreasesConverse(b, e1, e2);
    }
  }

  lemma LemmaPullOutPows(b: nat, x: nat, y: nat, z: nat)
    requires b > 0
    ensures 0 <= x * y
    ensures 0 <= y * z
    ensures Pow(Pow(b, x * y), z) == Pow(Pow(b, x), y * z)
  {
    LemmaMulNonnegative(x, y);
    LemmaMulNonnegative(y, z);
    LemmaPowPositive(b, x);
    calc {
      Pow(Pow(b, x * y), z);
      {
        LemmaPowMultiplies(b, x, y);
      }
      Pow(Pow(Pow(b, x), y), z);
      {
        LemmaPowMultiplies(Pow(b, x), y, z);
      }
      Pow(Pow(b, x), y * z);
    }
  }

  lemma LemmaPullOutPowsAuto()
    ensures forall y: nat, z: nat {:trigger z * y} :: 0 <= z * y && 0 <= y * z
    ensures forall b: nat, x: nat, y: nat, z: nat {:trigger Pow(Pow(b, x * y), z)} :: b > 0 ==> Pow(Pow(b, x * y), z) == Pow(Pow(b, x), y * z)
  {
    LemmaMulNonnegativeAuto();
    forall b: nat, x: nat, y: nat, z: nat {:trigger Pow(Pow(b, x * y), z)} | b > 0
      ensures Pow(Pow(b, x * y), z) == Pow(Pow(b, x), y * z)
    {
      LemmaPullOutPows(b, x, y, z);
    }
  }

  lemma LemmaPowDivisionInequality(x: nat, b: nat, e1: nat, e2: nat)
    requires b > 0
    requires e2 <= e1
    requires x < Pow(b, e1)
    ensures Pow(b, e2) > 0
    ensures x / Pow(b, e2) < Pow(b, e1 - e2)
  {
    LemmaPowPositiveAuto();
    if x / Pow(b, e2) >= Pow(b, e1 - e2) {
      assert x / Pow(b, e2) >= Pow(b, e1 - e2);
      assert x / Pow(b, e2) * Pow(b, e2) >= Pow(b, e1 - e2) * Pow(b, e2) by {
        LemmaMulInequality(Pow(b, e1 - e2), x / Pow(b, e2), Pow(b, e2));
      }
      assert x - x % Pow(b, e2) >= Pow(b, e1 - e2) * Pow(b, e2) by {
        LemmaFundamentalDivMod(x, Pow(b, e2));
        LemmaMulIsCommutativeAuto();
      }
      assert x - x % Pow(b, e2) >= Pow(b, e1) by {
        LemmaPowAdds(b, e1 - e2, e2);
      }
      assert x >= Pow(b, e1) by {
        LemmaModPropertiesAuto();
      }
    }
  }

  lemma LemmaPowDivisionInequalityAuto()
    ensures forall b: nat, e2: nat :: b > 0 ==> Pow(b, e2) > 0
    ensures forall x: nat, b: nat, e1: nat, e2: nat {:trigger x / Pow(b, e2), Pow(b, e1 - e2)} :: b > 0 && e2 <= e1 && x < Pow(b, e1) ==> x / Pow(b, e2) < Pow(b, e1 - e2)
  {
    LemmaPowPositiveAuto();
    forall x: nat, b: nat, e1: nat, e2: nat {:trigger x / Pow(b, e2), Pow(b, e1 - e2)} | b > 0 && e2 <= e1 && x < Pow(b, e1)
      ensures x / Pow(b, e2) < Pow(b, e1 - e2)
    {
      LemmaPowDivisionInequality(x, b, e1, e2);
    }
  }

  lemma {:induction false} LemmaPowMod(b: nat, e: nat)
    requires b > 0 && e > 0
    ensures Pow(b, e) % b == 0
  {
    calc {
      Pow(b, e) % b;
      b * Pow(b, e - 1) % b;
      {
        LemmaMulIsCommutative(b, Pow(b, e - 1));
      }
      Pow(b, e - 1) * b % b;
      {
        LemmaPowPositiveAuto();
        LemmaModMultiplesBasic(Pow(b, e - 1), b);
      }
      0;
    }
  }

  lemma LemmaPowModAuto()
    ensures forall b: nat, e: nat {:trigger Pow(b, e)} :: b > 0 && e > 0 ==> Pow(b, e) % b == 0
  {
    forall b: nat, e: nat {:trigger Pow(b, e)} | b > 0 && e > 0
      ensures Pow(b, e) % b == 0
    {
      LemmaPowMod(b, e);
    }
  }

  lemma LemmaPowModNoop(b: int, e: nat, m: int)
    requires m > 0
    ensures Pow(b % m, e) % m == Pow(b, e) % m
    decreases e
  {
    LemmaModPropertiesAuto();
    if e > 0 {
      calc {
        Pow(b % m, e) % m;
        b % m * Pow(b % m, e - 1) % m;
        {
          LemmaMulModNoopGeneral(b, Pow(b % m, e - 1), m);
        }
        b % m * (Pow(b % m, e - 1) % m) % m % m;
        {
          LemmaPowModNoop(b, e - 1, m);
        }
        b % m * (Pow(b, e - 1) % m) % m % m;
        {
          LemmaMulModNoopGeneral(b, Pow(b, e - 1), m);
        }
        b * Pow(b, e - 1) % m % m;
        b * Pow(b, e - 1) % m;
        Pow(b, e) % m;
      }
    }
  }

  lemma LemmaPowModNoopAuto()
    ensures forall b: nat, e: nat, m: nat {:trigger Pow(b % m, e)} :: m > 0 ==> Pow(b % m, e) % m == Pow(b, e) % m
  {
    forall b: nat, e: nat, m: nat {:trigger Pow(b % m, e)} | m > 0
      ensures Pow(b % m, e) % m == Pow(b, e) % m
    {
      LemmaPowModNoop(b, e, m);
    }
  }

  import opened DivMod

  import opened GeneralInternals

  import opened Mul

  import opened MulInternals
}

module {:disableNonlinearArithmetic} Std.Arithmetic.Power2 {
  function Pow2(e: nat): nat
    ensures Pow2(e) > 0
  {
    LemmaPowPositive(2, e);
    Pow(2, e)
  }

  lemma LemmaPow2(e: nat)
    ensures Pow2(e) == Pow(2, e)
  {
    if e != 0 {
      LemmaPow2(e - 1);
    }
  }

  lemma LemmaPow2Auto()
    ensures forall e: nat {:trigger Pow2(e)} :: Pow2(e) == Pow(2, e)
  {
    forall e: nat {:trigger Pow2(e)} | true
      ensures Pow2(e) == Pow(2, e)
    {
      LemmaPow2(e);
    }
  }

  lemma LemmaPow2MaskDiv2(e: nat)
    requires 0 < e
    ensures (Pow2(e) - 1) / 2 == Pow2(e - 1) - 1
  {
    LemmaPow2Auto();
    LemmaPowAuto();
    var f := e => 0 < e ==> (Pow2(e) - 1) / 2 == Pow2(e - 1) - 1;
    assert forall i {:trigger IsLe(0, i)} :: IsLe(0, i) && f(i) ==> f(i + 1);
    assert forall i {:trigger IsLe(i, 0)} :: IsLe(i, 0) && f(i) ==> f(i - 1);
    LemmaMulInductionAuto(e, f);
  }

  lemma LemmaPow2MaskDiv2Auto()
    ensures forall e: nat {:trigger Pow2(e)} :: 0 < e ==> (Pow2(e) - 1) / 2 == Pow2(e - 1) - 1
  {
    forall e: nat {:trigger Pow2(e)} | 0 < e
      ensures (Pow2(e) - 1) / 2 == Pow2(e - 1) - 1
    {
      LemmaPow2MaskDiv2(e);
    }
  }

  lemma Lemma2To64()
    ensures Pow2(0) == 1
    ensures Pow2(1) == 2
    ensures Pow2(2) == 4
    ensures Pow2(3) == 8
    ensures Pow2(4) == 16
    ensures Pow2(5) == 32
    ensures Pow2(6) == 64
    ensures Pow2(7) == 128
    ensures Pow2(8) == 256
    ensures Pow2(9) == 512
    ensures Pow2(10) == 1024
    ensures Pow2(11) == 2048
    ensures Pow2(12) == 4096
    ensures Pow2(13) == 8192
    ensures Pow2(14) == 16384
    ensures Pow2(15) == 32768
    ensures Pow2(16) == 65536
    ensures Pow2(17) == 131072
    ensures Pow2(18) == 262144
    ensures Pow2(19) == 524288
    ensures Pow2(20) == 1048576
    ensures Pow2(21) == 2097152
    ensures Pow2(22) == 4194304
    ensures Pow2(23) == 8388608
    ensures Pow2(24) == 16777216
    ensures Pow2(25) == 33554432
    ensures Pow2(26) == 67108864
    ensures Pow2(27) == 134217728
    ensures Pow2(28) == 268435456
    ensures Pow2(29) == 536870912
    ensures Pow2(30) == 1073741824
    ensures Pow2(31) == 2147483648
    ensures Pow2(32) == 4294967296
    ensures Pow2(64) == 18446744073709551616
  {
    assert Pow2(0) == 1;
    assert Pow2(8) == 256;
    assert Pow2(16) == 65536;
    assert Pow2(24) == 16777216;
    assert Pow2(32) == 4294967296;
    assert Pow(2, 32 + 32) == Pow(2, 32) * Pow(2, 32) by {
      LemmaPowAuto();
    }
  }

  import opened GeneralInternals

  import opened MulInternals

  import opened Power
}

module Std.Base64 {
  predicate IsBase64Char(c: char)
  {
    c == '+' || c == '/' || '0' <= c <= '9' || 'A' <= c <= 'Z' || 'a' <= c <= 'z'
  }

  lemma Base64CharIs7Bit(c: char)
    requires IsBase64Char(c)
    ensures c < 128 as char
  {
  }

  predicate IsUnpaddedBase64String(s: string)
  {
    |s| % 4 == 0 &&
    forall k :: 
      k in s ==>
        IsBase64Char(k)
  }

  function IndexToChar(i: index): (c: char)
    ensures IsBase64Char(c)
  {
    if i == 63 then
      '/'
    else if i == 62 then
      '+'
    else if 52 <= i <= 61 then
      (i - 4) as int as char
    else if 26 <= i <= 51 then
      i as int as char + 71 as char
    else
      i as int as char + 65 as char
  }

  lemma IndexToCharIsBase64(i: index)
    ensures IsBase64Char(IndexToChar(i))
  {
  }

  function CharToIndex(c: char): (i: index)
    requires IsBase64Char(c)
  {
    if c == '/' then
      63
    else if c == '+' then
      62
    else if '0' <= c <= '9' then
      (c + 4 as char) as int as index
    else if 'a' <= c <= 'z' then
      (c - 71 as char) as int as index
    else
      (c - 65 as char) as int as index
  }

  @ResourceLimit("2e6") @IsolateAssertions lemma CharToIndexToChar(c: char)
    requires IsBase64Char(c)
    ensures IndexToChar(CharToIndex(c)) == c
  {
    Base64CharIs7Bit(c);
    if c == '/' {
      assert IndexToChar(CharToIndex(c)) == c;
    } else if c == '+' {
      assert IndexToChar(CharToIndex(c)) == c;
    } else if '0' <= c <= '9' {
      assert IndexToChar(CharToIndex(c)) == c;
    } else if 'a' <= c < 'j' {
      assert IndexToChar(CharToIndex(c)) == c;
    } else if 'j' <= c < 'm' {
      assert IndexToChar(CharToIndex(c)) == c;
    } else if 'm' <= c <= 'z' {
      assert IndexToChar(CharToIndex(c)) == c;
    } else {
      assert IndexToChar(CharToIndex(c)) == c;
    }
  }

  @IsolateAssertions lemma IndexToCharToIndex(i: index)
    ensures (IndexToCharIsBase64(i); CharToIndex(IndexToChar(i)) == i)
  {
    IndexToCharIsBase64(i);
    if i == 63 {
      assert CharToIndex(IndexToChar(i)) == i;
    } else if i == 62 {
      assert CharToIndex(IndexToChar(i)) == i;
    } else if 52 <= i <= 61 {
      assert CharToIndex(IndexToChar(i)) == i;
    } else if 26 <= i <= 51 {
      assert CharToIndex(IndexToChar(i)) == i;
    } else {
      assert CharToIndex(IndexToChar(i)) == i;
    }
  }

  lemma IndexToCharToIndexAuto()
    ensures forall x :: (IndexToCharIsBase64(x); CharToIndex(IndexToChar(x)) == x)
  {
    forall x: index | true
      ensures (IndexToCharIsBase64(x); CharToIndex(IndexToChar(x)) == x)
    {
      IndexToCharToIndex(x);
    }
  }

  lemma CharToIndexToCharAuto()
    ensures forall c | IsBase64Char(c) :: IndexToChar(CharToIndex(c)) == c
  {
    forall c: char | IsBase64Char(c)
      ensures IndexToChar(CharToIndex(c)) == c
    {
      CharToIndexToChar(c);
    }
  }

  function BV24ToSeq(x: bv24): (ret: seq<bv8>)
    ensures |ret| == 3
  {
    var b0 := ((x >> 16) & 255) as bv8;
    var b1 := ((x >> 8) & 255) as bv8;
    var b2 := (x & 255) as bv8;
    [b0, b1, b2]
  }

  function SeqToBV24(x: seq<bv8>): (ret: bv24)
    requires |x| == 3
  {
    (x[0] as bv24 << 16) | (x[1] as bv24 << 8) | x[2] as bv24
  }

  lemma BV24ToSeqToBV24(x: bv24)
    ensures SeqToBV24(BV24ToSeq(x)) == x
  {
  }

  lemma SeqToBV24ToSeq(s: seq<bv8>)
    requires |s| == 3
    ensures BV24ToSeq(SeqToBV24(s)) == s
  {
  }

  function BV24ToIndexSeq(x: bv24): (ret: seq<index>)
    ensures |ret| == 4
  {
    var b0 := ((x >> 18) & 63) as index;
    var b1 := ((x >> 12) & 63) as index;
    var b2 := ((x >> 6) & 63) as index;
    var b3 := (x & 63) as index;
    [b0, b1, b2, b3]
  }

  function IndexSeqToBV24(x: seq<index>): (ret: bv24)
    requires |x| == 4
  {
    (x[0] as bv24 << 18) | (x[1] as bv24 << 12) | (x[2] as bv24 << 6) | x[3] as bv24
  }

  lemma BV24ToIndexSeqToBV24(x: bv24)
    ensures IndexSeqToBV24(BV24ToIndexSeq(x)) == x
  {
  }

  lemma IndexSeqToBV24ToIndexSeq(s: seq<index>)
    requires |s| == 4
    ensures BV24ToIndexSeq(IndexSeqToBV24(s)) == s
  {
  }

  function DecodeBlock(s: seq<index>): (ret: seq<bv8>)
    requires |s| == 4
    ensures |ret| == 3
  {
    BV24ToSeq(IndexSeqToBV24(s))
  }

  function EncodeBlock(s: seq<bv8>): (ret: seq<index>)
    requires |s| == 3
    ensures |ret| == 4
  {
    BV24ToIndexSeq(SeqToBV24(s))
  }

  lemma EncodeDecodeBlock(s: seq<bv8>)
    requires |s| == 3
    ensures DecodeBlock(EncodeBlock(s)) == s
  {
    var b := SeqToBV24(s);
    BV24ToIndexSeqToBV24(b);
    SeqToBV24ToSeq(s);
  }

  lemma DecodeEncodeBlock(s: seq<index>)
    requires |s| == 4
    ensures EncodeBlock(DecodeBlock(s)) == s
  {
    var b := IndexSeqToBV24(s);
    BV24ToSeqToBV24(b);
    IndexSeqToBV24ToIndexSeq(s);
  }

  @IsolateAssertions function DecodeRecursively(s: seq<index>): (b: seq<bv8>)
    requires |s| % 4 == 0
    decreases |s|
  {
    if |s| == 0 then
      []
    else
      DecodeBlock(s[..4]) + DecodeRecursively(s[4..])
  } by method {
    var resultLength := |s| / 4 * 3;
    var result := new bv8[resultLength] (i => 0);
    var i := |s|;
    var j := resultLength;
    while i > 0
      invariant i % 4 == 0
      invariant 0 <= i <= |s|
      invariant i * 3 == j * 4
      invariant 0 <= j <= resultLength
      invariant result[j..] == DecodeRecursively(s[i..])
    {
      i := i - 4;
      j := j - 3;
      var block := DecodeBlock(s[i .. i + 4]);
      result[j] := block[0];
      result[j + 1] := block[1];
      result[j + 2] := block[2];
      assert s[i..][..4] == s[i .. i + 4];
      assert s[i..][4..] == s[i + 4..];
      assert result[j .. j + 3] == block;
      calc {
        DecodeBlock(s[i .. i + 4]) + DecodeRecursively(s[i + 4..]);
        DecodeBlock(s[i..][..4]) + DecodeRecursively(s[i..][4..]);
        DecodeRecursively(s[i..]);
      }
    }
    b := result[..];
  }

  lemma DecodeRecursivelyBounds(s: seq<index>)
    requires |s| % 4 == 0
    ensures |DecodeRecursively(s)| == |s| / 4 * 3
    ensures |DecodeRecursively(s)| % 3 == 0
    ensures |DecodeRecursively(s)| == 0 ==> |s| == 0
  {
  }

  lemma DecodeRecursivelyBlock(s: seq<index>)
    requires |s| % 4 == 0
    ensures (DecodeRecursivelyBounds(s); var b := DecodeRecursively(s); |b| != 0 ==> EncodeBlock(b[..3]) == s[..4])
  {
    DecodeRecursivelyBounds(s);
    if |s| == 0 {
    } else {
      DecodeEncodeBlock(s[..4]);
    }
  }

  @IsolateAssertions function EncodeRecursively(b: seq<bv8>): (s: seq<index>)
    requires |b| % 3 == 0
  {
    if |b| == 0 then
      []
    else
      EncodeBlock(b[..3]) + EncodeRecursively(b[3..])
  } by method {
    var resultLength := |b| / 3 * 4;
    var result := new index[resultLength] (i => 0);
    var i := |b|;
    var j := resultLength;
    while i > 0
      invariant i % 3 == 0
      invariant 0 <= i <= |b|
      invariant i * 4 == j * 3
      invariant 0 <= j <= resultLength
      invariant result[j..] == EncodeRecursively(b[i..])
    {
      i := i - 3;
      j := j - 4;
      var block := EncodeBlock(b[i .. i + 3]);
      result[j] := block[0];
      result[j + 1] := block[1];
      result[j + 2] := block[2];
      result[j + 3] := block[3];
      assert b[i..][..3] == b[i .. i + 3];
      assert b[i..][3..] == b[i + 3..];
      assert result[j .. j + 4] == block;
      calc {
        EncodeBlock(b[i .. i + 3]) + EncodeRecursively(b[i + 3..]);
        EncodeBlock(b[i..][..3]) + EncodeRecursively(b[i..][3..]);
        EncodeRecursively(b[i..]);
      }
    }
    s := result[..];
  }

  lemma EncodeRecursivelyBounds(b: seq<bv8>)
    requires |b| % 3 == 0
    ensures |EncodeRecursively(b)| == |b| / 3 * 4
    ensures |EncodeRecursively(b)| % 4 == 0
    ensures |EncodeRecursively(b)| == 0 ==> |b| == 0
  {
  }

  lemma EncodeRecursivelyBlock(b: seq<bv8>)
    requires |b| % 3 == 0
    ensures (EncodeRecursivelyBounds(b); var s := EncodeRecursively(b); |s| != 0 ==> DecodeBlock(s[..4]) == b[..3])
  {
    EncodeRecursivelyBounds(b);
    if |b| == 0 {
    } else {
      EncodeDecodeBlock(b[..3]);
    }
  }

  lemma {:isolate_assertions} EncodeDecodeRecursively(b: seq<bv8>)
    requires |b| % 3 == 0
    ensures (EncodeRecursivelyBounds(b); DecodeRecursively(EncodeRecursively(b)) == b)
  {
    hide *;
    var s := EncodeRecursively(b);
    EncodeRecursivelyBounds(b);
    DecodeRecursivelyBounds(s);
    if |b| == 0 {
    } else {
      calc {
        DecodeRecursively(EncodeRecursively(b));
      ==
        DecodeRecursively(s);
      ==
        {
          assert |s[4..]| % 4 == 0;
          reveal DecodeRecursively;
        }
        DecodeBlock(s[..4]) + DecodeRecursively(s[4..]);
      ==
        {
          EncodeRecursivelyBlock(b);
        }
        b[..3] + DecodeRecursively(s[4..]);
      ==
        {
          reveal EncodeRecursively;
        }
        b[..3] + DecodeRecursively(EncodeRecursively(b[3..]));
      ==
        {
          EncodeDecodeRecursively(b[3..]);
        }
        b[..3] + b[3..];
      ==
        b;
      }
    }
  }

  lemma {:isolate_assertions} DecodeEncodeRecursively(s: seq<index>)
    requires |s| % 4 == 0
    ensures (DecodeRecursivelyBounds(s); EncodeRecursively(DecodeRecursively(s)) == s)
  {
    hide *;
    var b := DecodeRecursively(s);
    DecodeRecursivelyBounds(s);
    EncodeRecursivelyBounds(b);
    if |s| == 0 {
    } else {
      calc {
        EncodeRecursively(DecodeRecursively(s));
      ==
        EncodeRecursively(b);
      ==
        {
          reveal EncodeRecursively;
          assert |b[3..]| % 3 == 0;
        }
        EncodeBlock(b[..3]) + EncodeRecursively(b[3..]);
      ==
        {
          DecodeRecursivelyBlock(s);
        }
        s[..4] + EncodeRecursively(b[3..]);
      ==
        {
          reveal DecodeRecursively;
        }
        s[..4] + EncodeRecursively(DecodeRecursively(s[4..]));
      ==
        {
          DecodeEncodeRecursively(s[4..]);
        }
        s[..4] + s[4..];
      ==
        s;
      }
    }
  }

  function FromCharsToIndices(s: seq<char>): (b: seq<index>)
    requires forall k :: k in s ==> IsBase64Char(k)
    ensures |b| == |s|
  {
    seq(|s|, i requires 0 <= i < |s| => CharToIndex(s[i]))
  }

  function FromIndicesToChars(b: seq<index>): (s: seq<char>)
    ensures forall k :: k in s ==> IsBase64Char(k)
    ensures |s| == |b|
  {
    seq(|b|, i requires 0 <= i < |b| => IndexToChar(b[i]))
  }

  lemma FromCharsToIndicesToChars(s: seq<char>)
    requires forall k :: k in s ==> IsBase64Char(k)
    ensures FromIndicesToChars(FromCharsToIndices(s)) == s
  {
    CharToIndexToCharAuto();
  }

  lemma FromIndicesToCharsToIndices(b: seq<index>)
    ensures FromCharsToIndices(FromIndicesToChars(b)) == b
  {
    IndexToCharToIndexAuto();
  }

  function DecodeUnpadded(s: seq<char>): (b: seq<bv8>)
    requires IsUnpaddedBase64String(s)
  {
    DecodeRecursively(FromCharsToIndices(s))
  }

  lemma DecodeUnpaddedBounds(s: seq<char>)
    requires IsUnpaddedBase64String(s)
    ensures |DecodeUnpadded(s)| == |s| / 4 * 3
    ensures |DecodeUnpadded(s)| % 3 == 0
  {
    var indices := FromCharsToIndices(s);
    assert |indices| == |s|;
    DecodeRecursivelyBounds(indices);
  }

  function EncodeUnpadded(b: seq<bv8>): (s: seq<char>)
    requires |b| % 3 == 0
  {
    EncodeDecodeRecursively(b);
    FromIndicesToChars(EncodeRecursively(b))
  }

  lemma EncodeUnpaddedNotPadded(b: seq<bv8>)
    requires |b| % 3 == 0
    requires b != []
    ensures (EncodeUnpaddedBounds(b); var s := EncodeUnpadded(b); !Is1Padding(s[|s| - 4..]) && !Is2Padding(s[|s| - 4..]))
  {
    var s := EncodeUnpadded(b);
    EncodeUnpaddedBounds(b);
    var suffix := s[|s| - 4..];
    assert forall c :: c in s ==> IsBase64Char(c);
    assert IsBase64Char(s[|s| - 1]);
    assert s[|s| - 1] != '=';
  }

  lemma EncodeUnpaddedBounds(b: seq<bv8>)
    requires |b| % 3 == 0
    ensures |EncodeUnpadded(b)| == |b| / 3 * 4
    ensures |EncodeUnpadded(b)| % 4 == 0
  {
    EncodeRecursivelyBounds(b);
  }

  lemma EncodeUnpaddedBase64(b: seq<bv8>)
    requires |b| % 3 == 0
    ensures IsUnpaddedBase64String(EncodeUnpadded(b))
  {
    EncodeRecursivelyBounds(b);
  }

  lemma EncodeDecodeUnpadded(b: seq<bv8>)
    requires |b| % 3 == 0
    ensures (EncodeUnpaddedBounds(b); EncodeUnpaddedBase64(b); DecodeUnpadded(EncodeUnpadded(b)) == b)
  {
    EncodeUnpaddedBase64(b);
    calc {
      DecodeUnpadded(EncodeUnpadded(b));
    ==
      DecodeUnpadded(FromIndicesToChars(EncodeRecursively(b)));
    ==
      {
        EncodeRecursivelyBounds(b);
      }
      DecodeRecursively(FromCharsToIndices(FromIndicesToChars(EncodeRecursively(b))));
    ==
      {
        FromIndicesToCharsToIndices(EncodeRecursively(b));
      }
      DecodeRecursively(EncodeRecursively(b));
    ==
      {
        EncodeDecodeRecursively(b);
      }
      b;
    }
  }

  lemma DecodeEncodeUnpadded(s: seq<char>)
    requires |s| % 4 == 0
    requires IsUnpaddedBase64String(s)
    ensures (DecodeUnpaddedBounds(s); EncodeUnpadded(DecodeUnpadded(s)) == s)
  {
    DecodeUnpaddedBounds(s);
    var fromCharsToIndicesS := FromCharsToIndices(s);
    calc {
      EncodeUnpadded(DecodeUnpadded(s));
    ==
      EncodeUnpadded(DecodeRecursively(FromCharsToIndices(s)));
    ==
      EncodeUnpadded(DecodeRecursively(fromCharsToIndicesS));
    ==
      assert |fromCharsToIndicesS| % 4 == 0; FromIndicesToChars(EncodeRecursively(DecodeRecursively(fromCharsToIndicesS)));
    ==
      {
        DecodeEncodeRecursively(fromCharsToIndicesS);
      }
      FromIndicesToChars(fromCharsToIndicesS);
    ==
      FromIndicesToChars(FromCharsToIndices(s));
    ==
      {
        FromCharsToIndicesToChars(s);
      }
      s;
    }
  }

  predicate Is1Padding(s: seq<char>)
  {
    |s| == 4 &&
    IsBase64Char(s[0]) &&
    IsBase64Char(s[1]) &&
    IsBase64Char(s[2]) &&
    CharToIndex(s[2]) & 3 == 0 &&
    s[3] == '='
  }

  function Decode1Padding(s: seq<char>): (b: seq<bv8>)
    requires Is1Padding(s)
    ensures |b| == 2
  {
    var d := DecodeBlock([CharToIndex(s[0]), CharToIndex(s[1]), CharToIndex(s[2]), 0]);
    [d[0], d[1]]
  }

  function Encode1Padding(b: seq<bv8>): (s: seq<char>)
    requires |b| == 2
    ensures |s| % 4 == 0
    ensures |s| == 4
  {
    var e := EncodeBlock([b[0], b[1], 0]);
    IndexToCharIsBase64(e[0]);
    IndexToCharIsBase64(e[1]);
    IndexToCharIsBase64(e[2]);
    [IndexToChar(e[0]), IndexToChar(e[1]), IndexToChar(e[2]), '=']
  }

  lemma EncodeDecodeBlock1Padding(b: seq<bv8>)
    requires |b| == 2
    ensures var e := EncodeBlock([b[0], b[1], 0]); var d := DecodeBlock([e[0], e[1], e[2], 0]); [d[0], d[1]] == b
  {
  }

  lemma {:resource_limit 0} Encode1PaddingIs1Padding(b: seq<bv8>)
    requires |b| == 2
    ensures Is1Padding(Encode1Padding(b))
  {
    hide *;
    var s := Encode1Padding(b);
    var e := EncodeBlock([b[0], b[1], 0]);
    reveal Encode1Padding;
    assert s == [IndexToChar(e[0]), IndexToChar(e[1]), IndexToChar(e[2]), '='] by {
    }
    IndexToCharIsBase64(e[0]);
    IndexToCharIsBase64(e[1]);
    IndexToCharIsBase64(e[2]);
    reveal Encode1Padding, EncodeBlock, IndexToChar, CharToIndex, BV24ToIndexSeq, SeqToBV24;
    assert CharToIndex(s[2]) & 3 == 0 by {
    }
    assert Is1Padding(s) by {
      reveal Is1Padding;
    }
  }

  lemma EncodeDecode1Padding(b: seq<bv8>)
    requires |b| == 2
    ensures (Encode1PaddingIs1Padding(b); Decode1Padding(Encode1Padding(b)) == b)
  {
    Encode1PaddingIs1Padding(b);
    var e := EncodeBlock([b[0], b[1], 0]);
    var s := [CharToIndex(IndexToChar(e[0])), CharToIndex(IndexToChar(e[1])), CharToIndex(IndexToChar(e[2])), 0];
    var s' := [e[0], e[1], e[2], 0];
    var d := DecodeBlock(s);
    var d' := DecodeBlock(s');
    calc {
      Decode1Padding(Encode1Padding(b));
    ==
      Decode1Padding([IndexToChar(e[0]), IndexToChar(e[1]), IndexToChar(e[2]), '=']);
    ==
      [d[0], d[1]];
    ==
      {
        IndexToCharToIndex(e[0]);
        IndexToCharToIndex(e[1]);
        IndexToCharToIndex(e[2]);
      }
      [d'[0], d'[1]];
    ==
      {
        EncodeDecodeBlock1Padding(b);
      }
      b;
    }
  }

  @IsolateAssertions lemma DecodeEncode1Padding(s: seq<char>)
    requires Is1Padding(s)
    ensures Encode1Padding(Decode1Padding(s)) == s
  {
    var i := [CharToIndex(s[0]), CharToIndex(s[1]), CharToIndex(s[2]), 0];
    var d := DecodeBlock(i);
    var e := EncodeBlock([d[0], d[1], 0]);
    var d' := [IndexToChar(e[0]), IndexToChar(e[1]), IndexToChar(e[2]), '='];
    calc {
      Encode1Padding(Decode1Padding(s));
    ==
      Encode1Padding([d[0], d[1]]);
    ==
      d';
    ==
      {
        assert d'[0] == IndexToChar(CharToIndex(s[0]));
        assert d'[1] == IndexToChar(CharToIndex(s[1]));
        assert d'[2] == IndexToChar(CharToIndex(s[2]));
      }
      [IndexToChar(CharToIndex(s[0])), IndexToChar(CharToIndex(s[1])), IndexToChar(CharToIndex(s[2])), '='];
    ==
      {
        CharToIndexToChar(s[0]);
        CharToIndexToChar(s[1]);
        CharToIndexToChar(s[2]);
      }
      s;
    }
  }

  predicate Is2Padding(s: seq<char>)
  {
    |s| == 4 &&
    IsBase64Char(s[0]) &&
    IsBase64Char(s[1]) &&
    CharToIndex(s[1]) % 16 == 0 &&
    s[2] == '=' &&
    s[3] == '='
  }

  function Decode2Padding(s: seq<char>): (b: seq<bv8>)
    requires Is2Padding(s)
    ensures |b| == 1
  {
    var d := DecodeBlock([CharToIndex(s[0]), CharToIndex(s[1]), 0, 0]);
    [d[0]]
  }

  function Encode2Padding(b: seq<bv8>): (s: seq<char>)
    requires |b| == 1
    ensures |s| % 4 == 0
    ensures |s| == 4
  {
    var e := EncodeBlock([b[0], 0, 0]);
    IndexToCharIsBase64(e[0]);
    IndexToCharIsBase64(e[1]);
    [IndexToChar(e[0]), IndexToChar(e[1]), '=', '=']
  }

  lemma Encode2PaddingIs2Padding(b: seq<bv8>)
    requires |b| == 1
    ensures Is2Padding(Encode2Padding(b))
  {
  }

  lemma DecodeEncodeBlock2Padding(b: seq<bv8>)
    requires |b| == 1
    ensures var e := EncodeBlock([b[0], 0, 0]); var d := DecodeBlock([e[0], e[1], 0, 0]); [d[0]] == b
  {
  }

  lemma EncodeDecode2Padding(b: seq<bv8>)
    requires |b| == 1
    ensures (Encode2PaddingIs2Padding(b); Decode2Padding(Encode2Padding(b)) == b)
  {
    Encode2PaddingIs2Padding(b);
    var e := EncodeBlock([b[0], 0, 0]);
    calc {
      Decode2Padding(Encode2Padding(b));
    ==
      Decode2Padding([IndexToChar(e[0]), IndexToChar(e[1]), '=', '=']);
    ==
      [DecodeBlock([CharToIndex(IndexToChar(e[0])), CharToIndex(IndexToChar(e[1])), 0, 0])[0]];
    ==
      {
        IndexToCharToIndex(e[0]);
        IndexToCharToIndex(e[1]);
      }
      [DecodeBlock([e[0], e[1], 0, 0])[0]];
    ==
      {
        DecodeEncodeBlock2Padding(b);
      }
      b;
    }
  }

  lemma DecodeEncode2Padding(s: seq<char>)
    requires Is2Padding(s)
    ensures Encode2Padding(Decode2Padding(s)) == s
  {
    var i := [CharToIndex(s[0]), CharToIndex(s[1]), 0, 0];
    var d := DecodeBlock(i);
    var e := EncodeBlock([d[0], 0, 0]);
    var d' := [IndexToChar(e[0]), IndexToChar(e[1]), '=', '='];
    calc {
      Encode2Padding(Decode2Padding(s));
    ==
      Encode2Padding([d[0]]);
    ==
      d';
    ==
      {
      }
      [IndexToChar(CharToIndex(s[0])), IndexToChar(CharToIndex(s[1])), '=', '='];
    ==
      {
        CharToIndexToChar(s[0]);
        CharToIndexToChar(s[1]);
      }
      s;
    }
  }

  predicate IsBase64String(s: string)
  {
    var finalBlockStart := |s| - 4;
    |s| % 4 == 0 &&
    (IsUnpaddedBase64String(s) || (IsUnpaddedBase64String(s[..finalBlockStart]) && (Is1Padding(s[finalBlockStart..]) || Is2Padding(s[finalBlockStart..]))))
  }

  function DecodeValid(s: seq<char>): (b: seq<bv8>)
    requires IsBase64String(s)
  {
    if s == [] then
      []
    else
      var finalBlockStart := |s| - 4; var prefix, suffix := s[..finalBlockStart], s[finalBlockStart..]; if Is1Padding(suffix) then DecodeUnpadded(prefix) + Decode1Padding(suffix) else if Is2Padding(suffix) then DecodeUnpadded(prefix) + Decode2Padding(suffix) else DecodeUnpadded(s)
  }

  lemma AboutDecodeValid(s: seq<char>, b: seq<bv8>)
    requires IsBase64String(s) && b == DecodeValid(s)
    ensures 4 <= |s| ==> var finalBlockStart := |s| - 4; var prefix, suffix := s[..finalBlockStart], s[finalBlockStart..]; (Is1Padding(suffix) && IsUnpaddedBase64String(prefix) <==> |b| % 3 == 2 && |b| > 1) && (Is2Padding(suffix) && IsUnpaddedBase64String(prefix) <==> |b| % 3 == 1 && |b| > 0) && (!Is1Padding(suffix) && !Is2Padding(suffix) && IsUnpaddedBase64String(s) <==> |b| % 3 == 0 && |b| > 1)
  {
    if 4 <= |s| {
      var finalBlockStart := |s| - 4;
      var prefix, suffix := s[..finalBlockStart], s[finalBlockStart..];
      if s == [] {
      } else if Is1Padding(suffix) {
        assert !Is2Padding(suffix) by {
        }
        var x, y := DecodeUnpadded(prefix), Decode1Padding(suffix);
        assert b == x + y;
        assert |x| == |x| / 3 * 3 && |y| == 2 && |b| > 1 by {
          DecodeUnpaddedBounds(prefix);
        }
        Mod3(|x| / 3, |y|, |b|);
      } else if Is2Padding(suffix) {
        var x, y := DecodeUnpadded(prefix), Decode2Padding(suffix);
        assert b == x + y;
        assert |x| == |x| / 3 * 3 && |y| == 1 && |b| > 0 by {
          DecodeUnpaddedBounds(prefix);
        }
        Mod3(|x| / 3, |y|, |b|);
      } else {
        assert b == DecodeUnpadded(s);
        assert |b| % 3 == 0 && |b| > 1 by {
          DecodeUnpaddedBounds(s);
        }
      }
    }
  }

  lemma Mod3(x: nat, k: nat, n: nat)
    requires k < 3 && n == 3 * x + k
    ensures n % 3 == k
  {
  }

  function DecodeBV(s: seq<char>): (b: Result<seq<bv8>, string>)
    ensures IsBase64String(s) ==> b.Success?
  {
    if IsBase64String(s) then
      Success(DecodeValid(s))
    else
      Failure("The encoding is malformed")
  }

  lemma DecodeBVFailure(s: seq<char>)
    ensures !IsBase64String(s) ==> DecodeBV(s).Failure?
  {
  }

  ghost predicate StringIs7Bit(s: string)
  {
    forall c :: 
      c in s ==>
        c < 128 as char
  }

  lemma UnpaddedBase64StringIs7Bit(s: string)
    requires IsUnpaddedBase64String(s)
    ensures StringIs7Bit(s)
  {
  }

  lemma Is7Bit1Padding(s: string)
    requires Is1Padding(s)
    ensures StringIs7Bit(s)
  {
  }

  lemma Is7Bit2Padding(s: string)
    requires Is2Padding(s)
    ensures StringIs7Bit(s)
  {
  }

  function EncodeBV(b: seq<bv8>): (s: seq<char>)
  {
    if |b| % 3 == 0 then
      EncodeUnpaddedBounds(b);
      EncodeUnpadded(b)
    else if |b| % 3 == 1 then
      assert |b| >= 1;
      EncodeUnpaddedBounds(b[..|b| - 1]);
      var s1, s2 := EncodeUnpadded(b[..|b| - 1]), Encode2Padding(b[|b| - 1..]);
      s1 + s2
    else
      assert |b| % 3 == 2; assert |b| >= 2; EncodeUnpaddedBounds(b[..|b| - 2]); var s1, s2 := EncodeUnpadded(b[..|b| - 2]), Encode1Padding(b[|b| - 2..]); s1 + s2
  }

  lemma EncodeBVIsUnpadded(b: seq<bv8>)
    requires |b| % 3 == 0
    ensures EncodeBV(b) == EncodeUnpadded(b)
  {
  }

  lemma EncodeBVIs2Padded(b: seq<bv8>)
    requires |b| % 3 == 1
    ensures EncodeBV(b) == EncodeUnpadded(b[..|b| - 1]) + Encode2Padding(b[|b| - 1..])
  {
  }

  lemma EncodeBVIs1Padded(b: seq<bv8>)
    requires |b| % 3 == 2
    ensures EncodeBV(b) == EncodeUnpadded(b[..|b| - 2]) + Encode1Padding(b[|b| - 2..])
  {
  }

  lemma EncodeBVLengthCongruentToZeroMod4(b: seq<bv8>)
    ensures |EncodeBV(b)| % 4 == 0
  {
    if |b| % 3 == 0 {
      EncodeUnpaddedBounds(b);
    } else if |b| % 3 == 1 {
      EncodeUnpaddedBounds(b[..|b| - 1]);
    } else {
      EncodeUnpaddedBounds(b[..|b| - 2]);
    }
  }

  lemma EncodeBVIsBase64(b: seq<bv8>)
    ensures IsBase64String(EncodeBV(b))
  {
    EncodeBVLengthExact(b);
    if |EncodeBV(b)| < 4 {
    } else if |b| % 3 == 0 {
      EncodeUnpaddedBase64(b);
    } else if |b| % 3 == 1 {
      var bStart := b[..|b| - 1];
      var bEnd := b[|b| - 1..];
      EncodeUnpaddedBase64(bStart);
      Encode2PaddingIs2Padding(bEnd);
    } else {
      var bStart := b[..|b| - 2];
      var bEnd := b[|b| - 2..];
      EncodeUnpaddedBase64(bStart);
      Encode1PaddingIs1Padding(bEnd);
    }
  }

  lemma EncodeBVLengthExact(b: seq<bv8>)
    ensures var s := EncodeBV(b); (|b| % 3 == 0 ==> |s| == |b| / 3 * 4) && (|b| % 3 != 0 ==> |s| == |b| / 3 * 4 + 4)
  {
    var s := EncodeBV(b);
    if |b| % 3 == 0 {
      assert s == EncodeUnpadded(b);
      EncodeUnpaddedBounds(b);
      assert |s| == |b| / 3 * 4;
    } else if |b| % 3 == 1 {
      EncodeUnpaddedBounds(b[..|b| - 1]);
      assert s == EncodeUnpadded(b[..|b| - 1]) + Encode2Padding(b[|b| - 1..]);
      calc {
        |s|;
      ==
        |EncodeUnpadded(b[..|b| - 1])| + |Encode2Padding(b[|b| - 1..])|;
      ==
        {
          assert |Encode2Padding(b[|b| - 1..])| == 4;
        }
        |EncodeUnpadded(b[..|b| - 1])| + 4;
      ==
        {
          assert |EncodeUnpadded(b[..|b| - 1])| == |b[..|b| - 1]| / 3 * 4;
        }
        |b[..|b| - 1]| / 3 * 4 + 4;
      ==
        {
          assert |b[..|b| - 1]| == |b| - 1;
        }
        (|b| - 1) / 3 * 4 + 4;
      ==
        {
          assert (|b| - 1) / 3 == |b| / 3;
        }
        |b| / 3 * 4 + 4;
      }
    } else {
      EncodeUnpaddedBounds(b[..|b| - 2]);
      assert s == EncodeUnpadded(b[..|b| - 2]) + Encode1Padding(b[|b| - 2..]);
      Encode1PaddingIs1Padding(b[|b| - 2..]);
      calc {
        |s|;
      ==
        |EncodeUnpadded(b[..|b| - 2])| + |Encode1Padding(b[|b| - 2..])|;
      ==
        {
          assert |Encode1Padding(b[|b| - 2..])| == 4;
        }
        |EncodeUnpadded(b[..|b| - 2])| + 4;
      ==
        {
          assert |EncodeUnpadded(b[..|b| - 2])| == |b[..|b| - 2]| / 3 * 4;
        }
        |b[..|b| - 2]| / 3 * 4 + 4;
      ==
        {
          assert |b[..|b| - 2]| == |b| - 2;
        }
        (|b| - 2) / 3 * 4 + 4;
      ==
        {
          assert (|b| - 2) / 3 == |b| / 3;
        }
        |b| / 3 * 4 + 4;
      }
    }
  }

  lemma EncodeBVLengthBound(b: seq<bv8>)
    ensures var s := EncodeBV(b); |s| <= |b| / 3 * 4 + 4
  {
    EncodeBVLengthExact(b);
  }

  lemma SeqPartsMakeWhole<T>(s: seq<T>, i: nat)
    requires i <= |s|
    ensures s[..i] + s[i..] == s
  {
  }

  lemma DecodeValidEncodeEmpty(s: seq<char>)
    requires s == []
    ensures EncodeBV(DecodeValid(s)) == s
  {
    assert IsBase64String(s) by {
    }
    var b := DecodeValid(s);
    assert b == [];
    assert EncodeBV(b) == [] by {
    }
  }

  lemma EncodeDecodeValidEmpty(b: seq<bv8>)
    requires b == []
    ensures (EncodeBVIsBase64(b); DecodeValid(EncodeBV(b)) == b)
  {
    assert EncodeBV(b) == [] by {
    }
    EncodeBVIsBase64(b);
    assert DecodeValid([]) == [] by {
    }
  }

  lemma DecodeValidEncodeUnpadded(s: seq<char>)
    requires IsBase64String(s)
    requires |s| >= 4
    requires !Is1Padding(s[|s| - 4..])
    requires !Is2Padding(s[|s| - 4..])
    ensures EncodeBV(DecodeValid(s)) == s
  {
    DecodeUnpaddedBounds(s);
    calc {
      EncodeBV(DecodeValid(s));
    ==
      EncodeBV(DecodeUnpadded(s));
    ==
      EncodeUnpadded(DecodeUnpadded(s));
    ==
      {
        DecodeEncodeUnpadded(s);
      }
      s;
    }
  }

  lemma EncodeDecodeValidUnpadded(b: seq<bv8>)
    requires |b| % 3 == 0
    requires b != []
    ensures var s := EncodeBV(b); IsUnpaddedBase64String(s) && |s| >= 4 && !Is1Padding(s[|s| - 4..]) && !Is2Padding(s[|s| - 4..]) && s == EncodeUnpadded(b)
  {
    EncodeUnpaddedBase64(b);
    EncodeUnpaddedBounds(b);
    var s := EncodeBV(b);
    assert s == EncodeUnpadded(b) by {
      EncodeBVIsUnpadded(b);
    }
    assert !Is1Padding(s[|s| - 4..]) by {
      EncodeUnpaddedNotPadded(b);
    }
    assert !Is2Padding(s[|s| - 4..]) by {
      EncodeUnpaddedNotPadded(b);
    }
  }

  lemma {:resource_limit "6e6"} EncodeDecodeValid2Padded(b: seq<bv8>)
    requires |b| % 3 == 1
    ensures var s := EncodeBV(b); s == EncodeUnpadded(b[..|b| - 1]) + Encode2Padding(b[|b| - 1..]) && Is2Padding(s[|s| - 4..])
  {
    hide *;
    reveal EncodeBV;
    EncodeUnpaddedBase64(b[..|b| - 1]);
    EncodeUnpaddedBounds(b[..|b| - 1]);
    var s := EncodeBV(b);
    Encode2PaddingIs2Padding(b[|b| - 1..]);
    assert Is2Padding(s[|s| - 4..]);
  }

  lemma EncodeDecodeValid1Padded(b: seq<bv8>)
    requires |b| % 3 == 2
    ensures var s := EncodeBV(b); s == EncodeUnpadded(b[..|b| - 2]) + Encode1Padding(b[|b| - 2..]) && |s| >= 4 && IsUnpaddedBase64String(s[..|s| - 4]) && Is1Padding(s[|s| - 4..])
  {
    EncodeUnpaddedBase64(b[..|b| - 2]);
    EncodeUnpaddedBounds(b[..|b| - 2]);
    var s := EncodeBV(b);
    Encode1PaddingIs1Padding(b[|b| - 2..]);
    assert Is1Padding(s[|s| - 4..]);
  }

  lemma DecodeValidUnpaddedPartialFrom1PaddedSeq(s: seq<char>)
    requires IsBase64String(s)
    requires |s| >= 4
    requires Is1Padding(s[|s| - 4..])
    ensures DecodeValid(s)[..|DecodeValid(s)| - 2] == DecodeUnpadded(s[..|s| - 4])
  {
  }

  lemma DecodeValid1PaddedPartialFrom1PaddedSeq(s: seq<char>)
    requires IsBase64String(s)
    requires |s| >= 4
    requires Is1Padding(s[|s| - 4..])
    ensures DecodeValid(s)[|DecodeValid(s)| - 2..] == Decode1Padding(s[|s| - 4..])
  {
  }

  lemma DecodeValid1PaddingLengthMod3(s: seq<char>)
    requires IsBase64String(s)
    requires |s| >= 4
    requires Is1Padding(s[|s| - 4..])
    ensures |DecodeValid(s)| % 3 == 2
  {
    assert IsUnpaddedBase64String(s[..|s| - 4]) by {
      UnpaddedBase64Prefix(s);
    }
    AboutDecodeValid(s, DecodeValid(s));
  }

  @ResourceLimit("12e6") lemma DecodeValidEncode1Padding(s: seq<char>)
    requires IsBase64String(s)
    requires |s| >= 4
    requires Is1Padding(s[|s| - 4..])
    ensures EncodeBV(DecodeValid(s)) == s
  {
    assert |DecodeValid(s)| % 3 == 2 by {
      DecodeValid1PaddingLengthMod3(s);
    }
    calc {
      EncodeBV(DecodeValid(s));
    ==
      EncodeUnpadded(DecodeValid(s)[..|DecodeValid(s)| - 2]) + Encode1Padding(DecodeValid(s)[|DecodeValid(s)| - 2..]);
    ==
      {
        DecodeValidUnpaddedPartialFrom1PaddedSeq(s);
      }
      EncodeUnpadded(DecodeUnpadded(s[..|s| - 4])) + Encode1Padding(DecodeValid(s)[|DecodeValid(s)| - 2..]);
    ==
      {
        DecodeEncodeUnpadded(s[..|s| - 4]);
      }
      s[..|s| - 4] + Encode1Padding(DecodeValid(s)[|DecodeValid(s)| - 2..]);
    ==
      {
        DecodeValid1PaddedPartialFrom1PaddedSeq(s);
      }
      s[..|s| - 4] + Encode1Padding(Decode1Padding(s[|s| - 4..]));
    ==
      {
        DecodeEncode1Padding(s[|s| - 4..]);
      }
      s[..|s| - 4] + s[|s| - 4..];
    ==
      {
        SeqPartsMakeWhole(s, |s| - 4);
      }
      s;
    }
  }

  lemma DecodeValidPartialsFrom2PaddedSeq(s: seq<char>)
    requires IsBase64String(s)
    requires |s| >= 4
    requires Is2Padding(s[|s| - 4..])
    ensures var b := DecodeValid(s); b[..|b| - 1] == DecodeUnpadded(s[..|s| - 4]) && b[|b| - 1..] == Decode2Padding(s[|s| - 4..])
  {
    AboutDecodeValid(s, DecodeValid(s));
    assert Is2Padding(s[|s| - 4..]);
  }

  lemma DecodeValidPartialsFrom1PaddedSeq(s: seq<char>)
    requires IsBase64String(s)
    requires |s| >= 4
    requires Is1Padding(s[|s| - 4..])
    ensures var b := DecodeValid(s); b[..|b| - 2] == DecodeUnpadded(s[..|s| - 4]) && b[|b| - 2..] == Decode1Padding(s[|s| - 4..])
  {
    AboutDecodeValid(s, DecodeValid(s));
  }

  lemma UnpaddedBase64Prefix(s: string)
    requires IsBase64String(s)
    requires |s| >= 4
    ensures IsUnpaddedBase64String(s[..|s| - 4])
  {
  }

  lemma DecodeValid2PaddingLengthMod3(s: seq<char>)
    requires IsBase64String(s)
    requires |s| >= 4
    requires Is2Padding(s[|s| - 4..])
    ensures |DecodeValid(s)| % 3 == 1
  {
    assert IsUnpaddedBase64String(s[..|s| - 4]) by {
      UnpaddedBase64Prefix(s);
    }
    AboutDecodeValid(s, DecodeValid(s));
  }

  lemma DecodeValidEncode2Padding(s: seq<char>)
    requires IsBase64String(s)
    requires |s| >= 4
    requires Is2Padding(s[|s| - 4..])
    ensures EncodeBV(DecodeValid(s)) == s
  {
    assert |DecodeValid(s)| % 3 == 1 by {
      DecodeValid2PaddingLengthMod3(s);
    }
    calc {
      EncodeBV(DecodeValid(s));
    ==
      EncodeUnpadded(DecodeValid(s)[..|DecodeValid(s)| - 1]) + Encode2Padding(DecodeValid(s)[|DecodeValid(s)| - 1..]);
    ==
      {
        DecodeValidPartialsFrom2PaddedSeq(s);
      }
      EncodeUnpadded(DecodeUnpadded(s[..|s| - 4])) + Encode2Padding(DecodeValid(s)[|DecodeValid(s)| - 1..]);
    ==
      {
        DecodeEncodeUnpadded(s[..|s| - 4]);
      }
      s[..|s| - 4] + Encode2Padding(DecodeValid(s)[|DecodeValid(s)| - 1..]);
    ==
      {
        DecodeValidPartialsFrom2PaddedSeq(s);
      }
      s[..|s| - 4] + Encode2Padding(Decode2Padding(s[|s| - 4..]));
    ==
      {
        DecodeEncode2Padding(s[|s| - 4..]);
      }
      s[..|s| - 4] + s[|s| - 4..];
    ==
      {
        SeqPartsMakeWhole(s, |s| - 4);
      }
      s;
    }
  }

  lemma DecodeValidEncode(s: seq<char>)
    requires IsBase64String(s)
    ensures EncodeBV(DecodeValid(s)) == s
  {
    if s == [] {
      calc {
        EncodeBV(DecodeValid(s));
      ==
        {
          DecodeValidEncodeEmpty(s);
        }
        s;
      }
    } else if |s| >= 4 && Is1Padding(s[|s| - 4..]) {
      calc {
        EncodeBV(DecodeValid(s));
      ==
        {
          DecodeValidEncode1Padding(s);
        }
        s;
      }
    } else if |s| >= 4 && Is2Padding(s[|s| - 4..]) {
      calc {
        EncodeBV(DecodeValid(s));
      ==
        {
          DecodeValidEncode2Padding(s);
        }
        s;
      }
    } else {
      calc {
        EncodeBV(DecodeValid(s));
      ==
        {
          DecodeValidEncodeUnpadded(s);
        }
        s;
      }
    }
  }

  lemma EncodeDecodeValid(b: seq<bv8>)
    ensures (EncodeBVIsBase64(b); DecodeValid(EncodeBV(b)) == b)
  {
    hide *;
    EncodeBVIsBase64(b);
    var s := EncodeBV(b);
    if b == [] {
      calc {
        DecodeValid(EncodeBV(b));
      ==
        {
          EncodeDecodeValidEmpty(b);
        }
        b;
      }
    } else if |b| % 3 == 0 {
      calc {
        DecodeValid(EncodeBV(b));
      ==
        {
          EncodeBVIsUnpadded(b);
        }
        DecodeValid(EncodeUnpadded(b));
      ==
        {
          reveal DecodeValid;
          EncodeDecodeValidUnpadded(b);
        }
        DecodeUnpadded(EncodeUnpadded(b));
      ==
        {
          EncodeDecodeUnpadded(b);
        }
        b;
      }
    } else if |b| % 3 == 1 {
      EncodeDecodeValid2Padded(b);
      var prefix := b[..|b| - 1];
      var suffix := b[|b| - 1..];
      EncodeUnpaddedBase64(prefix);
      calc {
        DecodeValid(EncodeBV(b));
      ==
        DecodeValid(EncodeUnpadded(prefix) + Encode2Padding(suffix));
      ==
        {
          DecodeValidPartialsFrom2PaddedSeq(s);
        }
        DecodeUnpadded(EncodeUnpadded(prefix)) + Decode2Padding(Encode2Padding(suffix));
      ==
        {
          EncodeDecodeUnpadded(prefix);
          EncodeDecode2Padding(suffix);
        }
        prefix + suffix;
      ==
        b;
      }
    } else if |b| % 3 == 2 {
      EncodeDecodeValid1Padded(b);
      var prefix := b[..|b| - 2];
      var suffix := b[|b| - 2..];
      EncodeUnpaddedBase64(prefix);
      calc {
        DecodeValid(EncodeBV(b));
      ==
        DecodeValid(EncodeUnpadded(prefix) + Encode1Padding(suffix));
      ==
        {
          DecodeValidPartialsFrom1PaddedSeq(s);
        }
        DecodeUnpadded(EncodeUnpadded(prefix)) + Decode1Padding(Encode1Padding(suffix));
      ==
        {
          EncodeDecodeUnpadded(prefix);
          EncodeDecode1Padding(suffix);
        }
        prefix + suffix;
      ==
        b;
      }
    }
  }

  lemma DecodeEncodeBV(s: seq<char>)
    requires IsBase64String(s)
    ensures EncodeBV(DecodeBV(s).value) == s
  {
    calc {
      EncodeBV(DecodeBV(s).value);
    ==
      {
        DecodeValidEncode(s);
      }
      s;
    }
  }

  lemma EncodeDecodeBV(b: seq<bv8>)
    ensures DecodeBV(EncodeBV(b)) == Success(b)
  {
    EncodeBVIsBase64(b);
    calc {
      DecodeBV(EncodeBV(b));
    ==
      {
        assert IsBase64String(EncodeBV(b));
      }
      Success(DecodeValid(EncodeBV(b)));
    ==
      {
        EncodeDecodeValid(b);
      }
      Success(b);
    }
  }

  function UInt8sToBVs(u: seq<uint8>): (r: seq<bv8>)
    ensures |r| == |u|
    ensures forall i :: 0 <= i < |u| ==> r[i] == u[i] as bv8
  {
    seq(|u|, i requires 0 <= i < |u| => u[i] as bv8)
  }

  function BVsToUInt8s(b: seq<bv8>): (r: seq<uint8>)
    ensures |r| == |b|
    ensures forall i :: 0 <= i < |b| ==> r[i] == b[i] as uint8
  {
    seq(|b|, i requires 0 <= i < |b| => b[i] as uint8)
  }

  @IsolateAssertions @ResourceLimit("1e9") lemma UInt8sToBVsToUInt8s(u: seq<uint8>)
    ensures BVsToUInt8s(UInt8sToBVs(u)) == u
  {
    var b := UInt8sToBVs(u);
    assert |b| == |u|;
    var u' := BVsToUInt8s(b);
    assert |u'| == |b|;
  }

  lemma BVsToUInt8sToBVs(b: seq<bv8>)
    ensures UInt8sToBVs(BVsToUInt8s(b)) == b
  {
    var u := BVsToUInt8s(b);
    assert |b| == |u|;
    var b' := UInt8sToBVs(u);
    assert |b'| == |u|;
  }

  function Encode(u: seq<uint8>): seq<char>
  {
    EncodeBV(UInt8sToBVs(u))
  }

  function Decode(s: seq<char>): (b: Result<seq<uint8>, string>)
    ensures IsBase64String(s) ==> b.Success?
  {
    if IsBase64String(s) then
      var b := DecodeValid(s);
      Success(BVsToUInt8s(b))
    else
      Failure("The encoding is malformed")
  }

  lemma EncodeDecode(b: seq<uint8>)
    ensures Decode(Encode(b)) == Success(b)
  {
    var bvs := UInt8sToBVs(b);
    var s := EncodeBV(bvs);
    assert Encode(b) == s;
    assert IsBase64String(s) by {
      EncodeBVIsBase64(bvs);
    }
    var b' := DecodeValid(s);
    assert b' == bvs by {
      EncodeDecodeValid(bvs);
    }
    var us := BVsToUInt8s(b');
    assert Decode(s) == Success(us) by {
    }
    assert b' == bvs;
    assert b == us by {
      UInt8sToBVsToUInt8s(b);
    }
  }

  lemma DecodeEncode(s: seq<char>)
    requires IsBase64String(s)
    ensures Encode(Decode(s).value) == s
  {
    var b := DecodeValid(s);
    var u := BVsToUInt8s(b);
    assert Decode(s) == Success(u);
    var s' := EncodeBV(UInt8sToBVs(u));
    assert s' == Encode(u);
    assert UInt8sToBVs(BVsToUInt8s(b)) == b by {
      BVsToUInt8sToBVs(b);
    }
    assert s == s' by {
      DecodeValidEncode(s);
    }
  }

  import opened Wrappers

  import opened BoundedInts

  export
    reveals IsBase64Char, index, CharToIndex, IndexToChar, IsBase64String, IsUnpaddedBase64String, Is1Padding, Is2Padding
    provides Encode, Decode, EncodeBV, DecodeBV, EncodeDecode, DecodeEncode, EncodeDecodeBV, DecodeEncodeBV, BoundedInts, Wrappers


  export Internals
    reveals *


  type index = bv6
}

module Std.BoundedInts {
  const TWO_TO_THE_0: int := 1
  const TWO_TO_THE_1: int := 2
  const TWO_TO_THE_2: int := 4
  const TWO_TO_THE_4: int := 16
  const TWO_TO_THE_5: int := 32
  const TWO_TO_THE_7: int := 128
  const TWO_TO_THE_8: int := 256
  const TWO_TO_THE_15: int := 32768
  const TWO_TO_THE_16: int := 65536
  const TWO_TO_THE_24: int := 16777216
  const TWO_TO_THE_31: int := 2147483648
  const TWO_TO_THE_32: int := 4294967296
  const TWO_TO_THE_40: int := 1099511627776
  const TWO_TO_THE_48: int := 281474976710656
  const TWO_TO_THE_56: int := 72057594037927936
  const TWO_TO_THE_63: int := 9223372036854775808
  const TWO_TO_THE_64: int := 18446744073709551616
  const TWO_TO_THE_127: int := 170141183460469231731687303715884105728
  const TWO_TO_THE_128: int := 340282366920938463463374607431768211456
  const TWO_TO_THE_256: int := 115792089237316195423570985008687907853269984665640564039457584007913129639936
  const TWO_TO_THE_512: int := 13407807929942597099574024998205846127479365820592393377723561443721764030073546976801874298166903427690031858186486050853753882811946569946433649006084096
  const UINT8_MAX: uint8 := 255
  const UINT16_MAX: uint16 := 65535
  const UINT32_MAX: uint32 := 4294967295
  const UINT64_MAX: uint64 := 18446744073709551615
  const INT8_MIN: int8 := -128
  const INT8_MAX: int8 := 127
  const INT16_MIN: int16 := -32768
  const INT16_MAX: int16 := 32767
  const INT32_MIN: int32 := -2147483648
  const INT32_MAX: int32 := 2147483647
  const INT64_MIN: int64 := -9223372036854775808
  const INT64_MAX: int64 := 9223372036854775807
  const NAT8_MAX: nat8 := 127
  const NAT16_MAX: nat16 := 32767
  const NAT32_MAX: nat32 := 2147483647
  const NAT64_MAX: nat64 := 9223372036854775807

  newtype uint8 = x: int
    | 0 <= x < TWO_TO_THE_8

  newtype uint16 = x: int
    | 0 <= x < TWO_TO_THE_16

  newtype uint32 = x: int
    | 0 <= x < TWO_TO_THE_32

  newtype uint64 = x: int
    | 0 <= x < TWO_TO_THE_64

  newtype uint128 = x: int
    | 0 <= x < TWO_TO_THE_128

  newtype int8 = x: int
    | -TWO_TO_THE_7 <= x < TWO_TO_THE_7

  newtype int16 = x: int
    | -TWO_TO_THE_15 <= x < TWO_TO_THE_15

  newtype int32 = x: int
    | -TWO_TO_THE_31 <= x < TWO_TO_THE_31

  newtype int64 = x: int
    | -TWO_TO_THE_63 <= x < TWO_TO_THE_63

  newtype int128 = x: int
    | -TWO_TO_THE_127 <= x < TWO_TO_THE_127

  newtype nat8 = x: int
    | 0 <= x < TWO_TO_THE_7

  newtype nat16 = x: int
    | 0 <= x < TWO_TO_THE_15

  newtype nat32 = x: int
    | 0 <= x < TWO_TO_THE_31

  newtype nat64 = x: int
    | 0 <= x < TWO_TO_THE_63

  newtype nat128 = x: int
    | 0 <= x < TWO_TO_THE_127

  type byte = uint8

  type bytes = seq<byte>

  newtype opt_byte = c: int
    | -1 <= c < TWO_TO_THE_8
}

module Std.Collections.Array {
  method BinarySearch<T(!new)>(a: array<T>, key: T, less: (T, T) -> bool)
      returns (r: Option<nat>)
    requires SortedBy((x, y) => less(x, y) || x == y, a[..])
    requires StrictTotalOrdering(less)
    ensures r.Some? ==> r.value < a.Length && a[r.value] == key
    ensures r.None? ==> key !in a[..]
  {
    var lo, hi: nat := 0, a.Length;
    while lo < hi
      invariant 0 <= lo <= hi <= a.Length
      invariant key !in a[..lo] && key !in a[hi..]
      invariant a[..] == old(a[..])
    {
      var mid := (lo + hi) / 2;
      if less(key, a[mid]) {
        hi := mid;
      } else if less(a[mid], key) {
        lo := mid + 1;
      } else {
        return Some(mid);
      }
    }
    return None;
  }

  import opened Wrappers

  import opened Relations

  import opened Seq
}

module Std.Collections {
}

module Std.Collections.Imap {
  function Get<X, Y>(m: imap<X, Y>, x: X): Option<Y>
  {
    if x in m then
      Some(m[x])
    else
      None
  }

  opaque ghost function RemoveKeys<X, Y>(m: imap<X, Y>, xs: iset<X>): (m': imap<X, Y>)
    ensures forall x {:trigger m'[x]} :: x in m && x !in xs ==> x in m' && m'[x] == m[x]
    ensures forall x {:trigger x in m'} :: x in m' ==> x in m && x !in xs
    ensures m'.Keys == m.Keys - xs
  {
    imap x | x in m && x !in xs :: m[x]
  }

  opaque ghost function RemoveKey<X, Y>(m: imap<X, Y>, x: X): (m': imap<X, Y>)
    ensures m' == RemoveKeys(m, iset{x})
    ensures forall x' {:trigger m'[x']} :: x' in m' ==> m'[x'] == m[x']
  {
    imap i | i in m && i != x :: m[i]
  }

  opaque ghost function Restrict<X, Y>(m: imap<X, Y>, xs: iset<X>): (m': imap<X, Y>)
    ensures m' == RemoveKeys(m, m.Keys - xs)
  {
    imap x | x in xs && x in m :: m[x]
  }

  ghost predicate EqualOnKey<X, Y>(m: imap<X, Y>, m': imap<X, Y>, x: X)
  {
    (x !in m && x !in m') || (x in m && x in m' && m[x] == m'[x])
  }

  ghost predicate IsSubset<X, Y>(m: imap<X, Y>, m': imap<X, Y>)
  {
    m.Keys <= m'.Keys &&
    forall x {:trigger EqualOnKey(m, m', x)} {:trigger x in m} :: 
      x in m ==>
        EqualOnKey(m, m', x)
  }

  opaque ghost function Union<X, Y>(m: imap<X, Y>, m': imap<X, Y>): (r: imap<X, Y>)
    ensures r.Keys == m.Keys + m'.Keys
    ensures forall x {:trigger r[x]} :: x in m' ==> r[x] == m'[x]
    ensures forall x {:trigger r[x]} :: x in m && x !in m' ==> r[x] == m[x]
  {
    m + m'
  }

  ghost predicate Injective<X, Y>(m: imap<X, Y>)
  {
    forall x, x' {:trigger m[x], m[x']} :: 
      x != x' &&
      x in m &&
      x' in m ==>
        m[x] != m[x']
  }

  ghost function Invert<X, Y>(m: imap<X, Y>): imap<Y, X>
  {
    imap y | y in m.Values :: var x :| x in m.Keys && m[x] == y; x
  }

  lemma LemmaInvertIsInjective<X, Y>(m: imap<X, Y>)
    ensures Injective(Invert(m))
  {
  }

  ghost predicate Total<X(!new), Y>(m: imap<X, Y>)
  {
    forall i {:trigger m[i]} {:trigger i in m} :: 
      i in m
  }

  ghost predicate Monotonic(m: imap<int, int>)
  {
    forall x, x' {:trigger m[x], m[x']} :: 
      x in m &&
      x' in m &&
      x <= x' ==>
        m[x] <= m[x']
  }

  ghost predicate MonotonicFrom(m: imap<int, int>, start: int)
  {
    forall x, x' {:trigger m[x], m[x']} :: 
      x in m &&
      x' in m &&
      start <= x <= x' ==>
        m[x] <= m[x']
  }

  import opened Wrappers
}

module Std.Collections.Iset {
  lemma LemmaSubset<T>(x: iset<T>, y: iset<T>)
    requires forall e {:trigger e in y} :: e in x ==> e in y
    ensures x <= y
  {
  }

  ghost function Map<X(!new), Y>(xs: iset<X>, f: X --> Y): (ys: iset<Y>)
    requires forall x {:trigger f.requires(x)} :: f.requires(x)
    requires Injective(f)
    reads f.reads
    ensures forall x {:trigger f(x)} :: x in xs <==> f(x) in ys
  {
    var ys := iset x | x in xs :: f(x);
    ys
  }

  ghost function Filter<X(!new)>(xs: iset<X>, f: X ~> bool): (ys: iset<X>)
    requires forall x {:trigger f.requires(x)} {:trigger x in xs} :: x in xs ==> f.requires(x)
    reads set x, o | x in xs && o in f.reads(x) :: o
    ensures forall y {:trigger f(y)} {:trigger y in xs} :: y in ys <==> y in xs && f(y)
  {
    var ys := iset x | x in xs && f(x);
    ys
  }

  import opened Functions

  import opened Relations
}

module Std.Collections.Map {
  function Get<X, Y>(m: map<X, Y>, x: X): Option<Y>
  {
    if x in m then
      Some(m[x])
    else
      None
  }

  function ToImap<X, Y>(m: map<X, Y>): (m': imap<X, Y>)
    ensures forall x {:trigger m'[x]} :: x in m ==> x in m' && m'[x] == m[x]
    ensures forall x {:trigger x in m'} :: x in m' ==> x in m
  {
    imap x | x in m :: m[x]
  }

  function RemoveKeys<X, Y>(m: map<X, Y>, xs: set<X>): (m': map<X, Y>)
    ensures forall x {:trigger m'[x]} :: x in m && x !in xs ==> x in m' && m'[x] == m[x]
    ensures forall x {:trigger x in m'} :: x in m' ==> x in m && x !in xs
    ensures m'.Keys == m.Keys - xs
  {
    m - xs
  }

  function Remove<X, Y>(m: map<X, Y>, x: X): (m': map<X, Y>)
    ensures m' == RemoveKeys(m, {x})
    ensures |m'.Keys| <= |m.Keys|
    ensures x in m ==> |m'| == |m| - 1
    ensures x !in m ==> |m'| == |m|
  {
    var m' := map x' | x' in m && x' != x :: m[x'];
    assert m'.Keys == m.Keys - {x};
    m'
  }

  function Restrict<X, Y>(m: map<X, Y>, xs: set<X>): (m': map<X, Y>)
    ensures m' == RemoveKeys(m, m.Keys - xs)
  {
    map x | x in xs && x in m :: m[x]
  }

  ghost predicate EqualOnKey<X, Y>(m: map<X, Y>, m': map<X, Y>, x: X)
  {
    (x !in m && x !in m') || (x in m && x in m' && m[x] == m'[x])
  }

  ghost predicate IsSubset<X, Y>(m: map<X, Y>, m': map<X, Y>)
  {
    m.Keys <= m'.Keys &&
    forall x {:trigger EqualOnKey(m, m', x)} {:trigger x in m} :: 
      x in m ==>
        EqualOnKey(m, m', x)
  }

  function Union<X, Y>(m: map<X, Y>, m': map<X, Y>): (r: map<X, Y>)
    ensures r.Keys == m.Keys + m'.Keys
    ensures forall x {:trigger r[x]} :: x in m' ==> r[x] == m'[x]
    ensures forall x {:trigger r[x]} :: x in m && x !in m' ==> r[x] == m[x]
  {
    m + m'
  }

  lemma LemmaDisjointUnionSize<X, Y>(m: map<X, Y>, m': map<X, Y>)
    requires m.Keys !! m'.Keys
    ensures |Union(m, m')| == |m| + |m'|
  {
    var u := Union(m, m');
    assert |u.Keys| == |m.Keys| + |m'.Keys|;
  }

  ghost predicate Injective<X, Y>(m: map<X, Y>)
  {
    forall x, x' {:trigger m[x], m[x']} :: 
      x != x' &&
      x in m &&
      x' in m ==>
        m[x] != m[x']
  }

  ghost function Invert<X, Y>(m: map<X, Y>): map<Y, X>
  {
    map y | y in m.Values :: var x :| x in m.Keys && m[x] == y; x
  }

  lemma LemmaInvertIsInjective<X, Y>(m: map<X, Y>)
    ensures Injective(Invert(m))
  {
  }

  ghost predicate Total<X(!new), Y>(m: map<X, Y>)
  {
    forall i {:trigger m[i]} {:trigger i in m} :: 
      i in m
  }

  ghost predicate Monotonic(m: map<int, int>)
  {
    forall x, x' {:trigger m[x], m[x']} :: 
      x in m &&
      x' in m &&
      x <= x' ==>
        m[x] <= m[x']
  }

  ghost predicate MonotonicFrom(m: map<int, int>, start: int)
  {
    forall x, x' {:trigger m[x], m[x']} :: 
      x in m &&
      x' in m &&
      start <= x <= x' ==>
        m[x] <= m[x']
  }

  import opened Wrappers
}

module Std.Collections.Multiset {
  ghost function ExtractFromNonEmptyMultiset<T>(s: multiset<T>): (x: T)
    requires |s| != 0
    ensures x in s
  {
    var x :| x in s;
    x
  }

  lemma LemmaSubmultisetSize<T>(x: multiset<T>, y: multiset<T>)
    ensures x < y ==> |x| < |y|
    ensures x <= y ==> |x| <= |y|
  {
    if x != multiset{} {
      var e :| e in x;
      LemmaSubmultisetSize(x - multiset{e}, y - multiset{e});
    }
  }
}

module Std.Collections.Seq {
  function First<T>(xs: seq<T>): T
    requires |xs| > 0
  {
    xs[0]
  }

  function DropFirst<T>(xs: seq<T>): seq<T>
    requires |xs| > 0
  {
    xs[1..]
  }

  function Last<T>(xs: seq<T>): T
    requires |xs| > 0
  {
    xs[|xs| - 1]
  }

  function DropLast<T>(xs: seq<T>): seq<T>
    requires |xs| > 0
  {
    xs[..|xs| - 1]
  }

  lemma TakeLess<T>(s: seq<T>, m: nat, n: nat)
    requires m <= n <= |s|
    ensures s[..n][..m] == s[..m]
  {
  }

  lemma LemmaLast<T>(xs: seq<T>)
    requires |xs| > 0
    ensures DropLast(xs) + [Last(xs)] == xs
  {
  }

  lemma LemmaAppendLast<T>(xs: seq<T>, ys: seq<T>)
    requires 0 < |ys|
    ensures Last(xs + ys) == Last(ys)
  {
  }

  lemma LemmaConcatIsAssociative<T>(xs: seq<T>, ys: seq<T>, zs: seq<T>)
    ensures xs + (ys + zs) == xs + ys + zs == xs + ys + zs
  {
  }

  lemma LemmaConcatIsAssociative2<T>(a: seq<T>, b: seq<T>, c: seq<T>, d: seq<T>)
    ensures a + b + c + d == a + (b + c + d)
  {
  }

  lemma EmptySequenceIsRightIdentity(l: seq)
    ensures l == l + []
  {
  }

  ghost predicate IsPrefix<T>(xs: seq<T>, ys: seq<T>)
    ensures IsPrefix(xs, ys) ==> |xs| <= |ys| && xs == ys[..|xs|]
  {
    xs <= ys
  }

  ghost predicate IsSuffix<T>(xs: seq<T>, ys: seq<T>)
  {
    |xs| <= |ys| &&
    xs == ys[|ys| - |xs|..]
  }

  lemma LemmaSplitAt<T>(xs: seq<T>, pos: nat)
    requires pos < |xs|
    ensures xs[..pos] + xs[pos..] == xs
  {
  }

  lemma LemmaElementFromSlice<T>(xs: seq<T>, xs': seq<T>, a: int, b: int, pos: nat)
    requires 0 <= a <= pos < b <= |xs|
    requires xs' == xs[a .. b]
    ensures pos - a < |xs'|
    ensures xs'[pos - a] == xs[pos]
  {
  }

  lemma LemmaSliceOfSlice<T>(xs: seq<T>, s1: int, e1: int, s2: int, e2: int)
    requires 0 <= s1 <= e1 <= |xs|
    requires 0 <= s2 <= e2 <= e1 - s1
    ensures xs[s1 .. e1][s2 .. e2] == xs[s1 + s2 .. s1 + e2]
  {
    var r1 := xs[s1 .. e1];
    var r2 := r1[s2 .. e2];
    var r3 := xs[s1 + s2 .. s1 + e2];
    assert |r2| == |r3|;
    forall i {:trigger r2[i], r3[i]} | 0 <= i < |r2|
      ensures r2[i] == r3[i]
    {
    }
  }

  method ToArray<T>(xs: seq<T>) returns (a: array<T>)
    ensures fresh(a)
    ensures a.Length == |xs|
    ensures forall i :: 0 <= i < |xs| ==> a[i] == xs[i]
  {
    a := new T[|xs|] (i requires 0 <= i < |xs| => xs[i]);
  }

  function ToSet<T>(xs: seq<T>): set<T>
  {
    set x: T | x in xs
  }

  lemma LemmaCardinalityOfSet<T>(xs: seq<T>)
    ensures |ToSet(xs)| <= |xs|
  {
    if |xs| == 0 {
    } else {
      assert ToSet(xs) == ToSet(DropLast(xs)) + {Last(xs)};
      LemmaCardinalityOfSet(DropLast(xs));
    }
  }

  lemma LemmaCardinalityOfEmptySetIs0<T>(xs: seq<T>)
    ensures |ToSet(xs)| == 0 <==> |xs| == 0
  {
    if |xs| != 0 {
      assert xs[0] in ToSet(xs);
    }
  }

  ghost predicate HasNoDuplicates<T>(xs: seq<T>)
  {
    forall i, j :: 
      0 <= i < |xs| &&
      0 <= j < |xs| &&
      i != j ==>
        xs[i] != xs[j]
  }

  @TimeLimitMultiplier(3) lemma LemmaNoDuplicatesInConcat<T>(xs: seq<T>, ys: seq<T>)
    requires HasNoDuplicates(xs)
    requires HasNoDuplicates(ys)
    requires multiset(xs) !! multiset(ys)
    ensures HasNoDuplicates(xs + ys)
  {
    var zs := xs + ys;
    if |zs| > 1 {
      assert forall i :: 0 <= i < |xs| ==> zs[i] in multiset(xs);
      assert forall j :: |xs| <= j < |zs| ==> zs[j] in multiset(ys);
      assert forall i, j :: 0 <= i < |xs| <= j < |zs| ==> zs[i] != zs[j];
    }
  }

  lemma LemmaNoDuplicatesDecomposition<T>(xs: seq<T>, ys: seq<T>)
    requires HasNoDuplicates(xs + ys)
    ensures HasNoDuplicates(xs)
    ensures HasNoDuplicates(ys)
    ensures multiset(xs) !! multiset(ys)
  {
    var zs := xs + ys;
    if !HasNoDuplicates(xs) {
      assert false by {
        var i, j :| 0 <= i < j < |xs| && xs[i] == xs[j];
        assert zs[i] == zs[j];
        assert !HasNoDuplicates(zs);
      }
    }
    if !HasNoDuplicates(ys) {
      assert false by {
        var i, j :| 0 <= i < j < |ys| && ys[i] == ys[j];
        assert zs[|xs| + i] == zs[|xs| + j];
        assert !HasNoDuplicates(zs);
      }
    }
    if !(multiset(xs) !! multiset(ys)) {
      assert false by {
        var i, j :| 0 <= i < |xs| && 0 <= j < |ys| && xs[i] == ys[j];
        assert zs[i] == zs[|xs| + j];
        assert !HasNoDuplicates(zs);
      }
    }
  }

  lemma LemmaCardinalityOfSetNoDuplicates<T>(xs: seq<T>)
    requires HasNoDuplicates(xs)
    ensures |ToSet(xs)| == |xs|
  {
    if |xs| == 0 {
    } else {
      LemmaCardinalityOfSetNoDuplicates(DropLast(xs));
      assert ToSet(xs) == ToSet(DropLast(xs)) + {Last(xs)};
    }
  }

  lemma LemmaNoDuplicatesCardinalityOfSet<T>(xs: seq<T>)
    requires |ToSet(xs)| == |xs|
    ensures HasNoDuplicates(xs)
  {
    if |xs| == 0 {
    } else {
      assert xs == [First(xs)] + DropFirst(xs);
      assert ToSet(xs) == {First(xs)} + ToSet(DropFirst(xs));
      if First(xs) in DropFirst(xs) {
        assert ToSet(xs) == ToSet(DropFirst(xs));
        LemmaCardinalityOfSet(DropFirst(xs));
      } else {
        assert |ToSet(xs)| == 1 + |ToSet(DropFirst(xs))|;
        LemmaNoDuplicatesCardinalityOfSet(DropFirst(xs));
      }
    }
  }

  lemma LemmaMultisetHasNoDuplicates<T>(xs: seq<T>)
    requires HasNoDuplicates(xs)
    ensures forall x {:trigger multiset(xs)[x]} | x in multiset(xs) :: multiset(xs)[x] == 1
  {
    if |xs| == 0 {
    } else {
      assert xs == DropLast(xs) + [Last(xs)];
      assert Last(xs) !in DropLast(xs) by {
      }
      assert HasNoDuplicates(DropLast(xs)) by {
      }
      LemmaMultisetHasNoDuplicates(DropLast(xs));
    }
  }

  opaque function IndexOf<T(==)>(xs: seq<T>, v: T): (i: nat)
    requires v in xs
    ensures i < |xs| && xs[i] == v
    ensures forall j :: 0 <= j < i ==> xs[j] != v
  {
    if xs[0] == v then
      0
    else
      1 + IndexOf(xs[1..], v)
  }

  opaque function IndexOfOption<T(==)>(xs: seq<T>, v: T): (o: Option<nat>)
    ensures if o.Some? then o.value < |xs| && xs[o.value] == v && forall j :: 0 <= j < o.value ==> xs[j] != v else v !in xs
  {
    IndexByOption(xs, x => x == v)
  }

  opaque function IndexByOption<T(==)>(xs: seq<T>, p: T -> bool): (o: Option<nat>)
    ensures if o.Some? then o.value < |xs| && p(xs[o.value]) && forall j :: 0 <= j < o.value ==> !p(xs[j]) else forall x | x in xs :: !p(x)
  {
    if |xs| == 0 then
      None()
    else if p(xs[0]) then
      Some(0)
    else
      var o' := IndexByOption(xs[1..], p); if o'.Some? then Some(o'.value + 1) else None()
  }

  opaque function LastIndexOf<T(==)>(xs: seq<T>, v: T): (i: nat)
    requires v in xs
    ensures i < |xs| && xs[i] == v
    ensures forall j :: i < j < |xs| ==> xs[j] != v
  {
    if xs[|xs| - 1] == v then
      |xs| - 1
    else
      LastIndexOf(xs[..|xs| - 1], v)
  }

  opaque function LastIndexOfOption<T(==)>(xs: seq<T>, v: T): (o: Option<nat>)
    ensures if o.Some? then o.value < |xs| && xs[o.value] == v && forall j :: o.value < j < |xs| ==> xs[j] != v else v !in xs
  {
    LastIndexByOption(xs, x => x == v)
  }

  opaque function LastIndexByOption<T(==)>(xs: seq<T>, p: T -> bool): (o: Option<nat>)
    ensures if o.Some? then o.value < |xs| && p(xs[o.value]) && forall j {:trigger xs[j]} :: o.value < j < |xs| ==> !p(xs[j]) else forall x | x in xs :: !p(x)
  {
    if |xs| == 0 then
      None()
    else if p(xs[|xs| - 1]) then
      Some(|xs| - 1)
    else
      LastIndexByOption(xs[..|xs| - 1], p)
  }

  opaque function Remove<T>(xs: seq<T>, pos: nat): (ys: seq<T>)
    requires pos < |xs|
    ensures |ys| == |xs| - 1
    ensures forall i {:trigger ys[i], xs[i]} | 0 <= i < pos :: ys[i] == xs[i]
    ensures forall i {:trigger ys[i]} | pos <= i < |xs| - 1 :: ys[i] == xs[i + 1]
  {
    xs[..pos] + xs[pos + 1..]
  }

  opaque function RemoveValue<T(==)>(xs: seq<T>, v: T): (ys: seq<T>)
    ensures v !in xs ==> xs == ys
    ensures v in xs ==> |multiset(ys)| == |multiset(xs)| - 1
    ensures v in xs ==> multiset(ys)[v] == multiset(xs)[v] - 1
    ensures HasNoDuplicates(xs) ==> HasNoDuplicates(ys) && ToSet(ys) == ToSet(xs) - {v}
  {
    if v !in xs then
      xs
    else
      var i := IndexOf(xs, v); assert xs == xs[..i] + [v] + xs[i + 1..]; xs[..i] + xs[i + 1..]
  }

  opaque function Insert<T>(xs: seq<T>, a: T, pos: nat): seq<T>
    requires pos <= |xs|
    ensures |Insert(xs, a, pos)| == |xs| + 1
    ensures forall i {:trigger Insert(xs, a, pos)[i], xs[i]} :: 0 <= i < pos ==> Insert(xs, a, pos)[i] == xs[i]
    ensures forall i {:trigger xs[i]} :: pos <= i < |xs| ==> Insert(xs, a, pos)[i + 1] == xs[i]
    ensures Insert(xs, a, pos)[pos] == a
    ensures multiset(Insert(xs, a, pos)) == multiset(xs) + multiset{a}
  {
    assert xs == xs[..pos] + xs[pos..];
    xs[..pos] + [a] + xs[pos..]
  }

  opaque function Reverse<T>(xs: seq<T>): (ys: seq<T>)
    ensures |ys| == |xs|
    ensures forall i {:trigger ys[i]} {:trigger xs[|xs| - i - 1]} :: 0 <= i < |xs| ==> ys[i] == xs[|xs| - i - 1]
  {
    if xs == [] then
      []
    else
      [xs[|xs| - 1]] + Reverse(xs[0 .. |xs| - 1])
  }

  opaque function Repeat<T>(v: T, length: nat): (xs: seq<T>)
    ensures |xs| == length
    ensures forall i: nat | i < |xs| :: xs[i] == v
  {
    if length == 0 then
      []
    else
      [v] + Repeat(v, length - 1)
  }

  opaque function Unzip<A, B>(xs: seq<(A, B)>): (seq<A>, seq<B>)
    ensures |Unzip(xs).0| == |Unzip(xs).1| == |xs|
    ensures forall i {:trigger Unzip(xs).0[i]} {:trigger Unzip(xs).1[i]} :: 0 <= i < |xs| ==> (Unzip(xs).0[i], Unzip(xs).1[i]) == xs[i]
  {
    if |xs| == 0 then
      ([], [])
    else
      var (a, b) := Unzip(DropLast(xs)); (a + [Last(xs).0], b + [Last(xs).1])
  }

  opaque function Zip<A, B>(xs: seq<A>, ys: seq<B>): seq<(A, B)>
    requires |xs| == |ys|
    ensures |Zip(xs, ys)| == |xs|
    ensures forall i {:trigger Zip(xs, ys)[i]} :: 0 <= i < |Zip(xs, ys)| ==> Zip(xs, ys)[i] == (xs[i], ys[i])
    ensures Unzip(Zip(xs, ys)).0 == xs
    ensures Unzip(Zip(xs, ys)).1 == ys
  {
    if |xs| == 0 then
      []
    else
      Zip(DropLast(xs), DropLast(ys)) + [(Last(xs), Last(ys))]
  }

  lemma LemmaZipOfUnzip<A, B>(xs: seq<(A, B)>)
    ensures Zip(Unzip(xs).0, Unzip(xs).1) == xs
  {
  }

  lemma MembershipImpliesIndexing<T>(p: T -> bool, xs: seq<T>)
    requires forall t | t in xs :: p(t)
    ensures forall i | 0 <= i < |xs| :: p(xs[i])
  {
  }

  opaque function Max(xs: seq<int>): int
    requires 0 < |xs|
    ensures forall k :: k in xs ==> Max(xs) >= k
    ensures Max(xs) in xs
  {
    assert xs == [xs[0]] + xs[1..];
    if |xs| == 1 then
      xs[0]
    else
      Math.Max(xs[0], Max(xs[1..]))
  }

  lemma LemmaMaxOfConcat(xs: seq<int>, ys: seq<int>)
    requires 0 < |xs| && 0 < |ys|
    ensures Max(xs + ys) >= Max(xs)
    ensures Max(xs + ys) >= Max(ys)
    ensures forall i {:trigger i in [Max(xs + ys)]} :: i in xs + ys ==> Max(xs + ys) >= i
  {
    reveal Max;
    if |xs| == 1 {
    } else {
      assert xs[1..] + ys == (xs + ys)[1..];
      LemmaMaxOfConcat(xs[1..], ys);
    }
  }

  opaque function Min(xs: seq<int>): int
    requires 0 < |xs|
    ensures forall k :: k in xs ==> Min(xs) <= k
    ensures Min(xs) in xs
  {
    assert xs == [xs[0]] + xs[1..];
    if |xs| == 1 then
      xs[0]
    else
      Math.Min(xs[0], Min(xs[1..]))
  }

  lemma LemmaMinOfConcat(xs: seq<int>, ys: seq<int>)
    requires 0 < |xs| && 0 < |ys|
    ensures Min(xs + ys) <= Min(xs)
    ensures Min(xs + ys) <= Min(ys)
    ensures forall i :: i in xs + ys ==> Min(xs + ys) <= i
  {
    reveal Min;
    if |xs| == 1 {
    } else {
      assert xs[1..] + ys == (xs + ys)[1..];
      LemmaMinOfConcat(xs[1..], ys);
    }
  }

  lemma LemmaSubseqMax(xs: seq<int>, from: nat, to: nat)
    requires from < to <= |xs|
    ensures Max(xs[from .. to]) <= Max(xs)
  {
    var subseq := xs[from .. to];
    var subseqMax := Max(subseq);
    assert forall x | x in subseq :: x in xs[from..];
    assert subseqMax in subseq;
    assert subseqMax in xs;
  }

  lemma LemmaSubseqMin(xs: seq<int>, from: nat, to: nat)
    requires from < to <= |xs|
    ensures Min(xs[from .. to]) >= Min(xs)
  {
    var subseq := xs[from .. to];
    var subseqMin := Min(subseq);
    assert forall x | x in subseq :: x in xs[from..];
    assert subseqMin in subseq;
    assert subseqMin in xs;
  }

  function Flatten<T>(xs: seq<seq<T>>): seq<T>
    decreases |xs|
  {
    if |xs| == 0 then
      []
    else
      xs[0] + Flatten(xs[1..])
  }

  @IsolateAssertions lemma LemmaFlattenConcat<T>(xs: seq<seq<T>>, ys: seq<seq<T>>)
    ensures Flatten(xs + ys) == Flatten(xs) + Flatten(ys)
  {
    if |xs| == 0 {
      assert xs + ys == ys;
    } else {
      calc == {
        Flatten(xs + ys);
        {
          assert (xs + ys)[0] == xs[0];
          assert (xs + ys)[1..] == xs[1..] + ys;
        }
        xs[0] + Flatten(xs[1..] + ys);
        xs[0] + Flatten(xs[1..]) + Flatten(ys);
        Flatten(xs) + Flatten(ys);
      }
    }
  }

  function FlattenReverse<T>(xs: seq<seq<T>>): seq<T>
    decreases |xs|
  {
    if |xs| == 0 then
      []
    else
      FlattenReverse(DropLast(xs)) + Last(xs)
  }

  lemma LemmaFlattenReverseConcat<T>(xs: seq<seq<T>>, ys: seq<seq<T>>)
    ensures FlattenReverse(xs + ys) == FlattenReverse(xs) + FlattenReverse(ys)
  {
    if |ys| == 0 {
      assert FlattenReverse(ys) == [];
      assert xs + ys == xs;
    } else {
      calc == {
        FlattenReverse(xs + ys);
        {
          assert Last(xs + ys) == Last(ys);
          assert DropLast(xs + ys) == xs + DropLast(ys);
        }
        FlattenReverse(xs + DropLast(ys)) + Last(ys);
        FlattenReverse(xs) + FlattenReverse(DropLast(ys)) + Last(ys);
        FlattenReverse(xs) + FlattenReverse(ys);
      }
    }
  }

  lemma LemmaFlattenAndFlattenReverseAreEquivalent<T>(xs: seq<seq<T>>)
    ensures Flatten(xs) == FlattenReverse(xs)
  {
    if |xs| == 0 {
    } else {
      calc == {
        FlattenReverse(xs);
        FlattenReverse(DropLast(xs)) + Last(xs);
        {
          LemmaFlattenAndFlattenReverseAreEquivalent(DropLast(xs));
        }
        Flatten(DropLast(xs)) + Last(xs);
        Flatten(DropLast(xs)) + Flatten([Last(xs)]);
        {
          LemmaFlattenConcat(DropLast(xs), [Last(xs)]);
          assert xs == DropLast(xs) + [Last(xs)];
        }
        Flatten(xs);
      }
    }
  }

  lemma LemmaFlattenLengthGeSingleElementLength<T>(xs: seq<seq<T>>, i: int)
    requires 0 <= i < |xs|
    ensures |FlattenReverse(xs)| >= |xs[i]|
  {
    if i < |xs| - 1 {
      LemmaFlattenLengthGeSingleElementLength(xs[..|xs| - 1], i);
    }
  }

  lemma LemmaFlattenLengthLeMul<T>(xs: seq<seq<T>>, j: int)
    requires forall i | 0 <= i < |xs| :: |xs[i]| <= j
    ensures |FlattenReverse(xs)| <= |xs| * j
  {
    if |xs| == 0 {
    } else {
      LemmaFlattenLengthLeMul(xs[..|xs| - 1], j);
      assert |FlattenReverse(xs[..|xs| - 1])| <= (|xs| - 1) * j;
    }
  }

  function Join<T>(seqs: seq<seq<T>>, separator: seq<T>): seq<T>
  {
    if |seqs| == 0 then
      []
    else if |seqs| == 1 then
      seqs[0]
    else
      seqs[0] + separator + Join(seqs[1..], separator)
  }

  lemma LemmaJoinWithEmptySeparator(seqs: seq<string>)
    ensures Flatten(seqs) == Join(seqs, [])
  {
  }

  @TailRecursion function Split<T(==)>(s: seq<T>, delim: T): (res: seq<seq<T>>)
    ensures delim !in s ==> res == [s]
    ensures s == [] ==> res == [[]]
    ensures 0 < |res|
    ensures forall i :: 0 <= i < |res| ==> delim !in res[i]
    ensures Join(res, [delim]) == s
    decreases |s|
  {
    var i := IndexOfOption(s, delim);
    if i.Some? then
      [s[..i.value]] + Split(s[i.value + 1..], delim)
    else
      [s]
  }

  @TailRecursion function SplitOnce<T(==)>(s: seq<T>, delim: T): (res: (seq<T>, seq<T>))
    requires delim in s
    ensures res.0 + [delim] + res.1 == s
    ensures !(delim in res.0)
  {
    var i := IndexOfOption(s, delim);
    assert i.Some?;
    (s[..i.value], s[i.value + 1..])
  }

  @TailRecursion function SplitOnceOption<T(==)>(s: seq<T>, delim: T): (res: Option<(seq<T>, seq<T>)>)
    ensures res.Some? ==> res.value.0 + [delim] + res.value.1 == s
    ensures res.None? ==> !(delim in s)
    ensures res.Some? ==> !(delim in res.value.0)
  {
    var i :- IndexOfOption(s, delim); Some((s[..i], s[i + 1..]))
  }

  @ResourceLimit("1e6") @IsolateAssertions lemma {:induction false} WillSplitOnDelim<T>(s: seq<T>, delim: T, prefix: seq<T>)
    requires |prefix| < |s|
    requires forall i :: 0 <= i < |prefix| ==> prefix[i] == s[i]
    requires delim !in prefix && s[|prefix|] == delim
    ensures Split(s, delim) == [prefix] + Split(s[|prefix| + 1..], delim)
  {
    hide *;
    calc {
      Split(s, delim);
    ==
      {
        reveal Split();
      }
      var i := IndexOfOption(s, delim); if i.Some? then [s[..i.value]] + Split(s[i.value + 1..], delim) else [s];
    ==
      {
        IndexOfOptionLocatesElem(s, delim, |prefix|);
        assert IndexOfOption(s, delim).Some?;
      }
      [s[..|prefix|]] + Split(s[|prefix| + 1..], delim);
    ==
      {
        assert s[..|prefix|] == prefix;
      }
      [prefix] + Split(s[|prefix| + 1..], delim);
    }
  }

  lemma WillNotSplitWithOutDelim<T>(s: seq<T>, delim: T)
    requires delim !in s
    ensures Split(s, delim) == [s]
  {
    calc {
      Split(s, delim);
    ==
      var i := IndexOfOption(s, delim); if i.Some? then [s[..i.value]] + Split(s[i.value + 1..], delim) else [s];
    ==
      {
        IndexOfOptionLocatesElem(s, delim, |s|);
      }
      [s];
    }
  }

  lemma IndexOfOptionLocatesElem<T>(s: seq<T>, c: T, elemIndex: nat)
    requires 0 <= elemIndex <= |s|
    requires forall i :: 0 <= i < elemIndex ==> s[i] != c
    requires elemIndex == |s| || s[elemIndex] == c
    ensures IndexOfOption(s, c) == if elemIndex == |s| then None else Some(elemIndex)
    decreases elemIndex
  {
  }

  opaque function Map<T, R>(f: T ~> R, xs: seq<T>): (result: seq<R>)
    requires forall i :: 0 <= i < |xs| ==> f.requires(xs[i])
    reads set i, o | 0 <= i < |xs| && o in f.reads(xs[i]) :: o
    ensures |result| == |xs|
    ensures forall i {:trigger result[i]} :: 0 <= i < |xs| ==> result[i] == f(xs[i])
  {
    if |xs| == 0 then
      []
    else
      [f(xs[0])] + Map(f, xs[1..])
  }

  function MapPartialFunction<T, R>(f: T --> R, xs: seq<T>): (result: seq<R>)
    requires forall i :: 0 <= i < |xs| ==> f.requires(xs[i])
  {
    Map(f, xs)
  }

  opaque function MapWithResult<T, R, E>(f: T ~> Result<R, E>, xs: seq<T>): (result: Result<seq<R>, E>)
    requires forall i :: 0 <= i < |xs| ==> f.requires(xs[i])
    reads set i, o | 0 <= i < |xs| && o in f.reads(xs[i]) :: o
    ensures result.Success? ==> |result.value| == |xs| && forall i :: 0 <= i < |xs| ==> f(xs[i]).Success? && result.value[i] == f(xs[i]).value
  {
    if |xs| == 0 then
      Success([])
    else
      var head :- f(xs[0]); var tail :- MapWithResult(f, xs[1..]); Success([head] + tail)
  }

  lemma {:induction false} LemmaMapDistributesOverConcat<T, R>(f: T ~> R, xs: seq<T>, ys: seq<T>)
    requires X: forall i :: 0 <= i < |xs| ==> f.requires(xs[i])
    requires Y: forall j :: 0 <= j < |ys| ==> f.requires(ys[j])
    ensures Map(f, xs + ys) == Map(f, xs) + Map(f, ys)
  {
    if |xs| == 0 {
      assert xs + ys == ys;
    } else {
      calc {
        Map(f, reveal X, Y; xs + ys);
        {
          assert (xs + ys)[0] == xs[0];
          assert (xs + ys)[1..] == xs[1..] + ys;
        }
        Map(f, [xs[0]]) + Map(f, xs[1..] + ys);
        Map(f, [xs[0]]) + Map(f, reveal X; xs[1..]) + Map(f, reveal Y; ys);
        {
          assert [(xs + ys)[0]] + xs[1..] + ys == xs + ys;
        }
        Map(f, xs) + Map(f, ys);
      }
    }
  }

  lemma {:induction false} LemmaMapPartialFunctionDistributesOverConcat<T, R>(f: T --> R, xs: seq<T>, ys: seq<T>)
    requires X: forall i :: 0 <= i < |xs| ==> f.requires(xs[i])
    requires Y: forall j :: 0 <= j < |ys| ==> f.requires(ys[j])
    ensures MapPartialFunction(f, xs + ys) == MapPartialFunction(f, xs) + MapPartialFunction(f, ys)
  {
    if |xs| == 0 {
      assert xs + ys == ys;
    } else {
      calc {
        MapPartialFunction(f, reveal X, Y; xs + ys);
        {
          assert (xs + ys)[0] == xs[0];
          assert (xs + ys)[1..] == xs[1..] + ys;
        }
        MapPartialFunction(f, [xs[0]]) + MapPartialFunction(f, xs[1..] + ys);
        MapPartialFunction(f, [xs[0]]) + MapPartialFunction(f, reveal X; xs[1..]) + MapPartialFunction(f, reveal Y; ys);
        {
          assert [(xs + ys)[0]] + xs[1..] + ys == xs + ys;
        }
        MapPartialFunction(f, xs) + MapPartialFunction(f, ys);
      }
    }
  }

  opaque function Filter<T>(f: T ~> bool, xs: seq<T>): (result: seq<T>)
    requires forall i :: 0 <= i < |xs| ==> f.requires(xs[i])
    reads set i, o | 0 <= i < |xs| && o in f.reads(xs[i]) :: o
    ensures |result| <= |xs|
    ensures forall i: nat | i < |result| :: f.requires(result[i]) && f(result[i])
  {
    if |xs| == 0 then
      []
    else
      (if f(xs[0]) then [xs[0]] else []) + Filter(f, xs[1..])
  }

  @IsolateAssertions lemma {:induction false} LemmaFilterDistributesOverConcat<T>(f: T ~> bool, xs: seq<T>, ys: seq<T>)
    requires forall i :: 0 <= i < |xs| ==> f.requires(xs[i])
    requires forall j :: 0 <= j < |ys| ==> f.requires(ys[j])
    ensures Filter(f, xs + ys) == Filter(f, xs) + Filter(f, ys)
  {
    hide *;
    if |xs| == 0 {
      assert xs + ys == ys;
    } else {
      calc {
        Filter(f, xs + ys);
        {
          reveal Filter;
          assert (xs + ys)[0] == xs[0];
          assert (xs + ys)[1..] == xs[1..] + ys;
        }
        Filter(f, [xs[0]]) + Filter(f, xs[1..] + ys);
        {
          LemmaFilterDistributesOverConcat(f, xs[1..], ys);
        }
        Filter(f, [xs[0]]) + (Filter(f, xs[1..]) + Filter(f, ys));
        {
          reveal Filter;
          assert [(xs + ys)[0]] + (xs[1..] + ys) == xs + ys;
        }
        Filter(f, xs) + Filter(f, ys);
      }
    }
  }

  function FoldLeft<A, T>(f: (A, T) -> A, init: A, xs: seq<T>): A
  {
    if |xs| == 0 then
      init
    else
      FoldLeft(f, f(init, xs[0]), xs[1..])
  }

  lemma LemmaFoldLeftDistributesOverConcat<A, T>(f: (A, T) -> A, init: A, xs: seq<T>, ys: seq<T>)
    ensures FoldLeft(f, init, xs + ys) == FoldLeft(f, FoldLeft(f, init, xs), ys)
  {
    if |xs| == 0 {
      assert xs + ys == ys;
    } else {
      assert |xs| >= 1;
      assert ([xs[0]] + xs[1..] + ys)[0] == xs[0];
      calc {
        FoldLeft(f, FoldLeft(f, init, xs), ys);
        FoldLeft(f, FoldLeft(f, f(init, xs[0]), xs[1..]), ys);
        {
          LemmaFoldLeftDistributesOverConcat(f, f(init, xs[0]), xs[1..], ys);
        }
        FoldLeft(f, f(init, xs[0]), xs[1..] + ys);
        {
          assert (xs + ys)[0] == xs[0];
          assert (xs + ys)[1..] == xs[1..] + ys;
        }
        FoldLeft(f, init, xs + ys);
      }
    }
  }

  ghost predicate InvFoldLeft<A(!new), B(!new)>(inv: (B, seq<A>) -> bool, stp: (B, A, B) -> bool)
  {
    forall x: A, xs: seq<A>, b: B, b': B :: 
      inv(b, [x] + xs) &&
      stp(b, x, b') ==>
        inv(b', xs)
  }

  lemma LemmaInvFoldLeft<A(!new), B(!new)>(inv: (B, seq<A>) -> bool, stp: (B, A, B) -> bool, f: (B, A) -> B, b: B, xs: seq<A>)
    requires InvFoldLeft(inv, stp)
    requires forall b, a :: stp(b, a, f(b, a))
    requires inv(b, xs)
    ensures inv(FoldLeft(f, b, xs), [])
  {
    if xs == [] {
    } else {
      assert [xs[0]] + xs[1..] == xs;
      LemmaInvFoldLeft(inv, stp, f, f(b, xs[0]), xs[1..]);
    }
  }

  function FoldRight<A, T>(f: (T, A) -> A, xs: seq<T>, init: A): A
  {
    if |xs| == 0 then
      init
    else
      f(xs[0], FoldRight(f, xs[1..], init))
  }

  lemma LemmaFoldRightDistributesOverConcat<A, T>(f: (T, A) -> A, init: A, xs: seq<T>, ys: seq<T>)
    ensures FoldRight(f, xs + ys, init) == FoldRight(f, xs, FoldRight(f, ys, init))
  {
    if |xs| == 0 {
      assert xs + ys == ys;
    } else {
      calc {
        FoldRight(f, xs, FoldRight(f, ys, init));
        f(xs[0], FoldRight(f, xs[1..], FoldRight(f, ys, init)));
        f(xs[0], FoldRight(f, xs[1..] + ys, init));
        {
          assert (xs + ys)[0] == xs[0];
          assert (xs + ys)[1..] == xs[1..] + ys;
        }
        FoldRight(f, xs + ys, init);
      }
    }
  }

  ghost predicate InvFoldRight<A(!new), B(!new)>(inv: (seq<A>, B) -> bool, stp: (A, B, B) -> bool)
  {
    forall x: A, xs: seq<A>, b: B, b': B :: 
      inv(xs, b) &&
      stp(x, b, b') ==>
        inv([x] + xs, b')
  }

  lemma LemmaInvFoldRight<A(!new), B(!new)>(inv: (seq<A>, B) -> bool, stp: (A, B, B) -> bool, f: (A, B) -> B, b: B, xs: seq<A>)
    requires InvFoldRight(inv, stp)
    requires forall a, b :: stp(a, b, f(a, b))
    requires inv([], b)
    ensures inv(xs, FoldRight(f, xs, b))
  {
    if xs == [] {
    } else {
      assert [xs[0]] + xs[1..] == xs;
    }
  }

  function MergeSortBy<T(!new)>(lessThanOrEq: (T, T) -> bool, a: seq<T>): (result: seq<T>)
    requires TotalOrdering(lessThanOrEq)
    ensures multiset(a) == multiset(result)
    ensures SortedBy(lessThanOrEq, result)
  {
    if |a| <= 1 then
      a
    else
      var splitIndex := |a| / 2; var left, right := a[..splitIndex], a[splitIndex..]; assert a == left + right; var leftSorted := MergeSortBy(lessThanOrEq, left); var rightSorted := MergeSortBy(lessThanOrEq, right); MergeSortedWith(leftSorted, rightSorted, lessThanOrEq)
  }

  @TailRecursion function MergeSortedWith<T(!new)>(left: seq<T>, right: seq<T>, lessThanOrEq: (T, T) -> bool): (result: seq<T>)
    requires SortedBy(lessThanOrEq, left)
    requires SortedBy(lessThanOrEq, right)
    requires TotalOrdering(lessThanOrEq)
    ensures multiset(left + right) == multiset(result)
    ensures SortedBy(lessThanOrEq, result)
  {
    if |left| == 0 then
      right
    else if |right| == 0 then
      left
    else if lessThanOrEq(left[0], right[0]) then
      LemmaNewFirstElementStillSortedBy(left[0], MergeSortedWith(left[1..], right, lessThanOrEq), lessThanOrEq);
      assert left == [left[0]] + left[1..];
      [left[0]] + MergeSortedWith(left[1..], right, lessThanOrEq)
    else
      LemmaNewFirstElementStillSortedBy(right[0], MergeSortedWith(left, right[1..], lessThanOrEq), lessThanOrEq); assert right == [right[0]] + right[1..]; [right[0]] + MergeSortedWith(left, right[1..], lessThanOrEq)
  }

  lemma LemmaNewFirstElementStillSortedBy<T(!new)>(newFirst: T, s: seq<T>, lessOrEqual: (T, T) -> bool)
    requires SortedBy(lessOrEqual, s)
    requires |s| == 0 || lessOrEqual(newFirst, s[0])
    requires TotalOrdering(lessOrEqual)
    ensures SortedBy(lessOrEqual, [newFirst] + s)
  {
  }

  lemma SortedUnique<T(!new)>(xs: seq<T>, ys: seq<T>, R: (T, T) -> bool)
    requires SortedBy(R, xs)
    requires SortedBy(R, ys)
    requires TotalOrdering(R)
    requires multiset(xs) == multiset(ys)
    ensures xs == ys
  {
    if xs == [] {
      assert multiset(xs) == multiset{};
      assert multiset(ys) == multiset{};
      assert ys == [];
    } else {
      assert xs == [xs[0]] + xs[1..];
      assert ys == [ys[0]] + ys[1..];
      assert multiset(xs[1..]) == multiset(xs) - multiset{xs[0]};
      assert multiset(ys[1..]) == multiset(ys) - multiset{ys[0]};
      assert multiset(xs[1..]) == multiset(ys[1..]);
      SortedUnique(xs[1..], ys[1..], R);
    }
  }

  predicate All<T>(s: seq<T>, p: T -> bool)
  {
    forall i {:trigger s[i]} | 0 <= i < |s| :: 
      p(s[i])
  }

  predicate AllNot<T>(s: seq<T>, p: T -> bool)
  {
    forall i {:trigger s[i]} | 0 <= i < |s| :: 
      !p(s[i])
  }

  lemma AllDecomposition<T>(left: seq<T>, right: seq<T>, p: T -> bool)
    requires All(left + right, p)
    ensures All(left, p)
    ensures All(right, p)
  {
    forall i: nat | i < |left|
      ensures p(left[i])
    {
      assert (left + right)[i] == left[i];
    }
    forall i: nat | i < |right|
      ensures p(right[i])
    {
      assert (left + right)[|left| + i] == right[i];
    }
  }

  lemma AllNotDecomposition<T>(left: seq<T>, right: seq<T>, p: T -> bool)
    requires AllNot(left + right, p)
    ensures AllNot(left, p)
    ensures AllNot(right, p)
  {
    forall i: nat | i < |left|
      ensures !p(left[i])
    {
      assert (left + right)[i] == left[i];
    }
    forall i: nat | i < |right|
      ensures !p(right[i])
    {
      assert (left + right)[|left| + i] == right[i];
    }
  }

  predicate Partitioned<T>(s: seq<T>, p: T -> bool)
  {
    if s == [] then
      true
    else if p(s[0]) then
      Partitioned(s[1..], p)
    else
      AllNot(s[1..], p)
  }

  lemma AllImpliesPartitioned<T>(s: seq<T>, p: T -> bool)
    requires All(s, p)
    ensures Partitioned(s, p)
  {
  }

  lemma AllNotImpliesPartitioned<T>(s: seq<T>, p: T -> bool)
    requires AllNot(s, p)
    ensures Partitioned(s, p)
  {
  }

  lemma PartitionedFirstFalseImpliesAllNot<T>(s: seq<T>, p: T -> bool)
    requires Partitioned(s, p)
    requires 0 < |s|
    requires !p(First(s))
    ensures AllNot(s, p)
  {
  }

  lemma PartitionedLastTrueImpliesAll<T>(s: seq<T>, p: T -> bool)
    requires Partitioned(s, p)
    requires 0 < |s|
    requires p(Last(s))
    ensures All(s, p)
  {
  }

  lemma PartitionedCompositionRight<T>(left: seq<T>, right: seq<T>, p: T -> bool)
    requires Partitioned(left, p)
    requires AllNot(right, p)
    ensures Partitioned(left + right, p)
  {
    if left == [] {
    } else {
      if p(left[0]) {
        PartitionedCompositionRight(left[1..], right, p);
        assert left == [left[0]] + left[1..];
        PartitionedCompositionLeft([left[0]], left[1..] + right, p);
        assert Partitioned([left[0]] + (left[1..] + right), p);
        assert left + right == [left[0]] + (left[1..] + right);
      } else {
      }
    }
  }

  lemma PartitionedCompositionLeft<T>(left: seq<T>, right: seq<T>, p: T -> bool)
    requires All(left, p)
    requires Partitioned(right, p)
    ensures Partitioned(left + right, p)
  {
    if left == [] {
      assert left + right == right;
    } else {
      PartitionedCompositionLeft(left[1..], right, p);
      assert left + right == [left[0]] + (left[1..] + right);
    }
  }

  lemma PartitionedDecomposition<T>(left: seq<T>, right: seq<T>, p: T -> bool)
    requires Partitioned(left + right, p)
    ensures Partitioned(left, p)
    ensures Partitioned(right, p)
  {
    if left == [] {
      assert right == left + right;
    } else {
      if !p(left[0]) {
        PartitionedFirstFalseImpliesAllNot(left + right, p);
        AllNotDecomposition(left, right, p);
        assert AllNot(left, p);
        PartitionedDecomposition(left[1..], right, p);
      } else {
        var combined := left + right;
        assert p(combined[0]);
        assert Partitioned(combined[1..], p);
        assert combined[1..] == left[1..] + right;
        PartitionedDecomposition(left[1..], right, p);
      }
    }
  }

  import opened Wrappers

  import opened Relations

  import Math

  datatype Slice<T> = Slice(data: seq<T>, start: int, end: int) {
    ghost predicate Valid()
    {
      0 <= start <= end <= |data|
    }

    function View(): seq<T>
      requires Valid()
    {
      data[start .. end]
    }

    function Length(): nat
      requires Valid()
    {
      end - start
    }

    function At(i: int): (result: T)
      requires Valid()
      requires 0 <= i < Length()
      ensures result == View()[i]
    {
      data[start + i]
    }

    function Drop(firstIncludedIndex: int): (result: Slice<T>)
      requires Valid()
      requires 0 <= firstIncludedIndex <= Length()
      ensures result.Valid()
      ensures result.View() == View()[firstIncludedIndex..]
    {
      Slice(data, start + firstIncludedIndex, end)
    }

    function Sub(firstIncludedIndex: int, lastExcludedIndex: int): (result: Slice<T>)
      requires Valid()
      requires 0 <= firstIncludedIndex <= lastExcludedIndex <= Length()
      ensures result.Valid()
      ensures result.View() == View()[firstIncludedIndex .. lastExcludedIndex]
    {
      PrefixRestrict(firstIncludedIndex, lastExcludedIndex);
      Slice(data, start + firstIncludedIndex, start + lastExcludedIndex)
    }

    lemma PrefixRestrict(firstIncludedIndex: int, lastExcludedIndex: int)
      requires Valid()
      requires 0 <= firstIncludedIndex <= lastExcludedIndex <= Length()
      ensures data[start..][firstIncludedIndex .. lastExcludedIndex] == data[start .. end][firstIncludedIndex .. lastExcludedIndex]
      decreases |data| - end
    {
      if end == |data| {
        assert data[start .. end] == data[start..];
      } else {
        var before := data[start .. end][firstIncludedIndex .. lastExcludedIndex];
        var after := data[start .. end + 1][firstIncludedIndex .. lastExcludedIndex];
        calc {
          data[start .. end][firstIncludedIndex .. lastExcludedIndex];
          {
            assert |before| == |after|;
            assert forall i | 0 <= i < |before| :: before[i] == after[i];
          }
          data[start .. end + 1][firstIncludedIndex .. lastExcludedIndex];
        }
        Slice(data, start, end + 1).PrefixRestrict(firstIncludedIndex, lastExcludedIndex);
      }
    }
  }
}

module Std.Collections.Set {
  lemma LemmaSubset<T>(x: set<T>, y: set<T>)
    requires forall e {:trigger e in y} :: e in x ==> e in y
    ensures x <= y
  {
  }

  lemma LemmaSubsetSize<T>(x: set<T>, y: set<T>)
    ensures x < y ==> |x| < |y|
    ensures x <= y ==> |x| <= |y|
  {
    if x != {} {
      var e :| e in x;
      LemmaSubsetSize(x - {e}, y - {e});
    }
  }

  lemma LemmaSubsetEquality<T>(x: set<T>, y: set<T>)
    requires x <= y
    requires |x| == |y|
    ensures x == y
    decreases x, y
  {
    if x == {} {
    } else {
      var e :| e in x;
      LemmaSubsetEquality(x - {e}, y - {e});
    }
  }

  lemma LemmaSingletonSize<T>(x: set<T>, e: T)
    requires x == {e}
    ensures |x| == 1
  {
  }

  lemma LemmaSingletonEquality<T>(x: set<T>, a: T, b: T)
    requires |x| == 1
    requires a in x
    requires b in x
    ensures a == b
  {
    if a != b {
      assert {a} < x;
      LemmaSubsetSize({a}, x);
      assert false;
    }
  }

  ghost predicate IsSingleton<T>(s: set<T>)
  {
    (exists x :: 
      x in s) &&
    forall x, y | x in s && y in s :: 
      x == y
  }

  lemma LemmaIsSingleton<T>(s: set<T>)
    ensures |s| == 1 <==> IsSingleton(s)
  {
    if |s| == 1 {
      forall x, y | x in s && y in s
        ensures x == y
      {
        LemmaSingletonEquality(s, x, y);
      }
    }
    if IsSingleton(s) {
      var x :| x in s;
      assert s == {x};
      assert |s| == 1;
    }
  }

  ghost function ExtractFromNonEmptySet<T>(s: set<T>): (x: T)
    requires |s| != 0
    ensures x in s
  {
    var x :| x in s;
    x
  }

  function ExtractFromSingleton<T>(s: set<T>): (x: T)
    requires |s| == 1
    ensures s == {x}
  {
    LemmaIsSingleton(s);
    var x :| x in s;
    x
  }

  lemma LemmaMapSize<X(!new), Y>(xs: set<X>, ys: set<Y>, f: X --> Y)
    requires forall x {:trigger f.requires(x)} :: f.requires(x)
    requires Injective(f)
    requires forall x {:trigger f(x)} :: x in xs <==> f(x) in ys
    requires forall y {:trigger y in ys} :: y in ys ==> exists x :: x in xs && y == f(x)
    ensures |xs| == |ys|
  {
    if xs != {} {
      var x :| x in xs;
      var xs' := xs - {x};
      var ys' := ys - {f(x)};
      LemmaMapSize(xs', ys', f);
    }
  }

  opaque function Map<X(!new), Y>(f: X --> Y, xs: set<X>): (ys: set<Y>)
    requires forall x {:trigger f.requires(x)} :: f.requires(x)
    requires Injective(f)
    reads f.reads
    ensures forall x {:trigger f(x)} :: x in xs <==> f(x) in ys
    ensures |xs| == |ys|
  {
    var ys := set x | x in xs :: f(x);
    LemmaMapSize(xs, ys, f);
    ys
  }

  lemma LemmaFilterSize<X>(xs: set<X>, ys: set<X>, f: X ~> bool)
    requires forall x {:trigger f.requires(x)} {:trigger x in xs} :: x in xs ==> f.requires(x)
    requires forall y {:trigger f(y)} {:trigger y in xs} :: y in ys ==> y in xs && f(y)
    ensures |ys| <= |xs|
    decreases xs, ys
  {
    if ys != {} {
      var y :| y in ys;
      var xs' := xs - {y};
      var ys' := ys - {y};
      LemmaFilterSize(xs', ys', f);
    }
  }

  opaque function Filter<X(!new)>(f: X ~> bool, xs: set<X>): (ys: set<X>)
    requires forall x {:trigger f.requires(x)} {:trigger x in xs} :: x in xs ==> f.requires(x)
    reads set x, o | x in xs && o in f.reads(x) :: o
    ensures forall y {:trigger f(y)} {:trigger y in xs} :: y in ys <==> y in xs && f(y)
    ensures |ys| <= |xs|
  {
    var ys := set x | x in xs && f(x);
    LemmaFilterSize(xs, ys, f);
    ys
  }

  lemma LemmaUnionSize<X>(xs: set<X>, ys: set<X>)
    ensures |xs + ys| >= |xs|
    ensures |xs + ys| >= |ys|
  {
    if ys == {} {
    } else {
      var y :| y in ys;
      if y in xs {
        var xr := xs - {y};
        var yr := ys - {y};
        assert xr + yr == xs + ys - {y};
        LemmaUnionSize(xr, yr);
      } else {
        var yr := ys - {y};
        assert xs + yr == xs + ys - {y};
        LemmaUnionSize(xs, yr);
      }
    }
  }

  opaque function SetRange(a: int, b: int): (s: set<int>)
    requires a <= b
    ensures forall i {:trigger i in s} :: a <= i < b <==> i in s
    ensures |s| == b - a
    decreases b - a
  {
    if a == b then
      {}
    else
      {a} + SetRange(a + 1, b)
  }

  opaque function SetRangeZeroBound(n: int): (s: set<int>)
    requires n >= 0
    ensures forall i {:trigger i in s} :: 0 <= i < n <==> i in s
    ensures |s| == n
  {
    SetRange(0, n)
  }

  lemma LemmaBoundedSetSize(x: set<int>, a: int, b: int)
    requires forall i {:trigger i in x} :: i in x ==> a <= i < b
    requires a <= b
    ensures |x| <= b - a
  {
    var range := SetRange(a, b);
    forall e {:trigger e in range} {:trigger e in x} | e in x
      ensures e in range
    {
    }
    assert x <= range;
    LemmaSubsetSize(x, range);
  }

  lemma LemmaGreatestImpliesMaximal<T(!new)>(R: (T, T) -> bool, max: T, s: set<T>)
    requires IsGreatest(R, max, s)
    ensures IsMaximal(R, max, s)
  {
  }

  lemma LemmaLeastImpliesMinimal<T(!new)>(R: (T, T) -> bool, min: T, s: set<T>)
    requires IsLeast(R, min, s)
    ensures IsMinimal(R, min, s)
  {
  }

  lemma LemmaMaximalEquivalentGreatest<T(!new)>(R: (T, T) -> bool, max: T, s: set<T>)
    requires TotalOrdering(R)
    ensures IsGreatest(R, max, s) <==> IsMaximal(R, max, s)
  {
  }

  lemma LemmaMinimalEquivalentLeast<T(!new)>(R: (T, T) -> bool, min: T, s: set<T>)
    requires TotalOrdering(R)
    ensures IsLeast(R, min, s) <==> IsMinimal(R, min, s)
  {
  }

  lemma LemmaLeastIsUnique<T(!new)>(R: (T, T) -> bool, s: set<T>)
    requires PartialOrdering(R)
    ensures forall min, min' | IsLeast(R, min, s) && IsLeast(R, min', s) :: min == min'
  {
  }

  lemma LemmaGreatestIsUnique<T(!new)>(R: (T, T) -> bool, s: set<T>)
    requires PartialOrdering(R)
    ensures forall max, max' | IsGreatest(R, max, s) && IsGreatest(R, max', s) :: max == max'
  {
  }

  lemma LemmaMinimalIsUnique<T(!new)>(R: (T, T) -> bool, s: set<T>)
    requires TotalOrdering(R)
    ensures forall min, min' | IsMinimal(R, min, s) && IsMinimal(R, min', s) :: min == min'
  {
  }

  lemma LemmaMaximalIsUnique<T(!new)>(R: (T, T) -> bool, s: set<T>)
    requires TotalOrdering(R)
    ensures forall max, max' | IsMaximal(R, max, s) && IsMaximal(R, max', s) :: max == max'
  {
  }

  lemma LemmaFindUniqueMinimal<T(!new)>(R: (T, T) -> bool, s: set<T>) returns (min: T)
    requires |s| > 0 && TotalOrdering(R)
    ensures IsMinimal(R, min, s) && forall min': T | IsMinimal(R, min', s) :: min == min'
  {
    var x :| x in s;
    if s == {x} {
      min := x;
    } else {
      var min' := LemmaFindUniqueMinimal(R, s - {x});
      if
      case R(min', x) =>
        min := min';
      case R(x, min') =>
        min := x;
    }
  }

  lemma LemmaFindUniqueMaximal<T(!new)>(R: (T, T) -> bool, s: set<T>) returns (max: T)
    requires |s| > 0 && TotalOrdering(R)
    ensures IsMaximal(R, max, s) && forall max': T | IsMaximal(R, max', s) :: max == max'
  {
    var x :| x in s;
    if s == {x} {
      max := x;
    } else {
      var max' := LemmaFindUniqueMaximal(R, s - {x});
      if
      case R(max', x) =>
        max := x;
      case R(x, max') =>
        max := max';
    }
  }

  import opened Functions

  import opened Relations
}

module Std.Collections.Tuple {
  function T2_0<L, R>(): ((L, R)) -> L
  {
    (lr: (L, R)) => lr.0
  }

  function T2_1<L, R>(): ((L, R)) -> R
  {
    (lr: (L, R)) => lr.1
  }
}

module Std.DynamicArray {

  import opened BoundedInts

  import opened Wrappers

  export
    reveals DynamicArray
    provides BoundedInts, DynamicArray.items, DynamicArray.capacity, DynamicArray.Repr, DynamicArray.Valid?, DynamicArray.size, DynamicArray.At, DynamicArray.Put, DynamicArray.Push, DynamicArray.PushFast, DynamicArray.PopFast, DynamicArray.Ensure

  class DynamicArray<A> {
    ghost var items: seq<A>
    ghost var Repr: set<object>
    var size: nat
    var capacity: nat
    var data: array<A>

    ghost predicate Valid?()
      reads this, Repr
    {
      Repr == {this, data} &&
      data.Length == capacity as int &&
      size <= capacity &&
      size as int == |items| &&
      items == data[..size]
    }

    constructor ()
      ensures size == 0
      ensures items == []
      ensures fresh(Repr)
      ensures capacity == 0
      ensures Valid?()
    {
      items := [];
      size := 0;
      capacity := 0;
      data := new A[0];
      Repr := {this, data};
    }

    function At(index: nat): (element: A)
      requires index < size
      requires Valid?()
      reads this, Repr
      ensures element == items[index]
    {
      data[index]
    }

    method Put(index: nat, element: A)
      requires index < size
      requires Valid?()
      reads this, Repr
      modifies Repr, `items
      ensures Valid?()
      ensures fresh(Repr - old(Repr))
      ensures size == old(size)
      ensures items == old(items)[index := element]
    {
      data[index] := element;
      items := items[index := element];
    }

    method Ensure(reserved: nat, defaultValue: A)
      requires Valid?()
      reads this, Repr
      modifies Repr
      ensures Valid?()
      ensures size == old(size)
      ensures items == old(items)
      ensures fresh(Repr - old(Repr))
      ensures reserved <= capacity - size
    {
      var newCapacity := capacity;
      while reserved > newCapacity - size
        invariant newCapacity >= capacity
      {
        newCapacity := DefaultNewCapacity(newCapacity);
      }
      if newCapacity > capacity {
        Realloc(defaultValue, newCapacity);
      }
    }

    method PopFast()
      requires Valid?()
      requires size > 0
      modifies `size, `items
      ensures Valid?()
      ensures size < capacity
      ensures size == old(size) - 1
      ensures capacity == old(capacity)
      ensures items == old(items[..|items| - 1])
    {
      size := size - 1;
      items := items[..|items| - 1];
    }

    method PushFast(element: A)
      requires Valid?()
      requires size < capacity
      reads this, Repr
      modifies Repr
      ensures Valid?()
      ensures fresh(Repr - old(Repr))
      ensures size == old(size) + 1
      ensures capacity == old(capacity)
      ensures items == old(items) + [element]
    {
      data[size] := element;
      size := size + 1;
      items := items + [element];
    }

    method Push(element: A)
      requires Valid?()
      reads this, Repr
      modifies Repr
      ensures Valid?()
      ensures fresh(Repr - old(Repr))
      ensures size == old(size) + 1
      ensures items == old(items) + [element]
      ensures capacity >= old(capacity)
    {
      if size == capacity {
        ReallocDefault(element);
      }
      PushFast(element);
    }

    method Realloc(defaultValue: A, newCapacity: nat)
      requires Valid?()
      requires newCapacity > capacity
      reads this, Repr
      modifies `capacity, `data, `Repr, data
      ensures Valid?()
      ensures capacity == newCapacity
      ensures fresh(data)
    {
      var oldData, oldCapacity := data, capacity;
      data, capacity := new A[newCapacity] (_ /* _v0 */ => defaultValue), newCapacity;
      CopyFrom(oldData, oldCapacity);
      Repr := {this, data};
    }

    function DefaultNewCapacity(capacity: nat): nat
    {
      if capacity == 0 then
        8
      else
        2 * capacity
    }

    method ReallocDefault(defaultValue: A)
      requires Valid?()
      reads this, Repr
      modifies `capacity, `data, `Repr, data
      ensures Valid?()
      ensures fresh(data)
      ensures capacity == old(DefaultNewCapacity(capacity))
    {
      Realloc(defaultValue, DefaultNewCapacity(capacity));
    }

    method CopyFrom(newData: array<A>, count: nat)
      requires count as int <= newData.Length
      requires count <= capacity
      requires data.Length == capacity as int
      reads this, Repr, data, newData
      modifies data
      ensures data[..count] == newData[..count]
      ensures data[count..] == old(data[count..])
    {
      forall index | 0 <= index < count {
        data[index] := newData[index];
      }
    }
  }
}

module Std.Frames {

  import opened Termination
  trait Validatable extends object {
    ghost var Repr: set<object>

    ghost predicate Valid()
      reads this, Repr
      ensures Valid() ==> this in Repr
      decreases Repr, 0

    twostate predicate ValidChange()
      reads this, Repr
      ensures ValidChange() ==> old(Valid()) && Valid() && fresh(Repr - old(Repr))

    twostate lemma ValidImpliesValidChange()
      requires old(Valid())
      requires unchanged(old(Repr))
      ensures ValidChange()

    ghost predicate ValidComponent(component: Validatable)
      reads this, Repr
    {
      component in Repr &&
      component.Repr <= Repr &&
      this !in component.Repr &&
      component.Valid()
    }

    twostate predicate ValidComponentChange(component: Validatable)
      reads this, Repr
    {
      ValidComponent(component) &&
      component.ValidChange()
    }

    ghost function ReprTerminationMetric(): TerminationMetric
      reads this
    {
      TMSet(set o | o in Repr :: TMObject(o))
    }

    twostate predicate ValidAndDisjoint()
      reads this, Repr
    {
      Valid() &&
      fresh(Repr - old(Repr))
    }
  }

  class GhostBox<T> {
    ghost var value: T

    ghost constructor (value: T)
      reads {}
      ensures this.value == value
    {
      this.value := value;
    }
  }

  class Box<T> {
    var value: T

    constructor (value: T)
      reads {}
      ensures this.value == value
    {
      this.value := value;
    }
  }
}

module Std.Functions {
  ghost predicate Injective<X(!new), Y>(f: X --> Y)
    requires forall x :: f.requires(x)
    reads f.reads
  {
    forall x1, x2 :: 
      f(x1) == f(x2) ==>
        x1 == x2
  }

  ghost predicate Commutative<T(!new), U(!new)>(f: (T, T) -> U)
    requires forall x, y :: f.requires(x, y) && f.requires(y, x)
    reads f.reads
  {
    forall x, y :: 
      f(x, y) == f(y, x)
  }

  ghost predicate Associative<T(!new)>(f: (T, T) -> T)
    requires forall x, y, z :: f.requires(x, y) && f.requires(y, z) && f.requires(x, z)
    reads f.reads
  {
    forall x, y, z: T :: 
      f(x, f(y, z)) == f(f(x, y), z)
  }
}

module Std.JSON.API {
  function Serialize(js: Values.JSON): (bs: SerializationResult<seq<byte>>)
  {
    var js :- Serializer.JSON(js); ZeroCopy.Serialize(js)
  }

  method SerializeAlloc(js: Values.JSON) returns (bs: SerializationResult<array<byte>>)
  {
    var js :- Serializer.JSON(js);
    bs := ZeroCopy.SerializeAlloc(js);
  }

  method SerializeInto(js: Values.JSON, bs: array<byte>) returns (len: SerializationResult<uint32>)
    modifies bs
  {
    var js :- Serializer.JSON(js);
    len := ZeroCopy.SerializeInto(js, bs);
  }

  function Deserialize(bs: seq<byte>): (js: DeserializationResult<Values.JSON>)
  {
    var js :- ZeroCopy.Deserialize(bs); Deserializer.JSON(js)
  }

  import Values

  import Serializer

  import Deserializer

  import ZeroCopy = ZeroCopy.API

  import opened BoundedInts

  import opened Errors
}

@DisableNonlinearArithmetic
module Std.JSON.ByteStrConversion refines Strings.ParametricConversion {
  const chars := ['0' as byte, '1' as byte, '2' as byte, '3' as byte, '4' as byte, '5' as byte, '6' as byte, '7' as byte, '8' as byte, '9' as byte]
  const charToDigit := map['0' as byte := 0, '1' as byte := 1, '2' as byte := 2, '3' as byte := 3, '4' as byte := 4, '5' as byte := 5, '6' as byte := 6, '7' as byte := 7, '8' as byte := 8, '9' as byte := 9]

  lemma CharsConsistent()
    ensures forall c | c in chars :: c in charToDigit && chars[charToDigit[c]] == c
  {
  }

  import opened BoundedInts

  type Char = byte
}

module Std.JSON.ConcreteSyntax.Spec {
  function View(v: Vs.View): bytes
  {
    v.Bytes()
  }

  function Structural<T>(self: Structural<T>, fT: T -> bytes): bytes
  {
    View(self.before) + fT(self.t) + View(self.after)
  }

  function StructuralView(self: Structural<Vs.View>): bytes
  {
    Structural<Vs.View>(self, View)
  }

  function Maybe<T>(self: Maybe<T>, fT: T -> bytes): (bs: bytes)
    ensures self.Empty? ==> bs == []
    ensures self.NonEmpty? ==> bs == fT(self.t)
  {
    if self.Empty? then
      []
    else
      fT(self.t)
  }

  function ConcatBytes<T>(ts: seq<T>, fT: T --> bytes): (b: bytes)
    requires forall d | d in ts :: fT.requires(d)
    ensures |ts| == 1 ==> b == fT(ts[0])
  {
    if |ts| == 0 then
      []
    else
      fT(ts[0]) + ConcatBytes(ts[1..], fT)
  }

  function Bracketed<D, S>(self: Bracketed<Vs.View, D, S, Vs.View>, fDatum: Suffixed<D, S> --> bytes): bytes
    requires forall d | d < self :: fDatum.requires(d)
  {
    StructuralView(self.l) + ConcatBytes(self.data, fDatum) + StructuralView(self.r)
  }

  function KeyValue(self: jKeyValue): bytes
  {
    String(self.k) + StructuralView(self.colon) + Value(self.v)
  }

  function Frac(self: jfrac): bytes
  {
    View(self.period) + View(self.num)
  }

  function Exp(self: jexp): bytes
  {
    View(self.e) + View(self.sign) + View(self.num)
  }

  function Number(self: jnumber): bytes
  {
    View(self.minus) + View(self.num) + Maybe(self.frac, Frac) + Maybe(self.exp, Exp)
  }

  function String(self: jstring): bytes
  {
    View(self.lq) + View(self.contents) + View(self.rq)
  }

  function CommaSuffix(c: Maybe<Structural<jcomma>>): bytes
  {
    Maybe<Structural<Vs.View>>(c, StructuralView)
  }

  function Member(self: jmember): bytes
  {
    KeyValue(self.t) + CommaSuffix(self.suffix)
  }

  function Item(self: jitem): bytes
  {
    Value(self.t) + CommaSuffix(self.suffix)
  }

  function Object(obj: jobject): bytes
  {
    Bracketed(obj, (d: jmember) requires d < obj => Member(d))
  }

  function Array(arr: jarray): bytes
  {
    Bracketed(arr, (d: jitem) requires d < arr => Item(d))
  }

  function Value(self: Value): (b: bytes)
    ensures self.String? ==> b == String(self.str)
    ensures self.Number? ==> b == Number(self.num)
    ensures self.Object? ==> b == Object(self.obj)
    ensures self.Array? ==> b == Array(self.arr)
  {
    match self {
      case Null(n) =>
        View(n)
      case Bool(b) =>
        View(b)
      case String(str) =>
        String(str)
      case Number(num) =>
        Number(num)
      case Object(obj) =>
        Object(obj)
      case Array(arr) =>
        Array(arr)
    }
  }

  lemma UnfoldValueNumber(v: Value)
    requires v.Number?
    ensures Value(v) == Number(v.num)
  {
    assert Value(v) == match v { case Number(num) => Number(num) case _ /* _v0 */ => [] };
  }

  lemma UnfoldValueObject(v: Value)
    requires v.Object?
    ensures Value(v) == Object(v.obj)
  {
    assert Value(v) == match v { case Object(obj) => Object(obj) case _ /* _v1 */ => [] };
  }

  lemma UnfoldValueArray(v: Value)
    requires v.Array?
    ensures Value(v) == Array(v.arr)
  {
    assert Value(v) == match v { case Array(arr) => Array(arr) case _ /* _v2 */ => [] };
  }

  function JSON(js: JSON): bytes
  {
    Structural(js, Value)
  }

  import Vs = Utils.Views.Core

  import opened BoundedInts

  import opened Grammar
}

module Std.JSON.ConcreteSyntax.SpecProperties {
  ghost predicate Bracketed_Morphism_Requires<D, S>(bracketed: Bracketed<Vs.View, D, S, Vs.View>, pd0: Suffixed<D, S> --> bytes, pd1: Suffixed<D, S> --> bytes)
  {
    (forall d | d < bracketed :: 
      pd0.requires(d)) &&
    (forall d | d < bracketed :: 
      pd1.requires(d)) &&
    forall d | d < bracketed :: 
      pd0(d) == pd1(d)
  }

  lemma Bracketed_Morphism<D, S>(bracketed: Bracketed<Vs.View, D, S, Vs.View>, pd0: Suffixed<D, S> --> bytes, pd1: Suffixed<D, S> --> bytes)
    requires Bracketed_Morphism_Requires(bracketed, pd0, pd1)
    ensures Spec.Bracketed(bracketed, pd0) == Spec.Bracketed(bracketed, pd1)
  {
    calc {
      Spec.Bracketed(bracketed, pd0);
      {
        ConcatBytes_Morphism(bracketed.data, pd0, pd1);
      }
      Spec.Bracketed(bracketed, pd1);
    }
  }

  lemma {:induction ts} ConcatBytes_Morphism<T>(ts: seq<T>, pt0: T --> bytes, pt1: T --> bytes)
    requires forall d | d in ts :: pt0.requires(d)
    requires forall d | d in ts :: pt1.requires(d)
    requires forall d | d in ts :: pt0(d) == pt1(d)
    ensures Spec.ConcatBytes(ts, pt0) == Spec.ConcatBytes(ts, pt1)
  {
  }

  @ResourceLimit("10e6") lemma {:induction ts0} ConcatBytes_Linear<T>(ts0: seq<T>, ts1: seq<T>, pt: T --> bytes)
    requires forall d | d in ts0 :: pt.requires(d)
    requires forall d | d in ts1 :: pt.requires(d)
    ensures Spec.ConcatBytes(ts0 + ts1, pt) == Spec.ConcatBytes(ts0, pt) + Spec.ConcatBytes(ts1, pt)
  {
    if |ts0| == 0 {
      assert [] + ts1 == ts1;
    } else {
      assert ts0 + ts1 == [ts0[0]] + (ts0[1..] + ts1);
    }
  }

  import Spec

  import Vs = Utils.Views.Core

  import opened BoundedInts

  import opened Grammar
}

module Std.JSON.Deserializer {
  function Bool(js: Grammar.jbool): bool
  {
    assert js.Bytes() in {Grammar.TRUE, Grammar.FALSE};
    js.At(0) == 't' as byte
  }

  function UnsupportedEscape16(code: seq<uint16>): DeserializationError
  {
    UnsupportedEscape(FromUTF16Checked(code).ToOption().GetOr("Couldn't decode UTF-16"))
  }

  const HEX_TABLE_16 := Uint16StrConversion.charToDigit

  function ToNat16(str: Uint16StrConversion.String): uint16
    requires |str| <= 4
    requires forall c | c in str :: c in HEX_TABLE_16
  {
    assume {:axiom} false;
    Uint16StrConversion.ToNatBound(str);
    var hd := Uint16StrConversion.ToNat(str);
    assert hd < 65536;
    hd as uint16
  }

  @TailRecursion @IsolateAssertions function Unescape(str: seq<uint16>, start: nat := 0, prefix: seq<uint16> := []): DeserializationResult<seq<uint16>>
    decreases |str| - start
  {
    if start >= |str| then
      Success(prefix)
    else if str[start] == '\\' as uint16 then
      if |str| == start + 1 then
        Failure(EscapeAtEOS)
      else
        var c := str[start + 1]; if c == 'u' as uint16 then if |str| < start + 6 then Failure(EscapeAtEOS) else var code := str[start + 2 .. start + 6]; if exists c | c in code :: c !in HEX_TABLE_16 then Failure(UnsupportedEscape16(code)) else var hd := ToNat16(code); Unescape(str, start + 6, prefix + [hd]) else var unescaped: uint16 := match c case 34 => 34 as uint16 case 92 => 92 as uint16 case 98 => 8 as uint16 case 102 => 12 as uint16 case 110 => 10 as uint16 case 114 => 13 as uint16 case 116 => 9 as uint16 case _ /* _v0 */ => 0 as uint16; if unescaped as int == 0 then Failure(UnsupportedEscape16(str[start .. start + 2])) else Unescape(str, start + 2, prefix + [unescaped])
    else
      Unescape(str, start + 1, prefix + [str[start]])
  }

  function String(js: Grammar.jstring): DeserializationResult<string>
  {
    var asUtf32 :- FromUTF8Checked(js.contents.Bytes()).MapFailure((error: string) => DeserializationError.InvalidUnicode(error)); var asUint16 :- ToUTF16Checked(asUtf32).ToResult(DeserializationError.InvalidUnicode("")); var unescaped :- Unescape(asUint16); FromUTF16Checked(unescaped).MapFailure((error: string) => DeserializationError.InvalidUnicode(error))
  }

  const DIGITS := ByteStrConversion.charToDigit
  const MINUS := '-' as uint8

  function ToInt(sign: jsign, n: jnum): DeserializationResult<int>
  {
    var n: int := ByteStrConversion.ToNat(n.Bytes());
    Success(if sign.Char?('-') then -n else n)
  }

  function Number(js: Grammar.jnumber): DeserializationResult<Values.Decimal>
  {
    var JNumber(minus, num, frac, exp) := js;
    var n :- ToInt(minus, num); var e10 :- match exp case Empty => Success(0) case NonEmpty(JExp(_ /* _v1 */, sign, num)) => ToInt(sign, num); match frac case Empty => Success(Values.Decimal(n, e10)) case NonEmpty(JFrac(_ /* _v2 */, num)) => var pow10 := num.Length() as int; var frac :- ToInt(minus, num); Success(Values.Decimal(n * Pow(10, pow10) + frac, e10 - pow10))
  }

  function KeyValue(js: Grammar.jKeyValue): DeserializationResult<(string, Values.JSON)>
  {
    var k :- String(js.k); var v :- Value(js.v); Success((k, v))
  }

  function Object(js: Grammar.jobject): DeserializationResult<seq<(string, Values.JSON)>>
  {
    var f := d requires d in js.data => KeyValue(d.t);
    assert forall i :: 0 <= i < |js.data| ==> f.requires(js.data[i]);
    Seq.MapWithResult(f, js.data)
  }

  function Array(js: Grammar.jarray): DeserializationResult<seq<Values.JSON>>
  {
    var f := d requires d in js.data => Value(d.t);
    assert forall i :: 0 <= i < |js.data| ==> f.requires(js.data[i]);
    Seq.MapWithResult(f, js.data)
  }

  function Value(js: Grammar.Value): DeserializationResult<Values.JSON>
  {
    match js
    case Null(_ /* _v3 */) =>
      Success(Values.Null())
    case Bool(b) =>
      Success(Values.Bool(Bool(b)))
    case String(str) =>
      var s :- String(str); Success(Values.String(s))
    case Number(dec) =>
      var n :- Number(dec); Success(Values.Number(n))
    case Object(obj) =>
      var o :- Object(obj); Success(Values.Object(o))
    case Array(arr) =>
      var a :- Array(arr); Success(Values.Array(a))
  }

  function JSON(js: Grammar.JSON): DeserializationResult<Values.JSON>
  {
    Value(js.t)
  }

  import Values

  import Spec

  import ByteStrConversion

  import opened Seq = Collections.Seq

  import opened Wrappers

  import opened BoundedInts

  import opened Logarithm = Arithmetic.Logarithm

  import opened Power = Arithmetic.Power

  import opened Strings

  import opened UnicodeStringsWithUnicodeChar = Unicode.UnicodeStringsWithUnicodeChar

  import opened Errors

  import opened DynamicArray

  import opened Grammar

  import opened Core = Utils.Views.Core

  @DisableNonlinearArithmetic
  module Uint16StrConversion refines Strings.ParametricConversion {
    const chars := ['0' as uint16, '1' as uint16, '2' as uint16, '3' as uint16, '4' as uint16, '5' as uint16, '6' as uint16, '7' as uint16, '8' as uint16, '9' as uint16, 'a' as uint16, 'b' as uint16, 'c' as uint16, 'd' as uint16, 'e' as uint16, 'f' as uint16, 'A' as uint16, 'B' as uint16, 'C' as uint16, 'D' as uint16, 'E' as uint16, 'F' as uint16]
    const charToDigit := map['0' as uint16 := 0, '1' as uint16 := 1, '2' as uint16 := 2, '3' as uint16 := 3, '4' as uint16 := 4, '5' as uint16 := 5, '6' as uint16 := 6, '7' as uint16 := 7, '8' as uint16 := 8, '9' as uint16 := 9, 'a' as uint16 := 10, 'b' as uint16 := 11, 'c' as uint16 := 12, 'd' as uint16 := 13, 'e' as uint16 := 14, 'f' as uint16 := 15, 'A' as uint16 := 10, 'B' as uint16 := 11, 'C' as uint16 := 12, 'D' as uint16 := 13, 'E' as uint16 := 14, 'F' as uint16 := 15]

    @Axiom lemma CharsConsistent()
      ensures forall c | c in chars :: c in charToDigit && chars[charToDigit[c]] == c

    import opened BoundedInts

    type Char = uint16
  }
}

module Std.JSON.Errors {

  import Wrappers

  import Strings

  import opened BoundedInts
  datatype DeserializationError = UnterminatedSequence | UnsupportedEscape(str: string) | EscapeAtEOS | EmptyNumber | ExpectingEOF | IntOverflow | ReachedEOF | ExpectingByte(expected: byte, b: opt_byte) | ExpectingAnyByte(expected_sq: seq<byte>, b: opt_byte) | InvalidUnicode(str: string) {
    function ToString(): string
    {
      match this
      case UnterminatedSequence =>
        "Unterminated sequence"
      case UnsupportedEscape(str) =>
        "Unsupported escape sequence: " + str
      case EscapeAtEOS =>
        "Escape character at end of string"
      case EmptyNumber =>
        "Number must contain at least one digit"
      case ExpectingEOF =>
        "Expecting EOF"
      case IntOverflow =>
        "Input length does not fit in a 32-bit counter"
      case ReachedEOF =>
        "Reached EOF"
      case ExpectingByte(b0, b) =>
        var c := if b > 0 then "'" + [b as char] + "'" else "EOF";
        "Expecting '" + [b0 as char] + "', read " + c
      case ExpectingAnyByte(bs0, b) =>
        var c := if b > 0 then "'" + [b as char] + "'" else "EOF";
        var c0s := seq(|bs0|, idx requires 0 <= idx < |bs0| => bs0[idx] as char);
        "Expecting one of '" + c0s + "', read " + c
      case InvalidUnicode(str) =>
        if str == "" then
          "Invalid Unicode sequence"
        else
          str
    }
  }

  datatype SerializationError = OutOfMemory | IntTooLarge(i: int) | StringTooLong(s: string) | InvalidUnicode {
    function ToString(): string
    {
      match this
      case OutOfMemory =>
        "Out of memory"
      case IntTooLarge(i: int) =>
        "Integer too large: " + Strings.OfInt(i)
      case StringTooLong(s: string) =>
        "String too long: " + s
      case InvalidUnicode =>
        "Invalid Unicode sequence"
    }
  }

  type SerializationResult<+T> = Wrappers.Result<T, SerializationError>

  type DeserializationResult<+T> = Wrappers.Result<T, DeserializationError>
}

module Std.JSON.Grammar {
  const EMPTY := View.OfBytes([])
  const DOUBLEQUOTE := View.OfBytes(['\"' as byte])
  const PERIOD := View.OfBytes(['.' as byte])
  const E := View.OfBytes(['e' as byte])
  const COLON := View.OfBytes([':' as byte])
  const COMMA := View.OfBytes([',' as byte])
  const LBRACE := View.OfBytes(['{' as byte])
  const RBRACE := View.OfBytes(['}' as byte])
  const LBRACKET := View.OfBytes(['[' as byte])
  const RBRACKET := View.OfBytes([']' as byte])
  const MINUS := View.OfBytes(['-' as byte])

  predicate Blank?(b: byte)
  {
    b == 32 || b == 9 || b == 10 || b == 13
  }

  ghost predicate Blanks?(v: View)
  {
    forall b | b in v.Bytes() :: 
      Blank?(b)
  }

  ghost predicate NoTrailingSuffix<S, D>(s: seq<Suffixed<D, S>>)
  {
    forall idx | 0 <= idx < |s| :: 
      s[idx].suffix.Empty? <==> idx == |s| - 1
  }

  const NULL: bytes := ['n' as byte, 'u' as byte, 'l' as byte, 'l' as byte]
  const TRUE: bytes := ['t' as byte, 'r' as byte, 'u' as byte, 'e' as byte]
  const FALSE: bytes := ['f' as byte, 'a' as byte, 'l' as byte, 's' as byte, 'e' as byte]

  ghost predicate Null?(v: View)
  {
    v.Bytes() == NULL
  }

  ghost predicate Bool?(v: View)
  {
    v.Bytes() in {TRUE, FALSE}
  }

  predicate Digit?(b: byte)
  {
    '0' as byte <= b <= '9' as byte
  }

  ghost predicate Digits?(v: View)
  {
    forall b | b in v.Bytes() :: 
      Digit?(b)
  }

  ghost predicate Num?(v: View)
  {
    Digits?(v) &&
    !v.Empty?
  }

  ghost predicate Int?(v: View)
  {
    v.Char?('0') || (Num?(v) && v.At(0) != '0' as byte)
  }

  import opened BoundedInts

  import opened Core = Utils.Views.Core

  type jchar = v: View
    | v.Length() == 1
    witness View.OfBytes(['b' as byte])

  type jquote = v: View
    | v.Char?('\"')
    witness DOUBLEQUOTE

  type jperiod = v: View
    | v.Char?('.')
    witness PERIOD

  type je = v: View
    | v.Char?('e') || v.Char?('E')
    witness E

  type jcolon = v: View
    | v.Char?(':')
    witness COLON

  type jcomma = v: View
    | v.Char?(',')
    witness COMMA

  type jlbrace = v: View
    | v.Char?('{')
    witness LBRACE

  type jrbrace = v: View
    | v.Char?('}')
    witness RBRACE

  type jlbracket = v: View
    | v.Char?('[')
    witness LBRACKET

  type jrbracket = v: View
    | v.Char?(']')
    witness RBRACKET

  type jminus = v: View
    | v.Char?('-') || v.Empty?
    witness MINUS

  type jsign = v: View
    | v.Char?('-') || v.Char?('+') || v.Empty?
    witness EMPTY

  type jblanks = v: View
    | Blanks?(v)
    witness View.OfBytes([])

  datatype Structural<+T> = Structural(before: jblanks, t: T, after: jblanks)

  datatype Maybe<+T> = Empty | NonEmpty(t: T)

  datatype Suffixed<+T, +S> = Suffixed(t: T, suffix: Maybe<Structural<S>>)

  type SuffixedSequence<+D, +S> = s: seq<Suffixed<D, S>>
    | NoTrailingSuffix(s)

  datatype Bracketed<+L, +D, +S, +R> = Bracketed(l: Structural<L>, data: SuffixedSequence<D, S>, r: Structural<R>)

  type jnull = v: View
    | Null?(v)
    witness View.OfBytes(NULL)

  type jbool = v: View
    | Bool?(v)
    witness View.OfBytes(TRUE)

  type jdigits = v: View
    | Digits?(v)
    witness View.OfBytes([])

  type jnum = v: View
    | Num?(v)
    witness View.OfBytes(['0' as byte])

  type jint = v: View
    | Int?(v)
    witness View.OfBytes(['0' as byte])

  type jstr = v: View
    | true
    witness View.OfBytes([])

  datatype jstring = JString(lq: jquote, contents: jstr, rq: jquote)

  datatype jKeyValue = KeyValue(k: jstring, colon: Structural<jcolon>, v: Value)

  type jobject = Bracketed<jlbrace, jKeyValue, jcomma, jrbrace>

  type jarray = Bracketed<jlbracket, Value, jcomma, jrbracket>

  type jmembers = SuffixedSequence<jKeyValue, jcomma>

  type jmember = Suffixed<jKeyValue, jcomma>

  type jitems = SuffixedSequence<Value, jcomma>

  type jitem = Suffixed<Value, jcomma>

  datatype jfrac = JFrac(period: jperiod, num: jnum)

  datatype jexp = JExp(e: je, sign: jsign, num: jnum)

  datatype jnumber = JNumber(minus: jminus, num: jnum, frac: Maybe<jfrac>, exp: Maybe<jexp>)

  datatype Value = Null(n: jnull) | Bool(b: jbool) | String(str: jstring) | Number(num: jnumber) | Object(obj: jobject) | Array(arr: jarray)

  type JSON = Structural<Value>
}

module Std.JSON.Serializer {
  function Bool(b: bool): jbool
  {
    View.OfBytes(if b then TRUE else FALSE)
  }

  function CheckLength<T>(s: seq<T>, err: SerializationError): Outcome<SerializationError>
  {
    Outcome.Need(|s| < TWO_TO_THE_32, err)
  }

  function String(str: string): Result<jstring>
  {
    var bs :- Spec.EscapeToUTF8(str); var o := CheckLength(bs, StringTooLong(str)); if o.Pass? then Success(Grammar.JString(Grammar.DOUBLEQUOTE, View.OfBytes(bs), Grammar.DOUBLEQUOTE)) else Failure(o.error)
  }

  function Sign(n: int): jminus
  {
    View.OfBytes(if n < 0 then ['-' as byte] else [])
  }

  const DIGITS := ByteStrConversion.chars
  const MINUS := '-' as byte

  function Int'(n: int): (str: bytes)
    ensures forall c | c in str :: c in DIGITS || c == MINUS
  {
    ByteStrConversion.OfInt(n, MINUS)
  }

  function Int(n: int): Result<View>
  {
    var bs := Int'(n);
    var o := CheckLength(bs, IntTooLarge(n));
    if o.Pass? then
      Success(View.OfBytes(bs))
    else
      Failure(o.error)
  }

  @IsolateAssertions @ResourceLimit("1e6") function Number(dec: Values.Decimal): Result<jnumber>
  {
    var minus: jminus := Sign(dec.n);
    var num: jnum :- Int(Math.Abs(dec.n)); var frac: Maybe<jfrac> := Empty(); var exp: Maybe<jexp> :- if dec.e10 == 0 then Success(Empty()) else var e: je := View.OfBytes(['e' as byte]); var sign: jsign := Sign(dec.e10); var num: jnum :- Int(Math.Abs(dec.e10)); Success(NonEmpty(JExp(e, sign, num))); Success(JNumber(minus, num, Empty, exp))
  }

  function MkStructural<T>(v: T): Structural<T>
  {
    Structural(EMPTY, v, EMPTY)
  }

  const COLON: Structural<jcolon> := MkStructural(Grammar.COLON)

  function KeyValue(kv: (string, Values.JSON)): Result<jKeyValue>
  {
    var k :- String(kv.0); var v :- Value(kv.1); Success(Grammar.KeyValue(k, COLON, v))
  }

  function MkSuffixedSequence<D, S>(ds: seq<D>, suffix: Structural<S>, start: nat := 0): SuffixedSequence<D, S>
    decreases |ds| - start
  {
    if start >= |ds| then
      []
    else if start == |ds| - 1 then
      [Suffixed(ds[start], Empty)]
    else
      [Suffixed(ds[start], NonEmpty(suffix))] + MkSuffixedSequence(ds, suffix, start + 1)
  }

  const COMMA: Structural<jcomma> := MkStructural(Grammar.COMMA)

  function Object(obj: seq<(string, Values.JSON)>): Result<jobject>
  {
    var items :- Seq.MapWithResult(v requires v in obj => KeyValue(v), obj); Success(Bracketed(MkStructural(LBRACE), MkSuffixedSequence(items, COMMA), MkStructural(RBRACE)))
  }

  function Array(arr: seq<Values.JSON>): Result<jarray>
  {
    var items :- Seq.MapWithResult(v requires v in arr => Value(v), arr); Success(Bracketed(MkStructural(LBRACKET), MkSuffixedSequence(items, COMMA), MkStructural(RBRACKET)))
  }

  function Value(js: Values.JSON): Result<Grammar.Value>
  {
    match js
    case Null =>
      Success(Grammar.Null(View.OfBytes(NULL)))
    case Bool(b) =>
      Success(Grammar.Bool(Bool(b)))
    case String(str) =>
      var s :- String(str); Success(Grammar.String(s))
    case Number(dec) =>
      var n :- Number(dec); Success(Grammar.Number(n))
    case Object(obj) =>
      var o :- Object(obj); Success(Grammar.Object(o))
    case Array(arr) =>
      var a :- Array(arr); Success(Grammar.Array(a))
  }

  function JSON(js: Values.JSON): Result<Grammar.JSON>
  {
    var val :- Value(js); Success(MkStructural(val))
  }

  import Seq = Collections.Seq

  import Math

  import Values

  import Spec

  import opened Wrappers

  import opened BoundedInts

  import opened Strings

  import opened Errors

  import opened DynamicArray

  import opened Grammar

  import opened Core = Utils.Views.Core

  import ByteStrConversion

  type Result<+T> = SerializationResult<T>

  type bytes = seq<uint8>

  type bytes32 = bs: bytes
    | |bs| < TWO_TO_THE_32

  type string32 = s: string
    | |s| < TWO_TO_THE_32
}

module Std.JSON.Spec {
  function EscapeUnicode(c: uint16): seq<uint16>
  {
    var sStr := Strings.HexConversion.OfNat(c as nat);
    Seq.MembershipImpliesIndexing(c => 0 <= c as int < 128, sStr);
    var s := ASCIIToUTF16(sStr);
    assert |s| <= 4 by {
      assert c as nat <= 65535;
      assert Log(16, c as nat) <= Log(16, 65535) by {
        LemmaLogIsOrdered(16, c as nat, 65535);
      }
      assert Log(16, 65535) == 3;
    }
    seq(4 - |s|, _ /* _v0 */ => '0' as uint16) + s
  }

  function Escape(str: seq<uint16>, start: nat := 0): seq<uint16>
    decreases |str| - start
  {
    if start >= |str| then
      []
    else
      (match str[start] case 34 => ASCIIToUTF16("\\\"") case 92 => ASCIIToUTF16("\\\\") case 8 => ASCIIToUTF16("\\b") case 12 => ASCIIToUTF16("\\f") case 10 => ASCIIToUTF16("\\n") case 13 => ASCIIToUTF16("\\r") case 9 => ASCIIToUTF16("\\t") case c => (if c < 31 then ASCIIToUTF16("\\u") + EscapeUnicode(c) else [str[start]])) + Escape(str, start + 1)
  }

  function EscapeToUTF8(str: string, start: nat := 0): Result<bytes>
  {
    var utf16 :- ToUTF16Checked(str).ToResult(SerializationError.InvalidUnicode); var escaped := Escape(utf16); var utf32 :- FromUTF16Checked(escaped).ToOption().ToResult(SerializationError.InvalidUnicode); ToUTF8Checked(utf32).ToResult(SerializationError.InvalidUnicode)
  }

  function String(str: string): Result<bytes>
  {
    var inBytes :- EscapeToUTF8(str); Success(ASCIIToUTF8("\"") + inBytes + ASCIIToUTF8("\""))
  }

  lemma OfIntOnlyASCII(n: int)
    ensures true && var s := Strings.OfInt(n); true && forall i | 0 <= i < |s| :: 0 <= s[i] as int < 128
  {
    var s := Strings.OfInt(n);
    forall i | 0 <= i < |s|
      ensures 0 <= s[i] as int < 128
    {
      if i == 0 {
      } else {
        var isHexDigit := c => c in Strings.HexConversion.HEX_DIGITS;
        assert Strings.HexConversion.IsNumberStr(s, '-');
        assert isHexDigit(s[i]);
      }
    }
  }

  function IntToBytes(n: int): bytes
  {
    var s := Strings.OfInt(n);
    OfIntOnlyASCII(n);
    ASCIIToUTF8(s)
  }

  function Number(dec: Decimal): Result<bytes>
  {
    Success(IntToBytes(dec.n) + if dec.e10 == 0 then [] else ASCIIToUTF8("e") + IntToBytes(dec.e10))
  }

  function KeyValue(kv: (string, JSON)): Result<bytes>
  {
    var key :- String(kv.0); var value :- JSON(kv.1); Success(key + ASCIIToUTF8(":") + value)
  }

  function Join(sep: bytes, items: seq<Result<bytes>>): Result<bytes>
  {
    if |items| == 0 then
      Success([])
    else
      var first :- items[0]; if |items| == 1 then Success(first) else var rest :- Join(sep, items[1..]); Success(first + sep + rest)
  }

  function Object(obj: seq<(string, JSON)>): Result<bytes>
  {
    var middle :- Join(ASCIIToUTF8(","), seq(|obj|, i requires 0 <= i < |obj| => KeyValue(obj[i]))); Success(ASCIIToUTF8("{") + middle + ASCIIToUTF8("}"))
  }

  function Array(arr: seq<JSON>): Result<bytes>
  {
    var middle :- Join(ASCIIToUTF8(","), seq(|arr|, i requires 0 <= i < |arr| => JSON(arr[i]))); Success(ASCIIToUTF8("[") + middle + ASCIIToUTF8("]"))
  }

  function JSON(js: JSON): Result<bytes>
  {
    match js
    case Null =>
      Success(ASCIIToUTF8("null"))
    case Bool(b) =>
      Success(if b then ASCIIToUTF8("true") else ASCIIToUTF8("false"))
    case String(str) =>
      String(str)
    case Number(dec) =>
      Number(dec)
    case Object(obj) =>
      Object(obj)
    case Array(arr) =>
      Array(arr)
  }

  import Seq = Collections.Seq

  import opened BoundedInts

  import opened Strings

  import opened Values

  import opened Wrappers

  import opened Errors

  import opened UnicodeStringsWithUnicodeChar = Unicode.UnicodeStringsWithUnicodeChar

  import opened Logarithm = Arithmetic.Logarithm

  type Result<+T> = SerializationResult<T>
}

module Std.JSON.Utils.Cursors {

  import opened BoundedInts

  import opened Wrappers

  import opened Vs = Views.Core

  import opened Lx = Lexers.Core
  datatype Split<+T> = SP(t: T, cs: FreshCursor) {
    ghost predicate BytesSplitFrom?(cs0: Cursor, spec: T -> bytes)
    {
      cs0.Bytes() == spec(t) + cs.Bytes()
    }

    ghost predicate SplitFrom?(cs0: Cursor, spec: T -> bytes)
    {
      cs.SplitFrom?(cs0) &&
      BytesSplitFrom?(cs0, spec)
    }

    ghost predicate StrictlySplitFrom?(cs0: Cursor, spec: T -> bytes)
    {
      cs.StrictlySplitFrom?(cs0) &&
      BytesSplitFrom?(cs0, spec)
    }
  }

  type Cursor = ps: Cursor_
    | ps.Valid?
    witness Cursor([], 0, 0, 0)

  type FreshCursor = ps: Cursor
    | ps.BOF?
    witness Cursor([], 0, 0, 0)

  datatype CursorError<+R> = EOF | ExpectingByte(expected: byte, b: opt_byte) | ExpectingAnyByte(expected_sq: seq<byte>, b: opt_byte) | OtherError(err: R) {
    function ToString(pr: R -> string): string
    {
      match this
      case EOF =>
        "Reached EOF"
      case ExpectingByte(b0, b) =>
        var c := if b > 0 then "'" + [b as char] + "'" else "EOF";
        "Expecting '" + [b0 as char] + "', read " + c
      case ExpectingAnyByte(bs0, b) =>
        var c := if b > 0 then "'" + [b as char] + "'" else "EOF";
        var c0s := seq(|bs0|, idx requires 0 <= idx < |bs0| => bs0[idx] as char);
        "Expecting one of '" + c0s + "', read " + c
      case OtherError(err) =>
        pr(err)
    }
  }

  type CursorResult<+R> = Result<Cursor, CursorError<R>>

  datatype Cursor_ = Cursor(s: bytes, beg: uint32, point: uint32, end: uint32) {
    ghost const Valid?: bool := 0 <= beg as int <= point as int <= end as int <= |s| < TWO_TO_THE_32
    const BOF? := point == beg
    const EOF? := point == end

    static function OfView(v: View): FreshCursor
    {
      Cursor(v.s, v.beg, v.beg, v.end)
    }

    static function OfBytes(bs: bytes): FreshCursor
      requires |bs| < TWO_TO_THE_32
    {
      Cursor(bs, 0, 0, |bs| as uint32)
    }

    function Bytes(): bytes
      requires Valid?
    {
      s[beg .. end]
    }

    ghost predicate StrictlyAdvancedFrom?(other: Cursor): (b: bool)
      requires Valid?
      ensures b ==> SuffixLength() < other.SuffixLength()
      ensures b ==> beg == other.beg && end == other.end ==> forall idx | beg <= idx < point :: s[idx] == other.s[idx]
    {
      s == other.s &&
      beg == other.beg &&
      end == other.end &&
      point > other.point
    }

    ghost predicate AdvancedFrom?(other: Cursor)
      requires Valid?
    {
      this == other || StrictlyAdvancedFrom?(other)
    }

    ghost predicate StrictSuffixOf?(other: Cursor)
      requires Valid?
      ensures StrictSuffixOf?(other) ==> Length() < other.Length()
    {
      s == other.s &&
      beg > other.beg &&
      end == other.end
    }

    ghost predicate SuffixOf?(other: Cursor)
      requires Valid?
    {
      this == other || StrictSuffixOf?(other)
    }

    ghost predicate StrictlySplitFrom?(other: Cursor)
      requires Valid?
    {
      BOF? &&
      StrictSuffixOf?(other)
    }

    ghost predicate SplitFrom?(other: Cursor)
      requires Valid?
    {
      this == other || StrictlySplitFrom?(other)
    }

    function Prefix(): View
      requires Valid?
    {
      View(s, beg, point)
    }

    function Suffix(): Cursor
      requires Valid?
    {
      this.(beg := point)
    }

    function Split(): (sp: Split<View>)
      requires Valid?
      ensures sp.SplitFrom?(this, (v: View) => v.Bytes())
      ensures beg != point ==> sp.StrictlySplitFrom?(this, (v: View) => v.Bytes())
      ensures !BOF? ==> sp.StrictlySplitFrom?(this, (v: View) => v.Bytes()) && sp.cs.StrictSuffixOf?(this)
      ensures !EOF? <==> !sp.cs.EOF?
    {
      SP(this.Prefix(), this.Suffix())
    }

    function PrefixLength(): uint32
      requires Valid?
    {
      point - beg
    }

    function SuffixLength(): uint32
      requires Valid?
    {
      end - point
    }

    function Length(): uint32
      requires Valid?
    {
      end - beg
    }

    lemma PrefixSuffixLength()
      requires Valid?
      ensures Length() == PrefixLength() + SuffixLength()
    {
    }

    ghost predicate ValidIndex?(idx: uint32)
    {
      beg as int + idx as int < end as int
    }

    function At(idx: uint32): byte
      requires Valid?
      requires ValidIndex?(idx)
    {
      s[beg + idx]
    }

    ghost predicate ValidSuffixIndex?(idx: uint32)
    {
      point as int + idx as int < end as int
    }

    function SuffixAt(idx: uint32): byte
      requires Valid?
      requires ValidSuffixIndex?(idx)
    {
      s[point + idx]
    }

    function Peek(): (r: opt_byte)
      requires Valid?
      ensures r < 0 <==> EOF?
    {
      if EOF? then
        -1
      else
        SuffixAt(0) as opt_byte
    }

    predicate LookingAt(c: char): (b: bool)
      requires Valid?
      requires c as int < 256
      ensures b <==> !EOF? && SuffixAt(0) == c as byte
    {
      Peek() == c as opt_byte
    }

    function Skip(n: uint32): (ps: Cursor)
      requires Valid?
      requires point as int + n as int <= end as int
      ensures n == 0 ==> ps == this
      ensures n > 0 ==> ps.StrictlyAdvancedFrom?(this)
    {
      this.(point := point + n)
    }

    function Unskip(n: uint32): Cursor
      requires Valid?
      requires beg as int <= point as int - n as int
    {
      this.(point := point - n)
    }

    function Get<R>(err: R): (ppr: CursorResult<R>)
      requires Valid?
      ensures ppr.Success? ==> ppr.value.StrictlyAdvancedFrom?(this)
    {
      if EOF? then
        Failure(OtherError(err))
      else
        Success(Skip(1))
    }

    function AssertByte<R>(b: byte): (pr: CursorResult<R>)
      requires Valid?
      ensures pr.Success? ==> !EOF?
      ensures pr.Success? ==> s[point] == b
      ensures pr.Success? ==> pr.value.StrictlyAdvancedFrom?(this)
    {
      var nxt := Peek();
      if nxt == b as opt_byte then
        Success(Skip(1))
      else
        Failure(ExpectingByte(b, nxt))
    }

    @TailRecursion function AssertBytes<R>(bs: bytes, offset: uint32 := 0): (pr: CursorResult<R>)
      requires Valid?
      requires |bs| < TWO_TO_THE_32
      requires offset <= |bs| as uint32
      requires forall b | b in bs :: b as int < 256
      ensures pr.Success? ==> pr.value.AdvancedFrom?(this)
      ensures pr.Success? && offset < |bs| as uint32 ==> pr.value.StrictlyAdvancedFrom?(this)
      ensures pr.Success? ==> s[point .. pr.value.point] == bs[offset..]
      decreases SuffixLength()
    {
      if offset == |bs| as uint32 then
        Success(this)
      else
        var ps :- AssertByte(bs[offset] as byte); ps.AssertBytes(bs, offset + 1)
    }

    function AssertChar<R>(c0: char): (pr: CursorResult<R>)
      requires Valid?
      requires c0 as int < 256
      ensures pr.Success? ==> pr.value.StrictlyAdvancedFrom?(this)
    {
      AssertByte(c0 as byte)
    }

    function SkipByte(): (ps: Cursor)
      requires Valid?
      ensures ps.AdvancedFrom?(this)
      ensures !EOF? ==> ps.StrictlyAdvancedFrom?(this)
      decreases SuffixLength()
    {
      if EOF? then
        this
      else
        Skip(1)
    }

    function SkipIf(p: byte -> bool): (ps: Cursor)
      requires Valid?
      ensures ps.AdvancedFrom?(this)
      ensures !EOF? && p(SuffixAt(0)) ==> ps.StrictlyAdvancedFrom?(this)
      decreases SuffixLength()
    {
      if EOF? || !p(SuffixAt(0)) then
        this
      else
        Skip(1)
    }

    function SkipWhile(p: byte -> bool): (ps: Cursor)
      requires Valid?
      ensures ps.AdvancedFrom?(this)
      ensures forall idx | point <= idx < ps.point :: p(ps.s[idx])
      decreases SuffixLength()
    {
      if EOF? || !p(SuffixAt(0)) then
        this
      else
        Skip(1).SkipWhile(p)
    } by method {
      var point' := this.point;
      var end := this.end;
      while point' < end && p(this.s[point'])
        invariant var thisAfter := this.(point := point'); thisAfter.Valid?
        invariant var thisAfter := this.(point := point'); thisAfter.SkipWhile(p) == this.SkipWhile(p)
      {
        point' := point' + 1;
      }
      return Cursor(this.s, this.beg, point', this.end);
    }

    function SkipWhileLexer<A, R>(step: Lexer<A, R>, st: A): (pr: CursorResult<R>)
      requires Valid?
      ensures pr.Success? ==> pr.value.AdvancedFrom?(this)
      decreases SuffixLength()
    {
      match step(st, Peek())
      case Accept =>
        Success(this)
      case Reject(err) =>
        Failure(OtherError(err))
      case Partial(st) =>
        if EOF? then
          Failure(EOF)
        else
          Skip(1).SkipWhileLexer(step, st)
    } by method {
      var point' := point;
      var end := this.end;
      var st' := st;
      while true
        invariant var thisAfter := this.(point := point'); thisAfter.Valid?
        invariant var thisAfter := this.(point := point'); thisAfter.SkipWhileLexer(step, st') == this.SkipWhileLexer(step, st)
        decreases var thisAfter := this.(point := point'); thisAfter.SuffixLength()
      {
        var eof := point' == end;
        var minusone: opt_byte := -1;
        var c := if eof then minusone else this.s[point'] as opt_byte;
        match step(st', c)
        case {:split false} Accept =>
          return Success(Cursor(this.s, this.beg, point', this.end));
        case {:split false} Reject(err) =>
          return Failure(OtherError(err));
        case {:split false} Partial(st'') =>
          if eof {
            return Failure(EOF);
          } else {
            st' := st'';
            point' := point' + 1;
          }
      }
    }
  }
}

module Std.JSON.Utils.Lexers {

  module Core {

    import opened Wrappers

    import opened BoundedInts
    datatype LexerResult<+T, +R> = Accept | Reject(err: R) | Partial(st: T)

    type Lexer<!T, +R> = (T, opt_byte) -> LexerResult<T, R>
  }

  module Strings {
    const StringBodyLexerStart: StringBodyLexerState := false

    function StringBody<R>(escaped: StringBodyLexerState, byte: opt_byte): LexerResult<StringBodyLexerState, R>
    {
      if byte == '\\' as opt_byte then
        Partial(!escaped)
      else if byte == '\"' as opt_byte && !escaped then
        Accept
      else
        Partial(false)
    }

    const StringLexerStart: StringLexerState := Start

    function String(st: StringLexerState, byte: opt_byte): LexerResult<StringLexerState, string>
    {
      match st
      case Start() =>
        if byte == '\"' as opt_byte then
          Partial(Body(false))
        else
          Reject("String must start with double quote")
      case End() =>
        Accept
      case Body(escaped) =>
        if byte == '\\' as opt_byte then
          Partial(Body(!escaped))
        else if byte == '\"' as opt_byte && !escaped then
          Partial(End)
        else
          Partial(Body(false))
    }

    import opened Core

    import opened BoundedInts

    type StringBodyLexerState = bool

    datatype StringLexerState = Start | Body(escaped: bool) | End
  }
}

module Std.JSON.Utils.Parsers {
  function ParserWitness<T, R>(): (p: Parser_<T, R>)
    ensures p.Valid?()
  {
    Parser(_ /* _v0 */ => Failure(EOF), _ /* _v1 */ => [])
  }

  function SubParserWitness<T, R>(): (subp: SubParser_<T, R>)
    ensures subp.Valid?()
  {
    SubParser(Cursor([], 0, 0, 0), (cs: FreshCursor) => false, (cs: FreshCursor) => Failure(EOF), _ /* _v2 */ => [])
  }

  import opened BoundedInts

  import opened Wrappers

  import opened Core = Views.Core

  import opened Cursors

  type SplitResult<+T, +R> = Result<Split<T>, CursorError<R>>

  type Parser<!T, +R> = p: Parser_<T, R>
    | p.Valid?()
    witness ParserWitness<T, R>()

  datatype Parser_<!T, +R> = Parser(fn: FreshCursor -> SplitResult<T, R>, ghost spec: T -> bytes) {
    ghost predicate Valid?()
    {
      forall cs': FreshCursor :: 
        fn(cs').Success? ==>
          fn(cs').value.StrictlySplitFrom?(cs', spec)
    }
  }

  datatype SubParser_<!T, +R> = SubParser(ghost cs: Cursor, ghost pre: FreshCursor -> bool, fn: FreshCursor --> SplitResult<T, R>, ghost spec: T -> bytes) {
    ghost predicate Valid?()
    {
      (forall cs': FreshCursor | pre(cs') :: 
        fn.requires(cs')) &&
      (forall cs': FreshCursor | cs'.StrictlySplitFrom?(cs) :: 
        pre(cs')) &&
      forall cs': FreshCursor | pre(cs') :: 
        fn(cs').Success? ==>
          fn(cs').value.StrictlySplitFrom?(cs', spec)
    }
  }

  type SubParser<!T, +R> = p: SubParser_<T, R>
    | p.Valid?()
    witness SubParserWitness<T, R>()
}

module Std.JSON.Utils.Views.Core {
  predicate Adjacent(lv: View, rv: View)
  {
    lv.end == rv.beg &&
    lv.s == rv.s
  }

  function Merge(lv: View, rv: View): (v: View)
    requires Adjacent(lv, rv)
    ensures v.Bytes() == lv.Bytes() + rv.Bytes()
  {
    lv.(end := rv.end)
  }

  import opened BoundedInts

  type View = v: View_
    | v.Valid?
    witness View([], 0, 0)

  datatype View_ = View(s: bytes, beg: uint32, end: uint32) {
    ghost const Valid?: bool := 0 <= beg as int <= end as int <= |s| < TWO_TO_THE_32
    static const Empty: View := View([], 0, 0)
    const Empty? := beg == end

    function Length(): uint32
      requires Valid?
    {
      end - beg
    }

    function Bytes(): bytes
      requires Valid?
    {
      s[beg .. end]
    }

    static function OfBytes(bs: bytes): (v: View)
      requires |bs| < TWO_TO_THE_32
      ensures v.Bytes() == bs
    {
      View(bs, 0 as uint32, |bs| as uint32)
    }

    static function OfString(s: string): bytes
      requires forall c: char | c in s :: c as int < 256
    {
      seq(|s|, i requires 0 <= i < |s| => assert s[i] in s; s[i] as byte)
    }

    ghost predicate SliceOf?(v': View)
    {
      v'.s == s &&
      v'.beg <= beg &&
      end <= v'.end
    }

    ghost predicate StrictPrefixOf?(v': View)
    {
      v'.s == s &&
      v'.beg == beg &&
      end < v'.end
    }

    ghost predicate StrictSuffixOf?(v': View)
    {
      v'.s == s &&
      v'.beg < beg &&
      end == v'.end
    }

    predicate Byte?(c: byte)
      requires Valid?
    {
      Bytes() == [c]
    } by method {
      return Length() == 1 && At(0) == c;
    }

    predicate Char?(c: char)
      requires Valid?
      requires c as int < 256
    {
      Byte?(c as byte)
    }

    ghost predicate ValidIndex?(idx: uint32)
    {
      beg as int + idx as int < end as int
    }

    function At(idx: uint32): byte
      requires Valid?
      requires ValidIndex?(idx)
    {
      s[beg + idx]
    }

    function Peek(): (r: opt_byte)
      requires Valid?
      ensures r < 0 <==> Empty?
    {
      if Empty? then
        -1
      else
        At(0) as opt_byte
    }

    method CopyTo(dest: array<byte>, start: uint32 := 0)
      requires Valid?
      requires start as int + Length() as int <= dest.Length
      requires start as int + Length() as int < TWO_TO_THE_32
      modifies dest
      ensures dest[start .. start + Length()] == Bytes()
      ensures dest[start + Length()..] == old(dest[start + Length()..])
    {
      for idx := 0 to Length()
        invariant dest[start .. start + idx] == Bytes()[..idx]
        invariant dest[start + Length()..] == old(dest[start + Length()..])
      {
        dest[start + idx] := s[beg + idx];
      }
    }
  }
}

module Std.JSON.Utils.Views.Writers {

  import opened BoundedInts

  import opened Core
  datatype Chain = Empty | Chain(previous: Chain, v: View) {
    function Length(): nat
    {
      if Empty? then
        0
      else
        previous.Length() + v.Length() as int
    }

    function Count(): nat
    {
      if Empty? then
        0
      else
        previous.Count() + 1
    }

    function Bytes(): (bs: bytes)
      ensures |bs| == Length()
    {
      if Empty? then
        []
      else
        previous.Bytes() + v.Bytes()
    }

    function Append(v': View): (c: Chain)
      ensures c.Bytes() == Bytes() + v'.Bytes()
    {
      if Chain? && Adjacent(v, v') then
        Chain(previous, Merge(v, v'))
      else
        Chain(this, v')
    }

    @TailRecursion method CopyTo(dest: array<byte>, end: uint32)
      requires end as int == Length() <= dest.Length
      modifies dest
      ensures dest[..end] == Bytes()
      ensures dest[end..] == old(dest[end..])
    {
      if Chain? {
        var end := end - v.Length();
        v.CopyTo(dest, end);
        previous.CopyTo(dest, end);
      }
    }
  }

  type Writer = w: Writer_
    | w.Valid?
    witness Writer(0, Chain.Empty)

  datatype Writer_ = Writer(length: uint32, chain: Chain) {
    static const Empty: Writer := Writer(0, Chain.Empty)
    const Empty? := chain.Empty?
    const Unsaturated? := length != UINT32_MAX

    ghost function Length(): nat
    {
      chain.Length()
    }

    ghost const Valid? := length == if chain.Length() >= TWO_TO_THE_32 then UINT32_MAX else chain.Length() as uint32

    function Bytes(): (bs: bytes)
      ensures |bs| == Length()
    {
      chain.Bytes()
    }

    static function SaturatedAddU32(a: uint32, b: uint32): uint32
    {
      if a <= UINT32_MAX - b then
        a + b
      else
        UINT32_MAX
    }

    function Append(v': View): (rw: Writer)
      requires Valid?
      ensures rw.Unsaturated? <==> v'.Length() < UINT32_MAX - length
      ensures rw.Bytes() == Bytes() + v'.Bytes()
    {
      Writer(SaturatedAddU32(length, v'.Length()), chain.Append(v'))
    }

    function Then(fn: Writer ~> Writer): Writer
      requires Valid?
      requires fn.requires(this)
      reads fn.reads(this)
    {
      fn(this)
    }

    @TailRecursion method CopyTo(dest: array<byte>)
      requires Valid?
      requires Unsaturated?
      requires Length() <= dest.Length
      modifies dest
      ensures dest[..length] == Bytes()
      ensures dest[length..] == old(dest[length..])
    {
      chain.CopyTo(dest, length);
    }

    method ToArray() returns (bs: array<byte>)
      requires Valid?
      requires Unsaturated?
      ensures fresh(bs)
      ensures bs[..] == Bytes()
    {
      bs := new byte[length] (i => 0);
      CopyTo(bs);
    }
  }
}

module Std.JSON.Values {
  function Int(n: int): Decimal
  {
    Decimal(n, 0)
  }

  datatype Decimal = Decimal(n: int, e10: int)

  datatype JSON = Null | Bool(b: bool) | String(str: string) | Number(num: Decimal) | Object(obj: seq<(string, JSON)>) | Array(arr: seq<JSON>)
}

module Std.JSON.ZeroCopy.API {
  function Serialize(js: Grammar.JSON): (bs: SerializationResult<seq<byte>>)
    ensures bs == Success(Spec.JSON(js))
  {
    Success(Serializer.Text(js).Bytes())
  }

  method SerializeAlloc(js: Grammar.JSON) returns (bs: SerializationResult<array<byte>>)
    ensures bs.Success? ==> fresh(bs.value)
    ensures bs.Success? ==> bs.value[..] == Spec.JSON(js)
  {
    bs := Serializer.Serialize(js);
  }

  method SerializeInto(js: Grammar.JSON, bs: array<byte>) returns (len: SerializationResult<uint32>)
    modifies bs
    ensures len.Success? ==> len.value as int <= bs.Length
    ensures len.Success? ==> bs[..len.value] == Spec.JSON(js)
    ensures len.Success? ==> bs[len.value..] == old(bs[len.value..])
    ensures len.Failure? ==> unchanged(bs)
  {
    len := Serializer.SerializeTo(js, bs);
  }

  function Deserialize(bs: seq<byte>): (js: DeserializationResult<Grammar.JSON>)
    ensures js.Success? ==> bs == Spec.JSON(js.value)
  {
    Deserializer.API.OfBytes(bs)
  }

  import Grammar

  import Spec = ConcreteSyntax.Spec

  import Serializer

  import Deserializer

  import opened BoundedInts

  import opened Wrappers

  import opened Errors
}

module Std.JSON.ZeroCopy.Deserializer {

  module Core {
    const SpecView := (v: Vs.View) => Spec.View(v)

    function Get(cs: FreshCursor, err: JSONError): (pr: ParseResult<jchar>)
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, SpecView)
    {
      var cs :- cs.Get(err); Success(cs.Split())
    }

    @IsolateAssertions @ResourceLimit("1000e6") function WS(cs: FreshCursor): (sp: Split<jblanks>)
      ensures sp.SplitFrom?(cs, SpecView)
      ensures sp.cs.SuffixOf?(cs)
      ensures !cs.BOF? ==> sp.cs.StrictSuffixOf?(cs)
      ensures cs.EOF? ==> sp.cs.SuffixOf?(cs.Suffix())
    {
      cs.SkipWhile(Blank?).Split()
    } by method {
      var point' := cs.point;
      var end := cs.end;
      while point' < end && Blank?(cs.s[point'])
        invariant var csAfter := cs.(point := point'); csAfter.Valid?
        invariant var csAfter := cs.(point := point'); csAfter.SkipWhile(Blank?) == cs.SkipWhile(Blank?)
      {
        point' := point' + 1;
      }
      return Cursor(cs.s, cs.beg, point', cs.end).Split();
    }

    @IsolateAssertions @ResourceLimit("1000e6") function Structural<T>(cs: FreshCursor, parser: Parser<T>): (pr: ParseResult<Structural<T>>)
      requires forall cs: FreshCursor :: parser.fn.requires(cs)
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, st => Spec.Structural(st, parser.spec))
    {
      var SP(before, cs) := WS(cs);
      var SP(val, cs) :- parser.fn(cs); var SP(after, cs) := WS(cs); Success(SP(Grammar.Structural(before, val, after), cs))
    }

    @ResourceLimit("100e6") function TryStructural(cs: FreshCursor): (sp: Split<Structural<jopt>>)
      ensures sp.SplitFrom?(cs, (st: Structural<jopt>) => Spec.Structural(st, SpecView))
    {
      var SP(before, cs) := WS(cs);
      var SP(val, cs) := cs.SkipByte().Split();
      var SP(after, cs) := WS(cs);
      SP(Grammar.Structural(before, val, after), cs)
    }

    ghost predicate ValueParserValid(sp: SubParser<Value>)
    {
      forall t :: 
        sp.spec(t) == Spec.Value(t)
    }

    import opened BoundedInts

    import opened Wrappers

    import Spec = ConcreteSyntax.Spec

    import Vs = Utils.Views.Core

    import opened Cursors = Utils.Cursors

    import opened Parsers = Utils.Parsers

    import opened Grammar

    import Errors

    import opened Seq = Collections.Seq

    type JSONError = Errors.DeserializationError

    type Error = CursorError<JSONError>

    type ParseResult<+T> = SplitResult<T, JSONError>

    type Parser<!T> = Parsers.Parser<T, JSONError>

    type SubParser<!T> = Parsers.SubParser<T, JSONError>

    type jopt = v: Vs.View
      | v.Length() <= 1
      witness Vs.View.OfBytes([])

    type ValueParser = sp: SubParser<Value>
      | ValueParserValid(sp)
      witness *
  }
  type Error = Core.Error

  abstract module SequenceParams {
    const OPEN: byte
    const CLOSE: byte

    ghost function ElementSpec(t: TElement): bytes

    function Element(cs: FreshCursor, json: ValueParser): (pr: ParseResult<TElement>)
      requires cs.StrictlySplitFrom?(json.cs)
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, ElementSpec)
      decreases cs.Length()

    import opened BoundedInts

    import opened Grammar

    import opened Cursors = Utils.Cursors

    import opened Core

    type TElement
  }

  abstract module Sequences {
    const SEPARATOR: byte := ',' as byte
    const SpecViewClose: jclose -> bytes := SpecView
    const SpecViewOpen: jopen -> bytes := SpecView

    ghost function SuffixedElementSpec(e: TSuffixedElement): bytes
    {
      ElementSpec(e.t) + Spec.CommaSuffix(e.suffix)
    }

    ghost function BracketedSpec(ts: TBracketed): bytes
    {
      Spec.Bracketed(ts, SuffixedElementSpec)
    }

    ghost function SuffixedElementsSpec(ts: seq<TSuffixedElement>): bytes
    {
      Spec.ConcatBytes(ts, SuffixedElementSpec)
    }

    function Open(cs: FreshCursor): (pr: ParseResult<jopen>)
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, SpecViewOpen)
    {
      var cs :- cs.AssertByte(OPEN); Success(cs.Split())
    }

    function Close(cs: FreshCursor): (pr: ParseResult<jclose>)
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, SpecViewClose)
    {
      var cs :- cs.AssertByte(CLOSE); Success(cs.Split())
    }

    function BracketedFromParts(ghost cs: Cursor, open: Split<Structural<jopen>>, elems: Split<seq<TSuffixedElement>>, close: Split<Structural<jclose>>): (sp: Split<TBracketed>)
      requires Grammar.NoTrailingSuffix(elems.t)
      requires open.StrictlySplitFrom?(cs, (c: Structural<jopen>) => Spec.Structural(c, SpecView))
      requires elems.SplitFrom?(open.cs, SuffixedElementsSpec)
      requires close.StrictlySplitFrom?(elems.cs, (c: Structural<jclose>) => Spec.Structural(c, SpecView))
      ensures sp.StrictlySplitFrom?(cs, BracketedSpec)
    {
      var sp := SP(Grammar.Bracketed(open.t, elems.t, close.t), close.cs);
      calc {
        cs.Bytes();
        Spec.Structural(open.t, SpecView) + open.cs.Bytes();
        {
          assert open.cs.Bytes() == SuffixedElementsSpec(elems.t) + elems.cs.Bytes();
        }
        Spec.Structural(open.t, SpecView) + (SuffixedElementsSpec(elems.t) + elems.cs.Bytes());
        {
          Seq.LemmaConcatIsAssociative(Spec.Structural(open.t, SpecView), SuffixedElementsSpec(elems.t), elems.cs.Bytes());
        }
        Spec.Structural(open.t, SpecView) + SuffixedElementsSpec(elems.t) + elems.cs.Bytes();
        {
          assert elems.cs.Bytes() == Spec.Structural(close.t, SpecView) + close.cs.Bytes();
        }
        Spec.Structural(open.t, SpecView) + SuffixedElementsSpec(elems.t) + (Spec.Structural(close.t, SpecView) + close.cs.Bytes());
        {
          Seq.LemmaConcatIsAssociative(Spec.Structural(open.t, SpecView) + SuffixedElementsSpec(elems.t), Spec.Structural(close.t, SpecView), close.cs.Bytes());
        }
        Spec.Structural(open.t, SpecView) + SuffixedElementsSpec(elems.t) + Spec.Structural(close.t, SpecView) + close.cs.Bytes();
        Spec.Bracketed(sp.t, SuffixedElementSpec) + close.cs.Bytes();
      }
      assert sp.StrictlySplitFrom?(cs, BracketedSpec);
      sp
    }

    function AppendWithSuffix(ghost cs0: FreshCursor, ghost json: ValueParser, elems: Split<seq<TSuffixedElement>>, elem: Split<TElement>, sep: Split<Structural<jcomma>>): (elems': Split<seq<TSuffixedElement>>)
      requires elems.cs.StrictlySplitFrom?(json.cs)
      requires elems.SplitFrom?(cs0, SuffixedElementsSpec)
      requires elem.StrictlySplitFrom?(elems.cs, ElementSpec)
      requires sep.StrictlySplitFrom?(elem.cs, (c: Structural<jcomma>) => Spec.Structural(c, SpecView))
      requires forall e | e in elems.t :: e.suffix.NonEmpty?
      ensures elems'.StrictlySplitFrom?(cs0, SuffixedElementsSpec)
      ensures forall e | e in elems'.t :: e.suffix.NonEmpty?
      ensures elems'.cs.Length() < elems.cs.Length()
      ensures elems'.cs.StrictlySplitFrom?(json.cs)
      ensures elems'.SplitFrom?(cs0, SuffixedElementsSpec)
    {
      var suffixed := Suffixed(elem.t, NonEmpty(sep.t));
      var elems' := SP(elems.t + [suffixed], sep.cs);
      assert cs0.Bytes() == SuffixedElementsSpec(elems'.t) + sep.cs.Bytes() by {
        assert {:focus} cs0.Bytes() == SuffixedElementsSpec(elems.t) + (ElementSpec(suffixed.t) + Spec.CommaSuffix(suffixed.suffix)) + sep.cs.Bytes() by {
          assert cs0.Bytes() == SuffixedElementsSpec(elems.t) + ElementSpec(suffixed.t) + Spec.CommaSuffix(suffixed.suffix) + sep.cs.Bytes() by {
            assert cs0.Bytes() == SuffixedElementsSpec(elems.t) + elems.cs.Bytes();
            assert elems.cs.Bytes() == ElementSpec(suffixed.t) + elem.cs.Bytes();
            assert elem.cs.Bytes() == Spec.CommaSuffix(suffixed.suffix) + sep.cs.Bytes();
            Seq.LemmaConcatIsAssociative(SuffixedElementsSpec(elems.t), ElementSpec(suffixed.t), elem.cs.Bytes());
            Seq.LemmaConcatIsAssociative(SuffixedElementsSpec(elems.t) + ElementSpec(suffixed.t), Spec.CommaSuffix(suffixed.suffix), sep.cs.Bytes());
          }
          Seq.LemmaConcatIsAssociative(SuffixedElementsSpec(elems.t), ElementSpec(suffixed.t), Spec.CommaSuffix(suffixed.suffix));
        }
        assert SuffixedElementsSpec(elems.t) + (ElementSpec(suffixed.t) + Spec.CommaSuffix(suffixed.suffix)) + sep.cs.Bytes() == SuffixedElementsSpec(elems'.t) + sep.cs.Bytes() by {
          assert SuffixedElementsSpec(elems.t) + SuffixedElementSpec(suffixed) == SuffixedElementsSpec(elems.t + [suffixed]) by {
            SpecProperties.ConcatBytes_Linear(elems.t, [suffixed], SuffixedElementSpec);
            assert Spec.ConcatBytes(elems.t, SuffixedElementSpec) + Spec.ConcatBytes([suffixed], SuffixedElementSpec) == Spec.ConcatBytes(elems.t + [suffixed], SuffixedElementSpec);
          }
        }
      }
      assert elems'.StrictlySplitFrom?(cs0, SuffixedElementsSpec);
      assert forall e | e in elems'.t :: e.suffix.NonEmpty? by {
        assert elems'.t == elems.t + [suffixed];
      }
      assert {:split_here} elems'.cs.Length() < elems.cs.Length();
      assert elems'.SplitFrom?(cs0, SuffixedElementsSpec) by {
        assert elems'.BytesSplitFrom?(cs0, SuffixedElementsSpec) by {
          assert elems'.StrictlySplitFrom?(cs0, SuffixedElementsSpec);
        }
        assert elems'.cs.SplitFrom?(cs0) by {
          assert elems'.cs.StrictlySplitFrom?(cs0) by {
            assert elems'.StrictlySplitFrom?(cs0, SuffixedElementsSpec);
          }
        }
      }
      elems'
    }

    @ResourceLimit("10e6") @IsolateAssertions function AppendLast(ghost cs0: FreshCursor, ghost json: ValueParser, elems: Split<seq<TSuffixedElement>>, elem: Split<TElement>, sep: Split<Structural<jclose>>): (elems': Split<seq<TSuffixedElement>>)
      requires elems.cs.StrictlySplitFrom?(json.cs)
      requires elems.SplitFrom?(cs0, SuffixedElementsSpec)
      requires elem.StrictlySplitFrom?(elems.cs, ElementSpec)
      requires sep.StrictlySplitFrom?(elem.cs, (c: Structural<jclose>) => Spec.Structural(c, SpecView))
      requires forall e | e in elems.t :: e.suffix.NonEmpty?
      ensures elems'.StrictlySplitFrom?(cs0, SuffixedElementsSpec)
      ensures NoTrailingSuffix(elems'.t)
      ensures elems'.cs.Length() < elems.cs.Length()
      ensures elems'.cs.StrictlySplitFrom?(json.cs)
      ensures sep.StrictlySplitFrom?(elems'.cs, (c: Structural<jclose>) => Spec.Structural(c, SpecView))
    {
      var suffixed := Suffixed(elem.t, Empty());
      var elems' := SP(elems.t + [suffixed], elem.cs);
      assert cs0.Bytes() == SuffixedElementsSpec(elems'.t) + elem.cs.Bytes() by {
        assert cs0.Bytes() == SuffixedElementsSpec(elems.t) + ElementSpec(suffixed.t) + elem.cs.Bytes() by {
          assert elem.t == suffixed.t;
        }
        assert SuffixedElementsSpec(elems.t) + ElementSpec(suffixed.t) + elem.cs.Bytes() == SuffixedElementsSpec(elems'.t) + elem.cs.Bytes() by {
          assert SuffixedElementsSpec(elems.t) + SuffixedElementSpec(suffixed) == SuffixedElementsSpec(elems.t + [suffixed]) by {
            SpecProperties.ConcatBytes_Linear(elems.t, [suffixed], SuffixedElementSpec);
            assert Spec.ConcatBytes(elems.t, SuffixedElementSpec) + Spec.ConcatBytes<TSuffixedElement>([suffixed], SuffixedElementSpec) == Spec.ConcatBytes(elems.t + [suffixed], SuffixedElementSpec);
          }
        }
      }
      assert elems'.StrictlySplitFrom?(cs0, SuffixedElementsSpec);
      elems'
    }

    @ResourceLimit("10e6") @IsolateAssertions lemma AboutTryStructural(cs: FreshCursor)
      ensures var sp := Core.TryStructural(cs); var s0 := sp.t.t.Peek(); ((!cs.BOF? || !cs.EOF?) && s0 == SEPARATOR as opt_byte ==> var sp: Split<Structural<jcomma>> := sp; sp.cs.StrictSuffixOf?(cs)) && (s0 == SEPARATOR as opt_byte ==> var sp: Split<Structural<jcomma>> := sp; sp.SplitFrom?(cs, (st: Structural<jcomma>) => Spec.Structural(st, SpecView))) && ((!cs.BOF? || !cs.EOF?) && s0 == CLOSE as opt_byte ==> var sp: Split<Structural<jclose>> := sp; sp.cs.StrictSuffixOf?(cs)) && (s0 == CLOSE as opt_byte ==> var sp: Split<Structural<jclose>> := sp; sp.SplitFrom?(cs, (st: Structural<jclose>) => Spec.Structural(st, SpecView)))
    {
      var sp := Core.TryStructural(cs);
      var s0 := sp.t.t.Peek();
      assert (!cs.BOF? || !cs.EOF?) && s0 == SEPARATOR as opt_byte ==> var sp: Split<Structural<jcomma>> := sp; sp.cs.StrictSuffixOf?(cs);
      assert s0 == SEPARATOR as opt_byte ==> var sp: Split<Structural<jcomma>> := sp; sp.SplitFrom?(cs, (st: Structural<jcomma>) => Spec.Structural(st, SpecView));
      assert (!cs.BOF? || !cs.EOF?) && s0 == CLOSE as opt_byte ==> var sp: Split<Structural<jclose>> := sp; sp.cs.StrictSuffixOf?(cs);
      assert s0 == CLOSE as opt_byte ==> var sp: Split<Structural<jclose>> := sp; sp.SplitFrom?(cs, (st: Structural<jclose>) => Spec.Structural(st, SpecView));
    }

    @IsolateAssertions lemma AboutLists<T>(xs: seq<T>, i: uint32)
      requires 0 <= i as int < |xs|
      ensures xs[i as int .. i as int + 1] == [xs[i as int]]
    {
    }

    @IsolateAssertions @TailRecursion function Elements(ghost cs0: FreshCursor, json: ValueParser, open: Split<Structural<jopen>>, elems: Split<seq<TSuffixedElement>>): (pr: ParseResult<TBracketed>)
      requires open.StrictlySplitFrom?(cs0, (c: Structural<jopen>) => Spec.Structural(c, SpecView))
      requires elems.cs.StrictlySplitFrom?(json.cs)
      requires elems.SplitFrom?(open.cs, SuffixedElementsSpec)
      requires forall e | e in elems.t :: e.suffix.NonEmpty?
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs0, BracketedSpec)
      decreases elems.cs.Length()
    {
      var elem :- Element(elems.cs, json); if elem.cs.EOF? then Failure(EOF) else AboutTryStructural(elem.cs); var sep := Core.TryStructural(elem.cs); var s0 := sep.t.t.Peek(); if s0 == SEPARATOR as opt_byte && sep.t.t.Length() == 1 then assert sep.t.t.Char?(',') by {
    calc {
      sep.t.t.Char?(',');
      sep.t.t.Byte?(',' as byte);
      sep.t.t.Byte?(SEPARATOR);
      sep.t.t.Bytes() == [SEPARATOR];
      sep.t.t.s[sep.t.t.beg as int .. sep.t.t.end as int] == [SEPARATOR];
      {
        assert sep.t.t.beg as int + 1 == sep.t.t.end as int by {
          assert sep.t.t.Length() == 1;
        }
      }
      sep.t.t.s[sep.t.t.beg as int .. sep.t.t.beg as int + 1] == [SEPARATOR];
      {
        assert sep.t.t.s[sep.t.t.beg as int .. sep.t.t.beg as int + 1] == [sep.t.t.s[sep.t.t.beg as int]] by {
          AboutLists(sep.t.t.s, sep.t.t.beg);
        }
      }
      [sep.t.t.s[sep.t.t.beg as int]] == [SEPARATOR];
      sep.t.t.s[sep.t.t.beg as int] as opt_byte == SEPARATOR as opt_byte;
      sep.t.t.At(0) as opt_byte == SEPARATOR as opt_byte;
      s0 == SEPARATOR as opt_byte;
      true;
    }
  } var sep: Split<Structural<jcomma>> := sep; assert AppendWithSuffix.requires(open.cs, json, elems, elem, sep) by {
    assert {:focus} elems.cs.StrictlySplitFrom?(json.cs);
    assert elems.SplitFrom?(open.cs, SuffixedElementsSpec);
    assert elem.StrictlySplitFrom?(elems.cs, ElementSpec);
    assert sep.StrictlySplitFrom?(elem.cs, (c: Structural<jcomma>) => Spec.Structural(c, SpecView)) by {
      assert sep.BytesSplitFrom?(elem.cs, (c: Structural<jcomma>) => Spec.Structural(c, SpecView)) by {
        assert sep.SplitFrom?(elem.cs, (c: Structural<jcomma>) => Spec.Structural(c, SpecView));
      }
      assert sep.cs.StrictlySplitFrom?(elem.cs) by {
        assert sep.cs.BOF?;
        assert sep.cs.StrictSuffixOf?(elem.cs) by {
          assert !elem.cs.EOF?;
        }
      }
    }
    assert forall e | e in elems.t :: e.suffix.NonEmpty?;
    assert {:split_here} true;
  } var elems := AppendWithSuffix(open.cs, json, elems, elem, sep); Elements(cs0, json, open, elems) else if s0 == CLOSE as opt_byte && sep.t.t.Length() == 1 then assert sep.t.t.Byte?(CLOSE) by {
    calc {
      sep.t.t.Byte?(CLOSE);
      sep.t.t.Bytes() == [CLOSE];
      sep.t.t.s[sep.t.t.beg as int .. sep.t.t.end as int] == [CLOSE];
      {
        assert sep.t.t.beg as int + 1 == sep.t.t.end as int by {
          assert sep.t.t.Length() == 1;
        }
      }
      sep.t.t.s[sep.t.t.beg as int .. sep.t.t.beg as int + 1] == [CLOSE];
      {
        assert sep.t.t.s[sep.t.t.beg as int .. sep.t.t.beg as int + 1] == [sep.t.t.s[sep.t.t.beg as int]] by {
          AboutLists(sep.t.t.s, sep.t.t.beg);
        }
      }
      [sep.t.t.s[sep.t.t.beg as int]] == [CLOSE];
      sep.t.t.s[sep.t.t.beg as int] as opt_byte == CLOSE as opt_byte;
      sep.t.t.At(0) as opt_byte == CLOSE as opt_byte;
      s0 == CLOSE as opt_byte;
      true;
    }
  } var sep: Split<Structural<jclose>> := sep; assert AppendLast.requires(open.cs, json, elems, elem, sep) by {
    assert elems.cs.StrictlySplitFrom?(json.cs);
    assert elems.SplitFrom?(open.cs, SuffixedElementsSpec);
    assert elem.StrictlySplitFrom?(elems.cs, ElementSpec);
    assert sep.StrictlySplitFrom?(elem.cs, (c: Structural<jclose>) => Spec.Structural(c, SpecView)) by {
      assert sep.BytesSplitFrom?(elem.cs, (c: Structural<jclose>) => Spec.Structural(c, SpecView)) by {
        assert sep.SplitFrom?(elem.cs, (c: Structural<jclose>) => Spec.Structural(c, SpecView));
      }
      assert sep.cs.StrictlySplitFrom?(elem.cs) by {
        assert sep.cs.BOF?;
        assert sep.cs.StrictSuffixOf?(elem.cs) by {
          assert !elem.cs.EOF?;
        }
      }
    }
    assert forall e | e in elems.t :: e.suffix.NonEmpty?;
  } var elems' := AppendLast(open.cs, json, elems, elem, sep); assert elems'.SplitFrom?(open.cs, SuffixedElementsSpec) by {
    assert elems'.StrictlySplitFrom?(open.cs, SuffixedElementsSpec);
  } var bracketed := BracketedFromParts(cs0, open, elems', sep); assert bracketed.StrictlySplitFrom?(cs0, BracketedSpec); Success(bracketed) else var separator := SEPARATOR; var pr := Failure(ExpectingAnyByte([CLOSE, separator], s0)); pr
    }

    lemma AboutCloseParser()
      ensures Parsers.Parser(Close, SpecViewClose).Valid?()
    {
      assert Parsers.Parser(Close, SpecViewClose).Valid?() by {
        forall cs': FreshCursor | true
          ensures Close(cs').Success? ==> Close(cs').value.StrictlySplitFrom?(cs', SpecViewClose)
        {
          if Close(cs').Success? {
            assert Close(cs').value.StrictlySplitFrom?(cs', SpecViewClose) by {
              assert Close(cs').Success? ==> Close(cs').value.StrictlySplitFrom?(cs', SpecViewClose);
            }
          }
        }
      }
    }

    @IsolateAssertions function Bracketed(cs: FreshCursor, json: ValueParser): (pr: ParseResult<TBracketed>)
      requires cs.SplitFrom?(json.cs)
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, BracketedSpec)
    {
      var open :- Core.Structural<jopen>(cs, Parsers.Parser(Open, SpecViewOpen)); assert open.cs.StrictlySplitFrom?(json.cs); var elems := SP([], open.cs); if open.cs.Peek() == CLOSE as opt_byte then var p := Parsers.Parser(Close, SpecViewClose); assert p.Valid?() by {
    AboutCloseParser();
  } var close :- Core.Structural<jclose>(open.cs, p); Success(BracketedFromParts(cs, open, elems, close)) else Elements(cs, json, open, elems)
    }

    lemma Valid(x: TBracketed)
      ensures x.l.t.Byte?(OPEN)
      ensures x.r.t.Byte?(CLOSE)
      ensures NoTrailingSuffix(x.data)
      ensures forall pf | pf in x.data :: pf.suffix.NonEmpty? ==> pf.suffix.t.t.Byte?(SEPARATOR)
    {
      var xlt: jopen := x.l.t;
      var xrt: jclose := x.r.t;
      forall pf | pf in x.data
        ensures pf.suffix.NonEmpty? ==> pf.suffix.t.t.Byte?(SEPARATOR)
      {
        if pf.suffix.NonEmpty? {
          var xtt := pf.suffix.t.t;
        }
      }
    }

    import opened Wrappers

    import opened BoundedInts

    import opened Params : SequenceParams

    import SpecProperties = ConcreteSyntax.SpecProperties

    import opened Vs = Utils.Views.Core

    import opened Grammar

    import opened Cursors = Utils.Cursors

    import Parsers = Utils.Parsers

    import opened Core

    type jopen = v: Vs.View
      | v.Byte?(OPEN)
      witness Vs.View.OfBytes([OPEN])

    type jclose = v: Vs.View
      | v.Byte?(CLOSE)
      witness Vs.View.OfBytes([CLOSE])

    type TBracketed = Bracketed<jopen, TElement, jcomma, jclose>

    type TSuffixedElement = Suffixed<TElement, jcomma>
  }

  module API {
    function LiftCursorError(err: Cursors.CursorError<DeserializationError>): DeserializationError
    {
      match err
      case EOF =>
        ReachedEOF
      case ExpectingByte(expected, b) =>
        ExpectingByte(expected, b)
      case ExpectingAnyByte(expected_sq, b) =>
        ExpectingAnyByte(expected_sq, b)
      case OtherError(err) =>
        err
    }

    @IsolateAssertions @ResourceLimit("10e6") function JSON(cs: Cursors.FreshCursor): (pr: DeserializationResult<Cursors.Split<JSON>>)
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, Spec.JSON)
    {
      Core.Structural(cs, Parsers.Parser(Values.Value, Spec.Value)).MapFailure(LiftCursorError)
    }

    function Text(v: View): (jsr: DeserializationResult<JSON>)
      ensures jsr.Success? ==> v.Bytes() == Spec.JSON(jsr.value)
    {
      var SP(text, cs) :- JSON(Cursors.Cursor.OfView(v)); assert Cursors.SP(text, cs).BytesSplitFrom?(Cursors.Cursor.OfView(v), Spec.JSON); assert v.Bytes() == Spec.JSON(text) + cs.Bytes(); :- Need(cs.EOF?, Errors.ExpectingEOF); assert cs.Bytes() == []; Success(text)
    }

    function OfBytes(bs: bytes): (jsr: DeserializationResult<JSON>)
      ensures jsr.Success? ==> bs == Spec.JSON(jsr.value)
    {
      :- Need(|bs| < TWO_TO_THE_32, Errors.IntOverflow); Text(Vs.View.OfBytes(bs))
    }

    import opened BoundedInts

    import opened Wrappers

    import opened Vs = Utils.Views.Core

    import opened Grammar

    import opened Core

    import opened Errors

    import Cursors = Utils.Cursors

    import Values
  }

  module Values {
    @IsolateAssertions function Value(cs: FreshCursor): (pr: ParseResult<Value>)
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, Spec.Value)
      decreases cs.Length(), 1
    {
      var c := cs.Peek();
      if c == '{' as opt_byte then
        var SP(obj, cs') :- Objects.Object(cs, ValueParser(cs)); var v := Grammar.Object(obj); var sp := SP(v, cs'); assert sp.StrictlySplitFrom?(cs, Spec.Value) by {
    Spec.UnfoldValueObject(v);
    assert SP(obj, cs').StrictlySplitFrom?(cs, Spec.Object);
  } Spec.UnfoldValueObject(v); assert sp.StrictlySplitFrom?(cs, Spec.Value); Success(sp)
      else if c == '[' as opt_byte then
        var SP(arr, cs') :- Arrays.Array(cs, ValueParser(cs)); var v := Grammar.Array(arr); var sp := SP(v, cs'); assert sp.StrictlySplitFrom?(cs, Spec.Value) by {
    assert SP(arr, cs').StrictlySplitFrom?(cs, Spec.Array);
    Spec.UnfoldValueArray(v);
  } assert sp.StrictlySplitFrom?(cs, Spec.Value); Success(sp)
      else if c == '\"' as opt_byte then
        var SP(str, cs') :- Strings.String(cs); assert SP(Grammar.String(str), cs').StrictlySplitFrom?(cs, Spec.Value) by {
    calc {
      SP(Grammar.String(str), cs').StrictlySplitFrom?(cs, Spec.Value);
      cs'.StrictlySplitFrom?(cs) &&
      SP(Grammar.String(str), cs').BytesSplitFrom?(cs, Spec.Value);
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == Spec.Value(Grammar.String(str)) + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == Spec.String(str) + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      SP(str, cs').BytesSplitFrom?(cs, Spec.String);
      SP(str, cs').StrictlySplitFrom?(cs, Spec.String);
      true;
    }
  } Success(SP(Grammar.String(str), cs'))
      else if c == 't' as opt_byte then
        var SP(cst, cs') :- Constants.Constant(cs, TRUE); assert SP(Grammar.Bool(cst), cs').StrictlySplitFrom?(cs, Spec.Value) by {
    var f := _ /* _v0 */ => TRUE;
    calc {
      SP(Grammar.Bool(cst), cs').StrictlySplitFrom?(cs, Spec.Value);
      cs'.StrictlySplitFrom?(cs) &&
      SP(Grammar.Bool(cst), cs').BytesSplitFrom?(cs, Spec.Value);
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == Spec.Value(Grammar.Bool(cst)) + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == Spec.View(cst) + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == cst.Bytes() + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == TRUE + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == f(Grammar.Bool(cst)) + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      SP(Grammar.Bool(cst), cs').BytesSplitFrom?(cs, f);
      {
        assert cs'.StrictlySplitFrom?(cs) <==> cs'.SplitFrom?(cs) by {
          assert cs' != cs;
        }
      }
      cs'.SplitFrom?(cs) &&
      SP(Grammar.Bool(cst), cs').BytesSplitFrom?(cs, f);
      SP(Grammar.Bool(cst), cs').SplitFrom?(cs, f);
      true;
    }
  } Success(SP(Grammar.Bool(cst), cs'))
      else if c == 'f' as opt_byte then
        var SP(cst, cs') :- Constants.Constant(cs, FALSE); assert SP(Grammar.Bool(cst), cs').StrictlySplitFrom?(cs, Spec.Value) by {
    var f := _ /* _v1 */ => FALSE;
    calc {
      SP(Grammar.Bool(cst), cs').StrictlySplitFrom?(cs, Spec.Value);
      cs'.StrictlySplitFrom?(cs) &&
      SP(Grammar.Bool(cst), cs').BytesSplitFrom?(cs, Spec.Value);
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == Spec.Value(Grammar.Bool(cst)) + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == Spec.View(cst) + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == cst.Bytes() + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == FALSE + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == f(Grammar.Bool(cst)) + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      SP(Grammar.Bool(cst), cs').BytesSplitFrom?(cs, f);
      {
        assert cs'.StrictlySplitFrom?(cs) <==> cs'.SplitFrom?(cs) by {
          assert cs' != cs;
        }
      }
      cs'.SplitFrom?(cs) &&
      SP(Grammar.Bool(cst), cs').BytesSplitFrom?(cs, f);
      SP(Grammar.Bool(cst), cs').SplitFrom?(cs, f);
      true;
    }
  } Success(SP(Grammar.Bool(cst), cs'))
      else if c == 'n' as opt_byte then
        var SP(cst, cs') :- Constants.Constant(cs, NULL); assert SP(Grammar.Null(cst), cs').StrictlySplitFrom?(cs, Spec.Value) by {
    var f := _ /* _v2 */ => NULL;
    calc {
      SP(Grammar.Null(cst), cs').StrictlySplitFrom?(cs, Spec.Value);
      cs'.StrictlySplitFrom?(cs) &&
      SP(Grammar.Null(cst), cs').BytesSplitFrom?(cs, Spec.Value);
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == Spec.Value(Grammar.Null(cst)) + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == Spec.View(cst) + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == cst.Bytes() + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == NULL + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      cs.Bytes() == f(Grammar.Null(cst)) + cs'.Bytes();
      cs'.StrictlySplitFrom?(cs) &&
      SP(Grammar.Null(cst), cs').BytesSplitFrom?(cs, f);
      {
        assert cs'.StrictlySplitFrom?(cs) <==> cs'.SplitFrom?(cs) by {
          assert cs' != cs;
        }
      }
      cs'.SplitFrom?(cs) &&
      SP(Grammar.Null(cst), cs').BytesSplitFrom?(cs, f);
      SP(Grammar.Null(cst), cs').SplitFrom?(cs, f);
      true;
    }
  } Success(SP(Grammar.Null(cst), cs'))
      else
        var SP(num, cs') :- Numbers.Number(cs); var v := Grammar.Number(num); var sp := SP(v, cs'); assert sp.StrictlySplitFrom?(cs, Spec.Value) by {
    assert SP(num, cs').StrictlySplitFrom?(cs, Spec.Number);
    Spec.UnfoldValueNumber(v);
  } assert sp.StrictlySplitFrom?(cs, Spec.Value); Success(sp)
    }

    function ValueParser(cs: FreshCursor): (p: ValueParser)
      ensures cs.SplitFrom?(p.cs)
      decreases cs.Length(), 0
    {
      var pre := (ps': FreshCursor) => ps'.Length() < cs.Length();
      var fn := (ps': FreshCursor) requires pre(ps') => Value(ps');
      Parsers.SubParser(cs, pre, fn, Spec.Value)
    }

    import Strings

    import Numbers

    import Objects

    import Arrays

    import Constants

    import SpecProperties = ConcreteSyntax.SpecProperties

    import opened BoundedInts

    import opened Wrappers

    import opened Grammar

    import opened Cursors = Utils.Cursors

    import opened Core
  }

  module Constants {
    function Constant(cs: FreshCursor, expected: bytes): (pr: ParseResult<Vs.View>)
      requires |expected| < TWO_TO_THE_32
      ensures pr.Success? ==> pr.value.t.Bytes() == expected
      ensures pr.Success? ==> pr.value.SplitFrom?(cs, _ /* _v3 */ => expected)
    {
      var cs :- cs.AssertBytes(expected); Success(cs.Split())
    }

    import opened BoundedInts

    import opened Wrappers

    import opened Grammar

    import opened Core

    import opened Cursors = Utils.Cursors
  }

  module Strings {
    function StringBody(cs: Cursor): (pr: CursorResult<JSONError>)
      ensures pr.Success? ==> pr.value.AdvancedFrom?(cs)
    {
      cs.SkipWhileLexer(Strings.StringBody, StringBodyLexerStart)
    } by method {
      var escaped := false;
      for point' := cs.point to cs.end
        invariant var csAfter := cs.(point := point'); csAfter.Valid?
        invariant var csAfter := cs.(point := point'); csAfter.SkipWhileLexer(Strings.StringBody, escaped) == StringBody(cs)
      {
        var byte := cs.s[point'];
        if byte == '\"' as byte && !escaped {
          return Success(Cursor(cs.s, cs.beg, point', cs.end));
        } else if byte == '\\' as byte {
          escaped := !escaped;
        } else {
          escaped := false;
        }
      }
      return Failure(EOF);
    }

    function Quote(cs: FreshCursor): (pr: ParseResult<jquote>)
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, SpecView)
    {
      var cs :- cs.AssertChar('\"'); Success(cs.Split())
    }

    @ResourceLimit("10e6") function String(cs: FreshCursor): (pr: ParseResult<jstring>)
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, Spec.String)
    {
      var origCs := cs;
      var SP(lq, cs) :- Quote(cs); var contents :- StringBody(cs); var SP(contents, cs) := contents.Split(); var SP(rq, cs) :- Quote(cs); var result := SP(Grammar.JString(lq, contents, rq), cs); assert result.StrictlySplitFrom?(origCs, Spec.String); Success(result)
    }

    import opened Wrappers

    import opened BoundedInts

    import opened Grammar

    import opened Cursors = Utils.Cursors

    import opened LC = Utils.Lexers.Core

    import opened Strings = Utils.Lexers.Strings

    import opened Parsers = Utils.Parsers

    import opened Core
  }

  module Numbers {
    function Digits(cs: FreshCursor): (sp: Split<jdigits>)
      ensures sp.SplitFrom?(cs, SpecView)
    {
      cs.SkipWhile(Digit?).Split()
    }

    function NonEmptyDigits(cs: FreshCursor): (pr: ParseResult<jnum>)
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, SpecView)
    {
      var sp := Digits(cs);
      if sp.t.Empty? then
        Failure(OtherError(Errors.EmptyNumber))
      else
        Success(sp)
    }

    function NonZeroInt(cs: FreshCursor): (pr: ParseResult<jint>)
      requires cs.Peek() != '0' as opt_byte
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, SpecView)
    {
      NonEmptyDigits(cs)
    }

    function OptionalMinus(cs: FreshCursor): (sp: Split<jminus>)
      ensures sp.SplitFrom?(cs, SpecView)
    {
      cs.SkipIf(c => c == '-' as byte).Split()
    }

    function OptionalSign(cs: FreshCursor): (sp: Split<jsign>)
      ensures sp.SplitFrom?(cs, SpecView)
    {
      cs.SkipIf(c => c == '-' as byte || c == '+' as byte).Split()
    }

    function TrimmedInt(cs: FreshCursor): (pr: ParseResult<jint>)
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, SpecView)
    {
      var sp := cs.SkipIf(c => c == '0' as byte).Split();
      if sp.t.Empty? then
        NonZeroInt(sp.cs)
      else
        Success(sp)
    }

    @IsolateAssertions @ResourceLimit("1e9") function Exp(cs: FreshCursor): (pr: ParseResult<Maybe<jexp>>)
      ensures pr.Success? ==> pr.value.SplitFrom?(cs, exp => Spec.Maybe(exp, Spec.Exp))
    {
      var SP(e, cs) := cs.SkipIf(c => c == 'e' as byte || c == 'E' as byte).Split();
      if e.Empty? then
        Success(SP(Empty(), cs))
      else
        assert e.Char?('e') || e.Char?('E'); var SP(sign, cs) := OptionalSign(cs); var SP(num, cs) :- NonEmptyDigits(cs); Success(SP(NonEmpty(JExp(e, sign, num)), cs))
    }

    function Frac(cs: FreshCursor): (pr: ParseResult<Maybe<jfrac>>)
      ensures pr.Success? ==> pr.value.SplitFrom?(cs, frac => Spec.Maybe(frac, Spec.Frac))
    {
      var SP(period, cs) := cs.SkipIf(c => c == '.' as byte).Split();
      if period.Empty? then
        Success(SP(Empty(), cs))
      else
        assert Digits(cs).t.Empty? ==> NonEmptyDigits(cs).Failure?; var SP(num, cs) :- NonEmptyDigits(cs); Success(SP(NonEmpty(JFrac(period, num)), cs))
    }

    function NumberFromParts(ghost cs: Cursor, minus: Split<jminus>, num: Split<jint>, frac: Split<Maybe<jfrac>>, exp: Split<Maybe<jexp>>): (sp: Split<jnumber>)
      requires minus.SplitFrom?(cs, SpecView)
      requires num.StrictlySplitFrom?(minus.cs, SpecView)
      requires frac.SplitFrom?(num.cs, frac => Spec.Maybe(frac, Spec.Frac))
      requires exp.SplitFrom?(frac.cs, exp => Spec.Maybe(exp, Spec.Exp))
      ensures sp.StrictlySplitFrom?(cs, Spec.Number)
    {
      var sp := SP(Grammar.JNumber(minus.t, num.t, frac.t, exp.t), exp.cs);
      assert cs.Bytes() == Spec.Number(sp.t) + exp.cs.Bytes() by {
        assert cs.Bytes() == Spec.View(minus.t) + Spec.View(num.t) + Spec.Maybe(frac.t, Spec.Frac) + Spec.Maybe(exp.t, Spec.Exp) + exp.cs.Bytes() by {
          assert cs.Bytes() == Spec.View(minus.t) + minus.cs.Bytes();
          assert minus.cs.Bytes() == Spec.View(num.t) + num.cs.Bytes();
          assert num.cs.Bytes() == Spec.Maybe(frac.t, Spec.Frac) + frac.cs.Bytes();
          assert frac.cs.Bytes() == Spec.Maybe(exp.t, Spec.Exp) + exp.cs.Bytes();
          Seq.LemmaConcatIsAssociative(Spec.View(minus.t), Spec.View(num.t), num.cs.Bytes());
          Seq.LemmaConcatIsAssociative(Spec.View(minus.t) + Spec.View(num.t), Spec.Maybe(frac.t, Spec.Frac), frac.cs.Bytes());
          Seq.LemmaConcatIsAssociative(Spec.View(minus.t) + Spec.View(num.t) + Spec.Maybe(frac.t, Spec.Frac), Spec.Maybe(exp.t, Spec.Exp), exp.cs.Bytes());
        }
      }
      assert sp.StrictlySplitFrom?(cs, Spec.Number);
      sp
    }

    function Number(cs: FreshCursor): (pr: ParseResult<jnumber>)
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, Spec.Number)
    {
      var minus := OptionalMinus(cs);
      var num :- TrimmedInt(minus.cs); var frac :- Frac(num.cs); var exp :- Exp(frac.cs); Success(NumberFromParts(cs, minus, num, frac, exp))
    }

    import opened BoundedInts

    import opened Wrappers

    import opened Grammar

    import opened Cursors = Utils.Cursors

    import opened Core
  }

  module ArrayParams refines SequenceParams {
    const OPEN := '[' as byte
    const CLOSE := ']' as byte

    function ElementSpec(t: TElement): bytes
    {
      Spec.Value(t)
    }

    function Element(cs: FreshCursor, json: ValueParser): (pr: ParseResult<TElement>)
    {
      json.fn(cs)
    }

    import opened Strings

    import opened Wrappers

    type TElement = Value
  }

  module Arrays refines Sequences {
    @IsolateAssertions lemma BracketedToArray(arr: jarray)
      ensures Spec.Bracketed(arr, SuffixedElementSpec) == Spec.Array(arr)
    {
      var rItem := (d: jitem) requires d < arr => Spec.Item(d);
      assert Spec.Bracketed(arr, SuffixedElementSpec) == Spec.Bracketed(arr, rItem) by {
        assert SpecProperties.Bracketed_Morphism_Requires(arr, SuffixedElementSpec, rItem);
        SpecProperties.Bracketed_Morphism(arr, SuffixedElementSpec, rItem);
      }
      calc {
        Spec.Bracketed(arr, SuffixedElementSpec);
        Spec.Bracketed(arr, rItem);
        Spec.Array(arr);
      }
    }

    @IsolateAssertions function Array(cs: FreshCursor, json: ValueParser): (pr: ParseResult<jarray>)
      requires cs.SplitFrom?(json.cs)
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, Spec.Array)
    {
      var sp :- Bracketed(cs, json); assert sp.StrictlySplitFrom?(cs, BracketedSpec); BracketedToArray(sp.t); Success(sp)
    }

    import opened Params = ArrayParams
  }

  module ObjectParams refines SequenceParams {
    const OPEN := '{' as byte
    const CLOSE := '}' as byte

    function Colon(cs: FreshCursor): (pr: ParseResult<jcolon>)
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, SpecView)
    {
      var cs :- cs.AssertChar(':'); Success(cs.Split())
    }

    function KeyValueFromParts(ghost cs: Cursor, k: Split<jstring>, colon: Split<Structural<jcolon>>, v: Split<Value>): (sp: Split<jKeyValue>)
      requires k.StrictlySplitFrom?(cs, Spec.String)
      requires colon.StrictlySplitFrom?(k.cs, (c: Structural<jcolon>) => Spec.Structural(c, SpecView))
      requires v.StrictlySplitFrom?(colon.cs, Spec.Value)
      ensures sp.StrictlySplitFrom?(cs, ElementSpec)
    {
      var sp := SP(Grammar.KeyValue(k.t, colon.t, v.t), v.cs);
      assert cs.Bytes() == Spec.KeyValue(sp.t) + v.cs.Bytes() by {
        assert cs.Bytes() == Spec.String(k.t) + Spec.Structural(colon.t, SpecView) + Spec.Value(v.t) + v.cs.Bytes() by {
          assert cs.Bytes() == Spec.String(k.t) + k.cs.Bytes();
          assert k.cs.Bytes() == Spec.Structural(colon.t, SpecView) + colon.cs.Bytes();
          assert colon.cs.Bytes() == Spec.Value(v.t) + v.cs.Bytes();
          Seq.LemmaConcatIsAssociative(Spec.String(k.t), Spec.Structural(colon.t, SpecView), colon.cs.Bytes());
          Seq.LemmaConcatIsAssociative(Spec.String(k.t) + Spec.Structural(colon.t, SpecView), Spec.Value(v.t), v.cs.Bytes());
        }
      }
      assert sp.StrictlySplitFrom?(cs, ElementSpec);
      sp
    }

    function ElementSpec(t: TElement): bytes
    {
      Spec.KeyValue(t)
    }

    @IsolateAssertions function Element(cs: FreshCursor, json: ValueParser): (pr: ParseResult<TElement>)
    {
      var k :- Strings.String(cs); assert k.cs.StrictlySplitFrom?(json.cs); assert k.StrictlySplitFrom?(cs, Spec.String); var p := Parsers.Parser(Colon, SpecView); assert p.Valid?(); var colon :- Core.Structural(k.cs, p); assert colon.StrictlySplitFrom?(k.cs, (st: Structural<jcolon>) => Spec.Structural(st, SpecView)); assert colon.cs.StrictlySplitFrom?(json.cs); assert json.fn.requires(colon.cs) by {
    assert json.pre(colon.cs) by {
      assert colon.cs.StrictlySplitFrom?(json.cs);
      assert json.Valid?();
    }
    assert json.Valid?();
  } var v :- json.fn(colon.cs); assert v.StrictlySplitFrom?(colon.cs, Spec.Value) by {
    assert v.cs.StrictlySplitFrom?(colon.cs) by {
      assert v.StrictlySplitFrom?(colon.cs, json.spec) by {
        assert json.Valid?();
      }
    }
    assert v.BytesSplitFrom?(colon.cs, Spec.Value) by {
      calc {
        colon.cs.Bytes();
        {
          assert v.BytesSplitFrom?(colon.cs, json.spec) by {
            assert json.Valid?();
          }
        }
        json.spec(v.t) + v.cs.Bytes();
        {
          assert json.spec(v.t) == Spec.Value(v.t) by {
            assert ValueParserValid(json);
          }
        }
        Spec.Value(v.t) + v.cs.Bytes();
      }
    }
  } var kv := KeyValueFromParts(cs, k, colon, v); Success(kv)
    }

    import Strings

    import opened Wrappers

    type TElement = jKeyValue
  }

  module Objects refines Sequences {
    @IsolateAssertions lemma BracketedToObject(obj: jobject)
      ensures Spec.Bracketed(obj, SuffixedElementSpec) == Spec.Object(obj)
    {
      var rMember := (d: jmember) requires d < obj => Spec.Member(d);
      assert Spec.Bracketed(obj, SuffixedElementSpec) == Spec.Bracketed(obj, rMember) by {
        assert Spec.Bracketed(obj, SuffixedElementSpec) == Spec.Bracketed(obj, rMember) by {
          assert SpecProperties.Bracketed_Morphism_Requires(obj, SuffixedElementSpec, rMember);
          SpecProperties.Bracketed_Morphism(obj, SuffixedElementSpec, rMember);
        }
      }
      calc {
        Spec.Bracketed(obj, SuffixedElementSpec);
        Spec.Bracketed(obj, rMember);
        Spec.Object(obj);
      }
    }

    @IsolateAssertions @ResourceLimit("10e6") function Object(cs: FreshCursor, json: ValueParser): (pr: ParseResult<jobject>)
      requires cs.SplitFrom?(json.cs)
      ensures pr.Success? ==> pr.value.StrictlySplitFrom?(cs, Spec.Object)
    {
      var sp :- Bracketed(cs, json); assert sp.StrictlySplitFrom?(cs, BracketedSpec); BracketedToObject(sp.t); Success(sp)
    }

    import opened Params = ObjectParams
  }
}

module Std.JSON.ZeroCopy.Serializer {
  method Serialize(js: JSON) returns (rbs: SerializationResult<array<byte>>)
    ensures rbs.Success? ==> fresh(rbs.value)
    ensures rbs.Success? ==> rbs.value[..] == Spec.JSON(js)
  {
    var writer := Text(js);
    :- Need(writer.Unsaturated?, OutOfMemory);
    var bs := writer.ToArray();
    return Success(bs);
  }

  method SerializeTo(js: JSON, dest: array<byte>) returns (len: SerializationResult<uint32>)
    modifies dest
    ensures len.Success? ==> len.value as int <= dest.Length
    ensures len.Success? ==> dest[..len.value] == Spec.JSON(js)
    ensures len.Success? ==> dest[len.value..] == old(dest[len.value..])
    ensures len.Failure? ==> unchanged(dest)
  {
    var writer := Text(js);
    :- Need(writer.Unsaturated?, OutOfMemory);
    :- Need(writer.length as int <= dest.Length, OutOfMemory);
    writer.CopyTo(dest);
    return Success(writer.length);
  }

  function Text(js: JSON): (wr: Writer)
    ensures wr.Bytes() == Spec.JSON(js)
  {
    JSON(js)
  }

  function JSON(js: JSON, writer: Writer := Writer.Empty): (wr: Writer)
    ensures wr.Bytes() == writer.Bytes() + Spec.JSON(js)
  {
    Seq.LemmaConcatIsAssociative2(writer.Bytes(), js.before.Bytes(), Spec.Value(js.t), js.after.Bytes());
    writer.Append(js.before).Then((wr: Writer) => Value(js.t, wr)).Append(js.after)
  }

  @IsolateAssertions function Value(v: Grammar.Value, writer: Writer): (wr: Writer)
    ensures wr.Bytes() == writer.Bytes() + Spec.Value(v)
    decreases v, 4
  {
    match v
    case Null(n) =>
      var wr := writer.Append(n);
      wr
    case Bool(b) =>
      var wr := writer.Append(b);
      wr
    case String(str) =>
      var wr := String(str, writer);
      calc {
        wr.Bytes();
        {
          assert wr == String(v.str, writer);
        }
        writer.Bytes() + Spec.String(v.str);
        {
          assert v.String?;
          assert v.String? ==> Spec.Value(v) == Spec.String(v.str);
        }
        writer.Bytes() + Spec.Value(v);
      } wr
    case Number(num) =>
      var wr := Number(num, writer);
      calc {
        wr.Bytes();
        {
          assert wr == Number(v.num, writer);
        }
        writer.Bytes() + Spec.Number(v.num);
        {
          assert v.Number?;
          assert v.Number? ==> Spec.Value(v) == Spec.Number(v.num);
        }
        writer.Bytes() + Spec.Value(v);
      } wr
    case Object(obj) =>
      var wr := Object(obj, writer);
      calc {
        wr.Bytes();
        {
          assert wr == Object(v.obj, writer);
        }
        writer.Bytes() + Spec.Object(v.obj);
        {
          assert v.Object?;
          assert v.Object? ==> Spec.Value(v) == Spec.Object(v.obj);
        }
        writer.Bytes() + Spec.Value(v);
      } wr
    case Array(arr) =>
      var wr := Array(arr, writer);
      calc {
        wr.Bytes();
        {
          assert wr == Array(v.arr, writer);
        }
        writer.Bytes() + Spec.Array(v.arr);
        {
          assert v.Array?;
          assert v.Array? ==> Spec.Value(v) == Spec.Array(v.arr);
        }
        writer.Bytes() + Spec.Value(v);
      }
      wr
  }

  function String(str: jstring, writer: Writer): (wr: Writer)
    ensures wr.Bytes() == writer.Bytes() + Spec.String(str)
    decreases str, 0
  {
    hide *;
    reveal Writer.Append, Spec.String, Spec.View;
    writer.Append(str.lq).Append(str.contents).Append(str.rq)
  }

  @IsolateAssertions lemma NumberHelper1(num: jnumber, writer: Writer)
    ensures if num.exp.NonEmpty? then if num.frac.NonEmpty? then writer.Append(num.minus).Append(num.num).Append(num.frac.t.period).Append(num.frac.t.num).Append(num.exp.t.e).Append(num.exp.t.sign).Append(num.exp.t.num).Bytes() == writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + num.frac.t.period.Bytes() + num.frac.t.num.Bytes() + num.exp.t.e.Bytes() + num.exp.t.sign.Bytes() + num.exp.t.num.Bytes() else writer.Append(num.minus).Append(num.num).Append(num.exp.t.e).Append(num.exp.t.sign).Append(num.exp.t.num).Bytes() == writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + num.exp.t.e.Bytes() + num.exp.t.sign.Bytes() + num.exp.t.num.Bytes() else if num.frac.NonEmpty? then writer.Append(num.minus).Append(num.num).Append(num.frac.t.period).Append(num.frac.t.num).Bytes() == writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + num.frac.t.period.Bytes() + num.frac.t.num.Bytes() else writer.Append(num.minus).Append(num.num).Bytes() == writer.Bytes() + num.minus.Bytes() + num.num.Bytes()
  {
    if num.exp.NonEmpty? {
      if num.frac.NonEmpty? {
        assert writer.Append(num.minus).Append(num.num).Append(num.frac.t.period).Append(num.frac.t.num).Append(num.exp.t.e).Append(num.exp.t.sign).Append(num.exp.t.num).Bytes() == writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + num.frac.t.period.Bytes() + num.frac.t.num.Bytes() + num.exp.t.e.Bytes() + num.exp.t.sign.Bytes() + num.exp.t.num.Bytes();
      } else {
        assert writer.Append(num.minus).Append(num.num).Append(num.exp.t.e).Append(num.exp.t.sign).Append(num.exp.t.num).Bytes() == writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + num.exp.t.e.Bytes() + num.exp.t.sign.Bytes() + num.exp.t.num.Bytes();
      }
    } else {
      if num.frac.NonEmpty? {
        assert writer.Append(num.minus).Append(num.num).Append(num.frac.t.period).Append(num.frac.t.num).Bytes() == writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + num.frac.t.period.Bytes() + num.frac.t.num.Bytes();
      } else {
        assert writer.Append(num.minus).Append(num.num).Bytes() == writer.Bytes() + num.minus.Bytes() + num.num.Bytes();
      }
    }
  }

  @IsolateAssertions lemma NumberHelper2a(num: jnumber, writer: Writer)
    ensures Spec.Number(num) == num.minus.Bytes() + num.num.Bytes() + Spec.Maybe(num.frac, Spec.Frac) + Spec.Maybe(num.exp, Spec.Exp)
  {
  }

  @IsolateAssertions @ResourceLimit("10e6") lemma NumberHelper2(num: jnumber, writer: Writer)
    ensures if num.exp.NonEmpty? then if num.frac.NonEmpty? then writer.Bytes() + Spec.Number(num) == writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + num.frac.t.period.Bytes() + num.frac.t.num.Bytes() + num.exp.t.e.Bytes() + num.exp.t.sign.Bytes() + num.exp.t.num.Bytes() else writer.Bytes() + Spec.Number(num) == writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + num.exp.t.e.Bytes() + num.exp.t.sign.Bytes() + num.exp.t.num.Bytes() else if num.frac.NonEmpty? then writer.Bytes() + Spec.Number(num) == writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + num.frac.t.period.Bytes() + num.frac.t.num.Bytes() else writer.Bytes() + Spec.Number(num) == writer.Bytes() + num.minus.Bytes() + num.num.Bytes()
  {
    if num.exp.NonEmpty? {
      if num.frac.NonEmpty? {
        calc {
          writer.Bytes() + Spec.Number(num);
          {
            NumberHelper2a(num, writer);
          }
          writer.Bytes() + (num.minus.Bytes() + num.num.Bytes() + Spec.Maybe(num.frac, Spec.Frac) + Spec.Maybe(num.exp, Spec.Exp));
          writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + (Spec.Maybe(num.frac, Spec.Frac) + Spec.Maybe(num.exp, Spec.Exp));
          {
            assert Spec.Maybe(num.frac, Spec.Frac) == Spec.Frac(num.frac.t);
            assert Spec.Maybe(num.exp, Spec.Exp) == Spec.Exp(num.exp.t);
          }
          writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + (Spec.Frac(num.frac.t) + Spec.Exp(num.exp.t));
          {
            assert Spec.Frac(num.frac.t) == num.frac.t.period.Bytes() + num.frac.t.num.Bytes();
            assert Spec.Exp(num.exp.t) == num.exp.t.e.Bytes() + num.exp.t.sign.Bytes() + num.exp.t.num.Bytes();
          }
          writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + (num.frac.t.period.Bytes() + num.frac.t.num.Bytes() + (num.exp.t.e.Bytes() + num.exp.t.sign.Bytes() + num.exp.t.num.Bytes()));
          writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + num.frac.t.period.Bytes() + num.frac.t.num.Bytes() + num.exp.t.e.Bytes() + num.exp.t.sign.Bytes() + num.exp.t.num.Bytes();
        }
      } else {
        calc {
          writer.Bytes() + Spec.Number(num);
          {
            NumberHelper2a(num, writer);
          }
          writer.Bytes() + (num.minus.Bytes() + num.num.Bytes() + Spec.Maybe(num.frac, Spec.Frac) + Spec.Maybe(num.exp, Spec.Exp));
          writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + (Spec.Maybe(num.frac, Spec.Frac) + Spec.Maybe(num.exp, Spec.Exp));
          {
            assert Spec.Maybe(num.frac, Spec.Frac) == [];
            assert Spec.Maybe(num.exp, Spec.Exp) == Spec.Exp(num.exp.t);
          }
          writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + ([] + Spec.Exp(num.exp.t));
          {
            assert [] + Spec.Exp(num.exp.t) == Spec.Exp(num.exp.t);
          }
          writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + Spec.Exp(num.exp.t);
          {
            assert Spec.Exp(num.exp.t) == num.exp.t.e.Bytes() + num.exp.t.sign.Bytes() + num.exp.t.num.Bytes();
          }
          writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + (num.exp.t.e.Bytes() + num.exp.t.sign.Bytes() + num.exp.t.num.Bytes());
          writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + num.exp.t.e.Bytes() + num.exp.t.sign.Bytes() + num.exp.t.num.Bytes();
        }
      }
    } else {
      if num.frac.NonEmpty? {
        calc {
          writer.Bytes() + Spec.Number(num);
          {
            NumberHelper2a(num, writer);
          }
          writer.Bytes() + (num.minus.Bytes() + num.num.Bytes() + Spec.Maybe(num.frac, Spec.Frac) + Spec.Maybe(num.exp, Spec.Exp));
          writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + (Spec.Maybe(num.frac, Spec.Frac) + Spec.Maybe(num.exp, Spec.Exp));
          {
            assert Spec.Maybe(num.exp, Spec.Exp) == [];
            assert Spec.Maybe(num.frac, Spec.Frac) == Spec.Frac(num.frac.t);
          }
          writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + (Spec.Frac(num.frac.t) + []);
          writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + Spec.Frac(num.frac.t);
          {
            assert Spec.Frac(num.frac.t) == num.frac.t.period.Bytes() + num.frac.t.num.Bytes();
          }
          writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + num.frac.t.period.Bytes() + num.frac.t.num.Bytes();
        }
      } else {
        calc {
          writer.Bytes() + Spec.Number(num);
          {
            NumberHelper2a(num, writer);
          }
          writer.Bytes() + (num.minus.Bytes() + num.num.Bytes() + Spec.Maybe(num.frac, Spec.Frac) + Spec.Maybe(num.exp, Spec.Exp));
          {
            assert Spec.Maybe(num.frac, Spec.Frac) == [];
            assert Spec.Maybe(num.exp, Spec.Exp) == [];
          }
          writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + [] + [];
          writer.Bytes() + num.minus.Bytes() + num.num.Bytes();
        }
      }
    }
  }

  @IsolateAssertions function Number(num: jnumber, writer: Writer): (wr: Writer)
    ensures wr.Bytes() == writer.Bytes() + Spec.Number(num)
    decreases num, 0
  {
    var wr1 := writer.Append(num.minus).Append(num.num);
    var wr2 := if num.frac.NonEmpty? then wr1.Append(num.frac.t.period).Append(num.frac.t.num) else wr1;
    var wr3 := if num.exp.NonEmpty? then wr2.Append(num.exp.t.e).Append(num.exp.t.sign).Append(num.exp.t.num) else wr2;
    var wr := wr3;
    calc {
      wr.Bytes();
      {
        assert wr == wr3;
      }
      wr3.Bytes();
      {
        assert wr3 == if num.exp.NonEmpty? then wr2.Append(num.exp.t.e).Append(num.exp.t.sign).Append(num.exp.t.num) else wr2;
      }
      if num.exp.NonEmpty? then wr2.Append(num.exp.t.e).Append(num.exp.t.sign).Append(num.exp.t.num).Bytes() else wr2.Bytes();
      {
        assert wr2 == if num.frac.NonEmpty? then wr1.Append(num.frac.t.period).Append(num.frac.t.num) else wr1;
      }
      if num.exp.NonEmpty? then if num.frac.NonEmpty? then wr1.Append(num.frac.t.period).Append(num.frac.t.num).Append(num.exp.t.e).Append(num.exp.t.sign).Append(num.exp.t.num).Bytes() else wr1.Append(num.exp.t.e).Append(num.exp.t.sign).Append(num.exp.t.num).Bytes() else if num.frac.NonEmpty? then wr1.Append(num.frac.t.period).Append(num.frac.t.num).Bytes() else wr1.Bytes();
      {
        assert wr1 == writer.Append(num.minus).Append(num.num);
      }
      if num.exp.NonEmpty? then if num.frac.NonEmpty? then writer.Append(num.minus).Append(num.num).Append(num.frac.t.period).Append(num.frac.t.num).Append(num.exp.t.e).Append(num.exp.t.sign).Append(num.exp.t.num).Bytes() else writer.Append(num.minus).Append(num.num).Append(num.exp.t.e).Append(num.exp.t.sign).Append(num.exp.t.num).Bytes() else if num.frac.NonEmpty? then writer.Append(num.minus).Append(num.num).Append(num.frac.t.period).Append(num.frac.t.num).Bytes() else writer.Append(num.minus).Append(num.num).Bytes();
      {
        NumberHelper1(num, writer);
      }
      if num.exp.NonEmpty? then if num.frac.NonEmpty? then writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + num.frac.t.period.Bytes() + num.frac.t.num.Bytes() + num.exp.t.e.Bytes() + num.exp.t.sign.Bytes() + num.exp.t.num.Bytes() else writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + num.exp.t.e.Bytes() + num.exp.t.sign.Bytes() + num.exp.t.num.Bytes() else if num.frac.NonEmpty? then writer.Bytes() + num.minus.Bytes() + num.num.Bytes() + num.frac.t.period.Bytes() + num.frac.t.num.Bytes() else writer.Bytes() + num.minus.Bytes() + num.num.Bytes();
      {
        NumberHelper2(num, writer);
      }
      if num.exp.NonEmpty? then if num.frac.NonEmpty? then writer.Bytes() + Spec.Number(num) else writer.Bytes() + Spec.Number(num) else if num.frac.NonEmpty? then writer.Bytes() + Spec.Number(num) else writer.Bytes() + Spec.Number(num);
      writer.Bytes() + Spec.Number(num);
    }
    wr
  }

  @IsolateAssertions function StructuralView(st: Structural<View>, writer: Writer): (wr: Writer)
    ensures wr.Bytes() == writer.Bytes() + Spec.Structural(st, Spec.View)
  {
    hide *;
    reveal Writer.Append, Spec.Structural, Spec.View;
    writer.Append(st.before).Append(st.t).Append(st.after)
  }

  lemma StructuralViewEns(st: Structural<View>, writer: Writer)
    ensures StructuralView(st, writer).Bytes() == writer.Bytes() + Spec.Structural(st, Spec.View)
  {
  }

  lemma BracketedToObject(obj: jobject)
    ensures Spec.Bracketed(obj, Spec.Member) == Spec.Object(obj)
  {
    var rMember := (d: jmember) requires d < obj => Spec.Member(d);
    assert Spec.Bracketed(obj, Spec.Member) == Spec.Bracketed(obj, rMember) by {
      assert SpecProperties.Bracketed_Morphism_Requires(obj, Spec.Member, rMember);
      SpecProperties.Bracketed_Morphism(obj, Spec.Member, rMember);
    }
    calc {
      Spec.Bracketed(obj, Spec.Member);
      Spec.Bracketed(obj, rMember);
      Spec.Object(obj);
    }
  }

  function Object(obj: jobject, writer: Writer): (wr: Writer)
    ensures wr.Bytes() == writer.Bytes() + Spec.Object(obj)
    decreases obj, 3
  {
    var wr := StructuralView(obj.l, writer);
    StructuralViewEns(obj.l, writer);
    var wr := Members(obj, wr);
    var wr := StructuralView(obj.r, wr);
    Seq.LemmaConcatIsAssociative2(writer.Bytes(), Spec.Structural<View>(obj.l, Spec.View), Spec.ConcatBytes(obj.data, Spec.Member), Spec.Structural<View>(obj.r, Spec.View));
    assert wr.Bytes() == writer.Bytes() + Spec.Bracketed(obj, Spec.Member) by {
      hide *;
    }
    assert Spec.Bracketed(obj, Spec.Member) == Spec.Object(obj) by {
      BracketedToObject(obj);
    }
    wr
  }

  lemma BracketedToArray(arr: jarray)
    ensures Spec.Bracketed(arr, Spec.Item) == Spec.Array(arr)
  {
    var rItem := (d: jitem) requires d < arr => Spec.Item(d);
    assert Spec.Bracketed(arr, Spec.Item) == Spec.Bracketed(arr, rItem) by {
      assert SpecProperties.Bracketed_Morphism_Requires(arr, Spec.Item, rItem);
      SpecProperties.Bracketed_Morphism(arr, Spec.Item, rItem);
    }
    calc {
      Spec.Bracketed(arr, Spec.Item);
      Spec.Bracketed(arr, rItem);
      Spec.Array(arr);
    }
  }

  function Array(arr: jarray, writer: Writer): (wr: Writer)
    ensures wr.Bytes() == writer.Bytes() + Spec.Array(arr)
    decreases arr, 3
  {
    var wr := StructuralView(arr.l, writer);
    StructuralViewEns(arr.l, writer);
    var wr := Items(arr, wr);
    var wr := StructuralView(arr.r, wr);
    Seq.LemmaConcatIsAssociative2(writer.Bytes(), Spec.Structural<View>(arr.l, Spec.View), Spec.ConcatBytes(arr.data, Spec.Item), Spec.Structural<View>(arr.r, Spec.View));
    assert wr.Bytes() == writer.Bytes() + Spec.Bracketed(arr, Spec.Item);
    assert Spec.Bracketed(arr, Spec.Item) == Spec.Array(arr) by {
      BracketedToArray(arr);
    }
    wr
  }

  function Members(obj: jobject, writer: Writer): (wr: Writer)
    ensures wr.Bytes() == writer.Bytes() + Spec.ConcatBytes(obj.data, Spec.Member)
    decreases obj, 2
  {
    MembersSpec(obj, obj.data, writer)
  } by method {
    assume {:axiom} false;
    wr := MembersImpl(obj, writer);
  }

  function Items(arr: jarray, writer: Writer): (wr: Writer)
    ensures wr.Bytes() == writer.Bytes() + Spec.ConcatBytes(arr.data, Spec.Item)
    decreases arr, 2
  {
    ItemsSpec(arr, arr.data, writer)
  } by method {
    assume {:axiom} false;
    wr := ItemsImpl(arr, writer);
  }

  ghost function MembersSpec(obj: jobject, members: seq<jmember>, writer: Writer): (wr: Writer)
    requires forall j | 0 <= j < |members| :: members[j] < obj
    ensures wr.Bytes() == writer.Bytes() + Spec.ConcatBytes(members, Spec.Member)
    decreases obj, 1, members
  {
    if members == [] then
      writer
    else
      var butLast, last := members[..|members| - 1], members[|members| - 1]; assert members == butLast + [last]; var wr := MembersSpec(obj, butLast, writer); var wr := Member(obj, last, wr); assert wr.Bytes() == writer.Bytes() + (Spec.ConcatBytes(butLast, Spec.Member) + Spec.ConcatBytes([last], Spec.Member)) by {
    Seq.LemmaConcatIsAssociative(writer.Bytes(), Spec.ConcatBytes(butLast, Spec.Member), Spec.ConcatBytes([last], Spec.Member));
  } SpecProperties.ConcatBytes_Linear(butLast, [last], Spec.Member); wr
  }

  ghost predicate SequenceSpecRequiresHelper<T>(v: Value, items: seq<T>, spec: T -> bytes, impl: (Value, T, Writer) --> Writer, writer: Writer, item: T, wr: Writer)
    requires item in items
  {
    impl.requires(v, item, wr) &&
    impl(v, item, wr).Bytes() == wr.Bytes() + spec(item)
  }

  ghost predicate SequenceSpecRequires<T>(v: Value, items: seq<T>, spec: T -> bytes, impl: (Value, T, Writer) --> Writer, writer: Writer)
  {
    forall item, wr: Writer | item in items :: 
      SequenceSpecRequiresHelper(v, items, spec, impl, writer, item, wr)
  }

  @IsolateAssertions ghost function SequenceSpec<T>(v: Value, items: seq<T>, spec: T -> bytes, impl: (Value, T, Writer) --> Writer, writer: Writer): (wr: Writer)
    requires SequenceSpecRequires(v, items, spec, impl, writer)
    ensures wr.Bytes() == writer.Bytes() + Spec.ConcatBytes(items, spec)
    decreases v, 1, items
  {
    if items == [] then
      writer
    else
      assert SequenceSpecRequires(v, items[..|items| - 1], spec, impl, writer) by {
    assert forall item, wr: Writer {:trigger SequenceSpecRequiresHelper(v, items[..|items| - 1], spec, impl, writer, item, wr)} | item in items[..|items| - 1] :: SequenceSpecRequiresHelper(v, items[..|items| - 1], spec, impl, writer, item, wr) by {
      forall item, wr: Writer {:trigger SequenceSpecRequiresHelper(v, items[..|items| - 1], spec, impl, writer, item, wr)} | item in items[..|items| - 1]
        ensures SequenceSpecRequiresHelper(v, items[..|items| - 1], spec, impl, writer, item, wr)
      {
        assert item in items;
        assert SequenceSpecRequiresHelper(v, items, spec, impl, writer, item, wr);
      }
    }
  } var writer' := SequenceSpec(v, items[..|items| - 1], spec, impl, writer); assert impl.requires(v, items[|items| - 1], writer') by {
    assert SequenceSpecRequiresHelper(v, items, spec, impl, writer, items[|items| - 1], writer') by {
      assert SequenceSpecRequires(v, items, spec, impl, writer);
      assert items[|items| - 1] in items;
    }
  } var wr := impl(v, items[|items| - 1], writer'); assert wr.Bytes() == writer.Bytes() + Spec.ConcatBytes(items, spec) by {
    calc {
      wr.Bytes();
      {
        assert wr == impl(v, items[|items| - 1], writer');
      }
      impl(v, items[|items| - 1], writer').Bytes();
      {
        assert SequenceSpecRequires(v, items, spec, impl, writer);
        assert items[|items| - 1] in items;
        assert SequenceSpecRequiresHelper(v, items, spec, impl, writer, items[|items| - 1], writer');
      }
      writer'.Bytes() + spec(items[|items| - 1]);
      {
        assert writer' == SequenceSpec(v, items[..|items| - 1], spec, impl, writer);
      }
      writer.Bytes() + Spec.ConcatBytes(items[..|items| - 1], spec) + spec(items[|items| - 1]);
      {
        assert spec(items[|items| - 1]) == Spec.ConcatBytes([items[|items| - 1]], spec);
      }
      writer.Bytes() + Spec.ConcatBytes(items[..|items| - 1], spec) + Spec.ConcatBytes([items[|items| - 1]], spec);
      {
        SpecProperties.ConcatBytes_Linear(items[..|items| - 1], [items[|items| - 1]], spec);
      }
      writer.Bytes() + Spec.ConcatBytes(items[..|items| - 1] + [items[|items| - 1]], spec);
      {
        assert items == items[..|items| - 1] + [items[|items| - 1]];
      }
      writer.Bytes() + Spec.ConcatBytes(items, spec);
    }
  } wr
  }

  ghost function ItemsSpec(arr: jarray, items: seq<jitem>, writer: Writer): (wr: Writer)
    requires forall j | 0 <= j < |items| :: items[j] < arr
    ensures wr.Bytes() == writer.Bytes() + Spec.ConcatBytes(items, Spec.Item)
    decreases arr, 1, items
  {
    if items == [] then
      writer
    else
      var butLast, last := items[..|items| - 1], items[|items| - 1]; assert items == butLast + [last]; var wr := ItemsSpec(arr, butLast, writer); var wr := Item(arr, last, wr); assert wr.Bytes() == writer.Bytes() + (Spec.ConcatBytes(butLast, Spec.Item) + Spec.ConcatBytes([last], Spec.Item)) by {
    Seq.LemmaConcatIsAssociative(writer.Bytes(), Spec.ConcatBytes(butLast, Spec.Item), Spec.ConcatBytes([last], Spec.Item));
  } SpecProperties.ConcatBytes_Linear(butLast, [last], Spec.Item); wr
  }

  @IsolateAssertions method MembersImpl(obj: jobject, writer: Writer) returns (wr: Writer)
    ensures wr == MembersSpec(obj, obj.data, writer)
    decreases obj, 1
  {
    wr := writer;
    var members := obj.data;
    assert wr == MembersSpec(obj, members[..0], writer);
    for i := 0 to |members|
      invariant wr == MembersSpec(obj, members[..i], writer)
    {
      assert members[..i + 1][..i] == members[..i] by {
        Seq.TakeLess(members, i, i + 1);
      }
      wr := Member(obj, members[i], wr);
    }
    assert members[..|members|] == members;
    assert wr == MembersSpec(obj, members, writer);
  }

  @IsolateAssertions method ItemsImpl(arr: jarray, writer: Writer) returns (wr: Writer)
    ensures wr == ItemsSpec(arr, arr.data, writer)
    decreases arr, 1
  {
    wr := writer;
    var items := arr.data;
    assert wr == ItemsSpec(arr, items[..0], writer);
    for i := 0 to |items|
      invariant wr == ItemsSpec(arr, items[..i], writer)
    {
      assert items[..i + 1][..i] == items[..i] by {
        AboutList(items, i, i + 1);
      }
      wr := Item(arr, items[i], wr);
    }
    assert items[..|items|] == items;
  }

  lemma AboutList<T>(xs: seq<T>, i: nat, j: nat)
    requires i < j <= |xs|
    ensures xs[..j][..i] == xs[..i]
  {
  }

  function Member(ghost obj: jobject, m: jmember, writer: Writer): (wr: Writer)
    requires m < obj
    ensures wr.Bytes() == writer.Bytes() + Spec.Member(m)
    decreases obj, 0
  {
    var wr := String(m.t.k, writer);
    var wr := StructuralView(m.t.colon, wr);
    var wr := Value(m.t.v, wr);
    assert wr.Bytes() == writer.Bytes() + (Spec.String(m.t.k) + Spec.Structural<View>(m.t.colon, Spec.View) + Spec.Value(m.t.v)) by {
      Seq.LemmaConcatIsAssociative2(writer.Bytes(), Spec.String(m.t.k), Spec.Structural<View>(m.t.colon, Spec.View), Spec.Value(m.t.v));
    }
    var wr := if m.suffix.Empty? then wr else StructuralView(m.suffix.t, wr);
    assert wr.Bytes() == writer.Bytes() + Spec.KeyValue(m.t) + Spec.CommaSuffix(m.suffix) by {
      if m.suffix.Empty? {
        EmptySequenceIsRightIdentity(Spec.KeyValue(m.t));
        Seq.LemmaConcatIsAssociative(writer.Bytes(), Spec.KeyValue(m.t), []);
      } else {
        assert Spec.StructuralView(m.suffix.t) == Spec.CommaSuffix(m.suffix);
      }
    }
    assert wr.Bytes() == writer.Bytes() + (Spec.KeyValue(m.t) + Spec.CommaSuffix(m.suffix)) by {
      Seq.LemmaConcatIsAssociative(writer.Bytes(), Spec.KeyValue(m.t), Spec.CommaSuffix(m.suffix));
    }
    wr
  }

  function Item(ghost arr: jarray, m: jitem, writer: Writer): (wr: Writer)
    requires m < arr
    ensures wr.Bytes() == writer.Bytes() + Spec.Item(m)
    decreases arr, 0
  {
    var wr := Value(m.t, writer);
    var wr := if m.suffix.Empty? then wr else StructuralView(m.suffix.t, wr);
    assert wr.Bytes() == writer.Bytes() + (Spec.Value(m.t) + Spec.CommaSuffix(m.suffix)) by {
      Seq.LemmaConcatIsAssociative(writer.Bytes(), Spec.Value(m.t), Spec.CommaSuffix(m.suffix));
    }
    wr
  }

  import Spec = ConcreteSyntax.Spec

  import SpecProperties = ConcreteSyntax.SpecProperties

  import opened BoundedInts

  import opened Wrappers

  import opened Seq = Collections.Seq

  import opened Errors

  import opened Grammar

  import opened Writers = Utils.Views.Writers

  import opened Vs = Utils.Views.Core
}

module Std.Math {
  function Min(a: int, b: int): int
  {
    if a < b then
      a
    else
      b
  }

  function Min3(a: int, b: int, c: int): int
  {
    Min(a, Min(b, c))
  }

  function Max(a: int, b: int): int
  {
    if a < b then
      b
    else
      a
  }

  function Max3(a: int, b: int, c: int): int
  {
    Max(a, Max(b, c))
  }

  function Abs(a: int): int
  {
    if a < 0 then
      -a
    else
      a
  }
}

module Std.Ordinal {
  ghost function {:axiom} Omega(): ORDINAL
    ensures !Omega().IsNat
    ensures Omega().IsLimit
    ensures forall other: ORDINAL | other.IsLimit && other != 0 :: Omega() <= other

  lemma {:axiom} Succ(a: ORDINAL, b: ORDINAL)
    ensures a < b <==> a + 1 <= b

  ghost function {:axiom} PlusLimit(left: ORDINAL, right: ORDINAL): (result: ORDINAL)
    ensures forall right' | right' < right :: Plus(left, right') < result
    ensures forall result' {:trigger} | forall right' | right' < right :: Plus(left, right') < result' :: result <= result'
    decreases right, 0

  ghost function Plus(left: ORDINAL, right: ORDINAL): ORDINAL
    decreases right
  {
    if right == 0 then
      0
    else if right.IsLimit then
      PlusLimit(left, right)
    else
      Plus(left, right - 1) + 1
  }

  lemma {:axiom} PlusDefinition(left: ORDINAL, right: ORDINAL)
    ensures Plus(left, right) == left + right

  lemma {:axiom} PlusStrictlyIncreasingOnRight(left: ORDINAL, right: ORDINAL, right': ORDINAL)
    requires right < right'
    ensures left + right < left + right'
    decreases right

  lemma {:axiom} PlusIncreasingOnLeft(left: ORDINAL, left': ORDINAL, right: ORDINAL)
    requires left <= left'
    ensures left + right <= left' + right

  lemma SuccStrictlyIncreasing(a: ORDINAL, b: ORDINAL)
    requires a < b
    ensures a + 1 < b + 1
  {
    PlusDefinition(a, 1);
    PlusDefinition(b, 1);
  }

  lemma SuccIncreasing(a: ORDINAL, b: ORDINAL)
    requires a <= b
    ensures a + 1 <= b + 1
  {
    PlusDefinition(a, 1);
    PlusDefinition(b, 1);
  }

  lemma {:axiom} PlusIsAssociative(x: ORDINAL, y: ORDINAL, z: ORDINAL)
    ensures x + y + z == x + (y + z)
    decreases z

  ghost function {:axiom} TimesLimit(left: ORDINAL, right: ORDINAL): (result: ORDINAL)
    ensures forall right' | right' < right :: Times(left, right') < result
    ensures forall result' {:trigger} | forall right' | right' < right :: Times(left, right') < result' :: result <= result'
    decreases right, 0

  ghost function Times(left: ORDINAL, right: ORDINAL): (result: ORDINAL)
    decreases right
  {
    if right == 0 then
      0
    else if right.IsLimit then
      TimesLimit(left, right)
    else
      Times(left, right - 1) + left
  }

  lemma TimesLeftIdentity(o: ORDINAL)
    ensures Times(1, o) == o
  {
    if o.IsLimit {
      assert Times(1, o) <= o;
    } else {
      TimesLeftIdentity(o - 1);
    }
  }

  lemma TimesRightIdentity(o: ORDINAL)
    ensures Times(o, 1) == o
  {
  }

  lemma {:axiom} TimesStrictlyIncreasingOnRight(left: ORDINAL, right: ORDINAL, right': ORDINAL)
    requires 0 < left
    requires right < right'
    ensures Times(left, right) < Times(left, right')

  lemma {:axiom} TimesIncreasingOnLeft(left: ORDINAL, left': ORDINAL, right: ORDINAL)
    requires left <= left'
    ensures Times(left, right) < Times(left', right)

  lemma {:axiom} TimesDistributesOnLeft(left: ORDINAL, right: ORDINAL, right': ORDINAL)
    ensures Times(left, right + right') == Times(left, right) + Times(left, right')
    decreases right'

  function Max(a: ORDINAL, b: ORDINAL): ORDINAL
  {
    if a < b then
      b
    else
      a
  }

  lemma RadixStrictlyIncreasing(base: ORDINAL, a: ORDINAL, a': ORDINAL, b: ORDINAL)
    requires a < a'
    requires b < base
    ensures Times(base, a) + b < Times(base, a')
  {
    Succ(a, a');
    assert a + 1 <= a';
    TimesDistributesOnLeft(base, a', 1);
    assert Times(base, a' + 1) == Times(base, a') + Times(base, 1);
    TimesLeftIdentity(base);
    assert Times(base, a' + 1) == Times(base, a') + base;
    if a + 1 == a' {
      calc {
        Times(base, a) + b;
      <
        {
          PlusStrictlyIncreasingOnRight(Times(base, a), b, base);
        }
        Times(base, a) + base;
        Times(base, a + 1);
        Times(base, a');
      }
    } else {
      calc {
        Times(base, a) + b;
      <
        {
          PlusStrictlyIncreasingOnRight(Times(base, a), b, base);
        }
        Times(base, a) + base;
        Times(base, a + 1);
      <=
        {
          TimesStrictlyIncreasingOnRight(base, a + 1, a');
        }
        Times(base, a');
      }
    }
  }
}

abstract module Std.Parsers.AbstractInput {
  function ToInput(r: seq<C>): (i: Input)
    ensures View(i) == r

  function View(self: Input): (r: seq<C>)
    ensures |View(self)| == Length(self)

  function Length(self: Input): nat

  function CharAt(self: Input, i: int): C
    requires 0 <= i < Length(self)
    ensures CharAt(self, i) == View(self)[i]

  function Drop(self: Input, start: int): Input
    requires 0 <= start <= Length(self)
    ensures View(self)[start..] == View(Drop(self, start))
    ensures start == 0 ==> Drop(self, start) == self

  function Slice(self: Input, start: int, end: int): Input
    requires 0 <= start <= end <= Length(self)
    ensures View(self)[start .. end] == View(Slice(self, start, end))

  lemma AboutDrop(self: Input, a: int, b: int)
    requires 0 <= a <= Length(self)
    requires 0 <= b <= Length(self) - a
    ensures Drop(self, a + b) == Drop(Drop(self, a), b)

  type Input(==,!new)

  type C(==,!new)
}

abstract module Std.Parsers.Core {
  predicate IsRemaining(input: Input, remaining: Input)
  {
    A.Length(remaining) <= A.Length(input) &&
    A.Drop(input, A.Length(input) - A.Length(remaining)) == remaining
  }

  lemma IsRemainingTransitive(input: Input, remaining1: Input, remaining2: Input)
    requires IsRemaining(input, remaining1)
    requires IsRemaining(remaining1, remaining2)
    ensures IsRemaining(input, remaining2)
  {
    A.AboutDrop(input, A.Length(input) - A.Length(remaining1), A.Length(remaining1) - A.Length(remaining2));
  }

  opaque function SucceedWith<R>(result: R): (p: Parser<R>)
  {
    (input: Input) => ParseSuccess(result, input)
  }

  opaque function Epsilon(): (p: Parser<()>)
  {
    SucceedWith(())
  }

  opaque function FailWith<R>(message: string, level: FailureLevel := Recoverable): Parser<R>
  {
    (input: Input) => ParseFailure(level, FailureData(message, input, Option.None))
  }

  opaque function ResultWith<R>(result: ParseResult<R>): Parser<R>
  {
    (input: Input) => result
  }

  opaque function EndOfString(): Parser<()>
  {
    (input: Input) => if A.Length(input) == 0 then ParseSuccess((), input) else ParseFailure(Recoverable, FailureData("expected end of string", input, Option.None))
  }

  opaque function Bind<L, R>(left: Parser<L>, right: L -> Parser<R>): (p: Parser<R>)
  {
    (input: Input) => var (leftResult, remaining) :- left(input); right(leftResult)(remaining)
  }

  opaque function BindSucceeds<L, R>(left: Parser<L>, right: (L, Input) -> Parser<R>): (p: Parser<R>)
  {
    (input: Input) => var (leftResult, remaining) :- left(input); right(leftResult, remaining)(remaining)
  }

  opaque function BindResult<L, R>(left: Parser<L>, right: (ParseResult<L>, Input) -> Parser<R>): (p: Parser<R>)
  {
    (input: Input) => right(left(input), input)(input)
  }

  opaque function Map<R, U>(underlying: Parser<R>, mappingFunc: R -> U): (p: Parser<U>)
  {
    (input: Input) => var (result, remaining) :- underlying(input); var u := mappingFunc(result); ParseSuccess(u, remaining)
  }

  opaque function Not<R>(underlying: Parser<R>): Parser<()>
  {
    (input: Input) => var l := underlying(input); if l.IsFailure() then if l.IsFatal() then l.PropagateFailure() else ParseSuccess((), input) else ParseFailure(Recoverable, FailureData("not failed", input, Option.None))
  }

  opaque function And<L, R>(left: Parser<L>, right: Parser<R>): (p: Parser<(L, R)>)
  {
    (input: Input) => var (l, remainingLeft) :- left(input); var (r, remainingRight) :- right(input); ParseSuccess((l, r), remainingRight)
  }

  opaque function Or<R>(left: Parser<R>, right: Parser<R>): (p: Parser<R>)
  {
    (input: Input) => var p := left(input); if !p.NeedsAlternative(input) then p else var p2 := right(input); if !p2.NeedsAlternative(input) then p2 else p2.MapRecoverableError(dataRight => p.data.Concat(dataRight))
  }

  opaque function OrSeq<R>(alternatives: seq<Parser<R>>): Parser<R>
  {
    if |alternatives| == 0 then
      FailWith("no alternatives")
    else if |alternatives| == 1 then
      alternatives[0]
    else
      Or(alternatives[0], OrSeq(alternatives[1..]))
  }

  opaque function Lookahead<R>(underlying: Parser<R>): (p: Parser<R>)
  {
    (input: Input) => var p := underlying(input); if p.IsFailure() then if p.IsFatal() then p else p.(data := FailureData(p.data.message, input, Option.None)) else p.(remaining := input)
  }

  opaque function ?<R>(underlying: Parser<R>): (p: Parser<R>)
  {
    (input: Input) => var p := underlying(input); if p.IsFailure() then if p.IsFatal() then p else p.(data := FailureData(p.data.message, input, Option.None)) else p
  }

  opaque function If<L, R>(condition: Parser<L>, succeed: Parser<R>): (p: Parser<R>)
  {
    Bind(Lookahead(condition), (l: L) => succeed)
  }

  lemma AboutMaybe(input: Input)
    requires A.Length(input) > 0
  {
    reveal FailWith();
    var u := FailWith<char>("Error")(input);
    reveal Maybe();
    assert Maybe<char>(FailWith("Error"))(input) == ParseSuccess(Wrappers.None, input);
    var committedFailure := ParseFailure(Recoverable, FailureData("", A.Drop(input, 1), Option.None));
    reveal ResultWith();
    assert Maybe<char>(ResultWith(committedFailure))(input) == committedFailure.PropagateFailure();
  }

  opaque function Maybe<R>(underlying: Parser<R>): Parser<Option<R>>
  {
    (input: Input) => var u := underlying(input); if u.IsFatalFailure() || (u.IsFailure() && !u.NeedsAlternative(input)) then u.PropagateFailure() else if u.ParseSuccess? then u.Map(result => Option.Some(result)) else ParseSuccess(Option.None, input)
  }

  opaque function ConcatMap<L, R, T>(left: Parser<L>, right: Parser<R>, mapper: (L, R) -> T): (p: Parser<T>)
  {
    (input: Input) => var (l, remaining) :- left(input); var (r, remaining2) :- right(remaining); ParseSuccess(mapper(l, r), remaining2)
  }

  opaque function Concat<L, R>(left: Parser<L>, right: Parser<R>): (p: Parser<(L, R)>)
  {
    (input: Input) => var (l, remaining) :- left(input); var (r, remaining2) :- right(remaining); ParseSuccess((l, r), remaining2)
  }

  opaque function ConcatKeepRight<L, R>(left: Parser<L>, right: Parser<R>): (p: Parser<R>)
  {
    ConcatMap(left, right, (l, r) => r)
  }

  opaque function ConcatKeepLeft<L, R>(left: Parser<L>, right: Parser<R>): (p: Parser<L>)
  {
    ConcatMap(left, right, (l, r) => l)
  }

  opaque function Debug<R, D>(underlying: Parser<R>, name: string, onEnter: (string, Input) -> D, onExit: (string, D, ParseResult<R>) -> ()): (p: Parser<R>)
  {
    (input: Input) => var debugData := onEnter(name, input); var output := underlying(input); var _ /* _v1 */ := onExit(name, debugData, output); output
  }

  opaque function ZeroOrMore<R>(underlying: Parser<R>): Parser<seq<R>>
  {
    Map(Rep(underlying, (result: SeqB<R>, r: R) => result.Append(r), SeqBNil), (result: SeqB<R>) => result.ToSequence())
  }

  opaque function OneOrMore<R>(underlying: Parser<R>): (p: Parser<seq<R>>)
  {
    Bind(underlying, (r: R) => Map(Rep(underlying, (result: SeqB<R>, r: R) => result.Append(r), SeqBCons(r, SeqBNil)), (result: SeqB<R>) => result.ToSequence()))
  }

  opaque function Rep<A, B>(underlying: Parser<B>, combine: (A, B) -> A, acc: A): Parser<A>
  {
    (input: Input) => Rep_(underlying, combine, acc, input)
  }

  opaque function RepSep<A, B>(underlying: Parser<A>, separator: Parser<B>): Parser<seq<A>>
  {
    Bind(Maybe(underlying), (result: Option<A>) => if result.None? then SucceedWith<seq<A>>([]) else Map(Rep(ConcatKeepRight(separator, underlying), (acc: SeqB<A>, a: A) => acc.Append(a), SeqBCons(result.value, SeqBNil)), (result: SeqB<A>) => result.ToSequence()))
  }

  opaque function RepMerge<A>(underlying: Parser<A>, merger: (A, A) -> A): Parser<A>
  {
    Bind(Maybe(underlying), (result: Option<A>) => if result.None? then FailWith<A>("No first element in RepMerge", Recoverable) else Rep(underlying, (acc: A, a: A) => merger(acc, a), result.value))
  }

  opaque function RepSepMerge<A, B>(underlying: Parser<A>, separator: Parser<B>, merger: (A, A) -> A): Parser<A>
  {
    Bind(Maybe(underlying), (result: Option<A>) => if result.None? then FailWith<A>("No first element in RepSepMerge", Recoverable) else Rep(ConcatKeepRight(separator, underlying), (acc: A, a: A) => merger(acc, a), result.value))
  }

  opaque function {:tailrecursion true} Rep_<A, B>(underlying: Parser<B>, combine: (A, B) -> A, acc: A, input: Input): (p: ParseResult<A>)
    decreases A.Length(input)
  {
    match underlying(input)
    case ParseSuccess(result, remaining) =>
      if A.Length(remaining) >= A.Length(input) then
        ParseSuccess(acc, input)
      else
        Rep_(underlying, combine, combine(acc, result), remaining)
    case failure =>
      if failure.NeedsAlternative(input) then
        ParseSuccess(acc, input)
      else
        failure.PropagateFailure()
  }

  opaque function Recursive<R(!new)>(underlying: Parser<R> -> Parser<R>): (p: Parser<R>)
  {
    (input: Input) => Recursive_(underlying, input)
  }

  function RecursiveProgressError<R>(name: string, input: A.Input, remaining: Input): (r: ParseResult<R>)
    requires A.Length(input) <= A.Length(remaining)
    ensures r.IsFailure()
  {
    if A.Length(remaining) == A.Length(input) then
      ParseFailure(Recoverable, FailureData(name + " no progress in recursive parser", remaining, Option.None))
    else
      ParseFailure(Fatal, FailureData(name + "fixpoint called with an increasing remaining sequence", remaining, Option.None))
  }

  opaque function Recursive_<R(!new)>(underlying: Parser<R> -> Parser<R>, input: Input): (p: ParseResult<R>)
    decreases A.Length(input)
  {
    var callback: Parser<R> := (remaining: Input) => if A.Length(remaining) < A.Length(input) then Recursive_(underlying, remaining) else RecursiveProgressError<R>("Parsers.Recursive", input, remaining);
    underlying(callback)(input)
  }

  function RecursiveNoStack<R>(underlying: Parser<RecursiveNoStackResult<R>>): Parser<R>
  {
    (input: Input) => RecursiveNoStack_(underlying, underlying, input, [])
  }

  @IsolateAssertions function RecursiveNoStack_<R>(continuation: Parser<RecursiveNoStackResult<R>>, underlying: Parser<RecursiveNoStackResult<R>>, input: Input, callbacks: seq<ParseResult<R> -> RecursiveCallback<R>>): (result: ParseResult<R>)
    decreases A.Length(input), |callbacks|
  {
    var (recursor, remaining) :- continuation(input); match recursor case RecursiveReturn(result) => (if |callbacks| == 0 then ParseSuccess(result, remaining) else var toCompute := callbacks[0](ParseSuccess(result, remaining)); if A.Length(input) < A.Length(remaining) then RecursiveProgressError<R>("Parsers.RecursiveNoStack[internal]", input, remaining) else RecursiveNoStack_<R>(toCompute, underlying, remaining, callbacks[1..])) case RecursiveContinue(rToNewParserOfRecursiveNoStackResultOfR) => if A.Length(input) <= A.Length(remaining) then RecursiveProgressError<R>("Parsers.RecursiveNoStack", input, remaining) else RecursiveNoStack_<R>(underlying, underlying, remaining, [(p: ParseResult<R>) => if p.IsFailure() then ResultWith(p.PropagateFailure()) else var (r, remaining2) := p.Extract(); rToNewParserOfRecursiveNoStackResultOfR(r)] + callbacks)
  }

  opaque function RecursiveMap<R(!new)>(underlying: map<string, RecursiveDef<R>>, fun: string): (p: Parser<R>)
  {
    (input: Input) => RecursiveMap_(underlying, fun, input)
  }

  opaque function RecursiveMap_<R(!new)>(underlying: map<string, RecursiveDef<R>>, fun: string, input: Input): (p: ParseResult<R>)
    decreases A.Length(input), if fun in underlying then underlying[fun].order else 0
  {
    if fun !in underlying then
      ParseFailure(Fatal, FailureData("parser '" + fun + "' not found", input, Option.None))
    else
      var RecursiveDef(orderFun, definitionFun) := underlying[fun]; var callback: ParserSelector<R> := (fun': string) => var p: Parser<R> := if fun' !in underlying.Keys then FailWith(fun' + " not defined", Fatal) else var RecursiveDef(orderFun', definitionFun') := underlying[fun']; (remaining: Input) => if A.Length(remaining) < A.Length(input) || (A.Length(remaining) == A.Length(input) && orderFun' < orderFun) then RecursiveMap_(underlying, fun', remaining) else if A.Length(remaining) == A.Length(input) then ParseFailure(Recoverable, FailureData("non-progressing recursive call requires that order of '" + fun' + "' (" + Strings.OfInt(orderFun') + ") is lower than the order of '" + fun + "' (" + Strings.OfInt(orderFun) + ")", remaining, Option.None)) else ParseFailure(Fatal, FailureData("parser did not return a suffix of the input", remaining, Option.None)); p; definitionFun(callback)(input)
  }

  opaque function CharTest(test: C -> bool, name: string): (p: Parser<C>)
  {
    (input: Input) => if 0 < A.Length(input) && test(A.CharAt(input, 0)) then ParseSuccess(A.CharAt(input, 0), A.Drop(input, 1)) else ParseFailure(Recoverable, FailureData("expected a " + name, input, Option.None))
  }

  opaque function DigitToInt(c: char): int
  {
    match c
    case '0' =>
      0
    case '1' =>
      1
    case '2' =>
      2
    case '3' =>
      3
    case '4' =>
      4
    case '5' =>
      5
    case '6' =>
      6
    case '7' =>
      7
    case '8' =>
      8
    case '9' =>
      9
    case _ /* _v4 */ =>
      -1
  }

  opaque function StringToInt(s: string): int
    decreases |s|
  {
    if |s| == 0 then
      0
    else if |s| == 1 then
      DigitToInt(s[0])
    else if s[0] == '-' then
      0 - StringToInt(s[1..])
    else
      StringToInt(s[0 .. |s| - 1]) * 10 + StringToInt(s[|s| - 1 .. |s|])
  }

  import Wrappers

  import Strings

  export
    provides Wrappers, SucceedWith, Epsilon, FailWith, EndOfString, Bind, BindSucceeds, BindResult, Map, Not, And, Or, OrSeq, Lookahead, ?, If, Maybe, ConcatMap, Concat, ConcatKeepLeft, ConcatKeepRight, Debug, Rep, RepSep, RepMerge, RepSepMerge, ResultWith, CharTest, ZeroOrMore, OneOrMore, Recursive, RecursiveNoStack, RecursiveMap, DigitToInt, StringToInt, ParseResult.IsFailure, ParseResult.PropagateFailure, ParseResult.Extract, A
    reveals C, Input, Parser, ParserSelector, Option, FailureLevel, ParseResult, FailureData, RecursiveDef, RecursiveNoStackResult, RecursiveProgressError


  export All
    reveals *


  import A : AbstractInput

  type C = A.C

  type Input = A.Input

  type Parser<+R> = Input -> ParseResult<R>

  type ParserSelector<!R> = string -> Parser<R>

  type Option<T> = Wrappers.Option<T>

  datatype FailureData = FailureData(message: string, remaining: Input, next: Option<FailureData>) {
    function Concat(other: FailureData): FailureData
    {
      if next == Option.None then
        this.(next := Option.Some(other))
      else
        FailureData(message, remaining, Option.Some(next.value.Concat(other)))
    }
  }

  datatype FailureLevel = Fatal | Recoverable

  datatype ParseResult<+R> = ParseFailure(level: FailureLevel, data: FailureData) | ParseSuccess(result: R, remaining: Input) {
    function Remaining(): Input
    {
      if ParseSuccess? then
        remaining
      else
        data.remaining
    }

    predicate IsFailure()
    {
      ParseFailure?
    }

    predicate IsFatalFailure()
    {
      ParseFailure? &&
      level == Fatal
    }

    predicate IsFatal()
      requires IsFailure()
    {
      level == Fatal
    }

    function PropagateFailure<U>(): ParseResult<U>
      requires IsFailure()
    {
      ParseFailure(level, data)
    }

    function Extract(): (R, Input)
      requires !IsFailure()
    {
      (result, remaining)
    }

    function Map<R'>(f: R -> R'): ParseResult<R'>
    {
      match this
      case ParseSuccess(result, remaining) =>
        ParseSuccess(f(result), remaining)
      case ParseFailure(level, data) =>
        ParseFailure(level, data)
    }

    function MapRecoverableError(f: FailureData -> FailureData): ParseResult<R>
    {
      match this
      case ParseFailure(Recoverable, data) =>
        ParseFailure(Recoverable, f(data))
      case _ /* _v0 */ =>
        this
    }

    predicate NeedsAlternative(input: Input)
    {
      ParseFailure? &&
      level == Recoverable &&
      input == Remaining()
    }
  }

  datatype SeqB<A> = SeqBCons(last: A, init: SeqB<A>) | SeqBNil {
    function Append(elem: A): SeqB<A>
    {
      SeqBCons(elem, this)
    }

    function Length(): nat
    {
      if SeqBNil? then
        0
      else
        1 + init.Length()
    }

    function ToSequence(): seq<A>
      ensures |ToSequence()| == Length()
    {
      if SeqBNil? then
        []
      else
        init.ToSequence() + [last]
    } by method {
      if SeqBNil? {
        return [];
      }
      var defaultElem := last;
      var l := Length();
      var elements := new A[l] (i => defaultElem);
      var t := this;
      var i := l;
      assert t.ToSequence() + elements[i..] == ToSequence();
      while !t.SeqBNil?
        invariant 0 <= i <= l
        invariant i == t.Length()
        invariant t.ToSequence() + elements[i..] == ToSequence()
        decreases i
      {
        i := i - 1;
        elements[i] := t.last;
        t := t.init;
        assert t.ToSequence() + elements[i..] == ToSequence();
      }
      return elements[..];
    }
  }

  datatype RecursiveNoStackResult<!R> = RecursiveReturn(R) | RecursiveContinue(R -> Parser<RecursiveNoStackResult<R>>)

  type RecursiveCallback<!R> = Parser<RecursiveNoStackResult<R>>

  datatype RecursiveDef<!R> = RecursiveDef(order: nat, definition: ParserSelector<R> -> Parser<R>)
}

abstract module Std.Parsers.Builders {
  function ToInput(other: seq<C>): (i: Input)

  function SucceedWith<T>(t: T): B<T>
  {
    B(P.SucceedWith(t))
  }

  function FailWith<T>(message: string, level: FailureLevel := P.Recoverable): B<T>
  {
    B(P.FailWith(message, level))
  }

  function ResultWith<R>(result: ParseResult<R>): B<R>
  {
    B(P.ResultWith(result))
  }

  const Nothing: B<()> := B(P.Epsilon())

  function MId<R>(r: R): R
  {
    r
  }

  function MapIdentity<R>(r: R): R
  {
    r
  }

  function O<R>(alternatives: seq<B<R>>): B<R>
  {
    if |alternatives| == 0 then
      FailWith("no alternative")
    else if |alternatives| == 1 then
      alternatives[0]
    else
      B(P.Or(alternatives[0].apply, O(alternatives[1..]).apply))
  }

  function Or<R>(alternatives: seq<B<R>>): B<R>
  {
    O(alternatives)
  }

  const EOS: B<()> := B(P.EndOfString())
  const EndOfString: B<()> := EOS

  function CharTest(test: C -> bool, name: string): B<C>
  {
    B(P.CharTest(test, name))
  }

  opaque function Rec<R(!new)>(underlying: B<R> -> B<R>): B<R>
  {
    B(P.Recursive((p: P.Parser<R>) => underlying(B(p)).apply))
  }

  opaque function Recursive<R(!new)>(underlying: B<R> -> B<R>): B<R>
  {
    Rec(underlying)
  }

  function InputLength(input: Input): nat
  {
    P.A.Length(input)
  }

  predicate NonProgressing(input1: Input, input2: Input)
  {
    InputLength(input1) <= InputLength(input2)
  }

  function RecursiveProgressError<R>(name: string, input1: Input, input2: Input): P.ParseResult<R>
    requires NonProgressing(input1, input2)
  {
    P.RecursiveProgressError(name, input1, input2)
  }

  opaque function RecNoStack<R(!new)>(underlying: B<RecNoStackResult<R>>): B<R>
  {
    B((input: Input) => RecNoStack_(underlying, underlying, input, input, []))
  }

  function RecursiveNoStack<R(!new)>(underlying: B<RecNoStackResult<R>>): B<R>
  {
    RecNoStack(underlying)
  }

  function RecNoStack_<R>(continuation: B<RecNoStackResult<R>>, underlying: B<RecNoStackResult<R>>, input: P.Input, previousInput: P.Input, callbacks: seq<ParseResult<R> -> RecCallback<R>>): (result: ParseResult<R>)
    decreases P.A.Length(input), P.A.Length(previousInput), |callbacks|
  {
    var continuationResult := continuation.apply(input);
    var remaining := continuationResult.Remaining();
    if continuationResult.IsFailure() || continuationResult.Extract().0.RecReturn? then
      var parseResult := if continuationResult.IsFailure() then continuationResult.PropagateFailure() else P.ParseSuccess(continuationResult.Extract().0.toReturn, remaining);
      if |callbacks| == 0 then
        parseResult
      else
        var toCompute := callbacks[0](parseResult); if P.A.Length(input) < P.A.Length(remaining) then RecursiveProgressError<R>("Parsers.RecNoStack[internal]", input, remaining) else if P.A.Length(previousInput) < P.A.Length(input) then RecursiveProgressError<R>("Parsers.RecNoStack[internal]", previousInput, input) else RecNoStack_<R>(toCompute, underlying, remaining, input, callbacks[1..])
    else
      var recursor := continuationResult.Extract().0; assert recursor.RecContinue?; var rToNewParserOfRecursiveNoStackResultOfR := recursor.toContinue; if P.A.Length(remaining) < P.A.Length(input) then RecNoStack_<R>(underlying, underlying, remaining, remaining, [(p: ParseResult<R>) => if p.IsFailure() then B(P.ResultWith(p.PropagateFailure())) else var (r, remaining2) := p.Extract(); rToNewParserOfRecursiveNoStackResultOfR(r, remaining2)] + callbacks) else if P.A.Length(remaining) == P.A.Length(input) && P.A.Length(remaining) < P.A.Length(previousInput) then RecNoStack_<R>(underlying, underlying, remaining, remaining, [(p: ParseResult<R>) => if p.IsFailure() then B(P.ResultWith(p.PropagateFailure())) else var (r, remaining2) := p.Extract(); rToNewParserOfRecursiveNoStackResultOfR(r, remaining2)] + callbacks) else RecursiveProgressError<R>("ParserBuilders.RecNoStack", input, remaining)
  }

  opaque function RecMap<R(!new)>(underlying: map<string, RecMapDef<R>>, startFun: string): (p: B<R>)
  {
    B(P.RecursiveMap(map k | k in underlying :: k := P.RecursiveDef(underlying[k].order, (selector: P.ParserSelector<R>) => underlying[k].definition((name: string) => B(selector(name))).apply), startFun))
  }

  opaque function RecursiveMap<R(!new)>(underlying: map<string, RecMapDef<R>>, startFun: string): (p: B<R>)
  {
    RecMap(underlying, startFun)
  }

  import P : Core

  export
    provides P, O, SucceedWith, FailWith, ResultWith, Rec, MId, B.Apply, B.e_I, B.I_e, B.I_I, B.M, B.M2, B.M3, B.If, B.?, B.??, B.Then, B.ThenWithRemaining, B.Bind, B.Rep, B.RepFold, B.RepSep, B.RepMerge, B.RepSepMerge, B.Rep1, B.Debug, B.End, EOS, Nothing, CharTest, ToInput, RecNoStack, RecursiveProgressError, MapIdentity, B.Option, B.FailureResetsInput, B.ConcatKeepRight, B.ConcatKeepLeft, B.Concat, B.Map, B.Map2, B.Map3, EndOfString, Or, B.Repeat, B.RepeatFold, B.RepeatSeparator, B.RepeatMerge, B.RepeatSeparatorMerge, B.RepeatAtLeastOnce, Recursive, RecursiveNoStack, RecursiveMap
    reveals NonProgressing, Input, InputLength, C, ParseResult, B, Rec, RecMap, RecMapDef, FailureLevel, RecMapSel, RecNoStackResult


  type Input = P.Input

  type C = P.C

  type FailureLevel = P.FailureLevel

  type RecMapSel<A> = string -> B<A>

  type ParseResult<+T> = P.ParseResult<T>

  datatype B<R> = B(apply: P.Parser<R>) {
    function Apply(input: seq<C>): ParseResult<R>
    {
      apply(ToInput(input))
    }

    function ?(): B<P.Option<R>>
    {
      B(P.Maybe(apply))
    }

    function Option(): B<P.Option<R>>
    {
      B(P.Maybe(apply))
    }

    function ??(): B<R>
    {
      B(P.?(apply))
    }

    function FailureResetsInput(): B<R>
    {
      B(P.?(apply))
    }

    function e_I<U>(other: B<U>): (p: B<U>)
    {
      B(P.ConcatKeepRight(apply, other.apply))
    }

    function ConcatKeepRight<U>(other: B<U>): (p: B<U>)
    {
      e_I(other)
    }

    function I_e<U>(other: B<U>): (p: B<R>)
    {
      B(P.ConcatKeepLeft(apply, other.apply))
    }

    function ConcatKeepLeft<U>(other: B<U>): (p: B<R>)
    {
      I_e(other)
    }

    function I_I<U>(other: B<U>): (p: B<(R, U)>)
    {
      B(P.Concat(apply, other.apply))
    }

    function Concat<U>(other: B<U>): (p: B<(R, U)>)
    {
      I_I(other)
    }

    function If<U>(cond: B<U>): (p: B<R>)
    {
      B(P.If(cond.apply, apply))
    }

    function M<U>(mappingFunc: R -> U): (p: B<U>)
    {
      B(P.Map(apply, mappingFunc))
    }

    function Map<U>(mappingFunc: R -> U): (p: B<U>)
    {
      M(mappingFunc)
    }

    function M2<R1, R2, U>(unfolder: R -> (R1, R2), mappingFunc: (R1, R2) -> U): (p: B<U>)
    {
      B(P.Map(apply, (x: R) => var x := unfolder(x); mappingFunc(x.0, x.1)))
    }

    function Map2<R1, R2, U>(unfolder: R -> (R1, R2), mappingFunc: (R1, R2) -> U): (p: B<U>)
    {
      M2(unfolder, mappingFunc)
    }

    function M3<R1, R2, R3, U>(unfolder: R -> (R1, R2, R3), mappingFunc: (R1, R2, R3) -> U): (p: B<U>)
    {
      B(P.Map(apply, (x: R) => var x := unfolder(x); mappingFunc(x.0, x.1, x.2)))
    }

    function Map3<R1, R2, R3, U>(unfolder: R -> (R1, R2, R3), mappingFunc: (R1, R2, R3) -> U): (p: B<U>)
    {
      M3(unfolder, mappingFunc)
    }

    function Then<V>(other: R -> B<V>): (p: B<V>)
    {
      B(P.Bind(apply, (result: R) => other(result).apply))
    }

    function ThenWithRemaining<V>(other: (R, Input) -> B<V>): (p: B<V>)
    {
      B(P.BindSucceeds(apply, (result: R, input: Input) => other(result, input).apply))
    }

    function Bind<V>(other: (ParseResult<R>, Input) -> B<V>): (p: B<V>)
    {
      B(P.BindResult(apply, (result: ParseResult<R>, input: Input) => other(result, input).apply))
    }

    function Debug<D>(name: string, onEnter: (string, Input) -> D, onExit: (string, D, ParseResult<R>) -> ()): B<R>
    {
      B(P.Debug(apply, name, onEnter, onExit))
    }

    function RepFold<A>(init: A, combine: (A, R) -> A): (p: B<A>)
    {
      B(P.Rep(apply, combine, init))
    }

    function RepeatFold<A>(init: A, combine: (A, R) -> A): (p: B<A>)
    {
      RepFold(init, combine)
    }

    function RepSep<K>(separator: B<K>): (p: B<seq<R>>)
    {
      B(P.RepSep(apply, separator.apply))
    }

    function RepeatSeparator<K>(separator: B<K>): (p: B<seq<R>>)
    {
      RepSep(separator)
    }

    function RepMerge(merger: (R, R) -> R): (p: B<R>)
    {
      B(P.RepMerge(apply, merger))
    }

    function RepeatMerge(merger: (R, R) -> R): (p: B<R>)
    {
      RepMerge(merger)
    }

    function RepSepMerge<K>(separator: B<K>, merger: (R, R) -> R): (p: B<R>)
    {
      B(P.RepSepMerge(apply, separator.apply, merger))
    }

    function RepeatSeparatorMerge<K>(separator: B<K>, merger: (R, R) -> R): (p: B<R>)
    {
      RepSepMerge(separator, merger)
    }

    function Rep(): (p: B<seq<R>>)
    {
      B(P.ZeroOrMore(apply))
    }

    function Repeat(): (p: B<seq<R>>)
    {
      Rep()
    }

    function Rep1(): (p: B<seq<R>>)
    {
      B(P.OneOrMore(apply))
    }

    function RepeatAtLeastOnce(): (p: B<seq<R>>)
    {
      Rep1()
    }

    function End(): (p: B<R>)
    {
      this.I_e(EOS)
    }
  }

  datatype RecNoStackResult<!R> = RecReturn(toReturn: R) | RecContinue(toContinue: (R, Input) -> B<RecNoStackResult<R>>)

  type RecCallback<!R> = B<RecNoStackResult<R>>

  datatype RecMapDef<!R> = RecMapDef(order: nat, definition: RecMapSel<R> -> B<R>)
}

abstract module Std.Parsers.Theorems refines Core {
  ghost predicate Trigger<T>(i: T)
  {
    true
  }

  opaque ghost predicate NeverFatal<R>(underlying: Parser<R>)
  {
    forall input: Input | Trigger(input) :: 
      (underlying(input).ParseFailure? ==>
        underlying(input).level == Recoverable) &&
      IsRemaining(input, underlying(input).Remaining())
  }

  lemma AboutSucceedWith<R>(result: R, input: Input)
    ensures var p := SucceedWith(result); p(input).ParseSuccess? && p(input).remaining == input
  {
    reveal SucceedWith();
  }

  lemma AboutFail<R>(message: string, level: FailureLevel, input: Input)
    ensures var p := FailWith<R>(message, level)(input); p.ParseFailure? && p.data == FailureData(message, input, Option.None) && p.level == level
  {
    reveal FailWith();
  }

  lemma AboutFail_2<R>(message: string, input: Input)
    ensures var p := FailWith<R>(message)(input); p.ParseFailure? && p.level == Recoverable && p.data == FailureData(message, input, Option.None)
  {
    reveal FailWith();
  }

  lemma AboutBind_<L, R>(left: Parser<L>, right: (L, Input) -> Parser<R>, input: Input)
    ensures var p := BindSucceeds(left, right)(input); true && var leftResult := left(input); true && !leftResult.IsFailure() ==> var leftValues := left(input).Extract(); true && var rightResult := right(leftValues.0, leftValues.1)(leftValues.1); true && !rightResult.IsFailure() ==> !p.IsFailure() && p.remaining == rightResult.remaining && p.result == rightResult.result
  {
    reveal BindSucceeds();
  }

  lemma AboutMap_<R, U>(underlying: Parser<R>, mappingFunc: R -> U, input: Input)
    ensures var p := Map(underlying, mappingFunc); (underlying(input).ParseSuccess? <==> p(input).ParseSuccess?) && (p(input).ParseSuccess? ==> p(input).remaining == underlying(input).remaining && p(input).result == mappingFunc(underlying(input).result))
  {
    reveal Map();
    reveal BindSucceeds();
    reveal SucceedWith();
  }

  function BindMapCallback<R, U>(mappingFunc: R -> U): (R, Input) -> Parser<U>
  {
    (result: R, remaining: Input) => SucceedWith(mappingFunc(result))
  }

  lemma AboutMap_Bind_<R, U>(underlying: Parser<R>, mappingFunc: R -> U, input: Input)
    ensures Map(underlying, mappingFunc)(input) == BindSucceeds<R, U>(underlying, BindMapCallback(mappingFunc))(input)
  {
    reveal Map();
    reveal BindSucceeds();
    reveal SucceedWith();
  }

  lemma AboutConcat<L, R>(left: Parser<L>, right: Parser<R>, input: Input)
    ensures var p := Concat(left, right); true && (p(input).ParseSuccess? ==> left(input).ParseSuccess? && p(input).result.0 == left(input).result && var input2 := left(input).remaining; right(input2).ParseSuccess? && p(input).result.1 == right(input2).result && p(input).remaining == right(input2).remaining)
  {
    reveal Concat();
    reveal ConcatMap();
  }

  function BindConcatCallback<L, R>(right: Parser<R>): (L, Input) -> Parser<(L, R)>
  {
    (l: L, remaining: Input) => Map(right, (r: R) => (l, r))
  }

  lemma AboutConcatBindSucceeds<L, R>(left: Parser<L>, right: Parser<R>, input: Input)
    ensures Concat(left, right)(input) == BindSucceeds(left, BindConcatCallback(right))(input)
  {
    reveal Concat();
    reveal BindSucceeds();
    reveal SucceedWith();
    reveal Map();
    reveal ConcatMap();
  }

  lemma AboutConcatKeepRight<L, R>(left: Parser<L>, right: Parser<R>, input: Input)
    ensures var p := ConcatKeepRight(left, right); true && (p(input).ParseSuccess? ==> left(input).ParseSuccess? && var input2 := left(input).remaining; right(input2).ParseSuccess? && p(input).result == right(input2).result && p(input).remaining == right(input2).remaining)
  {
    reveal ConcatKeepRight();
    reveal ConcatMap();
  }

  lemma AboutConcatConcatKeepRight<L, R>(left: Parser<L>, right: Parser<R>, input: Input)
    ensures Map(Concat(left, right), T2_1())(input) == ConcatKeepRight(left, right)(input)
  {
    reveal Concat();
    reveal SucceedWith();
    reveal ConcatKeepRight();
    reveal Map();
    reveal ConcatMap();
  }

  lemma AboutConcatKeepLeft<L, R>(left: Parser<L>, right: Parser<R>, input: Input)
    ensures var p := ConcatKeepLeft(left, right); true && (p(input).ParseSuccess? ==> left(input).ParseSuccess? && var input2 := left(input).remaining; right(input2).ParseSuccess? && p(input).result == left(input).result && p(input).remaining == right(input2).remaining)
  {
    reveal ConcatKeepLeft();
    reveal ConcatMap();
  }

  lemma AboutConcatConcatKeepLeft<L, R>(left: Parser<L>, right: Parser<R>, input: Input)
    ensures Map(Concat(left, right), T2_0())(input) == ConcatKeepLeft(left, right)(input)
  {
    reveal Concat();
    reveal SucceedWith();
    reveal ConcatKeepLeft();
    reveal Map();
    reveal ConcatMap();
  }

  predicate AboutRepIncreasesPosIfUnderlyingSucceedsAtLeastOnce_Ensures<R>(underlying: Parser<R>, acc: seq<R>, input: Input)
  {
    var result := ZeroOrMore(underlying)(input);
    result.ParseSuccess? &&
    |acc| <= |result.result| &&
    (underlying(input).ParseSuccess? &&
    A.Length(underlying(input).remaining) < A.Length(input) ==>
      |acc| < |result.result| &&
      A.Length(result.remaining) < A.Length(input))
  }

  predicate AboutFix_Ensures<R(!new)>(underlying: Parser<R> -> Parser<R>, input: Input)
  {
    var p := Recursive_(underlying, input);
    p.ParseSuccess? ==>
      IsRemaining(input, p.remaining)
  }

  opaque function CallUnderlyingCallbackInput<R(!new)>(underlying: Parser<R> -> Parser<R>, callback: Parser<R>, input: Input): ParseResult<R>
  {
    underlying(callback)(input)
  }

  opaque predicate IsRemainingFix<R(!new)>(underlying: Parser<R> -> Parser<R>, callback: Parser<R>, input: Input)
  {
    IsRemaining(input, CallUnderlyingCallbackInput(underlying, callback, input).Remaining())
  }

  @IsolateAssertions lemma AboutFix<R(!new)>(underlying: Parser<R> -> Parser<R>, input: Input)
    requires forall callback: Parser<R>, u: Input | CallUnderlyingCallbackInput(underlying, callback, u).ParseSuccess? :: IsRemainingFix(underlying, callback, input)
    ensures AboutFix_Ensures(underlying, input)
  {
    reveal Recursive_();
    hide IsRemaining();
    var p := Recursive_(underlying, input);
    if p.ParseSuccess? {
      var callback: Parser<R> := (remaining: Input) => if A.Length(remaining) < A.Length(input) then Recursive_(underlying, remaining) else RecursiveProgressError<R>("Parsers.Recursive", input, remaining);
      assert p == underlying(callback)(input);
      assert forall c: Parser<R>, u: Input | CallUnderlyingCallbackInput(underlying, c, u).ParseSuccess? :: IsRemainingFix(underlying, c, input);
      InstantiateForallManually(underlying, callback, input);
      assert CallUnderlyingCallbackInput(underlying, callback, input).ParseSuccess? by {
        reveal CallUnderlyingCallbackInput();
      }
      assert IsRemainingFix(underlying, callback, input);
      assert IsRemaining(input, underlying(callback)(input).Remaining()) by {
        reveal IsRemainingFix();
        reveal CallUnderlyingCallbackInput();
      }
      assert IsRemaining(input, p.remaining);
    }
  }

  lemma InstantiateForallManually<R(!new)>(underlying: Parser<R> -> Parser<R>, callback: Parser<R>, input: Input)
    requires forall c: Parser<R>, u: Input | CallUnderlyingCallbackInput(underlying, c, u).ParseSuccess? :: IsRemainingFix(underlying, c, input)
    ensures CallUnderlyingCallbackInput(underlying, callback, input).ParseSuccess? ==> IsRemainingFix(underlying, callback, input)
  {
  }

  predicate AboutRecursiveMap_Ensures<R(!new)>(underlying: map<string, RecursiveDef<R>>, fun: string, input: Input)
  {
    var p := RecursiveMap_(underlying, fun, input);
    true &&
    (p.ParseSuccess? ==>
      IsRemaining(input, p.remaining))
  }

  lemma SucceedWithValid<R>(result: R)
    ensures NeverFatal(SucceedWith(result))
  {
    reveal NeverFatal(), SucceedWith();
  }

  lemma SucceedWithValidAuto<R>()
    ensures forall result: R :: NeverFatal(SucceedWith(result))
  {
    reveal NeverFatal(), SucceedWith();
  }

  lemma EpsilonValid()
    ensures NeverFatal(Epsilon())
  {
    reveal NeverFatal(), Epsilon();
    SucceedWithValid(());
  }

  lemma AboutEpsilon(input: Input)
    ensures var p := Epsilon(); p(input).ParseSuccess? && p(input).remaining == input
  {
    reveal Epsilon();
    reveal SucceedWith();
  }

  lemma FailValid<R>(message: string)
    ensures NeverFatal<R>(FailWith(message, Recoverable))
  {
    reveal FailWith();
    reveal NeverFatal();
  }

  lemma FailValidAuto<R>()
    ensures forall message :: NeverFatal<R>(FailWith(message, Recoverable))
  {
    reveal FailWith();
    reveal NeverFatal();
  }

  ghost predicate BindRightValid<L(!new), R>(right: (L, Input) -> Parser<R>)
  {
    forall l: L, input: Input :: 
      NeverFatal(right(l, input))
  }

  @IsolateAssertions @ResourceLimit("5e5") lemma BindSucceedsValid<L(!new), R>(left: Parser<L>, right: (L, Input) -> Parser<R>)
    requires NeverFatal(left)
    requires BindRightValid(right)
    ensures NeverFatal(BindSucceeds(left, right))
  {
    reveal BindSucceeds(), NeverFatal();
    var p := BindSucceeds(left, right);
    forall input: Input | Trigger(input)
      ensures (p(input).ParseFailure? ==> p(input).level == Recoverable) && IsRemaining(input, p(input).Remaining())
    {
      var pResult := left(input);
      if pResult.ParseSuccess? {
        var (leftResult, remaining) := pResult.Extract();
        var _ /* _v0 */ := Trigger(remaining);
        var r := right(leftResult, remaining);
        assert NeverFatal(r);
        assert IsRemaining(input, remaining);
        assert IsRemaining(remaining, r(remaining).Remaining());
        assert p(input).Remaining() == r(remaining).Remaining();
        IsRemainingTransitive(input, remaining, p(input).Remaining());
        assert IsRemaining(input, p(input).Remaining());
      } else {
        assert IsRemaining(input, p(input).Remaining());
      }
      assert IsRemaining(input, p(input).Remaining());
    }
    assert NeverFatal(p);
  }

  ghost predicate BindValidRight<L(!new), R(!new)>(left: Parser<L>)
    requires NeverFatal(left)
  {
    forall right: (L, Input) -> Parser<R> | BindRightValid(right) :: 
      NeverFatal(BindSucceeds(left, right))
  }

  lemma BindValidAuto<L(!new), R(!new)>()
    ensures forall left: Parser<L> | NeverFatal(left) :: BindValidRight<L, R>(left)
  {
    forall left: Parser<L>, right: (L, Input) -> Parser<R> | NeverFatal(left) && BindRightValid(right)
      ensures NeverFatal(BindSucceeds(left, right))
    {
      BindSucceedsValid(left, right);
    }
  }

  import opened Tuple = Collections.Tuple
}

module Std.Parsers.StringBuilders refines Builders {
  function ToInput(other: seq<C>): (i: Input)
    ensures P.A.View(i) == other
  {
    P.A.Seq.Slice(other, 0, |other|)
  }

  function ToInputEnd(other: seq<C>, fromEnd: int := 0): (i: Input)
    requires 0 <= fromEnd <= |other|
    ensures P.A.View(i) == other[|other| - fromEnd .. |other|]
  {
    P.A.Seq.Slice(other, |other| - fromEnd, |other|)
  }

  function S(s: string): B<string>
  {
    B(P.String(s))
  }

  function String(s: string): B<string>
  {
    S(s)
  }

  const Int: B<int> := B(P.Int())
  const Nat: B<nat> := B(P.Nat())
  const Digit: B<char> := B(P.Digit())
  const DigitNumber: B<nat> := B(P.DigitNumber())
  const WS: B<string> := B(P.WS())
  const Whitespace: B<string> := WS

  function Except(s: string): B<string>
  {
    CharTest((c: char) => c !in s, "Not '" + s + "'").Rep()
  }

  function DebugSummaryInput(name: string, input: string): string
  {
    P.DebugSummaryInput(name, input)
  }

  method {:print} PrintDebugSummaryOutput<R>(name: string, input: string, result: ParseResult<R>)
  {
    P.PrintDebugSummaryOutput(name, input, result);
  }

  function FailureToString<R>(input: string, result: ParseResult<R>): (s: string)
    requires result.IsFailure()
  {
    P.FailureToString(input, result)
  }

  function Apply<T>(parser: B<T>, input: string): ParseResult<T>
  {
    P.Apply(parser.apply, input)
  }

  function InputToString(input: Input): string
  {
    P.A.View(input)
  }

  import P = StringParsers

  export extends Builders
    provides ToInput, ToInputEnd, S, Int, Nat, WS, Except, Digit, DigitNumber, DebugSummaryInput, PrintDebugSummaryOutput, FailureToString, Apply, InputToString, String, Whitespace

}

module Std.Parsers.InputString refines AbstractInput {
  function ToInput(r: seq<C>): (i: Input)
    ensures View(i) == r
  {
    Seq.Slice(r, 0, |r|)
  }

  function View(self: Input): (r: seq<C>)
    ensures |View(self)| == Length(self)
  {
    self.View()
  }

  function Length(self: Input): nat
  {
    self.Length()
  }

  function CharAt(self: Input, i: int): C
    ensures CharAt(self, i) == View(self)[i]
  {
    self.At(i)
  }

  function Drop(self: Input, start: int): Input
    ensures View(self)[start..] == View(Drop(self, start))
  {
    self.Drop(start)
  }

  function Slice(self: Input, start: int, end: int): Input
    ensures View(Slice(self, start, end)) == View(self)[start .. end]
  {
    self.Sub(start, end)
  }

  lemma AboutDrop(self: Input, a: int, b: int)
    ensures Drop(self, a + b) == Drop(Drop(self, a), b)
  {
  }

  predicate Equals(self: Input, other: Input)
    ensures Equals(self, other) ==> View(self) == View(other)
  {
    self == other
  }

  import Seq = Collections.Seq

  type Input = x: Seq.Slice<char>
    | x.Valid()
    witness *

  type C = char
}

module Std.Parsers.StringParsers refines Core {
  opaque function Char(expectedChar: char): (p: Parser<char>)
  {
    CharTest((c: char) => c == expectedChar, [expectedChar])
  }

  opaque function Space(): (p: Parser<char>)
  {
    CharTest(c => c in " \t\r\n               　", "space")
  }

  opaque function WS(): (p: Parser<string>)
  {
    ZeroOrMore(Space())
  }

  opaque function Digit(): (p: Parser<char>)
  {
    CharTest(c => c in "0123456789", "digit")
  }

  opaque function DigitNumber(): (p: Parser<nat>)
  {
    Map(Digit(), (c: char) => var d := DigitToInt(c); var n: nat := if d >= 0 then d else 0; n)
  }

  opaque function Nat(): (p: Parser<nat>)
  {
    Bind(DigitNumber(), (result: nat) => Rep(DigitNumber(), (previous: nat, c: nat) => var r: nat := previous * 10 + c; r, result))
  }

  opaque function Int(): (p: Parser<int>)
  {
    Bind(Maybe(Char('-')), (minusSign: Option<char>) => Map<nat, int>(Nat(), (result: nat) => if minusSign.Some? then 0 - result else result))
  }

  opaque function String(expected: string): (p: Parser<string>)
  {
    (input: Input) => if |expected| <= A.Length(input) && A.Slice(input, 0, |expected|).View() == expected then ParseSuccess(expected, A.Drop(input, |expected|)) else ParseFailure(Recoverable, FailureData("expected '" + expected + "'", input, Option.None))
  }

  opaque ghost function ExtractLineColSpecAux(vars: ExtractLineMutableState): (res: ExtractLineMutableState)
    requires 0 <= vars.startLinePos <= vars.i <= |vars.input|
    ensures 0 <= res.startLinePos <= res.i <= |res.input|
    ensures !(res.i < |res.input| && res.i != res.pos)
    decreases |vars.input| - vars.i
  {
    if vars.i < |vars.input| && vars.i != vars.pos then
      var colNumber := vars.colNumber + 1;
      if vars.input[vars.i] == '\r' && vars.i + 1 < |vars.input| && vars.input[vars.i + 1] == '\n' then
        ExtractLineColSpecAux(ExtractLineMutableState(vars.input, vars.pos, vars.i + 2, vars.i + 2, vars.lineNumber + 1, 0))
      else if vars.input[vars.i] in "\r\n" then
        var lineNumber := vars.lineNumber + 1;
        var colNumber := 0;
        var startLinePos := vars.i + 1;
        ExtractLineColSpecAux(ExtractLineMutableState(vars.input, vars.pos, startLinePos, vars.i + 1, lineNumber, colNumber))
      else
        ExtractLineColSpecAux(ExtractLineMutableState(vars.input, vars.pos, vars.startLinePos, vars.i + 1, vars.lineNumber, colNumber))
    else
      vars
  }

  opaque ghost function ExtractLineColSpecAux2(vars: ExtractLineMutableState): (res: ExtractLineMutableState)
    requires 0 <= vars.startLinePos <= vars.i <= |vars.input|
    ensures 0 <= res.startLinePos <= res.i <= |res.input|
    ensures !(res.i < |res.input| && res.input[res.i] !in "\r\n")
    decreases |vars.input| - vars.i
  {
    if vars.i < |vars.input| && vars.input[vars.i] !in "\r\n" then
      ExtractLineColSpecAux2(vars.(i := vars.i + 1))
    else
      vars
  }

  opaque ghost function ToCodeLocation(vars: ExtractLineMutableState): CodeLocation
    requires 0 <= vars.startLinePos <= vars.i <= |vars.input|
  {
    CodeLocation(vars.lineNumber, vars.colNumber, vars.input[vars.startLinePos .. vars.i])
  }

  @IsolateAssertions opaque function ExtractLineCol(input: string, pos: nat): (output: CodeLocation)
  {
    var vars := ExtractLineColSpecAux(ExtractLineMutableState(input, pos, 0, 0, 1, 0));
    var vars := ExtractLineColSpecAux2(vars);
    ToCodeLocation(vars)
  } by method {
    var lineNumber, colNumber, lineStr;
    lineNumber := 1;
    var startLinePos: nat := 0;
    colNumber := 0;
    var i := 0;
    ghost var initMutableState := ExtractLineMutableState(input, pos, startLinePos, i, lineNumber, colNumber);
    assert ExtractLineCol(input, pos) == ToCodeLocation(ExtractLineColSpecAux2(ExtractLineColSpecAux(initMutableState))) by {
      reveal ExtractLineCol();
    }
    assert !(i < |input| && i != pos) ==> ExtractLineColSpecAux(ExtractLineMutableState(input, pos, startLinePos, i, lineNumber, colNumber)) == ExtractLineMutableState(input, pos, startLinePos, i, lineNumber, colNumber) by {
      reveal ExtractLineColSpecAux();
    }
    while i < |input| && i != pos
      invariant 0 <= startLinePos <= i <= |input|
      invariant ExtractLineColSpecAux(ExtractLineMutableState(input, pos, startLinePos, i, lineNumber, colNumber)) == ExtractLineColSpecAux(initMutableState)
      invariant !(i < |input| && i != pos) ==> ExtractLineColSpecAux(ExtractLineMutableState(input, pos, startLinePos, i, lineNumber, colNumber)) == ExtractLineMutableState(input, pos, startLinePos, i, lineNumber, colNumber)
    {
      reveal ExtractLineColSpecAux();
      colNumber := colNumber + 1;
      if input[i] == '\r' && i + 1 < |input| && input[i + 1] == '\n' {
        lineNumber := lineNumber + 1;
        colNumber := 0;
        i := i + 1;
        startLinePos := i + 1;
      } else if input[i] in "\r\n" {
        lineNumber := lineNumber + 1;
        colNumber := 0;
        startLinePos := i + 1;
      }
      i := i + 1;
    }
    ghost var tmpMutableState := ExtractLineMutableState(input, pos, startLinePos, i, lineNumber, colNumber);
    assert ExtractLineCol(input, pos) == ToCodeLocation(ExtractLineColSpecAux2(tmpMutableState)) by {
      reveal ExtractLineCol();
    }
    assert !(i < |input| && input[i] !in "\r\n") ==> ExtractLineColSpecAux2(ExtractLineMutableState(input, pos, startLinePos, i, lineNumber, colNumber)) == ExtractLineMutableState(input, pos, startLinePos, i, lineNumber, colNumber) by {
      reveal ExtractLineColSpecAux2();
    }
    while i < |input| && input[i] !in "\r\n"
      invariant 0 <= startLinePos <= i <= |input|
      invariant ExtractLineColSpecAux2(tmpMutableState) == ExtractLineColSpecAux2(ExtractLineMutableState(input, pos, startLinePos, i, lineNumber, colNumber))
      invariant !(i < |input| && input[i] !in "\r\n") ==> ExtractLineColSpecAux2(ExtractLineMutableState(input, pos, startLinePos, i, lineNumber, colNumber)) == ExtractLineMutableState(input, pos, startLinePos, i, lineNumber, colNumber)
    {
      reveal ExtractLineColSpecAux2();
      i := i + 1;
    }
    reveal ExtractLineCol();
    assert ExtractLineCol(input, pos) == ToCodeLocation(ExtractLineMutableState(input, pos, startLinePos, i, lineNumber, colNumber));
    lineStr := input[startLinePos .. i];
    output := CodeLocation(lineNumber, colNumber, lineStr);
    reveal ToCodeLocation();
    assert ExtractLineCol(input, pos) == output;
  }

  function DebugSummary(input: string): string
  {
    (if |input| > 0 then "'" + match input[0] { case '\n' => "\\n" case '\r' => "\\r" case '\t' => "\\t" case c => [c] } + if |input| == 1 then "' and end of string" else "'" + " and " + Strings.OfInt(|input| - 1) + " char" + (if |input| == 2 then "" else "s") + " remaining" else "'' (end of string)") + "\n"
  }

  function DebugNameSummary(name: string, input: string): string
  {
    "[" + name + "] " + DebugSummary(input)
  }

  function DebugSummaryInput(name: string, input: string): string
  {
    "> " + DebugNameSummary(name, input)
  }

  @Print method PrintDebugSummaryInput(name: string, input: string)
  {
    print DebugSummaryInput(name, input);
  }

  function NewIndent(input: string, indent: string): string
  {
    if |input| == 0 then
      ""
    else
      (if input[0] == '\n' then input[..1] + indent else input[..1]) + NewIndent(input[1..], indent)
  }

  @Print method PrintDebugSummaryOutput<R>(name: string, input: string, result: ParseResult<R>)
  {
    print "< ", DebugNameSummary(name, input);
    if result.ParseFailure? {
      print "| Unparsed: ", DebugSummary(A.View(result.Remaining()));
      if A.Length(result.Remaining()) < |input| {
        print "| Was committed\n";
      }
      print "| " + NewIndent(FailureToString(input, result), "| "), "\n";
    } else {
      print "| Success: ", result.result, ", ", DebugSummary(A.View(result.Remaining())), "\n";
    }
  }

  opaque function FailureToString<R>(input: string, result: ParseResult<R>, printPos: int := -1): (failure: string)
    requires result.ParseFailure?
    decreases result.data
  {
    var failure := "";
    var failure := failure + if printPos == -1 then (if result.level == Fatal then "Fatal error" else "Error") + ":\n" else "";
    var pos: int := |input| - A.Length(result.data.remaining);
    var pos := if pos < 0 then 0 else pos;
    var failure := if printPos == pos then failure else var output := ExtractLineCol(input, pos); var CodeLocation(line, col, lineStr) := output; failure + Strings.OfInt(line) + ": " + lineStr + "\n" + Seq.Repeat(' ', col + 2 + |Strings.OfInt(line)|) + "^" + "\n";
    var failure := failure + result.data.message;
    if result.data.next.Some? then
      var failure := failure + ", or\n";
      var subFailure := FailureToString<R>(input, ParseFailure(result.level, result.data.next.value), pos);
      var failure := failure + subFailure;
      failure
    else
      var failure := failure + "\n"; failure
  }

  function Apply<T>(parser: Parser<T>, input: string): ParseResult<T>
  {
    parser(ToInput(input))
  }

  function ToInput(input: string): Input
  {
    A.Seq.Slice(input, 0, |input|)
  }

  import Seq = Collections.Seq

  export
    reveals *


  export Export extends Core
    provides CodeLocation, Char, Digit, DigitNumber, Nat, Int, String, ExtractLineCol, Wrappers, Space, WS, Apply
    reveals C


  import A = InputString

  datatype CodeLocation = CodeLocation(lineNumber: nat, colNumber: nat, lineStr: string)

  datatype ExtractLineMutableState = ExtractLineMutableState(input: string, pos: nat, startLinePos: nat, i: nat, lineNumber: nat, colNumber: nat)
}

module Std.Relations {
  ghost predicate Reflexive<T(!new)>(relation: (T, T) -> bool)
  {
    forall x :: 
      relation(x, x)
  }

  ghost predicate Irreflexive<T(!new)>(relation: (T, T) -> bool)
  {
    forall x :: 
      !relation(x, x)
  }

  ghost predicate Symmetric<T(!new)>(relation: (T, T) -> bool)
  {
    forall x, y :: 
      relation(x, y) <==> relation(y, x)
  }

  ghost predicate AntiSymmetric<T(!new)>(relation: (T, T) -> bool)
  {
    forall x, y :: 
      relation(x, y) &&
      relation(y, x) ==>
        x == y
  }

  ghost predicate Asymmetric<T(!new)>(relation: (T, T) -> bool)
  {
    forall x, y :: 
      relation(x, y) ==>
        !relation(y, x)
  }

  lemma AsymmetricIsAntiSymmetric<T(!new)>(relation: (T, T) -> bool)
    ensures Asymmetric(relation) ==> AntiSymmetric(relation)
  {
  }

  lemma AsymmetricIsIrreflexive<T(!new)>(relation: (T, T) -> bool)
    ensures Asymmetric(relation) ==> Irreflexive(relation)
  {
  }

  ghost predicate Connected<T(!new)>(relation: (T, T) -> bool)
  {
    forall x, y :: 
      x != y ==>
        relation(x, y) || relation(y, x)
  }

  ghost predicate StronglyConnected<T(!new)>(relation: (T, T) -> bool)
  {
    forall x, y :: 
      relation(x, y) || relation(y, x)
  }

  ghost predicate Transitive<T(!new)>(relation: (T, T) -> bool)
  {
    forall x, y, z :: 
      relation(x, y) &&
      relation(y, z) ==>
        relation(x, z)
  }

  ghost predicate TotalOrdering<T(!new)>(relation: (T, T) -> bool)
  {
    Reflexive(relation) &&
    AntiSymmetric(relation) &&
    Transitive(relation) &&
    StronglyConnected(relation)
  }

  ghost predicate StrictTotalOrdering<T(!new)>(relation: (T, T) -> bool)
  {
    Irreflexive(relation) &&
    AntiSymmetric(relation) &&
    Transitive(relation) &&
    Connected(relation)
  }

  ghost predicate PreOrdering<T(!new)>(relation: (T, T) -> bool)
  {
    Reflexive(relation) &&
    Transitive(relation)
  }

  ghost predicate PartialOrdering<T(!new)>(relation: (T, T) -> bool)
  {
    Reflexive(relation) &&
    Transitive(relation) &&
    AntiSymmetric(relation)
  }

  ghost predicate EquivalenceRelation<T(!new)>(relation: (T, T) -> bool)
  {
    Reflexive(relation) &&
    Symmetric(relation) &&
    Transitive(relation)
  }

  ghost predicate IsLeast<T>(lessOrEqual: (T, T) -> bool, least: T, s: set<T>)
  {
    least in s &&
    forall x | x in s :: 
      lessOrEqual(least, x)
  }

  ghost predicate IsMinimal<T>(lessOrEqual: (T, T) -> bool, minimal: T, s: set<T>)
  {
    minimal in s &&
    forall x | x in s && lessOrEqual(x, minimal) :: 
      lessOrEqual(minimal, x)
  }

  ghost predicate IsGreatest<T>(lessOrEqual: (T, T) -> bool, greatest: T, s: set<T>)
  {
    greatest in s &&
    forall x | x in s :: 
      lessOrEqual(x, greatest)
  }

  ghost predicate IsMaximal<T>(lessOrEqual: (T, T) -> bool, maximal: T, s: set<T>)
  {
    maximal in s &&
    forall x | x in s && lessOrEqual(maximal, x) :: 
      lessOrEqual(x, maximal)
  }

  ghost predicate SortedBy<T>(lessOrEqual: (T, T) -> bool, xs: seq<T>)
  {
    forall i, j | 0 <= i < j < |xs| :: 
      lessOrEqual(xs[i], xs[j])
  }
}

@DisableNonlinearArithmetic
module Std.Strings {
  function OfNat(n: nat): (str: string)
    ensures |str| == Log(DecimalConversion.base, n) + 1
    ensures forall c | c in str :: c in DecimalConversion.chars
  {
    DecimalConversion.OfNat(n)
  }

  function OfInt(n: int): (str: string)
    ensures DecimalConversion.IsNumberStr(str, '-')
  {
    DecimalConversion.OfInt(n, '-')
  }

  function ToNat(str: string): (n: nat)
    requires forall c | c in str :: DecimalConversion.IsDigitChar(c)
    ensures n < Pow(DecimalConversion.base, |str|)
  {
    DecimalConversion.ToNatBound(str);
    DecimalConversion.ToNat(str)
  }

  function ToInt(str: string): (n: int)
    requires str != "-"
    requires DecimalConversion.IsNumberStr(str, '-')
  {
    DecimalConversion.ToInt(str, '-')
  }

  function EscapeQuotes(str: string): string
  {
    CharStrEscaping.Escape(str, {'\"', '\''}, '\\')
  }

  function UnescapeQuotes(str: string): Option<string>
  {
    CharStrEscaping.Unescape(str, '\\')
  }

  function OfBool(b: bool): string
  {
    if b then
      "true"
    else
      "false"
  }

  function OfChar(c: char): string
  {
    [c]
  }

  import opened Wrappers

  import opened Power = Arithmetic.Power

  import opened Logarithm = Arithmetic.Logarithm

  import Arithmetic

  @DisableNonlinearArithmetic
  abstract module ParametricConversion refines Arithmetic.LittleEndianNat {
    const chars: CharSeq
    const base := |chars|
    const charToDigit: map<Char, digit>

    lemma CharsConsistent()
      ensures forall c | c in chars :: c in charToDigit && chars[charToDigit[c]] == c

    function BASE(): nat
    {
      base
    }

    predicate IsDigitChar(c: Char)
    {
      c in charToDigit
    }

    function OfDigits(digits: seq<digit>): (str: String)
      ensures forall c | c in str :: c in chars
      ensures |str| == |digits|
    {
      if digits == [] then
        []
      else
        assert digits[0] in digits; assert forall d | d in digits[1..] :: d in digits; OfDigits(digits[1..]) + [chars[digits[0]]]
    }

    function OfNat(n: nat): (str: String)
      ensures |str| == Log(base, n) + 1
      ensures forall c | c in str :: c in chars
    {
      if n == 0 then
        [chars[0]]
      else
        LemmaFromNatLen2(n); OfDigits(FromNat(n))
    }

    predicate IsNumberStr(str: String, minus: Char)
    {
      str != [] ==>
        (str[0] == minus || str[0] in charToDigit) &&
        forall c | c in str[1..] :: 
          IsDigitChar(c)
    }

    function OfInt(n: int, minus: Char): (str: String)
      ensures IsNumberStr(str, minus)
    {
      CharsConsistent();
      if n >= 0 then
        OfNat(n)
      else
        [minus] + OfNat(-n)
    }

    @IsolateAssertions function ToNat(str: String): (n: nat)
      requires forall c | c in str :: IsDigitChar(c)
    {
      if str == [] then
        0
      else
        LemmaMulNonnegativeAuto(); var c := str[|str| - 1]; assert IsDigitChar(c); ToNat(str[..|str| - 1]) * base + charToDigit[c]
    }

    lemma {:induction false} ToNatBound(str: String)
      requires base > 0
      requires forall c | c in str :: IsDigitChar(c)
      ensures ToNat(str) < Pow(base, |str|)
    {
      if str == [] {
      } else {
        calc <= {
          ToNat(str);
          {
            assert IsDigitChar(str[|str| - 1]);
          }
          ToNat(str[..|str| - 1]) * base + charToDigit[str[|str| - 1]];
          ToNat(str[..|str| - 1]) * base + (base - 1);
          {
            ToNatBound(str[..|str| - 1]);
            LemmaMulInequalityAuto();
          }
          (Pow(base, |str| - 1) - 1) * base + base - 1;
          {
            LemmaMulIsDistributiveAuto();
          }
          Pow(base, |str| - 1) * base - 1;
          {
            LemmaMulIsCommutativeAuto();
          }
          Pow(base, |str|) - 1;
        }
      }
    }

    function ToInt(str: String, minus: Char): (s: int)
      requires str != [minus]
      requires IsNumberStr(str, minus)
    {
      if [minus] <= str then
        -(ToNat(str[1..]) as int)
      else
        assert str == [] || str == [str[0]] + str[1..]; ToNat(str)
    }

    import opened Wrappers

    type Char(==)

    type String = seq<Char>

    type CharSeq = chars: seq<Char>
      | |chars| > 1
      witness *
  }

  abstract module ParametricEscaping {
    function Escape(str: String, mustEscape: set<Char>, escape: Char): String
    {
      if str == [] then
        str
      else if str[0] in mustEscape then
        [escape, str[0]] + Escape(str[1..], mustEscape, escape)
      else
        [str[0]] + Escape(str[1..], mustEscape, escape)
    }

    function Unescape(str: String, escape: Char): Option<String>
    {
      if str == [] then
        Some(str)
      else if str[0] == escape then
        if |str| > 1 then
          var tl :- Unescape(str[2..], escape); Some([str[1]] + tl)
        else
          None
      else
        var tl :- Unescape(str[1..], escape); Some([str[0]] + tl)
    }

    lemma {:induction false} Unescape_Escape(str: String, special: set<Char>, escape: Char)
      requires escape in special
      ensures Unescape(Escape(str, special, escape), escape) == Some(str)
    {
      if str == [] {
      } else {
        assert str == [str[0]] + str[1..];
        Unescape_Escape(str[1..], special, escape);
      }
    }

    import opened Wrappers

    type Char(==)

    type String = seq<Char>
  }

  @DisableNonlinearArithmetic
  module HexConversion refines ParametricConversion {
    const HEX_DIGITS: seq<char> := "0123456789ABCDEF"
    const chars := HEX_DIGITS
    const charToDigit := map['0' := 0, '1' := 1, '2' := 2, '3' := 3, '4' := 4, '5' := 5, '6' := 6, '7' := 7, '8' := 8, '9' := 9, 'a' := 10, 'b' := 11, 'c' := 12, 'd' := 13, 'e' := 14, 'f' := 15, 'A' := 10, 'B' := 11, 'C' := 12, 'D' := 13, 'E' := 14, 'F' := 15]

    @Axiom lemma CharsConsistent()
      ensures forall c | c in chars :: c in charToDigit && chars[charToDigit[c]] == c

    type Char = char
  }

  @DisableNonlinearArithmetic
  module DecimalConversion refines ParametricConversion {
    const DIGITS: seq<char> := "0123456789"
    const chars := DIGITS
    const charToDigit := map['0' := 0, '1' := 1, '2' := 2, '3' := 3, '4' := 4, '5' := 5, '6' := 6, '7' := 7, '8' := 8, '9' := 9]

    lemma CharsConsistent()
      ensures forall c | c in chars :: c in charToDigit && chars[charToDigit[c]] == c
    {
    }

    type Char = char
  }

  module CharStrEscaping refines ParametricEscaping {
    type Char = char
  }
}

module Std.Termination {

  import opened Set = Collections.Set

  import opened Multiset = Collections.Multiset

  import opened Ordinal

  import Seq = Collections.Seq
  datatype TerminationMetric = TMBool(boolValue: bool) | TMNat(natValue: nat) | TMChar(charValue: nat) | TMOrdinal(ordinalValue: ORDINAL) | TMObject(objectValue: object) | TMSeq(seqValue: seq<TerminationMetric>) | TMSet(setValue: set<TerminationMetric>) | TMTuple(base: TerminationMetric, first: TerminationMetric, second: TerminationMetric) | TMTop | TMSucc(original: TerminationMetric) {
    opaque ghost function Ordinal(): ORDINAL
      decreases this
    {
      match this {
        case TMBool(boolValue) =>
          if boolValue then
            1
          else
            0
        case TMNat(natValue) =>
          natValue as ORDINAL
        case TMChar(charValue) =>
          charValue as ORDINAL
        case TMOrdinal(ordinalValue) =>
          ordinalValue
        case TMObject(objectValue) =>
          0
        case TMSet(setValue) =>
          |setValue| as ORDINAL
        case TMSeq(seqValue) =>
          MultisetOrdinal(this, multiset(seqValue))
        case TMTuple(base, first, second) =>
          Times(base.Ordinal(), first.Ordinal()) + second.Ordinal() + 1
        case TMSucc(original) =>
          original.Ordinal() + 1
        case TMTop =>
          Omega()
      }
    }

    ghost predicate DecreasesTo(other: TerminationMetric)
    {
      Ordinal() > other.Ordinal()
    }

    ghost predicate NonIncreasesTo(other: TerminationMetric)
    {
      Ordinal() >= other.Ordinal()
    }

    static opaque ghost function MaxOrdinal(parent: TerminationMetric, s: multiset<TerminationMetric>): ORDINAL
      requires forall o | o in s :: parent decreases to o
      ensures forall o | o in s :: MaxOrdinal(parent, s) >= o.Ordinal()
      decreases parent, |s|, 0
    {
      if s == multiset{} then
        0
      else
        var x := ExtractFromNonEmptyMultiset(s); Max(x.Ordinal(), MaxOrdinal(parent, s - multiset{x}))
    }

    static lemma MaxOrdinalAnyParent(parent: TerminationMetric, parent': TerminationMetric, s: multiset<TerminationMetric>)
      requires forall o | o in s :: (parent decreases to o) && (parent' decreases to o)
      ensures MaxOrdinal(parent, s) == MaxOrdinal(parent', s)
    {
      reveal MaxOrdinal();
    }

    static ghost function MultisetOrdinal(parent: TerminationMetric, s: multiset<TerminationMetric>): ORDINAL
      requires forall o | o in s :: parent decreases to o
      decreases parent, |s|
    {
      MaxOrdinal(parent, s) + |s| as ORDINAL + 1
    }

    static lemma MultisetOrdinalAnyParent(parent: TerminationMetric, parent': TerminationMetric, s: multiset<TerminationMetric>)
      requires forall o | o in s :: (parent decreases to o) && (parent' decreases to o)
      ensures MultisetOrdinal(parent, s) == MultisetOrdinal(parent', s)
    {
      MaxOrdinalAnyParent(parent, parent', s);
    }

    static lemma MultisetOrdinalDecreasesToSubMultiset(parent: TerminationMetric, left: multiset<TerminationMetric>, right: multiset<TerminationMetric>)
      requires forall o | o in left :: parent decreases to o
      requires forall o | o in right :: parent decreases to o
      requires left > right
      ensures MultisetOrdinal(parent, left) > MultisetOrdinal(parent, right)
    {
      var maxLeft := MaxOrdinal(parent, left);
      var maxRight := MaxOrdinal(parent, right);
      MaxOrdinalNonIncreases(parent, left, right);
      assert maxLeft >= maxRight;
      LemmaSubmultisetSize(right, left);
      assert |left| > |right|;
      assert |left| as ORDINAL + 1 > |right| as ORDINAL + 1;
      PlusIncreasingOnLeft(maxRight, maxLeft, |right| as ORDINAL + 1);
      PlusStrictlyIncreasingOnRight(maxLeft, |right| as ORDINAL + 1, |left| as ORDINAL + 1);
    }

    static lemma MaxOrdinalNonIncreases(parent: TerminationMetric, left: multiset<TerminationMetric>, right: multiset<TerminationMetric>)
      requires forall o | o in left :: parent decreases to o
      requires forall o | o in right :: parent decreases to o
      requires left > right
      ensures MaxOrdinal(parent, left) >= MaxOrdinal(parent, right)
    {
      reveal MaxOrdinal();
    }

    static lemma MaxOrdinalDecreasesIfAllDecrease(parent: TerminationMetric, left: multiset<TerminationMetric>, right: multiset<TerminationMetric>)
      requires forall o | o in left :: parent decreases to o
      requires forall o | o in right :: parent decreases to o
      requires left > right
      ensures MaxOrdinal(parent, left) >= MaxOrdinal(parent, right)
    {
      reveal MaxOrdinal();
    }

    lemma SetDecreasesTo(other: TerminationMetric)
      requires TMSet?
      requires other.TMSet?
      requires setValue > other.setValue
      ensures DecreasesTo(other)
    {
      reveal Ordinal();
      LemmaSubsetSize(other.setValue, setValue);
    }

    lemma SeqDecreasesToSubSequence(other: TerminationMetric)
      requires TMSeq?
      requires other.TMSeq?
      requires multiset(seqValue) > multiset(other.seqValue)
      ensures DecreasesTo(other)
    {
      reveal Ordinal();
      MultisetOrdinalAnyParent(this, other, multiset(other.seqValue));
      MultisetOrdinalDecreasesToSubMultiset(this, multiset(seqValue), multiset(other.seqValue));
    }

    lemma SeqDecreasesToProperPrefix(other: TerminationMetric, hi: nat)
      requires TMSeq?
      requires other.TMSeq?
      requires hi < |seqValue|
      requires seqValue[..hi] == other.seqValue
      ensures DecreasesTo(other)
    {
      assert seqValue == seqValue[..hi] + seqValue[hi..];
      SeqDecreasesToSubSequence(other);
    }

    lemma SeqDecreasesToProperSuffix(other: TerminationMetric, lo: nat)
      requires TMSeq?
      requires other.TMSeq?
      requires 0 < lo <= |seqValue|
      requires seqValue[lo..] == other.seqValue
      ensures DecreasesTo(other)
    {
      assert seqValue == seqValue[..lo] + seqValue[lo..];
      SeqDecreasesToSubSequence(other);
    }

    lemma SeqDecreasesToProperDeletion(other: TerminationMetric, lo: nat, hi: nat)
      requires TMSeq?
      requires other.TMSeq?
      requires 0 <= lo < hi <= |seqValue|
      requires seqValue[..lo] + seqValue[hi..] == other.seqValue
      ensures DecreasesTo(other)
    {
      assert seqValue == seqValue[..lo] + seqValue[lo .. hi] + seqValue[hi..];
      SeqDecreasesToSubSequence(other);
    }

    lemma SeqDecreasesToElement(other: TerminationMetric)
      requires TMSeq?
      requires other in seqValue
      ensures DecreasesTo(other)
    {
      reveal Ordinal();
    }

    lemma TupleDecreasesToTuple(other: TerminationMetric)
      requires TMTuple?
      requires other.TMTuple?
      requires base == other.base
      requires other.base.DecreasesTo(other.second) && (first.DecreasesTo(other.first) || (first.NonIncreasesTo(other.first) && second.DecreasesTo(other.second)))
      ensures DecreasesTo(other)
    {
      reveal Ordinal();
      if first.DecreasesTo(other.first) {
        TimesStrictlyIncreasingOnRight(base.Ordinal(), other.first.Ordinal(), first.Ordinal());
        RadixStrictlyIncreasing(base.Ordinal(), other.first.Ordinal(), first.Ordinal(), other.second.Ordinal());
      } else {
        PlusStrictlyIncreasingOnRight(Times(base.Ordinal(), first.Ordinal()), other.second.Ordinal(), second.Ordinal());
      }
      SuccStrictlyIncreasing(Times(base.Ordinal(), other.first.Ordinal()) + other.second.Ordinal(), Times(base.Ordinal(), first.Ordinal()) + second.Ordinal());
    }

    lemma TupleNonIncreasesToTuple(other: TerminationMetric)
      requires TMTuple?
      requires other.TMTuple?
      requires base == other.base
      requires other.base.DecreasesTo(other.second)
      requires first.NonIncreasesTo(other.first)
      requires second.NonIncreasesTo(other.second)
      ensures NonIncreasesTo(other)
    {
      reveal Ordinal();
      if first.DecreasesTo(other.first) || second.DecreasesTo(other.second) {
        TupleDecreasesToTuple(other);
      }
    }

    lemma TupleDecreasesToFirst()
      requires TMTuple?
      requires base.DecreasesTo(second)
      ensures DecreasesTo(first)
    {
      reveal Ordinal();
      var term := Times(base.Ordinal(), first.Ordinal());
      PlusStrictlyIncreasingOnRight(term, 0, second.Ordinal() + 1);
      PlusIsAssociative(term, second.Ordinal(), 1);
      TimesIncreasingOnLeft(1, base.Ordinal(), first.Ordinal());
      TimesLeftIdentity(first.Ordinal());
    }

    lemma TupleDecreasesToSecond()
      requires TMTuple?
      requires base.DecreasesTo(second)
      ensures DecreasesTo(second)
    {
      reveal Ordinal();
      PlusIncreasingOnLeft(0, Times(base.Ordinal(), first.Ordinal()), second.Ordinal());
    }

    lemma SuccDecreasesToSucc(other: TerminationMetric)
      requires TMSucc?
      requires other.TMSucc?
      requires original.DecreasesTo(other.original)
      ensures DecreasesTo(other)
    {
      reveal Ordinal();
      SuccStrictlyIncreasing(other.original.Ordinal(), original.Ordinal());
    }

    lemma SuccNonIncreasesToSucc(other: TerminationMetric)
      requires TMSucc?
      requires other.TMSucc?
      requires original.NonIncreasesTo(other.original)
      ensures NonIncreasesTo(other)
    {
      reveal Ordinal();
      if original.Ordinal() > other.original.Ordinal() {
        SuccStrictlyIncreasing(other.original.Ordinal(), original.Ordinal());
      }
    }

    lemma SuccDecreasesToOriginal()
      requires TMSucc?
      ensures DecreasesTo(original)
    {
      reveal Ordinal();
    }

    lemma NatDecreasesToNat(other: TerminationMetric)
      requires TMNat?
      requires other.TMNat?
      requires natValue > other.natValue
      ensures DecreasesTo(other)
    {
      reveal Ordinal();
    }

    lemma NatNonIncreasesToNat(other: TerminationMetric)
      requires TMNat?
      requires other.TMNat?
      requires natValue >= other.natValue
      ensures NonIncreasesTo(other)
    {
      reveal Ordinal();
    }

    lemma TopDecreasesToNat(other: TerminationMetric)
      requires TMTop?
      requires other.TMNat?
      ensures DecreasesTo(other)
    {
      reveal Ordinal();
    }
  }
}

module Std.Unicode {
}

module Std.Unicode.Base {
  const HIGH_SURROGATE_MIN: CodePoint := 55296
  const HIGH_SURROGATE_MAX: CodePoint := 56319
  const LOW_SURROGATE_MIN: CodePoint := 56320
  const LOW_SURROGATE_MAX: CodePoint := 57343
  const ASSIGNED_PLANES: set<bv8> := {0, 1, 2, 3, 14, 15, 16}

  predicate IsInAssignedPlane(i: CodePoint)
  {
    var plane := (i >> 16) as bv8;
    plane in ASSIGNED_PLANES
  }

  type CodePoint = i: bv24
    | 0 <= i <= 1114111

  type HighSurrogateCodePoint = p: CodePoint
    | HIGH_SURROGATE_MIN <= p <= HIGH_SURROGATE_MAX
    witness HIGH_SURROGATE_MIN

  type LowSurrogateCodePoint = p: CodePoint
    | LOW_SURROGATE_MIN <= p <= LOW_SURROGATE_MAX
    witness LOW_SURROGATE_MIN

  type ScalarValue = p: CodePoint
    | (p < HIGH_SURROGATE_MIN || p > HIGH_SURROGATE_MAX) && (p < LOW_SURROGATE_MIN || p > LOW_SURROGATE_MAX)

  type AssignedCodePoint = p: CodePoint
    | IsInAssignedPlane(p)
    witness *
}

abstract module Std.Unicode.UnicodeEncodingForm {
  function IsMinimalWellFormedCodeUnitSubsequence(s: CodeUnitSeq): (b: bool)
    ensures b ==> |s| > 0 && forall i | 0 < i < |s| :: !IsMinimalWellFormedCodeUnitSubsequence(s[..i])
    decreases |s|

  function SplitPrefixMinimalWellFormedCodeUnitSubsequence(s: CodeUnitSeq): (maybePrefix: Option<MinimalWellFormedCodeUnitSeq>)
    ensures |s| == 0 ==> maybePrefix.None?
    ensures (exists i | 0 < i <= |s| :: IsMinimalWellFormedCodeUnitSubsequence(s[..i])) <==> true && maybePrefix.Some?
    ensures maybePrefix.Some? ==> true && var prefix := maybePrefix.Extract(); 0 < |prefix| <= |s| && prefix == s[..|prefix|] && forall i | 0 < i < |prefix| :: !IsMinimalWellFormedCodeUnitSubsequence(s[..i])

  function EncodeScalarValue(v: ScalarValue): (m: MinimalWellFormedCodeUnitSeq)

  function DecodeMinimalWellFormedCodeUnitSubsequence(m: MinimalWellFormedCodeUnitSeq): (v: ScalarValue)
    ensures EncodeScalarValue(v) == m

  lemma LemmaUniquePrefixMinimalWellFormedCodeUnitSeq(s: CodeUnitSeq, m1: MinimalWellFormedCodeUnitSeq, m2: MinimalWellFormedCodeUnitSeq)
    requires m1 <= s
    requires m2 <= s
    ensures m1 == m2
    decreases |s|, |m1|, |m2|
  {
    if |m1| > |m2| {
      LemmaUniquePrefixMinimalWellFormedCodeUnitSeq(s, m2, m1);
    } else {
      assert m1 <= m2;
      assert m1 == m2 by {
        if m1 < m2 {
          assert false by {
            assert m1 == m2[..|m1|];
          }
        }
      }
    }
  }

  lemma LemmaSplitPrefixMinimalWellFormedCodeUnitSubsequenceInvertsPrepend(m: MinimalWellFormedCodeUnitSeq, s: CodeUnitSeq)
    ensures SplitPrefixMinimalWellFormedCodeUnitSubsequence(m + s) == Some(m)
  {
    var ms := m + s;
    var maybePrefix := SplitPrefixMinimalWellFormedCodeUnitSubsequence(ms);
    assert maybePrefix.Some? by {
      assert IsMinimalWellFormedCodeUnitSubsequence(ms[..|m|]);
    }
    var prefix := maybePrefix.Extract();
    assert m <= ms;
    assert prefix <= ms;
    LemmaUniquePrefixMinimalWellFormedCodeUnitSeq(ms, m, prefix);
  }

  function PartitionCodeUnitSequenceChecked(s: CodeUnitSeq): (maybeParts: Result<seq<MinimalWellFormedCodeUnitSeq>, CodeUnitSeq>)
    ensures maybeParts.Success? ==> Seq.Flatten(maybeParts.Extract()) == s
    decreases |s|
  {
    if s == [] then
      Success([])
    else
      var prefix :- SplitPrefixMinimalWellFormedCodeUnitSubsequence(s).ToResult(s); var restParts :- PartitionCodeUnitSequenceChecked(s[|prefix|..]); Success([prefix] + restParts)
  } by method {
    if s == [] {
      return Success([]);
    }
    var result: seq<MinimalWellFormedCodeUnitSeq> := [];
    var rest := s;
    while |rest| > 0
      invariant PartitionCodeUnitSequenceChecked(s).Success? <==> PartitionCodeUnitSequenceChecked(rest).Success?
      invariant if PartitionCodeUnitSequenceChecked(s).Success? then true && PartitionCodeUnitSequenceChecked(s).value == result + PartitionCodeUnitSequenceChecked(rest).value else PartitionCodeUnitSequenceChecked(s).error == PartitionCodeUnitSequenceChecked(rest).error
    {
      var prefix :- SplitPrefixMinimalWellFormedCodeUnitSubsequence(rest).ToResult(rest);
      result := result + [prefix];
      rest := rest[|prefix|..];
    }
    assert result + [] == result;
    return Success(result);
  }

  function PartitionCodeUnitSequence(s: WellFormedCodeUnitSeq): (parts: seq<MinimalWellFormedCodeUnitSeq>)
    ensures Seq.Flatten(parts) == s
  {
    PartitionCodeUnitSequenceChecked(s).Extract()
  }

  lemma LemmaPartitionMinimalWellFormedCodeUnitSubsequence(m: MinimalWellFormedCodeUnitSeq)
    ensures PartitionCodeUnitSequenceChecked(m) == Success([m])
  {
    LemmaSplitPrefixMinimalWellFormedCodeUnitSubsequenceInvertsPrepend(m, []);
    calc == {
      Success(m);
      SplitPrefixMinimalWellFormedCodeUnitSubsequence(m + []).ToResult(m);
      {
        assert m + [] == m;
      }
      SplitPrefixMinimalWellFormedCodeUnitSubsequence(m).ToResult(m);
    }
    calc == {
      PartitionCodeUnitSequenceChecked(m);
      Success([m] + []);
      {
        assert [m] + [] == [m];
      }
      Success([m]);
    }
  }

  function IsWellFormedCodeUnitSequence(s: CodeUnitSeq): (b: bool)
  {
    PartitionCodeUnitSequenceChecked(s).Success?
  }

  lemma LemmaMinimalWellFormedCodeUnitSubsequenceIsWellFormedSequence(m: MinimalWellFormedCodeUnitSeq)
    ensures IsWellFormedCodeUnitSequence(m)
  {
    LemmaPartitionMinimalWellFormedCodeUnitSubsequence(m);
  }

  lemma LemmaPrependMinimalWellFormedCodeUnitSubsequence(m: MinimalWellFormedCodeUnitSeq, s: WellFormedCodeUnitSeq)
    ensures IsWellFormedCodeUnitSequence(m + s)
  {
    LemmaPartitionMinimalWellFormedCodeUnitSubsequence(m);
    LemmaSplitPrefixMinimalWellFormedCodeUnitSubsequenceInvertsPrepend(m, s);
  }

  lemma LemmaFlattenMinimalWellFormedCodeUnitSubsequences(ms: seq<MinimalWellFormedCodeUnitSeq>)
    ensures IsWellFormedCodeUnitSequence(Seq.Flatten(ms))
  {
    if |ms| == 0 {
    } else {
      var head := ms[0];
      var tail := ms[1..];
      LemmaFlattenMinimalWellFormedCodeUnitSubsequences(tail);
      var flatTail := Seq.Flatten(tail);
      LemmaPrependMinimalWellFormedCodeUnitSubsequence(head, flatTail);
    }
  }

  lemma LemmaConcatWellFormedCodeUnitSubsequences(s: WellFormedCodeUnitSeq, t: WellFormedCodeUnitSeq)
    ensures IsWellFormedCodeUnitSequence(s + t)
  {
    var partsS := PartitionCodeUnitSequence(s);
    var partsT := PartitionCodeUnitSequence(t);
    var partsST := partsS + partsT;
    Seq.LemmaFlattenConcat(partsS, partsT);
    LemmaFlattenMinimalWellFormedCodeUnitSubsequences(partsST);
  }

  function EncodeScalarSequence(vs: seq<ScalarValue>): (s: WellFormedCodeUnitSeq)
  {
    var ms := Seq.Map(EncodeScalarValue, vs);
    LemmaFlattenMinimalWellFormedCodeUnitSubsequences(ms);
    Seq.Flatten(ms)
  } by method {
    s := [];
    ghost var unflattened: seq<MinimalWellFormedCodeUnitSeq> := [];
    for i := |vs| downto 0
      invariant unflattened == Seq.MapPartialFunction(EncodeScalarValue, vs[i..])
      invariant s == Seq.Flatten(unflattened)
    {
      var next: MinimalWellFormedCodeUnitSeq := EncodeScalarValue(vs[i]);
      unflattened := [next] + unflattened;
      LemmaPrependMinimalWellFormedCodeUnitSubsequence(next, s);
      s := next + s;
    }
  }

  function DecodeCodeUnitSequence(s: WellFormedCodeUnitSeq): (vs: seq<ScalarValue>)
    ensures EncodeScalarSequence(vs) == s
  {
    var parts := PartitionCodeUnitSequence(s);
    var vs := Seq.MapPartialFunction(DecodeMinimalWellFormedCodeUnitSubsequence, parts);
    calc == {
      s;
      Seq.Flatten(parts);
      {
        assert parts == Seq.MapPartialFunction(EncodeScalarValue, vs);
      }
      Seq.Flatten(Seq.MapPartialFunction(EncodeScalarValue, vs));
      EncodeScalarSequence(vs);
    }
    vs
  }

  function DecodeErrorMessage(index: int): string
  {
    "Could not decode byte at index " + Strings.OfInt(index)
  }

  function DecodeCodeUnitSequenceChecked(s: CodeUnitSeq): (resultVs: Result<seq<ScalarValue>, string>)
    ensures IsWellFormedCodeUnitSequence(s) ==> resultVs.Success? && resultVs.Extract() == DecodeCodeUnitSequence(s)
    ensures !IsWellFormedCodeUnitSequence(s) ==> true && resultVs.Failure?
  {
    match PartitionCodeUnitSequenceChecked(s) {
      case Success(_ /* _v0 */) =>
        Success(DecodeCodeUnitSequence(s))
      case Failure(s') =>
        Failure(DecodeErrorMessage(|s| - |s'|))
    }
  } by method {
    var maybeParts := PartitionCodeUnitSequenceChecked(s);
    if maybeParts.Failure? {
      return Failure(DecodeErrorMessage(|s| - |maybeParts.error|));
    }
    var parts := maybeParts.value;
    var vs := Seq.MapPartialFunction(DecodeMinimalWellFormedCodeUnitSubsequence, parts);
    calc == {
      s;
      Seq.Flatten(parts);
      {
        assert parts == Seq.MapPartialFunction(EncodeScalarValue, vs);
      }
      Seq.Flatten(Seq.MapPartialFunction(EncodeScalarValue, vs));
      EncodeScalarSequence(vs);
    }
    return Success(vs);
  }

  import opened Wrappers

  import Strings

  import Functions

  import Seq = Collections.Seq

  import opened Base

  type CodeUnitSeq = seq<CodeUnit>

  type WellFormedCodeUnitSeq = s: CodeUnitSeq
    | IsWellFormedCodeUnitSequence(s)
    witness []

  type MinimalWellFormedCodeUnitSeq = s: CodeUnitSeq
    | IsMinimalWellFormedCodeUnitSubsequence(s)
    witness *

  type CodeUnit
}

abstract module Std.Unicode.AbstractUnicodeStrings {
  function ToUTF8Checked(s: string): Option<seq<uint8>>

  function ASCIIToUTF8(s: string): seq<uint8>
    requires forall i | 0 <= i < |s| :: 0 <= s[i] as int < 128
  {
    Seq.Map(c requires 0 <= c as int < 128 => c as uint8, s)
  }

  function FromUTF8Checked(bs: seq<uint8>): Result<string, string>

  function ToUTF16Checked(s: string): Option<seq<uint16>>

  function ASCIIToUTF16(s: string): seq<uint16>
    requires forall i | 0 <= i < |s| :: 0 <= s[i] as int < 128
  {
    Seq.Map(c requires 0 <= c as int < 128 => c as uint16, s)
  }

  function FromUTF16Checked(bs: seq<uint16>): Result<string, string>

  import Seq = Collections.Seq

  import opened Wrappers

  import opened BoundedInts
}

module Std.Unicode.UnicodeStringsWithUnicodeChar refines AbstractUnicodeStrings {
  @IsolateAssertions lemma CharIsUnicodeScalarValue(c: char)
    ensures true && var asBits := c as int as bv24; asBits <= 1114111 && (0 <= asBits < Base.HIGH_SURROGATE_MIN || Base.LOW_SURROGATE_MAX < asBits)
  {
    assert c as int < 1114112;
    assume {:axiom} c as int as bv24 < 1114112 as bv24;
    var asBits := c as int as bv24;
    assert asBits < 1114112 as bv24;
    assert asBits < Base.HIGH_SURROGATE_MIN || asBits > Base.LOW_SURROGATE_MAX;
    assert asBits <= 1114111;
  }

  lemma UnicodeScalarValueIsChar(sv: Base.ScalarValue)
    ensures true && var asInt := sv as int; true && (0 <= asInt < 55296 || 57344 <= asInt < 1114112)
  {
    var asInt := sv as int;
    assert asInt < 55296 || asInt > 57343;
    assert asInt < 56319 || asInt > 56320;
  }

  function CharAsUnicodeScalarValue(c: char): Base.ScalarValue
  {
    CharIsUnicodeScalarValue(c);
    c as int as Base.ScalarValue
  }

  function CharFromUnicodeScalarValue(sv: Base.ScalarValue): char
  {
    UnicodeScalarValueIsChar(sv);
    sv as int as char
  }

  function ToUTF8Checked(s: string): Option<seq<uint8>>
    ensures ToUTF8Checked(s).Some?
  {
    var asCodeUnits := Seq.Map(CharAsUnicodeScalarValue, s);
    var asUtf8CodeUnits := Utf8EncodingForm.EncodeScalarSequence(asCodeUnits);
    var asBytes := Seq.Map(cu => cu as uint8, asUtf8CodeUnits);
    Some(asBytes)
  }

  function FromUTF8Checked(bs: seq<uint8>): Result<string, string>
  {
    var asCodeUnits := Seq.Map(c => c as Utf8EncodingForm.CodeUnit, bs);
    var utf32 :- Utf8EncodingForm.DecodeCodeUnitSequenceChecked(asCodeUnits); var asChars := Seq.Map(CharFromUnicodeScalarValue, utf32); Success(asChars)
  }

  function ToUTF16Checked(s: string): Option<seq<uint16>>
    ensures ToUTF16Checked(s).Some?
  {
    var asCodeUnits := Seq.Map(CharAsUnicodeScalarValue, s);
    var asUtf16CodeUnits := Utf16EncodingForm.EncodeScalarSequence(asCodeUnits);
    var asBytes := Seq.Map(cu => cu as uint16, asUtf16CodeUnits);
    Some(asBytes)
  }

  function FromUTF16Checked(bs: seq<uint16>): Result<string, string>
  {
    var asCodeUnits := Seq.Map(c => c as Utf16EncodingForm.CodeUnit, bs);
    var utf32 :- Utf16EncodingForm.DecodeCodeUnitSequenceChecked(asCodeUnits); var asChars := Seq.Map(CharFromUnicodeScalarValue, utf32); Success(asChars)
  }

  import Base

  import Utf8EncodingForm

  import Utf16EncodingForm
}

module Std.Unicode.Utf16EncodingForm refines UnicodeEncodingForm {
  function IsMinimalWellFormedCodeUnitSubsequence(s: CodeUnitSeq): (b: bool)
  {
    if |s| == 1 then
      IsWellFormedSingleCodeUnitSequence(s)
    else if |s| == 2 then
      var b := IsWellFormedDoubleCodeUnitSequence(s);
      assert b ==> forall i | 0 < i < |s| :: !IsMinimalWellFormedCodeUnitSubsequence(s[..i]);
      b
    else
      false
  }

  function IsWellFormedSingleCodeUnitSequence(s: CodeUnitSeq): (b: bool)
    requires |s| == 1
  {
    var firstWord := s[0];
    0 <= firstWord <= 55295 || 57344 <= firstWord <= 65535
  }

  function IsWellFormedDoubleCodeUnitSequence(s: CodeUnitSeq): (b: bool)
    requires |s| == 2
    ensures b ==> !IsWellFormedSingleCodeUnitSequence(s[..1])
  {
    var firstWord := s[0];
    var secondWord := s[1];
    55296 <= firstWord <= 56319 &&
    56320 <= secondWord <= 57343
  }

  function SplitPrefixMinimalWellFormedCodeUnitSubsequence(s: CodeUnitSeq): (maybePrefix: Option<MinimalWellFormedCodeUnitSeq>)
    ensures |s| == 0 ==> maybePrefix.None?
    ensures (exists i | 0 < i <= |s| :: IsMinimalWellFormedCodeUnitSubsequence(s[..i])) <==> true && maybePrefix.Some?
    ensures maybePrefix.Some? ==> true && var prefix := maybePrefix.Extract(); 0 < |prefix| <= |s| && prefix == s[..|prefix|] && IsMinimalWellFormedCodeUnitSubsequence(prefix)
  {
    if |s| >= 1 && IsWellFormedSingleCodeUnitSequence(s[..1]) then
      Some(s[..1])
    else if |s| >= 2 && IsWellFormedDoubleCodeUnitSequence(s[..2]) then
      Some(s[..2])
    else
      None
  }

  function EncodeScalarValue(v: ScalarValue): (m: MinimalWellFormedCodeUnitSeq)
  {
    if 0 <= v <= 55295 || 57344 <= v <= 65535 then
      EncodeScalarValueSingleWord(v)
    else
      EncodeScalarValueDoubleWord(v)
  }

  function EncodeScalarValueSingleWord(v: ScalarValue): (m: MinimalWellFormedCodeUnitSeq)
    requires 0 <= v <= 55295 || 57344 <= v <= 65535
    ensures |m| == 1
    ensures IsWellFormedSingleCodeUnitSequence(m)
  {
    var firstWord := v as CodeUnit;
    [firstWord]
  }

  function EncodeScalarValueDoubleWord(v: ScalarValue): (m: MinimalWellFormedCodeUnitSeq)
    requires 65536 <= v <= 1114111
    ensures |m| == 2
    ensures IsWellFormedDoubleCodeUnitSequence(m)
  {
    var x2 := (v & 1023) as bv10;
    var x1 := (v & 64512 >> 10) as bv6;
    var u := (v & 2031616 >> 16) as bv5;
    var w := (u - 1) as bv4;
    var firstWord := 55296 | (w as CodeUnit << 6) | x1 as CodeUnit;
    var secondWord := 56320 | x2 as CodeUnit;
    [firstWord, secondWord]
  }

  function DecodeMinimalWellFormedCodeUnitSubsequence(m: MinimalWellFormedCodeUnitSeq): (v: ScalarValue)
  {
    if |m| == 1 then
      DecodeMinimalWellFormedCodeUnitSubsequenceSingleWord(m)
    else
      assert |m| == 2; DecodeMinimalWellFormedCodeUnitSubsequenceDoubleWord(m)
  }

  function DecodeMinimalWellFormedCodeUnitSubsequenceSingleWord(m: MinimalWellFormedCodeUnitSeq): (v: ScalarValue)
    requires |m| == 1
    ensures 0 <= v <= 55295 || 57344 <= v <= 65535
    ensures EncodeScalarValueSingleWord(v) == m
  {
    var firstWord := m[0];
    var x := firstWord as bv16;
    assert EncodeScalarValueSingleWord(x as ScalarValue) == m;
    x as ScalarValue
  }

  @ResourceLimit("1200e3") function DecodeMinimalWellFormedCodeUnitSubsequenceDoubleWord(m: MinimalWellFormedCodeUnitSeq): (v: ScalarValue)
    requires |m| == 2
    ensures 65536 <= v <= 1114111
    ensures EncodeScalarValueDoubleWord(v) == m
  {
    var firstWord := m[0];
    var secondWord := m[1];
    var x2 := (secondWord & 1023) as bv24;
    var x1 := (firstWord & 63) as bv24;
    var w := (firstWord & 960 >> 6) as bv24;
    var u := (w + 1) as bv24;
    var v := (u << 16) | (x1 << 10) | x2 as ScalarValue;
    assert {:split_here} true;
    assert EncodeScalarValueDoubleWord(v) == m;
    v
  }

  type CodeUnit = bv16
}

module Std.Unicode.Utf8EncodingForm refines UnicodeEncodingForm {
  function IsMinimalWellFormedCodeUnitSubsequence(s: CodeUnitSeq): (b: bool)
  {
    if |s| == 1 then
      var b := IsWellFormedSingleCodeUnitSequence(s);
      assert b ==> forall i | 0 < i < |s| :: !IsMinimalWellFormedCodeUnitSubsequence(s[..i]);
      b
    else if |s| == 2 then
      var b := IsWellFormedDoubleCodeUnitSequence(s);
      assert b ==> forall i | 0 < i < |s| :: !IsMinimalWellFormedCodeUnitSubsequence(s[..i]);
      b
    else if |s| == 3 then
      var b := IsWellFormedTripleCodeUnitSequence(s);
      assert b ==> forall i | 0 < i < |s| :: !IsMinimalWellFormedCodeUnitSubsequence(s[..i]);
      b
    else if |s| == 4 then
      var b := IsWellFormedQuadrupleCodeUnitSequence(s);
      assert b ==> forall i | 0 < i < |s| :: !IsMinimalWellFormedCodeUnitSubsequence(s[..i]);
      b
    else
      false
  }

  function IsWellFormedSingleCodeUnitSequence(s: CodeUnitSeq): (b: bool)
    requires |s| == 1
  {
    var firstByte := s[0];
    true &&
    0 <= firstByte <= 127
  }

  function IsWellFormedDoubleCodeUnitSequence(s: CodeUnitSeq): (b: bool)
    requires |s| == 2
    ensures b ==> true && !IsWellFormedSingleCodeUnitSequence(s[..1])
  {
    var firstByte := s[0];
    var secondByte := s[1];
    194 <= firstByte <= 223 &&
    128 <= secondByte <= 191
  }

  function IsWellFormedTripleCodeUnitSequence(s: CodeUnitSeq): (b: bool)
    requires |s| == 3
    ensures b ==> !IsWellFormedSingleCodeUnitSequence(s[..1]) && !IsWellFormedDoubleCodeUnitSequence(s[..2])
  {
    var firstByte := s[0];
    var secondByte := s[1];
    var thirdByte := s[2];
    ((firstByte == 224 && 160 <= secondByte <= 191) || (225 <= firstByte <= 236 && 128 <= secondByte <= 191) || (firstByte == 237 && 128 <= secondByte <= 159) || (238 <= firstByte <= 239 && 128 <= secondByte <= 191)) &&
    128 <= thirdByte <= 191
  }

  function IsWellFormedQuadrupleCodeUnitSequence(s: CodeUnitSeq): (b: bool)
    requires |s| == 4
    ensures b ==> !IsWellFormedSingleCodeUnitSequence(s[..1]) && !IsWellFormedDoubleCodeUnitSequence(s[..2]) && !IsWellFormedTripleCodeUnitSequence(s[..3])
  {
    var firstByte := s[0];
    var secondByte := s[1];
    var thirdByte := s[2];
    var fourthByte := s[3];
    ((firstByte == 240 && 144 <= secondByte <= 191) || (241 <= firstByte <= 243 && 128 <= secondByte <= 191) || (firstByte == 244 && 128 <= secondByte <= 143)) &&
    128 <= thirdByte <= 191 &&
    128 <= fourthByte <= 191
  }

  function SplitPrefixMinimalWellFormedCodeUnitSubsequence(s: CodeUnitSeq): (maybePrefix: Option<MinimalWellFormedCodeUnitSeq>)
  {
    if |s| >= 1 && IsWellFormedSingleCodeUnitSequence(s[..1]) then
      Some(s[..1])
    else if |s| >= 2 && IsWellFormedDoubleCodeUnitSequence(s[..2]) then
      Some(s[..2])
    else if |s| >= 3 && IsWellFormedTripleCodeUnitSequence(s[..3]) then
      Some(s[..3])
    else if |s| >= 4 && IsWellFormedQuadrupleCodeUnitSequence(s[..4]) then
      Some(s[..4])
    else
      None
  }

  function EncodeScalarValue(v: ScalarValue): (m: MinimalWellFormedCodeUnitSeq)
  {
    if v <= 127 then
      EncodeScalarValueSingleByte(v)
    else if v <= 2047 then
      EncodeScalarValueDoubleByte(v)
    else if v <= 65535 then
      EncodeScalarValueTripleByte(v)
    else
      EncodeScalarValueQuadrupleByte(v)
  }

  function EncodeScalarValueSingleByte(v: ScalarValue): (m: MinimalWellFormedCodeUnitSeq)
    requires 0 <= v <= 127
    ensures |m| == 1
    ensures IsWellFormedSingleCodeUnitSequence(m)
  {
    var x := (v & 127) as bv7;
    var firstByte := x as CodeUnit;
    [firstByte]
  }

  function EncodeScalarValueDoubleByte(v: ScalarValue): (s: CodeUnitSeq)
    requires 128 <= v <= 2047
    ensures |s| == 2
    ensures IsWellFormedDoubleCodeUnitSequence(s)
  {
    var x := (v & 63) as bv6;
    var y := (v & 1984 >> 6) as bv5;
    var firstByte := 192 | y as CodeUnit;
    var secondByte := 128 | x as CodeUnit;
    [firstByte, secondByte]
  }

  function EncodeScalarValueTripleByte(v: ScalarValue): (s: CodeUnitSeq)
    requires 2048 <= v <= 65535
    ensures |s| == 3
    ensures IsWellFormedTripleCodeUnitSequence(s)
  {
    var x := (v & 63) as bv6;
    var y := (v & 4032 >> 6) as bv6;
    var z := (v & 61440 >> 12) as bv4;
    var firstByte := 224 | z as CodeUnit;
    var secondByte := 128 | y as CodeUnit;
    var thirdByte := 128 | x as CodeUnit;
    [firstByte, secondByte, thirdByte]
  }

  function EncodeScalarValueQuadrupleByte(v: ScalarValue): (s: CodeUnitSeq)
    requires 65536 <= v <= 1114111
    ensures |s| == 4
    ensures IsWellFormedQuadrupleCodeUnitSequence(s)
  {
    assert v <= 2097151;
    var x := (v & 63) as bv6;
    var y := (v & 4032 >> 6) as bv6;
    var z := (v & 61440 >> 12) as bv4;
    var u2 := (v & 196608 >> 16) as bv2;
    var u1 := (v & 1835008 >> 18) as bv3;
    var firstByte := 240 | u1 as CodeUnit;
    var secondByte := 128 | (u2 as CodeUnit << 4) | z as CodeUnit;
    var thirdByte := 128 | y as CodeUnit;
    var fourthByte := 128 | x as CodeUnit;
    [firstByte, secondByte, thirdByte, fourthByte]
  }

  function DecodeMinimalWellFormedCodeUnitSubsequence(m: MinimalWellFormedCodeUnitSeq): (v: ScalarValue)
  {
    if |m| == 1 then
      DecodeMinimalWellFormedCodeUnitSubsequenceSingleByte(m)
    else if |m| == 2 then
      DecodeMinimalWellFormedCodeUnitSubsequenceDoubleByte(m)
    else if |m| == 3 then
      DecodeMinimalWellFormedCodeUnitSubsequenceTripleByte(m)
    else
      assert |m| == 4; DecodeMinimalWellFormedCodeUnitSubsequenceQuadrupleByte(m)
  }

  function DecodeMinimalWellFormedCodeUnitSubsequenceSingleByte(m: MinimalWellFormedCodeUnitSeq): (v: ScalarValue)
    requires |m| == 1
    ensures 0 <= v <= 127
    ensures EncodeScalarValueSingleByte(v) == m
  {
    var firstByte := m[0];
    var x := firstByte as bv7;
    x as ScalarValue
  }

  function DecodeMinimalWellFormedCodeUnitSubsequenceDoubleByte(m: MinimalWellFormedCodeUnitSeq): (v: ScalarValue)
    requires |m| == 2
    ensures 128 <= v <= 2047
    ensures EncodeScalarValueDoubleByte(v) == m
  {
    var firstByte := m[0];
    var secondByte := m[1];
    var y := (firstByte & 31) as bv24;
    var x := (secondByte & 63) as bv24;
    (y << 6) | x as ScalarValue
  }

  @ResourceLimit("115e6") function DecodeMinimalWellFormedCodeUnitSubsequenceTripleByte(m: MinimalWellFormedCodeUnitSeq): (v: ScalarValue)
    requires |m| == 3
    ensures 2048 <= v <= 65535
    ensures EncodeScalarValueTripleByte(v) == m
  {
    var firstByte := m[0];
    var secondByte := m[1];
    var thirdByte := m[2];
    var z := (firstByte & 15) as bv24;
    var y := (secondByte & 63) as bv24;
    var x := (thirdByte & 63) as bv24;
    assert {:split_here} true;
    (z << 12) | (y << 6) | x as ScalarValue
  }

  @IsolateAssertions function DecodeMinimalWellFormedCodeUnitSubsequenceQuadrupleByte(m: MinimalWellFormedCodeUnitSeq): (v: ScalarValue)
    requires |m| == 4
    ensures 65536 <= v <= 1114111
    ensures EncodeScalarValueQuadrupleByte(v) == m
  {
    var firstByte := m[0];
    var secondByte := m[1];
    var thirdByte := m[2];
    var fourthByte := m[3];
    var u1 := (firstByte & 7) as bv24;
    var u2 := (secondByte & 48 >> 4) as bv24;
    var z := (secondByte & 15) as bv24;
    var y := (thirdByte & 63) as bv24;
    var x := (fourthByte & 63) as bv24;
    assert {:split_here} true;
    var r := (u1 << 18) | (u2 << 16) | (z << 12) | (y << 6) | x as ScalarValue;
    assert EncodeScalarValueQuadrupleByte(r)[0] == m[0];
    assert EncodeScalarValueQuadrupleByte(r)[1] == m[1];
    assert EncodeScalarValueQuadrupleByte(r)[2] == m[2];
    assert EncodeScalarValueQuadrupleByte(r)[3] == m[3];
    r
  }

  type CodeUnit = bv8
}

module Std.Unicode.Utf8EncodingScheme {
  function Serialize(s: Utf8EncodingForm.CodeUnitSeq): (b: seq<byte>)
  {
    Seq.Map(c => c as byte, s)
  }

  function Deserialize(b: seq<byte>): (s: Utf8EncodingForm.CodeUnitSeq)
  {
    Seq.Map(b => b as Utf8EncodingForm.CodeUnit, b)
  }

  lemma LemmaSerializeDeserialize(s: Utf8EncodingForm.CodeUnitSeq)
    ensures Deserialize(Serialize(s)) == s
  {
  }

  @ResourceLimit("30e7") lemma LemmaDeserializeSerialize(b: seq<byte>)
    ensures Serialize(Deserialize(b)) == b
  {
    hide *;
    reveal BoundedInts.TWO_TO_THE_8;
    calc {
      Serialize(Deserialize(b));
    ==
      {
        reveal Serialize;
        reveal Deserialize;
      }
      Seq.Map(c => c as byte, Seq.Map(b => b as Utf8EncodingForm.CodeUnit, b));
    ==
      Seq.Map(b => b as Utf8EncodingForm.CodeUnit as byte, b);
    ==
      Seq.Map(b => b, b);
    ==
      b;
    }
  }

  import opened Wrappers

  import BoundedInts

  import Seq = Collections.Seq

  import Utf8EncodingForm

  type byte = BoundedInts.uint8
}

module Std.Wrappers {
  function Need<E>(condition: bool, error: E): (result: OutcomeResult<E>)
  {
    if condition then
      Pass'
    else
      Fail'(error)
  }

  datatype Option<+T> = None | Some(value: T) {
    predicate IsFailure()
    {
      None?
    }

    function PropagateFailure<U>(): Option<U>
      requires None?
    {
      None
    }

    function Extract(): T
      requires Some?
    {
      value
    }

    function GetOr(default: T): T
    {
      match this
      case Some(v) =>
        v
      case None() =>
        default
    }

    function ToResult<E>(error: E): Result<T, E>
    {
      match this
      case Some(v) =>
        Success(v)
      case None() =>
        Failure(error)
    }

    function ToOutcome<E>(error: E): Outcome<E>
    {
      match this
      case Some(v) =>
        Pass
      case None() =>
        Fail(error)
    }

    function Map<FC>(rewrap: Option<T> -> FC): FC
    {
      rewrap(this)
    }
  }

  datatype Result<+R, +E> = Success(value: R) | Failure(error: E) {
    predicate IsFailure()
    {
      Failure?
    }

    function PropagateFailure<U>(): (r: Result<U, E>)
      requires Failure?
    {
      Failure(this.error)
    }

    function Extract(): R
      requires Success?
    {
      value
    }

    function GetOr(default: R): R
    {
      match this
      case Success(s) =>
        s
      case Failure(e) =>
        default
    }

    function ToOption(): Option<R>
    {
      match this
      case Success(s) =>
        Some(s)
      case Failure(e) =>
        None()
    }

    function ToOutcome(): Outcome<E>
    {
      match this
      case Success(s) =>
        Pass
      case Failure(e) =>
        Fail(e)
    }

    function Map<FC>(rewrap: Result<R, E> -> FC): FC
    {
      rewrap(this)
    }

    function MapFailure<NewE>(reWrap: E -> NewE): Result<R, NewE>
    {
      match this
      case Success(s) =>
        Success(s)
      case Failure(e) =>
        Failure(reWrap(e))
    }
  }

  datatype Outcome<+E> = Pass | Fail(error: E) {
    predicate IsFailure()
    {
      Fail?
    }

    function PropagateFailure(): Outcome<E>
      requires Fail?
    {
      this
    }

    function ToOption<R>(r: R): Option<R>
    {
      match this
      case Pass =>
        Some(r)
      case Fail(e) =>
        None()
    }

    function ToResult<R>(r: R): Result<R, E>
    {
      match this
      case Pass =>
        Success(r)
      case Fail(e) =>
        Failure(e)
    }

    function Map<FC>(rewrap: Outcome<E> -> FC): FC
    {
      rewrap(this)
    }

    function MapFailure<T, NewE>(rewrap: E -> NewE, default: T): Result<T, NewE>
    {
      match this
      case Pass =>
        Success(default)
      case Fail(e) =>
        Failure(rewrap(e))
    }

    static function Need(condition: bool, error: E): (result: Outcome<E>)
    {
      if condition then
        Pass
      else
        Fail(error)
    }
  }

  datatype OutcomeResult<+E> = Pass' | Fail'(error: E) {
    predicate IsFailure()
    {
      Fail'?
    }

    function PropagateFailure<U>(): Result<U, E>
      requires IsFailure()
    {
      Failure(this.error)
    }
  }
}
