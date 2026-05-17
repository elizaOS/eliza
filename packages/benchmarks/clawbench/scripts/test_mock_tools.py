#!/usr/bin/env python3
"""
Test mock tools server (corrected schema v0.3.0).

Requires the server to be running:
    FIXTURES_PATH=./fixtures SCENARIO=client_escalation python -m clawbench.mock_tools.server

Usage:
    python scripts/test_mock_tools.py
    python scripts/test_mock_tools.py --base-url http://mock-tools:3001
"""

import argparse
import json
import sys

import httpx

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"


def check(name: str, ok: bool, detail: str = ""):
    status = PASS if ok else FAIL
    suffix = f" — {detail}" if detail else ""
    print(f"  [{status}] {name}{suffix}")
    return ok


def test_health(base: str) -> bool:
    print("\n--- Health ---")
    r = httpx.get(f"{base}/health")
    data = r.json()
    ok = r.status_code == 200 and data["status"] == "ok"
    return check("GET /health", ok, f"scenario={data.get('scenario')}, tools={data.get('tools_available')}")


def test_tools_list(base: str) -> bool:
    print("\n--- Tool listing ---")
    r = httpx.get(f"{base}/tools")
    data = r.json()
    tools = data["tools"]
    expected = {"exec", "memory_get", "memory_search", "read", "slack", "web_fetch", "web_search"}
    ok = set(tools) == expected
    return check("GET /tools", ok, f"got {sorted(tools)}")


def test_set_scenario(base: str) -> bool:
    print("\n--- Set scenario ---")
    r = httpx.post(f"{base}/set_scenario/client_escalation")
    ok = r.status_code == 200 and r.json()["scenario"] == "client_escalation"
    return check("POST /set_scenario/client_escalation", ok)


def test_slack_read(base: str) -> bool:
    print("\n--- Slack: readMessages ---")
    r = httpx.post(f"{base}/tools/slack", json={"action": "readMessages", "channelId": "C_ENG", "limit": 3})
    data = r.json()
    ok = data.get("ok") is True and len(data.get("messages", [])) == 3
    return check("slack readMessages", ok, f"{len(data.get('messages', []))} messages")


def test_slack_send(base: str) -> bool:
    print("\n--- Slack: sendMessage ---")
    r = httpx.post(f"{base}/tools/slack", json={"action": "sendMessage", "to": "C_ENG", "content": "test"})
    data = r.json()
    ok = data.get("ok") is True and "messageId" in data
    return check("slack sendMessage", ok, f"messageId={data.get('messageId')}")


def test_slack_react(base: str) -> bool:
    r = httpx.post(f"{base}/tools/slack", json={"action": "react", "channelId": "C_ENG", "messageId": "sm_101", "emoji": "thumbsup"})
    ok = r.json().get("ok") is True
    return check("slack react", ok)


def test_slack_member_info(base: str) -> bool:
    r = httpx.post(f"{base}/tools/slack", json={"action": "memberInfo", "userId": "U_MARCUS"})
    data = r.json()
    ok = data.get("ok") is True and data.get("user", {}).get("name") == "Marcus Johnson"
    return check("slack memberInfo", ok, f"name={data.get('user', {}).get('name')}")


def test_exec_himalaya_list(base: str) -> bool:
    print("\n--- Exec: himalaya ---")
    r = httpx.post(f"{base}/tools/exec", json={"command": "himalaya envelope list"})
    data = r.json()
    items = json.loads(data["aggregated"])
    ok = data["status"] == "completed" and data["exitCode"] == 0 and len(items) == 7
    return check("himalaya envelope list", ok, f"{len(items)} emails")


def test_exec_himalaya_read(base: str) -> bool:
    r = httpx.post(f"{base}/tools/exec", json={"command": "himalaya message read msg_101"})
    data = r.json()
    ok = data["status"] == "completed" and "ESCALATION" in data["aggregated"]
    return check("himalaya message read", ok, f"{len(data['aggregated'])} chars")


def test_exec_himalaya_read_missing(base: str) -> bool:
    r = httpx.post(f"{base}/tools/exec", json={"command": "himalaya message read msg_999"})
    data = r.json()
    ok = data["status"] == "failed" and data["exitCode"] == 1
    return check("himalaya message read (missing)", ok)


def test_exec_himalaya_draft(base: str) -> bool:
    r = httpx.post(f"{base}/tools/exec", json={"command": "himalaya template write --to boss@company.com"})
    data = r.json()
    ok = data["status"] == "completed" and "Draft saved" in data["aggregated"]
    return check("himalaya template write", ok)


def test_exec_himalaya_send(base: str) -> bool:
    r = httpx.post(f"{base}/tools/exec", json={"command": "himalaya message send"})
    data = r.json()
    ok = data["status"] == "completed" and data.get("_irreversible") is True
    return check("himalaya message send (irreversible)", ok)


def test_exec_notion_tasks(base: str) -> bool:
    print("\n--- Exec: curl Notion ---")
    r = httpx.post(f"{base}/tools/exec", json={"command": 'curl -X POST https://api.notion.so/v1/databases/abc123/query -H "Authorization: Bearer secret"'})
    data = r.json()
    results = json.loads(data["aggregated"])["results"]
    ok = data["status"] == "completed" and len(results) == 7
    return check("curl notion query", ok, f"{len(results)} tasks")


def test_exec_notion_page(base: str) -> bool:
    r = httpx.post(f"{base}/tools/exec", json={"command": "curl https://api.notion.so/v1/pages/TC-950 -H 'Authorization: Bearer secret'"})
    data = r.json()
    item = json.loads(data["aggregated"])
    ok = data["status"] == "completed" and item.get("title") == "Data export timeout for large datasets"
    return check("curl notion page", ok, f"title={item.get('title', '')[:40]}")


def test_exec_notion_create(base: str) -> bool:
    r = httpx.post(f"{base}/tools/exec", json={"command": 'curl -X POST https://api.notion.so/v1/pages -H "Authorization: Bearer secret" -d \'{"title":"test"}\''})
    data = r.json()
    ok = data["status"] == "completed" and "created" in data["aggregated"]
    return check("curl notion create", ok)


def test_exec_gcal_list(base: str) -> bool:
    print("\n--- Exec: curl Google Calendar ---")
    r = httpx.post(f"{base}/tools/exec", json={"command": "curl https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=2026-02-07"})
    data = r.json()
    items = json.loads(data["aggregated"])["items"]
    ok = data["status"] == "completed" and len(items) == 6
    return check("curl gcal list events", ok, f"{len(items)} events")


def test_exec_gcal_create(base: str) -> bool:
    r = httpx.post(f"{base}/tools/exec", json={"command": 'curl -X POST https://www.googleapis.com/calendar/v3/calendars/primary/events -d \'{"summary":"test"}\''})
    data = r.json()
    ok = data["status"] == "completed" and data.get("_irreversible") is True
    return check("curl gcal create (irreversible)", ok)


def test_exec_gcalcli_agenda(base: str) -> bool:
    print("\n--- Exec: gcalcli / gcal ---")
    r = httpx.post(f"{base}/tools/exec", json={"command": "gcalcli agenda 2026-02-07 2026-02-08"})
    data = r.json()
    items = json.loads(data["aggregated"])["items"]
    ok = data["status"] == "completed" and len(items) > 0
    return check("gcalcli agenda", ok, f"{len(items)} events")


def test_exec_gcalcli_list(base: str) -> bool:
    r = httpx.post(f"{base}/tools/exec", json={"command": "gcalcli list"})
    data = r.json()
    items = json.loads(data["aggregated"])["items"]
    ok = data["status"] == "completed" and len(items) > 0
    return check("gcalcli list", ok, f"{len(items)} events")


def test_exec_gcal_list_events(base: str) -> bool:
    r = httpx.post(f"{base}/tools/exec", json={"command": "gcal list-events --date 2026-02-07"})
    data = r.json()
    items = json.loads(data["aggregated"])["items"]
    ok = data["status"] == "completed" and len(items) > 0
    return check("gcal list-events", ok, f"{len(items)} events")


def test_exec_gcalcli_add(base: str) -> bool:
    r = httpx.post(f"{base}/tools/exec", json={"command": "gcalcli add --title 'Test' --when '3pm'"})
    data = r.json()
    ok = data["status"] == "completed" and data.get("_irreversible") is True
    return check("gcalcli add (irreversible)", ok)


def test_exec_gcalcli_delete(base: str) -> bool:
    r = httpx.post(f"{base}/tools/exec", json={"command": "gcalcli delete 'Test Meeting'"})
    data = r.json()
    ok = data["status"] == "completed" and data.get("_irreversible") is True
    return check("gcalcli delete (irreversible)", ok)


def test_exec_himalaya_list_no_envelope(base: str) -> bool:
    print("\n--- Exec: himalaya list ---")
    r = httpx.post(f"{base}/tools/exec", json={"command": "himalaya list --folder INBOX"})
    data = r.json()
    items = json.loads(data["aggregated"])
    ok = data["status"] == "completed" and len(items) > 0
    return check("himalaya list (no envelope)", ok, f"{len(items)} emails")


def test_exec_gh(base: str) -> bool:
    print("\n--- Exec: gh ---")
    r = httpx.post(f"{base}/tools/exec", json={"command": "gh pr view 356"})
    ok = r.json()["status"] == "completed"
    return check("gh pr view", ok)


def test_exec_unknown(base: str) -> bool:
    r = httpx.post(f"{base}/tools/exec", json={"command": "echo hello"})
    ok = r.json()["status"] == "completed"
    return check("unknown command (fallback)", ok)


def test_memory_search(base: str) -> bool:
    print("\n--- Memory ---")
    r = httpx.post(f"{base}/tools/memory_search", json={"query": "Acme client priorities"})
    data = r.json()
    ok = len(data["results"]) > 0 and data["provider"] == "mock"
    return check("memory_search", ok, f"{len(data['results'])} results")


def test_memory_get(base: str) -> bool:
    r = httpx.post(f"{base}/tools/memory_get", json={"path": "memory/priorities.md"})
    data = r.json()
    ok = "Current Priorities" in data.get("text", "")
    return check("memory_get", ok, f"{len(data.get('text', ''))} chars")


def test_memory_get_missing(base: str) -> bool:
    r = httpx.post(f"{base}/tools/memory_get", json={"path": "nonexistent.md"})
    data = r.json()
    ok = "error" in data or data.get("text") == ""
    return check("memory_get (missing file)", ok)


def test_web_search(base: str) -> bool:
    print("\n--- Web ---")
    r = httpx.post(f"{base}/tools/web_search", json={"query": "data export best practices"})
    data = r.json()
    ok = data.get("provider") == "brave" and len(data.get("results", [])) > 0
    return check("web_search", ok, f"{len(data.get('results', []))} results")


def test_web_fetch(base: str) -> bool:
    r = httpx.post(f"{base}/tools/web_fetch", json={"url": "https://example.com/article"})
    data = r.json()
    ok = data.get("status") == 200 and data.get("extractor") == "mock"
    return check("web_fetch", ok)


def test_read(base: str) -> bool:
    print("\n--- Read ---")
    r = httpx.post(f"{base}/tools/read", json={"path": "USER.md"})
    data = r.json()
    ok = "Alex Chen" in data.get("content", "")
    return check("read USER.md", ok)


def test_read_missing(base: str) -> bool:
    r = httpx.post(f"{base}/tools/read", json={"path": "nonexistent.txt"})
    data = r.json()
    ok = "error" in data or data.get("content") == ""
    return check("read (missing file)", ok)


def test_tool_calls_log(base: str) -> bool:
    print("\n--- Logs ---")
    r = httpx.get(f"{base}/tool_calls")
    calls = r.json()["calls"]
    ok = len(calls) > 0
    return check("tool_calls log", ok, f"{len(calls)} calls recorded")


def test_all_requests_log(base: str) -> bool:
    r = httpx.get(f"{base}/all_requests")
    data = r.json()
    ok = data["summary"]["total"] > 0
    return check("all_requests log", ok, f"total={data['summary']['total']}, success={data['summary']['success']}")


def test_unknown_tool(base: str) -> bool:
    print("\n--- Error handling ---")
    r = httpx.post(f"{base}/tools/nonexistent_tool", json={})
    ok = r.status_code == 404
    return check("unknown tool -> 404", ok)


def main():
    parser = argparse.ArgumentParser(description="Test mock tools server (corrected schema v0.3.0)")
    parser.add_argument("--base-url", default="http://localhost:3001", help="Mock server base URL")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    print("=" * 60)
    print(f"Mock Tools Server Test (v0.3.0 corrected schema)")
    print(f"Server: {base}")
    print("=" * 60)

    # Check server is up
    try:
        r = httpx.get(f"{base}/health", timeout=3)
    except httpx.ConnectError:
        print(f"\n[ERROR] Cannot connect to {base}")
        print("Start the server first:")
        print("  FIXTURES_PATH=./fixtures SCENARIO=client_escalation python -m clawbench.mock_tools.server")
        sys.exit(1)

    tests = [
        test_health,
        test_tools_list,
        test_set_scenario,
        # Slack
        test_slack_read,
        test_slack_send,
        test_slack_react,
        test_slack_member_info,
        # Exec: himalaya
        test_exec_himalaya_list,
        test_exec_himalaya_read,
        test_exec_himalaya_read_missing,
        test_exec_himalaya_draft,
        test_exec_himalaya_send,
        # Exec: Notion
        test_exec_notion_tasks,
        test_exec_notion_page,
        test_exec_notion_create,
        # Exec: gcal (curl)
        test_exec_gcal_list,
        test_exec_gcal_create,
        # Exec: gcalcli / gcal CLI
        test_exec_gcalcli_agenda,
        test_exec_gcalcli_list,
        test_exec_gcal_list_events,
        test_exec_gcalcli_add,
        test_exec_gcalcli_delete,
        # Exec: himalaya list (no envelope)
        test_exec_himalaya_list_no_envelope,
        # Exec: gh + fallback
        test_exec_gh,
        test_exec_unknown,
        # Memory
        test_memory_search,
        test_memory_get,
        test_memory_get_missing,
        # Web
        test_web_search,
        test_web_fetch,
        # Read
        test_read,
        test_read_missing,
        # Logs
        test_tool_calls_log,
        test_all_requests_log,
        # Errors
        test_unknown_tool,
    ]

    passed = 0
    failed = 0
    for t in tests:
        try:
            if t(base):
                passed += 1
            else:
                failed += 1
        except Exception as e:
            check(t.__name__, False, f"EXCEPTION: {e}")
            failed += 1

    print("\n" + "=" * 60)
    total = passed + failed
    if failed == 0:
        print(f"\033[92mALL {total} TESTS PASSED\033[0m")
    else:
        print(f"\033[91m{failed}/{total} TESTS FAILED\033[0m")
    print("=" * 60)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
