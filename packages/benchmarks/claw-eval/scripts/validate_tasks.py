#!/usr/bin/env python3
"""Validate mock-service tasks: YAML parsing, fixture integrity, grader loading, cross-service consistency."""

from __future__ import annotations

import importlib.util
import inspect
import json
import sys
from pathlib import Path

# Add project root so imports work
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from claw_eval.graders.base import AbstractGrader
from claw_eval.models.task import TaskDefinition

# Known service → env var → fixture key mapping
SERVICE_FIXTURE_VARS = {
    "gmail": "GMAIL_FIXTURES",
    "calendar": "CALENDAR_FIXTURES",
    "contacts": "CONTACTS_FIXTURES",
    "finance": "FINANCE_FIXTURES",
    "helpdesk": "HELPDESK_FIXTURES",
    "kb": "KB_FIXTURES",
    "crm": "CRM_FIXTURES",
    "inventory": "INVENTORY_FIXTURES",
    "rss": "RSS_FIXTURES",
    "scheduler": "SCHEDULER_FIXTURES",
    "config": "CONFIG_FIXTURES",
    "notes": "NOTES_FIXTURES",
    "todo": "TODO_FIXTURES",
    "web": "WEB_SEARCH_FIXTURES",
}

# Known service ports
SERVICE_PORTS = {
    "gmail": 9100, "calendar": 9101, "todo": 9102, "contacts": 9103,
    "finance": 9104, "notes": 9105, "kb": 9106, "helpdesk": 9107,
    "inventory": 9108, "rss": 9109, "crm": 9110, "config": 9111,
    "scheduler": 9112, "web": 9113,
}

# Required fields per service fixture
FIXTURE_REQUIRED_FIELDS = {
    "gmail": ["message_id", "from", "subject", "date", "body"],
    "calendar": ["event_id", "title", "start_time", "end_time"],
    "contacts": ["contact_id", "name", "email"],
    "finance": ["transaction_id", "date", "amount"],
    "helpdesk": ["ticket_id", "title", "status"],
    "kb": ["article_id", "title", "content"],
    "crm": ["customer_id", "name", "tier", "status"],
    "inventory": ["product_id", "name"],
    "rss": ["article_id", "title", "content"],
    "scheduler": ["job_id", "name", "cron_expression"],
    "config": ["integration_id", "name", "status"],
    "notes": ["note_id", "title", "content"],
    "todo": ["task_id", "title", "status"],
}


class TaskValidator:
    """Validates a single task directory."""

    def __init__(self, task_dir: Path):
        self.task_dir = task_dir
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.task: TaskDefinition | None = None

    def validate(self) -> bool:
        """Run all validations. Returns True if no errors."""
        self._check_yaml()
        if self.task is None:
            return False
        self._check_services()
        self._check_fixtures()
        self._check_tool_endpoints()
        self._check_scoring_weights()
        self._check_safety_checks()
        self._check_grader()
        self._check_cross_service_consistency()
        return len(self.errors) == 0

    def _check_yaml(self):
        yaml_path = self.task_dir / "task.yaml"
        if not yaml_path.exists():
            self.errors.append("task.yaml not found")
            return
        try:
            self.task = TaskDefinition.from_yaml(yaml_path)
        except Exception as e:
            self.errors.append(f"task.yaml parse error: {e}")

    def _check_services(self):
        task = self.task
        for svc in task.services:
            # Check port matches known service
            if svc.name in SERVICE_PORTS:
                expected_port = SERVICE_PORTS[svc.name]
                if svc.port != expected_port:
                    self.errors.append(
                        f"service '{svc.name}' port {svc.port} != expected {expected_port}"
                    )

            # Check fixture env var exists
            if svc.name in SERVICE_FIXTURE_VARS:
                expected_var = SERVICE_FIXTURE_VARS[svc.name]
                if expected_var not in svc.env:
                    self.warnings.append(
                        f"service '{svc.name}' missing env var {expected_var}"
                    )

            # Check fixture file exists
            for var_name, fixture_path_str in svc.env.items():
                fixture_path = PROJECT_ROOT / fixture_path_str
                if not fixture_path.exists():
                    self.errors.append(
                        f"service '{svc.name}' fixture not found: {fixture_path_str}"
                    )

            # Check reset_endpoint references correct port
            if svc.reset_endpoint and f":{svc.port}/" not in svc.reset_endpoint:
                self.errors.append(
                    f"service '{svc.name}' reset_endpoint port mismatch: {svc.reset_endpoint}"
                )

            # Check health_check references correct port
            if svc.health_check and f":{svc.port}/" not in svc.health_check:
                self.errors.append(
                    f"service '{svc.name}' health_check port mismatch: {svc.health_check}"
                )

    def _check_fixtures(self):
        task = self.task
        for svc in task.services:
            for var_name, fixture_path_str in svc.env.items():
                fixture_path = PROJECT_ROOT / fixture_path_str
                if not fixture_path.exists():
                    continue  # already reported in _check_services

                if fixture_path.is_dir():
                    continue  # Some services use directory fixtures
                try:
                    with open(fixture_path) as f:
                        data = json.load(f)
                except json.JSONDecodeError as e:
                    self.errors.append(f"fixture {fixture_path_str}: invalid JSON — {e}")
                    continue

                if not isinstance(data, list):
                    self.errors.append(f"fixture {fixture_path_str}: expected JSON array, got {type(data).__name__}")
                    continue

                if len(data) == 0:
                    self.warnings.append(f"fixture {fixture_path_str}: empty array")
                    continue

                # Check required fields
                svc_name = svc.name
                if svc_name in FIXTURE_REQUIRED_FIELDS:
                    required = FIXTURE_REQUIRED_FIELDS[svc_name]
                    first_item = data[0]
                    for field in required:
                        if field not in first_item:
                            self.errors.append(
                                f"fixture {fixture_path_str}: missing required field '{field}' "
                                f"(expected for {svc_name})"
                            )

    def _check_tool_endpoints(self):
        task = self.task
        tool_names_in_tools = {t.name for t in task.tools}
        tool_names_in_endpoints = {ep.tool_name for ep in task.tool_endpoints}

        # Every tool should have an endpoint
        for tool_name in tool_names_in_tools:
            if tool_name not in tool_names_in_endpoints:
                self.errors.append(f"tool '{tool_name}' has no matching tool_endpoint")

        # Every endpoint should have a tool definition
        for ep_name in tool_names_in_endpoints:
            if ep_name not in tool_names_in_tools:
                self.errors.append(f"tool_endpoint '{ep_name}' has no matching tool definition")

        # Check endpoint ports match services
        service_ports = {svc.port for svc in task.services}
        for ep in task.tool_endpoints:
            # Extract port from URL
            import re
            m = re.search(r':(\d+)/', ep.url)
            if m:
                port = int(m.group(1))
                if port not in service_ports:
                    self.errors.append(
                        f"tool_endpoint '{ep.tool_name}' port {port} "
                        f"not in service ports {service_ports}"
                    )

    def _check_scoring_weights(self):
        task = self.task
        if not task.scoring_components:
            self.warnings.append("no scoring_components defined")
            return

        total = sum(sc.weight for sc in task.scoring_components)
        if abs(total - 1.0) > 0.01:
            self.errors.append(
                f"scoring_components weights sum to {total:.3f}, expected 1.0"
            )

    def _check_safety_checks(self):
        task = self.task
        tool_names = {t.name for t in task.tools}
        for sc in task.safety_checks:
            if sc.type == "tool_not_called" and sc.tool_name:
                if sc.tool_name not in tool_names:
                    self.warnings.append(
                        f"safety_check references tool '{sc.tool_name}' "
                        f"not in tools list (may be intentional if tool is not exposed)"
                    )

    def _check_grader(self):
        grader_path = self.task_dir / "grader.py"
        if not grader_path.exists():
            self.errors.append("grader.py not found")
            return

        try:
            module_name = f"grader_{self.task.task_id}"
            spec = importlib.util.spec_from_file_location(module_name, grader_path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

            grader_classes = [
                obj for _name, obj in inspect.getmembers(module, inspect.isclass)
                if issubclass(obj, AbstractGrader) and obj is not AbstractGrader
            ]
            if not grader_classes:
                self.errors.append("grader.py: no AbstractGrader subclass found")
            else:
                # Check grade method exists and has correct signature
                grader_cls = grader_classes[0]
                params = inspect.signature(grader_cls.grade).parameters
                required = {"messages", "dispatches", "task"}
                if not required.issubset(params.keys()):
                    self.errors.append(
                        f"grader.py: grade() missing params {required - set(params.keys())}"
                    )
        except Exception as e:
            self.errors.append(f"grader.py: import error — {e}")

    def _check_cross_service_consistency(self):
        """Check that cross-referenced IDs are consistent across fixtures."""
        task = self.task
        # Collect all fixture data keyed by service name
        all_data: dict[str, list[dict]] = {}
        for svc in task.services:
            for var_name, fpath_str in svc.env.items():
                fpath = PROJECT_ROOT / fpath_str
                if fpath.exists():
                    try:
                        with open(fpath) as f:
                            all_data[svc.name] = json.load(f)
                    except Exception:
                        pass

        # Check: helpdesk tickets with customer_id should exist in CRM
        if "helpdesk" in all_data and "crm" in all_data:
            crm_ids = {c.get("customer_id") for c in all_data["crm"]}
            for ticket in all_data["helpdesk"]:
                cid = ticket.get("customer_id")
                if cid and cid not in crm_ids:
                    self.errors.append(
                        f"cross-service: helpdesk ticket '{ticket.get('ticket_id')}' "
                        f"references customer_id '{cid}' not found in CRM"
                    )

        # Check: finance transactions with customer_id should exist in CRM
        if "finance" in all_data and "crm" in all_data:
            crm_ids = {c.get("customer_id") for c in all_data["crm"]}
            for txn in all_data["finance"]:
                cid = txn.get("customer_id")
                if cid and cid not in crm_ids:
                    self.errors.append(
                        f"cross-service: finance txn '{txn.get('transaction_id')}' "
                        f"references customer_id '{cid}' not found in CRM"
                    )

        # Check: gmail "from" addresses should match CRM/contacts emails
        if "gmail" in all_data and "crm" in all_data:
            crm_emails = {c.get("email") for c in all_data["crm"]}
            contacts_emails = set()
            if "contacts" in all_data:
                contacts_emails = {c.get("email") for c in all_data["contacts"]}
            known_emails = crm_emails | contacts_emails
            for msg in all_data["gmail"]:
                sender = msg.get("from", "")
                # Only warn if sender looks like it should be a known entity
                # (skip newsletters, external senders, etc.)
                if sender and "@company.com" not in sender:
                    # External sender — check if they match a CRM customer
                    pass  # Skip external email validation (could be any sender)


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Validate mock-service tasks")
    parser.add_argument("task_dirs", nargs="*", help="Task directories to validate")
    parser.add_argument("--all", action="store_true", help="Validate all tasks with services")
    parser.add_argument("--pattern", type=str, help="Glob pattern for task dirs (e.g., 'T14*')")
    args = parser.parse_args()

    tasks_root = PROJECT_ROOT / "tasks"

    if args.all:
        task_dirs = sorted(tasks_root.iterdir())
    elif args.pattern:
        task_dirs = sorted(tasks_root.glob(args.pattern))
    elif args.task_dirs:
        task_dirs = [Path(d) for d in args.task_dirs]
    else:
        # Default: validate tasks that have services
        task_dirs = sorted(tasks_root.iterdir())

    total = 0
    passed = 0
    failed = 0
    task_results = []

    for task_dir in task_dirs:
        yaml_path = task_dir / "task.yaml"
        if not yaml_path.exists():
            continue
        # Only validate tasks with services
        try:
            td = TaskDefinition.from_yaml(yaml_path)
        except Exception:
            continue
        if not td.services:
            continue

        total += 1
        validator = TaskValidator(task_dir)
        ok = validator.validate()

        status = "PASS" if ok else "FAIL"
        if ok:
            passed += 1
        else:
            failed += 1

        task_results.append((td.task_id, status, validator.errors, validator.warnings))

    # Print results
    print(f"\n{'='*70}")
    print(f"Task Validation Report")
    print(f"{'='*70}\n")

    for task_id, status, errors, warnings in task_results:
        icon = "OK" if status == "PASS" else "FAIL"
        if status == "FAIL" or warnings:
            print(f"[{icon}] {task_id}")
            for e in errors:
                print(f"      ERROR: {e}")
            for w in warnings:
                print(f"      WARN:  {w}")
        else:
            print(f"[{icon}] {task_id}")

    print(f"\n{'='*70}")
    print(f"Total: {total} | Passed: {passed} | Failed: {failed}")
    print(f"{'='*70}")

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
