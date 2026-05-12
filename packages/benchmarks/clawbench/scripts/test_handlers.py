#!/usr/bin/env python3
"""
Test mock tool handlers directly (no server needed).

This tests the Python handler functions in-process — fastest possible
validation. No Docker, no HTTP server, no network.

Usage:
    cd clawbench
    python scripts/test_handlers.py
    python scripts/test_handlers.py --scenario client_escalation
"""

import argparse
import json
import os
import sys

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"


def check(name: str, ok: bool, detail: str = ""):
    status = PASS if ok else FAIL
    suffix = f" — {detail}" if detail else ""
    print(f"  [{status}] {name}{suffix}")
    return ok


def main():
    parser = argparse.ArgumentParser(description="Test handler functions directly (no server)")
    parser.add_argument("--scenario", default="client_escalation", help="Scenario to test against")
    args = parser.parse_args()

    # Set env before importing
    os.environ["FIXTURES_PATH"] = "./fixtures"
    os.environ["SCENARIO"] = args.scenario

    from clawbench.mock_tools.server import (
        handle_exec,
        handle_memory_get,
        handle_memory_search,
        handle_read,
        handle_slack,
        handle_web_fetch,
        handle_web_search,
    )

    scenario = args.scenario

    print("=" * 60)
    print(f"Handler Unit Tests (scenario: {scenario})")
    print("=" * 60)

    passed = 0
    failed = 0

    def run(name, ok, detail=""):
        nonlocal passed, failed
        if check(name, ok, detail):
            passed += 1
        else:
            failed += 1

    # ── Slack ──────────────────────────────────────────────────────

    print("\n--- Slack handler ---")

    r = handle_slack({"action": "readMessages", "channelId": "C_ENG"}, scenario)
    run("readMessages (all)", r["ok"] and len(r["messages"]) > 0, f"{len(r['messages'])} msgs")

    r = handle_slack({"action": "readMessages", "channelId": "C_ENG", "limit": 2}, scenario)
    run("readMessages (limit=2)", r["ok"] and len(r["messages"]) == 2, f"{len(r['messages'])} msgs")

    r = handle_slack({"action": "readMessages", "channelId": "C_INCIDENTS"}, scenario)
    run("readMessages (incidents)", r["ok"] and len(r["messages"]) > 0, f"{len(r['messages'])} msgs")

    r = handle_slack({"action": "readMessages", "channelId": "NONEXISTENT"}, scenario)
    run("readMessages (empty channel)", r["ok"] and len(r["messages"]) == 0)

    r = handle_slack({"action": "sendMessage", "to": "C_ENG", "content": "hello"}, scenario)
    run("sendMessage", r["ok"] and "messageId" in r)

    r = handle_slack({"action": "react", "channelId": "C_ENG", "messageId": "sm_101", "emoji": "thumbsup"}, scenario)
    run("react", r["ok"])

    r = handle_slack({"action": "memberInfo", "userId": "U_MARCUS"}, scenario)
    run("memberInfo (known)", r["ok"] and r["user"]["name"] == "Marcus Johnson")

    r = handle_slack({"action": "memberInfo", "userId": "U_UNKNOWN"}, scenario)
    run("memberInfo (unknown)", r["ok"] and r["user"]["name"] == "Unknown User")

    r = handle_slack({"action": "listPins", "channelId": "C_ENG"}, scenario)
    run("listPins", r["ok"])

    r = handle_slack({"action": "emojiList"}, scenario)
    run("emojiList", r["ok"])

    r = handle_slack({"action": "bogus_action"}, scenario)
    run("unknown action -> error", not r["ok"])

    # ── Exec: himalaya ────────────────────────────────────────────

    print("\n--- Exec handler: himalaya ---")

    r = handle_exec({"command": "himalaya envelope list"}, scenario)
    items = json.loads(r["aggregated"])
    run("envelope list", r["status"] == "completed" and len(items) > 0, f"{len(items)} emails")

    r = handle_exec({"command": "himalaya message read msg_101"}, scenario)
    run("message read (exists)", r["status"] == "completed" and "ESCALATION" in r["aggregated"])

    r = handle_exec({"command": "himalaya message read 'msg_104'"}, scenario)
    run("message read (quoted id)", r["status"] == "completed" and "cursor" in r["aggregated"].lower())

    r = handle_exec({"command": "himalaya message read msg_999"}, scenario)
    run("message read (missing)", r["status"] == "failed" and r["exitCode"] == 1)

    r = handle_exec({"command": "himalaya template write --to someone@test.com"}, scenario)
    run("template write (draft)", r["status"] == "completed" and "Draft" in r["aggregated"])

    r = handle_exec({"command": "himalaya message send"}, scenario)
    run("message send (irreversible)", r["status"] == "completed" and r.get("_irreversible") is True)

    r = handle_exec({"command": "himalaya flag add --flag Seen msg_002"}, scenario)
    run("flag add", r["status"] == "completed")

    # ── Exec: Notion ──────────────────────────────────────────────

    print("\n--- Exec handler: curl Notion ---")

    r = handle_exec({"command": 'curl -X POST https://api.notion.so/v1/databases/db_123/query -H "Authorization: Bearer secret"'}, scenario)
    results = json.loads(r["aggregated"])["results"]
    run("databases query (tasks)", r["status"] == "completed" and len(results) > 0, f"{len(results)} tasks")

    r = handle_exec({"command": "curl https://api.notion.so/v1/pages/TC-950"}, scenario)
    item = json.loads(r["aggregated"])
    run("pages get (TC-950)", r["status"] == "completed" and item.get("title") == "Data export timeout for large datasets")

    r = handle_exec({"command": "curl https://api.notion.so/v1/pages/NONEXISTENT"}, scenario)
    run("pages get (missing)", r["status"] == "failed")

    r = handle_exec({"command": 'curl -X POST https://api.notion.so/v1/pages -d \'{"title":"new task"}\''}, scenario)
    run("pages create", r["status"] == "completed" and "created" in r["aggregated"])

    r = handle_exec({"command": 'curl -X PATCH https://api.notion.so/v1/pages/TC-950 -d \'{"status":"done"}\''}, scenario)
    run("pages update", r["status"] == "completed" and "updated" in r["aggregated"])

    # ── Exec: Google Calendar ─────────────────────────────────────

    print("\n--- Exec handler: curl Google Calendar ---")

    r = handle_exec({"command": "curl https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=2026-02-07"}, scenario)
    items = json.loads(r["aggregated"])["items"]
    run("events list", r["status"] == "completed" and len(items) > 0, f"{len(items)} events")

    r = handle_exec({"command": 'curl -X POST https://www.googleapis.com/calendar/v3/calendars/primary/events -d \'{"summary":"test"}\''}, scenario)
    run("events create (irreversible)", r["status"] == "completed" and r.get("_irreversible") is True)

    r = handle_exec({"command": 'curl -X DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_201'}, scenario)
    run("events delete (irreversible)", r["status"] == "completed" and r.get("_irreversible") is True)

    r = handle_exec({"command": 'curl -X PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_201 -d \'{"summary":"updated"}\''}, scenario)
    run("events update", r["status"] == "completed")

    # ── Exec: gcalcli / gcal CLI ──────────────────────────────────

    print("\n--- Exec handler: gcalcli / gcal ---")

    r = handle_exec({"command": "gcalcli agenda 2026-02-07 2026-02-08"}, scenario)
    items = json.loads(r["aggregated"])["items"]
    run("gcalcli agenda", r["status"] == "completed" and len(items) > 0, f"{len(items)} events")

    r = handle_exec({"command": "gcalcli list"}, scenario)
    items = json.loads(r["aggregated"])["items"]
    run("gcalcli list", r["status"] == "completed" and len(items) > 0, f"{len(items)} events")

    r = handle_exec({"command": "gcalcli search 'standup'"}, scenario)
    items = json.loads(r["aggregated"])["items"]
    run("gcalcli search", r["status"] == "completed" and len(items) > 0, f"{len(items)} events")

    r = handle_exec({"command": "gcal list-events --date 2026-02-07"}, scenario)
    items = json.loads(r["aggregated"])["items"]
    run("gcal list-events", r["status"] == "completed" and len(items) > 0, f"{len(items)} events")

    r = handle_exec({"command": "gcalcli add --title 'Test Meeting' --when '2026-02-07 3pm'"}, scenario)
    run("gcalcli add (irreversible)", r["status"] == "completed" and r.get("_irreversible") is True)

    r = handle_exec({"command": "gcal create-event --title 'Test'"}, scenario)
    run("gcal create-event (irreversible)", r["status"] == "completed" and r.get("_irreversible") is True)

    r = handle_exec({"command": "gcalcli delete 'Test Meeting'"}, scenario)
    run("gcalcli delete (irreversible)", r["status"] == "completed" and r.get("_irreversible") is True)

    # ── Exec: himalaya list (without envelope) ────────────────────

    print("\n--- Exec handler: himalaya list ---")

    r = handle_exec({"command": "himalaya list --folder INBOX"}, scenario)
    items = json.loads(r["aggregated"])
    run("himalaya list (no envelope)", r["status"] == "completed" and len(items) > 0, f"{len(items)} emails")

    # ── Exec: gh + fallback ───────────────────────────────────────

    print("\n--- Exec handler: gh + fallback ---")

    r = handle_exec({"command": "gh pr view 356"}, scenario)
    run("gh pr view", r["status"] == "completed")

    r = handle_exec({"command": "echo hello world"}, scenario)
    run("unknown command (fallback)", r["status"] == "completed" and "mock output" in r["aggregated"])

    # ── Memory ────────────────────────────────────────────────────

    print("\n--- Memory handlers ---")

    r = handle_memory_search({"query": "Acme client"}, scenario)
    run("search (Acme)", len(r["results"]) > 0, f"{len(r['results'])} results")

    r = handle_memory_search({"query": "priorities deadline"}, scenario)
    run("search (priorities)", len(r["results"]) > 0, f"{len(r['results'])} results")

    r = handle_memory_search({"query": "xyzzynotfound"}, scenario)
    run("search (no match)", len(r["results"]) == 0)

    r = handle_memory_search({"query": "client", "maxResults": 1}, scenario)
    run("search (maxResults=1)", len(r["results"]) <= 1)

    r = handle_memory_get({"path": "memory/priorities.md"}, scenario)
    run("get priorities.md", "Current Priorities" in r.get("text", ""))

    r = handle_memory_get({"path": "memory/clients.md"}, scenario)
    run("get clients.md", "Acme Corp" in r.get("text", ""))

    r = handle_memory_get({"path": "nonexistent.md"}, scenario)
    run("get (missing)", r.get("text") == "" or "error" in r)

    r = handle_memory_get({"path": "memory/priorities.md", "from": 3, "lines": 2}, scenario)
    run("get (from/lines)", r.get("text", "") != "" and len(r["text"].split("\n")) <= 2)

    # ── Web ───────────────────────────────────────────────────────

    print("\n--- Web handlers ---")

    r = handle_web_search({"query": "test query"}, scenario)
    run("web_search", r.get("provider") == "brave" and len(r.get("results", [])) > 0)

    r = handle_web_search({"query": "test", "count": 1}, scenario)
    run("web_search (count=1)", len(r.get("results", [])) == 1)

    r = handle_web_fetch({"url": "https://example.com"}, scenario)
    run("web_fetch", r.get("status") == 200 and r.get("extractor") == "mock")

    r = handle_web_fetch({"url": "https://example.com", "extractMode": "text"}, scenario)
    run("web_fetch (text mode)", r.get("extractMode") == "text")

    # ── Read ──────────────────────────────────────────────────────

    print("\n--- Read handler ---")

    r = handle_read({"path": "USER.md"}, scenario)
    run("read USER.md", "Alex Chen" in r.get("content", ""))

    r = handle_read({"path": "nonexistent.txt"}, scenario)
    run("read (missing)", "error" in r or r.get("content") == "")

    # ── Summary ───────────────────────────────────────────────────

    total = passed + failed
    print("\n" + "=" * 60)
    if failed == 0:
        print(f"\033[92mALL {total} TESTS PASSED\033[0m")
    else:
        print(f"\033[91m{failed}/{total} TESTS FAILED\033[0m")
    print("=" * 60)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
