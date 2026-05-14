"""Vendored Princeton-NLP WebShop sources.

Importing this package makes ``upstream.web_agent_site`` and
``upstream.baseline_models`` available, but the standard upstream
import path is ``web_agent_site`` (with no prefix). We expose it under
that name by inserting this directory onto ``sys.path`` when the
elizaOS adapter imports the env.

See ``UPSTREAM.md`` for vendoring notes and license.
"""
