import collections
import json
import docker

from swebench.harness.constants import (
    FAIL_TO_PASS,
    PASS_TO_PASS,
    KEY_INSTANCE_ID,
    KEY_MODEL,
)
from swebench.harness.run_evaluation import make_run_report

TEST_INSTANCE = collections.defaultdict(lambda: "test")
TEST_INSTANCE[PASS_TO_PASS] = "[]"
TEST_INSTANCE["repo"] = "pvlib/pvlib-python"
TEST_INSTANCE["version"] = "0.1"
TEST_INSTANCE[FAIL_TO_PASS] = "[]"


def test_make_run_report(tmpdir) -> None:
    client = docker.from_env()
    with tmpdir.as_cwd():
        output_path = make_run_report(
            {"test": {KEY_INSTANCE_ID: "test", KEY_MODEL: "test"}},
            [TEST_INSTANCE],
            "test",
            client,
        )
        assert output_path.is_file()
        report = json.loads(output_path.read_text())
        assert report["schema_version"] == 2
