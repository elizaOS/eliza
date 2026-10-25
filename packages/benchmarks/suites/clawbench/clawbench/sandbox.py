"""Sandbox transport and fixture setup shared by ClawBench launchers."""

from pathlib import Path
import shutil
from urllib.parse import quote

import httpx


class SandboxError(RuntimeError):
    """An episode lacks valid transport, setup, or tool evidence."""

    def __init__(self, message: str, *, evidence: list | None = None) -> None:
        super().__init__(message)
        self.evidence = list(evidence or [])


class SandboxClient:
    def __init__(self, *, agent_url: str, token: str, tools_url: str, model: str) -> None:
        self.agent_url = agent_url.rstrip("/")
        self.token = token
        self.tools_url = tools_url.rstrip("/")
        self.model = model
        self.evidence: list[dict] = []

    def _request(self, method: str, url: str, **kwargs: object) -> dict:
        try:
            response = httpx.request(method, url, **kwargs)
            self.evidence.append({"method": method, "url": url, "status": response.status_code, "body": response.text})
            response.raise_for_status()
            value = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise SandboxError(f"Sandbox {method} failed: {url}", evidence=self.evidence) from exc
        if not isinstance(value, dict):
            raise SandboxError(f"Sandbox {method} returned a non-object: {url}", evidence=self.evidence)
        return value

    def send_message(self, message: str) -> dict:
        value = self._request("POST", f"{self.agent_url}/v1/chat/completions",
            headers={"Authorization": f"Bearer {self.token}"},
            json={"model": self.model, "messages": [{"role": "user", "content": message}], "stream": False},
            timeout=180)
        choices = value.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict) or not isinstance(choices[0].get("message"), dict):
            raise SandboxError("Sandbox completion omitted its assistant response", evidence=self.evidence)
        return value

    def get_tool_calls(self) -> list:
        calls = self._request("GET", f"{self.tools_url}/tool_calls", timeout=5).get("calls")
        if not isinstance(calls, list) or any(not isinstance(call, dict) for call in calls):
            raise SandboxError("Sandbox tool evidence must contain a calls array", evidence=self.evidence)
        return calls

    def get_all_requests(self) -> dict:
        value = self._request("GET", f"{self.tools_url}/all_requests", timeout=5)
        requests = value.get("requests")
        summary = value.get("summary")
        if not isinstance(requests, list) or any(not isinstance(request, dict) for request in requests) or not isinstance(summary, dict):
            raise SandboxError("Sandbox request evidence is incomplete", evidence=self.evidence)
        return value

    def reset_scenario(self, scenario: str) -> None:
        self.evidence = []
        self._request("POST", f"{self.tools_url}/set_scenario/{quote(scenario, safe='')}", timeout=5)


def setup_workspace(scenario: dict, variant: str, fixtures: Path, workspace: Path) -> None:
    variants = scenario.get("variants", {})
    if variant not in variants:
        raise SandboxError(f"Unknown workspace variant: {variant}")
    fixture = fixtures / scenario["name"]
    copies = {"AGENTS.md": variants[variant], **scenario.get("workspace", {})}
    # Validate the complete input before replacing any workspace file.
    for destination, source in copies.items():
        if not (fixture / source).is_file():
            raise SandboxError(f"Missing workspace fixture: {fixture / source}")
        if not (workspace / destination).resolve().is_relative_to(workspace.resolve()):
            raise SandboxError(f"Workspace destination escapes its root: {destination}")
    workspace.mkdir(parents=True, exist_ok=True)
    for destination, source in copies.items():
        target = workspace / destination
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(fixture / source, target)
