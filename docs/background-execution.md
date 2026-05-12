# Background execution — what happens to my scheduled tasks when I close the app?

You set up a Heartbeat to check your email every hour. You close Eliza. The
hour rolls over. Does anything happen?

The honest answer is **it depends on the device**. The same Eliza app
behaves very differently when it's running on a laptop, a phone, or a
browser tab. This page explains what to expect on each.

If you only read one sentence: **on mobile and in the browser, scheduled
tasks fire reliably only while the app is open. If you need them to run
24/7 in the background, install Eliza on a server, pair Eliza Cloud, or
keep the app in the foreground.**

## Desktop (macOS / Windows / Linux)

This is the case that "just works". When Eliza is running on a desktop or
laptop, the app stays alive as long as the OS is awake.

- A 1-minute interval Heartbeat will fire roughly every minute.
- A cron schedule like "every weekday at 9am" will fire at 9am on every
  weekday the machine is awake.
- If the laptop is closed or sleeping at the scheduled time, the task runs
  the next time the machine wakes up and Eliza is running.
- If you quit Eliza entirely, nothing fires until you re-open it.

There are no hidden caps. The desktop app is the most reliable place to
run scheduled work that depends on tight timing.

## iOS (iPhone, iPad)

iOS aggressively manages background apps to save battery and memory. Eliza
gets the same treatment.

When the app is in the **foreground** (you're using it), everything works
exactly like desktop.

When the app is in the **background** (you switched apps, or your screen
is locked), iOS gives Eliza short, occasional wake windows to catch up:

- Wakes happen **opportunistically**. Apple's system decides when, based
  on how often you use Eliza, your battery level, network state, and
  what other apps are demanding time. Typical real-world cadence on a
  healthy device is once every **1 to 4 hours**, not once every 15
  minutes.
- Each wake gives Eliza about **30 seconds** to do work. If a Heartbeat
  takes longer than that, iOS will cut it off and the task will resume
  on the next wake.
- If you **force-quit** Eliza by swiping it away in the app switcher,
  iOS stops scheduling background wakes for the app entirely. The task
  will not fire again until you reopen Eliza.

What this means in practice:

- A "check every 5 minutes" Heartbeat on iPhone will *not* check every
  five minutes. It will check whenever iOS lets it — usually a handful of
  times per day, more often if you're actively using Eliza, less often if
  the device is in low-power mode or you've left the app alone.
- The Heartbeat editor in Eliza will show you a warning if you pick an
  interval shorter than 15 minutes, because that's the floor of what
  mobile can do.
- For real-time notifications (new email arrived, calendar event ending),
  prefer **push** triggers over polling Heartbeats. Push wakes the app
  the instant the event happens and doesn't burn through your background
  budget.

If you need a Heartbeat to run on a fixed schedule whether or not your
phone is in your pocket, pair Eliza Cloud — the same Heartbeat runs in
the cloud on a real server and pushes results back to your phone.

## Android

Android's behavior is closer to a checkpoint than a guarantee. The system
runs background work through two mechanisms:

- **WorkManager** is the default. It enforces a **15-minute floor** —
  the shortest periodic interval Android will accept. Past that floor,
  Doze mode and App Standby can defer execution by hours if the device
  is idle. Force-stopping Eliza from system settings halts background
  work the same way it does on iOS.
- **Foreground service** (FGS). For tasks that genuinely need to run on
  schedule, Eliza can run a persistent foreground service. The price is
  a permanent notification in your status bar saying Eliza is running
  in the background. This is the only way to guarantee a Heartbeat
  fires on time on Android.

In practice:

- A "check every minute" Heartbeat on Android, with default settings,
  will fire at most every 15 minutes — and often less often.
- The Heartbeat editor warns you when you pick an interval shorter than
  15 minutes.
- Tasks you mark as "important — run on schedule" upgrade to the
  foreground service, which adds a visible notification but holds the
  scheduled time.
- Cloud-paired Heartbeats bypass all of this — the cloud runs the
  schedule and Android only needs to be online to receive the result.

## Browser tabs

When Eliza is running as a web page in Chrome, Safari, or another
browser, the browser itself decides whether Eliza stays alive.

- A tab in the foreground works normally.
- A tab in the **background** (you switched to another tab or app) gets
  its timers throttled — typically clamped to at most once per minute.
- A tab the browser **discards** to save memory stops running entirely.
  Modern browsers do this when they're under memory pressure, even if
  you can still see the tab. You'll notice because the tab will reload
  next time you click it.
- Closing the tab or quitting the browser stops everything.

Browser tabs are the **least reliable** host for scheduled work. The
Heartbeat editor surfaces a banner when it detects the app is running in
a plain browser tab. For anything that matters, prefer the desktop app
or a paired Eliza Cloud instance.

## Quick reference

| Host           | Tight intervals (< 15 min) | Long intervals (≥ 15 min) | When closed                  |
| -------------- | --------------------------- | -------------------------- | ---------------------------- |
| Desktop / Linux server | Works                | Works                      | Stops until you reopen Eliza |
| Eliza Cloud    | Works                       | Works                      | Keeps running                |
| iPhone / iPad  | Clamped to ~30 min cadence  | Opportunistic, ~1–4h       | Stops if force-quit          |
| Android        | Clamped to 15 min floor     | Subject to Doze            | Stops if force-stopped       |
| Browser tab    | Throttled                   | Throttled                  | Stops when tab closes        |

## Where to look next

- **Plain-language reminder in the app**: open Heartbeats and look for the
  amber banner that names your current host.
- **Operator setup notes**: `plugins/plugin-background-runner/INSTALL.md`
  walks through the native iOS BGTaskScheduler and Android WorkManager
  wiring that powers mobile background.
- **Engine-side capability detection**:
  `plugins/plugin-workflow/src/utils/host-capabilities.ts` is the truth
  source the workflow engine uses to refuse activating nodes the current
  host can't satisfy.
- **Skill knowledge**: the `elizaos` and `eliza-cloud` SKILL.md files in
  `skills/.defaults/` cover the runtime model and Cloud pairing flow.
