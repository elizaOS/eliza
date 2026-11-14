# All the projects

The dashboard stores just one thing itself: the list of projects, each naming
the shared spreadsheet that holds its tasks and the chat channel where it is
discussed. All other data lives in the spreadsheets.

## Domain

### A project entry

```quint
type Writer = Admin | Sheet
type Entry = { key: str, sheet: str, channel: str }
type Registry = { entries: List[Entry], last: Writer }

pure val initial: Registry = { entries: List(), last: Admin }
```

### What the simulator tries

Three project keys, three spreadsheets, two channels, and the empty value of
each, plus four registries.

```quint
pure val keyValues = Set("", "a", "b", "c")
pure val sheetValues = Set("", "S1", "S2", "S3")
pure val channelValues = Set("", "C1", "C2")
pure val rValues = Set(
  { entries: List(), last: Admin },
  { entries: List({ key: "a", sheet: "S1", channel: "C1" }), last: Admin },
  { entries: List({ key: "a", sheet: "S1", channel: "C1" }, { key: "b", sheet: "S2", channel: "C1" }), last: Sheet },
  { entries: List({ key: "a", sheet: "S1", channel: "C1" }, { key: "b", sheet: "S2", channel: "C2" }), last: Admin },
)
```

## Story: Connect a sheet as a project

> As an administrator, I want to register a spreadsheet and a chat channel
> as a project, and be stopped if either is already used by another project.

### A sheet is connected as at most one project

Two projects sharing a spreadsheet would hand out the same task numbers.

```quint
pure def hasKey(r: Registry, key: str): bool = r.entries.some(e => e.key == key)

pure def channelIsFree(r: Registry, key: str, channel: str): bool =
  channel == "" or r.entries.every(e => e.key == key or e.channel != channel)

pure def canConnect(r: Registry, key: str, sheet: str, channel: str): bool =
  key != "" and sheet != "" and not(hasKey(r, key))
    and r.entries.every(e => e.sheet != sheet) and channelIsFree(r, key, channel)

pure def connect(r: Registry, key: str, sheet: str, channel: str): Registry =
  { entries: r.entries.append({ key: key, sheet: sheet, channel: channel }), last: Admin }

pure def alwaysASheetHasOneProject(r: Registry): bool =
  r.entries.every(a => r.entries.select(b => b.sheet == a.sheet).length() == 1)
```

### A project key names one project

Commands and links name a project by its key.

```quint
pure def alwaysAKeyNamesOneProject(r: Registry): bool =
  r.entries.every(a => r.entries.select(b => b.key == a.key).length() == 1)
```

### Every project has a key and a sheet

An empty key would read as "no project" where the dashboard answers which
project a channel means, and an empty sheet names no spreadsheet.

```quint
pure def alwaysEveryProjectHasAKeyAndASheet(r: Registry): bool =
  r.entries.every(e => e.key != "" and e.sheet != "")
```

### Two projects can be connected

```quint
pure def sometimesTwoProjectsAreConnected(r: Registry): bool = r.entries.length() >= 2 and r.last == Admin
```

### A project can be disconnected

```quint
pure def canDisconnect(r: Registry, key: str): bool = hasKey(r, key)

pure def disconnect(r: Registry, key: str): Registry =
  { entries: r.entries.select(e => e.key != key), last: Admin }
```

## Story: Know which project a channel means

> As someone running the `/tasks` command in a channel, I want the dashboard
> to use that channel's project, and to ask instead of guessing when it is
> unclear.

### The admin screen never gives two projects the same channel

A project whose channel the admin screen sets, or that it connects, does not
share that channel with any other project. A channel shared by hand edits may
stay shared. An empty channel is no channel, and any number of projects may
have one.

```quint
pure def canSetChannel(r: Registry, key: str, channel: str): bool =
  hasKey(r, key) and channelIsFree(r, key, channel)

pure def setChannel(r: Registry, key: str, channel: str): Registry =
  { entries: r.entries.listMap(e => if (e.key == key) { ...e, channel: channel } else e), last: Admin }

pure def stepTheAdminScreenNeverSharesAChannel(before: Registry, after: Registry): bool =
  after.last == Admin implies after.entries.every(a =>
    a.channel == ""
      or before.entries.some(b => b.key == a.key and b.channel == a.channel)
      or after.entries.every(b => b.key == a.key or b.channel != a.channel))
```

### A channel typed into a sheet by hand is accepted, even if another project has it

The channel of a project is stored in a cell of its spreadsheet, so anyone
can type any value there.

```quint
pure def canHandSetChannel(r: Registry, key: str, channel: str): bool = hasKey(r, key)

pure def handSetChannel(r: Registry, key: str, channel: str): Registry =
  { entries: r.entries.listMap(e => if (e.key == key) { ...e, channel: channel } else e), last: Sheet }

pure def sharedChannels(r: Registry): List[str] =
  r.entries.select(a => a.channel != "" and r.entries.some(b => b.key != a.key and b.channel == a.channel))
    .listMap(e => e.channel)

pure def sometimesTwoProjectsClaimAChannel(r: Registry): bool = sharedChannels(r).length() > 0
```

### The dashboard never guesses which project a shared channel means

It returns the single project that claims the channel, and nothing when no
project or more than one does. Since no project has an empty key, an answer
is never mistaken for nothing.

```quint
pure def claimants(r: Registry, channel: str): List[Entry] =
  r.entries.select(e => channel != "" and e.channel == channel)

pure def projectFor(r: Registry, channel: str): str =
  if (claimants(r, channel).length() == 1) claimants(r, channel).nth(0).key else ""

pure def lawAnAnswerIsTheOnlyClaimant(r: Registry, channel: str): bool =
  r.entries.every(e => e.key != "") implies
    ((claimants(r, channel).length() == 1)
      iff (projectFor(r, channel) != "" and claimants(r, channel).every(e => e.key == projectFor(r, channel))))

```

### A channel can name a project

```quint
pure def sometimesAChannelNamesAProject(r: Registry): bool =
  r.entries.some(e => e.channel != "" and projectFor(r, e.channel) == e.key)
```
