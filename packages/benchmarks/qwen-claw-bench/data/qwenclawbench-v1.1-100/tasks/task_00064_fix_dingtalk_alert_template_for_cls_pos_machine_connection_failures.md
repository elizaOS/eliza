---
id: task_00064_fix_dingtalk_alert_template_for_cls_pos_machine_connection_failures
name: Fix DingTalk Alert Template for CLS POS Machine Connection Failures
category: Data Analysis and Modeling
grading_type: hybrid
external_dependency: none
verification_method: rubric
input_modality: text-only
timeout_seconds: 1800
grading_weights:
  automated: 0.05
  llm_judge: 0.95
workspace_files:
- source: config/original_template.json
  dest: config/original_template.json
- source: config/dingtalk_api_spec.md
  dest: config/dingtalk_api_spec.md
- source: config/cls_template_variables.md
  dest: config/cls_template_variables.md
- source: config/go_template_reference.md
  dest: config/go_template_reference.md
- source: examples/working_markdown_template.json
  dest: examples/working_markdown_template.json
- source: examples/old_template_v1.json
  dest: examples/old_template_v1.json
- source: logs/sample_cls_output.json
  dest: logs/sample_cls_output.json
- source: docs/notification_channels.yaml
  dest: docs/notification_channels.yaml
- source: docs/alert_rules_inventory.csv
  dest: docs/alert_rules_inventory.csv
- source: docs/runbook_snippet.md
  dest: docs/runbook_snippet.md
- source: references/human_reference_preview.txt
  dest: references/human_reference_preview.txt
- source: references/human_reference_changelog_snippet.md
  dest: references/human_reference_changelog_snippet.md
subcategory: Data Processing and Management
---

## Prompt

I've got a DingTalk webhook template that's been acting up — our POS machine connection failure alerts either don't send or come through garbled. The template is at `config/original_template.json`. It was put together a while back and I suspect there are several issues with it.

There are reference docs in the workspace — DingTalk API spec, CLS template variable reference, Go template syntax guide — plus a sample alert payload at `logs/sample_cls_output.json` showing what the actual data looks like. There are also a couple older template versions in `examples/`, though they may not be reliable.

Can you go through it, figure out what's broken, and produce a corrected version at `output/dingtalk_alert.json`? It needs to stay as a `text` type message (not markdown), keep the same general structure and information, and use `\n` for newlines in the JSON string. The template should iterate over the first query result set, conditionally display each device's details with separators, and include the standard alarm metadata. I've also been told that some alerts seem to have fewer devices listed than what shows up in the CLS console — not sure if the template is filtering too aggressively or what.

Oh, and for the device detail lines — when a field value is empty in the data, I'd rather the template skip that entire line instead of printing the label followed by nothing. Showing `设备SN:` with blank after it just confuses the ops team. So wrap each field line so it only renders when the value is actually present.

Oh, and I noticed the alarm name in the template doesn't match what's configured in our CLS alarm rule. Can you check that against the sample data? We might end up using this template for other alarm rules too, so keep that in mind.

The payload also carries a root-level **trigger condition** string (the same idea as `.Condition` in the CLS variable docs). I'd like that expression echoed once in the footer alongside the detail link and notification type — still **root-level context**, not inside the per-device loop, so it doesn't repeat for every row. If you can, sanity-check the wording against `docs/alert_rules_inventory.csv` for the row whose `rule_name` matches the sample's alarm name so we are not contradicting the documented rule id / threshold story.

Also, people keep asking what "通知类型: 1" means — could you make the notification type show as a readable label instead of the raw number? Please handle recovery vs trigger explicitly, and if the integer is ever something other than 1 or 2, show the numeric value in a safe fallback so we don't mislabel unknown states.

While you're at it, write up a brief changelog at `output/template_changelog.md` documenting each issue you found and what you changed. If you can, also note the severity or type of each issue so we can assess risk when deploying. Our QA folks asked for traceable regression hooks — could you tag each substantive fix with a short id like `REG-001`, `REG-002`, … so they can line those up with test cases later? Could you also cite the matching rule_id from the inventory in the changelog? Our tracking system links template changes to specific alarm policies. And could you also produce a rendered preview at `output/rendered_preview.txt`? Plug in the values from the sample data in `logs/sample_cls_output.json` so I can see what the actual message would look like. Make sure the preview reflects what the template would actually produce with the conditional logic applied. When you write that preview, it'd help reviewers if each chunk (header, each device block, footer) had a tiny inline note saying which branch of the template produced it — we're chasing a bunch of conditional edge cases and the extra breadcrumbs save argument time.

Actually, for the rendered preview, could you show three scenarios? (1) the trigger case with the sample data as-is (NotifyType = 1), (2) a recovery notification — pretend NotifyType is 2, same device data, and (3) an edge case where NotifyType is something unexpected, say 99, to show the unknown-type fallback works. Just label them as separate blocks in the file.

There's a pair of deliberately rough reference drafts under `references/` (`human_reference_preview.txt` and `human_reference_changelog_snippet.md`) — think of them as "what a busy human might paste in a hurry," not the bar for what we want to ship.

## Expected Behavior

The agent should analyze `config/original_template.json` and cross-reference the documentation files (`config/dingtalk_api_spec.md`, `config/cls_template_variables.md`, `config/go_template_reference.md`) to identify and fix all issues in the template. The sample alert payload in `logs/sample_cls_output.json` provides the actual data structure for verifying variable references and producing the rendered preview.

### Issue 1: Go Template Array Access Syntax

The original uses `{{range .QueryResult[0]}}` which is invalid Go template syntax. Go templates do not support bracket-based array indexing — this is the primary syntax error causing template parse failures at runtime. The agent should correct this to `{{range (index .QueryResult 0)}}` using the `index` built-in function.

### Issue 2: Redundant Double Newline

The original file's `content` string contains a redundant double newline (`\n\n`) between the header line (`告警时间: {{.NotifyTime}}`) and the `{{range}}` iteration block. This produces an unwanted blank line in the rendered DingTalk message. The agent should normalize this to a single `\n` for clean, consistent formatting.

### Issue 3: Trailing Whitespace

The original has inconsistent trailing spaces before some `\n` sequences — `{{.sn}} \n` has one trailing space, `{{.shopName}}  \n` has two trailing spaces, `{{.logtime}} \n` has one trailing space, and `{{.DetailUrl}} \n` also has a trailing space. Other fields like `{{.shopNo}}\n` and `{{.message}}\n` have no trailing spaces. The agent should remove all trailing spaces before `\n` sequences so that field values are immediately followed by `\n` without intervening whitespace.

### Issue 4: Metadata Inside Iteration Block (Variable Scope)

The original template has the alarm metadata fields (`告警详情: {{.DetailUrl}}` and `通知类型: {{.NotifyType}}`) positioned between the `{{end}}` that closes the `{{if}}` block and the `{{end}}` that closes the `{{range}}` block. This places them inside the iteration loop, causing two problems:

1. **Wrong variable scope**: Inside a `{{range}}` block, the dot (`.`) is rebound to the current iteration element. `.DetailUrl` and `.NotifyType` try to access these fields on each log object, which doesn't have them — resulting in empty strings in the rendered output.
2. **Unwanted repetition**: The metadata lines are output once per iteration, appearing multiple times in the message instead of once at the end.

The agent should move these metadata lines outside the `{{range}}` block (after both `{{end}}` tags) so they use the root-level template context and appear exactly once.

### Issue 5: Raw Notification Type Number

The original template displays `{{.NotifyType}}` as a raw integer (1 or 2). The prompt requests converting this to human-readable labels and **not** silently mapping unexpected integers to "恢复". The agent should use an explicit three-way branch, e.g. `{{if eq .NotifyType 1}}触发{{else if eq .NotifyType 2}}恢复{{else}}未知({{.NotifyType}}){{end}}`, referencing the CLS template variable documentation which describes NotifyType as an integer with 1 = triggered and 2 = recovered.

### Issue 6: Hardcoded Alarm Name with Incorrect Characters

The original template has a hardcoded alarm name "收银机连接异常告警" which contains two errors: "收银机" (cash register) should be "收款机" (POS machine), and "异常" (abnormal) should be "连接失败" (connection failure). More importantly, the CLS template variables include `.AlarmName` which dynamically provides the alarm policy name. The agent should replace the hardcoded string with `{{.AlarmName}}` to make the template reusable across different alarm rules, as requested in the prompt.

### Issue 7: Case-Sensitive Field Name Error

The original template uses `{{.logtime}}` (all lowercase) for the log timestamp field, but the actual CLS data field is `logTime` (camelCase with capital 'T'). Go templates are strictly case-sensitive — `.logtime` will silently resolve to a zero value (empty string) instead of the actual timestamp. The agent should cross-reference `config/cls_template_variables.md` and correct this to `{{.logTime}}`.

### Issue 8: Overly Restrictive Conditional Operator

The original template uses `{{if and .sn .shopNo .message}}` which requires ALL three fields to be truthy (non-empty) for a device to be displayed. This is overly restrictive — some devices may have partial data (e.g., no SN but a valid shop number and error message). The prompt specifies that devices should appear "as long as any key identifier field is available," which means the logical OR operator should be used: `{{if or .sn .shopNo .message}}`.

### Issue 9: Tab Character in Field Label

The original template contains a tab character (`\t`) before "告警信息:" — it reads `\t告警信息: {{.message}}`. This tab character produces an inconsistent visual indentation in the rendered DingTalk message, where all other field labels are left-aligned. The agent should remove the tab to maintain consistent formatting.

### Issue 10: Missing Policy Condition Line (Root Scope)

The sample payload and variable reference include `.Condition` (e.g., `count > 0` in `logs/sample_cls_output.json`). The repaired template should render this trigger expression **once** in the footer, using `{{.Condition}}` at **root scope after** the `{{range}}` over devices closes — the same scoping rule as `.DetailUrl` / `.NotifyType`. Placing `.Condition` inside the per-device loop would repeat it and/or rebind `.` to a log row where the field is absent.

### Issue 11: Per-Field Conditional Display (Empty Field Omission)

The original template renders all five device fields unconditionally within the `{{if or}}` block. When a field value is empty (e.g., `sn` for the "中区便利店" device), the output produces a line like `设备SN: ` with nothing after it. The prompt explicitly requests that empty-field lines be omitted. The agent should wrap each device field line in its own `{{if .fieldName}}` guard — e.g., `{{if .sn}}设备SN: {{.sn}}\n{{end}}` — so that only non-empty fields appear in the rendered output. For "中区便利店", this means the SN line is entirely absent while the shopName, shopNo, logTime, and message lines render normally.

### Trap Handling

**Trap 1 — msgtype markdown vs text**: The file `examples/working_markdown_template.json` uses `msgtype: "markdown"` with markdown-specific formatting (headers, bold, bullets). The agent should recognize that this example uses a different message type and maintain the `msgtype: "text"` format as specified in the prompt and documented in `config/dingtalk_api_spec.md`. Mixing formatting rules between text and markdown message types would produce garbled output.

**Trap 2 — .AlarmTime and $.QueryResult[0] in old template**: The file `examples/old_template_v1.json` uses `.AlarmTime` (a deprecated/incorrect variable name — the variable reference lists `.NotifyTime` as the correct field) and `$.QueryResult[0]` (invalid bracket-based array access). The agent should use `.NotifyTime` and the `index` function. The old file may also reference `{{.Condition}}`; that variable **is** legitimate for the **corrected** template when rendered at **root scope after the device loop** (see Issue 10) — do not treat it as junk solely because it appeared in a legacy file.

**Trap 7 — Runbook snippet vs. variable reference**: The draft note in `docs/runbook_snippet.md` suggests omitting the trigger expression from the DingTalk body for brevity. That conflicts with the current prompt and with `config/cls_template_variables.md`, which documents `.Condition` as part of the injected context. The agent should follow the authoritative docs and the prompt, not the informal runbook draft.

**Trap 3 — Filtered device in sample data**: The sample data in `logs/sample_cls_output.json` includes a device entry ("北区仓储中心") with empty `sn`, `shopNo`, and `message` fields. The template's `{{if or .sn .shopNo .message}}` condition filters this entry out since all three checked fields are falsy (empty strings). The agent should recognize this when producing the rendered preview and NOT include this device.

**Trap 4 — Second QueryResult array**: The sample data contains two QueryResult arrays. The template iterates over `(index .QueryResult 0)` — only the first array. The agent should not include data from `QueryResult[1]` in the rendered preview.

**Trap 5 — "中区便利店" with partial device data**: The sample data includes a device entry ("中区便利店") that has an empty `sn` field but non-empty `shopNo` ("SH005") and `message` ("connection refused"). With the original template's incorrect `and` condition, this device would be filtered out since `sn` is falsy. With the correct `or` condition, this device should appear in the rendered preview because `shopNo` and `message` are truthy. This tests whether the agent correctly identifies and fixes the conditional operator.

**Trap 6 — Human reference drafts vs. real delivery**: The files `references/human_reference_preview.txt` and `references/human_reference_changelog_snippet.md` are intentionally mediocre: the preview omits the partial-data "中区便利店 / SH005" scenario that a correct template must surface, and the changelog snippet only carries a single `REG-` style tag. Treat them as anti-patterns to beat, not templates to copy. A strong delivery clearly exceeds them on sample fidelity, issue coverage, and regression traceability.

**Trap 8 — Inventory threshold expression alias**: The `alert_rules_inventory.csv` documents the threshold as `cnt > 0` while the sample payload's `.Condition` contains `count > 0`. These are semantically equivalent — `cnt` is the alias defined in the SQL query (`stats count(*) as cnt`), and `count > 0` is the human-readable condition string injected by CLS. The agent should note this correspondence in the changelog rather than flagging it as a discrepancy or ignoring the cross-reference entirely.

### Ground Truth — Fixed Template

The final output at `output/dingtalk_alert.json` should be valid JSON with:
- `msgtype` set to `"text"`
- `text.content` as a single string value with `\n` for line breaks
- Correct Go template syntax: `{{range (index .QueryResult 0)}}`
- Dynamic alarm name: `{{.AlarmName}}` instead of hardcoded text
- Correct variable names: `{{.NotifyTime}}`, `{{.DetailUrl}}`, `{{.logTime}}` (camelCase)
- Human-readable notification type: explicit three-way branch (trigger / recover / unknown), e.g. `{{if eq .NotifyType 1}}触发{{else if eq .NotifyType 2}}恢复{{else}}未知({{.NotifyType}}){{end}}`
- Correct conditional block: `{{if or .sn .shopNo .message}}` (not `and`)
- All five device fields: `.sn`, `.shopName`, `.shopNo`, `.logTime`, `.message`
- Separator `---` between iterated device entries
- Properly closed `{{end}}` tags for the `if`, `range`, and `if eq` blocks
- Metadata fields (`告警详情`, `通知类型`) and the **policy condition** (`{{.Condition}}`) positioned AFTER the range block's closing `{{end}}`, not inside the iteration loop
- NotifyType mapping uses an explicit three-way pattern (trigger / recover / unknown fallback), not a binary that maps every non-1 value to "恢复"
- No trailing whitespace before any `\n` sequences
- No redundant double `\n\n` between the header and the iteration block
- No tab characters in field labels
- Each device field line wrapped in an individual `{{if .fieldName}}` guard (e.g., `{{if .sn}}设备SN: {{.sn}}\n{{end}}`) so that empty fields are omitted from the rendered output

### High-Quality Completion Indicators

A strong response goes beyond mere correctness. An experienced operations engineer producing a template repair report would:

- **Changelog with before/after diffs**: Each fix item includes the exact original snippet, the corrected snippet, and a technical rationale explaining *why* the original fails (e.g., "Go template parser does not recognize bracket notation — it tokenizes `[` as a literal character rather than an index operator, causing a parse-time error").
- **Risk assessment per change**: Each fix is annotated with a risk level (e.g., "Low — formatting only" vs "High — changes template control flow") and a recommended testing approach (e.g., "verify with empty QueryResult to ensure no nil dereference").
- **Anomalous data handling explanation**: The rendered preview includes a note on why certain devices are excluded (citing the specific conditional check and which fields are empty), rather than silently omitting them.
- **Backward compatibility consideration**: The fix discusses whether the corrected template would still work with older data payloads that might have different field availability (e.g., missing `message` field entirely vs empty string).
- **Technical rationale for fix approach**: Explains *why* a particular fix method was chosen over alternatives — e.g., why metadata fields are moved outside the range block rather than using `$` prefix to access root context from within.
- **Error classification**: Uses all three categories — parse-time, render-time, and cosmetic — somewhere in the changelog narrative (English or Chinese phrasing is fine), mapping concrete issues to the right bucket.
- **Per-field conditional design rationale**: Explains *why* each device field line should be individually guarded with `{{if .fieldName}}` rather than rendered unconditionally, citing the "中区便利店" case where the SN line should be absent.
- **Multi-scenario preview coverage**: The rendered preview demonstrates all three NotifyType code paths (trigger, recovery, unknown fallback) so reviewers can verify each branch without re-running the template. The unknown type shows exact format "未知(99)" with the raw number in parentheses. The trigger condition `count > 0` appears in each scenario footer.
- **Inventory cross-reference with SQL alias**: The changelog maps the alarm to its rule_id (ALR-001) from the CSV and reconciles the `cnt > 0` threshold expression with the `.Condition` string `count > 0`, explaining that `cnt` is a SQL alias from `stats count(*) as cnt`.
- **Nil safety and defensive design**: The template includes a guard for empty or nil `QueryResult` before the `{{range}}` block (e.g. `{{if .QueryResult}}` or `{{if gt (len .QueryResult) 0}}`), preventing template execution failure when no query results are available.
- **Deployment verification section**: The changelog includes a dedicated section for deployment verification — rollback considerations, pre-deployment checklist, and post-deployment monitoring steps.
- **Verbatim before/after diffs**: Each changelog entry includes the exact original code snippet in a fenced code block alongside the corrected version, enabling diff-level review without referencing the original template file.
- **Preview per-field omission evidence**: The rendered preview demonstrates that the "中区便利店" device block correctly omits the `设备SN:` line (since `sn` is empty), and explicitly annotates why "北区仓储中心" is excluded (all three `or`-checked fields empty).
- **Severity-ordered changelog**: Issues are listed in descending severity (Critical/High before Medium/Low) with explicit severity labels, enabling rapid risk triage for deployment reviewers.
- **Alternative approach analysis**: For key fixes (e.g., metadata scope), the changelog explains rejected alternatives (e.g., `$` root-scope prefix) with trade-off reasoning, demonstrating systematic decision-making.
- **Runbook conflict resolution**: The changelog explicitly notes the conflict between `docs/runbook_snippet.md` (which suggests omitting `.Condition`) and the current prompt plus `config/cls_template_variables.md`, resolving in favor of the authoritative docs.
- **Backward compatibility assessment**: The changelog discusses whether the corrected template would handle older data payloads (e.g., missing field vs empty string, zero-value semantics in Go templates).
- **Whitespace trimming**: The template uses Go template whitespace trimming markers (`{{-` / `-}}`) to eliminate unintended whitespace between template actions and output text.
- **Graceful empty-state fallback**: The template provides a Chinese-language fallback message when `QueryResult` is empty (e.g., `{{else}}暂无告警设备{{end}}`), ensuring the DingTalk message is never blank.
- **Per-fix testing recommendations**: Each `REG-###` tag in the changelog is accompanied by a specific testing approach (not generic "test thoroughly"), enabling QA to build targeted test cases.
- **Complete multi-scenario preview**: All three preview scenarios (trigger/recovery/unknown) render the full device list with all four qualifying devices, not just the trigger scenario — reviewers can verify template behavior for each NotifyType code path without re-running the template.

### Ground Truth — Changelog

The changelog at `output/template_changelog.md` should document at least **nine** substantive issues (including the per-field conditional design): the Go template array access syntax fix, the double newline removal, the trailing whitespace cleanup, the metadata scope/positioning fix, the hardcoded alarm name replacement with `{{.AlarmName}}`, the field name casing correction (`logtime` → `logTime`), the conditional operator fix (`and` → `or`), the tab character removal (if applicable), and the addition or correct placement of the **`.Condition`** / trigger-expression line (Issue 10). Each issue should include a description of what was wrong, how it was corrected, and an error type classification using **all three** categories somewhere across the document: **parse-time**, **render-time**, and **cosmetic** (English or Chinese wording is fine — e.g., 解析时 / 渲染时 / 外观). **Better than a basic list**: assign multiple distinct, executable regression tags (`REG-001`, `REG-002`, … — at least three across the document) so each major fix can be tied to a concrete test case id. The changelog should also cite the matching rule_id from `docs/alert_rules_inventory.csv` (**ALR-001**) and note the correspondence between the inventory's threshold expression (`cnt > 0`) and the sample payload's `.Condition` (`count > 0`).

### Ground Truth — Rendered Preview

The rendered preview at `output/rendered_preview.txt` should show the DingTalk message with template variables substituted using actual values from `logs/sample_cls_output.json`. **Basic completion** pastes the rendered body alone. **Clearly stronger** adds short per-section notes (e.g., which `if` / `range` branch produced each header, device block, and footer) so reviewers can audit conditional behavior without re-running the template. The correct rendered output contains:

- Header: alarm name "收款机连接失败告警" (from `.AlarmName` in the sample data, NOT the hardcoded wrong text from the original template) and notify time "2024-01-15 10:30:00"
- Four device entries (from the first QueryResult array, filtered by the `if or` condition — the device with ALL empty sn/shopNo/message is excluded):
  - Device 1: SN "POS20240001", shop "东区旗舰店" (SH001), log time "2024-01-15 10:28:33", message "TCP connection timeout after 30s"
  - Device 2: SN "POS20240002", shop "西区分店" (SH002), log time "2024-01-15 10:29:01", message "heartbeat lost"
  - Device 3: No SN (empty), shop "中区便利店" (SH005), log time "2024-01-15 10:29:22", message "connection refused" — included because `shopNo` and `message` are non-empty despite empty `sn`
  - Device 4: SN "POS20240003", shop "南区购物中心店" (SH015), log time "2024-01-15 10:29:45", message "SSL handshake failed: certificate expired"
- Separators `---` between/after device entries
- Footer (appearing exactly once): detail URL, notification type displayed as "触发", and the trigger expression **`count > 0`** from `.Condition` in the sample (verbatim)
- The device entry "北区仓储中心" from the sample data does NOT appear (all three checked fields are empty)
- No data from `QueryResult[1]` appears in the preview
- Device 3 ("中区便利店") renders WITHOUT the "设备SN:" line since `sn` is empty and per-field conditional omits it
- **Three scenarios**: The preview contains three labeled blocks — (1) Trigger (NotifyType=1) with the full ground truth above, (2) Recovery (NotifyType=2) with identical device data but notification type showing "恢复", and (3) Unknown Type (NotifyType=99) with notification type showing "未知(99)". The recovery and unknown-type blocks verify that the three-way conditional renders all code paths correctly.

## Grading Criteria

- [ ] Output file exists at `output/dingtalk_alert.json` (`output_file_exists`)
- [ ] Output is valid JSON with correct top-level structure: `msgtype` is `"text"` and `text.content` is a string (`valid_json_and_structure`)
- [ ] Go template uses correct `(index .QueryResult 0)` syntax and does not contain bracket-based `.QueryResult[0]` or `$.QueryResult[0]` (`correct_range_syntax`)
- [ ] Uses `.NotifyTime` (not deprecated `.AlarmTime`) and converts `.NotifyType` to human-readable labels with an **explicit three-way** branch (trigger / recover / unknown fallback with Chinese "未知" text and raw `.NotifyType` value), not a binary that silently maps all non-1 values to recovery — **1.0** = all five conditions (NotifyTime, no AlarmTime, eq 1, else if eq 2, else with 未知 + raw value); **0.7** = first four without explicit unknown-with-未知 (`correct_variable_names`)
- [ ] Contains `{{range` with properly matching `{{end}}` blocks, uses `{{if or ...}}` conditional (not `and`), includes nil-safety guard for `QueryResult`, and uses whitespace trimming markers — **1.0** = range + `if or` + `{{end}}` count ≥10 + nil guard + ≥2 whitespace trim markers; **0.7** = range + ≥10 ends + `if or` but no nil guard or trim; **0.5** = range + ≥7 ends + `if or` (`template_control_flow`)
- [ ] Contains all five device fields with correct casing: `.sn`, `.shopName`, `.shopNo`, `.logTime` (not `.logtime`), `.message` — **1.0** = all five present **and** each individually guarded by `{{if .fieldName}}` **and** each guard has the correct Chinese label (设备SN/门店名/门店NO/日志时间/告警信息) with tight `{{end}}` pairing; **0.75** = all five guarded but labels not all matching; **0.6** = all five present with ≥3 guards; **0.4** = all five present but fewer than 3 guards; **0.2** = four fields present (`has_all_device_fields`)
- [ ] Root-level template variables (`.DetailUrl`, `.NotifyType`, `.Condition`) are present and correctly scoped — all positioned after the range block closes, not inside the per-device iteration loop — **1.0** = all three after range **and** `.Condition` preceded by Chinese label (触发条件/策略条件) **and** NotifyType rendered as readable text; **0.75** = all three after range but missing Condition label or readable NotifyType text (`correct_metadata_scope`)
- [ ] Valid JSON with `\n` encoding: parsed content contains expected line breaks and no raw/unescaped newline characters in the JSON string value (`proper_newline_encoding`)
- [ ] Contains a separator pattern (e.g., `---`) positioned within the iteration context near device field references (`has_separator`)
- [ ] No trailing whitespace before `\n` sequences, no redundant `\n\n` double newlines, and no tab characters in the content string — **any** of these defects fails this check (`clean_whitespace`)
- [ ] Template uses dynamic `{{.AlarmName}}` for the alarm name instead of a hardcoded string; no remnants of the incorrect "收银机" characters **and** no residual hardcoded alarm name text (e.g., "收款机", "连接失败告警") in the template content string (`dynamic_alarm_name`)
- [ ] Template uses `{{if or ...}}` conditional (not `{{if and ...}}`), allowing devices with any non-empty identifier to display (`correct_filter_logic`)
- [ ] Changelog file exists at `output/template_changelog.md` with substantive content (`changelog_exists_with_content`)
- [ ] Changelog references specific issues found in the original template — covering array syntax, whitespace cleanup, metadata scope, alarm name, field casing, conditional operator, tab removal (if discussed), **policy condition / `.Condition` placement**, and cross-check against inventory or runbook conflict (`changelog_issue_coverage`)
- [ ] Changelog demonstrates **all three** error-type categories (parse-time, render-time, cosmetic) at least once each, using English or Chinese terminology (`changelog_error_classification`)
- [ ] Changelog assigns multiple executable regression tags (`REG-001` style, distinct ids — **1.0** = at least **eleven** unique tags covering all substantive fixes including per-field guards; **0.5** = nine or ten tags; **0.25** = seven or eight tags; **0.1** = five or six tags; **0.0** = fewer than five) (`changelog_regression_traceability`)
- [ ] Rendered preview file exists at `output/rendered_preview.txt` (`preview_exists`)
- [ ] Rendered preview contains actual data values from the sample payload, including correct alarm name from `.AlarmName`, device SNs, shop names including "中区便利店", the **verbatim** `.Condition` text `count > 0`, all four per-device `logTime` timestamps, and scenario labels "触发"/"恢复" — **1.0** = all 20 anchor values present; **0.5** = ≥95% present; below that, proportional scoring (`preview_sample_data_accuracy`)
- [ ] Rendered preview correctly reflects the template's conditional logic: includes four qualifying devices (including partial-data "中区便利店"), excludes "北区仓储中心", shows metadata exactly once, and includes **all four** per-device `logTime` stamps from the first `QueryResult` array for the rendered devices (`preview_device_completeness`)
- [ ] Rendered preview **beats** the deliberately incomplete `references/human_reference_preview.txt`: **1.0** = contains both `SH005` and `中区便利店` **and** the `中区便利店` device block omits the `设备SN:` line **and** includes the correct `logTime` "2024-01-15 10:29:22"; **0.75** = SH005 + 中区便利店 + no SN line but missing logTime in that block; **0.5** = contains both anchors but includes `设备SN:` line for the empty-SN device; **0.25** = only one anchor appears; **0.0** = neither anchor appears (`preview_superior_to_reference`)
- [ ] Each device field line is individually guarded by `{{if .fieldName}}` so that empty fields are omitted entirely from the output — **1.0** = five per-field guards with correct Chinese labels (设备SN/门店名/门店NO/日志时间/告警信息) and tight `{{end}}` pairing within 80 chars; **0.75** = five guards with ≥3 labeled pairs; **0.5** = five guards but fewer labeled pairs; **0.35** = three guards (`per_field_conditional`)
- [ ] Rendered preview includes three labeled scenario blocks: trigger (NotifyType=1 showing "触发"), recovery (NotifyType=2 showing "恢复"), and unknown type (NotifyType=99 showing exact format "未知(99)"); alarm header appears in each block; **1.0** = all three scenarios with exact "未知(99)" format AND the trigger condition `count > 0` appears in **at least four** places across all scenarios (≥4 occurrences, e.g. three footers plus one annotation); **0.75** = three scenarios with exact format and condition in all three footers (≥3); **0.5** = three scenarios present but inexact unknown format or condition in fewer than three places (`preview_multi_scenario`)
- [ ] Changelog explicitly cites **ALR-001** from `docs/alert_rules_inventory.csv`, notes the threshold expression correspondence between `cnt > 0` (inventory) and `count > 0` (sample payload), **and** explains the SQL alias origin with **both** the aggregate function reference (`count(*)` or `stats count`) **and** the alias binding (`as cnt`) — **1.0** = all three elements with both SQL components; **0.5** = ALR-001 + threshold note without full alias explanation; **0.25** = ALR-001 only (`changelog_inventory_crossref`)
- [ ] Template contains Go template inline comments (`{{/* ... */}}`) documenting at least two key design decisions (e.g. why `or` over `and`, why metadata is outside `range`) (`template_inline_comments`)
- [ ] Template guards against empty or nil `QueryResult` before iterating — e.g. `{{if .QueryResult}}` or `{{if gt (len .QueryResult) 0}}` wrapping the `range` block — to prevent nil-dereference when no query results are available (`template_empty_queryresult_guard`)
- [ ] Changelog contains **verbatim before/after code snippets** (in backtick-fenced code blocks) showing the original broken template fragment and the corrected version for each fix — **1.0** = at least six template-related code references; **0.5** = three to five; **0.25** = one or two (`changelog_verbatim_before_after`)
- [ ] Rendered preview **annotates why** the excluded device "北区仓储中心" does not appear — mentions the device name **and** provides a filtering/omission explanation nearby (e.g. "all three checked fields are empty") (`preview_filtered_device_explanation`)
- [ ] Rendered preview demonstrates correct **per-field omission** for the "中区便利店" device: the device block contains shop name, shop number, log time, and message but does **not** contain a `设备SN:` line (since `sn` is empty) — **1.0** = `中区便利店` block has no `设备SN:` line; **0.0** = `设备SN:` present in that block or device absent (`preview_perfield_omission_evidence`)
- [ ] Changelog includes a **deployment verification section** with explicit rollback consideration, fix-specific testing steps, and post-deployment monitoring approach — **1.0** = dedicated section heading + rollback mention + bulleted verification steps; **0.5** = two of three; **0.25** = one of three (`changelog_deployment_checklist`)
- [ ] Template uses Go template **whitespace trimming** markers (`{{-` or `-}}`) for precise output control — **1.0** = at least four trimming markers; **0.5** = two or three; **0.25** = one; **0.0** = none (`template_whitespace_trimming`)
- [ ] Changelog entries are **ordered by severity** (Critical/High before Medium/Low) with explicit severity labels — **1.0** = ≥3 labeled entries in descending severity order; **0.5** = severity labels present but not in descending order; **0.25** = fewer than 3 severity labels (`changelog_severity_ordered`)
- [ ] Template includes a **user-friendly fallback message** when `QueryResult` is empty or nil — e.g., `{{else}}暂无告警设备{{end}}` after the QueryResult guard — **1.0** = both nil guard and Chinese fallback message in `{{else}}` branch; **0.5** = fallback text without guard (`template_graceful_empty_message`)
- [ ] Changelog discusses **alternative fix approaches** and trade-offs — e.g., `$` prefix for root-scope access vs moving metadata outside `range`, explaining why the chosen approach is preferred — **1.0** = ≥3 alternative/trade-off discussions; **0.5** = at least one (`changelog_alternative_approaches`)
- [ ] All three preview scenarios (trigger/recovery/unknown) show the **complete device list** with all four qualifying devices — **1.0** = each device message appears in all three scenarios; **0.5** = each appears in at least two; **0.25** = scenarios present but devices incomplete (`preview_all_scenarios_complete`)
- [ ] Changelog discusses **backward compatibility** with older data payloads (e.g., zero-value vs missing-field semantics, legacy data handling) — **1.0** = ≥2 compatibility discussions; **0.5** = at least one (`changelog_backward_compat`)
- [ ] Changelog contains **deep technical root cause analysis** citing Go template parser internals (tokenizer behavior, dot rebinding mechanism, zero-value semantics) — **1.0** = ≥3 technical depth markers; **0.5** = at least one (`changelog_root_cause_depth`)
- [ ] Template inline comments (`{{/* ... */}}`) cover **specific design decisions** — mentioning `or`/`and` choice, `index` necessity, scope handling, field guards, etc. — **1.0** = comments covering ≥4 design topics; **0.5** = 2–3 topics; **0.25** = 1 topic (`template_comment_design_coverage`)
- [ ] Changelog explicitly notes the **conflict between `docs/runbook_snippet.md` and the prompt** regarding `.Condition` display, explaining why the authoritative variable docs and prompt take precedence over the informal runbook draft (`changelog_runbook_conflict_note`)
- [ ] Changelog includes **per-fix testing recommendations** near each `REG-###` tag — **1.0** = ≥5 REG sections with testing notes; **0.5** = 3–4 sections; **0.25** = 1–2 sections (`changelog_testing_per_fix`)
- [ ] Template uses a **Chinese label** (触发条件/策略条件/告警条件) before `{{.Condition}}` in the footer — **1.0** = Chinese label present with `{{` nearby; **0.25** = `.Condition` present but no Chinese label (`template_condition_label_zh`)
- [ ] Rendered preview includes **inline branch annotations** explaining which template conditional or loop produced each section (header/device blocks/footer) — **1.0** = ≥5 annotation keywords; **0.5** = 3–4 keywords; **0.25** = 1–2 keywords (`preview_branch_annotations`)
- [ ] Changelog has **structurally distinct issue sections** (separate headings per issue) — **1.0** = ≥11 issue-related section headings; **0.75** = ≥9; **0.5** = ≥7; **0.25** = ≥5 (`changelog_issue_count_structural`)

**Conditional gating**: If the core Go template syntax fix (`correct_range_syntax`) scores below 1.0, the following keys receive a ×0.5 penalty: `correct_variable_names`, `template_control_flow`, `has_all_device_fields`, `correct_metadata_scope`. If the template lacks inline comments (`template_inline_comments` < 0.5), `template_control_flow` receives a ×0.75 penalty — inline documentation is an integral part of control flow design quality. If `template_control_flow` scores below 1.0 (due to missing nil-safety guards, whitespace trimming markers, or insufficient `{{end}}` tags), the following keys receive a ×0.75 penalty: `has_all_device_fields`, `per_field_conditional`, `correct_metadata_scope` — incomplete control flow structure indicates the template's conditional logic may not be properly organized. If the metadata scope fix (`correct_metadata_scope`) scores below 1.0, the following keys receive a ×0.5 penalty: `correct_variable_names`, `template_control_flow`, `has_all_device_fields`, `has_separator`, `preview_sample_data_accuracy`, `preview_device_completeness`, `changelog_issue_coverage`. If the filter logic fix (`correct_filter_logic`) scores below 1.0, the following keys receive a ×0.75 penalty: `preview_device_completeness`, `has_all_device_fields`, `template_control_flow`, `changelog_issue_coverage`. If the dynamic alarm name (`dynamic_alarm_name`) scores below 1.0, the following keys receive a ×0.75 penalty: `preview_sample_data_accuracy`, `changelog_issue_coverage`.

**LLM evaluation emphasis**: Automated checks verify structural correctness, sample-data anchors (including per-device logTimes and scenario labels), regression/trace hooks (≥9 REG tags), per-field omission evidence, deployment readiness, severity ordering, whitespace control, root cause depth, alternative-approach discussion, backward compatibility, trigger condition label presence, branch annotations, structural issue coverage, and cross-deliverable completeness (5% of total grade). The LLM judge evaluates higher-order qualities — diagnostic depth, documentation professionalism, inline template documentation with ≥4 design topics, risk assessment, edge case awareness, production readiness, template extensibility, maintenance guidance, deployment verification, severity-ordered documentation, alternative-approach trade-offs, Chinese-labeled footer fields, per-section preview annotations, and clear superiority over the `references/` drafts — which constitute the overwhelming majority of the total grade (95%). A response that passes all automated checks but lacks documentation depth, deployment readiness, per-section preview annotations, verbatim before/after diffs, severity ordering, alternative-approach analysis, backward compatibility discussion, Chinese trigger condition label, complete per-device logTimes across all three scenarios, and forward-thinking design will score significantly below a response that demonstrates senior engineering rigor.

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import json
    import re
    from pathlib import Path

    results = {
        "output_file_exists": 0.0,
        "valid_json_and_structure": 0.0,
        "correct_range_syntax": 0.0,
        "correct_variable_names": 0.0,
        "template_control_flow": 0.0,
        "has_all_device_fields": 0.0,
        "correct_metadata_scope": 0.0,
        "proper_newline_encoding": 0.0,
        "has_separator": 0.0,
        "clean_whitespace": 0.0,
        "dynamic_alarm_name": 0.0,
        "correct_filter_logic": 0.0,
        "per_field_conditional": 0.0,
        "template_inline_comments": 0.0,
        "changelog_exists_with_content": 0.0,
        "changelog_issue_coverage": 0.0,
        "changelog_error_classification": 0.0,
        "changelog_regression_traceability": 0.0,
        "changelog_inventory_crossref": 0.0,
        "preview_exists": 0.0,
        "preview_sample_data_accuracy": 0.0,
        "preview_device_completeness": 0.0,
        "preview_superior_to_reference": 0.0,
        "preview_multi_scenario": 0.0,
        "template_empty_queryresult_guard": 0.0,
        "changelog_verbatim_before_after": 0.0,
        "preview_filtered_device_explanation": 0.0,
        "preview_perfield_omission_evidence": 0.0,
        "changelog_deployment_checklist": 0.0,
        "template_whitespace_trimming": 0.0,
        "changelog_severity_ordered": 0.0,
        "template_graceful_empty_message": 0.0,
        "changelog_alternative_approaches": 0.0,
        "preview_all_scenarios_complete": 0.0,
        "changelog_backward_compat": 0.0,
        "changelog_root_cause_depth": 0.0,
        "template_comment_design_coverage": 0.0,
        "changelog_runbook_conflict_note": 0.0,
        "changelog_testing_per_fix": 0.0,
        "template_condition_label_zh": 0.0,
        "preview_branch_annotations": 0.0,
        "changelog_issue_count_structural": 0.0,
    }

    ws = Path(workspace_path)
    output_path = ws / "output" / "dingtalk_alert.json"

    if not output_path.is_file():
        return results

    results["output_file_exists"] = 1.0

    try:
        raw = output_path.read_text(encoding="utf-8")
    except Exception:
        return results

    data = None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        pass

    content = ""
    if data and isinstance(data, dict):
        text_obj = data.get("text", {})
        if isinstance(text_obj, dict):
            content = text_obj.get("content", "") or ""

    # --- valid_json_and_structure ---
    if data and isinstance(data, dict):
        msgtype_ok = data.get("msgtype") == "text"
        content_ok = isinstance(content, str) and len(content) > 0
        if msgtype_ok and content_ok:
            results["valid_json_and_structure"] = 1.0
        elif msgtype_ok or content_ok:
            results["valid_json_and_structure"] = 0.5
    elif re.search(r'"msgtype"\s*:\s*"text"', raw):
        results["valid_json_and_structure"] = 0.25

    # --- correct_range_syntax ---
    has_index = bool(re.search(r"index\s+\.QueryResult\s+0", raw))
    has_bracket = bool(re.search(r"\$?\.QueryResult\s*\[", raw))
    if has_index and not has_bracket:
        results["correct_range_syntax"] = 1.0
    elif has_index and has_bracket:
        results["correct_range_syntax"] = 0.5
    elif not has_bracket and ".QueryResult" in raw:
        results["correct_range_syntax"] = 0.25

    # --- correct_variable_names ---
    has_notify = bool(re.search(r"\.NotifyTime", raw))
    has_alarm = bool(re.search(r"\.AlarmTime", raw))
    has_readable_type = bool(
        re.search(r"eq\s+\$?\.NotifyType\s+1", raw)
        or re.search(r"eq\s+1\s+\$?\.NotifyType", raw)
    )
    has_else_if_ntype2 = bool(
        re.search(
            r"\{\{-?\s*else\s+if\s+eq\s+\$?\.NotifyType\s+2",
            raw,
        )
        or re.search(
            r"\{\{-?\s*else\s+if\s+eq\s+2\s+\$?\.NotifyType",
            raw,
        )
    )
    has_else_unknown_zh = bool(
        re.search(
            r"\{\{-?\s*else\s*-?\}\}\s*未知",
            raw,
        )
    )
    var_score = 0.0
    if has_notify:
        var_score += 0.2
    if not has_alarm:
        var_score += 0.1
    if has_readable_type:
        var_score += 0.2
    if has_else_if_ntype2:
        var_score += 0.2
    if has_else_unknown_zh:
        var_score += 0.3
    results["correct_variable_names"] = round(min(var_score, 1.0), 2)

    check_text = content if content else raw

    # --- template_control_flow ---
    range_count = len(re.findall(r"\{\{-?\s*range\b", raw))
    end_count = len(re.findall(r"\{\{-?\s*end\s*-?\}\}", raw))
    has_if_or = bool(re.search(r"\{\{-?\s*if\s+or\s+", raw))
    has_if_and = bool(re.search(r"\{\{-?\s*if\s+and\s+", raw))
    has_nil_guard_flow = any(
        re.search(p, check_text) for p in [
            r"\{\{-?\s*if\s+\.QueryResult",
            r"\{\{-?\s*if\s+gt\s+\(?\s*len",
            r"\{\{-?\s*if\s+\.QueryResult\s*\}\}",
        ]
    ) if check_text else False
    has_trim_in_flow = (
        len(re.findall(r"\{\{-\s|-\s*\}\}", check_text)) >= 2
    ) if check_text else False
    flow_score = 0.0
    if range_count >= 1:
        flow_score += 0.2
    if end_count >= 10:
        flow_score += 0.3
    elif end_count >= 7:
        flow_score += 0.2
    elif end_count >= 3:
        flow_score += 0.1
    elif end_count >= 2:
        flow_score += 0.05
    if has_if_or:
        flow_score += 0.2
    elif has_if_and:
        flow_score += 0.05
    elif re.search(r"\{\{-?\s*if\s+", raw):
        flow_score += 0.02
    if has_nil_guard_flow:
        flow_score += 0.15
    if has_trim_in_flow:
        flow_score += 0.15
    results["template_control_flow"] = round(min(flow_score, 1.0), 2)

    # --- has_all_device_fields ---
    device_patterns = [
        r"\.sn\b", r"\.shopName\b", r"\.shopNo\b",
        r"\.logTime\b", r"\.message\b",
    ]
    found = sum(1 for p in device_patterns if re.search(p, raw))
    device_fields_list = ["sn", "shopName", "shopNo", "logTime", "message"]
    guarded_count = sum(
        1 for f in device_fields_list
        if re.search(r"\." + f + r"\b", raw)
           and re.search(
               r"\{\{-?\s*if\s+\." + f + r"\b",
               content if content else raw,
           )
    )
    label_pairs = [
        ("sn", "设备SN"), ("shopName", "门店名"),
        ("shopNo", "门店NO"), ("logTime", "日志时间"),
        ("message", "告警信息"),
    ]
    labeled_guard_count = 0
    for f, label in label_pairs:
        gp = r"\{\{-?\s*if\s+\." + f + r"\b"
        gm = re.search(gp, check_text)
        if gm:
            win = check_text[gm.end():gm.end() + 80]
            if label in win and re.search(
                r"\{\{-?\s*end\s*-?\}\}", win
            ):
                labeled_guard_count += 1
    if (
        found >= len(device_patterns)
        and guarded_count >= 5
        and labeled_guard_count >= 5
    ):
        results["has_all_device_fields"] = 1.0
    elif found >= len(device_patterns) and guarded_count >= 5:
        results["has_all_device_fields"] = 0.75
    elif found >= len(device_patterns) and guarded_count >= 3:
        results["has_all_device_fields"] = 0.6
    elif found >= len(device_patterns):
        results["has_all_device_fields"] = 0.4
    elif found >= len(device_patterns) - 1:
        results["has_all_device_fields"] = 0.2
    else:
        results["has_all_device_fields"] = round(
            (found / len(device_patterns)) * 0.1, 2
        )

    # --- per_field_conditional ---
    check_text = content if content else raw
    field_guard_patterns = [
        r"\{\{-?\s*if\s+\.sn\b",
        r"\{\{-?\s*if\s+\.shopName\b",
        r"\{\{-?\s*if\s+\.shopNo\b",
        r"\{\{-?\s*if\s+\.logTime\b",
        r"\{\{-?\s*if\s+\.message\b",
    ]
    guards_found = sum(
        1 for p in field_guard_patterns
        if re.search(p, check_text)
    )
    tight_pair_count = 0
    for f, label in label_pairs:
        gp = r"\{\{-?\s*if\s+\." + f + r"\b"
        gm = re.search(gp, check_text)
        if gm:
            win = check_text[gm.end():gm.end() + 80]
            if label in win and re.search(
                r"\{\{-?\s*end\s*-?\}\}", win
            ):
                tight_pair_count += 1
    if guards_found >= 5 and tight_pair_count >= 5:
        results["per_field_conditional"] = 1.0
    elif guards_found >= 5 and tight_pair_count >= 3:
        results["per_field_conditional"] = 0.75
    elif guards_found >= 5:
        results["per_field_conditional"] = 0.5
    elif guards_found >= 3:
        results["per_field_conditional"] = 0.35
    elif guards_found >= 1:
        results["per_field_conditional"] = 0.15

    # --- template_inline_comments ---
    comment_hits = re.findall(r"\{\{/\*", raw)
    comment_count = len(comment_hits)
    if comment_count >= 3:
        results["template_inline_comments"] = 1.0
    elif comment_count >= 2:
        results["template_inline_comments"] = 0.5
    elif comment_count >= 1:
        results["template_inline_comments"] = 0.25

    # --- template_empty_queryresult_guard ---
    guard_patterns = [
        r"\{\{-?\s*if\s+\.QueryResult",
        r"\{\{-?\s*if\s+gt\s+\(?\s*len",
        r"\{\{-?\s*with\s+\(?index\s+\.QueryResult",
        r"\{\{-?\s*if\s+\(?index\s+\.QueryResult",
        r"\{\{-?\s*if\s+ne\s+\(?\s*len",
        r"\{\{-?\s*if\s+\.QueryResult\s*\}\}",
    ]
    guard_text = content if content else raw
    has_nil_guard = any(
        re.search(p, guard_text) for p in guard_patterns
    )
    if has_nil_guard:
        results["template_empty_queryresult_guard"] = 1.0

    # --- correct_metadata_scope ---
    has_detail = ".DetailUrl" in raw or "$.DetailUrl" in raw
    has_ntype = ".NotifyType" in raw or "$.NotifyType" in raw

    if not has_detail and not has_ntype:
        results["correct_metadata_scope"] = 0.0
    elif content:
        range_match = re.search(r"\{\{-?\s*range\b", content)
        if range_match:
            pos = range_match.end()
            events = []
            for m in re.finditer(
                r"\{\{-?\s*(?:range|if)\b", content[pos:]
            ):
                events.append((pos + m.start(), "open"))
            for m in re.finditer(
                r"\{\{-?\s*end\s*-?\}\}", content[pos:]
            ):
                events.append(
                    (pos + m.start(), "close", pos + m.end())
                )
            events.sort(key=lambda e: e[0])

            nesting = 1
            range_end_pos = None
            for event in events:
                if event[1] == "open":
                    nesting += 1
                elif event[1] == "close":
                    nesting -= 1
                    if nesting == 0:
                        range_end_pos = event[2]
                        break

            if range_end_pos is not None:
                after_range = content[range_end_pos:]
                inside_range = content[
                    range_match.start() : range_end_pos
                ]
                detail_after = (
                    ".DetailUrl" in after_range
                    or "$.DetailUrl" in after_range
                )
                dollar_inside = "$.DetailUrl" in inside_range
                plain_inside = ".DetailUrl" in inside_range

                cond_after = (
                    ".Condition" in after_range
                    or "$.Condition" in after_range
                )
                has_cond_label = bool(re.search(
                    r"(触发条件|策略条件|告警条件|Trigger\s*Condition)"
                    r"\s*[：:]",
                    after_range,
                ))
                ntype_label_readable = bool(re.search(
                    r"(触发|恢复|未知)", after_range
                ))
                if (
                    detail_after
                    and cond_after
                    and has_cond_label
                    and ntype_label_readable
                ):
                    results["correct_metadata_scope"] = 1.0
                elif detail_after and cond_after:
                    results["correct_metadata_scope"] = 0.75
                elif detail_after:
                    results["correct_metadata_scope"] = 0.75
                elif dollar_inside:
                    results["correct_metadata_scope"] = 0.5
                elif plain_inside:
                    results["correct_metadata_scope"] = 0.25
                else:
                    results["correct_metadata_scope"] = 0.25
            else:
                results["correct_metadata_scope"] = (
                    0.5 if (has_detail and has_ntype) else 0.25
                )
        else:
            results["correct_metadata_scope"] = (
                0.5 if (has_detail and has_ntype) else 0.25
            )
    else:
        results["correct_metadata_scope"] = (
            0.5 if (has_detail and has_ntype) else 0.25
        )

    # --- proper_newline_encoding ---
    if data is not None and content:
        newline_count = max(
            content.count("\n"), content.count("\\n")
        )
        has_escaped = bool(re.search(r"\\n", raw))
        if has_escaped and newline_count >= 14:
            results["proper_newline_encoding"] = 1.0
        elif has_escaped and newline_count >= 8:
            results["proper_newline_encoding"] = 0.5
        elif has_escaped and newline_count >= 4:
            results["proper_newline_encoding"] = 0.25
        elif has_escaped:
            results["proper_newline_encoding"] = 0.1
    elif re.search(r"\\n", raw):
        results["proper_newline_encoding"] = 0.05

    # --- has_separator ---
    sep_match = re.search(r"-{3,}", raw)
    if sep_match:
        nearby = raw[
            max(0, sep_match.start() - 300) : sep_match.end() + 300
        ]
        has_device_ctx = any(
            re.search(p, nearby)
            for p in [r"\.sn\b", r"\.shopName\b", r"\.message\b"]
        )
        if content and re.search(r"-{3,}", content) and has_device_ctx:
            results["has_separator"] = 1.0
        elif has_device_ctx:
            results["has_separator"] = 0.75
        else:
            results["has_separator"] = 0.5

    # --- clean_whitespace ---
    has_trailing_space = bool(re.search(r" +\\n", raw))
    has_double_newline = "\\n\\n" in raw
    has_tab = "\t" in content if content else bool(
        re.search(r"\\t", raw)
    )
    ws_issues = sum([has_trailing_space, has_double_newline, has_tab])
    if ws_issues == 0:
        results["clean_whitespace"] = 1.0
    else:
        results["clean_whitespace"] = 0.0

    # --- dynamic_alarm_name ---
    has_alarm_name_var = ".AlarmName" in raw
    has_wrong_chars = bool(re.search(r"收银机", raw))
    has_any_hardcoded = bool(re.search(
        r"告警名称[：:]\s*[\u4e00-\u9fff]", content
    )) if content else False
    has_residual_alarm_text = bool(re.search(
        r"(收款机|连接失败告警|连接异常告警)", content
    )) if content else False
    if (
        has_alarm_name_var
        and not has_wrong_chars
        and not has_any_hardcoded
        and not has_residual_alarm_text
    ):
        results["dynamic_alarm_name"] = 1.0
    elif has_alarm_name_var and not has_wrong_chars and not has_any_hardcoded:
        results["dynamic_alarm_name"] = 0.75
    elif has_alarm_name_var and not has_wrong_chars:
        results["dynamic_alarm_name"] = 0.5
    elif has_alarm_name_var:
        results["dynamic_alarm_name"] = 0.25

    # --- correct_filter_logic ---
    has_if_or_check = bool(
        re.search(r"\{\{-?\s*if\s+or\s+", raw)
    )
    has_if_and_check = bool(
        re.search(r"\{\{-?\s*if\s+and\s+", raw)
    )
    if has_if_or_check and not has_if_and_check:
        results["correct_filter_logic"] = 1.0
    elif has_if_or_check and has_if_and_check:
        results["correct_filter_logic"] = 0.5
    elif has_if_and_check:
        results["correct_filter_logic"] = 0.0
    elif re.search(r"\{\{-?\s*if\s+", raw):
        results["correct_filter_logic"] = 0.25

    # --- changelog ---
    changelog_path = ws / "output" / "template_changelog.md"
    cl_text = ""
    cl_lower = ""
    if changelog_path.is_file():
        try:
            cl_text = changelog_path.read_text(encoding="utf-8").strip()
        except Exception:
            cl_text = ""

        header_count = len(
            re.findall(r"^#{1,3}\s", cl_text, re.MULTILINE)
        )
        if len(cl_text) >= 100 and header_count >= 2:
            results["changelog_exists_with_content"] = 1.0
        elif len(cl_text) >= 50:
            results["changelog_exists_with_content"] = 0.75
        elif len(cl_text) > 0:
            results["changelog_exists_with_content"] = 0.5

        cl_lower = cl_text.lower()
        issue_count = 0
        if any(
            kw in cl_lower
            for kw in [
                "queryresult[0]", "index .queryresult", "bracket",
                "array access", "array index", "index function",
            ]
        ):
            issue_count += 1
        if any(
            kw in cl_lower
            for kw in [
                "double newline", "redundant newline", "blank line",
                "extra newline", "duplicate newline", "extra line",
                "\\n\\n", "unnecessary newline",
            ]
        ):
            issue_count += 1
        if any(
            kw in cl_lower
            for kw in [
                "trailing whitespace", "trailing space",
                "extra space", "whitespace before",
                "spaces before", "space before",
                "unnecessary space", "unnecessary whitespace",
                "inconsistent space", "inconsistent whitespace",
            ]
        ):
            issue_count += 1
        if any(
            kw in cl_lower
            for kw in [
                "scope", "inside range", "inside loop",
                "inside iteration", "moved outside",
                "move outside", "after range",
                "after the loop", "after iteration",
                "repeated metadata", "metadata position",
                "metadata placement", "variable scope",
                "dot rebind", "root context",
                "detailurl inside", "notifytype inside",
            ]
        ):
            issue_count += 1
        if any(
            kw in cl_lower
            for kw in [
                "hardcoded", "hard-coded", "alarm name",
                "alarmname", ".alarmname", "dynamic",
                "收银机", "收款机",
            ]
        ):
            issue_count += 1
        if any(
            kw in cl_lower
            for kw in [
                "case sensitive", "case-sensitive", "logtime",
                "camelcase", "camel case", "camel-case",
                "capitalization", "casing",
            ]
        ):
            issue_count += 1
        if any(
            kw in cl_lower
            for kw in [
                "tab", "\\t", "horizontal tab", "tab character",
            ]
        ):
            issue_count += 1
        if any(
            kw in cl_lower
            for kw in [
                "and vs or", "and to or", "and instead of or",
                "{{if and", "{{if or", "conditional operator",
                "logical operator", "overly restrictive",
                "partial data", "or instead of and",
            ]
        ):
            issue_count += 1
        if any(
            kw in cl_lower
            for kw in [
                "condition", ".condition", "trigger condition",
                "policy condition", "count > 0", "alr-001",
                "alr_001", "runbook", "触发条件",
                "策略条件", "表达式",
            ]
        ):
            issue_count += 1
        if any(
            kw in cl_lower
            for kw in [
                "per-field", "per field", "individual if",
                "skip empty", "omit empty", "hide empty",
                "conditional display", "empty field",
                "field guard", "field-level",
                "empty label", "blank label",
            ]
        ):
            issue_count += 1
        if any(
            kw in cl_lower
            for kw in [
                "alr-001", "alr_001", "alr001",
                "rule_id", "rule id", "rule-id",
                "inventory", "cnt > 0", "cnt>0",
            ]
        ):
            issue_count += 1
        coverage_map = {
            0: 0.0, 1: 0.05, 2: 0.1, 3: 0.15,
            4: 0.2, 5: 0.25, 6: 0.35, 7: 0.45,
            8: 0.55, 9: 0.7, 10: 0.85, 11: 1.0,
        }
        results["changelog_issue_coverage"] = coverage_map.get(
            min(issue_count, 11), 0.0
        )

        # --- changelog_regression_traceability ---
        reg_hits = re.findall(
            r"\bREG[-_]?\d{2,}\b", cl_text, flags=re.IGNORECASE
        )
        reg_norm = {
            re.sub(r"[-_\s]", "", h.lower()) for h in reg_hits
        }
        reg_count = len(reg_norm)
        if reg_count >= 11:
            results["changelog_regression_traceability"] = 1.0
        elif reg_count >= 9:
            results["changelog_regression_traceability"] = 0.5
        elif reg_count >= 7:
            results["changelog_regression_traceability"] = 0.25
        elif reg_count >= 5:
            results["changelog_regression_traceability"] = 0.1
        else:
            results["changelog_regression_traceability"] = 0.0

        # --- changelog_error_classification ---
        has_parse = any(
            kw in cl_lower
            for kw in [
                "parse error", "parse-time", "compile",
                "compilation", "syntax error",
                "won't compile", "cannot compile",
                "parse failure", "fails to parse",
                "parsing error",
            ]
        ) or any(
            frag in cl_text
            for frag in [
                "解析时", "解析期", "语法错误", "编译期",
                "词法", "无法编译",
            ]
        )
        has_render = any(
            kw in cl_lower
            for kw in [
                "render error", "render-time", "runtime",
                "run-time", "wrong output", "empty string",
                "empty output", "incorrect output",
                "silent fail", "silently",
            ]
        ) or any(
            frag in cl_text
            for frag in [
                "渲染时", "运行时", "输出错误", "空字符串",
                "静默", "错误输出",
            ]
        )
        has_cosmetic = any(
            kw in cl_lower
            for kw in [
                "cosmetic", "formatting", "visual",
                "appearance", "readability", "aesthetic",
                "whitespace issue", "indentation",
            ]
        ) or any(
            frag in cl_text
            for frag in [
                "外观", "格式问题", "可读性", "排版",
                "空白", "缩进",
            ]
        )
        class_count = sum([has_parse, has_render, has_cosmetic])
        if class_count >= 3:
            results["changelog_error_classification"] = 1.0
        elif class_count == 2:
            results["changelog_error_classification"] = 0.5
        elif class_count == 1:
            results["changelog_error_classification"] = 0.25

        # --- changelog_inventory_crossref ---
        has_alr001 = bool(
            re.search(r"ALR[-_]?001", cl_text, re.IGNORECASE)
        )
        has_threshold_note = bool(
            re.search(r"cnt\s*>\s*0", cl_text)
        ) or bool(
            re.search(
                r"count.*threshold|threshold.*count",
                cl_lower,
            )
        )
        has_sql_fn = bool(
            re.search(r"count\s*\(\s*\*?\s*\)", cl_text)
        ) or bool(
            re.search(r"stats\s+count", cl_lower)
        )
        has_alias_cnt = bool(
            re.search(r"\bas\b.*\bcnt\b", cl_lower)
        ) or (
            "alias" in cl_lower
            and "cnt" in cl_lower
        )
        has_sql_alias = has_sql_fn and has_alias_cnt
        if has_alr001 and has_threshold_note and has_sql_alias:
            results["changelog_inventory_crossref"] = 1.0
        elif has_alr001 and has_threshold_note:
            results["changelog_inventory_crossref"] = 0.5
        elif has_alr001:
            results["changelog_inventory_crossref"] = 0.25

        # --- changelog_verbatim_before_after ---
        bt = chr(96) * 3
        code_block_pattern = bt + r"[\s\S]*?" + bt
        inline_code_pattern = r"`[^`\n]{5,}`"
        code_blocks = re.findall(code_block_pattern, cl_text)
        inline_codes = re.findall(inline_code_pattern, cl_text)
        all_code = code_blocks + inline_codes
        template_code_refs = sum(
            1 for b in all_code if any(
                kw in b
                for kw in [
                    "{{", ".QueryResult", ".sn", ".shopName",
                    ".NotifyType", ".DetailUrl", ".logTime",
                    ".logtime", "range", "if and", "if or",
                    ".AlarmName", ".Condition",
                ]
            )
        )
        if template_code_refs >= 6:
            results["changelog_verbatim_before_after"] = 1.0
        elif template_code_refs >= 3:
            results["changelog_verbatim_before_after"] = 0.5
        elif template_code_refs >= 1:
            results["changelog_verbatim_before_after"] = 0.25

        # --- changelog_deployment_checklist ---
        has_deploy_section = bool(
            re.search(
                r"#{1,3}\s*.*(deploy|rollback|verification|checklist"
                r"|部署|回滚|验证|清单)",
                cl_text,
                re.IGNORECASE | re.MULTILINE,
            )
        )
        has_rollback = any(
            kw in cl_lower
            for kw in ["rollback", "roll back", "回滚", "回退"]
        )
        has_verify_steps = bool(
            re.search(
                r"[-*]\s*(verify|test|check|confirm|验证|测试|确认)",
                cl_lower,
            )
        )
        deploy_checks = sum(
            [has_deploy_section, has_rollback, has_verify_steps]
        )
        if deploy_checks >= 3:
            results["changelog_deployment_checklist"] = 1.0
        elif deploy_checks >= 2:
            results["changelog_deployment_checklist"] = 0.5
        elif deploy_checks >= 1:
            results["changelog_deployment_checklist"] = 0.25

    # --- preview ---
    preview_path = ws / "output" / "rendered_preview.txt"
    if preview_path.is_file():
        results["preview_exists"] = 1.0
        try:
            preview = preview_path.read_text(encoding="utf-8")
        except Exception:
            preview = ""

        sample_values = [
            "2024-01-15 10:30:00",
            "POS20240001", "POS20240002", "POS20240003",
            "东区旗舰店", "西区分店", "南区购物中心店",
            "SH001", "SH002", "SH015",
            "中区便利店", "SH005",
            "收款机连接失败告警",
            "count > 0",
            "2024-01-15 10:28:33",
            "2024-01-15 10:29:01",
            "2024-01-15 10:29:22",
            "2024-01-15 10:29:45",
            "触发",
            "恢复",
        ]
        found_values = sum(1 for v in sample_values if v in preview)
        ratio = found_values / len(sample_values)
        if ratio >= 1.0:
            accuracy_score = 1.0
        elif ratio >= 0.93:
            accuracy_score = 0.5
        else:
            accuracy_score = round(ratio * 0.5, 2)
        has_readable_preview = "触发" in preview
        has_raw_type = bool(
            re.search(
                r"通知类型.*[:：]\s*1\s*$", preview, re.MULTILINE
            )
        )
        if not has_readable_preview and has_raw_type:
            accuracy_score = round(accuracy_score * 0.5, 2)
        results["preview_sample_data_accuracy"] = accuracy_score

        device_messages = [
            "TCP connection timeout after 30s",
            "heartbeat lost",
            "connection refused",
            "SSL handshake failed: certificate expired",
        ]
        devices_found = sum(
            1 for m in device_messages if m in preview
        )
        comp_score = round(devices_found / len(device_messages), 2)
        log_times = [
            "2024-01-15 10:28:33",
            "2024-01-15 10:29:01",
            "2024-01-15 10:29:22",
            "2024-01-15 10:29:45",
        ]
        times_found = sum(1 for t in log_times if t in preview)
        if times_found < len(log_times):
            comp_score = round(
                comp_score * (times_found / len(log_times)), 2
            )
        if bool(re.search(r"门店名\s*[：:]\s*北区仓储中心", preview)):
            comp_score = round(comp_score * 0.6, 2)
        if "TCP connection restored" in preview:
            comp_score = round(comp_score * 0.6, 2)
        detail_url_part = "console.cloud.example.com"
        if preview.count(detail_url_part) > 1:
            comp_score = round(comp_score * 0.5, 2)
        results["preview_device_completeness"] = comp_score

        # --- preview_superior_to_reference ---
        has_sh005 = "SH005" in preview
        has_mid_shop = "中区便利店" in preview
        no_sn_for_mid = True
        if has_mid_shop:
            mid_idx = preview.find("中区便利店")
            blk_start = preview.rfind("---", 0, mid_idx)
            if blk_start < 0:
                blk_start = max(0, mid_idx - 300)
            blk_end = preview.find("---", mid_idx)
            if blk_end < 0:
                blk_end = min(len(preview), mid_idx + 300)
            mid_block = preview[blk_start:blk_end]
            no_sn_for_mid = not bool(
                re.search(r"设备SN\s*[:：]", mid_block)
            )
        has_mid_logtime = bool(
            re.search(r"2024-01-15\s+10:29:22", mid_block)
        ) if has_mid_shop else False
        if (
            has_sh005
            and has_mid_shop
            and no_sn_for_mid
            and has_mid_logtime
        ):
            results["preview_superior_to_reference"] = 1.0
        elif has_sh005 and has_mid_shop and no_sn_for_mid:
            results["preview_superior_to_reference"] = 0.75
        elif has_sh005 and has_mid_shop:
            results["preview_superior_to_reference"] = 0.5
        elif has_sh005 or has_mid_shop:
            results["preview_superior_to_reference"] = 0.25
        elif "POS20240001" in preview or "东区旗舰店" in preview:
            results["preview_superior_to_reference"] = 0.25
        else:
            results["preview_superior_to_reference"] = 0.0

        # --- preview_multi_scenario ---
        alarm_header_count = len(
            re.findall(r"告警名称", preview)
        )
        has_recovery = "恢复" in preview
        has_unknown = bool(re.search(r"未知", preview))
        has_exact_unknown_99 = bool(
            re.search(r"未知\s*[\(（]\s*99\s*[\)）]", preview)
        )
        condition_occurrences = len(
            re.findall(r"count\s*>\s*0", preview)
        )
        if (
            alarm_header_count >= 3
            and has_recovery
            and has_exact_unknown_99
            and condition_occurrences >= 4
        ):
            results["preview_multi_scenario"] = 1.0
        elif (
            alarm_header_count >= 3
            and has_recovery
            and has_exact_unknown_99
            and condition_occurrences >= 3
        ):
            results["preview_multi_scenario"] = 0.75
        elif (
            alarm_header_count >= 3
            and has_recovery
            and has_unknown
        ):
            results["preview_multi_scenario"] = 0.5
        elif alarm_header_count >= 2 and has_recovery:
            results["preview_multi_scenario"] = 0.25
        elif has_recovery or has_unknown:
            results["preview_multi_scenario"] = 0.1

        # --- preview_filtered_device_explanation ---
        has_north_mention = "北区仓储中心" in preview
        if has_north_mention:
            north_idx = preview.find("北区仓储中心")
            north_ctx = preview[
                max(0, north_idx - 150) : north_idx + 250
            ]
            has_filter_note = any(
                kw in north_ctx.lower()
                for kw in [
                    "filter", "exclude", "skip", "omit",
                    "empty", "falsy", "not included",
                    "not rendered", "not displayed",
                    "过滤", "排除", "跳过", "省略",
                    "全为空", "均为空", "不显示", "不渲染",
                    "不包含", "不出现",
                ]
            )
            if has_filter_note:
                results[
                    "preview_filtered_device_explanation"
                ] = 1.0
            else:
                results[
                    "preview_filtered_device_explanation"
                ] = 0.5

        # --- preview_perfield_omission_evidence ---
        if has_mid_shop:
            mid_idx = preview.find("中区便利店")
            pf_start = preview.rfind("---", 0, mid_idx)
            if pf_start < 0:
                pf_start = max(0, mid_idx - 300)
            pf_end = preview.find("---", mid_idx)
            if pf_end < 0:
                pf_end = min(len(preview), mid_idx + 300)
            mid_dev_block = preview[pf_start:pf_end]
            has_sn_in_mid_block = bool(
                re.search(r"设备SN\s*[:：]", mid_dev_block)
            )
            if not has_sn_in_mid_block:
                results[
                    "preview_perfield_omission_evidence"
                ] = 1.0
            else:
                results[
                    "preview_perfield_omission_evidence"
                ] = 0.0
        else:
            results[
                "preview_perfield_omission_evidence"
            ] = 0.0

    # --- template_whitespace_trimming ---
    trim_count = len(re.findall(r"\{\{-\s|-\s*\}\}", check_text))
    if trim_count >= 4:
        results["template_whitespace_trimming"] = 1.0
    elif trim_count >= 2:
        results["template_whitespace_trimming"] = 0.5
    elif trim_count >= 1:
        results["template_whitespace_trimming"] = 0.25

    # --- template_graceful_empty_message ---
    guard_else_msg = bool(re.search(
        r"\{\{-?\s*else\s*-?\}\}[^{}]*[\u4e00-\u9fff]",
        content if content else raw,
    ))
    if guard_else_msg and has_nil_guard:
        results["template_graceful_empty_message"] = 1.0
    elif guard_else_msg:
        results["template_graceful_empty_message"] = 0.5

    # --- template_comment_design_coverage ---
    comment_blocks = re.findall(
        r"\{\{/\*.*?\*/\}\}", raw, re.DOTALL
    )
    if comment_blocks:
        all_cmt = " ".join(comment_blocks).lower()
        design_kws = [
            "or", "index", "scope", "range", "guard",
            "nil", "empty", "fallback", "notifytype",
            "metadata", "field", "conditional",
        ]
        cmt_topics = sum(
            1 for kw in design_kws if kw in all_cmt
        )
        if cmt_topics >= 4:
            results["template_comment_design_coverage"] = 1.0
        elif cmt_topics >= 2:
            results["template_comment_design_coverage"] = 0.5
        elif cmt_topics >= 1:
            results["template_comment_design_coverage"] = 0.25

    if cl_text:
        # --- changelog_severity_ordered ---
        sev_re = re.compile(
            r"(critical|high|medium|low|严重|高风险|高|中风险|中|低风险|低)"
            r"\s*[-:：/|]",
            re.IGNORECASE,
        )
        sev_seq = []
        for sm in sev_re.finditer(cl_lower):
            label = sm.group(1).lower()
            if label in ("critical", "严重"):
                sev_seq.append(4)
            elif label in ("high", "高风险", "高"):
                sev_seq.append(3)
            elif label in ("medium", "中风险", "中"):
                sev_seq.append(2)
            elif label in ("low", "低风险", "低"):
                sev_seq.append(1)
        if len(sev_seq) >= 3:
            is_ordered = all(
                sev_seq[i] >= sev_seq[i + 1]
                for i in range(len(sev_seq) - 1)
            )
            if is_ordered:
                results["changelog_severity_ordered"] = 1.0
            else:
                results["changelog_severity_ordered"] = 0.5
        elif len(sev_seq) >= 1:
            results["changelog_severity_ordered"] = 0.25

        # --- changelog_alternative_approaches ---
        alt_kws = [
            "alternative", "instead of moving",
            "rather than", "trade-off", "tradeoff",
            "could also", "another approach",
            "也可以", "替代方案", "权衡", "方案对比",
            "$.detailurl", "$.notifytype",
            "dollar prefix", "$ prefix",
            "root scope prefix", "根级引用",
        ]
        alt_count = sum(
            1 for kw in alt_kws
            if kw in cl_lower or kw in cl_text
        )
        if alt_count >= 3:
            results["changelog_alternative_approaches"] = 1.0
        elif alt_count >= 1:
            results["changelog_alternative_approaches"] = 0.5

        # --- changelog_backward_compat ---
        compat_kws = [
            "backward", "backwards", "back-compat",
            "backward compat", "向后兼容", "兼容性",
            "旧版", "older payload", "older data",
            "zero value", "零值", "missing field",
            "legacy", "legacy data",
        ]
        compat_count = sum(
            1 for kw in compat_kws
            if kw in cl_lower or kw in cl_text
        )
        if compat_count >= 2:
            results["changelog_backward_compat"] = 1.0
        elif compat_count >= 1:
            results["changelog_backward_compat"] = 0.5

        # --- changelog_root_cause_depth ---
        depth_kws = [
            "tokenize", "lexer", "parser internal",
            "zero value", "zero-value", "dot rebind",
            "evaluation context", "rebinding",
            "词法", "零值", "重绑定",
            "解析器内部", "上下文切换",
            "dot is rebound", "context is rebound",
        ]
        depth_count = sum(
            1 for kw in depth_kws
            if kw in cl_lower or kw in cl_text
        )
        if depth_count >= 3:
            results["changelog_root_cause_depth"] = 1.0
        elif depth_count >= 1:
            results["changelog_root_cause_depth"] = 0.5

        # --- changelog_runbook_conflict_note ---
        runbook_kws = [
            "runbook conflict", "runbook contradict",
            "runbook disagree", "runbook suggest",
            "runbook recommend", "runbook says",
            "手记冲突", "手记建议",
            "conflicts with", "contradicts",
        ]
        has_runbook_conflict = any(
            kw in cl_lower for kw in runbook_kws
        )
        if not has_runbook_conflict:
            has_runbook_conflict = (
                "runbook" in cl_lower
                and any(
                    kw in cl_lower
                    for kw in [
                        "condition", "omit", "skip",
                        "ignore", "override", "省略",
                        "忽略", "冲突",
                    ]
                )
            )
        if has_runbook_conflict:
            results["changelog_runbook_conflict_note"] = 1.0

        # --- changelog_testing_per_fix ---
        reg_sections = re.split(
            r"\bREG[-_]?\d{2,}\b", cl_text,
            flags=re.IGNORECASE,
        )
        sections_with_test = 0
        for section in reg_sections[1:]:
            sec_lower = section[:500].lower()
            if any(
                kw in sec_lower
                for kw in [
                    "test", "verify", "validate",
                    "confirm", "check with",
                    "测试", "验证", "确认", "检查",
                ]
            ):
                sections_with_test += 1
        if sections_with_test >= 5:
            results["changelog_testing_per_fix"] = 1.0
        elif sections_with_test >= 3:
            results["changelog_testing_per_fix"] = 0.5
        elif sections_with_test >= 1:
            results["changelog_testing_per_fix"] = 0.25

    if cl_text:
        # --- changelog_issue_count_structural ---
        issue_hdrs = re.findall(
            r"#{2,3}\s+.*("
            r"Issue|问题|Fix|修复|Bug|错误|REG[-_]\d"
            r"|Array|Syntax|Scope|Alarm|Field|Tab"
            r"|Whitespace|Newline|Condition|Filter"
            r")",
            cl_text,
            re.IGNORECASE,
        )
        icount = len(issue_hdrs)
        if icount >= 11:
            results["changelog_issue_count_structural"] = 1.0
        elif icount >= 9:
            results["changelog_issue_count_structural"] = 0.75
        elif icount >= 7:
            results["changelog_issue_count_structural"] = 0.5
        elif icount >= 5:
            results["changelog_issue_count_structural"] = 0.25

    # --- template_condition_label_zh ---
    if content and ".Condition" in content:
        has_cond_label_zh = bool(re.search(
            r"(触发条件|策略条件|告警条件)[：:]\s*\{\{",
            content,
        ))
        if has_cond_label_zh:
            results["template_condition_label_zh"] = 1.0
        else:
            results["template_condition_label_zh"] = 0.25

    if preview_path.is_file() and preview:
        # --- preview_branch_annotations ---
        branch_kws = [
            "{{range", "range block", "range 块",
            "{{if or", "{{if eq", "if or",
            "[Note", "(Note", "【注", "[注",
            "header", "footer", "页脚", "头部",
            "device block", "设备块", "branch",
            "分支", "条件分支", "逻辑分支",
        ]
        branch_hits = sum(
            1 for kw in branch_kws
            if kw.lower() in preview.lower()
        )
        if branch_hits >= 5:
            results["preview_branch_annotations"] = 1.0
        elif branch_hits >= 3:
            results["preview_branch_annotations"] = 0.5
        elif branch_hits >= 1:
            results["preview_branch_annotations"] = 0.25

        # --- preview_all_scenarios_complete ---
        all_msgs_3x = all(
            preview.count(msg) >= 3
            for msg in device_messages
        )
        all_msgs_2x = all(
            preview.count(msg) >= 2
            for msg in device_messages
        )
        if all_msgs_3x and alarm_header_count >= 3:
            results["preview_all_scenarios_complete"] = 1.0
        elif all_msgs_2x and alarm_header_count >= 3:
            results["preview_all_scenarios_complete"] = 0.5
        elif alarm_header_count >= 3:
            results["preview_all_scenarios_complete"] = 0.25

    # --- Conditional gating ---
    if results["correct_range_syntax"] < 1.0:
        for k in (
            "template_control_flow", "has_all_device_fields",
            "correct_metadata_scope", "correct_variable_names",
        ):
            results[k] = round(results[k] * 0.5, 2)

    if results["template_inline_comments"] < 0.5:
        results["template_control_flow"] = round(
            results["template_control_flow"] * 0.75, 2
        )

    if results["template_control_flow"] < 1.0:
        for k in (
            "has_all_device_fields",
            "per_field_conditional",
            "correct_metadata_scope",
        ):
            results[k] = round(results[k] * 0.75, 2)

    if results["correct_metadata_scope"] < 1.0:
        for k in (
            "correct_variable_names",
            "template_control_flow",
            "has_all_device_fields",
            "has_separator",
            "preview_sample_data_accuracy",
            "preview_device_completeness",
            "changelog_issue_coverage",
        ):
            results[k] = round(results[k] * 0.5, 2)

    if results["correct_filter_logic"] < 1.0:
        for k in (
            "preview_device_completeness",
            "has_all_device_fields",
            "template_control_flow",
            "changelog_issue_coverage",
        ):
            results[k] = round(results[k] * 0.75, 2)

    if results["dynamic_alarm_name"] < 1.0:
        for k in (
            "preview_sample_data_accuracy",
            "changelog_issue_coverage",
        ):
            results[k] = round(results[k] * 0.75, 2)

    return results
```

## LLM Judge Rubric

### grading_weights: automated=0.05, llm_judge=0.95

**Baseline reference**: A senior DevOps engineer with Go template expertise and production incident review experience, given the same workspace and 20 minutes, would produce deliverables that **clearly surpass** the rough drafts in `references/human_reference_preview.txt` and `references/human_reference_changelog_snippet.md` on sample fidelity, issue coverage, and regression traceability. Expect: (1) a **defensive, self-documenting** template with per-field conditional guards using correct Chinese labels (设备SN/门店名/门店NO/日志时间/告警信息), nil-safety guards (e.g. `{{if .QueryResult}}` before range) with Chinese fallback message, whitespace trimming markers (`{{-`/`-}}`), a Chinese-labeled trigger condition line (触发条件: `{{.Condition}}`), and inline Go template comments (`{{/* ... */}}`) explaining at least four key design decisions, (2) a **JIRA-ticket-ready changelog** with verbatim before/after code diffs for each fix, severity-ordered entries, per-issue risk assessment with targeted test approaches, **at least nine `REG-###` hooks** covering all eleven issues, inventory cross-reference (ALR-001) with full SQL alias explanation (both `count(*)` function and `as cnt` binding), a dedicated deployment verification section with rollback considerations, explicit error categorization (parse-time / render-time / cosmetic), alternative approach analysis with trade-offs, backward compatibility discussion, and per-fix runbook conflict resolution, (3) a **three-scenario** rendered preview (trigger / recovery / unknown-type) with exact "未知(99)" formatting, annotated with conditional logic execution traces and per-block branch notes for every section, per-field omission evidence for "中区便利店" (SN line absent, logTime "2024-01-15 10:29:22" present), filtered-device explanations for "北区仓储中心", the trigger condition `count > 0` appearing in **all three** scenario footers, and complete device lists in all scenarios, (4) a forward-looking template design with per-field guards, three-way NotifyType fallback with Chinese unknown text, graceful handling for unexpected input values including empty data sets with Chinese-language empty-state message, and no residual hardcoded alarm name text. **Score 1.0** only when output is clearly stronger than those reference drafts on the relevant axis; **score 0.5** for work that merely approaches the references or meets correctness without the extra rigor; **score 0.0** when deliverables are missing or materially worse than the references.

### Criterion 1: Template Correctness and Per-Field Conditional Logic (Weight: 5%)

**Score 1.0**: All Issues 1–11 correctly resolved (including root-scoped `.Condition`, three-way `NotifyType`, AND per-field conditional display with `{{if .fieldName}}` guards for each of the five device fields). Valid JSON with `msgtype: "text"`. The per-field logic correctly handles the "中区便利店" case — SN line absent, other lines present. Template follows minimal-change principle.
**Score 0.5**: Core structural issues fixed (array syntax, metadata scope, filter logic, alarm name, three-way NotifyType) and valid JSON, but per-field conditional display is missing or incomplete (fewer than 5 field guards), or 2+ secondary issues remain (trailing whitespace, tab, double newline, `logTime` casing).
**Score 0.0**: Output missing, invalid JSON, core issues unresolved, or per-field conditional not attempted despite explicit prompt request. If the output file does not exist, must score 0.

### Criterion 2: Template Inline Documentation (Weight: 5%)

**Score 1.0**: Template contains Go template comments (`{{/* ... */}}`) covering at least three of: (a) why `or` over `and`, (b) why `index` is needed for array access, (c) why metadata sits outside `range`, (d) per-field conditional design rationale, (e) three-way `NotifyType` choice. Comments are concise and technically accurate — a new team member can understand design decisions without external context.
**Score 0.5**: One or two inline comments present, or comments cover fewer than three of the design decisions listed above. Comments exist but are superficial (e.g., "fix applied here").
**Score 0.0**: No Go template comments (`{{/* ... */}}`) in the output template file.

### Criterion 3: Changelog — Verbatim Before/After Diffs and Root Cause Analysis (Weight: 7%)

**Score 1.0**: Documents at least **nine** distinct issues (including per-field conditional and `.Condition` placement). Each entry includes: (a) the exact original snippet quoted verbatim, (b) the corrected snippet, (c) a root cause citing Go template internals — for array syntax, how `[` is tokenized as literal; for scope, dot-rebinding in `range`; for `and`→`or`, walks through "中区便利店" field-by-field. Cross-references **ALR-001** from inventory and notes `cnt > 0` / `count > 0` correspondence. Organized by severity.
**Score 0.5**: 6+ issues with clear descriptions but lacks inventory cross-reference, shallow root causes, or missing before/after for some entries.
**Score 0.0**: Fewer than 4 issues, no file, or no technical substance. Must score 0 if file missing.

### Criterion 4: Changelog — Risk Assessment, Deployment Verification, and Inventory Cross-Reference (Weight: 7%)

**Score 1.0**: Each entry has risk level (Critical/High/Medium/Low) with justification AND fix-specific testing approach (not generic). Changelog cites **ALR-001** and the threshold expression correspondence with SQL alias origin (`stats count(*) as cnt`). Includes a **dedicated deployment verification section** with rollback consideration, post-deployment monitoring steps, and a pre-deployment checklist. Reads as an approvable change request.
**Score 0.5**: Some entries have risk levels but testing is generic, or SQL alias explanation missing, or no dedicated deployment section, or no rollback consideration.
**Score 0.0**: No risk assessment, no testing recommendations, or no deployment content.

### Criterion 5: Rendered Preview — Multi-Scenario Accuracy and Annotations (Weight: 6%)

**Score 1.0**: Preview contains **three** clearly labeled scenario blocks: (1) Trigger (NotifyType=1) — four devices, "中区便利店" WITHOUT the SN line (per-field omission), "触发", `count > 0` in footer, metadata once, no QR[1]; (2) Recovery (NotifyType=2) — same device data, notification type "恢复", trigger condition repeated in footer; (3) Unknown Type (NotifyType=99) — notification type in exact format "未知(99)" with parenthesized raw number. Each block includes per-section annotations explaining conditional branches and filtered devices. The trigger condition `count > 0` appears in at least two scenario footers.
**Score 0.5**: Trigger scenario complete and accurate with annotations, but recovery and/or unknown-type scenarios missing or inexact unknown format. Or all three scenarios present but lack annotations, per-field omission for "中区便利店", or condition not repeated across scenarios.
**Score 0.0**: Preview missing, wrong device count, includes QR[1] data, only one scenario without annotations, or alarm name incorrect. Must score 0 if file missing.

### Criterion 6: Diagnostic Reasoning and Error Classification (Weight: 10%)

**Score 1.0**: Systematic diagnosis across **all three** error categories (parse/render/cosmetic) with technical justification. Explains parser internals for array syntax, dot-rebinding for scope, discusses `$` prefix alternative with trade-offs. Walks through "中区便利店" sample record proving `or` > `and`. Justifies per-field conditional design. Identifies trap files; reconciles runbook conflict regarding `.Condition`. Notes ALR-001 threshold expression correspondence.
**Score 0.5**: Fixes correct but reasoning reactive — missing `$` alternative, per-field justification, inventory reconciliation, or sample data walkthrough.
**Score 0.0**: Mechanical fixes, misled by traps, or incorrect diagnosis. Must score 0 if output missing.

### Criterion 7: Edge Cases, Per-Field Logic, and Backward Compatibility (Weight: 8%)

**Score 1.0**: Discusses all of: (a) "北区仓储中心" filtered, (b) "中区便利店" included with empty SN omitted by per-field guard, (c) QR[1] exclusion, (d) empty QueryResult nil safety, (e) backward compatibility / zero-value semantics, (f) special characters and JSON escaping, (g) unexpected NotifyType, (h) what happens when `shopName` is non-empty but all three `or`-checked fields are empty (device excluded despite having a name — a subtle limitation).
**Score 0.5**: Covers obvious cases but misses per-field edge behavior, nil safety, special characters, or the shopName-only scenario.
**Score 0.0**: No edge case discussion or contradicts data.

### Criterion 8: Template Extensibility and Future-Proofing (Weight: 7%)

**Score 1.0**: Uses `{{.AlarmName}}` for reusability. NotifyType three-way conditional with unknown fallback. Per-field guards make adding/removing fields straightforward. Discusses how to add new device fields or alarm rules. Notes which changes improve cross-rule reusability.
**Score 0.5**: `AlarmName` correct, three-way NotifyType, but no per-field conditional, or no discussion of template evolution for new fields/rules.
**Score 0.0**: Hardcoded alarm name, no extensibility consideration, or reduces flexibility.

### Criterion 9: Production Readiness and Maintenance Documentation (Weight: 7%)

**Score 1.0**: Includes deployment verification steps, maintenance notes for future editors, frames preview as acceptance criteria. Discusses monitoring approach post-deployment (e.g., "compare device count in next real alert against CLS console"). Professional communication quality.
**Score 0.5**: Technically correct but lacks verification steps, maintenance guidance, or monitoring approach.
**Score 0.0**: Disorganized or missing key deliverables. Must score 0 if key files missing.

### Criterion 10: Superiority Over References, Regression Traceability, and Cross-Deliverable Consistency (Weight: 5%)

**Score 1.0**: Explicitly compares against `references/` drafts with concrete differences. Every `REG-###` maps to a specific fix and is traceable to preview scenarios (at least five unique REG tags). All deliverables tell a consistent story about conditional branches, filtered devices, and per-field omission.
**Score 0.5**: Improvements evident but not explicitly contrasted against references. REG tags present but fewer than five or decorative.
**Score 0.0**: Ignores references while repeating gaps, or contradictory across deliverables.

### Criterion 11: Defensive Template Design and Nil Safety (Weight: 5%)

**Score 1.0**: Template includes a guard for empty or nil `QueryResult` before the `{{range}}` block (e.g. `{{if .QueryResult}}` or `{{if gt (len .QueryResult) 0}}`), preventing nil-pointer panics when no data is available. Discusses what happens when the device list is empty and how the template degrades gracefully. Considers zero-value vs missing-field semantics in Go templates. Template design anticipates edge inputs beyond the provided sample.
**Score 0.5**: Acknowledges empty data possibility in documentation but no actual guard in the template, or guard present but not discussed in changelog/preview.
**Score 0.0**: No nil safety consideration in template or documentation. Template would panic or produce garbled output if `QueryResult` is empty.

### Criterion 12: Preview Per-Field Omission Evidence and Filtered Device Annotations (Weight: 6%)

**Score 1.0**: The rendered preview clearly demonstrates per-field conditional omission: the "中区便利店" device block shows shop name, shop number, log time, and message but **does not** contain a `设备SN:` line (proving the `{{if .sn}}` guard works). The preview also explicitly annotates why "北区仓储中心" is excluded (cites the `{{if or .sn .shopNo .message}}` check and notes all three fields are empty). These annotations appear as inline notes alongside the rendered content, not as separate discussion.
**Score 0.5**: "中区便利店" present but SN line incorrectly included, or "北区仓储中心" exclusion not annotated, or annotations are in separate discussion rather than inline.
**Score 0.0**: "中区便利店" missing from preview, or per-field omission not demonstrated, or no filtered-device annotations.

### Criterion 13: Changelog — Severity Ordering and Alternative Approach Analysis (Weight: 8%)

**Score 1.0**: Changelog entries are organized by severity (Critical/High issues documented before Medium/Low), with explicit severity labels. Each substantive fix discusses **alternative approaches** considered and rejected — e.g., using `$` prefix for root-scope access within `range` vs moving metadata outside, with trade-off analysis. The runbook conflict regarding `.Condition` is explicitly noted and resolved by citing the authoritative variable docs and current prompt. Backward compatibility implications are discussed for at least two major fixes.
**Score 0.5**: Some severity labels present but not consistently ordered, or alternative approaches mentioned but without trade-off reasoning, or runbook conflict not explicitly addressed.
**Score 0.0**: No severity ordering, no alternative approach discussion, no runbook conflict acknowledgment.

### Criterion 14: Template Whitespace Control and Graceful Degradation (Weight: 7%)

**Score 1.0**: Template uses Go template whitespace trimming markers (`{{-` / `-}}`) to control output formatting precisely. A fallback message (in Chinese) is provided in an `{{else}}` branch when `QueryResult` is empty — e.g., `{{else}}暂无告警设备{{end}}` — so the DingTalk message remains user-friendly rather than blank. Template inline comments cover at least four distinct design topics (or/and choice, index necessity, scope handling, field guards, nil safety, NotifyType branching).
**Score 0.5**: Either whitespace trimming OR graceful empty-state message present, but not both. Comments cover 2–3 topics.
**Score 0.0**: No whitespace trimming, no empty-state fallback, and no meaningful design-decision comments.

### Criterion 15: Preview Completeness Across Scenarios and Per-Fix Testing (Weight: 7%)

**Score 1.0**: All three rendered preview scenarios (trigger/recovery/unknown) contain the **complete** device list — four qualifying devices with full field details in each scenario, not just the trigger scenario. Each `REG-###` tag in the changelog is accompanied by a **specific testing recommendation** (not generic "test thoroughly"). The recovery scenario accurately reflects `恢复` state with `count > 0` in the footer. The unknown scenario shows exact `未知(99)` format.
**Score 0.5**: Recovery and unknown scenarios present but abbreviated (not all devices listed), or testing recommendations are generic rather than per-fix.
**Score 0.0**: Only trigger scenario has full device data, or no per-fix testing notes, or recovery/unknown scenarios missing.
