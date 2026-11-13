import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import worker
from vastai.serverless.server.lib.data_types import LogAction
from vastai.serverless.server.worker import EndpointHandlerFactory


class WorkerContractTests(unittest.TestCase):
    def test_complete_tool_history_and_schema_affect_workload(self):
        request = {
            "messages": [{"role": "assistant", "content": None}],
            "max_tokens": 128,
        }
        baseline = worker.workload_for_chat_request(request)
        request["messages"][0]["tool_calls"] = [
            {
                "id": "call-1",
                "type": "function",
                "function": {
                    "name": "search",
                    "arguments": "x" * 100_000,
                },
            }
        ]
        self.assertGreaterEqual(
            worker.workload_for_chat_request(request), baseline + 25_000
        )
        request["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": "search",
                    "parameters": {
                        "properties": {"long_property_name" * 1000: {"type": "string"}}
                    },
                },
            }
        ]
        self.assertGreater(worker.workload_for_chat_request(request), baseline + 28_000)

    def test_token_ids_and_batched_outputs_are_accounted_for(self):
        self.assertEqual(
            worker.workload_for_chat_request(
                {"prompt": list(range(10_000)), "max_tokens": 128}
            ),
            10_128,
        )
        self.assertEqual(
            worker.workload_for_chat_request(
                {"prompt": [[1, 2], [3, 4, 5]], "max_tokens": 100, "n": 3}
            ),
            605,
        )
        self.assertEqual(
            worker.workload_for_chat_request(
                {"prompt": ["x" * 400, "y" * 400], "max_tokens": 100, "best_of": 3}
            ),
            800,
        )

    def test_output_limit_alias_and_extension_fields(self):
        request = {"prompt": "x" * 400, "max_tokens": 10, "max_completion_tokens": 200}
        self.assertEqual(worker.workload_for_chat_request(request), 300)
        request["eliza_planner_action_schemas"] = {"task": "x" * 4000}
        self.assertGreaterEqual(worker.workload_for_chat_request(request), 1300)

    def test_nested_input_has_no_recursion_or_truncation_limit(self):
        nested = "x" * 4000
        for _ in range(2000):
            nested = [nested]
        self.assertEqual(worker._text_token_estimate(nested), 1000)

    def test_sdk_preserves_payload_and_estimates_the_same_request(self):
        factory = EndpointHandlerFactory(worker.worker_config())
        request = {
            "messages": [
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "function": {"name": "f", "arguments": "x" * 100_000},
                        }
                    ],
                }
            ],
            "max_tokens": 128,
            "eliza_guided_decode": {"schema": {"type": "object"}},
        }
        original = copy.deepcopy(request)
        for route in ("/v1/chat/completions", "/v1/completions"):
            payload = factory.get_handler(route).payload_cls().from_json_msg(request)
            self.assertEqual(payload.generate_payload_json(), original)
            self.assertEqual(
                payload.count_workload(), worker.workload_for_chat_request(request)
            )
        self.assertEqual(request, original)

    def test_actual_sdk_constructor_has_local_url_and_readiness_actions(self):
        config = worker.worker_config()
        with patch.dict(
            "os.environ",
            {
                "CONTAINER_ID": "1234",
                "REPORT_ADDR": "http://127.0.0.1:1",
                "WORKER_PORT": "9000",
                "VAST_TCP_PORT_9000": "9000",
                "PUBLIC_IPADDR": "127.0.0.1",
            },
        ):
            instance = worker.Worker(config)
        self.assertEqual(
            instance.backend.model_server_url,
            f"http://127.0.0.1:{worker.LLAMA_SERVER_PORT}",
        )
        self.assertEqual(
            instance.backend.healthcheck_url,
            f"http://127.0.0.1:{worker.LLAMA_SERVER_PORT}/health",
        )
        for line in (
            "srv listen: server is listening on http://127.0.0.1:8080",
            "INFO: Application startup complete.",
        ):
            self.assertTrue(
                any(
                    action == LogAction.ModelLoaded and pattern in line
                    for action, pattern in instance.backend.log_actions
                )
            )
        factory = EndpointHandlerFactory(config)
        self.assertIsNotNone(factory.get_benchmark_handler())
        self.assertEqual(
            sum(h.has_benchmark for h in factory.get_all_handlers().values()), 1
        )


if __name__ == "__main__":
    unittest.main()
