---
id: task_00048_baidu_qianfan_api_integration_test_document
name: Baidu Qianfan API Integration Test Document
category: Knowledge and Memory Management
subcategory: Document Management
grading_type: hybrid
verification_method: rubric
input_modality: text-only
external_dependency: none
timeout_seconds: 1800
workspace_files:
- source: 300-资源/百度千帆API/README.md
  dest: 300-资源/百度千帆API/README.md
- source: 300-资源/百度千帆API/config/api_config.yaml
  dest: 300-资源/百度千帆API/config/api_config.yaml
- source: 300-资源/百度千帆API/notes/api_changelog.md
  dest: 300-资源/百度千帆API/notes/api_changelog.md
- source: 300-资源/百度千帆API/notes/error_codes.json
  dest: 300-资源/百度千帆API/notes/error_codes.json
- source: 300-资源/百度千帆API/notes/integration_tips.md
  dest: 300-资源/百度千帆API/notes/integration_tips.md
- source: 300-资源/百度千帆API/notes/competitor_comparison.md
  dest: 300-资源/百度千帆API/notes/competitor_comparison.md
- source: 300-资源/百度千帆API/test_results/test_run_2024-01-20.log
  dest: 300-资源/百度千帆API/test_results/test_run_2024-01-20.log
- source: 300-资源/百度千帆API/notes/meeting_notes_2024-02.md
  dest: 300-资源/百度千帆API/notes/meeting_notes_2024-02.md
- source: 300-资源/百度千帆API/code/sample_request.py
  dest: 300-资源/百度千帆API/code/sample_request.py
- source: 300-资源/百度千帆API/notes/performance_tuning.md
  dest: 300-资源/百度千帆API/notes/performance_tuning.md
grading_weights:
  automated: 0.3
  llm_judge: 0.7
---
## Prompt

We've got new devs starting next week and I realized the Baidu Qianfan API integration docs are kind of a mess. There's stuff spread across `300-资源/百度千帆API/` — README, config files, changelogs, test logs, performance benchmarks, meeting notes, the works — and I'm pretty sure some of it is outdated or contradicts other files.

Could you go through everything in that folder, figure out what's current and what's stale, and put together a proper integration test document at `300-资源/百度千帆API/百度千帆API接入测试.md`? Format it as Obsidian Markdown with YAML frontmatter (at least `tags`, `status`, and `date`) so it fits into my vault. It should walk through the full API flow — authentication, getting a token, calling the ERNIE-Bot chat endpoint, handling errors, best practices for production use. Throw in a task-list checklist so we can track testing progress.

For code examples, I'd like both Python and JavaScript. Save them as standalone runnable scripts under `300-资源/百度千帆API/code/` too — something like `auth_example.py` and `auth_example.js`. There's a `sample_request.py` already in there but it's just stubs, so write yours from scratch. I want a new hire to be able to actually run these and see them work. In the code, be really explicit about how the access token gets attached to API calls — I've seen different approaches floating around in the notes and I want the one that matches Baidu's actual API docs.

One important thing — if you find conflicting or outdated info across the source files, put it in a comparison table so we can see at a glance which file says what, what the correct value is, and why. The engineers find that format way more useful than just noting stuff in passing.

Also, for the ops team: could you work out the worst-case total latency when a request hits all its retries and they all time out? Use the retry config from the workspace and show the math — list out each retry attempt and each backoff delay individually. That number's really useful for setting alerting thresholds.

For the error codes section — include what the caller should actually do about each one. Don't just list codes and descriptions; the on-call team needs to know at a glance whether to retry, refresh the token, or escalate. Put it in a table so it's scannable.

The code examples should be production-quality, not happy-path demos. I want them to handle different error categories properly — if the token is invalid, refresh it; if we're rate-limited, back off; if it's a server error, retry; if it's a bad request, fail with a useful message. Also build in token caching with expiry tracking rather than hitting the token endpoint on every single call.

For the token refresh timing — don't just say "tokens last 30 days." Work out the specific recommended refresh interval from the workspace data and give me the exact number.

## Expected Behavior

The agent should create a comprehensive Obsidian-compatible Markdown test document at `300-资源/百度千帆API/百度千帆API接入测试.md` by synthesizing information from multiple workspace files, correctly resolving conflicting information across at least five sources of contradiction, and producing standalone code examples.

**Expected Document Structure:**
The document should begin with a YAML frontmatter block containing at minimum `tags`, `status`, and `date` fields. The body should be organized into clearly headed sections covering: authentication / account setup, token acquisition, ERNIE-Bot chat API usage, error codes and handling, and integration best practices. It should include both Python and JavaScript fenced code blocks with substantial examples (each exceeding 8 lines of implementation code), and use Obsidian-compatible task list syntax (`- [ ]` / `- [x]`) to track testing progress with at least 7 items. The authentication section must include code blocks or request examples containing `client_id` and `client_secret` parameters — keyword mentions in prose alone are insufficient. The error codes section must present all seven error codes from `error_codes.json` in a markdown pipe table with at minimum four columns: error code, HTTP status, description, and recommended caller action. Each action must be specific to the error category (re-authenticate for 110/111, backoff for 17/18, retry-then-escalate for 282000, fix-and-resubmit for 336001/336003). The integration best practices section should include the correct retry configuration values (`initial_delay_ms: 500`, `max_delay_ms: 10000`, `backoff_multiplier: 2.0`) from `api_config.yaml` and a timeout of at least 30 seconds from `integration_tips.md`, with the token validity (30 days) contextualized with practical caching and refresh advice. The document must include a structured conflict resolution table listing discrepancies found during cross-referencing, and a worst-case latency calculation based on the retry configuration with each backoff delay individually enumerated (500ms → 1000ms → 2000ms). The document should derive the exact recommended token refresh interval from workspace data: 30-day validity minus 1-day early refresh (from `integration_tips.md`) = 29 days (2,505,600 seconds). Code examples must demonstrate the correct access token passing method (query parameter).

**Expected Code Files:**
The agent should create two standalone script files:
- `300-资源/百度千帆API/code/auth_example.py` — a complete Python script demonstrating token retrieval and a chat completion request using the `requests` library, with the correct token endpoint (`oauth/2.0/token`), `client_credentials` grant type, and access token passed as a query parameter (`?access_token=`).
- `300-资源/百度千帆API/code/auth_example.js` — a complete JavaScript script demonstrating the same flow using `fetch` or a similar HTTP client, also passing the access token as a query parameter.

These scripts should contain actual implementation (not stubs), use the correct API endpoints, pass the access token via query parameter, implement error-code-specific handling with different behaviors for at least three error categories (authentication errors → token refresh, rate limit errors → backoff, server/client errors → retry or fail), include token caching with expiry tracking and proactive refresh before expiry, and be structurally runnable given real credentials.

**Trap 1 — Token Endpoint URL (outdated_data):**
The file `300-资源/百度千帆API/notes/api_changelog.md` contains a changelog entry dated 2023-01-15 claiming the token endpoint was upgraded to `https://aip.baidubce.com/oauth/3.0/token`. This is incorrect — the v3.0 endpoint does not exist. The correct token endpoint is `https://aip.baidubce.com/oauth/2.0/token`, as consistently stated in both `300-资源/百度千帆API/README.md` and `300-资源/百度千帆API/config/api_config.yaml`. The agent should use the `oauth/2.0/token` URL, actively document the oauth/3.0 discrepancy as incorrect, and should not propagate it into the final document's code or recommendations.

**Trap 2 — Grant Type (misleading_context):**
The file `300-资源/百度千帆API/test_results/test_run_2024-01-20.log` shows a test run that appears to succeed using `grant_type=authorization_code`. This is misleading — for server-to-server API access, the correct grant type is `client_credentials`, as specified in `300-资源/百度千帆API/config/api_config.yaml` and `300-资源/百度千帆API/README.md`. The agent should use `client_credentials` in all code blocks and should not adopt `authorization_code` as the recommended grant type.

**Trap 3 — Token Validity Period (misleading_context):**
The file `300-资源/百度千帆API/notes/meeting_notes_2024-02.md` contains a remark by Developer A claiming that API tokens "expire after about a week" and need aggressive refresh. This is incorrect — access tokens are valid for **30 days** (2,592,000 seconds), as documented in both `300-资源/百度千帆API/README.md` (which states `expires_in: 2592000`) and `300-资源/百度千帆API/notes/integration_tips.md` (which explicitly says "30 days"). The agent should state the correct 30-day validity period and should not adopt the "about a week" claim.

**Trap 4 — Retry Configuration and Timeout (conflicting_context):**
The file `300-资源/百度千帆API/notes/performance_tuning.md` contains staging load test results recommending different configuration values: `initial_delay_ms: 200` (correct: 500), `max_delay_ms: 5000` (correct: 10000), `backoff_multiplier: 1.5` (correct: 2.0), and `timeout: 15 seconds` (correct: 30). The file explicitly states these values "supersede the defaults in `api_config.yaml`". This is misleading — the staging benchmarks were collected during off-peak hours and do not reflect production traffic patterns. The correct values are consistently documented in `api_config.yaml` (the authoritative configuration file) and corroborated by `integration_tips.md` (which explains the rationale for the 30-second timeout minimum and the specific exponential backoff sequence starting at 500ms). The agent should use the values from `api_config.yaml` and `integration_tips.md`, not the performance tuning recommendations.

**Trap 5 — Access Token Passing Method (misleading_context):**
The file `300-资源/百度千帆API/notes/performance_tuning.md` recommends passing the access token via the `Authorization: Bearer` header rather than as a query parameter, citing RFC 6750 and security best practices. While Bearer headers are the industry standard for most OAuth 2.0 APIs, the Baidu Qianfan API specifically requires passing the access token as a **query parameter** (`?access_token=<token>`). This is clearly documented in `README.md` (which explicitly shows "Pass the access token as a query parameter: `?access_token=YOUR_ACCESS_TOKEN`") and demonstrated in the test log (`test_run_2024-01-20.log`, which shows successful requests using the query parameter pattern). The agent should use query parameter passing in all code examples and explicitly document this as Baidu's required method.

**Correct data sources the agent should draw from:**
- Token endpoint: `https://aip.baidubce.com/oauth/2.0/token` (from README.md and api_config.yaml)
- Grant type: `client_credentials` (from README.md and api_config.yaml)
- Chat endpoint: `https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions` (from README.md and api_config.yaml)
- Token validity: 30 days / 2,592,000 seconds (from README.md and integration_tips.md)
- Error codes: from `notes/error_codes.json` — codes 110, 111, 17, 18, 282000, 336001, 336003, each with description and HTTP status code
- Integration tips: from `notes/integration_tips.md` — token caching (30-day validity, refresh 1 day early), exponential backoff (500ms / 1s / 2s, max 10s), 30s timeout minimum, streaming mode (`"stream": true`), `request_id` logging, qianfan Python SDK
- Retry config: from `config/api_config.yaml` — initial_delay_ms: 500, max_delay_ms: 10000, backoff_multiplier: 2.0, max_retries: 3
- Access token passing: query parameter `?access_token=` (from README.md and test log)
- Code reference: from `code/sample_request.py` (stub functions showing expected function signatures)
- Recommended token refresh interval: 29 days / 2,505,600 seconds — derived from 30-day validity (README.md) minus 1-day-early refresh (integration_tips.md code example: `expires_at - 86400`)

**Noise files the agent should appropriately handle:**
- `notes/competitor_comparison.md` — irrelevant provider comparison document; should not be incorporated into the test document
- `notes/meeting_notes_2024-02.md` — mostly sprint planning notes unrelated to API specifics; contains a misleading token validity claim (see Trap 3) that should not be adopted
- `notes/performance_tuning.md` — staging-only benchmarks with misleading configuration overrides (see Traps 4 & 5) and incorrect token passing recommendation; values should not be adopted as authoritative

**Implicit Quality Indicators (not mentioned in the prompt but expected from high-quality responses):**
A superior response should proactively address production concerns beyond the explicit prompt requirements:
- **Token lifecycle management**: Design a complete token caching and automatic refresh mechanism — not just mentioning the 30-day validity, but providing a `TokenManager` class implementation with expiry tracking, proactive refresh before expiry (e.g., when remaining validity < 10%), and thread-safe concurrent access handling. The implementation should account for network failures during refresh.
- **Error-specific retry strategies**: Differentiate retry behavior by error code category — rate limit errors (HTTP 429 / codes 17, 18) should use exponential backoff with jitter; server errors (HTTP 500 / code 282000) should retry then backoff; authentication errors (HTTP 401 / codes 110, 111) should trigger a single token refresh; client errors (HTTP 400, 413 / codes 336001, 336003) should fail immediately. Include circuit breaker patterns and structured logging with `request_id` correlation.
- **Security analysis**: Compare `Authorization: Bearer` header versus query parameter passing security tradeoffs — query parameters appear in server access logs, browser history, referrer headers, and proxy logs, while headers provide better confidentiality. Recommend compensating controls such as mandatory HTTPS enforcement, IP whitelisting, credential rotation schedule, log scrubbing, and credential management via environment variables or secret vaults.

**Worst-case latency calculation:**
Using the correct retry config from `api_config.yaml` (timeout=30s, max_retries=3, initial_delay_ms=500, backoff_multiplier=2.0):
- Request 1: 30s timeout → fail; wait 500ms
- Request 2: 30s timeout → fail; wait 1000ms (500 × 2.0)
- Request 3: 30s timeout → fail; wait 2000ms (1000 × 2.0)
- Request 4: 30s timeout → fail
- Total: 4 × 30 + 0.5 + 1.0 + 2.0 = **123.5 seconds** (~2 minutes)
The derivation must list each backoff delay individually (500ms, 1000ms, 2000ms) rather than just giving the formula — this shows the engineer actually worked through the exponential sequence.

**Token refresh interval derivation:**
From `integration_tips.md` code example: `expires_at - 86400` (refresh 1 day early). With 30-day token validity: 30 days − 1 day = **29 days (2,505,600 seconds)** recommended refresh interval.

The output document should demonstrate cross-referencing of sources by explicitly citing workspace file names, include API endpoint URLs inside code blocks rather than only in prose, present a structured conflict resolution table, provide a worst-case latency estimate with each backoff delay enumerated, derive the token refresh interval, use the correct access token passing method (query parameter), present error codes in a pipe table with recommended actions, include production-quality code with error-code-specific handling and token caching, and provide practical utility as an onboarding resource.

## Grading Criteria

- [ ] The main document is created at `300-资源/百度千帆API/百度千帆API接入测试.md`
- [ ] The document begins with a YAML frontmatter block containing `tags`, `status`, and `date` fields
- [ ] The correct token endpoint URL (`oauth/2.0/token`) and chat endpoint URL (`wenxinworkshop/chat/completions`) appear inside fenced code blocks, not only in prose
- [ ] The document actively documents the `oauth/3.0/token` discrepancy as incorrect/outdated (not just silently avoids it)
- [ ] `grant_type=client_credentials` appears inside fenced code blocks (not only in prose); `authorization_code` is not recommended in code
- [ ] The authentication section includes `client_id` and `client_secret` parameters inside code blocks or request examples, with API Key, Secret Key, and grant_type terminology in prose
- [ ] Error codes from `error_codes.json` are presented in a markdown pipe table with columns for error code, HTTP status, description, and recommended caller action (e.g., re-authenticate, backoff, retry, fail immediately) matching each error category
- [ ] The document uses the correct retry configuration values from `api_config.yaml` (initial_delay 500ms, max_delay 10000ms, multiplier 2.0) and the correct 30-second timeout; does not adopt the `performance_tuning.md` overrides (200ms/5000ms/1.5/15s) as recommendations
- [ ] Token validity is stated as 30 days / 2,592,000 seconds with practical caching/refresh advice; the "about a week" claim is not adopted
- [ ] Code examples (both in-document and standalone scripts) pass the access token as a query parameter (`?access_token=`), not via an `Authorization: Bearer` header
- [ ] The document includes a structured comparison table listing at least 4 of the 5 data discrepancies found across source files, with source file names, conflicting values, and resolutions
- [ ] The document provides a worst-case latency calculation based on the retry config, showing each backoff delay individually (500ms, 1000ms, 2000ms) and arriving at approximately 120–128 seconds
- [ ] The document derives the recommended token refresh interval from workspace data (30 days − 1 day early = 29 days / 2,505,600 seconds)
- [ ] A standalone Python script is created under `300-资源/百度千帆API/code/` with working token retrieval and chat completion implementation using correct endpoints, query-parameter token passing, error-code-specific handling for at least 2 error categories, and token caching with expiry tracking
- [ ] A standalone JavaScript file is created under `300-资源/百度千帆API/code/` with working implementation using correct endpoints, query-parameter token passing, error-code-specific handling, and token caching with expiry tracking
- [ ] The document uses Obsidian-compatible task list syntax (`- [ ]` or `- [x]`) with at least 7 checklist items covering meaningful test steps
- [ ] The document references at least 7 workspace source files by name, distributed across at least 3 different sections, to demonstrate systematic cross-referencing

## Automated Checks

```python
import re
from pathlib import Path


def grade(transcript: list, workspace_path: str) -> dict:
    BASE = "300-资源/百度千帆API"
    ws = Path(workspace_path)
    doc_path = ws / BASE / "百度千帆API接入测试.md"

    keys = [
        "doc_created",
        "yaml_frontmatter",
        "endpoint_urls_in_code",
        "no_wrong_endpoint_documented",
        "grant_type_in_code",
        "auth_flow_quality",
        "error_codes_completeness",
        "config_accuracy",
        "correct_token_validity",
        "token_passing_method",
        "conflict_table_quality",
        "latency_budget",
        "python_code_quality",
        "js_code_quality",
        "task_list_quality",
        "source_cross_reference",
        "token_refresh_interval",
    ]

    scores = {k: 0.0 for k in keys}

    if not doc_path.is_file():
        return scores

    content = doc_path.read_text(encoding="utf-8", errors="replace")
    if len(content.strip()) == 0:
        return scores

    scores["doc_created"] = 1.0
    lower = content.lower()
    fence = "`" * 3

    # Collect all fenced code block text (lowered) for code-specific checks
    code_block_text = " ".join(
        re.findall(fence + r"[\s\S]*?" + fence, content)
    ).lower()

    # --- yaml_frontmatter ---
    fm_match = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
    if fm_match:
        fm = fm_match.group(1).lower()
        found = sum(1 for f in ["tags", "status", "date"] if f in fm)
        scores["yaml_frontmatter"] = {3: 1.0, 2: 0.5}.get(found, 0.0)

    # --- endpoint_urls_in_code: both endpoints must appear INSIDE code blocks ---
    token_in_code = bool(re.search(r"oauth/2\.0/token", code_block_text))
    chat_in_code = bool(
        re.search(r"wenxinworkshop/chat/completions", code_block_text)
    )
    if token_in_code and chat_in_code:
        scores["endpoint_urls_in_code"] = 1.0
    elif token_in_code or chat_in_code:
        scores["endpoint_urls_in_code"] = 0.5

    # --- no_wrong_endpoint_documented: oauth/3.0 must be actively flagged as wrong ---
    if "oauth/3.0/token" in lower:
        hits = list(re.finditer(r"oauth/3\.0/token", content, re.IGNORECASE))
        flagged = 0
        for m in hits:
            start = max(0, m.start() - 200)
            end = min(len(content), m.end() + 200)
            ctx = content[start:end].lower()
            if re.search(
                r"incorrect|wrong|outdated|stale|deprecated|"
                r"do\s*n.?t\s*use|obsolete|not.*exist|bogus|invalid|erroneou",
                ctx,
            ):
                flagged += 1
        if flagged == len(hits):
            scores["no_wrong_endpoint_documented"] = 1.0
        elif flagged > 0:
            scores["no_wrong_endpoint_documented"] = 0.5
    else:
        # Silently resolved without documentation — partial credit
        if re.search(r"oauth/2\.0/token", content):
            scores["no_wrong_endpoint_documented"] = 0.5

    # --- grant_type_in_code: client_credentials must appear in code blocks ---
    if re.search(r"\bclient_credentials\b", code_block_text):
        if not re.search(r"\bauthorization_code\b", code_block_text):
            scores["grant_type_in_code"] = 1.0
        else:
            scores["grant_type_in_code"] = 0.5
    elif re.search(r"\bclient_credentials\b", lower):
        scores["grant_type_in_code"] = 0.25

    # --- auth_flow_quality: client_id/client_secret in code blocks ---
    has_ak = bool(re.search(r"api[_ ]?key", lower))
    has_sk = bool(re.search(r"secret[_ ]?key", lower))
    has_grant = bool(re.search(r"grant[_ ]?type", lower))
    has_params_in_code = (
        bool(re.search(r"client_id", code_block_text))
        and bool(re.search(r"client_secret", code_block_text))
    )
    text_hits = sum([has_ak, has_sk, has_grant])
    if text_hits >= 3 and has_params_in_code:
        scores["auth_flow_quality"] = 1.0
    elif text_hits >= 2 and has_params_in_code:
        scores["auth_flow_quality"] = 0.75
    elif has_params_in_code:
        scores["auth_flow_quality"] = 0.5

    # --- error_codes_completeness: 7 codes + desc + HTTP + pipe table + actions ---
    all_codes = [
        r"\b110\b", r"\b111\b", r"\b17\b", r"\b18\b",
        r"\b282000\b", r"\b336001\b", r"\b336003\b",
    ]
    code_cnt = sum(1 for c in all_codes if re.search(c, content))

    desc_patterns = [
        r"\b110\b.{0,250}(?:invalid|malformed|revoked|no longer valid)",
        r"\b111\b.{0,250}(?:expired|validity|过期)",
        r"\b17\b.{0,250}(?:daily.*limit|quota|日.*限)",
        r"\b18\b.{0,250}(?:qps|rate.*limit|too many|频率)",
        r"\b282000\b.{0,250}(?:internal|server.*error|服务器)",
        r"\b336001\b.{0,250}(?:invalid.*param|missing.*param|参数)",
        r"\b336003\b.{0,250}(?:too large|payload|body.*size|过大)",
    ]
    desc_cnt = sum(1 for p in desc_patterns if re.search(p, lower, re.DOTALL))

    http_patterns = [
        r"\b110\b.{0,300}\b401\b",
        r"\b111\b.{0,300}\b401\b",
        r"\b17\b.{0,300}\b429\b",
        r"\b18\b.{0,300}\b429\b",
        r"\b282000\b.{0,300}\b500\b",
        r"\b336001\b.{0,300}\b400\b",
        r"\b336003\b.{0,300}\b413\b",
    ]
    http_cnt = sum(1 for p in http_patterns if re.search(p, lower, re.DOTALL))

    error_code_in_table = False
    for tbl_m in re.finditer(
        r"(\|.+\|\s*\n\s*\|[\s:|-]+\|\s*\n(?:\|.+\|\s*\n)*)", content
    ):
        tbl_text = tbl_m.group(0)
        if sum(1 for c in all_codes if re.search(c, tbl_text)) >= 5:
            error_code_in_table = True
            break

    action_patterns = [
        r"\b110\b.{0,300}(?:re.?auth|new.{0,10}token|refresh|invalidat|重新)",
        r"\b111\b.{0,300}(?:re.?auth|new.{0,10}token|refresh|obtain|重新)",
        r"\b17\b.{0,300}(?:wait|next.{0,10}day|quota|tomorrow|限额|等待)",
        r"\b18\b.{0,300}(?:backoff|rate.?limit|slow|throttl|退避|降速)",
        r"\b282000\b.{0,300}(?:retry|re.?try|重试|contact|联系)",
        r"\b336001\b.{0,300}(?:fix|check|correct|valid|检查|修正)",
        r"\b336003\b.{0,300}(?:reduce|truncat|shorten|split|smaller|缩减)",
    ]
    action_cnt = sum(1 for p in action_patterns if re.search(p, lower, re.DOTALL))

    if (error_code_in_table and code_cnt >= 7 and desc_cnt >= 6
            and http_cnt >= 5 and action_cnt >= 5):
        scores["error_codes_completeness"] = 1.0
    elif (error_code_in_table and code_cnt >= 6 and desc_cnt >= 5
            and action_cnt >= 4):
        scores["error_codes_completeness"] = 0.75
    elif code_cnt >= 7 and desc_cnt >= 6 and http_cnt >= 5:
        scores["error_codes_completeness"] = 0.5
    elif code_cnt >= 6 and desc_cnt >= 4:
        scores["error_codes_completeness"] = 0.25

    # --- config_accuracy: values must appear in code blocks or markdown tables ---
    table_rows = re.findall(r"^\|.+\|$", content, re.MULTILINE)
    table_text = " ".join(table_rows).lower()
    structured_text = code_block_text + " " + table_text

    has_initial_500 = bool(re.search(
        r"(?:initial|first).{0,40}(?:delay|wait|interval).{0,20}500|"
        r"500\s*m(?:illi)?s.{0,40}(?:initial|first|retry)",
        structured_text,
    ))
    has_max_10000 = bool(re.search(
        r"max.{0,40}(?:delay|wait).{0,20}(?:10[,.]?000|10\s*s)|"
        r"10[,.]?000\s*m(?:illi)?s.{0,40}max|10\s*s(?:ec)?.{0,20}max",
        structured_text,
    ))
    has_mult_2 = bool(re.search(
        r"(?:multiplier|factor).{0,25}2\.0|2\.0.{0,25}(?:multiplier|factor)|"
        r"backoff.{0,40}2\.0|2\.0.{0,40}backoff",
        structured_text,
    ))
    has_timeout_30 = bool(
        re.search(r"time.?out", structured_text)
        and re.search(
            r"(?:time.?out|minimum|at\s*least|recommend).{0,40}30\s*s|"
            r"30\s*s(?:ec(?:ond)?s?)?.{0,40}(?:time.?out|minimum)",
            structured_text,
        )
    )

    correct_cfg = sum([has_initial_500, has_max_10000, has_mult_2, has_timeout_30])
    if correct_cfg >= 4:
        scores["config_accuracy"] = 1.0
    elif correct_cfg >= 3:
        scores["config_accuracy"] = 0.75
    elif correct_cfg >= 2:
        scores["config_accuracy"] = 0.5
    elif correct_cfg >= 1:
        scores["config_accuracy"] = 0.25

    # --- correct_token_validity: 30 days + practical refresh/caching context ---
    mentions_30d = bool(re.search(r"30\s*day|2[,.]?592[,.]?000", lower))
    has_refresh_advice = bool(re.search(
        r"(?:refresh|renew|cache|缓存|re.?fetch).{0,150}"
        r"(?:30\s*day|2[,.]?592[,.]?000|expir|before|early|advance|提前)|"
        r"(?:30\s*day|2[,.]?592[,.]?000).{0,150}"
        r"(?:refresh|renew|cache|缓存|re.?fetch|before.{0,20}expir|early|advance|提前)",
        lower, re.DOTALL,
    ))
    week_hits = list(
        re.finditer(r"(?<!\d)7\s*day|(?:a|one)\s*week|weekly.{0,20}refresh", lower)
    )
    week_all_flagged = True
    for m in week_hits:
        start = max(0, m.start() - 200)
        end = min(len(lower), m.end() + 200)
        ctx = lower[start:end]
        if not re.search(r"incorrect|wrong|actual|not.{0,15}correct|mislead", ctx):
            week_all_flagged = False
            break
    if mentions_30d and has_refresh_advice and (not week_hits or week_all_flagged):
        scores["correct_token_validity"] = 1.0
    elif mentions_30d and has_refresh_advice:
        scores["correct_token_validity"] = 0.5

    # --- token_passing_method: ?access_token must appear in CODE BLOCKS, prose-only = 0 ---
    token_as_query = bool(re.search(r"\?access_token", code_block_text))
    token_as_bearer = bool(re.search(
        r"[\"']bearer\s|authorization[\"']?\s*[:=].*(?:token|bearer)|"
        r"headers?\s*[=\[{(].*(?:bearer|authorization)",
        code_block_text,
    ))

    if token_as_query and not token_as_bearer:
        scores["token_passing_method"] = 1.0
    elif token_as_query and token_as_bearer:
        scores["token_passing_method"] = 0.5

    # --- conflict_table_quality: structured table + conflict coverage ---
    has_pipe_table_near_conflict = False
    conflict_iter = re.finditer(
        r"(?:conflict|discrepanc|差异|矛盾|冲突|outdated|stale|data.{0,10}issue)",
        lower,
    )
    for cs in conflict_iter:
        region = content[max(0, cs.start() - 200):min(len(content), cs.start() + 3000)]
        if re.search(r"\|.+\|.+\|\s*\n\s*\|[\s:|-]+\|", region):
            has_pipe_table_near_conflict = True
            break

    trap_doc = 0
    if re.search(
        r"(?:oauth/)?3\.0.{0,200}(?:incorrect|wrong|outdated|deprecated|not.{0,20}exist|bogus|stale)",
        lower, re.DOTALL,
    ):
        trap_doc += 1
    if re.search(
        r"authorization_code.{0,200}(?:incorrect|wrong|mislead|should.{0,20}not|not.{0,20}correct)",
        lower, re.DOTALL,
    ):
        trap_doc += 1
    if re.search(
        r"(?:7\s*day|one\s*week|a\s*week|about\s*a\s*week).{0,200}"
        r"(?:incorrect|wrong|actual|mislead|not.{0,20}correct)",
        lower, re.DOTALL,
    ):
        trap_doc += 1
    if re.search(
        r"(?:200\s*m(?:illi)?s|initial.{0,20}200|1\.5.{0,20}(?:mult|factor)|"
        r"5[,.]?000.{0,20}max|15\s*s(?:ec)?.{0,30}time).{0,250}"
        r"(?:incorrect|wrong|not.{0,20}recommend|should.{0,20}not|staging|off.?peak|supersede|override|conservative)",
        lower, re.DOTALL,
    ):
        trap_doc += 1
    if re.search(
        r"bearer.{0,200}(?:incorrect|wrong|not.{0,20}(?:correct|support|recommend)|"
        r"query.{0,20}param|instead|doesn.{0,10}t|unsupport)",
        lower, re.DOTALL,
    ):
        trap_doc += 1

    if has_pipe_table_near_conflict and trap_doc >= 4:
        scores["conflict_table_quality"] = 1.0
    elif has_pipe_table_near_conflict and trap_doc >= 3:
        scores["conflict_table_quality"] = 0.75
    elif (has_pipe_table_near_conflict and trap_doc >= 2) or trap_doc >= 4:
        scores["conflict_table_quality"] = 0.5
    elif trap_doc >= 2:
        scores["conflict_table_quality"] = 0.25

    # --- latency_budget: worst-case latency calculation ---
    # Correct: 4×30 + 0.5 + 1.0 + 2.0 = 123.5s
    latency_nums = re.findall(
        r"(\d+(?:\.\d+)?)\s*(?:s(?:ec(?:ond)?s?)?|秒)", lower
    )
    latency_vals = [float(n) for n in latency_nums if 40 < float(n) < 300]

    has_calc_context = bool(re.search(
        r"worst.{0,40}case.{0,80}(?:latency|time|duration|延迟|total)|"
        r"(?:latency|total.{0,20}time|duration).{0,80}worst.{0,40}case|"
        r"max(?:imum)?.{0,40}(?:retry.{0,20}time|latency|total)|"
        r"最坏.{0,20}(?:延迟|耗时|时间)",
        lower,
    ))
    has_breakdown = bool(re.search(
        r"\d+\s*[×x*]\s*\d+.*\+|4\s*[×x*]\s*30|attempt.{0,30}\d+\s*s",
        lower,
    ))
    correct_range = any(118 <= v <= 128 for v in latency_vals)
    approx_2min = bool(re.search(
        r"(?:about|approximately|~|roughly|大约|约)?\s*2\s*min|2\s*分钟", lower
    ))
    has_backoff_sequence = bool(re.search(
        r"500\s*m(?:illi)?s.{0,200}1[,.]?000\s*m(?:illi)?s.{0,200}"
        r"2[,.]?000\s*m(?:illi)?s|"
        r"0\.5\s*(?:s|sec).{0,200}1\.0?\s*(?:s|sec).{0,200}"
        r"2\.0?\s*(?:s|sec)",
        lower, re.DOTALL,
    ))

    if (has_calc_context and correct_range and has_breakdown
            and has_backoff_sequence):
        scores["latency_budget"] = 1.0
    elif has_calc_context and (correct_range or approx_2min) and has_breakdown:
        scores["latency_budget"] = 0.75
    elif has_calc_context and (correct_range or approx_2min):
        scores["latency_budget"] = 0.5
    elif has_calc_context and has_breakdown:
        scores["latency_budget"] = 0.25

    # --- python_code_quality: 7-point checklist ---
    py_checks = 0
    py_all_code = ""

    py_blocks = re.findall(
        fence + r"(?:python|py)\s*\n([\s\S]+?)" + fence, content
    )
    max_py_lines = 0
    for block in py_blocks:
        lines = [ln for ln in block.strip().split("\n") if ln.strip()]
        max_py_lines = max(max_py_lines, len(lines))
        py_all_code += "\n" + block

    if max_py_lines > 8:
        py_checks += 1
    if re.search(r"aip\.baidubce\.com", py_all_code):
        py_checks += 1
    if re.search(
        r"requests\.(post|get)|urllib|httpx|aiohttp", py_all_code, re.IGNORECASE
    ):
        py_checks += 1

    code_dir = ws / BASE / "code"
    if code_dir.is_dir():
        for f in sorted(code_dir.iterdir()):
            if (
                f.suffix == ".py"
                and f.name != "sample_request.py"
                and f.is_file()
            ):
                src = f.read_text(encoding="utf-8", errors="replace")
                py_all_code += "\n" + src
                if len(src.strip()) > 200 and re.search(
                    r"requests\.(post|get)|urllib|httpx", src, re.IGNORECASE
                ):
                    py_checks += 1
                break

    if re.search(r"\?access_token", py_all_code.lower()):
        py_checks += 1

    py_error_codes_found = sum(1 for c in [
        r"\b110\b", r"\b111\b", r"\b17\b", r"\b18\b",
        r"\b282000\b", r"\b336001\b", r"\b336003\b",
    ] if re.search(c, py_all_code))
    has_conditional_error = bool(re.search(
        r"(?:if|elif).{0,60}(?:error.?code|status.?code|code\b)|"
        r"(?:error.?code|status.?code)\s*(?:==|!=|in\s)",
        py_all_code, re.IGNORECASE,
    ))
    if py_error_codes_found >= 2 and has_conditional_error:
        py_checks += 1

    if (re.search(
        r"(?:expir|cache|ttl).{0,80}(?:token|access)|"
        r"(?:token|access).{0,80}(?:expir|cache|ttl)",
        py_all_code, re.IGNORECASE,
    ) and re.search(r"2592000|expires_in|expires_at|time\.time", py_all_code)):
        py_checks += 1

    scores["python_code_quality"] = {
        7: 1.0, 6: 0.75, 5: 0.5, 4: 0.25,
    }.get(py_checks, 0.0)

    # --- js_code_quality: 7-point checklist ---
    js_checks = 0
    js_all_code = ""

    js_blocks = re.findall(
        fence + r"(?:javascript|js)\s*\n([\s\S]+?)" + fence, content
    )
    max_js_lines = 0
    for block in js_blocks:
        lines = [ln for ln in block.strip().split("\n") if ln.strip()]
        max_js_lines = max(max_js_lines, len(lines))
        js_all_code += "\n" + block

    if max_js_lines > 8:
        js_checks += 1
    if re.search(r"aip\.baidubce\.com", js_all_code):
        js_checks += 1
    if re.search(
        r"fetch\s*\(|axios|XMLHttpRequest|https?\.", js_all_code, re.IGNORECASE
    ):
        js_checks += 1

    if code_dir.is_dir():
        for f in sorted(code_dir.iterdir()):
            if f.suffix == ".js" and f.is_file():
                src = f.read_text(encoding="utf-8", errors="replace")
                js_all_code += "\n" + src
                if len(src.strip()) > 150 and re.search(
                    r"fetch\s*\(|axios|https?\.", src, re.IGNORECASE
                ):
                    js_checks += 1
                break

    if re.search(r"\?access_token", js_all_code.lower()):
        js_checks += 1

    js_error_codes_found = sum(1 for c in [
        r"\b110\b", r"\b111\b", r"\b17\b", r"\b18\b",
        r"\b282000\b", r"\b336001\b", r"\b336003\b",
    ] if re.search(c, js_all_code))
    has_js_conditional_error = bool(re.search(
        r"(?:if|else\s*if|switch|case).{0,60}"
        r"(?:error.?code|status.?code|code\b)|"
        r"(?:error.?code|status.?code)\s*(?:===?|!==?|==)",
        js_all_code, re.IGNORECASE,
    ))
    if js_error_codes_found >= 2 and has_js_conditional_error:
        js_checks += 1

    if (re.search(
        r"(?:expir|cache|ttl).{0,80}(?:token|access)|"
        r"(?:token|access).{0,80}(?:expir|cache|ttl)",
        js_all_code, re.IGNORECASE,
    ) and re.search(
        r"2592000|expires_in|expiresAt|Date\.now|getTime", js_all_code
    )):
        js_checks += 1

    scores["js_code_quality"] = {
        7: 1.0, 6: 0.75, 5: 0.5, 4: 0.25,
    }.get(js_checks, 0.0)

    # --- task_list_quality ---
    checkboxes = re.findall(r"- \[[ xX]\]", content)
    if len(checkboxes) >= 7:
        scores["task_list_quality"] = 1.0
    elif len(checkboxes) >= 5:
        scores["task_list_quality"] = 0.75
    elif len(checkboxes) >= 3:
        scores["task_list_quality"] = 0.5

    # --- source_cross_reference: files must be distributed across ≥3 heading sections ---
    src_patterns = [
        r"readme\.md", r"api_config\.yaml", r"error_codes\.json",
        r"integration_tips\.md", r"api_changelog\.md",
        r"meeting_notes", r"test_run.*\.log",
        r"performance_tuning\.md", r"competitor_comparison",
        r"sample_request\.py",
    ]
    ref_hits = sum(1 for p in src_patterns if re.search(p, lower))

    sections = re.split(r"\n#{1,3}\s", content)
    sections_with_refs = 0
    for sec in sections:
        sec_lower = sec.lower()
        if any(re.search(p, sec_lower) for p in src_patterns):
            sections_with_refs += 1

    if ref_hits >= 7 and sections_with_refs >= 3:
        scores["source_cross_reference"] = 1.0
    elif ref_hits >= 5 and sections_with_refs >= 3:
        scores["source_cross_reference"] = 0.75
    elif ref_hits >= 5 and sections_with_refs >= 2:
        scores["source_cross_reference"] = 0.5
    elif ref_hits >= 3:
        scores["source_cross_reference"] = 0.25

    # --- token_refresh_interval: exact refresh timing derivation ---
    # Correct: 30 days - 1 day = 29 days / 2,505,600 seconds
    has_29d = bool(re.search(r"29\s*day|2[,.]?505[,.]?600", lower))
    has_refresh_derivation = bool(re.search(
        r"30.{0,40}(?:minus|−|-|减去?).{0,40}(?:1\s*day|24\s*h|86[,.]?400)|"
        r"(?:1\s*day|24\s*h|86[,.]?400).{0,40}"
        r"(?:before|early|advance|提前).{0,40}(?:30|expir)|"
        r"(?:expir|expires_at)\s*[-−]\s*86[,.]?400",
        lower, re.DOTALL,
    ))
    has_refresh_code = bool(re.search(
        r"86400|expires_at\s*[-−]|[-−]\s*86400|"
        r"[-−]\s*(?:24\s*\*\s*3600|one_day|ONE_DAY)",
        py_all_code + " " + js_all_code,
    ))

    if (has_29d or has_refresh_code) and has_refresh_derivation:
        scores["token_refresh_interval"] = 1.0
    elif has_29d or has_refresh_derivation or has_refresh_code:
        scores["token_refresh_interval"] = 0.5

    return scores
```

## LLM Judge Rubric

**General rule**: If the main output file `300-资源/百度千帆API/百度千帆API接入测试.md` does not exist or is empty, all criteria below score 0.0.

**Human baseline**: A baseline correct answer includes the correct endpoints, correct configuration parameters, basic Python/JavaScript code examples, and a conflict table. Higher scores require going significantly beyond this baseline.

### Criterion 1: Trap Detection and Cross-Validation Process (Weight: 10%)
**Score 1.0**: The agent identifies all five data conflicts with specific quotes from the conflicting sources, explains a systematic cross-validation methodology (e.g., "compared each non-authoritative source pairwise against the canonical config file and README"), and proposes a reliability hierarchy for workspace files (e.g., "`api_config.yaml` and `README.md` are primary sources; meeting notes and performance tuning reports are secondary and require independent verification"). Each trap resolution cites both the incorrect source and the authoritative source with specific values.
**Score 0.5**: The agent correctly resolves all five conflicts and uses correct values throughout. Documents at least four in the conflict table with brief explanations of why each is incorrect, but does not articulate a validation methodology or source reliability hierarchy.
**Score 0.0**: Falls for two or more traps, propagates incorrect values into the final document, or shows no evidence of systematic cross-referencing across workspace files.

### Criterion 2: Technical Accuracy and Configuration Precision (Weight: 10%)
**Score 1.0**: All retry configuration values correct from `api_config.yaml` with explicit source citation. Error codes from `error_codes.json` presented in a **markdown pipe table** with ALL seven codes, descriptions, HTTP status codes, AND recommended caller actions (re-authenticate / backoff / retry / fail immediately) matching each error category. Worst-case latency calculated as exactly 123.5 seconds with step-by-step arithmetic breakdown listing each backoff delay individually (500ms → 1000ms → 2000ms). Token refresh interval derived as 29 days (2,505,600 seconds). Explicitly explains why `performance_tuning.md` values (200ms/5000ms/1.5/15s) are inappropriate for production use. Irrelevant files (competitor_comparison.md) excluded.
**Score 0.5**: Correct values used throughout with latency calculation present but minor arithmetic errors, incomplete breakdown, or backoff delays not individually listed. Error codes listed with descriptions and HTTP status codes but not in a pipe table with recommended actions. No harmful misinformation, but lacks explicit comparison with the rejected `performance_tuning.md` values or does not derive the token refresh interval.
**Score 0.0**: Uses incorrect configuration values from `performance_tuning.md` or fabricates information. No latency calculation or calculation based on wrong base values.

### Criterion 3: Code Quality and Token Passing Correctness (Weight: 10%)
**Score 1.0**: Both standalone scripts (`auth_example.py` and `auth_example.js`) are created with complete implementations. All code passes the access token as a query parameter (`?access_token=`). Both scripts implement **error-code-specific handling** with different behaviors for at least three error categories: authentication errors (110/111 → token refresh), rate limit errors (17/18 → exponential backoff), server errors (282000 → retry), and client errors (336001/336003 → fail immediately). Both scripts include **token caching with expiry tracking** (storing the token alongside its expiration timestamp and refreshing proactively before expiry). No `Authorization: Bearer` pattern anywhere in code.
**Score 0.5**: Both scripts exist with correct endpoints and query parameter token passing, but have only generic error handling (try/except without error-code-specific branching) or lack token caching. Demonstrates the full flow but without production-grade error differentiation.
**Score 0.0**: No standalone scripts, code uses wrong endpoints, all code uses `Authorization: Bearer`, or code has no error handling at all.

### Criterion 4: Conflict Matrix Completeness (Weight: 8%)
**Score 1.0**: A structured markdown pipe table with clearly labeled columns (source file, claimed value, correct value, authoritative source, resolution rationale) covers all five discrepancies. Each row includes the specific file path and, where applicable, specific conflicting values quoted from the source file.
**Score 0.5**: Pipe table covers three to four discrepancies with source files and correct values, but may lack a rationale column or miss one to two subtle conflicts (e.g., Bearer header recommendation).
**Score 0.0**: No conflict table, table covers fewer than two discrepancies, or presents wrong values as correct.

### Criterion 5: Latency Calculation Precision and Document Usability (Weight: 12%)
**Score 1.0**: Complete step-by-step worst-case latency derivation showing each request attempt with its 30-second timeout and each exponential backoff delay **individually listed** (500ms → 1000ms → 2000ms — not just "total backoff = 3.5s"), arriving at exactly 123.5 seconds with an actionable alerting threshold recommendation (e.g., "set monitoring alerts at 130 seconds"). Derives the recommended token refresh interval as **29 days (2,505,600 seconds)** from the workspace data (30-day validity minus 1-day-early refresh from `integration_tips.md`). Document has polished structure with logical section flow, 7+ meaningful task checklist items, and source files cited across multiple sections. A new developer could follow it end-to-end.
**Score 0.5**: Latency calculation present with roughly correct result (~120–130s) but without individual backoff delay enumeration or without alerting recommendation. Token refresh interval not explicitly derived as "29 days" or derivation missing. Document adequately structured with 5+ checklist items but some sections lack depth.
**Score 0.0**: No latency calculation or wrong base values used. Document missing major sections or too disorganized for onboarding.

### Criterion 6: Token Lifecycle Management (Weight: 20%)
*This criterion evaluates whether the response proactively designs a robust token management architecture — critical for production deployments but not explicitly requested in the prompt. A baseline answer only states the 30-day validity; a high-quality answer builds a production-ready caching system.*
**Score 1.0**: Provides a complete token caching mechanism with code: stores the access token alongside its expiry timestamp, implements proactive refresh before expiry (e.g., refresh when remaining validity drops below 10% or 1 day before the 30-day expiry), handles thread-safe concurrent access (using mutex/lock or atomic compare-and-swap to prevent duplicate refresh requests), includes monitoring or logging for refresh failures, and demonstrates a `TokenManager` class (or equivalent encapsulation) managing the full acquire → cache → monitor → refresh lifecycle. The implementation accounts for network failures during refresh.
**Score 0.5**: Discusses token caching strategy with refresh-before-expiry advice and provides partial code (e.g., a simple timestamp check and conditional refresh without thread safety), or provides a complete class but without handling concurrent access or refresh failure scenarios.
**Score 0.0**: Only mentions the 30-day validity period or suggests "cache the token" in passing without any implementation details. Does not address token lifecycle beyond basic acquisition.

### Criterion 7: Error-Specific Retry Strategy and Production Resilience (Weight: 15%)
*This criterion evaluates whether the response implements differentiated error handling by error type and includes production-grade resilience patterns not explicitly requested in the prompt.*
**Score 1.0**: Implements differentiated retry strategies by error code in code: HTTP 429 (rate limit / codes 17, 18) → exponential backoff with jitter to avoid thundering herd; HTTP 500 (server error / code 282000) → immediate retry then exponential backoff; HTTP 401 (auth error / codes 110, 111) → single token-refresh-and-retry without backoff; HTTP 400/413 (client error / codes 336001, 336003) → fail immediately without retry. Includes a circuit breaker pattern to prevent cascading failures when the API is consistently failing, structured logging with `request_id` correlation for distributed tracing, and configurable timeout with graceful degradation.
**Score 0.5**: Discusses different retry approaches for different error categories (e.g., "don't retry client errors") but without full code implementation, or implements basic differentiation without circuit breaker, jitter, or structured logging.
**Score 0.0**: Uses a uniform retry strategy for all error types, or only lists error codes without discussing error-specific handling strategies.

### Criterion 8: Security Analysis and API Best Practices (Weight: 15%)
*This criterion evaluates whether the response proactively analyzes security implications and provides production-grade best practices beyond what was explicitly asked.*
**Score 1.0**: Explicitly compares the security tradeoffs of query parameter token passing versus `Authorization: Bearer` header — noting that query parameters appear in server access logs, URL browser history, referrer headers, and proxy logs, while headers provide better confidentiality — and explains why Baidu requires query parameters despite this tradeoff. Recommends compensating controls: mandatory HTTPS enforcement, IP whitelisting, credential rotation schedule, and log scrubbing to remove tokens from access logs. Discusses credential management best practices (environment variables or secret vaults, never hardcoding API keys). Provides API rate limit planning with a graceful degradation strategy when approaching limits (codes 17/18).
**Score 0.5**: Briefly acknowledges that query parameter token passing has security limitations and suggests using HTTPS or environment variables, but lacks a systematic security comparison or compensating controls discussion.
**Score 0.0**: Does not discuss security implications of the token passing method, or provides code with hardcoded credentials without any warning or guidance.
