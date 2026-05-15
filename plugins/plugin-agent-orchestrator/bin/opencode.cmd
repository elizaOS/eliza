@ECHO OFF
REM Shim that forwards `opencode` to the vendored elizaOS/opencode source tree.
REM plugin-agent-orchestrator's AcpService points acpx at this shim so we run
REM the PR #26763 (Cerebras reasoning fix) vendored source without needing a
REM compiled binary.
SETLOCAL
SET "OC_DIR=%~dp0..\..\..\vendor\opencode\packages\opencode"
bun run --cwd "%OC_DIR%" --conditions=browser src/index.ts %*
