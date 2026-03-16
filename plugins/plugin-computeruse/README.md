# @elizaos/plugin-computeruse

Gives an elizaOS agent the ability to **control a computer UI**:

- **Local mode**: uses `@elizaos/computeruse` bindings directly via native accessibility APIs
- **MCP mode**: uses a configured **ComputerUse MCP server** (local or remote), so the agent can control a different machine

> Safety note: computer control is powerful. Run with least privilege, and only enable in trusted environments.

## Platform Support

| Platform | Local Mode | MCP Mode | API |
|----------|:----------:|:--------:|-----|
| Windows  | ✅ | ✅ | UI Automation |
| macOS    | ✅ | ✅ | Accessibility API (AX) |
| Linux    | ✅ | ✅ | AT-SPI2 |

**Requirements:**
- **Windows**: Works out of the box
- **macOS**: Requires Accessibility permissions (System Preferences → Privacy & Security → Accessibility)
- **Linux**: Requires AT-SPI2 (default on GNOME/KDE), `wmctrl` and `xdotool` for X11

## Configuration

- `COMPUTERUSE_ENABLED` (default: `false`)
- `COMPUTERUSE_MODE` (default: `auto`) — `auto | local | mcp`
- `COMPUTERUSE_MCP_SERVER` (default: `computeruse`) — name of the MCP server in your runtime settings.

## Actions

- `COMPUTERUSE_OPEN_APPLICATION`
- `COMPUTERUSE_CLICK`
- `COMPUTERUSE_TYPE`
- `COMPUTERUSE_GET_WINDOW_TREE`
- `COMPUTERUSE_GET_APPLICATIONS`

### Selector scoping (MCP mode)

When using a ComputerUse MCP server, selector-based actions must be scoped to a running process.

You can do that either by:

- Passing `process` alongside `selector`, or
- Prefixing the selector with `process:<name> >> ...` (e.g. `process:notepad >> role:Button|name:Save`)

## Example

See `examples/computer-use/*` for TypeScript / Python / Rust runnable examples.

