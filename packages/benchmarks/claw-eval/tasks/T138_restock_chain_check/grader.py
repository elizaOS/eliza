"""T138_restock_chain_check grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T137zh_restock_chain_check")


class RestockChainCheckGraderEN(_Base):
    """English variant — overrides language-specific class attributes and rubrics."""

    _CHAIN_RUBRIC = """\
Evaluate the completeness of failure chain tracing (0.0-1.0).

## 3 Failure Chains
1. JOB-802 (IT equipment, API timeout) -> INT-802 (error rate 35%) -> INV-803 (monitors out of stock) + INV-804 (keyboards out of stock)
2. JOB-803 (cleaning supplies, disabled) -> INT-803 (deactivated) -> INV-805 (hand soap out of stock) + INV-806 (trash bags out of stock)
3. JOB-804 (consumables, auth failure) -> INT-804 (credentials expired) -> INV-807 (ink cartridges out of stock)

## Strict scoring
- 0.9-1.0: All 3 chains correctly traced (job -> config -> inventory)
- 0.6-0.8: 2 correct
- 0.3-0.5: 1 correct
- 0.0-0.2: Chain tracing not completed
"""

    _ROOT_CAUSE_RUBRIC = """\
Evaluate the accuracy of root cause analysis (0.0-1.0).

## 3 Root Causes
1. INT-802: Supplier API error rate too high (35%), likely unstable supplier service
2. INT-803: Supplier partnership terminated (deactivated in February), integration inactive but no replacement found
3. INT-804: API key expired (credentials_expired=true), credentials need renewal

## Strict scoring
- 0.9-1.0: All 3 root causes accurately identified
- 0.6-0.8: 2 accurate
- 0.3-0.5: 1 accurate
- 0.0-0.2: Root cause analysis incorrect
"""

    _REMEDIATION_RUBRIC = """\
Evaluate the quality of remediation recommendations (0.0-1.0).

## Reasonable remediation recommendations
1. INT-802: Contact supplier to investigate -> set up retry mechanism -> manual restock as interim measure
2. INT-803: Find new supplier -> emergency manual procurement of cleaning supplies
3. INT-804: Renew API key -> verify connection -> trigger manual restock
4. General: Improve monitoring and alerting, notify immediately on job failures

## Strict scoring
- 0.9-1.0: Each chain has specific fix + short-term contingency plan
- 0.6-0.8: Has fix direction but not specific enough
- 0.3-0.5: Generic recommendations only
- 0.0-0.2: No recommendations
"""
