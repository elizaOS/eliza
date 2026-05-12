---
id: task_00013_weather_skill_token_efficiency_overhaul_config_pruning_and_parser
name: Weather Skill Token-Efficiency Overhaul — Config Pruning and Parser Implementation
category: Communication and Scheduling
subcategory: Reminders and Scheduled Tasks
grading_type: hybrid
grading_weights:
  automated: 0.5
  llm_judge: 0.5
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: skills/weather/SKILL.md
  dest: skills/weather/SKILL.md
- source: skills/weather/config.yaml
  dest: skills/weather/config.yaml
- source: skills/weather/scripts/fetch_weather.sh
  dest: skills/weather/scripts/fetch_weather.sh
- source: skills/weather/scripts/parse_response.py
  dest: skills/weather/scripts/parse_response.py
- source: skills/weather/scripts/wttr_fetch.sh
  dest: skills/weather/scripts/wttr_fetch.sh
- source: data/cache/weather_response_beijing_20250118.json
  dest: data/cache/weather_response_beijing_20250118.json
---

## Prompt

Ugh, still getting the giant weather blob — thousands of tokens every time. I see there's already a `skills/weather/` folder. Can you look through the whole thing — the config, the parse script, the skill doc — find why it's so verbose and fix it properly? I only want current conditions in a compact single-line format: temp, feels-like, wind speed and direction, humidity, and a brief weather description. Strip out everything else.

## Expected Behavior

The agent should read all five skill files and the cached response, diagnose the root cause of token waste, then make targeted changes to three files.

### Diagnosis

**`skills/weather/config.yaml`**: The file requests **46 `hourly_params`** (including `soil_moisture_0_to_1cm` through `soil_moisture_27_to_81cm`, `et0_fao_evapotranspiration`, `global_tilted_irradiance`, `cape`, `wind_speed_80m/120m/180m`, etc.) and **22 `daily_params`** across 7 forecast days. With 46 params × 168 hourly data points = 7,728 values for hourly alone, plus daily summaries and metadata, this easily produces 15,000+ tokens per API call. The `output.format: raw` setting disables all filtering.

**`skills/weather/scripts/parse_response.py`**: The `parse_weather()` function contains an explicit `TODO: Add filtering/summarization to reduce token usage` comment but is not implemented — it calls `json.dumps(data, indent=2)` which returns the full raw JSON blob.

**`skills/weather/scripts/fetch_weather.sh`**: The HOURLY URL parameter lists all 46 params; the DAILY lists all 22. The entire 7-day forecast is requested every time.

**`skills/weather/scripts/wttr_fetch.sh`**: Uses `?format=j1` which returns the full verbose JSON.

**`data/cache/weather_response_beijing_20250118.json`**: The 8,000+ line cached response file demonstrates the real-world output size of the current configuration.

### Required Changes

**File 1: `skills/weather/config.yaml`**

Reduce `hourly_params` from 46 to at most 6 essential params (any reasonable subset of):
- `temperature_2m`
- `apparent_temperature`
- `relative_humidity_2m`
- `wind_speed_10m`
- `wind_direction_10m`
- `weather_code`

Remove at minimum all of the following non-essential params:
- All soil moisture params (`soil_moisture_0_to_1cm` through `soil_moisture_27_to_81cm`)
- All radiation params (`shortwave_radiation`, `direct_radiation`, `diffuse_radiation`, `global_tilted_irradiance`, `direct_normal_irradiance`)
- All multi-height wind params (`wind_speed_80m`, `wind_speed_120m`, `wind_speed_180m`, `wind_direction_80m/120m/180m`)
- `et0_fao_evapotranspiration`, `cape`, `evapotranspiration`, `vapour_pressure_deficit`
- All soil temperature params

Also update:
- `output.format: raw` → `output.format: compact`
- `output.filter_fields: false` → `output.filter_fields: true`
- `output.include_hourly: true` → `output.include_hourly: false` (current weather only, no 168-point arrays)
- `output.max_tokens: null` → a reasonable limit (e.g., `500`)
- `forecast_days: 7` → `1`

**File 2: `skills/weather/scripts/parse_response.py`**

Implement the `TODO`. The `parse_weather()` function must:
- Extract from the `current` section: `temperature_2m`, `apparent_temperature`, `relative_humidity_2m`, `wind_speed_10m`, `wind_direction_10m` (or `wind_gusts_10m`), `weather_code`
- Convert `weather_code` to a human-readable description (e.g., using the WMO weather interpretation codes: 0=Clear sky, 1-3=Partly cloudy, 45/48=Fog, 51-67=Rain, 71-77=Snow, 80-82=Showers, 95=Thunderstorm)
- Format as a compact single line, e.g.: `Beijing: ⛅ Partly cloudy, 14°C (feels 11°C) | Wind: 23 km/h NE | Humidity: 45%`
- The returned string must be ≤ 200 characters (no more JSON dumps)

**File 3: `workspace/skills/weather/SKILL.md`**

Update to document the compact approach:
- Change step 3 from "Return the full response to the user" to document the compact single-line format
- Add a section specifying which fields are included (temp, feels-like, wind, humidity, description)
- Note that `parse_response.py` filters the response to essential fields only

**Optional (bonus): `skills/weather/scripts/wttr_fetch.sh`**

Change `?format=j1` to a compact format string. The wttr.in compact format supports: `%l` (location), `%C` (condition), `%t` (temperature), `%f` (feels-like), `%w` (wind), `%h` (humidity). Example compact URL: `curl -s "https://wttr.in/${ENCODED}?format=%25l:+%25C+%25t+feels+%25f+%7C+%25w+%7C+%25h"`

**Key traps / common failure modes:**
- Agent creates a new `SKILL.md` at workspace root or `workspace/skills/weather-compact/SKILL.md` instead of modifying the existing broken system (the problem is in the existing files, not in missing files).
- Agent only updates `workspace/skills/weather/SKILL.md` text documentation but does NOT modify `config.yaml` or `parse_response.py` — the root cause is in those two files.
- Agent reduces `hourly_params` but keeps the essential params (temp, humidity, wind) in the list without also disabling hourly output (`include_hourly: false`) — 168-point hourly arrays still waste tokens even with fewer params.
- Agent implements `parse_response.py` filtering but still includes `json.dumps` output as a fallback.
- Agent removes ALL params from `config.yaml` including the essential 5-6, leaving the config non-functional.
- Agent updates `parse_response.py` but keeps the output as multi-line verbose format rather than a compact single line.

## Grading Criteria

- [ ] `skills/weather/config.yaml` updated: `hourly_params` count reduced from 46 to ≤ 8; non-essential params (soil moisture, radiation, multi-height wind, ET) removed
- [ ] `skills/weather/config.yaml` essential params retained: `temperature_2m`, `apparent_temperature`, `relative_humidity_2m`, `wind_speed_10m`, `wind_direction_10m`, `weather_code`
- [ ] `skills/weather/config.yaml` output settings updated: `format` changed from `raw`, `include_hourly` disabled or `forecast_days` reduced
- [ ] `skills/weather/scripts/parse_response.py` implements the TODO: extracts current weather fields instead of returning full JSON dump
- [ ] `skills/weather/scripts/parse_response.py` produces compact single-line output (≤ 200 chars) including temp, feels-like, wind, humidity
- [ ] `workspace/skills/weather/SKILL.md` updated to document compact format (no longer says "return full response")
- [ ] Agent correctly identifies root cause: the combination of 46+ hourly params × 168 data points = massive token waste
- [ ] Agent does NOT create a redundant new SKILL.md at workspace root (the fix should update existing files)

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os, re, yaml
    from pathlib import Path

    scores = {
        "config_params_reduced": 0.0,
        "config_essential_params_retained": 0.0,
        "parse_script_filtering_implemented": 0.0,
        "compact_output_format": 0.0,
        "skill_md_updated": 0.0,
        "root_cause_identified": 0.0,
    }

    ws = Path(workspace_path)

    # ── config.yaml changes ──────────────────────────────────────────
    config_path = ws / "skills" / "weather" / "config.yaml"
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                config_text = f.read()
            # Count hourly_params entries (approximate by counting list items under hourly_params)
            # Non-essential params that should have been removed
            removed_signals = ["soil_moisture", "et0_fao", "shortwave_radiation",
                               "wind_speed_80m", "wind_speed_120m", "wind_speed_180m",
                               "diffuse_radiation", "global_tilted_irradiance", "cape",
                               "evapotranspiration", "vapour_pressure_deficit"]
            still_present = sum(1 for p in removed_signals if p in config_text)
            # The more non-essential params removed, the better
            if still_present == 0:
                scores["config_params_reduced"] = 1.0
            elif still_present <= 3:
                scores["config_params_reduced"] = 0.7
            elif still_present <= 6:
                scores["config_params_reduced"] = 0.4
            else:
                scores["config_params_reduced"] = 0.0

            # Essential params must still be present
            essential = ["temperature_2m", "apparent_temperature",
                         "relative_humidity_2m", "wind_speed_10m",
                         "wind_direction_10m", "weather_code"]
            retained = sum(1 for p in essential if p in config_text)
            scores["config_essential_params_retained"] = retained / len(essential)

        except Exception:
            pass

    # ── parse_response.py changes ─────────────────────────────────────
    parse_path = ws / "skills" / "weather" / "scripts" / "parse_response.py"
    if parse_path.exists():
        try:
            with open(parse_path, "r", encoding="utf-8") as f:
                parse_text = f.read()

            # Must not still just be returning full JSON dump
            still_dumb = 'return json.dumps(data, indent=2' in parse_text
            has_filtering = any(kw in parse_text for kw in [
                'current', 'temperature_2m', 'apparent_temperature',
                'relative_humidity', 'wind_speed', 'weather_code', 'f-string', "f'", 'f"'
            ])
            if not still_dumb and has_filtering:
                scores["parse_script_filtering_implemented"] = 1.0
            elif has_filtering:
                scores["parse_script_filtering_implemented"] = 0.5
            elif not still_dumb:
                scores["parse_script_filtering_implemented"] = 0.3

            # Check for compact single-line output
            compact_signals = [
                re.search(r"f['\"].*temp.*wind", parse_text, re.IGNORECASE),
                re.search(r"f['\"].*°C", parse_text),
                re.search(r"format.*string", parse_text, re.IGNORECASE),
                "feels" in parse_text,
                "humidity" in parse_text.lower(),
                "|" in parse_text,
            ]
            compact_hits = sum(1 for s in compact_signals if s)
            if compact_hits >= 3:
                scores["compact_output_format"] = 1.0
            elif compact_hits >= 2:
                scores["compact_output_format"] = 0.6
            elif compact_hits >= 1:
                scores["compact_output_format"] = 0.3
        except Exception:
            pass

    # ── SKILL.md updated ─────────────────────────────────────────────
    skill_path = ws / "skills" / "weather" / "SKILL.md"
    if skill_path.exists():
        try:
            with open(skill_path, "r", encoding="utf-8") as f:
                skill_text = f.read().lower()
            # Original said "return the full response to the user"
            still_verbose = "return the full response" in skill_text or "maximum detail" in skill_text
            has_compact = any(kw in skill_text for kw in [
                "compact", "single-line", "single line", "token", "efficient",
                "feels", "humidity", "format"
            ])
            if has_compact and not still_verbose:
                scores["skill_md_updated"] = 1.0
            elif has_compact:
                scores["skill_md_updated"] = 0.5
            elif not still_verbose:
                scores["skill_md_updated"] = 0.3
        except Exception:
            pass

    # ── Root cause identified in transcript ──────────────────────────
    full_text = ""
    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        if msg.get("role") == "assistant":
            c = msg.get("content", "")
            if isinstance(c, list):
                c = " ".join(p.get("text", "") for p in c if isinstance(p, dict))
            full_text += " " + c.lower()

    root_cause_kws = [
        r"\b4[56789]\b.{0,30}(param|field|metric)",
        r"(46|50|47|48).{0,30}hourly",
        r"168.{0,30}(point|data)",
        r"soil.{0,20}moisture.{0,30}(remove|unnecessary|not.need|strip)",
        r"et0_fao|evapotranspiration",
        r"15.{0,5}000.{0,20}token",
        r"7.{0,5}(day|days).{0,20}(hour|forecast).{0,20}(waste|verbose|unneed)",
    ]
    rc_hits = sum(1 for p in root_cause_kws if re.search(p, full_text))
    if rc_hits >= 2:
        scores["root_cause_identified"] = 1.0
    elif rc_hits >= 1:
        scores["root_cause_identified"] = 0.5

    return scores
```

## LLM Judge Rubric

### Root Cause Diagnosis (Weight: 25%)
Evaluate whether the agent reads `config.yaml` and `parse_response.py`, correctly identifies the source of token waste (46 hourly params × 168 data points + raw JSON dump), and explains the problem before attempting to fix it.

- **1.0**: Agent explicitly reads `config.yaml`; counts or enumerates the excessive params (e.g., "46 hourly params including soil moisture, radiation fields, multi-height wind that are not needed for a current weather summary"); reads `parse_response.py` and identifies the `TODO` + `json.dumps` full-dump as the second problem; estimates or notes the 15,000+ token output from the cached file. Explains both root causes clearly.
- **0.75**: Agent identifies the excessive `config.yaml` params and the `parse_response.py` TODO, but without specific counts or detailed enumeration of which params are unnecessary.
- **0.5**: Agent notices the problem is in `config.yaml` or `parse_response.py` but only identifies one of the two root causes.
- **0.25**: Agent vaguely notes "the config requests too much" without reading the files or specifying what needs to change.
- **0.0**: Agent ignores the existing skill files and writes a new SKILL.md from scratch, or fails to read the existing system at all.

### Config.yaml Pruning Correctness (Weight: 30%)
Evaluate whether `skills/weather/config.yaml` is correctly updated: non-essential params removed (soil, radiation, multi-height wind, ET), essential params retained (temp, feels-like, humidity, wind, weather_code), and output settings updated.

- **1.0**: `hourly_params` reduced to ≤8 essential params; all soil moisture, radiation, and multi-height wind params removed; `output.format` changed from `raw`; `include_hourly: false` or `forecast_days: 1`; essential params (`temperature_2m`, `apparent_temperature`, `relative_humidity_2m`, `wind_speed_10m`, `wind_direction_10m`, `weather_code`) retained.
- **0.75**: Most non-essential params removed and essential ones retained; one output setting not updated (e.g., still `include_hourly: true`).
- **0.5**: Params partially pruned (e.g., soil moisture removed but radiation params kept); or essential params partially retained.
- **0.25**: Config modified but changes are superficial or incorrect (e.g., only `forecast_days` changed but 46 params kept).
- **0.0**: `config.yaml` unchanged; or all params removed including essential ones (config broken).

### parse_response.py Implementation (Weight: 30%)
Evaluate whether the `TODO` in `parse_response.py` is implemented: the function must extract current weather fields and format as a compact single line (≤~200 characters), not return the full JSON dump.

- **1.0**: `parse_weather()` correctly extracts from `current` section: temp (`temperature_2m`), feels-like (`apparent_temperature`), humidity (`relative_humidity_2m`), wind (`wind_speed_10m` + direction), and weather description (from `weather_code`); formats as a compact readable single line using f-string; no longer calls `json.dumps(data, indent=2)` as the primary return; handles missing keys gracefully.
- **0.75**: Implementation extracts most key fields and produces compact output, but missing one field (e.g., no feels-like or no humidity) or the output is still multi-line.
- **0.5**: Implementation present but only extracts 2-3 fields; or still includes a full JSON dump alongside a compact summary.
- **0.25**: `parse_response.py` modified but the TODO is not meaningfully implemented (e.g., just adds a comment or prints one field only).
- **0.0**: `parse_response.py` unchanged (`json.dumps` full-dump still the only return); or file broken/deleted.

### SKILL.md Documentation Update (Weight: 15%)
Evaluate whether `workspace/skills/weather/SKILL.md` is updated to document the compact approach, removing the "return full response" instruction.

- **1.0**: `workspace/skills/weather/SKILL.md` updated: "Return the full response to the user" replaced with compact format documentation; explicitly states which fields are included; notes the token efficiency goal; references that `parse_response.py` does the filtering.
- **0.75**: SKILL.md updated with compact format but the old verbose instruction still present (not replaced).
- **0.5**: SKILL.md has some changes but documentation is incomplete or generic.
- **0.25**: SKILL.md barely modified; only minor text changes without documenting the new approach.
- **0.0**: SKILL.md unchanged; or agent created a new SKILL.md at workspace root instead of updating the existing one.
