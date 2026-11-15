// escapeGbnfClassChar writes each member of a `pattern` character class into
// the strict planner grammar, and a pinned llama.cpp grammar parser reads it.
module GrammarClassEscape {
  // member (the last member of the class `[a<member>]`): 0 a plain character,
  // 1 a literal hyphen, 2 a literal caret, 3 a closing bracket, 4 a range b-c.
  // A class with `"`, a backslash or a control character keeps jsonstring and
  // is not compiled.
  // parser: 0 the elizaOS/llama.cpp fork at the plugin-local-inference
  // submodule pin, 1 the copy bundled in llama-cpp-capacitor 0.1.5.
  // token: 0 the raw character, 1 a \xNN hex escape, 2 the character after a
  // backslash, 3 a raw range.
  // read: -1 nothing, else the member the parser reads back.
  var member: int
  var parser: int
  var phase: int
  var token: int
  var loaded: bool
  var read: int

  action init = {
    nondet chosenMember = 0.to(4).oneOf()
    nondet chosenParser = Set(0, 1).oneOf()
    all {
      member' = chosenMember, parser' = chosenParser, phase' = 0,
      token' = 0, loaded' = false, read' = -1
    }
  }

  // escapeGbnfClassChar: hex for `-` and `^`, a backslash before `]`. The
  // class parser writes a range as two raw endpoints around a raw `-`.
  pure def write(m: int): int =
    if (m == 1 or m == 2) 1
    else if (m == 3) 2
    else if (m == 4) 3
    else 0

  // parse_char: both parsers read \x \u \U \t \r \n \\ \" \[ \]; the fork
  // pin also reads \-. Any other escape rejects the whole grammar.
  pure def reads(p: int, t: int, m: int): bool =
    t != 2 or m == 3 or (p == 0 and m == 1)

  action writeClass = all {
    phase == 0, phase' = 1, member' = member, parser' = parser,
    token' = write(member), loaded' = loaded, read' = read
  }
  action load = all {
    phase == 1, phase' = 2, member' = member, parser' = parser,
    token' = token, loaded' = reads(parser, token, member),
    read' = if (reads(parser, token, member)) member else -1
  }
  action stay = all {
    phase == 2, phase' = phase, member' = member, parser' = parser,
    token' = token, loaded' = loaded, read' = read
  }
  action step = any { writeClass, load, stay }

  val Loads = phase != 2 or loaded
  val ReadsBackMember = phase != 2 or read == member
  val HexHyphenAndCaret =
    phase == 0 or not(member == 1 or member == 2) or token == 1
  val RangeStaysRange = phase == 0 or member != 4 or token == 3
}
