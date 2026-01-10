"""
Service types for elizaOS.

This module defines the Service base class and service-related types.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, ClassVar

from pydantic import BaseModel, Field

from elizaos.types.primitives import Metadata

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime


class ServiceTypeRegistry:
    """
    Core service type registry that can be extended by plugins.
    """

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
    """
    Enumerates the recognized types of services that can be registered and used.
    """

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
    """
    Abstract base class for services.
    Services provide specialized functionalities like audio transcription,
    video processing, web browsing, etc.
    """

    # Class variable for service type - must be set by subclasses
    service_type: ClassVar[str] = ServiceType.UNKNOWN

    def __init__(self, runtime: IAgentRuntime | None = None) -> None:
        """Initialize the service with an optional runtime reference."""
        self._runtime = runtime
        self._config: Metadata | None = None

    @property
    def runtime(self) -> IAgentRuntime:
        """Get the runtime instance."""
        if self._runtime is None:
            raise RuntimeError("Service runtime not set")
        return self._runtime

    @runtime.setter
    def runtime(self, value: IAgentRuntime) -> None:
        """Set the runtime instance."""
        self._runtime = value

    @property
    def config(self) -> Metadata | None:
        """Get the service configuration."""
        return self._config

    @config.setter
    def config(self, value: Metadata | None) -> None:
        """Set the service configuration."""
        self._config = value

    @property
    @abstractmethod
    def capability_description(self) -> str:
        """Get the capability description for this service."""
        ...

    @abstractmethod
    async def stop(self) -> None:
        """Stop the service connection."""
        ...

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> Service:
        """Start the service connection."""
        raise NotImplementedError("Subclasses must implement start()")

    @classmethod
    def register_send_handlers(cls, runtime: IAgentRuntime, service: Service) -> None:
        """Optional static method to register send handlers.

        Subclasses may override this to register custom send handlers.
        """
        _ = runtime, service  # Optional method, default is no-op


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
    """Safely create a ServiceError from any caught error."""
    if isinstance(error, Exception):
        return ServiceError(code=code, message=str(error), cause=error)
    return ServiceError(code=code, message=str(error))
