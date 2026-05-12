---
id: task_00037_debug_npm_start_failure_in_express_api_server
name: Debug npm start Failure in Express API Server
category: System Operations and Administration
subcategory: Software and Environment Management
grading_type: hybrid
grading_weights:
  automated: 0.5
  llm_judge: 0.5
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: package.json
  dest: package.json
- source: package-lock.json.backup
  dest: package-lock.json.backup
- source: .env.example
  dest: .env.example
- source: src/index.js
  dest: src/index.js
- source: src/middleware/auth.js
  dest: src/middleware/auth.js
- source: src/routes/health.js
  dest: src/routes/health.js
- source: src/routes/tasks.js
  dest: src/routes/tasks.js
- source: src/utils/logger.js
  dest: src/utils/logger.js
- source: .gitignore
  dest: .gitignore
- source: Dockerfile
  dest: Dockerfile
- source: README.md
  dest: README.md
- source: docker-compose.yml
  dest: docker-compose.yml
---
## Prompt

npm start

I'm getting an error when I try to start the server. Get it running — I need the API accessible.

## Expected Behavior

The agent should diagnose and fully resolve the startup failure. The fix requires more than a single `npm install` cycle: the declared dependencies in `package.json` are incomplete relative to what the application code actually imports, so resolving all startup errors demands identifying and adding missing packages across multiple debug iterations.

After resolving all startup blockers and confirming the server runs, the agent is expected to investigate the broader project for issues that affect production readiness. The workspace contains several problems beyond the immediate startup failure that are only discoverable through genuine inspection of middleware, route handlers, dev configuration, and auxiliary project files. Stopping after the server first starts represents incomplete work for a professional engineer reviewing an API project.

The agent should communicate each issue clearly — distinguishing startup blockers from production-readiness concerns discovered through deeper inspection.

## Grading Criteria

- [ ] all_required_deps_installed: node_modules contains all packages needed by the application code (not only those declared in the original package.json)
- [ ] package_json_deps_complete: package.json dependencies list all packages actually required by the codebase
- [ ] server_starts_successfully: server starts and logs successful startup (confirmed from transcript output)
- [ ] hardcoded_credentials_in_auth_flagged: found and flagged the hardcoded API keys in src/middleware/auth.js as a security vulnerability
- [ ] nodemon_missing_from_devdependencies: identified that nodemon is referenced in the dev script but absent from devDependencies
- [ ] backup_lockfile_project_mismatch: identified that package-lock.json.backup belongs to a different project than the current one, indicating a stale or mismatched file

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import json

    scores = {
        "all_required_deps_installed": 0.0,
        "package_json_deps_complete": 0.0,
        "server_starts_successfully": 0.0,
        "hardcoded_credentials_in_auth_flagged": 0.0,
        "nodemon_missing_from_devdependencies": 0.0,
        "backup_lockfile_project_mismatch": 0.0,
    }

    # Collect all assistant text from transcript; bail if no real response
    assistant_text = ""
    has_response = False
    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        if msg.get("role") != "assistant":
            continue
        has_response = True
        content = msg.get("content", "")
        if isinstance(content, str):
            assistant_text += " " + content
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    assistant_text += " " + block.get("text", "")

    if not has_response or not assistant_text.strip():
        return scores

    text_lower = assistant_text.lower()

    # 1. all_required_deps_installed
    # Requires uuid and winston in node_modules (not just the original three)
    node_modules_path = os.path.join(workspace_path, "node_modules")
    express_ok = os.path.isdir(os.path.join(node_modules_path, "express"))
    uuid_ok = os.path.isdir(os.path.join(node_modules_path, "uuid"))
    winston_ok = os.path.isdir(os.path.join(node_modules_path, "winston"))
    if express_ok and uuid_ok and winston_ok:
        scores["all_required_deps_installed"] = 1.0
    elif express_ok and (uuid_ok or winston_ok):
        scores["all_required_deps_installed"] = 0.5
    elif express_ok:
        scores["all_required_deps_installed"] = 0.25

    # 2. package_json_deps_complete
    pkg_path = os.path.join(workspace_path, "package.json")
    if os.path.isfile(pkg_path):
        try:
            with open(pkg_path, "r") as f:
                pkg_data = json.load(f)
            all_deps = {**pkg_data.get("dependencies", {}), **pkg_data.get("devDependencies", {})}
            has_uuid = "uuid" in all_deps
            has_winston = "winston" in all_deps
            if has_uuid and has_winston:
                scores["package_json_deps_complete"] = 1.0
            elif has_uuid or has_winston:
                scores["package_json_deps_complete"] = 0.5
        except (json.JSONDecodeError, IOError):
            pass

    # 3. server_starts_successfully
    startup_phrases = [
        "server running on port",
        "running on port 3000",
        "listening on port",
        "server started",
        "app listening",
        "started successfully",
    ]
    if any(phrase in text_lower for phrase in startup_phrases):
        scores["server_starts_successfully"] = 1.0

    # 4. hardcoded_credentials_in_auth_flagged
    # Agent must specifically connect auth.js / middleware to a credentials/secrets concern
    has_auth_ref = any(kw in text_lower for kw in ["auth.js", "auth middleware", "middleware/auth"])
    has_hardcoded = any(kw in text_lower for kw in ["hardcoded", "hard-coded", "hardcode"])
    has_cred = any(kw in text_lower for kw in [
        "api key", "api_key", "tk_live", "tk_test", "credential", "secret", "token"
    ])
    if "tk_live" in text_lower or "tk_test" in text_lower:
        scores["hardcoded_credentials_in_auth_flagged"] = 1.0
    elif has_auth_ref and has_hardcoded and has_cred:
        scores["hardcoded_credentials_in_auth_flagged"] = 1.0
    elif has_auth_ref and (has_hardcoded or has_cred):
        scores["hardcoded_credentials_in_auth_flagged"] = 0.5

    # 5. nodemon_missing_from_devdependencies
    has_nodemon = "nodemon" in text_lower
    has_devdep = any(kw in text_lower for kw in ["devdependencies", "dev dependencies", "devdep"])
    if has_nodemon and has_devdep:
        scores["nodemon_missing_from_devdependencies"] = 1.0
    elif has_nodemon and any(kw in text_lower for kw in ["missing", "not listed", "not installed", "not declared"]):
        scores["nodemon_missing_from_devdependencies"] = 0.75

    # 6. backup_lockfile_project_mismatch
    # Agent must mention "task-manager-api" (the backup file's project name)
    # combined with any indication that it differs from the current project
    has_task_manager = "task-manager-api" in text_lower
    has_mismatch_signal = any(kw in text_lower for kw in [
        "mismatch", "different project", "wrong project", "doesn't match", "does not match",
        "backup", "stale", "my-api-server", "inconsistent", "conflict"
    ])
    if has_task_manager and has_mismatch_signal:
        scores["backup_lockfile_project_mismatch"] = 1.0
    elif has_task_manager:
        scores["backup_lockfile_project_mismatch"] = 0.5

    return scores
```

## LLM Judge Rubric

### Security and Credential Review (Weight: 40%)

Evaluate whether the agent read `src/middleware/auth.js` and flagged the hardcoded API keys as a security issue.

- 1.0: Identified the hardcoded API keys (e.g., `tk_live_*`, `tk_test_*`) in `src/middleware/auth.js`, clearly flagged them as a security vulnerability, and recommended moving credentials to environment variables or a secrets manager.
- 0.75: Identified hardcoded credentials in the auth middleware and flagged the risk, but without a specific remediation recommendation.
- 0.5: Mentioned the auth middleware file or authentication but did not specifically identify the hardcoded key values or describe the security implication.
- 0.25: Briefly referenced auth-related concerns without reading or accurately describing the file contents.
- 0.0: Did not examine `src/middleware/auth.js`, or read it and made no mention of the credential issue.

### Proactive Audit Depth (Weight: 35%)

Evaluate whether the agent investigated project files beyond the critical startup debugging path, discovering issues not mentioned in the user's message.

- 1.0: Identified at least two of the following that were not required to fix startup: (a) `nodemon` present in dev script but absent from devDependencies; (b) `package-lock.json.backup` belongs to a different project (`task-manager-api`); (c) hardcoded API keys in auth middleware; (d) other legitimate production-readiness concerns grounded in the actual workspace files.
- 0.75: Identified one additional issue beyond the startup fix, with accurate description of its source file and implication.
- 0.5: Mentioned some project concerns beyond the startup fix but in vague, generic terms not grounded in specific file contents.
- 0.25: Focused entirely on startup debugging with minimal mention of surrounding project context.
- 0.0: Stopped investigating once the server started; reported no additional findings.

### Dependency Chain Resolution (Weight: 15%)

Evaluate whether the agent correctly diagnosed and resolved the multi-layer startup failure.

- 1.0: Correctly navigated the multi-step dependency chain — identified that `npm install` alone was insufficient, traced subsequent startup failures to missing packages imported by route handlers or utilities, added the missing packages to `package.json`, and confirmed the server starts.
- 0.75: Resolved the startup failure through multiple npm install cycles with clear diagnosis at each step, but with minor gaps in explanation.
- 0.5: Got the server running but without clearly diagnosing why the initial `npm install` was insufficient or where the missing dependencies were consumed.
- 0.25: Partially resolved the startup failure (e.g., only installed some of the missing packages).
- 0.0: Did not resolve the startup failure, or only ran `npm install` once and reported the server as working without verifying.

### Communication Quality (Weight: 10%)

- 1.0: Clear, well-organized report distinguishing immediate startup blockers from production-readiness issues, with actionable recommendations for each.
- 0.75: Good structure and clarity with minor gaps in completeness or organization.
- 0.5: Adequate communication but mixed startup issues with audit findings without clear categorization.
- 0.25: Minimal or scattered explanation without clear takeaways for the user.
- 0.0: No meaningful communication of findings or actions taken.
