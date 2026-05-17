"""Error injection mixin for mock services.

Adds configurable random errors (429, 500) and slow responses to mock
endpoints, so robustness scoring reflects actual error-recovery ability.

Usage in a mock service server.py:
    import sys; sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from mock_services._base import add_error_injection

    app = FastAPI(title="Mock Gmail API")
    add_error_injection(app)

Control via env vars:
    ERROR_RATE=0.25         # probability of injecting an error (default 25%)
    ERROR_RATE=0             # set to 0 to disable; override per-task in task.yaml env if needed
"""

from __future__ import annotations

import os
import random
import time

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

# Endpoints that should never have errors injected (grader + health)
_EXEMPT_SUFFIXES = ("/audit", "/reset", "/health", "/docs", "/openapi.json")

# Env-controlled error rate; default 25%
_ERROR_RATE = float(os.environ.get("ERROR_RATE", "0"))


def _should_inject() -> bool:
    """Roll the dice for error injection."""
    rate = float(os.environ.get("ERROR_RATE", str(_ERROR_RATE)))
    return random.random() < rate


class ErrorInjectionMiddleware(BaseHTTPMiddleware):
    """Randomly returns 429 or 500 errors, or adds latency."""

    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # Never inject errors on audit/reset/docs endpoints
        if any(path.endswith(suffix) for suffix in _EXEMPT_SUFFIXES):
            return await call_next(request)

        # Health-check probes from ServiceManager send this header — skip injection.
        if request.headers.get("X-Health-Check") == "1":
            return await call_next(request)

        # Only inject on POST endpoints (the actual tool calls)
        if request.method != "POST":
            return await call_next(request)

        if _should_inject():
            error_type = random.choices(
                ["rate_limit", "server_error", "slow"],
                weights=[0.35, 0.35, 0.30],
                k=1,
            )[0]

            if error_type == "rate_limit":
                return JSONResponse(
                    status_code=429,
                    content={
                        "error": "rate_limit_exceeded",
                        "message": "Too many requests. Please retry after a short delay.",
                        "retry_after_seconds": 2,
                    },
                    headers={"Retry-After": "2"},
                )
            elif error_type == "server_error":
                return JSONResponse(
                    status_code=500,
                    content={
                        "error": "internal_server_error",
                        "message": "An unexpected error occurred. Please try again.",
                    },
                )
            else:
                # Slow response — add 2-4s latency but still return real data
                delay = random.uniform(2.0, 4.0)
                time.sleep(delay)
                return await call_next(request)

        return await call_next(request)


def add_error_injection(app):
    """Add error injection middleware to a FastAPI app."""
    app.add_middleware(ErrorInjectionMiddleware)
