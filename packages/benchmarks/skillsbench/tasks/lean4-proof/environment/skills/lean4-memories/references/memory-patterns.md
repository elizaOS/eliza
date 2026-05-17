# Memory Patterns and Examples

This document provides detailed examples of memory operations for the lean4-memories skill.

## Memory Entity Schemas

### ProofPattern Entity

```json
{
  "entity_type": "ProofPattern",
  "name": "pi_system_uniqueness_for_measures",
  "attributes": {
    "project": "/Users/freer/work/exch-repos/exchangeability-cursor",
    "skill": "lean4-memories",
    "goal_pattern": "Show two measures equal via finite marginals",
    "goal_type_signature": "μ₁ = μ₂",
    "hypothesis_patterns": [
      "∀ n, μ₁.map (prefixProj n) = μ₂.map (prefixProj n)"
    ],
    "tactics_sequence": [
      "apply measure_eq_of_fin_marginals_eq",
      "intro n",
      "simp [prefixProj]"
    ],
    "helper_lemmas": [
      "isPiSystem_prefixCylinders",
      "generateFrom_prefixCylinders",
      "measure_eq_on_piSystem"
    ],
    "domain": "measure_theory",
    "difficulty": "medium",
    "lines_of_proof": 54,
    "confidence": 0.9,
    "file": "Exchangeability/Core.lean",
    "theorem_name": "measure_eq_of_fin_marginals_eq",
    "success_count": 3,
    "timestamp": "2025-10-19T14:30:00Z"
  },
  "relations": [
    {"type": "uses", "target": "isPiSystem_prefixCylinders"},
    {"type": "similar_to", "target": "fullyExchangeable_via_pathLaw"}
  ]
}
```

### FailedApproach Entity

```json
{
  "entity_type": "FailedApproach",
  "name": "simp_condExp_mul_comm_loop",
  "attributes": {
    "project": "/Users/freer/work/exch-repos/exchangeability-cursor",
    "skill": "lean4-memories",
    "failed_tactic": "simp only [condExp_indicator, mul_comm]",
    "error_type": "infinite_loop",
    "error_message": "deep recursion was detected",
    "context": "Conditional expectation with indicator function",
    "goal_pattern": "condExp μ m (indicator S f) = ...",
    "file": "Exchangeability/DeFinetti/ViaL2.lean",
    "line": 2830,
    "alternative_approach": "simp only [condExp_indicator], then use ring",
    "alternative_success": true,
    "time_wasted": "20 minutes",
    "confidence": 0.95,
    "timestamp": "2025-10-17T09:15:00Z"
  },
  "relations": [
    {"type": "avoided_in", "target": "condIndep_of_condExp_eq"}
  ]
}
```

### ProjectConvention Entity

```json
{
  "entity_type": "ProjectConvention",
  "name": "measure_theory_instance_declaration",
  "attributes": {
    "project": "/Users/freer/work/exch-repos/exchangeability-cursor",
    "skill": "lean4-memories",
    "convention_type": "proof_structure",
    "pattern": "haveI : MeasurableSpace Ω := inferInstance",
    "description": "All measure theory proofs require explicit MeasurableSpace instance",
    "domain": "measure_theory",
    "frequency": 15,
    "files": [
      "Exchangeability/DeFinetti/ViaL2.lean",
      "Exchangeability/Core.lean",
      "Exchangeability/Contractability.lean"
    ],
    "confidence": 0.95,
    "timestamp": "2025-10-15T10:00:00Z"
  }
}
```

### UserPreference Entity

```json
{
  "entity_type": "UserPreference",
  "name": "verbose_script_output",
  "attributes": {
    "project": "/Users/freer/work/exch-repos/exchangeability-cursor",
    "skill": "lean4-memories",
    "preference_type": "script_usage",
    "setting": "verbose_output",
    "value": true,
    "context": "User prefers --verbose flag for all automation scripts",
    "scripts_affected": [
      "search_mathlib.sh",
      "find_instances.sh",
      "smart_search.sh"
    ],
    "confidence": 0.8,
    "timestamp": "2025-10-10T16:20:00Z"
  }
}
```

### TheoremDependency Entity

```json
{
  "entity_type": "TheoremDependency",
  "name": "permutation_extension_lemma_usage",
  "attributes": {
    "project": "/Users/freer/work/exch-repos/exchangeability-cursor",
    "skill": "lean4-memories",
    "helper_theorem": "exists_perm_extending_strictMono",
    "dependent_theorems": [
      "exchangeable_iff_contractable",
      "fullyExchangeable_iff_exchangeable"
    ],
    "usage_pattern": "Extend finite permutation to full permutation",
    "domain": "combinatorics",
    "importance": "high",
    "confidence": 1.0,
    "timestamp": "2025-10-12T11:00:00Z"
  },
  "relations": [
    {"type": "critical_for", "target": "exchangeable_iff_contractable"}
  ]
}
```

## Storage Operation Examples

### Example 1: Store Successful Proof Pattern

**Scenario:** Just completed proof of `condIndep_iff_condexp_eq` using conditional expectation uniqueness.

**Storage operation:**
```python
# Pseudocode for MCP memory operation
memory.create_entity(
    entity_type="ProofPattern",
    name="condExp_unique_for_conditional_independence",
    content={
        "project": os.getcwd(),  # /Users/freer/work/exch-repos/exchangeability-cursor
        "skill": "lean4-memories",
        "goal_pattern": "Prove conditional independence via conditional expectation equality",
        "goal_type": "CondIndep X Y m ↔ condExp m X = condExp m Y",
        "tactics_sequence": [
            "apply condExp_unique",
            "intro s hs",
            "show_ae_eq",
            "measurability"
        ],
        "helper_lemmas": [
            "condExp_unique",
            "ae_eq_condExp_of_forall_setIntegral_eq",
            "setIntegral_condExp"
        ],
        "domain": "probability_theory",
        "subdomain": "conditional_independence",
        "difficulty": "large",
        "lines_of_proof": 85,
        "sorry_count": 0,
        "confidence": 0.9,
        "file": "Exchangeability/DeFinetti/ViaL2.lean",
        "theorem_name": "condIndep_iff_condexp_eq",
        "timestamp": datetime.now().isoformat()
    }
)

memory.create_relations([
    {"source": "condIndep_iff_condexp_eq", "type": "uses", "target": "condExp_unique"},
    {"source": "condIndep_iff_condexp_eq", "type": "similar_to", "target": "condProb_eq_of_eq_on_pi_system"}
])
```

### Example 2: Store Failed Approach

**Scenario:** Attempted to use `tsum_congr` with `condExp` but got type mismatch.

**Storage operation:**
```python
memory.create_entity(
    entity_type="FailedApproach",
    name="tsum_condExp_direct_exchange",
    content={
        "project": os.getcwd(),
        "skill": "lean4-memories",
        "failed_tactic": "apply tsum_congr; intro i; rw [condExp_indicator]",
        "error_type": "type_mismatch",
        "error_message": "expected condExp to be measurable, but got ae-measurable",
        "context": "Trying to exchange tsum and condExp directly",
        "goal_pattern": "condExp (∑' i, f i) = ∑' i, condExp (f i)",
        "why_failed": "condExp output is only ae-measurable, not point-wise measurable",
        "file": "Exchangeability/DeFinetti/ViaL2.lean",
        "line": 643,
        "alternative_approach": "Use restricted measure trick: switch to μ.restrict S",
        "alternative_detail": "integral_condExp on restricted measure with set = univ",
        "alternative_success": true,
        "time_wasted": "45 minutes",
        "learning": "Cannot exchange condExp with series directly; need measure restriction",
        "confidence": 0.95,
        "timestamp": datetime.now().isoformat()
    }
)
```

### Example 3: Store Project Convention

**Scenario:** Observed consistent pattern of hypothesis naming across 10+ files.

**Storage operation:**
```python
memory.create_entity(
    entity_type="ProjectConvention",
    name="hypothesis_naming_pattern",
    content={
        "project": os.getcwd(),
        "skill": "lean4-memories",
        "convention_type": "naming",
        "category": "hypotheses",
        "pattern": "h{property_name}",
        "examples": [
            "hExchangeable : Exchangeable μ X",
            "hMeasurable : Measurable f",
            "hIntegrable : Integrable f μ",
            "hContract : Contractable μ X"
        ],
        "description": "Hypotheses prefixed with 'h' followed by property name",
        "exceptions": [
            "ih for induction hypothesis",
            "hs for set membership (h_s avoided)"
        ],
        "frequency": 120,
        "files_surveyed": 15,
        "confidence": 0.95,
        "timestamp": datetime.now().isoformat()
    }
)
```

### Example 4: Store User Preference

**Scenario:** User consistently requests ripgrep output format.

**Storage operation:**
```python
memory.create_entity(
    entity_type="UserPreference",
    name="search_tool_preference",
    content={
        "project": os.getcwd(),
        "skill": "lean4-memories",
        "preference_type": "tool_usage",
        "tool": "search_mathlib.sh",
        "setting": "output_format",
        "preferred_value": "with_context",
        "reasoning": "User wants to see surrounding code for search results",
        "explicit_request": true,
        "frequency": 8,
        "confidence": 0.9,
        "timestamp": datetime.now().isoformat()
    }
)
```

## Retrieval Operation Examples

### Example 1: Retrieve Similar Proof Patterns

**Scenario:** About to prove `fullyExchangeable_iff_X` which requires showing measure equality.

**Retrieval query:**
```python
# Query for similar patterns
results = memory.search_entities(
    query="measure equality finite marginals",
    entity_type="ProofPattern",
    filters={
        "project": os.getcwd(),
        "skill": "lean4-memories",
        "confidence": {">=": 0.7}
    },
    limit=5
)

# Expected result:
# ProofPattern: pi_system_uniqueness_for_measures
# - Tactics: [apply measure_eq_of_fin_marginals_eq, ...]
# - Confidence: 0.9
# - Success count: 3

# Suggested action:
# "This goal is similar to measure_eq_of_fin_marginals_eq"
# "Try π-system uniqueness approach: apply measure_eq_of_fin_marginals_eq"
```

### Example 2: Check for Known Failures

**Scenario:** About to apply `simp only [condExp_indicator, mul_comm]`.

**Retrieval query:**
```python
# Query for known issues with this tactic
results = memory.search_entities(
    query="simp condExp_indicator mul_comm",
    entity_type="FailedApproach",
    filters={
        "project": os.getcwd(),
        "skill": "lean4-memories"
    }
)

# Expected result:
# FailedApproach: simp_condExp_mul_comm_loop
# - Error: infinite_loop
# - Alternative: simp only [condExp_indicator], then ring

# Suggested action:
# ⚠️ WARNING: This tactic combination causes infinite loop
# Alternative approach: Use simp only [condExp_indicator] without mul_comm, then ring
```

### Example 3: Retrieve Project Conventions

**Scenario:** Starting new theorem in measure theory file.

**Retrieval query:**
```python
# Query for measure theory conventions
results = memory.search_entities(
    query="measure theory proof structure",
    entity_type="ProjectConvention",
    filters={
        "project": os.getcwd(),
        "skill": "lean4-memories",
        "domain": "measure_theory"
    }
)

# Expected result:
# ProjectConvention: measure_theory_instance_declaration
# - Pattern: haveI : MeasurableSpace Ω := inferInstance
# - Frequency: 15 occurrences

# Suggested action:
# "Based on project conventions, start with:"
# haveI : MeasurableSpace Ω := inferInstance
```

### Example 4: Find Helpful Lemmas

**Scenario:** Stuck on proof, need helper lemmas.

**Retrieval query:**
```python
# Query for theorems that helped with similar goals
results = memory.search_entities(
    query="conditional expectation uniqueness",
    entity_type="TheoremDependency",
    filters={
        "project": os.getcwd(),
        "skill": "lean4-memories",
        "domain": "probability_theory"
    }
)

# Expected result:
# TheoremDependency: condExp_unique_usage_pattern
# - Helper: condExp_unique
# - Used in: [condIndep_iff_condexp_eq, condProb_eq_of_eq_on_pi_system]
# - Pattern: "Test equality on measurable sets via integrals"

# Suggested action:
# "Consider using condExp_unique - it helped with similar proofs"
# "Pattern: Show ae_eq by testing on measurable sets"
```

## Memory Maintenance Examples

### Update Memory with New Success

**Scenario:** Used `pi_system_uniqueness` pattern successfully again.

```python
# Retrieve existing memory
pattern = memory.get_entity("pi_system_uniqueness_for_measures")

# Update success count and confidence
pattern.attributes["success_count"] += 1
pattern.attributes["confidence"] = min(1.0, pattern.attributes["confidence"] + 0.05)
pattern.attributes["last_used"] = datetime.now().isoformat()

memory.update_entity(pattern)
```

### Deprecate Outdated Memory

**Scenario:** Found better approach than stored pattern.

```python
# Mark old pattern as deprecated
old_pattern = memory.get_entity("old_approach_name")
old_pattern.attributes["deprecated"] = true
old_pattern.attributes["deprecation_reason"] = "Better approach found: new_approach_name"
old_pattern.attributes["replaced_by"] = "new_approach_name"

memory.update_entity(old_pattern)

# Store new pattern
memory.create_entity(
    entity_type="ProofPattern",
    name="new_approach_name",
    content={...}
)
```

### Prune Low-Confidence Memories

**Scenario:** Periodic cleanup of unreliable memories.

```python
# Query for low-confidence, old memories
candidates = memory.search_entities(
    entity_type="ProofPattern",
    filters={
        "project": os.getcwd(),
        "skill": "lean4-memories",
        "confidence": {"<": 0.5},
        "timestamp": {"<": one_month_ago}
    }
)

# Review and delete if not used
for pattern in candidates:
    if pattern.attributes["success_count"] == 0:
        memory.delete_entity(pattern.name)
```

## Integration Patterns

### Pattern 1: Pre-Proof Memory Check

Before starting a proof, check memories:

```python
def pre_proof_memory_check(goal_description):
    # 1. Check for similar successful patterns
    similar = memory.search_entities(
        query=goal_description,
        entity_type="ProofPattern",
        filters={"project": os.getcwd(), "confidence": {">=": 0.7}}
    )

    # 2. Check for known failures with this goal type
    failures = memory.search_entities(
        query=goal_description,
        entity_type="FailedApproach",
        filters={"project": os.getcwd()}
    )

    # 3. Get relevant conventions
    conventions = memory.search_entities(
        query=extract_domain(goal_description),
        entity_type="ProjectConvention",
        filters={"project": os.getcwd()}
    )

    return {
        "similar_proofs": similar,
        "known_failures": failures,
        "conventions": conventions
    }
```

### Pattern 2: Post-Proof Memory Storage

After completing a proof, store the pattern:

```python
def post_proof_memory_store(proof_info):
    # Only store non-trivial proofs
    if proof_info["lines"] < 10:
        return

    # Only store if confidence is reasonable
    if proof_info["sorry_count"] > 0:
        confidence = 0.5
    elif proof_info["warnings"] > 0:
        confidence = 0.7
    else:
        confidence = 0.9

    memory.create_entity(
        entity_type="ProofPattern",
        name=generate_pattern_name(proof_info),
        content={
            "project": os.getcwd(),
            "skill": "lean4-memories",
            "goal_pattern": proof_info["goal"],
            "tactics_sequence": proof_info["tactics"],
            "helper_lemmas": proof_info["lemmas_used"],
            "difficulty": estimate_difficulty(proof_info["lines"]),
            "confidence": confidence,
            **proof_info
        }
    )
```

### Pattern 3: Tactic Suggestion with Memory

Enhance tactic suggestions with memory:

```python
def suggest_tactics_with_memory(goal):
    # Get base suggestions from goal pattern
    base_suggestions = analyze_goal_pattern(goal)

    # Enhance with memory
    memory_patterns = memory.search_entities(
        query=goal,
        entity_type="ProofPattern",
        filters={"project": os.getcwd(), "confidence": {">=": 0.7}}
    )

    # Prioritize tactics from successful memories
    for pattern in memory_patterns:
        for tactic in pattern.attributes["tactics_sequence"]:
            if tactic not in base_suggestions:
                base_suggestions.append({
                    "tactic": tactic,
                    "source": "memory",
                    "confidence": pattern.attributes["confidence"]
                })

    # Filter out known failures
    failures = memory.search_entities(
        query=goal,
        entity_type="FailedApproach",
        filters={"project": os.getcwd()}
    )

    for failure in failures:
        base_suggestions = [
            s for s in base_suggestions
            if s["tactic"] != failure.attributes["failed_tactic"]
        ]

    return sorted(base_suggestions, key=lambda x: x.get("confidence", 0.5), reverse=True)
```

## Best Practices

### When to Store Memories

**DO store:**
- ✅ Proofs with >10 lines (non-trivial)
- ✅ Approaches that failed after >10 minutes of trying
- ✅ Patterns observed 3+ times
- ✅ Project-specific insights not in mathlib docs

**DON'T store:**
- ❌ One-line proofs (rfl, simp, exact)
- ❌ Obvious applications of standard lemmas
- ❌ Temporary hacks or workarounds
- ❌ General Lean knowledge

### Confidence Scoring Guidelines

- **0.9-1.0:** Clean proof, no warnings, used successfully multiple times
- **0.7-0.9:** Works well, minor issues or single use
- **0.5-0.7:** Works but has problems, needs refinement
- **0.3-0.5:** Hacky solution, use only if nothing else works
- **0.0-0.3:** Experimental, likely needs replacement

### Memory Scoping Guidelines

Always scope by:
1. **Project path** (absolute path to repository)
2. **Skill** ("lean4-memories")
3. **Entity type** (ProofPattern, FailedApproach, etc.)

Never mix memories across projects unless explicitly linked.
