# MODIFIED FROM UPSTREAM: WebAgentSiteEnv (Selenium-backed) is now imported
# defensively so that the headless WebAgentTextEnv can be used without a
# selenium / chromedriver install. This is the only file in `upstream/` that
# we modify; see ../../UPSTREAM.md.

try:
    from gym.envs.registration import register
except Exception:  # pragma: no cover - gym is optional for text-only runs
    def register(*args, **kwargs):
        return None

try:
    from web_agent_site.envs.web_agent_site_env import WebAgentSiteEnv  # noqa: F401
    _SITE_ENV_AVAILABLE = True
except Exception:  # pragma: no cover - selenium/chromedriver missing
    WebAgentSiteEnv = None  # type: ignore[assignment]
    _SITE_ENV_AVAILABLE = False

from web_agent_site.envs.web_agent_text_env import WebAgentTextEnv  # noqa: F401

if _SITE_ENV_AVAILABLE:
    register(
        id='WebAgentSiteEnv-v0',
        entry_point='web_agent_site.envs:WebAgentSiteEnv',
    )

register(
    id='WebAgentTextEnv-v0',
    entry_point='web_agent_site.envs:WebAgentTextEnv',
)
