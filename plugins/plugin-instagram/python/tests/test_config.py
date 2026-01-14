import os
from unittest.mock import patch

import pytest

from elizaos_plugin_instagram.config import InstagramConfig


class TestInstagramConfig:
    def test_config_creation(self) -> None:
        config = InstagramConfig(
            username="testuser",
            password="testpass",
            verification_code="123456",
            proxy="http://proxy:8080",
            locale="de_DE",
            timezone_offset=3600,
        )

        assert config.username == "testuser"
        assert config.password == "testpass"
        assert config.verification_code == "123456"
        assert config.proxy == "http://proxy:8080"
        assert config.locale == "de_DE"
        assert config.timezone_offset == 3600

    def test_config_defaults(self) -> None:
        config = InstagramConfig(username="testuser", password="testpass")

        assert config.verification_code is None
        assert config.proxy is None
        assert config.locale == "en_US"
        assert config.timezone_offset == 0

    def test_from_env(self) -> None:
        env = {
            "INSTAGRAM_USERNAME": "envuser",
            "INSTAGRAM_PASSWORD": "envpass",
            "INSTAGRAM_VERIFICATION_CODE": "654321",
            "INSTAGRAM_PROXY": "http://envproxy:8080",
            "INSTAGRAM_LOCALE": "fr_FR",
            "INSTAGRAM_TIMEZONE_OFFSET": "7200",
        }

        with patch.dict(os.environ, env, clear=False):
            config = InstagramConfig.from_env()

        assert config.username == "envuser"
        assert config.password == "envpass"
        assert config.verification_code == "654321"
        assert config.proxy == "http://envproxy:8080"
        assert config.locale == "fr_FR"
        assert config.timezone_offset == 7200

    def test_from_env_missing_username(self) -> None:
        env = {"INSTAGRAM_PASSWORD": "testpass"}

        with patch.dict(os.environ, env, clear=True):
            with pytest.raises(ValueError, match="INSTAGRAM_USERNAME"):
                InstagramConfig.from_env()

    def test_from_env_missing_password(self) -> None:
        env = {"INSTAGRAM_USERNAME": "testuser"}

        with patch.dict(os.environ, env, clear=True):
            with pytest.raises(ValueError, match="INSTAGRAM_PASSWORD"):
                InstagramConfig.from_env()

    def test_from_env_invalid_timezone_offset(self) -> None:
        env = {
            "INSTAGRAM_USERNAME": "testuser",
            "INSTAGRAM_PASSWORD": "testpass",
            "INSTAGRAM_TIMEZONE_OFFSET": "invalid",
        }

        with patch.dict(os.environ, env, clear=False):
            config = InstagramConfig.from_env()

        assert config.timezone_offset == 0
