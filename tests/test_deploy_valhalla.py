import json
import os
from pathlib import Path
import secrets
import socketserver
import subprocess
import threading
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "deploy-valhalla.sh"
MOCK_DIR = ROOT / "tests" / "deploy_valhalla_mock"


class MockHandler(socketserver.StreamRequestHandler):
    def handle(self):
        request = json.loads(self.rfile.readline())
        server = self.server
        if request["token"] != server.token:
            return
        args = request["args"]
        state = server.state
        state["calls"].append(args)
        scenario = server.scenario
        status = 0
        stdout = ""
        stderr = ""
        if args[:1] == ["api"] and "--method" not in args:
            if scenario == "missing_branch":
                status = 1
            elif scenario == "bad_sha":
                stdout = '{"commit":{"sha":"bad"}}'
            else:
                stdout = json.dumps({"commit": {"sha": "a" * 40}})
        elif args[:1] == ["api"] and "--method" in args:
            state["payload"] = request["payload"]
            if scenario == "dispatch_failure":
                status = 1
        elif args[:2] == ["run", "list"]:
            state["lists"] += 1
            payload = state["payload"]
            run = {
                "databaseId": 123,
                "displayTitle": "valhalla-" + payload["inputs"]["request_id"],
                "event": "workflow_dispatch",
                "headBranch": payload["ref"],
                "headSha": payload["inputs"]["sha"],
            }
            if scenario == "list_failure":
                status = 1
            elif scenario == "malformed_list":
                stdout = "{}"
            elif scenario == "wrong_event":
                stdout = json.dumps([dict(run, event="push")])
            elif scenario == "wrong_branch":
                stdout = json.dumps([dict(run, headBranch="another-branch")])
            elif scenario == "wrong_sha":
                stdout = json.dumps([dict(run, headSha="b" * 40)])
            elif scenario == "never_found" or state["lists"] == 1:
                stdout = json.dumps([dict(run, displayTitle="unrelated")])
            elif scenario == "duplicates":
                stdout = json.dumps([run, run])
            else:
                stdout = json.dumps([dict(run, displayTitle="unrelated"), run])
        elif args[:2] == ["run", "watch"]:
            if scenario == "watch_failure":
                status = 1
        else:
            stderr = "Unexpected gh invocation: " + repr(args)
            status = 2
        self.wfile.write(json.dumps({"stdout": stdout, "stderr": stderr, "status": status}).encode() + b"\n")


class DeployLauncherTests(unittest.TestCase):
    def setUp(self):
        self.server = socketserver.TCPServer(("127.0.0.1", 0), MockHandler)
        self.server.token = secrets.token_hex(16)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01})
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def launch(self, scenario="", ref="feature/quote\"branch", environment=None, **env_overrides):
        self.server.state = {"calls": [], "lists": 0}
        self.server.scenario = scenario
        env = os.environ.copy()
        env.update({
            "PATH": f"{MOCK_DIR}:{env['PATH']}",
            "MOCK_GH_PORT": str(self.server.server_address[1]),
            "MOCK_GH_TOKEN": self.server.token,
            "MOCK_GH_SCENARIO": scenario,
            "VALHALLA_DISCOVERY_ATTEMPTS": "3",
            "VALHALLA_DISCOVERY_INTERVAL": "0",
            **env_overrides,
        })
        args = ["bash", str(SCRIPT), "--repo", "owner/repo", "--ref", ref]
        if environment is not None:
            args.extend(["--environment", environment])
        result = subprocess.run(
            args,
            env=env, capture_output=True, text=True, timeout=15, check=False,
        )
        return result, self.server.state

    def test_success_escapes_payload_and_matches_exact_run(self):
        result, state = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(state["payload"]["ref"], 'feature/quote"branch')
        self.assertEqual(state["payload"]["inputs"]["sha"], "a" * 40)
        self.assertEqual(state["payload"]["inputs"]["environment"], "github-pages")
        self.assertEqual(set(state["payload"]["inputs"]), {"sha", "request_id", "environment"})
        self.assertIn("feature%2Fquote%22branch", state["calls"][0][1])
        self.assertEqual(state["lists"], 2)
        self.assertEqual(state["calls"][-1], [
            "run", "watch", "123", "--repo", "owner/repo", "--exit-status"
        ])

    def test_environment_is_json_escaped(self):
        result, state = self.launch(environment='review "quoted"\nname')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(state["payload"]["inputs"]["environment"], 'review "quoted"\nname')

    def test_request_ids_are_unique(self):
        _, first = self.launch()
        _, second = self.launch()
        self.assertNotEqual(first["payload"]["inputs"]["request_id"],
                            second["payload"]["inputs"]["request_id"])

    def test_missing_branch_and_invalid_sha_never_dispatch(self):
        for scenario in ("missing_branch", "bad_sha"):
            with self.subTest(scenario=scenario):
                result, state = self.launch(scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(len(state["calls"]), 1)

    def test_failures_are_reported(self):
        for scenario in ("dispatch_failure", "list_failure", "malformed_list",
                         "never_found", "wrong_event", "wrong_branch", "wrong_sha",
                         "duplicates", "watch_failure"):
            with self.subTest(scenario=scenario):
                result, state = self.launch(scenario)
                self.assertNotEqual(result.returncode, 0, scenario)
                if scenario == "never_found":
                    self.assertEqual(state["lists"], 3)
                if scenario != "watch_failure":
                    self.assertFalse(any(call[:2] == ["run", "watch"] for call in state["calls"]))

    def test_invalid_poll_configuration_never_calls_gh(self):
        result, state = self.launch(VALHALLA_DISCOVERY_ATTEMPTS="999")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state["calls"], [])

    def test_hung_network_commands_are_bounded(self):
        for scenario in ("branch_hang", "dispatch_hang", "list_hang"):
            with self.subTest(scenario=scenario):
                result, state = self.launch(scenario, VALHALLA_GH_TIMEOUT="1")
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(call[:2] == ["run", "watch"] for call in state["calls"]))

    def test_invalid_environment_and_timeout_never_call_gh(self):
        for options in ({"environment": ""}, {"VALHALLA_GH_TIMEOUT": "0"},
                        {"VALHALLA_GH_TIMEOUT": "301"}):
            with self.subTest(options=options):
                result, state = self.launch(**options)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(state["calls"], [])


if __name__ == "__main__":
    unittest.main()
