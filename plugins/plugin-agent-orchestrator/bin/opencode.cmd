@ECHO OFF
REM Shim that forwards `opencode` to the vendored elizaOS/opencode source tree.
REM plugin-agent-orchestrator's AcpService points acpx at this shim so we run
REM the vendored source with provider-specific compatibility fixes without
REM needing a compiled binary.
SETLOCAL
SET "OC_DIR=%~dp0..\vendor\opencode\packages\opencode"
bun run --cwd "%OC_DIR%" --conditions=browser src/index.ts %*
