"""Synthesize planner-stage `eliza_native_v1` rows for the *current* agent /
orchestration action surface.

The runtime collapsed the old multi-action orchestrator/app/skill surface
(`SPAWN_AGENT`, `SEND_TO_AGENT`, `STOP_AGENT`, `TASK_CONTROL`, `TASK_HISTORY`,
`TASK_SHARE`, `FINALIZE_WORKSPACE`, `PROVISION_WORKSPACE`, `MANAGE_ISSUES`,
plus old PLUGIN / per-leaf skill actions) into four parent actions:

  - **TASKS**  — sub-ops via the `action` param: create, spawn_agent, send,
    stop_agent, list_agents, cancel, history, control, share,
    provision_workspace, submit_workspace, manage_issues, archive, reopen.
    (`plugins/plugin-agent-orchestrator/src/actions/tasks.ts`)
  - **APP**    — sub-ops: launch, relaunch, load_from_directory, list, create.
    (`plugins/plugin-app-control/src/actions/app.ts`)
  - **USE_SKILL** — invoke an enabled skill by `slug` (`mode` ∈ script|guidance|auto).
    (`plugins/plugin-agent-skills/src/actions/use-skill.ts`)
  - **SKILL**  — catalog ops via `action`: search, details, sync, toggle,
    install, uninstall. (`plugins/plugin-agent-skills/src/actions/skill.ts`)

Each row is one Vercel AI SDK `generateText` planner boundary: a planner-stage
`request.system` (user_role / contexts / action specs / planner rules), a
trajectory-shaped `request.messages` (providers block: `provider:ENTITIES`,
`provider:RECENT_MESSAGES`, `# Received Message`), and a `response` carrying the
live planner envelope `{thought, toolCalls:[{id,name,args}], messageToUser?}`.

Deterministic — template tables + seeded `random`, no LLM API calls. A small
fraction (~6%) of rows are "subtle null": a vague request → empty `toolCalls`
plus a `messageToUser` clarification (these become REPLY-ish rows downstream).

Run:
    uv run python scripts/synthesize_agent_orch_actions.py --per-op 80
"""

from __future__ import annotations

import argparse
import logging
import random
import sys
from pathlib import Path
from typing import Any, Callable, Iterable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.native_record import native_tool_call_record, stable_id, write_jsonl  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("synth-agent-orch")

DEFAULT_OUT = ROOT / "data" / "synthesized" / "action_examples" / "agent_orch.jsonl"

# ─── shared planner-stage scaffolding ────────────────────────────────────

PLANNER_RULES = """planner_stage:
task: Plan next native tool calls.

rules:
- use only tools from the tools array; smallest grounded queue
- the action parameter on TASKS/APP/SKILL selects the sub-operation; never invent compound action names
- arguments grounded in user request or prior tool results; array params must be JSON arrays
- never use empty strings, placeholders, or invented values for required tool arguments
- when a tool matches the requested operation, call it even if details are missing; the handler owns follow-up questions, drafts, confirmations, refusal
- do not ask a follow-up via messageToUser when a matching tool exists
- if no tool fits or task is complete, return no toolCalls and set messageToUser"""

CONTEXT_LINE = "- agents: Coding/task sub-agent lifecycle, workspaces, GitHub issues, apps, and skills."

# Per-parent-action one-line spec rendered into the system prompt.
ACTION_SPECS: dict[str, str] = {
    "TASKS": (
        "- TASKS — orchestrator task-agent + workspace lifecycle. action ∈ {create, spawn_agent, send, "
        "stop_agent, list_agents, cancel, history, control, share, provision_workspace, submit_workspace, "
        "manage_issues, archive, reopen}. Sub-args: task/repo/workdir/agentType/approvalPreset (create); "
        "task/agentType (spawn_agent); input/sessionId (send); all/sessionId (stop_agent); "
        "threadId/search/reason (cancel); metric/window/includeArchived (history); "
        "controlAction/threadId/instruction/note (control); sessionId (share); repo (provision_workspace); "
        "workspaceId/prTitle/commitMessage/draft/skipPR/baseBranch (submit_workspace); "
        "issueAction/repo/title/issueNumber/body/labels/state (manage_issues); taskId (archive, reopen)."
    ),
    "APP": (
        "- APP — manage apps. action ∈ {launch, relaunch, load_from_directory, list, create}. Sub-args: "
        "app (launch, relaunch); verify/workdir (relaunch); directory (load_from_directory); intent (create)."
    ),
    "USE_SKILL": (
        "- USE_SKILL — invoke an enabled skill by slug. Args: slug (required), mode ∈ {script, guidance, auto}."
    ),
    "SKILL": (
        "- SKILL — manage the skill catalog. action ∈ {search, details, sync, toggle, install, uninstall}."
    ),
}
REPLY_SPEC = "- REPLY — send a direct conversational reply."


def _system_prompt(parent_action: str) -> str:
    return (
        "user_role: OWNER\n\n"
        "selected_contexts: agents\n\n"
        "contexts:\n"
        f"{CONTEXT_LINE}\n\n"
        "actions:\n"
        f"{ACTION_SPECS[parent_action]}\n"
        f"{REPLY_SPEC}\n\n"
        f"{PLANNER_RULES}"
    )


# Provider-block conversation history.
SPEAKERS = [
    "kira", "carlos", "olivia", "priya", "diana", "jin", "marta", "ethan", "hina",
    "alice", "bob", "fatima", "ivan", "sofia", "wei", "yuki", "nadia", "george", "leo", "mia",
]
AGENTS = ["Eliza", "Iris", "Kai", "Ava", "Nova", "Sage", "Atlas", "Lyra", "Lumi", "Rune", "Orion", "Vega", "Sol"]

# Generic "lead-in" prior turns that don't bias toward any particular op.
LEAD_INS: list[list[tuple[str, str]]] = [
    [],
    [("user", "the dashboard looks stale")],
    [("user", "the build's been flaky lately")],
    [("user", "I want to add a capability"), ("agent", "I can check the skill catalog.")],
    [("user", "hey")],
    [("user", "the build's been flaky lately"), ("agent", "want me to look into it?")],
]

# Vague follow-ups used for subtle-null rows, keyed by language.
VAGUE_BY_LANG: dict[str, list[str]] = {
    "en": ["do the thing", "the usual", "you know what to do", "go ahead", "do it", "handle it"],
    "zh": ["你知道该做什么", "照旧", "去做吧"],
    "es": ["ya sabes qué hacer", "lo de siempre", "hazlo"],
    "fr": ["tu sais quoi faire", "comme d'habitude", "vas-y"],
    "ja": ["いつものやつ", "よろしく", "あれやっといて"],
    "de": ["du weißt schon", "wie immer", "mach es"],
    "pt": ["você sabe o que fazer", "o de sempre", "manda ver"],
}
CLARIFY_BY_LANG: dict[str, str] = {
    "en": "Could you say a bit more about what you'd like me to do?",
    "zh": "能再具体说一下你想让我做什么吗？",
    "es": "¿Puedes decirme un poco más sobre lo que quieres que haga?",
    "fr": "Peux-tu préciser un peu ce que tu veux que je fasse ?",
    "ja": "もう少し詳しく、何をしてほしいか教えてもらえますか？",
    "de": "Kannst du etwas genauer sagen, was ich tun soll?",
    "pt": "Pode me dizer um pouco mais sobre o que você quer que eu faça?",
}
VAGUE_THOUGHT = "The request is too vague to invoke a tool — ask for specifics."

LANGS = ["en", "en", "en", "zh", "es", "fr", "ja", "de", "pt"]

# Localized prefixes that wrap an English payload so the row reads multilingual.
LANG_WRAP: dict[str, Callable[[str], str]] = {
    "en": lambda s: s,
    "zh": lambda s: f"帮我：{s}",
    "es": lambda s: f"por favor: {s}",
    "fr": lambda s: f"s'il te plaît : {s}",
    "ja": lambda s: f"お願い：{s}",
    "de": lambda s: f"bitte: {s}",
    "pt": lambda s: f"por favor: {s}",
}


def _providers_message(speaker: str, agent: str, prior: list[tuple[str, str]], current: str) -> str:
    """Render the trajectory-shaped user turn (providers block + received message)."""
    ents = f'# People in the Room\n"{speaker}"\n"{agent}"'
    convo_lines = [f"{(speaker if who == 'user' else agent)}: {txt}" for who, txt in prior]
    convo_lines.append(f"{speaker}: {current}")
    convo = "# Conversation Messages\n" + "\n".join(convo_lines)
    return (
        "provider:ENTITIES:\n"
        f"{ents}\n\n"
        "provider:RECENT_MESSAGES:\n"
        f"{convo}\n\n"
        "# Received Message\n"
        f"{speaker}: {current}"
    )


# ─── op tables ───────────────────────────────────────────────────────────
#
# Each op entry is a list of (user_message, thought, args) cases (English
# canonical). The `action` key is injected automatically. Args are grounded
# in the message text.

Case = tuple[str, str, dict[str, Any]]

TASKS_OPS: dict[str, list[Case]] = {
    "create": [
        ("spawn a codex agent on elizaos/eliza to: fix the failing auth tests",
         "User wants a coding task done — spawn a task agent for it.",
         {"task": "fix the failing auth tests", "repo": "elizaos/eliza", "agentType": "codex"}),
        ("start a coding task in /Users/me/code/weather-app: add a 7-day forecast view",
         "User wants a coding task started in a local workspace.",
         {"task": "add a 7-day forecast view", "workdir": "/Users/me/code/weather-app", "agentType": "claude"}),
        ("kick off a task on elizaOS-plugins/plugin-discord to migrate to discord.js v14 with the autonomous approval preset",
         "User wants a new coding task with a specific approval preset.",
         {"task": "migrate to discord.js v14", "repo": "elizaOS-plugins/plugin-discord", "agentType": "codex",
          "approvalPreset": "autonomous"}),
        ("have a pi agent refactor the payments module in this repo",
         "User wants a task agent on the current workspace.",
         {"task": "refactor the payments module", "agentType": "pi"}),
    ],
    "spawn_agent": [
        ("add a second agent to also work on the docs site rebuild",
         "Add another agent to work alongside the running one.",
         {"task": "rebuild the docs site", "agentType": "claude"}),
        ("spin up another codex agent to chase down the flaky e2e tests in parallel",
         "Spawn an additional task agent for parallel work.",
         {"task": "stabilize the flaky e2e tests", "agentType": "codex"}),
        ("bring on one more agent for the typescript strict-mode migration",
         "User wants an extra agent for a parallel workstream.",
         {"task": "typescript strict-mode migration", "agentType": "claude"}),
    ],
    "send": [
        ("tell session sess-bd-7e3f: rebase onto develop before pushing",
         "Relay the user's input to the running task agent's session.",
         {"input": "rebase onto develop before pushing", "sessionId": "sess-bd-7e3f"}),
        ("send to the running agent: skip the integration tests for now, just unit",
         "Forward an instruction to the active task agent.",
         {"input": "skip the integration tests for now, just unit"}),
        ("reply to sess-codex-44: yes, go ahead and open the PR",
         "Relay an approval to a specific session.",
         {"input": "yes, go ahead and open the PR", "sessionId": "sess-codex-44"}),
    ],
    "stop_agent": [
        ("stop the running agent", "User wants the running agent stopped.", {"all": True}),
        ("kill session sess-codex-12", "User wants a specific session terminated.", {"sessionId": "sess-codex-12"}),
        ("halt all task agents now", "User wants every task agent stopped.", {"all": True}),
    ],
    "list_agents": [
        ("any agents still alive?", "User is asking what task agents are active — list them.", {}),
        ("show me the running task agents", "User wants the active task-agent list.", {}),
        ("what's running right now?", "User wants a list of active task agents.", {}),
    ],
    "cancel": [
        ("cancel thread thr-bb-2 — we changed direction", "User wants to cancel a task thread.",
         {"threadId": "thr-bb-2", "reason": "requirements changed"}),
        ("drop the coding task about the discord migration", "Cancel a task matched by description.",
         {"search": "discord migration"}),
        ("abort thr-auth-9, no longer needed", "User wants a task thread cancelled.",
         {"threadId": "thr-auth-9", "reason": "no longer needed"}),
    ],
    "history": [
        ("how many coding tasks did we run last week?", "User wants a count over a window.",
         {"metric": "count", "window": "last_7_days"}),
        ("show details on the latest task", "User wants the most recent task's detail.",
         {"metric": "detail", "window": "active"}),
        ("list all my coding tasks including archived ones", "User wants the full task list.",
         {"metric": "list", "includeArchived": True}),
        ("what tasks ran today?", "User wants today's task history.", {"metric": "list", "window": "today"}),
    ],
    "control": [
        ("pause task thr-bb-2 for now", "User wants to pause a task thread.",
         {"controlAction": "pause", "threadId": "thr-bb-2"}),
        ("resume thr-auth-12 and tell it to also add docs for the new endpoint",
         "User wants to resume a paused thread with a follow-up instruction.",
         {"controlAction": "resume", "threadId": "thr-auth-12", "instruction": "also add docs for the new endpoint"}),
        ("stop thr-bb-7, note it down as blocked on review", "User wants to stop a thread with a note.",
         {"controlAction": "stop", "threadId": "thr-bb-7", "note": "blocked on review"}),
        ("continue thr-codex-3 — keep going with the migration", "User wants a thread to continue.",
         {"controlAction": "continue", "threadId": "thr-codex-3", "instruction": "keep going with the migration"}),
    ],
    "share": [
        ("can I see what session sess-codex-44 produced?", "User wants to see a task's output — surface the artifact.",
         {"sessionId": "sess-codex-44"}),
        ("show me the diff from the running agent", "User wants the active task agent's output shared.", {}),
        ("share the result of sess-bd-7e3f", "User wants a specific session's output.", {"sessionId": "sess-bd-7e3f"}),
    ],
    "provision_workspace": [
        ("set up a workspace for elizaos/eliza", "User wants a coding workspace provisioned.",
         {"repo": "elizaos/eliza"}),
        ("provision a clean workspace on elizaOS-plugins/plugin-telegram", "Provision a workspace for a repo.",
         {"repo": "elizaOS-plugins/plugin-telegram"}),
        ("clone anthropics/claude-cookbooks into a workspace", "User wants a workspace for a repo.",
         {"repo": "anthropics/claude-cookbooks"}),
    ],
    "submit_workspace": [
        ("submit workspace ws-12 — title the PR 'Add forecast view', commit as 'feat: 7-day forecast'",
         "User wants to commit, push, and open a PR for a workspace.",
         {"workspaceId": "ws-12", "prTitle": "Add forecast view", "commitMessage": "feat: 7-day forecast"}),
        ("finalize the current workspace as a draft PR against develop",
         "User wants a draft PR off the active workspace.",
         {"draft": True, "baseBranch": "develop"}),
        ("push workspace ws-7 but skip the PR for now", "User wants to commit/push without a PR.",
         {"workspaceId": "ws-7", "skipPR": True}),
    ],
    "manage_issues": [
        ("list open issues on anthropics/claude-cookbooks", "User wants a GitHub issue listing.",
         {"issueAction": "list", "repo": "anthropics/claude-cookbooks", "state": "open"}),
        ("open an issue on elizaos/eliza titled 'flaky auth tests' with labels bug, ci",
         "User wants a new GitHub issue created.",
         {"issueAction": "create", "repo": "elizaos/eliza", "title": "flaky auth tests", "labels": ["bug", "ci"]}),
        ("close issue #142 on elizaOS-plugins/plugin-discord", "User wants a GitHub issue closed.",
         {"issueAction": "close", "repo": "elizaOS-plugins/plugin-discord", "issueNumber": 142}),
        ("add a comment to issue #88 on elizaos/eliza: fixed in the latest push",
         "User wants to comment on a GitHub issue.",
         {"issueAction": "comment", "repo": "elizaos/eliza", "issueNumber": 88, "body": "fixed in the latest push"}),
        ("add labels needs-review, priority-high to issue #57 on elizaos/eliza",
         "User wants labels added to a GitHub issue.",
         {"issueAction": "add_labels", "repo": "elizaos/eliza", "issueNumber": 57,
          "labels": ["needs-review", "priority-high"]}),
    ],
    "archive": [
        ("close out task thr-auth-12 — it's done", "User wants the coding task archived.", {"taskId": "thr-auth-12"}),
        ("archive the forecast-view coding task", "User wants a finished coding task archived.",
         {"taskId": "thr-forecast-3"}),
        ("file away thr-bd-9, we shipped it", "User wants the task archived.", {"taskId": "thr-bd-9"}),
    ],
    "reopen": [
        ("reopen the archived coding task thr-auth-12", "User wants the archived coding task reopened.",
         {"taskId": "thr-auth-12"}),
        ("un-archive thr-forecast-3, there's a regression", "User wants an archived task brought back.",
         {"taskId": "thr-forecast-3"}),
        ("bring back coding task thr-bd-9", "User wants the archived task reopened.", {"taskId": "thr-bd-9"}),
    ],
}

APP_OPS: dict[str, list[Case]] = {
    "launch": [
        ("open music-player", "User wants an installed app launched.", {"app": "music-player"}),
        ("launch the companion app", "User wants an installed app launched.", {"app": "companion"}),
        ("start the workout-logger app", "User wants an installed app launched.", {"app": "workout-logger"}),
    ],
    "relaunch": [
        ("restart the companion app", "User wants the app restarted.", {"app": "companion"}),
        ("relaunch weather-app and verify it from /Users/me/code/weather-app",
         "User wants the app restarted and verified.",
         {"app": "weather-app", "verify": True, "workdir": "/Users/me/code/weather-app"}),
        ("reload music-player", "User wants the app restarted.", {"app": "music-player"}),
    ],
    "load_from_directory": [
        ("scan /Users/me/code/weather-app for apps and register them", "User wants apps in a directory registered.",
         {"directory": "/Users/me/code/weather-app"}),
        ("load the app at /home/me/projects/companion", "User wants an app loaded from a directory.",
         {"directory": "/home/me/projects/companion"}),
        ("register the app in /workspace/eliza/apps/app-notes", "User wants an app registered from a directory.",
         {"directory": "/workspace/eliza/apps/app-notes"}),
    ],
    "list": [
        ("what apps do I have installed?", "User wants the installed-app list.", {}),
        ("show me my apps", "User wants the installed-app list.", {}),
        ("list available apps", "User wants the installed-app list.", {}),
    ],
    "create": [
        ("make an app: a workout logger with sets, reps, and a calendar view", "User wants a new app scaffolded and built.",
         {"intent": "a workout logger with sets, reps, and a calendar view"}),
        ("build me an app that tracks daily water intake with a weekly chart", "User wants a new app created.",
         {"intent": "tracks daily water intake with a weekly chart"}),
        ("create an app: a markdown notes board with tags and search", "User wants a new app scaffolded.",
         {"intent": "a markdown notes board with tags and search"}),
    ],
}

SKILL_OPS: dict[str, list[Case]] = {
    "search": [
        ("browse the skill catalog", "User is browsing the skill catalog.", {}),
        ("search skills for image generation", "User wants to search the skill catalog.", {"query": "image generation"}),
        ("find a skill for working with notion", "User wants to search the catalog.", {"query": "notion"}),
    ],
    "details": [
        ("tell me more about the yara-authoring skill", "User wants details about a skill.", {"slug": "yara-authoring"}),
        ("what does the obsidian skill do?", "User wants details about a skill.", {"slug": "obsidian"}),
        ("show the details for the github skill", "User wants details about a skill.", {"slug": "github"}),
    ],
    "sync": [
        ("update the skill catalog", "User wants the skill catalog refreshed.", {}),
        ("sync skills from the registry", "User wants the skill catalog synced.", {}),
        ("refresh available skills", "User wants the skill catalog synced.", {}),
    ],
    "toggle": [
        ("enable the things-mac skill", "User wants a skill enabled.", {"slug": "things-mac", "enabled": True}),
        ("turn off the spotify-player skill", "User wants a skill disabled.", {"slug": "spotify-player", "enabled": False}),
        ("toggle the tmux skill on", "User wants a skill enabled.", {"slug": "tmux", "enabled": True}),
    ],
    "install": [
        ("install the weather skill", "User wants a skill installed from the catalog.", {"slug": "weather"}),
        ("add the slack skill", "User wants a skill installed.", {"slug": "slack"}),
        ("install nano-banana-pro from the registry", "User wants a skill installed.", {"slug": "nano-banana-pro"}),
    ],
    "uninstall": [
        ("uninstall the tmux skill", "User wants a skill removed.", {"slug": "tmux"}),
        ("remove the trello skill", "User wants a skill removed.", {"slug": "trello"}),
        ("delete the canvas skill", "User wants a skill removed.", {"slug": "canvas"}),
    ],
}

USE_SKILL_CASES: list[Case] = [
    ("invoke the weather skill", "User wants an enabled skill invoked.", {"slug": "weather", "mode": "script"}),
    ("run the github skill in guidance mode", "User wants a skill's guidance, not its script.",
     {"slug": "github", "mode": "guidance"}),
    ("use the obsidian skill to file this note", "User wants an enabled skill to do the work.",
     {"slug": "obsidian", "mode": "auto"}),
    ("kick off the healthcheck skill", "User wants an enabled skill invoked.", {"slug": "healthcheck", "mode": "script"}),
    ("invoke plan-my-day", "User wants an enabled skill invoked.", {"slug": "plan-my-day", "mode": "auto"}),
]


# ─── row builder ─────────────────────────────────────────────────────────

def _meta(parent_action: str, op: str, lang: str, idx: int, subtle_null: bool, msg: str) -> dict[str, Any]:
    synth_op = parent_action if parent_action == "USE_SKILL" else f"{parent_action}/{op}"
    m: dict[str, Any] = {
        "task_type": "tool_call",
        "source_dataset": "synth-agent-orch",
        "synth_op": synth_op,
        "synth_lang": lang,
        "split": "train",
        "id": stable_id("agent-orch", parent_action, op, lang, idx, subtle_null, msg),
    }
    if subtle_null:
        m["subtle_null"] = True
    else:
        m["synth_action"] = parent_action
    return m


def _tool_call_row(parent_action: str, op: str, case: Case, lang: str, idx: int) -> dict[str, Any]:
    user_msg_en, thought, args = case
    base_args = dict(args)
    if parent_action != "USE_SKILL":
        base_args = {"action": op, **base_args}
    speaker = SPEAKERS[(idx * 7 + len(parent_action)) % len(SPEAKERS)]
    agent = AGENTS[(idx * 3 + len(op)) % len(AGENTS)]
    prior = LEAD_INS[(idx + len(op)) % len(LEAD_INS)]
    user_msg = LANG_WRAP[lang](user_msg_en)
    turns = [{"role": "user", "content": _providers_message(speaker, agent, prior, user_msg)}]
    return native_tool_call_record(
        system=_system_prompt(parent_action),
        turns=turns,
        thought=thought,
        tool_calls=[{"name": parent_action, "args": base_args, "id": "call_0"}],
        metadata=_meta(parent_action, op, lang, idx, False, user_msg_en),
    )


def _null_row(parent_action: str, op: str, lang: str, idx: int) -> dict[str, Any]:
    speaker = SPEAKERS[(idx * 5 + 1) % len(SPEAKERS)]
    agent = AGENTS[(idx * 2 + 4) % len(AGENTS)]
    prior = LEAD_INS[(idx * 3) % len(LEAD_INS)]
    vague_choices = VAGUE_BY_LANG.get(lang, VAGUE_BY_LANG["en"])
    vague = vague_choices[idx % len(vague_choices)]
    turns = [{"role": "user", "content": _providers_message(speaker, agent, prior, vague)}]
    return native_tool_call_record(
        system=_system_prompt(parent_action),
        turns=turns,
        thought=VAGUE_THOUGHT,
        tool_calls=[],
        message_to_user=CLARIFY_BY_LANG.get(lang, CLARIFY_BY_LANG["en"]),
        metadata=_meta(parent_action, op, lang, idx, True, vague),
    )


def _ops_for(parent_action: str) -> dict[str, list[Case]]:
    if parent_action == "TASKS":
        return TASKS_OPS
    if parent_action == "APP":
        return APP_OPS
    if parent_action == "SKILL":
        return SKILL_OPS
    if parent_action == "USE_SKILL":
        return {"USE_SKILL": USE_SKILL_CASES}
    raise KeyError(parent_action)


PARENT_ACTIONS = ["TASKS", "APP", "USE_SKILL", "SKILL"]
NULL_FRACTION = 0.06  # ~6% subtle-null rows


def generate(per_op: int, seed: int) -> Iterable[dict[str, Any]]:
    rng = random.Random(seed)  # reserved for future jitter; output stays deterministic
    del rng
    null_per_op = max(1, round(per_op * NULL_FRACTION))
    tool_per_op = max(1, per_op - null_per_op)
    for parent_action in PARENT_ACTIONS:
        for op, cases in _ops_for(parent_action).items():
            for i in range(tool_per_op):
                case = cases[i % len(cases)]
                lang = LANGS[i % len(LANGS)] if i % 5 == 0 else "en"
                yield _tool_call_row(parent_action, op, case, lang, i)
            for j in range(null_per_op):
                lang = LANGS[(j * 2) % len(LANGS)]
                yield _null_row(parent_action, op, lang, j)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--per-op", type=int, default=80, help="rows per sub-operation (default 80)")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"output JSONL path (default {DEFAULT_OUT})")
    ap.add_argument("--seed", type=int, default=0xA0_07_2026)
    args = ap.parse_args()

    rows = list(generate(args.per_op, args.seed))
    n = write_jsonl(rows, args.out)
    nulls = sum(1 for r in rows if not r["response"].get("toolCalls"))
    log.info("wrote %d agent-orch eliza_native_v1 rows (%d subtle-null) to %s", n, nulls, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
