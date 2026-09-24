# @elizaos/agent

Standalone agent host and HTTP/WebSocket backend around the elizaOS runtime.

Compose core, assistant, storage, and providers explicitly. Enforce authentication at HTTP boundaries. Attachments use the existing content-addressed media store and SSRF-guarded fetches.

Build, test, and setup: [README.md](README.md).

Retain real end-to-end scenarios exercising host, transport, and persistence.
The package test, test:e2e, and test:integration commands share that suite;
do not reintroduce removed unit, mock, smoke, or source-inspection tests.
