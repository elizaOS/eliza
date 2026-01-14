class InstagramError(Exception):
    def __init__(self, message: str, cause: Exception | None = None) -> None:
        super().__init__(message)
        self.cause = cause


class ConfigError(InstagramError):
    pass


class AuthenticationError(InstagramError):
    def __init__(
        self, message: str = "Authentication failed", cause: Exception | None = None
    ) -> None:
        super().__init__(message, cause)


class RateLimitError(InstagramError):
    def __init__(self, retry_after: int | None = None) -> None:
        message = "Rate limit exceeded"
        if retry_after:
            message += f", retry after {retry_after} seconds"
        super().__init__(message)
        self.retry_after = retry_after


class MessageSendError(InstagramError):
    def __init__(self, thread_id: str, cause: Exception | None = None) -> None:
        super().__init__(f"Failed to send message to thread {thread_id}", cause)
        self.thread_id = thread_id


class MediaUploadError(InstagramError):
    def __init__(self, media_type: str, cause: Exception | None = None) -> None:
        super().__init__(f"Failed to upload {media_type}", cause)
        self.media_type = media_type
