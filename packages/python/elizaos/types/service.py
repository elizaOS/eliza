from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, ClassVar

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime


class ServiceTypeRegistry:
    TRANSCRIPTION: ClassVar[str] = "transcription"
    VIDEO: ClassVar[str] = "video"
    BROWSER: ClassVar[str] = "browser"
    PDF: ClassVar[str] = "pdf"
    REMOTE_FILES: ClassVar[str] = "aws_s3"
    WEB_SEARCH: ClassVar[str] = "web_search"
    EMAIL: ClassVar[str] = "email"
    TEE: ClassVar[str] = "tee"
    TASK: ClassVar[str] = "task"
    WALLET: ClassVar[str] = "wallet"
    LP_POOL: ClassVar[str] = "lp_pool"
    TOKEN_DATA: ClassVar[str] = "token_data"
    MESSAGE_SERVICE: ClassVar[str] = "message_service"
    MESSAGE: ClassVar[str] = "message"
    POST: ClassVar[str] = "post"
    UNKNOWN: ClassVar[str] = "unknown"


# Type for service names
ServiceTypeName = str


class ServiceType:
    TRANSCRIPTION = ServiceTypeRegistry.TRANSCRIPTION
    VIDEO = ServiceTypeRegistry.VIDEO
    BROWSER = ServiceTypeRegistry.BROWSER
    PDF = ServiceTypeRegistry.PDF
    REMOTE_FILES = ServiceTypeRegistry.REMOTE_FILES
    WEB_SEARCH = ServiceTypeRegistry.WEB_SEARCH
    EMAIL = ServiceTypeRegistry.EMAIL
    TEE = ServiceTypeRegistry.TEE
    TASK = ServiceTypeRegistry.TASK
    WALLET = ServiceTypeRegistry.WALLET
    LP_POOL = ServiceTypeRegistry.LP_POOL
    TOKEN_DATA = ServiceTypeRegistry.TOKEN_DATA
    MESSAGE_SERVICE = ServiceTypeRegistry.MESSAGE_SERVICE
    MESSAGE = ServiceTypeRegistry.MESSAGE
    POST = ServiceTypeRegistry.POST
    UNKNOWN = ServiceTypeRegistry.UNKNOWN


class Service(ABC):
    service_type: ClassVar[str] = ServiceType.UNKNOWN

    def __init__(self, runtime: IAgentRuntime | None = None) -> None:
        self._runtime = runtime
        self._config: object | None = None

    @property
    def runtime(self) -> IAgentRuntime:
        if self._runtime is None:
            raise RuntimeError("Service runtime not set")
        return self._runtime

    @runtime.setter
    def runtime(self, value: IAgentRuntime) -> None:
        self._runtime = value

    @property
    def config(self) -> object | None:
        return self._config

    @config.setter
    def config(self, value: object | None) -> None:
        self._config = value

    @property
    @abstractmethod
    def capability_description(self) -> str: ...

    @abstractmethod
    async def stop(self) -> None: ...

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> Service:
        raise NotImplementedError("Subclasses must implement start()")

    @classmethod
    def register_send_handlers(cls, runtime: IAgentRuntime, service: Service) -> None:
        _ = runtime, service


class ServiceError(BaseModel):
    """Standardized service error type for consistent error handling."""

    code: str = Field(..., description="Error code")
    message: str = Field(..., description="Error message")
    details: dict[str, Any] | str | int | float | bool | None = Field(
        default=None, description="Additional error details"
    )
    cause: Exception | None = Field(default=None, description="Cause of the error")

    model_config = {"arbitrary_types_allowed": True}


def create_service_error(error: Exception | str | Any, code: str = "UNKNOWN_ERROR") -> ServiceError:
    if isinstance(error, Exception):
        return ServiceError(code=code, message=str(error), cause=error)
    return ServiceError(code=code, message=str(error))
