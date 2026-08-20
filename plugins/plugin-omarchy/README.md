# @elizaos/plugin-omarchy

Opt-in bridge between an Eliza agent and an Omarchy Linux desktop. It pairs
with the separate `elizaos.eliza` Omarchy shell plugin, which owns the bar
presence and quick-chat pill.

## Runtime surface

| Kind | Name | Behavior |
| --- | --- | --- |
| Provider | `omarchyDesktop` | Reads Omarchy version, theme, plugin inventory, and Eliza shell-plugin state. |
| Action | `GET_OMARCHY_STATUS` | Returns the same bounded read-only snapshot on request. |
| Action | `SHOW_OMARCHY_NOTIFICATION` | Shows an explicitly requested notification with headline, body, and urgency. |
| Action | `SHOW_ELIZA_OMARCHY_PILL` | Uses the fixed bar IPC target to show `elizaos.eliza` with the user's effective endpoint, identity, and Workstation settings. |

## Security boundary

- Linux + Omarchy host detection gates every surface.
- Commands use `execFile` with a fixed executable and fixed control arguments.
- Notification text is length-bounded and option-shaped values are rejected,
  preventing Omarchy's `--exec` notification option from being selected.
- The plugin exposes no arbitrary command, package install, update, theme
  mutation, URL launch, or privilege escalation.
- Notification and pill actions require `USER` role and explicit request text.
- Status fails closed if version, theme, or plugin inventory cannot be read;
  zero-exit IPC text is accepted only when Omarchy explicitly returns `ok`.

## Commands

```bash
bun run --cwd plugins/plugin-omarchy test
bun run --cwd plugins/plugin-omarchy typecheck
bun run --cwd plugins/plugin-omarchy lint:check
bun run --cwd plugins/plugin-omarchy build
```

## Configuration

No secrets or environment settings are required. `OMARCHY_PATH` is honored as
the normal Omarchy session marker; `/usr/share/omarchy` is the packaged fallback.

The companion shell plugin configures its local Eliza endpoint independently.
It intentionally does not store a bearer token in Omarchy's `shell.json`.
