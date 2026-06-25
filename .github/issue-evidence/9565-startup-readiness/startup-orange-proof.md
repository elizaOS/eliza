# 9565 boot/launch orange = #ef5a1f (proof)

The boot/loading/launch surfaces must match the default home background orange
`#ef5a1f` (`DEFAULT_BACKGROUND_COLOR`), not the brand accent, so the native
splash → React StartupShell → home transition is one seamless orange.

## React StartupShell renders exactly #ef5a1f

Headless Chromium against the renderer dev server, reading the startup shell's
computed background:

```
startup-shell computed backgroundColor: rgb(239, 90, 31)   // == #ef5a1f ✓
body       computed backgroundColor: rgb(245, 245, 244)     // theme --bg (NOT orange)
```

`rgb(239, 90, 31)` is exactly `#ef5a1f`. The body's `--bg` is `rgb(245,245,244)`
(the light-theme background), which is why the StartupShell launch surface uses a
dedicated `--launch-bg` token (default `#ef5a1f`) rather than `--bg`: `--bg`
resolves to white/black (`:root`/`.dark`) or `#ff8a24` (`.theme-app`), none of
which is the home shader color.

Screenshot: `startup-shell-orange-ef5a1f.png` (the launch surface as a single
seamless `#ef5a1f` field).

## Native launch surfaces

Pinned to `#ef5a1f` by `packages/app/test/brand-surface.test.ts` (9 assertions):
`index.html` FOUC, `capacitor.config.ts` (splash/ios/android), `app.config.ts`
web colors + PWA manifest, Android `colors.xml` `splash_background` +
`styles.xml` launch status bar, iOS `LaunchScreen.storyboard`
(`red="0.937" green="0.353" blue="0.122"`). The brand accent stays `#FF5800`.
