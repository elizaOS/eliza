"""Mock Knowledge Base API service for agent evaluation (FastAPI on port 9106)."""

from __future__ import annotations

import json
import copy
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Mock KB API")

from mock_services._base import add_error_injection
add_error_injection(app)

FIXTURES_PATH = Path(os.environ.get(
    "KB_FIXTURES",
    str(Path(__file__).resolve().parent.parent.parent / "tasks" / "T015zh_kb_search" / "fixtures" / "kb" / "articles.json"),
))

_articles: list[dict[str, Any]] = []
_audit_log: list[dict[str, Any]] = []
_updates: list[dict[str, Any]] = []


def _load_fixtures() -> None:
    global _articles
    with open(FIXTURES_PATH) as f:
        _articles = json.load(f)


_load_fixtures()


def _log_call(endpoint: str, request_body: dict[str, Any], response_body: Any) -> None:
    _audit_log.append({
        "endpoint": endpoint,
        "request_body": request_body,
        "response_body": response_body,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


class SearchRequest(BaseModel):
    query: str
    category: str | None = None
    max_results: int = 5


class GetArticleRequest(BaseModel):
    article_id: str


class UpdateArticleRequest(BaseModel):
    article_id: str
    content: str


def _tokenize_chinese(text: str) -> set[str]:
    """Simple Chinese-aware tokenization: character bigrams + space-split words."""
    tokens = set()
    # Space-split for English/mixed content
    for word in text.lower().split():
        tokens.add(word)
    # Character bigrams for Chinese
    for i in range(len(text) - 1):
        bigram = text[i:i+2].lower()
        if not bigram.isspace():
            tokens.add(bigram)
    # Single Chinese characters
    for char in text:
        if '\u4e00' <= char <= '\u9fff':
            tokens.add(char)
    return tokens


@app.post("/kb/search")
def search_articles(req: SearchRequest) -> dict[str, Any]:
    results = []
    query_tokens = _tokenize_chinese(req.query)
    for article in _articles:
        if req.category and article["category"] != req.category:
            continue
        # Chinese-aware keyword matching in title, tags, and content
        searchable = (
            article["title"] + " " +
            " ".join(article["tags"]) + " " +
            article["content"]
        )
        searchable_tokens = _tokenize_chinese(searchable)
        if query_tokens & searchable_tokens:  # any overlap
            results.append({
                "article_id": article["article_id"],
                "title": article["title"],
                "category": article["category"],
                "tags": article["tags"],
                "last_updated": article["last_updated"],
                "views": article["views"],
                "snippet": article["content"][:150] + "...",
            })
    results = results[:req.max_results]
    resp = {"articles": results, "total": len(results)}
    _log_call("/kb/search", req.model_dump(), resp)
    return resp


@app.post("/kb/articles/get")
def get_article(req: GetArticleRequest) -> dict[str, Any]:
    for article in _articles:
        if article["article_id"] == req.article_id:
            resp = copy.deepcopy(article)
            _log_call("/kb/articles/get", req.model_dump(), resp)
            return resp
    resp = {"error": f"Article {req.article_id} not found"}
    _log_call("/kb/articles/get", req.model_dump(), resp)
    return resp


@app.post("/kb/articles/update")
def update_article(req: UpdateArticleRequest) -> dict[str, Any]:
    for article in _articles:
        if article["article_id"] == req.article_id:
            article["content"] = req.content
            article["last_updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            _updates.append({"article_id": req.article_id, "timestamp": datetime.now(timezone.utc).isoformat()})
            resp = {"status": "updated", "article_id": req.article_id}
            _log_call("/kb/articles/update", req.model_dump(), resp)
            return resp
    resp = {"error": f"Article {req.article_id} not found"}
    _log_call("/kb/articles/update", req.model_dump(), resp)
    return resp


@app.get("/kb/audit")
def get_audit() -> dict[str, Any]:
    return {"calls": _audit_log, "updates": _updates}


@app.post("/kb/reset")
def reset_state() -> dict[str, str]:
    global _audit_log, _updates
    _audit_log = []
    _updates = []
    _load_fixtures()
    return {"status": "reset"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "9106")))
