from __future__ import annotations

import pyautogui
from .Backend.Backend import Backend
from .Backend.ADBBackend import ADBBackend
from .Backend.PyAutoGUIBackend import PyAutoGUIBackend
from .Backend.PyAutoGUIVMwareBackend import PyAutoGUIVMwareBackend
"""hardware_interface.py  ▸  Execute Action objects on real devices / emulators
==============================================================================
This module is the *single entry point* that upper‑layer planners / executors
use to perform UI operations.  It is deliberately thin:

*   Accepts one `Action` **or** a `List[Action]` (defined in *actions.py*).
*   Delegates to a concrete *Backend* which knows how to translate the `Action`
    into platform‑specific calls (PyAutoGUI, ADB, Lybic cloud device, …).
*   Performs minimal capability checks + error propagation.

The default backend implemented here is **PyAutoGUIBackend**.  Stubs for
**ADBBackend** and **LybicBackend** show how to extend the system.

--------------------------------------------------------------------------
Quick usage
--------------------------------------------------------------------------
```python
from actions import Click
from hardware_interface import HardwareInterface

hwi = HardwareInterface(backend="pyautogui")

# Single action
hwi.dispatch(Click(xy=(960, 540)))

# Batch
plan = [Click(xy=(100,200)), Click(xy=(300,400))]
hwi.dispatch(plan)

# actionDict
hwi.dispatchDict({"type": "Click", "xy": [200, 300]})

```
"""

from typing import List, Type, Dict, Set, Union, Any

# Import your Action primitives
from .Action import (
    Action,
    Screenshot,
)

__all__ = [
    "HardwareInterface",
    "Backend",
    "PyAutoGUIBackend",
    "ADBBackend",
    "PyAutoGUIVMwareBackend",
]



# ---------------------------------------------------------------------------
# Facade – single entry point
# ---------------------------------------------------------------------------
class HardwareInterface:
    """High‑level facade that routes Action objects to a chosen backend."""

    BACKEND_MAP: Dict[str, Type[Backend]] = {
        "pyautogui": PyAutoGUIBackend,
        "adb": ADBBackend,
        "pyautogui_vmware": PyAutoGUIVMwareBackend,
    }

    # ------------------------------------------------------------------
    def __init__(self, backend: str | Backend = "pyautogui", **backend_kwargs):
        if isinstance(backend, Backend):
            self.backend: Backend = backend
        else:
            key = backend.lower()
            if key not in self.BACKEND_MAP:
                raise ValueError(f"Unsupported backend '{backend}'. Available: {list(self.BACKEND_MAP)}")
            self.backend = self.BACKEND_MAP[key](**backend_kwargs)

    # ------------------------------------------------------------------
    def dispatch(self, actions: Action | List[Action]):
        """Execute one or multiple actions *in order*.

        Args:
            actions: `Action` instance or list thereof.
        """
        if isinstance(actions, Action):
            actions = [actions]

        for act in actions:
            # Special handling for Memorize action, do not pass to backend execution
            if type(act).__name__ == "Memorize":
                continue
            if not self.backend.supports(type(act)):
                raise NotImplementedError(
                    f"{type(act).__name__} is not supported by backend {self.backend.__class__.__name__}"
                )
            if (not isinstance(actions, list)) or (len(actions)==1):
                result = self.backend.execute(act)
                # If a single action returns a value (e.g., Screenshot), propagate it
                return result
            else:
                self.backend.execute(act)
        # For batch execution with no explicit return
        return None

    def dispatchDict(self, actionDict: Union[Dict[str, Any], List[Dict[str, Any]]]):
        """Execute one or multiple actions provided as JSON‑style dict(s).

        Parameters
        ----------
        actionDict : Dict[str, Any] | List[Dict[str, Any]]
            - Dict:  single action, e.g. {"type": "Click", "xy": [100,200], ...}
            - List:  sequence of actions in the above format
        """
        if isinstance(actionDict, list):
            actions = [Action.from_dict(item) for item in actionDict]
        else:
            actions = Action.from_dict(actionDict)

        return self.dispatch(actions)
