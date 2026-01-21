from __future__ import annotations

import logging
import os
import sys
from typing import Any

import structlog

_DEFAULT_REDACT_KEYS: frozenset[str] = frozenset(
    {
        "password",
        "passwd",
        "secret",
        "token",
        "apikey",
        "api_key",
        "apisecret",
        "api_secret",
        "authorization",
        "auth",
        "credential",
        "credentials",
        "privatekey",
        "private_key",
        "accesstoken",
        "access_token",
        "refreshtoken",
        "refresh_token",
        "cookie",
        "session",
        "jwt",
        "bearer",
    }
)


def _parse_bool(value: str | None, *, default: bool) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _build_redact_keys() -> frozenset[str]:
    extra = os.environ.get("ELIZA_LOG_REDACT_KEYS", "")
    extra_keys = {k.strip().lower() for k in extra.split(",") if k.strip()}
    return _DEFAULT_REDACT_KEYS.union(extra_keys)


def _redact_value(value: object, *, redact_keys: frozenset[str]) -> object:
    if isinstance(value, dict):
        redacted: dict[object, object] = {}
        for k, v in value.items():
            if isinstance(k, str) and k.lower() in redact_keys:
                redacted[k] = "[REDACTED]"
            else:
                redacted[k] = _redact_value(v, redact_keys=redact_keys)
        return redacted
    if isinstance(value, list):
        return [_redact_value(v, redact_keys=redact_keys) for v in value]
    return value


def _redaction_processor(
    _logger: logging.Logger, _method_name: str, event_dict: structlog.types.EventDict
) -> structlog.types.EventDict:
    enabled = _parse_bool(os.environ.get("ELIZA_LOG_REDACT"), default=True)
    if not enabled:
        return event_dict
    redact_keys = _build_redact_keys()
    return _redact_value(event_dict, redact_keys=redact_keys)  # type: ignore[return-value]


def configure_structlog(log_level: str = "INFO") -> None:
    json_mode = _parse_bool(os.environ.get("LOG_JSON_FORMAT"), default=False)
    show_timestamps = _parse_bool(os.environ.get("LOG_TIMESTAMPS"), default=True)

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=getattr(logging, log_level.upper(), logging.INFO),
    )

    base_processors: list[structlog.types.Processor] = [
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        _redaction_processor,
    ]
    if show_timestamps:
        base_processors.append(structlog.processors.TimeStamper(fmt="iso"))
    base_processors.extend(
        [
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.UnicodeDecoder(),
        ]
    )

    structlog.configure(
        processors=[
            *base_processors,
            structlog.processors.JSONRenderer()
            if json_mode
            else structlog.dev.ConsoleRenderer(colors=True),
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


class Logger:
    def __init__(
        self,
        namespace: str | None = None,
        level: str = "INFO",
    ) -> None:
        self._namespace = namespace or "elizaos"
        self._level = level
        self._logger = structlog.get_logger(self._namespace)

    @property
    def namespace(self) -> str:
        return self._namespace

    def _log(
        self,
        level: str,
        message: str,
        *args: Any,
        **kwargs: Any,
    ) -> None:
        log_method = getattr(self._logger, level.lower(), self._logger.info)
        if args:
            log_method(message, *args, **kwargs)
        else:
            log_method(message, **kwargs)

    def debug(self, message: str, *args: Any, **kwargs: Any) -> None:
        self._log("debug", message, *args, **kwargs)

    def info(self, message: str, *args: Any, **kwargs: Any) -> None:
        self._log("info", message, *args, **kwargs)

    def warn(self, message: str, *args: Any, **kwargs: Any) -> None:
        self._log("warning", message, *args, **kwargs)

    def warning(self, message: str, *args: Any, **kwargs: Any) -> None:
        self._log("warning", message, *args, **kwargs)

    def error(self, message: str, *args: Any, **kwargs: Any) -> None:
        self._log("error", message, *args, **kwargs)

    def exception(self, message: str, *args: Any, **kwargs: Any) -> None:
        self._log("exception", message, *args, exc_info=True, **kwargs)

    def bind(self, **kwargs: Any) -> Logger:
        new_logger = Logger(namespace=self._namespace, level=self._level)
        new_logger._logger = self._logger.bind(**kwargs)
        return new_logger


def create_logger(
    namespace: str | None = None,
    level: str = "INFO",
) -> Logger:
    return Logger(namespace=namespace, level=level)


configure_structlog(log_level=os.environ.get("LOG_LEVEL", "INFO"))
logger = create_logger()
