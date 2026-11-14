# The outline of one spec

The studio shows one spec at a time as an outline: its title and
introduction, then its stories in order, each with its rules in order. Every
change a person makes is an event on that outline, and the page offers only
the events the outline allows. Text arrives whole: the page sends a heading
as it was typed, trimmed, and a body as a Markdown block, and the outline
keeps each as it is.

## Domain

### A story and its rules

Each story and rule has a number, given when it is added and kept while it
moves, and the key it had on disk when the spec was loaded, or none if it
was added here. The number tells the page which story or rule is which; the
key tells the agent what each one was.

```quint
type Rule = { id: int, title: str, body: str, origin: str }
type Story = { id: int, title: str, body: str, origin: str, rules: List[Rule] }
type Outline = { title: str, body: str, stories: List[Story], counter: int }
```

### A new spec's outline is empty

A spec on disk is loaded as an outline that keeps every rule below.

```quint
pure val initial: Outline = { title: "", body: "", stories: List(), counter: 1 }
```

### Positions

A story is found by its position in the outline, and a rule by its story's
position and its own.

```quint
pure val noRule: Rule = { id: 0, title: "", body: "", origin: "" }
pure val noStory: Story = { id: 0, title: "", body: "", origin: "", rules: List() }
pure def storyAt(o: Outline, s: int): Story = o.stories.nthOr(s, noStory)
pure def hasStory(o: Outline, s: int): bool = 0 <= s and s < o.stories.length()
pure def hasRule(o: Outline, s: int, r: int): bool = hasStory(o, s) and 0 <= r and r < storyAt(o, s).rules.length()

// `xs` with `x` placed at position `at`, or after the last if `at` is past it. Until `x` is placed, what is built
// so far is exactly as long as the position of the next item.
pure def storiesWith(xs: List[Story], at: int, x: Story): List[Story] =
  val placed = xs.foldl(List(), (acc, y) => if (acc.length() == at) acc.append(x).append(y) else acc.append(y))
  if (at < xs.length()) placed else placed.append(x)

pure def rulesWith(xs: List[Rule], at: int, x: Rule): List[Rule] =
  val placed = xs.foldl(List(), (acc, y) => if (acc.length() == at) acc.append(x).append(y) else acc.append(y))
  if (at < xs.length()) placed else placed.append(x)

pure def storiesReplaced(xs: List[Story], s: int, x: Story): List[Story] = storiesWith(xs.removeAt(s), s, x)
```

### What the simulator tries

```quint
pure val sValues = Set(-1, 0, 1, 2)
pure val rValues = Set(-1, 0, 1)
pure val destValues = Set(0, 1, 2)
pure val atValues = Set(0, 1, 2, 3)
pure val titleValues = Set("", "Pay", "Ship")
pure val bodyValues = Set("", "As a shopper")
pure val originValues = Set("", "## Story: Pay")
```

## Story: Shape the outline

> As a spec author, I want to add, rename, remove and reorder the stories of
> a spec, so that it tells them in the order I mean.

### The spec's title and introduction can be changed

```quint
pure def retitle(o: Outline, title: str, body: str): Outline = { ...o, title: title, body: body }
```

### A story can be added anywhere, empty or with the text it had elsewhere

A story moved here from another spec arrives with its text and its key, and
its rules follow one at a time.

```quint
pure def canAddStory(o: Outline, at: int): bool = 0 <= at and at <= o.stories.length()
pure def addStory(o: Outline, at: int, title: str, body: str, origin: str): Outline =
  { ...o, stories: storiesWith(o.stories, at, { id: o.counter, title: title, body: body, origin: origin, rules: List() }), counter: o.counter + 1 }
```

### A story's heading and text can be changed

```quint
pure def canEditStory(o: Outline, s: int): bool = hasStory(o, s)
pure def editStory(o: Outline, s: int, title: str, body: str): Outline =
  { ...o, stories: storiesReplaced(o.stories, s, { ...storyAt(o, s), title: title, body: body }) }
```

### Removing a story removes its rules with it

```quint
pure def canRemoveStory(o: Outline, s: int): bool = hasStory(o, s)
pure def removeStory(o: Outline, s: int): Outline = { ...o, stories: o.stories.removeAt(s) }
```

### A story can be moved to any position, and its rules move with it

```quint
pure def canMoveStory(o: Outline, s: int, dest: int): bool = hasStory(o, s) and hasStory(o, dest)
pure def moveStory(o: Outline, s: int, dest: int): Outline =
  { ...o, stories: storiesWith(o.stories.removeAt(s), dest, storyAt(o, s)) }
```

### Only retitling changes the spec's title and introduction

```quint
pure def stepHeadChangesOnlyByRetitling(before: Outline, via: str, after: Outline): bool =
  via != "retitle" implies (after.title == before.title and after.body == before.body)
```

### An outline can hold several stories, each with rules

```quint
pure def sometimesSeveralStoriesWithRules(o: Outline): bool =
  o.stories.length() >= 2 and o.stories.every(x => x.rules.length() >= 1)
```

## Story: Group rules under stories

> As a spec author, I want to add, rename, remove and reorder the rules of a
> story, and move a rule to another story, so that each story holds the
> rules it implies.

### A rule can be added anywhere in a story, empty or with the text it had elsewhere

```quint
pure def canAddRule(o: Outline, s: int, at: int): bool = hasStory(o, s) and 0 <= at and at <= storyAt(o, s).rules.length()
pure def addRule(o: Outline, s: int, at: int, title: str, body: str, origin: str): Outline =
  val st = storyAt(o, s)
  { ...o, stories: storiesReplaced(o.stories, s, { ...st, rules: rulesWith(st.rules, at, { id: o.counter, title: title, body: body, origin: origin }) }), counter: o.counter + 1 }
```

### A rule's heading and body can be changed

The body is the rule's prose and its Quint blocks, as Markdown.

```quint
pure def canEditRule(o: Outline, s: int, r: int): bool = hasRule(o, s, r)
pure def editRule(o: Outline, s: int, r: int, title: str, body: str): Outline =
  val st = storyAt(o, s)
  val rule = st.rules.nthOr(r, noRule)
  { ...o, stories: storiesReplaced(o.stories, s, { ...st, rules: rulesWith(st.rules.removeAt(r), r, { ...rule, title: title, body: body }) }) }
```

### A rule can be removed

```quint
pure def canRemoveRule(o: Outline, s: int, r: int): bool = hasRule(o, s, r)
pure def removeRule(o: Outline, s: int, r: int): Outline =
  val st = storyAt(o, s)
  { ...o, stories: storiesReplaced(o.stories, s, { ...st, rules: st.rules.removeAt(r) }) }
```

### A rule can be moved to any position of any story, keeping its number and key

`at` is the rule's position in the story it moves to, counted without it.

```quint
pure def canMoveRule(o: Outline, s: int, r: int, dest: int, at: int): bool =
  hasRule(o, s, r) and hasStory(o, dest) and 0 <= at
  and at <= storyAt(o, dest).rules.length() - (if (dest == s) 1 else 0)
pure def moveRule(o: Outline, s: int, r: int, dest: int, at: int): Outline =
  val st = storyAt(o, s)
  val rule = st.rules.nthOr(r, noRule)
  val without = storiesReplaced(o.stories, s, { ...st, rules: st.rules.removeAt(r) })
  val target = without.nthOr(dest, noStory)
  { ...o, stories: storiesReplaced(without, dest, { ...target, rules: rulesWith(target.rules, at, rule) }) }
```

### A new story or rule takes a number no story or rule has

Every story and rule has a number below the counter, and the counter never
goes back, so the counter, which a new story or rule takes, is above every
number in use.

```quint
pure def numberedBelow(x: Story, c: int): bool =
  1 <= x.id and x.id < c and x.rules.every(y => 1 <= y.id and y.id < c)
pure def alwaysNumberedBelowTheCounter(o: Outline): bool =
  o.counter >= 1 and o.stories.every(x => numberedBelow(x, o.counter))
pure def stepCounterNeverGoesBack(before: Outline, after: Outline): bool = after.counter >= before.counter
```

### A move keeps the number of stories and of rules

```quint
pure def ruleCount(o: Outline): int = o.stories.foldl(0, (n, x) => n + x.rules.length())
pure def stepMovesKeepEverything(before: Outline, via: str, after: Outline): bool =
  (via == "moveStory" or via == "moveRule") implies
    (after.stories.length() == before.stories.length() and ruleCount(after) == ruleCount(before))
```

## Story: Publish only what reads as a spec

> As a spec author, I want the studio to stop me publishing a spec whose
> headings would be read differently from what I see, so that what the agent
> and the checks read is what I wrote.

### Every story and rule needs a heading, unique where it is

A story's heading is its key in the spec, and a rule's is its key within its
story, so two that share one would be read as one. While a person types, the
outline lets a heading be empty or repeat another; the page publishes a spec
only when this holds of it.

```quint
pure def headingsAreSound(o: Outline): bool =
  o.stories.every(x =>
    x.title != "" and o.stories.select(y => y.title == x.title).length() == 1
    and x.rules.every(r => r.title != "" and x.rules.select(q => q.title == r.title).length() == 1))
```

### An outline can have headings that would not publish

```quint
pure def sometimesHeadingsClash(o: Outline): bool = o.stories.length() >= 2 and not(headingsAreSound(o))
```
