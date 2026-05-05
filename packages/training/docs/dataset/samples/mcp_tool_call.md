# Sample: `mcp_tool_call task_type (deepfabric-github-mcp)`

- **source_dataset:** `deepfabric-github-mcp`
- **task_type:** `mcp_tool_call`
- **split:** `train`
- **license:** `unknown`
- **agentId:** `agent`
- **roomName:** `2ea92ca907ccc968b7d7dca9`

> MCP-server tool call; identical wire format to `tool_call` — only the tool name namespace and the originating dataset differ.

## currentMessage

```
role:    user
speaker: user
channel: dm

content:
I need to resolve a review comment on the 'add-feature' branch for pull request #123 in the 'octocat/Spoon-Knife' repository. Can you help me do that?
```

## memoryEntries (0 entries)

_(empty)_

## availableActions

Type: List[str] (count=3)

```
[
  "TASK_CALL",
  "REPLY",
  "IGNORE"
]
```

## expectedResponse (verbatim)

```
thought: Tool dispatch in order.
actions[1]:
  - name: TASK_CALL
    params:
      tool: add_issue_comment
      arguments:
        owner: octocat
        repo: Spoon-Knife
        issue_number: 123
        body: Resolved the review comment.
providers[0]:
text: ""
simple: false
```