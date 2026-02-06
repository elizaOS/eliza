"""Token-based authentication for webhook endpoints.

Supports three methods (in priority order):
  1. Authorization: Bearer <token>
  2. x-otto-token: <token>
  3. ?token=<token> (deprecated, logs a warning)
"""

from __future__ import annotations

import hmac
import logging
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

logger = logging.getLogger("elizaos.plugin.webhooks")


def extract_token(
    headers: Optional[dict[str, Any]] = None,
    query: Optional[dict[str, Any]] = None,
    url: Optional[str] = None,
) -> Optional[str]:
    """Extract an authentication token from a request.

    Checks in priority order:
      1. ``Authorization: Bearer <token>`` header
      2. ``x-otto-token`` header
      3. ``?token=<token>`` query parameter (deprecated)

    Args:
        headers: Request headers dict.  Values may be ``str`` or ``list[str]``.
        query: Parsed query-string dict.  Values may be ``str`` or ``list[str]``.
        url: Raw request URL (used as fallback for query-param extraction).

    Returns:
        The extracted token string, or ``None`` if no token is present.
    """
    hdrs: dict[str, Any] = headers or {}

    # 1. Authorization: Bearer <token>
    auth_header = hdrs.get("authorization") or hdrs.get("Authorization")
    if isinstance(auth_header, list):
        auth_header = auth_header[0] if auth_header else None
    if isinstance(auth_header, str) and auth_header.startswith("Bearer "):
        return auth_header[7:].strip()

    # 2. x-otto-token header
    otto_header = hdrs.get("x-otto-token") or hdrs.get("X-Otto-Token")
    if isinstance(otto_header, list):
        otto_header = otto_header[0] if otto_header else None
    if isinstance(otto_header, str) and otto_header.strip():
        return otto_header.strip()

    # 3. Query parameter (deprecated)
    query_token: Optional[str] = None

    if query is not None:
        tok = query.get("token")
        if isinstance(tok, str):
            query_token = tok
        elif isinstance(tok, list) and tok:
            query_token = tok[0] if isinstance(tok[0], str) else None

    if query_token is None and url is not None:
        parsed = urlparse(url)
        qs = parse_qs(parsed.query)
        tok_list = qs.get("token")
        if tok_list:
            query_token = tok_list[0]

    if query_token:
        logger.warning(
            "[Webhooks] Query-param token auth is deprecated; "
            "use Authorization header instead"
        )
        return query_token.strip()

    return None


def validate_token(
    expected_token: str,
    *,
    headers: Optional[dict[str, Any]] = None,
    query: Optional[dict[str, Any]] = None,
    url: Optional[str] = None,
) -> bool:
    """Validate a request token against the expected token.

    Uses :func:`hmac.compare_digest` for constant-time comparison.

    Args:
        expected_token: The expected (configured) token.
        headers: Request headers dict.
        query: Parsed query-string dict.
        url: Raw request URL.

    Returns:
        ``True`` if the provided token matches; ``False`` otherwise.
    """
    provided = extract_token(headers=headers, query=query, url=url)
    if provided is None:
        return False

    # Constant-time comparison
    return hmac.compare_digest(provided.encode("utf-8"), expected_token.encode("utf-8"))
