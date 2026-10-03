# gui_agents/s2/store/registry.py

# Usage: in any file, get the object through Registry.get
# from gui_agents.store.registry import Registry
# GlobalStateStore = Registry.get("GlobalStateStore")

class Registry:
    _services: dict[str, object] = {}

    @classmethod
    def register(cls, name: str, obj: object):
        cls._services[name] = obj

    @classmethod
    def get(cls, name: str) -> object:
        if name not in cls._services:
            raise KeyError(f"{name!r} not registered in Registry")
        return cls._services[name]

    @classmethod
    def clear(cls):
        cls._services.clear()
