# Desktop Release Regression Checklist

This checklist tracks manual desktop regression checks required by
`packages/app-core/test/regression-matrix.json`. These items are intentionally
outside the deterministic PR contract suite because they need human visual
confirmation, hardware, or host OS permission dialogs.

## Manual Checks

- Left-clicking the tray icon opens the companion window (visual)
- Right-clicking the tray icon shows the tray context menu (visual)
- Window can be dragged by clicking the header region (visual)
- Photo quality is acceptable at default settings (hardware)
- Requesting accessibility opens System Preferences (OS interaction)
- Permission status reflects actual system state (OS interaction)
- Context menu appears at cursor position (visual)
- Power state reflects actual battery status (hardware)

## Release Use

Run this list against packaged desktop builds before promoting a release
candidate. Record the OS, architecture, package version, commit, and any
deviation in the release evidence bundle.
