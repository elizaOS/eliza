# #8933 — vision-critical chat widgets + Storybook stories

Per-state screenshots for the six new presentational widgets added in this PR,
captured from the built Storybook catalog (`build-storybook`) rendered in
headless Chromium (dark theme, the catalog default). All 19 story states render
cleanly (`19/19 good`, 0 console errors, 0 a11y violations).

| Component | States (PNG) |
| --- | --- |
| TopicChipsBar | `topicchipsbar--empty`, `--single`, `--few`, `--overflow` |
| TopicGroupedTranscript | `topicgroupedtranscript--collapsed`, `--expanded` |
| ChatHistorySwiper | `chathistoryswiper--single`, `--multi`, `--after-clear-undo` |
| CredentialRequestWidget | `credentialrequestwidget--oauth-link`, `--paste-secret`, `--image-upload` |
| BrowserLaunchWidget | `browserlaunchwidget--idle`, `--launching`, `--awaiting`, `--done` |
| OrchestratorGrillingCard | `orchestratorgrillingcard--evidence-pending`, `--criteria-failed`, `--criteria-met` |

These are the same stories the `ui-story-gate.yml` CI workflow sweeps on every
`packages/ui/**` change (it builds the catalog, renders every story headlessly,
and hard-fails on a throw / blank render / console error / serious a11y
violation), so they are continuously regression-guarded.
