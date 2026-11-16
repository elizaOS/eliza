# App

What the application in `apps/app` does: it greets a person by name, says
hello, and counts the greetings. What it says is in [Words](./words.md); as
far as counting goes it is a [Tally](./tally.md). [Echo](./echo.md) is how a
hello would be answered over a network.

## Story: Say hello

> As a visitor, I want to type my name, or open a link with it, and be
> greeted, so that I know the page heard me.

### A greeter holds the last name it greeted and how many greetings it gave

It starts with no name and no greetings. A name comes typed into the page or
in the link the page was opened with, which the program knows from where it
read it, never from the event.

```quint
import tally as T from "./tally"
import words.* from "./words"

type Via = Typed | Linked
type Greeter = { name: str, count: int }
type Greeted = { state: Greeter, out: List[Said] }

pure val initial: Greeter = { name: "", count: 0 }
pure val nameValues = Set("", "Ada", "Grace")
```

### Only a name that is not empty can be greeted, and a link greets only a name not greeted last

Greeting a name remembers it, counts one more greeting and says hello to it.
Opening the same link again, as a reload does, greets no one.

```quint
pure def canGreet(g: Greeter, name: str, by: Via): bool = name != "" and (by == Typed or name != g.name)

pure def greet(g: Greeter, name: str, by: Via): Greeted =
  { state: { name: name, count: g.count + 1 }, out: List(hello(name)) }
```

### Once someone has been greeted, the greeter holds a name

```quint
pure def alwaysGreetedHasName(g: Greeter): bool = g.count > 0 implies g.name != ""
```

### The number of greetings is never negative

Discovered by proof: the initial count is zero and each greeting adds one,
so a saved negative count cannot represent a history of this greeter.

```quint
pure def alwaysCountIsNonnegative(g: Greeter): bool = g.count >= 0
```

### Every step adds exactly one greeting

```quint
pure def stepCountsOne(before: Greeter, after: Greeter): bool = after.count == before.count + 1
```

### Every step says hello to the name it greeted, once

```quint
pure def stepSaysHello(before: Greeter, after: Greeter, out: List[Said]): bool = out == List(hello(after.name))
```

### A greeting is for the name it was given

Whoever the greeter greeted before, and however the name came, a greeting
holds the name given to it.

```quint
pure def lawGreetsTheNameGiven(g: Greeter, name: str, by: Via): bool = greet(g, name, by).state.name == name
```

### The greeter can give a second greeting

At least two greetings in all, to the same name or to different ones.

```quint
pure def sometimesGreetedTwice(g: Greeter): bool = g.count >= 2
```

### As a tally, a greeter is its count

```quint
pure def refinesT(g: Greeter): T::Tally = { greetings: g.count }
```
