"""Optional Pier adapter boundary checks; live grading is a separate lane."""
import asyncio
import json
from types import SimpleNamespace
import hashlib
import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


@unittest.skipUnless(importlib.util.find_spec('pier'), 'Install datacurve-pier==0.3.1 for this optional adapter')
class PierAdapterBoundaryTests(unittest.TestCase):
    def setUp(self):
        from eliza_adapter.pier_agent import ElizaAgent
        self.agent_class = ElizaAgent
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        bundle = root / 'runtime.tar.gz'
        bundle.write_bytes(b'fixture; never executed')
        self.arguments = dict(runtime_bundle=str(bundle),
                              runtime_sha256=hashlib.sha256(bundle.read_bytes()).hexdigest(),
                              runtime_revision='test-revision', logs_dir=root,
                              model_name='cerebras/test-model', extra_env={'CEREBRAS_API_KEY': 'fixture'})

    def test_task_local_git_identity_allows_real_agent_commit_without_global_config(self):
        root = Path(self.directory.name)
        checkout = root / "task"
        checkout.mkdir()
        home = root / "home"
        home.mkdir()
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / "config"), GIT_CONFIG_NOSYSTEM="1",
                   GIT_CONFIG_GLOBAL=str(home / "empty-gitconfig"))
        subprocess.run(["git", "init", str(checkout)], env=env, capture_output=True, check=True)
        before = subprocess.run(["git", "rev-parse", "--verify", "HEAD"], cwd=checkout,
                                env=env, capture_output=True)
        self.assertNotEqual(before.returncode, 0)
        subprocess.run(["git", "config", "--local", "user.useConfigOnly", "true"],
                       cwd=checkout, env=env, check=True)
        missing = subprocess.run(["git", "var", "GIT_AUTHOR_IDENT"], cwd=checkout,
                                 env=env, capture_output=True)
        self.assertNotEqual(missing.returncode, 0)

        async def execute(command, **kwargs):
            self.assertEqual(kwargs["cwd"], "/app")
            result = subprocess.run(command, shell=True, cwd=checkout, env=env,
                                    capture_output=True, text=True, timeout=kwargs["timeout_sec"])
            return SimpleNamespace(return_code=result.returncode, stdout=result.stdout, stderr=result.stderr)

        agent = self.agent_class(**self.arguments)
        asyncio.run(agent._prepare_git_identity(SimpleNamespace(exec=execute)))
        self.assertFalse((home / "empty-gitconfig").exists())
        self.assertNotEqual(subprocess.run(["git", "rev-parse", "--verify", "HEAD"], cwd=checkout,
                                          env=env, capture_output=True).returncode, 0)
        (checkout / "agent-created.txt").write_text("agent implementation\n")
        subprocess.run(["git", "add", "agent-created.txt"], cwd=checkout, env=env, check=True)
        subprocess.run(["git", "commit", "-m", "Agent completes task"], cwd=checkout,
                       env=env, check=True, capture_output=True)
        author = subprocess.check_output(["git", "show", "-s", "--format=%an <%ae>"],
                                         cwd=checkout, env=env, text=True).strip()
        self.assertEqual(author, "Eliza Benchmark <benchmark@eliza.invalid>")

    def test_git_identity_setup_failure_is_not_hidden(self):
        async def execute(*args, **kwargs):
            return SimpleNamespace(return_code=128)
        with self.assertRaisesRegex(RuntimeError, "task-local Git"):
            asyncio.run(self.agent_class(**self.arguments)._prepare_git_identity(SimpleNamespace(exec=execute)))

    def test_changed_bundle_rejected(self):
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            self.agent_class(**(self.arguments | {'runtime_sha256': '0' * 64}))

    def test_missing_credentials_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Missing CEREBRAS_API_KEY'):
            self.agent_class(**(self.arguments | {'extra_env': {}}))

    def test_provider_url_requires_https_without_credentials(self):
        for url in ('http://example.com', 'https://user:password@example.com', 'not-a-url'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.agent_class(**(self.arguments | {'provider_url': url}))

    def test_explicit_model_and_supported_provider_required(self):
        for override in ({'model_name': None}, {'provider': 'unknown'}):
            with self.subTest(override=override), self.assertRaises(ValueError):
                self.agent_class(**(self.arguments | override))

    def test_identity_and_provider_allowlist(self):
        agent = self.agent_class(**self.arguments)
        self.assertEqual(agent.version(), 'test-revision')
        self.assertEqual(agent.network_allowlist().domains, ['api.cerebras.ai'])
        self.assertFalse(agent.SUPPORTS_ATIF)

    def test_runtime_config_projects_public_provider_settings_without_credentials(self):
        uploads = {}
        environment = SimpleNamespace(session_id="task", agent_process_env=lambda env: env)

        async def upload(source, destination):
            uploads[destination] = Path(source).read_text()

        async def execute(*args, **kwargs):
            return SimpleNamespace(return_code=1)

        async def download_file(source, destination):
            Path(destination).write_text("")

        async def download_dir(source, destination):
            Path(destination).mkdir(parents=True, exist_ok=True)

        environment.upload_file = upload
        environment.exec = execute
        environment.download_file = download_file
        environment.download_dir = download_dir
        agent = self.agent_class(**(self.arguments | {
            "extra_env": {"CEREBRAS_API_KEY": "fixture", "OPENAI_REASONING_EFFORT": "none",
                          "UNRELATED_SECRET": "do-not-project"},
        }))
        agent.state_dir = "/private-state"
        with self.assertRaisesRegex(RuntimeError, "Native Eliza CLI exited 1"):
            asyncio.run(agent.run("Solve the task", environment, SimpleNamespace(metadata={})))
        settings = json.loads(uploads["/private-state/eliza.json"])["env"]["vars"]
        self.assertEqual(settings["OPENAI_REASONING_EFFORT"], "none")
        self.assertEqual(settings["CEREBRAS_MODEL"], "test-model")
        self.assertEqual(settings["OPENAI_LARGE_MODEL"], "test-model")
        self.assertEqual(settings["OPENAI_BASE_URL"], "https://api.cerebras.ai/v1")
        self.assertNotIn("CEREBRAS_API_KEY", settings)
        self.assertNotIn("UNRELATED_SECRET", settings)


if __name__ == '__main__':
    unittest.main()
