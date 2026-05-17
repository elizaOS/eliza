---
id: task_00059_user_discount_calculator
name: User Discount Calculator
category: Data Analysis and Modeling
subcategory: Statistical Analysis and Modeling
grading_type: hybrid
grading_weights:
  automated: 0.7
  llmjudge: 0.3
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- role: input
  description: JSON file containing tier discount percentages, loyalty bonus rules, spending bonus thresholds, and maximum discount cap.
  source: data/discount_rules.json
  dest: data/discount_rules.json
- role: input
  description: CSV file with user records including membership tier, signup date, total spent, order count, and active status.
  source: data/users.csv
  dest: data/users.csv
- role: input
  description: CSV file with product listings including prices and categories.
  source: data/product_catalog.csv
  dest: data/product_catalog.csv
- role: context
  description: JSON file with promotional campaigns and coupon codes (not required for core discount calculation).
  source: config/promotion_schedule.json
  dest: config/promotion_schedule.json
- role: context
  description: Internal policy document describing the discount rules in human-readable form.
  source: docs/discount_policy.md
  dest: docs/discount_policy.md
---
## Prompt

I need a Python script saved as `discount_calculator.py` that calculates discounts for users in our workspace data.

Use the discount rules and user data already provided. The script should be usable as code, not just a one-off notebook snippet. It needs to correctly determine each user’s discount based on the available rule sources, and it should hold up on edge cases in the data rather than relying on assumptions.

A few practical constraints:
- inactive users should not receive a discount
- there is a maximum overall discount
- cumulative-spend bonuses should be handled according to the actual rule definition, including threshold behavior
- membership duration matters, so don’t ignore dates
- there are extra files in the workspace; only use files that are actually relevant to this calculation

Please make the program runnable and include a reusable calculation entry point (function and/or class) so another developer could import it.

## Expected Behavior

The agent should inspect the workspace and create `discount_calculator.py` that correctly implements the discount logic from the provided rule sources.

### Core requirements

1. **Read the actual rules from the provided rule source(s)** rather than inventing a separate ruleset.
   - The authoritative machine-readable source is `data/discount_rules.json`.
   - `docs/discount_policy.md` is supporting context and should not override the JSON if a model invents conflicting values.
   - `config/promotion_schedule.json` and `data/product_catalog.csv` are irrelevant to the required discount calculation and should not be used to alter user discounts.

2. **Implement membership tier base discounts** using the configured tier mapping:
   - bronze → 0%
   - silver → 5%
   - gold → 10%
   - platinum → 15%

3. **Implement spending bonus threshold logic correctly**:
   - spend ≥ 1000 → +2%
   - spend ≥ 3000 → +5%
   - **Do not stack spending thresholds**. A user qualifying for 3000 gets +5%, not +7%.

4. **Implement loyalty bonus based on membership duration**:
   - users who have been members for **2 or more years** receive +3%
   - this requires parsing `signup_date`
   - evaluations should be computed as of **2025-07-01**

5. **Implement inactive-user handling correctly**:
   - if `is_active=False`, final discount must be **0% regardless of all other fields**

6. **Implement maximum discount cap**:
   - final discount must not exceed **25%**

7. **Provide reusable program structure**:
   - the file must be valid Python
   - it must expose at least one function or class implementing discount calculation logic
   - it should be importable and runnable without crashing

### Important traps / judgment points

A correct solution must handle the following correctly:

- **Trap A: inactive overrides everything**
  - An inactive gold user with enough spend and enough tenure still gets 0%.
- **Trap B: spending thresholds are highest-match, not cumulative**
  - Users above 3000 total spend get +5%, not +2% +5%.
- **Trap C: loyalty requires real date handling**
  - The logic should use `signup_date` relative to 2025-07-01, not just hardcode bonuses by user id.
- **Trap D: max cap is on final combined discount**
  - Even if components sum above the cap, the returned result must be capped.
- **Trap E: irrelevant files are noise**
  - Promotions and product catalog should not influence the answer.

### Ground Truth examples

These examples are evaluated from the provided assets as of **2025-07-01**:

- **USR-0005 (Mona Lee)**: gold (10%) + loyalty bonus (signup 2022-10-09, ≥2 years → +3%) + spending bonus ($4,045.28 → +5%) = **18%**
- **USR-0020 (Hank Taylor)**: platinum (15%) + loyalty bonus (signup 2022-11-12, ≥2 years → +3%) + spending bonus ($2,218.60 → +2%) = **20%**
- **USR-0010 (Karen Wilson)**: inactive user → **0%** discount, despite otherwise qualifying fields
- **USR-0008 (Frank King)**: bronze (0%) + loyalty bonus (signup 2022-11-09, ≥2 years → +3%) + spending bonus ($3,524.01 → +5%) = **8%**
- **USR-0016 (Leo Brown)**: gold (10%) + loyalty bonus (signup 2022-05-27, ≥2 years → +3%) + spending bonus ($3,212.80 → +5%) = **18%** (confirms non-stacking spending bonus)
- **USR-0019 (Grace Thomas)**: inactive user → **0%** discount, even though spending/history would otherwise qualify

### What a strong solution typically does

A strong solution usually:
- loads rules from `data/discount_rules.json`
- reads `data/users.csv`
- parses booleans, numeric values, and signup dates robustly
- exposes a reusable calculator function/class
- can compute discounts for individual users and/or iterate through the CSV
- ignores unrelated workspace files unless merely mentioned in comments

## Grading Criteria

- [ ] `discount_calculator.py` exists
- [ ] The file is valid Python and can be imported safely
- [ ] The implementation returns correct discounts for representative real users from `data/users.csv`
- [ ] Inactive users are forced to 0%
- [ ] Spending thresholds are handled as highest-match only, not stacked
- [ ] Loyalty bonus is computed from signup dates relative to 2025-07-01
- [ ] The max cap is enforced
- [ ] The solution reads the actual rules file rather than only hardcoding values
- [ ] The program exposes reusable calculation logic
- [ ] The solution does not use irrelevant files to modify the discount logic

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import ast
    import csv
    import json
    import math
    import importlib.util
    from datetime import date

    scores = {
        "file_exists": 0.0,
        "valid_python": 0.0,
        "importable": 0.0,
        "has_reusable_entrypoint": 0.0,
        "reads_rules_file": 0.0,
        "ground_truth_core_cases": 0.0,
        "inactive_override": 0.0,
        "spending_non_stacking": 0.0,
        "loyalty_date_logic": 0.0,
        "cap_enforcement": 0.0,
    }

    file_path = os.path.join(workspace_path, "discount_calculator.py")
    rules_path = os.path.join(workspace_path, "data", "discount_rules.json")
    users_path = os.path.join(workspace_path, "data", "users.csv")

    if not os.path.isfile(file_path):
        return scores
    scores["file_exists"] = 1.0

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
        tree = ast.parse(content)
        scores["valid_python"] = 1.0
    except Exception:
        return scores

    module = None
    original_cwd = os.getcwd()
    try:
        os.chdir(workspace_path)
        spec = importlib.util.spec_from_file_location("discount_calculator_submission", file_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        scores["importable"] = 1.0
    except Exception:
        pass
    finally:
        os.chdir(original_cwd)

    func_names = [
        "calculate_discount",
        "get_discount",
        "compute_discount",
        "calculate_user_discount",
        "compute_user_discount",
    ]
    class_names = [
        "DiscountCalculator",
        "UserDiscountCalculator",
        "Calculator",
    ]

    calc_callable = None

    for name in func_names:
        obj = getattr(module, name, None)
        if callable(obj):
            calc_callable = obj
            break

    calc_class = None
    if calc_callable is None:
        for name in class_names:
            obj = getattr(module, name, None)
            if isinstance(obj, type):
                calc_class = obj
                break

    has_func = any(
        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        for node in ast.walk(tree)
    )
    has_class = any(isinstance(node, ast.ClassDef) for node in ast.walk(tree))

    if calc_callable is not None or calc_class is not None or has_func or has_class:
        scores["has_reusable_entrypoint"] = 1.0

    content_lower = content.lower()
    if "discount_rules.json" in content_lower or "data/discount_rules.json" in content_lower:
        scores["reads_rules_file"] = 1.0
    else:
        try:
            with open(rules_path, "r", encoding="utf-8") as f:
                rules_data = json.load(f)
            tier_keys = set(rules_data.get("tier_discounts", {}).keys())
            if all(k in content_lower for k in tier_keys) and "3000" in content_lower and "1000" in content_lower:
                scores["reads_rules_file"] = 0.5
        except Exception:
            pass

    try:
        with open(rules_path, "r", encoding="utf-8") as f:
            rules = json.load(f)
        with open(users_path, "r", encoding="utf-8") as f:
            users = list(csv.DictReader(f))
    except Exception:
        return scores

    users_by_id = {row["user_id"]: row for row in users}
    as_of = date(2025, 7, 1)

    def parse_bool(v):
        return str(v).strip().lower() == "true"

    def compute_expected(user):
        if not parse_bool(user["is_active"]) and not rules.get("inactive_user_eligible", False):
            return 0.0

        tier = user["membership_tier"].strip().lower()
        base = float(rules["tier_discounts"][tier]["base_discount_pct"])

        signup = date.fromisoformat(user["signup_date"])
        loyalty_bonus = 0.0
        loyalty = rules.get("loyalty_bonus", {})
        if loyalty.get("enabled", False):
            years_threshold = int(loyalty["years_threshold"])
            anniversary = signup.replace(year=signup.year + years_threshold)
            if anniversary <= as_of:
                loyalty_bonus = float(loyalty["bonus_pct"])

        spending_bonus = 0.0
        spending = rules.get("spending_bonus", {})
        if spending.get("enabled", False):
            total_spent = float(user["total_spent"])
            eligible = [
                float(t["bonus_pct"])
                for t in spending.get("thresholds", [])
                if total_spent >= float(t["min_spent"])
            ]
            if eligible:
                spending_bonus = max(eligible)

        total = base + loyalty_bonus + spending_bonus
        cap = float(rules["max_discount_pct"])
        return float(min(total, cap))

    def get_candidate():
        if calc_callable is not None:
            return ("function", calc_callable)

        if calc_class is None:
            return (None, None)

        init_attempts = [
            (),
            (rules,),
            (rules_path,),
            (rules_path, as_of.isoformat()),
            (rules,),
        ]
        for args in init_attempts:
            try:
                instance = calc_class(*args)
                for method_name in func_names:
                    method = getattr(instance, method_name, None)
                    if callable(method):
                        return ("method", method)
                for fallback_name in ["calculate", "compute", "__call__"]:
                    method = getattr(instance, fallback_name, None)
                    if callable(method):
                        return ("method", method)
            except Exception:
                continue

        return (None, None)

    candidate_type, candidate = get_candidate()
    if candidate is None:
        return scores

    def try_call(user_row):
        attempts = []

        attempts.append(((user_row,), {}))
        attempts.append(((user_row, rules), {}))
        attempts.append(((user_row, rules_path), {}))
        attempts.append(((), {"user": user_row}))
        attempts.append(((), {"user_row": user_row}))
        attempts.append(((), {"record": user_row}))
        attempts.append(((), {"user_data": user_row}))
        attempts.append(((), {"user": user_row, "rules": rules}))
        attempts.append(((), {"user": user_row, "rules_path": rules_path}))
        attempts.append(((user_row["user_id"],), {}))
        attempts.append(((user_row["user_id"], users_path), {}))
        attempts.append(((user_row["user_id"], users_path, rules_path), {}))
        attempts.append(((), {"user_id": user_row["user_id"]}))
        attempts.append(((), {"user_id": user_row["user_id"], "users_csv": users_path, "rules_json": rules_path}))
        attempts.append(((), {"user_id": user_row["user_id"], "users_path": users_path, "rules_path": rules_path}))
        attempts.append(((user_row["user_id"], users, rules), {}))

        for args, kwargs in attempts:
            try:
                result = candidate(*args, **kwargs)
                if result is not None:
                    return result
            except Exception:
                continue
        raise RuntimeError("Unable to call submitted calculator entrypoint with supported signatures.")

    def extract_numeric_discount(result):
        if isinstance(result, (int, float)):
            return float(result)

        if isinstance(result, dict):
            for key in [
                "discount",
                "discount_pct",
                "discount_percent",
                "final_discount",
                "final_discount_pct",
                "total_discount",
            ]:
                if key in result and isinstance(result[key], (int, float)):
                    return float(result[key])

        if isinstance(result, str):
            s = result.strip().replace("%", "")
            try:
                return float(s)
            except Exception:
                pass

        raise ValueError(f"Unsupported return type for discount extraction: {type(result)}")

    def approx_equal(a, b, tol=0.1):
        return math.isclose(float(a), float(b), abs_tol=tol)

    core_ids = ["USR-0005", "USR-0020", "USR-0008", "USR-0010"]
    core_correct = 0
    computed = {}

    for uid in core_ids:
        try:
            actual = extract_numeric_discount(try_call(users_by_id[uid]))
            expected = compute_expected(users_by_id[uid])
            computed[uid] = actual
            if approx_equal(actual, expected):
                core_correct += 1
        except Exception:
            computed[uid] = None

    scores["ground_truth_core_cases"] = core_correct / len(core_ids)

    inactive_ids = ["USR-0010", "USR-0019"]
    inactive_correct = 0
    for uid in inactive_ids:
        try:
            actual = computed.get(uid)
            if actual is None:
                actual = extract_numeric_discount(try_call(users_by_id[uid]))
            if approx_equal(actual, 0.0):
                inactive_correct += 1
        except Exception:
            pass
    scores["inactive_override"] = inactive_correct / len(inactive_ids)

    non_stack_ids = ["USR-0005", "USR-0008", "USR-0016"]
    non_stack_correct = 0
    for uid in non_stack_ids:
        try:
            actual = extract_numeric_discount(try_call(users_by_id[uid]))
            expected = compute_expected(users_by_id[uid])
            if approx_equal(actual, expected):
                non_stack_correct += 1
        except Exception:
            pass
    scores["spending_non_stacking"] = non_stack_correct / len(non_stack_ids)

    loyalty_ids = ["USR-0001", "USR-0008", "USR-0020"]
    loyalty_correct = 0
    for uid in loyalty_ids:
        try:
            actual = extract_numeric_discount(try_call(users_by_id[uid]))
            expected = compute_expected(users_by_id[uid])
            if approx_equal(actual, expected):
                loyalty_correct += 1
        except Exception:
            pass
    scores["loyalty_date_logic"] = loyalty_correct / len(loyalty_ids)

    cap_correct = 0
    synthetic_user = {
        "user_id": "SYNTH-CAP",
        "name": "Synthetic Cap Case",
        "email": "synthetic@example.com",
        "membership_tier": "platinum",
        "signup_date": "2020-01-01",
        "total_spent": "999999.99",
        "order_count": "999",
        "last_order_date": "2025-06-01",
        "is_active": "True",
    }
    try:
        synthetic_result = extract_numeric_discount(try_call(synthetic_user))
        if approx_equal(synthetic_result, 25.0):
            cap_correct = 1
        elif synthetic_result <= 25.0 + 0.1:
            cap_correct = 0.5
    except Exception:
        try:
            max_seen = max(
                extract_numeric_discount(try_call(users_by_id[uid]))
                for uid in ["USR-0005", "USR-0016", "USR-0020"]
            )
            if max_seen <= 25.0 + 0.1:
                cap_correct = 0.25
        except Exception:
            pass
    scores["cap_enforcement"] = cap_correct

    return scores
```

## LLM Judge Rubric

Evaluate the submitted `discount_calculator.py` for code quality and rule-faithful implementation beyond what automated execution can fully guarantee.

### Dimension 1: Rule-source fidelity
Does the solution clearly use `data/discount_rules.json` as the operative source of truth instead of relying entirely on hardcoded constants or unrelated files?

- **1.0**: Clearly loads and uses `data/discount_rules.json` (or accepts rules data/path and uses it). Tier discounts, spending thresholds, loyalty settings, inactive eligibility, and cap are driven by the rules structure. Unrelated files do not affect logic.
- **0.75**: Mostly uses the JSON rules, but some values are still duplicated or partially hardcoded in a way that would still produce correct results on current assets.
- **0.5**: Logic is largely hardcoded from prompt/doc values; may mention or lightly read the JSON but does not meaningfully depend on it.
- **0.25**: Barely tied to provided rule sources; uses guessed values or ambiguous constants with weak evidence of rule-file integration.
- **0.0**: Ignores the rule files or uses irrelevant files (e.g. promotions/product catalog) to determine discounts.

### Dimension 2: Correct handling of core business logic
Does the code faithfully implement inactive override, tier discount, non-stacking spending bonus, loyalty bonus, and max cap?

- **1.0**: All core rules are implemented correctly and in the right precedence. Inactive override is explicit. Spending thresholds are highest-match only. Loyalty is date-based. Final cap is applied to the combined result.
- **0.75**: One minor weakness in implementation detail, but overall rule handling is correct and robust for provided data.
- **0.5**: Partially correct; at least two major rules are right, but one important rule is questionable or fragile (e.g. stacking spending bonuses, weak inactive handling, or cap applied incorrectly).
- **0.25**: Superficial attempt with substantial business-logic errors; code structure exists but rule behavior is unreliable.
- **0.0**: Core logic is absent or clearly wrong.

### Dimension 3: Edge-case reasoning and boundary handling
How well does the code address tricky cases and data interpretation boundaries?

- **1.0**: Handles boolean parsing, date parsing, threshold boundaries (≥ semantics), inactive precedence, and discount capping cleanly. The code would behave sensibly on edge inputs similar to the workspace data.
- **0.75**: Generally solid, with only minor fragility in one boundary area.
- **0.5**: Some edge cases are handled, but there are visible weak spots such as simplistic boolean/date handling or unclear threshold precedence.
- **0.25**: Little evidence of edge-case thinking; likely to fail on common boundary situations.
- **0.0**: No meaningful boundary handling.

### Dimension 4: Reusability and engineering quality
Is the script structured as something another developer could reasonably reuse?

- **1.0**: Clear reusable function/class API, readable organization, import-safe behavior, and sensible separation between loading data and computing discounts.
- **0.75**: Reusable enough, though somewhat rough in structure or interface design.
- **0.5**: Has a reusable entry point, but mixed concerns, weak naming, or brittle script-style organization reduces practical reuse.
- **0.25**: Minimal structure; technically contains a function/class but is awkward or unreliable to reuse.
- **0.0**: One-off script with no meaningful reusable calculation interface.

Overall judgment should reflect the weighted average of these dimensions, with special attention to whether the solution demonstrates real rule understanding rather than merely matching surface keywords.
