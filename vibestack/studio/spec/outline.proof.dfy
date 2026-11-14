// Proofs of what Dafny cannot see through on its own: where storiesWith and rulesWith put their item (a fold), and
// what that means for numbering and for counting rules.

// The insert fold, from any list built so far: until the item is placed, what is built is as long as the position
// of the next element, so the item lands exactly at `at`, or at the end if `at` is past what is left.

// Past the position, nothing is inserted.
lemma FoldPast<T>(f: (seq<T>, T) -> seq<T>, at: int, x: T, acc: seq<T>, ys: seq<T>)
  requires forall a: seq<T>, y: T :: f(a, y) == (if |a| == at then a + [x, y] else a + [y])
  requires |acc| > at
  ensures Std.Collections.Seq.FoldLeft(f, acc, ys) == acc + ys
  decreases |ys|
{
  if |ys| == 0 {
    assert acc + ys == acc;
  } else {
    FoldPast(f, at, x, acc + [ys[0]], ys[1..]);
    assert acc + [ys[0]] + ys[1..] == acc + ys;
  }
}

// Short of the position by more than is left, nothing is inserted either.
lemma FoldShort<T>(f: (seq<T>, T) -> seq<T>, at: int, x: T, acc: seq<T>, ys: seq<T>)
  requires forall a: seq<T>, y: T :: f(a, y) == (if |a| == at then a + [x, y] else a + [y])
  requires |acc| + |ys| <= at
  ensures Std.Collections.Seq.FoldLeft(f, acc, ys) == acc + ys
  decreases |ys|
{
  if |ys| == 0 {
    assert acc + ys == acc;
  } else {
    FoldShort(f, at, x, acc + [ys[0]], ys[1..]);
    assert acc + [ys[0]] + ys[1..] == acc + ys;
  }
}

// Within reach, the item lands exactly at the position.
lemma FoldInsert<T>(f: (seq<T>, T) -> seq<T>, at: int, x: T, acc: seq<T>, ys: seq<T>)
  requires forall a: seq<T>, y: T :: f(a, y) == (if |a| == at then a + [x, y] else a + [y])
  requires |acc| <= at < |acc| + |ys|
  ensures Std.Collections.Seq.FoldLeft(f, acc, ys) == acc + ys[..at - |acc|] + [x] + ys[at - |acc|..]
  decreases |ys|
{
  var k := at - |acc|;
  var t := ys[1..];
  assert ys == [ys[0]] + t;
  // One step of the fold, stated so the solver need not find it.
  assert Std.Collections.Seq.FoldLeft(f, acc, ys) == Std.Collections.Seq.FoldLeft(f, f(acc, ys[0]), t);
  if k == 0 {
    FoldInsertHere(f, at, x, acc, ys);
  } else {
    var a := acc + [ys[0]];
    assert f(acc, ys[0]) == a;
    FoldInsert(f, at, x, a, t);
    assert at - |a| == k - 1;
    assert ys[..k] == [ys[0]] + t[..k - 1];
    assert ys[k..] == t[k - 1..];
    assert a + t[..k - 1] == acc + ys[..k];
  }
}

// FoldInsert where `x` goes at the front of what is left: placed, then the rest follows unchanged.
lemma FoldInsertHere<T>(f: (seq<T>, T) -> seq<T>, at: int, x: T, acc: seq<T>, ys: seq<T>)
  requires forall a: seq<T>, y: T :: f(a, y) == (if |a| == at then a + [x, y] else a + [y])
  requires |acc| == at && |ys| > 0
  ensures Std.Collections.Seq.FoldLeft(f, f(acc, ys[0]), ys[1..]) == acc + ys[..0] + [x] + ys[0..]
{
  var t := ys[1..];
  assert f(acc, ys[0]) == acc + [x, ys[0]];
  FoldPast(f, at, x, acc + [x, ys[0]], t);
  assert ys[..0] == [];
  assert ys[0..] == ys;
  assert ys == [ys[0]] + t;
  assert acc + [x, ys[0]] + t == acc + [] + [x] + ys;
}

lemma StoriesWithIs(xs: seq<Story>, at: int, x: Story)
  requires 0 <= at <= |xs|
  ensures storiesWith(xs, at, x) == xs[..at] + [x] + xs[at..]
{
  if at < |xs| {
    FoldInsert((acc: seq<Story>, y: Story) => (if (|acc| == at) then (acc + [x, y]) else (acc + [y])), at, x, [], xs);
    assert [] + xs[..at] == xs[..at];
  } else {
    FoldShort((acc: seq<Story>, y: Story) => (if (|acc| == at) then (acc + [x, y]) else (acc + [y])), at, x, [], xs);
    assert [] + xs == xs;
    assert xs[..at] == xs && xs[at..] == [];
  }
}

lemma RulesWithIs(xs: seq<Rule>, at: int, x: Rule)
  requires 0 <= at <= |xs|
  ensures rulesWith(xs, at, x) == xs[..at] + [x] + xs[at..]
{
  if at < |xs| {
    FoldInsert((acc: seq<Rule>, y: Rule) => (if (|acc| == at) then (acc + [x, y]) else (acc + [y])), at, x, [], xs);
    assert [] + xs[..at] == xs[..at];
  } else {
    FoldShort((acc: seq<Rule>, y: Rule) => (if (|acc| == at) then (acc + [x, y]) else (acc + [y])), at, x, [], xs);
    assert [] + xs == xs;
    assert xs[..at] == xs && xs[at..] == [];
  }
}

lemma StoriesReplacedIs(xs: seq<Story>, s: int, x: Story)
  requires 0 <= s < |xs|
  ensures storiesReplaced(xs, s, x) == xs[..s] + [x] + xs[s + 1..]
{
  var ys := xs[0..s] + xs[(s + 1)..];
  StoriesWithIs(ys, s, x);
  assert ys[..s] == xs[..s];
  assert ys[s..] == xs[s + 1..];
}

// --- numbering ----------------------------------------------------------------------------------------------

lemma Numbered(o: Outline)
  requires inv(o)
  ensures o.counter >= 1
  ensures forall k | 0 <= k < |o.stories| :: numberedBelow(o.stories[k], o.counter)
{
}

lemma NumberedHolds(o: Outline)
  requires o.counter >= 1
  requires forall k | 0 <= k < |o.stories| :: numberedBelow(o.stories[k], o.counter)
  ensures alwaysNumberedBelowTheCounter(o)
{
}

lemma RulesBelow(x: Story, c: int)
  requires numberedBelow(x, c)
  ensures 1 <= x.id < c
  ensures forall j | 0 <= j < |x.rules| :: 1 <= x.rules[j].id < c
{
}

lemma BelowRules(x: Story, c: int)
  requires 1 <= x.id < c
  requires forall j | 0 <= j < |x.rules| :: 1 <= x.rules[j].id < c
  ensures numberedBelow(x, c)
{
}

lemma NumberedUp(x: Story, c: int, d: int)
  requires numberedBelow(x, c) && c <= d
  ensures numberedBelow(x, d)
{
  RulesBelow(x, c);
  BelowRules(x, d);
}

lemma NumberedSplice(xs: seq<Story>, at: int, x: Story, c: int, ys: seq<Story>)
  requires 0 <= at <= |xs| && ys == xs[..at] + [x] + xs[at..]
  requires forall k | 0 <= k < |xs| :: numberedBelow(xs[k], c)
  requires numberedBelow(x, c)
  ensures forall k | 0 <= k < |ys| :: numberedBelow(ys[k], c)
{
  forall k | 0 <= k < |ys| ensures numberedBelow(ys[k], c) {
    if k < at { assert ys[k] == xs[k]; }
    else if k > at { assert ys[k] == xs[k - 1]; }
    else { assert ys[k] == x; }
  }
}

lemma NumberedReplace(xs: seq<Story>, s: int, x: Story, c: int, ys: seq<Story>)
  requires 0 <= s < |xs| && ys == xs[..s] + [x] + xs[s + 1..]
  requires forall k | 0 <= k < |xs| :: numberedBelow(xs[k], c)
  requires numberedBelow(x, c)
  ensures forall k | 0 <= k < |ys| :: numberedBelow(ys[k], c)
{
  forall k | 0 <= k < |ys| ensures numberedBelow(ys[k], c) {
    if k < s { assert ys[k] == xs[k]; }
    else if k > s { assert ys[k] == xs[k]; }
    else { assert ys[k] == x; }
  }
}

lemma NumberedRemove(xs: seq<Story>, s: int, c: int, ys: seq<Story>)
  requires 0 <= s < |xs| && ys == xs[0..s] + xs[(s + 1)..]
  requires forall k | 0 <= k < |xs| :: numberedBelow(xs[k], c)
  ensures forall k | 0 <= k < |ys| :: numberedBelow(ys[k], c)
{
  forall k | 0 <= k < |ys| ensures numberedBelow(ys[k], c) {
    if k < s { assert ys[k] == xs[k]; } else { assert ys[k] == xs[k + 1]; }
  }
}

lemma RuleIdsSplice(rs: seq<Rule>, at: int, y: Rule, c: int, zs: seq<Rule>)
  requires 0 <= at <= |rs| && zs == rs[..at] + [y] + rs[at..]
  requires forall j | 0 <= j < |rs| :: 1 <= rs[j].id < c
  requires 1 <= y.id < c
  ensures forall j | 0 <= j < |zs| :: 1 <= zs[j].id < c
{
  forall j | 0 <= j < |zs| ensures 1 <= zs[j].id < c {
    if j < at { assert zs[j] == rs[j]; }
    else if j > at { assert zs[j] == rs[j - 1]; }
    else { assert zs[j] == y; }
  }
}

lemma RuleIdsRemove(rs: seq<Rule>, r: int, c: int, zs: seq<Rule>)
  requires 0 <= r < |rs| && zs == rs[0..r] + rs[(r + 1)..]
  requires forall j | 0 <= j < |rs| :: 1 <= rs[j].id < c
  ensures forall j | 0 <= j < |zs| :: 1 <= zs[j].id < c
{
  forall j | 0 <= j < |zs| ensures 1 <= zs[j].id < c {
    if j < r { assert zs[j] == rs[j]; } else { assert zs[j] == rs[j + 1]; }
  }
}

// --- counting rules ----------------------------------------------------------------------------------------

lemma CountFrom(g: (int, Story) -> int, n: int, xs: seq<Story>)
  requires forall m: int, x: Story :: g(m, x) == m + |x.rules|
  ensures Std.Collections.Seq.FoldLeft(g, n, xs) == n + Std.Collections.Seq.FoldLeft(g, 0, xs)
  decreases |xs|
{
  if |xs| > 0 {
    CountFrom(g, g(n, xs[0]), xs[1..]);
    CountFrom(g, g(0, xs[0]), xs[1..]);
  }
}

lemma CountConcat(g: (int, Story) -> int, a: seq<Story>, b: seq<Story>)
  requires forall m: int, x: Story :: g(m, x) == m + |x.rules|
  ensures Std.Collections.Seq.FoldLeft(g, 0, a + b) == Std.Collections.Seq.FoldLeft(g, 0, a) + Std.Collections.Seq.FoldLeft(g, 0, b)
  decreases |a|
{
  if |a| == 0 {
    assert a + b == b;
  } else {
    assert (a + b)[0] == a[0];
    assert (a + b)[1..] == a[1..] + b;
    CountConcat(g, a[1..], b);
    CountFrom(g, g(0, a[0]), a[1..] + b);
    CountFrom(g, g(0, a[0]), a[1..]);
  }
}

lemma CountOne(g: (int, Story) -> int, y: Story)
  requires forall m: int, x: Story :: g(m, x) == m + |x.rules|
  ensures Std.Collections.Seq.FoldLeft(g, 0, [y]) == |y.rules|
{
  assert [y][1..] == [];
}

// The rules of `xs` with `x` in place of the story at `s`.
lemma CountReplace(g: (int, Story) -> int, xs: seq<Story>, s: int, x: Story)
  requires forall m: int, z: Story :: g(m, z) == m + |z.rules|
  requires 0 <= s < |xs|
  ensures Std.Collections.Seq.FoldLeft(g, 0, xs[..s] + [x] + xs[s + 1..]) == Std.Collections.Seq.FoldLeft(g, 0, xs) - |xs[s].rules| + |x.rules|
{
  assert xs == xs[..s] + [xs[s]] + xs[s + 1..];
  CountConcat(g, xs[..s] + [xs[s]], xs[s + 1..]);
  CountConcat(g, xs[..s], [xs[s]]);
  CountConcat(g, xs[..s] + [x], xs[s + 1..]);
  CountConcat(g, xs[..s], [x]);
  CountOne(g, xs[s]);
  CountOne(g, x);
}

lemma CountInsert(g: (int, Story) -> int, ys: seq<Story>, d: int, x: Story)
  requires forall m: int, z: Story :: g(m, z) == m + |z.rules|
  requires 0 <= d <= |ys|
  ensures Std.Collections.Seq.FoldLeft(g, 0, ys[..d] + [x] + ys[d..]) == Std.Collections.Seq.FoldLeft(g, 0, ys) + |x.rules|
{
  assert ys == ys[..d] + ys[d..];
  CountConcat(g, ys[..d], ys[d..]);
  CountConcat(g, ys[..d] + [x], ys[d..]);
  CountConcat(g, ys[..d], [x]);
  CountOne(g, x);
}

lemma CountRemove(g: (int, Story) -> int, xs: seq<Story>, s: int)
  requires forall m: int, z: Story :: g(m, z) == m + |z.rules|
  requires 0 <= s < |xs|
  ensures Std.Collections.Seq.FoldLeft(g, 0, xs[0..s] + xs[(s + 1)..]) == Std.Collections.Seq.FoldLeft(g, 0, xs) - |xs[s].rules|
{
  assert xs == xs[..s] + [xs[s]] + xs[s + 1..];
  assert xs[0..s] == xs[..s];
  CountConcat(g, xs[..s] + [xs[s]], xs[s + 1..]);
  CountConcat(g, xs[..s], [xs[s]]);
  CountConcat(g, xs[..s], xs[s + 1..]);
  CountOne(g, xs[s]);
}

// --- the obligations ----------------------------------------------------------------------------------------

lemma addStory_ensures(o: Outline, at: int, title: string, body: string, origin: string)
  ensures (inv(o) ==> canAddStory(o, at) ==> alwaysNumberedBelowTheCounter(addStory(o, at, title, body, origin)))
  ensures (inv(o) ==> canAddStory(o, at) ==> stepHeadChangesOnlyByRetitling(o, "addStory", addStory(o, at, title, body, origin)))
  ensures (inv(o) ==> canAddStory(o, at) ==> stepCounterNeverGoesBack(o, addStory(o, at, title, body, origin)))
  ensures (inv(o) ==> canAddStory(o, at) ==> stepMovesKeepEverything(o, "addStory", addStory(o, at, title, body, origin)))
{
  if inv(o) && canAddStory(o, at) {
    var x := Story(o.counter, title, body, origin, []);
    var after := addStory(o, at, title, body, origin);
    Numbered(o);
    forall k | 0 <= k < |o.stories| ensures numberedBelow(o.stories[k], after.counter) { NumberedUp(o.stories[k], o.counter, after.counter); }
    BelowRules(x, after.counter);
    StoriesWithIs(o.stories, at, x);
    NumberedSplice(o.stories, at, x, after.counter, after.stories);
    NumberedHolds(after);
  }
}

lemma editStory_ensures(o: Outline, s: int, title: string, body: string)
  ensures (inv(o) ==> canEditStory(o, s) ==> alwaysNumberedBelowTheCounter(editStory(o, s, title, body)))
  ensures (inv(o) ==> canEditStory(o, s) ==> stepHeadChangesOnlyByRetitling(o, "editStory", editStory(o, s, title, body)))
  ensures (inv(o) ==> canEditStory(o, s) ==> stepCounterNeverGoesBack(o, editStory(o, s, title, body)))
  ensures (inv(o) ==> canEditStory(o, s) ==> stepMovesKeepEverything(o, "editStory", editStory(o, s, title, body)))
{
  if inv(o) && canEditStory(o, s) {
    var x := storyAt(o, s).(title := title, body := body);
    Numbered(o);
    RulesBelow(o.stories[s], o.counter);
    BelowRules(x, o.counter);
    StoriesReplacedIs(o.stories, s, x);
    NumberedReplace(o.stories, s, x, o.counter, o.stories[..s] + [x] + o.stories[s + 1..]);
    NumberedHolds(editStory(o, s, title, body));
  }
}

lemma moveStory_ensures(o: Outline, s: int, dest: int)
  ensures (inv(o) ==> canMoveStory(o, s, dest) ==> alwaysNumberedBelowTheCounter(moveStory(o, s, dest)))
  ensures (inv(o) ==> canMoveStory(o, s, dest) ==> stepHeadChangesOnlyByRetitling(o, "moveStory", moveStory(o, s, dest)))
  ensures (inv(o) ==> canMoveStory(o, s, dest) ==> stepCounterNeverGoesBack(o, moveStory(o, s, dest)))
  ensures (inv(o) ==> canMoveStory(o, s, dest) ==> stepMovesKeepEverything(o, "moveStory", moveStory(o, s, dest)))
{
  if inv(o) && canMoveStory(o, s, dest) {
    var ys := o.stories[0..s] + o.stories[(s + 1)..];
    var x := o.stories[s];
    var after := moveStory(o, s, dest);
    Numbered(o);
    NumberedRemove(o.stories, s, o.counter, ys);
    StoriesWithIs(ys, dest, x);
    NumberedSplice(ys, dest, x, o.counter, after.stories);
    NumberedHolds(after);
    CountRemove((n: int, x: Story) => (n + |x.rules|), o.stories, s);
    CountInsert((n: int, x: Story) => (n + |x.rules|), ys, dest, x);
    assert ruleCount(after) == ruleCount(o);
  }
}

lemma addRule_ensures(o: Outline, s: int, at: int, title: string, body: string, origin: string)
  ensures (inv(o) ==> canAddRule(o, s, at) ==> alwaysNumberedBelowTheCounter(addRule(o, s, at, title, body, origin)))
  ensures (inv(o) ==> canAddRule(o, s, at) ==> stepHeadChangesOnlyByRetitling(o, "addRule", addRule(o, s, at, title, body, origin)))
  ensures (inv(o) ==> canAddRule(o, s, at) ==> stepCounterNeverGoesBack(o, addRule(o, s, at, title, body, origin)))
  ensures (inv(o) ==> canAddRule(o, s, at) ==> stepMovesKeepEverything(o, "addRule", addRule(o, s, at, title, body, origin)))
{
  if inv(o) && canAddRule(o, s, at) {
    var st := o.stories[s];
    var y := Rule(o.counter, title, body, origin);
    var x := st.(rules := rulesWith(st.rules, at, y));
    var after := addRule(o, s, at, title, body, origin);
    Numbered(o);
    forall k | 0 <= k < |o.stories| ensures numberedBelow(o.stories[k], after.counter) { NumberedUp(o.stories[k], o.counter, after.counter); }
    RulesBelow(st, after.counter);
    RulesWithIs(st.rules, at, y);
    RuleIdsSplice(st.rules, at, y, after.counter, st.rules[..at] + [y] + st.rules[at..]);
    BelowRules(x, after.counter);
    StoriesReplacedIs(o.stories, s, x);
    NumberedReplace(o.stories, s, x, after.counter, after.stories);
    NumberedHolds(after);
  }
}

lemma editRule_ensures(o: Outline, s: int, r: int, title: string, body: string)
  ensures (inv(o) ==> canEditRule(o, s, r) ==> alwaysNumberedBelowTheCounter(editRule(o, s, r, title, body)))
  ensures (inv(o) ==> canEditRule(o, s, r) ==> stepHeadChangesOnlyByRetitling(o, "editRule", editRule(o, s, r, title, body)))
  ensures (inv(o) ==> canEditRule(o, s, r) ==> stepCounterNeverGoesBack(o, editRule(o, s, r, title, body)))
  ensures (inv(o) ==> canEditRule(o, s, r) ==> stepMovesKeepEverything(o, "editRule", editRule(o, s, r, title, body)))
{
  if inv(o) && canEditRule(o, s, r) {
    var st := o.stories[s];
    var rs := st.rules[0..r] + st.rules[(r + 1)..];
    var y := st.rules[r].(title := title, body := body);
    var x := st.(rules := rulesWith(rs, r, y));
    Numbered(o);
    RulesBelow(st, o.counter);
    RuleIdsRemove(st.rules, r, o.counter, st.rules[0..r] + st.rules[(r + 1)..]);
    RulesWithIs(rs, r, y);
    RuleIdsSplice(rs, r, y, o.counter, rs[..r] + [y] + rs[r..]);
    BelowRules(x, o.counter);
    StoriesReplacedIs(o.stories, s, x);
    NumberedReplace(o.stories, s, x, o.counter, o.stories[..s] + [x] + o.stories[s + 1..]);
    NumberedHolds(editRule(o, s, r, title, body));
  }
}

lemma removeRule_ensures(o: Outline, s: int, r: int)
  ensures (inv(o) ==> canRemoveRule(o, s, r) ==> alwaysNumberedBelowTheCounter(removeRule(o, s, r)))
  ensures (inv(o) ==> canRemoveRule(o, s, r) ==> stepHeadChangesOnlyByRetitling(o, "removeRule", removeRule(o, s, r)))
  ensures (inv(o) ==> canRemoveRule(o, s, r) ==> stepCounterNeverGoesBack(o, removeRule(o, s, r)))
  ensures (inv(o) ==> canRemoveRule(o, s, r) ==> stepMovesKeepEverything(o, "removeRule", removeRule(o, s, r)))
{
  if inv(o) && canRemoveRule(o, s, r) {
    var st := o.stories[s];
    var x := st.(rules := st.rules[0..r] + st.rules[(r + 1)..]);
    Numbered(o);
    RulesBelow(st, o.counter);
    RuleIdsRemove(st.rules, r, o.counter, st.rules[0..r] + st.rules[(r + 1)..]);
    BelowRules(x, o.counter);
    StoriesReplacedIs(o.stories, s, x);
    NumberedReplace(o.stories, s, x, o.counter, o.stories[..s] + [x] + o.stories[s + 1..]);
    NumberedHolds(removeRule(o, s, r));
  }
}

lemma moveRule_ensures(o: Outline, s: int, r: int, dest: int, at: int)
  ensures (inv(o) ==> canMoveRule(o, s, r, dest, at) ==> alwaysNumberedBelowTheCounter(moveRule(o, s, r, dest, at)))
  ensures (inv(o) ==> canMoveRule(o, s, r, dest, at) ==> stepHeadChangesOnlyByRetitling(o, "moveRule", moveRule(o, s, r, dest, at)))
  ensures (inv(o) ==> canMoveRule(o, s, r, dest, at) ==> stepCounterNeverGoesBack(o, moveRule(o, s, r, dest, at)))
  ensures (inv(o) ==> canMoveRule(o, s, r, dest, at) ==> stepMovesKeepEverything(o, "moveRule", moveRule(o, s, r, dest, at)))
{
  if inv(o) && canMoveRule(o, s, r, dest, at) {
    var st := o.stories[s];
    var y := st.rules[r];
    var rs := st.rules[0..r] + st.rules[(r + 1)..];
    var lessened := st.(rules := rs);
    var without := storiesReplaced(o.stories, s, lessened);
    Numbered(o);
    RulesBelow(st, o.counter);
    RuleIdsRemove(st.rules, r, o.counter, st.rules[0..r] + st.rules[(r + 1)..]);
    BelowRules(lessened, o.counter);
    StoriesReplacedIs(o.stories, s, lessened);
    NumberedReplace(o.stories, s, lessened, o.counter, without);
    assert |without| == |o.stories|;
    var target := without[dest];
    assert numberedBelow(target, o.counter);
    assert dest == s ==> target == lessened;
    assert dest != s ==> target == o.stories[dest];
    RulesBelow(target, o.counter);
    RulesWithIs(target.rules, at, y);
    RuleIdsSplice(target.rules, at, y, o.counter, target.rules[..at] + [y] + target.rules[at..]);
    var placed := target.(rules := rulesWith(target.rules, at, y));
    BelowRules(placed, o.counter);
    StoriesReplacedIs(without, dest, placed);
    NumberedReplace(without, dest, placed, o.counter, without[..dest] + [placed] + without[dest + 1..]);
    var after := moveRule(o, s, r, dest, at);
    assert after.stories == without[..dest] + [placed] + without[dest + 1..];
    NumberedHolds(after);
    CountReplace((n: int, x: Story) => (n + |x.rules|), o.stories, s, lessened);
    CountReplace((n: int, x: Story) => (n + |x.rules|), without, dest, placed);
    assert ruleCount(after) == ruleCount(o);
  }
}
