"""Translate a stratified sample of the training corpus to multiple languages,
preserving structural identifiers (action names, native JSON keys, code, paths, IDs).

Strategy
========
1. Reservoir-sample a stratified slice from data/final/train.jsonl proportional
   to task_type distribution.
2. For each record translate three text surfaces:
   - metadata.system_prompt (natural language) — full translation
   - currentMessage.content — full translation
   - expectedResponse — format-aware translation:
       * native JSON: translate only sentence-like values for prose-bearing keys
       * Fenced JSON / raw JSON: leave keys, translate select string values
       * XML: translate only contents of <thought>/<text>/<reasoning>/<description>
3. Identifier protection: ALL_CAPS_TOKENS, URLs, paths, JSON-shaped substrings,
   code blocks are masked before translation and restored after.
4. Output to data/synthesized/translated/<lang>.jsonl with progress tracking
   for resume on failure.

Backend: argos-translate (offline NMT). One language pack per target language.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

# Force single-threaded execution per process. CTranslate2 (argos's backend)
# defaults to multi-threading internally; with 8 parallel processes that
# multiplies into 24+ contended threads on this 24-core box and net throughput
# tanks. Setting these here, before importing argos, keeps each process to one
# CPU thread and lets the OS schedule the 8 processes across 8 cores cleanly.
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("CT2_INTER_THREADS", "1")
os.environ.setdefault("CT2_INTRA_THREADS", "1")

import argostranslate.translate

ROOT = Path(__file__).resolve().parent.parent
TRAIN_FILE = ROOT / "data" / "final" / "train.jsonl"
OUT_DIR = ROOT / "data" / "synthesized" / "translated"
PROGRESS_FILE = OUT_DIR / ".progress.json"

# Final manifest task-type distribution (from data/final/manifest.json totals).
TASK_TYPE_FRACTIONS = {
    "agent_trace": 510979 / 1137077,
    "tool_call": 371761 / 1137077,
    "reasoning_cot": 127170 / 1137077,
    "shell_command": 100285 / 1137077,
    "scam_defense": 54829 / 1137077,
    "mcp_tool_call": 32138 / 1137077,
    "dialogue_routing": 5613 / 1137077,
    "n8n_workflow_generation": 3392 / 1137077,
}

# native JSON keys whose values are natural-language prose worth translating.
PROSE_NATIVE_JSON_KEYS = {
    "thought",
    "text",
    "reasoning",
    "description",
    "summary",
    "explanation",
    "message",
    "content",
    "answer",
    "rationale",
    "plan",
    "analysis",
    "notes",
}

# JSON keys whose string values are natural language (translate). Anything else
# stays untouched.
PROSE_JSON_KEYS = {
    "analysis",
    "plan",
    "explanation",
    "reasoning",
    "thought",
    "rationale",
    "description",
    "summary",
    "answer",
    "message",
    "content",
    "notes",
    "comment",
    "response",
}


# --------------------------------------------------------------------------- #
# Identifier masking
# --------------------------------------------------------------------------- #


# Order matters: longest / most specific first so we don't double-eat tokens.
MASK_PATTERNS: list[re.Pattern] = [
    re.compile(r"```[\s\S]*?```"),               # fenced code blocks
    re.compile(r"`[^`\n]+`"),                    # inline code
    re.compile(r"https?://\S+"),                 # URLs
    re.compile(r"[A-Za-z]?:?(?:/[A-Za-z0-9_.\-]+){2,}/?"),   # absolute paths
    re.compile(r"\b[\w.\-]+\.(?:py|js|ts|tsx|json|yaml|yml|md|sh|cpp|c|h|hpp|rs|go|java|kt|rb|php|sql|html|css|toml|ini)\b"),  # file names
    re.compile(r"\{[^{}\n]{3,200}\}"),           # short inline JSON-ish
    re.compile(r"\$[A-Z_][A-Z0-9_]*"),            # shell vars
    re.compile(r"--[a-z][a-z0-9-]+"),            # CLI flags
    re.compile(r"\b[A-Z][A-Z0-9_]{3,}\b"),       # ALL_CAPS_TOKENS (>=4 chars)
    re.compile(r"\b[a-z][a-z0-9_]{2,}\.[a-z][a-zA-Z0-9_]{2,}\b"),  # snake.dotted.calls
    re.compile(r"\b\w+\([^)]{0,80}\)"),           # function-like calls
]


def mask_text(text: str) -> tuple[str, list[str]]:
    """Replace each protected substring with a Zk Q sentinel and return (masked, table).

    The placeholder uses letter-prefix forms (Zk{N}Q) instead of underscores
    because argos-translate strips underscores around standalone tokens. We
    pick a rare letter sequence ("zkq") to minimize collisions.
    """
    table: list[str] = []
    masked = text
    for pat in MASK_PATTERNS:
        def _swap(m: re.Match) -> str:
            table.append(m.group(0))
            return f" Zkq{len(table) - 1}Qkz "
        masked = pat.sub(_swap, masked)
    return masked, table


# Tolerant restorer: argos may lowercase, add spaces, drop punctuation. Match
# the core "zkq<digits>qkz" pattern even with whitespace around it.
RESTORE_RE = re.compile(r"Zkq\s*(\d+)\s*Qkz", re.IGNORECASE)


def restore_text(text: str, table: list[str]) -> str:
    if not table:
        return text

    def _sub(m: re.Match) -> str:
        idx = int(m.group(1))
        if 0 <= idx < len(table):
            return table[idx]
        return m.group(0)

    return RESTORE_RE.sub(_sub, text)


# --------------------------------------------------------------------------- #
# Translator (lazy, per-language)
# --------------------------------------------------------------------------- #


class Translator:
    def __init__(self, target: str):
        self.target = target
        langs = argostranslate.translate.get_installed_languages()
        en = next((lang for lang in langs if lang.code == "en"), None)
        tgt = next((lang for lang in langs if lang.code == target), None)
        if en is None or tgt is None:
            raise RuntimeError(f"argos pack en->{target} not installed")
        self._tr = en.get_translation(tgt)
        # Tiny memo to avoid re-translating identical short strings within a run.
        self._cache: dict[str, str] = {}
        self.calls = 0
        self.cache_hits = 0

    def translate(self, text: str) -> str:
        if text is None:
            return text
        # Skip empty / whitespace-only / pure-numeric / pure-symbol strings.
        stripped = text.strip()
        if not stripped:
            return text
        if not re.search(r"[A-Za-z]", stripped):
            return text  # nothing to translate
        if len(stripped) < 2:
            return text

        if text in self._cache:
            self.cache_hits += 1
            return self._cache[text]

        masked, table = mask_text(text)
        try:
            out = self._tr.translate(masked)
        except Exception as exc:  # argos sometimes throws on weird inputs
            sys.stderr.write(f"[warn] translate failed ({exc}); keeping original\n")
            return text
        out = restore_text(out, table)
        self.calls += 1
        if len(self._cache) < 10000:  # bounded
            self._cache[text] = out
        return out


# --------------------------------------------------------------------------- #
# Format-aware translation of expectedResponse
# --------------------------------------------------------------------------- #


# native JSON line: leading indent, key, colon, optional space, value.
NATIVE_JSON_LINE_RE = re.compile(r"^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:\s*)(.*)$")
# Bullet list inside native JSON.
NATIVE_JSON_BULLET_RE = re.compile(r"^(\s*-\s+)(.*)$")


def looks_like_payload(text: str) -> bool:
    head = text.lstrip().splitlines()[:3]
    if not head:
        return False
    return any(NATIVE_JSON_LINE_RE.match(line) for line in head)


def looks_like_xml(text: str) -> bool:
    s = text.lstrip()
    return s.startswith("<") and ">" in s[:200]


def looks_like_json(text: str) -> bool:
    s = text.lstrip()
    return s.startswith("{") or s.startswith("[")


def _is_prose_value(value: str) -> bool:
    """Heuristic: only translate when the value looks like a sentence."""
    v = value.strip()
    if not v:
        return False
    if v.startswith(("{", "[", "<")):
        return False
    if v.startswith('"') and v.endswith('"') and ("{" in v or "\\n" in v):
        # JSON-encoded blob inside a native JSON string — handled separately.
        return False
    if "://" in v:
        return False
    if v.startswith("/") or v.startswith("./"):
        return False
    if re.fullmatch(r"[A-Z][A-Z0-9_]+", v):
        return False
    if re.fullmatch(r"[\d\W]+", v):
        return False
    # Need at least a couple of letters and a space — real prose.
    if " " not in v and len(v) < 20:
        return False
    return bool(re.search(r"[A-Za-z]{3,}", v))


def _regex_translate_json_blob(blob: str, tr: Translator) -> str:
    """Best-effort translation of "key": "value" pairs in a malformed JSON blob.

    When the inner string is a JSON document we cannot parse cleanly (common
    when shell traces or heredocs were embedded), we still want to translate
    the prose-bearing keys. This walks the string and translates the matched
    string-literal value when the key is in PROSE_JSON_KEYS, leaving structural
    characters unchanged.
    """
    # Match "<key>": "<value>" allowing escaped quotes inside the value.
    pattern = re.compile(
        r'"(' + "|".join(PROSE_JSON_KEYS) + r')"\s*:\s*"((?:[^"\\]|\\.)*)"',
        re.IGNORECASE,
    )

    def _sub(m: re.Match) -> str:
        key = m.group(0).split('"', 2)[1]
        raw_value = m.group(2)
        # Decode escapes (\\n -> newline, \\" -> ") for translation only.
        try:
            decoded = json.loads('"' + raw_value + '"')
        except json.JSONDecodeError:
            return m.group(0)
        if not _is_prose_value(decoded):
            return m.group(0)
        translated = tr.translate(decoded)
        # Re-encode as JSON string body (without surrounding quotes).
        encoded = json.dumps(translated, ensure_ascii=False)[1:-1]
        return f'"{key}": "{encoded}"'

    return pattern.sub(_sub, blob)


def translate_payload_value(raw: str, tr: Translator) -> str:
    """Translate the value part of a native JSON line, preserving surrounding quotes.

    A common native JSON shape is `text: "{\\n  \\"analysis\\": ...}"` — i.e. a JSON
    string whose decoded form is itself JSON. We unwrap both layers, translate
    the prose-bearing values inside the inner JSON tree, then re-serialize.
    When the inner JSON is malformed, fall back to regex-level translation of
    prose-bearing keys so we still get partial coverage.
    """
    v = raw
    if v.startswith('"') and v.endswith('"') and len(v) >= 2:
        try:
            decoded = json.loads(v)
        except json.JSONDecodeError:
            decoded = None

        if isinstance(decoded, str) and decoded.lstrip().startswith(("{", "[")):
            try:
                obj = json.loads(decoded)
                obj2 = translate_json_value(obj, tr)
                inner_json = json.dumps(obj2, ensure_ascii=False, indent=2)
                return json.dumps(inner_json, ensure_ascii=False)
            except json.JSONDecodeError:
                # Malformed inner JSON: do a best-effort regex pass.
                patched = _regex_translate_json_blob(decoded, tr)
                return json.dumps(patched, ensure_ascii=False)

        if isinstance(decoded, str) and _is_prose_value(decoded):
            return json.dumps(tr.translate(decoded), ensure_ascii=False)
        return v

    if _is_prose_value(v):
        return tr.translate(v)
    return v


def translate_payload(text: str, tr: Translator) -> str:
    out_lines: list[str] = []
    for line in text.split("\n"):
        m = NATIVE_JSON_LINE_RE.match(line)
        if m:
            indent, key, sep, value = m.groups()
            if key.lower() in PROSE_NATIVE_JSON_KEYS and value:
                value = translate_payload_value(value, tr)
            out_lines.append(f"{indent}{key}{sep}{value}")
            continue
        b = NATIVE_JSON_BULLET_RE.match(line)
        if b:
            bullet_prefix, body = b.group(1), b.group(2)
            # Bullet bodies often carry their own `key: value` (native JSON sub-key)
            # or `Key: value` form. Translating the entire body rewrites the
            # key into the target language and breaks downstream native JSON parsing
            # contracts ("Name" -> "nombre", "arguments" -> "argumentos", etc).
            # Detect that shape and translate only the value when the key is
            # in PROSE_NATIVE_JSON_KEYS; otherwise translate the whole prose body.
            sub = NATIVE_JSON_LINE_RE.match(body)
            if sub:
                _, sub_key, sub_sep, sub_value = sub.groups()
                if sub_key.lower() in PROSE_NATIVE_JSON_KEYS and sub_value:
                    sub_value = translate_payload_value(sub_value, tr)
                out_lines.append(f"{bullet_prefix}{sub_key}{sub_sep}{sub_value}")
                continue
            if _is_prose_value(body):
                out_lines.append(bullet_prefix + tr.translate(body))
                continue
        out_lines.append(line)
    return "\n".join(out_lines)


def translate_json_value(obj, tr: Translator):
    """Recursively translate prose-bearing string fields inside a JSON tree."""
    if isinstance(obj, dict):
        new = {}
        for k, v in obj.items():
            if isinstance(v, str) and k.lower() in PROSE_JSON_KEYS and _is_prose_value(v):
                new[k] = tr.translate(v)
            else:
                new[k] = translate_json_value(v, tr)
        return new
    if isinstance(obj, list):
        return [translate_json_value(x, tr) for x in obj]
    return obj


XML_PROSE_TAGS = ("thought", "text", "reasoning", "description", "think")


def translate_xml(text: str, tr: Translator) -> str:
    def replace_tag(tag: str, body: str) -> str:
        if not _is_prose_value(body):
            return body
        return tr.translate(body)

    out = text
    for tag in XML_PROSE_TAGS:
        pat = re.compile(rf"(<{tag}[^>]*>)([\s\S]*?)(</{tag}>)", re.IGNORECASE)
        out = pat.sub(
            lambda m: m.group(1) + replace_tag(tag, m.group(2)) + m.group(3),
            out,
        )
    return out


def translate_expected_response(text: str, tr: Translator) -> str:
    if not isinstance(text, str) or not text.strip():
        return text

    stripped = text.lstrip()

    # Fenced JSON: ```json\n{...}\n```
    fence = re.match(r"^```(?:json|JSON)?\s*\n([\s\S]+?)\n```\s*$", stripped)
    if fence:
        try:
            obj = json.loads(fence.group(1))
            obj2 = translate_json_value(obj, tr)
            return f"```json\n{json.dumps(obj2, ensure_ascii=False, indent=2)}\n```"
        except json.JSONDecodeError:
            pass  # fall through

    if looks_like_xml(text):
        return translate_xml(text, tr)

    if looks_like_json(text):
        try:
            obj = json.loads(text)
            obj2 = translate_json_value(obj, tr)
            return json.dumps(obj2, ensure_ascii=False)
        except json.JSONDecodeError:
            pass

    if looks_like_payload(text):
        return translate_payload(text, tr)

    # Otherwise: plain prose.
    if _is_prose_value(text):
        return tr.translate(text)
    return text


# --------------------------------------------------------------------------- #
# Stratified reservoir sample
# --------------------------------------------------------------------------- #


def stratified_sample(target_per_lang: int, seed: int = 42) -> list[dict]:
    """Reservoir-sample a stratified slice from data/final/train.jsonl.

    We sample per task_type proportional to TASK_TYPE_FRACTIONS so every
    language gets ~target_per_lang records distributed by type.
    """
    rng = random.Random(seed)
    quota = {tt: max(1, int(round(target_per_lang * frac)))
             for tt, frac in TASK_TYPE_FRACTIONS.items()}
    # Make sure totals add to target_per_lang.
    total = sum(quota.values())
    if total < target_per_lang:
        quota["agent_trace"] += target_per_lang - total
    elif total > target_per_lang:
        quota["agent_trace"] -= total - target_per_lang

    print(f"[sample] stratified quotas (sum={sum(quota.values())}):")
    for tt, q in quota.items():
        print(f"  {tt}: {q}")

    reservoirs: dict[str, list[dict]] = defaultdict(list)
    counts: dict[str, int] = defaultdict(int)

    n_lines = 0
    t0 = time.time()
    with TRAIN_FILE.open("r") as f:
        for line in f:
            n_lines += 1
            if n_lines % 200_000 == 0:
                print(f"  scanned {n_lines:,} lines... {time.time()-t0:.1f}s")
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            tt = (r.get("metadata") or {}).get("task_type", "agent_trace")
            if tt not in quota:
                continue
            cap = quota[tt]
            counts[tt] += 1
            res = reservoirs[tt]
            if len(res) < cap:
                res.append(r)
            else:
                j = rng.randint(0, counts[tt] - 1)
                if j < cap:
                    res[j] = r

    out: list[dict] = []
    for tt, recs in reservoirs.items():
        out.extend(recs)
    rng.shuffle(out)
    print(f"[sample] picked {len(out)} records from {n_lines:,} scanned in {time.time()-t0:.1f}s")
    return out


# --------------------------------------------------------------------------- #
# Per-record translation pipeline
# --------------------------------------------------------------------------- #


# Cap individual text-field length so single records can't dominate runtime.
# Argos is CPU-bound, sentence-by-sentence; long blocks (5–10kB shell traces)
# yield diminishing translation value while costing many seconds each.
MAX_TEXT_CHARS = 800

# Records whose total text surface exceeds this are skipped entirely. This
# protects against a single 30 kB JSON-encoded reasoning trace blowing up
# per-language runtime by 100x.
MAX_RECORD_CHARS = 8000


def _bounded_translate(value: str, tr: Translator) -> str:
    """Translate the natural-prose head of a string, leaving the tail intact.

    Long inputs typically have their prose framing in the first sentence(s),
    followed by code/output/data dumps. We translate up to MAX_TEXT_CHARS at
    the head and pass the rest through verbatim. Shorter inputs translate
    in full.
    """
    if value is None:
        return value
    if len(value) <= MAX_TEXT_CHARS:
        return tr.translate(value)
    head = value[:MAX_TEXT_CHARS]
    # Try to break on a sentence boundary near the end of the slice.
    cut = max(head.rfind(". "), head.rfind("\n"), head.rfind(": "))
    if cut > MAX_TEXT_CHARS // 2:
        head = value[: cut + 1]
    tail = value[len(head):]
    return tr.translate(head) + tail


# Heuristics for "this looks like a shell trace / JSON dump / code blob, not a
# natural-language user message we should translate." These are common in
# agent_trace and shell_command tasks, where the user message is actually
# captured terminal state.
SHELL_PROMPT_RE = re.compile(r"^(?:root@|\$ |# |C:\\|>>> )", re.MULTILINE)


def _is_user_prose(value: str) -> bool:
    head = value.lstrip()[:300]
    if head.startswith(("{", "[", "<", "```")):
        return False
    if SHELL_PROMPT_RE.search(value[:500]):
        return False
    if "Current terminal state" in head or "Terminal Output" in head:
        return False
    return True


def _translate_user_input(value: str, tr: Translator) -> str:
    """Translate user-message content, but pass shell/code dumps through."""
    if not _is_user_prose(value):
        return value
    return _bounded_translate(value, tr)


def translate_record(record: dict, tr: Translator, lang: str) -> dict:
    out = json.loads(json.dumps(record))  # deep copy via JSON

    # currentMessage.content — primary surface. We translate only the prose
    # framing in front of any shell output / code dump / JSON dump.
    cm = out.get("currentMessage")
    if isinstance(cm, dict):
        c = cm.get("content")
        if isinstance(c, str) and c.strip():
            cm["content"] = _translate_user_input(c, tr)

    # metadata.system_prompt — translate when present and prose
    md = out.get("metadata") or {}
    sp = md.get("system_prompt")
    if isinstance(sp, str) and sp.strip() and _is_prose_value(sp):
        md["system_prompt"] = _bounded_translate(sp, tr)

    # memoryEntries: deliberately skipped. They're typically tool outputs,
    # shell traces, or code — not natural prose worth translating, and they
    # dominate per-record runtime when included. We keep them as-is so the
    # context the model sees stays accurate.

    # expectedResponse — format-aware translation
    er = out.get("expectedResponse")
    if isinstance(er, str):
        out["expectedResponse"] = translate_expected_response(er, tr)

    # Annotate
    md["translated_from"] = md.get("language", "en")
    md["translated_to"] = lang
    out["metadata"] = md
    out["source_dataset"] = f"synth-translated-{lang}"
    rn = out.get("roomName") or ""
    out["roomName"] = f"{rn}:lang={lang}"
    return out


# --------------------------------------------------------------------------- #
# Driver
# --------------------------------------------------------------------------- #


def load_progress() -> dict:
    if PROGRESS_FILE.exists():
        return json.loads(PROGRESS_FILE.read_text())
    return {}


def save_progress(progress: dict) -> None:
    PROGRESS_FILE.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS_FILE.write_text(json.dumps(progress, indent=2))


def write_or_load_sample(per_lang: int, seed: int) -> list[dict]:
    """Cache the stratified sample on disk so parallel runs share it."""
    cache = OUT_DIR / f".sample_n{per_lang}_seed{seed}.jsonl"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if cache.exists():
        # Use line-iter (split on '\n' only). splitlines() splits on Unicode
        # line separators like \x1c,  , etc. that occur inside escaped
        # JSON string values, fragmenting valid records and causing decode
        # errors on large samples.
        recs: list[dict] = []
        with cache.open("r") as fh:
            for line in fh:
                if line.strip():
                    recs.append(json.loads(line))
        print(f"[sample] reused cached sample {cache} ({len(recs)} recs)")
        return recs
    sample = stratified_sample(per_lang, seed=seed)
    with cache.open("w") as f:
        for r in sample:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"[sample] wrote cached sample to {cache}")
    return sample


def run(langs: list[str], per_lang: int, seed: int) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    sample = write_or_load_sample(per_lang, seed)
    print(f"[run] using sample of {len(sample)} records across {len(langs)} languages")

    progress = load_progress()
    progress["sample_size"] = len(sample)
    progress["languages"] = progress.get("languages", {})

    for lang in langs:
        out_path = OUT_DIR / f"{lang}.jsonl"
        st = progress["languages"].get(lang, {"written": 0, "started": time.time()})
        already = st.get("written", 0)
        mode = "a" if already > 0 else "w"

        print(f"\n=== {lang} === starting at idx={already}, target={len(sample)}", flush=True)
        tr = Translator(lang)

        t0 = time.time()
        skipped_huge = 0
        with out_path.open(mode) as f:
            for i, rec in enumerate(sample):
                if i < already:
                    continue
                # Skip oversized records.
                cm_len = len((rec.get("currentMessage") or {}).get("content","") or "")
                er_len = len(rec.get("expectedResponse","") or "")
                if cm_len + er_len > MAX_RECORD_CHARS:
                    skipped_huge += 1
                    continue
                try:
                    out = translate_record(rec, tr, lang)
                except Exception as exc:
                    sys.stderr.write(f"[warn] {lang} idx={i} failed: {exc}\n")
                    continue
                f.write(json.dumps(out, ensure_ascii=False) + "\n")
                if (i + 1) % 25 == 0:
                    f.flush()
                    elapsed = time.time() - t0
                    rate = (i + 1 - already) / elapsed if elapsed > 0 else 0
                    eta = (len(sample) - i - 1) / rate if rate > 0 else 0
                    print(f"  [{lang}] {i+1}/{len(sample)}  "
                          f"{rate:.2f} rec/s  cache={tr.cache_hits} "
                          f"skip_huge={skipped_huge} eta={eta/60:.1f}m",
                          flush=True)
                    progress["languages"][lang] = {
                        "written": i + 1,
                        "started": st.get("started", t0),
                        "rate_per_sec": rate,
                    }
                    save_progress(progress)

        progress["languages"][lang] = {
            "written": len(sample),
            "started": st.get("started", t0),
            "elapsed_sec": time.time() - t0,
            "calls": tr.calls,
            "cache_hits": tr.cache_hits,
        }
        save_progress(progress)
        print(f"=== {lang} done in {(time.time()-t0)/60:.1f}m, "
              f"calls={tr.calls}, cache_hits={tr.cache_hits} ===")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--langs", default="es,fr,de,pt,zh,ja,ko,ru")
    ap.add_argument("--per-lang", type=int, default=12000)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    langs = [s.strip() for s in args.langs.split(",") if s.strip()]
    run(langs, args.per_lang, args.seed)


if __name__ == "__main__":
    main()
