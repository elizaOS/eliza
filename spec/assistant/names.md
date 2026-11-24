# Names

How the owner's words name one of the things the assistant keeps for
them, a [reminder](./reminders.md) or a [goal](./goals.md), when a
request changes or reads one.

## Story: Name what I keep without repeating its whole title

> As an owner, I want to change a reminder or a goal by saying its title
> loosely, or a few of its words, and never to have the change land on a
> guess between two of them.

### A title that is the name wins, and otherwise the titles that hold the name's words are the candidates

A request names an item by its id, or by its title compared without
case, punctuation or extra spaces. When no title is the name, the titles
that hold the name's words in order are the candidates, as "the dentist"
names "Call the dentist". A title that is the name wins over titles that
only hold it. The request applies only when exactly one item is named;
with none or several nothing changes, and the reply lists the candidates.

```quint
pure def namedCount(sameTitle: int, holdingTitle: int): int = if (sameTitle > 0) sameTitle else holdingTitle
pure def namesOne(sameTitle: int, holdingTitle: int): bool = namedCount(sameTitle, holdingTitle) == 1
pure def lawATitleThatIsTheNameWins(sameTitle: int, holdingTitle: int): bool =
  sameTitle > 0 implies namedCount(sameTitle, holdingTitle) == sameTitle
pure def lawSeveralTitlesHoldingTheNameChangeNothing(holdingTitle: int): bool = holdingTitle > 1 implies not(namesOne(0, holdingTitle))
pure def lawNoTitleNamedChangesNothing(holdingTitle: int): bool = holdingTitle <= 0 implies not(namesOne(0, holdingTitle))
```
