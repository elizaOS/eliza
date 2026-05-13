---
id: task_00029_openclaw_runtime_diagnostics_skill_and_health_audit
name: OpenClaw Runtime Diagnostics Skill and Health Audit
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
- source: .openclaw/config/gateway.yaml
  dest: .openclaw/config/gateway.yaml
- source: .openclaw/logs/gateway.log
  dest: .openclaw/logs/gateway.log
- source: .openclaw/logs/gateway.log.1
  dest: .openclaw/logs/gateway.log.1
- source: .openclaw/state/active-sessions.json
  dest: .openclaw/state/active-sessions.json
- source: .openclaw/state/gateway.pid
  dest: .openclaw/state/gateway.pid
- source: .openclaw/state/process.json
  dest: .openclaw/state/process.json
- source: scripts/gateway-manager.sh
  dest: scripts/gateway-manager.sh
- source: sessions/20260203_discord_4471054.jsonl
  dest: sessions/20260203_discord_4471054.jsonl
- source: sessions/20260203_discord_6721426.jsonl
  dest: sessions/20260203_discord_6721426.jsonl
- source: sessions/20260203_feishu_6128898.jsonl
  dest: sessions/20260203_feishu_6128898.jsonl
- source: sessions/20260203_heartbeat_8861924.jsonl
  dest: sessions/20260203_heartbeat_8861924.jsonl
- source: sessions/20260204_heartbeat_2768185.jsonl
  dest: sessions/20260204_heartbeat_2768185.jsonl
- source: sessions/20260204_heartbeat_7711301.jsonl
  dest: sessions/20260204_heartbeat_7711301.jsonl
- source: sessions/20260204_isolated_5495544.jsonl
  dest: sessions/20260204_isolated_5495544.jsonl
- source: sessions/20260204_main_1803372.jsonl
  dest: sessions/20260204_main_1803372.jsonl
- source: sessions/20260204_main_3456408.jsonl
  dest: sessions/20260204_main_3456408.jsonl
- source: sessions/20260204_subagent_8774559.jsonl
  dest: sessions/20260204_subagent_8774559.jsonl
- source: sessions/20260205_cron_9408514.jsonl
  dest: sessions/20260205_cron_9408514.jsonl
- source: sessions/20260205_discord_6970904.jsonl
  dest: sessions/20260205_discord_6970904.jsonl
- source: sessions/20260205_feishu_1326187.jsonl
  dest: sessions/20260205_feishu_1326187.jsonl
- source: sessions/20260205_feishu_3153959.jsonl
  dest: sessions/20260205_feishu_3153959.jsonl
- source: sessions/20260205_main_2981915.jsonl
  dest: sessions/20260205_main_2981915.jsonl
- source: sessions/20260206_heartbeat_5458596.jsonl
  dest: sessions/20260206_heartbeat_5458596.jsonl
- source: sessions/20260207_discord_1115416.jsonl
  dest: sessions/20260207_discord_1115416.jsonl
- source: sessions/20260207_discord_7338175.jsonl
  dest: sessions/20260207_discord_7338175.jsonl
- source: sessions/20260207_main_2736283.jsonl
  dest: sessions/20260207_main_2736283.jsonl
- source: sessions/20260207_subagent_2628112.jsonl
  dest: sessions/20260207_subagent_2628112.jsonl
- source: sessions/20260207_telegram_7660548.jsonl
  dest: sessions/20260207_telegram_7660548.jsonl
- source: sessions/20260208_discord_3086090.jsonl
  dest: sessions/20260208_discord_3086090.jsonl
- source: sessions/20260209_cron_4812840.jsonl
  dest: sessions/20260209_cron_4812840.jsonl
- source: sessions/20260209_discord_3620012.jsonl
  dest: sessions/20260209_discord_3620012.jsonl
- source: sessions/20260209_discord_6514892.jsonl
  dest: sessions/20260209_discord_6514892.jsonl
- source: sessions/20260209_feishu_8638416.jsonl
  dest: sessions/20260209_feishu_8638416.jsonl
- source: sessions/20260209_subagent_9683399.jsonl
  dest: sessions/20260209_subagent_9683399.jsonl
- source: sessions/20260210_discord_8203827.jsonl
  dest: sessions/20260210_discord_8203827.jsonl
- source: sessions/20260210_isolated_5357892.jsonl
  dest: sessions/20260210_isolated_5357892.jsonl
- source: sessions/20260210_main_3353328.jsonl
  dest: sessions/20260210_main_3353328.jsonl
- source: sessions/20260210_subagent_5303439.jsonl
  dest: sessions/20260210_subagent_5303439.jsonl
- source: sessions/20260210_subagent_8184527.jsonl
  dest: sessions/20260210_subagent_8184527.jsonl
- source: sessions/20260210_telegram_2860307.jsonl
  dest: sessions/20260210_telegram_2860307.jsonl
- source: sessions/20260211_cron_2960776.jsonl
  dest: sessions/20260211_cron_2960776.jsonl
- source: sessions/20260211_feishu_3915303.jsonl
  dest: sessions/20260211_feishu_3915303.jsonl
- source: sessions/20260211_isolated_3714494.jsonl
  dest: sessions/20260211_isolated_3714494.jsonl
- source: sessions/20260211_main_3378309.jsonl
  dest: sessions/20260211_main_3378309.jsonl
- source: sessions/20260211_telegram_1795748.jsonl
  dest: sessions/20260211_telegram_1795748.jsonl
- source: sessions/20260212_discord_3104496.jsonl
  dest: sessions/20260212_discord_3104496.jsonl
- source: sessions/20260212_main_5365611.jsonl
  dest: sessions/20260212_main_5365611.jsonl
- source: sessions/20260213_heartbeat_4759635.jsonl
  dest: sessions/20260213_heartbeat_4759635.jsonl
- source: sessions/20260213_isolated_2853794.jsonl
  dest: sessions/20260213_isolated_2853794.jsonl
- source: sessions/20260214_cron_1664622.jsonl
  dest: sessions/20260214_cron_1664622.jsonl
- source: sessions/20260214_feishu_2480018.jsonl
  dest: sessions/20260214_feishu_2480018.jsonl
- source: sessions/20260214_main_6798606.jsonl
  dest: sessions/20260214_main_6798606.jsonl
- source: sessions/20260214_main_7271444.jsonl
  dest: sessions/20260214_main_7271444.jsonl
- source: sessions/20260214_subagent_3366001.jsonl
  dest: sessions/20260214_subagent_3366001.jsonl
- source: sessions/20260215_feishu_2718777.jsonl
  dest: sessions/20260215_feishu_2718777.jsonl
- source: sessions/20260215_feishu_5452819.jsonl
  dest: sessions/20260215_feishu_5452819.jsonl
- source: sessions/20260215_subagent_1037160.jsonl
  dest: sessions/20260215_subagent_1037160.jsonl
- source: sessions/20260216_cron_2039292.jsonl
  dest: sessions/20260216_cron_2039292.jsonl
- source: sessions/20260216_discord_6138620.jsonl
  dest: sessions/20260216_discord_6138620.jsonl
- source: sessions/20260216_heartbeat_3333409.jsonl
  dest: sessions/20260216_heartbeat_3333409.jsonl
- source: sessions/20260216_isolated_3717915.jsonl
  dest: sessions/20260216_isolated_3717915.jsonl
- source: sessions/20260216_isolated_6343675.jsonl
  dest: sessions/20260216_isolated_6343675.jsonl
- source: sessions/20260216_isolated_8834042.jsonl
  dest: sessions/20260216_isolated_8834042.jsonl
- source: sessions/20260217_discord_7560274.jsonl
  dest: sessions/20260217_discord_7560274.jsonl
- source: sessions/20260217_discord_9276836.jsonl
  dest: sessions/20260217_discord_9276836.jsonl
- source: sessions/20260218_discord_5384609.jsonl
  dest: sessions/20260218_discord_5384609.jsonl
- source: sessions/20260218_heartbeat_5638210.jsonl
  dest: sessions/20260218_heartbeat_5638210.jsonl
- source: sessions/20260218_telegram_8259498.jsonl
  dest: sessions/20260218_telegram_8259498.jsonl
- source: sessions/20260219_cron_1058105.jsonl
  dest: sessions/20260219_cron_1058105.jsonl
- source: sessions/20260219_cron_6783788.jsonl
  dest: sessions/20260219_cron_6783788.jsonl
- source: sessions/20260219_discord_4657439.jsonl
  dest: sessions/20260219_discord_4657439.jsonl
- source: sessions/20260219_telegram_6073488.jsonl
  dest: sessions/20260219_telegram_6073488.jsonl
- source: sessions/20260219_telegram_6848086.jsonl
  dest: sessions/20260219_telegram_6848086.jsonl
- source: sessions/20260220_cron_2897985.jsonl
  dest: sessions/20260220_cron_2897985.jsonl
- source: sessions/20260220_discord_9990056.jsonl
  dest: sessions/20260220_discord_9990056.jsonl
- source: sessions/20260220_feishu_6730633.jsonl
  dest: sessions/20260220_feishu_6730633.jsonl
- source: sessions/20260220_feishu_9048275.jsonl
  dest: sessions/20260220_feishu_9048275.jsonl
- source: sessions/20260220_subagent_6179661.jsonl
  dest: sessions/20260220_subagent_6179661.jsonl
- source: sessions/20260221_cron_1328258.jsonl
  dest: sessions/20260221_cron_1328258.jsonl
- source: sessions/20260221_cron_9709924.jsonl
  dest: sessions/20260221_cron_9709924.jsonl
- source: sessions/20260222_heartbeat_3081239.jsonl
  dest: sessions/20260222_heartbeat_3081239.jsonl
- source: sessions/20260222_isolated_3044592.jsonl
  dest: sessions/20260222_isolated_3044592.jsonl
- source: sessions/20260222_isolated_8899555.jsonl
  dest: sessions/20260222_isolated_8899555.jsonl
- source: sessions/20260222_isolated_9409353.jsonl
  dest: sessions/20260222_isolated_9409353.jsonl
- source: sessions/20260222_telegram_6420869.jsonl
  dest: sessions/20260222_telegram_6420869.jsonl
- source: sessions/20260223_heartbeat_1086281.jsonl
  dest: sessions/20260223_heartbeat_1086281.jsonl
- source: sessions/20260223_telegram_7975395.jsonl
  dest: sessions/20260223_telegram_7975395.jsonl
- source: sessions/20260224_discord_1398626.jsonl
  dest: sessions/20260224_discord_1398626.jsonl
- source: sessions/20260224_discord_9855469.jsonl
  dest: sessions/20260224_discord_9855469.jsonl
- source: sessions/20260224_isolated_3699362.jsonl
  dest: sessions/20260224_isolated_3699362.jsonl
- source: sessions/20260224_isolated_8151197.jsonl
  dest: sessions/20260224_isolated_8151197.jsonl
- source: sessions/20260224_isolated_9195948.jsonl
  dest: sessions/20260224_isolated_9195948.jsonl
- source: sessions/20260224_subagent_1982022.jsonl
  dest: sessions/20260224_subagent_1982022.jsonl
- source: sessions/20260224_telegram_7680742.jsonl
  dest: sessions/20260224_telegram_7680742.jsonl
- source: sessions/20260225_discord_8489021.jsonl
  dest: sessions/20260225_discord_8489021.jsonl
- source: sessions/20260225_feishu_2381803.jsonl
  dest: sessions/20260225_feishu_2381803.jsonl
- source: sessions/20260225_feishu_9441432.jsonl
  dest: sessions/20260225_feishu_9441432.jsonl
- source: sessions/20260225_subagent_3787091.jsonl
  dest: sessions/20260225_subagent_3787091.jsonl
- source: sessions/20260225_telegram_5938205.jsonl
  dest: sessions/20260225_telegram_5938205.jsonl
- source: sessions/20260226_discord_8920444.jsonl
  dest: sessions/20260226_discord_8920444.jsonl
- source: sessions/20260226_heartbeat_2762110.jsonl
  dest: sessions/20260226_heartbeat_2762110.jsonl
- source: sessions/20260226_main_7755246.jsonl
  dest: sessions/20260226_main_7755246.jsonl
- source: sessions/20260226_subagent_2702295.jsonl
  dest: sessions/20260226_subagent_2702295.jsonl
- source: sessions/20260226_telegram_1251174.jsonl
  dest: sessions/20260226_telegram_1251174.jsonl
- source: sessions/20260227_discord_4208697.jsonl
  dest: sessions/20260227_discord_4208697.jsonl
- source: sessions/20260227_isolated_5359846.jsonl
  dest: sessions/20260227_isolated_5359846.jsonl
- source: sessions/20260227_isolated_8399539.jsonl
  dest: sessions/20260227_isolated_8399539.jsonl
- source: sessions/20260227_subagent_9004097.jsonl
  dest: sessions/20260227_subagent_9004097.jsonl
- source: sessions/20260227_telegram_1111238.jsonl
  dest: sessions/20260227_telegram_1111238.jsonl
- source: sessions/20260227_telegram_1672727.jsonl
  dest: sessions/20260227_telegram_1672727.jsonl
- source: sessions/20260227_telegram_9882435.jsonl
  dest: sessions/20260227_telegram_9882435.jsonl
- source: sessions/20260228_heartbeat_3866179.jsonl
  dest: sessions/20260228_heartbeat_3866179.jsonl
- source: sessions/20260228_telegram_6942519.jsonl
  dest: sessions/20260228_telegram_6942519.jsonl
- source: sessions/20260301_cron_6821917.jsonl
  dest: sessions/20260301_cron_6821917.jsonl
- source: sessions/20260301_discord_6607414.jsonl
  dest: sessions/20260301_discord_6607414.jsonl
- source: sessions/20260301_telegram_1975695.jsonl
  dest: sessions/20260301_telegram_1975695.jsonl
- source: sessions/20260302_feishu_1089490.jsonl
  dest: sessions/20260302_feishu_1089490.jsonl
- source: sessions/20260302_feishu_3499428.jsonl
  dest: sessions/20260302_feishu_3499428.jsonl
- source: sessions/20260302_heartbeat_3910550.jsonl
  dest: sessions/20260302_heartbeat_3910550.jsonl
- source: sessions/20260302_heartbeat_4160621.jsonl
  dest: sessions/20260302_heartbeat_4160621.jsonl
- source: sessions/20260302_isolated_8732614.jsonl
  dest: sessions/20260302_isolated_8732614.jsonl
- source: sessions/20260303_discord_6145047.jsonl
  dest: sessions/20260303_discord_6145047.jsonl
- source: sessions/20260303_feishu_3933094.jsonl
  dest: sessions/20260303_feishu_3933094.jsonl
- source: sessions/20260303_isolated_3277217.jsonl
  dest: sessions/20260303_isolated_3277217.jsonl
- source: sessions/20260303_isolated_4096992.jsonl
  dest: sessions/20260303_isolated_4096992.jsonl
- source: sessions/20260303_isolated_7781560.jsonl
  dest: sessions/20260303_isolated_7781560.jsonl
- source: sessions/20260303_main_5013575.jsonl
  dest: sessions/20260303_main_5013575.jsonl
- source: sessions/20260303_telegram_6389420.jsonl
  dest: sessions/20260303_telegram_6389420.jsonl
- source: sessions/20260304_cron_1607654.jsonl
  dest: sessions/20260304_cron_1607654.jsonl
- source: sessions/20260304_cron_8462823.jsonl
  dest: sessions/20260304_cron_8462823.jsonl
- source: sessions/20260304_heartbeat_1712735.jsonl
  dest: sessions/20260304_heartbeat_1712735.jsonl
- source: sessions/20260304_heartbeat_4446867.jsonl
  dest: sessions/20260304_heartbeat_4446867.jsonl
- source: sessions/20260304_heartbeat_4715304.jsonl
  dest: sessions/20260304_heartbeat_4715304.jsonl
- source: sessions/20260304_subagent_4722793.jsonl
  dest: sessions/20260304_subagent_4722793.jsonl
- source: sessions/20260304_subagent_6110793.jsonl
  dest: sessions/20260304_subagent_6110793.jsonl
- source: sessions/20260305_cron_3187254.jsonl
  dest: sessions/20260305_cron_3187254.jsonl
- source: sessions/20260305_cron_5935406.jsonl
  dest: sessions/20260305_cron_5935406.jsonl
- source: sessions/20260305_discord_7767755.jsonl
  dest: sessions/20260305_discord_7767755.jsonl
- source: sessions/20260305_heartbeat_8432676.jsonl
  dest: sessions/20260305_heartbeat_8432676.jsonl
- source: sessions/20260305_main_4786140.jsonl
  dest: sessions/20260305_main_4786140.jsonl
- source: sessions/20260306_discord_4668492.jsonl
  dest: sessions/20260306_discord_4668492.jsonl
- source: sessions/20260306_subagent_4232345.jsonl
  dest: sessions/20260306_subagent_4232345.jsonl
- source: sessions/20260306_telegram_6745192.jsonl
  dest: sessions/20260306_telegram_6745192.jsonl
- source: sessions/20260307_telegram_4197939.jsonl
  dest: sessions/20260307_telegram_4197939.jsonl
- source: sessions/20260308_cron_8269739.jsonl
  dest: sessions/20260308_cron_8269739.jsonl
- source: sessions/20260308_discord_1983006.jsonl
  dest: sessions/20260308_discord_1983006.jsonl
- source: sessions/20260308_discord_3461062.jsonl
  dest: sessions/20260308_discord_3461062.jsonl
- source: sessions/20260308_discord_7721916.jsonl
  dest: sessions/20260308_discord_7721916.jsonl
- source: sessions/20260308_feishu_2816533.jsonl
  dest: sessions/20260308_feishu_2816533.jsonl
- source: sessions/20260308_feishu_5517943.jsonl
  dest: sessions/20260308_feishu_5517943.jsonl
- source: sessions/20260308_heartbeat_7152800.jsonl
  dest: sessions/20260308_heartbeat_7152800.jsonl
- source: sessions/20260308_main_4364880.jsonl
  dest: sessions/20260308_main_4364880.jsonl
- source: sessions/20260309_cron_3732534.jsonl
  dest: sessions/20260309_cron_3732534.jsonl
- source: sessions/20260309_discord_2970178.jsonl
  dest: sessions/20260309_discord_2970178.jsonl
- source: sessions/20260310_cron_4473929.jsonl
  dest: sessions/20260310_cron_4473929.jsonl
- source: sessions/20260310_discord_6537760.jsonl
  dest: sessions/20260310_discord_6537760.jsonl
- source: sessions/20260310_heartbeat_2224890.jsonl
  dest: sessions/20260310_heartbeat_2224890.jsonl
- source: sessions/20260310_telegram_8834783.jsonl
  dest: sessions/20260310_telegram_8834783.jsonl
- source: sessions/20260311_heartbeat_9982372.jsonl
  dest: sessions/20260311_heartbeat_9982372.jsonl
- source: sessions/20260311_isolated_2302035.jsonl
  dest: sessions/20260311_isolated_2302035.jsonl
- source: sessions/20260311_main_2068859.jsonl
  dest: sessions/20260311_main_2068859.jsonl
- source: sessions/20260312_cron_4104036.jsonl
  dest: sessions/20260312_cron_4104036.jsonl
- source: sessions/20260312_cron_8347741.jsonl
  dest: sessions/20260312_cron_8347741.jsonl
- source: sessions/20260312_heartbeat_9856373.jsonl
  dest: sessions/20260312_heartbeat_9856373.jsonl
- source: sessions/20260312_subagent_1799017.jsonl
  dest: sessions/20260312_subagent_1799017.jsonl
- source: sessions/20260312_telegram_4101041.jsonl
  dest: sessions/20260312_telegram_4101041.jsonl
- source: sessions/20260313_main_2345442.jsonl
  dest: sessions/20260313_main_2345442.jsonl
- source: sessions/20260313_main_4870073.jsonl
  dest: sessions/20260313_main_4870073.jsonl
- source: sessions/20260313_main_9294510.jsonl
  dest: sessions/20260313_main_9294510.jsonl
- source: sessions/20260314_cron_4155895.jsonl
  dest: sessions/20260314_cron_4155895.jsonl
- source: sessions/20260314_discord_4903660.jsonl
  dest: sessions/20260314_discord_4903660.jsonl
- source: sessions/20260314_heartbeat_6213993.jsonl
  dest: sessions/20260314_heartbeat_6213993.jsonl
- source: sessions/20260314_isolated_7360389.jsonl
  dest: sessions/20260314_isolated_7360389.jsonl
- source: sessions/20260314_subagent_5351250.jsonl
  dest: sessions/20260314_subagent_5351250.jsonl
- source: sessions/20260314_telegram_9450756.jsonl
  dest: sessions/20260314_telegram_9450756.jsonl
- source: sessions/20260315_cron_1308576.jsonl
  dest: sessions/20260315_cron_1308576.jsonl
- source: sessions/20260315_cron_5955590.jsonl
  dest: sessions/20260315_cron_5955590.jsonl
- source: sessions/20260315_isolated_6986959.jsonl
  dest: sessions/20260315_isolated_6986959.jsonl
- source: sessions/20260315_telegram_6725338.jsonl
  dest: sessions/20260315_telegram_6725338.jsonl
- source: sessions/20260316_cron_2550272.jsonl
  dest: sessions/20260316_cron_2550272.jsonl
- source: sessions/20260317_heartbeat_9628703.jsonl
  dest: sessions/20260317_heartbeat_9628703.jsonl
- source: sessions/20260317_subagent_2020341.jsonl
  dest: sessions/20260317_subagent_2020341.jsonl
- source: sessions/20260318_subagent_9664541.jsonl
  dest: sessions/20260318_subagent_9664541.jsonl
- source: sessions/20260318_telegram_5430804.jsonl
  dest: sessions/20260318_telegram_5430804.jsonl
- source: sessions/20260319_feishu_2760303.jsonl
  dest: sessions/20260319_feishu_2760303.jsonl
- source: sessions/20260319_feishu_3401467.jsonl
  dest: sessions/20260319_feishu_3401467.jsonl
- source: sessions/20260319_isolated_5660027.jsonl
  dest: sessions/20260319_isolated_5660027.jsonl
- source: sessions/20260319_main_1362971.jsonl
  dest: sessions/20260319_main_1362971.jsonl
- source: sessions/20260319_telegram_2585148.jsonl
  dest: sessions/20260319_telegram_2585148.jsonl
- source: sessions/20260319_telegram_7544283.jsonl
  dest: sessions/20260319_telegram_7544283.jsonl
- source: sessions/20260320_feishu_5886971.jsonl
  dest: sessions/20260320_feishu_5886971.jsonl
- source: sessions/20260320_heartbeat_3518860.jsonl
  dest: sessions/20260320_heartbeat_3518860.jsonl
- source: sessions/20260320_subagent_7660011.jsonl
  dest: sessions/20260320_subagent_7660011.jsonl
- source: sessions/20260320_telegram_4420419.jsonl
  dest: sessions/20260320_telegram_4420419.jsonl
---

## Prompt

The OpenClaw gateway has been accumulating session files for a while, and I've started seeing memory warnings in the logs. Before I do any cleanup or consider a restart, I want a proper health snapshot.

First, create a reusable skill at `workspace/skills/runtime-diagnostics/SKILL.md` that documents a repeatable OpenClaw runtime health audit procedure. The skill should describe: which state files to read (and in what order), how to cross-validate PID and active-session-count across multiple sources, how to parse `gateway.log` for memory and session warnings, how to inventory the `sessions/` directory by session type (the filename format is `YYYYMMDD_TYPE_ID.jsonl`), and how to compute a health score using this exact formula:

```
health_score = 100 - (memory_warn_count * 1) - (state_inconsistency_count * 15) - (oversized_session_warn_count * 1)
```

where `memory_warn_count` is the number of `WARN  memory` lines in `gateway.log`, `state_inconsistency_count` is the total number of cross-file inconsistencies found, and `oversized_session_warn_count` is the number of `WARN  session: Session file growing` lines in `gateway.log`.

Then actually run the audit following that skill. Specifically, you must:

1. Read `.openclaw/state/process.json`, `.openclaw/state/gateway.pid`, and `.openclaw/state/active-sessions.json`, cross-validate the PID and active session count across these files, and flag any discrepancies.
2. Parse `.openclaw/logs/gateway.log` (not gateway.log.1) to count `WARN  memory` events and `WARN  session: Session file growing` events.
3. Count all `.jsonl` files in `sessions/` and break down the count by session type extracted from the filename.
4. Compute the health score using the formula above.
5. Write the results to two files:
   - `runtime-audit.json` — a machine-readable JSON with these exact top-level keys: `gateway_pid`, `pid_in_pidfile`, `pid_consistent`, `version`, `uptime`, `memory_current_mb`, `memory_warn_count`, `memory_max_mb`, `active_session_count_process_json`, `active_session_count_in_file`, `session_count_consistent`, `total_session_files`, `session_count_by_type`, `oversized_session_warn_count`, `state_inconsistency_count`, `state_inconsistencies`, `health_score`, `recovery_command`
   - `runtime-audit.md` — a human-readable report summarizing the findings with a dedicated section for inconsistencies and a recovery procedure.

## Expected Behavior

The agent should:

1. Create `workspace/skills/runtime-diagnostics/SKILL.md` with valid YAML frontmatter (including `name` and `description`), and sections covering the full audit procedure described in the prompt: state file reading order, cross-validation logic, log parsing, session inventory, health score formula.

2. Read `.openclaw/state/process.json` and note pid=28417, version=2026.2.6-3, uptime="2d 5h 1m", memory=387.2MB, activeSessionCount=3.

3. Read `.openclaw/state/gateway.pid` and note PID=28419 — this does NOT match process.json (28417 vs 28419), which is a state inconsistency.

4. Read `.openclaw/state/active-sessions.json` and count 4 entries in the `activeSessions` array — this does NOT match activeSessionCount=3 in process.json, which is a second state inconsistency. Therefore state_inconsistency_count=2.

5. Parse `.openclaw/logs/gateway.log` and count exactly 14 lines matching `WARN  memory`, with max memory value being 473MB. Count exactly 10 lines matching `WARN  session: Session file growing`.

6. Count 187 `.jsonl` files in `sessions/` and break down as: discord=31, telegram=27, heartbeat=24, cron=24, isolated=23, subagent=20, feishu=20, main=18.

7. Compute health_score = 100 - 14 - (2 * 15) - 10 = 46.

8. Write `runtime-audit.json` with the following correct values:
   - `gateway_pid`: 28417
   - `pid_in_pidfile`: 28419
   - `pid_consistent`: false
   - `version`: "2026.2.6-3"
   - `uptime`: "2d 5h 1m"
   - `memory_current_mb`: 387.2
   - `memory_warn_count`: 14
   - `memory_max_mb`: 473
   - `active_session_count_process_json`: 3
   - `active_session_count_in_file`: 4
   - `session_count_consistent`: false
   - `total_session_files`: 187
   - `session_count_by_type`: {"discord": 31, "telegram": 27, "heartbeat": 24, "cron": 24, "isolated": 23, "subagent": 20, "feishu": 20, "main": 18}
   - `oversized_session_warn_count`: 10
   - `state_inconsistency_count`: 2
   - `state_inconsistencies`: list containing descriptions of the PID mismatch and session count mismatch
   - `health_score`: 46
   - `recovery_command`: the correct command from `scripts/gateway-manager.sh` (e.g., `bash scripts/gateway-manager.sh restart`)

9. Write `runtime-audit.md` with sections covering: process info, state consistency issues (must call out both the PID mismatch and session count mismatch explicitly), memory analysis, session inventory table, health score with formula breakdown, and recovery procedure referencing `scripts/gateway-manager.sh`.

## Grading Criteria

- [ ] `workspace/skills/runtime-diagnostics/SKILL.md` exists with valid YAML frontmatter (name, description)
- [ ] SKILL.md describes the cross-validation logic and health score formula
- [ ] `runtime-audit.json` exists and is valid JSON
- [ ] `runtime-audit.json` contains correct gateway_pid (28417) and pid_in_pidfile (28419) with pid_consistent=false
- [ ] `runtime-audit.json` contains correct active_session_count_process_json=3 and active_session_count_in_file=4 with session_count_consistent=false
- [ ] `runtime-audit.json` contains correct memory_warn_count=14 and memory_max_mb=473
- [ ] `runtime-audit.json` contains correct total_session_files=187 and session_count_by_type with all 8 types correct
- [ ] `runtime-audit.json` contains correct oversized_session_warn_count=10
- [ ] `runtime-audit.json` contains correct health_score=46
- [ ] `runtime-audit.md` exists and explicitly flags both state inconsistencies with correct details
- [ ] `runtime-audit.md` includes a recovery procedure referencing scripts/gateway-manager.sh

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import re
    import json

    scores = {
        "skill_md_exists_and_structured": 0.0,
        "audit_json_exists_and_valid": 0.0,
        "pid_cross_validation_correct": 0.0,
        "session_count_cross_validation_correct": 0.0,
        "log_parsing_correct": 0.0,
        "session_inventory_correct": 0.0,
        "health_score_correct": 0.0,
        "audit_md_completeness": 0.0,
    }

    # Check SKILL.md
    skill_path = os.path.join(workspace_path, "skills", "runtime-diagnostics", "SKILL.md")
    if os.path.isfile(skill_path):
        try:
            with open(skill_path, "r", encoding="utf-8") as f:
                skill_content = f.read()
            has_frontmatter = skill_content.strip().startswith("---")
            has_name = bool(re.search(r"(?i)name\s*:", skill_content))
            has_description = bool(re.search(r"(?i)description\s*:", skill_content))
            has_formula = bool(re.search(r"health_score", skill_content, re.IGNORECASE))
            has_sections = len(re.findall(r"^#{1,3}\s+\S", skill_content, re.MULTILINE)) >= 2
            if has_frontmatter and has_name and has_description:
                base = 0.5
                if has_sections:
                    base += 0.25
                if has_formula:
                    base += 0.25
                scores["skill_md_exists_and_structured"] = base
            elif has_name or has_description:
                scores["skill_md_exists_and_structured"] = 0.2
        except Exception:
            scores["skill_md_exists_and_structured"] = 0.0

    if not os.path.isfile(skill_path):
        return scores

    # Check runtime-audit.json
    audit_json_path = os.path.join(workspace_path, "runtime-audit.json")
    audit_data = None
    if os.path.isfile(audit_json_path):
        try:
            with open(audit_json_path, "r", encoding="utf-8") as f:
                audit_data = json.load(f)
            required_keys = [
                "gateway_pid", "pid_in_pidfile", "pid_consistent",
                "version", "uptime", "memory_current_mb", "memory_warn_count",
                "memory_max_mb", "active_session_count_process_json",
                "active_session_count_in_file", "session_count_consistent",
                "total_session_files", "session_count_by_type",
                "oversized_session_warn_count", "state_inconsistency_count",
                "state_inconsistencies", "health_score", "recovery_command"
            ]
            present = sum(1 for k in required_keys if k in audit_data)
            scores["audit_json_exists_and_valid"] = round(present / len(required_keys), 2)
        except Exception:
            scores["audit_json_exists_and_valid"] = 0.1
    else:
        return scores

    if audit_data is None:
        return scores

    # Check PID cross-validation
    pid_ok = audit_data.get("gateway_pid") == 28417
    pid_file_ok = audit_data.get("pid_in_pidfile") == 28419
    pid_consistent_ok = audit_data.get("pid_consistent") is False
    if pid_ok and pid_file_ok and pid_consistent_ok:
        scores["pid_cross_validation_correct"] = 1.0
    elif pid_ok and pid_file_ok:
        scores["pid_cross_validation_correct"] = 0.75
    elif pid_ok or pid_file_ok:
        scores["pid_cross_validation_correct"] = 0.4

    # Check session count cross-validation
    sess_proc_ok = audit_data.get("active_session_count_process_json") == 3
    sess_file_ok = audit_data.get("active_session_count_in_file") == 4
    sess_consistent_ok = audit_data.get("session_count_consistent") is False
    if sess_proc_ok and sess_file_ok and sess_consistent_ok:
        scores["session_count_cross_validation_correct"] = 1.0
    elif sess_proc_ok and sess_file_ok:
        scores["session_count_cross_validation_correct"] = 0.75
    elif sess_proc_ok or sess_file_ok:
        scores["session_count_cross_validation_correct"] = 0.4

    # Check log parsing
    mem_warn_ok = audit_data.get("memory_warn_count") == 14
    mem_max_ok = audit_data.get("memory_max_mb") == 473
    oversized_ok = audit_data.get("oversized_session_warn_count") == 10
    if mem_warn_ok and mem_max_ok and oversized_ok:
        scores["log_parsing_correct"] = 1.0
    elif mem_warn_ok and mem_max_ok:
        scores["log_parsing_correct"] = 0.7
    elif mem_warn_ok or (mem_max_ok and oversized_ok):
        scores["log_parsing_correct"] = 0.4
    elif mem_warn_ok or mem_max_ok or oversized_ok:
        scores["log_parsing_correct"] = 0.2

    # Check session inventory
    total_ok = audit_data.get("total_session_files") == 187
    by_type = audit_data.get("session_count_by_type", {})
    expected_types = {
        "discord": 31, "telegram": 27, "heartbeat": 24, "cron": 24,
        "isolated": 23, "subagent": 20, "feishu": 20, "main": 18
    }
    correct_types = sum(1 for k, v in expected_types.items() if by_type.get(k) == v)
    if total_ok and correct_types == 8:
        scores["session_inventory_correct"] = 1.0
    elif total_ok and correct_types >= 6:
        scores["session_inventory_correct"] = 0.75
    elif total_ok and correct_types >= 4:
        scores["session_inventory_correct"] = 0.5
    elif total_ok or correct_types >= 4:
        scores["session_inventory_correct"] = 0.25

    # Check health score — also verify formula components are derivable from raw data
    expected_health = 46
    actual_health = audit_data.get("health_score")

    # Retrieve component values from the audit JSON for formula verification
    mem_warns = audit_data.get("memory_warn_count")
    state_incon = audit_data.get("state_inconsistency_count")
    oversized = audit_data.get("oversized_session_warn_count")

    # Verify formula: 100 - 14*1 - 2*15 - 10*1 = 46
    formula_correct = (
        mem_warns == 14 and
        state_incon == 2 and
        oversized == 10 and
        actual_health == 46
    )
    if formula_correct:
        scores["health_score_correct"] = 1.0
    elif actual_health == expected_health:
        # Correct final answer but can't verify components
        scores["health_score_correct"] = 0.7
    elif isinstance(actual_health, (int, float)) and abs(actual_health - expected_health) <= 2:
        # Near-correct — formula might have a minor arithmetic error
        scores["health_score_correct"] = 0.4

    # Check runtime-audit.md — require formula breakdown and core sections
    audit_md_path = os.path.join(workspace_path, "runtime-audit.md")
    if os.path.isfile(audit_md_path):
        try:
            with open(audit_md_path, "r", encoding="utf-8") as f:
                md_content = f.read()
            checks = [
                bool(re.search(r"28417", md_content)),
                bool(re.search(r"28419", md_content)),
                bool(re.search(r"(?i)inconsisten", md_content)),
                bool(re.search(r"(?i)session.*count|active.*session", md_content)),
                bool(re.search(r"(?i)gateway-manager", md_content)),
                bool(re.search(r"(?i)recovery|restart", md_content)),
                bool(re.search(r"187", md_content)),
                # Health score formula breakdown (100 - 14 - 30 - 10 or similar)
                bool(re.search(r'100\s*-\s*14|100\s*-\s*1[0-9]\s*-\s*30|formula', md_content)),
            ]
            scores["audit_md_completeness"] = round(sum(checks) / len(checks), 2)
        except Exception:
            scores["audit_md_completeness"] = 0.0

    return scores
```

## LLM Judge Rubric

### Skill Quality and Protocol Coverage (Weight: 20%)
Evaluates whether `workspace/skills/runtime-diagnostics/SKILL.md` is a well-structured, genuinely reusable skill that fully documents the audit procedure, including cross-validation logic, log parsing approach, session inventory method, and the exact health score formula.
- 1.0: Complete YAML frontmatter, 3+ organized sections, explicitly documents the health_score formula and all data sources; could be followed by another agent to reproduce the audit
- 0.75: Good structure and covers most steps but missing the formula or one data source
- 0.5: Exists with frontmatter but is generic; missing cross-validation or log parsing specifics
- 0.25: Minimal stub with little procedural detail
- 0.0: Missing or empty

### State Consistency Analysis (Weight: 30%)
Evaluates whether the agent correctly identified and documented both planted inconsistencies: PID mismatch (process.json=28417 vs gateway.pid=28419) and active session count mismatch (process.json=3 vs active-sessions.json=4).
- 1.0: Both inconsistencies identified with correct values from both sources, clearly flagged in runtime-audit.json and runtime-audit.md
- 0.75: Both inconsistencies identified but one value is slightly wrong or not surfaced in both output files
- 0.5: Only one inconsistency identified with correct values
- 0.25: Mentions inconsistency but values are wrong or vague
- 0.0: No inconsistencies reported, or all state files treated as consistent

### Log Parsing and Session Inventory Accuracy (Weight: 25%)
Evaluates whether memory_warn_count=14, memory_max_mb=473, oversized_session_warn_count=10, total_session_files=187, and all 8 session type counts are correct.
- 1.0: All values are exactly correct (memory_warn_count=14, memory_max_mb=473, oversized=10, total=187, all 8 type counts match)
- 0.75: Total session count and memory counts correct; 1-2 type counts off
- 0.5: Memory warn count or session count correct but not both; or multiple type counts wrong
- 0.25: Some numbers in the right ballpark but significant errors
- 0.0: All counts wrong or not attempted; output disconnected from actual file contents

### Health Score Computation and Report Quality (Weight: 25%)
Evaluates whether health_score=46 is computed correctly using the stated formula, and whether runtime-audit.md is well-organized with a clear breakdown showing how the score was derived, plus an actionable recovery section.
- 1.0: health_score=46 with correct formula breakdown shown (100 - 14 - 30 - 10), and runtime-audit.md has clear sections for inconsistencies, memory analysis, session inventory, and a recovery procedure citing scripts/gateway-manager.sh
- 0.75: health_score correct or within ±2, report is reasonably complete but formula breakdown missing or recovery section vague
- 0.5: health_score wrong but formula reasoning shown; or correct score but report is incomplete
- 0.25: Score present but clearly incorrect formula; report exists but poorly organized
- 0.0: No health score or completely wrong; no meaningful report
