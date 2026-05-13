---
id: task_00042_doraemon_character_drawing_script_documentation
name: Doraemon Character Drawing Script Documentation
category: Workflow and Agent Orchestration
grading_type: hybrid
timeout_seconds: 1800
verification_method: rubric
input_modality: text-only
workspace_files:
- source: project/requirements.txt
  dest: project/requirements.txt
- source: project/README.md
  dest: project/README.md
- source: project/config/colors.json
  dest: project/config/colors.json
- source: project/config/dimensions.yaml
  dest: project/config/dimensions.yaml
- source: project/config/doraemon_colors.json
  dest: project/config/doraemon_colors.json
- source: project/examples/turtle_example.py
  dest: project/examples/turtle_example.py
- source: project/examples/svg_export_notes.txt
  dest: project/examples/svg_export_notes.txt
- source: project/config/export_settings.ini
  dest: project/config/export_settings.ini
- source: project/docs/run_instructions.md
  dest: project/docs/run_instructions.md
grading_weights:
  automated: 0.35
  llm_judge: 0.65
subcategory: Script and Terminal Automation
---
## Prompt

I have a small project set up for drawing Doraemon (the blue robot cat) with matplotlib — there are config files, example code, and docs all under `project/`. I just never got around to writing the actual drawing script.

Can you go through the project, read the config files, and write a working matplotlib script that draws a recognizable Doraemon? Save the script as `draw_doraemon.py` so I can run it directly. Then write up `doraemon_drawing.md` — include the full code in a fenced block, explain which config files you ended up using and why you chose them over the alternatives, and add instructions on how to run it.

It doesn't need to be pixel-perfect — just clearly Doraemon. Blue head, white face area, red nose, whiskers, collar with bell, that kind of thing. Use the project configs for colors, dimensions, export format and resolution.

## Expected Behavior

The agent should explore the project workspace, read the configuration files, and produce two deliverables:
1. A standalone, runnable Python script `draw_doraemon.py` that draws a Doraemon character using matplotlib
2. A markdown document `doraemon_drawing.md` containing the full code, configuration analysis, and run instructions

**Correct configuration resolution:**

1. **Trap 1 — Color palette (ambiguous versions):** The project contains two color palette files with the same key structure but different hex values: `project/config/colors.json` (palette_name "Doraemon Standard Colors", version 2.0, last updated 2024-01-10) and `project/config/doraemon_colors.json` (palette_name "Doraemon Drawing Project Colors", version 2.1, last updated 2024-05-18). Both files use the key `body_blue`, but with different values: `colors.json` has `#0093D6` (the iconic Doraemon blue) while `doraemon_colors.json` has `#2196F3` (a Material Design blue). The correct file is `colors.json` because: (a) its palette_name contains "Standard" matching the README's reference to the "standard project palette"; (b) its notes field says "current canonical color palette"; (c) `doraemon_colors.json` self-describes as a "Material Design-inspired" adaptation with "accent colors adjusted for digital display", indicating it is a derivative variant rather than the project standard. The newer date and higher minor version number of `doraemon_colors.json` are red herrings — they reflect when the variant was created, not that it supersedes the standard palette. The accent colors also differ between files (e.g., nose_red `#D63C3C` vs `#E53935`, collar_red `#CC0000` vs `#C62828`, bell_yellow `#FFD700` vs `#FFC107`); the agent must consistently use all colors from `colors.json`.

2. **Trap 2 — Export settings (competing configs):** `project/config/dimensions.yaml` specifies `dpi: 150` and `format: png` under its `output` section alongside the complete character layout. `project/config/export_settings.ini` specifies `dpi=72`, `format=jpg`, and `quality=85`, with `scope=preview` in its `[metadata]` section and description "Optimized export profile for web delivery." The YAML is the authoritative project configuration — it contains comprehensive layout data and output settings in one place. The INI is a secondary export profile scoped for web preview use, not applicable to the main drawing output. The agent should use DPI 150 and PNG format from `dimensions.yaml`.

3. **Noise files:** `project/examples/turtle_example.py` is an incomplete turtle example (multiple TODO placeholders, no save-to-file capability) and `project/examples/svg_export_notes.txt` discusses SVG export via the `svgwrite` library. Neither is relevant to the matplotlib-based task. The `README.md` explicitly states matplotlib is preferred over turtle for this project.

4. **Standalone script (`draw_doraemon.py`):** The Python script should:
   - Import and use `matplotlib.pyplot` and `matplotlib.patches` (Circle, Ellipse, Arc, Polygon, etc.) for shape composition
   - Reference dimension values from `dimensions.yaml`: canvas 800×800 with background `#F0F0F0`, head radius 200 centered at (400, 450), face radius 170 centered at (400, 430), nose radius 15, eye positions at (370, 490) and (430, 490), body 280×180, collar at y=340, whisker parameters
   - Apply correct colors from `colors.json`: body blue `#0093D6`, face white `#FFFFFF`, nose red `#D63C3C`, collar red `#CC0000`, bell yellow `#FFD700`
   - Draw multiple distinct Doraemon features: blue circular head, white face area, eyes (with pupils), red nose, mouth, whiskers (3 per side), red collar, yellow bell
   - Save output as PNG at 150 DPI via `plt.savefig()`
   - Be runnable with `python draw_doraemon.py` after installing dependencies from `requirements.txt`

5. **Documentation (`doraemon_drawing.md`):** The markdown file should:
   - Include the full Python code in a fenced code block
   - Explain which config files were used and why — specifically why `doraemon_colors.json` was not used (it is a Material Design-inspired variant, not the standard palette) despite having a higher version number and more recent date, and why `export_settings.ini` does not apply to the main output (its scope is preview/web delivery, not production rendering)
   - Note the export format (PNG) and DPI (150) choices with reference to `dimensions.yaml`
   - Provide run instructions including dependency installation (`pip install -r requirements.txt` or `pip install matplotlib`) and the execution command (`python draw_doraemon.py`)

6. **Code engineering quality:** The drawing code should demonstrate good engineering practices:
   - Function encapsulation for distinct drawing components (e.g., separate functions for head, face, whiskers) rather than a single monolithic block
   - Centralized color management (loading from config or defining a color dictionary at the top) rather than scattered hex string literals
   - Parameterized dimensions that reference the YAML values through named variables rather than arbitrary hardcoded numbers
   - Clear variable naming that maps to the character's anatomy (e.g., `head_radius`, `eye_left_x`)

7. **Implicit technical requirements:** Beyond the explicit task description, strong responses should handle:
   - The figsize-DPI relationship: with DPI 150 and canvas 800×800, the figure size should be approximately 5.33×5.33 inches (800/150) to produce pixel-accurate output
   - Layer ordering via `zorder` parameters to ensure features render in the correct visual order (e.g., face overlay on head, pupils on eyes)
   - Output quality: `bbox_inches='tight'` or similar to ensure the saved image is properly cropped
   - `ax.set_aspect('equal')` and `ax.axis('off')` for a clean drawing canvas without axis decorations

Tested capabilities: multi-file configuration disambiguation with deceptive metadata, matplotlib drawing API usage, color palette version analysis, technical documentation with config traceability, multi-file delivery, code engineering quality assessment, implicit requirements handling.

## Grading Criteria

- [ ] Both deliverables exist: `doraemon_drawing.md` with matplotlib code blocks and standalone `draw_doraemon.py` with matplotlib imports (`deliverables_exist`)
- [ ] The code uses the correct body blue `#0093D6` from `colors.json`, the standard palette (`uses_correct_blue`)
- [ ] The code does not contain the wrong blue `#2196F3` from `doraemon_colors.json`; only scored when correct blue appears in code blocks, not just prose mentions (`avoids_wrong_blue`)
- [ ] Accent colors (nose, collar, bell) consistently come from `colors.json` — not mixed with `doraemon_colors.json` values (`color_palette_consistency`)
- [ ] The code calls `savefig()` to export as PNG with a DPI parameter — not JPG (`specifies_png_format`)
- [ ] The output uses DPI 150 from `dimensions.yaml`, not 72 from `export_settings.ini` (`correct_dpi`)
- [ ] The code uses `matplotlib.patches` API (Circle, Ellipse, etc.) for shape composition (`uses_matplotlib_patches`)
- [ ] The code references specific dimension values from `dimensions.yaml` — canvas size, radii, center positions, eye coordinates (`uses_yaml_dimensions`)
- [ ] The code applies the background color `#F0F0F0` from the canvas section of `dimensions.yaml` (`uses_background_color`)
- [ ] The code draws multiple recognizable Doraemon features with actual drawing operations, not just keyword mentions (`drawing_features`)
- [ ] The document explains why `doraemon_colors.json` was not used — requires explicit rejection reasoning (standard/canonical distinction, material variant identification), not merely mentioning both file names (`explains_color_choice`)
- [ ] The document explains why `export_settings.ini` was not used — requires explicit rejection reasoning citing preview/web scope or non-authoritative status, not merely listing both file names (`explains_export_choice`)
- [ ] The document includes instructions for running the script — dependencies and execution command presented in fenced code blocks, not just plain text (`run_instructions`)
- [ ] The standalone script `draw_doraemon.py` and the markdown code block share key implementation patterns (`script_code_consistency`)
- [ ] The code uses explicit `zorder` parameters on patches to manage visual layering of overlapping drawing elements (`zorder_layering`)
- [ ] The code derives `figsize` from the canvas dimensions (800) and DPI (150) to produce pixel-accurate output dimensions (`figsize_dpi_match`)

## Automated Checks

```python
import os
import re


def grade(transcript: list, workspace_path: str) -> dict:
    results = {
        "deliverables_exist": 0.0,
        "uses_correct_blue": 0.0,
        "avoids_wrong_blue": 0.0,
        "color_palette_consistency": 0.0,
        "specifies_png_format": 0.0,
        "correct_dpi": 0.0,
        "uses_matplotlib_patches": 0.0,
        "uses_yaml_dimensions": 0.0,
        "uses_background_color": 0.0,
        "drawing_features": 0.0,
        "explains_color_choice": 0.0,
        "explains_export_choice": 0.0,
        "run_instructions": 0.0,
        "script_code_consistency": 0.0,
        "zorder_layering": 0.0,
        "figsize_dpi_match": 0.0,
    }

    output_file = os.path.join(workspace_path, "doraemon_drawing.md")
    if not os.path.isfile(output_file):
        return results

    with open(output_file, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    if not content.strip():
        return results

    content_lower = content.lower()
    fence = "`" * 3

    # --- Standalone script file ---
    script_path = os.path.join(workspace_path, "draw_doraemon.py")
    script_text = ""
    if os.path.isfile(script_path):
        with open(script_path, "r", encoding="utf-8", errors="replace") as f:
            script_text = f.read()

    # --- Extract Python code blocks from markdown ---
    code_blocks = re.findall(fence + r"python([\s\S]*?)" + fence, content, re.IGNORECASE)
    code_text = "\n".join(code_blocks)
    code_lower = code_text.lower()

    # --- Extract all fenced blocks (any language) for command checks ---
    all_fenced_blocks = re.findall(
        fence + r"[a-z]*\s*\n([\s\S]*?)" + fence, content, re.IGNORECASE
    )
    fenced_text = "\n".join(all_fenced_blocks)

    # --- deliverables_exist: both files present with matplotlib imports ---
    has_output = True
    has_script = bool(script_text.strip())
    has_mpl_md = bool(
        code_blocks
        and re.search(r"(import\s+matplotlib|from\s+matplotlib)", code_lower)
    )
    has_mpl_script = (
        bool(re.search(r"(import\s+matplotlib|from\s+matplotlib)", script_text.lower()))
        if script_text
        else False
    )
    d_parts = int(has_output) + int(has_script) + int(has_mpl_md) + int(has_mpl_script)
    if d_parts >= 4:
        results["deliverables_exist"] = 1.0
    elif d_parts >= 3:
        results["deliverables_exist"] = 0.75
    elif d_parts >= 2:
        results["deliverables_exist"] = 0.5
    elif d_parts >= 1:
        results["deliverables_exist"] = 0.25

    # --- uses_correct_blue: hex #0093D6 must appear in code blocks for full credit ---
    if re.search(r"#0093d6", code_lower):
        results["uses_correct_blue"] = 1.0
    elif re.search(r"0093d6", code_lower):
        results["uses_correct_blue"] = 0.75
    elif re.search(r"#0093d6", content_lower):
        results["uses_correct_blue"] = 0.25

    # --- avoids_wrong_blue: gated on code-level blue (>= 0.75) ---
    if results["uses_correct_blue"] >= 0.75:
        if not re.search(r"#?2196f3", code_lower):
            results["avoids_wrong_blue"] = 1.0

    # --- color_palette_consistency: gated on code-level blue (>= 0.75) ---
    if results["uses_correct_blue"] >= 0.75:
        correct_accents = [r"#d63c3c", r"#cc0000", r"#ffd700"]
        wrong_accents = [r"#e53935", r"#c62828", r"#ffc107"]
        correct_hits = sum(1 for p in correct_accents if re.search(p, code_lower))
        wrong_hits = sum(1 for p in wrong_accents if re.search(p, code_lower))
        if correct_hits >= 2 and wrong_hits == 0:
            results["color_palette_consistency"] = 1.0
        elif correct_hits >= 1 and wrong_hits == 0:
            results["color_palette_consistency"] = 0.75
        elif correct_hits > wrong_hits:
            results["color_palette_consistency"] = 0.5
        elif correct_hits >= 1:
            results["color_palette_consistency"] = 0.25

    # --- specifies_png_format ---
    has_savefig = bool(re.search(r"savefig\s*\(", code_lower))
    saves_png = bool(re.search(r"savefig\s*\([\s\S]*?\.png", code_lower))
    saves_jpg = bool(re.search(r"savefig\s*\([\s\S]*?\.(jpg|jpeg)", code_lower))
    has_dpi_in_savefig = bool(re.search(
        r"savefig\s*\([^)]{0,200}\bdpi\s*=", code_text, re.IGNORECASE
    ))
    if saves_jpg:
        results["specifies_png_format"] = 0.0
    elif saves_png and has_dpi_in_savefig:
        results["specifies_png_format"] = 1.0
    elif saves_png:
        results["specifies_png_format"] = 0.5
    elif has_savefig and re.search(r"\.png", code_lower):
        results["specifies_png_format"] = 0.25

    # --- correct_dpi: 150 per dimensions.yaml ---
    dpi_in_code = [
        int(m.group(1))
        for m in re.finditer(r"\bdpi\s*[=:]\s*(\d+)", code_text, re.IGNORECASE)
    ]
    dpi_in_text = [
        int(m.group(1))
        for m in re.finditer(r"\bdpi\s*[=:]\s*(\d+)", content, re.IGNORECASE)
    ]
    dpi_in_text += [
        int(m.group(1))
        for m in re.finditer(r"(\d+)\s*dpi\b", content, re.IGNORECASE)
    ]
    if dpi_in_code:
        if 150 in dpi_in_code and 72 not in dpi_in_code:
            results["correct_dpi"] = 1.0
        elif 150 in dpi_in_code:
            results["correct_dpi"] = 0.5
        elif 72 in dpi_in_code:
            results["correct_dpi"] = 0.0
        else:
            results["correct_dpi"] = 0.5
    elif dpi_in_text:
        if 150 in dpi_in_text and 72 not in dpi_in_text:
            results["correct_dpi"] = 0.75
        elif 150 in dpi_in_text:
            results["correct_dpi"] = 0.5
        elif 72 in dpi_in_text:
            results["correct_dpi"] = 0.0

    # --- uses_matplotlib_patches: proper shape-drawing API ---
    has_patches_import = bool(re.search(
        r"matplotlib\.patches|from\s+matplotlib\s+import\s+patches", code_lower
    ))
    has_add_patch = bool(re.search(r"add_patch\s*\(|add_artist\s*\(", code_lower))
    has_shape_calls = len(re.findall(
        r"\b(Circle|Ellipse|Arc|Polygon|Wedge|Rectangle|FancyBboxPatch)\s*\(", code_text
    ))
    has_basic_draw = bool(re.search(r"plt\.fill|ax\.fill|plt\.plot|ax\.plot", code_lower))
    if has_patches_import and has_add_patch and has_shape_calls >= 3:
        results["uses_matplotlib_patches"] = 1.0
    elif has_patches_import and (has_add_patch or has_shape_calls >= 2):
        results["uses_matplotlib_patches"] = 0.75
    elif has_add_patch or has_shape_calls >= 1:
        results["uses_matplotlib_patches"] = 0.5
    elif has_basic_draw:
        results["uses_matplotlib_patches"] = 0.25

    # --- uses_yaml_dimensions: specific values from dimensions.yaml ---
    yaml_markers = [
        r"\b170\b", r"\b450\b", r"\b430\b", r"\b460\b", r"\b340\b",
        r"\b280\b", r"\b370\b", r"\b490\b", r"\b200\b",
    ]
    marker_hits = sum(1 for p in yaml_markers if re.search(p, code_text))
    has_canvas_800 = bool(re.search(r"\b800\b", code_text))
    if marker_hits >= 7 or (has_canvas_800 and marker_hits >= 6):
        results["uses_yaml_dimensions"] = 1.0
    elif marker_hits >= 4 or (has_canvas_800 and marker_hits >= 3):
        results["uses_yaml_dimensions"] = 0.75
    elif marker_hits >= 3 or (has_canvas_800 and marker_hits >= 2):
        results["uses_yaml_dimensions"] = 0.5
    elif marker_hits >= 1 or has_canvas_800:
        results["uses_yaml_dimensions"] = 0.25

    # --- uses_background_color: #F0F0F0 from dimensions.yaml canvas section ---
    bg_in_code = bool(re.search(r"#?f0f0f0", code_lower))
    bg_setter = bool(re.search(r"set_facecolor\s*\(", code_lower))
    if bg_in_code and bg_setter:
        results["uses_background_color"] = 1.0
    elif bg_in_code:
        results["uses_background_color"] = 0.75
    elif bg_setter:
        results["uses_background_color"] = 0.25

    # --- drawing_features: require actual drawing operations, not just keyword mentions ---
    features = ["head", "face", "eye", "nose", "whisker", "collar", "bell", "mouth"]
    found_in_code = sum(1 for f in features if re.search(r"\b" + f, code_lower))
    found_in_text = sum(1 for f in features if re.search(r"\b" + f, content_lower))
    has_draw_ops = bool(re.search(
        r"add_patch|add_artist|plt\.fill|ax\.fill|Circle\s*\(|Ellipse\s*\(", code_text
    ))
    if found_in_code >= 6 and has_draw_ops:
        results["drawing_features"] = 1.0
    elif found_in_code >= 4 and has_draw_ops:
        results["drawing_features"] = 0.75
    elif found_in_code >= 6 or (found_in_text >= 6 and has_draw_ops):
        results["drawing_features"] = 0.5

    # --- explains_color_choice: requires explicit rejection reasoning ---
    refs_doraemon_colors = bool(re.search(r"doraemon_colors", content, re.IGNORECASE))
    refs_colors_json = bool(re.search(
        r"(?<!doraemon_)colors\.json", content, re.IGNORECASE
    ))
    rejects_alt = bool(re.search(
        r"(doraemon_colors[\s\S]{0,100}(material|alternative|variant|adaptation|"
        r"refresh|non.?standard|not.{0,20}standard|not.{0,20}canonical|"
        r"not.{0,20}authoritative|different|reject|skip|avoid|ignore)|"
        r"(?<!doraemon_)colors\.json[\s\S]{0,80}(standard|canonical|official|"
        r"authoritative|primary)|"
        r"(standard|canonical)[\s\S]{0,80}(?<!doraemon_)colors\.json)",
        content_lower
    ))
    version_reasoning = bool(re.search(
        r"(version|v\s*2[\.\s]|v\s*2\.1|2\.0|2\.1|date|updated|newer|older)"
        r"[\s\S]{0,120}"
        r"(standard|canonical|despite|although|however|but|not\s+necessarily|"
        r"does\s+not\s+(mean|imply|indicate))",
        content_lower
    ))
    if refs_doraemon_colors and refs_colors_json and rejects_alt and version_reasoning:
        results["explains_color_choice"] = 1.0
    elif refs_doraemon_colors and refs_colors_json and rejects_alt:
        results["explains_color_choice"] = 0.75
    elif refs_colors_json and rejects_alt:
        results["explains_color_choice"] = 0.5
    elif (refs_doraemon_colors or refs_colors_json) and rejects_alt:
        results["explains_color_choice"] = 0.25

    # --- explains_export_choice: requires explicit rejection reasoning ---
    refs_dimensions = bool(re.search(r"dimensions\.yaml", content, re.IGNORECASE))
    refs_export_ini = bool(re.search(r"export_settings\.ini", content, re.IGNORECASE))
    rejects_ini = bool(re.search(
        r"(preview|web[\s-]?(only|specific|delivery|optimized|purpose)|"
        r"not[\s\S]{0,40}(main|primary|authoritative|production)|"
        r"scope[\s\S]{0,40}preview|"
        r"export_settings[\s\S]{0,80}(preview|web|ignore|skip|not\s+use|secondary|"
        r"alternative|not.{0,30}authoritative|not.{0,30}primary)|"
        r"dimensions\.yaml[\s\S]{0,80}(primary|authoritative|main|production|"
        r"comprehensive|complete|full\s+config))",
        content_lower
    ))
    if refs_export_ini and refs_dimensions and rejects_ini:
        results["explains_export_choice"] = 1.0
    elif refs_dimensions and rejects_ini:
        results["explains_export_choice"] = 0.75
    elif refs_export_ini and rejects_ini:
        results["explains_export_choice"] = 0.5
    elif refs_export_ini and refs_dimensions:
        results["explains_export_choice"] = 0.25

    # --- run_instructions: commands must be in fenced code blocks ---
    has_heading = bool(re.search(
        r"^#{1,4}\s+.*\b(run|setup|usage|install|how to|getting started|"
        r"prerequisites|dependencies)\b",
        content, re.MULTILINE | re.IGNORECASE
    ))
    has_pip_fenced = bool(re.search(
        r"\bpip\s+install\b", fenced_text, re.IGNORECASE
    ))
    has_python_cmd_fenced = bool(re.search(
        r"\bpython3?\s+[\w.]+\.py\b", fenced_text, re.IGNORECASE
    ))
    if has_heading and has_pip_fenced and has_python_cmd_fenced:
        results["run_instructions"] = 1.0
    elif has_heading and (has_pip_fenced or has_python_cmd_fenced):
        results["run_instructions"] = 0.75
    elif has_pip_fenced and has_python_cmd_fenced:
        results["run_instructions"] = 0.5

    # --- script_code_consistency ---
    if script_text.strip() and code_text.strip():
        key_snippets = [
            r"#0093d6", r"savefig\s*\(", r"matplotlib\.patches",
            r"add_patch\s*\(", r"Circle\s*\(", r"\b150\b",
        ]
        shared = sum(
            1 for p in key_snippets
            if re.search(p, script_text, re.IGNORECASE)
            and re.search(p, code_text, re.IGNORECASE)
        )
        if shared >= 5:
            results["script_code_consistency"] = 1.0
        elif shared >= 4:
            results["script_code_consistency"] = 0.75
        elif shared >= 3:
            results["script_code_consistency"] = 0.5
        elif shared >= 2:
            results["script_code_consistency"] = 0.25

    # --- zorder_layering: explicit layer ordering ---
    zorder_uses = len(re.findall(r"\bzorder\s*=\s*\d+", code_text, re.IGNORECASE))
    if zorder_uses >= 5:
        results["zorder_layering"] = 1.0
    elif zorder_uses >= 3:
        results["zorder_layering"] = 0.75
    elif zorder_uses >= 1:
        results["zorder_layering"] = 0.5

    # --- figsize_dpi_match: figsize derived from canvas/DPI ---
    has_figsize_calc = bool(re.search(
        r"figsize\s*=\s*\([\s\S]{0,50}800\s*/\s*150", code_text, re.IGNORECASE
    ))
    has_approx_figsize = bool(re.search(
        r"figsize\s*=\s*\(\s*5\.3", code_text, re.IGNORECASE
    ))
    if has_figsize_calc:
        results["figsize_dpi_match"] = 1.0
    elif has_approx_figsize:
        results["figsize_dpi_match"] = 0.75

    # --- Gate explanations on correct config usage ---
    if results["uses_correct_blue"] < 0.25:
        results["explains_color_choice"] = 0.0
    if results["correct_dpi"] == 0.0 and results["specifies_png_format"] == 0.0:
        results["explains_export_choice"] = 0.0

    return results
```

## LLM Judge Rubric

**Fallback rule**: If neither `draw_doraemon.py` nor `doraemon_drawing.md` exists, or both are empty, score 0 on all dimensions below.

### Criterion 1: Configuration Trap Identification and Reasoning Depth (Weight: 20%)
**Score 1.0**: The agent explicitly identifies both configuration traps with a complete reasoning chain for each. For the color palette, it compares the two JSON files' metadata — palette_name ("Standard Colors" vs generic project name), notes ("canonical" vs "Material Design-inspired"), and cross-references the README's mention of "standard project palette" — while addressing the version/date red herring (2.1 > 2.0 does not imply supersession) and explaining why all accent colors must also come from `colors.json`. For the export settings, it examines the INI's `[metadata]` section, identifies `scope=preview` and the "web delivery" description, and contrasts it with `dimensions.yaml`'s comprehensive role as the primary project configuration.
**Score 0.5**: The agent uses correct configuration values for both traps and provides surface-level reasoning for at least one (e.g., mentions "standard palette" or "preview scope") but lacks the multi-signal reasoning chain — does not connect palette_name + notes + README, or does not cite both scope and description from the INI file.
**Score 0.0**: The agent falls into at least one trap (uses `#2196F3` or exports as JPG at 72 DPI), provides no meaningful explanation of why alternatives were rejected, or shows no awareness that competing config files exist. Also applies if output files do not exist.

### Criterion 2: Documentation Structure and Config Traceability (Weight: 15%)
**Score 1.0**: The markdown has clear, labeled sections. Each configuration value is traced to its source file with path and version info (e.g., "`config/colors.json` v2.0 — the standard palette"). Both alternative files (`doraemon_colors.json`, `export_settings.ini`) are explicitly discussed and set aside with specific field-level evidence. Noise files are correctly excluded. The document reads as a self-contained technical record where a reviewer can verify every configuration choice without consulting the source files.
**Score 0.5**: The document references config files and has reasonable structure, but traceability is partial — some values are stated without citing their source, or alternative files are dismissed in a single sentence without field-level evidence (e.g., version numbers, scope metadata).
**Score 0.0**: The document is a code dump with no meaningful structure, config references, or selection reasoning. Also applies if output files do not exist.

### Criterion 3: Drawing Feature Completeness and Visual Faithfulness (Weight: 20%)
**Score 1.0**: The code draws all eight core Doraemon features (blue head, white face oval, eyes with pupils, red nose, mouth/smile, whiskers — 3 per side, red collar, yellow bell) using `matplotlib.patches` with correct colors from `colors.json` and proportions from `dimensions.yaml`. Features are layered in logical z-order (head behind face, pupils on top of eyes, etc.). Canvas background uses `#F0F0F0`. The character would be immediately recognizable as Doraemon when rendered.
**Score 0.5**: The code draws at least 5 core features with mostly correct colors, but may miss secondary features (e.g., individual pupils, bell detail), use partially incorrect proportions, or render features in a suboptimal layer order. Still recognizable as Doraemon with some effort.
**Score 0.0**: The code draws fewer than 3 features, uses wrong colors throughout, produces an unrecognizable output, or is non-functional pseudocode. Also applies if output files do not exist.

### Criterion 4: Code Engineering Quality and Modularity (Weight: 15%)
**Score 1.0**: Drawing code uses function encapsulation for distinct components (e.g., `draw_head()`, `draw_face()`, `draw_whiskers()`), manages colors through a centralized dictionary or config loading rather than scattered hex string literals, parameterizes dimensions so the drawing can be easily rescaled, and follows clear naming conventions. Code structure enables independent modification of any component.
**Score 0.5**: Code defines color or dimension variables at the top (not inline), may use one or two helper functions, but is mostly a linear sequence of drawing calls. Some values are still hardcoded in place. Modification requires changes in multiple locations.
**Score 0.0**: Code is a monolithic block of sequential calls with hardcoded hex values and magic numbers scattered throughout. No variable naming for colors or dimensions. Difficult to understand or modify.

### Criterion 5: Implicit Technical Requirements (Weight: 15%)
**Score 1.0**: The code correctly handles the figsize-DPI relationship so that output pixel dimensions match the 800×800 canvas specification (e.g., `figsize=(800/150, 800/150)` at DPI 150). Patch drawing uses explicit `zorder` parameters to ensure correct visual layering. Output uses `bbox_inches='tight'` or equivalent to eliminate whitespace. The code addresses at least one cross-platform consideration (e.g., safe font fallback, `plt.rcParams` configuration).
**Score 0.5**: The code correctly handles at least two of: figsize-DPI relationship, zorder management, tight output bounding box. Shows awareness that matplotlib rendering requires configuration beyond basic patch placement, but does not comprehensively address all quality factors.
**Score 0.0**: No evidence of implicit requirement awareness. Uses arbitrary figsize unrelated to canvas specification, no zorder management, no output quality settings. Default matplotlib behavior with no customization.

### Criterion 6: Reproducibility and Run Instructions (Weight: 15%)
**Score 1.0**: The document provides a complete, copy-pasteable setup sequence in fenced code blocks: dependency installation (referencing `requirements.txt` or explicit `pip install matplotlib`), script execution command (`python draw_doraemon.py`), expected output file name and format. Mentions both the standalone script and confirms the output format/DPI. A reader unfamiliar with the project could reproduce the result by following the instructions verbatim.
**Score 0.5**: Run instructions exist and include the basic commands (install + run) but may be missing expected output details, not properly formatted in code blocks, or lack reference to `requirements.txt`.
**Score 0.0**: No run instructions, or instructions are vague/incomplete (e.g., "run the script" without specifying the command or dependencies). Also applies if output files do not exist.
