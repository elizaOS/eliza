# Desktop Release Regression Checklist

This checklist captures desktop release checks that still require visual confirmation, hardware, or OS interaction. The automated release contract keeps this file in sync with `packages/app-core/test/regression-matrix.json`.

## Manual Checks

- [ ] Left-clicking the tray icon opens the companion window (visual)
- [ ] Right-clicking the tray icon shows the tray context menu (visual)
- [ ] Window can be dragged by clicking the header region (visual)
- [ ] Photo quality is acceptable at default settings (hardware)
- [ ] Requesting accessibility opens System Preferences (OS interaction)
- [ ] Permission status reflects actual system state (OS interaction)
- [ ] Context menu appears at cursor position (visual)
- [ ] Power state reflects actual battery status (hardware)
