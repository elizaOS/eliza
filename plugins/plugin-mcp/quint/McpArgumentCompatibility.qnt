// The MCP call_tool action fills a tool's arguments with the model
// (plugins/plugin-mcp/src/utils/selection.ts createToolSelectionArgument) and
// retries through withModelRetry until they validate or three attempts are
// used. McpService (src/service.ts) can rewrite a tool's input schema for the
// runtime's model provider (src/tool-compatibility): the rewrite removes the
// keywords that provider does not accept and restates them in descriptions.
// The argument prompt shows that rewrite; the arguments are validated against
// the schema the server published, so the server only receives arguments that
// schema accepts.
// One case: the fixture tool "explicit" (a [string, integer] pair with
// minItems/maxItems 2 and additionalProperties false), one provider and one
// argument shape that the model returns on every attempt.
module McpArgumentCompatibility {
  pure val Providers = Set("none", "anthropic", "google")
  // valid fits the schema, short breaks minItems only and extra breaks
  // additionalProperties only.
  pure val Shapes = Set("valid", "short", "extra")
  pure val Constraints = Set("additionalProperties", "maxItems", "minItems")
  pure val MaxAttempts = 3

  // Keywords of the tool schema that each provider's rewrite removes.
  pure def removedBy(p: str): Set[str] =
    if (p == "google") Constraints
    else if (p == "anthropic") Set("additionalProperties")
    else Set()
  // Keywords of the server's schema that each argument shape breaks.
  pure def broken(shape: str): Set[str] =
    if (shape == "short") Set("minItems")
    else if (shape == "extra") Set("additionalProperties")
    else Set()

  var provider: str
  var shape: str
  // Argument prompts the model answered.
  var attempts: int
  // Keywords missing from the schema in the argument prompt.
  var hidden: Set[str]
  // Keywords that the prompt's descriptions restate.
  var restated: Set[str]
  // The server received the arguments.
  var sent: bool
  // The action returned: tool called, or no tool after the last attempt.
  var done: bool

  action init = all {
    nondet p = Providers.oneOf()
    nondet a = Shapes.oneOf()
    all {
      provider' = p,
      shape' = a,
      attempts' = 0,
      hidden' = Set(),
      restated' = Set(),
      sent' = false,
      done' = false,
    },
  }

  // The model answers one argument prompt, which shows the provider's rewrite.
  // The answer is validated against the server's schema; a valid answer is
  // sent, an invalid one is retried until the last attempt.
  action answer = all {
    not(done),
    provider' = provider,
    shape' = shape,
    attempts' = attempts + 1,
    hidden' = removedBy(provider),
    restated' = removedBy(provider),
    sent' = broken(shape) == Set(),
    done' = (broken(shape) == Set() or attempts + 1 == MaxAttempts),
  }
  // The model has not answered yet.
  action stutter = all {
    provider' = provider,
    shape' = shape,
    attempts' = attempts,
    hidden' = hidden,
    restated' = restated,
    sent' = sent,
    done' = done,
  }
  action step = any { answer, stutter }

  val ModelState = {
    provider: provider,
    shape: shape,
    attempts: attempts,
    hidden: hidden,
    restated: restated,
    sent: sent,
    done: done,
  }
  temporal ReturnsWithoutFairness = eventually(done)
  temporal Returns = answer.weakFair(ModelState).implies(ReturnsWithoutFairness)

  // The server only receives arguments that its own schema accepts.
  val OnlyValidSent = sent implies broken(shape) == Set()
  // Valid arguments are sent on the first attempt.
  val ValidSentFirst = (done and broken(shape) == Set()) implies (sent and attempts == 1)
  // Invalid arguments use every attempt and reach no server.
  val InvalidRefused = (done and broken(shape) != Set()) implies (not(sent) and attempts == MaxAttempts)
  // The prompt hides exactly the keywords the provider does not accept.
  val PromptRewritten = attempts > 0 implies hidden == removedBy(provider)
  // Every keyword the prompt hides is restated in a description.
  val RulesKept = hidden.subseteq(restated)
  val TypeOK = and {
    Providers.contains(provider),
    Shapes.contains(shape),
    attempts.in(0.to(MaxAttempts)),
    hidden.subseteq(Constraints),
    restated.subseteq(Constraints),
    done implies attempts > 0,
  }
}
