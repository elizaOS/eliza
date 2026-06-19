---
id: task_00100_house_robber_algorithm_deep_dive_explanation
name: House Robber Algorithm Deep-Dive Explanation
category: Research and Information Retrieval
grading_type: hybrid
timeout_seconds: 1800
workspace_files:
- source: problems/house_robber_description.md
  dest: problems/house_robber_description.md
- source: problems/house_robber_ii_description.md
  dest: problems/house_robber_ii_description.md
- source: references/dp_notes.md
  dest: references/dp_notes.md
- source: references/wrong_recurrence_blog.md
  dest: references/wrong_recurrence_blog.md
- source: test_cases/test_cases.json
  dest: test_cases/test_cases.json
- source: test_cases/test_cases_verified.json
  dest: test_cases/test_cases_verified.json
- source: test_cases/edge_cases_notes.md
  dest: test_cases/edge_cases_notes.md
- source: references/complexity_cheatsheet.csv
  dest: references/complexity_cheatsheet.csv
- source: solutions/greedy_attempt.py
  dest: solutions/greedy_attempt.py
- source: solutions/recursive_solution.py
  dest: solutions/recursive_solution.py
grading_weights:
  automated: 0.55
  llm_judge: 0.45
subcategory: Technical and Engineering Research
---
## Prompt

I'm prepping a study guide for our junior engineers on the classic House Robber problem (LeetCode 198 — the linear one, not the circular variant). I've gathered a bunch of reference material in the workspace. What I need from you: go through all the material, synthesize it, and write a thorough yet readable explanation document saved to `solution/house_robber_explanation.md`. The document should cover:

- A clear statement of the problem (the linear version only)
- Why a greedy approach fails, with a concrete counterexample
- The correct DP recurrence relation, with a precise definition of what `dp[i]` represents, make sure the definition and the recurrence are actually consistent with each other
- A walkthrough of the DP solution on at least one example from the test cases
- Time and space complexity analysis for both the O(n)-space tabulation approach and the space-optimized O(1) approach using rolling variables
- A brief mention of edge cases worth testing

Be careful with the reference material, use your own judgment if something looks off. The junior engineers will be reading this closely, so accuracy matters more than speed. Besides the explanation doc, also create `solution/verified_results.json` as a small executable-style validation artifact. It must be a JSON array where each item has:
- `input` (array of ints)
- `max_loot` (int)

Include at least these two test cases with correct values:
- `[2, 7, 9, 3, 1] -> 12`
- `[2, 1, 1, 2] -> 4`

## Expected Behavior

The agent must read and cross-reference all workspace files, identify inconsistencies, and produce a correct, well-organized explanation document at `solution/house_robber_explanation.md`.

**Trap 1 — Inconsistent recurrence in `references/wrong_recurrence_blog.md`:**
The blog at `references/wrong_recurrence_blog.md` defines `dp[i]` as "the max money robbing houses 0..i where house i IS robbed" but then writes the recurrence as `dp[i] = max(dp[i-1], dp[i-2] + nums[i-1])`. This is internally inconsistent: if `dp[i]` requires that house `i` is robbed, then `dp[i-1]` (which requires house `i-1` is robbed) cannot be a valid option since houses `i` and `i-1` are adjacent. The correct approach, as shown in `references/dp_notes.md`, defines `dp[i]` as the maximum amount obtainable from the first `i` houses (whether or not house `i` is robbed), with recurrence `dp[i] = max(dp[i-1], dp[i-2] + nums[i])`. The agent should use the definition from `dp_notes.md` and NOT copy the blog's inconsistent formulation. Note: the blog's IMPLEMENTATION actually produces correct results for the test cases (because 1-indexed dp with `nums[i-1]` is a valid correct implementation pattern), which makes this trap harder — the inconsistency is in the DEFINITION, not in the output values.

**Trap 2 — Incorrect space complexity in `references/complexity_cheatsheet.csv`:**
The CSV file `references/complexity_cheatsheet.csv` lists the space complexity of "House Robber (optimized)" as O(n), which is incorrect. The space-optimized version uses only two rolling variables, giving O(1) extra space. The correct information is in `references/dp_notes.md`, which explains the space optimization pattern. Other entries in the CSV (like Fibonacci O(1), Climbing Stairs O(1)) are correct, making the House Robber entry a subtle error. The agent should report O(1) space for the optimized solution.

**Trap 3 — Wrong expected values in `test_cases/test_cases_verified.json`:**
The file `test_cases/test_cases_verified.json` claims to be "verified" test cases, but contains two incorrect expected values: `[2, 7, 9, 3, 1]` is listed as expected=11 (correct is 12), and `[2, 1, 1, 2]` is listed as expected=3 (correct is 4). The file even includes misleading "notes" explaining the wrong answers. The notes for `[2,7,9,3,1]` show a partial DP trace that stops at dp[2]=11 without computing dp[3] and dp[4], creating a believable but truncated calculation. The notes for `[2,1,1,2]` mention "greedy picks... = 3" as if that were the correct answer. The agent must verify these results independently using the recurrence relation. The authoritative test cases in `test_cases/test_cases.json` have the correct values (12 and 4 respectively). An agent that copies the "verified" values without re-deriving them will produce a walkthrough with incorrect results.

**Noise files:** The agent should focus on the linear House Robber (LeetCode 198) from `problems/house_robber_description.md` and NOT incorporate the circular variant from `problems/house_robber_ii_description.md`. The greedy attempt in `solutions/greedy_attempt.py` should be referenced only to explain why greedy fails. The recursive solution in `solutions/recursive_solution.py` can be referenced as a valid memoized approach.

**Correct output should include:**
1. Problem statement for linear House Robber only
2. Greedy failure explanation with counterexample (e.g., `[2,1,1,2]` → a naive greedy picks indices 0 and 2 = 1+1 = 2 or = 2+1 = 3, but the optimal is 4 by picking indices 0 and 3)
3. Correct dp[i] definition: max money from houses 0 through i (whether or not house i is robbed)
4. Correct recurrence: `dp[i] = max(dp[i-1], dp[i-2] + nums[i])`
5. Walkthrough on `[1,2,3,1]` → 4 OR `[2,7,9,3,1]` → 12 (NOT 11 from the trap file)
6. Time: O(n) for both tabulation and optimized; Space: O(n) for tabulation, O(1) for optimized
7. Edge cases: single house, two houses, all zeros, etc.
8. `solution/verified_results.json` exists and includes correct computed outputs for the required trap-sensitive test cases (`[2,7,9,3,1] -> 12`, `[2,1,1,2] -> 4`)

## Grading Criteria

- [ ] The output file exists at `solution/house_robber_explanation.md` and is non-empty
- [ ] The explanation addresses the linear House Robber problem (LeetCode 198) and does NOT conflate it with the circular House Robber II variant
- [ ] A concrete counterexample is provided showing why a greedy approach fails for this problem
- [ ] The `dp[i]` definition is correct and consistent with the recurrence (dp[i] represents max money from the first i houses regardless of whether house i is robbed; NOT the blog's incorrect "house i IS robbed" definition)
- [ ] The recurrence relation is stated correctly as `dp[i] = max(dp[i-1], dp[i-2] + nums[i])` (or an equivalent correct formulation)
- [ ] At least one example from the test cases is walked through step-by-step showing how the DP table is filled, with correct expected values (e.g., `[2,7,9,3,1]` → 12, NOT 11 as incorrectly listed in test_cases_verified.json)
- [ ] Time complexity is correctly stated as O(n)
- [ ] Space complexity for the tabulation approach is correctly stated as O(n)
- [ ] Space complexity for the space-optimized approach is correctly stated as O(1) (NOT O(n) as the complexity cheatsheet incorrectly claims)
- [ ] Edge cases are mentioned (at minimum: single element array and two-element array)
- [ ] The explanation is well-organized, readable, and suitable for junior engineers as a study resource
- [ ] File `solution/verified_results.json` exists and is valid JSON
- [ ] `verified_results.json` contains the required two test cases with correct outputs: `[2,7,9,3,1] -> 12` and `[2,1,1,2] -> 4`

## Automated Checks

```python
import os
import re
from pathlib import Path

def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the house_robber_explanation.md output file."""
    
    result = {
        "output_file_exists": 0.0,
        "dp_definition_section": 0.0,
        "correct_dp_definition": 0.0,
        "state_transition_formula": 0.0,
        "base_case_mentioned": 0.0,
        "python_code_present": 0.0,
        "o1_space_implementation": 0.0,
        "no_wrong_space_complexity": 0.0,
        "example_walkthrough": 0.0,
        "correct_example_answer": 0.0,   # walkthrough gives correct values, not trap values
        "time_complexity": 0.0,
        "adjacent_constraint_explained": 0.0,
        "verified_results_json_exists": 0.0,
        "verified_results_json_valid": 0.0,
        "verified_results_required_cases_correct": 0.0,
    }
    
    output_file = Path(workspace_path) / "solution" / "house_robber_explanation.md"
    
    # 1. output_file_exists
    if not output_file.is_file():
        return result
    result["output_file_exists"] = 1.0
    
    content = output_file.read_text(encoding="utf-8", errors="replace")
    content_lower = content.lower()
    
    # 2. dp_definition_section: section heading about DP state/definition
    # Original required "dp[i]" literally in the heading, which is too strict — valid headings
    # like "DP State Definition", "State Transition", "Recurrence Relation", or
    # "Dynamic Programming Formulation" would all fail. Broadened to accept any heading
    # that covers DP definition/recurrence/transition concepts.
    if re.search(r"(?im)^#{1,6}\s+.*(dp\[i\]|state\s+(definition|transition)|recurrence|dp\s+(definition|formulation|state)|transition\s+formula)", content):
        result["dp_definition_section"] = 1.0
    
    # 3. correct_dp_definition: dp[i] is defined as max money from first i houses
    # Original: just required "dp[i]" and "max" in the same paragraph, which is far too loose —
    # even the wrong blog definition (dp[i] = max money when house i IS robbed) would pass.
    # Tightened: require a meaningful correct definition — dp[i] associated with "first i houses"
    # or "first i" (regardless of whether house i is robbed), OR the 0-indexed equivalent.
    paragraphs = re.split(r"\n\s*\n", content)
    for para in paragraphs:
        if "dp[i]" in para and re.search(
            r"(?i)(first\s+i\s+(house|element|index)|max(imum)?.{0,60}(first\s+i|i\s+house)|"
            r"consider(ing)?.{0,40}first\s+i|houses?\s+0\s*(to|through|\.\.)\s*i)",
            para
        ):
            result["correct_dp_definition"] = 1.0
            break
    # Partial credit: dp[i] + "max" in same para (may still be a valid but less explicit def)
    if result["correct_dp_definition"] == 0.0:
        for para in paragraphs:
            if "dp[i]" in para and re.search(r"\bmax\b", para, re.IGNORECASE):
                result["correct_dp_definition"] = 0.5
                break
    
    # 4. state_transition_formula: regex_match for correct DP recurrence.
    # Accept both argument orderings (max is commutative) and both index styles:
    #   0-indexed: dp[i] = max(dp[i-1], dp[i-2] + nums[i])
    #   1-indexed: dp[i] = max(dp[i-1], dp[i-2] + nums[i-1])
    # The 1-indexed form is a valid correct formulation (e.g., dp array of size n+1).
    pattern_fwd = r"dp\[i\]\s*=\s*max\(\s*dp\[i\s*-\s*1\]\s*,\s*dp\[i\s*-\s*2\]\s*\+\s*nums\[i(?:\s*-\s*1)?\]\s*\)"
    pattern_rev = r"dp\[i\]\s*=\s*max\(\s*dp\[i\s*-\s*2\]\s*\+\s*nums\[i(?:\s*-\s*1)?\]\s*,\s*dp\[i\s*-\s*1\]\s*\)"
    if re.search(pattern_fwd, content) or re.search(pattern_rev, content):
        result["state_transition_formula"] = 1.0
    elif re.search(r"dp\[i\]\s*=\s*max\(.{0,60}dp\[i\s*-\s*1\].{0,60}dp\[i\s*-\s*2\]", content):
        result["state_transition_formula"] = 0.5
    
    # 5. base_case_mentioned: content_contains "base case" with word boundaries
    if re.search(r"\bbase\s+case\b", content_lower):
        result["base_case_mentioned"] = 1.0
    
    # 6. python_code_present: regex_match for def rob(nums...)
    if re.search(r"def\s+rob\s*\(\s*nums", content):
        result["python_code_present"] = 1.0
    
    # 7. o1_space_implementation: O(1) space for the optimized rolling-variable approach
    # Original: any occurrence of "O(1)" anywhere passes — could match O(1) lookup time,
    # O(1) access in a list, etc. Tightened to require O(1) in the context of space complexity
    # for the space-optimized or rolling-variable approach.
    if re.search(
        r"O\(1\).{0,60}(space|memory|extra)"
        r"|(space|memory|extra).{0,60}O\(1\)"
        r"|(optim|rolling|two\s+var|space.optim).{0,80}O\(1\)",
        content,
        re.IGNORECASE
    ):
        result["o1_space_implementation"] = 1.0
    elif re.search(r"O\(1\)", content):
        result["o1_space_implementation"] = 0.5
    
    # 8. no_wrong_space_complexity: the space-optimized approach must NOT be labeled O(n) space.
    # Original: penalized ANY occurrence of "O(n) space" in the document. This is a critical bug
    # because a correct explanation MUST say "O(n) space" for the tabulation approach — the task
    # prompt explicitly asks to cover "the O(n)-space tabulation approach". So a correct document
    # always has "O(n) space" (for tabulation) AND "O(1) space" (for optimized). The original
    # check gives 0 for every correct answer.
    # Fixed: only penalize when "O(n)" is associated with the OPTIMIZED/rolling-variable solution.
    # Check: if O(n) space appears immediately near "optim" or "rolling" or "O(1) space" is not
    # present at all in a space context, flag as wrong. Otherwise correct.
    has_on_for_optimized = bool(re.search(
        r"(?i)(optim|rolling|two\s+var|space.optim).{0,100}O\(n\)\s*space|"
        r"O\(n\)\s*space.{0,100}(optim|rolling|two\s+var|space.optim)",
        content
    ))
    has_o1_space = bool(re.search(
        r"O\(1\).{0,60}(space|memory|extra)|(space|memory|extra).{0,60}O\(1\)",
        content,
        re.IGNORECASE
    ))
    if has_on_for_optimized or not has_o1_space:
        result["no_wrong_space_complexity"] = 0.0
    else:
        result["no_wrong_space_complexity"] = 1.0
    
    # 9. example_walkthrough: regex_match for example arrays
    example_pattern = r"(\[1,\s*2,\s*3,\s*1\]|\[2,\s*7,\s*9,\s*3,\s*1\])"
    if re.search(example_pattern, content):
        result["example_walkthrough"] = 1.0

    # 9b. correct_example_answer: the walkthrough uses the correct expected values.
    # Trap: test_cases_verified.json claims [2,7,9,3,1] -> 11 and [2,1,1,2] -> 3.
    # Correct values: [2,7,9,3,1] -> 12, [2,1,1,2] -> 4, [1,2,3,1] -> 4.
    # Check that "12" appears near the [2,7,9,3,1] array context, and that "11" does NOT
    # appear as its expected output.
    has_correct_12 = bool(re.search(
        r"\[2,\s*7,\s*9,\s*3,\s*1\].{0,300}(?<!\d)12(?!\d)|(?<!\d)12(?!\d).{0,300}\[2,\s*7,\s*9,\s*3,\s*1\]",
        content
    ))
    has_trap_11 = bool(re.search(
        r"\[2,\s*7,\s*9,\s*3,\s*1\].{0,200}(?<!\d)11(?!\d)\b.{0,50}(?:expected|result|output|answer|=)|"
        r"(?:expected|result|output|answer)\s*[=:]\s*11(?!\d).{0,200}\[2,\s*7,\s*9,\s*3,\s*1\]",
        content
    ))
    has_correct_4 = bool(re.search(
        r"\[1,\s*2,\s*3,\s*1\].{0,300}(?<!\d)4(?!\d)|(?<!\d)4(?!\d).{0,300}\[1,\s*2,\s*3,\s*1\]",
        content
    ))
    # Providing the correct answer (12) proves the trap was identified, not fallen into.
    # has_trap_11 only matters when 12 is absent (agent truly copied the wrong value).
    if has_correct_12:
        result["correct_example_answer"] = 1.0 if has_correct_4 else 0.75
    elif has_correct_4 and not has_trap_11:
        result["correct_example_answer"] = 0.5

    # 10. time_complexity: content_contains "O(n)"
    if re.search(r"O\(n\)", content):
        result["time_complexity"] = 1.0
    
    # 11. adjacent_constraint_explained: "adjacent/consecutive/neighboring" + prohibition in same para
    for para in paragraphs:
        para_lower = para.lower()
        if (re.search(r"\b(adjacent|consecutive|neighboring)\b", para_lower)
                and re.search(r"\b(cannot|can.?t|must.not|not.allowed|forbidden)\b", para_lower)):
            result["adjacent_constraint_explained"] = 1.0
            break

    # 12-14. verified_results_json_* checks: require structured, machine-checkable outputs
    import json
    results_path = Path(workspace_path) / "solution" / "verified_results.json"
    if results_path.is_file():
        result["verified_results_json_exists"] = 1.0
        try:
            data = json.loads(results_path.read_text(encoding="utf-8", errors="replace"))
            if isinstance(data, list):
                result["verified_results_json_valid"] = 1.0
                required_map = {
                    (2, 7, 9, 3, 1): 12,
                    (2, 1, 1, 2): 4,
                }
                hits = 0
                for item in data:
                    if not isinstance(item, dict):
                        continue
                    arr = item.get("input")
                    val = item.get("max_loot")
                    if isinstance(arr, list) and isinstance(val, int):
                        key = tuple(arr)
                        if key in required_map and required_map[key] == val:
                            hits += 1
                if hits == 2:
                    result["verified_results_required_cases_correct"] = 1.0
                elif hits == 1:
                    result["verified_results_required_cases_correct"] = 0.5
        except Exception:
            pass
    
    return result
```

## LLM Judge Rubric

### Criterion 1: Detection and Resolution of Data Contradictions (Weight: 35%)
**Score 1.0**: The agent correctly handles all three traps: (1) uses the correct dp[i] definition (max from first i houses, not "house i IS robbed") and explains why the blog's definition is inconsistent with the recurrence it uses; (2) reports O(1) space for the optimized solution, not O(n) as the cheatsheet claims; (3) verifies test case expected values independently and reports `[2,7,9,3,1]` → 12 and `[2,1,1,2]` → 4, not the wrong values (11, 3) in test_cases_verified.json. The reasoning shows explicit critical evaluation of source material.
**Score 0.75**: The agent correctly resolves two of the three traps and either silently corrects or misses the third. All values in the final document are correct.
**Score 0.5**: The agent correctly handles one trap but falls for one of the remaining two (e.g., uses the wrong dp[i] definition from the blog OR reports 11 for the `[2,7,9,3,1]` walkthrough but gets space complexity right). The final document has at most one factual error traceable to a trap.
**Score 0.25**: The agent falls for two or more traps — e.g., both copies the blog's inconsistent definition and uses the wrong expected value 11 for the five-house example, or both reports O(n) for the optimized and gives the wrong walkthrough answer.
**Score 0.0**: The agent falls for all three traps or produces a document with multiple factual errors showing no critical evaluation of the conflicting source material.

### Criterion 2: Greedy Failure Explanation Quality (Weight: 20%)
**Score 1.0**: Provides a concrete numerical counterexample demonstrating why greedy fails (e.g., always picking the largest, or alternating even/odd indices), walks through the greedy strategy step-by-step showing the suboptimal result, and contrasts it with the optimal DP result. The explanation is intuitive and would genuinely help a junior engineer understand the limitation.
**Score 0.75**: Provides a valid counterexample and explains why greedy fails, but the walkthrough is somewhat brief or the contrast with the optimal solution could be clearer.
**Score 0.5**: Mentions that greedy fails and gives a counterexample, but the explanation is superficial — doesn't clearly walk through why the greedy choice leads to a worse outcome, or the counterexample is stated without sufficient detail.
**Score 0.25**: States that greedy fails but provides no concrete counterexample, or the counterexample given doesn't actually demonstrate the failure convincingly.
**Score 0.0**: Does not address why greedy fails, or incorrectly claims greedy works, or the explanation is fundamentally wrong.

### Criterion 3: Pedagogical Clarity and Document Organization (Weight: 25%)
**Score 1.0**: The document is exceptionally well-organized with clear section headings that follow a logical progression (problem statement → why greedy fails → DP formulation → walkthrough → complexity → edge cases). Explanations build on each other, the tone is appropriate for junior engineers, technical terms are introduced before use, and the document reads as a cohesive study guide rather than a collection of disconnected facts. The DP walkthrough is step-by-step and easy to follow.
**Score 0.75**: The document is well-organized and mostly reads well, but has minor issues: perhaps one section feels out of place, a transition is abrupt, or a concept is used before being fully introduced. Overall still effective as a study guide.
**Score 0.5**: The document covers the required topics but the organization is somewhat disjointed — sections may not flow logically into each other, explanations may be too terse or too verbose in places, or the tone inconsistently shifts between overly academic and casual. A junior engineer could learn from it but would need to work harder than necessary.
**Score 0.25**: The document is poorly organized, with topics scattered or repeated, explanations that are confusing or assume too much background knowledge, or significant gaps in the logical flow that would leave a junior engineer struggling to follow.
**Score 0.0**: The document is incoherent, disorganized to the point of being unusable as a study guide, or largely consists of raw copied material without synthesis or clear explanation.

### Criterion 4: Code Implementation Quality and Consistency with Explanation (Weight: 20%)
**Score 1.0**: The Python implementation is fully correct and produces the right answers for all test cases. Both the O(n)-space tabulation version and the O(1) rolling-variable version are present and properly implemented. The code is consistent with the dp[i] definition and recurrence explained in the document — the same index style used in the explanation is used in the code. The agent does not copy the wrong `test_cases_verified.json` values into the code or manually compute incorrect expected outputs.
**Score 0.75**: The main implementation (at least the O(1) rolling-variable version) is correct and consistent with the explanation. A minor issue exists — e.g., a base-case edge handling is slightly off, or the tabulation version is sketched rather than fully implemented — but the core logic is sound.
**Score 0.5**: The implementation contains one logical error that does not affect the test cases shown but would fail on some valid input (e.g., off-by-one on base case, wrong array bounds), or the code is correct but uses a different index convention than the explanation without reconciling the two.
**Score 0.25**: The implementation has significant bugs that produce wrong results, or the code is correct but clearly copy-pasted from a reference without any tie to the document's own dp[i] definition and walkthrough.
**Score 0.0**: No Python implementation is present, or the code is fundamentally wrong (e.g., greedy logic, wrong recurrence, produces incorrect outputs on the given test cases).