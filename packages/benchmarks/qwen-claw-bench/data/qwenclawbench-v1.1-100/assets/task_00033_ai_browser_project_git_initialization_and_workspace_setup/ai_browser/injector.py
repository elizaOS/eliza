"""JavaScript injection module for dynamic page manipulation."""

import logging
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


# Built-in injection scripts
BUILTIN_SCRIPTS = {
    "scroll_to_bottom": """
        async function scrollToBottom() {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 300;
                const timer = setInterval(() => {
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= document.body.scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        }
        await scrollToBottom();
    """,

    "remove_overlays": """
        document.querySelectorAll('[class*="overlay"], [class*="modal"], [class*="popup"]')
            .forEach(el => el.remove());
        document.querySelectorAll('[class*="cookie"], [id*="cookie"]')
            .forEach(el => el.remove());
        document.body.style.overflow = 'auto';
    """,

    "expand_lazy_images": """
        document.querySelectorAll('img[data-src], img[data-lazy-src]').forEach(img => {
            const realSrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
            if (realSrc) img.src = realSrc;
        });
    """,

    "click_show_more": """
        const buttons = document.querySelectorAll(
            'button, a, [role="button"]'
        );
        for (const btn of buttons) {
            const text = btn.innerText.toLowerCase();
            if (text.includes('show more') || text.includes('load more') ||
                text.includes('read more') || text.includes('see all')) {
                btn.click();
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    """,

    "extract_metadata": """
        (() => {
            const meta = {};
            document.querySelectorAll('meta').forEach(m => {
                const name = m.getAttribute('name') || m.getAttribute('property') || '';
                const content = m.getAttribute('content') || '';
                if (name && content) meta[name] = content;
            });
            return JSON.stringify(meta);
        })();
    """,
}


class ScriptInjector:
    """Manages JavaScript injection into browser pages.

    Provides built-in scripts for common operations (scrolling, overlay removal,
    lazy loading) and supports custom script injection.
    """

    def __init__(self):
        self._scripts: Dict[str, str] = BUILTIN_SCRIPTS.copy()
        self._execution_log: List[Dict] = []

    def register_script(self, name: str, script: str):
        """Register a custom injection script.

        Args:
            name: Unique script identifier.
            script: JavaScript code to inject.
        """
        self._scripts[name] = script
        logger.info("Registered custom script: %s", name)

    def get_script(self, name: str) -> Optional[str]:
        """Get a script by name."""
        return self._scripts.get(name)

    def list_scripts(self) -> List[str]:
        """List all available script names."""
        return list(self._scripts.keys())

    async def inject(self, page, script_name: str, **kwargs) -> Optional[str]:
        """Inject and execute a named script on the page.

        Args:
            page: Playwright page object.
            script_name: Name of the script to inject.
            **kwargs: Optional parameters to substitute in the script.

        Returns:
            Script return value as string, or None.
        """
        script = self._scripts.get(script_name)
        if not script:
            logger.error("Script not found: %s", script_name)
            return None

        # Simple parameter substitution
        for key, value in kwargs.items():
            script = script.replace(f"${{{key}}}", str(value))

        try:
            result = await page.evaluate(script)
            self._execution_log.append({
                "script": script_name,
                "success": True,
                "result_length": len(str(result)) if result else 0,
            })
            logger.info("Injected script '%s' successfully", script_name)
            return str(result) if result else None
        except Exception as e:
            self._execution_log.append({
                "script": script_name,
                "success": False,
                "error": str(e),
            })
            logger.error("Script '%s' failed: %s", script_name, e)
            raise

    async def inject_all(self, page, script_names: List[str]) -> Dict[str, Optional[str]]:
        """Inject multiple scripts sequentially.

        Args:
            page: Playwright page object.
            script_names: List of script names to execute.

        Returns:
            Dict mapping script names to their results.
        """
        results = {}
        for name in script_names:
            try:
                results[name] = await self.inject(page, name)
            except Exception:
                results[name] = None
        return results

    def get_execution_log(self) -> List[Dict]:
        """Return the script execution log."""
        return self._execution_log.copy()
