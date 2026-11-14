# AlphaPhone browser request grounding

Alpha's projected source uses
`packages/contracts/src/browser-request-grounding.ts` at Eliza
`c518127a025ab173874af9c7d304f26b25213b0d`. The [browser adapter](./alpha/browser.md)
owns browser visits. This contract owns admission from the current message.

## Story: Open a destination stated in this message

### A negated destination cannot be authorized by a proposal

A whole-message strict command can bypass model judgment. A recognized
direct question, everyday command, or bare address can be offered through
the direct client route. A URL mention supplies grounding evidence for a
model proposal without authorizing automatic navigation. A refused or
negated occurrence vetoes the host even if another occurrence asks to open
it, including host spellings that are recognized as words but refused as
URLs. A proposed HTTPS destination must have the same normalized host
and port as an admitted user-written candidate. Address, path and query
evidence select among the user's candidates. Exact href wins, then the
same authored path and query, then a bare address of the same hostname,
then a bare address with equivalent leading-www normalization. Result
spelling always comes from the selected user address. A bare host cannot
grant a model-invented path. Typed file-extension-like suffixes require
the producer's affirmative web signal. The model projects syntax,
normalization and order from a decoder. The concrete recognizer still
needs fixture replay, including unreadable control characters, Unicode
dots, and negation around quoted or formatted host words.

```quint
type GroundedAddress = { authoredHref: str, qualifies: bool, rank: int }
pure val noGroundedAddress: GroundedAddress = { authoredHref: "", qualifies: false, rank: 0 }
pure def candidatesAtRank(rank: int, candidates: List[GroundedAddress]): List[GroundedAddress] =
  candidates.select(c => c.qualifies and c.rank == rank)
pure def orderedDestination(candidates: List[GroundedAddress]): GroundedAddress =
  candidatesAtRank(1, candidates).concat(candidatesAtRank(2, candidates)).concat(candidatesAtRank(3, candidates)).concat(candidatesAtRank(4, candidates)).nthOr(0, noGroundedAddress)
pure def groundProposedDestination(readable: bool, https: bool, vetoed: bool, candidates: List[GroundedAddress]): str =
  if (readable and https and not(vetoed)) orderedDestination(candidates).authoredHref else ""
pure def directDestination(readable: bool, classifiedDirect: bool, directHref: str): str =
  if (readable and classifiedDirect) directHref else ""
pure val candidatesValues = Set(
  List(),
  List({ authoredHref: "https://example.com/", qualifies: true, rank: 3 }),
  List({ authoredHref: "https://example.com/first", qualifies: true, rank: 2 }, { authoredHref: "https://example.com/second", qualifies: true, rank: 1 })
)
pure def lawNegationVetoesGrounding(readable: bool, https: bool, candidates: List[GroundedAddress]): bool =
  groundProposedDestination(readable, https, true, candidates) == ""
pure def lawMentionDoesNotEnableDirect(readable: bool, directHref: str): bool =
  directDestination(readable, false, directHref) == ""
pure def lawGroundingPreservesAuthoredSpelling(readable: bool, https: bool, vetoed: bool, candidates: List[GroundedAddress]): bool = {
  val result = groundProposedDestination(readable, https, vetoed, candidates)
  result != "" implies candidates.some(c => c.qualifies and c.authoredHref == result)
}
```
