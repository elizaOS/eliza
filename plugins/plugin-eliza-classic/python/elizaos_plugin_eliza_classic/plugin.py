from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from elizaos_plugin_eliza_classic.types import ElizaConfig


@dataclass(frozen=True)
class ScriptRule:
    decomposition: str
    reassembly: list[str]


@dataclass(frozen=True)
class KeywordEntry:
    keyword: list[str]
    precedence: int
    rules: list[ScriptRule]
    memory: list[ScriptRule] = field(default_factory=list)


@dataclass(frozen=True)
class DoctorScript:
    greetings: list[str]
    goodbyes: list[str]
    default: list[str]
    reflections: dict[str, str]
    substitutions: dict[str, str]
    groups: dict[str, list[str]]
    keywords: list[KeywordEntry]


@dataclass
class SessionState:
    limit: int = 1
    memories: list[str] = field(default_factory=list)
    reassembly_index: dict[str, int] = field(default_factory=dict)


def _load_doctor_json() -> DoctorScript:
    # Prefer canonical shared doctor.json in-repo; fall back to package data if installed.
    here = Path(__file__).resolve()
    shared = here.parents[2] / "shared" / "doctor.json"
    if shared.exists():
        raw = shared.read_text(encoding="utf-8")
    else:
        data_path = here.parent / "data" / "doctor.json"
        if not data_path.exists():
            raise FileNotFoundError("doctor.json not found in repo or package data")
        raw = data_path.read_text(encoding="utf-8")

    import json

    parsed = json.loads(raw)
    keywords: list[KeywordEntry] = []
    for entry in parsed["keywords"]:
        rules = [
            ScriptRule(
                decomposition=r["decomposition"], reassembly=list(r["reassembly"])
            )
            for r in entry["rules"]
        ]
        memory_rules = [
            ScriptRule(
                decomposition=r["decomposition"], reassembly=list(r["reassembly"])
            )
            for r in entry.get("memory", [])
        ]
        keywords.append(
            KeywordEntry(
                keyword=list(entry["keyword"]),
                precedence=int(entry["precedence"]),
                rules=rules,
                memory=memory_rules,
            )
        )

    return DoctorScript(
        greetings=list(parsed["greetings"]),
        goodbyes=list(parsed["goodbyes"]),
        default=list(parsed["default"]),
        reflections=dict(parsed["reflections"]),
        substitutions=dict(parsed.get("substitutions", {})),
        groups={k: list(v) for k, v in parsed["groups"].items()},
        keywords=keywords,
    )


_SCRIPT = _load_doctor_json()
_KEYWORD_INDEX: dict[str, KeywordEntry] = {
    w.lower(): entry for entry in _SCRIPT.keywords for w in entry.keyword
}


def reflect(text: str) -> str:
    words = text.lower().split()
    reflected = [_SCRIPT.reflections.get(word, word) for word in words]
    return " ".join(reflected)


def _normalize_raw_input(input_text: str) -> str:
    s = input_text.strip()
    s = re.sub(r"[!?;:]+", " ", s)
    s = s.replace("\u2018", "'").replace("\u2019", "'")
    s = re.sub(r"\s+", " ", s)
    return s


def _tokenize_words(text: str) -> list[str]:
    cleaned = _normalize_raw_input(text)
    cleaned = re.sub(r'[.,"()]', " ", cleaned).lower()
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return []
    canon = {"dont", "cant", "wont", "dreamed", "dreams", "mom", "dad"}
    out: list[str] = []
    for w in cleaned.split(" "):
        if w in canon:
            out.append(_SCRIPT.substitutions.get(w) or _SCRIPT.reflections.get(w, w))
        else:
            out.append(w)
    return out


def _tokenize_for_scan(text: str) -> list[str]:
    cleaned = _normalize_raw_input(text)
    cleaned = re.sub(r"[.,]", " | ", cleaned)
    cleaned = re.sub(r'["()]', " ", cleaned).lower()
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return []
    canon = {"dont", "cant", "wont", "dreamed", "dreams", "mom", "dad"}
    out: list[str] = []
    for w in cleaned.split(" "):
        if w in canon:
            out.append(_SCRIPT.substitutions.get(w) or _SCRIPT.reflections.get(w, w))
        else:
            out.append(w)
    return out


def _split_into_clauses(words: list[str]) -> list[list[str]]:
    clauses: list[list[str]] = []
    current: list[str] = []
    for w in words:
        if w == "|" or w == "but":
            if current:
                clauses.append(current)
            current = []
            continue
        current.append(w)
    if current:
        clauses.append(current)
    return clauses


def _substitute_words_for_matching(words: list[str]) -> list[str]:
    out: list[str] = []
    for w in words:
        key = w.lower()
        mapped = _SCRIPT.substitutions.get(key) or _SCRIPT.reflections.get(key)
        if not mapped:
            out.append(key)
            continue
        parts = [p for p in mapped.lower().split() if p]
        out.extend(parts if parts else [key])
    return out


TokenKind = Literal["wildcard", "literal", "alt", "group"]


@dataclass(frozen=True)
class Token:
    kind: TokenKind
    value: str | None = None
    options: list[str] | None = None


def _parse_decomposition(pattern: str) -> list[Token]:
    raw = " ".join(pattern.strip().split()).lower()
    if not raw:
        return []
    tokens: list[Token] = []
    i = 0
    while i < len(raw):
        while i < len(raw) and raw[i] == " ":
            i += 1
        if i >= len(raw):
            break
        ch = raw[i]
        if ch == "*":
            tokens.append(Token(kind="wildcard"))
            i += 1
            continue
        if ch == "@":
            j = i + 1
            while j < len(raw) and raw[j] != " ":
                j += 1
            group = raw[i + 1 : j].strip()
            if group:
                tokens.append(Token(kind="group", value=group))
            i = j
            continue
        if ch == "[":
            close = raw.find("]", i + 1)
            if close == -1:
                rest = raw[i:].strip()
                if rest:
                    tokens.append(Token(kind="literal", value=rest))
                break
            inside = raw[i + 1 : close].strip()
            opts = inside.split() if inside else []
            tokens.append(Token(kind="alt", options=opts))
            i = close + 1
            continue
        # literal
        j = i
        while j < len(raw) and raw[j] != " ":
            j += 1
        word = raw[i:j].strip()
        if word:
            tokens.append(Token(kind="literal", value=word))
        i = j
    return tokens


def _token_matches_word(token: Token, word: str) -> bool:
    if token.kind == "literal":
        return token.value == word
    if token.kind == "alt":
        return word in (token.options or [])
    if token.kind == "group":
        group_words = _SCRIPT.groups.get(token.value or "")
        return word in group_words if group_words else False
    return False


def _match_decomposition(tokens: list[Token], words: list[str]) -> list[str] | None:
    parts = [""] * len(tokens)

    def backtrack(ti: int, wi: int) -> bool:
        if ti == len(tokens):
            return wi == len(words)
        token = tokens[ti]
        if token.kind == "wildcard":
            for end in range(wi, len(words) + 1):
                parts[ti] = " ".join(words[wi:end]).strip()
                if backtrack(ti + 1, end):
                    return True
            return False
        if wi >= len(words):
            return False
        w = words[wi]
        if not _token_matches_word(token, w):
            return False
        parts[ti] = w
        return backtrack(ti + 1, wi + 1)

    if not backtrack(0, 0):
        return None
    return parts


def _apply_reassembly(template: str, parts: list[str]) -> str:
    def repl(m: re.Match[str]) -> str:
        n = int(m.group(1))
        if n <= 0 or n > len(parts):
            return ""
        return reflect(parts[n - 1])

    out = re.sub(r"\$(\d+)", repl, template)
    out = re.sub(r"\$\d+", "that", out)
    return re.sub(r"\s+", " ", out).strip()


def _stable_key(keyword: str, rule: ScriptRule, rule_index: int) -> str:
    return f"{keyword}::{rule_index}::{rule.decomposition}"


def _pick_next_reassembly(
    state: SessionState, keyword: str, rule: ScriptRule, idx: int
) -> str:
    key = _stable_key(keyword, rule, idx)
    current = state.reassembly_index.get(key, 0)
    if not rule.reassembly:
        return ""
    pick = rule.reassembly[current % len(rule.reassembly)]
    state.reassembly_index[key] = (current + 1) % max(1, len(rule.reassembly))
    return pick


def _compute_word_hash(word: str) -> int:
    h = 0
    for ch in word:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return h


def _choose_default(state: SessionState) -> str:
    if state.limit == 4 and state.memories:
        return state.memories.pop(0)
    idx = state.reassembly_index.get("__default__", 0)
    state.reassembly_index["__default__"] = idx + 1
    return _SCRIPT.default[idx % len(_SCRIPT.default)]


def _is_goodbye(words: list[str]) -> bool:
    if not words:
        return False
    first = words[0]
    for g in _SCRIPT.goodbyes:
        gw = _tokenize_words(g)
        if gw and gw[0] == first:
            return True
    return False


def _resolve_redirect(s: str) -> str | None:
    t = s.strip()
    if not t.startswith("="):
        return None
    k = t[1:].strip().lower()
    return k if k else None


def _is_newkey(s: str) -> bool:
    t = s.strip().lower()
    return t == ":newkey" or t == "newkey"


def _parse_pre(s: str) -> tuple[str, str] | None:
    m = re.match(r"^:pre\s+(.+?)\s+\(=\s*([^)]+)\s*\)\s*$", s.strip(), re.IGNORECASE)
    if not m:
        return None
    pre_text = m.group(1).strip()
    redirect = m.group(2).strip().lower()
    if not pre_text or not redirect:
        return None
    return pre_text, redirect


RuleEval = Literal["no_match", "newkey", "redirect", "pre", "response"]


@dataclass(frozen=True)
class RuleResult:
    kind: RuleEval
    text: str | None = None
    redirect: str | None = None
    pre_text: str | None = None
    parts: list[str] | None = None


def _try_rules(
    state: SessionState, keyword: str, entry: KeywordEntry, words: list[str]
) -> RuleResult:
    for idx, rule in enumerate(entry.rules):
        tokens = _parse_decomposition(rule.decomposition)
        parts = _match_decomposition(tokens, words)
        if parts is None:
            continue
        picked = _pick_next_reassembly(state, keyword, rule, idx)
        if _is_newkey(picked):
            return RuleResult(kind="newkey")
        pre = _parse_pre(picked)
        if pre:
            pre_text, redirect = pre
            return RuleResult(
                kind="pre", pre_text=pre_text, redirect=redirect, parts=parts
            )
        redirect = _resolve_redirect(picked)
        if redirect:
            return RuleResult(kind="redirect", redirect=redirect)
        return RuleResult(kind="response", text=_apply_reassembly(picked, parts))
    return RuleResult(kind="no_match")


def _maybe_record_memory(
    state: SessionState, entry: KeywordEntry, words: list[str]
) -> None:
    if not entry.memory:
        return
    last = words[-1] if words else ""
    chosen = entry.memory[_compute_word_hash(last) % len(entry.memory)]
    tokens = _parse_decomposition(chosen.decomposition)
    parts = _match_decomposition(tokens, words)
    if parts is None:
        return
    ridx = _compute_word_hash(last) % max(1, len(chosen.reassembly))
    template = chosen.reassembly[ridx] if chosen.reassembly else ""
    response = _apply_reassembly(template, parts)
    if response:
        state.memories.append(response)


def _extract_user_message(prompt: str) -> str:
    m = re.search(r"(?:User|Human|You):\s*(.+?)(?:\n|$)", prompt, re.IGNORECASE)
    return (m.group(1).strip() if m else prompt.strip()) if prompt else ""


class ElizaClassicEngine:
    def __init__(self) -> None:
        self._state = SessionState()

    def reset(self) -> None:
        self._state = SessionState()

    def get_greeting(self) -> str:
        return (
            _SCRIPT.greetings[1] if len(_SCRIPT.greetings) > 1 else _SCRIPT.greetings[0]
        )

    def generate(self, input_text: str) -> str:
        text = _extract_user_message(input_text)
        words = _tokenize_words(text)
        scan_words = _tokenize_for_scan(text)

        self._state.limit = 1 if self._state.limit == 4 else self._state.limit + 1

        if not words:
            return _choose_default(self._state)
        if _is_goodbye(words):
            return _SCRIPT.goodbyes[0] if _SCRIPT.goodbyes else "Goodbye"

        for clause in _split_into_clauses(scan_words):
            found = [w for w in clause if w in _KEYWORD_INDEX]
            if not found:
                continue
            stack = sorted(
                found,
                key=lambda w: (-_KEYWORD_INDEX[w].precedence, clause.index(w)),
            )
            match_words = _substitute_words_for_matching(clause)
            for kw in stack:
                entry = _KEYWORD_INDEX[kw]
                _maybe_record_memory(self._state, entry, match_words)
                result = _try_rules(self._state, kw, entry, match_words)
                if result.kind in ("no_match", "newkey"):
                    continue
                if result.kind == "response":
                    return result.text or ""
                if result.kind == "redirect":
                    target = result.redirect or ""
                    target_entry = _KEYWORD_INDEX.get(target)
                    if not target_entry:
                        continue
                    rr = _try_rules(self._state, target, target_entry, match_words)
                    if rr.kind == "response":
                        return rr.text or ""
                    continue
                if result.kind == "pre":
                    pre_text = _apply_reassembly(
                        result.pre_text or "", result.parts or []
                    )
                    pre_words = _tokenize_words(pre_text)
                    target = result.redirect or ""
                    target_entry = _KEYWORD_INDEX.get(target)
                    if not target_entry:
                        continue
                    rr = _try_rules(self._state, target, target_entry, pre_words)
                    if rr.kind == "response":
                        return rr.text or ""
                    continue
            break

        return _choose_default(self._state)


_ENGINE = ElizaClassicEngine()


def generate_response(input_text: str) -> str:
    return _ENGINE.generate(input_text)


def get_greeting() -> str:
    return _ENGINE.get_greeting()


class ElizaClassicPlugin:
    def __init__(self, config: ElizaConfig | None = None) -> None:
        self._config = config or ElizaConfig()
        self._engine = ElizaClassicEngine()

    def generate_response(self, input_text: str) -> str:
        return self._engine.generate(input_text)

    def get_greeting(self) -> str:
        return self._engine.get_greeting()

    def reset_history(self) -> None:
        self._engine.reset()


def create_eliza_classic_elizaos_plugin() -> object:
    try:
        from elizaos import Plugin
        from elizaos.types.model import ModelType
        from elizaos.types.runtime import IAgentRuntime
    except ImportError as e:
        raise ImportError("elizaos package required for plugin creation") from e

    plugin_instance = ElizaClassicPlugin()

    async def text_large_handler(
        runtime: IAgentRuntime, params: dict[str, object]
    ) -> str:
        prompt = params.get("prompt", "")
        match = re.search(r"(?:User|Human|You):\s*(.+?)(?:\n|$)", prompt, re.IGNORECASE)
        input_text = match.group(1) if match else prompt
        return plugin_instance.generate_response(input_text)

    async def text_small_handler(
        runtime: IAgentRuntime, params: dict[str, object]
    ) -> str:
        return await text_large_handler(runtime, params)

    return Plugin(
        name="eliza-classic",
        description="Classic ELIZA pattern matching - no LLM required",
        models={
            ModelType.TEXT_LARGE.value: text_large_handler,
            ModelType.TEXT_SMALL.value: text_small_handler,
        },
    )


_eliza_plugin_instance: object | None = None


def get_eliza_classic_plugin() -> object:
    global _eliza_plugin_instance
    if _eliza_plugin_instance is None:
        _eliza_plugin_instance = create_eliza_classic_elizaos_plugin()
    return _eliza_plugin_instance
