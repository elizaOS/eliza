from __future__ import annotations

from abc import ABC, abstractmethod


class TeeVendorNames:
    PHALA = "phala"


class TeeVendorInterface(ABC):
    @property
    @abstractmethod
    def type(self) -> str:
        pass

    @abstractmethod
    def get_actions(self) -> list[dict[str, object]]:
        pass

    @abstractmethod
    def get_providers(self) -> list[object]:
        pass

    @abstractmethod
    def get_name(self) -> str:
        pass

    @abstractmethod
    def get_description(self) -> str:
        pass
