---
id: task_00019_create_n8n_test_workflow_report_from_configuration_and_specs
name: Create n8n Test Workflow Report from Configuration and Specs
category: Workflow and Agent Orchestration
grading_type: hybrid
timeout_seconds: 1800
verification_method: rubric
grading_weights:
  automated: 0.55
  llm_judge: 0.45
workspace_files:
- source: config/n8n_server.json
  dest: config/n8n_server.json
- source: config/n8n_credentials.json
  dest: config/n8n_credentials.json
- source: docs/n8n_workflow_spec.md
  dest: docs/n8n_workflow_spec.md
- source: docs/n8n_node_reference.md
  dest: docs/n8n_node_reference.md
- source: examples/sample_workflow_v1.json
  dest: examples/sample_workflow_v1.json
- source: examples/sample_workflow_v2.json
  dest: examples/sample_workflow_v2.json
- source: config/deployment_notes.yaml
  dest: config/deployment_notes.yaml
- source: logs/n8n_execution.log
  dest: logs/n8n_execution.log
subcategory: Workflow and Task Scheduling
---
## Prompt

I'm setting up a QA environment for our n8n platform and need a standard test workflow that confirms everything's healthy after deployment. I've put the spec docs, server config, node reference, a couple of older example workflows, credentials info, and our recent execution logs into the workspace for reference.

Could you go through those files and put together a report at `output/n8n_workflow_report.md`? I'd want a brief summary up top — what the workflow does, which nodes it uses, where it should live on the server — then a compatibility section explaining what's different from the two older example workflows we have and why they can't just be reused as-is. After that, include the full workflow JSON inline so I can review it right in the report.

Also drop the raw workflow JSON as `output/test_workflow.json` so we can import it straight into n8n. Make sure the two copies are identical — same nodes, same connections, same settings, same name.

Heads up: some files in the workspace are from previous environments and may not be current. The spec and node reference docs are the authoritative sources, and the server config JSON is ground truth for deployment paths and environment settings like timezone. Don't just copy from the old examples without checking — each one has at least one issue. And make sure the Function node's validation logic is actually robust: it should verify that fields exist and are in the correct format (e.g., timestamps should be valid ISO 8601), not just do a basic truthy check.

Also make sure the test variables capture enough context about the deployment — at minimum which environment name and server version the test targets (those are in different workspace config files). And double-check any timezone-related fields in the server config carefully; there may be more than one, and you'll want the right one for workflow settings.

## Expected Behavior

The agent must produce two deliverables:

**1. Markdown Report** at `output/n8n_workflow_report.md`:

- A summary section describing the test workflow's purpose (verifying n8n instance health post-deployment), the three required nodes (Manual Trigger, Set, Function), and the correct server save path `/opt/n8n/workflows`.
- A compatibility notes section that identifies specific issues with each of the two example workflows (`sample_workflow_v1.json` and `sample_workflow_v2.json`) and explains why they cannot be reused directly.
- A complete, valid n8n-compatible workflow JSON inlined as a fenced code block.

**2. Standalone Workflow JSON** at `output/test_workflow.json`:

- The same workflow as embedded in the report, saved as a directly importable n8n JSON file. The standalone file and the report's inline JSON must be structurally identical (same nodes, connections, settings, and workflow name).

### Workflow JSON Requirements

The workflow JSON (in both deliverables) must contain:

- A `name` field following the `Test_Workflow_<Purpose>` PascalCase pattern (e.g., `Test_Workflow_QaVerification`, `Test_Workflow_PostDeployCheck`), per the naming convention in `docs/n8n_workflow_spec.md`. The purpose portion must be PascalCase without underscores and at least 6 characters.
- A `nodes` array with exactly three nodes (no additional nodes):
  - A **Manual Trigger** node with type `n8n-nodes-base.manualTrigger` (NOT the deprecated `n8n-nodes-base.start`).
  - A **Set** node with type `n8n-nodes-base.set`, `typeVersion` exactly 3.4 (per node reference), using the `assignments` parameter format (with `testName`, `testTimestamp`, and `testEnv` variables). Each assignment entry must include `id`, `name`, `value`, and `type` fields per the node reference, with `type` set to `"string"`. The `testEnv` value must combine the deployment environment from `config/deployment_notes.yaml` (i.e., `staging`) with the n8n server version from `config/n8n_server.json` (i.e., `1.52.0`), such that both the environment identifier and the version number appear in the value (e.g., `"staging-1.52.0"`). The `testTimestamp` value must be a valid ISO 8601 string with UTC timezone indicator (ending with `Z` or `+00:00`, matching the server's UTC timezone). The `testName` value must not be copied from either example workflow.
  - A **Function** node with type `n8n-nodes-base.function` (recommended per node reference; `n8n-nodes-base.code` is accepted with reduced credit) containing a `functionCode` parameter with robust validation logic including try-catch error handling, field presence and format checks (e.g., validates that `testTimestamp` is a parseable date/time), and returning a result with `status` and `message` fields.
- Each node must include all required fields: `name`, `type`, `typeVersion`, `position` (as `[x, y]` array), and `parameters`.
- A `connections` object wiring: Manual Trigger → Set → Function, with each connection entry including exactly three fields (`node`, `type`, `index`) and no extras. The chain must have at least 2 connection links (matching the reference workflow `sample_workflow_v1.json`'s 3-node chain pattern). Each connection source must have exactly one output port array with one target per port (linear chain, no branching). All target node names must reference nodes that actually exist in the `nodes` array. The Function node is terminal and must not have outgoing connections; the connections object should contain exactly two source keys (trigger and set nodes only).
- A `settings` object with workflow-level configuration derived from the server environment — `timezone` must match the server config value ("UTC" from `config/n8n_server.json`), `saveManualExecutions` must be set, `executionTimeout` should reflect the server's execution timeout (3600 from `config/n8n_server.json`), and `saveDataOnError` / `saveDataOnSuccess` must match the server config's execution settings ("all" from `config/n8n_server.json`).

### Trap Handling

- **Trap 1 (Deprecated node types and parameter formats):** `examples/sample_workflow_v1.json` uses the deprecated `n8n-nodes-base.start` node, old `parameters.values` format for the Set node, and an outdated `typeVersion` of 1 for the Set node. The agent must consult `docs/n8n_node_reference.md` (which lists `n8n-nodes-base.start` as deprecated since v1.0 and `parameters.values` as deprecated) and use `n8n-nodes-base.manualTrigger` with the `parameters.assignments` format and `typeVersion` 3.4 instead.

- **Trap 2 (Contradictory save paths):** `config/deployment_notes.yaml` specifies `workflow_save_path: /var/lib/n8n/workflows`, contradicting `workflowsDir: /opt/n8n/workflows` in `config/n8n_server.json`. The prompt explicitly states the server config JSON is ground truth, so the correct path is `/opt/n8n/workflows`.

- **Trap 3 (Incomplete example):** `examples/sample_workflow_v2.json` is a partial example that only contains Manual Trigger and Set nodes — it is missing the required Function node. An agent that relies solely on this example without adding the Function node will produce an incomplete workflow.

- **Trap 4 (Settings discrepancy in examples):** `examples/sample_workflow_v1.json` uses `"timezone": "America/New_York"` in its settings, contradicting the server configuration's `"timezone": "UTC"`. The agent should derive all workflow settings from the server configuration (`config/n8n_server.json`), not from example workflows. Additionally, the server config specifies `saveDataOnError: "all"` and `saveDataOnSuccess: "all"` under `executions`, which should be reflected in the workflow settings.

- **Trap 5 (Ambiguous timezone fields in server config):** `config/n8n_server.json` contains two timezone-related fields: `timezone: "UTC"` (the correct workflow-level timezone) and `genericTimezone: "America/New_York"` (the n8n UI display timezone, irrelevant to workflow settings). An agent that confuses `genericTimezone` with `timezone` may use the wrong value for workflow settings. The report should discuss this dual-timezone configuration and explicitly clarify that `timezone` (not `genericTimezone`) is the correct field for workflow `settings.timezone`.

- **Noise files:** `config/n8n_credentials.json` and `logs/n8n_execution.log` are irrelevant to workflow creation and should not be incorporated into the output.

### Common Pitfalls

- Copying settings (e.g., timezone) from example workflows rather than deriving them from the server configuration.
- Omitting `id` and `type` fields from assignment entries in the Set node (only providing `name` and `value`).
- Writing trivial Function node code that only checks field existence (`if (testName)`) without validating format (e.g., ISO 8601 timestamp parsing).
- Using underscores in the `<Purpose>` portion of the workflow name (spec requires PascalCase).
- Producing different JSON in the report vs. the standalone file (inconsistent connections or settings keys).
- Not discussing all three example-related issues in the compatibility section (deprecated types in v1, deprecated parameter format in v1, missing Function node in v2).
- Using `n8n-nodes-base.code` with `jsCode` instead of `n8n-nodes-base.function` with `functionCode` (the node reference recommends the `function` type for simple validation tasks).
- Omitting try-catch error handling in the Function node code (the prompt explicitly requires "robust" validation logic).
- Not including UTC timezone indicator (`Z` or `+00:00`) in the `testTimestamp` value despite the server being configured for UTC.
- Adding the Function node as a source key in the connections object when it should be terminal (no outgoing connections).
- Not deriving `saveDataOnError` and `saveDataOnSuccess` settings from the server configuration's `executions` section.
- Not discussing timezone/settings discrepancies between example workflows and server configuration in the compatibility section.
- Not including a `testEnv` variable in the Set node assignments (requires cross-file reasoning: combining `environment` from `config/deployment_notes.yaml` with `version` from `config/n8n_server.json`).
- Confusing `genericTimezone` with `timezone` in the server config, or not discussing the presence of both timezone-related fields in the compatibility section.

### Multi-Layer Expectations

- **Basic completion:** Both output files exist; the report contains a summary and embedded JSON with the three correct node types; standalone JSON is parseable.
- **High-quality completion:** JSON is structurally valid and importable — exactly 3 nodes, each with all required fields (`name`, `type`, `typeVersion`, `position`, `parameters`); Set node uses `typeVersion` exactly 3.4 with proper `parameters.assignments` nested structure including `id` and `type` (`"string"`) fields for each assignment, `testTimestamp` as ISO 8601 with UTC indicator (`Z`), `testName` as original value (not copied from examples), **`testEnv` combining the deployment environment ("staging") and server version ("1.52.0") from two different config files**; Function node uses `n8n-nodes-base.function` type with `functionCode` parameter, contains try-catch error handling plus conditional validation logic that checks both field presence and timestamp format, returning `{status, message}`; connections have exactly two source keys with Function as terminal node, each connection target has exactly three fields (`node`, `type`, `index`) with no extras, all target names reference existing nodes, and the chain has at least 2 links; settings have `timezone: "UTC"`, `saveManualExecutions`, `executionTimeout: 3600`, `saveDataOnError: "all"`, and `saveDataOnSuccess: "all"` (all from server config). Report includes a compatibility section discussing issues with **both** example workflows (deprecated types/formats in v1, missing Function node in v2, settings discrepancies), **discusses the `genericTimezone` vs `timezone` ambiguity in the server config**, correctly identifies the authoritative save path with source reference, and the standalone JSON is structurally identical to the report's inline JSON (matching nodes, connections, settings, and name).

## Grading Criteria

- [ ] The report file `output/n8n_workflow_report.md` exists and contains substantive content.
- [ ] The standalone file `output/test_workflow.json` exists and is valid, parseable JSON with a `nodes` array.
- [ ] The workflow JSON contains exactly three nodes with correct types: `n8n-nodes-base.manualTrigger`, `n8n-nodes-base.set` (typeVersion exactly 3.4), and `n8n-nodes-base.function` with `functionCode` parameter (preferred; `.code` accepted with reduced credit), no deprecated `n8n-nodes-base.start`, each node includes all required fields (`name`, `type`, `typeVersion`, `position` as `[x,y]`, `parameters`), and exactly 3 nodes total.
- [ ] The Set node uses `typeVersion` exactly 3.4 with the `assignments` parameter format (nested `assignments.assignments` array), each entry having `id`, `name`, `value`, and `type` (`"string"`) fields, with `testName` (original value, not copied from examples), `testTimestamp` defined as a valid ISO 8601 string with UTC indicator (`Z` or `+00:00`), and `testEnv` whose value combines the deployment environment from `config/deployment_notes.yaml` (`"staging"`) and the server version from `config/n8n_server.json` (`"1.52.0"`) — not the deprecated `values` format.
- [ ] The `connections` object correctly wires the three nodes in sequence: Manual Trigger → Set → Function, with each connection target entry having exactly three fields (`node`, `type: "main"`, `index: 0`) and no extras. The chain must have at least 2 connection links (matching v1's pattern). Each source must have exactly one output port with one target (linear, no branching). All target node names must reference nodes that exist in the `nodes` array. The Function node must be terminal (no outgoing connections), and the connections object must contain exactly two source keys.
- [ ] The workflow `name` field follows the `Test_Workflow_<Purpose>` PascalCase naming convention from the spec (no underscores in the purpose portion, at least 6 characters).
- [ ] The report references the correct save path `/opt/n8n/workflows` (from `config/n8n_server.json`), ties it to the server config as the authoritative deployment source, and does not present the conflicting `/var/lib/n8n/workflows` path as authoritative. Mentioning the conflicting path only to explain the discrepancy (e.g. vs `deployment_notes.yaml`) is acceptable.
- [ ] The Function node includes a `functionCode` parameter with robust validation logic: conditional checks + data access patterns + try-catch error handling for resilience.
- [ ] The standalone JSON file and the JSON embedded in the report are structurally identical (same node types, workflow name, connection keys, and settings keys).
- [ ] The workflow `settings` object includes `timezone` matching the server config ("UTC"), `saveManualExecutions`, `executionTimeout` matching the server's execution timeout (3600), and `saveDataOnError` / `saveDataOnSuccess` matching the server config's execution settings ("all").
- [ ] The report discusses issues with both example workflows: deprecated node types/parameter formats in v1, the missing Function node in v2, settings discrepancies (v1's `America/New_York` timezone vs server's `UTC`; execution data persistence settings), the dual-timezone ambiguity in the server config (`genericTimezone: "America/New_York"` vs `timezone: "UTC"`) and why `timezone` is the correct field, and identifies the server configuration as the authoritative source for deployment settings.
- [ ] The Function node's code validates both `testName` and `testTimestamp` fields, includes timestamp format validation (e.g., ISO 8601 parsing or regex), and returns results with both `status` and `message` fields.

## Automated Checks

```python
import os
import re
import json
from pathlib import Path


def grade(transcript: list, workspace_path: str) -> dict:
    result = {
        "report_exists": 0.0,
        "standalone_json_valid": 0.0,
        "correct_node_types": 0.0,
        "set_node_assignments": 0.0,
        "connections_wiring": 0.0,
        "workflow_name_convention": 0.0,
        "correct_save_path": 0.0,
        "function_node_has_code": 0.0,
        "json_consistency": 0.0,
        "has_settings": 0.0,
        "report_discusses_traps": 0.0,
        "function_code_validates_inputs": 0.0,
    }

    ws = Path(workspace_path)
    report_file = ws / "output" / "n8n_workflow_report.md"
    json_file = ws / "output" / "test_workflow.json"

    if not report_file.is_file():
        return result

    try:
        report_content = report_file.read_text(encoding="utf-8")
    except Exception:
        return result

    if len(report_content.strip()) < 50:
        return result

    result["report_exists"] = 1.0

    def extract_json_from_markdown(text):
        bt = chr(96) * 3
        pats = [bt + r'json\s*\n(.*?)' + bt, bt + r'\s*\n(\{.*?\})\s*\n' + bt]
        for pat in pats:
            for m in re.findall(pat, text, re.DOTALL):
                try:
                    obj = json.loads(m.strip())
                    if isinstance(obj, dict) and "nodes" in obj:
                        return obj
                except (json.JSONDecodeError, ValueError):
                    continue
        return None

    report_json = extract_json_from_markdown(report_content)

    standalone_json = None
    if json_file.is_file():
        try:
            raw = json.loads(json_file.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and "nodes" in raw:
                standalone_json = raw
                result["standalone_json_valid"] = 1.0
            elif isinstance(raw, dict):
                result["standalone_json_valid"] = 0.5
        except (json.JSONDecodeError, Exception):
            result["standalone_json_valid"] = 0.25

    wf = standalone_json or report_json

    if not wf or not isinstance(wf, dict):
        return result

    nodes = wf.get("nodes", [])
    if not isinstance(nodes, list):
        return result

    type_map = {}
    for n in nodes:
        if isinstance(n, dict):
            t = n.get("type", "")
            type_map[t] = n

    has_trigger = any("manualTrigger" in t for t in type_map)
    has_set = "n8n-nodes-base.set" in type_map
    has_function = ("n8n-nodes-base.function" in type_map
                    or "n8n-nodes-base.code" in type_map)
    has_deprecated = any("n8n-nodes-base.start" == t for t in type_map)

    correct_count = sum([has_trigger, has_set, has_function])
    set_node = type_map.get("n8n-nodes-base.set")
    set_version_ok = True
    if has_set and set_node:
        tv = set_node.get("typeVersion")
        if not (isinstance(tv, (int, float)) and tv >= 3):
            set_version_ok = False

    req_fields = {"name", "type", "typeVersion", "position", "parameters"}
    all_complete = all(
        isinstance(n, dict) and req_fields.issubset(set(n.keys()))
        for n in nodes
    )
    positions_ok = all(
        isinstance(n.get("position"), list)
        and len(n.get("position", [])) == 2
        and all(isinstance(c, (int, float)) for c in n.get("position", []))
        for n in nodes if isinstance(n, dict)
    )
    exact_three = len(nodes) == 3

    set_tv_exact = bool(set_node and set_node.get("typeVersion") == 3.4)
    uses_function_type = "n8n-nodes-base.function" in type_map
    fn_node_strict = type_map.get("n8n-nodes-base.function")
    fn_has_functionCode = bool(
        fn_node_strict
        and fn_node_strict.get("parameters", {}).get("functionCode"))

    trigger_node = None
    for t, n in type_map.items():
        if "manualTrigger" in t:
            trigger_node = n
            break
    trigger_tv_exact = bool(
        trigger_node and trigger_node.get("typeVersion") == 1)
    fn_tv_exact = bool(
        fn_node_strict and fn_node_strict.get("typeVersion") == 1)
    all_ref_versions = trigger_tv_exact and set_tv_exact and fn_tv_exact

    base_ok = (correct_count == 3 and not has_deprecated and set_version_ok
               and exact_three and all_complete and positions_ok)

    if (base_ok and set_tv_exact
            and uses_function_type and fn_has_functionCode
            and all_ref_versions):
        result["correct_node_types"] = 1.0
    elif base_ok:
        result["correct_node_types"] = 0.5
    elif correct_count == 3 and not has_deprecated and set_version_ok:
        result["correct_node_types"] = 0.25

    if set_node:
        params = set_node.get("parameters", {})
        assignments_obj = params.get("assignments", {})
        has_deprecated_values = "values" in params

        assign_list = []
        if isinstance(assignments_obj, dict):
            assign_list = assignments_obj.get("assignments", [])
        elif isinstance(assignments_obj, list):
            assign_list = assignments_obj

        field_map = {}
        all_have_id = True
        all_have_type = True
        all_type_string = True
        for a in assign_list:
            if isinstance(a, dict):
                field_map[a.get("name", "").lower()] = a.get("value", "")
                if not a.get("id"):
                    all_have_id = False
                if not a.get("type"):
                    all_have_type = False
                if a.get("type") != "string":
                    all_type_string = False

        has_tn = any("testname" in f for f in field_map)
        has_ts = any("testtimestamp" in f for f in field_map)

        ts_value = ""
        for k, v in field_map.items():
            if "testtimestamp" in k:
                ts_value = str(v)
        ts_iso = bool(re.match(
            r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}', ts_value))

        ts_utc = bool(re.search(r'(Z|\+00:?00)$', ts_value))

        tn_value = ""
        for k, v in field_map.items():
            if "testname" in k:
                tn_value = str(v)
        copied_names = {"legacy_smoke_test", "example_test", "sampletest"}
        tn_not_copied = (tn_value.lower().replace("_", "").replace(" ", "")
                         not in {n.replace("_", "") for n in copied_names})

        has_env = any("testenv" in f for f in field_map)
        env_value = ""
        for k, v in field_map.items():
            if "testenv" in k:
                env_value = str(v)

        ref_env = "staging"
        ref_ver = "1.52.0"
        try:
            dn_file = ws / "config" / "deployment_notes.yaml"
            if dn_file.is_file():
                for line in dn_file.read_text(
                        encoding="utf-8").splitlines():
                    if line.strip().startswith("environment:"):
                        ref_env = line.split(":", 1)[1].strip()
        except Exception:
            pass
        try:
            cfg_file = ws / "config" / "n8n_server.json"
            if cfg_file.is_file():
                cfg_d = json.loads(
                    cfg_file.read_text(encoding="utf-8"))
                ref_ver = cfg_d.get("version", ref_ver)
        except Exception:
            pass

        env_has_env = ref_env.lower() in env_value.lower()
        env_has_ver = ref_ver.split(".")[0] + "." \
            + ref_ver.split(".")[1] in env_value
        env_correct = has_env and env_has_env and env_has_ver

        basic_ok = (assign_list and has_tn and has_ts
                    and not has_deprecated_values)
        full_old = basic_ok and all_have_id and all_have_type and ts_iso

        if (full_old and all_type_string and ts_utc
                and tn_not_copied and env_correct):
            result["set_node_assignments"] = 1.0
        elif full_old and all_type_string and ts_utc and tn_not_copied:
            result["set_node_assignments"] = 0.5
        elif full_old:
            result["set_node_assignments"] = 0.25
        elif basic_ok:
            result["set_node_assignments"] = 0.1

    fn_node = type_map.get("n8n-nodes-base.function") or type_map.get(
        "n8n-nodes-base.code")
    code_str = ""
    if fn_node:
        code_str = fn_node.get("parameters", {}).get("functionCode", "")
        if not code_str:
            code_str = fn_node.get("parameters", {}).get("jsCode", "")
    if code_str:
        cond_pats = [r'\bif\s*\(', r'\?\s*[^:]+:', r'===', r'!==',
                     r'\bthrow\b', r'\bcatch\b']
        has_cond = any(re.search(p, code_str) for p in cond_pats)
        data_pats = [r'items\[', r'item\.json', r'\$input',
                     r'\$json', r'getNodeParameter']
        has_data = any(re.search(p, code_str) for p in data_pats)

        has_try_catch = bool(
            re.search(r'\btry\b', code_str)
            and re.search(r'\bcatch\b', code_str))

        if has_cond and has_data and has_try_catch:
            result["function_node_has_code"] = 1.0
        elif has_cond and has_data:
            result["function_node_has_code"] = 0.5
        elif has_cond or has_data:
            result["function_node_has_code"] = 0.25

    connections = wf.get("connections", {})
    if isinstance(connections, dict):
        node_name_to_type = {}
        for n in nodes:
            if isinstance(n, dict):
                node_name_to_type[n.get("name", "")] = n.get("type", "")

        trigger_name = set_name = function_name = None
        for name, ntype in node_name_to_type.items():
            if "manualTrigger" in ntype:
                trigger_name = name
            elif ntype == "n8n-nodes-base.set":
                set_name = name
            elif ntype in ("n8n-nodes-base.function", "n8n-nodes-base.code"):
                function_name = name

        def get_targets(conn_entry):
            try:
                return [t.get("node", "") for t in conn_entry["main"][0]]
            except (KeyError, IndexError, TypeError):
                return []

        def check_conn_fmt(conn_entry):
            try:
                for t in conn_entry["main"][0]:
                    if t.get("type") != "main":
                        return False
                    if "index" in t and t["index"] != 0:
                        return False
                return True
            except (KeyError, IndexError, TypeError):
                return False

        def check_port_strict(conn_entry):
            if not isinstance(conn_entry, dict):
                return False
            if set(conn_entry.keys()) != {"main"}:
                return False
            try:
                targets = conn_entry["main"][0]
                for t in targets:
                    if t.get("type") != "main":
                        return False
                    if t.get("index") != 0:
                        return False
                return True
            except (KeyError, IndexError, TypeError):
                return False

        t2s = (trigger_name and trigger_name in connections
               and set_name in get_targets(connections[trigger_name]))
        s2f = (set_name and set_name in connections
               and function_name in get_targets(connections[set_name]))

        fmt_ok = True
        if trigger_name and trigger_name in connections:
            if not check_conn_fmt(connections[trigger_name]):
                fmt_ok = False
        if set_name and set_name in connections:
            if not check_conn_fmt(connections[set_name]):
                fmt_ok = False

        port_strict_ok = True
        if trigger_name and trigger_name in connections:
            if not check_port_strict(connections[trigger_name]):
                port_strict_ok = False
        if set_name and set_name in connections:
            if not check_port_strict(connections[set_name]):
                port_strict_ok = False

        fn_is_terminal = function_name not in connections
        conn_keys = set(connections.keys())
        expected_keys = set()
        if trigger_name:
            expected_keys.add(trigger_name)
        if set_name:
            expected_keys.add(set_name)
        exact_conn_keys = conn_keys == expected_keys

        total_links = 0
        target_keys_strict = True
        single_target_per_port = True
        all_targets_exist = True
        all_node_names = {n.get("name", "")
                          for n in nodes if isinstance(n, dict)}

        for src, entry in connections.items():
            if not isinstance(entry, dict):
                continue
            try:
                main_arr = entry.get("main", [])
                if not isinstance(main_arr, list):
                    single_target_per_port = False
                    continue
                if len(main_arr) != 1:
                    single_target_per_port = False
                for port in main_arr:
                    if not isinstance(port, list):
                        continue
                    if len(port) != 1:
                        single_target_per_port = False
                    for tgt in port:
                        total_links += 1
                        if not isinstance(tgt, dict):
                            continue
                        if set(tgt.keys()) != {
                                "node", "type", "index"}:
                            target_keys_strict = False
                        if (tgt.get("node", "")
                                not in all_node_names):
                            all_targets_exist = False
            except (TypeError, AttributeError):
                pass

        ref_min_links = 2
        links_sufficient = total_links >= ref_min_links

        if (t2s and s2f and fmt_ok
                and fn_is_terminal and exact_conn_keys
                and port_strict_ok
                and target_keys_strict
                and single_target_per_port
                and all_targets_exist
                and links_sufficient):
            result["connections_wiring"] = 1.0
        elif (t2s and s2f and fmt_ok
              and fn_is_terminal and exact_conn_keys
              and port_strict_ok):
            result["connections_wiring"] = 0.5
        elif t2s and s2f and fmt_ok:
            result["connections_wiring"] = 0.25
        elif t2s or s2f:
            result["connections_wiring"] = 0.1

    wf_name = wf.get("name", "")
    purpose_m = re.match(r"Test_Workflow_([A-Z][a-zA-Z]+)$", wf_name)
    if purpose_m and len(purpose_m.group(1)) >= 6:
        result["workflow_name_convention"] = 1.0
    elif re.match(r"Test_Workflow_[A-Za-z]\w+$", wf_name):
        result["workflow_name_convention"] = 0.5
    elif re.search(r"Test_Workflow", wf_name, re.IGNORECASE):
        result["workflow_name_convention"] = 0.25

    correct_path = "/opt/n8n/workflows"
    try:
        cfg_file = ws / "config" / "n8n_server.json"
        if cfg_file.is_file():
            cfg = json.loads(cfg_file.read_text(encoding="utf-8"))
            correct_path = cfg.get("workflowsDir", correct_path)
    except Exception:
        pass

    report_lower = report_content.lower()
    has_correct = correct_path.lower() in report_content.lower()
    source_aware = any(kw in report_lower for kw in [
        "n8n_server.json", "server config", "server configuration",
        "ground truth", "authoritative", "服务器配置", "唯一真实来源"])

    if has_correct and source_aware:
        result["correct_save_path"] = 1.0
    elif has_correct:
        result["correct_save_path"] = 0.5

    settings = wf.get("settings")
    if isinstance(settings, dict) and settings:
        ref_tz = "UTC"
        ref_timeout = 3600
        ref_save_error = "all"
        ref_save_success = "all"
        try:
            cfg_file = ws / "config" / "n8n_server.json"
            if cfg_file.is_file():
                cfg = json.loads(cfg_file.read_text(encoding="utf-8"))
                ref_tz = cfg.get("timezone", "UTC")
                execs = cfg.get("executions", {})
                ref_timeout = execs.get("timeout", 3600)
                ref_save_error = execs.get("saveDataOnError", "all")
                ref_save_success = execs.get("saveDataOnSuccess", "all")
        except Exception:
            pass

        wf_tz = settings.get("timezone", "")
        has_save = settings.get("saveManualExecutions") is not None
        tz_ok = wf_tz == ref_tz
        timeout_ok = settings.get("executionTimeout") == ref_timeout
        save_error_ok = settings.get("saveDataOnError") == ref_save_error
        save_success_ok = (
            settings.get("saveDataOnSuccess") == ref_save_success)

        if (tz_ok and has_save and timeout_ok
                and save_error_ok and save_success_ok):
            result["has_settings"] = 1.0
        elif tz_ok and has_save and timeout_ok:
            result["has_settings"] = 0.5
        elif tz_ok or has_save:
            result["has_settings"] = 0.25

    if report_json and standalone_json:
        r_types = sorted(n.get("type", "") for n in report_json.get(
            "nodes", []) if isinstance(n, dict))
        s_types = sorted(n.get("type", "") for n in standalone_json.get(
            "nodes", []) if isinstance(n, dict))
        r_name = report_json.get("name", "")
        s_name = standalone_json.get("name", "")
        r_conns = sorted(report_json.get("connections", {}).keys())
        s_conns = sorted(standalone_json.get("connections", {}).keys())
        r_skeys = sorted(report_json.get("settings", {}).keys())
        s_skeys = sorted(standalone_json.get("settings", {}).keys())

        types_eq = r_types == s_types
        name_eq = r_name == s_name
        conns_eq = r_conns == s_conns
        skeys_eq = r_skeys == s_skeys

        ref_wf_dir = "/opt/n8n/workflows"
        try:
            cfg_p = ws / "config" / "n8n_server.json"
            if cfg_p.is_file():
                ref_wf_dir = json.loads(
                    cfg_p.read_text(encoding="utf-8")
                ).get("workflowsDir", ref_wf_dir)
        except Exception:
            pass
        r_wfdir = str(report_json.get("workflowsDir",
                       report_json.get("savePath", "")))
        s_wfdir = str(standalone_json.get("workflowsDir",
                       standalone_json.get("savePath", "")))
        wfdir_ok = (ref_wf_dir in r_wfdir or not r_wfdir) and (
            ref_wf_dir in s_wfdir or not s_wfdir)

        if (types_eq and name_eq and conns_eq
                and skeys_eq and wfdir_ok):
            result["json_consistency"] = 1.0
        elif types_eq and name_eq and conns_eq:
            result["json_consistency"] = 0.5
        elif types_eq:
            result["json_consistency"] = 0.25
    elif report_json or standalone_json:
        result["json_consistency"] = 0.0

    trap_deprecation = any(kw in report_lower for kw in [
        "deprecated", "deprecat", "legacy", "弃用", "旧版",
        "n8n-nodes-base.start", "parameters.values"])
    trap_path_conflict = any(kw in report_lower for kw in [
        "conflict", "contradict", "矛盾", "incorrect", "outdated",
        "deployment_notes"]) and has_correct
    trap_incomplete = any(kw in report_lower for kw in [
        "sample_workflow_v2", "partial_example", "partial example",
        "incomplete example", "missing function", "no function node",
        "不完整", "缺少function"])
    trap_settings_source = (
        "america/new_york" in report_lower
        or ("new_york" in report_lower and "timezone" in report_lower)
        or (any(kw in report_lower for kw in [
            "savedataon", "save_data_on", "savedata"])
            and any(kw in report_lower for kw in [
                "config", "server", "配置"])))
    trap_generic_tz = any(kw in report_lower for kw in [
        "generictimezone", "generic_timezone",
        "generic timezone", "generictz"])

    trap_save_path_conflict = (
        any(kw in report_lower for kw in [
            "/var/lib/n8n", "/opt/n8n/workflows",
            "workflow_save_path", "workflowsdir"])
        and any(kw in report_lower for kw in [
            "conflict", "contradict", "mismatch", "inconsisten",
            "differ", "discrepan", "两个", "不一致", "矛盾"]))

    trap_count = sum([trap_deprecation, trap_path_conflict,
                      trap_incomplete, trap_settings_source,
                      trap_generic_tz, trap_save_path_conflict])
    if trap_count >= 6:
        result["report_discusses_traps"] = 1.0
    elif trap_count >= 4:
        result["report_discusses_traps"] = 0.5
    elif trap_count >= 2:
        result["report_discusses_traps"] = 0.25

    if code_str:
        checks_tn = any(re.search(p, code_str, re.IGNORECASE) for p in [
            r'testname', r'testName'])
        checks_ts = any(re.search(p, code_str, re.IGNORECASE) for p in [
            r'testtimestamp', r'testTimestamp'])
        checks_both = checks_tn and checks_ts

        has_status = any(re.search(p, code_str) for p in [
            r'["\']status["\']', r'status\s*:'])
        has_message = any(re.search(p, code_str) for p in [
            r'["\']message["\']', r'message\s*:'])
        has_status_msg = has_status and has_message

        has_fmt_check = any(re.search(p, code_str, re.IGNORECASE) for p in [
            r'Date\.parse', r'new\s+Date\b', r'isNaN',
            r'\.match\s*\(', r'\.test\s*\(',
            r'RegExp', r'iso.?8601',
            r'invalid.*timestamp', r'timestamp.*format'])

        has_error_handling = any(re.search(p, code_str, re.IGNORECASE) for p in [
            r'try\s*\{', r'catch\s*\(', r'throw\s+new',
            r'error\s*\(', r'Error\s*\(',
            r'typeof\s+\w+\s*[!=]==?\s*["\']undefined',
            r'if\s*\(\s*!\s*\w+\s*\)',
        ])

        if checks_both and has_status_msg and has_fmt_check and has_error_handling:
            result["function_code_validates_inputs"] = 1.0
        elif checks_both and has_status_msg and has_fmt_check:
            result["function_code_validates_inputs"] = 0.5
        elif checks_both and (has_status_msg or has_fmt_check):
            result["function_code_validates_inputs"] = 0.25
        elif checks_both or has_status:
            result["function_code_validates_inputs"] = 0.1

    return result
```

## LLM Judge Rubric

> If any of the required output files (`output/n8n_workflow_report.md`, `output/test_workflow.json`) do not exist, score **0** on all dimensions below.

### Criterion 1: Summary Quality and Compatibility Analysis (Weight: 35%)

**Score 1.0**: Summary correctly explains the workflow's purpose (post-deployment health check), names all three node types and their roles, states the authoritative save path `/opt/n8n/workflows` with explicit reference to the server config as the source. Includes a compatibility section that identifies specific issues with **both** example workflows: deprecated `n8n-nodes-base.start` and `parameters.values` format in v1, the missing Function node in v2, and settings discrepancies (v1's timezone, execution data persistence settings). Discusses the `genericTimezone` vs `timezone` ambiguity in the server config and explains which field to use. Demonstrates cross-referencing of spec, node reference, server config, and deployment notes.
**Score 0.75**: Summary covers purpose, nodes, and correct save path, discusses issues with at least one example, but does not discuss the `genericTimezone` ambiguity or misses the v2 incompleteness issue.
**Score 0.5**: Summary is present and mentions the workflow purpose and some nodes, but is vague on details, misses the compatibility section, or contains minor inaccuracies.
**Score 0.25**: Minimal summary that is mostly generic boilerplate without task-specific details from the workspace documents.
**Score 0.0**: No summary, or summary is fundamentally incorrect (e.g., describes a completely different workflow purpose).

### Criterion 2: Trap Handling and Source Authority (Weight: 35%)

**Score 1.0**: Correctly resolves all traps — uses `n8n-nodes-base.manualTrigger` (not `start`), uses `parameters.assignments` with `id` and `type` fields per node reference (not `values`), references `/opt/n8n/workflows` from server config (not deployment notes), includes the Function node that v2 omitted, derives workflow settings (timezone, executionTimeout, saveDataOnError, saveDataOnSuccess) from the server configuration, discusses timezone discrepancy in v1, and explicitly addresses the `genericTimezone` vs `timezone` ambiguity in the server config. Set node includes `testEnv` derived from cross-file reasoning (deployment environment + server version). The report explicitly explains why each old example cannot be reused.
**Score 0.75**: Resolves the node type and parameter format traps correctly, uses the right save path, but has minor issues (e.g., doesn't discuss the `genericTimezone` field, missing `testEnv` variable, or doesn't discuss v2's incompleteness).
**Score 0.5**: Resolves one or two traps but falls for at least one (e.g., uses correct node types but wrong save path, or correct path but deprecated parameter format, or doesn't address both examples' issues, or misses the cross-file `testEnv` requirement).
**Score 0.25**: Falls for multiple traps — uses deprecated node types or parameter formats, or references the wrong save path as authoritative.
**Score 0.0**: Falls for all traps or produces output that copies directly from a legacy example without any adaptation.

### Criterion 3: Workflow JSON Completeness and Import Readiness (Weight: 30%)

**Score 1.0**: Both the report's inline JSON and the standalone JSON file are valid n8n format that could be directly imported and are structurally identical. JSON includes all required top-level fields (`name`, `nodes`, `connections`, `settings`). Exactly three nodes, each with `name`, `type`, `typeVersion`, `position`, and `parameters`. Workflow name follows strict PascalCase convention. Set node defines `testName` (original value), `testTimestamp` (ISO 8601 with UTC indicator), and `testEnv` (cross-file value combining environment and version) via assignments with `id`/`type` (`"string"`) fields. Function node uses `n8n-nodes-base.function` type with `functionCode`, contains try-catch error handling and validation logic checking field presence and format, returning `{status, message}`. Connections have exactly two source keys with Function as terminal node, each target entry has exactly three fields (`node`, `type`, `index`), all targets reference existing nodes, linear chain with at least 2 links. Settings include `timezone: "UTC"`, `saveManualExecutions`, `executionTimeout: 3600`, `saveDataOnError: "all"`, and `saveDataOnSuccess: "all"` — all matching server config.
**Score 0.75**: JSON is mostly correct and import-ready, but has minor issues (e.g., missing `testEnv` variable, missing `id`/`type` in assignments, trivial Function code without format validation, settings partially derived from server config, or slight inconsistency between the two outputs).
**Score 0.5**: JSON has the right overall structure but is missing important elements (e.g., no `testEnv`, no format validation in Function code, missing required node fields like position, extra unnecessary nodes, or connections don't properly chain all three nodes).
**Score 0.25**: JSON present but with significant structural issues that would prevent import (malformed connections, wrong field names, missing nodes array, nodes missing typeVersion).
**Score 0.0**: No JSON present, or JSON is invalid / unparseable.
