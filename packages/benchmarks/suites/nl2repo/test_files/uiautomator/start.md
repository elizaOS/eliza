## Introduction and Goals of the uiautomator Project

uiautomator is a Python library **for Android automated testing** that can connect to Android devices via ADB and perform UI automation operations. Based on the Android native UiAutomator framework, this tool supports Android 4.1+ (API Level 16 - 30) devices without requiring any additional components to be installed on the Android device. Its core functions include: device connection management (establishing a connection with an Android device via ADB), **UI element location and operation** (supporting multiple selectors such as text, ID, and class name), gesture simulation (clicking, swiping, dragging, etc.), screen control (taking screenshots, rotating the screen, adjusting brightness), and an intelligent waiting mechanism. In short, uiautomator aims to provide a simple and efficient Android UI automated testing solution, enabling developers to easily write Android application test scripts across devices.

## Natural Language Instructions (Prompt)

Please create a Python project named uiautomator to implement an Android UI automated testing library. The project should include the following functions:

1. **Device Connection Management**: Establish a connection with Android devices via ADB, supporting multi - device management and remote device connection. Provide functions such as specifying device serial numbers and configuring the ADB server to ensure stable device communication.

2. **UI Element Location System**: Implement a powerful UI element selector, supporting multiple location methods such as text matching, resource ID, class name, and description. Support hierarchical relationship queries (parent - child, sibling elements), relative position location, and element existence checks.

3. **Gesture Operation Simulation**: Provide a complete set of touch operation APIs, including single - click, long - click, swipe, drag, multi - touch, etc. Support precise coordinate operations and element - based operations, as well as chained gesture calls.

4. **Device Control Functions**: Implement basic device control, including screen on/off, key simulation, orientation control, and screenshot functions. Support system - level functions such as device information acquisition, application package management, and notification bar operations.

5. **Intelligent Waiting Mechanism**: Provide functions such as element waiting, interface update waiting, and idle waiting to ensure the stability of test scripts. Support timeout settings, conditional waiting, and custom waiting strategies.

6. **Testing Auxiliary Functions**: Include window hierarchy export, element information acquisition, test report generation, etc. Provide debugging tools and error handling mechanisms to facilitate problem location and script maintenance.

7. **Core File Requirements**: The project must include a complete setup.py file, which should configure the project as a standard Python package that can be installed via pip install. Declare a complete list of dependencies, including core libraries such as urllib3>=1.7.1 (for network request support), mock>=1.0.1 (for test simulation), nose>=1.0 (test framework), coverage>=3.6 (code coverage analysis), etc., to ensure the normal dependencies of functions such as device communication, RPC calls, and test verification. The setup.py file should verify the validity of all functional modules (such as device connection, UI element location, operation execution, error handling, etc.) through configuration, support triggering full - function verification via test commands, covering core scenarios such as device connection, element selection, and event triggering. At the same time, provide uiautomator/__init__.py as a unified API entry. This file should integrate key components from the core modules: import AutomatorDevice (the core class for device operations, exported as Device externally), Adb (ADB utility class), and AutomatorServer (automated testing server) from the device communication module; import Selector (UI element selector) from the selector module; import JsonRPCClient (JSON - RPC client), JsonRPCMethod (RPC method decorator), and JsonRPCError (RPC error class) from the RPC communication module; import AutomatorDeviceObject (base class for device objects) and AutomatorDeviceNamedUiObject (named UI element object) from the object - element interaction module; import param_to_property (tool for converting parameters to properties) from the utility module; in addition, define the device instance (the default instance of AutomatorDevice) and provide version information via __version__, ensuring that users can access all major functions through a simple `from uiautomator import *` statement, supporting both element operations such as d(text="OK").click() and device control such as d.screen.on(), simplifying the entire process from device connection to UI interaction.

## Environment Configuration

### Python Version
The Python version used in the current project is: Python 3.12.4

### Core Dependency Library Versions

```Plain
coverage     7.10.6
distlib      0.4.0
filelock     3.19.1
iniconfig    2.1.0
mock         5.2.0
nose         1.3.7
packaging    25.0
pip          24.0
platformdirs 4.4.0
pluggy       1.6.0
py           1.11.0
Pygments     2.19.2
pytest       8.4.1
setuptools   72.1.0
tox          1.6.0
urllib3      2.5.0
virtualenv   20.34.0
wheel        0.43.0
```

## uiautomator Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .DS_Store     
├── .README.md.swp
├── .gitignore    
├── .travis.yml   
├── LICENSE       
├── MANIFEST.in   
├── NOTICE        
├── README.md
├── docs
│   ├── img
│   │   └── settings.png
├── setup.cfg
├── setup.py
└── uiautomator
    ├── __init__.py
    └── libs
        ├── app-uiautomator-androidx.apk
        ├── app-uiautomator-test-androidx.apk
        ├── app-uiautomator-test.apk
        ├── app-uiautomator.apk
        ├── bundle.jar
        └── uiautomator-stub.jar

```

## API Usage Guide

### Core API

#### 1. Module Import

```python
from uiautomator import Adb
from uiautomator import AutomatorDeviceObject, Selector, AutomatorDeviceNamedUiObject
from uiautomator import AutomatorDevice
from uiautomator import JsonRPCMethod, JsonRPCClient
from uiautomator import rect, point, _init_local_port, next_local_port
from uiautomator import param_to_property
from uiautomator import AutomatorServer, JsonRPCError
from uiautomator import NotFoundHandler, AutomatorDeviceUiObject, U ,intersect
from uiautomator import DEVICE_PORT, LOCAL_PORT
from uiautomator import device as d
```

#### 2. Module-Level Variables and Constants

##### Environment Variables
- `UIAUTOMATOR_DEVICE_PORT`: Device port, default 9008
- `UIAUTOMATOR_LOCAL_PORT`: Local port, default 9008
- `no_proxy`: Proxy settings
- `jsonrpc_timeout`: JSONRPC timeout, default 90 seconds
- `JSONRPC_TIMEOUT`: JSONRPC timeout, default 90 seconds

##### Global Variables
- `DEVICE_PORT`: Device port number
- `LOCAL_PORT`: Local port number
- `_init_local_port`: Initial local port

##### Exports
```python
__all__ = ["device", "Device", "rect", "point", "Selector", "JsonRPCError"]
```

#### 3. Utility Functions

##### `U(x)`
**Function Description**: String encoding compatibility handling (Python 2/3)
**Parameters**:
- `x`: Input string
**Return Value**: Uniformly encoded string

##### `param_to_property(*props, **kwprops)`
**Function Description**: Decorator for parameter to property conversion
**Parameters**:
- `*props`: Positional argument properties
- `**kwprops`: Keyword argument properties
**Return Value**: Wrapper class

**Internal Class** `Wrapper`:
- `__init__(self, func)`: Initialization
- `__getattr__(self, attr)`: Attribute getter
- `__call__(self, *args, **kwargs)`: Call execution

##### `rect(top=0, left=0, bottom=100, right=100)`
**Function Description**: Create a rectangular area
**Parameters**: Four boundary coordinates
**Return Value**: Rectangle dictionary

##### `intersect(rect1, rect2)`
**Function Description**: Calculate the intersection of two rectangles
**Parameters**: Two rectangle dictionaries
**Return Value**: Intersection boundary tuple (left, top, right, bottom)

##### `point(x=0, y=0)`
**Function Description**: Create a coordinate point
**Parameters**: x, y coordinates
**Return Value**: Coordinate point dictionary

##### `next_local_port(adbHost=None)`
**Function Description**: Get the next available local port
**Parameter**: adb host address
**Return Value**: Available port number

**Internal Function**:
- `is_port_listening(port)`: Check if the specified port is listening
  - **Parameter**: `port` - The port number to check
  - **Return Value**: `bool` - Returns True if the port is occupied, otherwise False

**Global Variables**:
- `_init_local_port`: Initial port number, starting from `LOCAL_PORT - 1`

**Algorithm Logic**:
1. Start from `_init_local_port` and increment to find an available port
2. Port number range is limited within 32764, reset to `LOCAL_PORT` if exceeded
3. Use `socket.connect_ex()` method to detect port occupancy
4. Return the first unoccupied port number

#### 4. Core Classes

##### `JsonRPCError` Exception Class
**Inheritance**: `Exception`
**Function Description**: JSONRPC error exception

**Methods**:
- `__init__(self, code, message)`: Initialize error information
- `__str__(self)`: Return error string representation

##### `JsonRPCMethod` Class
**Function Description**: JSONRPC method call encapsulation

**Methods**:
- `__init__(self, url, method, timeout=30)`: Initialize method
- `__call__(self, *args, **kwargs)`: Execute RPC call
- `id(self)`: Generate request ID

##### `JsonRPCClient` Class
**Function Description**: JSONRPC client

**Methods**:
- `__init__(self, url, timeout=30, method_class=JsonRPCMethod)`: Initialize client
- `__getattr__(self, method)`: Dynamically get method

##### `Selector` Class
**Inheritance**: `dict`
**Function Description**: UI selector, constructs UiSelector parameters passed to the Android device

**Internal Fields**:
- `mask`: Field mask
- `childOrSibling`: Child or sibling relationship
- `childOrSiblingSelector`: Child or sibling selector

**Field Masks**:
- `text` (0x01), `textContains` (0x02), `textMatches` (0x04), `textStartsWith` (0x08)
- `className` (0x10), `classNameMatches` (0x20)
- `description` (0x40), `descriptionContains` (0x80), `descriptionMatches` (0x0100), `descriptionStartsWith` (0x0200)
- `checkable` (0x0400), `checked` (0x0800), `clickable` (0x1000), `longClickable` (0x2000), `scrollable` (0x4000)
- `enabled` (0x8000), `focusable` (0x010000), `focused` (0x020000), `selected` (0x040000)
- `packageName` (0x080000), `packageNameMatches` (0x100000)
- `resourceId` (0x200000), `resourceIdMatches` (0x400000)
- `index` (0x800000), `instance` (0x01000000)

**Methods**:
- `__init__(self, **kwargs)`: Initialize selector
- `__setitem__(self, k, v)`: Set selector field
- `__delitem__(self, k)`: Delete selector field
- `clone(self)`: Clone selector
- `child(self, **kwargs)`: Add child selector
- `sibling(self, **kwargs)`: Add sibling selector
- `child_selector`, `from_parent`: Aliases for child and sibling

##### `Adb` Class
**Function Description**: ADB command encapsulation

**Properties**:
- `__adb_cmd`: ADB command path
- `default_serial`: Default device serial number
- `adb_server_host`: ADB server host
- `adb_server_port`: ADB server port
- `adbHostPortOptions`: ADB host port options

**Methods**:
- `__init__(self, serial=None, adb_server_host=None, adb_server_port=None)`: Initialize
- `adb(self)`: Get adb command path
- `cmd(self, *args, **kwargs)`: Execute adb command with serial number
- `raw_cmd(self, *args)`: Execute raw adb command
- `device_serial(self)`: Get device serial number
- `devices(self)`: Get connected devices list
- `forward(self, local_port, device_port)`: Port forwarding
- `forward_list(self)`: Get forwarding list
- `version(self)`: Get adb version

##### `NotFoundHandler` Class
**Function Description**: UI object not found exception handler

**Properties**:
- `__handlers`: Handler dictionary

**Methods**:
- `__init__(self)`: Initialize handler
- `__get__(self, instance, type)`: Descriptor getter


##### `AutomatorServer` Class
**Function Description**: Start and stop RPC server on the device

**Class Variables**:
- `__jar_files`: JAR file mapping
- `__apk_files`: APK file list
- `__androidx_apk_files`: AndroidX APK file list
- `__sdk`: SDK version
- `handlers`: NotFoundHandler instance

**Properties**:
- `uiautomator_process`: uiautomator process
- `adb`: Adb instance
- `device_port`: Device port
- `local_port`: Local port

**Methods**:
- `__init__(self, serial=None, local_port=None, device_port=None, adb_server_host=None, adb_server_port=None)`: Initialize
- `push(self)`: Push files to device
- `install(self)`: Install APK
- `install_androidx(self)`: Install AndroidX APK
- `jsonrpc`: JSONRPC client property (decorated with `@property`)
- `jsonrpc_wrap(self, timeout)`: Wrap JSONRPC client
- `__jsonrpc(self)`: Internal JSONRPC client method
- `sdk_version(self)`: Get SDK version
- `start(self, timeout=5)`: Start server
- `ping(self)`: Check server status
- `alive`: Server alive status property (decorated with `@property`)
- `stop(self)`: Stop server
- `stop_uri`: Stop URI property (decorated with `@property`)
- `rpc_uri`: RPC URI property (decorated with `@property`)
- `screenshot_uri`: Screenshot URI property (decorated with `@property`)
- `screenshot(self, filename=None, scale=1.0, quality=100)`: Take screenshot


##### `AutomatorDevice` Class (Alias `Device` instance object: `device = AutomatorDevice()`)
**Function Description**: uiautomator wrapper for Android device

**Direction Constants __orientation**:
- `(0, "natural", "n", 0)`: Natural orientation
- `(1, "left", "l", 90)`: Rotate left 90 degrees
- `(2, "upsidedown", "u", 180)`: Upside down 180 degrees
- `(3, "right", "r", 270)`: Rotate right 270 degrees

**Property Aliases __alias**:
- `width` → `displayWidth`
- `height` → `displayHeight`

**Methods**:
- `__init__(self, serial=None, local_port=None, adb_server_host=None, adb_server_port=None)`: Initialize
- `__call__(self, **kwargs)`: Create device object
- `__getattr__(self, attr)`: Get info property alias
- `info`: Device information property (decorated with `@property`)
- `click(self, x, y)`: Click coordinates
- `long_click(self, x, y)`: Long press coordinates
- `swipe(self, sx, sy, ex, ey, steps=100)`: Swipe
- `swipePoints(self, points, steps=100)`: Multi-point swipe
- `drag(self, sx, sy, ex, ey, steps=100)`: Drag
- `dump(self, filename=None, compressed=True, pretty=True)`: Dump window hierarchy
- `screenshot(self, filename, scale=1.0, quality=100)`: Screenshot
- `freeze_rotation(self, freeze=True)`: Freeze rotation
- `orientation`: Device orientation property (getter/setter, decorated with `@property` and `@orientation.setter`)
- `last_traversed_text`: Last traversed text property (decorated with `@property`)
- `clear_traversed_text(self)`: Clear traversed text
- `open`: Open notification or quick settings property (decorated with `@property`, internal methods decorated with `@param_to_property(action=["notification", "quick_settings"])`)
  - `notification()`: Open notification panel
  - `quick_settings()`: Open quick settings panel
- `handlers`: Handler management property (decorated with `@property`)
- `watchers`: Watcher list property (decorated with `@property`)
- `watcher(self, name)`: Create watcher
- `press`: Key press operation property (decorated with `@property`, internal methods decorated with `@param_to_property`)
- `wakeup(self)`: Wake up device
- `sleep(self)`: Put device to sleep
- `screen`: Screen control property (decorated with `@property`)
- `wait`: Wait operation property (decorated with `@property`, internal methods decorated with `@param_to_property`)
- `exists(self, **kwargs)`: Check if UI object exists


##### `AutomatorDeviceUiObject` Class
**Function Description**: Represents a UI object, can perform actions like clicking, setting text, etc.

**Property Aliases __alias**:
- `description` → `contentDescription`

**Methods**:
- `__init__(self, device, selector)`: Initialize
- `__getattr__(self, attr)`: Get info property alias
- `exists`: Object existence property (decorated with `@property`)
- `info`: Object information property (decorated with `@property`)
- `set_text(self, text)`: Set text
- `clear_text(self)`: Clear text
- `click`: Click operation property (decorated with `@property`, returns function decorated with `@param_to_property(action=["tl", "topleft", "br", "bottomright", "wait"])`)
- `long_click`: Long click operation property (decorated with `@property`, returns function decorated with `@param_to_property(corner=["tl", "topleft", "br", "bottomright"])`)
- `drag`: Drag operation property (decorated with `@property`)
- `gesture(self, start1, start2, *args, **kwargs)`: Two-point gesture
- `gestureM(self, start1, start2, start3, *args, **kwargs)`: Three-point gesture
- `pinch`: Pinch gesture property (decorated with `@property`, returns function decorated with `@param_to_property(in_or_out=["In", "Out"])`)
- `swipe`: Swipe gesture property (decorated with `@property`, returns function decorated with `@param_to_property(direction=["up", "down", "right", "left"])`)
- `wait`: Wait operation property (decorated with `@property`, returns function decorated with `@param_to_property(action=["exists", "gone"])`)

##### `AutomatorDeviceNamedUiObject` Class
**Inheritance**: `AutomatorDeviceUiObject`
**Function Description**: Named UI object

**Methods**:
- `__init__(self, device, name)`: Initialize
- `child(self, **kwargs)`: Get child object
- `sibling(self, **kwargs)`: Get sibling object

##### `AutomatorDeviceObject` Class
**Inheritance**: `AutomatorDeviceUiObject`
**Function Description**: Generic UI object/UiScrollable/UiCollection

**Methods**:
- `__init__(self, device, selector)`: Initialize
- `child(self, **kwargs)`: Set child selector
- `sibling(self, **kwargs)`: Set parent selector
- `child_selector`, `from_parent`: Aliases for child and sibling
- `child_by_text(self, txt, **kwargs)`: Get child object by text
- `child_by_description(self, txt, **kwargs)`: Get child object by description
- `child_by_instance(self, inst, **kwargs)`: Get child object by instance
- `count`: Object count property
- `__len__(self)`: Number of objects
- `__getitem__(self, index)`: Index access
- `__iter__(self)`: Iterator
- `right(self, **kwargs)`: Get right object
- `left(self, **kwargs)`: Get left object
- `up(self, **kwargs)`: Get top object
- `down(self, **kwargs)`: Get bottom object
- `fling`: Fling property
- `scroll`: Scroll property
#### 5. Internal Classes and Helper Classes

##### `Wrapper` Class (inside `param_to_property`)
**Function Description**: Parameter to property wrapper

**Properties**:
- `func`: Wrapped function
- `kwargs`: Keyword arguments
- `args`: Positional arguments

**Methods**:
- `__init__(self, func)`: Initialize
- `__getattr__(self, attr)`: Get attribute
- `__call__(self, *args, **kwargs)`: Call function

##### `_Screen` Class (inside `AutomatorDevice.screen`)
**Function Description**: Internal class for screen control

**Methods**:
- `on(self)`: Turn screen on
- `off(self)`: Turn screen off
- `__call__(self, action)`: Execute screen operation
- `__eq__(self, value)`: Equality comparison
- `__ne__(self, value)`: Inequality comparison

##### `Handlers` Class (inside `AutomatorDevice.handlers`)
**Function Description**: Internal class for handler management

**Methods**:
- `on(self, fn)`: Register handler
- `off(self, fn)`: Unregister handler

##### `Watchers` Class (inside `AutomatorDevice.watchers`)
**Inheritance**: `list`
**Function Description**: Internal class for watcher list

**Properties**:
- `triggered`: Whether watcher is triggered

**Methods**:
- `remove(self, name=None)`: Remove watcher
- `reset(self)`: Reset watcher trigger
- `run(self)`: Run watcher

##### `Watcher` Class (inside `AutomatorDevice.watcher`)
**Function Description**: Internal class for watcher

**Properties**:
- `__selectors`: Selector list
- `triggered`: Whether triggered

**Methods**:
- `__init__(self)`: Initialize
- `remove(self)`: Remove watcher
- `when(self, **kwargs)`: Set trigger condition
- `click(self, **kwargs)`: Set click action
- `press`: Key press action property


##### `Iter` Class (inside `AutomatorDeviceObject.__iter__`)
**Function Description**: Internal class for iterator

**Properties**:
- `index`: Current index

**Methods**:
- `__init__(self)`: Initialize
- `next(self)`: Next element (Python 2)
- `__next__(self)`: Next element (Python 3)

#### 6. Decorator Usage

##### `param_to_property` Decorator Usage Examples

```python
# Usage in AutomatorDevice class
@param_to_property(action=["notification", "quick_settings"])
def _open(action):
    # Open notification or quick settings
    pass

# Usage in AutomatorDeviceUiObject class  
@param_to_property(action=["tl", "topleft", "br", "bottomright", "wait"])
def _click(action=None, timeout=3000):
    # Click operation
    pass

# Key operations in AutomatorDevice class
@param_to_property(
    key=["home", "back", "left", "right", "up", "down", "center",
         "menu", "search", "enter", "delete", "del", "recent",
         "volume_up", "volume_down", "volume_mute", "camera", "power"]
)
def _press(key, meta=None):
    # Key press operation
    pass
```

#### 7. Global Device Instance

##### `device`
**Function Description**: Global AutomatorDevice instance
**Usage**: 
```python
device.click(100, 200)
device(text="App").click()
```


#### 8. Usage Examples

##### Basic Operations
```python
# Click coordinates
device.click(100, 200)

# Find and click element
device(text="Settings").click()

# Swipe
device.swipe(100, 100, 200, 200)

# Screenshot
device.screenshot("screen.png")
```

##### Selector Usage
```python
# Multiple selection conditions
selector = Selector(text="OK", className="android.widget.Button")
selector.child(text="Cancel")

# Chain calls
device.child(text="Parent").child(text="Child").click()
```

##### Waiting and Existence Checks
```python
# Wait for element to appear
device(text="Loading").wait.exists(timeout=5000)

# Check if element exists
if device(text="Dialog").exists:
    device(text="OK").click()
```

## Detailed Function Implementation Nodes

### Node 1: Device Information Retrieval

**Function Description**: Get the basic information of an Android device, including screen size, orientation, current application package name, and other device status information.

**Core Algorithm**:
- Obtain device information through a JSON - RPC call.
- Parse the device information dictionary.
- Provide a device status query interface.

**Input - Output Example**:

```python
from uiautomator import *

# Get device information
device_info = device.info
print(device_info)
# Output example:
# {
#   'displayRotation': 0,
#   'displaySizeDpY': 640,
#   'displaySizeDpX': 360,
#   'currentPackageName': 'com.android.launcher',
#   'productName': 'takju',
#   'displayWidth': 720,
#   'sdkInt': 18,
#   'displayHeight': 1184,
#   'naturalOrientation': True
# }

# Get screen size
width = device_info['displayWidth']  # 720
height = device_info['displayHeight']  # 1184

# Get the current application package name
current_app = device_info['currentPackageName']  # 'com.android.launcher'

# Get the Android SDK version
sdk_version = device_info['sdkInt']  # 18
```

**Parameters / Returns**:
- info -> dict: Read-only property (no parameters); returns device information dictionary with keys:
  - displayRotation: int (0/1/2/3)
  - displaySizeDpY: int
  - displaySizeDpX: int
  - currentPackageName: str
  - productName: str
  - displayWidth: int
  - displayHeight: int
  - sdkInt: int
  - naturalOrientation: bool
- __getattr__(attr: str) -> Any: Provides aliased access to info fields; supports 'width' (alias for displayWidth), 'height' (alias for displayHeight)

### Node 2: Basic Gesture Operations

**Function Description**: Provide basic touch and gesture operations, including click, long - click, swipe, drag, and other basic interaction functions.

**Supported Operation Types**:
- Single - point click: `click(x, y)`
- Long - click operation: `long_click(x, y)`
- Swipe operation: `swipe(sx, sy, ex, ey, steps)`
- Drag operation: `drag(sx, sy, ex, ey, steps)`

**Input - Output Example**:

```python
from uiautomator import *

# Single - point click
device.click(100, 200)  # Click at coordinates (100, 200)

# Long - click operation
device.long_click(150, 250)  # Long - click at coordinates (150, 250)

# Swipe operation
device.swipe(100, 200, 300, 400, steps=50)  # Swipe from (100,200) to (300,400) in 50 steps

# Drag operation
device.drag(100, 200, 300, 400, steps=100)  # Drag from (100,200) to (300,400) in 100 steps

# Multi - point swipe
points = [(100, 200), (150, 250), (200, 300)]
device.swipePoints(points, steps=50)  # Swipe along the path points
```

**Parameters / Returns**:
- click(x: int, y: int) -> bool: Click at coordinates (x, y)
- long_click(x: int, y: int) -> bool: Long click at coordinates; internally calls swipe(x, y, x+1, y+1)
- swipe(sx: int, sy: int, ex: int, ey: int, steps: int=100) -> bool: Swipe from start to end coordinates
- swipePoints(points: list[tuple], steps: int=100) -> bool: Multi-point swipe along path; points format: [(x1,y1), (x2,y2), ...]
- drag(sx: int, sy: int, ex: int, ey: int, steps: int=100) -> bool: Drag from start to end coordinates

### Node 3: Screen Control Operations

**Function Description**: Control the on/off state of the device screen, including wake - up, sleep, screen orientation control, and other functions.

**Supported Operations**:
- Screen wake - up: `wakeup()`
- Screen sleep: `sleep()`
- Screen on/off: `screen.on()`, `screen.off()`
- Screen status check: `screen == "on"` or `screen == "off"`
- Screen orientation control: `orientation` attribute setting

**Input - Output Example**:

```python
from uiautomator import *

# Wake up the device
device.wakeup()

# Put the device to sleep
device.sleep()

# Turn on the screen
device.screen.on()

# Turn off the screen
device.screen.off()

# Check screen status
if device.screen == "on":
    print("The screen is on")
elif device.screen == "off":
    print("The screen is off")

# Set the screen orientation
device.orientation = "l"  # Rotate 90 degrees to the left
device.orientation = "r"  # Rotate 90 degrees to the right
device.orientation = "n"  # Natural orientation

# Freeze screen rotation
device.freeze_rotation()  # Freeze
device.freeze_rotation(False)  # Unfreeze
```

**Parameters / Returns**:
- wakeup() -> None: Turn on screen (no return value)
- sleep() -> None: Turn off screen (no return value)
- screen.on() -> None: Same as wakeup()
- screen.off() -> None: Same as sleep()
- screen.__eq__(value: str) -> bool: Check screen status; value must be "on"/"off" (case insensitive)
- orientation -> str: Get current orientation ("natural", "left", "right", "upsidedown")
- orientation.setter(value: str) -> None: Set orientation; accepts "n"/"natural", "l"/"left", "r"/"right", "u"/"upsidedown"
- freeze_rotation(freeze: bool=True) -> None: Freeze/unfreeze rotation

### Node 4: Key Press Operations

**Function Description**: Simulate the physical and soft key operations of an Android device, including system keys such as Home, Back, and volume.

**Supported Key Types**:
- System keys: `home`, `back`, `menu`, `search`
- Direction keys: `up`, `down`, `left`, `right`, `center`
- Function keys: `enter`, `delete`, `recent`
- Volume keys: `volume_up`, `volume_down`, `volume_mute`
- Other keys: `camera`, `power`

**Input - Output Example**:

```python
from uiautomator import *

# Press the Home key
device.press.home()

# Press the Back key
device.press.back()

# Press the Menu key
device.press.menu()

# Press the Search key
device.press.search()

# Press direction keys
device.press.up()
device.press.down()
device.press.left()
device.press.right()
device.press.center()

# Press function keys
device.press.enter()
device.press.delete()

# Press volume keys
device.press.volume_up()
device.press.volume_down()
device.press.volume_mute()

# Combination keys
device.press(0x07, 0x02)  # Press the number key '0' while holding the ALT key

# Key press in string form
device.press("back")
device.press("home")
```

**Parameters / Returns**:
- press(key: str|int, meta: int=None) -> bool: Press key by name or keycode
  - key: Key name ("home", "back", "left", "right", "up", "down", "center", "menu", "search", "enter", "delete"/"del", "recent", "volume_up", "volume_down", "volume_mute", "camera", "power") or keycode (int)
  - meta: Optional meta key code for combination keys
- press.home() / press.back() / press.menu() etc. -> bool: Property-style key presses for convenience

### Node 5: UI Element Selector

**Function Description**: Provide a powerful UI element location and selection function, supporting multiple selection strategies and attribute matching.

**Selector Field Types**:
- Text - related: `text`, `textContains`, `textMatches`, `textStartsWith`
- Class name - related: `className`, `classNameMatches`
- Description - related: `description`, `descriptionContains`, `descriptionMatches`, `descriptionStartsWith`
- State - related: `checkable`, `checked`, `clickable`, `longClickable`, `scrollable`, `enabled`, `focusable`, `focused`, `selected`
- Package name - related: `packageName`, `packageNameMatches`
- Resource ID - related: `resourceId`, `resourceIdMatches`
- Position - related: `index`, `instance`

**Input - Output Example**:

```python
from uiautomator import *

# Basic selectors
device(text="Settings")  # Select by text
device(className="android.widget.Button")  # Select by class name
device(resourceId="com.android.settings:id/title")  # Select by resource ID

# Compound selectors
device(text="Wi-Fi", className="android.widget.TextView", clickable=True)

# Text matching
device(textContains="Wi")  # Text containing "Wi"
device(textMatches=".*Fi.*")  # Regular expression matching
device(textStartsWith="Wi")  # Text starting with "Wi"

# State selection
device(clickable=True)  # Clickable elements
device(enabled=True)  # Enabled elements
device(checked=True)  # Selected elements

# Index selection
device(text="Button", instance=0)  # The first matching button
device(text="Button", instance=1)  # The second matching button

# Selector operations
selector = device(text="Settings")
selector.exists  # Check if the element exists
selector.info  # Get element information
selector.click()  # Click the element
```

**Parameters / Returns**:
- __init__(**kwargs): Create Selector instance with field filters
- All supported fields (e.g., text, textContains, resourceId, className, description, clickable, enabled, instance, index, etc.) are accepted as keyword arguments.
- clone() -> Selector: Returns a deep-copied selector.
- child(**kwargs) -> Selector: Returns a selector with child relationship.
- sibling(**kwargs) -> Selector: Returns a selector with fromParent (sibling) relationship.

**Field Types Reference**:
- text/textStartsWith/textContains: str
- textMatches/classNameMatches/packageNameMatches/descriptionMatches: regex string
- className/packageName/description/descriptionStartsWith/descriptionContains: str
- clickable/longClickable/scrollable/enabled/focusable/focused/selected/checkable/checked: bool
- index/instance: int

**Advanced Features**:
- child_selector: Alias for child() method
- from_parent: Alias for sibling() method
- Inherits from dict: Can use dictionary methods for inspection
- Raises ReferenceError: When attempting to set invalid field names

**Usage Note**: Selector objects are immutable after creation for child/sibling relationships. Use clone() to create independent copies.


### Node 6: UI Element Hierarchy

**Function Description**: Support the location of parent - child and sibling relationships of UI elements, enabling complex UI structure navigation.

**Supported Hierarchical Operations**:
- Child element selection: `child()`
- Sibling element selection: `sibling()`
- Text child element: `child_by_text()`
- Description child element: `child_by_description()`
- Instance child element: `child_by_instance()`
- Relative position: `left()`, `right()`, `up()`, `down()`

**Input - Output Example**:

```python
from uiautomator import *

# Child element selection
device(className="android.widget.ListView").child(text="Bluetooth")

# Sibling element selection
device(text="Google").sibling(className="android.widget.ImageView")

# Text child element selection
device(className="android.widget.ListView").child_by_text("Wi-Fi", className="android.widget.LinearLayout")

# Child element selection with scroll search allowed
device(className="android.widget.ListView").child_by_text(
    "Bluetooth", 
    allow_scroll_search=True, 
    className="android.widget.LinearLayout"
)

# Description child element selection
device(className="android.widget.ListView").child_by_description("Wi-Fi description")

# Instance child element selection
device(className="android.widget.ListView").child_by_instance(0, className="android.widget.LinearLayout")

# Relative position selection
device(text="Wi-Fi").right(className="android.widget.Switch")  # The switch to the right of Wi-Fi
device(text="Settings").left(className="android.widget.ImageView")  # The image to the left of Settings
device(text="Item").up(className="android.widget.TextView")  # The text above Item
device(text="Item").down(className="android.widget.Button")  # The button below Item
```

**Parameters / Returns**:
- child(**kwargs) -> AutomatorDeviceObject: kwargs are selector fields of the child.
- sibling(**kwargs) -> AutomatorDeviceObject: kwargs are selector fields of the sibling (fromParent).
- child_by_text(txt: str, **kwargs) -> AutomatorDeviceNamedUiObject
  - kwargs: selector for the child container; allow_scroll_search: bool (optional)
- child_by_description(txt: str, **kwargs) -> AutomatorDeviceNamedUiObject
- child_by_instance(inst: int, **kwargs) -> AutomatorDeviceNamedUiObject
- right/left/up/down(**kwargs) -> AutomatorDeviceObject|None: Returns the nearest matching object by relative position or None if not found.

### Node 7: UI Element Operations

**Function Description**: Perform various operations on selected UI elements, including click, long - click, drag, gesture, and other interaction operations.

**Supported Operation Types**:
- Click operations: `click()`, `click.topleft()`, `click.bottomright()`, `click.wait()`
- Long - click operations: `long_click()`, `long_click.topleft()`, `long_click.bottomright()`
- Drag operations: `drag.to()`
- Gesture operations: `gesture()`, `gestureM()`
- Pinch operations: `pinch.In()`, `pinch.Out()`
- Swipe operations: `swipe.left()`, `swipe.right()`, `swipe.up()`, `swipe.down()`

**Input - Output Example**:

```python
from uiautomator import *

# Basic click
device(text="Settings").click()

# Click at a specified position
device(text="Settings").click.topleft()  # Click at the top - left corner
device(text="Settings").click.bottomright()  # Click at the bottom - right corner

# Click and wait
device(text="Settings").click.wait()  # Click and wait for the interface to update

# Long - click operation
device(text="Settings").long_click()
device(text="Settings").long_click.topleft()

# Drag operation
device(text="Settings").drag.to(100, 200, steps=50)  # Drag to specified coordinates
device(text="Settings").drag.to(text="Target", steps=50)  # Drag to a target element

# Gesture operation
device(text="Settings").gesture((100, 200), (300, 400)).to((500, 600), (700, 800))

# Multi - point gesture
device(text="Settings").gestureM((100, 200), (300, 400), (500, 600)).to((700, 800), (900, 1000), (1100, 1200))

# Pinch operation
device(text="Settings").pinch.In(percent=100, steps=10)  # Pinch in
device(text="Settings").pinch.Out(percent=100, steps=10)  # Pinch out

# Swipe operation
device(text="Settings").swipe.left(steps=10)  # Swipe left
device(text="Settings").swipe.right(steps=10)  # Swipe right
device(text="Settings").swipe.up(steps=10)  # Swipe up
device(text="Settings").swipe.down(steps=10)  # Swipe down
```

**Parameters / Returns**:
- click(action: None|"topleft"|"bottomright"|aliases, timeout_ms=3000) -> bool
- long_click(corner: None|"topleft"|"bottomright") -> bool
- drag.to(x: int, y: int, steps: int=100) -> bool | drag.to(**selector, steps=100) -> bool
- gesture(start1: tuple|dict, start2: tuple|dict).to(end1, end2, steps=100) -> bool
- gestureM(start1, start2, start3).to(end1, end2, end3, steps=100) -> bool
- pinch.In(percent=100, steps=50) / pinch.Out(percent=100, steps=50) -> bool
- swipe.left/right/up/down(steps=10[, percent: float]) -> bool
- wait.exists(timeout_ms=3000) / wait.gone(timeout_ms=3000) -> bool

### Node 8: Text Input Operations

**Function Description**: Perform text input, clearing, and setting operations on editable UI elements.

**Supported Operations**:
- Set text: `set_text(text)`
- Clear text: `clear_text()`
- Text attribute acquisition: `text` attribute

**Input - Output Example**:

```python
from uiautomator import *

# Set text
device(resourceId="com.example:id/edit_text").set_text("Hello World")

# Clear text
device(resourceId="com.example:id/edit_text").clear_text()

# Get text content
text_content = device(resourceId="com.example:id/text_view").text
print(f"Text content: {text_content}")

# Combination operations
edit_box = device(resourceId="com.example:id/input_field")
edit_box.clear_text()  # Clear first
edit_box.set_text("New Text")  # Then set new text
```

**Parameters / Returns**:
- set_text(text: str|None) -> bool: Set text in editable element; if text is None or "", calls clearTextField instead
- clear_text() -> None: Clear text field; internally calls set_text(None)
- text -> str: Read-only property to get current text content of element

### Node 9: Scroll and Fling Operations

**Function Description**: Perform scroll, page - turning, and other operations on scrollable UI elements, supporting multiple scroll strategies.

**Supported Operation Types**:
- Scroll operations: `scroll.forward()`, `scroll.backward()`, `scroll.toBeginning()`, `scroll.toEnd()`, `scroll.to()`
- Page - turning operations: `fling.forward()`, `fling.backward()`, `fling.toBeginning()`, `fling.toEnd()`
- Direction control: `vert` (vertical), `horiz` (horizontal)

**Input - Output Example**:

```python
from uiautomator import *

# Scroll operations
device(scrollable=True).scroll.forward(steps=100)  # Scroll forward
device(scrollable=True).scroll.backward(steps=100)  # Scroll backward
device(scrollable=True).scroll.toBeginning(steps=100, max_swipes=1000)  # Scroll to the beginning
device(scrollable=True).scroll.toEnd(steps=100)  # Scroll to the end
device(scrollable=True).scroll.to(text="Target Text")  # Scroll to specified text

# Horizontal scrolling
device(scrollable=True).scroll.horiz.forward(steps=100)
device(scrollable=True).scroll.horiz.backward(steps=100)

# Page - turning operations
device(scrollable=True).fling.forward()  # Page forward
device(scrollable=True).fling.backward()  # Page backward
device(scrollable=True).fling.toBeginning(max_swipes=1000)  # Page to the beginning
device(scrollable=True).fling.toEnd()  # Page to the end

# Horizontal page - turning
device(scrollable=True).fling.horiz.forward()
device(scrollable=True).fling.horiz.backward()
```

**Parameters / Returns**:
- scroll(dimention: str="vert", action: str="forward", steps: int=100, max_swipes: int=1000, **kwargs) -> bool:
  - dimention: "vert"/"vertical"/"vertically" or "horiz"/"horizontal"/"horizontally"
  - action: "forward", "backward", "toBeginning", "toEnd", "to"
  - steps: Number of steps for smooth scrolling (default: 100)
  - max_swipes: Max swipes for toBeginning/toEnd actions (default: 1000)
  - **kwargs: Selector fields for "to" action (scroll to specific element)
- fling(dimention: str="vert", action: str="forward", max_swipes: int=1000) -> bool:
  - dimention: "vert"/"vertical"/"vertically" or "horiz"/"horizontal"/"horizontally"  
  - action: "forward", "backward", "toBeginning", "toEnd"
  - max_swipes: Max swipes for toBeginning/toEnd actions (default: 1000)

### Node 10: Wait Operations

**Function Description**: Provide various waiting mechanisms, including waiting for element appearance, disappearance, and interface idle.

**Supported Waiting Types**:
- Wait for element appearance: `wait.exists()`
- Wait for element disappearance: `wait.gone()`
- Wait for interface idle: `wait.idle()`
- Wait for interface update: `wait.update()`

**Input - Output Example**:

```python
from uiautomator import *

# Wait for an element to appear
device(text="Loading").wait.exists(timeout=3000)  # Wait for 3 seconds

# Wait for an element to disappear
device(text="Loading").wait.gone(timeout=5000)  # Wait for 5 seconds

# Wait for the interface to be idle
device.wait.idle()  # Wait for the current interface to be idle

# Wait for the interface to update
device.wait.update()  # Wait for an interface update event

# Combination waiting
if device(text="Loading").wait.exists(timeout=3000):
    device(text="Loading").wait.gone(timeout=10000)  # Wait for loading to complete
```

**Parameters / Returns**:
- wait.idle(timeout: int=1000) -> bool: Wait for current application to be idle (device level)
- wait.update(timeout: int=1000, package_name: str=None) -> bool: Wait for window update event (device level)
- element.wait.exists(timeout: int=3000) -> bool: Wait for UI element to appear (element level)
- element.wait.gone(timeout: int=3000) -> bool: Wait for UI element to disappear (element level)

### Node 11: Element Information Retrieval

**Function Description**: Get detailed information about UI elements, including position, size, status, attributes, etc.

**Retrievable Information**:
- Basic information: `text`, `className`, `packageName`, `resourceId`
- Position information: `bounds`, `visibleBounds`
- Status information: `enabled`, `clickable`, `checked`, `focusable`, `focused`, `selected`
- Other attributes: `description`, `childCount`, `longClickable`, `scrollable`

**Input - Output Example**:

```python
from uiautomator import *

# Get element information
element_info = device(text="Settings").info
print(element_info)
# Output example:
# {
#   'contentDescription': '',
#   'checked': False,
#   'scrollable': False,
#   'text': 'Settings',
#   'packageName': 'com.android.launcher',
#   'selected': False,
#   'enabled': True,
#   'bounds': {'top': 385, 'right': 360, 'bottom': 585, 'left': 200},
#   'className': 'android.widget.TextView',
#   'focused': False,
#   'focusable': True,
#   'clickable': True,
#   'childCount': 0,
#   'longClickable': True,
#   'visibleBounds': {'top': 385, 'right': 360, 'bottom': 585, 'left': 200},
#   'checkable': False
# }

# Get specific attributes
text = device(text="Settings").text
bounds = device(text="Settings").bounds
is_clickable = device(text="Settings").clickable
is_enabled = device(text="Settings").enabled

# Get position information
x = (bounds['left'] + bounds['right']) // 2
y = (bounds['top'] + bounds['bottom']) // 2
```

**Parameters / Returns**:
- info -> dict: Read-only property returning complete element information with keys:
  - contentDescription: str
  - checked: bool
  - scrollable: bool
  - text: str
  - packageName: str
  - selected: bool
  - enabled: bool
  - bounds: dict {'top': int, 'right': int, 'bottom': int, 'left': int}
  - className: str
  - focused: bool
  - focusable: bool
  - clickable: bool
  - childCount: int
  - longClickable: bool
  - visibleBounds: dict (same format as bounds)
  - checkable: bool
- __getattr__(attr: str) -> Any: Direct access to info fields; supports alias 'description' -> 'contentDescription'

### Node 12: Element Counting and Iteration

**Function Description**: Perform counting and iteration operations on matching UI elements, supporting list - style access.

**Supported Operations**:
- Element counting: `count` attribute
- Length acquisition: `len()` function
- Index access: `[index]` operation
- Iteration traversal: `for` loop

**Input - Output Example**:

```python
from uiautomator import *

# Get the number of elements
button_count = device(className="android.widget.Button").count
print(f"Number of buttons: {button_count}")

# Use the len() function
buttons = device(className="android.widget.Button")
print(f"Number of buttons: {len(buttons)}")

# Index access
first_button = device(className="android.widget.Button")[0]
second_button = device(className="android.widget.Button")[1]

# Traverse all elements
for i, button in enumerate(device(className="android.widget.Button")):
    print(f"Button {i}: {button.text}")

# Conditional traversal
for button in device(className="android.widget.Button"):
    if button.text == "OK":
        button.click()
        break
```

**Parameters / Returns**:
- count -> int; len(device(className=...)) == count
- obj[i] -> AutomatorDeviceObject: 0-based index; raises IndexError if i >= count
- iter(obj) -> iterator over AutomatorDeviceObject

### Node 13: Screenshot and UI Dump

**Function Description**: Get device screenshots and interface hierarchy information for debugging and analysis.

**Supported Functions**:
- Screen screenshot: `screenshot(filename, scale, quality)`
- UI dump: `dump(filename, compressed, pretty)`
- Screenshot acquisition: Server - side screenshot function

**Input - Output Example**:

```python
from uiautomator import *

# Screen screenshot
device.screenshot("screenshot.png", scale=1.0, quality=100)  # Save the screenshot to a file

# UI hierarchy dump
xml_content = device.dump("hierarchy.xml")  # Save to a file
xml_content = device.dump()  # Get XML content

# Server - side screenshot
screenshot_data = device.server.screenshot()  # Get screenshot data
screenshot_file = device.server.screenshot("remote_screenshot.png")  # Save a remote screenshot
```

**Parameters / Returns**:
- screenshot(filename: str, scale: float=1.0, quality: int=100) -> str|None: Take screenshot and save to file
  - Returns filename on success, None on failure
- dump(filename: str=None, compressed: bool=True, pretty: bool=True) -> str: Dump UI hierarchy to XML
  - If filename provided, saves to file and returns XML content
  - If filename is None, returns XML content only
  - compressed: whether to use compressed format
  - pretty: whether to format XML with indentation
- server.screenshot(filename: str=None, scale: float=1.0, quality: int=100) -> bytes|str: Server-side screenshot
  - Returns screenshot data (bytes) if no filename, or filename (str) if saved

### Node 14: Notification and Quick Settings Operations

**Function Description**: Operate the notification bar and quick settings panel of the Android system.

**Supported Operations**:
- Open the notification bar: `open.notification()`
- Open the quick settings: `open.quick_settings()`

**Input - Output Example**:

```python
from uiautomator import *

# Open the notification bar
device.open.notification()

# Open the quick settings
device.open.quick_settings()

# Combination operations
device.open.notification()  # Open the notification bar
device(text="Clear all").click()  # Clear all notifications
device.press.back()  # Go back
```

**Parameters / Returns**:
- open.notification() -> bool
- open.quick_settings() -> bool

### Node 15: Watcher Pattern

**Function Description**: Implement the UI watcher pattern, automatically performing operations when specific conditions are met.

**Supported Functions**:
- Register a watcher: `watcher(name)`
- Condition setting: `when()` method
- Action setting: `click()`, `press()` methods
- Watcher management: `watchers` attribute

**Input - Output Example**:

```python
from uiautomator import *

# Register a watcher
device.watcher("AUTO_FC_WHEN_ANR").when(text="ANR").when(text="Wait") \
                           .click(text="Force Close")

# Key watcher
device.watcher("AUTO_FC_WHEN_ANR").when(text="ANR").when(text="Wait") \
                           .press.back.home()

# Check if the watcher is triggered
if device.watcher("AUTO_FC_WHEN_ANR").triggered:
    print("The watcher has been triggered")

# Get all watchers
watcher_list = device.watchers
print(f"Watcher list: {watcher_list}")

# Check if any watcher is triggered
if device.watchers.triggered:
    print("A watcher has been triggered")

# Reset watcher status
device.watchers.reset()

# Remove a watcher
device.watcher("AUTO_FC_WHEN_ANR").remove()
device.watchers.remove("AUTO_FC_WHEN_ANR")

# Remove all watchers
device.watchers.remove()

# Force all watchers to run
device.watchers.run()
```

**Parameters / Returns**:
- watcher(name: str) -> Watcher: chain .when(**selector) conditions; actions: .click(**selector), .press.back.home() etc.
- watchers -> Manager: .triggered -> bool, .reset() -> None, .remove(name: str|None=None) -> None, .run() -> None
 - Implementation note: per-device watcher collections are maintained internally by a manager (akin to NotFoundHandler); rely on the public API above.

### Node 16: Handler Pattern

**Function Description**: Provide custom callback functions to handle UI not found exceptions, enabling more flexible exception handling. Internally implemented by the NotFoundHandler descriptor class.

**Supported Functions**:
- Register a handler: `handlers.on(callback)`
- Remove a handler: `handlers.off(callback)`
- Custom callback functions

**Implementation Note**: The handlers attribute is powered by NotFoundHandler, a descriptor class that maintains per-device handler collections. When a UI element is not found (JSON-RPC error code -32002), all registered handlers are invoked in sequence until one returns True or all handlers complete.

**Input - Output Example**:

```python
from uiautomator import *

# Define a handler callback function
def force_close_handler(device):
    if device(text='Force Close').exists:
        device(text='Force Close').click()
    return True  # Return True to interrupt the handler loop

# Register a handler
device.handlers.on(force_close_handler)

# Remove a handler
device.handlers.off(force_close_handler)

# Use the handler to handle exceptions
try:
    device(text="Non-existent element").click()
except:
    # The handler will automatically handle the exception
    pass
```

**Parameters / Returns**:
- handlers.on(fn: Callable[[Device], bool]) -> None: register; returns None
- handlers.off(fn: Callable[[Device], bool]) -> None: unregister; returns None
- Callback returns True to stop further handler processing loop.

### Node 16a: NotFoundHandler Class (Internal)

**Function Description**: Internal descriptor class that implements the handler pattern for UI Object Not Found exceptions. Acts as a replacement for UiAutomator watcher on the device side.

**Class Definition**:
```python
class NotFoundHandler(object):
    '''
    Handler for UI Object Not Found exception.
    It's a replacement of UiAutomator watcher on device side.
    '''
    
    def __init__(self):
        # Initialize per-device handler collections using defaultdict
        self.__handlers = collections.defaultdict(lambda: {'on': True, 'handlers': []})
    
    def __get__(self, instance, type):
        # Descriptor protocol: return handler dict for specific device serial
        return self.__handlers[instance.adb.device_serial()]
```

**Handler Dictionary Structure**:
```python
{
    'on': bool,           # Whether handlers are enabled
    'handlers': list,     # List of callback functions
    'device': Device      # Reference to device instance
}
```

**Usage Context**:
- Used by AutomatorServer: `handlers = NotFoundHandler()`
- Accessed via device.handlers or device.server.handlers
- Automatically invoked when JSON-RPC error code -32002 (Not Found) occurs
- Maintains separate handler collections per device serial number

**Implementation Details**:
- **Descriptor Pattern**: Uses Python's descriptor protocol (`__get__`) to provide per-device handler storage
- **Per-Device Isolation**: Each device serial gets its own handler collection in the defaultdict
- **Error Code Integration**: Triggered on JSON-RPC error code -32002 (ERROR_CODE_BASE - 2)
- **Handler Loop**: All handlers execute until one returns True (break) or all complete

**Internal Flow**:
1. UI operation fails with "Not Found" error
2. NotFoundHandler descriptor returns device-specific handler dict
3. Temporarily disable handlers (`'on': False`) to prevent recursion
4. Execute all registered handler functions sequentially
5. Handler returns True → stop further handlers; False → continue
6. Re-enable handlers (`'on': True`)
7. Retry original operation

**Why Internal**: This class is not meant for direct user instantiation. Users interact with it through the `device.handlers.on()` and `device.handlers.off()` API.

### Node 17: ADB Connection Management

**Function Description**: Manage Android Debug Bridge connections, including device discovery, port forwarding, command execution, etc.

**Supported Functions**:
- Device discovery: `devices()`
- Port forwarding: `forward(local_port, device_port)`
- Command execution: `cmd()`, `raw_cmd()`
- Device serial number management: `device_serial()`

**Input - Output Example**:

```python
from uiautomator import Adb

# Create an ADB connection
adb = Adb(serial="014E05DE0F02000E")

# Get the device list
devices = adb.devices()
print(f"Connected devices: {devices}")
# Output: {'014E05DE0F02000E': 'device', '489328DKFL7DF': 'device'}

# Port forwarding
adb.forward(9008, 9008)  # Forward local port 9008 to device port 9008

# Execute an ADB command
result = adb.cmd("shell", "ls", "/data/local/tmp")
print(f"Command result: {result}")

# Get the device serial number
serial = adb.device_serial()
print(f"Device serial number: {serial}")

# Get the forwarding list
forward_list = adb.forward_list()
print(f"Forwarding list: {forward_list}")
```

**Parameters / Returns**:
- __init__(serial: str=None, adb_server_host: str=None, adb_server_port: int=None): Create ADB connection instance
- devices() -> dict: Get connected devices; returns {serial: status} mapping
- forward(local_port: int, device_port: int) -> int: Setup port forwarding; returns exit code
- cmd(*args) -> subprocess.Popen: Execute ADB command with device serial
- raw_cmd(*args) -> subprocess.Popen: Execute raw ADB command without device serial
- device_serial() -> str: Get device serial number
- forward_list() -> list: Get list of active port forwards
- version() -> str: Get ADB version

### Node 18: JSON - RPC Communication

**Function Description**: Implement JSON - RPC communication with Android devices, supporting method calls and error handling.

**Supported Functions**:
- RPC method call: `JsonRPCMethod`
- RPC client: `JsonRPCClient`
- Error handling: `JsonRPCError`
- Timeout control: `timeout` parameter

**Input - Output Example**:

```python
from uiautomator import JsonRPCMethod, JsonRPCClient, JsonRPCError

# Create an RPC method
method = JsonRPCMethod("http://localhost:9008/jsonrpc", "ping", timeout=30)

# Call the RPC method
try:
    result = method()
    print(f"RPC call result: {result}")
except JsonRPCError as e:
    print(f"RPC error: {e.code} - {e.message}")

# Create an RPC client
client = JsonRPCClient("http://localhost:9008/jsonrpc", timeout=30)

# Call a method through the client
try:
    device_info = client.deviceInfo()
    print(f"Device information: {device_info}")
    
    click_result = client.click(100, 200)
    print(f"Click result: {click_result}")
except Exception as e:
    print(f"Client error: {e}")
```

**Parameters / Returns**:
- JsonRPCError(code: int, message: str): Exception carrying error info. Attributes: code, message.
- JsonRPCMethod(url: str, method: str, timeout: int=30): Callable representing one RPC method.
  - __call__(*args, **kwargs) -> Any: Invokes remote; may raise JsonRPCError.
  - id() -> str: Get unique method ID (md5 hash of method name and timestamp)
- JsonRPCClient(url: str, timeout: int=30, method_class=JsonRPCMethod): Dynamic client.
  - __getattr__(method: str) -> JsonRPCMethod: Dynamic method access (e.g., client.deviceInfo)
  - Use server.jsonrpc_wrap(timeout_ms) when per-call longer timeout is needed.

### Node 19: Automator Server Management

**Function Description**: Manage the uiautomator server, including starting, stopping, status checking, etc.

**Supported Functions**:
- Server start: `start(timeout)`
- Server stop: `stop()`
- Status check: `alive` attribute
- Heartbeat detection: `ping()`
- File pushing: `push()`

**Input - Output Example**:

```python
from uiautomator import AutomatorServer

# Create a server instance
server = AutomatorServer(serial="014E05DE0F02000E")

# Start the server
server.start(timeout=30)

# Check server status
if server.alive:
    print("The server is running normally")

# Heartbeat detection
ping_result = server.ping()
print(f"Heartbeat result: {ping_result}")

# Push files
jar_files = server.push()
print(f"Pushed files: {jar_files}")

# Screenshot function
screenshot_data = server.screenshot()
screenshot_file = server.screenshot("test.png")

# Stop the server
server.stop()
```

**Parameters / Returns**:
- __init__(serial: str=None, local_port: int=None, device_port: int=None, adb_server_host: str=None, adb_server_port: int=None): Create server instance
- start(timeout: int=30) -> bool: Start uiautomator server with timeout
- stop() -> None: Stop uiautomator server  
- alive -> bool: Read-only property; check if server is running
- ping() -> str: Send ping to server; returns "pong" if alive
- push() -> list: Push required JAR files to device; returns list of pushed files
- screenshot(filename: str=None, scale: float=1.0, quality: int=100) -> bytes|str: Take server-side screenshot

### Node 20: Parameter to Property Conversion

**Function Description**: Provide a decorator function to convert function parameters into property call forms, enabling a more elegant API design.

**Supported Functions**:
- Positional parameter conversion: `param_to_property("param1", "param2")`
- Keyword parameter conversion: `param_to_property(key=["value1", "value2"])`
- Chained calls: Support chained calls of multiple properties

**Input - Output Example**:

```python
from uiautomator import param_to_property

# Positional parameter conversion
@param_to_property("one", "two", "three")
def test_function(*args, **kwargs):
    print(f"Parameters: {args}")
    print(f"Keywords: {kwargs}")

# Chained calls
test_function.one.two.three(test=1)
# Output: Parameters: ('one', 'two', 'three'), Keywords: {'test': 1}

# Keyword parameter conversion
@param_to_property(key=["home", "back", "menu"])
def press_key(*args, **kwargs):
    print(f"Key: {kwargs.get('key')}")

# Usage
press_key.home()  # Output: Key: home
press_key.back()  # Output: Key: back
press_key.menu()  # Output: Key: menu

# Error handling
try:
    test_function.one.one  # Repeated parameters will throw an AttributeError
except AttributeError as e:
    print(f"Error: {e}")
```

**Parameters / Returns**:
- param_to_property(*args, **kwargs) -> decorator: Create property-style decorator
  - *args: Positional parameter names for property chaining
  - **kwargs: Keyword parameter mappings (key=["value1", "value2"])
  - Returns: Decorator function that wraps the target function
- Decorated function gains property-style access: func.param1.param2() instead of func("param1", "param2")

### Node 21: Utility Functions

**Function Description**: Provide various utility functions, including rectangle operations, point operations, port management, and other auxiliary functions.

**Supported Functions**:
- Rectangle operations: `rect()`, `intersect()`
- Point operations: `point()`
- Port management: `next_local_port()`
- String processing: `U()` function

**Input - Output Example**:

```python
from uiautomator import rect, point, intersect, next_local_port

# Create a rectangle
rectangle = rect(top=100, left=200, bottom=300, right=400)
print(f"Rectangle: {rectangle}")
# Output: {'top': 100, 'left': 200, 'bottom': 300, 'right': 400}

# Create a point
coordinate = point(x=150, y=250)
print(f"Coordinate: {coordinate}")
# Output: {'x': 150, 'y': 250}

# Rectangle intersection
rect1 = rect(0, 0, 100, 100)
rect2 = rect(50, 50, 150, 150)
intersection = intersect(rect1, rect2)
print(f"Intersection: {intersection}")
# Output: (50, 50, 100, 100)

# Get the next available port
port = next_local_port()
print(f"Available port: {port}")

# String processing (Python 2/3 compatibility)
from uiautomator import U
text = U("Hello World")
print(f"Processed text: {text}")
```

**Parameters / Returns**:
- rect(top: int=0, left: int=0, bottom: int=100, right: int=100) -> dict: {'top','left','bottom','right'}
- point(x: int=0, y: int=0) -> dict: {'x','y'}
- intersect(rect1: dict, rect2: dict) -> tuple[int, int, int, int]: (left, top, right, bottom) of overlap
- next_local_port(adbHost: str|None=None) -> int: First free host port probing from LOCAL_PORT
  - Uses internal helper is_port_listening(port: int) -> bool to check if port is occupied
  - Increments global _init_local_port counter to find free ports
- U(x: str) -> str: Unicode compatibility helper for Python 2/3

**Constants**:
- LOCAL_PORT: int = int(os.environ.get("UIAUTOMATOR_LOCAL_PORT", "9008")): Default local JSON-RPC port
  - Can be overridden by environment variable UIAUTOMATOR_LOCAL_PORT
  - Used as starting point for port allocation by next_local_port()
- DEVICE_PORT: int = int(os.environ.get("UIAUTOMATOR_DEVICE_PORT", "9008")): Default device-side JSON-RPC port
- _init_local_port: int = LOCAL_PORT - 1: Internal port counter used by next_local_port()

### Node 22: Multi - Device Support

**Function Description**: Support connecting and managing multiple Android devices simultaneously, providing device isolation and parallel operations.

**Supported Functions**:
- Device serial number specification: `Device(serial)`
- Multi - device parallel operations
- Device status isolation
- Remote ADB server support

**Input - Output Example**:

```python
from uiautomator import Device

# Specify device serial numbers
device1 = Device('014E05DE0F02000E')
device2 = Device('489328DKFL7DF')

# Multi - device parallel operations
device1.screen.on()
device2.screen.on()

device1.click(100, 200)
device2.click(300, 400)

# Get device information
info1 = device1.info
info2 = device2.info

print(f"Device 1 information: {info1}")
print(f"Device 2 information: {info2}")

# Remote ADB server
remote_device = Device(
    '014E05DE0F02000E', 
    adb_server_host='192.168.1.68', 
    adb_server_port=5037
)

# Remote device operations
remote_device.screen.on()
remote_device.click(100, 200)
```

**Parameters / Returns**:
- Device(serial: str=None, local_port: int=None, adb_server_host: str=None, adb_server_port: int=None) -> AutomatorDevice: Create device instance
  - serial: Target device serial number (None for default device)
  - local_port: Local port for JSON-RPC communication  
  - adb_server_host: Remote ADB server host (default: "127.0.0.1")
  - adb_server_port: Remote ADB server port (default: 5037)
  - Returns: AutomatorDevice instance for device-specific operations

### Node 23: Error Handling and Exception Management

**Function Description**: Provide a complete error handling mechanism, including custom exceptions, timeout handling, retry mechanisms, etc.

**Supported Exception Types**:
- `JsonRPCError`: JSON - RPC communication error
- `EnvironmentError`: Environment configuration error
- `IOError`: Input - output error
- `AttributeError`: Attribute access error

**Input - Output Example**:

```python
from uiautomator import *, JsonRPCError

# JSON - RPC error handling
try:
    result = device.server.jsonrpc.nonExistentMethod()
except JsonRPCError as e:
    print(f"RPC error code: {e.code}")
    print(f"RPC error message: {e.message}")

# Environment error handling
try:
    from uiautomator import Adb
    adb = Adb()
    adb.adb()  # May throw an EnvironmentError
except EnvironmentError as e:
    print(f"Environment error: {e}")

# Element non - existence handling
try:
    element = device(text="Non-existent element")
    if element.exists:
        element.click()
    else:
        print("The element does not exist")
except Exception as e:
    print(f"Operation error: {e}")

# Timeout handling
try:
    device(text="Loading").wait.exists(timeout=5000)
except Exception as e:
    print(f"Waiting timeout: {e}")

# Retry mechanism
import time
max_retries = 3
for attempt in range(max_retries):
    try:
        device(text="Target").click()
        break
    except Exception as e:
        if attempt == max_retries - 1:
            print(f"Final failure: {e}")
        else:
            print(f"Attempt {attempt + 1} failed, retrying...")
            time.sleep(1)
```

**Parameters / Returns**:
- JsonRPCError(code: int, message: str) -> JsonRPCError: Custom exception for JSON-RPC errors
  - code: Error code from server
  - message: Error description message
- Standard Python exceptions (EnvironmentError, IOError, AttributeError) used throughout the library

### Node 24: Performance Optimization and Monitoring

**Function Description**: Provide performance optimization functions, including connection pool management, timeout control, resource cleanup, etc.

**Supported Functions**:
- Connection pool management: urllib3 connection pool
- Timeout control: Multiple timeout settings
- Resource cleanup: Automatic cleanup mechanism
- Performance monitoring: Operation time - consuming statistics

**Input - Output Example**:

```python
from uiautomator import *
import time

# Performance monitoring
start_time = time.time()
device.click(100, 200)
click_time = time.time() - start_time
print(f"Click operation time: {click_time:.3f} seconds")

# Batch operation performance
start_time = time.time()
for i in range(10):
    device.click(100 + i, 200 + i)
batch_time = time.time() - start_time
print(f"Batch operation time: {batch_time:.3f} seconds")

# Timeout control
import signal

def timeout_handler(signum, frame):
    raise TimeoutError("Operation timed out")

# Set the timeout
signal.signal(signal.SIGALRM, timeout_handler)
signal.alarm(10)  # 10 - second timeout

try:
    device(text="Slow loading element").wait.exists(timeout=15000)
    signal.alarm(0)  # Cancel the timeout
except TimeoutError:
    print("Operation timed out")
    signal.alarm(0)

# Resource cleanup
def cleanup_resources():
    try:
        device.server.stop()
    except:
        pass

# Use a context manager
import contextlib

@contextlib.contextmanager
def device_session():
    try:
        yield device
    finally:
        cleanup_resources()

# Usage example
with device_session():
    device.screen.on()
    device.click(100, 200)
    # Automatically clean up resources
```

**Parameters / Returns**:
- Performance monitoring functions return execution timing information (float: seconds)
- Resource management functions typically return None but ensure proper cleanup
- Timeout handlers raise TimeoutError when operations exceed time limits

### Node 25: Testing and Debugging Support

**Function Description**: Provide rich testing and debugging functions, including mock objects, test cases, debugging information, etc.

**Supported Functions**:
- Mock objects: Mock object support
- Test cases: Complete test suite
- Debugging information: Detailed debugging output
- Logging: Operation log recording

**Input - Output Example**:

```python
from uiautomator import *
from mock import MagicMock, patch

# Mock the device object
mock_device = MagicMock()
mock_device.server.jsonrpc.click.return_value = True

# Mock a click operation
with patch('uiautomator.device', mock_device):
    result = device.click(100, 200)
    print(f"Mock click result: {result}")

# Debugging information output
import logging
logging.basicConfig(level=logging.DEBUG)

# Enable debug mode
device.server.jsonrpc.debug = True

# Perform an operation and view debugging information
device.click(100, 200)

# Test case example
def test_basic_operations():
    """Test basic operations"""
    # Test click
    assert device.click(100, 200) is True
    
    # Test text input
    device(resourceId="test_input").set_text("test")
    assert device(resourceId="test_input").text == "test"
    
    # Test element existence
    assert device(text="Settings").exists is True

# Performance test
def performance_test():
    """Performance test"""
    import time
    
    # Test click performance
    start_time = time.time()
    for i in range(100):
        device.click(100, 200)
    end_time = time.time()
    
    avg_time = (end_time - start_time) / 100
    print(f"Average click time: {avg_time:.3f} seconds")
    
    return avg_time < 0.1  # Expected average time less than 0.1 seconds

# Run tests
if __name__ == "__main__":
    test_basic_operations()
    performance_test()
```

**Parameters / Returns**:
- Mock functions return configurable mock responses for testing
- Test assertion functions return bool (True for pass, False for fail)
- Performance test functions return timing metrics (float: seconds)
- Debug logging outputs detailed operation information to console/log files

### Node 26: AutomatorDeviceUiObject

**Function Description**: Encapsulates a single UI element bound to a `Selector`, surfacing state via `info`/`exists` and providing attribute aliasing.

**Supported Functions**:
- exists: Check whether the object exists (RPC: exist(selector)).
- info: Get UI object info (RPC: objInfo(selector)).
- __getattr__: Map attribute access to info; supports alias description -> contentDescription; raises AttributeError if not found.
- Members: device, jsonrpc, selector

**Input - Output Example**:

```python
class AutomatorDeviceUiObject(object):

    '''Represent a UiObject, on which user can perform actions, such as click, set text
    '''

    __alias = {'description': "contentDescription"}

    def __init__(self, device, selector):
        self.device = device
        self.jsonrpc = device.server.jsonrpc
        self.selector = selector

    @property
    def exists(self):
        '''check if the object exists in current window.'''
        return self.jsonrpc.exist(self.selector)

    def __getattr__(self, attr):
        '''alias of fields in info property.'''
        info = self.info
        if attr in info:
            return info[attr]
        elif attr in self.__alias:
            return info[self.__alias[attr]]
        else:
            raise AttributeError("%s attribute not found!" % attr)

    @property
    def info(self):
        '''ui object info.'''
        return self.jsonrpc.objInfo(self.selector)

    def set_text(self, text):
        '''set the text field.'''
        if text in [None, ""]:
            return self.jsonrpc.clearTextField(self.selector)  # TODO no return
        else:
            return self.jsonrpc.setText(self.selector, text)

    def clear_text(self):
        '''clear text. alias for set_text(None).'''
        self.set_text(None)

    @property
    def click(self):
        '''
        click on the ui object.
        Usage:
        device(text="Clock").click()  # click on the center of the ui object
        device(text="OK").click.wait(timeout=3000) # click and wait for the new window update
        device(text="John").click.topleft() # click on the topleft of the ui object
        device(text="John").click.bottomright() # click on the bottomright of the ui object
        '''
        @param_to_property(action=["tl", "topleft", "br", "bottomright", "wait"])
        def _click(action=None, timeout=3000):
            if action is None:
                return self.jsonrpc.click(self.selector)
            elif action in ["tl", "topleft", "br", "bottomright"]:
                return self.jsonrpc.click(self.selector, action)
            else:
                return self.jsonrpc.clickAndWaitForNewWindow(self.selector, timeout)
        return _click

    @property
    def long_click(self):
        '''
        Perform a long click action on the object.
        Usage:
        device(text="Image").long_click()  # long click on the center of the ui object
        device(text="Image").long_click.topleft()  # long click on the topleft of the ui object
        device(text="Image").long_click.bottomright()  # long click on the topleft of the ui object
        '''
        @param_to_property(corner=["tl", "topleft", "br", "bottomright"])
        def _long_click(corner=None):
            info = self.info
            if info["longClickable"]:
                if corner:
                    return self.jsonrpc.longClick(self.selector, corner)
                else:
                    return self.jsonrpc.longClick(self.selector)
            else:
                bounds = info.get("visibleBounds") or info.get("bounds")
                if corner in ["tl", "topleft"]:
                    x = (5 * bounds["left"] + bounds["right"]) / 6
                    y = (5 * bounds["top"] + bounds["bottom"]) / 6
                elif corner in ["br", "bottomright"]:
                    x = (bounds["left"] + 5 * bounds["right"]) / 6
                    y = (bounds["top"] + 5 * bounds["bottom"]) / 6
                else:
                    x = (bounds["left"] + bounds["right"]) / 2
                    y = (bounds["top"] + bounds["bottom"]) / 2
                return self.device.long_click(x, y)
        return _long_click

    @property
    def drag(self):
        '''
        Drag the ui object to other point or ui object.
        Usage:
        device(text="Clock").drag.to(x=100, y=100)  # drag to point (x,y)
        device(text="Clock").drag.to(text="Remove") # drag to another object
        '''
        def to(obj, *args, **kwargs):
            if len(args) >= 2 or "x" in kwargs or "y" in kwargs:
                drag_to = lambda x, y, steps=100: self.jsonrpc.dragTo(self.selector, x, y, steps)
            else:
                drag_to = lambda steps=100, **kwargs: self.jsonrpc.dragTo(self.selector, Selector(**kwargs), steps)
            return drag_to(*args, **kwargs)
        return type("Drag", (object,), {"to": to})()

    def gesture(self, start1, start2, *args, **kwargs):
        '''
        perform two point gesture.
        Usage:
        device().gesture(startPoint1, startPoint2).to(endPoint1, endPoint2, steps)
        device().gesture(startPoint1, startPoint2, endPoint1, endPoint2, steps)
        '''
        def to(obj_self, end1, end2, steps=100):
            ctp = lambda pt: point(*pt) if type(pt) == tuple else pt  # convert tuple to point
            s1, s2, e1, e2 = ctp(start1), ctp(start2), ctp(end1), ctp(end2)
            return self.jsonrpc.gesture(self.selector, s1, s2, e1, e2, steps)
        obj = type("Gesture", (object,), {"to": to})()
        return obj if len(args) == 0 else to(None, *args, **kwargs)

    def gestureM(self, start1, start2, start3, *args, **kwargs):
        '''
        perform 3 point gesture.
        Usage:
        device().gestureM((100,200),(100,300),(100,400),(100,400),(100,400),(100,400))
        device().gestureM((100,200),(100,300),(100,400)).to((100,400),(100,400),(100,400))
        '''
        def to(obj_self, end1, end2, end3, steps=100):
            ctp = lambda pt: point(*pt) if type(pt) == tuple else pt  # convert tuple to point
            s1, s2, s3, e1, e2, e3 = ctp(start1), ctp(start2), ctp(start3), ctp(end1), ctp(end2), ctp(end3)
            return self.jsonrpc.gesture(self.selector, s1, s2, s3, e1, e2, e3, steps)
        obj = type("Gesture", (object,), {"to": to})()
        return obj if len(args) == 0 else to(None, *args, **kwargs)

    @property
    def pinch(self):
        '''
        Perform two point gesture from edge to center(in) or center to edge(out).
        Usages:
        device().pinch.In(percent=100, steps=10)
        device().pinch.Out(percent=100, steps=100)
        '''
        @param_to_property(in_or_out=["In", "Out"])
        def _pinch(in_or_out="Out", percent=100, steps=50):
            if in_or_out in ["Out", "out"]:
                return self.jsonrpc.pinchOut(self.selector, percent, steps)
            elif in_or_out in ["In", "in"]:
                return self.jsonrpc.pinchIn(self.selector, percent, steps)
        return _pinch

    @property
    def swipe(self):
        '''
        Perform swipe action. if device platform greater than API 18, percent can be used and value between 0 and 1
        Usages:
        device().swipe.right()
        device().swipe.left(steps=10)
        device().swipe.up(steps=10)
        device().swipe.down()
        device().swipe("right", steps=20)
        device().swipe("right", steps=20, percent=0.5)
        '''
        @param_to_property(direction=["up", "down", "right", "left"])
        def _swipe(direction="left", steps=10, percent=1):
            if percent == 1:
                return self.jsonrpc.swipe(self.selector, direction, steps)
            else:
                return self.jsonrpc.swipe(self.selector, direction, percent, steps)
        return _swipe

    @property
    def wait(self):
        '''
        Wait until the ui object gone or exist.
        Usage:
        device(text="Clock").wait.gone()  # wait until it's gone.
        device(text="Settings").wait.exists() # wait until it appears.
        '''
        @param_to_property(action=["exists", "gone"])
        def _wait(action, timeout=3000):
            if timeout / 1000 + 5 > int(os.environ.get("JSONRPC_TIMEOUT", 90)):
                http_timeout = timeout / 1000 + 5
            else:
                http_timeout = int(os.environ.get("JSONRPC_TIMEOUT", 90))
            method = self.device.server.jsonrpc_wrap(
                timeout=http_timeout
            ).waitUntilGone if action == "gone" else self.device.server.jsonrpc_wrap(timeout=http_timeout).waitForExists
            return method(self.selector, timeout)
        return _wait 
```

**Parameters / Returns (cheatsheet)**:
- exists/info -> bool | dict
- set_text(text: str|None) -> bool, clear_text() -> None
- click/long_click/drag/gesture/gestureM/pinch/swipe -> bool
- wait.exists(timeout_ms) / wait.gone(timeout_ms) -> bool

### Node 27: AutomatorDeviceNamedUiObject

**Function Description**: A UiObject wrapper identified by a server-side name; used as the return type of `child_by_*` queries to keep chainable navigation.

**Inheritance**: Inherits from AutomatorDeviceUiObject

**Constructor**:
```python
def __init__(self, device, name):
    super(AutomatorDeviceNamedUiObject, self).__init__(device, name)
```

**Core Methods**:
- child(**kwargs) -> AutomatorDeviceNamedUiObject: Navigate to named child element
  - Internally calls self.jsonrpc.getChild(self.selector, Selector(**kwargs))
- sibling(**kwargs) -> AutomatorDeviceNamedUiObject: Navigate to named sibling element (fromParent)
  - Internally calls self.jsonrpc.getFromParent(self.selector, Selector(**kwargs))

**Parameters / Returns**:
- __init__(device: AutomatorDevice, name: str): Create named UI object with server-side name
- child(**kwargs) -> AutomatorDeviceNamedUiObject: Returns new named object for chaining
- sibling(**kwargs) -> AutomatorDeviceNamedUiObject: Returns new named object for chaining
- Accepts the same selector keyword fields as `Selector` for navigation targets

**Usage**:
```python
from uiautomator import *

# Returned by child_by_* methods
named_obj = device(className="android.widget.ListView").child_by_text("Settings")
# Chain navigation
child = named_obj.child(className="android.widget.TextView")
sibling = named_obj.sibling(className="android.widget.ImageView")
```

### Node 28: AutomatorDeviceObject

**Function Description**: Full-featured UI object class with collection support, relative positioning, and scrollable operations. This is the primary class returned by `device(**kwargs)` calls.

**Inheritance**: Inherits from AutomatorDeviceUiObject

**Constructor**:
```python
def __init__(self, device, selector):
    super(AutomatorDeviceObject, self).__init__(device, selector)
```

**Hierarchical Navigation**:
- child(**kwargs) -> AutomatorDeviceObject: Navigate to child element (modifies selector with child relationship)
- sibling(**kwargs) -> AutomatorDeviceObject: Navigate to sibling element (uses fromParent relationship)
- child_selector: Alias for child() method
- from_parent: Alias for sibling() method
- child_by_text(txt: str, **kwargs) -> AutomatorDeviceNamedUiObject: Find child by text content
  - Optional kwarg: allow_scroll_search: bool (enable scrolling to find element)
- child_by_description(txt: str, **kwargs) -> AutomatorDeviceNamedUiObject: Find child by description
- child_by_instance(inst: int, **kwargs) -> AutomatorDeviceNamedUiObject: Find child by instance index

**Collection Operations**:
- count -> int: Get number of matching elements in current window
- __len__() -> int: Support len() function (returns count)
- __getitem__(index: int) -> AutomatorDeviceObject: Support indexing (e.g., obj[0], obj[1])
  - Raises IndexError if index >= count
- __iter__() -> iterator: Support iteration over all matching elements

**Relative Positioning**:
- right(**kwargs) -> AutomatorDeviceObject|None: Find nearest element to the right
- left(**kwargs) -> AutomatorDeviceObject|None: Find nearest element to the left
- up(**kwargs) -> AutomatorDeviceObject|None: Find nearest element above
- down(**kwargs) -> AutomatorDeviceObject|None: Find nearest element below
  - Returns None if no matching element found in that direction

**Scrollable Operations**:
- fling property: Fast scroll operations (see Node 9)
  - fling.forward/backward/toBeginning/toEnd(max_swipes=1000)
  - fling.horiz.forward/backward/toBeginning/toEnd(max_swipes=1000)
- scroll property: Precise scroll operations (see Node 9)
  - scroll.forward/backward/toBeginning/toEnd/to(steps=100, max_swipes=1000)
  - scroll.horiz.forward/backward/toBeginning/toEnd/to(steps=100, max_swipes=1000)

**Usage Example**:
```python
from uiautomator import *

# Basic selection (returns AutomatorDeviceObject)
obj = device(text="Settings")

# Collection operations
buttons = device(className="android.widget.Button")
print(f"Button count: {buttons.count}")
for i, btn in enumerate(buttons):
    print(f"Button {i}: {btn.text}")

# Hierarchical navigation
list_item = device(className="android.widget.ListView").child(index=0)
child_text = device(resourceId="list").child_by_text("Wi-Fi", allow_scroll_search=True)

# Relative positioning
switch = device(text="Bluetooth").right(className="android.widget.Switch")

# Scrollable operations
device(scrollable=True).scroll.forward(steps=100)
device(scrollable=True).fling.toEnd()
```

**Parameters / Returns**:
- __init__(device: AutomatorDevice, selector: Selector): Create device object instance
- All methods inherited from AutomatorDeviceUiObject (click, long_click, drag, gesture, etc.)
- Additional navigation and collection methods as documented above

### Node 29: Selector Class (Detailed API)

**Function Description**: Dictionary-based selector builder for constructing UiSelector queries sent to Android device. Inherits from Python's dict class.

**Class Definition**:
```python
class Selector(dict):
    """The class is to build parameters for UiSelector passed to Android device."""
    
    def __init__(self, **kwargs):
        # Initialize with mask, childOrSibling, and childOrSiblingSelector internal fields
        # Set user-provided selector fields
        
    def __setitem__(self, k, v):
        # Validate field name and update internal mask
        # Raises ReferenceError if field name is invalid
        
    def __delitem__(self, k):
        # Remove field and update internal mask
        
    def clone(self):
        # Deep copy selector including child/sibling relationships
        
    def child(self, **kwargs):
        # Add child selector relationship
        
    def sibling(self, **kwargs):
        # Add sibling (fromParent) selector relationship
    
    # Aliases
    child_selector = child
    from_parent = sibling
```

**Supported Fields and Masks**:
- text: 0x01 (MASK_TEXT)
- textContains: 0x02 (MASK_TEXTCONTAINS)
- textMatches: 0x04 (MASK_TEXTMATCHES)
- textStartsWith: 0x08 (MASK_TEXTSTARTSWITH)
- className: 0x10 (MASK_CLASSNAME)
- classNameMatches: 0x20 (MASK_CLASSNAMEMATCHES)
- description: 0x40 (MASK_DESCRIPTION)
- descriptionContains: 0x80 (MASK_DESCRIPTIONCONTAINS)
- descriptionMatches: 0x0100 (MASK_DESCRIPTIONMATCHES)
- descriptionStartsWith: 0x0200 (MASK_DESCRIPTIONSTARTSWITH)
- checkable: 0x0400 (MASK_CHECKABLE, default: False)
- checked: 0x0800 (MASK_CHECKED, default: False)
- clickable: 0x1000 (MASK_CLICKABLE, default: False)
- longClickable: 0x2000 (MASK_LONGCLICKABLE, default: False)
- scrollable: 0x4000 (MASK_SCROLLABLE, default: False)
- enabled: 0x8000 (MASK_ENABLED, default: False)
- focusable: 0x010000 (MASK_FOCUSABLE, default: False)
- focused: 0x020000 (MASK_FOCUSED, default: False)
- selected: 0x040000 (MASK_SELECTED, default: False)
- packageName: 0x080000 (MASK_PACKAGENAME)
- packageNameMatches: 0x100000 (MASK_PACKAGENAMEMATCHES)
- resourceId: 0x200000 (MASK_RESOURCEID)
- resourceIdMatches: 0x400000 (MASK_RESOURCEIDMATCHES)
- index: 0x800000 (MASK_INDEX, default: 0)
- instance: 0x01000000 (MASK_INSTANCE, default: 0)

**Internal Fields** (managed automatically):
- mask: Bitmask representing active selector fields
- childOrSibling: List of relationship types ["child", "sibling"]
- childOrSiblingSelector: List of child/sibling Selector objects

**Usage Examples**:
```python
from uiautomator import Selector

# Basic selector
sel = Selector(text="OK", clickable=True)

# Clone and modify
sel2 = sel.clone()

# Child relationship (two equivalent ways)
sel.child(className="Button")
sel.child_selector(className="Button")  # Same as above

# Sibling relationship (two equivalent ways)
sel.sibling(text="Cancel")
sel.from_parent(text="Cancel")  # Same as above

# Invalid field raises error
try:
    sel["invalidField"] = "value"
except ReferenceError as e:
    print(e)  # "invalidField is not allowed."
```

**Parameters / Returns**:
- __init__(**kwargs): Accepts any supported selector field as keyword argument
- __setitem__(k: str, v: Any): Set selector field; raises ReferenceError if invalid
- __delitem__(k: str): Remove selector field and update mask
- clone() -> Selector: Returns deep copy including child/sibling relationships
- child(**kwargs) -> Selector: Add child selector (returns self for chaining)
- sibling(**kwargs) -> Selector: Add sibling selector (returns self for chaining)
- child_selector: Alias for child method
- from_parent: Alias for sibling method