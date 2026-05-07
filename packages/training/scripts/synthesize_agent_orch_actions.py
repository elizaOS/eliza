"""Synthesize ~2,400 canonical TOON tool_call examples covering 24 actions
across the elizaOS agent/orchestration plugin surface.

Plugins covered:
    plugin-agent-orchestrator   (10 actions)
    plugin-agent-skills          (7 actions)
    plugin-app-control           (1 action,  polymorphic — APP)
    plugin-plugin-manager        (2 actions, PLUGIN polymorphic)
    plugin-elizacloud            (4 actions)

For polymorphic actions (APP, PLUGIN, USE_SKILL) the generator spreads
examples across all documented sub-operations (per the catalog
description / parameters / source code).

Per action: ~100 records.
Diversity:
  - ~70 English / ~30 across zh, es, fr, ja, de, pt (>=3 each).
  - >=10 user phrasing styles.
  - 30% empty memoryEntries / 50% 1-2 prior turns / 20% 3 prior turns.
  - 5-10% subtle-null records emit a `thought:/text:` REPLY shape rather
    than a tool_call.

Output format mirrors the messaging-gen agent — every record carries
`metadata.system_prompt`, `metadata.toolSpecs`, `metadata.synth_origin`,
`metadata.synth_action`, `metadata.synth_lang`, `metadata.synth_style`.

Run:
    .venv/bin/python scripts/synthesize_agent_orch_actions.py
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
    ACTION_IGNORE,
    ACTION_REPLY,
    build,
    stable_id,
)
from lib.expected_response import ExpectedResponseEncoder, JsonExpectedResponseEncoder  # noqa: E402

ACTIONS_PATH = ROOT / "data" / "prompts" / "actions-catalog.json"
OUT_PATH = ROOT / "data" / "synthesized" / "action_examples" / "agent_orch.jsonl"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("synth-orch")


TARGET_ACTIONS = [
    # plugin-agent-orchestrator
    "FINALIZE_WORKSPACE", "LIST_AGENTS", "MANAGE_ISSUES", "PROVISION_WORKSPACE",
    "SEND_TO_AGENT", "SPAWN_AGENT", "STOP_AGENT", "TASK_CONTROL",
    "TASK_HISTORY", "TASK_SHARE",
    # plugin-agent-skills
    "GET_SKILL_DETAILS", "INSTALL_SKILL", "SEARCH_SKILLS", "SYNC_SKILL_CATALOG",
    "TOGGLE_SKILL", "UNINSTALL_SKILL", "USE_SKILL",
    # plugin-app-control
    "APP",
    # plugin-plugin-manager
    "LIST_EJECTED_PLUGINS", "PLUGIN",
    # plugin-elizacloud
    "CHECK_CLOUD_CREDITS", "FREEZE_CLOUD_AGENT", "PROVISION_CLOUD_AGENT",
    "RESUME_CLOUD_AGENT",
]


# Personas (>= 20)
PERSONAS = [
    "alice", "bob", "carlos", "diana", "ethan", "fatima", "george",
    "hina", "ivan", "jin", "kira", "leo", "mia", "noah", "olivia",
    "priya", "quinn", "raj", "sofia", "tomas", "yuki", "wei", "amir",
    "marta", "nadia", "ren", "sven", "tess",
]

AGENT_NAMES = ["agent", "milady", "iris", "kai", "ava", "nova", "sage", "atlas",
               "lyra", "lumi", "rune", "vega", "sol", "orion"]

ROOM_KINDS = [
    "dm", "channel:general", "channel:engineering", "channel:design",
    "channel:trading", "channel:ops", "channel:launch", "channel:devops",
    "channel:product", "channel:hiring", "channel:cloud-ops",
    "channel:platform", "channel:android", "channel:training",
]
CHANNELS = ["dm", "public", "voice"]


# Languages and balance: ~70 English; remainder spread across 6 non-en
# (zh, es, fr, ja, de, pt) — ensure each has >=3 records per action.
NON_EN_LANGS = ["zh", "es", "fr", "ja", "de", "pt"]

LANG_PHRASE_TABLE = {
    # FINALIZE_WORKSPACE
    "FINALIZE_WORKSPACE": {
        "en": [
            "Wrap up the workspace and open a PR.",
            "Please finalize this workspace and push the branch.",
            "commit, push, draft PR plz",
            "create a pull request titled 'Refactor auth flow' with the body summarizing what changed",
            "finalize workspace {wsid} into develop",
            "skip the PR but commit and push the changes",
            "open a draft PR against main with my staged work",
            "wrap it up, commit message: 'fix: handle null user'",
            "push the branch and don't bother with a PR",
            "finalize, base branch develop, draft true",
        ],
        "zh": ["请提交工作区并打开 PR", "完成 workspace 并推送分支", "把这个工作区收尾，提 PR"],
        "es": ["Finaliza el workspace y abre un PR por favor", "Cierra el workspace y haz push", "Confirma y crea el PR contra main"],
        "fr": ["Finalise le workspace et ouvre une PR", "Commit, push, et crée un PR draft", "Termine le workspace stp"],
        "ja": ["ワークスペースを確定してPRを作成して", "コミットとプッシュ、PRを作って", "PRを下書きで開いて"],
        "de": ["Schließe den Workspace ab und öffne einen PR", "Commit und Push bitte", "Erstelle einen Draft-PR"],
        "pt": ["Finalize o workspace e abra um PR", "Commit, push, e crie um PR", "Encerre o workspace agora"],
    },
    "LIST_AGENTS": {
        "en": [
            "What task agents are running right now?",
            "list active subagents please",
            "show me all the running agents and what they're working on",
            "any agents still alive?",
            "agents status?",
            "give me a roster of running task agents",
            "who's still working in the background?",
            "list_agents",
            "what's currently spawned?",
            "running task agent count?",
        ],
        "zh": ["列出运行中的代理", "现在有哪些子代理在跑？", "查看活跃的任务代理"],
        "es": ["Lista los agentes activos", "qué agentes están corriendo?", "muéstrame los subagentes activos"],
        "fr": ["Liste les agents actifs", "quels agents tournent en ce moment ?", "donne-moi le statut des agents"],
        "ja": ["稼働中のエージェントを一覧して", "今動いてるサブエージェントは？", "アクティブなタスクエージェントを表示"],
        "de": ["Liste alle aktiven Agenten", "welche Agenten laufen gerade?", "Zeig mir die laufenden Sub-Agenten"],
        "pt": ["Liste os agentes ativos", "quais agentes estão rodando?", "mostra os subagentes ativos"],
    },
    "MANAGE_ISSUES": {
        "en": [
            "create an issue on {repo} titled 'Login regression'",
            "list open issues on {repo}",
            "close issue #{issue} on {repo}",
            "comment on issue #{issue}: 'fixed in PR 88'",
            "add labels bug,urgent to issue #{issue} on {repo}",
            "reopen issue #{issue}",
            "update issue #{issue} title to 'p0: token refresh broken'",
            "get details for issue #{issue} on {repo}",
            "list closed issues on {repo}",
            "create a github issue: 'add export endpoint' on {repo}",
        ],
        "zh": ["在 {repo} 创建 issue：登录回归", "列出 {repo} 的开放问题", "关闭 {repo} 的 #{issue} 号"],
        "es": ["Crea un issue en {repo}: 'regresión de login'", "Lista los issues abiertos en {repo}", "Cierra el issue #{issue}"],
        "fr": ["Crée une issue sur {repo} : 'Régression du login'", "Liste les issues ouvertes sur {repo}", "Ferme l'issue #{issue}"],
        "ja": ["{repo} に issue を作成：ログインの問題", "{repo} のオープンな issue を一覧", "issue #{issue} をクローズ"],
        "de": ["Erstelle ein Issue in {repo}: 'Login-Regression'", "Liste offene Issues in {repo}", "Schließe Issue #{issue}"],
        "pt": ["Crie um issue em {repo}: 'regressão de login'", "Liste os issues abertos em {repo}", "Feche o issue #{issue}"],
    },
    "PROVISION_WORKSPACE": {
        "en": [
            "clone {repo} and create a workspace for the auth feature",
            "set up a workspace from {repo} on branch develop",
            "create a worktree of the current repo",
            "spin up a workspace for me, {repo}, base main",
            "make a worktree for parallel work",
            "provision a clone of {repo}",
            "I want a fresh workspace from {repo}",
            "set up a sandbox workspace please",
            "create workspace using a worktree on develop",
            "clone the eliza repo and prep a workspace",
        ],
        "zh": ["克隆 {repo} 并创建一个工作区", "用 {repo} 准备一个 worktree", "创建一个独立的工作区"],
        "es": ["Clona {repo} y crea un workspace", "Crea un worktree del repo actual", "Provisiona un workspace desde {repo}"],
        "fr": ["Clone {repo} et crée un workspace", "Provisionne un worktree", "Mets en place un workspace depuis {repo}"],
        "ja": ["{repo} をクローンしてワークスペースを作成", "現在のリポジトリの worktree を作成", "新しい workspace を用意して"],
        "de": ["Klone {repo} und erstelle einen Workspace", "Lege ein Worktree an", "Provisioniere einen Workspace aus {repo}"],
        "pt": ["Clone {repo} e crie um workspace", "Crie um worktree do repo atual", "Provisione um workspace a partir de {repo}"],
    },
    "SEND_TO_AGENT": {
        "en": [
            "tell the running sub-agent to accept the changes",
            "send 'yes, continue' to session {sess}",
            "send Enter to the agent",
            "press Ctrl-C in the running session",
            "give the codex agent this task: 'audit the build pipeline'",
            "respond 'use option B' to the active session",
            "send 'y' to confirm",
            "tell session {sess} to skip and move on",
            "assign a fresh task to the running agent: 'draft release notes'",
            "send 'continue from where you left off' to the subagent",
        ],
        "zh": ["告诉正在运行的子代理继续", "向会话 {sess} 发送 'yes'", "对子代理按 Enter"],
        "es": ["Dile al subagente que continúe", "Envía 'sí, continúa' a la sesión {sess}", "Envía Enter al agente"],
        "fr": ["Dis au sous-agent de continuer", "Envoie 'oui, continue' à la session {sess}", "Envoie Entrée à l'agent"],
        "ja": ["サブエージェントに『続行』と伝えて", "セッション {sess} に 'yes' を送信", "エージェントに Enter を送って"],
        "de": ["Sag dem Sub-Agent, er soll weitermachen", "Sende 'ja, weiter' an Session {sess}", "Sende Enter an den Agenten"],
        "pt": ["Diga ao subagente para continuar", "Envie 'sim, continue' para a sessão {sess}", "Envie Enter para o agente"],
    },
    "SPAWN_AGENT": {
        "en": [
            "spawn a claude code agent in {wd} to fix the failing test",
            "start a codex sub-agent and have it audit the build pipeline",
            "spin up an aider session in /workspace/eliza",
            "launch a shell agent to monitor the deploy",
            "kick off a gemini agent for documentation work",
            "spawn an agent — pick whichever framework",
            "fire up a sub-agent to investigate the staging logs",
            "create a claude agent and tell it to draft release notes",
            "spawn pi agent in {wd} for the data migration",
            "I want a codex agent set up in workspace {wd}",
        ],
        "zh": ["在 {wd} 启动一个 claude 子代理来修复失败的测试", "启动 codex 子代理审计构建", "在 {wd} 启动一个 shell 代理"],
        "es": ["Lanza un agente claude en {wd} para arreglar el test", "Inicia un agente codex para auditar el build", "Spawnea un agente shell en {wd}"],
        "fr": ["Lance un agent claude dans {wd} pour corriger le test", "Démarre un agent codex pour auditer le build", "Spawn un agent shell dans {wd}"],
        "ja": ["{wd} に claude エージェントを起動して失敗テストを修正", "codex サブエージェントを起動", "shell エージェントを {wd} で起動"],
        "de": ["Starte einen Claude-Agenten in {wd}, der den Test repariert", "Starte einen Codex-Subagenten", "Spawne einen Shell-Agenten in {wd}"],
        "pt": ["Inicie um agente claude em {wd} para consertar o teste", "Inicie um agente codex para auditar o build", "Lance um agente shell em {wd}"],
    },
    "STOP_AGENT": {
        "en": [
            "stop the task agent",
            "kill session {sess}",
            "stop all running agents",
            "shut down the codex sub-agent",
            "stop sub-agent {sess} please",
            "kill all the agents",
            "terminate the running session",
            "halt the agent in the background",
            "stop the current session",
            "stop everything please",
        ],
        "zh": ["停止任务代理", "终止会话 {sess}", "关闭所有运行中的代理"],
        "es": ["Detén el agente", "Cierra la sesión {sess}", "Detén todos los agentes"],
        "fr": ["Arrête l'agent", "Tue la session {sess}", "Arrête tous les agents"],
        "ja": ["エージェントを止めて", "セッション {sess} を終了", "全エージェントを停止"],
        "de": ["Stoppe den Agenten", "Beende Session {sess}", "Stoppe alle Agenten"],
        "pt": ["Pare o agente", "Encerre a sessão {sess}", "Pare todos os agentes"],
    },
    "TASK_CONTROL": {
        "en": [
            "pause the current task thread",
            "resume thread {tid} with 'focus on the failing tests first'",
            "stop thread {tid}, paused while waiting on review",
            "archive thread {tid}",
            "reopen the thread about the migration",
            "continue the build-pipeline audit",
            "pause the active task — let's discuss",
            "stop and archive thread {tid}",
            "resume the codex task with framework override codex",
            "search for thread about 'auth flow' and pause it",
        ],
        "zh": ["暂停当前任务线", "恢复线程 {tid}", "停止并归档线程 {tid}"],
        "es": ["Pausa el hilo actual", "Reanuda el hilo {tid}", "Detén y archiva el hilo {tid}"],
        "fr": ["Mets en pause le thread actuel", "Reprends le thread {tid}", "Arrête et archive le thread {tid}"],
        "ja": ["現在のスレッドを一時停止", "スレッド {tid} を再開", "スレッド {tid} を停止してアーカイブ"],
        "de": ["Pausiere den aktuellen Thread", "Setze Thread {tid} fort", "Stoppe und archiviere Thread {tid}"],
        "pt": ["Pause a thread atual", "Retome a thread {tid}", "Pare e arquive a thread {tid}"],
    },
    "TASK_HISTORY": {
        "en": [
            "what are you working on right now?",
            "list active task threads",
            "count tasks completed yesterday",
            "show task detail for thread {tid}",
            "search task history for 'release notes'",
            "list paused threads",
            "task history this week",
            "include archived threads in the list",
            "give me task counts by status this month",
            "find tasks about 'auth flow' from last 7 days",
        ],
        "zh": ["你现在在做什么？", "列出活跃的任务线", "统计昨天完成的任务"],
        "es": ["¿En qué estás trabajando ahora?", "Lista los hilos activos", "Cuenta las tareas de ayer"],
        "fr": ["Sur quoi tu bosses en ce moment ?", "Liste les threads actifs", "Compte les tâches d'hier"],
        "ja": ["今何やってる？", "アクティブなタスクスレッドを一覧", "昨日完了したタスクを数えて"],
        "de": ["Woran arbeitest du gerade?", "Liste die aktiven Threads", "Zähle die Aufgaben von gestern"],
        "pt": ["No que está trabalhando agora?", "Liste as threads ativas", "Conte as tarefas de ontem"],
    },
    "TASK_SHARE": {
        "en": [
            "can I see it?",
            "share the result of thread {tid}",
            "show me the live preview for the current task",
            "where can I view the artifacts?",
            "share the task that's about 'release notes'",
            "give me a link to the running task",
            "what's the share URL for thread {tid}?",
            "I want to see the workspace path for the active task",
            "share the codex run output",
            "find the share path for the auth-flow task",
        ],
        "zh": ["我能看一下吗？", "分享线程 {tid} 的结果", "显示当前任务的预览"],
        "es": ["¿Puedo verlo?", "Comparte el resultado del hilo {tid}", "Muéstrame la previsualización"],
        "fr": ["Je peux voir ?", "Partage le résultat du thread {tid}", "Montre-moi la prévisualisation"],
        "ja": ["見せてくれる？", "スレッド {tid} の結果を共有", "プレビューを表示"],
        "de": ["Kann ich das sehen?", "Teile das Ergebnis von Thread {tid}", "Zeig mir die Live-Vorschau"],
        "pt": ["Posso ver?", "Compartilhe o resultado da thread {tid}", "Mostre a prévia"],
    },
    "GET_SKILL_DETAILS": {
        "en": [
            "tell me about the {skill} skill",
            "show details for {skill}",
            "what does {skill} do?",
            "skill info for {skill}",
            "describe the {skill} skill",
            "give me the version and stats for {skill}",
            "details on {skill} please",
            "{skill} — version, owner, stats?",
            "show metadata for {skill}",
            "what's installed for {skill}?",
        ],
        "zh": ["告诉我 {skill} 技能的详细信息", "显示 {skill} 的详情", "{skill} 是做什么的？"],
        "es": ["Dame detalles sobre el skill {skill}", "Información del skill {skill}", "¿Qué hace {skill}?"],
        "fr": ["Donne-moi les détails du skill {skill}", "Info sur {skill}", "Que fait {skill} ?"],
        "ja": ["{skill} スキルの詳細を教えて", "{skill} の情報を見せて", "{skill} は何をする？"],
        "de": ["Zeig mir Details zum Skill {skill}", "Infos zu {skill} bitte", "Was macht {skill}?"],
        "pt": ["Me dê detalhes do skill {skill}", "Informações sobre {skill}", "O que {skill} faz?"],
    },
    "INSTALL_SKILL": {
        "en": [
            "install the {skill} skill",
            "add {skill} to my agent",
            "please install {skill}",
            "grab the {skill} skill from the registry",
            "I want to add {skill}",
            "install skill {skill}",
            "set up {skill} on my agent",
            "add the {skill} package",
            "install {skill} now",
            "pull in the {skill} skill",
        ],
        "zh": ["安装 {skill} 技能", "把 {skill} 加到代理", "请安装 {skill}"],
        "es": ["Instala el skill {skill}", "Añade {skill} al agente", "Por favor instala {skill}"],
        "fr": ["Installe le skill {skill}", "Ajoute {skill} à l'agent", "Installe {skill} stp"],
        "ja": ["{skill} スキルをインストール", "{skill} をエージェントに追加", "{skill} を入れて"],
        "de": ["Installiere den Skill {skill}", "Füge {skill} dem Agenten hinzu", "Bitte installiere {skill}"],
        "pt": ["Instale o skill {skill}", "Adicione {skill} ao agente", "Por favor instale {skill}"],
    },
    "SEARCH_SKILLS": {
        "en": [
            "search for skills about {topic}",
            "find skills related to {topic}",
            "what skills are there for {topic}?",
            "look up skills tagged {topic}",
            "search registry for {topic}",
            "any skills around {topic}?",
            "find me a {topic} skill",
            "browse skills for {topic}",
            "skill catalog: {topic}",
            "search skills: {topic}",
        ],
        "zh": ["搜索关于 {topic} 的技能", "找一下 {topic} 相关的技能", "有没有 {topic} 的技能？"],
        "es": ["Busca skills sobre {topic}", "Encuentra skills de {topic}", "¿Hay algún skill para {topic}?"],
        "fr": ["Cherche des skills sur {topic}", "Trouve des skills liés à {topic}", "Skills pour {topic} ?"],
        "ja": ["{topic} に関するスキルを検索", "{topic} のスキルを探して", "{topic} 系スキルある？"],
        "de": ["Suche Skills zu {topic}", "Finde Skills für {topic}", "Gibt es Skills für {topic}?"],
        "pt": ["Procure skills sobre {topic}", "Encontre skills relacionados a {topic}", "Tem skill para {topic}?"],
    },
    "SYNC_SKILL_CATALOG": {
        "en": [
            "refresh the skill catalog",
            "sync skills from the registry",
            "update skill catalog",
            "pull the latest skills",
            "resync the skill registry",
            "refresh skills please",
            "discover new skills",
            "sync_skill_catalog now",
            "update the skill list",
            "refresh skills cache",
        ],
        "zh": ["刷新技能目录", "从注册中心同步技能", "更新技能列表"],
        "es": ["Actualiza el catálogo de skills", "Sincroniza los skills", "Refresca la lista"],
        "fr": ["Rafraîchis le catalogue de skills", "Synchronise les skills", "Mets à jour la liste"],
        "ja": ["スキルカタログを更新", "レジストリからスキルを同期", "スキル一覧をリフレッシュ"],
        "de": ["Aktualisiere den Skill-Katalog", "Synchronisiere die Skills", "Skill-Liste aktualisieren"],
        "pt": ["Atualize o catálogo de skills", "Sincronize os skills", "Atualize a lista de skills"],
    },
    "TOGGLE_SKILL": {
        "en": [
            "enable the {skill} skill",
            "disable {skill}",
            "turn on {skill}",
            "turn off the {skill} skill",
            "activate {skill}",
            "deactivate {skill}",
            "toggle {skill} on",
            "toggle {skill} off",
            "switch off {skill}",
            "enable skill {skill}",
        ],
        "zh": ["启用 {skill} 技能", "禁用 {skill}", "打开 {skill}"],
        "es": ["Habilita el skill {skill}", "Deshabilita {skill}", "Activa {skill}"],
        "fr": ["Active le skill {skill}", "Désactive {skill}", "Active {skill}"],
        "ja": ["{skill} スキルを有効化", "{skill} を無効化", "{skill} をオンに"],
        "de": ["Aktiviere den Skill {skill}", "Deaktiviere {skill}", "Schalte {skill} ein"],
        "pt": ["Habilite o skill {skill}", "Desabilite {skill}", "Ative {skill}"],
    },
    "UNINSTALL_SKILL": {
        "en": [
            "uninstall the {skill} skill",
            "remove {skill}",
            "delete the {skill} skill",
            "drop {skill}",
            "uninstall {skill}",
            "get rid of {skill}",
            "remove the {skill} package",
            "uninstall skill {skill}",
            "purge {skill}",
            "remove {skill} from my agent",
        ],
        "zh": ["卸载 {skill} 技能", "删除 {skill}", "去掉 {skill}"],
        "es": ["Desinstala el skill {skill}", "Elimina {skill}", "Quita {skill}"],
        "fr": ["Désinstalle le skill {skill}", "Supprime {skill}", "Retire {skill}"],
        "ja": ["{skill} スキルをアンインストール", "{skill} を削除", "{skill} を外して"],
        "de": ["Deinstalliere den Skill {skill}", "Entferne {skill}", "Lösche {skill}"],
        "pt": ["Desinstale o skill {skill}", "Remova {skill}", "Apague {skill}"],
    },
    "USE_SKILL": {
        "en": [
            "use the {skill} skill",
            "run {skill}",
            "invoke skill {skill}",
            "execute {skill} now",
            "use {skill} please",
            "call the {skill} skill",
            "fire {skill}",
            "run skill {skill} on this",
            "use_skill {skill}",
            "trigger the {skill} skill",
        ],
        "zh": ["使用 {skill} 技能", "运行 {skill}", "调用 {skill}"],
        "es": ["Usa el skill {skill}", "Ejecuta {skill}", "Invoca {skill}"],
        "fr": ["Utilise le skill {skill}", "Lance {skill}", "Appelle {skill}"],
        "ja": ["{skill} スキルを使って", "{skill} を実行", "{skill} を呼び出して"],
        "de": ["Nutze den Skill {skill}", "Starte {skill}", "Rufe {skill} auf"],
        "pt": ["Use o skill {skill}", "Execute {skill}", "Invoque {skill}"],
    },
    "APP": {
        "en": [
            "launch {app}",
            "relaunch {app}",
            "list installed apps",
            "list running apps",
            "register apps from {dir}",
            "create a new app for habit tracking",
            "build me an app: a dashboard for on-call shifts",
            "edit the {app} app — add a notifications panel",
            "load apps from directory {dir}",
            "relaunch {app} with verify",
            "launch app {app}",
            "show me the apps that are running",
            "create an app to track my reading",
            "scaffold a new milady app for trip planning",
        ],
        "zh": ["启动 {app}", "重启 {app}", "列出已安装的应用", "从目录 {dir} 加载应用", "创建一个新的应用：习惯追踪"],
        "es": ["Inicia {app}", "Reinicia {app}", "Lista las apps instaladas", "Carga apps desde {dir}", "Crea una nueva app para tracking de hábitos"],
        "fr": ["Lance {app}", "Redémarre {app}", "Liste les apps installées", "Charge les apps depuis {dir}", "Crée une nouvelle app pour le suivi d'habitudes"],
        "ja": ["{app} を起動", "{app} を再起動", "インストール済みアプリを一覧", "{dir} からアプリを読み込み", "新しいアプリを作成：習慣トラッカー"],
        "de": ["Starte {app}", "Starte {app} neu", "Liste die installierten Apps", "Lade Apps aus {dir}", "Erstelle eine neue App für Gewohnheits-Tracking"],
        "pt": ["Inicie {app}", "Reinicie {app}", "Liste os apps instalados", "Carregue apps de {dir}", "Crie um novo app para tracking de hábitos"],
    },
    "LIST_EJECTED_PLUGINS": {
        "en": [
            "list ejected plugins",
            "show me the ejected plugins",
            "which plugins are ejected?",
            "list local-managed plugins",
            "what plugins are ejected right now?",
            "show ejected plugins",
            "list_ejected_plugins",
            "any plugins managed locally?",
            "give me the ejected plugin list",
            "ejected plugins?",
        ],
        "zh": ["列出已弹出的插件", "显示本地管理的插件", "有哪些插件被 eject 了？"],
        "es": ["Lista los plugins ejectados", "Muestra los plugins locales", "¿Qué plugins están ejectados?"],
        "fr": ["Liste les plugins éjectés", "Quels plugins sont éjectés ?", "Affiche les plugins locaux"],
        "ja": ["イジェクトされたプラグインを一覧", "ローカル管理のプラグインを表示", "イジェクト済みのプラグインは？"],
        "de": ["Liste die ausgeworfenen Plugins", "Zeig mir die lokalen Plugins", "Welche Plugins sind ejected?"],
        "pt": ["Liste os plugins ejetados", "Mostre os plugins locais", "Quais plugins estão ejetados?"],
    },
    "PLUGIN": {
        "en": [
            "install {plug}",
            "install {plug} version {ver}",
            "eject {plug} locally",
            "sync {plug} from upstream",
            "reinject {plug}",
            "list installed plugins",
            "list ejected plugins",
            "search registry for {q}",
            "core_status please",
            "create a new plugin: a Linear bridge for the agent",
            "scaffold a plugin to expose Notion to the agent",
            "edit the {plug} plugin to add OAuth support",
            "install plugin {plug} from git",
            "search plugins: {q}",
        ],
        "zh": ["安装 {plug}", "弹出 {plug}", "同步 {plug}", "搜索插件 {q}", "创建一个新插件：Linear 桥接"],
        "es": ["Instala {plug}", "Eject {plug}", "Sincroniza {plug}", "Busca plugins: {q}", "Crea un plugin nuevo para Linear"],
        "fr": ["Installe {plug}", "Éjecte {plug}", "Synchronise {plug}", "Cherche des plugins : {q}", "Crée un nouveau plugin pour Linear"],
        "ja": ["{plug} をインストール", "{plug} をイジェクト", "{plug} を同期", "{q} のプラグインを検索", "新しいプラグインを作成：Linear ブリッジ"],
        "de": ["Installiere {plug}", "Ejecte {plug}", "Synchronisiere {plug}", "Suche Plugins: {q}", "Erstelle ein neues Plugin für Linear"],
        "pt": ["Instale {plug}", "Ejete {plug}", "Sincronize {plug}", "Busque plugins: {q}", "Crie um novo plugin para Linear"],
    },
    "CHECK_CLOUD_CREDITS": {
        "en": [
            "check my elizacloud credits",
            "how many credits do I have left?",
            "cloud credit balance please",
            "show detailed cloud credit history",
            "check_cloud_credits",
            "credits remaining?",
            "how much cloud time do I have?",
            "give me the credit transaction log",
            "what's my elizacloud balance?",
            "credit check please, with details",
        ],
        "zh": ["查看我的 elizacloud 余额", "我还有多少额度？", "显示详细的额度记录"],
        "es": ["Consulta mis créditos de elizacloud", "¿Cuántos créditos me quedan?", "Muestra el historial detallado"],
        "fr": ["Vérifie mes crédits elizacloud", "Combien de crédits il me reste ?", "Affiche l'historique détaillé"],
        "ja": ["elizacloud のクレジットを確認", "残りクレジットは？", "クレジットの詳細履歴を見せて"],
        "de": ["Prüfe meine elizacloud-Credits", "Wie viele Credits habe ich noch?", "Zeig mir den detaillierten Verlauf"],
        "pt": ["Veja meus créditos da elizacloud", "Quantos créditos restam?", "Mostre o histórico detalhado"],
    },
    "FREEZE_CLOUD_AGENT": {
        "en": [
            "freeze cloud agent {cid}",
            "snapshot and stop container {cid}",
            "freeze {cid}, confirmed",
            "pause the cloud agent {cid}",
            "freeze the cloud container {cid}",
            "snapshot agent {cid} and disconnect",
            "stop and freeze {cid}",
            "freeze_cloud_agent {cid}",
            "I'm done — freeze {cid}",
            "shutdown and snapshot {cid}",
        ],
        "zh": ["冻结云代理 {cid}", "快照并停止容器 {cid}", "暂停云代理 {cid}"],
        "es": ["Congela el agente cloud {cid}", "Toma snapshot y detén {cid}", "Pausa el agente cloud {cid}"],
        "fr": ["Gèle l'agent cloud {cid}", "Snapshot et arrête {cid}", "Mets en pause {cid}"],
        "ja": ["クラウドエージェント {cid} をフリーズ", "{cid} をスナップショットして停止", "{cid} を一時停止"],
        "de": ["Friere den Cloud-Agenten {cid} ein", "Snapshot und stoppe {cid}", "Pausiere {cid}"],
        "pt": ["Congele o agente cloud {cid}", "Tire snapshot e pare {cid}", "Pause o agente {cid}"],
    },
    "PROVISION_CLOUD_AGENT": {
        "en": [
            "deploy a cloud agent named {name}, project {proj}",
            "provision cloud agent: {name} ({proj}), confirmed",
            "spin up a cloud container for project {proj}",
            "deploy {name} to elizacloud as {proj}",
            "provision {name} on elizacloud, project_name={proj}",
            "create a cloud agent {name} with project {proj}",
            "deploy elizacloud agent {name}",
            "I want a cloud agent for {proj}",
            "provision_cloud_agent {name} {proj}",
            "spin up a cloud agent for the {proj} project",
        ],
        "zh": ["部署一个云代理 {name}，项目 {proj}", "为项目 {proj} 启动云容器", "在 elizacloud 部署 {name}"],
        "es": ["Despliega un agente cloud {name}, proyecto {proj}", "Provisiona {name} en elizacloud", "Crea un agente cloud para el proyecto {proj}"],
        "fr": ["Déploie un agent cloud {name}, projet {proj}", "Provisionne {name} sur elizacloud", "Crée un agent cloud pour {proj}"],
        "ja": ["クラウドエージェント {name} をデプロイ、プロジェクト {proj}", "{proj} 用のクラウドコンテナを起動", "elizacloud に {name} を展開"],
        "de": ["Stelle einen Cloud-Agenten {name} bereit, Projekt {proj}", "Provisioniere {name} auf elizacloud", "Erstelle einen Cloud-Agenten für {proj}"],
        "pt": ["Implante um agente cloud {name}, projeto {proj}", "Provisione {name} na elizacloud", "Crie um agente cloud para {proj}"],
    },
    "RESUME_CLOUD_AGENT": {
        "en": [
            "resume cloud agent {name} from project {proj}",
            "restore {name} ({proj}) from latest snapshot",
            "resume frozen agent {name} on elizacloud",
            "bring back the cloud agent {name}, project {proj}",
            "resume {name} from snapshot {snap}",
            "resume_cloud_agent {name} {proj}",
            "wake up cloud agent {name}",
            "restore the agent for project {proj} as {name}",
            "I want to resume {name}",
            "resume the frozen container under project {proj}",
        ],
        "zh": ["从项目 {proj} 恢复云代理 {name}", "用最新快照恢复 {name}", "唤醒冻结的云代理 {name}"],
        "es": ["Reanuda el agente cloud {name} del proyecto {proj}", "Restaura {name} desde snapshot", "Despierta el agente {name}"],
        "fr": ["Reprends l'agent cloud {name} du projet {proj}", "Restaure {name} depuis le dernier snapshot", "Réveille l'agent {name}"],
        "ja": ["プロジェクト {proj} のクラウドエージェント {name} を再開", "最新のスナップショットから {name} を復元", "{name} をウェイクアップ"],
        "de": ["Setze den Cloud-Agenten {name} aus Projekt {proj} fort", "Stelle {name} aus Snapshot wieder her", "Wecke den Agenten {name} auf"],
        "pt": ["Retome o agente cloud {name} do projeto {proj}", "Restaure {name} do último snapshot", "Acorde o agente {name}"],
    },
}


# Realistic value pools (for slot fills + argument values)
REPOS = ["elizaOS/eliza", "anthropics/claude-cookbooks", "milady/training",
         "shaw/playground", "elizaOS/plugin-twitter", "elizaOS/plugin-evm"]
SESS_IDS = ["sess-001", "sess-2026-05-01", "sess-abc123",
            "sess-bd-7e3f", "sess-rk-919", "sess-codex-44"]
THREAD_IDS = ["thr-aa-1", "thr-bb-2", "thr-cc-3", "thr-7e8f01", "thr-deploy-04"]
WORKDIRS = ["/workspace/eliza", "/home/user/repo", "/tmp/scratch",
            "/workspace/training-dashboard", "/var/projects/auth"]
WORKSPACE_IDS = ["ws-001", "ws-feature-auth", "ws-abc123", "ws-2026-05-02"]
APP_NAMES = ["companion", "homepage", "training-dashboard", "weather",
             "music-player", "things-mac", "shopify"]
PLUGIN_NAMES = ["@elizaos/plugin-twitter", "@elizaos/plugin-discord",
                "plugin-evm", "@elizaos/plugin-shell", "@elizaos/plugin-github",
                "@elizaos/plugin-solana"]
SKILL_SLUGS = ["weather", "pdf-processing", "github", "obsidian", "spotify-player",
               "calendly", "discord", "imsg", "notion", "trello", "1password",
               "things-mac", "yara-authoring", "nano-banana-pro", "tmux"]
SKILL_TOPICS = ["data analysis", "github", "calendar", "music", "imessage",
                "notes", "obsidian", "weather", "spotify", "1password",
                "todos", "design", "video", "pdfs"]
DIRECTORIES = ["/home/user/projects/companion",
               "/workspace/training-dashboard",
               "/Users/me/code/weather-app",
               "/srv/apps/homepage"]
ISSUE_NUMS = [12, 47, 88, 102, 5, 199, 421, 33]
CONTAINERS = ["cnt-prod-01", "cnt-staging-7", "cnt-test-aaa", "cnt-2026-05-02"]
PROJ_NAMES = ["habit-tracker", "trip-planner", "agent-runner", "auth-bridge",
              "ops-dashboard"]
CLOUD_NAMES = ["companion", "iris", "sage", "atlas", "lyra"]


# Style cycling — 10+
STYLES = ["direct", "formal", "casual", "expert-shorthand",
          "naive-underspecified", "voice-asr", "distracted-rambling",
          "broken-english", "self-correcting", "subtle-null", "imperative",
          "polite-question"]


def style_transform(text: str, style: str, rng: random.Random) -> str:
    """Apply a style flavor to text. Conservative — keeps semantics intact."""
    if style == "direct":
        return text
    if style == "formal":
        return text[0].upper() + text[1:] + "." if not text.endswith((".", "?", "!")) else text
    if style == "casual":
        return text.lower() + " thx"
    if style == "expert-shorthand":
        return text.replace("please ", "").replace(" please", "").replace("the ", "")
    if style == "naive-underspecified":
        return text.split(",")[0].split("—")[0].strip()
    if style == "voice-asr":
        # mimic ASR errors and run-ons
        return text.replace(".", "").replace(",", "").lower() + " uhh yeah"
    if style == "distracted-rambling":
        fillers = ["btw", "oh and", "side note —", "while we're at it"]
        return f"{rng.choice(fillers)} {text} ... actually nevermind sorry, do this: {text}"
    if style == "broken-english":
        return text.replace("the ", "").replace("'s", "").replace(", ", " ")
    if style == "self-correcting":
        return f"actually wait — scratch that. ok just {text}"
    if style == "imperative":
        return text.upper().rstrip(".") + "."
    if style == "polite-question":
        return f"would you mind — {text.rstrip('.?')}?"
    # subtle-null left as-is (callers detect and emit REPLY shape)
    return text


def random_room_meta(rng: random.Random) -> tuple[str, str]:
    return rng.choice(ROOM_KINDS), rng.choice(CHANNELS)


def random_memory(action: str, rng: random.Random, n_turns: int) -> list[dict[str, Any]]:
    """Plausible prior turns, lightly action-aware."""
    if n_turns <= 0:
        return []
    turn_pool = {
        "FINALIZE_WORKSPACE": [
            ("user", "task agent finished the auth refactor"),
            ("assistant", "Good — staged changes look clean. Ready when you are."),
            ("user", "tests are green"),
        ],
        "PROVISION_WORKSPACE": [
            ("user", "we need a sandbox for the migration work"),
            ("assistant", "I can spin one up — base branch?"),
        ],
        "SPAWN_AGENT": [
            ("user", "I want to delegate this investigation"),
            ("assistant", "Pick the framework — claude or codex?"),
        ],
        "STOP_AGENT": [
            ("user", "the codex agent is going in circles"),
            ("assistant", "Want me to terminate it?"),
        ],
        "TASK_CONTROL": [
            ("user", "I need to rethink the approach"),
            ("assistant", "OK — should I pause the active thread?"),
        ],
        "INSTALL_SKILL": [
            ("user", "I want to enable weather lookups"),
            ("assistant", "I can install the weather skill from the catalog."),
        ],
        "SEARCH_SKILLS": [
            ("user", "what skills do we have for music?"),
            ("assistant", "Let me check the catalog."),
        ],
        "USE_SKILL": [
            ("user", "give me the weather"),
            ("assistant", "I have a weather skill installed — running it now."),
        ],
        "PROVISION_CLOUD_AGENT": [
            ("user", "we need a hosted agent for the demo"),
            ("assistant", "I can deploy one to elizacloud — name and project?"),
        ],
        "FREEZE_CLOUD_AGENT": [
            ("user", "we're done with the demo container"),
            ("assistant", "Want me to snapshot and stop it?"),
        ],
        "RESUME_CLOUD_AGENT": [
            ("user", "bring back the demo agent"),
            ("assistant", "Restoring from the latest snapshot."),
        ],
    }
    fallback = [
        ("user", "hey, can you help with something?"),
        ("assistant", "Sure — what's on your mind?"),
        ("user", "let me explain"),
    ]
    pool = turn_pool.get(action, fallback)
    selected = pool[:n_turns] if len(pool) >= n_turns else (pool + fallback)[:n_turns]
    out: list[dict[str, Any]] = []
    speaker_user = rng.choice(PERSONAS)
    speaker_agent = rng.choice(AGENT_NAMES)
    channel = rng.choice(CHANNELS)
    for role, content in selected:
        out.append({
            "role": role,
            "speaker": speaker_user if role == "user" else speaker_agent,
            "content": content,
            "channel": channel,
        })
    return out


def system_prompt_for(action: str, available: list[str]) -> str:
    return (
        "You are an autonomous elizaOS agent. "
        "Decide whether the user's request maps to a known action. "
        "If it does, emit a TOON tool_calls envelope; otherwise reply with thought/text.\n\n"
        f"Available actions: {', '.join(available)}"
    )


def slot_fills(action: str, rng: random.Random, idx: int) -> dict[str, str]:
    """Return a dict of slot string substitutions for prompt template."""
    return {
        "wsid": WORKSPACE_IDS[idx % len(WORKSPACE_IDS)],
        "repo": REPOS[idx % len(REPOS)],
        "issue": str(ISSUE_NUMS[idx % len(ISSUE_NUMS)]),
        "sess": SESS_IDS[idx % len(SESS_IDS)],
        "tid": THREAD_IDS[idx % len(THREAD_IDS)],
        "wd": WORKDIRS[idx % len(WORKDIRS)],
        "skill": SKILL_SLUGS[idx % len(SKILL_SLUGS)],
        "topic": SKILL_TOPICS[idx % len(SKILL_TOPICS)],
        "app": APP_NAMES[idx % len(APP_NAMES)],
        "dir": DIRECTORIES[idx % len(DIRECTORIES)],
        "plug": PLUGIN_NAMES[idx % len(PLUGIN_NAMES)],
        "ver": ["latest", "1.2.3", "alpha", "0.9.5"][idx % 4],
        "q": ["calendar", "music", "github", "twitter", "evm"][idx % 5],
        "cid": CONTAINERS[idx % len(CONTAINERS)],
        "name": CLOUD_NAMES[idx % len(CLOUD_NAMES)],
        "proj": PROJ_NAMES[idx % len(PROJ_NAMES)],
        "snap": ["snap-20260501-aa", "snap-20260428-7c", "snap-latest"][idx % 3],
    }


# ─── argument builders per action ─────────────────────────────────────────

def build_args_finalize_workspace(idx: int, rng: random.Random) -> dict[str, Any]:
    args: dict[str, Any] = {}
    sub = idx % 6
    if sub == 0:
        # PR with all fields
        args["workspaceId"] = WORKSPACE_IDS[idx % len(WORKSPACE_IDS)]
        args["commitMessage"] = ["fix: handle null user", "feat: add export endpoint",
                                  "chore: bump deps", "docs: update README"][idx % 4]
        args["prTitle"] = ["Refactor auth flow", "Add export endpoint",
                            "Cleanup unused imports", "Migrate cold storage"][idx % 4]
        args["prBody"] = "## Summary\n- Implements the change.\n## Test\n- bun run test"
        args["baseBranch"] = ["main", "develop"][idx % 2]
    elif sub == 1:
        args["workspaceId"] = WORKSPACE_IDS[idx % len(WORKSPACE_IDS)]
        args["skipPR"] = True
        args["commitMessage"] = "chore: stage WIP for review"
    elif sub == 2:
        args["draft"] = True
        args["prTitle"] = "Draft: WIP refactor"
        args["baseBranch"] = "main"
    elif sub == 3:
        args["commitMessage"] = "fix: regression in token refresh"
        args["prTitle"] = "Fix: token refresh regression"
        args["baseBranch"] = "develop"
    elif sub == 4:
        args["skipPR"] = True
    else:
        args["prTitle"] = "Add feature X"
        args["baseBranch"] = "main"
    return args


def build_args_list_agents(idx: int, rng: random.Random) -> dict[str, Any]:
    return {}


def build_args_manage_issues(idx: int, rng: random.Random) -> dict[str, Any]:
    op = ["create", "list", "get", "comment", "close", "reopen", "update", "add_labels"][idx % 8]
    args: dict[str, Any] = {"operation": op, "repo": REPOS[idx % len(REPOS)]}
    if op == "create":
        args["title"] = ["Auth flow regression", "Add export endpoint",
                         "Migration plan for Q2", "RFC: typed events"][idx % 4]
        args["body"] = ["Reproduces on staging when user lacks email.",
                        "We should expose CSV exports for admin users.",
                        "Proposal to migrate cold storage to R2 in Q2."][idx % 3]
        if idx % 3 == 0:
            args["labels"] = ["bug,urgent", "enhancement", "good-first-issue"][idx % 3]
    elif op == "list":
        args["state"] = ["open", "closed", "all"][idx % 3]
    elif op == "get":
        args["issueNumber"] = ISSUE_NUMS[idx % len(ISSUE_NUMS)]
    elif op == "comment":
        args["issueNumber"] = ISSUE_NUMS[idx % len(ISSUE_NUMS)]
        args["body"] = ["fixed in PR 88", "blocked on review", "ready to merge"][idx % 3]
    elif op == "close":
        args["issueNumber"] = ISSUE_NUMS[idx % len(ISSUE_NUMS)]
    elif op == "reopen":
        args["issueNumber"] = ISSUE_NUMS[idx % len(ISSUE_NUMS)]
    elif op == "update":
        args["issueNumber"] = ISSUE_NUMS[idx % len(ISSUE_NUMS)]
        args["title"] = "p0: token refresh broken"
    elif op == "add_labels":
        args["issueNumber"] = ISSUE_NUMS[idx % len(ISSUE_NUMS)]
        args["labels"] = "bug,urgent"
    return args


def build_args_provision_workspace(idx: int, rng: random.Random) -> dict[str, Any]:
    sub = idx % 5
    args: dict[str, Any] = {}
    if sub == 0:
        args["repo"] = "https://github.com/" + REPOS[idx % len(REPOS)] + ".git"
        args["baseBranch"] = "main"
    elif sub == 1:
        args["repo"] = "https://github.com/" + REPOS[idx % len(REPOS)] + ".git"
        args["baseBranch"] = "develop"
    elif sub == 2:
        args["useWorktree"] = True
        args["parentWorkspaceId"] = WORKSPACE_IDS[idx % len(WORKSPACE_IDS)]
    elif sub == 3:
        args["repo"] = "https://github.com/" + REPOS[idx % len(REPOS)] + ".git"
        args["useWorktree"] = True
    else:
        args["useWorktree"] = True
    return args


def build_args_send_to_agent(idx: int, rng: random.Random) -> dict[str, Any]:
    sub = idx % 6
    args: dict[str, Any] = {}
    if sub == 0:
        args["sessionId"] = SESS_IDS[idx % len(SESS_IDS)]
        args["input"] = "yes, continue"
    elif sub == 1:
        args["input"] = ["use option B", "skip this step", "accept the changes"][idx % 3]
    elif sub == 2:
        args["sessionId"] = SESS_IDS[idx % len(SESS_IDS)]
        args["keys"] = ["Enter", "Ctrl-C", "y"][idx % 3]
    elif sub == 3:
        args["task"] = ["audit the build pipeline for slow steps",
                        "draft a release note for v2.4",
                        "investigate the failing test in apps/app"][idx % 3]
        args["label"] = ["audit", "release-notes", "investigation"][idx % 3]
    elif sub == 4:
        args["sessionId"] = SESS_IDS[idx % len(SESS_IDS)]
        args["task"] = "continue from where you left off"
    else:
        args["keys"] = "Enter"
    return args


def build_args_spawn_agent(idx: int, rng: random.Random) -> dict[str, Any]:
    sub = idx % 6
    args: dict[str, Any] = {}
    framework = ["claude", "codex", "gemini", "aider", "shell", "pi"][sub]
    if sub != 5:
        args["agentType"] = framework
    args["workdir"] = WORKDIRS[idx % len(WORKDIRS)]
    args["task"] = ["investigate the failing test in apps/app",
                     "draft a release note for v2.4",
                     "audit the build pipeline for slow steps",
                     "document the new auth middleware",
                     "summarize the staging logs",
                     "rebase on develop and resolve conflicts"][idx % 6]
    if sub % 3 == 0:
        args["memoryContent"] = ["You are working in a TypeScript monorepo. Use bun, not npm.",
                                   "Style: keep changes minimal; no broad refactors.",
                                   "When done, emit DONE on its own line."][idx % 3]
    if sub == 4:
        args["approvalPreset"] = "readonly"
    return args


def build_args_stop_agent(idx: int, rng: random.Random) -> dict[str, Any]:
    sub = idx % 4
    if sub == 0:
        return {"sessionId": SESS_IDS[idx % len(SESS_IDS)]}
    if sub == 1:
        return {"all": True}
    if sub == 2:
        return {"sessionId": SESS_IDS[idx % len(SESS_IDS)], "all": False}
    return {}


def build_args_task_control(idx: int, rng: random.Random) -> dict[str, Any]:
    op = ["pause", "stop", "resume", "continue", "archive", "reopen"][idx % 6]
    args: dict[str, Any] = {"operation": op}
    sel = idx % 3
    if sel == 0:
        args["threadId"] = THREAD_IDS[idx % len(THREAD_IDS)]
    elif sel == 1:
        args["sessionId"] = SESS_IDS[idx % len(SESS_IDS)]
    else:
        args["search"] = ["auth flow", "migration", "release notes",
                          "build-pipeline audit"][idx % 4]
    if op in ("pause", "stop"):
        args["note"] = ["paused while waiting on review",
                        "stopping due to flaky test",
                        "user wants to redirect"][idx % 3]
    elif op in ("resume", "continue"):
        args["instruction"] = ["focus on the failing tests first",
                                "draft the PR with the changes so far",
                                "investigate the staging logs"][idx % 3]
        if idx % 4 == 0:
            args["agentType"] = ["claude", "codex"][idx % 2]
    return args


def build_args_task_history(idx: int, rng: random.Random) -> dict[str, Any]:
    metric = ["list", "count", "detail"][idx % 3]
    args: dict[str, Any] = {"metric": metric}
    if metric == "detail":
        # detail typically needs identifying info
        args["search"] = ["auth flow", "migration", "release notes"][idx % 3]
    else:
        if idx % 2 == 0:
            args["window"] = ["last-7-days", "last-30-days", "today",
                               "yesterday", "this-week"][idx % 5]
        if idx % 3 == 0:
            args["search"] = ["release notes", "auth flow", "migration"][idx % 3]
        if idx % 4 == 0:
            args["statuses"] = [["active"], ["completed"],
                                 ["paused", "active"], ["archived"]][idx % 4]
        if idx % 5 == 0:
            args["limit"] = [25, 50, 100][idx % 3]
        if idx % 6 == 0:
            args["includeArchived"] = True
    return args


def build_args_task_share(idx: int, rng: random.Random) -> dict[str, Any]:
    sel = idx % 3
    if sel == 0:
        return {"threadId": THREAD_IDS[idx % len(THREAD_IDS)]}
    if sel == 1:
        return {"sessionId": SESS_IDS[idx % len(SESS_IDS)]}
    return {"search": ["release notes", "auth flow", "migration",
                       "build-pipeline audit"][idx % 4]}


def build_args_get_skill_details(idx: int, rng: random.Random) -> dict[str, Any]:
    return {"skill": SKILL_SLUGS[idx % len(SKILL_SLUGS)]}


def build_args_install_skill(idx: int, rng: random.Random) -> dict[str, Any]:
    return {"skill": SKILL_SLUGS[idx % len(SKILL_SLUGS)]}


def build_args_search_skills(idx: int, rng: random.Random) -> dict[str, Any]:
    return {"query": SKILL_TOPICS[idx % len(SKILL_TOPICS)]}


def build_args_sync_skill_catalog(idx: int, rng: random.Random) -> dict[str, Any]:
    return {}


def build_args_toggle_skill(idx: int, rng: random.Random) -> dict[str, Any]:
    enable = idx % 2 == 0
    return {"skill": SKILL_SLUGS[idx % len(SKILL_SLUGS)],
            "enabled": enable}


def build_args_uninstall_skill(idx: int, rng: random.Random) -> dict[str, Any]:
    return {"skill": SKILL_SLUGS[idx % len(SKILL_SLUGS)]}


def build_args_use_skill(idx: int, rng: random.Random) -> dict[str, Any]:
    return {"skill": SKILL_SLUGS[idx % len(SKILL_SLUGS)]}


def build_args_app(idx: int, rng: random.Random) -> dict[str, Any]:
    # spread across 5 modes: launch | relaunch | load_from_directory | list | create
    mode = ["launch", "relaunch", "load_from_directory", "list", "create"][idx % 5]
    args: dict[str, Any] = {"mode": mode}
    if mode == "launch":
        args["app"] = APP_NAMES[idx % len(APP_NAMES)]
    elif mode == "relaunch":
        args["app"] = APP_NAMES[idx % len(APP_NAMES)]
        if idx % 3 == 0:
            args["verify"] = True
        if idx % 4 == 0:
            args["workdir"] = WORKDIRS[idx % len(WORKDIRS)]
    elif mode == "load_from_directory":
        args["directory"] = DIRECTORIES[idx % len(DIRECTORIES)]
    elif mode == "list":
        pass
    elif mode == "create":
        sel = idx % 3
        if sel == 0:
            args["intent"] = ["a habit-tracker app for daily routines",
                              "a dashboard for monitoring on-call shifts",
                              "a Spotify-like player wrapper",
                              "an app to track my reading"][idx % 4]
        elif sel == 1:
            args["editTarget"] = APP_NAMES[idx % len(APP_NAMES)]
            args["intent"] = "add a notifications panel"
        else:
            args["choice"] = ["new", "edit-1", "cancel"][idx % 3]
            args["intent"] = "scaffold a new milady app"
    return args


def build_args_list_ejected_plugins(idx: int, rng: random.Random) -> dict[str, Any]:
    return {}


def build_args_plugin(idx: int, rng: random.Random) -> dict[str, Any]:
    # 9 modes: install | eject | sync | reinject | list | list_ejected | search | core_status | create
    mode = ["install", "eject", "sync", "reinject", "list",
            "list_ejected", "search", "core_status", "create"][idx % 9]
    args: dict[str, Any] = {"mode": mode}
    if mode == "install":
        args["name"] = PLUGIN_NAMES[idx % len(PLUGIN_NAMES)]
        if idx % 3 == 0:
            args["version"] = ["latest", "1.2.3", "alpha"][idx % 3]
        if idx % 4 == 0:
            args["source"] = "git"
            args["url"] = "https://github.com/elizaOS-plugins/" + PLUGIN_NAMES[idx % len(PLUGIN_NAMES)].split("/")[-1] + ".git"
    elif mode in ("eject", "sync", "reinject"):
        args["name"] = PLUGIN_NAMES[idx % len(PLUGIN_NAMES)]
    elif mode == "search":
        args["query"] = ["calendar", "music", "github", "twitter", "evm"][idx % 5]
    elif mode == "create":
        sel = idx % 3
        if sel == 0:
            args["intent"] = ["a Linear bridge for the agent",
                              "a plugin that exposes Notion to the agent",
                              "a plugin for Anki flashcard sync"][idx % 3]
        elif sel == 1:
            args["editTarget"] = PLUGIN_NAMES[idx % len(PLUGIN_NAMES)]
            args["intent"] = "add OAuth support"
        else:
            args["choice"] = ["new", "edit-1", "cancel"][idx % 3]
            args["intent"] = "scaffold a new plugin"
    return args


def build_args_check_cloud_credits(idx: int, rng: random.Random) -> dict[str, Any]:
    if idx % 2 == 0:
        return {}
    return {"detailed": True}


def build_args_freeze_cloud_agent(idx: int, rng: random.Random) -> dict[str, Any]:
    args: dict[str, Any] = {"containerId": CONTAINERS[idx % len(CONTAINERS)]}
    if idx % 3 != 0:
        args["confirmed"] = True
    return args


def build_args_provision_cloud_agent(idx: int, rng: random.Random) -> dict[str, Any]:
    args: dict[str, Any] = {
        "name": CLOUD_NAMES[idx % len(CLOUD_NAMES)],
        "project_name": PROJ_NAMES[idx % len(PROJ_NAMES)],
    }
    sel = idx % 5
    if sel == 0:
        args["description"] = ["staging demo agent", "production runner",
                                "research sandbox"][idx % 3]
    elif sel == 1:
        args["environment_vars"] = [{"NODE_ENV": "production"},
                                      {"LOG_LEVEL": "debug", "PORT": "3000"},
                                      {"ANTHROPIC_API_KEY": "<redacted>"}][idx % 3]
    elif sel == 2:
        args["auto_backup"] = idx % 2 == 0
    if idx % 3 != 0:
        args["confirmed"] = True
    return args


def build_args_resume_cloud_agent(idx: int, rng: random.Random) -> dict[str, Any]:
    args: dict[str, Any] = {
        "name": CLOUD_NAMES[idx % len(CLOUD_NAMES)],
        "project_name": PROJ_NAMES[idx % len(PROJ_NAMES)],
    }
    sel = idx % 4
    if sel == 0:
        args["snapshotId"] = ["snap-20260501-aa", "snap-20260428-7c", "snap-latest"][idx % 3]
    elif sel == 1:
        args["environment_vars"] = [{"NODE_ENV": "production"},
                                      {"LOG_LEVEL": "info"}][idx % 2]
    if idx % 3 != 0:
        args["confirmed"] = True
    return args


ARG_BUILDERS = {
    "FINALIZE_WORKSPACE": build_args_finalize_workspace,
    "LIST_AGENTS": build_args_list_agents,
    "MANAGE_ISSUES": build_args_manage_issues,
    "PROVISION_WORKSPACE": build_args_provision_workspace,
    "SEND_TO_AGENT": build_args_send_to_agent,
    "SPAWN_AGENT": build_args_spawn_agent,
    "STOP_AGENT": build_args_stop_agent,
    "TASK_CONTROL": build_args_task_control,
    "TASK_HISTORY": build_args_task_history,
    "TASK_SHARE": build_args_task_share,
    "GET_SKILL_DETAILS": build_args_get_skill_details,
    "INSTALL_SKILL": build_args_install_skill,
    "SEARCH_SKILLS": build_args_search_skills,
    "SYNC_SKILL_CATALOG": build_args_sync_skill_catalog,
    "TOGGLE_SKILL": build_args_toggle_skill,
    "UNINSTALL_SKILL": build_args_uninstall_skill,
    "USE_SKILL": build_args_use_skill,
    "APP": build_args_app,
    "LIST_EJECTED_PLUGINS": build_args_list_ejected_plugins,
    "PLUGIN": build_args_plugin,
    "CHECK_CLOUD_CREDITS": build_args_check_cloud_credits,
    "FREEZE_CLOUD_AGENT": build_args_freeze_cloud_agent,
    "PROVISION_CLOUD_AGENT": build_args_provision_cloud_agent,
    "RESUME_CLOUD_AGENT": build_args_resume_cloud_agent,
}


def expand_template(template: str, slots: dict[str, str]) -> str:
    """Substitute {slot} placeholders that exist in `slots`."""
    out = template
    for k, v in slots.items():
        out = out.replace("{" + k + "}", v)
    return out


def filter_args_by_message(args: dict[str, Any], user_msg: str,
                           action: str, optional_keys: set[str]) -> dict[str, Any]:
    """For the 'subtle-null' / 'naive-underspecified' style: drop optional
    args that aren't visibly referenced in the user message. Required keys
    stay regardless. Used to exercise omission of unmentioned optionals.
    """
    msg = user_msg.lower()
    out: dict[str, Any] = {}
    for k, v in args.items():
        if k not in optional_keys:
            out[k] = v
            continue
        # heuristic: keep optional only if user message contains a hint
        # tied to the value or the key
        keyhint = k.lower()
        valhint = ""
        if isinstance(v, str):
            valhint = v.lower()
        elif isinstance(v, bool):
            valhint = "yes" if v else ""
        if keyhint in msg or (valhint and valhint in msg):
            out[k] = v
    return out


# Optional-keys map by action — required keys per catalog stay in always.
REQUIRED_KEYS: dict[str, set[str]] = {
    "MANAGE_ISSUES": {"operation", "repo"},
    "TASK_CONTROL": {"operation"},
    "APP": {"mode"},
    "PLUGIN": {"mode"},
    "FREEZE_CLOUD_AGENT": {"containerId"},
    "PROVISION_CLOUD_AGENT": {"name", "project_name"},
    "RESUME_CLOUD_AGENT": {"name", "project_name"},
}


def make_record(
    *,
    encoder: ExpectedResponseEncoder,
    action: str,
    plugin: str,
    description: str,
    parameters: list[dict] | None,
    user_msg: str,
    args: dict[str, Any],
    rng: random.Random,
    lang: str,
    style: str,
    memory_n: int,
    is_subtle_null: bool,
) -> dict[str, Any]:
    available = [action, ACTION_REPLY, ACTION_IGNORE]
    sys_prompt = system_prompt_for(action, available)

    if is_subtle_null:
        # emit a thought/text REPLY shape — model should clarify rather than
        # tool-call.
        expected_obj = {
            "thought": "The user's message is too vague to invoke a tool — clarify before calling.",
            "text": "Could you clarify what exactly you'd like me to do?",
        }
        expected_str = encoder.encode(expected_obj)
        avail_for_meta = [ACTION_REPLY, ACTION_IGNORE]
    else:
        expected_obj = {
            "tool_calls": [{
                "name": action,
                "arguments": args,
            }],
        }
        expected_str = encoder.encode(expected_obj)
        avail_for_meta = available

    speaker = rng.choice(PERSONAS)
    agent_id = "agent"
    _, channel = random_room_meta(rng)
    memory = random_memory(action, rng, memory_n)
    room = stable_id("agent-orch-gen", action, user_msg, speaker, str(rng.random()))[:12]

    tool_spec = {
        "name": action,
        "description": description,
        "parameters": parameters or [],
    }

    extra_md = {
        "system_prompt": sys_prompt,
        "toolSpecs": [tool_spec],
        "synth_origin": "agent-orch-gen",
        "synth_action": action,
        "synth_plugin": plugin,
        "synth_lang": lang,
        "synth_style": style,
    }
    if not is_subtle_null:
        extra_md["expected_tool_calls"] = [{"name": action, "arguments": args}]

    rec = build(
        roomName=room,
        agentId=agent_id,
        memoryEntries=memory,
        currentMessage={
            "role": "user",
            "speaker": speaker,
            "content": user_msg,
            "channel": channel,
        },
        expectedResponse=expected_str,
        availableActions=avail_for_meta,
        task_type="tool_call",
        source_dataset="synth-agent-orch",
        license="synthetic",
        split="train",
        extra_metadata=extra_md,
    )
    return rec.to_dict()


def gen_for_action(encoder: ExpectedResponseEncoder, rng: random.Random,
                   action_meta: dict, n: int) -> Iterable[dict]:
    """Generate n records for one action."""
    action = action_meta["name"]
    plugin = action_meta.get("plugin", "")
    description = action_meta.get("description", "")
    parameters = action_meta.get("parameters") or []

    phrase_table = LANG_PHRASE_TABLE.get(action, {})
    en_pool = phrase_table.get("en") or [f"please run {action.lower().replace('_', ' ')}"]
    nonen_pools = {lang: phrase_table.get(lang, []) for lang in NON_EN_LANGS}

    # Lang plan: 70 en + 5 each of zh/es/fr/ja/de/pt = 100.
    lang_plan: list[str] = ["en"] * 70
    for lang in NON_EN_LANGS:
        lang_plan.extend([lang] * 5)
    rng.shuffle(lang_plan)

    # Memory plan: 30 empty, 50 with 1-2 turns, 20 with 3 turns.
    mem_plan: list[int] = []
    mem_plan += [0] * 30
    for i in range(50):
        mem_plan.append(1 if i % 2 == 0 else 2)
    mem_plan += [3] * 20
    rng.shuffle(mem_plan)

    # Subtle-null plan: pick ~7% (capped at 8) of indices to be subtle-null
    # clarifies. For small n in smoke runs use fewer.
    null_target = max(0, min(8, int(round(n * 0.07))))
    null_indices = set(rng.sample(range(n), null_target)) if null_target > 0 else set()

    builder = ARG_BUILDERS.get(action)
    if builder is None:
        raise RuntimeError(f"no arg builder for {action}")
    optional_keys: set[str] = set()
    for p in parameters:
        if not p.get("required"):
            optional_keys.add(p["name"])

    for i in range(n):
        lang = lang_plan[i % len(lang_plan)]
        mem_n = mem_plan[i % len(mem_plan)]

        # Pick a phrasing template from the right language pool;
        # fall back to en if the non-en pool is short.
        if lang == "en":
            template = en_pool[i % len(en_pool)]
        else:
            pool = nonen_pools[lang] or en_pool
            template = pool[i % len(pool)]

        slots = slot_fills(action, rng, i)
        user_msg = expand_template(template, slots)

        # Style choice; cycle to ensure >=10 styles per action.
        is_subtle_null = i in null_indices
        if is_subtle_null:
            style = "subtle-null"
            # Make the message intentionally vague — drop slot-fills to a stub.
            stubs_en = [
                "do the thing",
                "handle it",
                "you know what to do",
                "fix it for me",
                "go ahead",
                "yeah do that",
                "uh, the usual",
            ]
            stubs_other = {
                "zh": "处理一下", "es": "haz lo de siempre",
                "fr": "fais le truc", "ja": "あれやって",
                "de": "mach das übliche", "pt": "faz a parada",
            }
            user_msg = stubs_en[i % len(stubs_en)] if lang == "en" else stubs_other.get(lang, stubs_en[i % len(stubs_en)])
        else:
            style = STYLES[i % len(STYLES)]
            if style == "subtle-null":
                style = "direct"  # avoid double-tagging; subtle-null reserved
            if lang == "en":
                user_msg = style_transform(user_msg, style, rng)

        # Build args; for naive-underspecified, drop optional keys not
        # mentioned in the user message.
        full_args = builder(i, rng)
        if style == "naive-underspecified":
            full_args = filter_args_by_message(
                full_args, user_msg, action, optional_keys)

        yield make_record(
            encoder=encoder,
            action=action,
            plugin=plugin,
            description=description,
            parameters=parameters,
            user_msg=user_msg,
            args=full_args,
            rng=rng,
            lang=lang,
            style=style,
            memory_n=mem_n,
            is_subtle_null=is_subtle_null,
        )


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
                    help="examples per action (default: 100)")
    ap.add_argument("--seed", type=int, default=0xA60CE_2026)
    args = ap.parse_args()

    rng = random.Random(args.seed)

    catalog = json.loads(ACTIONS_PATH.read_text(encoding="utf-8"))
    actions_by_name: dict[str, dict] = {a["name"]: a for a in catalog["actions"]}
    missing = [n for n in TARGET_ACTIONS if n not in actions_by_name]
    if missing:
        log.error("missing target actions in catalog: %s", missing)
        return 1

    encoder = JsonExpectedResponseEncoder()
    counts: dict[str, int] = {}
    all_records: list[dict] = []

    try:
        for action_name in TARGET_ACTIONS:
            meta = actions_by_name[action_name]
            recs = list(gen_for_action(encoder, rng, meta, args.per_action))
            counts[action_name] = len(recs)
            log.info("  %-28s -> %d records", action_name, len(recs))
            all_records.extend(recs)

        n = write_jsonl(all_records, OUT_PATH)
        log.info("wrote %d records -> %s", n, OUT_PATH)
        log.info("counts: %s", counts)
    finally:
        encoder.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
