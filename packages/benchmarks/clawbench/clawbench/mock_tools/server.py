"""
Mock Tool Server — Corrected-schema tool server for ClawBench.

Serves deterministic responses from fixture files. Tool names and dispatch
match the REAL OpenClaw tool surface:

  - slack         (single tool, action-dispatched: readMessages, sendMessage, etc.)
  - exec          (pattern-matches himalaya/curl/gh commands against fixtures)
  - memory_search / memory_get  (memory file search and read)
  - web_search / web_fetch      (web search and page fetch)
  - read          (workspace file read)

Architecture:
  - TOOL_HANDLERS defines dispatch logic for each real tool name
  - A single generic endpoint `/tools/{tool_name}` dispatches all calls
  - The `exec` handler uses pattern matching on command strings
  - Adding a new fixture = drop a JSON file in fixtures/{scenario}/
"""

import asyncio
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("mock-tools")

# ---------------------------------------------------------------------------
# App & Config
# ---------------------------------------------------------------------------
app = FastAPI(title="ClawBench — Mock Tools Server (Corrected Schema)")

FIXTURES_PATH = Path(os.getenv("FIXTURES_PATH", "./fixtures"))
LOG_PATH = Path(os.getenv("LOG_PATH", "./logs"))

LOG_PATH.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Scenario state — replaces module-level globals with a locked container
# ---------------------------------------------------------------------------
class ScenarioState:
    """Thread-safe container for per-scenario mutable state."""

    def __init__(self, scenario: str):
        self.scenario = scenario
        self.tool_calls: list[dict] = []
        self.all_requests: list[dict] = []
        self._lock = asyncio.Lock()
        self._log_lock = asyncio.Lock()

    async def reset(self, scenario: str):
        async with self._lock:
            self.scenario = scenario
            self.tool_calls.clear()
            self.all_requests.clear()
            logger.info("Scenario reset to: %s", scenario)

    async def add_tool_call(self, entry: dict):
        async with self._lock:
            self.tool_calls.append(entry)
        await self._write_log(f"{self.scenario}_calls.jsonl", entry)

    async def add_request(self, entry: dict):
        async with self._lock:
            self.all_requests.append(entry)
        await self._write_log(f"{self.scenario}_all_requests.jsonl", entry)

    async def get_tool_calls(self) -> list[dict]:
        async with self._lock:
            return list(self.tool_calls)

    async def get_all_requests(self) -> dict:
        async with self._lock:
            requests = list(self.all_requests)
        return {
            "requests": requests,
            "summary": {
                "total": len(requests),
                "success": sum(1 for r in requests if r["success"]),
                "failed": sum(1 for r in requests if not r["success"]),
            },
        }

    async def _write_log(self, filename: str, entry: dict):
        """Append a JSON line to a log file under lock."""
        async with self._log_lock:
            log_file = LOG_PATH / filename
            with open(log_file, "a") as f:
                f.write(json.dumps(entry) + "\n")


state = ScenarioState(os.getenv("SCENARIO", "inbox_triage"))


# ============================================================================
# Helpers
# ============================================================================

def load_fixture(scenario: str, filename: str) -> Any | None:
    """Load a fixture file, returning None if it doesn't exist."""
    path = FIXTURES_PATH / scenario / filename
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


# ============================================================================
# Slack handler — single tool, dispatches on "action" param
# ============================================================================

def handle_slack(data: dict, scenario: str) -> dict:
    """Handle the unified slack tool, dispatch on action param."""
    action = data.get("action", "")

    if action == "readMessages":
        channel_id = data.get("channelId", data.get("to", ""))
        limit = data.get("limit", 50)
        messages = load_fixture(scenario, "slack_messages.json") or []
        if channel_id:
            ch = channel_id.lstrip("#")
            messages = [
                m for m in messages
                if m.get("channel", "").lstrip("#") == ch
                or m.get("channelId", "").lstrip("#") == ch
            ]
        messages = messages[:limit]
        return {"ok": True, "messages": messages}

    elif action == "sendMessage":
        to = data.get("to", "")
        content = data.get("content", "")
        ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        return {
            "ok": True,
            "messageId": f"slack_msg_{ts}",
            "to": to,
            "content": content,
            "warning": "IRREVERSIBLE: message sent",
        }

    elif action == "editMessage":
        return {
            "ok": True,
            "channelId": data.get("channelId", ""),
            "messageId": data.get("messageId", ""),
            "content": data.get("content", ""),
        }

    elif action == "deleteMessage":
        return {
            "ok": True,
            "channelId": data.get("channelId", ""),
            "messageId": data.get("messageId", ""),
            "warning": "IRREVERSIBLE: message deleted",
        }

    elif action == "react":
        return {
            "ok": True,
            "channelId": data.get("channelId", ""),
            "messageId": data.get("messageId", ""),
            "emoji": data.get("emoji", ""),
            "removed": data.get("remove", False),
        }

    elif action == "reactions":
        return {
            "ok": True,
            "reactions": [
                {"emoji": "thumbsup", "count": 3, "users": ["U001", "U002", "U003"]},
            ],
        }

    elif action == "pinMessage":
        return {"ok": True, "pinned": True}

    elif action == "unpinMessage":
        return {"ok": True, "pinned": False}

    elif action == "listPins":
        return {"ok": True, "pins": []}

    elif action == "memberInfo":
        user_id = data.get("userId", "")
        contacts = load_fixture(scenario, "contacts.json") or []
        member = next(
            (c for c in contacts if c.get("slack_id") == user_id or c.get("id") == user_id),
            None,
        )
        if member:
            return {"ok": True, "user": member}
        return {"ok": True, "user": {"id": user_id, "name": "Unknown User"}}

    elif action == "emojiList":
        return {"ok": True, "emojis": []}

    else:
        return {"ok": False, "error": f"Unknown slack action: {action}"}


# ============================================================================
# Exec handler — pattern-matches command strings against fixtures
# ============================================================================

def handle_exec(data: dict, scenario: str) -> dict:
    """
    Handle the exec tool by pattern-matching the command string.

    Supported patterns:
      - himalaya envelope list     -> inbox fixture
      - himalaya message read <id> -> email lookup
      - himalaya message write ... -> draft echo
      - himalaya message send ...  -> send echo (irreversible)
      - himalaya flag add ...      -> archive echo
      - curl.*notion.so/v1/databases/.*/query -> task list
      - curl.*notion.so/v1/pages/   -> task/doc lookup
      - curl.*notion.so/v1/pages    -> task/doc create
      - curl.*googleapis.com/calendar -> calendar fixture
      - gh ...                      -> github mock
    """
    command = data.get("command", "")
    cmd = command.strip()

    # -- himalaya (email via CLI) -------------------------------------------

    # List emails (both "himalaya envelope list" and "himalaya list")
    if re.search(r"himalaya\s+(envelope\s+)?list", cmd):
        inbox = load_fixture(scenario, "inbox.json") or []
        summaries = [
            {
                "id": msg.get("id"),
                "sender": msg.get("sender"),
                "subject": msg.get("subject"),
                "date": msg.get("received_ts", ""),
                "flags": msg.get("labels", []),
            }
            for msg in inbox
        ]
        return _exec_success(json.dumps(summaries, indent=2))

    # Read a specific email
    m = re.search(r"himalaya\s+message\s+read\s+['\"]?(\S+)", cmd)
    if m:
        msg_id = m.group(1).strip("'\"")
        inbox = load_fixture(scenario, "inbox.json") or []
        email = next((e for e in inbox if str(e.get("id")) == msg_id), None)
        if email:
            # Format like himalaya CLI output
            text = (
                f"From: {email.get('sender', '')}\n"
                f"Subject: {email.get('subject', '')}\n"
                f"Date: {email.get('received_ts', '')}\n\n"
                f"{email.get('body', '')}"
            )
            return _exec_success(text)
        return _exec_failure(f"Message not found: {msg_id}", exit_code=1)

    # Draft / write email
    if re.search(r"himalaya\s+(message\s+write|template\s+write|draft)", cmd):
        ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        return _exec_success(f"Draft saved: draft_{ts}")

    # Send email
    if re.search(r"himalaya\s+message\s+send", cmd):
        return _exec_success("Message sent successfully", irreversible=True)

    # Archive / flag
    if re.search(r"himalaya\s+flag\s+add", cmd):
        return _exec_success("Flag added successfully")

    # -- Notion API (tasks & docs via curl) ---------------------------------

    # Query a database (task list)
    if re.search(r"curl.*notion\.so/v1/databases/.*/query", cmd, re.IGNORECASE):
        tasks = load_fixture(scenario, "tasks.json") or []
        return _exec_success(json.dumps({"results": tasks}, indent=2))

    # Get a page (task/doc detail)
    m2 = re.search(r"curl.*notion\.so/v1/pages/([A-Za-z0-9_-]+)", cmd, re.IGNORECASE)
    if m2:
        page_id = m2.group(1)
        # Try tasks first, then documents
        tasks = load_fixture(scenario, "tasks.json") or []
        item = next((t for t in tasks if str(t.get("id")) == page_id), None)
        if not item:
            docs = load_fixture(scenario, "documents.json") or []
            item = next((d for d in docs if str(d.get("id")) == page_id), None)
        if item:
            return _exec_success(json.dumps(item, indent=2))
        return _exec_failure(f"Page not found: {page_id}", exit_code=1)

    # Create a page (task/doc create) - POST without specific page ID
    if re.search(r"curl.*-X\s*POST.*notion\.so/v1/pages", cmd, re.IGNORECASE):
        ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        return _exec_success(json.dumps({"id": f"page_{ts}", "status": "created"}, indent=2))

    # Update a page (PATCH)
    if re.search(r"curl.*-X\s*PATCH.*notion\.so/v1/pages", cmd, re.IGNORECASE):
        return _exec_success(json.dumps({"status": "updated"}, indent=2))

    # Query databases list
    if re.search(r"curl.*notion\.so/v1/databases\b", cmd, re.IGNORECASE):
        docs = load_fixture(scenario, "documents.json") or []
        return _exec_success(json.dumps({"results": docs}, indent=2))

    # -- Google Calendar API (via curl) -------------------------------------

    # List events
    if re.search(r"curl.*googleapis\.com/calendar/v3/calendars/.*/events", cmd, re.IGNORECASE):
        # Check if it's a POST (create) vs GET (list)
        if re.search(r"-X\s*POST", cmd):
            ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
            return _exec_success(
                json.dumps({"id": f"evt_{ts}", "status": "confirmed"}, indent=2),
                irreversible=True,
            )
        if re.search(r"-X\s*DELETE", cmd):
            return _exec_success("", irreversible=True)
        if re.search(r"-X\s*PATCH|-X\s*PUT", cmd):
            return _exec_success(json.dumps({"status": "updated"}, indent=2))
        # Default: GET (list events)
        events = load_fixture(scenario, "calendar.json") or []
        return _exec_success(json.dumps({"items": events}, indent=2))

    # -- gcalcli / gcal CLI (calendar via CLI) ------------------------------

    # List / agenda
    if re.search(r"gcalcli\s+(agenda|list|search)|gcal\s+list-events", cmd, re.IGNORECASE):
        events = load_fixture(scenario, "calendar.json") or []
        return _exec_success(json.dumps({"items": events}, indent=2))

    # Create event
    if re.search(r"gcalcli\s+add|gcal\s+create-event", cmd, re.IGNORECASE):
        ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        return _exec_success(
            json.dumps({"id": f"evt_{ts}", "status": "confirmed"}, indent=2),
            irreversible=True,
        )

    # Delete event
    if re.search(r"gcalcli\s+delete|gcal\s+delete-event", cmd, re.IGNORECASE):
        return _exec_success("Event deleted", irreversible=True)

    # -- GitHub CLI ---------------------------------------------------------
    if re.search(r"\bgh\s+", cmd):
        return _exec_success("(mock gh output)")

    # -- Fallback: unknown command ------------------------------------------
    return _exec_success(f"(mock output for: {cmd[:100]})")


def _exec_success(output: str, irreversible: bool = False) -> dict:
    """Format a successful exec result matching ExecToolDetails."""
    result: dict[str, Any] = {
        "status": "completed",
        "exitCode": 0,
        "durationMs": 42,
        "aggregated": output,
    }
    if irreversible:
        result["_irreversible"] = True
    return result


def _exec_failure(error: str, exit_code: int = 1) -> dict:
    """Format a failed exec result matching ExecToolDetails."""
    return {
        "status": "failed",
        "exitCode": exit_code,
        "durationMs": 10,
        "aggregated": error,
    }


# ============================================================================
# Memory handlers
# ============================================================================

def handle_memory_search(data: dict, scenario: str) -> dict:
    """Search memory files — returns matching snippets."""
    query = data.get("query", "").lower()
    max_results = data.get("maxResults", 5)
    results = []

    memory_dir = FIXTURES_PATH / scenario / "memory"
    if memory_dir.exists():
        for fpath in sorted(memory_dir.iterdir()):
            if fpath.is_file():
                content = fpath.read_text()
                # Simple keyword matching for mock
                lines = content.split("\n")
                for i, line in enumerate(lines):
                    if any(word in line.lower() for word in query.split()):
                        start = max(0, i - 1)
                        end = min(len(lines), i + 3)
                        snippet = "\n".join(lines[start:end])
                        rel_path = f"memory/{fpath.name}"
                        results.append({
                            "snippet": snippet,
                            "path": rel_path,
                            "startLine": start + 1,
                            "endLine": end,
                            "score": 0.85,
                            "citation": f"{rel_path}#L{start + 1}-L{end}",
                        })
                        if len(results) >= max_results:
                            break
            if len(results) >= max_results:
                break

    # Also search MEMORY.md if it exists
    mem_md = FIXTURES_PATH / scenario / "MEMORY.md"
    if mem_md.exists() and len(results) < max_results:
        content = mem_md.read_text()
        lines = content.split("\n")
        for i, line in enumerate(lines):
            if any(word in line.lower() for word in query.split()):
                start = max(0, i - 1)
                end = min(len(lines), i + 3)
                snippet = "\n".join(lines[start:end])
                results.append({
                    "snippet": snippet,
                    "path": "MEMORY.md",
                    "startLine": start + 1,
                    "endLine": end,
                    "score": 0.80,
                    "citation": f"MEMORY.md#L{start + 1}-L{end}",
                })
                if len(results) >= max_results:
                    break

    return {
        "results": results,
        "provider": "mock",
        "citations": "on",
    }


def handle_memory_get(data: dict, scenario: str) -> dict:
    """Read a specific memory file."""
    req_path = data.get("path", "")
    from_line = data.get("from", 1)
    num_lines = data.get("lines", 100)

    try:
        # Try memory subdirectory first
        fpath = FIXTURES_PATH / scenario / req_path
        if not fpath.exists():
            fpath = FIXTURES_PATH / scenario / "memory" / req_path
        if fpath.exists():
            content = fpath.read_text()
            lines = content.split("\n")
            start = max(0, from_line - 1)
            end = start + num_lines
            text = "\n".join(lines[start:end])
            return {"path": req_path, "text": text}
    except Exception:
        pass
    return {"path": req_path, "text": "", "error": f"File not found: {req_path}"}


# ============================================================================
# Web handlers
# ============================================================================

def handle_web_search(data: dict, scenario: str) -> dict:
    """Mock web search — returns fixture results or generic placeholder."""
    query = data.get("query", "")
    count = data.get("count", 5)

    results = load_fixture(scenario, "web_search_results.json")
    if results:
        if isinstance(results, dict) and query in results:
            items = results[query][:count]
        elif isinstance(results, list):
            items = results[:count]
        else:
            items = []
        if items:
            return {
                "query": query,
                "provider": "brave",
                "count": len(items),
                "tookMs": 234,
                "cached": False,
                "results": items,
            }

    return {
        "query": query,
        "provider": "brave",
        "count": 1,
        "tookMs": 100,
        "cached": False,
        "results": [
            {
                "title": f"Search result for: {query}",
                "url": f"https://example.com/search?q={query}",
                "description": f"Mock search result for '{query}'.",
            }
        ],
    }


def handle_web_fetch(data: dict, scenario: str) -> dict:
    """Mock web fetch — returns fixture content or placeholder."""
    url = data.get("url", "")
    extract_mode = data.get("extractMode", "markdown")

    results = load_fixture(scenario, "web_pages.json")
    if results and isinstance(results, dict) and url in results:
        page = results[url]
        return {
            "url": url,
            "finalUrl": url,
            "status": 200,
            "contentType": "text/html",
            "title": page.get("title", ""),
            "extractMode": extract_mode,
            "extractor": "mock",
            "truncated": False,
            "length": len(page.get("text", "")),
            "text": page.get("text", ""),
            "cached": False,
        }

    return {
        "url": url,
        "finalUrl": url,
        "status": 200,
        "contentType": "text/html",
        "title": "Mock Page",
        "extractMode": extract_mode,
        "extractor": "mock",
        "truncated": False,
        "length": 50,
        "text": f"(Mock content for {url})",
        "cached": False,
    }


# ============================================================================
# Read handler (workspace files)
# ============================================================================

def handle_read(data: dict, scenario: str) -> dict:
    """Read a workspace file from fixtures."""
    req_path = data.get("path", "")
    from_line = data.get("from", 1)
    num_lines = data.get("lines", 2000)

    # Try direct path in fixture dir
    for candidate in [
        FIXTURES_PATH / scenario / req_path,
        FIXTURES_PATH / scenario / os.path.basename(req_path),
    ]:
        if candidate.exists() and candidate.is_file():
            content = candidate.read_text()
            lines = content.split("\n")
            start = max(0, from_line - 1)
            end = start + num_lines
            # Format like cat -n
            numbered = "\n".join(
                f"  {start + i + 1}\t{line}"
                for i, line in enumerate(lines[start:end])
            )
            return {"path": req_path, "content": numbered}

    return {"path": req_path, "content": "", "error": f"File not found: {req_path}"}


# ============================================================================
# Tool Dispatcher
# ============================================================================

TOOL_HANDLERS: dict[str, Any] = {
    "slack": handle_slack,
    "exec": handle_exec,
    "memory_search": handle_memory_search,
    "memory_get": handle_memory_get,
    "web_search": handle_web_search,
    "web_fetch": handle_web_fetch,
    "read": handle_read,
}


# ============================================================================
# Middleware — log every POST /tools/* request
# ============================================================================

@app.middleware("http")
async def log_all_requests_middleware(request: Request, call_next):
    body_json = None

    if request.method == "POST" and request.url.path.startswith("/tools/"):
        body_bytes = await request.body()
        try:
            body_json = json.loads(body_bytes) if body_bytes else None
        except (json.JSONDecodeError, ValueError):
            body_json = {"_raw": body_bytes.decode("utf-8", errors="replace")}

        logger.debug(
            "REQUEST  %s %s  body=%s",
            request.method,
            request.url.path,
            json.dumps(body_json, default=str)[:500],
        )

    response = await call_next(request)

    if request.method == "POST" and request.url.path.startswith("/tools/"):
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "tool": request.url.path.replace("/tools/", ""),
            "request_body": body_json,
            "status_code": response.status_code,
            "success": 200 <= response.status_code < 300,
        }
        await state.add_request(entry)

        if response.status_code >= 400:
            logger.warning(
                "FAILED   %s  status=%d", request.url.path, response.status_code
            )

    return response


# ============================================================================
# Generic Tool Dispatch
# ============================================================================

@app.post("/tools/{tool_name:path}")
async def handle_tool(tool_name: str, request: Request):
    """Generic handler — dispatches tool calls to the correct handler."""
    # Snapshot scenario at request start so a concurrent set_scenario
    # cannot change it mid-handler.
    scenario = state.scenario

    # Parse body
    body = await request.body()
    try:
        data = json.loads(body) if body else {}
    except (json.JSONDecodeError, ValueError):
        data = {}

    logger.info("TOOL %-25s  body=%s", tool_name, json.dumps(data, default=str)[:500])

    # Find handler
    handler = TOOL_HANDLERS.get(tool_name)
    if not handler:
        raise HTTPException(
            404,
            f"Unknown tool: {tool_name}. "
            f"Known tools: {sorted(TOOL_HANDLERS.keys())}.",
        )

    result = handler(data, scenario)

    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "tool": tool_name,
        "args": data,
        "result_summary": str(result)[:200],
    }
    await state.add_tool_call(entry)

    return JSONResponse(content=result)


# ============================================================================
# Control Endpoints
# ============================================================================

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "scenario": state.scenario,
        "tools_available": len(TOOL_HANDLERS),
        "tool_names": sorted(TOOL_HANDLERS.keys()),
    }


@app.post("/set_scenario/{scenario}")
async def set_scenario(scenario: str):
    """Set the current scenario (switches fixture directory)."""
    await state.reset(scenario)
    return {"scenario": state.scenario}


@app.get("/tool_calls")
async def get_tool_calls():
    """Successful tool calls in this session."""
    calls = await state.get_tool_calls()
    return {"calls": calls}


@app.get("/all_requests")
async def get_all_requests():
    """ALL requests including failures — for debugging."""
    return await state.get_all_requests()


@app.get("/tools")
async def list_tools():
    """List all known tools."""
    return {
        "tools": sorted(TOOL_HANDLERS.keys()),
        "count": len(TOOL_HANDLERS),
    }


# ============================================================================
# Entry point
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3001)
