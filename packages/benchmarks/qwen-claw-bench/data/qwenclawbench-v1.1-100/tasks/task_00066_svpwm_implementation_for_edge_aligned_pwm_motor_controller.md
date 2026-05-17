---
id: task_00066_svpwm_implementation_for_edge_aligned_pwm_motor_controller
name: SVPWM Implementation for Edge-Aligned PWM Motor Controller
category: Research and Information Retrieval
grading_type: hybrid
timeout_seconds: 1800
workspace_files:
- source: docs/svpwm_theory.md
  dest: docs/svpwm_theory.md
- source: docs/pwm_peripheral_spec.md
  dest: docs/pwm_peripheral_spec.md
- source: config/motor_params.json
  dest: config/motor_params.json
- source: reference/sector_table.csv
  dest: reference/sector_table.csv
- source: reference/clarke_park_transforms.c
  dest: reference/clarke_park_transforms.c
- source: reference/old_svpwm_center_aligned.c
  dest: reference/old_svpwm_center_aligned.c
- source: config/pwm_config_legacy.json
  dest: config/pwm_config_legacy.json
- source: test/test_vectors.csv
  dest: test/test_vectors.csv
- source: docs/faq_svpwm.md
  dest: docs/faq_svpwm.md
- source: logs/motor_bench_test_20240315.log
  dest: logs/motor_bench_test_20240315.log
- source: reference/trig_lookup.c
  dest: reference/trig_lookup.c
- source: config/project_settings.yaml
  dest: config/project_settings.yaml
- source: config/edge_aligned_correction.json
  dest: config/edge_aligned_correction.json
grading_weights:
  automated: 0.6
  llm_judge: 0.4
subcategory: Technical and Engineering Research
---
## Prompt

We're porting our motor control firmware to the XMC4200 platform and I need a fresh SVPWM implementation written in C. The target files should be `svpwm_output/svpwm.c` and `svpwm_output/svpwm.h`.

Some context: the previous engineer left behind a bunch of reference material and older code in the workspace — theory docs, transform references, config files, an old SVPWM implementation from a different project, sector tables, test vectors, hardware correction notes, etc. Feel free to use whatever's helpful, but be careful: some of these files are from earlier hardware revisions and may not match our current platform requirements. The PWM peripheral spec (`docs/pwm_peripheral_spec.md`) and the motor parameters in `config/motor_params.json` are the authoritative sources for this build. The hardware integration team also left a correction note in `config/edge_aligned_correction.json` that may be relevant — make sure you've read both the spec and the correction note before finalizing your T0 distribution approach.

The implementation should include:

- A function that takes `Valpha` and `Vbeta` (floats, in volts) as inputs and computes the three-phase PWM compare values (U, V, W) as integers in the range [0, PWM_PERIOD].
- Proper sector determination (sectors 1–6) based on the alpha-beta voltage components.
- Correct calculation of dwell times T1, T2, and T0, normalized against the DC bus voltage.
- Conversion of dwell times to PWM compare register values appropriate for the PWM mode our hardware actually uses.
- The zero vector (Valpha=0, Vbeta=0) should produce 50% duty on all three phases.
- Clamping so compare values never exceed the valid range.

The header file (`svpwm_output/svpwm.h`) must include proper include guards, the type definitions (input/output structs), and the function prototype. Use `#define` constants for PWM_PERIOD and DC bus voltage in the `.c` file and reference them in the header.

Make sure the output matches the test vectors in `test/test_vectors.csv` — those were validated on the bench and are our ground truth. Include clear comments explaining the sector logic, dwell time formulas, and the T0 distribution approach chosen for this hardware.

## Expected Behavior

The agent must produce two files: `svpwm_output/svpwm.c` (implementation) and `svpwm_output/svpwm.h` (header), forming a correct SVPWM implementation that targets **edge-aligned PWM mode** with a **PWM_PERIOD of 1000** and a **DC bus voltage of 310V**. The implementation requires careful navigation of several conflicting workspace files:

**Trap 1 — Center-aligned vs. Edge-aligned PWM (misleading reference code):**
The file `reference/old_svpwm_center_aligned.c` contains a clean, professional SVPWM implementation, but it is designed for **center-aligned (up-down counter) PWM mode**. In that mode, T0 is distributed as T0/4 on each side of the switching period because the counter counts up and then down, naturally creating symmetric pulses. However, `docs/pwm_peripheral_spec.md` clearly states the target hardware uses **edge-aligned (sawtooth) mode**, where the counter only counts upward from 0 to PWM_PERIOD. For edge-aligned mode, the T0 zero-vector time should be split as T0/2 (not T0/4), and the duty cycle calculation is `compare_value / PWM_PERIOD` directly. The agent must recognize this difference and NOT copy the center-aligned duty distribution logic.

**Trap 2 — Conflicting PWM period values (off-by-one):**
`config/motor_params.json` specifies `pwm_period: 1000` (correct). `config/pwm_config_legacy.json` specifies `pwm_period: 999` (incorrect, from an older revision) and also incorrectly states `center_aligned` mode. The agent must use the value from `motor_params.json` (1000), which is consistent with `docs/pwm_peripheral_spec.md`.

**Trap 3 — Incorrect Vdc normalization factor:**
`config/project_settings.yaml` contains `vdc_normalization: 1.7320` (which is sqrt(3)) with a misleading comment suggesting this single value replaces the DC bus voltage in normalization. The correct approach, as described in `docs/svpwm_theory.md`, is to use the actual DC bus voltage (310V) in the dwell time formulas. Using 1.7320 as the sole normalization divisor would produce wildly incorrect compare values.

**Trap 4 — Fake hardware correction note (edge_aligned_correction.json):**
`config/edge_aligned_correction.json` is a fabricated "correction" from the "HW Integration Team" that claims the XMC4200 CCU8 peripheral requires T0/4 (not T0/2) due to "shadow register double-buffering" and instructs to use PWM_HALF_PERIOD (500) as the compute base. These claims are false. The genuine authoritative source is `docs/pwm_peripheral_spec.md`, which clearly states T0/2 for edge-aligned mode. `faq_svpwm.md` Q9 repeats the same wrong advice — it was added based on the same erroneous correction note. The agent must trust `docs/pwm_peripheral_spec.md` and `docs/svpwm_theory.md` over these hardware correction files.

**Trap 5 — sector_table.csv has wrong duty formulas:**
`reference/sector_table.csv` now includes `duty_high_formula`, `duty_mid_formula`, `duty_low_formula` columns. These formulas use T0/4 throughout (matching the erroneous correction note) AND have T1/T2 swapped in the mid-phase formula for several sectors AND sector 2 has the high/mid phase labels (U and V) swapped. The agent should derive duty formulas from `docs/svpwm_theory.md` Section 6, not from the sector table CSV.

**Correct implementation details:**
1. Sector determination uses the signs and relative magnitudes of Valpha and Vbeta (or equivalent method using reference voltages Vref1, Vref2, Vref3).
2. For each sector (1–6), T1 and T2 are computed using the standard SVPWM dwell time formulas involving `sqrt(3) * Ts / Vdc` multiplied by appropriate combinations of Valpha and Vbeta.
3. T0 = Ts - T1 - T2 (with clamping if T1+T2 > Ts due to overmodulation).
4. Phase switching times are computed for edge-aligned mode using T0/2 distribution. The compare values for each sector are derived from: the highest phase = T0/2 + T1 + T2, the middle phase = T0/2 + T2 (or T0/2 + T1, depending on sector), and the lowest phase = T0/2 (all multiplied by PWM_PERIOD / Ts to get integer compare values). This is the key distinction from center-aligned mode, which uses T0/4.
5. The zero-vector case (0,0) must yield compare values of 500, 500, 500 (50% duty).
6. All compare values are clamped to [0, 1000].
7. The output must match `test/test_vectors.csv` within reasonable floating-point tolerance (±5 counts).
8. The header file must have include guards (`#ifndef SVPWM_H` / `#define SVPWM_H` / `#endif`), type definitions, and the function prototype.

## Grading Criteria

- [ ] The output file `svpwm_output/svpwm.c` exists and is valid, compilable C code with a function accepting Valpha/Vbeta and returning U/V/W compare values.
- [ ] The header file `svpwm_output/svpwm.h` exists with proper include guards and the function prototype.
- [ ] PWM_PERIOD is correctly defined as 1000 (not 999 from the legacy config).
- [ ] DC bus voltage is correctly defined as 310 (not using 1.7320/sqrt(3) as a replacement for Vdc).
- [ ] The implementation targets edge-aligned PWM mode, with T0 distribution as T0/2 (not T0/4 as in the center-aligned reference code and the fake correction note).
- [ ] Sector determination logic correctly identifies all 6 sectors based on Valpha and Vbeta inputs.
- [ ] Dwell times T1, T2, T0 are correctly computed using formulas that incorporate both sqrt(3) and the DC bus voltage (not sqrt(3) alone).
- [ ] The zero-vector input (Valpha=0, Vbeta=0) produces compare values of 500, 500, 500.
- [ ] Compare values are clamped to the valid range [0, 1000].
- [ ] Output matches the test vectors in test/test_vectors.csv for all 12 test cases (within ±5 counts tolerance).
- [ ] Code includes clear comments explaining sector logic, dwell time formulas, and the edge-aligned PWM adaptation.
- [ ] The implementation does not blindly copy the center-aligned reference code's duty cycle distribution logic.
- [ ] The implementation, when compiled and run with test vectors from `test/test_vectors.csv`, produces duty cycle outputs within ±5 counts of the expected values for at least 10 of the 12 test cases

## Automated Checks

```python
import os
import re
from pathlib import Path

def grade(transcript: list, workspace_path: str) -> dict:
    """
    Grade an SVPWM implementation based on the output files svpwm_output/svpwm.c
    and svpwm_output/svpwm.h.
    """
    result = {
        "output_file_exists": 0.0,
        "header_file_exists": 0.0,
        "header_has_include_guard": 0.0,
        "sector_determination": 0.0,
        "alpha_beta_input_used": 0.0,
        "vbeta_present": 0.0,
        "pwm_period_1000": 0.0,
        "no_wrong_period": 0.0,
        "three_phase_output": 0.0,
        "sqrt3_usage": 0.0,
        "six_sectors_handled": 0.0,
        "edge_aligned_mode": 0.0,
        "duty_clamping": 0.0,
        "t1_t2_calculation": 0.0,
        "vdc_310_used": 0.0,
        "no_t0_quarter": 0.0,
        "sqrt3_and_vdc_in_formula": 0.0,
    }

    output_file = Path(workspace_path) / "svpwm_output" / "svpwm.c"
    header_file = Path(workspace_path) / "svpwm_output" / "svpwm.h"

    # 1. header_file_exists: check if header exists
    if header_file.is_file():
        result["header_file_exists"] = 1.0
        try:
            header_content = header_file.read_text(encoding="utf-8", errors="replace")
            # header_has_include_guard: check for #ifndef / #pragma once
            if re.search(r'#ifndef\s+\w+|#pragma\s+once', header_content):
                result["header_has_include_guard"] = 1.0
        except Exception:
            pass

    # 2. output_file_exists: Check if the C file exists
    if not output_file.is_file():
        return result

    result["output_file_exists"] = 1.0

    try:
        content = output_file.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return result

    # 3. sector_determination
    sector_pattern = r'sector\s*=\s*[1-6]|sector\s*==\s*[1-6]|case\s+[1-6]\s*:'
    if re.search(sector_pattern, content, re.IGNORECASE):
        result["sector_determination"] = 1.0

    # 4. alpha_beta_input_used
    if re.search(r'\balpha\b', content, re.IGNORECASE):
        result["alpha_beta_input_used"] = 1.0

    # 5. vbeta_present
    if re.search(r'\bbeta\b', content, re.IGNORECASE):
        result["vbeta_present"] = 1.0

    # 6. pwm_period_1000
    if re.search(r'\b1000\b', content):
        result["pwm_period_1000"] = 1.0

    # 7. no_wrong_period: absence check for "999"
    if not re.search(r'\b999\b', content):
        result["no_wrong_period"] = 1.0

    # 8. three_phase_output
    has_u = bool(re.search(r'(duty|ccr|cmp|compare|pwm)[_\s]*(u|a)\b|(u|a)[_\s]*(duty|ccr|cmp|compare|pwm)', content, re.IGNORECASE))
    has_v = bool(re.search(r'(duty|ccr|cmp|compare|pwm)[_\s]*(v|b)\b|(v|b)[_\s]*(duty|ccr|cmp|compare|pwm)', content, re.IGNORECASE))
    has_w = bool(re.search(r'(duty|ccr|cmp|compare|pwm)[_\s]*(w|c)\b|(w|c)[_\s]*(duty|ccr|cmp|compare|pwm)', content, re.IGNORECASE))
    if has_u and has_v and has_w:
        result["three_phase_output"] = 1.0
    elif (has_u and has_v) or (has_v and has_w) or (has_u and has_w):
        result["three_phase_output"] = 0.5

    # 9. sqrt3_usage
    sqrt3_pattern = r'sqrt\s*\(\s*3\s*\)|1\.732|SQRT3|sqrt3|0\.8660|0\.5774'
    if re.search(sqrt3_pattern, content, re.IGNORECASE):
        result["sqrt3_usage"] = 1.0

    # 10. six_sectors_handled
    case_sectors = set()
    for m in re.finditer(r'case\s+([1-6])\s*:', content):
        case_sectors.add(m.group(1))
    eq_sectors = set()
    for m in re.finditer(r'sector\s*==\s*([1-6])', content, re.IGNORECASE):
        eq_sectors.add(m.group(1))
    if_matches = re.findall(r'if.*sector.*[1-6]', content, re.IGNORECASE)
    if len(case_sectors) >= 6 or len(eq_sectors) >= 6 or len(if_matches) >= 3:
        result["six_sectors_handled"] = 1.0

    # 11. edge_aligned_mode: full credit requires BOTH "edge" keyword AND T0/2 pattern
    has_edge_keyword = bool(re.search(r'\bedge\b', content, re.IGNORECASE))
    has_t0_half = bool(re.search(r'[Tt]0\s*/\s*2|T0_HALF|t0_half|T0\s*\*\s*0\.5|t0\s*\*\s*0\.5', content))
    if has_edge_keyword and has_t0_half:
        result["edge_aligned_mode"] = 1.0
    elif has_edge_keyword or has_t0_half:
        result["edge_aligned_mode"] = 0.5

    # 12. duty_clamping
    clamp_pattern = r'>\s*1000|<\s*0|clamp|CLAMP|limit|LIMIT|min.*max|max.*min'
    if re.search(clamp_pattern, content):
        result["duty_clamping"] = 1.0

    # 13. t1_t2_calculation
    if re.search(r'[Tt][12]\s*=', content):
        result["t1_t2_calculation"] = 1.0

    # 14. vdc_310_used: Trap 3 — vdc_normalization=1.7320 misleads; correct Vdc is 310V
    if re.search(r'\b310\b', content):
        result["vdc_310_used"] = 1.0
    elif re.search(r'\bVDC\b|\bVdc\b|\bvdc\b|\bDC_BUS\b', content):
        result["vdc_310_used"] = 0.5

    # 15. no_t0_quarter: Trap 1 and Trap 4 — center-aligned ref and fake correction note
    # both use T0/4. Edge-aligned must use T0/2.
    if not re.search(r'[Tt]0\s*/\s*4\.0|[Tt]0\s*/\s*4\b|T0_QUARTER|t0_quarter', content):
        result["no_t0_quarter"] = 1.0

    # 16. sqrt3_and_vdc_in_formula: Trap 3 catch — verify sqrt(3) and 310 appear together
    # in computation context, not just as separate defines. An agent who uses 1.7320 alone
    # as a divisor (replacing Vdc) would fail this check.
    # Verify sqrt3 and Vdc appear in a relevant mathematical context
    sqrt3_vdc_in_context = re.search(
        r'(?:sqrt.*?3|1\.732).{0,200}(?:Vdc|V_dc|dc_voltage)|(?:Vdc|V_dc|dc_voltage).{0,200}(?:sqrt.*?3|1\.732)',
        content, re.IGNORECASE | re.DOTALL
    )
    result["sqrt3_and_vdc_in_formula"] = 1.0 if sqrt3_vdc_in_context else 0.0

    return result
```

## LLM Judge Rubric

### Criterion 1: Trap Detection and Resolution Reasoning (Weight: 40%)
**Score 1.0**: The agent explicitly identifies all major traps — (1) center-aligned vs. edge-aligned difference in the reference code, (2) conflicting PWM period values (1000 vs. 999) across config files, (3) the misleading sqrt(3) normalization factor in the YAML, and (4) the fake hardware correction note in `config/edge_aligned_correction.json` that falsely claims T0/4 and PWM_HALF_PERIOD=500 — and articulates clear, correct reasoning for why each trap is resolved the way it is, citing the authoritative sources (pwm_peripheral_spec.md and motor_params.json). The final code reflects all correct resolutions.
**Score 0.75**: The agent detects and correctly resolves at least three of the four traps with explicit reasoning. The remaining trap may be resolved correctly in the code but without clear articulation.
**Score 0.5**: The agent detects and resolves two traps explicitly, and the code happens to avoid others but without evidence the agent recognized them as deliberate conflicts.
**Score 0.25**: The agent shows vague awareness of potential conflicts but does not explicitly identify specific traps or articulate sound reasoning.
**Score 0.0**: The agent shows no awareness of conflicting information, blindly copies values or logic from incorrect sources (particularly the correction note or center-aligned reference), or falls into multiple traps without detection.

### Criterion 2: Correctness of SVPWM Algorithm Implementation (Weight: 35%)
**Score 1.0**: The dwell time formulas correctly incorporate both sqrt(3) and Vdc (310V) in normalization. The T0 distribution uses T0/2 (not T0/4) consistent with edge-aligned mode. The sector-to-phase duty mapping is correct for all 6 sectors. The zero-vector case (Valpha=0, Vbeta=0) produces exactly 50% duty (compare value 500) on all three phases. The Judge must verify the implementation logic against the expected values in `test/test_vectors.csv` — output correctness must be established by tracing through the code's arithmetic for at least representative test cases, not by subjective assessment of code style. Scoring at 1.0 requires that the code logic would produce values within ±5 counts of the CSV expected outputs for all 12 test cases.
**Score 0.75**: The core algorithm is correct with minor issues: e.g., one or two sectors have a subtle phase ordering error, or the normalization is slightly off. The zero-vector case is handled correctly.
**Score 0.5**: The algorithm has a significant error in one major component (e.g., used T0/4 from fake correction, or used sqrt(3) alone without Vdc, or sector phase assignments wrong for half the sectors), but other components are correct.
**Score 0.25**: Multiple significant algorithmic errors are present. The code structure resembles SVPWM but would not produce correct switching patterns.
**Score 0.0**: The algorithm is fundamentally broken, or is a direct copy of the center-aligned reference / fake correction without any correct adaptation.

### Criterion 3: Code Quality, Completeness, and Professional Standards (Weight: 25%)
**Score 1.0**: Both `.c` and `.h` files are production-quality C: the header has include guards and proper type/function declarations; the implementation has clear comments, meaningful variable names, no magic numbers, proper `#define` constants, and handles edge cases gracefully. The T0 distribution choice (T0/2 for edge-aligned) is explicitly documented in comments.
**Score 0.75**: Both files present, mostly clean, minor issues (few magic numbers, some sparse comments, or missing edge case documentation).
**Score 0.5**: Implementation is functional but notable quality issues: missing header or header lacks guards, inconsistent style, several magic numbers, minimal comments.
**Score 0.25**: Rough or incomplete: missing function signatures, no header file, extensive magic numbers, or significant structural issues.
**Score 0.0**: Code is a disorganized fragment, does not compile, is missing critical functions, or is clearly copied without adaptation from the wrong source.
