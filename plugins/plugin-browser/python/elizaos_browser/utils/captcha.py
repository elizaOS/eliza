import logging
from typing import Any

import httpx

from elizaos_browser.types import CaptchaType

logger = logging.getLogger(__name__)


class CapSolverService:
    def __init__(
        self,
        api_key: str,
        api_url: str = "https://api.capsolver.com",
        retry_attempts: int = 60,
        polling_interval: float = 2.0,
    ) -> None:
        self.api_key = api_key
        self.api_url = api_url
        self.retry_attempts = retry_attempts
        self.polling_interval = polling_interval

    async def create_task(self, task: dict[str, Any]) -> str:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{self.api_url}/createTask",
                    json={"clientKey": self.api_key, "task": task},
                )
                data = response.json()

                if data.get("errorId", 0) != 0:
                    raise RuntimeError(
                        f"CapSolver error: {data.get('errorDescription', 'Unknown error')}"
                    )

                task_id = data.get("taskId")
                if not isinstance(task_id, str):
                    raise RuntimeError(f"Invalid task ID from CapSolver: {task_id}")
                logger.info(f"CapSolver task created: {task_id}")
                return task_id

        except Exception as e:
            logger.error(f"Error creating CapSolver task: {e}")
            raise

    async def get_task_result(self, task_id: str) -> dict[str, Any]:
        import asyncio

        attempts = 0

        while attempts < self.retry_attempts:
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    response = await client.post(
                        f"{self.api_url}/getTaskResult",
                        json={"clientKey": self.api_key, "taskId": task_id},
                    )
                    data = response.json()

                    if data.get("errorId", 0) != 0:
                        raise RuntimeError(
                            f"CapSolver error: {data.get('errorDescription', 'Unknown error')}"
                        )

                    if data.get("status") == "ready":
                        logger.info("CapSolver task completed successfully")
                        solution = data.get("solution", {})
                        return dict(solution) if isinstance(solution, dict) else {}

                    await asyncio.sleep(self.polling_interval)
                    attempts += 1

            except Exception as e:
                logger.error(f"Error getting CapSolver task result: {e}")
                raise

        raise RuntimeError("CapSolver task timeout")

    async def solve_turnstile(
        self,
        website_url: str,
        website_key: str,
        proxy: str | None = None,
        user_agent: str | None = None,
    ) -> str:
        logger.info("Solving Cloudflare Turnstile captcha")

        task: dict[str, Any] = {
            "type": "AntiTurnstileTask" if proxy else "AntiTurnstileTaskProxyLess",
            "websiteURL": website_url,
            "websiteKey": website_key,
        }

        if proxy:
            parts = proxy.split(":")
            task["proxy"] = f"{parts[0]}:{parts[1]}"
            if len(parts) > 2:
                task["proxyLogin"] = parts[2]
                task["proxyPassword"] = parts[3]

        if user_agent:
            task["userAgent"] = user_agent

        task_id = await self.create_task(task)
        solution = await self.get_task_result(task_id)

        token = solution.get("token", "")
        return str(token) if token else ""

    async def solve_recaptcha_v2(
        self,
        website_url: str,
        website_key: str,
        is_invisible: bool = False,
        proxy: str | None = None,
    ) -> str:
        logger.info("Solving reCAPTCHA v2")

        task: dict[str, Any] = {
            "type": "RecaptchaV2Task" if proxy else "RecaptchaV2TaskProxyless",
            "websiteURL": website_url,
            "websiteKey": website_key,
            "isInvisible": is_invisible,
        }

        if proxy:
            parts = proxy.split(":")
            task["proxy"] = f"{parts[0]}:{parts[1]}"
            if len(parts) > 2:
                task["proxyLogin"] = parts[2]
                task["proxyPassword"] = parts[3]

        task_id = await self.create_task(task)
        solution = await self.get_task_result(task_id)

        response = solution.get("gRecaptchaResponse", "")
        return str(response) if response else ""

    async def solve_recaptcha_v3(
        self,
        website_url: str,
        website_key: str,
        page_action: str,
        min_score: float = 0.7,
        proxy: str | None = None,
    ) -> str:
        logger.info("Solving reCAPTCHA v3")

        task: dict[str, Any] = {
            "type": "RecaptchaV3Task" if proxy else "RecaptchaV3TaskProxyless",
            "websiteURL": website_url,
            "websiteKey": website_key,
            "pageAction": page_action,
            "minScore": min_score,
        }

        if proxy:
            parts = proxy.split(":")
            task["proxy"] = f"{parts[0]}:{parts[1]}"
            if len(parts) > 2:
                task["proxyLogin"] = parts[2]
                task["proxyPassword"] = parts[3]

        task_id = await self.create_task(task)
        solution = await self.get_task_result(task_id)

        response = solution.get("gRecaptchaResponse", "")
        return str(response) if response else ""

    async def solve_hcaptcha(
        self,
        website_url: str,
        website_key: str,
        proxy: str | None = None,
    ) -> str:
        logger.info("Solving hCaptcha")

        task: dict[str, Any] = {
            "type": "HCaptchaTask" if proxy else "HCaptchaTaskProxyless",
            "websiteURL": website_url,
            "websiteKey": website_key,
        }

        if proxy:
            parts = proxy.split(":")
            task["proxy"] = f"{parts[0]}:{parts[1]}"
            if len(parts) > 2:
                task["proxyLogin"] = parts[2]
                task["proxyPassword"] = parts[3]

        task_id = await self.create_task(task)
        solution = await self.get_task_result(task_id)

        token = solution.get("token", "")
        return str(token) if token else ""


async def detect_captcha_type(page: Any) -> tuple[CaptchaType, str | None]:
    turnstile = await page.query_selector("[data-sitekey]")
    if turnstile:
        cf_turnstile = await page.query_selector(".cf-turnstile")
        if cf_turnstile:
            site_key = await turnstile.get_attribute("data-sitekey")
            return CaptchaType.TURNSTILE, site_key

    recaptcha = await page.query_selector("[data-sitekey], .g-recaptcha")
    if recaptcha:
        site_key = await recaptcha.get_attribute("data-sitekey")
        is_v3 = await page.evaluate(
            "() => typeof grecaptcha !== 'undefined' && typeof grecaptcha.execute === 'function'"
        )
        return (
            CaptchaType.RECAPTCHA_V3 if is_v3 else CaptchaType.RECAPTCHA_V2,
            site_key,
        )

    hcaptcha = await page.query_selector("[data-sitekey].h-captcha, [data-hcaptcha-sitekey]")
    if hcaptcha:
        site_key = await hcaptcha.get_attribute("data-sitekey") or await hcaptcha.get_attribute(
            "data-hcaptcha-sitekey"
        )
        return CaptchaType.HCAPTCHA, site_key

    return CaptchaType.NONE, None


async def inject_captcha_solution(
    page: Any,
    captcha_type: CaptchaType,
    solution: str,
) -> None:
    if captcha_type == CaptchaType.TURNSTILE:
        await page.evaluate(
            """(token) => {
                const textarea = document.querySelector('[name="cf-turnstile-response"]');
                if (textarea) textarea.value = token;
                if (window.turnstileCallback) window.turnstileCallback(token);
            }""",
            solution,
        )
    elif captcha_type in (CaptchaType.RECAPTCHA_V2, CaptchaType.RECAPTCHA_V3):
        await page.evaluate(
            """(token) => {
                const textarea = document.querySelector('[name="g-recaptcha-response"]');
                if (textarea) {
                    textarea.value = token;
                    textarea.style.display = 'block';
                }
                if (window.onRecaptchaSuccess) window.onRecaptchaSuccess(token);
            }""",
            solution,
        )
    elif captcha_type == CaptchaType.HCAPTCHA:
        await page.evaluate(
            """(token) => {
                const textarea = document.querySelector('[name="h-captcha-response"]');
                if (textarea) textarea.value = token;
                const input = document.querySelector('[name="g-recaptcha-response"]');
                if (input) input.value = token;
                if (window.hcaptchaCallback) window.hcaptchaCallback(token);
            }""",
            solution,
        )
