from __future__ import annotations

import os
import re
from dataclasses import dataclass

from elizaos_plugin_bluesky.errors import ConfigError
from elizaos_plugin_bluesky.types import (
    BLUESKY_ACTION_INTERVAL,
    BLUESKY_MAX_ACTIONS,
    BLUESKY_POLL_INTERVAL,
    BLUESKY_POST_INTERVAL_MAX,
    BLUESKY_POST_INTERVAL_MIN,
    BLUESKY_SERVICE_URL,
)

AT_PROTOCOL_HANDLE_REGEX = re.compile(
    r"^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$"
)


@dataclass(frozen=True)
class BlueSkyConfig:
    handle: str
    password: str
    service: str = BLUESKY_SERVICE_URL
    dry_run: bool = False
    poll_interval: int = BLUESKY_POLL_INTERVAL
    enable_posting: bool = True
    post_interval_min: int = BLUESKY_POST_INTERVAL_MIN
    post_interval_max: int = BLUESKY_POST_INTERVAL_MAX
    enable_action_processing: bool = True
    action_interval: int = BLUESKY_ACTION_INTERVAL
    post_immediately: bool = False
    max_actions_processing: int = BLUESKY_MAX_ACTIONS
    enable_dms: bool = True

    def __post_init__(self) -> None:
        if not self.handle:
            raise ConfigError("Handle cannot be empty", "handle")
        if not AT_PROTOCOL_HANDLE_REGEX.match(self.handle):
            raise ConfigError("Invalid handle format", "handle")
        if not self.password:
            raise ConfigError("Password cannot be empty", "password")

    @classmethod
    def from_env(cls) -> BlueSkyConfig:
        handle = os.environ.get("BLUESKY_HANDLE", "")
        if not handle:
            raise ConfigError("BLUESKY_HANDLE not set", "handle")

        password = os.environ.get("BLUESKY_PASSWORD", "")
        if not password:
            raise ConfigError("BLUESKY_PASSWORD not set", "password")

        def get_int(key: str, default: int) -> int:
            val = os.environ.get(key)
            return int(val) if val else default

        def get_bool(key: str, default: bool) -> bool:
            val = os.environ.get(key, "").lower()
            if not val:
                return default
            return val == "true" if default is False else val != "false"

        return cls(
            handle=handle,
            password=password,
            service=os.environ.get("BLUESKY_SERVICE", BLUESKY_SERVICE_URL),
            dry_run=get_bool("BLUESKY_DRY_RUN", False),
            poll_interval=get_int("BLUESKY_POLL_INTERVAL", BLUESKY_POLL_INTERVAL),
            enable_posting=get_bool("BLUESKY_ENABLE_POSTING", True),
            post_interval_min=get_int("BLUESKY_POST_INTERVAL_MIN", BLUESKY_POST_INTERVAL_MIN),
            post_interval_max=get_int("BLUESKY_POST_INTERVAL_MAX", BLUESKY_POST_INTERVAL_MAX),
            enable_action_processing=get_bool("BLUESKY_ENABLE_ACTION_PROCESSING", True),
            action_interval=get_int("BLUESKY_ACTION_INTERVAL", BLUESKY_ACTION_INTERVAL),
            post_immediately=get_bool("BLUESKY_POST_IMMEDIATELY", False),
            max_actions_processing=get_int("BLUESKY_MAX_ACTIONS_PROCESSING", BLUESKY_MAX_ACTIONS),
            enable_dms=get_bool("BLUESKY_ENABLE_DMS", True),
        )
