# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import inspect
import re
import sys
from abc import ABC, abstractmethod
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from functools import wraps
from logging import getLogger
from pathlib import Path
from typing import Any, Callable, Generator, Generic, Iterable, Optional, TypeVar, Union

__all__ = [
    "optional_import_block",
    "patch_object",
    "require_optional_import",
    "run_for_optional_imports",
    "skip_on_missing_imports",
]

logger = getLogger(__name__)


@dataclass
class ModuleInfo:
    name: str
    min_version: Optional[str] = None
    max_version: Optional[str] = None
    min_inclusive: bool = False
    max_inclusive: bool = False

    def is_in_sys_modules(self) -> Optional[str]:
        """Check if the module is installed and satisfies the version constraints

        Returns:
            None if the module is installed and satisfies the version constraints, otherwise a message indicating the issue.

        """
        if self.name not in sys.modules:
            return f"'{self.name}' is not installed."
        else:
            if hasattr(sys.modules[self.name], "__file__") and sys.modules[self.name].__file__ is not None:
                autogen_path = (Path(__file__).parent).resolve()
                test_path = (Path(__file__).parent.parent / "test").resolve()
                module_path = Path(sys.modules[self.name].__file__).resolve()  # type: ignore[arg-type]

                if str(autogen_path) in str(module_path) or str(test_path) in str(module_path):
                    # The module is in the autogen or test directory
                    # Aka similarly named module in the autogen or test directory
                    return f"'{self.name}' is not installed."

        installed_version = (
            sys.modules[self.name].__version__ if hasattr(sys.modules[self.name], "__version__") else None
        )
        if installed_version is None and (self.min_version or self.max_version):
            return f"'{self.name}' is installed, but the version is not available."

        if self.min_version:
            msg = f"'{self.name}' is installed, but the installed version {installed_version} is too low (required '{self}')."
            if not self.min_inclusive and installed_version == self.min_version:
                return msg
            if self.min_inclusive and installed_version < self.min_version:  # type: ignore[operator]
                return msg

        if self.max_version:
            msg = f"'{self.name}' is installed, but the installed version {installed_version} is too high (required '{self}')."
            if not self.max_inclusive and installed_version == self.max_version:
                return msg
            if self.max_inclusive and installed_version > self.max_version:  # type: ignore[operator]
                return msg

        return None

    def __repr__(self) -> str:
        s = self.name
        if self.min_version:
            s += f">={self.min_version}" if self.min_inclusive else f">{self.min_version}"
        if self.max_version:
            s += f"<={self.max_version}" if self.max_inclusive else f"<{self.max_version}"
        return s

    @classmethod
    def from_str(cls, module_info: str) -> "ModuleInfo":
        """Parse a string to create a ModuleInfo object

        Args:
            module_info (str): A string containing the module name and optional version constraints

        Returns:
            ModuleInfo: A ModuleInfo object with the parsed information

        Raises:
            ValueError: If the module information is invalid
        """

        pattern = re.compile(r"^(?P<name>[a-zA-Z0-9-_]+)(?P<constraint>.*)$")
        match = pattern.match(module_info.strip())

        if not match:
            raise ValueError(f"Invalid package information: {module_info}")

        name = match.group("name")
        constraints = match.group("constraint").strip()
        min_version = max_version = None
        min_inclusive = max_inclusive = False

        if constraints:
            constraint_pattern = re.findall(r"(>=|<=|>|<)([0-9\.]+)?", constraints)

            if not all(version for _, version in constraint_pattern):
                raise ValueError(f"Invalid module information: {module_info}")

            for operator, version in constraint_pattern:
                if operator == ">=":
                    min_version = version
                    min_inclusive = True
                elif operator == "<=":
                    max_version = version
                    max_inclusive = True
                elif operator == ">":
                    min_version = version
                    min_inclusive = False
                elif operator == "<":
                    max_version = version
                    max_inclusive = False
                else:
                    raise ValueError(f"Invalid package information: {module_info}")

        return ModuleInfo(
            name=name,
            min_version=min_version,
            max_version=max_version,
            min_inclusive=min_inclusive,
            max_inclusive=max_inclusive,
        )


class Result:
    def __init__(self) -> None:
        self._failed: Optional[bool] = None

    @property
    def is_successful(self) -> bool:
        if self._failed is None:
            raise ValueError("Result not set")
        return not self._failed


@contextmanager
def optional_import_block() -> Generator[Result, None, None]:
    """Guard a block of code to suppress ImportErrors

    A context manager to temporarily suppress ImportErrors.
    Use this to attempt imports without failing immediately on missing modules.

    Example:
    ```python
    with optional_import_block():
        import some_module
        import some_other_module
    ```
    """
    result = Result()
    try:
        yield result
        result._failed = False
    except ImportError as e:
        # Ignore ImportErrors during this context
        logger.debug(f"Ignoring ImportError: {e}")
        result._failed = True


def get_missing_imports(modules: Union[str, Iterable[str]]) -> dict[str, str]:
    """Get missing modules from a list of module names

    Args:
        modules (Union[str, Iterable[str]]): Module name or list of module names

    Returns:
        List of missing module names
    """
    if isinstance(modules, str):
        modules = [modules]

    module_infos = [ModuleInfo.from_str(module) for module in modules]
    x = {m.name: m.is_in_sys_modules() for m in module_infos}
    return {k: v for k, v in x.items() if v}


T = TypeVar("T")
G = TypeVar("G", bound=Union[Callable[..., Any], type])
F = TypeVar("F", bound=Callable[..., Any])


class PatchObject(ABC, Generic[T]):
    def __init__(self, o: T, missing_modules: dict[str, str], dep_target: str):
        if not self.accept(o):
            raise ValueError(f"Cannot patch object of type {type(o)}")

        self.o = o
        self.missing_modules = missing_modules
        self.dep_target = dep_target

    @classmethod
    @abstractmethod
    def accept(cls, o: Any) -> bool: ...

    @abstractmethod
    def patch(self, except_for: Iterable[str]) -> T: ...

    def get_object_with_metadata(self) -> Any:
        return self.o

    @property
    def msg(self) -> str:
        o = self.get_object_with_metadata()
        plural = len(self.missing_modules) > 1
        fqn = f"{o.__module__}.{o.__name__}" if hasattr(o, "__module__") else o.__name__
        # modules_str = ", ".join([f"'{m}'" for m in self.missing_modules])
        msg = f"{'Modules' if plural else 'A module'} needed for {fqn} {'are' if plural else 'is'} missing:\n"
        for _, status in self.missing_modules.items():
            msg += f" - {status}\n"
        msg += f"Please install {'them' if plural else 'it'} using:\n'pip install ag2[{self.dep_target}]'"
        return msg

    def copy_metadata(self, retval: T) -> None:
        """Copy metadata from original object to patched object

        Args:
            retval: Patched object

        """
        o = self.o
        if hasattr(o, "__doc__"):
            retval.__doc__ = o.__doc__
        if hasattr(o, "__name__"):
            retval.__name__ = o.__name__  # type: ignore[attr-defined]
        if hasattr(o, "__module__"):
            retval.__module__ = o.__module__

    _registry: list[type["PatchObject[Any]"]] = []

    @classmethod
    def register(cls) -> Callable[[type["PatchObject[Any]"]], type["PatchObject[Any]"]]:
        def decorator(subclass: type["PatchObject[Any]"]) -> type["PatchObject[Any]"]:
            cls._registry.append(subclass)
            return subclass

        return decorator

    @classmethod
    def create(
        cls,
        o: T,
        *,
        missing_modules: dict[str, str],
        dep_target: str,
    ) -> Optional["PatchObject[T]"]:
        for subclass in cls._registry:
            if subclass.accept(o):
                return subclass(o, missing_modules, dep_target)
        return None


@PatchObject.register()
class PatchCallable(PatchObject[F]):
    @classmethod
    def accept(cls, o: Any) -> bool:
        return inspect.isfunction(o) or inspect.ismethod(o)

    def patch(self, except_for: Iterable[str]) -> F:
        if self.o.__name__ in except_for:
            return self.o

        f: Callable[..., Any] = self.o

        # @wraps(f.__call__)  # type: ignore[operator]
        @wraps(f)
        def _call(*args: Any, **kwargs: Any) -> Any:
            raise ImportError(self.msg)

        self.copy_metadata(_call)  # type: ignore[arg-type]

        return _call  # type: ignore[return-value]


@PatchObject.register()
class PatchStatic(PatchObject[F]):
    @classmethod
    def accept(cls, o: Any) -> bool:
        # return inspect.ismethoddescriptor(o)
        return isinstance(o, staticmethod)

    def patch(self, except_for: Iterable[str]) -> F:
        if hasattr(self.o, "__name__"):
            name = self.o.__name__
        elif hasattr(self.o, "__func__"):
            name = self.o.__func__.__name__
        else:
            raise ValueError(f"Cannot determine name for object {self.o}")
        if name in except_for:
            return self.o

        f: Callable[..., Any] = self.o.__func__  # type: ignore[attr-defined]

        @wraps(f)
        def _call(*args: Any, **kwargs: Any) -> Any:
            raise ImportError(self.msg)

        self.copy_metadata(_call)  # type: ignore[arg-type]

        return staticmethod(_call)  # type: ignore[return-value]

    def get_object_with_metadata(self) -> Any:
        return self.o.__func__  # type: ignore[attr-defined]


@PatchObject.register()
class PatchInit(PatchObject[F]):
    @classmethod
    def accept(cls, o: Any) -> bool:
        return inspect.ismethoddescriptor(o) and o.__name__ == "__init__"

    def patch(self, except_for: Iterable[str]) -> F:
        if self.o.__name__ in except_for:
            return self.o

        f: Callable[..., Any] = self.o

        @wraps(f)
        def _call(*args: Any, **kwargs: Any) -> Any:
            raise ImportError(self.msg)

        self.copy_metadata(_call)  # type: ignore[arg-type]

        return staticmethod(_call)  # type: ignore[return-value]

    def get_object_with_metadata(self) -> Any:
        return self.o


@PatchObject.register()
class PatchProperty(PatchObject[Any]):
    @classmethod
    def accept(cls, o: Any) -> bool:
        return inspect.isdatadescriptor(o) and hasattr(o, "fget")

    def patch(self, except_for: Iterable[str]) -> property:
        if not hasattr(self.o, "fget"):
            raise ValueError(f"Cannot patch property without getter: {self.o}")
        f: Callable[..., Any] = self.o.fget

        if f.__name__ in except_for:
            return self.o  # type: ignore[no-any-return]

        @wraps(f)
        def _call(*args: Any, **kwargs: Any) -> Any:
            raise ImportError(self.msg)

        self.copy_metadata(_call)

        return property(_call)

    def get_object_with_metadata(self) -> Any:
        return self.o.fget


@PatchObject.register()
class PatchClass(PatchObject[type[Any]]):
    @classmethod
    def accept(cls, o: Any) -> bool:
        return inspect.isclass(o)

    def patch(self, except_for: Iterable[str]) -> type[Any]:
        if self.o.__name__ in except_for:
            return self.o

        for name, member in inspect.getmembers(self.o):
            # Patch __init__ method if possible, but not other internal methods
            if name.startswith("__") and name != "__init__":
                continue
            patched = patch_object(
                member,
                missing_modules=self.missing_modules,
                dep_target=self.dep_target,
                fail_if_not_patchable=False,
                except_for=except_for,
            )
            with suppress(AttributeError):
                setattr(self.o, name, patched)

        return self.o


def patch_object(
    o: T,
    *,
    missing_modules: dict[str, str],
    dep_target: str,
    fail_if_not_patchable: bool = True,
    except_for: Optional[Union[str, Iterable[str]]] = None,
) -> T:
    patcher = PatchObject.create(o, missing_modules=missing_modules, dep_target=dep_target)
    if fail_if_not_patchable and patcher is None:
        raise ValueError(f"Cannot patch object of type {type(o)}")

    except_for = except_for if except_for is not None else []
    except_for = [except_for] if isinstance(except_for, str) else except_for

    return patcher.patch(except_for=except_for) if patcher else o


def require_optional_import(
    modules: Union[str, Iterable[str]],
    dep_target: str,
    *,
    except_for: Optional[Union[str, Iterable[str]]] = None,
) -> Callable[[T], T]:
    """Decorator to handle optional module dependencies

    Args:
        modules: Module name or list of module names required
        dep_target: Target name for pip installation (e.g. 'test' in pip install ag2[test])
        except_for: Name or list of names of objects to exclude from patching
    """
    missing_modules = get_missing_imports(modules)

    if not missing_modules:

        def decorator(o: T) -> T:
            return o

    else:

        def decorator(o: T) -> T:
            return patch_object(o, missing_modules=missing_modules, dep_target=dep_target, except_for=except_for)

    return decorator


def _mark_object(o: T, dep_target: str) -> T:
    import pytest

    markname = dep_target.replace("-", "_")
    pytest_mark_markname = getattr(pytest.mark, markname)
    pytest_mark_o = pytest_mark_markname(o)

    pytest_mark_o = pytest.mark.aux_neg_flag(pytest_mark_o)

    return pytest_mark_o  # type: ignore[no-any-return]


def run_for_optional_imports(modules: Union[str, Iterable[str]], dep_target: str) -> Callable[[G], G]:
    """Decorator to run a test if and only if optional modules are installed

    Args:
        modules: Module name or list of module names
        dep_target: Target name for pip installation (e.g. 'test' in pip install ag2[test])
    """
    # missing_modules = get_missing_imports(modules)
    # if missing_modules:
    #     raise ImportError(f"Missing module{'s' if len(missing_modules) > 1 else ''}: {', '.join(missing_modules)}. Install using 'pip install ag2[{dep_target}]'")

    def decorator(o: G) -> G:
        missing_modules = get_missing_imports(modules)

        if isinstance(o, type):
            wrapped = require_optional_import(modules, dep_target)(o)
        else:
            if inspect.iscoroutinefunction(o):

                @wraps(o)
                async def wrapped(*args: Any, **kwargs: Any) -> Any:
                    if missing_modules:
                        raise ImportError(
                            f"Missing module{'s' if len(missing_modules) > 1 else ''}: {', '.join(missing_modules)}. Install using 'pip install ag2[{dep_target}]'"
                        )
                    return await o(*args, **kwargs)

            else:

                @wraps(o)
                def wrapped(*args: Any, **kwargs: Any) -> Any:
                    if missing_modules:
                        raise ImportError(
                            f"Missing module{'s' if len(missing_modules) > 1 else ''}: {', '.join(missing_modules)}. Install using 'pip install ag2[{dep_target}]'"
                        )
                    return o(*args, **kwargs)

        pytest_mark_o: G = _mark_object(wrapped, dep_target)  # type: ignore[assignment]

        return pytest_mark_o

    return decorator


def skip_on_missing_imports(modules: Union[str, Iterable[str]], dep_target: str) -> Callable[[T], T]:
    """Decorator to skip a test if an optional module is missing

    Args:
        modules: Module name or list of module names
        dep_target: Target name for pip installation (e.g. 'test' in pip install ag2[test])
    """
    import pytest

    missing_modules = get_missing_imports(modules)

    if not missing_modules:

        def decorator(o: T) -> T:
            pytest_mark_o = _mark_object(o, dep_target)
            return pytest_mark_o  # type: ignore[no-any-return]

    else:

        def decorator(o: T) -> T:
            pytest_mark_o = _mark_object(o, dep_target)

            return pytest.mark.skip(  # type: ignore[return-value,no-any-return]
                f"Missing module{'s' if len(missing_modules) > 1 else ''}: {', '.join(missing_modules)}. Install using 'pip install ag2[{dep_target}]'"
            )(pytest_mark_o)

    return decorator
