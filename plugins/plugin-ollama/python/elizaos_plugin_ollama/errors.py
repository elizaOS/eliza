from __future__ import annotations


class OllamaError(Exception):
    pass


class ConfigError(OllamaError):
    pass


class ConnectionError(OllamaError):
    def __init__(self, url: str, message: str | None = None) -> None:
        self.url = url
        msg = f"Failed to connect to Ollama at {url}"
        if message:
            msg = f"{msg}: {message}"
        super().__init__(msg)


class NetworkError(OllamaError):
    def __init__(self, message: str, status_code: int | None = None) -> None:
        self.status_code = status_code
        super().__init__(message)


class ModelNotFoundError(OllamaError):
    def __init__(self, model: str) -> None:
        self.model = model
        super().__init__(f"Model '{model}' not found. Try: ollama pull {model}")
