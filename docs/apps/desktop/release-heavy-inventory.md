# Desktop Release Regression Inventory

This inventory tracks desktop checks that are intentionally outside the deterministic PR gate because they need packaged app behavior, host OS integration, hardware, or live network services.

## Packaged Desktop E2E

- gameOpenWindow — full round-trip with openGameWindow mock (needs canvas mock update)
- Abnormal window position (off-screen) is corrected to safe defaults (e2e)
- Deep link received while app is closed causes app to launch (e2e)
- Deep link received while app is open does not launch second instance (e2e)
- Shortcuts survive window focus changes (e2e)
- Auto-launch survives app updates (e2e)
- App launches automatically after system restart (e2e)
- Keyboard shortcut Cmd+Q triggers quit (e2e)
- Keyboard shortcut Cmd+R triggers reload (e2e)
- Keyboard shortcut Cmd+Option+I opens devtools (e2e)
- Tray icon persists after main window is closed (e2e)
- Main window has native vibrancy effect on macOS (e2e)

## Integration

- Gateway discovery sends gatewayDiscovery push event to renderer (integration)
- Canvas window is sandboxed — cannot access main app origin (integration)
- Canvas navigate blocks external URLs (integration)
- Agent port is reachable via HTTP after status reaches 'running' (integration)
- Agent crash triggers automatic restart (integration)
- Stopping agent while starting does not leave zombie process (integration)
- Context menu closes when clicking elsewhere (e2e)

## Hardware And OS

- Microphone input works after permission is granted (hardware)
- Swabble fires 'wakeWordDetected' event when wake word is spoken (hardware)
- Audio transcription produces non-empty text for clear speech (hardware)
- Camera preview renders in the UI when stream is started (hardware)
- Switching between front/rear camera works (hardware)
- takeScreenshot returns a non-empty base64 PNG (hardware)
- Frame capture mode streams frames at configured interval (hardware)
- Power state reflects actual battery status (hardware)

## Manual Visual Checks

- Left-clicking the tray icon opens the companion window (visual)
- Right-clicking the tray icon shows the tray context menu (visual)
- Window can be dragged by clicking the header region (visual)
- Photo quality is acceptable at default settings (hardware)
- Requesting accessibility opens System Preferences (OS interaction)
- Permission status reflects actual system state (OS interaction)
- Context menu appears at cursor position (visual)

## Network And Update Services

- Check for updates contacts the release server (network)
- Applying update relaunches the app (e2e)
- Update check works on both canary and stable channels (network)
