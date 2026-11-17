# Android device

The agent service, device sign-in and credential custody, native bridges,
device audio, browser, and the image, APK and update build library. Its
specifications are being written.

The package rebuild still owes these device boundaries referenced by the
agent and plugins:

- Claimed-operation execution and journal custody, reviewed operation wire
  values, device reviews and deletion windows. Agent request/session
  authority does not substitute for device execution evidence.
- Reminder scheduling, Calendar deletion, background mail and scheduled
  result delivery, reviewed file mutation, and camera access.
- Browser document custody and page requests, credential and secure-slot
  custody, voice capture and output warmup.

Their detailed models and installed-device qualification remain pending.
