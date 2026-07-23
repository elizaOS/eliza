"""elizaOS WebShop environment.

Adapter over **Princeton-NLP WebShop's** ``WebAgentTextEnv`` Gym environment
(vendored under ``upstream/web_agent_site``).

Reward is computed by upstream's
``web_agent_site.engine.goal.get_reward`` (TF-IDF / fuzzy-match score over
title, attributes, options, and price). The old in-process state machine
and custom scoring code have been removed entirely.

Full-catalog runs require the local checksum-bound Lucene index and pinned
Pyserini, Java, spaCy, and fuzzy-matching runtime. Small and explicitly
synthetic smoke profiles use an in-process BM25 backend and are not
publication-eligible. The reward function itself is unchanged.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import json
import importlib.util
import random
from importlib.metadata import version
from importlib.machinery import ModuleSpec
from html.parser import HTMLParser
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from elizaos_webshop.types import PageObservation, PageType, WebShopTask

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Upstream bootstrap
# ---------------------------------------------------------------------------

_BENCH_DIR = Path(__file__).resolve().parent.parent
_UPSTREAM_DIR = _BENCH_DIR / "upstream"
_OFFICIAL_INDEX_DIR = _BENCH_DIR / "data" / "search-indexes" / "full"
_OFFICIAL_INDEX_MANIFEST = (
    _BENCH_DIR / "data" / "search-indexes" / "full.manifest.json"
)
_FULL_SOURCE_SHA256 = "2ef591d65df3af89e972ab72468eb82cbf124d876552d9f3678667edd620a6c8"
_FULL_SUBMITTED_DOCUMENT_COUNT = 1_181_430
_FULL_EMPTY_PROJECTION_COUNT = 60
_FULL_DOCUMENT_COUNT = _FULL_SUBMITTED_DOCUMENT_COUNT - _FULL_EMPTY_PROJECTION_COUNT
_spacy_nlp_singleton: Any | None = None
_spacy_load_attempted = False
_ENVIRONMENT_RANDOM_SEED = 233


class _FallbackSpacyToken:
    def __init__(self, text: str) -> None:
        self.text = text
        self.lemma_ = text.lower()
        self.pos_ = "NOUN"


class _FallbackSpacyDoc(list[_FallbackSpacyToken]):
    @property
    def text(self) -> str:
        return " ".join(token.text for token in self)


class _FallbackSpacyNLP:
    def __call__(self, text: str) -> _FallbackSpacyDoc:
        return _FallbackSpacyDoc(_FallbackSpacyToken(part) for part in str(text).split())


def _ensure_spacy_model_available(
    *,
    model: str = "en_core_web_sm",
    _spacy_module: Any | None = None,
    _subprocess_run: Any = subprocess.run,
) -> Any:
    """Load spaCy's model, optionally installing it for local smoke runs."""
    global _spacy_nlp_singleton, _spacy_load_attempted
    if _spacy_nlp_singleton is not None:
        return _spacy_nlp_singleton

    if _spacy_module is None:
        import spacy as _spacy_module  # type: ignore[import-not-found]

    try:
        _spacy_nlp_singleton = _spacy_module.load(model)
        _spacy_load_attempted = True
        return _spacy_nlp_singleton
    except OSError as exc:
        _spacy_load_attempted = True
        if os.environ.get("WEBSHOP_ALLOW_SPACY_STUB"):
            logger.warning(
                "spaCy model %r is missing; using lightweight WebShop smoke stub "
                "because WEBSHOP_ALLOW_SPACY_STUB is set.",
                model,
            )
            _spacy_nlp_singleton = _FallbackSpacyNLP()
            return _spacy_nlp_singleton
        if os.environ.get("WEBSHOP_NO_AUTOFETCH"):
            raise OSError(
                f"spaCy model {model!r} is missing and WEBSHOP_NO_AUTOFETCH is set. "
                f"Install it manually with: python -m spacy download {model}"
            ) from exc

        cmd = [sys.executable, "-m", "spacy", "download", model]
        completed = _subprocess_run(cmd, check=False)
        returncode = int(getattr(completed, "returncode", 0))
        if returncode != 0:
            raise OSError(
                f"spaCy model {model!r} is missing and spacy download failed "
                f"with exit code {returncode}: {' '.join(cmd)}"
            ) from exc
        _spacy_nlp_singleton = _spacy_module.load(model)
        return _spacy_nlp_singleton


def _ensure_upstream_on_path() -> None:
    """Make ``import web_agent_site`` resolve to our vendored copy."""
    upstream_str = str(_UPSTREAM_DIR)
    if upstream_str not in sys.path:
        sys.path.insert(0, upstream_str)
    _ensure_beautifulsoup_available()
    _install_optional_dependency_stubs()
    _ensure_spacy_model_available()
    if "gym" not in sys.modules:
        import types as _types

        gym_stub = _types.ModuleType("gym")

        class _Env:
            pass

        gym_stub.Env = _Env  # type: ignore[attr-defined]
        gym_stub.spaces = _types.SimpleNamespace()  # type: ignore[attr-defined]
        envs_mod = _types.ModuleType("gym.envs")
        registration_mod = _types.ModuleType("gym.envs.registration")

        def _register(**_kwargs: Any) -> None:
            return None

        registration_mod.register = _register  # type: ignore[attr-defined]
        envs_mod.registration = registration_mod  # type: ignore[attr-defined]
        sys.modules["gym"] = gym_stub
        sys.modules["gym.envs"] = envs_mod
        sys.modules["gym.envs.registration"] = registration_mod


def _ensure_beautifulsoup_available() -> None:
    """Require BeautifulSoup, except in explicitly synthetic smoke runs."""
    if importlib.util.find_spec("bs4") is not None:
        return
    if os.environ.get("WEBSHOP_ALLOW_SPACY_STUB"):
        _install_beautifulsoup_stub()
        return
    raise ModuleNotFoundError(
        "WebShop requires beautifulsoup4 for real benchmark runs. Install the "
        "package before running, or use WEBSHOP_ALLOW_SPACY_STUB only for an "
        "explicitly nonpublishable smoke test."
    )


def _install_beautifulsoup_stub() -> None:
    """Install a small BeautifulSoup subset used by vendored WebShop."""
    import types as _types

    if "bs4" in sys.modules:
        return

    class Comment(str):
        pass

    class _TextNode(str):
        def __new__(cls, value: str, parent: "_Node") -> "_TextNode":
            obj = str.__new__(cls, value)
            obj.parent = parent  # type: ignore[attr-defined]
            return obj

    class _Node:
        def __init__(
            self,
            name: str,
            attrs: dict[str, Any] | None = None,
            parent: "_Node | None" = None,
        ) -> None:
            self.name = name
            self.attrs = attrs or {}
            self.parent = parent
            self.children: list[_Node | _TextNode] = []

        def get(self, key: str, default: Any = None) -> Any:
            value = self.attrs.get(key, default)
            if key == "class" and isinstance(value, str):
                return value.split()
            return value

        def __getitem__(self, key: str) -> Any:
            return self.attrs[key]

        @property
        def text(self) -> str:
            return self.get_text()

        @property
        def h4(self) -> "_Node":
            found = self.find("h4")
            if found is None:
                raise AttributeError("h4")
            return found

        def get_text(self) -> str:
            parts: list[str] = []
            for child in self.children:
                if isinstance(child, str):
                    parts.append(str(child))
                else:
                    parts.append(child.get_text())
            return "".join(parts)

        def _iter_nodes(self) -> list["_Node"]:
            nodes = [self]
            for child in self.children:
                if isinstance(child, _Node):
                    nodes.extend(child._iter_nodes())
            return nodes

        def _iter_text(self) -> list[_TextNode]:
            texts: list[_TextNode] = []
            for child in self.children:
                if isinstance(child, _TextNode):
                    texts.append(child)
                elif isinstance(child, _Node):
                    texts.extend(child._iter_text())
            return texts

        def _matches(
            self,
            name: str | None = None,
            *,
            id: str | None = None,
            class_: str | None = None,
        ) -> bool:
            if name is not None and self.name != name:
                return False
            if id is not None and self.attrs.get("id") != id:
                return False
            if class_ is not None:
                classes = self.get("class", [])
                if isinstance(classes, str):
                    classes = classes.split()
                if class_ not in classes:
                    return False
            return True

        def find(
            self,
            name: str | None = None,
            *,
            id: str | None = None,
            class_: str | None = None,
        ) -> "_Node | None":
            for node in self._iter_nodes():
                if node is not self and node._matches(name, id=id, class_=class_):
                    return node
            return None

        def find_all(
            self,
            name: str | None = None,
            *,
            class_: str | None = None,
        ) -> list["_Node"]:
            return [
                node
                for node in self._iter_nodes()
                if node is not self and node._matches(name, class_=class_)
            ]

        def findAll(self, text: bool = False) -> list[Any]:  # noqa: N802 - bs4 API
            if text:
                return self._iter_text()
            return self.find_all()

        def select(self, selector: str) -> list["_Node"]:
            if selector == 'input[type="radio"]':
                return [
                    node
                    for node in self._iter_nodes()
                    if node.name == "input" and node.attrs.get("type") == "radio"
                ]
            return []

    class _SoupParser(HTMLParser):
        def __init__(self) -> None:
            super().__init__(convert_charrefs=True)
            self.root = _Node("[document]")
            self.stack = [self.root]

        def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
            attr_dict = {k: (v if v is not None else "") for k, v in attrs}
            node = _Node(tag, attr_dict, self.stack[-1])
            self.stack[-1].children.append(node)
            if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
                self.stack.append(node)

        def handle_endtag(self, tag: str) -> None:
            for i in range(len(self.stack) - 1, 0, -1):
                if self.stack[i].name == tag:
                    del self.stack[i:]
                    break

        def handle_data(self, data: str) -> None:
            self.stack[-1].children.append(_TextNode(data, self.stack[-1]))

        def handle_comment(self, data: str) -> None:
            self.stack[-1].children.append(Comment(data))

    class BeautifulSoup(_Node):
        def __init__(self, html: str, _parser: str = "html.parser") -> None:
            parser = _SoupParser()
            parser.feed(html or "")
            self.__dict__.update(parser.root.__dict__)

    bs4_mod = _types.ModuleType("bs4")
    element_mod = _types.ModuleType("bs4.element")
    bs4_mod.__spec__ = ModuleSpec("bs4", loader=None)
    element_mod.__spec__ = ModuleSpec("bs4.element", loader=None)
    bs4_mod.BeautifulSoup = BeautifulSoup  # type: ignore[attr-defined]
    element_mod.Comment = Comment  # type: ignore[attr-defined]
    sys.modules["bs4"] = bs4_mod
    sys.modules["bs4.element"] = element_mod


def _install_optional_dependency_stubs() -> None:
    """Install lightweight compatibility stubs for explicit smoke runs only."""
    if not os.environ.get("WEBSHOP_ALLOW_SPACY_STUB"):
        return

    import types as _types

    if "thefuzz" not in sys.modules and importlib.util.find_spec("thefuzz") is None:
        fuzz_mod = _types.ModuleType("thefuzz.fuzz")

        def _ratio(a: object, b: object) -> int:
            left = str(a).strip().lower()
            right = str(b).strip().lower()
            if not left and not right:
                return 100
            if left == right:
                return 100
            if left in right or right in left:
                return 80
            return 0

        fuzz_mod.ratio = _ratio  # type: ignore[attr-defined]
        fuzz_mod.partial_ratio = _ratio  # type: ignore[attr-defined]
        fuzz_mod.token_set_ratio = _ratio  # type: ignore[attr-defined]
        pkg = _types.ModuleType("thefuzz")
        pkg.fuzz = fuzz_mod  # type: ignore[attr-defined]
        sys.modules["thefuzz"] = pkg
        sys.modules["thefuzz.fuzz"] = fuzz_mod
    else:
        from thefuzz import fuzz as fuzz_mod  # type: ignore[import-not-found]

        if not hasattr(fuzz_mod, "token_set_ratio"):
            def _token_set_ratio(a: object, b: object) -> int:
                left = set(str(a).strip().lower().split())
                right = set(str(b).strip().lower().split())
                if not left and not right:
                    return 100
                if not left or not right:
                    return 0
                intersection = left & right
                return int((2 * len(intersection) / (len(left) + len(right))) * 100)

            fuzz_mod.token_set_ratio = _token_set_ratio  # type: ignore[attr-defined]

    if "spacy" not in sys.modules and importlib.util.find_spec("spacy") is None:
        spacy_stub = _types.ModuleType("spacy")

        def _load(_model: str) -> _FallbackSpacyNLP:
            return _FallbackSpacyNLP()

        spacy_stub.load = _load  # type: ignore[attr-defined]
        sys.modules["spacy"] = spacy_stub


def _patch_search_engine_for_bm25_fallback(*, force_bm25: bool = False) -> None:
    """Monkey-patch ``engine.init_search_engine`` so pyserini/Lucene/Java
    is not required at import time.

    The fallback uses ``rank_bm25.BM25Okapi`` over product title +
    description. It exposes the minimal API ``get_top_n_product_from_keywords``
    uses: ``.search(query, k=...)`` returning hits with a ``.docid`` and
    ``.doc(docid)`` returning an object with ``.raw()`` returning the JSON
    string ``{"id": <asin>}``.
    """
    _ensure_upstream_on_path()

    # Determine whether pyserini is usable BEFORE we import the upstream
    # engine module (which does `from pyserini.search.lucene import
    # LuceneSearcher` at the top level).
    pyserini_available = False
    try:
        from pyserini.search.lucene import LuceneSearcher  # noqa: F401  # type: ignore[import-not-found]
        pyserini_available = True
    except Exception:
        pyserini_available = False

    if not pyserini_available:
        # Inject a stub ``pyserini.search.lucene.LuceneSearcher`` into
        # ``sys.modules`` so the upstream engine module imports cleanly.
        import types as _types

        if "pyserini" not in sys.modules:
            sys.modules["pyserini"] = _types.ModuleType("pyserini")
        if "pyserini.search" not in sys.modules:
            mod = _types.ModuleType("pyserini.search")
            sys.modules["pyserini.search"] = mod
            sys.modules["pyserini"].search = mod  # type: ignore[attr-defined]
        if "pyserini.search.lucene" not in sys.modules:
            stub = _types.ModuleType("pyserini.search.lucene")

            class _StubLuceneSearcher:  # noqa: D401 - stub
                def __init__(self, *args: Any, **kwargs: Any) -> None:
                    raise RuntimeError(
                        "pyserini stub: real Lucene index is not available. "
                        "WebShopEnvironment should never instantiate this; "
                        "the BM25 fallback is installed by SimServer."
                    )

            stub.LuceneSearcher = _StubLuceneSearcher  # type: ignore[attr-defined]
            sys.modules["pyserini.search.lucene"] = stub
            sys.modules["pyserini.search"].lucene = stub  # type: ignore[attr-defined]

    if (
        "rank_bm25" not in sys.modules
        and importlib.util.find_spec("rank_bm25") is None
        and os.environ.get("WEBSHOP_ALLOW_SPACY_STUB")
    ):
        import types as _types

        rank_bm25_stub = _types.ModuleType("rank_bm25")

        class _StubBM25Okapi:
            def __init__(self, corpus: list[list[str]]) -> None:
                self._corpus = corpus

            def get_scores(self, query_tokens: list[str]) -> list[float]:
                query_set = set(query_tokens)
                return [
                    float(len(query_set.intersection(tokens)))
                    for tokens in self._corpus
                ]

        rank_bm25_stub.BM25Okapi = _StubBM25Okapi  # type: ignore[attr-defined]
        sys.modules["rank_bm25"] = rank_bm25_stub

    from web_agent_site.engine import engine as _engine  # type: ignore[import-not-found]

    if pyserini_available and not force_bm25:
        return

    if getattr(_engine, "_elizaos_bm25_patched", False):
        return

    try:
        from rank_bm25 import BM25Okapi  # type: ignore[import-not-found]
    except Exception as exc:
        raise ModuleNotFoundError(
            "WebShop requires rank_bm25 when the official pyserini/Lucene "
            "search backend is unavailable"
        ) from exc

    import json as _json

    class _BM25Hit:
        __slots__ = ("docid", "score")

        def __init__(self, docid: str, score: float) -> None:
            self.docid = docid
            self.score = score

    class _BM25Doc:
        __slots__ = ("_raw",)

        def __init__(self, raw: str) -> None:
            self._raw = raw

        def raw(self) -> str:
            return self._raw

    class BM25Searcher:
        def __init__(self, products: list[dict[str, Any]]) -> None:
            corpus = []
            self._ids: list[str] = []
            for p in products:
                title = p.get("name", "") or p.get("Title", "") or ""
                desc = p.get("full_description", "") or p.get("Description", "") or ""
                cat = p.get("category", "") or ""
                tokens = (title + " " + desc + " " + cat).lower().split()
                corpus.append(tokens)
                self._ids.append(p["asin"])
            self._corpus = corpus
            self._bm25 = BM25Okapi(corpus) if corpus else None
            self._docs = {asin: _BM25Doc(_json.dumps({"id": asin})) for asin in self._ids}

        def search(self, query: str, k: int = 50) -> list[_BM25Hit]:
            if not self._ids:
                return []
            query_tokens = query.lower().split()
            if self._bm25 is None:
                return []
            scores = self._bm25.get_scores(query_tokens)
            ranked = sorted(
                zip(self._ids, scores),
                key=lambda t: t[1],
                reverse=True,
            )[: max(1, int(k))]
            return [_BM25Hit(asin, float(score)) for asin, score in ranked]

        def doc(self, docid: str) -> _BM25Doc:
            return self._docs[docid]

    _engine._bm25_searcher_factory = BM25Searcher  # type: ignore[attr-defined]
    _engine._original_init_search_engine = _engine.init_search_engine  # type: ignore[attr-defined]

    def _patched_init(num_products: int | None = None):  # type: ignore[override]
        # Placeholder; SimServer.__init__ wraps below assigns the real index
        # once products are loaded.
        return None

    _engine.init_search_engine = _patched_init  # type: ignore[assignment]
    _engine._elizaos_bm25_patched = True  # type: ignore[attr-defined]


def _configure_official_lucene_search() -> dict[str, str | int]:
    """Validate and install the checksum-bound full-catalog Lucene backend."""

    if not _OFFICIAL_INDEX_DIR.is_dir() or not _OFFICIAL_INDEX_MANIFEST.is_file():
        raise FileNotFoundError(
            "The full WebShop profile requires its official Lucene index. Run "
            "`python scripts/build_search_index.py` with the benchmark runtime first."
        )
    manifest = json.loads(_OFFICIAL_INDEX_MANIFEST.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("WebShop search-index manifest must be a JSON object")
    expected_manifest = {
        "search_backend": "pyserini-lucene",
        "document_count": _FULL_DOCUMENT_COUNT,
        "submitted_document_count": _FULL_SUBMITTED_DOCUMENT_COUNT,
        "empty_projection_count": _FULL_EMPTY_PROJECTION_COUNT,
        "source_sha256": _FULL_SOURCE_SHA256,
        "pyserini_version": "2.1.0",
        "anserini_version": "2.1.1",
    }
    for key, expected in expected_manifest.items():
        if manifest.get(key) != expected:
            raise ValueError(
                f"WebShop search-index manifest {key} mismatch: expected "
                f"{expected!r}, found {manifest.get(key)!r}"
            )

    from pyserini.index.lucene import LuceneIndexReader  # type: ignore[import-not-found]
    from pyserini.search.lucene import LuceneSearcher  # type: ignore[import-not-found]

    stats = LuceneIndexReader(str(_OFFICIAL_INDEX_DIR)).stats()
    document_count = int(stats.get("documents", -1))
    if document_count != _FULL_DOCUMENT_COUNT:
        raise ValueError(
            "WebShop Lucene document count mismatch: expected "
            f"{_FULL_DOCUMENT_COUNT}, found {document_count}"
        )
    if version("pyserini") != manifest["pyserini_version"]:
        raise ValueError(
            "WebShop Pyserini runtime does not match the version that built the index"
        )

    _ensure_upstream_on_path()
    from web_agent_site.engine import engine as _engine  # type: ignore[import-not-found]

    def _official_init(num_products: int | None = None) -> Any:
        if num_products is not None:
            raise ValueError(
                "The official WebShop Lucene index requires the full product catalog"
            )
        return LuceneSearcher(str(_OFFICIAL_INDEX_DIR))

    _engine.init_search_engine = _official_init  # type: ignore[assignment]

    nlp = _ensure_spacy_model_available()
    spacy_version = version("spacy")
    spacy_model_name = str(nlp.meta.get("name", ""))
    spacy_model_version = str(nlp.meta.get("version", ""))
    if spacy_model_name != "core_web_sm" or spacy_model_version != "3.8.0":
        raise ValueError(
            "WebShop requires the en_core_web_sm 3.8.0 reward model; found "
            f"{spacy_model_name!r} {spacy_model_version!r}"
        )
    java_version = subprocess.run(
        ["java", "-version"],
        check=True,
        capture_output=True,
        text=True,
    ).stderr.splitlines()[0]
    if '"21.' not in java_version:
        raise ValueError(f"WebShop Pyserini requires Java 21; found {java_version}")

    return {
        "search_backend": "pyserini-lucene",
        "search_index_document_count": document_count,
        "search_index_submitted_document_count": int(
            manifest["submitted_document_count"]
        ),
        "search_index_empty_projection_count": int(
            manifest["empty_projection_count"]
        ),
        "search_index_source_sha256": str(manifest["source_sha256"]),
        "pyserini_version": str(manifest["pyserini_version"]),
        "anserini_version": str(manifest["anserini_version"]),
        "spacy_version": spacy_version,
        "spacy_model_name": "en_core_web_sm",
        "spacy_model_version": spacy_model_version,
        "thefuzz_version": version("thefuzz"),
        "java_version": java_version,
    }


def _install_bm25_after_load_products() -> None:
    """Wrap ``SimServer.__init__`` so that after products are loaded, we
    install a real BM25 index into ``self.search_engine``.
    """
    _ensure_upstream_on_path()
    from web_agent_site.engine import engine as _engine  # type: ignore[import-not-found]
    from web_agent_site.envs import web_agent_text_env as _wate  # type: ignore[import-not-found]

    factory = getattr(_engine, "_bm25_searcher_factory", None)
    if factory is None:
        return  # pyserini path; nothing to patch.

    if getattr(_wate.SimServer, "_elizaos_bm25_wrapped", False):
        return

    original_init = _wate.SimServer.__init__

    def patched_init(self: Any, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        if self.search_engine is None and getattr(self, "all_products", None):
            self.search_engine = factory(self.all_products)
            logger.info(
                "[WebShopEnvironment] BM25Okapi fallback (no pyserini); %d products indexed.",
                len(self.all_products),
            )

    _wate.SimServer.__init__ = patched_init  # type: ignore[assignment]
    _wate.SimServer._elizaos_bm25_wrapped = True  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StepOutcome:
    observation: PageObservation
    reward: float
    done: bool
    info: dict[str, Any]


# ---------------------------------------------------------------------------
# WebShopEnvironment: adapter around upstream's gym env
# ---------------------------------------------------------------------------


class WebShopEnvironment:
    """Adapter around upstream ``WebAgentTextEnv``.

    Parameters
    ----------
    file_path:
        Path to a WebShop ``items_shuffle*.json`` product catalog (required).
    attr_path / human_attr_path:
        Override ``web_agent_site.utils.DEFAULT_ATTR_PATH`` and
        ``HUMAN_ATTR_PATH`` before the env loads.
    num_products:
        Restrict to the first N products (``None`` = full catalog).
    human_goals:
        If True, sample tasks from ``items_human_ins.json`` (12,087 human
        instructions). If False, use synthetic goals derived from attrs.
    observation_mode:
        ``"text"`` (simple), ``"text_rich"`` (with tag markers), or ``"html"``.
    """

    def __init__(
        self,
        *,
        file_path: str | Path,
        attr_path: str | Path | None = None,
        human_attr_path: str | Path | None = None,
        num_products: int | None = None,
        human_goals: bool = True,
        observation_mode: str = "text",
        require_official_search: bool = False,
    ) -> None:
        _ensure_upstream_on_path()
        _patch_search_engine_for_bm25_fallback(
            force_bm25=not require_official_search
        )
        if require_official_search:
            self._runtime_provenance = _configure_official_lucene_search()
        else:
            _install_bm25_after_load_products()
            self._runtime_provenance = {
                "search_backend": (
                    "smoke-token-overlap"
                    if os.environ.get("WEBSHOP_ALLOW_SPACY_STUB")
                    else "rank-bm25"
                )
            }

        from web_agent_site import utils as _utils  # type: ignore[import-not-found]
        from web_agent_site.engine import engine as _engine_mod  # type: ignore[import-not-found]
        if attr_path is not None:
            _utils.DEFAULT_ATTR_PATH = str(attr_path)
            _engine_mod.DEFAULT_ATTR_PATH = str(attr_path)
        if human_attr_path is not None:
            _utils.HUMAN_ATTR_PATH = str(human_attr_path)
            _engine_mod.HUMAN_ATTR_PATH = str(human_attr_path)

        from web_agent_site.envs.web_agent_text_env import (  # type: ignore[import-not-found]
            WebAgentTextEnv,
        )

        upstream_mode = (
            "text" if observation_mode == "text"
            else "text_rich" if observation_mode == "text_rich"
            else "html"
        )

        random_state = random.getstate()
        try:
            # Upstream randomizes product prices before it applies its fixed
            # goal shuffle. Pinning the initial state gives every harness the
            # same price constraints while preserving the published shuffle.
            random.seed(_ENVIRONMENT_RANDOM_SEED)
            self._gym_env = WebAgentTextEnv(
                observation_mode=upstream_mode,
                file_path=str(file_path),
                num_products=num_products,
                human_goals=int(bool(human_goals)),
            )
        finally:
            random.setstate(random_state)
        self._task: WebShopTask | None = None
        self._done: bool = False
        self._final_reward: float = 0.0
        self._purchased_asin: str | None = None
        self._last_observation: PageObservation | None = None

    # ----- read-only state ----------------------------------------------------

    @property
    def gym_env(self) -> Any:
        return self._gym_env

    @property
    def purchased_product_id(self) -> str | None:
        return self._purchased_asin

    @property
    def done(self) -> bool:
        return self._done

    @property
    def final_reward(self) -> float:
        return self._final_reward

    @property
    def upstream_goals(self) -> list[dict[str, Any]]:
        return list(self._gym_env.server.goals)

    @property
    def catalog_product_count(self) -> int:
        return len(self._gym_env.server.all_products)

    @property
    def runtime_provenance(self) -> dict[str, str | int]:
        return dict(self._runtime_provenance)

    @property
    def instruction_text(self) -> str:
        return getattr(self._gym_env, "instruction_text", "") or ""

    @property
    def available_actions(self) -> list[str]:
        info = self._gym_env.get_available_actions()
        clickables: list[str] = list(info.get("clickables", []))
        actions: list[str] = []
        if info.get("has_search_bar"):
            actions.append("search[<query>]")
        for c in clickables:
            if c == "search":
                continue
            actions.append(f"click[{c}]")
        return actions

    # ----- gym-like API -------------------------------------------------------

    def reset(self, task: WebShopTask | None = None) -> PageObservation:
        self._task = task
        self._done = False
        self._final_reward = 0.0
        self._purchased_asin = None

        if task is not None and task.instruction:
            self._gym_env.server.assigned_instruction_text = task.instruction
        else:
            self._gym_env.server.assigned_instruction_text = None

        obs_text, _info = self._gym_env.reset()
        self._install_task_goal(task)
        observation = self._wrap_observation(obs_text)
        self._last_observation = observation
        return observation

    def step(self, action: str) -> StepOutcome:
        if self._done:
            obs = self._wrap_observation("Episode already completed.")
            return StepOutcome(obs, 0.0, True, {"error": "episode_done"})

        obs_text, reward, done, info = self._gym_env.step(action)
        observation = self._wrap_observation(obs_text)
        self._last_observation = observation
        if done:
            self._done = True
            self._final_reward = float(reward)
            session_id = getattr(self._gym_env, "session", None)
            sessions = getattr(self._gym_env.server, "user_sessions", {})
            session = sessions.get(session_id) if session_id else None
            if session:
                self._purchased_asin = session.get("asin")
        return StepOutcome(
            observation=observation,
            reward=float(reward),
            done=bool(done),
            info=dict(info or {}),
        )

    def close(self) -> None:
        self._gym_env.close()

    # ----- helpers ------------------------------------------------------------

    def _install_task_goal(self, task: WebShopTask | None) -> None:
        if task is None:
            return
        raw_goal = task.metadata.get("upstream_goal_json")
        if not isinstance(raw_goal, str) or not raw_goal.strip():
            return
        try:
            goal = json.loads(raw_goal)
        except json.JSONDecodeError:
            return
        session_id = getattr(self._gym_env, "session", None)
        sessions = getattr(self._gym_env.server, "user_sessions", {})
        session = sessions.get(session_id) if session_id else None
        if not isinstance(session, dict):
            return
        session["goal"] = goal
        if task.instruction:
            session["goal"]["instruction_text"] = task.instruction

    def _wrap_observation(self, raw: str) -> PageObservation:
        url = getattr(self._gym_env.browser, "current_url", "") or ""
        page_type = _infer_page_type(url)
        return PageObservation(
            page_type=page_type,
            message=raw,
            query=None,
            results=None,
            product=None,
            selected_options={},
            available_actions=self.available_actions,
        )


def _infer_page_type(url: str) -> PageType:
    if "done/" in url:
        return PageType.CONFIRMATION
    if "item_page/" in url or "item_sub_page/" in url:
        return PageType.PRODUCT
    if "search_results/" in url:
        return PageType.RESULTS
    return PageType.SEARCH


# ---------------------------------------------------------------------------
# Public reward re-export — for evaluator / tests
# ---------------------------------------------------------------------------


def get_reward(
    purchased_product: dict[str, Any],
    goal: dict[str, Any],
    *,
    price: float,
    options: dict[str, str],
    verbose: bool = False,
) -> Any:
    """Direct re-export of upstream's TF-IDF / fuzzy-match reward."""
    _ensure_upstream_on_path()
    _patch_search_engine_for_bm25_fallback(force_bm25=True)
    from web_agent_site.engine.goal import (  # type: ignore[import-not-found]
        get_reward as _upstream_get_reward,
    )
    return _upstream_get_reward(
        purchased_product,
        goal,
        price=price,
        options=options,
        verbose=verbose,
    )


__all__ = [
    "StepOutcome",
    "WebShopEnvironment",
    "get_reward",
]
