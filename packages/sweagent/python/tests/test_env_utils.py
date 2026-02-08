from __future__ import annotations

import subprocess

import pytest

from sweagent.run.hooks.open_pr import _remove_triple_backticks, format_trajectory_markdown
from sweagent.utils.github import (
    InvalidGithubURL,
    _get_associated_commit_urls,
    _is_github_issue_url,
    _is_github_repo_url,
    _parse_gh_issue_url,
    _parse_gh_repo_url,
)


def test_format_trajectory_markdown(test_trajectory):
    formatted = format_trajectory_markdown(test_trajectory["trajectory"])
    assert formatted.startswith("<details>")
    assert formatted.endswith("</details>")


def test_remove_triple_backticks():
    assert _remove_triple_backticks("```") == ""


def test_is_github_repo_url():
    assert _is_github_repo_url("https://github.com/SWE-agent/SWE-agent")
    assert _is_github_repo_url("https://github.com/SWE-agent/SWE-agent/anything")
    assert _is_github_repo_url("github.com/SWE-agent/SWE-agent/anything")
    assert not _is_github_repo_url("")
    assert not _is_github_repo_url("/path/to/file")


def test_parse_gh_repo_url():
    assert _parse_gh_repo_url("https://github.com/SWE-agent/SWE-agent") == ("SWE-agent", "SWE-agent")
    assert _parse_gh_repo_url("github.com/SWE-agent/SWE-agent") == ("SWE-agent", "SWE-agent")
    assert _parse_gh_repo_url("github.com/SWE-agent/SWE-agent/asdfjsdfg") == ("SWE-agent", "SWE-agent")
    assert _parse_gh_repo_url("git@github.com/SWE-agent/SWE-agent/asdfjsdfg") == ("SWE-agent", "SWE-agent")


def test_parse_gh_repo_url_fails():
    with pytest.raises(InvalidGithubURL):
        _parse_gh_repo_url("adfkj;lasdfl;kj")
    with pytest.raises(InvalidGithubURL):
        _parse_gh_repo_url("github.com/")
    with pytest.raises(InvalidGithubURL):
        _parse_gh_repo_url("github.com//a/")


def test_parse_gh_issue_url():
    url = "https://github.com/SWE-agent/SWE-agent/issues/43"
    owner, repo, no = _parse_gh_issue_url(url)
    assert owner == "SWE-agent"
    assert repo == "SWE-agent"
    assert no == "43"


def test_parse_gh_issue_url_fails():
    with pytest.raises(InvalidGithubURL):
        _parse_gh_issue_url("https://github.com/a/b")
    with pytest.raises(InvalidGithubURL):
        _parse_gh_issue_url("https://github.com/a/b////")


def test_is_from_github_url():
    assert not _is_github_issue_url("")
    assert _is_github_issue_url("https://github.com/SWE-agent/SWE-agent/issues/43")


def test_get_associated_commit_urls(monkeypatch: pytest.MonkeyPatch):
    class FakeEvent:
        def __init__(self, event: str, commit_id: str | None):
            self.event = event
            self.commit_id = commit_id

    class FakeCommit:
        def __init__(self, message: str, html_url: str):
            self.commit = type("CommitObj", (), {"message": message})()
            self.html_url = html_url

    class FakeIssues:
        def list_events(self, _org: str, _repo: str, _issue_number: str):
            return [
                FakeEvent("referenced", "abc123"),
                FakeEvent("commented", "zzz999"),
                FakeEvent("referenced", None),
            ]

    class FakeRepos:
        def get_commit(self, _org: str, _repo: str, commit_id: str):
            if commit_id == "abc123":
                return FakeCommit(
                    message="Fixes #41: handle edge case",
                    html_url="https://github.com/SWE-agent/SWE-agent/commit/abc123",
                )
            return FakeCommit(
                message="Unrelated commit",
                html_url="https://github.com/SWE-agent/SWE-agent/commit/zzz999",
            )

    class FakeGhApi:
        def __init__(self, token: str = ""):
            self.token = token
            self.issues = FakeIssues()
            self.repos = FakeRepos()

    # Patch GhApi used inside sweagent.utils.github
    import sweagent.utils.github as gh

    monkeypatch.setattr(gh, "GhApi", FakeGhApi)
    assoc = _get_associated_commit_urls(
        org="SWE-agent",
        repo="SWE-agent",
        issue_number="41",
        token="",
    )

    assert assoc == ["https://github.com/SWE-agent/SWE-agent/commit/abc123"]


def clone_repo(tmp_path, repo_url):
    cmd = [
        "git",
        "clone",
        repo_url,
    ]
    subprocess.run(cmd, check=True, cwd=tmp_path)
