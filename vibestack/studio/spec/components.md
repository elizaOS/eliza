# Preview the component catalog

The catalog is generated from the project's React components and their
metadata: their props, stories and links to source, model and design
document. This model selects a component and one of its stories. Search
text and temporary prop overrides stay in the page, which clears the
overrides whenever the selection changes. The prop controls show the chosen
story's arguments, or the component's defaults, until a person overrides
them. Model links select the spec; source and design links open their files
in the editor.

## Story: Inspect a component and its stories

> As a spec author, I want to find a component, choose one of its stories,
> and try its props, so that I can reuse the component and follow its links
> to source, the model and the design document.

### A catalog records how many stories each component has

The model keeps, for each component in the catalog's order, how many
stories it has, and the key of the catalog it holds. A component or story
is selected by its position; a position of minus one means there is no
selection.

```quint
type Selection = { key: str, counts: List[int], component: int, story: int }
pure def hasComponent(p: Selection, at: int): bool = 0 <= at and at < p.counts.length()
pure def hasStory(p: Selection, at: int): bool =
  hasComponent(p, p.component) and 0 <= at and at < p.counts.nthOr(p.component, 0)
```

### Before a catalog is loaded nothing is selected

```quint
pure val initial: Selection = { key: "", counts: List(), component: -1, story: -1 }
```

### Loading a catalog selects its first component and that component's first story

An empty catalog has no selection. A component without stories has no
selected story. Every story count is nonnegative. The key identifies the
ordered component and story identities: an unchanged key is refused, so a
refresh leaves the selected preview and its prop overrides in place.

```quint
pure def canLoad(p: Selection, counts: List[int], key: str): bool =
  key != p.key and counts.every(n => n >= 0)
pure def load(p: Selection, counts: List[int], key: str): Selection =
  { key: key, counts: counts, component: if (counts.length() > 0) 0 else -1,
    story: if (counts.nthOr(0, 0) > 0) 0 else -1 }
```

### Choosing a component selects its first story and clears prop overrides

Only a component in the catalog can be chosen; its first story is
selected, or none if it has no stories. The page clears its prop overrides
with the selection.

```quint
pure def canChooseComponent(p: Selection, at: int): bool = hasComponent(p, at)
pure def chooseComponent(p: Selection, at: int): Selection =
  { ...p, component: at, story: if (p.counts.nthOr(at, 0) > 0) 0 else -1 }
```

### Choosing a story stays within its component and clears prop overrides

Only a story of the selected component can be chosen, and the component
stays selected. The page clears its prop overrides with the selection.

```quint
pure def canChooseStory(p: Selection, at: int): bool = hasStory(p, at)
pure def chooseStory(p: Selection, at: int): Selection = { ...p, story: at }
```

### Every selected component and story exists in the loaded catalog

With no components nothing is selected. Otherwise a component is, and a
story of it unless it has none. Every story count is nonnegative.

```quint
pure def alwaysSelectionExists(p: Selection): bool =
  p.counts.every(n => n >= 0) and
  (if (p.counts.length() == 0) p.component == -1 and p.story == -1
   else hasComponent(p, p.component) and
     (if (p.counts.nthOr(p.component, 0) == 0) p.story == -1 else hasStory(p, p.story)))
```

### A component without stories and a later story can both be inspected

A later story is one after the first, of a component after the first.

```quint
pure def sometimesNoStory(p: Selection): bool = hasComponent(p, p.component) and p.story == -1
pure def sometimesLaterStory(p: Selection): bool = p.component > 0 and p.story > 0
```
