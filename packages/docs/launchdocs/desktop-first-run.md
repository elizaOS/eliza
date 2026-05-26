# Desktop First-Run Launch QA

This launch QA scope tracks the desktop first-run startup contract that must
hold before release candidates move beyond static gates.

## Required behavior

- A fresh packaged desktop install starts the sidecar runtime without a remote
  launch dependency.
- First-run state is created under `~/.local/state/milady`.
- The renderer reaches the live API base before leaving the startup shell.
- Voice input is driven through packaged local ASR readiness, not the browser
  speech recognition service.
