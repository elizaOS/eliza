# Grammar character-class escapes

This migrates `quint/GrammarClassEscape.qnt` and the planner GBNF schema compiler. Both pinned llama.cpp parsers accept the shared escape subset. Literal hyphen and caret use hexadecimal escapes, closing brackets use an escape, ranges remain ranges, and unsupported classes retain the general JSON-string grammar.

## Story: Compile model input schemas to portable grammar classes

As a model provider, I want character classes to preserve their literal or range meaning across supported native parsers.

### Portable escaping preserves literal members and range structure

Actual character bytes and parser loading remain implementation validation obligations. The model fixes the semantic class of each emitted token for both supported parser variants.

```quint
type ClassMember = Plain | Hyphen | Caret | ClosingBracket | RangeMember
type GrammarToken = Raw | HexEscape | BackslashEscape | RawRange
pure def encodeMember(member: ClassMember): GrammarToken = if (member == Hyphen or member == Caret) HexEscape else if (member == ClosingBracket) BackslashEscape else if (member == RangeMember) RawRange else Raw
pure def parserAccepts(token: GrammarToken, member: ClassMember, forkParser: bool): bool = token != BackslashEscape or member == ClosingBracket or (forkParser and member == Hyphen)
pure def lawPortableClassLoads(member: ClassMember, forkParser: bool): bool = parserAccepts(encodeMember(member), member, forkParser)
pure def lawRangeRemainsRange(member: ClassMember): bool = member == RangeMember implies encodeMember(member) == RawRange
pure def lawLiteralMetacharactersAreHex(member: ClassMember): bool = (member == Hyphen or member == Caret) implies encodeMember(member) == HexEscape
```
