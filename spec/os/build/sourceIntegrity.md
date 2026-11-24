# Pinned source integrity

A consumer vendors Eliza at a commit it pins and builds its Android host from
that checkout. `@elizaos/os` exports `verifyCommittedWorkspace`, which
authenticates a prepared checkout against the pin, and
`exportCommittedSources`, which copies pinned paths out of the commit
(`src/build/source-integrity.vibe`). The sources are develop's
`packages/app/scripts/lib/immutable-workspace-source.mjs` and
`committed-source.mjs`, and the cache seed of one consumer. Git and
filesystem reads stay in the shell, which parses every pin and HEAD as a
lowercase 40-hex commit before it reaches these rules; this spec decides
what those reads admit.

## Story: Build only from the committed tree I pinned

> As a consumer, I want my build to use exactly the Eliza commit I pinned,
> so that local edits, extra files or a reused cache never change what I
> build.

### A tracked entry is admitted only with its committed bytes, kind and execute bits

The shell reads every entry of the pinned tree, ignored tracked files
included, and hashes the file on disk as a Git blob. A link must still be a
link to the recorded target bytes; an ordinary or executable file must not be
a link, and its execute bits under the mask `executeBits` (octal 111) must
be all set or all clear as recorded. A submodule entry is admitted without
reading the nested checkout, which this verifier does not authenticate.

```quint
type EntryMode = RegularEntry | ExecutableEntry | LinkEntry | SubmoduleEntry
type FileKind = RegularFile | LinkFile | MissingFile | OtherFile
pure val executeBits = 73
pure val execBitsValues = Set(0, 1, 64, 73)
pure def trackedEntryAdmitted(mode: EntryMode, file: FileKind, digestMatches: bool, execBits: int): bool =
  if (mode == SubmoduleEntry) true
  else if (mode == LinkEntry) file == LinkFile and digestMatches
  else file == RegularFile and digestMatches and execBits == (if (mode == ExecutableEntry) executeBits else 0)
pure def lawAdmittedEntryHasCommittedBytes(mode: EntryMode, file: FileKind, digestMatches: bool, execBits: int): bool =
  (trackedEntryAdmitted(mode, file, digestMatches, execBits) and mode != SubmoduleEntry) implies digestMatches
pure def lawTrackedFileCannotBecomeLink(mode: EntryMode, digestMatches: bool, execBits: int): bool =
  (mode == RegularEntry or mode == ExecutableEntry) implies not(trackedEntryAdmitted(mode, LinkFile, digestMatches, execBits))
```

### A workspace is exact only when tracked files, the diff and extra files all pass on their own

The host names its generated files and directories as explicit
workspace-relative paths: no empty, `.` or `..` segment. Extra files are
listed with ignored files included. Each must be a host-named file, a strict
descendant of a host-named directory, a dependency directory, the task
cache, a task log, or a literal `dir/**` output that a task of its workspace
declares; a directory prefix never matches a sibling whose name only starts
the same way. An allowance admits extra files only: it can never excuse a
changed tracked file or a diff against the pin.

```quint
type WorkspaceFinding = Exact | UnsafeAllowance | RootMismatch | TrackedChanged | DiffPresent | UnexpectedExtra
pure def explicitPath(segments: List[str]): bool = segments.length() > 0 and segments.every(x => x != "" and x != "." and x != "..")
pure def workspaceFinding(allowances: List[List[str]], rootExact: bool, trackedAdmitted: bool, diffClean: bool, extrasAdmitted: bool): WorkspaceFinding =
  if (not(allowances.every(p => explicitPath(p)))) UnsafeAllowance
  else if (not(rootExact)) RootMismatch
  else if (not(trackedAdmitted)) TrackedChanged
  else if (not(diffClean)) DiffPresent
  else if (not(extrasAdmitted)) UnexpectedExtra
  else Exact
pure def lawTrackedAndExtraCheckedSeparately(allowances: List[List[str]], rootExact: bool, trackedAdmitted: bool, diffClean: bool, extrasAdmitted: bool): bool =
  workspaceFinding(allowances, rootExact, trackedAdmitted, diffClean, extrasAdmitted) == Exact implies (rootExact and trackedAdmitted and diffClean and extrasAdmitted)
```

### A cache copy or a checkout is admitted only by verifying the destination against the pin

A local cache at the pinned commit may seed the destination; a missing,
mismatched or sparse cache falls back to an ordinary checkout. A cache with
tracked edits, or one that changes while it is copied, refuses the source
instead of being overwritten. Whatever its origin, the destination is
admitted only when the verifier finds it exact and its HEAD is the pin.
Verification runs again before staging and once more after it; a failed
check retires the admission.

```quint
type SeedFinding = NoUsableCache | CacheCopied | CacheDrifted
type SourceOrigin = NotChosen | FromCache | FromCheckout
type SourcePhase = Unchosen | Fetched | Admitted | Staging | Ready | Refused
type PreparedSource = { phase: SourcePhase, pin: str, origin: SourceOrigin }
pure val initial: PreparedSource = { phase: Unchosen, pin: "", origin: NotChosen }
pure val pinValues = Set("", "c1")
pure val headCommitValues = Set("c1", "c2")
pure def canChoose(s: PreparedSource, pin: str): bool = s.phase == Unchosen and pin != ""
pure def choose(s: PreparedSource, pin: str, seed: SeedFinding): PreparedSource =
  { phase: if (seed == CacheDrifted) Refused else Fetched, pin: pin, origin: if (seed == NoUsableCache) FromCheckout else FromCache }
pure def canVerify(s: PreparedSource): bool = s.phase == Fetched or s.phase == Admitted or s.phase == Staging
pure def verify(s: PreparedSource, headCommit: str, finding: WorkspaceFinding): PreparedSource =
  if (finding == Exact and headCommit == s.pin) { ...s, phase: if (s.phase == Staging) Ready else Admitted }
  else { ...s, phase: Refused }
pure def canBeginStaging(s: PreparedSource): bool = s.phase == Admitted
pure def beginStaging(s: PreparedSource): PreparedSource = { ...s, phase: Staging }
pure def alwaysChosenSourceNamesPinAndOrigin(s: PreparedSource): bool =
  (s.phase == Unchosen) == (s.pin == "") and (s.phase == Unchosen) == (s.origin == NotChosen)
pure def stepAdmissionComesFromVerification(before: PreparedSource, via: str, after: PreparedSource): bool =
  ((after.phase == Admitted and before.phase != Admitted) implies (via == "verify" and before.phase == Fetched)) and
  ((after.phase == Ready and before.phase != Ready) implies (via == "verify" and before.phase == Staging))
pure def stepPinAndOriginAreFixed(before: PreparedSource, after: PreparedSource): bool =
  before.phase != Unchosen implies (after.pin == before.pin and after.origin == before.origin)
pure def sometimesCacheCopyReady(s: PreparedSource): bool = s.phase == Ready and s.origin == FromCache
pure def sometimesCheckoutAdmitted(s: PreparedSource): bool = s.phase == Admitted and s.origin == FromCheckout
pure def sometimesChangedCheckoutRefused(s: PreparedSource): bool = s.phase == Refused and s.origin == FromCheckout
```

### A ready or refused source never changes again

A refused source is never admitted later; the consumer prepares a new one.

```quint
pure def stepFinishedSourceStays(before: PreparedSource, after: PreparedSource): bool =
  (before.phase == Ready or before.phase == Refused) implies after == before
```

## Story: Export pinned files without my local edits

> As a consumer, I want to copy pinned Eliza paths into my bundle from the
> commit itself, so that edits in my checkout never enter what I ship.

### An export returns the pinned commit only after the committed paths are extracted

The source must be the checkout root and the path list nonempty, each path
explicit. The shell archives the paths from the commit, never from the
working tree, so local edits to the same paths are not read; it returns the
commit only once extraction has succeeded.

```quint
type ExportOutcome = Exported({ commit: str }) | ExportRefused
pure def exportOutcome(commit: str, rootExact: bool, paths: List[List[str]], extracted: bool): ExportOutcome =
  if (commit != "" and rootExact and paths.length() > 0 and paths.every(p => explicitPath(p)) and extracted) Exported({ commit: commit }) else ExportRefused
pure def lawFailedExtractionReturnsNoCommit(commit: str, rootExact: bool, paths: List[List[str]]): bool =
  exportOutcome(commit, rootExact, paths, false) == ExportRefused
```

## Story: Build and register only the plugins my host selected

> As a consumer, I want the generated Android host to include only my
> chosen native modules and to leave authored files in my checkout intact.

### The host profile chooses native modules and names their source roots

`android/consumer-host.mjs` builds from an explicit identity, native module
list, source sets, manifests, resources and distribution variants. Module
names are unique and the app module name is reserved. Inputs must match
their declared consumer, upstream or dependency root, including after
following links, and be the requested file or directory. The module list
supplies the bridge's build evidence. The Activity's registration supplies
the separate runtime evidence.

```quint
pure def hostModuleAdmitted(nameAllowed: bool, uniqueName: bool, inputInDeclaredRoot: bool, directory: bool): bool =
  nameAllowed and uniqueName and inputInDeclaredRoot and directory
pure def lawHostModulesCannotEscapeTheirRoot(nameAllowed: bool, uniqueName: bool, directory: bool): bool =
  not(hostModuleAdmitted(nameAllowed, uniqueName, false, directory))
```

### Host generation writes only its owned outputs

The generated working directory stays outside the upstream checkout. An
explicit in-place build can use the consumer's own Android project. It
retains authored inputs already at their expected paths and replaces only
files identified as generated by the host inventory.

```quint
pure def hostOutputAdmitted(outsideUpstream: bool, vacant: bool, previouslyGenerated: bool, currentInput: bool): bool =
  outsideUpstream and not(currentInput) and (vacant or previouslyGenerated)
pure def lawAnAuthoredInputIsNeverReplaced(outsideUpstream: bool, vacant: bool, previouslyGenerated: bool): bool =
  not(hostOutputAdmitted(outsideUpstream, vacant, previouslyGenerated, true))
```
