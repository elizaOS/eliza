# Deploying meeting bots

`@elizaos/plugin-meetings` joins Google Meet / Microsoft Teams / Zoom by driving
a **real Chromium** via `playwright-core`. That has hard host requirements: a
Chromium binary must be resolvable, and — because Meet's `isTrusted`-click
bot-detection is defeated with humanized XTEST input — a real X server should be
available even on a "headless" box. This doc is the deployment matrix.

## How the plugin decides support & headless mode

Two typed resolvers own all of this (`src/platform-support.ts`):

- `resolveMeetingRuntimeSupport(runtime)` → `{ supported, reason?, headless, chromiumPath? }`.
  Unsupported when the host is a **mobile** embedding (`ELIZA_PLATFORM=android|ios`)
  or when **no Chromium is resolvable** (no bundled playwright download, no
  `ELIZA_MEETINGS_CHROMIUM_PATH`, and no system Chrome/Edge channel).
- `resolveHeadlessMode(env, platform)` → `boolean`:
  1. explicit `ELIZA_MEETINGS_HEADLESS` (`true`/`1`/`yes`/`on` vs `false`/`0`/`no`/`off`) wins;
  2. else auto-detect — **headed** when a display exists (macOS/Windows always;
     Linux only when `DISPLAY` or `WAYLAND_DISPLAY` is set), **headless** otherwise.

Headless uses Chromium's modern "new" headless (`headless: true` →
`--headless=new`), which keeps `getUserMedia` / WebAudio working. The classic
headless mode disabled them and is never used.

### Chromium resolution precedence

1. `ELIZA_MEETINGS_CHROMIUM_PATH` — explicit binary (must exist, else a hard error).
2. Playwright's bundled Chromium (when the browser download is installed).
3. System channel fallback — `chrome` (Meet/Zoom) or `msedge` (Teams).

## Headed-under-Xvfb vs pure headless — the recommendation

**Recommended: headed Chromium under Xvfb** (`ELIZA_MEETINGS_HEADLESS=false` +
`DISPLAY=:99`). Google Meet cross-checks that admission clicks are trusted user
gestures; the humanized input path (XTEST) needs a real X display to synthesize
those, which Xvfb provides without a physical monitor. Pure headless
(`--headless=new`, no X server) is **best-effort for Meet** (it often trips the
anti-abuse interstitial) but **reliable for Teams and Zoom**, which do not gate
on XTEST-grade input. Pick pure headless only for a Teams/Zoom-only deployment.

## (a) Local desktop — headed, system Chrome

macOS / Windows / a Linux desktop with a session. Turn on the `meetings` feature
in your agent config (`features.meetings`) — no env flag needed. A display is
always present, so the plugin auto-selects **headed**, and the system Chrome/Edge
channel is used if no bundled browser is installed.

```bash
# optional: pin a specific browser binary instead of the system channel
# export ELIZA_MEETINGS_CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

## (b) Linux server / Eliza Cloud container — Xvfb + headed Chromium + PulseAudio

A headless VPS or an Eliza Cloud container has no display. Run **headed
Chromium under Xvfb**, and run **PulseAudio** so Zoom's web client has an audio
sink to capture from.

### apt packages

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
      # Chromium runtime deps
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpango-1.0-0 libcairo2 fonts-liberation \
      # virtual display + humanized-input + clipboard
      xvfb xdotool xclip \
      # audio sink for Zoom capture
      pulseaudio \
  && rm -rf /var/lib/apt/lists/*
```

### env

Enable the `meetings` feature in the agent config baked into (or mounted onto)
the image; the vars below are runtime tuning, not an enable switch.

```dockerfile
ENV ELIZA_MEETINGS_HEADLESS=false \
    DISPLAY=:99
# Point at a Chromium binary if you don't ship playwright's bundled download:
# ENV ELIZA_MEETINGS_CHROMIUM_PATH=/usr/bin/chromium
```

### launch under Xvfb

Wrap the agent process so it inherits the virtual `:99` display and a running
PulseAudio daemon:

```bash
pulseaudio --start --exit-idle-time=-1
xvfb-run --server-num=99 --server-args="-screen 0 1280x720x24" \
  bun run start
```

`xvfb-run` exports `DISPLAY=:99`; `hasDisplay()` then reports a display, so the
auto-detect picks **headed** even inside the container. Setting
`ELIZA_MEETINGS_HEADLESS=false` makes the mode explicit and logged regardless.

## (c) iOS / Android on-device — NOT supported

Browser automation cannot run in a mobile app sandbox — there is no spawnable
Chromium, no XTEST, no PulseAudio. The plugin **refuses to auto-enable** on
`ELIZA_PLATFORM=android|ios` even when an env key is set, and
`resolveMeetingRuntimeSupport()` returns `supported: false` with a mobile
reason.

Mobile users still get meeting transcripts via one of:

- **Route to a cloud-hosted agent** — run the bot in an Eliza Cloud
  container/sandbox (topology (b) above) and consume the transcript from the
  mobile client over the dashboard/API. This is the intended path.
- **The Discord / voice path** — Discord "meetings" are voice channels owned by
  the Discord connector, which captures audio natively without a browser bot.

## Anti-bot caveat (read before trusting Meet in production)

Google Meet actively detects datacenter egress + automation. The launcher
already omits the detectable `--ignore-certificate-errors` /
`--disable-web-security` flags, pins a Client-Hints-consistent User-Agent, and
strips `navigator.webdriver`. Even so, Meet admission is **only reliable with
humanized XTEST input under a real X display** (Xvfb). Treat pure-headless Meet
joins as best-effort; Teams and Zoom are robust headless.
