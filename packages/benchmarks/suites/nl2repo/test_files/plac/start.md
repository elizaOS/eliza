## Introduction and Goals of the Plac Project

Plac is a Python library **for command-line argument parsing** that can automatically generate command-line arguments from function signatures and handle user input. This tool performs excellently across all versions from Python 2.6 to Python 3, achieving "the smartest command-line argument parsing" and a "lightweight design with zero dependencies". Its core functions include: automatic parameter parsing (automatically inferring parameter types and default values from function signatures), intelligent help generation (automatically generating detailed command-line help documentation), and decorator-driven parameter customization (supporting flexible configuration of positional parameters, optional parameters, and flag parameters). In short, Plac aims to provide a concise yet powerful command-line argument parsing system for quickly adding professional command-line interfaces to Python scripts (for example, defining positional parameters with the `@plac.pos()` decorator, optional parameters with the `@plac.opt()` decorator, and flag parameters with the `@plac.flg()` decorator).

This project is particularly suitable for Python developers who need to quickly develop command-line tools and is an ideal choice for building CLI applications.

## Natural Language Instructions (Prompt)

Please create a Python project named Plac to implement a command-line argument parsing library. The project should include the following features:

1. **Core Parameter Parsing Module**: Implement a function signature analyzer capable of extracting parameter information from functions, methods, and classes. Create a decorator system: `pos()`, `opt()`, `flg()` for annotating positional parameters, optional parameters, and flag parameters. Implement the `Annotation` class to store parameter metadata (help, kind, abbrev, type, choices, metavar). Create the `ArgumentParser` class that inherits from `argparse.ArgumentParser`, adding the `.func` and `.argspec` attributes. Implement the `call()` function as the main entry point, supporting the invocation of functions, classes, and modules, and ensuring compatibility from Python 2.6 to Python 3, including compatible handling of `inspect.getfullargspec`.

2. **Extended Function Module**: Implement the `Interpreter` class for the interactive interpreter, supporting command execution and task management. Create a task management system: `BaseTask`, `SynTask`, `ThreadedTask`, `MPTask` classes. Implement the `TaskManager` class to manage the lifecycle of tasks (submission, execution, termination, output). Add multi-process support with the `runp()` function, enabling parallel task execution. Implement the `Monitor` and `Manager` classes for task monitoring. Provide the `import_main()` function for dynamically importing modules, and support server mode with the `start_server()` function for network interaction. Additional utility classes include `TerminatedProcess` exception, `ReadlineInput` for enhanced input handling, `HelpSummary` for help management, `PlacFormatter` for custom formatting, `Process` for subprocess management, and `StartStopObject` as base class for startable/stoppable objects.

3. **GUI Interface Module**: Implement the `TkMonitor` class that inherits from `Monitor`, providing a Tkinter GUI interface. Create a scrolling text control to display task output, support the addition, deletion, and notification of task listeners, and implement the main loop and queue reading mechanism.

4. **Interface Design**: Design independent command-line interfaces or function interfaces for each functional module (such as parameter parsing, decorator system, interactive interpreter, task management, etc.), supporting terminal invocation for testing. Each module should define clear input and output formats.

5. **Examples and Evaluation Scripts**: Provide sample code and test cases to demonstrate how to use the `call()` function for parameter parsing and command execution (for example, `plac.call(main, ["--help"])` should return the help documentation). All the above features should be integrated to build a complete command-line argument parsing toolkit. The final project should include modules for parsing, decorators, interactivity, task management, etc., along with typical test cases, forming a reproducible development process for command-line tools.

6. **Core File Requirements**: The project must include a comprehensive `setup.py` file. This file should not only configure the project as an installable package (supporting `pip install`) but also declare a complete list of dependencies (relying only on Python standard libraries, including `argparse`, `inspect`, `functools`, `datetime`, `gettext`, `textwrap`, `os`, `sys`, `re`, `time`, `shlex`, `subprocess`, `multiprocessing`, `threading`, `signal`, `queue`, `Tkinter`/`tkinter`, `ScrolledText`, `imp`/`importlib` and other core libraries). The `setup.py` file should be able to verify the normal operation of all functional modules. Additionally, `plac.py` should be provided as a unified API entry point, importing core functions such as `call`, `pos`, `opt`, `flg` from the `plac_core` and `plac_ext` modules, exporting classes such as `Interpreter`, `TaskManager`, `Monitor`, `TkMonitor`, and providing version information, allowing users to access all major functions through a simple "import plac" statement. In `plac_core.py`, there should be a `call()` function to parse command-line arguments using various strategies and call the specified function. The `opt()` function serves as a decorator for optional parameters (used in `test_plac.py` to test optional parameter parsing), the `flg()` function serves as a decorator for flag parameters (used in `test_plac.py` to test flag parameter parsing), the `annotations()` function serves as a complete annotation decorator (used in `test_plac.py` to test complex parameter annotations), and the `parser_from()` function is used to create a parser from a function (used in `test_plac.py` to create a test parser). Under `plac.py`, `import plac` is required to import the main module for testing basic functions, and `import plac_core` is required to directly access core functions for testing. Core classes include `Interpreter` as an interactive interpreter class providing REPL functionality, `TaskManager` as a task management class for managing long-running tasks, `Monitor` as a task monitoring class for monitoring task execution status, `TkMonitor` as a GUI monitoring interface class providing graphical interface monitoring, `ArgumentParser` as an extended parameter parser class, and `Annotation` as a class for storing parameter metadata.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.11

### Core Dependency Library Versions

```Plain
exceptiongroup    1.3.0
iniconfig         2.1.0
packaging         25.0
pip               23.0.1
pluggy            1.6.0
Pygments          2.19.2
pytest            8.4.1
setuptools        65.5.1
tomli             2.2.1
typing_extensions 4.14.1
wheel             0.40.0
```

## Plac Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .gitignore
├── .travis.yml
├── CHANGES.md
├── LICENSE.txt
├── MANIFEST.in
├── Makefile
├── README.md
├── RELEASE.md
├── doc
│   ├── 3.13
│   │   ├── example10.help
│   │   ├── example11.help
│   │   ├── example12.help
│   │   ├── example13.help
│   │   ├── example14.help
│   │   ├── example15.help
│   │   ├── example16.help
│   │   ├── example3.help
│   │   ├── example5.help
│   │   ├── example6.help
│   │   ├── example7.help
│   │   ├── example7_.help
│   │   ├── example8.help
│   │   ├── example8_.help
│   │   ├── example9.help
│   │   ├── example_all.help
│   ├── annotations.py
│   ├── conf.py
│   ├── dry_run.py
│   ├── example1.py
│   ├── example10.help
│   ├── example10.py
│   ├── example11.help
│   ├── example11.py
│   ├── example12.help
│   ├── example12.py
│   ├── example13.help
│   ├── example13.py
│   ├── example14.help
│   ├── example14.py
│   ├── example15.help
│   ├── example15.py
│   ├── example16.help
│   ├── example16.py
│   ├── example2.py
│   ├── example3.help
│   ├── example3.py
│   ├── example4.py
│   ├── example5.help
│   ├── example5.py
│   ├── example5_.py
│   ├── example6.help
│   ├── example6.py
│   ├── example7.help
│   ├── example7.py
│   ├── example7_.help
│   ├── example7_.py
│   ├── example8.help
│   ├── example8.py
│   ├── example8_.help
│   ├── example8_.py
│   ├── example9.help
│   ├── example9.py
│   ├── example_all.help
│   ├── example_all.py
│   ├── generate_help.py
│   ├── importer1.py
│   ├── importer2.py
│   ├── importer3.py
│   ├── importer_ui.py
│   ├── index.rst
│   ├── ishelve.help
│   ├── ishelve.plac
│   ├── ishelve.placet
│   ├── ishelve.py
│   ├── ishelve2.hel
│   ├── ishelve2.plac
│   ├── ishelve2.placet
│   ├── ishelve2.py
│   ├── ishelve3.py
│   ├── picalculator.py
│   ├── plac.el
│   ├── plac_adv.rst
│   ├── plac_core.rst
│   ├── read_stdin.py
│   ├── server_ex.py
│   ├── tkmon.py
│   ├── vcs.help
│   ├── vcs.py
├── plac.py
├── plac_core.py
├── plac_ext.py
├── plac_runner.py
├── plac_tk.py
├── setup.cfg
└── setup.py

```

## API Usage Guide

### Core API

#### 1. Module Import

```python
import plac
import plac_core
from plac import (
    call, pos, opt, flg, annotations,
    Interpreter, TaskManager, Monitor, TkMonitor,
    runp, import_main, default_help
)
from plac_ext import (
    import_main, ReadlineInput, Interpreter,
    stdout, runp, Monitor, default_help
)
from plac_tk import TkMonitor

from plac_ext import Monitor, TerminatedProcess
from annotations import Positional
import plac; plac.call(main)
import plac; plac.Interpreter.call(ShelveInterface)
import plac, time
```

#### 2. call() Function - Main Invocation Interface

**Function**: Parse command-line arguments and call the specified function, class, or module.

**Function Signature**:
```python
def call(
    obj,
    arglist=None,
    eager=True,
    version=None
) -> Any:
```

**Parameter Description**:
- `obj`: The object to be called (function, class, module, or generator function)
- `arglist` (list, optional): List of arguments, defaulting to `sys.argv[1:]`
- `eager` (bool): Whether to execute immediately, defaulting to `True`
- `version` (str, optional): Version information for generating help documentation

**Return Value**: The result of the function execution or a generator object

#### 3. pos() Function - Positional Parameter Decorator

**Function**: Define positional parameters, which must be provided in order.

**Function Signature**:
```python
def pos(
    arg,
    help=None,
    type=None,
    choices=None,
    metavar=None
) -> callable:
```

**Parameter Description**:
- `arg` (str): Parameter name
- `help` (str, optional): Help documentation
- `type` (type, optional): Parameter type conversion function
- `choices` (list, optional): List of optional values
- `metavar` (str, optional): Parameter display name

#### 4. opt() Function - Optional Parameter Decorator

**Function**: Define optional parameters, using the `--` or `-` prefix.

**Function Signature**:
```python
def opt(
    arg,
    help=None,
    type=None,
    abbrev=None,
    choices=None,
    metavar=None
) -> callable:
```

**Parameter Description**:
- `arg` (str): Parameter name
- `help` (str, optional): Help documentation
- `type` (type, optional): Parameter type conversion function
- `abbrev` (str, optional): Short name (defaulting to the first letter of the parameter)
- `choices` (list, optional): List of optional values
- `metavar` (str, optional): Parameter display name

#### 5. flg() Function - Flag Parameter Decorator

**Function**: Define boolean flag parameters, which are switch options that do not require a value.

**Function Signature**:
```python
def flg(
    arg,
    help=None,
    abbrev=None
) -> callable:
```

**Parameter Description**:
- `arg` (str): Parameter name
- `help` (str, optional): Help documentation
- `abbrev` (str, optional): Short name (defaulting to the first letter of the parameter)

#### 9. Additional Core Functions

#### getargspec() Function
**Function Signature**:
```python
def getargspec(callableobj)
```

**Functionality**:
Given a callable return an object with attributes .args, .varargs, .varkw, .defaults. It tries to do the "right thing" with functions, methods, classes and generic callables.

#### to_date() Function
**Function Signature**:
```python
def to_date(s)
```

**Functionality**:
Convert string to date object. Returns year-month-day format.

#### to_datetime() Function
**Function Signature**:
```python
def to_datetime(s)
```

**Functionality**:
Convert string to datetime object. Returns year-month-day hour-minute-second format.

#### is_annotation() Function
**Function Signature**:
```python
def is_annotation(obj)
```

**Functionality**:
Check if an object is a plac annotation.

#### pconf() Function
**Function Signature**:
```python
def pconf(obj)
```

**Functionality**:
Parse configuration from object.

#### iterable() Function
**Function Signature**:
```python
def iterable(obj)
```

**Functionality**:
Check if an object is iterable.

#### _annotate() Function
**Function Signature**:
```python
def _annotate(arg, ann, f)
```

**Functionality**:
Internal function to annotate function arguments.

#### _extract_kwargs() Function
**Function Signature**:
```python
def _extract_kwargs(args)
```

**Functionality**:
Extract keyword arguments from argument list.

#### _match_cmd() Function
**Function Signature**:
```python
def _match_cmd(abbrev, commands, case_sensitive=True)
```

**Functionality**:
Match command abbreviation to full command name.


#### VCS Functions

#### checkout() Function
**Function Signature**:
```python
def checkout(url)
```

**Functionality**:
Version control checkout operation.

#### commit() Function
**Function Signature**:
```python
def commit(message)
```

**Functionality**:
Version control commit operation.

#### __missing__() Function
**Function Signature**:
```python
def __missing__(name)
```

**Functionality**:
Handle missing attributes in VCS operations.

#### __exit__() Function
**Function Signature**:
```python
def __exit__(etype, exc, tb)
```

**Functionality**:
Context manager exit method for VCS operations.

#### Additional Utility Functions

#### create_help() Function
**Function Signature**:
```python
def create_help(name)
```

**Functionality**:
Create help documentation for a given name.

#### taskwidget() Function
**Function Signature**:
```python
def taskwidget(root, task, tick=500)
```

**Functionality**:
Create a task widget for GUI monitoring.

#### show_outlist() Function
**Function Signature**:
```python
def show_outlist()
```

**Functionality**:
Display output list in GUI.

#### check_script() Function
**Function Signature**:
```python
def check_script(args)
```

**Functionality**:
Check script execution with given arguments.

#### Test Runner Functions

#### test1() Function
**Function Signature**:
```python
def test1()
```

**Functionality**:
Test function for runp functionality.

#### test2() Function
**Function Signature**:
```python
def test2()
```

**Functionality**:
Additional test function for runp functionality.

#### gen() Function
**Function Signature**:
```python
def gen(n)
```

**Functionality**:
Generator function for testing purposes.

#### err() Function
**Function Signature**:
```python
def err()
```

**Functionality**:
Error generation function for testing.

### Extended Functions and Classes

#### Extended Utility Functions

#### decode() Function
**Function Signature**:
```python
def decode(val)
```

**Functionality**:
Decode an object assuming the encoding is UTF-8.

#### stdout() Function
**Function Signature**:
```python
def stdout(fileobj)
```

**Functionality**:
Context manager for redirecting stdout to a file object.

#### write() Function
**Function Signature**:
```python
def write(x)
```

**Functionality**:
Write output to stdout.

#### gen_val() Function
**Function Signature**:
```python
def gen_val(value)
```

**Functionality**:
Generate value for task output.

#### gen_exc() Function
**Function Signature**:
```python
def gen_exc(etype, exc, tb)
```

**Functionality**:
Generate exception information for task output.

#### less() Function
**Function Signature**:
```python
def less(text)
```

**Functionality**:
Display text using a pager-like interface.

#### terminatedProcess() Function
**Function Signature**:
```python
def terminatedProcess(signum, frame)
```

**Functionality**:
Signal handler for terminated processes.

#### read_line() Function
**Function Signature**:
```python
def read_line(stdin, prompt='')
```

**Functionality**:
Read a single line from stdin with optional prompt.

#### read_long_line() Function
**Function Signature**:
```python
def read_long_line(stdin, terminator)
```

**Functionality**:
Read multiple lines until terminator is found.

#### format_help() Function
**Function Signature**:
```python
def format_help(self)
```

**Functionality**:
Format help text for display.

#### partial_call() Function
**Function Signature**:
```python
def partial_call(factory, arglist)
```

**Functionality**:
Create a partial function call with given arguments.

#### sharedattr() Function
**Function Signature**:
```python
def sharedattr(name, on_error)
```

**Functionality**:
Create shared attribute for multiprocessing tasks.

**Methods**:
- `get(self)`: Get shared attribute value
- `set(self, value)`: Set shared attribute value

### Extended Classes

#### TerminatedProcess Class

**Function**: Exception class for terminated processes.

```python
class TerminatedProcess(Exception):
```

**Functionality**:
Raised when a process is terminated unexpectedly.

#### ReadlineInput Class

**Function**: Enhanced input handling with readline support.

```python
class ReadlineInput:
    def __init__(self, completions, case_sensitive=True, histfile=None):
    def __enter__(self):
    def __exit__(self, etype, exc, tb):
    def complete(self, kw, state):
    def readline(self, prompt=''):
    def __iter__(self):
```

**Functionality**:
Provides enhanced command-line input with completion and history support.

#### Process Class

**Function**: Enhanced subprocess management.

```python
class Process(subprocess.Popen):
    def __init__(self, params):
    def close(self):
    def recv(self):
    def send(self, line):
```

**Functionality**:
Extended subprocess.Popen with additional communication methods.

#### 6. annotations() Function - Complete Annotation Decorator

**Function**: Define complete parameter annotations in tuple form.

**Function Signature**:
```python
def annotations(**annotations) -> callable:
```

**Parameter Format**:
```python
@plac.annotations(
    param_name=(help, kind, abbrev, type, choices, metavar)
)
```

**Parameter Description**:
- `help` (str): Help documentation
- `kind` (str): Parameter type ('positional', 'option', 'flag')
- `abbrev` (str, optional): Short name
- `type` (type, optional): Type conversion function
- `choices` (list, optional): List of optional values
- `metavar` (str, optional): Display name

#### 7 parser_from
**Function Signature**:
```python
def parser_from(obj, **confparams)
```

**Functionality**:
Creates an `ArgumentParser` from a callable or an object with a `.commands` attribute. This is the main entry point for creating command-line interfaces with PLAC.

**Parameters**:
- `obj`: A callable object (function, method, or class with `__call__`) or an object with a `.commands` attribute
- `**confparams`: Additional configuration parameters passed to the `ArgumentParser` constructor

**Returns**:
An instance of `plac.ArgumentParser` configured based on the input object's annotations and docstring.

**Example**:
```python
import plac

def main(name: str, age: int = 25):
    """A simple greeting program."""
    print(f"Hello {name}, you are {age} years old.")

if __name__ == '__main__':
    parser = plac.parser_from(main)
    args = parser.parse_args()
    plac.call(main, args)
```

---

#### 8 call
**Function Signature**:
```python
def call(obj, arglist=None, eager=True, version=None)
```

**Functionality**:
Parses command-line arguments and calls the given callable with the parsed arguments.

**Parameters**:
- `obj`: A callable or an object with a `.commands` attribute
- `arglist`: List of command-line arguments (defaults to `sys.argv[1:]`)
- `eager`: If True, immediately execute the command (default: True)
- `version`: Version string to display with `--version` flag

**Returns**:
The result of calling the function with parsed arguments.

---


### Detailed Explanation of Configuration Classes

#### 1. Annotation Class

**Function**: Store complete metadata information about parameters.

```python
class Annotation:
    def __init__(
        self,
        help=None,
        kind="positional",
        abbrev=None,
        type=None,
        choices=None,
        metavar=None
    ):
```

**Parameter Description**:
- `help` (str): Help documentation
- `kind` (str): Parameter type ('positional', 'option', 'flag')
- `abbrev` (str): Short name
- `type` (type): Type conversion function
- `choices` (list): List of optional values
- `metavar` (str): Display name

**Methods**:
- `from_(cls, obj)`: Class method to create annotation from object

#### 2. ArgumentParser Class

**Function**: An extended `ArgumentParser` that supports function calls and subcommands.

```python
class ArgumentParser(argparse.ArgumentParser):
    def __init__(self, *args, **kwargs):
```

**Main Methods**:
- `populate_from(func)`: Populate parameters from a function
- `addsubcommands(commands, obj, title=None, cmdprefix='')`: Add subcommands
- `consume(args)`: Consume the argument list
- `alias(arg)`: Create alias for argument
- `_extract_subparser_cmd(arglist)`: Extract subparser command from argument list
- `_set_func_argspec(obj)`: Set function argument specification
- `missing(name)`: Handle missing command
- `print_actions()`: Print available actions

#### 3. Missing Core Classes

#### HelpSummary Class

**Function**: Manage help summary information for commands.

```python
class HelpSummary:
    def __init__(self):
    def add(cls, obj, specialcommands):
    def write(self, s):
    def __str__(self):
```

#### PlacFormatter Class

**Function**: Custom formatter for plac help output.

```python
class PlacFormatter(argparse.RawDescriptionHelpFormatter):
    def _metavar_formatter(self, action, default_metavar):
```

#### StartStopObject Class

**Function**: Base class for objects that can be started and stopped.

```python
class StartStopObject:
    def start(self):
    def stop(self):
```

#### Process Class

**Function**: Subprocess management class that extends subprocess.Popen.

```python
class Process(subprocess.Popen):
    def __init__(self, params):
    def close(self):
    def recv(self):
    def send(self, line):
```

**Methods**:
- `__init__(self, params)`: Initialize process with parameters
- `close(self)`: Close process and cleanup
- `recv(self)`: Receive data from process
- `send(self, line)`: Send line to process

#### ReadlineInput Class

**Function**: Enhanced input handling with readline support and completion.

```python
class ReadlineInput(object):
    def __init__(self, completions, case_sensitive=True, histfile=None):
    def __enter__(self):
    def __exit__(self, etype, exc, tb):
    def complete(self, kw, state):
    def readline(self, prompt=''):
    def __iter__(self):
```

**Methods**:
- `__init__(self, completions, case_sensitive=True, histfile=None)`: Initialize with completions
- `__enter__(self)`: Context manager entry
- `__exit__(self, etype, exc, tb)`: Context manager exit
- `complete(self, kw, state)`: Completion function
- `readline(self, prompt='')`: Read line with prompt
- `__iter__(self)`: Iterator interface

#### TerminatedProcess Exception

**Function**: Exception class for terminated processes.

```python
class TerminatedProcess(Exception):
    pass
```

#### _TaskLauncher Class

**Function**: Internal class for launching tasks in different modes.

```python
class _TaskLauncher (object):
    def __init__(self, genseq, mode):
    def rungen(self, i):
```

#### PlacTestFormatter Class

**Function**: Test formatter class for plac help output formatting in tests.

```python
class PlacTestFormatter(argparse.RawDescriptionHelpFormatter):
```

#### Cmds Class

**Function**: Command management class for testing command functionality.

```python
class Cmds(object):
    add_help = False
    commands = 'help', 'commit'

    def help(self, name):
    def commit(self):
```

#### FakeImporter Class

**Function**: Mock importer class used in examples and tests for demonstrating file import functionality.

```python
class FakeImporter(object):
    commands = ['import_file']
    def __init__(self, dsn):
    def import_file(self, fname):
```

#### PiCalculator Class

**Function**: Pi calculation class demonstrating multiprocessing task execution.

```python
class PiCalculator(object):
    def __init__(self, npoints, mode):
    def submit_tasks(self):
    def close(self):
    def calc_pi(self, npoints):
    def run(self):
```

### Practical Usage Modes

#### Basic Usage

```python
import plac

def main(dsn, table='product', verbose=False):
    "Do something on the database"
    if verbose:
        print(f"Connecting to {dsn}")
    print(f"Working on table: {table}")

if __name__ == '__main__':
    plac.call(main)
```

#### Decorator Usage

```python
import plac

@plac.pos('dsn', "Database connection string")
@plac.opt('table', "Table name", type=str)
@plac.flg('verbose', "Verbose output", abbrev='v')
def main(dsn, table='product', verbose=False):
    "Do something on the database"
    if verbose:
        print(f"Connecting to {dsn}")
    print(f"Working on table: {table}")

if __name__ == '__main__':
    plac.call(main)
```

#### Complete Annotation Usage

```python
import plac

@plac.annotations(
    dsn=("Database connection string", 'positional', None, str),
    table=("Table name", 'option', 't', str),
    verbose=("Verbose output", 'flag', 'v')
)
def main(dsn, table='product', verbose=False):
    "Do something on the database"
    if verbose:
        print(f"Connecting to {dsn}")
    print(f"Working on table: {table}")

if __name__ == '__main__':
    plac.call(main)
```

#### Interactive Mode

```python
import plac

class Calculator:
    def add(self, a, b):
        "Add two numbers"
        return a + b
    
    def mul(self, a, b):
        "Multiply two numbers"
        return a * b
    
    def quit(self):
        "Exit the calculator"
        raise plac.Interpreter.Exit

if __name__ == '__main__':
    i = plac.Interpreter(Calculator())
    i.interact()
```

### Complete Interpreter Class Methods

The `Interpreter` class provides the following complete method set:
```python
class Interpreter(object):
    """
        A context manager with a .send method and a few utility methods:
    execute, test and doctest.
    """
```
**Initialization and Setup**:
- `__init__(self, obj, commentchar='#', split=shlex.split)`: Initialize interpreter
- `_set_commands(self, obj)`: Set available commands from object
- `__enter__(self)`: Context manager entry
- `__exit__(self, exctype, exc, tb)`: Context manager exit

**Task Management**:
- `submit(self, line)`: Submit command line for execution
- `send(self, line)`: Send command to interpreter
- `tasks(self)`: Get list of current tasks
- `close(self, exctype=None, exc=None, tb=None)`: Close interpreter

**Interactive Features**:
- `_make_interpreter(self)`: Create internal interpreter
- `check(self, given_input, expected_output)`: Check input/output for testing
- `_parse_doctest(self, lineiter)`: Parse doctest format
- `doctest(self, lineiter, verbose=False)`: Run doctest
- `execute(self, lineiter, verbose=False)`: Execute command lines
- `multiline(self, stdin=sys.stdin, terminator=';', verbose=False)`: Multi-line input mode
- `interact(self, stdin=sys.stdin, prompt='i> ', verbose=False)`: Interactive mode
- `_manage_input(self)`: Manage input processing

**Server and Monitoring**:
- `start_server(self, port=2199, **kw)`: Start network server
- `add_monitor(self, mon)`: Add task monitor
- `del_monitor(self, name)`: Remove task monitor

**Class Methods**:
- `call(cls, factory, arglist=sys.argv[1:], commentchar='#', split=shlex.split, stdin=sys.stdin, prompt='i> ', verbose=False)`: Class method to create and run interpreter

#### Task Management Mode

```python
import plac
import time

def long_task(duration, name="Task"):
    "Execute a long-running task"
    for i in range(duration):
        yield f"{name}: Progress {i+1}/{duration}"
        time.sleep(1)
    yield f"{name}: Completed!"

if __name__ == '__main__':
    tm = plac.TaskManager(long_task)
    
    # Submit multiple tasks
    tm.submit("5 Task1")
    tm.submit("3 Task2")
    
    # Check task status
    tm.list()
    
    # Get task output
    tm.output(1)
```

### Complete TaskManager Class Methods

The `TaskManager` class provides the following complete method set:

```python
class TaskManager(object):
    """
    Store the given commands into a task registry. Provides methods to
    manage the submitted tasks.
    """
```
**Initialization and Cleanup**:
- `__init__(self, obj)`: Initialize task manager with callable object
- `close(self)`: Close task manager and cleanup resources

**Task Management**:
- `_get_latest(self, taskno=-1, status=None)`: Get latest task with optional filtering
- `kill(self, taskno=-1)`: Kill specified task( under decorator @plac_core.annotations(
        taskno=('task to kill', 'positional', None, int)))
- `list(self, status='RUNNING')`: List tasks with specified status(under decorator  @plac_core.annotations(
        status=('', 'positional', None, str, BaseTask.STATES)))
- `output(self, taskno=-1, fname=None)`: Get task output, optionally save to file(under decorator     @plac_core.annotations(
        taskno=('task number', 'positional', None, int)))
- `last_tb(self, taskno=-1)`: Get last traceback for specified task (under decorator     @plac_core.annotations(taskno=('task number', 'positional', None, int)))

### Constants and Configuration

#### Core Constants

- `NONE`: Constant representing None value in plac_core
- `PARSER_CFG`: Parser configuration constant in plac_core

```python
NONE = object()  # sentinel use to signal the absence of a default

PARSER_CFG = getfullargspec(argparse.ArgumentParser.__init__).args[1:]
```


#### Type Aliases and Variables

- `_parser_registry`: Parser registry dictionary for managing parsers


### Supported Parameter Types

- **Basic Types**: Strings, integers, floating-point numbers, booleans, dates, date-times
- **Complex Types**: File paths, lists, tuples, dictionaries, sets
- **Custom Types**: Support for custom type conversion functions

### Error Handling

The system provides a comprehensive error handling mechanism:
- **Parameter Validation Errors**: Automatically display information about failed type conversions and available options
- **Execution Errors**: Capture and display function execution exceptions and task execution failure information
- **Debug Mode**: Support enabling a debug mode for detailed error tracking

### Important Notes

1. **Function Signature Requirements**: Parameter names must match those in the decorators, and default values must be defined in the function signature.
2. **Decorator Order**: Decorators are applied in bottom-up order, and `@plac.annotations()` should be the innermost decorator.
3. **Compatibility Considerations**: Support all versions from Python 2.6 to Python 3. Use `from __future__ import print_function` to ensure compatibility.
4. **Performance Optimization**: Use generator functions to support long-running tasks. The multi-process mode is suitable for CPU-intensive tasks.
5. **Security Considerations**: Avoid performing dangerous operations in interactive mode. Use `shlex.split()` to safely parse command lines.

## Detailed Functional Implementation Nodes

### Node 1: Function Signature Parser

**Function Description**: Automatically extract parameter information from functions, methods, and classes, support compatibility handling from Python 2.6 to Python 3, and implement intelligent parameter type inference and default value extraction.

**Core Algorithm**:
- Use `inspect.getfullargspec` to obtain the complete parameter specification
- Automatically identify positional parameters, keyword parameters, and variable parameters
- Support parsing of function annotations and type hints
- Handle Python 2/3 compatibility issues

**Input/Output Example**:

```python
from plac import call, pos, opt, flg

def main(dsn, table='product', verbose=False):
    "Do something on the database"
    print(f"DSN: {dsn}, Table: {table}, Verbose: {verbose}")

if __name__ == '__main__':
    # Automatically parse the function signature and generate the command-line interface
    call(main)
    
# Command-line Usage:
# python script.py "postgresql://localhost/db" --table users --verbose
# Output: DSN: postgresql://localhost/db, Table: users, Verbose: True
```

### Node 2: Decorator Annotation System

**Function Description**: Provide flexible parameter annotation decorators, supporting precise control of positional parameters, optional parameters, and flag parameters, including functions such as help documentation, type conversion, and option restrictions.

**Core Algorithm**:
- Implement the three core decorators `pos()`, `opt()`, `flg()`
- Support storage of parameter metadata (help, kind, abbrev, type, choices, metavar)
- Automatically generate short names and help documentation
- Perform parameter validation and type conversion

**Input/Output Example**:

```python
from plac import pos, opt, flg

@pos('model', "Model name", choices=['A', 'B', 'C'])
@opt('output_dir', "Output directory", type=str, abbrev='o')
@opt('n_iter', "Number of iterations", type=int, abbrev='n')
@flg('debug', "Enable debug mode", abbrev='d')
def train_model(model, output_dir='.', n_iter=100, debug=False):
    "Train a machine learning model"
    print(f"Training {model} for {n_iter} iterations")
    if debug:
        print("Debug mode enabled")

if __name__ == '__main__':
    call(train_model)
    
# Command-line Usage:
# python script.py A --output-dir /tmp --n-iter 200 --debug
# Output: Training A for 200 iterations
#       Debug mode enabled
```

### Node 3: Intelligent Help Generator

**Function Description**: Automatically generate detailed command-line help documentation, including parameter descriptions, usage examples, and type information, supporting multiple languages and custom formatting.

**Core Algorithm**:
- Extract help information from the function docstring
- Automatically format parameter descriptions and examples
- Support custom help templates
- Generate help documentation conforming to the `argparse` standard

**Input/Output Example**:

```python
from plac import call, annotations

@annotations(
    dsn=("Database connection string", 'positional', None, str),
    table=("Table name", 'option', 't', str),
    verbose=("Verbose output", 'flag', 'v')
)
def main(dsn, table='product', verbose=False):
    """
    Process database operations
    
    This script connects to a database and performs operations
    on the specified table.
    
    Examples:
        python script.py "postgresql://localhost/db" --table users
        python script.py "mysql://localhost/db" --verbose
    """
    pass

if __name__ == '__main__':
    call(main)
    
# Command-line Usage:
# python script.py --help
# Output: usage: script.py [-h] [-t TABLE] [-v] dsn
# 
# Process database operations
# 
# positional arguments:
#   dsn                   Database connection string
# 
# optional arguments:
#   -h, --help            show this help message and exit
#   -t TABLE, --table TABLE
#                         Table name
#   -v, --verbose         Verbose output
```

### Node 4: Interactive Interpreter Engine

**Function Description**: Provide an interactive command-line environment, supporting command execution, task management, multi-line input, and doctest mode, and implementing complete REPL functionality.

**Core Algorithm**:
- Implement a command parsing and distribution mechanism
- Support multi-line input and command history
- Integrate a task management system
- Provide doctest and server modes

**Input/Output Example**:

```python
from plac import Interpreter

class Calculator:
    def add(self, a, b):
        "Add two numbers"
        result = a + b
        yield f"{a} + {b} = {result}"
    
    def mul(self, a, b):
        "Multiply two numbers"
        result = a * b
        yield f"{a} * {b} = {result}"
    
    def quit(self):
        "Exit the calculator"
        raise Interpreter.Exit

if __name__ == '__main__':
    i = Interpreter(Calculator())
    i.interact()
    
# Interactive Session:
# i> add 5 3
# 5 + 3 = 8
# i> mul 4 7
# 4 * 7 = 28
# i> quit
# Exit the program
```

### Node 5: Task Management System

**Function Description**: Manage long-running tasks, supporting three execution modes: synchronous, threaded, and multi-process. Provide task status tracking, output capture, and error handling functions.

**Core Algorithm**:
- Implement the `BaseTask`, `SynTask`, `ThreadedTask`, `MPTask` classes
- Manage task status (SUBMITTED, RUNNING, FINISHED, etc.)
- Capture output streams and handle errors
- Manage the task lifecycle

### Complete Task Class Hierarchy

#### BaseTask Class Methods
```python
class BaseTask(object):
    """
    A task is a wrapper over a generator object with signature
    Task(no, arglist, genobj), attributes
    .no
    .arglist
    .outlist
    .str
    .etype
    .exc
    .tb
    .status
    and methods .run and .kill.
    """
    STATES = ('SUBMITTED', 'RUNNING', 'TOBEKILLED',  'KILLED', 'FINISHED',
              'ABORTED')

```

**Initialization and Setup**:
- `__init__(self, no, arglist, genobj)`: Initialize base task
- `notify(self, msg)`: Send notification message
- `_wrap(self, genobj, stringify_tb=False)`: Wrap generator object
- `_regular_exit(self)`: Handle regular task exit

**Execution Control**:
- `run(self)`: Execute the task
- `kill(self)`: Terminate the task
- `wait(self)`: Wait for task completion

**Status and Results**:
- `traceback(self)`: Get task traceback information
- `result(self)`: Get task result.(under decorator @property)
- `__repr__(self)`: String representation of task

#### SynTask Class Methods
```python
class SynTask(BaseTask):
    """
    A task that runs synchronously, i.e., the generator object is
    called in the same thread as the task object.
    """
```

**Synchronous Task Implementation**:
- `__str__(self)`: String representation for synchronous tasks

#### ThreadedTask Class Methods

```python
class ThreadedTask(BaseTask):
    """
    A task running in a separated thread.
    """
```

**Threaded Task Implementation**:
- `__init__(self, no, arglist, genobj)`: Initialize threaded task
- `run(self)`: Execute task in thread
- `wait(self)`: Wait for thread completion

#### MPTask Class Methods
```python
class MPTask(BaseTask):
    """
    A task running as an external process. The current implementation
    only works on Unix-like systems, where multiprocessing use forks.
    """
    str = sharedattr('str', '')
    etype = sharedattr('etype', None)
    exc = sharedattr('exc', None)
    tb = sharedattr('tb', None)
    status = sharedattr('status', 'ABORTED')
```
**Multiprocess Task Implementation**:
- `__init__(self, no, arglist, genobj, manager)`: Initialize multiprocess task
- `outlist(self)`: Get output list for multiprocess task
- `notify(self, msg)`: Send notification in multiprocess context
- `run(self)`: Execute task in separate process
- `wait(self)`: Wait for process completion
- `kill(self)`: Terminate process

**Input/Output Example**:

```python
from plac import TaskManager
import time

def long_task(duration, name="Task"):
    "Execute a long-running task with progress updates"
    for i in range(duration):
        yield f"{name}: Progress {i+1}/{duration}"
        time.sleep(1)
    yield f"{name}: Completed!"

if __name__ == '__main__':
    tm = TaskManager(long_task)
    
    # Submit multiple tasks
    tm.submit("5 Task1")
    tm.submit("3 Task2")
    
    # Check task status
    tm.list()
    
    # Get task output
    for task in tm.tasks():
        print(f"Task {task.no}: {task.result}")
    
# Output:
# Task 1: Task1: Progress 1/5
# Task 1: Task1: Progress 2/5
# ...
# Task 1: Task1: Completed!
# Task 2: Task2: Progress 1/3
# ...
```

### Node 6: Multiprocessing Execution Engine

**Function Description**: Support multi-process parallel task execution, implementing inter-process communication, resource management, and load balancing, suitable for CPU-intensive tasks.

#### runp() Function
**Function Signature**:
```python
def runp(genseq, mode='p')
```

**Parameters**:
- `genseq`: A sequence of generator functions to run in parallel
- `mode` (str): Execution mode - 'p' for processes (default), 't' for threads

**Returns**:
A list of task results or exceptions from the parallel execution.

**Core Algorithm**:
- Use the `multiprocessing` module to implement a process pool
- Implement an inter-process queue communication mechanism
- Manage shared attributes (str, etype, exc, tb, status)
- Control the process lifecycle

**Input/Output Example**:

```python
from plac import runp

def worker(worker_id):
    "Worker process that performs calculations"
    import time
    for i in range(5):
        yield f"Worker {worker_id}: Step {i+1}/5"
        time.sleep(0.5)
    yield f"Worker {worker_id}: Completed"

if __name__ == '__main__':
    # Create multiple worker processes
    workers = [worker(i) for i in range(3)]
    
    # Execute in parallel
    runp(workers, mode='p')
    
# Output:
# Worker 0: Step 1/5
# Worker 1: Step 1/5
# Worker 2: Step 1/5
# Worker 0: Step 2/5
# ...
# Worker 0: Completed
# Worker 1: Completed
# Worker 2: Completed
```

### Node 7: GUI Monitoring Interface

**Function Description**: Provide a Tkinter graphical interface to monitor task execution, displaying task output and status updates in real-time, supporting parallel monitoring of multiple tasks.

**Core Algorithm**:
- Implement the `TkMonitor` class that inherits from `Monitor`
- Use a scrolling text control to display task output
- Implement a mechanism for adding, deleting, and notifying task listeners
- Implement the main loop and queue reading mechanism

### Complete Monitor and Manager Classes

#### Monitor Class Methods
```python
class Monitor(StartStopObject):
    """
    Base monitor class with methods add_listener/del_listener/notify_listener
    read_queue and and start/stop.
    """
```

**Initialization and Control**:
- `__init__(self, name, queue=None)`: Initialize monitor with name and optional queue
- `start(self)`: Start monitoring
- `stop(self)`: Stop monitoring

**Listener Management**:
- `add_listener(self, taskno)`: Add task listener
- `del_listener(self, taskno)`: Remove task listener
- `notify_listener(self, taskno, msg)`: Notify specific listener

**Queue Operations**:
- `read_queue(self)`: Read from monitoring queue

#### Manager Class Methods
```python
class Manager(StartStopObject):
    """
    The plac Manager contains a multiprocessing.Manager and a set
    of slave monitor processes to which we can send commands. There
    is a manager for each interpreter with mpcommands.
    """
```

**Initialization and Control**:
- `__init__(self)`: Initialize manager
- `start(self)`: Start manager
- `stop(self)`: Stop manager

**Monitor Management**:
- `add(self, monitor)`: Add monitor to manager
- `delete(self, name)`: Remove monitor by name

**Listener Operations**:
- `notify_listener(self, taskno, msg)`: Notify listener through manager
- `add_listener(self, no)`: Add listener through manager

**Input/Output Example**:

```python
from plac import Interpreter, TkMonitor
import time

class TaskGenerator:
    def long_task(self, duration):
        "Execute a long task with GUI monitoring"
        for i in range(duration):
            yield f"Progress: {i+1}/{duration}"
            time.sleep(1)
        yield "Task completed!"

if __name__ == '__main__':
    i = Interpreter(TaskGenerator())
    i.add_monitor(TkMonitor("Task Monitor"))
    i.interact()
    
# GUI Interface Display:
# Task 1: Progress: 1/10
# Task 1: Progress: 2/10
# ...
# Task 1: Task completed!
# Update the GUI window in real-time to display task progress
```

### Node 8: Dynamic Module Importer

**Function Description**: Support dynamic import of Python modules and execution of their `main` functions, implementing a plug-in architecture and modular design.

**Core Algorithm**:
- Use `importlib.util` to dynamically load modules
- Be compatible with the module import mechanisms of Python 2/3
- Handle parameter passing and return values
- Handle errors and exceptions

**Input/Output Example**:

```python
from plac import import_main

# Dynamically import the main function from a module
main_func = import_main("my_module.py")

# Content of my_module.py:
def main(param1, param2="default"):
    print(f"Processing {param1} and {param2}")
    return "success"

if __name__ == '__main__':
    import plac
    plac.call(main)

# Now you can use the imported main function
result = plac.call(main_func, ["arg1", "--param2", "value"])

# Output:
# Processing arg1 and value
# result = "success"
```

### Node 9: Parameter Type Converter

**Function Description**: Provide intelligent parameter type conversion, supporting basic types, complex types, and custom types, implementing type validation and error handling.

**Core Algorithm**:
- Built-in type conversion functions (int, float, str, bool, date, datetime)
- Support for custom type converters
- Perform type validation and provide error prompts
- Handle default values and perform type inference

**Input/Output Example**:

```python
from plac import call, opt
from datetime import date

def custom_type(value):
    """Custom type conversion function"""
    if value.startswith('file://'):
        return value[7:]  # Remove the 'file://' prefix
    return value

@opt('input_file', "Input file path", type=custom_type)
@opt('count', "Number of items", type=int)
@opt('start_date', "Start date", type=date)
@opt('debug', "Debug mode", type=bool)
def process_data(input_file, count=10, start_date=None, debug=False):
    print(f"Processing {count} items from {input_file}")
    if start_date:
        print(f"Start date: {start_date}")
    if debug:
        print("Debug mode enabled")

if __name__ == '__main__':
    call(process_data)
    


```

### Node 10: Server Mode Communication Engine

**Function Description**: Implement network server mode, supporting remote command execution, client connection management, and real-time communication functions.

**Core Algorithm**:
- Network communication based on sockets
- Manage multiple client connections
- Implement a command parsing and response mechanism
- Provide security authentication and access control

**Input/Output Example**:

```python
from plac import Interpreter

class RemoteCalculator:
    def add(self, a, b):
        "Remote addition operation"
        result = a + b
        yield f"Remote calculation: {a} + {b} = {result}"
    
    def status(self):
        "Get server status"
        yield "Server is running and ready for connections"

if __name__ == '__main__':
    i = Interpreter(RemoteCalculator())
    i.start_server(port=2199)
    
# Client Connection:
# telnet localhost 2199
# > add 15 25
# Remote calculation: 15 + 25 = 40
# > status
# Server is running and ready for connections
```