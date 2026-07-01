# In-chat onboarding status

First-run onboarding now renders in the real `ContinuousChatOverlay` over the
normal app shell. The old full-screen first-run gate, `FirstRunChat` surface,
and standalone runtime chooser are no longer part of the shipped UI.

The current first-run flow is seeded by `use-first-run-conductor.ts` as inline
chat choices:

- `choice-__first_run__:runtime:{cloud|local|other}`
- `choice-__first_run__:provider:{on-device|elizacloud|other}`
- `choice-__first_run__:tutorial:{start|skip}`

Those choices route into the headless first-run finish path and produce a single
`POST /api/first-run`. Tests should assert the real chat overlay plus transcript
choices and should keep negative assertions for deleted surfaces such as
`first-run-runtime-chooser`, `first-run-chat`, and
`startup-first-run-background`.

Current end-to-end evidence for issue #10709 lives in
`.github/issue-evidence/10709-onboarding-chat/`.
