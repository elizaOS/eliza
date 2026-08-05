"""Synthesize ~1,000 canonical native JSON tool-call records for operations actions.

Targets ten actions across plugin-cron and plugin-commands, with about 100
records per action (~70 English and ~30 multilingual). The cron actions are
polymorphic, so examples span create, update, delete, list, and run operations
while preserving the canonical action name.

5–10% of records emit the subtle-null shape (`thought:/text:` REPLY) — these
are messages that *look* like the target action but lack the disambiguating
slot the action requires, so the agent should ask a clarifying question
instead of calling the tool.

Run:
    .venv/bin/python scripts/synthesize_commerce_actions.py
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
from pathlib import Path
from typing import Any, Callable, Iterable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.eliza_record import (  # noqa: E402
    ACTION_REPLY,
    ACTION_TASK_CALL,
    build,
    stable_id,
)
from lib.expected_response import ExpectedResponseEncoder, JsonExpectedResponseEncoder  # noqa: E402

OUT_PATH = ROOT / "data" / "synthesized" / "action_examples" / "commerce.jsonl"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("synth-commerce")


# ───────────────────────────── shared pools ──────────────────────────────

# 24 personas — mix of cultural backgrounds & English-as-second-language.
USER_NAMES = [
    "alice", "bob", "carlos", "diana", "ethan", "fatima", "george",
    "hina", "ivan", "jin", "kira", "leo", "mia", "noah", "olivia",
    "priya", "quinn", "raj", "sofia", "tomas", "yuki", "zara",
    "marco", "anika",
]

AGENT_NAMES = [
    "Iris", "Kai", "Ava", "Nova", "Echo", "Sage", "Atlas", "Lyra",
    "Pico", "Lumi", "Rune", "Vega", "Sol", "Orion", "Mira", "Tess",
    "eliza", "Eliza",
]

ROOM_KINDS = [
    "dm", "channel:general", "channel:ops", "channel:engineering",
    "channel:retail", "channel:fulfillment", "channel:cs", "channel:design",
    "channel:bookings", "channel:scheduling", "channel:standup",
]

CHANNELS = ["dm", "public", "voice"]


# ────────────────────────── domain reference data ────────────────────────

CRON_SCHEDULES = [
    ("every 5 minutes", "*/5 * * * *"),
    ("every hour", "0 * * * *"),
    ("daily at 9am", "0 9 * * *"),
    ("weekdays at noon", "0 12 * * 1-5"),
    ("Monday mornings", "0 8 * * 1"),
    ("first of the month", "0 0 1 * *"),
    ("every 30 minutes", "*/30 * * * *"),
    ("at 6pm Pacific", "0 18 * * *"),
    ("once on May 12 at 14:00", "@once 2026-05-12T14:00"),
]

CRON_TASKS = [
    "post the standup digest",
    "send daily KPI email",
    "rotate Slack status",
    "back up the workspace",
    "pull GitHub PR stats",
    "ping the on-call engineer",
    "refresh the cached metrics",
    "summarize yesterday's tickets",
    "tweet the weekly recap",
    "clean stale branches",
]

CRON_NAMES = [
    "daily-standup", "kpi-digest", "weekly-recap", "backup-workspace",
    "rotate-status", "stale-branch-cleanup", "metrics-refresh",
    "ticket-summary", "oncall-ping", "monthly-report",
]

CRON_IDS = [
    "cron_a1b2c3", "cron_99ff01", "cron_xy77z2", "cron_2026-05",
    "cron_ee0011", "cron_dailykpi",
]


# ────────────────────────── multilingual phrasebook ──────────────────────

# 6 languages × multiple phrasings per intent. Each entry is a list of
# (locale_tag, phrase) tuples used to drive the multilingual slice.
ML_LOCALES = ["zh", "es", "fr", "ja", "de", "pt"]


# ───────────────────────────── style helpers ─────────────────────────────

# 10+ styles. Each style is a (name, transformer) pair. The transformer
# takes a base English message and returns the styled message. For the
# subtle-null path we return a special marker the caller intercepts.

def _style_direct(base: str, _rng: random.Random) -> str:
    return base


def _style_formal(base: str, _rng: random.Random) -> str:
    return f"Could you please {base[0].lower() + base[1:].rstrip('.')}? Thank you."


def _style_casual(base: str, rng: random.Random) -> str:
    suffix = rng.choice([" lol", " 🙏", " thx", " when u get a sec", " ty"])
    return f"yo, {base.lower()}{suffix}"


def _style_expert_shorthand(base: str, _rng: random.Random) -> str:
    return base.replace("please", "").replace("can you ", "").strip()


def _style_voice_asr(base: str, _rng: random.Random) -> str:
    # ASR-style: lowercase, no punctuation, occasional disfluency.
    return ("um " + base.lower().replace(",", "").replace(".", "").replace("?", "")
            + " yeah").strip()


def _style_distracted_rambling(base: str, rng: random.Random) -> str:
    asides = [
        "sorry brain is fried", "back-to-back meetings today",
        "kid is yelling in the background", "anyway",
        "wait where was I", "ok focus",
    ]
    aside = rng.choice(asides)
    return f"{aside} — {base.lower()} — yeah that's it"


def _style_broken_english(base: str, _rng: random.Random) -> str:
    # Deliberately non-native: drop articles, simplify verbs.
    out = base
    for w in ("the ", "a ", "an "):
        out = out.replace(w, "")
        out = out.replace(w.capitalize(), "")
    return out.lower().replace("please", "plz")


def _style_self_correcting(base: str, rng: random.Random) -> str:
    edit = rng.choice([
        " — wait, scratch that, ",
        " actually no, ",
        " hm let me restart, ",
    ])
    return f"i want to {base.lower()}{edit}{base.lower()}"


STYLES: list[tuple[str, Callable[[str, random.Random], str]]] = [
    ("direct", _style_direct),
    ("formal", _style_formal),
    ("casual", _style_casual),
    ("expert-shorthand", _style_expert_shorthand),
    ("voice-asr", _style_voice_asr),
    ("distracted-rambling", _style_distracted_rambling),
    ("broken-english", _style_broken_english),
    ("self-correcting", _style_self_correcting),
]


# ─────────────────────── memory entry generators ─────────────────────────

MEMORY_SNIPPETS = [
    {"role": "user", "content": "morning"},
    {"role": "assistant", "content": "Good morning. What's on your plate?"},
    {"role": "user", "content": "the storefront looked weird earlier"},
    {"role": "assistant", "content": "I'll keep an eye on the storefront — anything specific?"},
    {"role": "user", "content": "btw the warehouse rep emailed"},
    {"role": "assistant", "content": "Noted. I'll loop in fulfillment if needed."},
    {"role": "user", "content": "which timezone is the new advisor in"},
    {"role": "assistant", "content": "Their Calendly is set to Pacific Time."},
    {"role": "user", "content": "calendar got crowded this week"},
    {"role": "assistant", "content": "Want me to surface conflicts?"},
    {"role": "user", "content": "deploys are passing"},
    {"role": "assistant", "content": "Good — anything else to schedule?"},
    {"role": "user", "content": "we should automate that report"},
    {"role": "assistant", "content": "Sure — give me a schedule and I'll wire it up."},
]


def make_memory(rng: random.Random, speaker: str, channel: str) -> list[dict[str, Any]]:
    """Return 0–6 memory entries. Sampled as a contiguous slice from
    MEMORY_SNIPPETS so the user/assistant alternation reads coherently."""
    n = rng.choices([0, 1, 2, 3, 4, 6], weights=[3, 3, 4, 3, 2, 1])[0]
    if n == 0:
        return []
    n = min(n, len(MEMORY_SNIPPETS))
    start = rng.randrange(0, len(MEMORY_SNIPPETS) - n + 1)
    snippets = MEMORY_SNIPPETS[start:start + n]
    out: list[dict[str, Any]] = []
    for s in snippets:
        out.append({
            "role": s["role"],
            "speaker": speaker if s["role"] == "user" else "agent",
            "content": s["content"],
            "channel": channel,
        })
    return out


# ────────────────────────────── builders ─────────────────────────────────

def _record(
    *,
    encoder: ExpectedResponseEncoder,
    rng: random.Random,
    user_msg: str,
    expected: dict[str, Any] | str,
    action_name: str,
    plugin: str,
    sub_op: str | None,
    style: str,
    language: str,
    is_subtle_null: bool,
    available_actions: list[str],
) -> dict[str, Any]:
    agent = rng.choice(AGENT_NAMES)
    user = rng.choice(USER_NAMES)
    room = rng.choice(ROOM_KINDS)
    channel = rng.choice(CHANNELS)

    expected_str = expected if isinstance(expected, str) else encoder.encode(expected)

    md: dict[str, Any] = {
        "agent_name": agent,
        "action_name": action_name,
        "plugin": plugin,
        "language": language,
        "style": style,
        "is_subtle_null": is_subtle_null,
        "room_kind": room,
    }
    if sub_op:
        md["sub_operation"] = sub_op

    rec = build(
        roomName=stable_id("synth-commerce", action_name, user_msg, agent, style, language,
                           user, channel, room),
        agentId=agent.lower(),
        memoryEntries=make_memory(rng, user, channel),
        currentMessage={
            "role": "user",
            "speaker": user,
            "content": user_msg,
            "channel": channel,
        },
        expectedResponse=expected_str,
        availableActions=available_actions,
        task_type="tool_call",
        source_dataset="synth-commerce-actions",
        license="synthetic",
        split="train",
        extra_metadata=md,
    )
    return rec.to_dict()


def _styled(base: str, style_idx: int, rng: random.Random) -> tuple[str, str]:
    name, fn = STYLES[style_idx % len(STYLES)]
    return name, fn(base, rng)


# ────────────────────────── per-action message banks ─────────────────────
#
# Each action provides:
#   • English prompt bank (~25–40 phrasings, spread across sub-ops where the
#     action is polymorphic)
#   • Multilingual prompt bank (≥3 entries per locale across {zh,es,fr,ja,de,pt})
#   • Argument builder: returns {} unless the wording authorizes a write,
#     in which case {"confirmed": True} is emitted (only for actions whose
#     spec exposes the `confirmed` parameter).
#   • Subtle-null prompt bank: looks-like-the-action but missing required
#     disambiguation → REPLY shape with thought + clarifying question.
#
# Each bank entry is (sub_op, message). For non-polymorphic actions sub_op
# is "default".


# ── plugin-cron ──────────────────────────────────────────────────────────

CRON_CREATE_EN = [
    ("interval", "create a cron that runs every 5 minutes to refresh the cached metrics"),
    ("interval", "make a cron every 30 minutes to ping the on-call engineer"),
    ("interval", "schedule every hour: pull GitHub PR stats"),
    ("cron_expr", "create cron 0 9 * * * — send daily KPI email, name it kpi-digest"),
    ("cron_expr", "schedule '0 12 * * 1-5' to post the standup digest"),
    ("cron_expr", "set up cron 0 8 * * 1: tweet the weekly recap"),
    ("cron_expr", "create a cron with expression '0 0 1 * *' to back up the workspace"),
    ("once", "schedule a one-time cron on 2026-05-12 at 14:00 to summarize yesterday's tickets"),
    ("once", "make a one-shot cron for 2026-06-01 09:00: rotate Slack status"),
    ("interval", "every 5 minutes, run a check for stale branches"),
    ("interval", "set a cron at every 15 minutes to clean stale branches"),
    ("cron_expr", "register cron */10 * * * * for refreshing metrics"),
    ("cron_expr", "schedule '30 18 * * *' — refresh the cached metrics"),
    ("cron_expr", "create cron 0 18 * * * named oncall-ping for ping the on-call engineer"),
    ("interval", "make a cron daily at 9am called daily-standup that posts the standup digest"),
    ("interval", "create a cron weekdays at noon — post the standup digest"),
    ("once", "one-time cron 2026-05-12T14:00 to summarize yesterday's tickets"),
    ("interval", "schedule a cron every 5 mins to refresh metrics"),
    ("cron_expr", "create cron expr 0 9 * * 1-5 — send daily KPI email"),
    ("interval", "set up a cron Monday mornings to tweet the weekly recap"),
    ("interval", "first of the month: back up the workspace, create that cron"),
    ("cron_expr", "create a cron with cron expression 0 6 * * * to clean stale branches"),
]

CRON_CREATE_ML = [
    ("zh", "interval", "创建一个每 5 分钟运行的 cron 任务来刷新缓存指标"),
    ("zh", "cron_expr", "调度 cron 表达式 0 9 * * *：发送每日 KPI 邮件"),
    ("zh", "interval", "每小时运行一次：拉取 GitHub PR 统计"),
    ("es", "interval", "crea un cron cada 30 minutos para hacer ping al ingeniero de guardia"),
    ("es", "cron_expr", "programa el cron '0 12 * * 1-5' para publicar el resumen de standup"),
    ("es", "once", "agenda un cron único para 2026-05-12 a las 14:00 para resumir tickets"),
    ("fr", "interval", "crée un cron toutes les 5 minutes qui rafraîchit les métriques"),
    ("fr", "cron_expr", "schedule cron 0 9 * * * envoie le KPI quotidien"),
    ("fr", "interval", "chaque heure: récupère les stats GitHub"),
    ("ja", "interval", "5 分ごとに実行する cron を作成、メトリクスを更新"),
    ("ja", "cron_expr", "cron 式 0 9 * * * を登録、毎日 KPI メールを送信"),
    ("ja", "once", "2026-05-12 14:00 に一度だけ走る cron を作成して、昨日のチケットを要約"),
    ("de", "interval", "lege einen Cron alle 5 Minuten an, der die Metriken auffrischt"),
    ("de", "cron_expr", "plane cron 0 9 * * 1-5 — sende den Tages-KPI-Mail"),
    ("de", "interval", "jeden Montagmorgen: poste den Wochenrückblick"),
    ("pt", "interval", "cria um cron a cada 5 minutos para atualizar as métricas"),
    ("pt", "cron_expr", "agenda cron 0 9 * * * para enviar o e-mail de KPI"),
    ("pt", "once", "cron único em 2026-05-12 14:00 para resumir os tickets de ontem"),
]

CRON_CREATE_NULL = [
    "create a cron",                # missing schedule + task
    "schedule something recurring",  # nothing concrete
    "make a cron job",                # underspecified
    "set up a recurring task",        # missing both fields
    "wire up a cron for that thing",  # which thing? when?
]


CRON_DELETE_EN = [
    ("by_id", "delete cron cron_a1b2c3"),
    ("by_id", "remove cron cron_99ff01"),
    ("by_id", "drop cron job cron_xy77z2"),
    ("by_id", "kill cron cron_2026-05"),
    ("by_id", "delete cron cron_ee0011 permanently"),
    ("by_name", "delete cron job named daily-standup"),
    ("by_name", "remove the kpi-digest cron"),
    ("by_name", "drop cron weekly-recap"),
    ("by_name", "delete the backup-workspace cron"),
    ("by_name", "delete cron rotate-status"),
    ("by_id", "remove cron_dailykpi"),
    ("by_name", "delete cron metrics-refresh"),
    ("by_name", "drop cron oncall-ping"),
    ("by_name", "kill the monthly-report cron"),
    ("by_id", "delete cron cron_a1b2c3 from the schedule"),
    ("by_name", "remove cron stale-branch-cleanup"),
    ("by_id", "delete cron cron_99ff01 immediately"),
    ("by_name", "drop the ticket-summary cron job"),
    ("by_name", "delete the cron called daily-standup"),
    ("by_id", "kill cron_xy77z2 forever"),
    ("by_name", "remove cron job 'rotate-status'"),
    ("by_id", "delete cron cron_2026-05 — please confirm"),
]

CRON_DELETE_ML = [
    ("zh", "by_id", "删除 cron 任务 cron_a1b2c3"),
    ("zh", "by_name", "删除名为 daily-standup 的 cron"),
    ("zh", "by_id", "永久删除 cron_99ff01"),
    ("es", "by_id", "elimina el cron cron_xy77z2"),
    ("es", "by_name", "borra el cron llamado kpi-digest"),
    ("es", "by_id", "remueve cron_dailykpi"),
    ("fr", "by_id", "supprime le cron cron_a1b2c3"),
    ("fr", "by_name", "efface le cron weekly-recap"),
    ("fr", "by_id", "supprime cron_ee0011 du planificateur"),
    ("ja", "by_id", "cron cron_a1b2c3 を削除"),
    ("ja", "by_name", "daily-standup という名前の cron を削除"),
    ("ja", "by_id", "cron_99ff01 を完全に削除"),
    ("de", "by_id", "lösche cron cron_a1b2c3"),
    ("de", "by_name", "entferne den Cron 'rotate-status'"),
    ("de", "by_id", "kill cron_xy77z2 dauerhaft"),
    ("pt", "by_id", "apaga o cron cron_a1b2c3"),
    ("pt", "by_name", "remove o cron chamado kpi-digest"),
    ("pt", "by_id", "deleta cron_dailykpi"),
]

CRON_DELETE_NULL = [
    "delete that cron",            # which one?
    "delete the cron",              # which?
    "remove that scheduled job",    # which?
    "kill it",                       # cron? which?
    "delete that broken cron job",   # which one
]


CRON_LIST_EN = [
    ("all", "list my cron jobs"),
    ("all", "show all cron jobs"),
    ("enabled", "list enabled crons"),
    ("disabled", "show disabled crons"),
    ("all", "what crons do I have"),
    ("all", "give me a rundown of my crons"),
    ("all", "list every cron job"),
    ("detail", "show details for cron daily-standup"),
    ("detail", "details for cron_a1b2c3"),
    ("detail", "describe the kpi-digest cron"),
    ("detail", "what does cron weekly-recap do"),
    ("all", "list crons"),
    ("enabled", "which crons are currently enabled"),
    ("all", "scheduled jobs please"),
    ("disabled", "show me crons that are turned off"),
    ("detail", "tell me everything about cron rotate-status"),
    ("all", "all crons"),
    ("all", "cron list"),
    ("enabled", "show running crons"),
    ("detail", "info on cron_xy77z2"),
    ("all", "list every scheduled job in the system"),
    ("disabled", "list paused crons"),
]

CRON_LIST_ML = [
    ("zh", "all", "列出我的 cron 任务"),
    ("zh", "enabled", "显示启用的 cron"),
    ("zh", "detail", "查看 daily-standup cron 的详情"),
    ("es", "all", "lista mis cron jobs"),
    ("es", "enabled", "muestra los cron activos"),
    ("es", "detail", "detalles del cron kpi-digest"),
    ("fr", "all", "liste mes crons"),
    ("fr", "disabled", "affiche les crons désactivés"),
    ("fr", "detail", "détails du cron weekly-recap"),
    ("ja", "all", "cron の一覧を表示"),
    ("ja", "enabled", "有効な cron を表示"),
    ("ja", "detail", "cron daily-standup の詳細"),
    ("de", "all", "liste meine Cron-Jobs"),
    ("de", "disabled", "zeig deaktivierte Crons"),
    ("de", "detail", "Details zum Cron rotate-status"),
    ("pt", "all", "lista meus cron jobs"),
    ("pt", "enabled", "mostra os crons ativos"),
    ("pt", "detail", "detalhes do cron kpi-digest"),
]

CRON_LIST_NULL: list[str] = []


CRON_RUN_EN = [
    ("by_name", "run cron daily-standup now"),
    ("by_name", "kick off the kpi-digest cron immediately"),
    ("by_id", "run cron cron_a1b2c3 now"),
    ("by_id", "trigger cron_99ff01 right now"),
    ("by_name", "manually run the weekly-recap cron"),
    ("by_id", "fire cron cron_xy77z2 once"),
    ("by_name", "execute cron oncall-ping ad-hoc"),
    ("by_name", "force-run the backup-workspace cron"),
    ("by_id", "run cron_2026-05 manually"),
    ("by_name", "run the daily-standup cron now please"),
    ("by_name", "trigger ticket-summary cron"),
    ("by_id", "run cron_dailykpi now"),
    ("by_name", "force the rotate-status cron to fire"),
    ("by_name", "kick the metrics-refresh cron"),
    ("by_id", "manually run cron_ee0011"),
    ("by_name", "execute monthly-report ahead of schedule"),
    ("by_name", "run the stale-branch-cleanup cron right now"),
    ("by_id", "run cron cron_a1b2c3 once on demand"),
    ("by_name", "test-fire the daily-standup cron"),
    ("by_id", "trigger cron_xy77z2 ad-hoc"),
    ("by_name", "run cron kpi-digest one off"),
    ("by_name", "fire weekly-recap manually"),
]

CRON_RUN_ML = [
    ("zh", "by_name", "立即运行 cron daily-standup"),
    ("zh", "by_id", "马上触发 cron_a1b2c3"),
    ("zh", "by_name", "手动执行 kpi-digest cron"),
    ("es", "by_name", "ejecuta el cron daily-standup ahora"),
    ("es", "by_id", "dispara cron_99ff01 ahora mismo"),
    ("es", "by_name", "corre el cron weekly-recap manualmente"),
    ("fr", "by_name", "lance le cron daily-standup maintenant"),
    ("fr", "by_id", "déclenche cron_xy77z2 immédiatement"),
    ("fr", "by_name", "exécute kpi-digest à la main"),
    ("ja", "by_name", "cron daily-standup を今すぐ実行"),
    ("ja", "by_id", "cron_a1b2c3 を即時実行"),
    ("ja", "by_name", "weekly-recap cron を手動で動かして"),
    ("de", "by_name", "führ den Cron daily-standup jetzt aus"),
    ("de", "by_id", "trigger cron_99ff01 sofort"),
    ("de", "by_name", "starte kpi-digest manuell"),
    ("pt", "by_name", "executa o cron daily-standup agora"),
    ("pt", "by_id", "dispara cron_a1b2c3 já"),
    ("pt", "by_name", "roda weekly-recap manualmente"),
]

CRON_RUN_NULL = [
    "run that cron",            # which?
    "kick it off now",           # what?
    "run it manually",            # which one?
    "fire the cron",              # which one
    "trigger that scheduled job", # which?
]


CRON_UPDATE_EN = [
    ("disable", "disable cron daily-standup"),
    ("disable", "pause the kpi-digest cron"),
    ("disable", "turn off cron cron_a1b2c3"),
    ("enable", "enable cron weekly-recap"),
    ("enable", "turn cron rotate-status back on"),
    ("enable", "re-enable cron_xy77z2"),
    ("schedule", "change daily-standup to run at 8am instead of 9am"),
    ("schedule", "update cron kpi-digest to '0 8 * * *'"),
    ("schedule", "switch cron weekly-recap to Monday at 7am"),
    ("schedule", "update cron_a1b2c3 schedule to */15 * * * *"),
    ("rename", "rename cron daily-standup to morning-standup"),
    ("rename", "rename cron_a1b2c3 to kpi-fast"),
    ("update_task", "update the task on cron daily-standup to also include weekend status"),
    ("update_task", "change cron weekly-recap task to tweet the weekly digest"),
    ("disable", "pause cron oncall-ping"),
    ("enable", "wake up cron metrics-refresh"),
    ("schedule", "set cron stale-branch-cleanup to once a week, Sunday 3am"),
    ("rename", "rename cron rotate-status to slack-status-rotator"),
    ("disable", "disable cron cron_99ff01"),
    ("enable", "enable cron monthly-report"),
    ("schedule", "change cron ticket-summary schedule to 0 18 * * *"),
    ("update_task", "update cron daily-standup so it pings the design channel too"),
]

CRON_UPDATE_ML = [
    ("zh", "disable", "停用 cron daily-standup"),
    ("zh", "schedule", "把 cron kpi-digest 改成 '0 8 * * *'"),
    ("zh", "rename", "把 cron_a1b2c3 重命名为 kpi-fast"),
    ("es", "disable", "desactiva el cron daily-standup"),
    ("es", "schedule", "actualiza el cron kpi-digest a '0 8 * * *'"),
    ("es", "rename", "renombra cron_a1b2c3 a kpi-fast"),
    ("fr", "disable", "désactive le cron daily-standup"),
    ("fr", "schedule", "passe le cron kpi-digest à '0 8 * * *'"),
    ("fr", "rename", "renomme cron_a1b2c3 en kpi-fast"),
    ("ja", "disable", "cron daily-standup を無効化"),
    ("ja", "schedule", "cron kpi-digest を '0 8 * * *' に変更"),
    ("ja", "rename", "cron_a1b2c3 を kpi-fast に改名"),
    ("de", "disable", "deaktiviere cron daily-standup"),
    ("de", "schedule", "ändere cron kpi-digest auf '0 8 * * *'"),
    ("de", "rename", "benenne cron_a1b2c3 in kpi-fast um"),
    ("pt", "disable", "desativa o cron daily-standup"),
    ("pt", "schedule", "atualiza o cron kpi-digest para '0 8 * * *'"),
    ("pt", "rename", "renomeia cron_a1b2c3 para kpi-fast"),
]

CRON_UPDATE_NULL = [
    "update that cron",         # which? what change?
    "change the schedule",       # of which cron? to what?
    "fix the cron",               # underspecified
    "tweak the cron",             # underspecified
    "update the cron job",         # which? what?
]


# ── plugin-commands (slash commands) ─────────────────────────────────────

# These actions only fire on specific slash prefixes; messages must be exact.

COMMANDS_LIST_EN = [
    "/commands",
    "/cmds",
    "/commands ",
    "/commands list everything",
    "/commands — show all",
    "/cmds please",
    "/cmds full list",
    "/commands now",
    "/commands all",
    "/cmds",
    "/commands available",
    "/commands ?",
    "/cmds plz",
    "/commands give me everything",
    "/commands full",
    "/cmds verbose",
    "/commands full list",
    "/cmds list all",
    "/commands pls",
    "/cmds — show me",
    "/commands full dump",
    "/cmds everything",
]

COMMANDS_LIST_ML = [
    ("zh", "/commands"),
    ("zh", "/cmds"),
    ("zh", "/commands 全部"),
    ("es", "/commands"),
    ("es", "/cmds por favor"),
    ("es", "/commands lista todos"),
    ("fr", "/commands"),
    ("fr", "/cmds"),
    ("fr", "/commands tout afficher"),
    ("ja", "/commands"),
    ("ja", "/cmds 全部"),
    ("ja", "/commands 一覧"),
    ("de", "/commands"),
    ("de", "/cmds bitte"),
    ("de", "/commands alle"),
    ("pt", "/commands"),
    ("pt", "/cmds"),
    ("pt", "/commands lista tudo"),
]

COMMANDS_LIST_NULL = [
    "show me the commands",     # not a slash command — won't activate
    "what commands are there",   # ambiguous
    "list available commands",   # missing slash prefix
]


HELP_COMMAND_EN = [
    "/help",
    "/h",
    "/?",
    "/help me",
    "/help please",
    "/help — what can you do",
    "/h ",
    "/help everything",
    "/? quick",
    "/h plz",
    "/help full guide",
    "/help slash commands",
    "/help me out",
    "/h?",
    "/help — show options",
    "/help in detail",
    "/help anyone",
    "/help asap",
    "/h all",
    "/? help",
    "/help full",
    "/h verbose",
]

HELP_COMMAND_ML = [
    ("zh", "/help"),
    ("zh", "/h"),
    ("zh", "/? 帮助"),
    ("es", "/help"),
    ("es", "/h por favor"),
    ("es", "/? ayuda"),
    ("fr", "/help"),
    ("fr", "/h"),
    ("fr", "/? aide"),
    ("ja", "/help"),
    ("ja", "/h"),
    ("ja", "/? ヘルプ"),
    ("de", "/help"),
    ("de", "/h bitte"),
    ("de", "/? hilfe"),
    ("pt", "/help"),
    ("pt", "/h"),
    ("pt", "/? ajuda"),
]

HELP_COMMAND_NULL = [
    "help",                  # missing slash prefix
    "i need help",            # not a command
    "what can you do",         # not a command
]


MODELS_COMMAND_EN = [
    "/models",
    "/models list",
    "/models all",
    "/models — full list",
    "/models please",
    "/models providers",
    "/models full",
    "/models everything",
    "/models verbose",
    "/models?",
    "/models plz",
    "/models all available",
    "/models with providers",
    "/models — show me",
    "/models now",
    "/models pls",
    "/models complete list",
    "/models — providers and ids",
    "/models everything plz",
    "/models full dump",
    "/models give me all",
    "/models in detail",
]

MODELS_COMMAND_ML = [
    ("zh", "/models"),
    ("zh", "/models 全部"),
    ("zh", "/models 列表"),
    ("es", "/models"),
    ("es", "/models lista completa"),
    ("es", "/models por favor"),
    ("fr", "/models"),
    ("fr", "/models tout"),
    ("fr", "/models liste"),
    ("ja", "/models"),
    ("ja", "/models 一覧"),
    ("ja", "/models 全部"),
    ("de", "/models"),
    ("de", "/models alle"),
    ("de", "/models bitte"),
    ("pt", "/models"),
    ("pt", "/models tudo"),
    ("pt", "/models lista completa"),
]

MODELS_COMMAND_NULL = [
    "what models are there",   # not a slash command
    "list models",              # missing slash
    "show me the AI models",     # not a command
]


STATUS_COMMAND_EN = [
    "/status",
    "/s",
    "/status please",
    "/s now",
    "/status full",
    "/status — show current settings",
    "/s — quick check",
    "/status what's set",
    "/status plz",
    "/s",
    "/status everything",
    "/status detailed",
    "/s pls",
    "/status?",
    "/s — directives",
    "/status give me everything",
    "/s full",
    "/status verbose",
    "/s with details",
    "/status what's going on",
    "/status overview",
    "/s — current state",
]

STATUS_COMMAND_ML = [
    ("zh", "/status"),
    ("zh", "/s"),
    ("zh", "/status 详情"),
    ("es", "/status"),
    ("es", "/s por favor"),
    ("es", "/status detalles"),
    ("fr", "/status"),
    ("fr", "/s"),
    ("fr", "/status détails"),
    ("ja", "/status"),
    ("ja", "/s"),
    ("ja", "/status 詳細"),
    ("de", "/status"),
    ("de", "/s bitte"),
    ("de", "/status alles"),
    ("pt", "/status"),
    ("pt", "/s"),
    ("pt", "/status detalhado"),
]

STATUS_COMMAND_NULL = [
    "what's the status",          # missing slash
    "status please",               # missing slash
    "give me a status update",      # not a slash command
]


STOP_COMMAND_EN = [
    "/stop",
    "/abort",
    "/cancel",
    "/stop everything",
    "/abort now",
    "/cancel please",
    "/stop the run",
    "/abort that",
    "/cancel the task",
    "/stop now please",
    "/abort plz",
    "/cancel asap",
    "/stop — kill it",
    "/abort the operation",
    "/cancel running task",
    "/stop running",
    "/abort current",
    "/cancel ongoing",
    "/stop the agent",
    "/abort right now",
    "/cancel — stop",
    "/stop pls",
]

STOP_COMMAND_ML = [
    ("zh", "/stop"),
    ("zh", "/abort"),
    ("zh", "/cancel 现在"),
    ("es", "/stop"),
    ("es", "/abort por favor"),
    ("es", "/cancel ahora"),
    ("fr", "/stop"),
    ("fr", "/abort"),
    ("fr", "/cancel maintenant"),
    ("ja", "/stop"),
    ("ja", "/abort"),
    ("ja", "/cancel 今すぐ"),
    ("de", "/stop"),
    ("de", "/abort sofort"),
    ("de", "/cancel jetzt"),
    ("pt", "/stop"),
    ("pt", "/abort agora"),
    ("pt", "/cancel já"),
]

STOP_COMMAND_NULL = [
    "stop",                  # missing slash prefix
    "please stop",            # missing slash prefix
    "abort",                  # missing slash prefix
]


# ────────────────────────── argument extractors ──────────────────────────
#
# These action specs are parameter-free, so every tool call carries an empty
# arguments object.

# ───────────────────────── subtle-null REPLY shapes ──────────────────────

_SUBTLE_NULL_REPLIES: dict[str, list[tuple[str, str]]] = {
    # action_name → list of (thought, text) clarifying-question pairs.
    "CREATE_CRON": [
        ("cron create requested with no schedule and no task",
         "Sure — what should it run, and on what schedule? (e.g. every 5 min, '0 9 * * *', or a one-time date)"),
        ("'wire up a cron for that thing' lacks both fields",
         "Happy to set up a cron — what task, and how often?"),
    ],
    "DELETE_CRON": [
        ("delete requested without ID or name",
         "Which cron should I delete? An ID like cron_a1b2c3 or a name works."),
        ("'kill it' has no antecedent",
         "Which cron? Tell me the name or ID and I'll remove it."),
    ],
    "RUN_CRON": [
        ("manual run requested with no cron identifier",
         "Which cron should I run now? A name or ID works."),
        ("'fire the cron' has no specific cron",
         "Which one? Tell me the cron name or ID."),
    ],
    "UPDATE_CRON": [
        ("update requested without target cron and without new value",
         "Which cron, and what should change? (schedule, name, enabled, task)"),
        ("'tweak the cron' is too vague",
         "Happy to update — which cron and which field?"),
    ],
    "COMMANDS_LIST": [
        ("user asked about commands without using /commands or /cmds — action only fires on those slashes",
         "If you want the full command list, send /commands or /cmds and I'll print it."),
    ],
    "HELP_COMMAND": [
        ("user asked for help but didn't use /help, /h, or /? — action only fires on those slashes",
         "Send /help (or /h, /?) and I'll show the command list."),
    ],
    "MODELS_COMMAND": [
        ("user asked about models without /models slash prefix",
         "Send /models and I'll list the available providers and model IDs."),
    ],
    "STATUS_COMMAND": [
        ("user asked for status without /status or /s slash prefix",
         "Send /status (or /s) and I'll show the current session directives."),
    ],
    "STOP_COMMAND": [
        ("user said 'stop' without the /stop, /abort, or /cancel slash prefix",
         "If you want me to abort the current run, send /stop, /abort, or /cancel."),
    ],
}


# ───────────────────────────── per-action driver ─────────────────────────


def _emit_for_action(
    *,
    encoder: ExpectedResponseEncoder,
    rng: random.Random,
    action_name: str,
    plugin: str,
    en_bank: list[tuple[str, str]],
    ml_bank: list[tuple[str, str, str]],
    null_bank: list[str],
    n_total: int,
) -> Iterable[dict[str, Any]]:
    """Generate ~n_total records for one action.

    English ≈ 70%, multilingual ≈ 30% (capped by ml_bank size). Within the
    English slice, we apply rotating styles. ~7% of overall records are
    subtle-null REPLY shapes (only if null_bank is non-empty).
    """
    n_subtle = max(0, round(n_total * 0.07)) if null_bank else 0
    # Multilingual ≈ 30%. Cycle through ml_bank with light suffix-rotation
    # to stay distinct when we need more records than unique phrasings.
    target_ml = max(0, round(n_total * 0.30))
    n_ml = target_ml if ml_bank else 0
    n_en = n_total - n_subtle - n_ml

    available_actions = [ACTION_TASK_CALL, ACTION_REPLY, action_name]

    # 1) English styled records
    for i in range(n_en):
        sub_op, base = en_bank[i % len(en_bank)]
        # Cycle styles, but bias toward direct (1 in 4 records).
        if i % 4 == 0:
            style_name, msg = "direct", base
        else:
            style_name, msg = _styled(base, i, rng)
        args: dict[str, Any] = {}
        expected = {"tool_calls": [{"name": action_name, "arguments": args}]}
        yield _record(
            encoder=encoder, rng=rng,
            user_msg=msg,
            expected=expected,
            action_name=action_name, plugin=plugin, sub_op=sub_op,
            style=style_name, language="en",
            is_subtle_null=False,
            available_actions=available_actions,
        )

    # 2) Multilingual records (style="direct" — keep target-language wording clean).
    # Group ml_bank by language and round-robin through languages so that
    # n_ml records are roughly balanced across the 6 locales regardless of
    # input bank ordering.
    by_lang: dict[str, list[tuple[str, str]]] = {}
    for lang_, sub_op_, m_ in ml_bank:
        by_lang.setdefault(lang_, []).append((sub_op_, m_))
    lang_order = sorted(by_lang.keys())  # deterministic
    # Apply a small per-language suffix on repeat passes so we don't emit
    # literal duplicates when n_ml > len(ml_bank).
    ml_suffixes_by_lang = {
        "zh": ["", "，谢谢", "。", " 现在", "，请", " 立刻"],
        "es": ["", ", por favor", ".", " ahora", " gracias", " — rápido"],
        "fr": ["", ", merci", ".", " maintenant", " s'il te plaît", " — vite"],
        "ja": ["", "、お願い", "。", " 今すぐ", " ありがとう", " — 急ぎで"],
        "de": ["", ", bitte", ".", " jetzt", " danke", " — schnell"],
        "pt": ["", ", por favor", ".", " agora", " obrigado", " — rápido"],
    }
    for i in range(n_ml):
        # round-robin pick a language, then index within that language
        lang = lang_order[i % len(lang_order)] if lang_order else ml_bank[0][0]
        per_lang = by_lang[lang]
        within = (i // len(lang_order)) % len(per_lang)
        loop = (i // len(lang_order)) // len(per_lang)
        sub_op, base_msg = per_lang[within]
        suffixes = ml_suffixes_by_lang.get(lang, [""])
        msg = base_msg + suffixes[loop % len(suffixes)]
        args: dict[str, Any] = {}
        expected = {"tool_calls": [{"name": action_name, "arguments": args}]}
        yield _record(
            encoder=encoder, rng=rng,
            user_msg=msg,
            expected=expected,
            action_name=action_name, plugin=plugin, sub_op=sub_op,
            style="direct", language=lang,
            is_subtle_null=False,
            available_actions=available_actions,
        )

    # 3) Subtle-null REPLY records
    null_replies = _SUBTLE_NULL_REPLIES.get(action_name, [])
    for i in range(n_subtle):
        if not null_replies:
            break
        msg = null_bank[i % len(null_bank)]
        thought, text = null_replies[i % len(null_replies)]
        expected = {"thought": thought, "text": text}
        yield _record(
            encoder=encoder, rng=rng,
            user_msg=msg,
            expected=expected,
            action_name=action_name, plugin=plugin, sub_op="subtle_null",
            style="subtle-null", language="en",
            is_subtle_null=True,
            available_actions=[ACTION_REPLY, ACTION_TASK_CALL, action_name],
        )


# ──────────────────────────── orchestration ──────────────────────────────


# (action_name, plugin, en_bank, ml_bank, null_bank)
ACTION_BANKS: list[tuple[str, str, list[tuple[str, str]], list[tuple[str, str, str]], list[str]]] = [
    # plugin-cron
    ("CREATE_CRON", "plugin-cron",
     CRON_CREATE_EN, CRON_CREATE_ML, CRON_CREATE_NULL),
    ("DELETE_CRON", "plugin-cron",
     CRON_DELETE_EN, CRON_DELETE_ML, CRON_DELETE_NULL),
    ("LIST_CRONS", "plugin-cron",
     CRON_LIST_EN, CRON_LIST_ML, CRON_LIST_NULL),
    ("RUN_CRON", "plugin-cron",
     CRON_RUN_EN, CRON_RUN_ML, CRON_RUN_NULL),
    ("UPDATE_CRON", "plugin-cron",
     CRON_UPDATE_EN, CRON_UPDATE_ML, CRON_UPDATE_NULL),

    # plugin-commands
    ("COMMANDS_LIST", "plugin-commands",
     [("default", m) for m in COMMANDS_LIST_EN],
     [(lang, "default", m) for lang, m in COMMANDS_LIST_ML],
     COMMANDS_LIST_NULL),
    ("HELP_COMMAND", "plugin-commands",
     [("default", m) for m in HELP_COMMAND_EN],
     [(lang, "default", m) for lang, m in HELP_COMMAND_ML],
     HELP_COMMAND_NULL),
    ("MODELS_COMMAND", "plugin-commands",
     [("default", m) for m in MODELS_COMMAND_EN],
     [(lang, "default", m) for lang, m in MODELS_COMMAND_ML],
     MODELS_COMMAND_NULL),
    ("STATUS_COMMAND", "plugin-commands",
     [("default", m) for m in STATUS_COMMAND_EN],
     [(lang, "default", m) for lang, m in STATUS_COMMAND_ML],
     STATUS_COMMAND_NULL),
    ("STOP_COMMAND", "plugin-commands",
     [("default", m) for m in STOP_COMMAND_EN],
     [(lang, "default", m) for lang, m in STOP_COMMAND_ML],
     STOP_COMMAND_NULL),
]


def write_jsonl(records: Iterable[dict], path: Path) -> int:
    n = 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")
            n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-action", type=int, default=100,
                    help="target records per action (default: 100)")
    ap.add_argument("--seed", type=int, default=0xC077E3CE)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    encoder = JsonExpectedResponseEncoder()
    try:
        all_records: list[dict[str, Any]] = []
        per_action_counts: dict[str, int] = {}
        for action_name, plugin, en_bank, ml_bank, null_bank in ACTION_BANKS:
            count = 0
            for rec in _emit_for_action(
                encoder=encoder, rng=rng,
                action_name=action_name, plugin=plugin,
                en_bank=en_bank, ml_bank=ml_bank, null_bank=null_bank,
                n_total=args.per_action,
            ):
                all_records.append(rec)
                count += 1
            per_action_counts[action_name] = count
            log.info("  %-30s → %d records", action_name, count)

        n = write_jsonl(all_records, OUT_PATH)
        log.info("Wrote %d total records → %s", n, OUT_PATH)

        # quick distribution stats
        langs: dict[str, int] = {}
        styles: dict[str, int] = {}
        n_subtle = 0
        for r in all_records:
            md = r["metadata"]
            langs[md["language"]] = langs.get(md["language"], 0) + 1
            styles[md["style"]] = styles.get(md["style"], 0) + 1
            if md.get("is_subtle_null"):
                n_subtle += 1
        log.info("Languages: %s", dict(sorted(langs.items())))
        log.info("Styles:    %s", dict(sorted(styles.items())))
        log.info("Subtle-null records: %d (%.1f%%)",
                 n_subtle, 100.0 * n_subtle / max(n, 1))
        log.info("Per-action: %s", per_action_counts)
    finally:
        encoder.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
