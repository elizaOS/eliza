import os

import pytest

from sweagent.agent.problem_statement import GithubIssue
from sweagent.run.hooks.open_pr import OpenPRConfig, OpenPRHook
from sweagent.types import AgentRunResult


def _fake_issue_from_url(url: str):
    # Minimal object shape used by OpenPRHook.should_open_pr
    issue_number = url.rstrip("/").split("/")[-1]

    class Issue:
        def __init__(self, state: str, assignee, locked: bool):
            self.state = state
            self.assignee = assignee
            self.locked = locked

    if issue_number == "16":
        return Issue(state="closed", assignee=None, locked=False)
    if issue_number == "17":
        return Issue(state="open", assignee="someone", locked=False)
    if issue_number == "18":
        return Issue(state="open", assignee=None, locked=True)
    if issue_number == "19":
        return Issue(state="open", assignee=None, locked=False)
    return Issue(state="open", assignee=None, locked=False)


def _fake_associated_commit_urls(_org: str, _repo: str, issue_number: str, *, token: str = ""):
    if issue_number == "19":
        return ["https://github.com/swe-agent/test-repo/commit/abc123"]
    return []


@pytest.fixture
def open_pr_hook_init_for_sop(monkeypatch: pytest.MonkeyPatch):
    # Patch network calls in OpenPRHook
    import sweagent.run.hooks.open_pr as open_pr

    def fake_get_issue(url: str, token: str = ""):
        if "github.com" not in url or "/issues/" not in url:
            msg = f"Invalid GitHub issue URL: {url}"
            raise open_pr.InvalidGithubURL(msg)
        return _fake_issue_from_url(url)

    monkeypatch.setattr(open_pr, "_get_gh_issue_data", fake_get_issue)
    monkeypatch.setattr(open_pr, "_get_associated_commit_urls", _fake_associated_commit_urls)

    hook = OpenPRHook(config=OpenPRConfig(skip_if_commits_reference_issue=True))
    hook._token = os.environ.get("GITHUB_TOKEN", "")
    hook._problem_statement = GithubIssue(github_url="https://github.com/swe-agent/test-repo/issues/1")
    return hook


@pytest.fixture
def agent_run_result():
    return AgentRunResult(
        info={
            "submission": "asdf",
            "exit_status": "submitted",
        },
        trajectory=[],
    )


def test_should_open_pr_fail_submission(open_pr_hook_init_for_sop, agent_run_result):
    hook = open_pr_hook_init_for_sop
    agent_run_result.info["submission"] = None
    assert not hook.should_open_pr(agent_run_result)


def test_should_open_pr_fail_exit(open_pr_hook_init_for_sop, agent_run_result):
    hook = open_pr_hook_init_for_sop
    agent_run_result.info["exit_status"] = "fail"
    assert not hook.should_open_pr(agent_run_result)


def test_should_open_pr_fail_invalid_url(open_pr_hook_init_for_sop, agent_run_result):
    hook = open_pr_hook_init_for_sop
    hook._problem_statement = type("PS", (), {"github_url": "asdf"})()
    assert not hook.should_open_pr(agent_run_result)


def test_should_open_pr_fail_closed(open_pr_hook_init_for_sop, agent_run_result):
    hook = open_pr_hook_init_for_sop
    hook._problem_statement = GithubIssue(github_url="https://github.com/swe-agent/test-repo/issues/16")
    assert not hook.should_open_pr(agent_run_result)


def test_should_open_pr_fail_assigned(open_pr_hook_init_for_sop, agent_run_result):
    hook = open_pr_hook_init_for_sop
    hook._problem_statement = GithubIssue(github_url="https://github.com/swe-agent/test-repo/issues/17")
    assert not hook.should_open_pr(agent_run_result)


def test_should_open_pr_fail_locked(open_pr_hook_init_for_sop, agent_run_result):
    hook = open_pr_hook_init_for_sop
    hook._problem_statement = GithubIssue(github_url="https://github.com/swe-agent/test-repo/issues/18")
    assert not hook.should_open_pr(agent_run_result)


def test_should_open_pr_fail_has_pr(open_pr_hook_init_for_sop, agent_run_result):
    hook = open_pr_hook_init_for_sop
    hook._problem_statement = GithubIssue(github_url="https://github.com/swe-agent/test-repo/issues/19")
    assert not hook.should_open_pr(agent_run_result)


def test_should_open_pr_success_has_pr_override(open_pr_hook_init_for_sop, agent_run_result):
    hook = open_pr_hook_init_for_sop
    hook._problem_statement = GithubIssue(github_url="https://github.com/swe-agent/test-repo/issues/19")
    hook._config.skip_if_commits_reference_issue = False
    assert hook.should_open_pr(agent_run_result)
