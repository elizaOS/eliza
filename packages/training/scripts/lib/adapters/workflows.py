"""Legacy corpus adapters: workflows."""

from __future__ import annotations
import json
import re
from typing import Any
from ..eliza_record import (
    build,
    stable_id,
)
from .common import _split_history

N8N_WORKFLOW_ACTIONS = ["CREATE_WORKFLOW", "PREVIEW_WORKFLOW", "REPLY", "IGNORE"]


def _n8n_synth_prompt_from_workflow(wf: dict[str, Any]) -> str:
    """Build a synthetic user prompt from a raw n8n workflow JSON."""
    name = (wf.get("name") or "").strip() or "an n8n workflow"
    nodes = wf.get("nodes") or []
    types = []
    for n in nodes if isinstance(nodes, list) else []:
        t = (n.get("type") if isinstance(n, dict) else None) or ""
        if t and t not in types:
            types.append(t)
        if len(types) >= 12:
            break
    integrations = ", ".join(types[:12]) if types else "various nodes"
    return (
        f"Generate the JSON for an n8n workflow named '{name}' that uses "
        f"these node types: {integrations}. Return only the workflow JSON."
    )


def _n8n_first_str(d: dict[str, Any], keys: list[str]) -> str:
    for k in keys:
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return v
    return ""


_N8N_FENCE_RE = re.compile(r"```(?:json)?\s*\n?([\s\S]*?)\n?```", re.IGNORECASE)


def _n8n_extract_workflow(text: str) -> dict[str, Any] | None:
    """Return a workflow dict (must contain `nodes` + `connections`) parsed
    from `text`, or None if no valid workflow can be recovered.

    Tolerates raw JSON, ```json fenced JSON, and prose-prefixed JSON (the
    `<thinking>…JSON…` shape used by stmasson and the markdown analysis
    shape used by davidrpatton).
    """
    if not isinstance(text, str) or not text.strip():
        return None
    body = text.strip()

    # 1) Direct JSON.
    try:
        wf = json.loads(body)
        if (
            isinstance(wf, dict)
            and isinstance(wf.get("nodes"), list)
            and isinstance(wf.get("connections"), dict)
        ):
            return wf
    except json.JSONDecodeError:
        pass

    # 2) Fenced JSON block(s) — pick the first that yields a valid workflow.
    for m in _N8N_FENCE_RE.finditer(body):
        chunk = m.group(1).strip()
        try:
            wf = json.loads(chunk)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(wf, dict)
            and isinstance(wf.get("nodes"), list)
            and isinstance(wf.get("connections"), dict)
        ):
            return wf

    # 3) First `{` … last `}` window. Useful for `<thinking>…{…}` shapes.
    first = body.find("{")
    last = body.rfind("}")
    if first >= 0 and last > first:
        try:
            wf = json.loads(body[first : last + 1])
        except json.JSONDecodeError:
            return None
        if (
            isinstance(wf, dict)
            and isinstance(wf.get("nodes"), list)
            and isinstance(wf.get("connections"), dict)
        ):
            return wf
    return None


def _n8n_planner_target(wf: dict[str, Any]) -> dict[str, Any]:
    """Build the canonical elizaOS planner output for a CREATE_WORKFLOW
    action, as a Python dict ready to encode.

    Shape mirrors the `<response>` XML envelope nubilio emits — `thought`,
    `actions[]{name, params}`, `providers[]`, `text`, `simple` — so the
    student model learns one envelope across both runtime tasks and
    workflow generation.
    """
    name = (wf.get("name") or "").strip() or "untitled"
    nodes = wf.get("nodes") if isinstance(wf.get("nodes"), list) else []
    n_count = len(nodes)
    trigger = ""
    sink = ""
    for n in nodes:
        if not isinstance(n, dict):
            continue
        t = (n.get("type") or "").lower()
        if not trigger and (
            "trigger" in t or "webhook" in t or t.endswith("formtrigger")
        ):
            trigger = n.get("name") or t.split(".")[-1] or "trigger"
        if (
            "googlesheets" in t
            or "telegram" in t
            or "slack" in t
            or "notion" in t
            or "gmail" in t
            or "discord" in t
            or "airtable" in t
        ):
            sink = n.get("name") or t.split(".")[-1] or sink
    if not trigger:
        trigger = "trigger"
    if not sink:
        if nodes and isinstance(nodes[-1], dict):
            last = nodes[-1]
            sink = (
                last.get("name") or (last.get("type") or "").split(".")[-1] or "action"
            )
        else:
            sink = "action"
    return {
        "thought": (
            f"User wants a {trigger} to {sink} workflow. Drafting with {n_count} nodes."
        ),
        "actions": [
            {
                "name": "CREATE_WORKFLOW",
                "params": {"workflow": wf},
            }
        ],
        "providers": [],
        "text": (
            f"Drafted '{name}' with {n_count} nodes. Connect any required "
            f"credentials, then confirm to deploy."
        ),
        "simple": False,
    }


def n8n_workflow(records, *, slug, license, split, encoder):
    """Universal adapter for n8n workflow-generation datasets.

    Detects six common input shapes and emits one ElizaRecord per row with
    `task_type='n8n_workflow_generation'`. The supervised target is the
    elizaOS planner envelope encoded with the configured expected-response encoder — `thought`, `actions[]
    {name, params:{workflow}}`, `providers[]`, `text`, `simple` — matching
    nubilio's runtime planner output exactly.

    Input shapes handled:
      A) {messages:[{role,content},...]}                    — OpenAI/SFT
      B) {prompt|instruction|input, json|answer|output|completion[, thinking]}
      C) {workflow_json, workflow_name, integrations, ...}  — Ker102 master
      D) {name, nodes, connections}                          — batuhanilgarr
      E) {key, value}                                        — 0xarchit kv
      F) {prompt, chosen, rejected, ...}                     — DPO (uses chosen)
    """
    seen: set[str] = set()
    emitted = 0
    for r in records:
        if not isinstance(r, dict):
            continue

        prompt_text: str = ""
        target_text: str = ""
        memory: list[dict[str, Any]] = []
        sys_prompt: str = ""
        thinking: str = ""

        # Shape A: messages list
        msgs = r.get("messages") or r.get("conversations")
        if isinstance(msgs, list) and msgs:
            sys_prompt, memory, current, final = _split_history(msgs)
            if not current or not final:
                continue
            prompt_text = current.get("content", "")
            target_text = final.get("content", "") or ""

        # Shape F: DPO triples
        elif isinstance(r.get("chosen"), str) and r.get("prompt"):
            prompt_text = str(r.get("prompt") or "")
            target_text = str(r.get("chosen") or "")

        # Shape C: workflow_json + metadata (Ker102 master)
        elif r.get("workflow_json"):
            wf_raw = r.get("workflow_json")
            target_text = wf_raw if isinstance(wf_raw, str) else json.dumps(wf_raw)
            name = (r.get("workflow_name") or "").strip()
            integrations = r.get("integrations") or ""
            category = r.get("category") or ""
            if isinstance(integrations, str) and integrations.startswith("["):
                try:
                    integrations = ", ".join(json.loads(integrations))
                except json.JSONDecodeError:
                    pass
            prompt_text = (
                f"Generate the JSON for an n8n workflow named '{name or 'untitled'}'"
                + (f" in the '{category}' category" if category else "")
                + (f" using these integrations: {integrations}" if integrations else "")
                + ". Return only the workflow JSON."
            )

        # Shape D: nodes + connections (batuhanilgarr)
        elif r.get("nodes") is not None and r.get("connections") is not None:
            nodes_v = r.get("nodes")
            conns_v = r.get("connections")
            try:
                nodes_obj = json.loads(nodes_v) if isinstance(nodes_v, str) else nodes_v
                conns_obj = json.loads(conns_v) if isinstance(conns_v, str) else conns_v
            except json.JSONDecodeError:
                continue
            wf = {
                "name": r.get("name") or "",
                "nodes": nodes_obj,
                "connections": conns_obj,
            }
            prompt_text = _n8n_synth_prompt_from_workflow(wf)
            target_text = json.dumps(wf, ensure_ascii=False, separators=(",", ":"))

        # Shape E: kv (0xarchit)
        elif isinstance(r.get("key"), str) and isinstance(r.get("value"), str):
            prompt_text = r.get("key") or ""
            target_text = r.get("value") or ""

        # Shape B: prompt-completion pair
        else:
            instruction = _n8n_first_str(r, ["instruction"])
            inp = _n8n_first_str(r, ["input"])
            prompt_only = _n8n_first_str(r, ["prompt", "question", "query"])
            target_text = _n8n_first_str(
                r, ["json", "answer", "output", "completion", "response"]
            )
            if not target_text:
                continue
            if instruction and inp:
                prompt_text = f"{instruction}\n\n{inp}".strip()
            elif instruction:
                prompt_text = instruction
            elif prompt_only:
                prompt_text = prompt_only
            elif inp:
                prompt_text = inp
            else:
                continue
            t = r.get("thinking")
            if isinstance(t, str) and t.strip():
                thinking = t

        if not prompt_text or not target_text:
            continue

        # Skip workflow-analysis tasks (image→description) that get
        # mis-tagged as generation. The davidrpatton dataset is the main
        # offender — its prompts begin with `<image>` and the assistant
        # output is a prose description that happens to embed the workflow.
        if prompt_text.lstrip().startswith("<image>"):
            continue

        # Recover a real workflow object from the raw target. This collapses
        # the heterogeneous source shapes (raw JSON, fenced JSON, prose-
        # prefixed JSON, French `<thinking>` chains-of-thought) into a single
        # canonical structure we can re-emit deterministically.
        wf = _n8n_extract_workflow(target_text)
        if wf is None:
            continue

        dedup = stable_id(slug, prompt_text, json.dumps(wf, sort_keys=True))
        if dedup in seen:
            continue
        seen.add(dedup)

        response = encoder.encode(_n8n_planner_target(wf))
        response_shape = "structured_envelope"
        emitted += 1

        current_msg = {
            "role": "user",
            "speaker": "user",
            "content": prompt_text,
            "channel": "dm",
        }
        md: dict[str, Any] = {
            "original_id": str(r.get("id") or r.get("workflow_id") or dedup),
            "response_shape": response_shape,
        }
        if sys_prompt:
            md["system_prompt"] = sys_prompt
        if thinking:
            md["thinking"] = thinking
        # Carry over a few useful columns when present
        for k in (
            "category",
            "complexity",
            "node_count",
            "integrations",
            "source_url",
            "source_title",
            "workflow_name",
        ):
            v = r.get(k)
            if v not in (None, "", []):
                md[k] = v if not isinstance(v, (dict, list)) else json.dumps(v)

        yield build(
            roomName=stable_id(slug, prompt_text),
            agentId="agent",
            memoryEntries=memory,
            currentMessage=current_msg,
            expectedResponse=response,
            availableActions=N8N_WORKFLOW_ACTIONS.copy(),
            task_type="n8n_workflow_generation",
            source_dataset=slug,
            license=license,
            split=split,
            extra_metadata=md,
        )
