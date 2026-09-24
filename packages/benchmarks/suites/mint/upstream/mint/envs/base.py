from abc import ABC, abstractmethod
from mint.datatypes import State, Action


class BaseEnv(ABC):
    @abstractmethod
    def step(self, action: Action) -> State:
        pass

    @abstractmethod
    def reset(self) -> State:
        pass
