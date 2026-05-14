"""elizaOS WebShop environment.

Adapter over **Princeton-NLP WebShop's** ``WebAgentTextEnv`` Gym environment
(vendored under ``upstream/web_agent_site``).

Reward is computed by upstream's
``web_agent_site.engine.goal.get_reward`` (TF-IDF / fuzzy-match score over
title, attributes, options, and price). The old in-process state machine
and custom scoring code have been removed entirely.

The optional Lucene/pyserini search engine is *replaced* with an in-process
BM25 fallback (``rank_bm25``) when pyserini is unavailable. The reward
function itself is unchanged.
"""

from __future__ import annotations

import logging
import sys
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


def _ensure_upstream_on_path() -> None:
    """Make ``import web_agent_site`` resolve to our vendored copy."""
    upstream_str = str(_UPSTREAM_DIR)
    if upstream_str not in sys.path:
        sys.path.insert(0, upstream_str)


def _patch_search_engine_for_bm25_fallback() -> None:
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

    from web_agent_site.engine import engine as _engine  # type: ignore[import-not-found]

    if pyserini_available:
        return

    if getattr(_engine, "_elizaos_bm25_patched", False):
        return

    try:
        from rank_bm25 import BM25Okapi  # type: ignore[import-not-found]
    except Exception as exc:
        raise RuntimeError(
            "Neither pyserini nor rank_bm25 is available. Install one of:\n"
            "  pip install rank_bm25       # lightweight, recommended\n"
            "  pip install pyserini       # requires Java 11+\n"
            f"(import error: {exc})"
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
            self._bm25 = BM25Okapi(corpus) if corpus else None
            self._docs = {asin: _BM25Doc(_json.dumps({"id": asin})) for asin in self._ids}

        def search(self, query: str, k: int = 50) -> list[_BM25Hit]:
            if self._bm25 is None:
                return []
            scores = self._bm25.get_scores(query.lower().split())
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
    ) -> None:
        _ensure_upstream_on_path()
        _patch_search_engine_for_bm25_fallback()
        _install_bm25_after_load_products()

        from web_agent_site import utils as _utils  # type: ignore[import-not-found]
        if attr_path is not None:
            _utils.DEFAULT_ATTR_PATH = str(attr_path)
        if human_attr_path is not None:
            _utils.HUMAN_ATTR_PATH = str(human_attr_path)

        from web_agent_site.envs.web_agent_text_env import (  # type: ignore[import-not-found]
            WebAgentTextEnv,
        )

        upstream_mode = (
            "text" if observation_mode == "text"
            else "text_rich" if observation_mode == "text_rich"
            else "html"
        )

        self._gym_env = WebAgentTextEnv(
            observation_mode=upstream_mode,
            file_path=str(file_path),
            num_products=num_products,
            human_goals=int(bool(human_goals)),
        )
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
    _patch_search_engine_for_bm25_fallback()
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
