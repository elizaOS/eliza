from enum import Enum
from pathlib import Path
from typing import TypedDict

from swebench.harness.constants.c import *
from swebench.harness.constants.go import *
from swebench.harness.constants.java import *
from swebench.harness.constants.javascript import *
from swebench.harness.constants.php import *
from swebench.harness.constants.python import *
from swebench.harness.constants.ruby import *
from swebench.harness.constants.rust import *


# Constants - Evaluation Log Directories
BASE_IMAGE_BUILD_DIR = Path("logs/build_images/base")
ENV_IMAGE_BUILD_DIR = Path("logs/build_images/env")
INSTANCE_IMAGE_BUILD_DIR = Path("logs/build_images/instances")
RUN_EVALUATION_LOG_DIR = Path("logs/run_evaluation")
RUN_VALIDATION_LOG_DIR = Path("logs/run_validation")


# Constants - Task Instance Class
class SWEbenchInstance(TypedDict):
    repo: str
    instance_id: str
    base_commit: str
    patch: str
    test_patch: str
    problem_statement: str
    hints_text: str
    created_at: str
    version: str
    FAIL_TO_PASS: str
    PASS_TO_PASS: str
    environment_setup_commit: str


# Constants - Test Types, Statuses, Commands
FAIL_TO_PASS = "FAIL_TO_PASS"
FAIL_TO_FAIL = "FAIL_TO_FAIL"
PASS_TO_PASS = "PASS_TO_PASS"
PASS_TO_FAIL = "PASS_TO_FAIL"


class ResolvedStatus(Enum):
    NO = "RESOLVED_NO"
    PARTIAL = "RESOLVED_PARTIAL"
    FULL = "RESOLVED_FULL"


class TestStatus(Enum):
    FAILED = "FAILED"
    PASSED = "PASSED"
    SKIPPED = "SKIPPED"
    ERROR = "ERROR"
    XFAIL = "XFAIL"


class EvalType(Enum):
    PASS_AND_FAIL = "pass_and_fail"
    FAIL_ONLY = "fail_only"


# Constants - Evaluation Keys
KEY_INSTANCE_ID = "instance_id"
KEY_MODEL = "model_name_or_path"
KEY_PREDICTION = "model_patch"

# Constants - Harness
DOCKER_PATCH = "/tmp/patch.diff"
DOCKER_USER = "root"
DOCKER_WORKDIR = "/testbed"
LOG_REPORT = "report.json"
LOG_INSTANCE = "run_instance.log"
LOG_TEST_OUTPUT = "test_output.txt"
UTF8 = "utf-8"

# Constants - Logging
APPLY_PATCH_FAIL = ">>>>> Patch Apply Failed"
APPLY_PATCH_PASS = ">>>>> Applied Patch"
INSTALL_FAIL = ">>>>> Init Failed"
INSTALL_PASS = ">>>>> Init Succeeded"
INSTALL_TIMEOUT = ">>>>> Init Timed Out"
RESET_FAILED = ">>>>> Reset Failed"
TESTS_ERROR = ">>>>> Tests Errored"
TESTS_FAILED = ">>>>> Some Tests Failed"
TESTS_PASSED = ">>>>> All Tests Passed"
TESTS_TIMEOUT = ">>>>> Tests Timed Out"
START_TEST_OUTPUT = ">>>>> Start Test Output"
END_TEST_OUTPUT = ">>>>> End Test Output"


# Constants - Patch Types
class PatchType(Enum):
    PATCH_GOLD = "gold"
    PATCH_PRED = "pred"
    PATCH_PRED_TRY = "pred_try"
    PATCH_PRED_MINIMAL = "pred_minimal"
    PATCH_PRED_MINIMAL_TRY = "pred_minimal_try"
    PATCH_TEST = "test"

    def __str__(self):
        return self.value


# Constants - Miscellaneous
NON_TEST_EXTS = [
    ".json",
    ".png",
    "csv",
    ".txt",
    ".md",
    ".jpg",
    ".jpeg",
    ".pkl",
    ".yml",
    ".yaml",
    ".toml",
]
SWE_BENCH_URL_RAW = "https://raw.githubusercontent.com/"
DEFAULT_DOCKER_SPECS = {
    "conda_version": "py311_23.11.0-2",
    "node_version": "21.6.2",
    "pnpm_version": "9.5.0",
    "python_version": "3.9",
    "ubuntu_version": "22.04",
}
FAIL_ONLY_REPOS = {
    "chartjs/Chart.js",
    "processing/p5.js",
    "markedjs/marked",
}

# Constants - Aggregate Installation Specifiactions
MAP_REPO_VERSION_TO_SPECS = {
    **MAP_REPO_VERSION_TO_SPECS_C,
    **MAP_REPO_VERSION_TO_SPECS_GO,
    **MAP_REPO_VERSION_TO_SPECS_JAVA,
    **MAP_REPO_VERSION_TO_SPECS_JS,
    **MAP_REPO_VERSION_TO_SPECS_PHP,
    **MAP_REPO_VERSION_TO_SPECS_PY,
    **MAP_REPO_VERSION_TO_SPECS_RUBY,
    **MAP_REPO_VERSION_TO_SPECS_RUST,
}

MAP_REPO_TO_INSTALL = {
    **MAP_REPO_TO_INSTALL_C,
    **MAP_REPO_TO_INSTALL_GO,
    **MAP_REPO_TO_INSTALL_JAVA,
    **MAP_REPO_TO_INSTALL_JS,
    **MAP_REPO_TO_INSTALL_PHP,
    **MAP_REPO_TO_INSTALL_PY,
    **MAP_REPO_TO_INSTALL_RUBY,
    **MAP_REPO_TO_INSTALL_RUST,
}

MAP_REPO_TO_EXT = {
    **{k: "c" for k in MAP_REPO_VERSION_TO_SPECS_C.keys()},
    **{k: "go" for k in MAP_REPO_VERSION_TO_SPECS_GO.keys()},
    **{k: "java" for k in MAP_REPO_VERSION_TO_SPECS_JAVA.keys()},
    **{k: "js" for k in MAP_REPO_VERSION_TO_SPECS_JS.keys()},
    **{k: "php" for k in MAP_REPO_VERSION_TO_SPECS_PHP.keys()},
    **{k: "py" for k in MAP_REPO_VERSION_TO_SPECS_PY.keys()},
    **{k: "rb" for k in MAP_REPO_VERSION_TO_SPECS_RUBY.keys()},
    **{k: "rs" for k in MAP_REPO_VERSION_TO_SPECS_RUST.keys()},
}

LATEST = "latest"
USE_X86 = USE_X86_PY

REPO_BASE_COMMIT_BRANCH = {
    "sympy/sympy": {
        "cffd4e0f86fefd4802349a9f9b19ed70934ea354": "1.7",
        "70381f282f2d9d039da860e391fe51649df2779d": "sympy-1.5.1",
    },
    "pytest-dev/pytest": {
        "8aba863a634f40560e25055d179220f0eefabe9a": "4.6.x",
    },
}
