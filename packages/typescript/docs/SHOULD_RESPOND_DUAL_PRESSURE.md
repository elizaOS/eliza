# Should-respond: dual-pressure scoring

This document describes the **dual-pressure** LLM classifier used when the agent must decide whether to **REPLY**, **IGNORE**, or **STOP** in ambiguous channels (e.g. group chat without an explicit @mention). It focuses on **what** the system does and **why** it is designed that way.

For a shorter rationale slice in the broader core design narrative, see [DESIGN.md](./DESIGN.md) (section *Dual-pressure shouldRespond*). For release notes, see [CHANGELOG.md](../CHANGELOG.md).

---

## Problem

A single scalar “confidence” or a free-form `shouldRespond: boolean` is easy for models to game: the model can say “yes, respond” while the surrounding context clearly calls for silence (or the opposite). In group settings, agents also tend to **over-reply** unless the prompt and post-processing consistently reward restraint.

**Why we care:** The should-respond gate runs **before** the expensive main generation path. A bad gate either wastes tokens and annoys users (speaking when not addressed) or misses legitimate help requests (staying silent when the user did need the agent).

---

## Approach: two scores + net + consistency rules

The classifier outputs two integers in \([0, 100]\):

| Field (API / prompt) | Meaning |
|----------------------|--------|
| `speak_up` | Pressure **to** engage (addressed, in-domain question, clear value, etc.) |
| `hold_back` | Pressure **to** stay quiet (wrong audience, redundancy, noisy channel, etc.) |

**Net:** `net = speak_up - hold_back` (range \([-100, 100]\)).

**Why two scores instead of one?** They force the model to make the tradeoff explicit. A single “confidence” does not distinguish “I am 90% sure I should talk” from “I am torn between jumping in and staying out.” Two pressures map naturally to group-chat social dynamics and make inconsistencies easier to detect in logs.

The prompt aligns with a **high / low band** (default half-width **T = 20**, configurable — see below): strong net favors a matching action; the middle band is judgment. The template also includes **anti-gaming** language: do not output high `hold_back` and then choose REPLY without reconciling in reasoning.

---

## Runtime enforcement (“gaslighting clamp”)

After the LLM returns `action` and scores, `DefaultMessageService` runs **`applyDualPressureToClassifierAction`**:

1. **Parse** `speak_up` and `hold_back` (snake_case or camelCase). If either is missing, **no** consistency check runs; the raw action is used. **Why:** Backward compatibility and resilience to partial JSON / schema drift; we still log when one score is present without the other.
2. **STOP is sacred:** If the model chose **STOP**, we do **not** clamp away from STOP using net. **Why:** User intent to end the conversation must not be overridden by numeric scores.
3. **Hard clamp:** If `net <= -threshold` and the action is **REPLY** or **RESPOND** (both mean “engage”), we **force IGNORE** and log a **warning**. **Why:** This is the main guardrail against “I said high hold_back / low net but still replied.”
4. **Soft warning:** If `net >= +threshold` and the action is **IGNORE**, we **allow** IGNORE but log a **warning**. **Why:** There are legitimate exceptions (policy, safety, channel norms) where silence is correct despite a high net; we surface the mismatch for operators instead of overriding the model.

Threshold is read from **`DUAL_PRESSURE_THRESHOLD`** (integer **1–100**, default **20**). **Why 20?** Matches the prompt’s default `T_hi` and is a practical band for “clearly leaning one way” without dominating the middle band where context matters most.

---

## Where this runs in the pipeline

1. **`shouldRespond()`** (on `DefaultMessageService` and the **`basic-capabilities`** helper) applies **cheap rules**: DMs, whitelisted sources, platform mentions/replies → skip LLM (`skipEvaluation: true`). **Why:** Deterministic, fast, and matches product expectations for private or explicitly targeted traffic.
2. **Ambiguous group (etc.)** → LLM classifier with **`shouldRespondTemplate`** (or character override), structured fields including `speak_up`, `hold_back`, `action`, plus context routing metadata when enabled.
3. **Initial `composeState`** for message processing uses **`ENTITIES`, `CHARACTER`, `RECENT_MESSAGES`, `ACTIONS`** — not the legacy **ANXIETY** provider for this path. **Why:** The dual-pressure rubric and rules in the should-respond template carry the “when to be quiet” guidance explicitly; keeping the compose list smaller reduces noise and avoids coupling should-respond quality to a separate provider unless the character adds it elsewhere.

---

## Observability and API surface

- **Logs:** Structured log data includes `dualPressure` and `shouldRespondClassifierAction` for the completed handler run. **Why:** Operators can correlate user complaints (“bot never speaks” / “bot won’t shut up”) with scores and final action.
- **`MessageProcessingResult`:** When the **LLM** classifier path ran, results may include **`dualPressure`** (possibly `null` if scores were incomplete) and **`shouldRespondClassifierAction`**. **Why:** Integrations (dashboards, tests, custom clients) can consume the same values as logs without parsing text.
- **`ResponseDecision`:** Optional **`pressure`** / **`classifierAction`** exist for **custom** `shouldRespond` implementations that want a typed contract aligned with the core. The built-in synchronous `shouldRespond()` does not set them (it only encodes rule-based shortcuts).

---

## Configuration reference

| Setting | Role |
|---------|------|
| `DUAL_PRESSURE_THRESHOLD` | Band half-width for clamp / warn (default 20). |
| `SHOULD_RESPOND_MODEL` / options | Model tier for the classifier (see runtime docs). |
| Character `templates.shouldRespondTemplate` | Override the default TOON template while keeping schema fields compatible if you want clamps to apply. |

See root **`.env.example`** for commented env keys.

---

## Prompt template ordering

The template lists **`action_space`** (REPLY / IGNORE / STOP meanings) **before** the **`output:`** TOON instruction. **Why:** Models see what each action means before the format constraint, which reduces avoidable confusion between labels and prose.

---

## Roadmap pointers

Deferred or follow-up ideas (priorities vary by product): REACT-style actions in the main pipeline, richer metrics export, optional hard override on high-net IGNORE, and alignment of fine-tuned heads with the dual-pressure schema. See [ROADMAP.md](../ROADMAP.md).

---

## Related tests

- `src/__tests__/message-service.test.ts` — clamp, soft warning, classifier action on `MessageProcessingResult`.
- `src/__tests__/prompts.test.ts` — template structure and `action_space` before `output:`.
