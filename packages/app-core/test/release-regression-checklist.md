# Desktop Release Regression Checklist

Complete these manual checks for desktop release candidates after packaged smoke
tests pass on the target platform.

- [ ] Left-clicking the tray icon opens the companion window (visual)
- [ ] Right-clicking the tray icon shows the tray context menu (visual)
- [ ] Window can be dragged by clicking the header region (visual)
- [ ] Photo quality is acceptable at default settings (hardware)
- [ ] Requesting accessibility opens System Preferences (OS interaction)
- [ ] Permission status reflects actual system state (OS interaction)
- [ ] Context menu appears at cursor position (visual)
- [ ] Power state reflects actual battery status (hardware)
