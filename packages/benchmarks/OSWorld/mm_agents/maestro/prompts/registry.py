import os
import threading
from typing import Dict, List, Set


class PromptRegistry:
    """Central registry for system and module prompts.

    - Loads .txt prompt files from the local `system` and `module` directories on initialization
    - Allows programmatic registration of prompts (module-level or dynamic)
    - Provides a simple, thread-safe API for getting/setting/listing prompts
    - Names for module prompts are based on relative path inside `module`, e.g. `manager/task_planner`
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._prompts: Dict[str, str] = {}
        self._base_dir = os.path.dirname(__file__)
        self._system_dir = os.path.join(self._base_dir, "system")
        self._module_dir = os.path.join(self._base_dir, "module")
        # Track namespaces
        self._module_keys: Set[str] = set()
        self._system_keys: Set[str] = set()
        self._load_system_prompts()
        self._load_module_prompts()

    def _load_system_prompts(self) -> None:
        system_prompts: Dict[str, str] = {}
        system_keys: Set[str] = set()
        try:
            if os.path.isdir(self._system_dir):
                for fname in os.listdir(self._system_dir):
                    if not fname.lower().endswith(".txt"):
                        continue
                    key = os.path.splitext(fname)[0]
                    fpath = os.path.join(self._system_dir, fname)
                    try:
                        with open(fpath, "r", encoding="utf-8") as f:
                            system_prompts[key] = f.read()
                            system_keys.add(key)
                    except Exception:
                        # Skip unreadable files but continue loading others
                        continue
        finally:
            with self._lock:
                # System prompts become the baseline; module/dynamic can override
                self._prompts.update(system_prompts)
                self._system_keys = system_keys

    def _load_module_prompts(self) -> None:
        module_prompts: Dict[str, str] = {}
        module_keys: Set[str] = set()
        try:
            if os.path.isdir(self._module_dir):
                for root, _dirs, files in os.walk(self._module_dir):
                    for fname in files:
                        if not fname.lower().endswith(".txt"):
                            continue
                        fpath = os.path.join(root, fname)
                        rel = os.path.relpath(fpath, self._module_dir)
                        key = os.path.splitext(rel)[0].replace(os.sep, "/")
                        try:
                            with open(fpath, "r", encoding="utf-8") as f:
                                module_prompts[key] = f.read()
                                module_keys.add(key)
                        except Exception:
                            continue
        finally:
            with self._lock:
                # Module prompts can override system prompts of the same key
                self._prompts.update(module_prompts)
                self._module_keys = module_keys

    def refresh(self) -> None:
        """Reload system and module prompts from disk. Keeps any programmatically registered prompts unless overwritten by disk files."""
        with self._lock:
            old_prompts = dict(self._prompts)
        # Reload from disk
        with self._lock:
            self._prompts = {}
            self._module_keys = set()
            self._system_keys = set()
        self._load_system_prompts()
        self._load_module_prompts()
        # Reapply dynamic prompts that are not present on disk
        with self._lock:
            for name, content in old_prompts.items():
                if name not in self._prompts:
                    self._prompts[name] = content

    def _names_from_dir(self, directory: str) -> List[str]:
        if not os.path.isdir(directory):
            return []
        return [os.path.splitext(f)[0] for f in os.listdir(directory) if f.lower().endswith(".txt")]

    def get(self, name: str, default: str = "") -> str:
        with self._lock:
            return self._prompts.get(name, default)

    def set(self, name: str, content: str) -> None:
        """Register or override a prompt by name."""
        with self._lock:
            self._prompts[name] = content

    def exists(self, name: str) -> bool:
        with self._lock:
            return name in self._prompts

    def exists_in_module(self, name: str) -> bool:
        with self._lock:
            return name in self._module_keys

    def module_children_exist(self, prefix: str) -> bool:
        with self._lock:
            prefix_slash = prefix + "/"
            return any(k.startswith(prefix_slash) for k in self._module_keys)

    def all_names(self) -> List[str]:
        with self._lock:
            return sorted(self._prompts.keys())

    def list_by_prefix(self, prefix: str) -> List[str]:
        with self._lock:
            return sorted([n for n in self._prompts.keys() if n.startswith(prefix)])

    def as_dict(self) -> Dict[str, str]:
        with self._lock:
            return dict(self._prompts)


class PromptNamespace:
    """Hierarchical attribute-style access to module prompts.

    Usage:
        from gui_agents.prompts import module
        text = module.evaluator.final_check_role
        text2 = module.manager.planner_role

    Resolution rules:
        - Resolve only against module prompts (under `module/`), ignoring system prompts
        - If an exact module key exists (e.g., "evaluator/final_check_role"), return its string content
        - Else, if there are module children under that path, return a deeper namespace object
        - Else, raise AttributeError
    """

    def __init__(self, registry: PromptRegistry, parts: List[str] = None): #type: ignore
        self._registry = registry
        self._parts = parts or []

    def __getattr__(self, name: str):
        prefix = "/".join(self._parts + [name]) if self._parts else name
        # Exact leaf in module space
        if self._registry.exists_in_module(prefix):
            return self._registry.get(prefix, "")
        # Nested namespace in module space?
        if self._registry.module_children_exist(prefix):
            return PromptNamespace(self._registry, self._parts + [name])
        raise AttributeError(f"No module prompt or namespace '{prefix}'")


# Singleton registry instance for convenient imports
prompt_registry = PromptRegistry()

# Convenience top-level helpers

def get_prompt(name: str, default: str = "") -> str:
    return prompt_registry.get(name, default)


def register_prompt(name: str, content: str) -> None:
    prompt_registry.set(name, content)


def list_prompts() -> List[str]:
    return prompt_registry.all_names()


def list_prompts_by_prefix(prefix: str) -> List[str]:
    return prompt_registry.list_by_prefix(prefix)


def refresh_prompts() -> None:
    prompt_registry.refresh()


# Hierarchical accessor for module prompts
module = PromptNamespace(prompt_registry, []) 