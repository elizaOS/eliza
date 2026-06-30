# #10424 — on-device agent behavior: no false action-narration observed

The issue: on the Stage-1 simple path the model sometimes *narrates an action it
didn't run* ("Spawning the sub-agent now", "verified live"). This is an on-device
behavioral check of that, run against a **real, model-backed agent** from the
Android app.

## Setup (real agent, on the device)

The emulator app's bundled local agent has no model, so it could not respond. I
connected the app to a running, model-backed Eliza agent via the app's own
"Connect your own agent" flow: `adb reverse tcp:31380 tcp:31337` →
`onboarding-remote-address = http://127.0.0.1:31380` → Connect. The dashboard
then loaded with live data ("Good morning · 80°F Clear · Brooklyn") and the chat
composer became available ("Ask DeviceE2EHostAgent").

## Interaction (read-only, benign)

A single benign, read-only prompt was sent from the device — **no action-firing
or destructive request** (which is why this is a safe on-device probe):

> **User:** Briefly, what are you able to help me with?
> **Agent:** I'm not sure how to answer that.

(Preceded by the agent's greeting "hey, take your time, no rush.") See
`10424-ondevice-chat-no-false-narration.png` + `10424-ondevice-chat.mp4`.

## Result

For this interaction the agent did **NOT** exhibit the #10424 symptom: it gave an
honest non-answer rather than fabricating a narrated action ("I just checked /
spawned / verified…"). That is a positive — if single-sample — on-device data
point.

**Scope/honesty:** one benign read-only prompt against one agent; the response
was terse (the model gave a short non-answer rather than a full capability list),
so this does not exercise the multi-step sub-agent path where #10424 was
originally observed. Reproducing that path on-device needs an action-firing
prompt against the live agent, which I did not run unprompted. The harness is now
proven, though: a model-backed agent **can** be driven from the Android app and
its responses captured on-device for this kind of behavioral assertion.
