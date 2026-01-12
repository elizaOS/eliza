from __future__ import annotations


class N8nError(Exception):
    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)


class ConfigError(N8nError):
    def __init__(self, setting: str, message: str | None = None) -> None:
        self.setting = setting
        msg = message or f"Missing or invalid configuration: {setting}"
        super().__init__(msg)


class ApiKeyError(ConfigError):
    def __init__(self, provider: str = "ANTHROPIC") -> None:
        self.provider = provider
        super().__init__(
            f"{provider}_API_KEY",
            f"{provider}_API_KEY is not configured.",
        )


class ValidationError(N8nError):
    def __init__(self, field: str, message: str) -> None:
        self.field = field
        super().__init__(f"Validation error for {field}: {message}")


class JobError(N8nError):
    def __init__(self, job_id: str, message: str) -> None:
        self.job_id = job_id
        super().__init__(f"Job {job_id}: {message}")


class RateLimitError(N8nError):
    def __init__(
        self, message: str = "Rate limit exceeded. Please wait before creating another plugin."
    ) -> None:
        super().__init__(message)


class PluginExistsError(N8nError):
    def __init__(self, plugin_name: str) -> None:
        self.plugin_name = plugin_name
        super().__init__(f"Plugin {plugin_name} has already been created in this session")


class InvalidPluginNameError(ValidationError):
    def __init__(self, name: str) -> None:
        super().__init__(
            "name", f"Invalid plugin name: {name}. Must follow format: @scope/plugin-name"
        )


class MaxConcurrentJobsError(N8nError):
    def __init__(self, max_jobs: int = 10) -> None:
        self.max_jobs = max_jobs
        super().__init__(
            f"Maximum number of concurrent jobs ({max_jobs}) reached. Please wait for existing jobs to complete."
        )
