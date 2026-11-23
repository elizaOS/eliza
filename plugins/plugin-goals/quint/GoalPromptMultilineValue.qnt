// evaluateGoalProgressWithLlm
// (plugins/plugin-goals/src/goal-semantic-evaluator.ts) prints the goal and
// the evidence into the semantic evaluator prompt with formatPromptValue
// (plugins/plugin-goals/src/goal-prompt-value.ts). A record key at nesting
// depth d is printed at column 2 * d. A value with a line break goes on the
// lines below its key; a list prints each item after a "- " marker.
// One text value sits in the goal record.
// depth: 0 a field of the goal itself (description), 1 a field of a nested
// record (successCriteria.notes), 2 a field two records deep
// (successCriteria.measure.notes). The key is printed at column 2 * depth.
// holder: 0 the key holds the text, 1 the key holds a list and the text is
// its only item (successCriteria.milestones, successCriteria.measure.milestones;
// the goal itself has no list field, so a list item has depth 1 or 2).
// lines: the text has 1, 2 or 3 lines.
// blank: the middle line of a 3-line text is empty.
// phase: 0 the prompt is not built yet, 1 the evaluator built the prompt.
// After the prompt is built:
// inline: the text is printed on the key's own line, after "key: " (a
// one-item list prints its "- " marker there too).
// column: the smallest column of a non-empty text line that starts a prompt
// line (NoLine when every text line follows "key: " or "- ").
// padded: an empty text line was printed as spaces.
// kept: the text lines without their leading spaces are the original text.
module GoalPromptMultilineValue {
  pure val Depths = 0.to(2)
  pure val Holders = 0.to(1)
  pure val Lines = 1.to(3)
  pure val NoLine = -1
  type Text = { depth: int, holder: int, lines: int, blank: bool }

  pure val Texts: Set[Text] = Depths.map(d => Holders.map(h => Lines.map(n =>
    Set(false, true).map(b => { depth: d, holder: h, lines: n, blank: b })
  ).flatten()).flatten()).flatten().filter(t => and {
    t.holder == 0 or t.depth >= 1,
    not(t.blank) or t.lines == 3,
  })

  var text: Text
  var phase: int
  var inline: bool
  var column: int
  var padded: bool
  var kept: bool

  // One-line text stays on the key's line.
  pure def onKeyLine(t: Text): bool = t.lines == 1
  // Every line of a field's multi-line text goes one level below the key; a
  // list item's lines after the first go at the item's level, two below.
  pure def startColumn(t: Text): int =
    if (t.lines == 1) NoLine
    else if (t.holder == 0) 2 * (t.depth + 1)
    else 2 * (t.depth + 2)

  action init = {
    nondet t = Texts.oneOf()
    all {
      text' = t,
      phase' = 0,
      inline' = false,
      column' = NoLine,
      padded' = false,
      kept' = false,
    }
  }
  // evaluateGoalProgressWithLlm builds the prompt once.
  action build = all {
    phase == 0,
    text' = text,
    phase' = 1,
    inline' = onKeyLine(text),
    column' = startColumn(text),
    padded' = false,
    kept' = true,
  }
  // The review may not have run yet.
  action stutter = all {
    text' = text,
    phase' = phase,
    inline' = inline,
    column' = column,
    padded' = padded,
    kept' = kept,
  }
  action step = any { build, stutter }

  val ModelState = {
    text: text,
    phase: phase,
    inline: inline,
    column: column,
    padded: padded,
    kept: kept,
  }
  temporal PromptBuiltWithoutFairness = (phase == 0).leadsTo(phase == 1)
  temporal PromptBuilt = build.weakFair(ModelState)
    .implies(PromptBuiltWithoutFairness)

  // No line of the text is printed in its key's column or left of it, so no
  // line reads as another field of the record.
  val LinesNestedUnderKey =
    phase == 0 or column == NoLine or column > 2 * text.depth
  // Only one-line text is printed on the key's line.
  val OneLineTextInline =
    phase == 0 or inline == onKeyLine(text)
  val BlankLineStaysEmpty = phase == 0 or not(padded)
  val TextKept = phase == 0 or kept
  val NothingPrintedBeforeBuild = phase == 1 or and {
    not(inline),
    column == NoLine,
    not(padded),
    not(kept),
  }
  val TypeOK = and {
    Texts.contains(text),
    Set(0, 1).contains(phase),
    column == NoLine or (column >= 2 and column <= 8),
  }
}
