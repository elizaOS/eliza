"""Rule-based synthesis of ~100 records per music action (~1,500 total).

Targets the 15 music actions across `plugin-music-library` (8) and
`plugin-music-player` (7). Per-action records cover:

  - English requests (~70 per action) across 20+ personas, 10+ phrasing
    styles, varied memory depths.
  - Multilingual requests (~30 per action) across zh/es/fr/ja/de/pt
    (≥3 each), distributed deterministically.
  - 5-10% subtle-null records that resolve to a canonical
    `thought:/text:` REPLY (e.g., "I want to listen to something")
    instead of a tool call — encoded via native JSON like the bundled
    `reply` task.

Output: one JSONL per record under
    data/synthesized/action_examples/music.jsonl

The expected shape is the canonical eliza record (see
`scripts/lib/eliza_record.py`):

  - `task_type: tool_call` for tool-call records.
  - `task_type: reply` for the subtle-null records.

Tool-call `expectedResponse` is the native JSON-encoded
`{tool_calls: [{name, arguments}]}` envelope, exactly matching the
upstream `synthesize_action_pairs.py` shape.

Usage:
    .venv/bin/python scripts/synthesize_music_actions.py
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.eliza_record import (  # noqa: E402
    ACTION_REPLY,
    ACTION_TASK_CALL,
    build,
    stable_id,
)
from lib.expected_response import ExpectedResponseEncoder, JsonExpectedResponseEncoder  # noqa: E402

ACTIONS_PATH = ROOT / "data" / "prompts" / "actions-catalog.json"
OUT_DIR = ROOT / "data" / "synthesized" / "action_examples"
OUT_FILE = OUT_DIR / "music.jsonl"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("synth-music")


# ───────────────────────────── shared pools ─────────────────────────────

AGENT_NAMES = [
    "Iris", "Kai", "Ava", "Nova", "Echo", "Sage", "Atlas", "Lyra",
    "Pico", "Lumi", "Rune", "Vega", "Sol", "Orion", "Mira", "Tess",
    "eliza", "Eliza", "Cleo", "Juno",
]

USER_NAMES = [
    "alice", "bob", "carlos", "diana", "ethan", "fatima", "george",
    "hina", "ivan", "jin", "kira", "leo", "mia", "noah", "olivia",
    "priya", "quinn", "raj", "sofia", "tomas", "yuna", "marcus",
    "claire", "miguel",
]

ROOM_KINDS = [
    "dm",
    "channel:music",
    "channel:listening-room",
    "channel:study-hall",
    "channel:lounge",
    "channel:road-trip",
    "channel:party",
    "channel:focus",
    "channel:general",
]
CHANNELS = ["dm", "public", "voice"]


# ───────────────────────────── music scenario pools ─────────────────────

# Songs / artists / albums spanning many genres.
TRACKS = [
    # rock / classic
    ("Stairway to Heaven", "Led Zeppelin", "rock"),
    ("Hotel California", "Eagles", "rock"),
    ("Comfortably Numb", "Pink Floyd", "rock"),
    ("Bohemian Rhapsody", "Queen", "rock"),
    ("Smells Like Teen Spirit", "Nirvana", "rock"),
    ("Surefire", "Wilderado", "indie"),
    ("Mr. Brightside", "The Killers", "indie"),
    ("Last Nite", "The Strokes", "indie"),
    # pop
    ("Anti-Hero", "Taylor Swift", "pop"),
    ("Cruel Summer", "Taylor Swift", "pop"),
    ("Shape of You", "Ed Sheeran", "pop"),
    ("Levitating", "Dua Lipa", "pop"),
    ("Espresso", "Sabrina Carpenter", "pop"),
    ("Watermelon Sugar", "Harry Styles", "pop"),
    # hip-hop
    ("God's Plan", "Drake", "hip-hop"),
    ("HUMBLE.", "Kendrick Lamar", "hip-hop"),
    ("Sicko Mode", "Travis Scott", "hip-hop"),
    ("Lose Yourself", "Eminem", "hip-hop"),
    ("Money Trees", "Kendrick Lamar", "hip-hop"),
    # k-pop
    ("Dynamite", "BTS", "k-pop"),
    ("Butter", "BTS", "k-pop"),
    ("How You Like That", "BLACKPINK", "k-pop"),
    ("Cupid", "FIFTY FIFTY", "k-pop"),
    # latin
    ("Tití Me Preguntó", "Bad Bunny", "latin"),
    ("Despacito", "Luis Fonsi", "latin"),
    ("Bad Bunny - Me Porto Bonito", "Bad Bunny", "latin"),
    ("Vivir Mi Vida", "Marc Anthony", "latin"),
    # electronic / edm
    ("Strobe", "Deadmau5", "electronic"),
    ("Levels", "Avicii", "electronic"),
    ("Opus", "Eric Prydz", "electronic"),
    ("Midnight City", "M83", "electronic"),
    # classical
    ("Moonlight Sonata", "Beethoven", "classical"),
    ("Clair de Lune", "Debussy", "classical"),
    ("Nessun Dorma", "Puccini", "classical"),
    ("Symphony No. 9", "Beethoven", "classical"),
    ("Canon in D", "Pachelbel", "classical"),
    # jazz
    ("Take Five", "Dave Brubeck", "jazz"),
    ("So What", "Miles Davis", "jazz"),
    ("My Favorite Things", "John Coltrane", "jazz"),
    ("Round Midnight", "Thelonious Monk", "jazz"),
    # beatles classics
    ("Here Comes the Sun", "The Beatles", "rock"),
    ("Let It Be", "The Beatles", "rock"),
    ("Hey Jude", "The Beatles", "rock"),
    # country
    ("Tennessee Whiskey", "Chris Stapleton", "country"),
    ("Wagon Wheel", "Old Crow Medicine Show", "country"),
    # r&b / soul
    ("Blinding Lights", "The Weeknd", "r&b"),
    ("Adorn", "Miguel", "r&b"),
    ("Pink + White", "Frank Ocean", "r&b"),
]

# Common playlist names users save / load / delete.
PLAYLIST_NAMES = [
    "workout", "morning run", "study session", "deep focus", "sleep",
    "party mix", "road trip", "dinner party", "chill vibes", "summer hits",
    "rainy day", "gym pump", "lo-fi", "Sunday brunch", "dance floor",
    "throwbacks", "bedroom pop", "rock classics", "My Favorites",
    "indie discoveries", "hype playlist", "coding focus", "guitar heroes",
    "k-pop bangers", "latin nights", "jazz hour", "sad bois",
    "yoga flow", "podcast queue", "wedding vibes", "chill house",
    "old school", "midnight drive", "reading corner", "coffee shop",
]

# Realistic free-form music queries — for PLAY_MUSIC_QUERY.
COMPLEX_QUERIES = [
    "the strokes' first single",
    "Taylor Swift's latest album",
    "something like Phoebe Bridgers but happier",
    "80s synth pop",
    "early 90s grunge",
    "Bad Bunny's most popular song",
    "BTS Korean version of Dynamite",
    "Drake summer vibes",
    "the third Beatles album",
    "study music with no words",
    "house music for cleaning",
    "lofi beats for coding",
    "movie soundtrack from Inception",
    "anime opening songs",
    "songs about heartbreak",
    "acoustic version of Wonderwall",
    "live cover of Hallelujah",
    "Frank Sinatra Christmas",
    "70s disco classics",
    "Beethoven 5th symphony",
    "ABBA but remixed",
    "indie rock from 2018",
    "Daft Punk Discovery album",
    "viral TikTok songs from last month",
    "songs from the Barbie movie",
    "Stranger Things soundtrack",
    "wedding first dance songs",
    "songs to cry to",
    "high energy gym tracks",
    "smooth jazz dinner playlist",
    "kids' bedtime music",
    "Christmas carols a cappella",
    "Halloween spooky music",
    "rainy Sunday playlist",
    "songs my dad would love",
]

# Plain free-text queries / search words for PLAY_AUDIO when no URL is given.
SEARCH_PHRASES = [
    "Hotel California Eagles",
    "Bohemian Rhapsody Queen live",
    "Despacito Luis Fonsi",
    "Bad Guy Billie Eilish",
    "Industry Baby Lil Nas X",
    "Take Five Dave Brubeck",
    "Moonlight Sonata third movement",
    "Cruel Summer Taylor Swift",
    "Nessun Dorma Pavarotti",
    "Dynamite BTS",
    "Vivir Mi Vida Marc Anthony",
    "Strobe deadmau5 extended mix",
    "Ed Sheeran Shape of You",
    "Levitating Dua Lipa",
]

# Real YouTube media URLs (well-known publicly listed videos).
YOUTUBE_URLS = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=fJ9rUzIMcZQ",
    "https://www.youtube.com/watch?v=9bZkp7q19f0",
    "https://www.youtube.com/watch?v=hT_nvWreIhg",
    "https://www.youtube.com/watch?v=kJQP7kiw5Fk",
    "https://www.youtube.com/watch?v=JGwWNGJdvx8",
    "https://youtu.be/L_jWHffIx5E",
    "https://youtu.be/RgKAFK5djSk",
    "https://music.youtube.com/watch?v=5anLPw0Efmo",
]


# ───────────────────────────── language pool ────────────────────────────
# Multilingual phrasings keyed by language. Each phrasing template uses
# {q} as the music-query slot. Roughly equal coverage across languages.
LANG_POOL: dict[str, list[str]] = {
    "zh": [
        "播放 {q}",
        "请放 {q}",
        "我想听 {q}",
        "可以播放 {q} 吗",
        "把 {q} 放出来",
        "帮我播放 {q}",
    ],
    "es": [
        "pon {q}",
        "reproduce {q}",
        "quiero escuchar {q}",
        "¿puedes poner {q}?",
        "ponme {q} por favor",
        "dale a {q}",
    ],
    "fr": [
        "joue {q}",
        "mets {q} s'il te plaît",
        "je veux écouter {q}",
        "tu peux lancer {q} ?",
        "passe {q}",
    ],
    "ja": [
        "{q} を再生して",
        "{q} をかけて",
        "{q} 聴きたい",
        "{q} 流して",
        "{q} お願い",
    ],
    "de": [
        "spiel {q}",
        "kannst du {q} abspielen",
        "ich möchte {q} hören",
        "leg {q} auf bitte",
        "spiel mal {q}",
    ],
    "pt": [
        "toca {q}",
        "põe {q} pra tocar",
        "quero ouvir {q}",
        "pode tocar {q}?",
        "manda {q}",
    ],
}

# Multilingual playlist phrases keyed by language. {p} is playlist name.
LANG_PLAYLIST_LOAD: dict[str, list[str]] = {
    "zh": ["加载 {p} 歌单", "把 {p} 这个歌单放出来", "切到 {p} 歌单"],
    "es": ["carga la playlist {p}", "pon mi playlist {p}", "reproduce la lista {p}"],
    "fr": ["charge la playlist {p}", "mets la playlist {p}", "joue la liste {p}"],
    "ja": ["{p} のプレイリストをかけて", "{p} を読み込んで", "{p} 流して"],
    "de": ["lade die {p} Playlist", "spiel die Playlist {p}", "Playlist {p} bitte"],
    "pt": ["carrega a playlist {p}", "põe a playlist {p}", "toca a lista {p}"],
}

LANG_PLAYLIST_LIST: dict[str, list[str]] = {
    "zh": ["显示我的歌单", "我的歌单都有哪些", "列出所有歌单"],
    "es": ["muéstrame mis playlists", "lista mis playlists", "qué playlists tengo"],
    "fr": ["montre mes playlists", "liste mes playlists", "quelles playlists ai-je"],
    "ja": ["プレイリスト一覧を見せて", "私のプレイリスト全部出して", "プレイリスト見せて"],
    "de": ["zeig meine Playlists", "liste alle Playlists", "welche Playlists habe ich"],
    "pt": ["mostra minhas playlists", "lista as minhas playlists", "quais playlists tenho"],
}

LANG_PLAYLIST_DELETE: dict[str, list[str]] = {
    "zh": ["删除 {p} 歌单", "把 {p} 这个歌单删了", "去掉 {p} 歌单"],
    "es": ["borra la playlist {p}", "elimina la lista {p}", "quita la playlist {p}"],
    "fr": ["supprime la playlist {p}", "efface la liste {p}", "enlève la playlist {p}"],
    "ja": ["{p} のプレイリストを削除", "{p} を消して", "{p} のリストを削除"],
    "de": ["lösche die Playlist {p}", "entferne {p}", "Playlist {p} löschen"],
    "pt": ["apaga a playlist {p}", "exclui a lista {p}", "remove a playlist {p}"],
}

LANG_PLAYLIST_ADD: dict[str, list[str]] = {
    "zh": ["把 {q} 加到 {p} 歌单", "把 {q} 添加到 {p}", "{q} 加进 {p} 歌单"],
    "es": ["agrega {q} a la playlist {p}", "añade {q} a {p}", "mete {q} en {p}"],
    "fr": ["ajoute {q} à la playlist {p}", "mets {q} dans {p}", "insère {q} dans la liste {p}"],
    "ja": ["{q} を {p} に追加", "{q} を {p} のプレイリストに入れて", "{p} に {q} 追加"],
    "de": ["füge {q} zur Playlist {p} hinzu", "pack {q} in {p}", "{q} zu {p} hinzufügen"],
    "pt": ["adiciona {q} à playlist {p}", "põe {q} em {p}", "coloca {q} na lista {p}"],
}

LANG_SAVE_PLAYLIST: dict[str, list[str]] = {
    "zh": ["把当前队列保存为歌单", "保存当前播放列表", "把现在的队列存成歌单"],
    "es": ["guarda esta cola como playlist", "salva la cola como lista", "guarda esto como playlist"],
    "fr": ["enregistre cette file comme playlist", "sauve cette queue en playlist"],
    "ja": ["今のキューをプレイリストに保存", "このキューをプレイリストとして保存", "現在のキューを保存"],
    "de": ["speichere die Warteschlange als Playlist", "Queue als Playlist speichern"],
    "pt": ["salva a fila como playlist", "guarda esta fila como playlist"],
}

LANG_SEARCH_YT: dict[str, list[str]] = {
    "zh": ["在 YouTube 上搜索 {q}", "帮我搜 YouTube 上的 {q}", "找一下 {q} 的 YouTube 链接"],
    "es": ["busca {q} en YouTube", "encuentra el enlace de YouTube de {q}", "búscame {q} en YouTube"],
    "fr": ["cherche {q} sur YouTube", "trouve le lien YouTube de {q}", "recherche {q} sur YouTube"],
    "ja": ["YouTube で {q} を検索", "{q} の YouTube リンクを探して", "YouTube で {q} 探して"],
    "de": ["such {q} auf YouTube", "finde den YouTube-Link für {q}", "suche {q} bei YouTube"],
    "pt": ["procura {q} no YouTube", "acha o link do YouTube de {q}", "pesquisa {q} no YouTube"],
}

LANG_DOWNLOAD: dict[str, list[str]] = {
    "zh": ["下载 {q}", "把 {q} 下载到本地", "{q} 保存到我的音乐库"],
    "es": ["descarga {q}", "guarda {q} en mi biblioteca", "baja {q} sin reproducir"],
    "fr": ["télécharge {q}", "sauvegarde {q} dans ma bibliothèque", "récupère {q} sans le jouer"],
    "ja": ["{q} をダウンロード", "{q} をライブラリに保存", "{q} を取得して"],
    "de": ["lade {q} herunter", "speichere {q} in meiner Bibliothek", "hol {q} runter ohne zu spielen"],
    "pt": ["baixa {q}", "salva {q} na biblioteca", "faz download de {q}"],
}

LANG_PAUSE: dict[str, list[str]] = {
    "zh": ["暂停音乐", "把音乐暂停一下", "停一下"],
    "es": ["pausa la música", "para un momento", "pausa esto"],
    "fr": ["mets en pause", "pause la musique", "stoppe un instant"],
    "ja": ["音楽を一時停止", "ポーズして", "ちょっと止めて"],
    "de": ["pausiere die Musik", "Pause bitte", "halt mal kurz an"],
    "pt": ["pausa a música", "dá um pause", "pausa isso"],
}

LANG_RESUME: dict[str, list[str]] = {
    "zh": ["继续播放", "音乐继续", "恢复播放"],
    "es": ["reanuda la música", "continúa la música", "sigue tocando"],
    "fr": ["reprends la musique", "continue", "remets la musique"],
    "ja": ["音楽を再開", "再開して", "続けて"],
    "de": ["spiel weiter", "Musik fortsetzen", "weitermachen"],
    "pt": ["retoma a música", "continua tocando", "volta a música"],
}

LANG_STOP: dict[str, list[str]] = {
    "zh": ["停止音乐", "关掉音乐", "把音乐关了"],
    "es": ["detén la música", "apaga la música", "para todo y limpia la cola"],
    "fr": ["arrête la musique", "coupe la musique", "stoppe tout"],
    "ja": ["音楽を止めて", "音楽オフ", "全部止めて"],
    "de": ["stopp die Musik", "Musik aus", "halt komplett an"],
    "pt": ["para a música", "desliga a música", "encerra a música"],
}

LANG_SKIP: dict[str, list[str]] = {
    "zh": ["跳过这首", "下一首", "切歌"],
    "es": ["sáltate esta", "siguiente canción", "pasa a la próxima"],
    "fr": ["passe la chanson", "suivante", "saute ce morceau"],
    "ja": ["スキップ", "次の曲", "この曲飛ばして"],
    "de": ["überspring den Song", "nächster Titel", "skip"],
    "pt": ["pula essa", "próxima música", "passa pra próxima"],
}

LANG_QUEUE: dict[str, list[str]] = {
    "zh": ["把 {q} 加到队列", "排队播放 {q}", "{q} 加入下一首"],
    "es": ["añade {q} a la cola", "encola {q}", "pon {q} para después"],
    "fr": ["ajoute {q} à la file", "mets {q} dans la queue", "encadre {q} pour plus tard"],
    "ja": ["{q} をキューに追加", "{q} を後で再生", "次に {q}"],
    "de": ["{q} zur Warteschlange hinzufügen", "stell {q} in die Queue", "{q} reihen ein"],
    "pt": ["adiciona {q} à fila", "põe {q} na fila", "deixa {q} pra depois"],
}

LANG_SHOW_QUEUE: dict[str, list[str]] = {
    "zh": ["显示队列", "队列里有什么", "把队列拿出来看看"],
    "es": ["muestra la cola", "qué hay en la cola", "ver la cola"],
    "fr": ["montre la file", "qu'est-ce qu'il y a dans la file", "affiche la queue"],
    "ja": ["キューを見せて", "キューに何ある", "キュー一覧"],
    "de": ["zeig die Warteschlange", "was steht in der Queue", "Queue anzeigen"],
    "pt": ["mostra a fila", "o que tem na fila", "ver a fila"],
}


# ───────────────────────────── memory entry pools ───────────────────────

# Short-form memory snippets shared across actions to vary memory depth.
MEMORY_SNIPPETS = [
    [],  # depth 0
    [
        ("user", "what's a good chill playlist"),
        ("agent", "I can pull together something with lo-fi and ambient if you want."),
    ],
    [
        ("user", "I'm trying to focus this afternoon"),
        ("agent", "Want me to start your study queue?"),
        ("user", "yeah please"),
    ],
    [
        ("user", "remind me to grab milk"),
        ("agent", "Added — also, anything for the music side?"),
    ],
    [
        ("user", "the last track was kinda mid"),
        ("agent", "Got it. I can switch genres or skip ahead."),
    ],
    [
        ("agent", "Currently playing: Hotel California — Eagles."),
        ("user", "ok cool"),
    ],
    [
        ("user", "queue is getting empty"),
        ("agent", "I can build it back up — what mood?"),
    ],
    [
        ("user", "morning standup ran long"),
        ("agent", "Heads up — your usual focus playlist is ready when you are."),
        ("user", "good"),
    ],
]


# ───────────────────────────── phrasing helpers ─────────────────────────

# English style adjectives — paraphrased prefixes/suffixes injected to
# vary register: casual / urgent / polite / voice-style / typo-light.
EN_PREFIXES = [
    "", "hey, ", "yo ", "ok so ", "uhh ", "real quick — ",
    "please ", "could you ", "can you ", "would you mind ",
    "i need you to ", "let's ", "go ahead and ", "trigger this: ",
    "voice command: ", "alexa, ", "siri, ", "hey eliza, ",
]
EN_SUFFIXES = [
    "", " thanks", " plz", " 🙏", "?", " — when you can",
    " right now", " (loud)", " 🎶", " for me", " on the speaker",
    " — keep it going",
]


def en_paraphrase(rng: random.Random, base: str, idx: int) -> str:
    pfx = EN_PREFIXES[idx % len(EN_PREFIXES)]
    sfx = EN_SUFFIXES[(idx // len(EN_PREFIXES)) % len(EN_SUFFIXES)]
    out = f"{pfx}{base}{sfx}".strip()
    if not out:
        return base
    return out


def to_memory_entries(
    rng: random.Random,
    speaker: str,
    agent: str,
    channel: str,
    snippet: list[tuple[str, str]],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for role, text in snippet:
        if role == "user":
            out.append({
                "role": "user",
                "speaker": speaker,
                "content": text,
                "channel": channel,
            })
        else:
            out.append({
                "role": "assistant",
                "speaker": agent,
                "content": text,
                "channel": channel,
            })
    return out


# ───────────────────────────── core builder ─────────────────────────────

def build_record(
    *,
    encoder: ExpectedResponseEncoder,
    task_type: str,
    user_msg: str,
    expected: dict[str, Any] | str,
    available_actions: list[str],
    extra_md: dict[str, Any],
    rng: random.Random,
    memory_idx: int,
    language: str,
) -> dict[str, Any]:
    agent = rng.choice(AGENT_NAMES)
    speaker = rng.choice(USER_NAMES)
    room_kind = rng.choice(ROOM_KINDS)
    channel = "dm" if room_kind == "dm" else rng.choice(CHANNELS)

    snippet = MEMORY_SNIPPETS[memory_idx % len(MEMORY_SNIPPETS)]
    memory = to_memory_entries(rng, speaker, agent, channel, snippet)

    if isinstance(expected, str):
        expected_str = expected
    else:
        expected_str = encoder.encode(expected)

    md = {"agent_name": agent, "language": language, "room_kind": room_kind}
    md.update(extra_md)

    rec = build(
        roomName=stable_id("synth-music", task_type, user_msg, agent, language),
        agentId=agent.lower(),
        memoryEntries=memory,
        currentMessage={
            "role": "user",
            "speaker": speaker,
            "content": user_msg,
            "channel": channel,
        },
        expectedResponse=expected_str,
        availableActions=available_actions,
        task_type=task_type,
        source_dataset="synth-music-actions",
        license="synthetic",
        split="train",
        extra_metadata=md,
    )
    return rec.to_dict()


def tool_call_expected(action_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "tool_calls": [
            {
                "name": action_name,
                "arguments": arguments,
            }
        ]
    }


# ───────────────────────────── per-action generators ────────────────────

# Each generator yields (user_msg, expected_or_tool_args, language) tuples
# along with extra metadata. Tool args use `confirmed: true` for actions
# that require it; LIST_PLAYLISTS / SHOW_QUEUE / SEARCH_YOUTUBE / PAUSE /
# RESUME have no params per the catalog.

def _en_track_query(idx: int) -> tuple[str, str, str]:
    title, artist, genre = TRACKS[idx % len(TRACKS)]
    return title, artist, genre


def _multilingual_distribution(total: int, langs: list[str]) -> list[str]:
    """Round-robin distribute a list of languages across `total` slots."""
    out: list[str] = []
    for i in range(total):
        out.append(langs[i % len(langs)])
    return out


# Subtle-null user messages → REPLY shape (no specific track / playlist
# named, agent should ask back instead of calling a tool).
SUBTLE_NULL_TEMPLATES = [
    ("I want to listen to something", "User wants music but did not specify a track, artist, genre, or mood — ask what they want before queueing.", "Sure — what should I put on? Any artist, genre, or mood in mind?"),
    ("put on some music", "Vague music request without enough signal to pick a track — ask for genre or mood.", "Happy to. What kind of vibe — chill, hype, focus, something else?"),
    ("can you play that one song", "Reference is ambiguous; no recent track context to anchor 'that one song' — ask for the title or artist.", "Which one? Drop a title or even a lyric snippet and I can find it."),
    ("throw on some tunes", "Underspecified — needs a genre or mood before I can choose anything.", "On it. Anything specific — genre, artist, or activity?"),
    ("vibe music please", "User asked for 'vibe' music with no further signal — ask for the kind of vibe.", "Got you. What kind of vibe — lo-fi, indie, chill house, something else?"),
    ("queue something good", "User wants a queue addition but did not name a track or artist.", "Sure — any genre, artist, or mood you're feeling right now?"),
    ("save my playlist", "Save action needs context (queue contents are unspecified) and the user did not provide a name.", "Want me to save the current queue as a playlist? If so, what should I name it?"),
    ("play that thing", "Anaphoric reference with no clear antecedent in memory; need clarification.", "Which one? Give me a title or an artist and I'll grab it."),
    ("put it back on", "Resume reference is ambiguous — no track was paused recently in this conversation.", "Sure — what would you like back on? I don't see a recently paused track."),
    ("just music", "Single-word request with no useful signal.", "Cool — any artist, genre, or mood I should aim for?"),
]


def _subtle_null_record(
    encoder: ExpectedResponseEncoder,
    rng: random.Random,
    idx: int,
    action_name: str,
    plugin: str,
) -> dict[str, Any]:
    user_msg, thought, text = SUBTLE_NULL_TEMPLATES[idx % len(SUBTLE_NULL_TEMPLATES)]
    expected = {"thought": thought, "text": text}
    return build_record(
        encoder=encoder,
        task_type="reply",
        user_msg=user_msg,
        expected=expected,
        available_actions=[ACTION_REPLY, ACTION_TASK_CALL, action_name],
        extra_md={
            "action_name": action_name,
            "plugin": plugin,
            "subtle_null": True,
        },
        rng=rng,
        memory_idx=idx,
        language="en",
    )


# ─── plugin-music-library ─────────────────────────────────────────────

def gen_play_audio(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    """PLAY_AUDIO: track / artist / search words / media URL.

    Uses confirmed:true (per catalog). Mix English (~70) + multilingual (~30),
    with ~10% subtle-null replies routed via _subtle_null_record.
    """
    plugin = "plugin-music-player"
    action = "PLAY_AUDIO"
    null_quota = max(1, int(n * 0.10))
    null_idxs = set(rng.sample(range(n), null_quota))

    en_count = 0
    en_target = int(n * 0.70)
    multi_target = n - en_target - null_quota
    multi_langs = _multilingual_distribution(multi_target, ["zh", "es", "fr", "ja", "de", "pt"])
    multi_iter = iter(multi_langs)

    en_styles = [
        "play {title} by {artist}",
        "throw on {title}",
        "let's hear {title} — {artist}",
        "i want to listen to {title}",
        "queue and play {title}",
        "put on {artist} — {title}",
        "play {url}",
        "open {url}",
        "play this: {url}",
        "search and play {phrase}",
    ]

    for i in range(n):
        if i in null_idxs:
            yield _subtle_null_record(encoder, rng, i, action, plugin)
            continue

        if en_count < en_target:
            title, artist, genre = _en_track_query(i)
            url = YOUTUBE_URLS[i % len(YOUTUBE_URLS)]
            phrase = SEARCH_PHRASES[i % len(SEARCH_PHRASES)]
            tmpl = en_styles[i % len(en_styles)]
            base = tmpl.format(title=title, artist=artist, url=url, phrase=phrase)
            user_msg = en_paraphrase(rng, base, i)
            language = "en"
            en_count += 1
            scenario = {"genre": genre, "artist": artist}
        else:
            language = next(multi_iter)
            tmpl = LANG_POOL[language][i % len(LANG_POOL[language])]
            title, artist, genre = _en_track_query(i)
            user_msg = tmpl.format(q=f"{title} - {artist}")
            scenario = {"genre": genre, "artist": artist}

        expected = tool_call_expected(action, {"confirmed": True})
        yield build_record(
            encoder=encoder,
            task_type="tool_call",
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action],
            extra_md={"action_name": action, "plugin": plugin, **scenario},
            rng=rng,
            memory_idx=i,
            language=language,
        )


def gen_play_music_query(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    plugin = "plugin-music-library"
    action = "PLAY_MUSIC_QUERY"
    null_quota = max(1, int(n * 0.10))
    null_idxs = set(rng.sample(range(n), null_quota))

    en_target = int(n * 0.70)
    multi_target = n - en_target - null_quota
    multi_langs = _multilingual_distribution(multi_target, ["zh", "es", "fr", "ja", "de", "pt"])
    multi_iter = iter(multi_langs)
    en_count = 0

    en_styles = [
        "play {q}",
        "find me {q}",
        "research and play {q}",
        "smart play: {q}",
        "i want {q}",
        "look up {q} and queue it",
        "give me {q}",
    ]

    for i in range(n):
        if i in null_idxs:
            yield _subtle_null_record(encoder, rng, i, action, plugin)
            continue

        q = COMPLEX_QUERIES[i % len(COMPLEX_QUERIES)]

        if en_count < en_target:
            tmpl = en_styles[i % len(en_styles)]
            user_msg = en_paraphrase(rng, tmpl.format(q=q), i)
            language = "en"
            en_count += 1
        else:
            language = next(multi_iter)
            user_msg = LANG_POOL[language][i % len(LANG_POOL[language])].format(q=q)

        expected = tool_call_expected(action, {"confirmed": True})
        yield build_record(
            encoder=encoder,
            task_type="tool_call",
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action],
            extra_md={"action_name": action, "plugin": plugin, "query": q},
            rng=rng,
            memory_idx=i,
            language=language,
        )


def gen_queue_music(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    plugin = "plugin-music-player"
    action = "QUEUE_MUSIC"
    null_quota = max(1, int(n * 0.10))
    null_idxs = set(rng.sample(range(n), null_quota))

    en_target = int(n * 0.70)
    multi_target = n - en_target - null_quota
    multi_langs = _multilingual_distribution(multi_target, ["zh", "es", "fr", "ja", "de", "pt"])
    multi_iter = iter(multi_langs)
    en_count = 0

    en_styles = [
        "queue {title} by {artist}",
        "add {title} to the queue",
        "queue up {artist} — {title}",
        "stick {title} on the queue",
        "next up: {title}",
        "throw {title} in the queue for later",
    ]

    for i in range(n):
        if i in null_idxs:
            yield _subtle_null_record(encoder, rng, i, action, plugin)
            continue

        title, artist, genre = _en_track_query(i)

        if en_count < en_target:
            tmpl = en_styles[i % len(en_styles)]
            base = tmpl.format(title=title, artist=artist)
            user_msg = en_paraphrase(rng, base, i)
            language = "en"
            en_count += 1
        else:
            language = next(multi_iter)
            tmpl = LANG_QUEUE[language][i % len(LANG_QUEUE[language])]
            user_msg = tmpl.format(q=f"{title} - {artist}")

        expected = tool_call_expected(action, {"confirmed": True})
        yield build_record(
            encoder=encoder,
            task_type="tool_call",
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action],
            extra_md={"action_name": action, "plugin": plugin, "genre": genre},
            rng=rng,
            memory_idx=i,
            language=language,
        )


def gen_pause_music(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    plugin = "plugin-music-player"
    action = "PAUSE_MUSIC"
    en_target = int(n * 0.70)
    multi_target = n - en_target
    multi_langs = _multilingual_distribution(multi_target, ["zh", "es", "fr", "ja", "de", "pt"])
    multi_iter = iter(multi_langs)
    en_count = 0

    en_styles = [
        "pause the music",
        "pause",
        "hit pause",
        "hold on, pause it",
        "pause the song",
        "pause playback please",
        "freeze the audio",
        "could you pause this",
        "pause for a sec",
        "give me a pause",
    ]

    for i in range(n):
        if en_count < en_target:
            user_msg = en_paraphrase(rng, en_styles[i % len(en_styles)], i)
            language = "en"
            en_count += 1
        else:
            language = next(multi_iter)
            user_msg = LANG_PAUSE[language][i % len(LANG_PAUSE[language])]

        expected = tool_call_expected(action, {})
        yield build_record(
            encoder=encoder,
            task_type="tool_call",
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action],
            extra_md={"action_name": action, "plugin": plugin},
            rng=rng,
            memory_idx=i,
            language=language,
        )


def gen_resume_music(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    plugin = "plugin-music-player"
    action = "RESUME_MUSIC"
    en_target = int(n * 0.70)
    multi_target = n - en_target
    multi_langs = _multilingual_distribution(multi_target, ["zh", "es", "fr", "ja", "de", "pt"])
    multi_iter = iter(multi_langs)
    en_count = 0

    en_styles = [
        "resume the music",
        "unpause",
        "continue playing",
        "keep going",
        "resume",
        "play again",
        "back on please",
        "kick it back on",
        "let it ride",
        "press play",
    ]

    for i in range(n):
        if en_count < en_target:
            user_msg = en_paraphrase(rng, en_styles[i % len(en_styles)], i)
            language = "en"
            en_count += 1
        else:
            language = next(multi_iter)
            user_msg = LANG_RESUME[language][i % len(LANG_RESUME[language])]

        expected = tool_call_expected(action, {})
        yield build_record(
            encoder=encoder,
            task_type="tool_call",
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action],
            extra_md={"action_name": action, "plugin": plugin},
            rng=rng,
            memory_idx=i,
            language=language,
        )


def gen_stop_music(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    plugin = "plugin-music-player"
    action = "STOP_MUSIC"
    en_target = int(n * 0.70)
    multi_target = n - en_target
    multi_langs = _multilingual_distribution(multi_target, ["zh", "es", "fr", "ja", "de", "pt"])
    multi_iter = iter(multi_langs)
    en_count = 0

    en_styles = [
        "stop the music",
        "music off",
        "kill the queue",
        "shut it off",
        "stop playback and clear",
        "turn off the music",
        "silence please",
        "ok stop everything",
        "stop and clear my queue",
        "halt the music",
    ]

    for i in range(n):
        if en_count < en_target:
            user_msg = en_paraphrase(rng, en_styles[i % len(en_styles)], i)
            language = "en"
            en_count += 1
        else:
            language = next(multi_iter)
            user_msg = LANG_STOP[language][i % len(LANG_STOP[language])]

        expected = tool_call_expected(action, {"confirmed": True})
        yield build_record(
            encoder=encoder,
            task_type="tool_call",
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action],
            extra_md={"action_name": action, "plugin": plugin},
            rng=rng,
            memory_idx=i,
            language=language,
        )


def gen_skip_track(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    plugin = "plugin-music-player"
    action = "SKIP_TRACK"
    en_target = int(n * 0.70)
    multi_target = n - en_target
    multi_langs = _multilingual_distribution(multi_target, ["zh", "es", "fr", "ja", "de", "pt"])
    multi_iter = iter(multi_langs)
    en_count = 0

    en_styles = [
        "skip",
        "next track",
        "skip this song",
        "next",
        "next song please",
        "skip to the next one",
        "this one's mid, skip",
        "fast forward to the next track",
        "go to next",
        "ugh skip this",
    ]

    for i in range(n):
        if en_count < en_target:
            user_msg = en_paraphrase(rng, en_styles[i % len(en_styles)], i)
            language = "en"
            en_count += 1
        else:
            language = next(multi_iter)
            user_msg = LANG_SKIP[language][i % len(LANG_SKIP[language])]

        expected = tool_call_expected(action, {"confirmed": True})
        yield build_record(
            encoder=encoder,
            task_type="tool_call",
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action],
            extra_md={"action_name": action, "plugin": plugin},
            rng=rng,
            memory_idx=i,
            language=language,
        )


def gen_show_queue(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    plugin = "plugin-music-player"
    action = "SHOW_QUEUE"
    en_target = int(n * 0.70)
    multi_target = n - en_target
    multi_langs = _multilingual_distribution(multi_target, ["zh", "es", "fr", "ja", "de", "pt"])
    multi_iter = iter(multi_langs)
    en_count = 0

    en_styles = [
        "show queue",
        "what's in the queue",
        "list the queue",
        "show me what's queued",
        "what's coming up",
        "queue list please",
        "see the music queue",
        "current queue?",
        "show me the playlist queue",
        "what's lined up next",
    ]

    for i in range(n):
        if en_count < en_target:
            user_msg = en_paraphrase(rng, en_styles[i % len(en_styles)], i)
            language = "en"
            en_count += 1
        else:
            language = next(multi_iter)
            user_msg = LANG_SHOW_QUEUE[language][i % len(LANG_SHOW_QUEUE[language])]

        expected = tool_call_expected(action, {})
        yield build_record(
            encoder=encoder,
            task_type="tool_call",
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action],
            extra_md={"action_name": action, "plugin": plugin},
            rng=rng,
            memory_idx=i,
            language=language,
        )


# ─── plugin-music-library: playlists & library ────────────────────────

def gen_list_playlists(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    plugin = "plugin-music-library"
    action = "LIST_PLAYLISTS"
    en_target = int(n * 0.70)
    multi_target = n - en_target
    multi_langs = _multilingual_distribution(multi_target, ["zh", "es", "fr", "ja", "de", "pt"])
    multi_iter = iter(multi_langs)
    en_count = 0

    en_styles = [
        "show my playlists",
        "list playlists",
        "what playlists do I have",
        "my playlists?",
        "view all my saved playlists",
        "show me all my playlists",
        "list all the playlists I've saved",
        "playlist list please",
        "give me a rundown of my playlists",
        "what music collections do I have saved",
    ]

    for i in range(n):
        if en_count < en_target:
            user_msg = en_paraphrase(rng, en_styles[i % len(en_styles)], i)
            language = "en"
            en_count += 1
        else:
            language = next(multi_iter)
            user_msg = LANG_PLAYLIST_LIST[language][i % len(LANG_PLAYLIST_LIST[language])]

        expected = tool_call_expected(action, {})
        yield build_record(
            encoder=encoder,
            task_type="tool_call",
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action],
            extra_md={"action_name": action, "plugin": plugin},
            rng=rng,
            memory_idx=i,
            language=language,
        )


def gen_load_playlist(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    plugin = "plugin-music-library"
    action = "LOAD_PLAYLIST"
    null_quota = max(1, int(n * 0.10))
    null_idxs = set(rng.sample(range(n), null_quota))
    en_target = int(n * 0.70)
    multi_target = n - en_target - null_quota
    multi_langs = _multilingual_distribution(multi_target, ["zh", "es", "fr", "ja", "de", "pt"])
    multi_iter = iter(multi_langs)
    en_count = 0

    en_styles = [
        "load my {p} playlist",
        "play my {p} playlist",
        "queue up the {p} list",
        "restore my {p} playlist",
        "throw on my {p} playlist",
        "load up {p}",
        "fire up the {p} list",
        "play the {p} mix I saved",
    ]

    for i in range(n):
        if i in null_idxs:
            yield _subtle_null_record(encoder, rng, i, action, plugin)
            continue
        playlist = PLAYLIST_NAMES[i % len(PLAYLIST_NAMES)]
        if en_count < en_target:
            tmpl = en_styles[i % len(en_styles)]
            user_msg = en_paraphrase(rng, tmpl.format(p=playlist), i)
            language = "en"
            en_count += 1
        else:
            language = next(multi_iter)
            tmpl = LANG_PLAYLIST_LOAD[language][i % len(LANG_PLAYLIST_LOAD[language])]
            user_msg = tmpl.format(p=playlist)

        expected = tool_call_expected(action, {"confirmed": True})
        yield build_record(
            encoder=encoder,
            task_type="tool_call",
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action],
            extra_md={"action_name": action, "plugin": plugin, "playlist": playlist},
            rng=rng,
            memory_idx=i,
            language=language,
        )


def gen_save_playlist(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    plugin = "plugin-music-library"
    action = "SAVE_PLAYLIST"
    null_quota = max(1, int(n * 0.10))
    null_idxs = set(rng.sample(range(n), null_quota))
    en_target = int(n * 0.70)
    multi_target = n - en_target - null_quota
    multi_langs = _multilingual_distribution(multi_target, ["zh", "es", "fr", "ja", "de", "pt"])
    multi_iter = iter(multi_langs)
    en_count = 0

    en_styles = [
        "save the current queue as a playlist called {p}",
        "save this as my {p} playlist",
        "make this queue into the {p} playlist",
        "store this set as {p}",
        "create a new playlist {p} from the current queue",
        "save my queue, name it {p}",
        "save current queue as {p}",
        "this queue rocks — save as {p}",
    ]

    for i in range(n):
        if i in null_idxs:
            yield _subtle_null_record(encoder, rng, i, action, plugin)
            continue
        playlist = PLAYLIST_NAMES[i % len(PLAYLIST_NAMES)]
        if en_count < en_target:
            tmpl = en_styles[i % len(en_styles)]
            user_msg = en_paraphrase(rng, tmpl.format(p=playlist), i)
            language = "en"
            en_count += 1
        else:
            language = next(multi_iter)
            tmpl = LANG_SAVE_PLAYLIST[language][i % len(LANG_SAVE_PLAYLIST[language])]
            user_msg = tmpl.format(p=playlist)

        expected = tool_call_expected(action, {"confirmed": True})
        yield build_record(
            encoder=encoder,
            task_type="tool_call",
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action],
            extra_md={"action_name": action, "plugin": plugin, "playlist": playlist},
            rng=rng,
            memory_idx=i,
            language=language,
        )


def gen_delete_playlist(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    plugin = "plugin-music-library"
    action = "DELETE_PLAYLIST"
    null_quota = max(1, int(n * 0.07))
    null_idxs = set(rng.sample(range(n), null_quota))
    en_target = int(n * 0.70)
    multi_target = n - en_target - null_quota
    multi_langs = _multilingual_distribution(multi_target, ["zh", "es", "fr", "ja", "de", "pt"])
    multi_iter = iter(multi_langs)
    en_count = 0

    en_styles = [
        "delete the {p} playlist",
        "remove playlist \"{p}\"",
        "drop my {p} playlist",
        "trash the {p} list",
        "delete saved playlist {p}",
        "get rid of the {p} playlist",
        "no longer need the {p} playlist — delete it",
        "purge my {p} playlist",
    ]

    for i in range(n):
        if i in null_idxs:
            yield _subtle_null_record(encoder, rng, i, action, plugin)
            continue
        playlist = PLAYLIST_NAMES[i % len(PLAYLIST_NAMES)]
        if en_count < en_target:
            tmpl = en_styles[i % len(en_styles)]
            user_msg = en_paraphrase(rng, tmpl.format(p=playlist), i)
            language = "en"
            en_count += 1
        else:
            language = next(multi_iter)
            tmpl = LANG_PLAYLIST_DELETE[language][i % len(LANG_PLAYLIST_DELETE[language])]
            user_msg = tmpl.format(p=playlist)

        expected = tool_call_expected(action, {"confirmed": True})
        yield build_record(
            encoder=encoder,
            task_type="tool_call",
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action],
            extra_md={"action_name": action, "plugin": plugin, "playlist": playlist},
            rng=rng,
            memory_idx=i,
            language=language,
        )


def gen_add_to_playlist(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    plugin = "plugin-music-library"
    action = "ADD_TO_PLAYLIST"
    null_quota = max(1, int(n * 0.07))
    null_idxs = set(rng.sample(range(n), null_quota))
    en_target = int(n * 0.70)
    multi_target = n - en_target - null_quota
    multi_langs = _multilingual_distribution(multi_target, ["zh", "es", "fr", "ja", "de", "pt"])
    multi_iter = iter(multi_langs)
    en_count = 0

    en_styles = [
        "add {title} to my {p} playlist",
        "stick {title} in {p}",
        "save {title} to {p}",
        "{artist} - {title} → my {p} playlist",
        "throw {title} on the {p} list",
        "put {title} into my {p} playlist",
        "tack {title} onto {p}",
        "add this song {title} to {p} please",
    ]

    for i in range(n):
        if i in null_idxs:
            yield _subtle_null_record(encoder, rng, i, action, plugin)
            continue
        title, artist, genre = _en_track_query(i)
        playlist = PLAYLIST_NAMES[i % len(PLAYLIST_NAMES)]
        if en_count < en_target:
            tmpl = en_styles[i % len(en_styles)]
            user_msg = en_paraphrase(rng, tmpl.format(title=title, artist=artist, p=playlist), i)
            language = "en"
            en_count += 1
        else:
            language = next(multi_iter)
            tmpl = LANG_PLAYLIST_ADD[language][i % len(LANG_PLAYLIST_ADD[language])]
            user_msg = tmpl.format(q=f"{title} - {artist}", p=playlist)

        expected = tool_call_expected(action, {"confirmed": True})
        yield build_record(
            encoder=encoder,
            task_type="tool_call",
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action],
            extra_md={
                "action_name": action,
                "plugin": plugin,
                "playlist": playlist,
                "genre": genre,
            },
            rng=rng,
            memory_idx=i,
            language=language,
        )


def gen_search_youtube(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    plugin = "plugin-music-library"
    action = "SEARCH_YOUTUBE"
    en_target = int(n * 0.70)
    multi_target = n - en_target
    multi_langs = _multilingual_distribution(multi_target, ["zh", "es", "fr", "ja", "de", "pt"])
    multi_iter = iter(multi_langs)
    en_count = 0

    en_styles = [
        "find the YouTube link for {title} by {artist}",
        "search YouTube for {title}",
        "get me the YouTube URL for {title}",
        "YouTube search: {artist} - {title}",
        "look up {title} on YouTube",
        "lookup YouTube for {title}",
        "what's the YouTube link to {title}",
        "find {title} on YouTube",
    ]

    for i in range(n):
        title, artist, genre = _en_track_query(i)
        if en_count < en_target:
            tmpl = en_styles[i % len(en_styles)]
            user_msg = en_paraphrase(rng, tmpl.format(title=title, artist=artist), i)
            language = "en"
            en_count += 1
        else:
            language = next(multi_iter)
            tmpl = LANG_SEARCH_YT[language][i % len(LANG_SEARCH_YT[language])]
            user_msg = tmpl.format(q=f"{title} - {artist}")

        expected = tool_call_expected(action, {})
        yield build_record(
            encoder=encoder,
            task_type="tool_call",
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action],
            extra_md={"action_name": action, "plugin": plugin, "genre": genre},
            rng=rng,
            memory_idx=i,
            language=language,
        )


def gen_download_music(encoder: ExpectedResponseEncoder, rng: random.Random, n: int) -> Iterable[dict]:
    plugin = "plugin-music-library"
    action = "DOWNLOAD_MUSIC"
    null_quota = max(1, int(n * 0.10))
    null_idxs = set(rng.sample(range(n), null_quota))
    en_target = int(n * 0.70)
    multi_target = n - en_target - null_quota
    multi_langs = _multilingual_distribution(multi_target, ["zh", "es", "fr", "ja", "de", "pt"])
    multi_iter = iter(multi_langs)
    en_count = 0

    en_styles = [
        "download {title} by {artist} to my library",
        "save {title} offline",
        "download {artist} - {title}",
        "grab {title} for offline listening",
        "fetch {title} into my library, don't play it",
        "save {title} but don't play",
        "add {title} to the local library",
        "download {title} please",
    ]

    for i in range(n):
        if i in null_idxs:
            yield _subtle_null_record(encoder, rng, i, action, plugin)
            continue
        title, artist, genre = _en_track_query(i)
        if en_count < en_target:
            tmpl = en_styles[i % len(en_styles)]
            user_msg = en_paraphrase(rng, tmpl.format(title=title, artist=artist), i)
            language = "en"
            en_count += 1
        else:
            language = next(multi_iter)
            tmpl = LANG_DOWNLOAD[language][i % len(LANG_DOWNLOAD[language])]
            user_msg = tmpl.format(q=f"{title} - {artist}")

        expected = tool_call_expected(action, {"confirmed": True})
        yield build_record(
            encoder=encoder,
            task_type="tool_call",
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action],
            extra_md={"action_name": action, "plugin": plugin, "genre": genre},
            rng=rng,
            memory_idx=i,
            language=language,
        )


# ───────────────────────────── driver ───────────────────────────────────

GENERATORS = [
    ("ADD_TO_PLAYLIST", gen_add_to_playlist),
    ("DELETE_PLAYLIST", gen_delete_playlist),
    ("DOWNLOAD_MUSIC", gen_download_music),
    ("LIST_PLAYLISTS", gen_list_playlists),
    ("LOAD_PLAYLIST", gen_load_playlist),
    ("PLAY_MUSIC_QUERY", gen_play_music_query),
    ("SAVE_PLAYLIST", gen_save_playlist),
    ("SEARCH_YOUTUBE", gen_search_youtube),
    ("PAUSE_MUSIC", gen_pause_music),
    ("PLAY_AUDIO", gen_play_audio),
    ("QUEUE_MUSIC", gen_queue_music),
    ("RESUME_MUSIC", gen_resume_music),
    ("SHOW_QUEUE", gen_show_queue),
    ("SKIP_TRACK", gen_skip_track),
    ("STOP_MUSIC", gen_stop_music),
]


def write_jsonl(records: Iterable[dict], path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")))
            f.write("\n")
            n += 1
    return n


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--per-action", type=int, default=100,
                        help="Records to generate per action (default 100).")
    parser.add_argument("--seed", type=int, default=0xB0BCAFE)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    encoder = JsonExpectedResponseEncoder()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    records: list[dict] = []
    counts: dict[str, int] = {}
    for name, gen in GENERATORS:
        # Each generator gets its own seeded RNG so they don't drift past
        # one another when --per-action changes.
        sub_rng = random.Random(rng.randrange(1 << 31))
        n = 0
        for rec in gen(encoder, sub_rng, args.per_action):
            records.append(rec)
            n += 1
        counts[name] = n
        log.info("[%s] %d records", name, n)

    total = write_jsonl(records, OUT_FILE)
    log.info("wrote %d records → %s", total, OUT_FILE)
    log.info("per-action counts: %s", counts)

    encoder.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
