"""Rule-based synthesis of system / computer-use / github action examples.

Produces ~1,100 canonical TOON tool_call records covering 11 actions across
3 plugins:

  - plugin-shell:        CLEAR_SHELL_HISTORY                                  (1)
  - plugin-computeruse:  BROWSER_ACTION, FILE_ACTION, MANAGE_WINDOW,
                         TERMINAL_ACTION, USE_COMPUTER                         (5)
  - plugin-github:       ASSIGN_ISSUE, CREATE_ISSUE, GITHUB_NOTIFICATION_TRIAGE,
                         LIST_PRS, REVIEW_PR                                   (5)

Output: data/synthesized/action_examples/system.jsonl

Each record is a flat eliza ElizaRecord with:
  - currentMessage    user prompt (varied phrasing, persona, language, style)
  - expectedResponse  TOON-encoded {tool_calls:[{name, arguments}]}
  - availableActions  [TASK_CALL, REPLY, <action_name>]
  - metadata.task_type = "tool_call"  (or "reply" for subtle-null cases)

Polymorphic *_ACTION / USE_COMPUTER actions are sampled across each
documented sub-operation (BROWSER_ACTION click/type/navigate/...,
FILE_ACTION read/write/list/edit/..., etc.) so the trainer sees the full
shape of the action surface.

Run:
    .venv/bin/python scripts/synthesize_system_actions.py
"""

from __future__ import annotations

import json
import logging
import random
import sys
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from lib.eliza_record import (  # noqa: E402
    ACTION_IGNORE,
    ACTION_REPLY,
    ACTION_TASK_CALL,
    build,
    stable_id,
)
from lib.expected_response import ExpectedResponseEncoder, JsonExpectedResponseEncoder  # noqa: E402

OUT_DIR = ROOT / "data" / "synthesized" / "action_examples"
OUT_PATH = OUT_DIR / "system.jsonl"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("synth-system")


# ───────────────────────────── identity / room pools ───────────────────

AGENT_NAMES = [
    "Iris", "Kai", "Ava", "Nova", "Echo", "Sage", "Atlas", "Lyra",
    "Pico", "Lumi", "Rune", "Vega", "Sol", "Orion", "Mira", "Tess",
    "eliza", "Eliza", "Hex", "Cipher", "Quill", "Cobalt",
]

# 25+ varied personas (developer-ish surface for sysadmin/devops actions)
PERSONAS = [
    {"name": "alice", "role": "backend dev"},
    {"name": "bob", "role": "sre"},
    {"name": "carlos", "role": "frontend dev"},
    {"name": "diana", "role": "platform engineer"},
    {"name": "ethan", "role": "devops"},
    {"name": "fatima", "role": "security engineer"},
    {"name": "george", "role": "data scientist"},
    {"name": "hina", "role": "ml engineer"},
    {"name": "ivan", "role": "infra lead"},
    {"name": "jin", "role": "fullstack"},
    {"name": "kira", "role": "qa engineer"},
    {"name": "leo", "role": "tech lead"},
    {"name": "mia", "role": "junior dev"},
    {"name": "noah", "role": "release manager"},
    {"name": "olivia", "role": "sysadmin"},
    {"name": "priya", "role": "engineering manager"},
    {"name": "quinn", "role": "staff engineer"},
    {"name": "raj", "role": "backend dev"},
    {"name": "sofia", "role": "designer"},
    {"name": "tomas", "role": "support engineer"},
    {"name": "uma", "role": "devrel"},
    {"name": "viktor", "role": "kernel hacker"},
    {"name": "wen", "role": "security analyst"},
    {"name": "xander", "role": "sre"},
    {"name": "yara", "role": "researcher"},
    {"name": "zed", "role": "freelance dev"},
]

ROOM_KINDS = [
    "dm", "channel:general", "channel:engineering", "channel:platform",
    "channel:devops", "channel:security", "channel:infra", "channel:incidents",
    "channel:release", "channel:on-call",
]

CHANNELS = ["dm", "public"]


def random_room_meta(rng: random.Random) -> tuple[str, str]:
    kind = rng.choice(ROOM_KINDS)
    if kind == "dm":
        return "dm", "dm"
    return kind, "public"


# ───────────────────────────── style helpers ──────────────────────────

# 10+ distinct styles. Each takes a base intent and rewrites it.
def style_direct(s: str, rng: random.Random) -> str:
    return s

def style_formal(s: str, rng: random.Random) -> str:
    return f"Could you please {s.rstrip('.?!')}? Thank you."

def style_casual(s: str, rng: random.Random) -> str:
    suffixes = [" pls", " thx", " 🙏", "", " when u get a sec"]
    return f"yo, {s}{rng.choice(suffixes)}"

def style_expert_shorthand(s: str, rng: random.Random) -> str:
    return s.lower().replace("please ", "").replace("could you ", "")

def style_naive_underspecified(s: str, rng: random.Random) -> str:
    return s.split(" ")[0] + "..." if " " in s else s + "..."

def style_voice_asr(s: str, rng: random.Random) -> str:
    # ASR-style: lowercase, missing punctuation, occasional filler
    fillers = ["um ", "uh ", "okay ", "so ", ""]
    return rng.choice(fillers) + s.lower().rstrip(".?!")

def style_distracted(s: str, rng: random.Random) -> str:
    asides = [
        " — sorry, kid is yelling",
        " (after I finish my coffee)",
        ", oh wait, my dog needs out",
        " — actually one sec, brb",
        " btw the wifi is acting weird",
    ]
    return s + rng.choice(asides)

def style_broken_english(s: str, rng: random.Random) -> str:
    # Simplified, dropped articles
    repl = s.replace(" the ", " ").replace(" a ", " ").replace("please", "plz")
    return repl.lower()

def style_self_correcting(s: str, rng: random.Random) -> str:
    return f"wait scratch that — {s}"

def style_emphatic(s: str, rng: random.Random) -> str:
    return f"{s.upper().rstrip('.?!')}!!"

STYLES = [
    style_direct,
    style_formal,
    style_casual,
    style_expert_shorthand,
    style_naive_underspecified,
    style_voice_asr,
    style_distracted,
    style_broken_english,
    style_self_correcting,
    style_emphatic,
]


# ───────────────────────────── language packs ──────────────────────────

# Multilingual variants per action. Used for ~30% of records.
# Each entry: (lang_code, intent_template, optional persona override)
MULTILINGUAL_PHRASES = {
    "zh": [
        "请帮我 {intent}",
        "你能 {intent} 吗",
        "麻烦 {intent}",
        "现在就 {intent}",
        "帮个忙 {intent}",
    ],
    "es": [
        "por favor {intent}",
        "¿puedes {intent}?",
        "necesito que {intent}",
        "ayúdame a {intent}",
        "vamos a {intent}",
    ],
    "fr": [
        "peux-tu {intent} s'il te plaît",
        "j'ai besoin de {intent}",
        "merci de {intent}",
        "aide-moi à {intent}",
        "il faut {intent}",
    ],
    "ja": [
        "{intent} してください",
        "{intent} お願いします",
        "{intent} できますか",
        "至急 {intent}",
        "{intent} やって",
    ],
    "de": [
        "bitte {intent}",
        "kannst du {intent}",
        "ich brauche {intent}",
        "mach bitte {intent}",
        "wir müssen {intent}",
    ],
    "pt": [
        "por favor {intent}",
        "você pode {intent}",
        "preciso que {intent}",
        "me ajude a {intent}",
        "vamos {intent}",
    ],
}

# Translated intent fragments per action. Each multi-lingual entry maps to
# a localised "intent" verb-phrase, since we want the user prompt to be
# coherent in-language even if the action name stays English.
INTENT_TRANSLATIONS = {
    "BROWSER_ACTION_open": {
        "zh": "打开浏览器", "es": "abrir el navegador", "fr": "ouvrir le navigateur",
        "ja": "ブラウザを開く", "de": "den Browser öffnen", "pt": "abrir o navegador",
    },
    "BROWSER_ACTION_navigate": {
        "zh": "导航到这个网址", "es": "navegar a esta URL", "fr": "naviguer vers cette URL",
        "ja": "このURLに移動", "de": "zu dieser URL navigieren", "pt": "navegar para esta URL",
    },
    "BROWSER_ACTION_click": {
        "zh": "点击这个按钮", "es": "hacer clic en el botón", "fr": "cliquer sur le bouton",
        "ja": "このボタンをクリック", "de": "auf den Button klicken", "pt": "clicar no botão",
    },
    "BROWSER_ACTION_screenshot": {
        "zh": "截屏", "es": "tomar captura de pantalla", "fr": "prendre une capture",
        "ja": "スクリーンショットを撮る", "de": "Screenshot machen", "pt": "tirar screenshot",
    },
    "BROWSER_ACTION_type": {
        "zh": "在表单里输入文字", "es": "escribir texto en el formulario",
        "fr": "saisir du texte dans le formulaire", "ja": "フォームに入力",
        "de": "Text in das Formular eingeben", "pt": "digitar texto no formulário",
    },
    "FILE_ACTION_read": {
        "zh": "读取这个文件", "es": "leer este archivo", "fr": "lire ce fichier",
        "ja": "このファイルを読む", "de": "diese Datei lesen", "pt": "ler este arquivo",
    },
    "FILE_ACTION_write": {
        "zh": "写入这个文件", "es": "escribir en este archivo", "fr": "écrire dans ce fichier",
        "ja": "このファイルに書き込む", "de": "in diese Datei schreiben", "pt": "gravar neste arquivo",
    },
    "FILE_ACTION_list": {
        "zh": "列出目录", "es": "listar el directorio", "fr": "lister le répertoire",
        "ja": "ディレクトリを一覧", "de": "Verzeichnis auflisten", "pt": "listar o diretório",
    },
    "FILE_ACTION_delete": {
        "zh": "删除这个文件", "es": "borrar este archivo", "fr": "supprimer ce fichier",
        "ja": "このファイルを削除", "de": "diese Datei löschen", "pt": "apagar este arquivo",
    },
    "FILE_ACTION_edit": {
        "zh": "编辑这个文件", "es": "editar este archivo", "fr": "éditer ce fichier",
        "ja": "このファイルを編集", "de": "diese Datei bearbeiten", "pt": "editar este arquivo",
    },
    "MANAGE_WINDOW_list": {
        "zh": "列出所有窗口", "es": "listar todas las ventanas",
        "fr": "lister toutes les fenêtres", "ja": "すべてのウィンドウを一覧",
        "de": "alle Fenster auflisten", "pt": "listar todas as janelas",
    },
    "MANAGE_WINDOW_focus": {
        "zh": "切换焦点到这个窗口", "es": "enfocar la ventana",
        "fr": "mettre la fenêtre au premier plan", "ja": "ウィンドウをフォーカス",
        "de": "Fenster fokussieren", "pt": "focar a janela",
    },
    "MANAGE_WINDOW_arrange": {
        "zh": "重新排列窗口", "es": "organizar las ventanas",
        "fr": "ranger les fenêtres", "ja": "ウィンドウを整列",
        "de": "Fenster anordnen", "pt": "arranjar as janelas",
    },
    "MANAGE_WINDOW_close": {
        "zh": "关闭这个窗口", "es": "cerrar la ventana",
        "fr": "fermer la fenêtre", "ja": "ウィンドウを閉じる",
        "de": "Fenster schließen", "pt": "fechar a janela",
    },
    "TERMINAL_ACTION_execute": {
        "zh": "执行这个命令", "es": "ejecutar este comando",
        "fr": "exécuter cette commande", "ja": "このコマンドを実行",
        "de": "diesen Befehl ausführen", "pt": "executar este comando",
    },
    "TERMINAL_ACTION_connect": {
        "zh": "连接到终端", "es": "conectar al terminal",
        "fr": "se connecter au terminal", "ja": "ターミナルに接続",
        "de": "mit dem Terminal verbinden", "pt": "conectar ao terminal",
    },
    "TERMINAL_ACTION_clear": {
        "zh": "清屏", "es": "limpiar la terminal",
        "fr": "nettoyer le terminal", "ja": "ターミナルをクリア",
        "de": "Terminal leeren", "pt": "limpar o terminal",
    },
    "USE_COMPUTER_screenshot": {
        "zh": "截屏看一下当前屏幕", "es": "captura de pantalla",
        "fr": "prendre une capture d'écran", "ja": "画面のスクリーンショット",
        "de": "Screenshot vom Bildschirm", "pt": "captura de tela",
    },
    "USE_COMPUTER_click": {
        "zh": "点击屏幕这个位置", "es": "hacer clic en este punto",
        "fr": "cliquer à cet endroit", "ja": "この位置をクリック",
        "de": "an dieser Stelle klicken", "pt": "clicar neste ponto",
    },
    "USE_COMPUTER_type": {
        "zh": "输入这段文字", "es": "escribir este texto",
        "fr": "taper ce texte", "ja": "このテキストを入力",
        "de": "diesen Text eingeben", "pt": "digitar este texto",
    },
    "USE_COMPUTER_key_combo": {
        "zh": "按下这个组合键", "es": "presionar la combinación de teclas",
        "fr": "appuyer sur la combinaison", "ja": "キーコンボを押す",
        "de": "Tastenkombination drücken", "pt": "pressionar a combinação",
    },
    "CLEAR_SHELL_HISTORY": {
        "zh": "清除 shell 历史记录", "es": "borrar el historial del shell",
        "fr": "effacer l'historique du shell", "ja": "シェル履歴をクリア",
        "de": "Shell-Verlauf löschen", "pt": "limpar histórico do shell",
    },
    "ASSIGN_ISSUE": {
        "zh": "把这个 issue 分配给", "es": "asignar el issue a",
        "fr": "assigner le ticket à", "ja": "このイシューを割り当てる",
        "de": "Issue zuweisen an", "pt": "atribuir o issue a",
    },
    "CREATE_ISSUE": {
        "zh": "创建一个新 issue", "es": "abrir un nuevo issue",
        "fr": "créer un nouveau ticket", "ja": "新しいイシューを作成",
        "de": "neues Issue erstellen", "pt": "criar novo issue",
    },
    "GITHUB_NOTIFICATION_TRIAGE": {
        "zh": "整理我的 GitHub 通知", "es": "triage de mis notificaciones",
        "fr": "trier mes notifications", "ja": "通知をトリアージ",
        "de": "meine Benachrichtigungen sichten", "pt": "triar minhas notificações",
    },
    "LIST_PRS": {
        "zh": "列出所有 PR", "es": "listar los pull requests",
        "fr": "lister les pull requests", "ja": "PRを一覧表示",
        "de": "Pull Requests auflisten", "pt": "listar os PRs",
    },
    "REVIEW_PR": {
        "zh": "审查这个 PR", "es": "revisar el PR",
        "fr": "réviser cette PR", "ja": "このPRをレビュー",
        "de": "diesen PR überprüfen", "pt": "revisar este PR",
    },
    # ── Generic fallbacks per action (when sub_op-specific key missing) ──
    "BROWSER_ACTION": {
        "zh": "在浏览器里执行这个操作", "es": "hacer esta acción en el navegador",
        "fr": "effectuer cette action dans le navigateur", "ja": "ブラウザで操作する",
        "de": "diese Browser-Aktion ausführen", "pt": "fazer esta ação no navegador",
    },
    "FILE_ACTION": {
        "zh": "做这个文件操作", "es": "hacer esta operación de archivo",
        "fr": "faire cette opération de fichier", "ja": "このファイル操作を実行",
        "de": "diesen Dateivorgang ausführen", "pt": "fazer esta operação de arquivo",
    },
    "MANAGE_WINDOW": {
        "zh": "管理这个窗口", "es": "gestionar la ventana",
        "fr": "gérer la fenêtre", "ja": "ウィンドウを管理",
        "de": "Fenster verwalten", "pt": "gerenciar a janela",
    },
    "TERMINAL_ACTION": {
        "zh": "执行这个终端操作", "es": "ejecutar esta acción de terminal",
        "fr": "exécuter cette action de terminal", "ja": "ターミナル操作を実行",
        "de": "diesen Terminal-Vorgang ausführen", "pt": "executar esta ação no terminal",
    },
    "USE_COMPUTER": {
        "zh": "在屏幕上做这个操作", "es": "hacer esta acción en la pantalla",
        "fr": "faire cette action à l'écran", "ja": "画面でこの操作を実行",
        "de": "diese Aktion am Bildschirm ausführen", "pt": "fazer esta ação na tela",
    },
}


def maybe_translate(intent_key: str, base_msg: str, rng: random.Random,
                    force_lang: str | None = None) -> tuple[str, str | None]:
    """Maybe rewrite as a multilingual variant. Returns (msg, lang_or_None)."""
    if force_lang is None:
        return base_msg, None
    lang = force_lang
    intent = INTENT_TRANSLATIONS.get(intent_key, {}).get(lang)
    if not intent:
        return base_msg, None
    template = rng.choice(MULTILINGUAL_PHRASES[lang])
    return template.format(intent=intent), lang


# ───────────────────────────── memory entries ──────────────────────────

# Optional prior turns. Some empty, some short, some longer. Provides
# realistic memoryEntries variation.
def random_memory(rng: random.Random, persona: dict, agent: str,
                  channel: str) -> list[dict[str, Any]]:
    n = rng.choices([0, 1, 2, 3, 5], weights=[35, 25, 20, 12, 8])[0]
    if n == 0:
        return []
    pool_user = [
        "hey, you around?",
        "need help with something quick",
        "working on the deploy",
        "the build is broken on main",
        "can you double-check this",
        f"looking at the {rng.choice(['logs', 'metrics', 'CI run', 'PR'])}",
        "got a sec?",
        "earlier today I was working on auth",
        "so I rebased onto develop",
        "the test suite is flaky again",
    ]
    pool_agent = [
        "yes, what's up?",
        "sure — I'm here.",
        "on it.",
        "go ahead.",
        "reading now.",
        "got it.",
        "hmm, that sounds annoying.",
        "want me to take a look?",
        "happy to help.",
        "sounds good.",
    ]
    out: list[dict[str, Any]] = []
    for i in range(n):
        if i % 2 == 0:
            out.append({
                "role": "user", "speaker": persona["name"],
                "content": rng.choice(pool_user), "channel": channel,
            })
        else:
            out.append({
                "role": "assistant", "speaker": agent,
                "content": rng.choice(pool_agent), "channel": channel,
            })
    return out


# ───────────────────────────── action scenario pools ───────────────────

# Each scenario carries: a sub-operation, a phrasing template (with named
# slots), and the resulting `arguments` dict for the tool call. Optional
# params are deliberately omitted when the user didn't mention them.

# ─── BROWSER_ACTION ────────────────────────────────────────────────────
BROWSER_SCENARIOS = [
    # open
    {"op": "open", "msg": "open a browser and go to https://github.com",
     "args": {"action": "open", "url": "https://github.com"}},
    {"op": "open", "msg": "launch a chromium session please",
     "args": {"action": "open"}},
    {"op": "open", "msg": "spin up the browser and load https://news.ycombinator.com",
     "args": {"action": "open", "url": "https://news.ycombinator.com"}},
    {"op": "open", "msg": "fire up the browser pointing at the staging dashboard https://staging.example.com",
     "args": {"action": "open", "url": "https://staging.example.com"}},
    # navigate
    {"op": "navigate", "msg": "navigate to https://docs.elizaos.ai",
     "args": {"action": "navigate", "url": "https://docs.elizaos.ai"}},
    {"op": "navigate", "msg": "go to https://twitter.com/elonmusk in the browser",
     "args": {"action": "navigate", "url": "https://twitter.com/elonmusk"}},
    {"op": "navigate", "msg": "open https://stackoverflow.com/questions/12345",
     "args": {"action": "navigate", "url": "https://stackoverflow.com/questions/12345"}},
    # click (selector)
    {"op": "click", "msg": "click the button with selector #submit-btn",
     "args": {"action": "click", "selector": "#submit-btn"}},
    {"op": "click", "msg": "click the .login-link",
     "args": {"action": "click", "selector": ".login-link"}},
    {"op": "click", "msg": "click button[data-testid='confirm']",
     "args": {"action": "click", "selector": "button[data-testid='confirm']"}},
    # click (coords)
    {"op": "click", "msg": "click at coordinates 320, 480",
     "args": {"action": "click", "coordinate": [320, 480]}},
    {"op": "click", "msg": "click at 1024,768 in the viewport",
     "args": {"action": "click", "coordinate": [1024, 768]}},
    # type
    {"op": "type", "msg": "type 'hello world' into #search",
     "args": {"action": "type", "selector": "#search", "text": "hello world"}},
    {"op": "type", "msg": "type my email shaw@elizaos.ai into the email input",
     "args": {"action": "type", "selector": "input[type=email]", "text": "shaw@elizaos.ai"}},
    {"op": "type", "msg": "type 'elizaos' into the search box",
     "args": {"action": "type", "selector": "input[name=q]", "text": "elizaos"}},
    # scroll
    {"op": "scroll", "msg": "scroll down on the page",
     "args": {"action": "scroll", "direction": "down"}},
    {"op": "scroll", "msg": "scroll up 500 pixels",
     "args": {"action": "scroll", "direction": "up", "amount": 500}},
    {"op": "scroll", "msg": "scroll down by 300px",
     "args": {"action": "scroll", "direction": "down", "amount": 300}},
    # screenshot
    {"op": "screenshot", "msg": "take a screenshot of the page",
     "args": {"action": "screenshot"}},
    {"op": "screenshot", "msg": "snap a screenshot of the browser viewport",
     "args": {"action": "screenshot"}},
    # dom
    {"op": "dom", "msg": "grab the page DOM",
     "args": {"action": "dom"}},
    {"op": "get_dom", "msg": "get me the html of the current page",
     "args": {"action": "get_dom"}},
    # clickables
    {"op": "clickables", "msg": "list the interactive elements on this page",
     "args": {"action": "clickables"}},
    {"op": "get_clickables", "msg": "show me the clickable items I can interact with",
     "args": {"action": "get_clickables"}},
    # execute
    {"op": "execute", "msg": "run this JS in the browser: document.title",
     "args": {"action": "execute", "code": "document.title"}},
    {"op": "execute", "msg": "execute window.scrollTo(0,0) in the page",
     "args": {"action": "execute", "code": "window.scrollTo(0,0)"}},
    # state
    {"op": "state", "msg": "what page is the browser on right now",
     "args": {"action": "state"}},
    {"op": "info", "msg": "is the browser open?",
     "args": {"action": "info"}},
    # wait
    {"op": "wait", "msg": "wait until #app-loaded shows up",
     "args": {"action": "wait", "selector": "#app-loaded"}},
    {"op": "wait", "msg": "wait for selector .results-container to appear",
     "args": {"action": "wait", "selector": ".results-container"}},
    # tabs
    {"op": "list_tabs", "msg": "list the open browser tabs",
     "args": {"action": "list_tabs"}},
    {"op": "open_tab", "msg": "open a new tab pointing at https://example.com",
     "args": {"action": "open_tab", "url": "https://example.com"}},
    {"op": "close_tab", "msg": "close tab tab-3",
     "args": {"action": "close_tab", "tabId": "tab-3"}},
    {"op": "switch_tab", "msg": "switch to tab tab-1",
     "args": {"action": "switch_tab", "tabId": "tab-1"}},
    # close
    {"op": "close", "msg": "close the browser",
     "args": {"action": "close"}},
]

# ─── FILE_ACTION ────────────────────────────────────────────────────
FILE_SCENARIOS = [
    # read
    {"op": "read", "msg": "read /etc/hosts for me",
     "args": {"action": "read", "path": "/etc/hosts"}},
    {"op": "read", "msg": "show me the contents of ~/.bashrc",
     "args": {"action": "read", "path": "~/.bashrc"}},
    {"op": "read", "msg": "open and read /var/log/syslog",
     "args": {"action": "read", "path": "/var/log/syslog"}},
    {"op": "read", "msg": "read the package.json in the project",
     "args": {"action": "read", "path": "package.json"}},
    {"op": "read", "msg": "what's in /tmp/output.txt",
     "args": {"action": "read", "path": "/tmp/output.txt"}},
    # write
    {"op": "write", "msg": "write 'hello world' to /tmp/note.txt",
     "args": {"action": "write", "path": "/tmp/note.txt", "content": "hello world"}},
    {"op": "write", "msg": "create /tmp/config.json with {\"debug\": true}",
     "args": {"action": "write", "path": "/tmp/config.json", "content": "{\"debug\": true}"}},
    {"op": "write", "msg": "save 'TODO: refactor' to ~/notes/todo.md",
     "args": {"action": "write", "path": "~/notes/todo.md", "content": "TODO: refactor"}},
    # append
    {"op": "append", "msg": "append 'export PATH=$PATH:/opt/bin' to ~/.bashrc",
     "args": {"action": "append", "path": "~/.bashrc",
              "content": "export PATH=$PATH:/opt/bin"}},
    {"op": "append", "msg": "add a new line 'shaw' to /tmp/users.txt",
     "args": {"action": "append", "path": "/tmp/users.txt", "content": "shaw"}},
    # edit
    {"op": "edit", "msg": "in /etc/nginx/nginx.conf replace 'worker_processes 1' with 'worker_processes auto'",
     "args": {"action": "edit", "path": "/etc/nginx/nginx.conf",
              "oldText": "worker_processes 1", "newText": "worker_processes auto"}},
    {"op": "edit", "msg": "edit ~/.zshrc — change 'export EDITOR=vi' to 'export EDITOR=nvim'",
     "args": {"action": "edit", "path": "~/.zshrc",
              "oldText": "export EDITOR=vi", "newText": "export EDITOR=nvim"}},
    {"op": "edit", "msg": "in package.json swap 'version: 1.0.0' with 'version: 1.0.1'",
     "args": {"action": "edit", "path": "package.json",
              "oldText": "version: 1.0.0", "newText": "version: 1.0.1"}},
    # delete
    {"op": "delete", "msg": "delete /tmp/old-cache.bin",
     "args": {"action": "delete", "path": "/tmp/old-cache.bin"}},
    {"op": "delete", "msg": "remove the file ~/Downloads/installer.dmg",
     "args": {"action": "delete", "path": "~/Downloads/installer.dmg"}},
    # exists
    {"op": "exists", "msg": "does /etc/passwd exist?",
     "args": {"action": "exists", "path": "/etc/passwd"}},
    {"op": "exists", "msg": "check if ~/.ssh/id_ed25519 is there",
     "args": {"action": "exists", "path": "~/.ssh/id_ed25519"}},
    # list
    {"op": "list", "msg": "list the files in /var/log",
     "args": {"action": "list", "path": "/var/log"}},
    {"op": "list", "msg": "what's in ~/projects/elizaos",
     "args": {"action": "list", "path": "~/projects/elizaos"}},
    {"op": "list", "msg": "show me the contents of /tmp",
     "args": {"action": "list", "path": "/tmp"}},
    # delete_directory
    {"op": "delete_directory", "msg": "wipe out the directory /tmp/build-cache",
     "args": {"action": "delete_directory", "path": "/tmp/build-cache"}},
    # download / upload / list_downloads
    {"op": "download", "msg": "download the file at https://example.com/data.csv",
     "args": {"action": "download", "path": "https://example.com/data.csv"}},
    {"op": "upload", "msg": "upload ~/reports/q4.pdf",
     "args": {"action": "upload", "path": "~/reports/q4.pdf"}},
    {"op": "list_downloads", "msg": "list my downloads",
     "args": {"action": "list_downloads"}},
]

# ─── MANAGE_WINDOW ────────────────────────────────────────────────────
WINDOW_SCENARIOS = [
    {"op": "list", "msg": "list all the windows on screen",
     "args": {"action": "list"}},
    {"op": "list", "msg": "what windows are visible right now",
     "args": {"action": "list"}},
    {"op": "focus", "msg": "focus window win-42",
     "args": {"action": "focus", "windowId": "win-42"}},
    {"op": "focus", "msg": "bring window 1024 to the front",
     "args": {"action": "focus", "windowId": "1024"}},
    {"op": "switch", "msg": "switch to the Terminal window",
     "args": {"action": "switch", "windowTitle": "Terminal"}},
    {"op": "switch", "msg": "switch over to Cursor",
     "args": {"action": "switch", "windowTitle": "Cursor"}},
    {"op": "switch", "msg": "go to the Slack window",
     "args": {"action": "switch", "windowTitle": "Slack"}},
    {"op": "arrange", "msg": "tile all the windows",
     "args": {"action": "arrange", "arrangement": "tile"}},
    {"op": "arrange", "msg": "cascade my windows",
     "args": {"action": "arrange", "arrangement": "cascade"}},
    {"op": "arrange", "msg": "arrange them vertically",
     "args": {"action": "arrange", "arrangement": "vertical"}},
    {"op": "arrange", "msg": "stack horizontally please",
     "args": {"action": "arrange", "arrangement": "horizontal"}},
    {"op": "move", "msg": "move window win-7 to 100,200",
     "args": {"action": "move", "windowId": "win-7", "x": 100, "y": 200}},
    {"op": "move", "msg": "drag the Chrome window to coordinates 0,0",
     "args": {"action": "move", "windowTitle": "Chrome", "x": 0, "y": 0}},
    {"op": "minimize", "msg": "minimize window win-3",
     "args": {"action": "minimize", "windowId": "win-3"}},
    {"op": "maximize", "msg": "maximize window win-9",
     "args": {"action": "maximize", "windowId": "win-9"}},
    {"op": "restore", "msg": "restore the minimized Slack window",
     "args": {"action": "restore", "windowTitle": "Slack"}},
    {"op": "close", "msg": "close window win-12",
     "args": {"action": "close", "windowId": "win-12"}},
]

# ─── TERMINAL_ACTION ────────────────────────────────────────────────────
TERMINAL_SCENARIOS = [
    {"op": "connect", "msg": "open a terminal session in /home/shaw/projects",
     "args": {"action": "connect", "cwd": "/home/shaw/projects"}},
    {"op": "connect", "msg": "spin up a shell in ~/work",
     "args": {"action": "connect", "cwd": "~/work"}},
    {"op": "execute", "msg": "run 'ls -la' in the terminal",
     "args": {"action": "execute", "command": "ls -la"}},
    {"op": "execute", "msg": "execute 'git status'",
     "args": {"action": "execute", "command": "git status"}},
    {"op": "execute", "msg": "run 'npm install' for me",
     "args": {"action": "execute", "command": "npm install"}},
    {"op": "execute", "msg": "kick off 'bun run build'",
     "args": {"action": "execute", "command": "bun run build"}},
    {"op": "execute", "msg": "run 'cargo test' in /home/shaw/rust-proj",
     "args": {"action": "execute", "command": "cargo test", "cwd": "/home/shaw/rust-proj"}},
    {"op": "execute", "msg": "execute 'docker ps -a'",
     "args": {"action": "execute", "command": "docker ps -a"}},
    {"op": "execute", "msg": "run 'kubectl get pods -A' with a 60s timeout",
     "args": {"action": "execute", "command": "kubectl get pods -A", "timeout": 60}},
    {"op": "execute", "msg": "run 'pytest tests/ -v' please",
     "args": {"action": "execute", "command": "pytest tests/ -v"}},
    {"op": "execute", "msg": "exec 'python -m venv .venv'",
     "args": {"action": "execute", "command": "python -m venv .venv"}},
    {"op": "execute_command", "msg": "fire 'tail -f /var/log/syslog'",
     "args": {"action": "execute_command", "command": "tail -f /var/log/syslog"}},
    {"op": "read", "msg": "read what's in the terminal session sess-001",
     "args": {"action": "read", "sessionId": "sess-001"}},
    {"op": "type", "msg": "type 'exit' into terminal session sess-2",
     "args": {"action": "type", "sessionId": "sess-2", "text": "exit"}},
    {"op": "type", "msg": "send 'q' to session sess-vim",
     "args": {"action": "type", "sessionId": "sess-vim", "text": "q"}},
    {"op": "clear", "msg": "clear the terminal",
     "args": {"action": "clear"}},
    {"op": "close", "msg": "close terminal session sess-001",
     "args": {"action": "close", "sessionId": "sess-001"}},
]

# ─── USE_COMPUTER ────────────────────────────────────────────────────
COMPUTER_SCENARIOS = [
    {"op": "screenshot", "msg": "take a screenshot of my screen",
     "args": {"action": "screenshot"}},
    {"op": "screenshot", "msg": "show me what's on screen right now",
     "args": {"action": "screenshot"}},
    {"op": "click", "msg": "click at 512, 384",
     "args": {"action": "click", "coordinate": [512, 384]}},
    {"op": "click", "msg": "left click 1200,800",
     "args": {"action": "click", "coordinate": [1200, 800]}},
    {"op": "click", "msg": "click at coordinates 250,640",
     "args": {"action": "click", "coordinate": [250, 640]}},
    {"op": "click_with_modifiers", "msg": "ctrl-click at 400,500",
     "args": {"action": "click_with_modifiers", "coordinate": [400, 500],
              "modifiers": ["ctrl"]}},
    {"op": "click_with_modifiers", "msg": "shift-click at 800,200",
     "args": {"action": "click_with_modifiers", "coordinate": [800, 200],
              "modifiers": ["shift"]}},
    {"op": "click_with_modifiers", "msg": "cmd+shift click 100,100",
     "args": {"action": "click_with_modifiers", "coordinate": [100, 100],
              "modifiers": ["cmd", "shift"]}},
    {"op": "double_click", "msg": "double click at 700,400",
     "args": {"action": "double_click", "coordinate": [700, 400]}},
    {"op": "double_click", "msg": "doubleclick 320,240",
     "args": {"action": "double_click", "coordinate": [320, 240]}},
    {"op": "right_click", "msg": "right click at 600,300",
     "args": {"action": "right_click", "coordinate": [600, 300]}},
    {"op": "mouse_move", "msg": "move the mouse to 1000,500",
     "args": {"action": "mouse_move", "coordinate": [1000, 500]}},
    {"op": "type", "msg": "type 'hello world' on screen",
     "args": {"action": "type", "text": "hello world"}},
    {"op": "type", "msg": "enter the text 'eliza-deploy-v2'",
     "args": {"action": "type", "text": "eliza-deploy-v2"}},
    {"op": "type", "msg": "type my password Hunter2! (don't log it)",
     "args": {"action": "type", "text": "Hunter2!"}},
    {"op": "key", "msg": "press the Return key",
     "args": {"action": "key", "key": "Return"}},
    {"op": "key", "msg": "hit Escape",
     "args": {"action": "key", "key": "Escape"}},
    {"op": "key", "msg": "press F5 to refresh",
     "args": {"action": "key", "key": "F5"}},
    {"op": "key", "msg": "tab to next field",
     "args": {"action": "key", "key": "Tab"}},
    {"op": "key_combo", "msg": "press ctrl+c",
     "args": {"action": "key_combo", "key": "ctrl+c"}},
    {"op": "key_combo", "msg": "do cmd+shift+s",
     "args": {"action": "key_combo", "key": "cmd+shift+s"}},
    {"op": "key_combo", "msg": "alt+F4",
     "args": {"action": "key_combo", "key": "alt+F4"}},
    {"op": "key_combo", "msg": "ctrl+alt+t",
     "args": {"action": "key_combo", "key": "ctrl+alt+t"}},
    {"op": "scroll", "msg": "scroll down at 600,400",
     "args": {"action": "scroll", "coordinate": [600, 400], "scrollDirection": "down"}},
    {"op": "scroll", "msg": "scroll up 5 ticks at 800,500",
     "args": {"action": "scroll", "coordinate": [800, 500],
              "scrollDirection": "up", "scrollAmount": 5}},
    {"op": "scroll", "msg": "scroll right at 700,300",
     "args": {"action": "scroll", "coordinate": [700, 300], "scrollDirection": "right"}},
    {"op": "drag", "msg": "drag from 100,100 to 400,400",
     "args": {"action": "drag", "startCoordinate": [100, 100],
              "coordinate": [400, 400]}},
    {"op": "drag", "msg": "drag the icon at 50,50 over to 500,300",
     "args": {"action": "drag", "startCoordinate": [50, 50],
              "coordinate": [500, 300]}},
]

# ─── CLEAR_SHELL_HISTORY ────────────────────────────────────────────────
SHELL_HISTORY_SCENARIOS = [
    {"msg": "clear my shell history please", "ctx": "privacy"},
    {"msg": "wipe the shell command log", "ctx": "privacy"},
    {"msg": "reset the recorded shell history for this conversation",
     "ctx": "privacy"},
    {"msg": "clean up the shell history — I pasted some secrets",
     "ctx": "secrets"},
    {"msg": "delete the history of commands I've run",
     "ctx": "privacy"},
    {"msg": "I want to start fresh — clear the shell history",
     "ctx": "fresh"},
    {"msg": "purge the recorded terminal commands",
     "ctx": "privacy"},
    {"msg": "drop the shell history, please",
     "ctx": "privacy"},
    {"msg": "scrub the command log — there's a token in there",
     "ctx": "secrets"},
    {"msg": "reset shell history. I'm done with this session",
     "ctx": "fresh"},
    {"msg": "weekly cleanup — clear the shell history",
     "ctx": "periodic"},
    {"msg": "I want a clean slate; remove the shell command history",
     "ctx": "fresh"},
]

# ─── ASSIGN_ISSUE ────────────────────────────────────────────────────
ASSIGN_ISSUE_SCENARIOS = [
    {"msg": "assign alice to elizaOS/eliza#42 (confirmed)",
     "args": {"repo": "elizaOS/eliza", "number": 42, "assignees": ["alice"], "confirmed": True}},
    {"msg": "add bob as assignee on eliza/eliza#101",
     "args": {"repo": "eliza/eliza", "number": 101, "assignees": ["bob"]}},
    {"msg": "go ahead and assign carlos to elizaOS/agent#7 — confirmed",
     "args": {"repo": "elizaOS/agent", "number": 7, "assignees": ["carlos"], "confirmed": True}},
    {"msg": "loop in diana and ethan on elizaOS/eliza#231",
     "args": {"repo": "elizaOS/eliza", "number": 231, "assignees": ["diana", "ethan"]}},
    {"msg": "assign [fatima, george] to elizaOS/plugin-shell#15, confirmed yes",
     "args": {"repo": "elizaOS/plugin-shell", "number": 15,
              "assignees": ["fatima", "george"], "confirmed": True}},
    {"msg": "put hina on eliza/training#88",
     "args": {"repo": "eliza/training", "number": 88, "assignees": ["hina"]}},
    {"msg": "assign ivan to issue 1024 in elizaOS/cli (confirmed)",
     "args": {"repo": "elizaOS/cli", "number": 1024, "assignees": ["ivan"], "confirmed": True}},
    {"msg": "assignees: jin and kira on elizaOS/dashboard#56",
     "args": {"repo": "elizaOS/dashboard", "number": 56, "assignees": ["jin", "kira"]}},
    {"msg": "ok confirmed, assign leo to elizaOS/eliza#999",
     "args": {"repo": "elizaOS/eliza", "number": 999, "assignees": ["leo"], "confirmed": True}},
    {"msg": "give priya the issue elizaOS/api#12",
     "args": {"repo": "elizaOS/api", "number": 12, "assignees": ["priya"]}},
    {"msg": "tag quinn on elizaOS/runtime#345 — confirmed",
     "args": {"repo": "elizaOS/runtime", "number": 345, "assignees": ["quinn"], "confirmed": True}},
    {"msg": "raj should own eliza/training#3, confirmed",
     "args": {"repo": "eliza/training", "number": 3, "assignees": ["raj"], "confirmed": True}},
    {"msg": "assign sofia to PR 22 in elizaOS/ui",
     "args": {"repo": "elizaOS/ui", "number": 22, "assignees": ["sofia"]}},
    {"msg": "set assignee tomas on elizaOS/plugin-github#8 confirmed",
     "args": {"repo": "elizaOS/plugin-github", "number": 8, "assignees": ["tomas"], "confirmed": True}},
    {"msg": "uma + viktor on elizaOS/eliza#1500",
     "args": {"repo": "elizaOS/eliza", "number": 1500, "assignees": ["uma", "viktor"]}},
]

# ─── CREATE_ISSUE ────────────────────────────────────────────────────
CREATE_ISSUE_SCENARIOS = [
    {"msg": "open an issue in elizaOS/eliza titled 'Docs gap on plugin-shell'",
     "args": {"repo": "elizaOS/eliza", "title": "Docs gap on plugin-shell",
              "body": "The plugin-shell README is missing examples for CLEAR_SHELL_HISTORY."}},
    {"msg": "create a bug report in eliza/eliza: 'Crash on startup when ANTHROPIC_API_KEY is empty' (confirmed)",
     "args": {"repo": "eliza/eliza", "title": "Crash on startup when ANTHROPIC_API_KEY is empty",
              "body": "Repro: launch eliza with empty key — runtime panics in eliza.ts.",
              "confirmed": True}},
    {"msg": "file an issue: 'Flaky test in tests/integration/auth.test.ts' on elizaOS/eliza, label flaky-test",
     "args": {"repo": "elizaOS/eliza", "title": "Flaky test in tests/integration/auth.test.ts",
              "body": "Fails ~10% of CI runs. Need to investigate.",
              "labels": ["flaky-test"]}},
    {"msg": "open issue 'Add dark mode' in elizaOS/dashboard, assign to mia",
     "args": {"repo": "elizaOS/dashboard", "title": "Add dark mode",
              "body": "Users have requested a dark theme.",
              "assignees": ["mia"]}},
    {"msg": "create issue in elizaOS/runtime — title 'Memory leak in long-running sessions' (confirmed)",
     "args": {"repo": "elizaOS/runtime", "title": "Memory leak in long-running sessions",
              "body": "After 24h of uptime, RSS climbs steadily.",
              "confirmed": True}},
    {"msg": "open an issue: 'Typescript type error in plugin-github' in elizaOS/plugin-github",
     "args": {"repo": "elizaOS/plugin-github", "title": "Typescript type error in plugin-github",
              "body": "Build fails with TS2322 in actions/review-pr.ts."}},
    {"msg": "file 'Investigate slow tool_call latency' in elizaOS/eliza with labels [perf, p1] confirmed",
     "args": {"repo": "elizaOS/eliza", "title": "Investigate slow tool_call latency",
              "body": "Some tool calls take >5s end-to-end.",
              "labels": ["perf", "p1"], "confirmed": True}},
    {"msg": "open 'Update CONTRIBUTING.md' on elizaOS/eliza, assignees [noah]",
     "args": {"repo": "elizaOS/eliza", "title": "Update CONTRIBUTING.md",
              "body": "Stale instructions on how to run tests.",
              "assignees": ["noah"]}},
    {"msg": "create a feature request: 'Add /reset slash command' in eliza/eliza (confirmed)",
     "args": {"repo": "eliza/eliza", "title": "Add /reset slash command",
              "body": "Convenience to clear conversation state.",
              "confirmed": True}},
    {"msg": "file an issue 'Audit log truncation' in elizaOS/api with label security",
     "args": {"repo": "elizaOS/api", "title": "Audit log truncation",
              "body": "Long bodies get cut off in audit log writes.",
              "labels": ["security"]}},
    {"msg": "open 'Refactor onboarding flow' on elizaOS/dashboard, assign sofia and olivia, confirmed",
     "args": {"repo": "elizaOS/dashboard", "title": "Refactor onboarding flow",
              "body": "Current flow has too many steps.",
              "assignees": ["sofia", "olivia"], "confirmed": True}},
    {"msg": "create issue 'Bun install fails on macOS arm64' in elizaOS/cli",
     "args": {"repo": "elizaOS/cli", "title": "Bun install fails on macOS arm64",
              "body": "Repro: bun install on M1, errors out at postinstall."}},
]

# ─── GITHUB_NOTIFICATION_TRIAGE ─────────────────────────────────────
NOTIFICATION_TRIAGE_SCENARIOS = [
    {"msg": "what's in my GitHub inbox?", "args": {}},
    {"msg": "triage my unread github notifications", "args": {}},
    {"msg": "show me my prioritized github inbox", "args": {}},
    {"msg": "do my github inbox triage please", "args": {}},
    {"msg": "what github notifications need attention?", "args": {}},
    {"msg": "sort my github notifications by priority", "args": {}},
    {"msg": "any urgent github notifications?", "args": {}},
    {"msg": "give me the top github notifications", "args": {}},
    {"msg": "go through my github inbox", "args": {}},
    {"msg": "what github stuff do I have to look at?", "args": {}},
    {"msg": "rank my unread notifications from github", "args": {}},
    {"msg": "github notification triage", "args": {}},
]

# ─── LIST_PRS ────────────────────────────────────────────────────
LIST_PRS_SCENARIOS = [
    {"msg": "show me open PRs on elizaOS/eliza",
     "args": {"repo": "elizaOS/eliza", "state": "open"}},
    {"msg": "list closed PRs on eliza/eliza",
     "args": {"repo": "eliza/eliza", "state": "closed"}},
    {"msg": "all PRs in elizaOS/agent",
     "args": {"repo": "elizaOS/agent", "state": "all"}},
    {"msg": "what PRs has shaw opened across all repos",
     "args": {"author": "shaw", "state": "open"}},
    {"msg": "show me lalalune's open PRs in elizaOS/eliza",
     "args": {"repo": "elizaOS/eliza", "state": "open", "author": "lalalune"}},
    {"msg": "open PRs across all my repos",
     "args": {"state": "open"}},
    {"msg": "list every open PR in elizaOS/dashboard",
     "args": {"repo": "elizaOS/dashboard", "state": "open"}},
    {"msg": "show me PRs by alice on elizaOS/runtime",
     "args": {"repo": "elizaOS/runtime", "author": "alice"}},
    {"msg": "what's open in elizaOS/cli",
     "args": {"repo": "elizaOS/cli", "state": "open"}},
    {"msg": "all PRs by bob",
     "args": {"author": "bob", "state": "all"}},
    {"msg": "open PRs in elizaOS/plugin-github authored by carlos",
     "args": {"repo": "elizaOS/plugin-github", "state": "open", "author": "carlos"}},
    {"msg": "list PRs on eliza/training",
     "args": {"repo": "eliza/training"}},
    {"msg": "closed PRs by diana in elizaOS/eliza",
     "args": {"repo": "elizaOS/eliza", "state": "closed", "author": "diana"}},
    {"msg": "show me what's pending review in elizaOS/eliza",
     "args": {"repo": "elizaOS/eliza", "state": "open"}},
]

# ─── REVIEW_PR ────────────────────────────────────────────────────
REVIEW_PR_SCENARIOS = [
    {"msg": "approve PR #42 on elizaOS/eliza (confirmed)",
     "args": {"repo": "elizaOS/eliza", "number": 42, "action": "approve", "confirmed": True}},
    {"msg": "request changes on elizaOS/eliza#100 — body 'tests please' confirmed",
     "args": {"repo": "elizaOS/eliza", "number": 100, "action": "request-changes",
              "body": "tests please", "confirmed": True}},
    {"msg": "leave a comment on eliza/eliza#7: 'looking good, minor nit on naming'",
     "args": {"repo": "eliza/eliza", "number": 7, "action": "comment",
              "body": "looking good, minor nit on naming"}},
    {"msg": "approve elizaOS/agent#88 confirmed",
     "args": {"repo": "elizaOS/agent", "number": 88, "action": "approve", "confirmed": True}},
    {"msg": "request changes on PR 12 in elizaOS/runtime, body 'add unit tests for the new path' (confirmed)",
     "args": {"repo": "elizaOS/runtime", "number": 12, "action": "request-changes",
              "body": "add unit tests for the new path", "confirmed": True}},
    {"msg": "comment on elizaOS/dashboard#33: 'lgtm pending CI'",
     "args": {"repo": "elizaOS/dashboard", "number": 33, "action": "comment",
              "body": "lgtm pending CI"}},
    {"msg": "approve elizaOS/cli#5, confirmed",
     "args": {"repo": "elizaOS/cli", "number": 5, "action": "approve", "confirmed": True}},
    {"msg": "post 'thanks!' as a comment on eliza/training#41",
     "args": {"repo": "eliza/training", "number": 41, "action": "comment",
              "body": "thanks!"}},
    {"msg": "request changes on elizaOS/plugin-github#22, 'fix the auth header' confirmed",
     "args": {"repo": "elizaOS/plugin-github", "number": 22, "action": "request-changes",
              "body": "fix the auth header", "confirmed": True}},
    {"msg": "approve PR elizaOS/eliza#777 confirmed",
     "args": {"repo": "elizaOS/eliza", "number": 777, "action": "approve", "confirmed": True}},
    {"msg": "comment 'I'll take a look in the morning' on elizaOS/api#9",
     "args": {"repo": "elizaOS/api", "number": 9, "action": "comment",
              "body": "I'll take a look in the morning"}},
    {"msg": "request-changes elizaOS/agent#150 body 'rename the function' yes confirmed",
     "args": {"repo": "elizaOS/agent", "number": 150, "action": "request-changes",
              "body": "rename the function", "confirmed": True}},
    {"msg": "approve elizaOS/ui#3 (confirmed)",
     "args": {"repo": "elizaOS/ui", "number": 3, "action": "approve", "confirmed": True}},
]


# ───────────────────────────── builder ─────────────────────────────────

def build_record(
    *,
    encoder: ExpectedResponseEncoder,
    user_msg: str,
    expected: dict[str, Any],
    available_actions: list[str],
    action_name: str,
    plugin: str,
    persona: dict,
    agent: str,
    memory: list[dict[str, Any]],
    channel: str,
    rng: random.Random,
    style_label: str,
    sub_op: str | None = None,
    language: str | None = None,
    task_type: str = "tool_call",
    expected_str_override: str | None = None,
) -> dict[str, Any]:
    if expected_str_override is not None:
        expected_str = expected_str_override
    else:
        expected_str = encoder.encode(expected)

    extra_md: dict[str, Any] = {
        "agent_name": agent,
        "action_name": action_name,
        "plugin": plugin,
        "style": style_label,
        "persona_role": persona["role"],
    }
    if sub_op is not None:
        extra_md["sub_op"] = sub_op
    if language is not None:
        extra_md["language"] = language

    rec = build(
        roomName=stable_id("synth-system-actions", action_name, user_msg, agent),
        agentId=agent.lower(),
        memoryEntries=memory,
        currentMessage={
            "role": "user",
            "speaker": persona["name"],
            "content": user_msg,
            "channel": channel,
        },
        expectedResponse=expected_str,
        availableActions=available_actions,
        task_type=task_type,
        source_dataset="synth-system-actions",
        license="synthetic",
        split="train",
        extra_metadata=extra_md,
    )
    return rec.to_dict()


# ───────────────────────────── per-action generators ─────────────────────

# Diversity targets per action (n ≈ 100):
#   ~70 English / ~30 multilingual (≥3 each across zh/es/fr/ja/de/pt = 5/lang)
#   ~5–10 subtle-null (REPLY {thought, text})

LANGS = ["zh", "es", "fr", "ja", "de", "pt"]


def _pick_lang(idx: int, multilingual_n: int, langs: list[str]) -> str:
    """Distribute multilingual indices across at least 3 each language."""
    return langs[idx % len(langs)]


# Subtle-null reply pool. The user message is just-clear-enough that the
# right move is a clarifying REPLY, not a tool call.
SUBTLE_NULL_PROMPTS = {
    "BROWSER_ACTION": [
        ("hey, browser thing", "I don't have enough info — which action did you want? Open a URL, click an element, take a screenshot, or something else?"),
        ("can you do the browser please", "Happy to drive the browser — what do you want me to do? Navigate, click, take a screenshot?"),
        ("browser", "Sure — what should I do with the browser?"),
    ],
    "FILE_ACTION": [
        ("file thing", "Which file action? read, write, edit, delete, list — and which path?"),
        ("touch a file for me", "Which file would you like me to touch, and what should the contents be?"),
        ("do the files", "What file operation would you like? read, write, edit, list, delete?"),
    ],
    "MANAGE_WINDOW": [
        ("window", "Which window action — list, focus, arrange, minimize, maximize, close?"),
        ("do the window stuff", "What would you like me to do with windows? Listing them is a good first step if you're not sure."),
        ("manage the windows", "Sure — list them first, or did you have a specific window in mind?"),
    ],
    "TERMINAL_ACTION": [
        ("terminal", "What terminal action — connect, execute, read, clear, close — and which command?"),
        ("run the thing in the shell", "Which command should I run, and in which working directory?"),
        ("shell please", "Sure — what command would you like me to run?"),
    ],
    "USE_COMPUTER": [
        ("computer thing", "What desktop action? screenshot, click, type, key combo, drag?"),
        ("do the computer", "Want me to take a screenshot first so we can see the current state?"),
        ("control my mac", "Sure — should I start with a screenshot, or do you have a specific click/type in mind?"),
    ],
    "CLEAR_SHELL_HISTORY": [
        ("can you do the shell history thing", "You want me to clear the recorded shell history? Just confirm and I'll do it."),
        ("history", "Want me to clear the shell history for this conversation?"),
    ],
    "ASSIGN_ISSUE": [
        ("assign the issue", "Which repo (owner/name), which issue number, and to whom?"),
        ("issue assignment", "Tell me the repo, the issue number, and the assignee — and confirm so I can run it."),
    ],
    "CREATE_ISSUE": [
        ("file an issue", "Which repo, what title, and a brief description? I'll need confirmation before I open it."),
        ("create issue", "Sure — repo (owner/name) and a title please."),
        ("issue please", "What should the issue be about? I need a repo and a title at minimum."),
    ],
    "GITHUB_NOTIFICATION_TRIAGE": [
        ("github stuff", "Want me to triage your unread GitHub notifications by priority?"),
    ],
    "LIST_PRS": [
        ("PRs", "Which repo, or across all? And do you want open, closed, or all?"),
        ("show pull requests", "Across all your repos or a specific one? Filter by state or author?"),
    ],
    "REVIEW_PR": [
        ("review the PR", "Which repo and number? Approve, request changes, or comment? Approve and request-changes need confirmation."),
        ("approve it", "Which PR (repo + number)? Approve needs explicit confirmation."),
    ],
}


def gen_action_examples(
    encoder: ExpectedResponseEncoder,
    rng: random.Random,
    action_name: str,
    plugin: str,
    scenarios: list[dict],
    target_n: int = 100,
    multilingual_count: int = 30,
    subtle_null_count: int = 7,
) -> Iterable[dict]:
    """Generate ~target_n records for a single action with full diversity.

    Layout:
      - subtle_null_count records → REPLY thought/text (task_type=reply)
      - multilingual_count records → translated user prompts
      - remaining English with style variants
    """
    n_main = target_n - subtle_null_count
    n_english = n_main - multilingual_count

    # 1) English style-varied tool_call records
    for i in range(n_english):
        sc = scenarios[i % len(scenarios)]
        style_fn = STYLES[i % len(STYLES)]
        style_label = style_fn.__name__.replace("style_", "")
        base_msg = sc["msg"]
        user_msg = style_fn(base_msg, rng)

        persona = rng.choice(PERSONAS)
        agent = rng.choice(AGENT_NAMES)
        room, channel = random_room_meta(rng)
        memory = random_memory(rng, persona, agent, channel)

        if action_name == "CLEAR_SHELL_HISTORY":
            args: dict[str, Any] = {}
            sub_op = sc.get("ctx")
        else:
            args = sc["args"]
            sub_op = sc.get("op")

        expected = {"tool_calls": [{"name": action_name, "arguments": args}]}
        yield build_record(
            encoder=encoder,
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action_name],
            action_name=action_name,
            plugin=plugin,
            persona=persona,
            agent=agent,
            memory=memory,
            channel=channel,
            rng=rng,
            style_label=style_label,
            sub_op=sub_op,
        )

    # 2) Multilingual records (≥5 each across 6 langs by default)
    for i in range(multilingual_count):
        sc = scenarios[i % len(scenarios)]
        lang = _pick_lang(i, multilingual_count, LANGS)

        # Build an intent_key for translation lookup
        if action_name == "CLEAR_SHELL_HISTORY":
            intent_key = "CLEAR_SHELL_HISTORY"
        elif action_name in ("ASSIGN_ISSUE", "CREATE_ISSUE",
                             "GITHUB_NOTIFICATION_TRIAGE", "LIST_PRS",
                             "REVIEW_PR"):
            intent_key = action_name
        else:
            intent_key = f"{action_name}_{sc.get('op', '')}"

        intent_phrase = INTENT_TRANSLATIONS.get(intent_key, {}).get(lang)
        if not intent_phrase:
            # Fallback: action-name-only generic translation
            intent_phrase = INTENT_TRANSLATIONS.get(action_name, {}).get(lang)
        if not intent_phrase:
            # Last resort: English direct
            user_msg = sc["msg"]
            language: str | None = None
        else:
            template = rng.choice(MULTILINGUAL_PHRASES[lang])
            # For github/shell-style commands, append the relevant operands
            # (repo, number, etc.) since translating a real owner/name
            # repo path is silly.
            tail = ""
            args = sc.get("args", {})
            if action_name in ("ASSIGN_ISSUE", "REVIEW_PR"):
                if "repo" in args and "number" in args:
                    tail = f" {args['repo']}#{args['number']}"
                    if "assignees" in args:
                        tail += f" → {','.join(args['assignees'])}"
                    if "action" in args:
                        tail += f" ({args['action']})"
                    if args.get("confirmed"):
                        tail += " confirmed"
            elif action_name == "CREATE_ISSUE":
                if "repo" in args and "title" in args:
                    tail = f" {args['repo']}: \"{args['title']}\""
                    if args.get("confirmed"):
                        tail += " confirmed"
            elif action_name == "LIST_PRS":
                if "repo" in args:
                    tail = f" {args['repo']}"
                if "state" in args and args["state"] != "all":
                    tail += f" ({args['state']})"
                if "author" in args:
                    tail += f" @{args['author']}"
            elif action_name == "BROWSER_ACTION" and "url" in args:
                tail = f" {args['url']}"
            elif action_name == "BROWSER_ACTION" and "selector" in args:
                tail = f" — selector {args['selector']}"
            elif action_name == "FILE_ACTION" and "path" in args:
                tail = f" {args['path']}"
            elif action_name == "TERMINAL_ACTION" and "command" in args:
                tail = f" `{args['command']}`"
            elif action_name == "USE_COMPUTER":
                if "coordinate" in args:
                    tail = f" {args['coordinate']}"
                elif "text" in args:
                    tail = f" '{args['text']}'"
                elif "key" in args:
                    tail = f" {args['key']}"
            elif action_name == "MANAGE_WINDOW":
                if "windowId" in args:
                    tail = f" {args['windowId']}"
                elif "windowTitle" in args:
                    tail = f" {args['windowTitle']}"
                elif "arrangement" in args:
                    tail = f" ({args['arrangement']})"

            user_msg = template.format(intent=intent_phrase) + tail
            language = lang

        persona = rng.choice(PERSONAS)
        agent = rng.choice(AGENT_NAMES)
        room, channel = random_room_meta(rng)
        memory = random_memory(rng, persona, agent, channel)

        if action_name == "CLEAR_SHELL_HISTORY":
            args = {}
            sub_op = sc.get("ctx")
        else:
            args = sc.get("args", {})
            sub_op = sc.get("op")

        expected = {"tool_calls": [{"name": action_name, "arguments": args}]}
        yield build_record(
            encoder=encoder,
            user_msg=user_msg,
            expected=expected,
            available_actions=[ACTION_TASK_CALL, ACTION_REPLY, action_name],
            action_name=action_name,
            plugin=plugin,
            persona=persona,
            agent=agent,
            memory=memory,
            channel=channel,
            rng=rng,
            style_label="multilingual",
            sub_op=sub_op,
            language=language,
        )

    # 3) Subtle-null REPLY records (task_type=reply)
    null_pool = SUBTLE_NULL_PROMPTS.get(action_name, [])
    for i in range(subtle_null_count):
        if not null_pool:
            break
        msg, reply_text = null_pool[i % len(null_pool)]
        persona = rng.choice(PERSONAS)
        agent = rng.choice(AGENT_NAMES)
        room, channel = random_room_meta(rng)
        memory = random_memory(rng, persona, agent, channel)

        thought = "underspecified — ask for the missing parameters before issuing a tool call"
        # Encode the canonical reply shape
        reply_toon = encoder.encode({"thought": thought, "text": reply_text})
        yield build_record(
            encoder=encoder,
            user_msg=msg,
            expected={},
            available_actions=[ACTION_REPLY, ACTION_IGNORE],
            action_name=action_name,
            plugin=plugin,
            persona=persona,
            agent=agent,
            memory=memory,
            channel=channel,
            rng=rng,
            style_label="subtle-null",
            task_type="reply",
            expected_str_override=reply_toon,
        )


# ───────────────────────────── main ─────────────────────────────────

ACTION_REGISTRY = [
    # (action_name, plugin, scenario_pool)
    ("CLEAR_SHELL_HISTORY", "plugin-shell", SHELL_HISTORY_SCENARIOS),
    ("BROWSER_ACTION", "plugin-computeruse", BROWSER_SCENARIOS),
    ("FILE_ACTION", "plugin-computeruse", FILE_SCENARIOS),
    ("MANAGE_WINDOW", "plugin-computeruse", WINDOW_SCENARIOS),
    ("TERMINAL_ACTION", "plugin-computeruse", TERMINAL_SCENARIOS),
    ("USE_COMPUTER", "plugin-computeruse", COMPUTER_SCENARIOS),
    ("ASSIGN_ISSUE", "plugin-github", ASSIGN_ISSUE_SCENARIOS),
    ("CREATE_ISSUE", "plugin-github", CREATE_ISSUE_SCENARIOS),
    ("GITHUB_NOTIFICATION_TRIAGE", "plugin-github", NOTIFICATION_TRIAGE_SCENARIOS),
    ("LIST_PRS", "plugin-github", LIST_PRS_SCENARIOS),
    ("REVIEW_PR", "plugin-github", REVIEW_PR_SCENARIOS),
]


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    rng = random.Random(20260502)

    encoder = JsonExpectedResponseEncoder()
    n_total = 0
    per_action_counts: dict[str, int] = {}
    style_hist: dict[str, int] = {}
    lang_hist: dict[str, int] = {}
    task_type_hist: dict[str, int] = {}
    sub_op_hist: dict[str, int] = {}

    with OUT_PATH.open("w", encoding="utf-8") as fp:
        for action_name, plugin, scenarios in ACTION_REGISTRY:
            n = 0
            for rec in gen_action_examples(
                encoder=encoder, rng=rng,
                action_name=action_name, plugin=plugin,
                scenarios=scenarios, target_n=100,
                multilingual_count=30, subtle_null_count=7,
            ):
                fp.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")))
                fp.write("\n")
                n += 1
                n_total += 1
                md = rec.get("metadata", {})
                style_hist[md.get("style", "?")] = style_hist.get(md.get("style", "?"), 0) + 1
                lang = md.get("language", "en")
                lang_hist[lang] = lang_hist.get(lang, 0) + 1
                tt = md.get("task_type", "?")
                task_type_hist[tt] = task_type_hist.get(tt, 0) + 1
                so = md.get("sub_op", "-")
                sub_op_hist[f"{action_name}::{so}"] = sub_op_hist.get(f"{action_name}::{so}", 0) + 1
            per_action_counts[action_name] = n
            log.info("  %s: %d records", action_name, n)

    encoder.close()

    log.info("─" * 60)
    log.info("Total records: %d", n_total)
    log.info("Per-action: %s", per_action_counts)
    log.info("Per-style:  %s", style_hist)
    log.info("Per-lang:   %s", lang_hist)
    log.info("Task types: %s", task_type_hist)
    log.info("Output: %s", OUT_PATH)

    # Coverage check: every polymorphic action should hit ≥5 distinct sub_ops
    poly_actions = ["BROWSER_ACTION", "FILE_ACTION", "MANAGE_WINDOW",
                    "TERMINAL_ACTION", "USE_COMPUTER"]
    for an in poly_actions:
        ops = {k.split("::", 1)[1] for k in sub_op_hist if k.startswith(f"{an}::")}
        log.info("  %s sub_ops covered: %d (%s)", an, len(ops), sorted(ops))
    return 0


if __name__ == "__main__":
    sys.exit(main())
