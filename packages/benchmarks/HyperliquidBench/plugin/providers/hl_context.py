"""
HL_CONTEXT provider – injects the current trading scenario, account state,
and available operations into the agent's context window.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# JSON plan schema (mirrors crates/hl-runner/src/llm/prompts.rs)
_PLAN_SCHEMA = """\
{
  "steps": [
    {"perp_orders": {"orders": [{"coin": "ETH", "side": "buy"|"sell", "tif": "GTC"|"ALO"|"IOC", "sz": number, "reduceOnly": bool, "builderCode": string, "px": number|string, "trigger": {"kind": "none"}}], "builderCode": string}},
    {"cancel_last": {"coin": string}},
    {"cancel_oids": {"coin": string, "oids": [number]}},
    {"cancel_all":  {"coin": string}},
    {"usd_class_transfer": {"toPerp": bool, "usdc": number}},
    {"set_leverage": {"coin": string, "leverage": number, "cross": bool}},
    {"sleep_ms": {"duration_ms": number}}
  ]
}"""

_PLAN_RULES = """\
- Use only the allowed coins.
- Sizes must be positive and reasonably small (e.g., 0.001 to 1).
- Keep leverage between 1 and 20.
- "trigger.kind" must always be "none".
- Prices can be absolute numbers or "mid±X%" strings (e.g., "mid-0.5%", "mid+1.0%").
- Return compact JSON without comments or markdown fences.
- Total steps must be <= the provided max."""


def _coerce_bench_root(value: object) -> Path | None:
    if isinstance(value, Path):
        return value
    if isinstance(value, str) and value.strip():
        return Path(value)
    return None


def _coerce_scenario(value: object) -> object | None:
    from benchmarks.HyperliquidBench.types import ScenarioKind, TradingScenario

    if isinstance(value, TradingScenario):
        return value
    if isinstance(value, dict):
        scenario_kind = value.get("kind", ScenarioKind.CUSTOM.value)
        if isinstance(scenario_kind, ScenarioKind):
            kind = scenario_kind
        else:
            try:
                kind = ScenarioKind(str(scenario_kind))
            except ValueError:
                kind = ScenarioKind.CUSTOM
        return TradingScenario(
            scenario_id=str(value.get("scenario_id", value.get("scenarioId", "unknown"))),
            kind=kind,
            description=str(value.get("description", "")),
            allowed_coins=[str(item) for item in value.get("allowed_coins", value.get("allowedCoins", []))],
            max_steps=int(value.get("max_steps", value.get("maxSteps", 5))),
            builder_code=str(value["builder_code"]) if value.get("builder_code") is not None else None,
            plan_spec=str(value["plan_spec"]) if value.get("plan_spec") is not None else None,
            hian_prompt_path=str(value["hian_prompt_path"]) if value.get("hian_prompt_path") is not None else None,
        )
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        return _coerce_scenario(parsed)
    return None


def _load_domains_summary(bench_root: Path) -> str:
    """Read domains-hl.yaml and return a human-readable summary."""
    domains_path = bench_root / "dataset" / "domains-hl.yaml"
    if not domains_path.exists():
        return "(domains file not found)"
    try:
        import yaml  # type: ignore[import-untyped]

        with open(domains_path) as fh:
            data = yaml.safe_load(fh)
        parts: list[str] = []
        domains = data.get("domains", {})
        for name, info in domains.items():
            weight = info.get("weight", 1.0)
            patterns = ", ".join(info.get("allow", []))
            parts.append(f"  {name} (weight={weight}): {patterns}")
        return "\n".join(parts) if parts else "(no domains)"
    except Exception:
        # Fallback: just read raw text
        return domains_path.read_text()[:500]


async def _get_hl_context(
    runtime: IAgentRuntime, _message: Memory, _state: State
) -> ProviderResult:
    """
    Build the Hyperliquid trading context for the current scenario.

    Reads ``CURRENT_SCENARIO``, ``BENCH_ROOT``, and ``LAST_RESULT`` from
    runtime settings.
    """
    scenario = _coerce_scenario(runtime.get_setting("CURRENT_SCENARIO"))
    bench_root = _coerce_bench_root(runtime.get_setting("BENCH_ROOT"))
    last_result_value = runtime.get_setting("LAST_RESULT_JSON")
    last_result_json: str | None = None
    if isinstance(last_result_value, str):
        last_result_json = last_result_value
    elif last_result_value is not None:
        last_result_json = json.dumps(last_result_value)

    if scenario is None:
        return ProviderResult(text="", values={}, data={})

    if bench_root is None:
        bench_root = Path(__file__).resolve().parents[2]

    parts: list[str] = []
    parts.append("## Hyperliquid Trading Context")
    parts.append("")
    parts.append(f"**Scenario:** {scenario.description}")
    parts.append(f"**Kind:** {scenario.kind.value}")
    parts.append(f"**Allowed coins:** {', '.join(scenario.allowed_coins)}")
    parts.append(f"**Max steps:** {scenario.max_steps}")
    if scenario.builder_code:
        parts.append(f"**Builder code:** {scenario.builder_code}")
    parts.append("")

    # Domain information
    parts.append("### Scoring Domains")
    parts.append(_load_domains_summary(bench_root))
    parts.append("")

    # Plan schema
    parts.append("### Plan JSON Schema")
    parts.append("```")
    parts.append(_PLAN_SCHEMA)
    parts.append("```")
    parts.append("")
    parts.append("### Rules")
    parts.append(_PLAN_RULES)
    parts.append("")

    # Available actions
    parts.append("### Available Actions")
    parts.append("- **GENERATE_PLAN**: Generate a trading plan as JSON")
    parts.append("- **EXECUTE_PLAN**: Execute a plan via the Rust hl-runner binary")
    parts.append("")

    # Previous result feedback with gap analysis
    if last_result_json:
        parts.append("### Previous Execution Result")
        try:
            result_data = json.loads(last_result_json)
            eval_data = result_data.get("evaluator", {})
            final_score = eval_data.get("finalScore", 0)
            found_sigs = eval_data.get("uniqueSignatures", [])
            parts.append(f"**Score: {final_score}** (base={eval_data.get('base', 0)}, bonus={eval_data.get('bonus', 0)}, penalty={eval_data.get('penalty', 0)})")
            parts.append(f"**Found signatures:** {', '.join(found_sigs)}")
            parts.append("")

            # Gap analysis: show what's missing
            all_possible_sigs = []
            coins = scenario.allowed_coins if scenario else ["ETH", "BTC", "SOL"]
            for tif in ["GTC", "ALO", "IOC"]:
                for ro in ["false", "true"]:
                    all_possible_sigs.append(f"perp.order.{tif}:{ro}:none")
            all_possible_sigs.extend(["perp.cancel.last", "perp.cancel.all"])
            for coin in coins:
                all_possible_sigs.append(f"perp.cancel.last.{coin}")
            all_possible_sigs.extend(["account.usdClassTransfer.toPerp", "account.usdClassTransfer.toSpot"])
            for coin in coins:
                all_possible_sigs.append(f"risk.setLeverage.{coin}")

            missing = [s for s in all_possible_sigs if s not in found_sigs]
            if missing:
                parts.append("### MISSING Signatures (target these in your next plan!)")
                for sig in missing[:15]:
                    parts.append(f"  - {sig}")
                parts.append("")
                parts.append("**To improve your score, include actions that generate these signatures.**")
                parts.append("- Use BOTH buy AND sell for each TIF (GTC, ALO, IOC)")
                parts.append("- Use reduceOnly=true AND reduceOnly=false")
                parts.append("- Transfer USDC both toPerp=true AND toPerp=false")
                parts.append("- Set leverage on EACH allowed coin")
            parts.append("")
        except (json.JSONDecodeError, TypeError):
            parts.append(f"```json\n{last_result_json}\n```")
            parts.append("")

    text = "\n".join(parts)

    values: dict[str, str | int | list[str]] = {
        "scenarioId": scenario.scenario_id,
        "scenarioKind": scenario.kind.value,
        "allowedCoins": scenario.allowed_coins,
        "maxSteps": scenario.max_steps,
    }
    if scenario.builder_code:
        values["builderCode"] = scenario.builder_code

    data: dict[str, object] = {
        "scenario": {
            "id": scenario.scenario_id,
            "kind": scenario.kind.value,
            "description": scenario.description,
            "allowedCoins": scenario.allowed_coins,
            "maxSteps": scenario.max_steps,
            "builderCode": scenario.builder_code,
        },
        "planSchema": _PLAN_SCHEMA,
        "planRules": _PLAN_RULES,
    }
    if last_result_json:
        try:
            data["lastResult"] = json.loads(last_result_json)
        except json.JSONDecodeError:
            data["lastResultRaw"] = last_result_json

    return ProviderResult(text=text, values=values, data=data)


hl_context_provider = Provider(
    name="HL_CONTEXT",
    description=(
        "Provides the current Hyperliquid trading scenario, plan schema, "
        "scoring domains, and previous execution results"
    ),
    position=50,
    private=False,
    get=_get_hl_context,
)
