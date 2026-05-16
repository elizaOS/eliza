# Desktop Manual Release Regression Checklist

Run this checklist against signed release candidates on each supported desktop OS before promoting a public release. Record the OS, architecture, app version, build artifact name, tester, and date in the release notes.

## Tray And Window

- Left-clicking the tray icon opens the companion window (visual)
- Right-clicking the tray icon shows the tray context menu (visual)
- Window can be dragged by clicking the header region (visual)
- Context menu appears at cursor position (visual)

## Permissions And Hardware

- Photo quality is acceptable at default settings (hardware)
- Requesting accessibility opens System Preferences (OS interaction)
- Permission status reflects actual system state (OS interaction)
- Power state reflects actual battery status (hardware)

## Pass Criteria

The release candidate passes when every item above is either verified on the target host or has a release-note exception that names the affected platform and owner.
