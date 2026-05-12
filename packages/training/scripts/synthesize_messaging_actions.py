"""Synthesize ~3,400 supervised JSON tool_call records for elizaOS
messaging-plugin actions (Discord, Twitter/X, Signal, BlueBubbles,
iMessage, WhatsApp).

Output: data/synthesized/action_examples/messaging.jsonl

Each record is a flat ElizaRecord with `expectedResponse` set to the
canonical JSON `{tool_calls:[{name,arguments}]}` envelope (or JSON
`{thought,text}` / `actions:["IGNORE"]` shape for subtle-null records).

Diversity targets (per action, 100 records):
  - languages: ~70 en, ~30 split across zh/es/fr/ja/de/pt
  - styles: 10 styles cycled — direct, formal, casual, expert, naive,
    voice-asr, distracted, broken-english, self-correcting, subtle-null
  - personas: 30+ identities
  - memoryEntries: ~30% empty / 50% 1-2 turns / 20% 3 turns
  - argument fill: required + 50% optional, with edge cases (special
    chars, multiline, lists, IDs as strings)

Run:
    .venv/bin/python scripts/synthesize_messaging_actions.py
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.eliza_record import build, stable_id  # noqa: E402
from lib.expected_response import ExpectedResponseEncoder, JsonExpectedResponseEncoder  # noqa: E402

ACTIONS_PATH = ROOT / "data" / "prompts" / "actions-catalog.json"
OUT_PATH = ROOT / "data" / "synthesized" / "action_examples" / "messaging.jsonl"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("synth-msg")


# ────────────────────────── Personas / pools ──────────────────────────

PERSONAS: list[str] = [
    "Alice", "Bob", "Pradeep", "Sofia", "Yuki", "Kenji", "Mateo", "Priya",
    "Hina", "Olivia", "Diego", "Fatima", "Carlos", "Aiko", "Lukas",
    "Marisol", "Ren", "Amina", "Nadia", "Wei", "Diana", "Ethan", "Tomas",
    "Mia", "Noah", "Quinn", "Raj", "George", "Ivan", "Jin", "Kira", "Leo",
    "Olamide", "Anastasia", "Hiroshi", "Stefan", "Magnus", "Camila",
    "Theo", "Niko",
]

AGENT_NAMES: list[str] = [
    "milady", "eliza", "iris", "atlas", "nova", "kai", "echo", "sage",
    "lyra", "vega",
]

LANGS_DIST: list[tuple[str, int]] = [
    ("en", 70),
    ("zh", 5),
    ("es", 5),
    ("fr", 5),
    ("ja", 5),
    ("de", 5),
    ("pt", 5),
]

STYLES: list[str] = [
    "direct",
    "formal",
    "casual",
    "expert",
    "naive",
    "voice-asr",
    "distracted",
    "broken-english",
    "self-correcting",
    "subtle-null",
]


# ────────────────────────── Param schemas ──────────────────────────
# The actions-catalog.json mostly carries `parameters: null` for
# messaging actions because the runtime extracts params via LLM. We
# pulled the actual param shapes from the action handlers under
# eliza/plugins/plugin-{discord,twitter,signal,bluebubbles,imessage,whatsapp}.

ParamSpec = dict[str, Any]


def _ps(name: str, type_: str, *, required: bool = False,
        description: str = "") -> ParamSpec:
    return {"name": name, "type": type_, "required": required,
            "description": description}


# Discord 17 connector intents mapped to canonical actions
DISCORD_PARAMS: dict[str, list[ParamSpec]] = {
    "CHAT_WITH_ATTACHMENTS": [
        _ps("objective", "string", required=True,
            description="The user objective for the attachment chat."),
        _ps("attachmentIds", "array<string>", required=True,
            description="List of Discord attachment IDs to inspect."),
    ],
    "CREATE_POLL": [
        _ps("question", "string", required=True,
            description="The poll question."),
        _ps("options", "array<string>", required=True,
            description="2-10 poll options."),
        _ps("useEmojis", "boolean",
            description="Whether to prefix options with emojis."),
    ],
    "DELETE_MESSAGE": [
        _ps("messageId", "string", required=True,
            description="The Discord message ID to delete."),
        _ps("channelRef", "string",
            description="Channel ref or 'current'."),
    ],
    "DOWNLOAD_MEDIA": [
        _ps("mediaUrl", "string", required=True,
            description="URL of the media to download."),
    ],
    "EDIT_MESSAGE": [
        _ps("messageId", "string", required=True,
            description="The Discord message ID to edit."),
        _ps("newText", "string", required=True,
            description="The new content for the message."),
        _ps("channelRef", "string",
            description="Channel ref or 'current'."),
    ],
    "discord_get_user": [
        _ps("userIdentifier", "string", required=True,
            description="User mention, ID, or username."),
        _ps("detailed", "boolean",
            description="If true, include detailed profile fields."),
    ],
    "JOIN_CHANNEL": [
        _ps("channelName", "string", required=True,
            description="Voice channel name to join."),
    ],
    "LEAVE_CHANNEL": [
        _ps("channelName", "string",
            description="Voice channel name to leave (default: current)."),
    ],
    "discord_list_channels": [
        _ps("guildId", "string",
            description="Optional Discord guild ID; defaults to current guild."),
    ],
    "discord_pin_message": [
        _ps("messageRef", "string", required=True,
            description="Message ID or 'last' to pin."),
        _ps("channelRef", "string",
            description="Channel ref or 'current'."),
        _ps("pin", "boolean", required=True,
            description="True to pin; false to remove an existing pin."),
    ],
    "discord_private_message": [
        _ps("recipientIdentifier", "string", required=True,
            description="Recipient user mention, ID, or username."),
        _ps("messageContent", "string", required=True,
            description="DM body to send."),
    ],
    "discord_channel_message": [
        _ps("text", "string", required=True,
            description="Message text to send."),
        _ps("channelRef", "string",
            description="Channel ref or 'current'."),
    ],
    "SERVER_INFO": [
        _ps("guildId", "string",
            description="Discord guild ID; defaults to current guild."),
    ],
    "SETUP_CREDENTIALS": [
        _ps("service", "string", required=True,
            description="Service preset name (e.g. github, openai, custom)."),
    ],
    "SUMMARIZE_CONVERSATION": [
        _ps("objective", "string", required=True,
            description="What to focus the summary on."),
        _ps("start", "string", required=True,
            description="Start time (ISO or relative, e.g. '2 hours ago')."),
        _ps("end", "string", required=True,
            description="End time (ISO or relative, e.g. 'now')."),
        _ps("channelRef", "string",
            description="Channel ref or 'current'."),
    ],
    "TRANSCRIBE_MEDIA": [
        _ps("attachmentId", "string", required=True,
            description="Discord attachment ID to transcribe."),
    ],
    "discord_unpin_message": [
        _ps("messageRef", "string", required=True,
            description="Message ID or 'last' to unpin."),
        _ps("channelRef", "string",
            description="Channel ref or 'current'."),
        _ps("pin", "boolean", required=True,
            description="True to pin; false to remove an existing pin."),
    ],
}

# Twitter/X 7 connector intents mapped to canonical actions
TWITTER_PARAMS: dict[str, list[ParamSpec]] = {
    "x_feed_top": [
        _ps("topN", "number",
            description="Number of top tweets to return (1-50)."),
    ],
    "x_post_basic": [
        _ps("text", "string", required=True,
            description="The tweet body (<=280 chars)."),
    ],
    "x_read_messages": [
        _ps("limit", "number",
            description="Max number of unread DMs to fetch."),
    ],
    "x_direct_message": [
        _ps("recipient", "string", required=True,
            description="Recipient user id or username (no leading @)."),
        _ps("text", "string", required=True,
            description="The DM body."),
        _ps("confirmed", "boolean",
            description="Must be true for the DM to actually send."),
    ],
    "x_search_posts": [
        _ps("query", "string", required=True,
            description="Search query against X recent tweets."),
        _ps("maxResults", "number",
            description="Maximum tweets to return (1-100)."),
    ],
    "x_post_confirmed": [
        _ps("text", "string", required=True,
            description="The tweet body."),
        _ps("confirmed", "boolean",
            description="Must be true for the tweet to actually post."),
    ],
    "x_feed_summary": [
        _ps("topN", "number",
            description="Number of top tweets to summarize."),
    ],
}

# Signal 5 connector intents mapped to canonical actions
SIGNAL_PARAMS: dict[str, list[ParamSpec]] = {
    "signal_contacts": [],
    "signal_groups": [],
    "signal_read_messages": [
        _ps("limit", "number",
            description="Max number of recent messages to read."),
    ],
    "signal_message": [
        _ps("text", "string", required=True,
            description="The Signal message text to send."),
        _ps("recipient", "string",
            description="E.164 phone (+1234567890), group ID, or 'current'."),
    ],
    "signal_reaction": [
        _ps("emoji", "string", required=True,
            description="Single emoji to react with."),
        _ps("targetTimestamp", "number", required=True,
            description="Timestamp of the message to react to."),
        _ps("targetAuthor", "string", required=True,
            description="E.164 phone of the message author."),
        _ps("remove", "boolean",
            description="If true, remove the reaction instead of adding."),
    ],
}

# BlueBubbles 2 connector intents mapped to canonical actions
BLUEBUBBLES_PARAMS: dict[str, list[ParamSpec]] = {
    "bluebubbles_reaction": [
        _ps("emoji", "string", required=True,
            description="Reaction (heart, thumbsup, thumbsdown, haha, "
            "exclamation, question, or any emoji)."),
        _ps("messageId", "string", required=True,
            description="Message ID to react to (or 'last')."),
        _ps("remove", "boolean",
            description="True to remove the reaction; false to add it."),
    ],
    "bluebubbles_message": [
        _ps("text", "string", required=True,
            description="The iMessage body to send."),
        _ps("chatGuid", "string",
            description="BlueBubbles chat GUID (default: current chat)."),
    ],
}

# iMessage 1 connector intent mapped to canonical actions
IMESSAGE_PARAMS: dict[str, list[ParamSpec]] = {
    "imessage_message": [
        _ps("text", "string", required=True,
            description="The iMessage body to send."),
        _ps("to", "string",
            description="Phone, email, or 'current' to reply."),
    ],
}

# WhatsApp 2 connector intents mapped to canonical actions
WHATSAPP_PARAMS: dict[str, list[ParamSpec]] = {
    "whatsapp_message": [
        _ps("to", "string", required=True,
            description="Phone in E.164 format (e.g. +14155552671)."),
        _ps("text", "string", required=True,
            description="The WhatsApp message body."),
    ],
    "whatsapp_reaction": [
        _ps("messageId", "string", required=True,
            description="WhatsApp message ID to react to."),
        _ps("emoji", "string", required=True,
            description="Emoji to react with."),
    ],
}

ALL_PARAMS: dict[str, list[ParamSpec]] = {
    **DISCORD_PARAMS,
    **TWITTER_PARAMS,
    **SIGNAL_PARAMS,
    **BLUEBUBBLES_PARAMS,
    **IMESSAGE_PARAMS,
    **WHATSAPP_PARAMS,
}


# ────────────────────────── Sample value pools ──────────────────────────

DISCORD_CHANNELS = [
    "#general", "#engineering", "#trading", "#design", "#announcements",
    "#help-desk", "#dev-ops", "#product", "#random", "#voice-lounge",
    "off-topic", "incidents", "support", "fr-team", "ja-bots",
]
DISCORD_VOICE_CHANNELS = [
    "Voice Lounge", "Engineering Standup", "Music Room", "Pomodoro",
    "Game Night", "Office Hours", "Karaoke",
]
DISCORD_GUILDS = [
    "740912344987001",
    "812003001144556",
    "999991122334455",
    "555444333222111",
]
DISCORD_USER_REFS = [
    "@alice#4421", "@bob_dev", "<@312312312>", "alice_in_chains",
    "carlos_eng", "fatima.designer", "@quinn", "@diana#0102",
]
DISCORD_MESSAGE_IDS = [
    "1234567890123456789", "9876543210987654321", "1357924680135792468",
    "2468013579246801357", "1112223334445556667", "8889990001112223334",
]
DISCORD_ATTACHMENT_IDS = [
    "att-9f2c7e10b1a44d3a", "att-001-image", "att-pdf-22ab",
    "att-mov-78f9", "att-aud-aa11",
]
MEDIA_URLS = [
    "https://cdn.discordapp.com/attachments/123/456/clip.mp4",
    "https://cdn.discordapp.com/attachments/789/012/voice.ogg",
    "https://example.com/files/recording.m4a",
    "https://files.example.org/uploads/2026-05-02/preview.png",
]
EMOJIS = ["heart", "thumbsup", "thumbsdown", "haha", "exclamation",
          "question", "🔥", "👀", "✨", "🎉", "😂", "🙏", "💯", "👍"]
PHONES = [
    "+14155552671", "+12025550143", "+447911123456", "+33612345678",
    "+819012345678", "+5511987654321", "+8613912345678",
]
SIGNAL_GROUPS = [
    "group.aXyz123abc", "group.qPlmNoP456", "group.ZooKeeperTeam",
]
TWITTER_HANDLES = [
    "alice_in_chains", "bob_dev", "elonmusk", "satyanadella",
    "elizaos_official", "milady_ai",
]
TWITTER_QUERIES = [
    "elizaOS news",
    "@milady_ai launches",
    "GPU shortage 2026",
    "ai agents tooling",
    "tokio rust async",
    "best vibecoding tips",
    "from:elizaos_official",
    "#opensource",
]
SAMPLE_TWEETS = [
    "Just shipped a new build of milady — local-first AI agents that respect your data.",
    "Hot take: TOON > JSON when the model is the consumer.",
    "Friendly reminder that @elizaos_official is always hiring.",
    "Coffee, then deploy. In that order.",
    "Eliza skill of the week: yara-authoring. Detect malware patterns from chat.",
]
DM_BODIES = [
    "Quick check — are you free for a 15min sync at 4pm PT?",
    "Thanks for sharing the doc. I'll review tonight, ETA tomorrow noon.",
    "Saw the launch. Congrats! Want to chat distribution?",
    "Sending the receipt screenshot in a sec — ignore the watermark.",
    "Confirmed for Friday at 6pm at Café Luna.",
]
POLL_QUESTIONS = [
    "Lunch?",
    "Best framework for the new dashboard?",
    "Should we ship today or wait for QA?",
    "Pick the offsite location",
    "Vote on the new logo direction",
]
POLL_OPTIONS = [
    ["Pizza", "Sushi", "Tacos"],
    ["Vue", "React", "Svelte", "SolidJS"],
    ["Ship today", "Wait for QA", "Cancel"],
    ["Lisbon", "Mexico City", "Bali"],
    ["v1 logo", "v2 logo", "v3 logo"],
]
TIMERANGES = [
    ("2 hours ago", "now"),
    ("yesterday 9am", "yesterday 5pm"),
    ("today 8am", "today noon"),
    ("2026-04-30T00:00:00Z", "2026-05-01T00:00:00Z"),
    ("last Monday", "last Friday"),
]
SUMMARY_OBJECTIVES = [
    "decisions made on the migration plan",
    "open action items and owners",
    "blockers raised by the design team",
    "user feedback on the v3 release",
    "performance regressions discussed today",
]


# ────────────────────────── Style decorators ──────────────────────────

ASR_DISFLUENCIES = [
    "uh", "um", "like", "you know", "I mean", "so yeah",
]


def add_disfluencies(text: str, rng: random.Random) -> str:
    parts = text.split(" ")
    out: list[str] = []
    for w in parts:
        out.append(w)
        if rng.random() < 0.12 and len(out) > 1:
            out.append(rng.choice(ASR_DISFLUENCIES))
    msg = " ".join(out).lower()
    msg = re.sub(r"[.!?]", "", msg)
    return msg


def add_distraction(text: str, rng: random.Random) -> str:
    asides = [
        " — wait sorry the dog is barking — ",
        " (one sec, kettle's done)",
        " ... where was I",
        " — hold on, doorbell",
        " (sorry, multitasking)",
    ]
    parts = text.split(" ")
    if len(parts) < 4:
        return text + rng.choice(asides)
    cut = rng.randint(2, len(parts) - 1)
    return " ".join(parts[:cut]) + rng.choice(asides) + " " + " ".join(parts[cut:])


def add_self_correction(text: str, rng: random.Random) -> str:
    swaps = [
        ("send", "ping... no wait, send"),
        ("post", "draft... actually post"),
        ("delete", "edit, no — delete"),
        ("pin", "bookmark — I mean pin"),
        ("react", "reply, sorry, react"),
    ]
    for kw, repl in swaps:
        if kw in text.lower():
            return text.replace(kw, repl, 1)
    return text + " — actually scratch that, do it"


def to_broken_english(text: str, rng: random.Random) -> str:
    text = re.sub(r"\bcan you\b", "you can", text, flags=re.I)
    text = re.sub(r"\bplease\b", "please please", text, flags=re.I)
    text = re.sub(r"\bthe\b", "", text, flags=re.I)
    text = re.sub(r"\b(I'd|I'll|I'm)\b", "I", text, flags=re.I)
    return text.strip()


def to_formal(text: str) -> str:
    return f"Could you kindly {text[0].lower() + text[1:]}, please."


def to_casual(text: str) -> str:
    return f"yo, {text.lower()}"


def to_expert(text: str) -> str:
    return text.lower()


def to_naive(text: str) -> str:
    return f"hi {text.lower()}? sorry I'm new here"


# ────────────────────────── Translations ──────────────────────────
# Keep these short so we don't drift from the action intent. A handful of
# preset translations per action covers the non-en bucket.

TRANSLATIONS: dict[str, dict[str, list[str]]] = {
    "discord_channel_message": {
        "zh": ["请在#general 频道发：{text}", "帮我在 {channel} 发一条消息：{text}"],
        "es": ["por favor envía «{text}» al canal {channel}",
               "manda este mensaje al {channel}: {text}"],
        "fr": ["peux-tu envoyer « {text} » dans {channel} ?",
               "envoie ce message dans {channel} : {text}"],
        "ja": ["{channel} に「{text}」と送って",
               "メッセージを{channel}に送信して：{text}"],
        "de": ["bitte sende „{text}\" in {channel}",
               "schick diese Nachricht in {channel}: {text}"],
        "pt": ["por favor envie \"{text}\" no {channel}",
               "manda essa mensagem em {channel}: {text}"],
    },
    "x_post_basic": {
        "zh": ["发个推文：{text}", "请帮我发一条推：{text}"],
        "es": ["postea este tweet: {text}", "publica un tweet: {text}"],
        "fr": ["publie ce tweet : {text}", "tweete ceci : {text}"],
        "ja": ["このツイートを投稿して: {text}", "ツイートしてください：{text}"],
        "de": ["bitte poste diesen Tweet: {text}",
               "tweete das hier: {text}"],
        "pt": ["por favor poste este tweet: {text}",
               "tweeta isso aí: {text}"],
    },
    "discord_private_message": {
        "zh": ["给 {recipient} 发私信：{text}",
               "请私信 {recipient}：{text}"],
        "es": ["mándale un DM a {recipient}: {text}",
               "envía un mensaje privado a {recipient}: {text}"],
        "fr": ["envoie un MP à {recipient} : {text}",
               "MP à {recipient} : {text}"],
        "ja": ["{recipient} に DM して：{text}",
               "{recipient} さんにダイレクトメッセージ：{text}"],
        "de": ["schreib {recipient} eine DM: {text}",
               "PN an {recipient}: {text}"],
        "pt": ["manda DM pro {recipient}: {text}",
               "envie um privado para {recipient}: {text}"],
    },
    "whatsapp_message": {
        "zh": ["请用 WhatsApp 给 {to} 发：{text}",
               "WhatsApp 发给 {to}：{text}"],
        "es": ["envía un WhatsApp a {to}: {text}",
               "mándale un WhatsApp a {to}: {text}"],
        "fr": ["envoie un WhatsApp à {to} : {text}",
               "WhatsApp à {to} : {text}"],
        "ja": ["{to} に WhatsApp で送って：{text}",
               "WhatsApp で {to} に：{text}"],
        "de": ["schick {to} eine WhatsApp: {text}",
               "WhatsApp an {to}: {text}"],
        "pt": ["envia um WhatsApp pra {to}: {text}",
               "manda no WhatsApp para {to}: {text}"],
    },
    "signal_message": {
        "zh": ["用 Signal 发：{text}", "Signal 发送：{text}"],
        "es": ["envía por Signal: {text}", "manda por Signal: {text}"],
        "fr": ["envoie par Signal : {text}", "Signal : {text}"],
        "ja": ["Signal で送って：{text}", "Signal メッセージ：{text}"],
        "de": ["sende per Signal: {text}", "Signal-Nachricht: {text}"],
        "pt": ["manda no Signal: {text}", "envia pelo Signal: {text}"],
    },
    "imessage_message": {
        "zh": ["iMessage 给 {to}：{text}", "用 iMessage 发：{text}"],
        "es": ["iMessage a {to}: {text}", "envía un iMessage: {text}"],
        "fr": ["iMessage à {to} : {text}", "envoie un iMessage : {text}"],
        "ja": ["iMessage で {to} に：{text}", "iMessage を送って：{text}"],
        "de": ["iMessage an {to}: {text}", "schick eine iMessage: {text}"],
        "pt": ["manda iMessage pro {to}: {text}",
               "envia um iMessage: {text}"],
    },
    "bluebubbles_message": {
        "zh": ["通过 BlueBubbles 发 iMessage：{text}",
               "用 BlueBubbles 发：{text}"],
        "es": ["envía vía BlueBubbles: {text}",
               "manda iMessage por BlueBubbles: {text}"],
        "fr": ["envoie via BlueBubbles : {text}",
               "iMessage par BlueBubbles : {text}"],
        "ja": ["BlueBubbles で送って：{text}",
               "BlueBubbles 経由で iMessage：{text}"],
        "de": ["sende über BlueBubbles: {text}",
               "BlueBubbles iMessage: {text}"],
        "pt": ["manda pelo BlueBubbles: {text}",
               "iMessage via BlueBubbles: {text}"],
    },
    "x_search_posts": {
        "zh": ["在 X 上搜：{query}", "X 搜索：{query}"],
        "es": ["busca en X: {query}", "haz una búsqueda en X: {query}"],
        "fr": ["cherche sur X : {query}", "recherche X : {query}"],
        "ja": ["X で「{query}」を検索", "X 検索：{query}"],
        "de": ["suche auf X nach {query}", "X-Suche: {query}"],
        "pt": ["pesquise no X: {query}", "buscar no X: {query}"],
    },
    "x_feed_top": {
        "zh": ["拉取 X 时间线前几条", "看一下 X 首页热门"],
        "es": ["trae lo más top de mi feed de X",
               "muéstrame lo mejor del feed de X"],
        "fr": ["récupère le top de mon flux X",
               "montre-moi les meilleurs tweets du flux"],
        "ja": ["X タイムラインのトップを取得",
               "X フィードの上位を見せて"],
        "de": ["hol mir die Top-Tweets aus meinem X-Feed",
               "zeig mir das Beste aus dem X-Feed"],
        "pt": ["pega os top tweets do meu feed do X",
               "me mostra o melhor do feed do X"],
    },
    "x_feed_summary": {
        "zh": ["总结一下 X 时间线",
               "把 X 首页前 N 条总结一下"],
        "es": ["resume mi feed de X",
               "haz un resumen del top de mi feed"],
        "fr": ["résume mon flux X",
               "fais un récap du top du flux X"],
        "ja": ["X フィードを要約して",
               "X タイムラインの要点をまとめて"],
        "de": ["fasse meinen X-Feed zusammen",
               "kurze Zusammenfassung des X-Feeds"],
        "pt": ["resume meu feed do X",
               "me dá um resumo do top do feed"],
    },
    "x_read_messages": {
        "zh": ["看看 X 的未读私信", "X 上有什么没读的 DM"],
        "es": ["léeme los DMs no leídos de X",
               "muéstrame los DMs sin leer en X"],
        "fr": ["lis-moi les DM non lus de X",
               "affiche les MP non lus sur X"],
        "ja": ["X の未読 DM を読んで",
               "未読の X ダイレクトメッセージは？"],
        "de": ["lies meine ungelesenen X-DMs",
               "zeig die ungelesenen X-DMs"],
        "pt": ["lê meus DMs do X não lidos",
               "mostra os DMs do X que não li"],
    },
    "x_direct_message": {
        "zh": ["回复 {recipient} 的 X 私信：{text}",
               "给 {recipient} 在 X 回 DM：{text}"],
        "es": ["responde el DM de X a {recipient}: {text}",
               "contesta a {recipient} en X por DM: {text}"],
        "fr": ["réponds au DM X de {recipient} : {text}",
               "réponds à {recipient} sur X en MP : {text}"],
        "ja": ["X DM で {recipient} に返信：{text}",
               "{recipient} の X DM に返事：{text}"],
        "de": ["antworte {recipient} in X-DM: {text}",
               "DM-Antwort an {recipient} auf X: {text}"],
        "pt": ["responde o DM do X para {recipient}: {text}",
               "manda resposta no X DM pro {recipient}: {text}"],
    },
    "x_post_confirmed": {
        "zh": ["在 X 上发：{text}", "X 发推：{text}"],
        "es": ["publica en X: {text}", "haz un post en X: {text}"],
        "fr": ["publie sur X : {text}", "post sur X : {text}"],
        "ja": ["X に投稿して：{text}", "X ポスト：{text}"],
        "de": ["poste auf X: {text}", "X-Beitrag: {text}"],
        "pt": ["posta no X: {text}", "publique no X: {text}"],
    },
    # Fallback for any messaging action without a specific translation
    # set: a generic "do this action" shape gets dropped into the user
    # message in English with a small prefix marker, so the language
    # field stays accurate while the action intent is preserved.
}


def fallback_translate(lang: str, en_msg: str) -> str:
    if lang == "en":
        return en_msg
    prefixes = {
        "zh": "请帮忙：",
        "es": "por favor: ",
        "fr": "s'il te plaît : ",
        "ja": "お願い：",
        "de": "bitte: ",
        "pt": "por favor: ",
    }
    return prefixes.get(lang, "") + en_msg


# ────────────────────────── Per-action message builders ──────────────────────────


def _quote_id(s: str) -> str:
    return s


def _build_args(action: str, param_key: str, param_specs: list[ParamSpec],
                idx: int, rng: random.Random,
                style: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return (arguments_dict, scenario_facts) for a given action.

    scenario_facts holds the underlying fields used to phrase the user
    message — speaker name, channel ref, etc.
    """
    args: dict[str, Any] = {}
    facts: dict[str, Any] = {}

    def maybe_optional(p: ParamSpec) -> bool:
        # required always included; ~50% optionals included; for
        # "subtle-null" style we sometimes drop optionals entirely
        if p.get("required"):
            return True
        if style == "subtle-null":
            return rng.random() < 0.2
        return (idx + ord(p["name"][0])) % 2 == 0

    for p in param_specs:
        if not maybe_optional(p):
            continue
        v = _sample_value(action, param_key, p, idx, rng)
        if v is None:
            continue
        args[p["name"]] = v

    # Build scenario facts for phrasing
    facts["channel"] = args.get("channelRef") or rng.choice(DISCORD_CHANNELS)
    facts["text"] = args.get("text") or args.get("messageContent") or args.get("newText") or ""
    facts["recipient"] = args.get("recipient") or args.get("recipientIdentifier") or args.get("to") or ""
    facts["query"] = args.get("query") or ""
    facts["topN"] = args.get("topN") or args.get("maxResults") or args.get("limit") or 10
    facts["messageId"] = args.get("messageId") or args.get("messageRef") or ""
    facts["emoji"] = args.get("emoji") or ""

    return args, facts


def _sample_value(action: str, param_key: str, p: ParamSpec, idx: int,
                  rng: random.Random) -> Any:
    n = p["name"]
    t = p["type"]
    # General string/number fallbacks driven by name
    if n == "text":
        if action == "POST" or param_key.startswith("x_post"):
            return SAMPLE_TWEETS[idx % len(SAMPLE_TWEETS)]
        if param_key in {
            "discord_private_message", "x_direct_message", "signal_message",
            "bluebubbles_message", "imessage_message", "whatsapp_message",
        }:
            return DM_BODIES[idx % len(DM_BODIES)]
        msgs = [
            "Hey team — quick update on the migration: we're 80% through.",
            "Don't forget standup at 10am, grab coffee first.",
            "Status: green. Logs are clean. Shipping at noon.",
            "FYI the deploy is paused for an hour while we patch the regression.",
            "Reminder: PR reviews due by EOD. Please tag a reviewer.",
            "I'll be late, kid's pickup ran long. Please carry on.",
            "PSA: vault token rotates Friday — re-pull creds before then.",
            "Thanks everyone for the offsite ideas — voting closes tonight.",
        ]
        return msgs[idx % len(msgs)]
    if n == "newText":
        return [
            "Updated: the deploy lands at 13:00 UTC, not 12:00.",
            "Edit: removed the broken link, see the new doc.",
            "Fixed typo — should be 'milady', not 'milday'.",
            "Adding context: this only affects the EU region.",
        ][idx % 4]
    if n == "messageContent":
        return DM_BODIES[idx % len(DM_BODIES)]
    if n == "objective":
        return SUMMARY_OBJECTIVES[idx % len(SUMMARY_OBJECTIVES)]
    if n == "question":
        return POLL_QUESTIONS[idx % len(POLL_QUESTIONS)]
    if n == "options":
        return POLL_OPTIONS[idx % len(POLL_OPTIONS)]
    if n == "useEmojis":
        return idx % 3 != 0
    if n in ("messageId", "messageRef"):
        if n == "messageRef" and idx % 5 == 0:
            return "last"
        return DISCORD_MESSAGE_IDS[idx % len(DISCORD_MESSAGE_IDS)]
    if n == "channelRef":
        if idx % 4 == 0:
            return "current"
        return DISCORD_CHANNELS[idx % len(DISCORD_CHANNELS)]
    if n == "channelName":
        return DISCORD_VOICE_CHANNELS[idx % len(DISCORD_VOICE_CHANNELS)]
    if n == "guildId":
        return DISCORD_GUILDS[idx % len(DISCORD_GUILDS)]
    if n == "userIdentifier":
        return DISCORD_USER_REFS[idx % len(DISCORD_USER_REFS)]
    if n == "detailed":
        return idx % 2 == 0
    if n == "recipientIdentifier":
        return DISCORD_USER_REFS[idx % len(DISCORD_USER_REFS)]
    if n == "recipient":
        if param_key == "x_direct_message":
            return TWITTER_HANDLES[idx % len(TWITTER_HANDLES)]
        # Signal message: phone, group, or 'current'
        bucket = idx % 4
        if bucket == 0:
            return "current"
        if bucket == 1:
            return SIGNAL_GROUPS[idx % len(SIGNAL_GROUPS)]
        return PHONES[idx % len(PHONES)]
    if n == "to":
        if param_key == "whatsapp_message":
            return PHONES[idx % len(PHONES)]
        # iMessage
        bucket = idx % 4
        if bucket == 0:
            return "current"
        if bucket == 1:
            return ["alice@example.com", "bob@me.com",
                    "carlos@gmail.com"][idx % 3]
        return PHONES[idx % len(PHONES)]
    if n == "chatGuid":
        return ["iMessage;-;+14155552671",
                "iMessage;-;chat123",
                "SMS;-;+12025550143"][idx % 3]
    if n == "mediaUrl":
        return MEDIA_URLS[idx % len(MEDIA_URLS)]
    if n == "attachmentId":
        return DISCORD_ATTACHMENT_IDS[idx % len(DISCORD_ATTACHMENT_IDS)]
    if n == "attachmentIds":
        k = (idx % 3) + 1
        return [DISCORD_ATTACHMENT_IDS[(idx + i) % len(DISCORD_ATTACHMENT_IDS)]
                for i in range(k)]
    if n == "service":
        return ["github", "openai", "anthropic", "vercel", "cloudflare",
                "fal", "custom"][idx % 7]
    if n == "start":
        return TIMERANGES[idx % len(TIMERANGES)][0]
    if n == "end":
        return TIMERANGES[idx % len(TIMERANGES)][1]
    if n == "query":
        return TWITTER_QUERIES[idx % len(TWITTER_QUERIES)]
    if n in ("maxResults", "limit", "topN"):
        return [5, 10, 20, 25, 50][idx % 5]
    if n == "confirmed":
        # Only `True` is meaningful; we surface confirmation in 60% of records
        return idx % 5 != 0
    if n == "pin":
        return param_key != "discord_unpin_message"
    if n == "remove":
        return idx % 4 == 0
    if n == "emoji":
        return EMOJIS[idx % len(EMOJIS)]
    if n == "targetTimestamp":
        # millis since epoch around 2026-04-30
        return 1714435200000 + (idx * 7777)
    if n == "targetAuthor":
        return PHONES[idx % len(PHONES)]
    # default fallbacks
    if t.startswith("array"):
        return [f"sample-{idx}-1", f"sample-{idx}-2"]
    if t == "boolean":
        return idx % 2 == 0
    if t == "number":
        return [1, 5, 10, 25, 50][idx % 5]
    return f"sample-{n}-{idx}"


# ────────────────────────── Phrasing per action ──────────────────────────


def _en_phrasings(action: str, param_key: str, args: dict[str, Any],
                  facts: dict[str, Any]) -> list[str]:
    a = action
    text = facts.get("text") or "..."
    channel = args.get("channelRef") or facts.get("channel") or "current"
    recipient = facts.get("recipient") or "alice"
    msg_id = facts.get("messageId") or "last"
    emoji = facts.get("emoji") or "👍"
    if param_key == "discord_channel_message":
        return [
            f"send '{text}' to {channel}",
            f"please post this in {channel}: {text}",
            f"in #{channel.lstrip('#')}, drop the line: {text}",
            f"could you say in {channel}: {text}",
        ]
    if param_key == "discord_private_message":
        return [
            f"DM {recipient}: {text}",
            f"send {recipient} a private message saying {text!r}",
            f"slide into {recipient}'s DMs with: {text}",
        ]
    if (a == "MESSAGE" and param_key == "EDIT_MESSAGE") or a == "EDIT_MESSAGE":
        new = args.get("newText", text)
        return [
            f"edit message {msg_id} in {channel} to say: {new}",
            f"can you patch message {msg_id} → {new}",
            f"update {msg_id} to: {new}",
        ]
    if (a == "MESSAGE" and param_key == "DELETE_MESSAGE") or a == "DELETE_MESSAGE":
        return [
            f"delete message {msg_id} in {channel}",
            f"remove that one — id {msg_id} — from {channel}",
            f"please yank discord msg {msg_id}",
        ]
    if param_key == "discord_pin_message":
        return [
            f"pin message {msg_id} in {channel}",
            f"make {msg_id} sticky in {channel}",
            f"please pin the {msg_id} message",
        ]
    if param_key == "discord_unpin_message":
        return [
            f"unpin {msg_id} from {channel}",
            f"remove pin on message {msg_id}",
            f"can you unpin the {msg_id} note in {channel}",
        ]
    if (a == "MESSAGE" and param_key == "JOIN_CHANNEL") or a == "JOIN_CHANNEL":
        return [
            f"hop into the {args.get('channelName')} voice channel",
            f"join voice: {args.get('channelName')}",
            f"can you join {args.get('channelName')} VC",
        ]
    if (a == "MESSAGE" and param_key == "LEAVE_CHANNEL") or a == "LEAVE_CHANNEL":
        cn = args.get("channelName") or "the current voice room"
        return [
            f"leave the {cn} voice channel",
            f"please disconnect from {cn}",
            f"hop out of {cn} VC",
        ]
    if param_key == "discord_list_channels":
        gid = args.get("guildId")
        if gid:
            return [
                f"list all channels in guild {gid}",
                f"show me the channel index for {gid}",
            ]
        return [
            "list the channels in this server",
            "show me all the channels we have",
            "what channels exist here?",
        ]
    if param_key == "discord_get_user":
        ui = args.get("userIdentifier", recipient)
        det = args.get("detailed", False)
        if det:
            return [
                f"give me a detailed profile on {ui}",
                f"full discord info for {ui} please",
            ]
        return [
            f"who is {ui}?",
            f"look up {ui}",
            f"info on {ui}",
        ]
    if a == "SERVER_INFO":
        gid = args.get("guildId")
        if gid:
            return [
                f"server info for guild {gid}",
                f"give me stats for {gid}",
            ]
        return [
            "tell me about this server",
            "discord server overview please",
        ]
    if a == "CREATE_POLL":
        opts = ", ".join(args.get("options", []))
        return [
            f"create a poll: {args.get('question')} — options: {opts}",
            f"start a vote on '{args.get('question')}' with {opts}",
        ]
    if a == "DOWNLOAD_MEDIA":
        return [
            f"download the media at {args.get('mediaUrl')}",
            f"grab {args.get('mediaUrl')} for me",
        ]
    if a == "TRANSCRIBE_MEDIA":
        return [
            f"transcribe attachment {args.get('attachmentId')}",
            f"please run STT on {args.get('attachmentId')}",
        ]
    if a == "CHAT_WITH_ATTACHMENTS":
        ids = ", ".join(args.get("attachmentIds", []))
        return [
            f"discuss attachments {ids} with focus: {args.get('objective')}",
            f"using {ids}, help me with {args.get('objective')}",
        ]
    if a == "SETUP_CREDENTIALS":
        return [
            f"set up {args.get('service')} credentials",
            f"configure {args.get('service')} for me",
            f"add an api key for {args.get('service')}",
        ]
    if a == "SUMMARIZE_CONVERSATION":
        return [
            f"summarize {channel} from {args.get('start')} to {args.get('end')}, focus on {args.get('objective')}",
            f"give me the highlights from {args.get('start')} to {args.get('end')} on {args.get('objective')}",
        ]

    # Twitter
    if param_key == "x_post_basic":
        return [
            f"tweet: {text}",
            f"post on twitter: {text}",
            f"new tweet please — {text}",
        ]
    if param_key == "x_post_confirmed":
        if args.get("confirmed"):
            return [
                f"yes confirmed, post the tweet: {text}",
                f"send it — {text}",
            ]
        return [
            f"draft a tweet for me: {text}",
            f"prepare X post: {text}",
        ]
    if param_key == "x_direct_message":
        if args.get("confirmed"):
            return [
                f"confirmed — reply to {recipient}'s X DM with: {text}",
                f"send the DM reply to {recipient}: {text}",
            ]
        return [
            f"draft a DM reply to {recipient}: {text}",
            f"prepare reply to {recipient} on X: {text}",
        ]
    if param_key == "x_search_posts":
        q = args.get("query", "")
        mr = args.get("maxResults")
        if mr:
            return [
                f"search X for '{q}', up to {mr} results",
                f"find tweets about '{q}' (limit {mr})",
            ]
        return [
            f"search X for '{q}'",
            f"what's being said about '{q}' on X",
        ]
    if param_key == "x_feed_top":
        return [
            "show me the top of my X feed",
            f"top {facts.get('topN', 10)} tweets in my feed",
            "what's hot in my X timeline right now",
        ]
    if param_key == "x_feed_summary":
        return [
            "summarize my X feed",
            f"give me a recap of the top {facts.get('topN', 10)} tweets",
        ]
    if param_key == "x_read_messages":
        return [
            "read my unread X DMs",
            "what unread DMs do I have on X",
        ]

    # Signal
    if param_key == "signal_contacts":
        return ["list my Signal contacts", "show Signal contacts"]
    if param_key == "signal_groups":
        return ["list my Signal groups", "show Signal groups"]
    if param_key == "signal_read_messages":
        return [
            f"read my latest {args.get('limit', 10)} Signal messages",
            "show recent Signal messages",
        ]
    if param_key == "signal_message":
        return [
            f"signal {recipient}: {text}",
            f"send Signal message to {recipient}: {text}",
        ]
    if param_key == "signal_reaction":
        return [
            f"react with {emoji} on Signal message {args.get('targetTimestamp')} from {args.get('targetAuthor')}",
            f"add a {emoji} reaction to that Signal msg",
        ]

    # BlueBubbles
    if param_key == "bluebubbles_reaction":
        return [
            f"react with {emoji} to message {msg_id}",
            f"add a {emoji} on that iMessage ({msg_id})",
        ]
    if param_key == "bluebubbles_message":
        return [
            f"send iMessage via BlueBubbles: {text}",
            f"text via BlueBubbles: {text}",
        ]

    # iMessage
    if param_key == "imessage_message":
        to = args.get("to", "current")
        return [
            f"iMessage {to}: {text}",
            f"text {to}: {text}",
        ]

    # WhatsApp
    if param_key == "whatsapp_message":
        to = args.get("to", "+14155552671")
        return [
            f"WhatsApp {to}: {text}",
            f"send a WhatsApp to {to}: {text}",
        ]
    if param_key == "whatsapp_reaction":
        return [
            f"react with {emoji} to whatsapp message {msg_id}",
            f"put a {emoji} on whatsapp msg {msg_id}",
        ]

    return [f"please run {action.lower().replace('_', ' ')}"]


def style_transform(msg: str, style: str, rng: random.Random) -> str:
    if style == "direct":
        return msg
    if style == "formal":
        return to_formal(msg)
    if style == "casual":
        return to_casual(msg)
    if style == "expert":
        return to_expert(msg)
    if style == "naive":
        return to_naive(msg)
    if style == "voice-asr":
        return add_disfluencies(msg, rng)
    if style == "distracted":
        return add_distraction(msg, rng)
    if style == "broken-english":
        return to_broken_english(msg, rng)
    if style == "self-correcting":
        return add_self_correction(msg, rng)
    return msg


# ────────────────────────── Memory builders ──────────────────────────


CASUAL_PRIOR = [
    "yo", "hey", "morning", "wat", "lol", "interesting", "saw the news?",
    "checking in", "let me think", "right",
]
ASSIST_PRIOR = [
    "got it", "ok", "noted", "I see", "sure", "yeah", "right",
    "interesting", "I'll keep that in mind",
]


def _make_memory(
    rng: random.Random,
    speaker: str,
    agent: str,
    style: str,
    *,
    related_topic: str | None = None,
) -> list[dict[str, Any]]:
    p = rng.random()
    if p < 0.30:
        n_pairs = 0
    elif p < 0.80:
        n_pairs = rng.choice([1, 1, 2])
    else:
        n_pairs = 3
    history: list[dict[str, Any]] = []
    for _ in range(n_pairs):
        u_text = rng.choice(CASUAL_PRIOR)
        if related_topic and rng.random() < 0.4:
            u_text = f"{u_text} — about {related_topic}?"
        history.append({
            "role": "user",
            "speaker": speaker,
            "content": u_text,
            "channel": "public" if rng.random() < 0.5 else "dm",
        })
        history.append({
            "role": "assistant",
            "speaker": agent,
            "content": rng.choice(ASSIST_PRIOR),
            "channel": "dm",
        })
    return history


# ────────────────────────── Subtle-null builder ──────────────────────────


SUBTLE_NULL_MESSAGES = [
    "thanks team, you're the best",
    "wow that was a lot, give me a sec",
    "I'm just venting, ignore me",
    "hmm, not sure what I want to do here",
    "love the vibes today",
    "lol nvm",
    "actually never mind, forget it",
    "I don't think we should do anything yet",
]


def _build_subtle_null_response(action: str,
                                 encoder: ExpectedResponseEncoder) -> tuple[str, list[str]]:
    """Either an IGNORE or a benign REPLY for cases where the action
    shouldn't fire."""
    # Half-half mix
    if hash(action) % 2 == 0:
        expected_response = encoder.encode({"thought": "", "text": "Acknowledged."})
        return expected_response, ["REPLY", "IGNORE", action]
    expected_response = encoder.encode({
        "thought": "User did not request the messaging action; nothing to do.",
        "actions": ["IGNORE"],
    })
    return expected_response, ["IGNORE", "REPLY", action]


# ────────────────────────── Record builder ──────────────────────────


def _pick_lang(rng: random.Random) -> str:
    """Sample language by configured weight."""
    pool: list[str] = []
    for code, n in LANGS_DIST:
        pool.extend([code] * n)
    return rng.choice(pool)


def _build_lang_schedule(n_per: int, rng: random.Random) -> list[str]:
    """Return a deterministic per-action language schedule of length
    n_per that hits the LANGS_DIST proportions exactly. Guarantees each
    non-en code gets >=3 records (with n_per=100 and 5% per non-en
    bucket the floor is 5)."""
    schedule: list[str] = []
    for code, n in LANGS_DIST:
        schedule.extend([code] * n)
    # If totals don't sum to n_per, top up with English.
    while len(schedule) < n_per:
        schedule.append("en")
    schedule = schedule[:n_per]
    rng.shuffle(schedule)
    return schedule


def _pick_style_for_index(action: str, idx: int) -> str:
    return STYLES[idx % len(STYLES)]


def _phrase(action: str, param_key: str, args: dict[str, Any], facts: dict[str, Any],
            lang: str, style: str, rng: random.Random) -> str:
    en_options = _en_phrasings(action, param_key, args, facts)
    en_msg = en_options[rng.randrange(len(en_options))]
    if lang != "en":
        templates = (
            TRANSLATIONS.get(param_key, {}).get(lang, [])
            or TRANSLATIONS.get(action, {}).get(lang, [])
        )
        if templates:
            tpl = templates[rng.randrange(len(templates))]
            try:
                fmt: dict[str, Any] = dict(facts)
                fmt.update({k: v for k, v in args.items()})
                msg = tpl.format(**fmt)
            except (KeyError, IndexError):
                msg = fallback_translate(lang, en_msg)
        else:
            msg = fallback_translate(lang, en_msg)
    else:
        msg = en_msg
    return style_transform(msg, style, rng)


def _canonicalize_connector_args(
    plugin: str,
    action: str,
    param_key: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    """Add canonical MESSAGE/POST operation fields for connector rows."""
    if action == "POST":
        operation = "send"
        if param_key in {"x_feed_top", "x_feed_summary"}:
            operation = "read"
        elif param_key == "x_search_posts":
            operation = "search"
        canonical = {"operation": operation, "source": "x", **args}
        if "maxResults" in args and "limit" not in canonical:
            canonical["limit"] = args["maxResults"]
        if "topN" in args and "limit" not in canonical:
            canonical["limit"] = args["topN"]
        return canonical

    if action != "MESSAGE":
        return args

    source_by_plugin = {
        "plugin-discord": "discord",
        "plugin-twitter": "x",
        "plugin-signal": "signal",
        "plugin-bluebubbles": "bluebubbles",
        "plugin-imessage": "imessage",
        "plugin-whatsapp": "whatsapp",
    }
    operation_by_key = {
        "DELETE_MESSAGE": "delete",
        "EDIT_MESSAGE": "edit",
        "JOIN_CHANNEL": "join",
        "LEAVE_CHANNEL": "leave",
        "discord_get_user": "get_user",
        "discord_list_channels": "list_channels",
        "discord_pin_message": "pin",
        "discord_private_message": "send",
        "discord_channel_message": "send",
        "discord_unpin_message": "pin",
        "x_read_messages": "read",
        "x_direct_message": "send",
        "signal_contacts": "get_user",
        "signal_groups": "list_channels",
        "signal_read_messages": "read",
        "signal_message": "send",
        "signal_reaction": "react",
        "bluebubbles_reaction": "react",
        "bluebubbles_message": "send",
        "imessage_message": "send",
        "whatsapp_message": "send",
        "whatsapp_reaction": "react",
    }
    canonical = {
        "operation": operation_by_key.get(param_key, "send"),
        "source": source_by_plugin.get(plugin, plugin.removeprefix("plugin-")),
        **args,
    }
    target = (
        args.get("recipient")
        or args.get("recipientIdentifier")
        or args.get("channelRef")
        or args.get("channelName")
        or args.get("guildId")
        or args.get("to")
    )
    if target and "target" not in canonical:
        canonical["target"] = target
    message_text = args.get("messageContent") or args.get("text") or args.get("newText")
    if message_text and "message" not in canonical:
        canonical["message"] = message_text
    message_id = args.get("messageId") or args.get("messageRef")
    if message_id and "messageId" not in canonical:
        canonical["messageId"] = message_id
    if args.get("guildId") and "serverId" not in canonical:
        canonical["serverId"] = args["guildId"]
    user = args.get("userIdentifier") or args.get("recipientIdentifier")
    if user and "user" not in canonical:
        canonical["user"] = user
    return canonical


def make_record(
    *, encoder: ExpectedResponseEncoder, action: str, param_key: str,
    plugin: str, idx: int,
    rng: random.Random, action_description: str,
    build_param_specs: list[ParamSpec], action_param_specs: list[ParamSpec],
    lang: str,
) -> dict[str, Any]:
    style = _pick_style_for_index(action, idx)
    persona = rng.choice(PERSONAS)
    agent = rng.choice(AGENT_NAMES)

    args, facts = _build_args(action, param_key, build_param_specs, idx, rng, style)
    args = _canonicalize_connector_args(plugin, action, param_key, args)

    if style == "subtle-null":
        msg = rng.choice(SUBTLE_NULL_MESSAGES)
        if lang != "en":
            msg = fallback_translate(lang, msg)
        expected_response, available = _build_subtle_null_response(action, encoder)
    else:
        msg = _phrase(action, param_key, args, facts, lang, style, rng)
        expected_response = encoder.encode({
            "tool_calls": [{"name": action, "arguments": args}],
        })
        available = [action, "REPLY", "IGNORE"]

    history = _make_memory(rng, persona, agent, style)

    rid = stable_id("messaging-gen", plugin, param_key, action, idx, msg, persona)[:12]

    system_prompt = (
        "You are an autonomous elizaOS agent. Decide which action to take "
        "from `availableActions` and respond with one compact JSON "
        "{tool_calls:[{name,arguments}]} document. No fences, no <think>, no prose before "
        "or after.\n\nAvailable actions: "
        f"{', '.join(available)}"
    )

    tool_specs = [{
        "name": action,
        "description": action_description or
        f"{action} action from {plugin}",
        "parameters": action_param_specs,
    }]

    rec = build(
        roomName=rid,
        agentId="agent",
        memoryEntries=history,
        currentMessage={"role": "user", "speaker": persona, "content": msg},
        expectedResponse=expected_response,
        availableActions=available,
        task_type="tool_call",
        source_dataset="synth-messaging-actions",
        license="synthetic",
        split="train",
        extra_metadata={
            "system_prompt": system_prompt,
            "toolSpecs": tool_specs,
            "synth_origin": "messaging-gen",
            "synth_action": action,
            "synth_intent": param_key,
            "synth_lang": lang,
            "synth_style": style,
            "plugin": plugin,
        },
    )
    return rec.to_dict()


# ────────────────────────── Main ──────────────────────────


TARGET_ACTIONS_BY_PLUGIN: dict[str, list[tuple[str, str]]] = {
    "plugin-discord": [
        ("CHAT_WITH_ATTACHMENTS", "CHAT_WITH_ATTACHMENTS"),
        ("CREATE_POLL", "CREATE_POLL"),
        ("MESSAGE", "DELETE_MESSAGE"),
        ("DOWNLOAD_MEDIA", "DOWNLOAD_MEDIA"),
        ("MESSAGE", "EDIT_MESSAGE"),
        ("MESSAGE", "discord_get_user"),
        ("MESSAGE", "JOIN_CHANNEL"),
        ("MESSAGE", "LEAVE_CHANNEL"),
        ("MESSAGE", "discord_list_channels"),
        ("MESSAGE", "discord_pin_message"),
        ("MESSAGE", "discord_private_message"),
        ("MESSAGE", "discord_channel_message"),
        ("SERVER_INFO", "SERVER_INFO"),
        ("SETUP_CREDENTIALS", "SETUP_CREDENTIALS"),
        ("SUMMARIZE_CONVERSATION", "SUMMARIZE_CONVERSATION"),
        ("TRANSCRIBE_MEDIA", "TRANSCRIBE_MEDIA"),
        ("MESSAGE", "discord_unpin_message"),
    ],
    "plugin-twitter": [
        ("POST", "x_feed_top"),
        ("POST", "x_post_basic"),
        ("MESSAGE", "x_read_messages"),
        ("MESSAGE", "x_direct_message"),
        ("POST", "x_search_posts"),
        ("POST", "x_post_confirmed"),
        ("POST", "x_feed_summary"),
    ],
    "plugin-signal": [
        ("MESSAGE", "signal_contacts"),
        ("MESSAGE", "signal_groups"),
        ("MESSAGE", "signal_read_messages"),
        ("MESSAGE", "signal_message"),
        ("MESSAGE", "signal_reaction"),
    ],
    "plugin-bluebubbles": [
        ("MESSAGE", "bluebubbles_reaction"),
        ("MESSAGE", "bluebubbles_message"),
    ],
    "plugin-imessage": [("MESSAGE", "imessage_message")],
    "plugin-whatsapp": [
        ("MESSAGE", "whatsapp_message"),
        ("MESSAGE", "whatsapp_reaction"),
    ],
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-per", type=int, default=100,
                    help="records per connector intent (default 100)")
    ap.add_argument("--seed", type=int, default=0xCEEB05)
    ap.add_argument("--out", type=Path, default=OUT_PATH)
    args = ap.parse_args()

    catalog = json.loads(ACTIONS_PATH.read_text(encoding="utf-8"))
    by_name: dict[str, dict[str, Any]] = {a["name"]: a
                                           for a in catalog["actions"]}

    targets: list[tuple[str, str, str]] = []
    for plugin, entries in TARGET_ACTIONS_BY_PLUGIN.items():
        for action, param_key in entries:
            targets.append((plugin, action, param_key))

    log.info("Generating %d records each for %d connector intents = %d total target",
             args.n_per, len(targets), args.n_per * len(targets))

    encoder = JsonExpectedResponseEncoder()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    n_total = 0
    try:
        with args.out.open("w", encoding="utf-8") as f:
            for plugin, action, param_key in targets:
                cat_entry = by_name.get(action, {})
                desc = cat_entry.get("description") or ""
                params = ALL_PARAMS.get(param_key, [])
                # If catalog has explicit params, prefer those; otherwise
                # use our researched specs.
                if cat_entry.get("parameters"):
                    cat_params = cat_entry["parameters"]
                    params_for_specs = [
                        {"name": p["name"], "type": p.get("type", "string"),
                         "required": p.get("required", False),
                         "description": p.get("description", "")}
                        for p in cat_params
                    ]
                else:
                    params_for_specs = params
                seed_material = hash((plugin, action, param_key)) & 0xFFFFFFFF
                action_rng = random.Random(args.seed ^ seed_material)
                lang_schedule = _build_lang_schedule(args.n_per, action_rng)
                wrote = 0
                for i in range(args.n_per):
                    rec = make_record(
                        encoder=encoder, action=action, param_key=param_key,
                        plugin=plugin,
                        idx=i, rng=action_rng,
                        action_description=desc,
                        build_param_specs=params,
                        action_param_specs=params_for_specs,
                        lang=lang_schedule[i],
                    )
                    f.write(json.dumps(rec, ensure_ascii=False,
                                       separators=(",", ":")) + "\n")
                    wrote += 1
                counts[f"{plugin}/{param_key}->{action}"] = wrote
                n_total += wrote
                log.info("  %s/%s (%s): %d records",
                         plugin, action, param_key, wrote)
    finally:
        encoder.close()

    log.info("=== messaging synthesis summary ===")
    log.info("  actions covered: %d", len(counts))
    log.info("  records written: %d", n_total)
    log.info("  output: %s", args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
