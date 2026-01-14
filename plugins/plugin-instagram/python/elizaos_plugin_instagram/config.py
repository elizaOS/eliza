import os

from pydantic import BaseModel


class InstagramConfig(BaseModel):
    username: str
    password: str
    verification_code: str | None = None
    proxy: str | None = None
    locale: str = "en_US"
    timezone_offset: int = 0

    @classmethod
    def from_env(cls) -> "InstagramConfig":
        username = os.getenv("INSTAGRAM_USERNAME")
        if not username:
            raise ValueError("INSTAGRAM_USERNAME environment variable is required")

        password = os.getenv("INSTAGRAM_PASSWORD")
        if not password:
            raise ValueError("INSTAGRAM_PASSWORD environment variable is required")

        verification_code = os.getenv("INSTAGRAM_VERIFICATION_CODE")
        proxy = os.getenv("INSTAGRAM_PROXY")
        locale = os.getenv("INSTAGRAM_LOCALE", "en_US")

        timezone_offset_str = os.getenv("INSTAGRAM_TIMEZONE_OFFSET", "0")
        try:
            timezone_offset = int(timezone_offset_str)
        except ValueError:
            timezone_offset = 0

        return cls(
            username=username,
            password=password,
            verification_code=verification_code,
            proxy=proxy,
            locale=locale,
            timezone_offset=timezone_offset,
        )
