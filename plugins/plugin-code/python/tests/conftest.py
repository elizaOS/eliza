from __future__ import annotations

import os
from pathlib import Path

import pytest

from elizaos_plugin_eliza_coder.service import CoderService


@pytest.fixture
def tmp_allowed_dir(tmp_path: Path) -> Path:
    return tmp_path


@pytest.fixture
def coder_env(tmp_allowed_dir: Path) -> None:
    os.environ["CODER_ENABLED"] = "true"
    os.environ["CODER_ALLOWED_DIRECTORY"] = str(tmp_allowed_dir)
    os.environ["CODER_TIMEOUT"] = "30000"
    os.environ.pop("CODER_FORBIDDEN_COMMANDS", None)


@pytest.fixture
def service(coder_env: None) -> CoderService:
    # Reads config from env during init.
    return CoderService()
