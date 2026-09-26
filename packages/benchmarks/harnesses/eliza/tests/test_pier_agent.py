"""Optional Pier adapter boundary checks; live grading is a separate lane."""
import asyncio
import json
from types import SimpleNamespace
import hashlib
import importlib.util
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
