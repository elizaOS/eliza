// The cloud native planner hands each MCP tool call to executePlannedToolCall
// (packages/core/src/runtime/execute-planned-tool-call.ts), which validates the
// arguments against the action parameters that convertJsonSchemaToActionParams
// (plugins/plugin-mcp/src/protocol-utils/schema-converter.ts) built from the
// tool's inputSchema. Only admitted arguments reach the action handler
// (packages/cloud/shared/src/lib/eliza/plugin-mcp/actions/dynamic-tool-actions.ts),
// which sends them to the MCP server; the server validates them again.
// The parameters carry the type-level shape the server declares: nested
// properties and their required names, additionalProperties and array items,
// and every type where a property names none. Value constraints such as
// minLength stay with the server.
// One case: one tool of a real server shape and one argument shape.
module McpArgumentShape {
  pure val Tools = Set("push_files", "create_page", "sum_ids", "echo_value", "set_labels")
  // Type-level keywords that the action parameters carry.
  pure val Carried = Set("required", "items", "additionalProperties", "type")

  // push_files: files is a list of {path, content} (server-github).
  // create_page: parent is {page_id} (Notion). sum_ids: ids is list[int].
  // echo_value: value is Any. set_labels: labels is dict[str, str].
  pure def shapesOf(tool: str): Set[str] =
    if (tool == "push_files") Set("valid", "missingContent")
    else if (tool == "create_page") Set("valid", "missingPageId")
    else if (tool == "sum_ids") Set("valid", "wordItem")
    else if (tool == "echo_value") Set("text", "object")
    else Set("valid", "numberValue")
  // Keywords of the server's schema that an argument shape breaks.
  pure def broken(shape: str): Set[str] =
    if (shape == "missingContent" or shape == "missingPageId") Set("required")
    else if (shape == "wordItem") Set("items")
    else if (shape == "numberValue") Set("additionalProperties")
    else Set()
  pure def serverAccepts(shape: str): bool = broken(shape) == Set()
  pure def plannerAdmits(shape: str): bool = broken(shape).intersect(Carried) == Set()

  var tool: str
  var shape: str
  // "plan" until validation, "send" while the handler calls the server.
  // The server's schema accepts the arguments.
  var accepts: bool
  var phase: str
  var admitted: bool
  // The action handler called the MCP server.
  var dispatched: bool
  // The server's tool ran with the arguments.
  var delivered: bool
  var done: bool

  action init = all {
    nondet t = Tools.oneOf()
    nondet s = shapesOf(t).oneOf()
    all {
      tool' = t,
      shape' = s,
      accepts' = serverAccepts(s),
      phase' = "plan",
      admitted' = false,
      dispatched' = false,
      delivered' = false,
      done' = false,
    },
  }

  // executePlannedToolCall validates the arguments before the handler runs.
  action validate = all {
    phase == "plan",
    tool' = tool,
    shape' = shape,
    accepts' = accepts,
    phase' = if (plannerAdmits(shape)) "send" else "returned",
    admitted' = plannerAdmits(shape),
    dispatched' = false,
    delivered' = false,
    done' = not(plannerAdmits(shape)),
  }
  // The handler sends admitted arguments; the server runs its tool only for
  // arguments its own schema accepts.
  action send = all {
    phase == "send",
    tool' = tool,
    shape' = shape,
    accepts' = accepts,
    phase' = "returned",
    admitted' = admitted,
    dispatched' = true,
    delivered' = serverAccepts(shape),
    done' = true,
  }
  action advance = any { validate, send }
  // Validation or the server call has not finished yet.
  action stutter = all {
    tool' = tool,
    shape' = shape,
    accepts' = accepts,
    phase' = phase,
    admitted' = admitted,
    dispatched' = dispatched,
    delivered' = delivered,
    done' = done,
  }
  action step = any { advance, stutter }

  val ModelState = {
    tool: tool,
    shape: shape,
    accepts: accepts,
    phase: phase,
    admitted: admitted,
    dispatched: dispatched,
    delivered: delivered,
    done: done,
  }
  temporal ReturnsWithoutFairness = eventually(done)
  temporal Returns = advance.weakFair(ModelState).implies(ReturnsWithoutFairness)

  // Arguments the server accepts reach its tool.
  val AcceptedDelivered = (done and serverAccepts(shape)) implies (admitted and delivered)
  // Arguments the server refuses are refused before the handler calls it.
  val RefusedBeforeDispatch = (done and not(serverAccepts(shape))) implies not(dispatched)
  // Only admitted arguments are sent, and the server's tool runs only for
  // arguments it accepts.
  val DeliveredAccepted = and {
    dispatched implies admitted,
    delivered implies (dispatched and serverAccepts(shape)),
  }
  val TypeOK = and {
    Tools.contains(tool),
    shapesOf(tool).contains(shape),
    accepts == serverAccepts(shape),
    Set("plan", "send", "returned").contains(phase),
    done == (phase == "returned"),
  }
}
