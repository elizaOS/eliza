"""Error types for the Gmail Watch plugin."""


class GmailWatchError(Exception):
    """Base exception for Gmail Watch plugin errors."""

    def __init__(self, message: str, cause: Exception | None = None) -> None:
        super().__init__(message)
        self.cause = cause


class ConfigError(GmailWatchError):
    """Configuration error."""


class GogBinaryNotFoundError(GmailWatchError):
    """The ``gog`` CLI binary was not found in PATH."""

    def __init__(self) -> None:
        super().__init__(
            "gog binary not found in PATH. Install gogcli: https://gogcli.sh/"
        )


class ProcessError(GmailWatchError):
    """An error related to the child process."""

    def __init__(self, message: str, exit_code: int | None = None) -> None:
        super().__init__(message)
        self.exit_code = exit_code


class RenewalError(GmailWatchError):
    """An error that occurred during watch renewal."""

    def __init__(self, message: str, exit_code: int | None = None) -> None:
        super().__init__(message)
        self.exit_code = exit_code
