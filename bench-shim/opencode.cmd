@ECHO OFF
REM Shim that forwards `opencode` to the vendored elizaOS/opencode source tree.
REM Used by the orchestrator->opencode benchmark wiring so we get the PR #26763
REM Cerebras reasoning fix without needing a compiled binary.
SETLOCAL
SET "OC_DIR=%~dp0..\vendor\opencode\packages\opencode"
SET "PYTHON=%~dp0..\.venv-bench\Scripts\python.exe"
bun run --cwd "%OC_DIR%" --conditions=browser src/index.ts %*
