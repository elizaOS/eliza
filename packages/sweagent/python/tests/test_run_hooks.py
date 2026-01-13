import os

import pytest

from sweagent.agent.problem_statement import GithubIssue
from sweagent.run.hooks.open_pr import OpenPRConfig, OpenPRHook
from sweagent.types import AgentRunResult


@pytest.fixture
def open_pr_hook_init_for_sop():
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
    agent_run_result.info["data_path"] = "asdf"
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
