## Introduction and Goals of the asteval Project

asteval is a **safe expression evaluator** Python library designed to parse and execute Python expressions in a restricted and secure manner. It is based on Python's AST (Abstract Syntax Tree) module, which converts user-input expressions into ASTs and evaluates them in a custom symbol table and a controlled environment, avoiding the security risks associated with direct use of `eval` or `exec`. This tool supports most Python expression syntax, including arithmetic operations, logical operations, variable assignment, list/dictionary/set operations, function definition and call, control flow (such as if, for, while), exception handling, etc. asteval also allows for the extension of the symbol table, supports custom functions and variables, and can integrate scientific computing libraries like numpy.

## Natural Language Instruction (Prompt)

Please create a Python project named asteval to implement a safe expression evaluation library. The project should include the following features:

1. Expression Parsing and Execution: It should be able to parse input strings into Python Abstract Syntax Trees (ASTs) and safely execute expressions in a controlled environment, supporting operations on common data structures such as variable assignment, arithmetic operations, logical operations, lists, dictionaries, sets, and tuples.

2. Security Mechanisms: Prohibit dangerous operations (such as file system access, system commands, and arbitrary code execution) to prevent security risks caused by user input. Implement symbol table isolation and read-only built-in symbols, and support custom read-only variables and functions.

3. Error Handling and Exception Capture: Capture and record runtime errors (such as ZeroDivisionError, TypeError, NameError, AttributeError, KeyError, ValueError, SyntaxError, NotImplementedError, RecursionError, OverflowError, etc.) and provide a detailed error information interface to facilitate user debugging and problem location.

4. Control Flow Support: Support Python control flow statements such as if, for, while, try/except, try/else/finally, break, continue, assert, and with, and correctly handle nesting and scoping.

5. Function Definition and Call: Support user-defined functions (including functions with default parameters, variable arguments, keyword arguments, and nested functions), allow the registration of custom functions in the symbol table, and support the integration of scientific computing libraries such as numpy/scipy.

6. Compatibility and Extensibility: Support custom symbol tables, extend built-in functions, configure node processors (such as disabling certain syntax nodes), and allow users to flexibly adjust the interpreter's behavior through configuration items.

7. Read-Only Symbols and Built-In Protection: Implement a read-only symbol mechanism to prevent users from modifying key variables and built-in functions, and support the configuration of builtins_readonly and readonly_symbols.

8. Result Return and Symbol Table Management: Return the final result of the expression and support user queries and management of variables and functions in the symbol table.

9. Command Line and Interface Design: Design independent function interfaces for each functional module (such as expression execution, error query, symbol table management, etc.), support terminal calls and automated testing. Each interface should define clear input and output formats.

10. Examples and Test Scripts: Provide typical example code and test cases covering all major functional points, including expression evaluation, error capture, symbol table operations, control flow statements, function definition and call, etc. The test scripts should automatically verify the correctness of all functional modules.

11. Core File Requirements: The project must include a complete pyproject.toml file to configure the project as an installable package (supporting pip install), declare a complete list of dependencies (such as numpy>=1.20.0, numpy_financial>=1.0.0, pytest>=6.0.0, pytest-cov>=2.0.0, coverage>=5.0.0, etc.). The project should include asteval/__init__.py as a unified API entry, exporting core classes and functions such as Interpreter, make_symbol_table, NameFinder, and get_ast_names, and provide version information, allowing users to access all major functions through a simple "from asteval/asteval.astutils import **" statement.In astutilits.cy, a fallback mechanism of attempting to import and failing to downgrade is required to handle numpy errors.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.11.7

### Core Dependency Library Versions

```Plain
iniconfig  2.1.0
numpy      2.3.3
packaging  25.0
pip        23.2.1
pluggy     1.6.0
Pygments   2.19.2
pytest     8.4.1
setuptools 65.5.1
wheel      0.42.0 
```

## asteval Project Architecture

### Project Directory Structure

```python
workspace/
├── .codecov.yml
├── .gitattributes
├── .gitignore
├── INSTALL
├── LICENSE
├── MANIFEST.in
├── README.rst
├── asteval
│   ├── __init__.py
│   ├── asteval.py
│   ├── astutils.py
├── doc
│   ├── Makefile
│   ├── _static
│   │   ├── empty
│   ├── _templates
│   │   ├── indexsidebar.html
│   ├── api.rst
│   ├── basics.rst
│   ├── conf.py
│   ├── index.rst
│   ├── installation.rst
│   ├── motivation.rst
└── pyproject.toml

```

## API Usage Guide

### Core API

#### 1. Core Module Import - Basic Usage

**Function**: Import the main classes and functions from the asteval module for safe expression evaluation.

**Import Signature**:
```python
from asteval import Interpreter, NameFinder, make_symbol_table
from asteval.astutils import get_ast_names
```

#### 2. Interpreter Class

**Function**: Create an Interpreter instance for safe expression evaluation.

**Class Definition**:
```python
from asteval.astutils import Interpreter
class Interpreter:
    """create an asteval Interpreter: a restricted, simplified interpreter
    of mathematical expressions using Python syntax.

    Parameters
    ----------
    symtable : dict or `None`
        dictionary or SymbolTable to use as symbol table (if `None`, one will be created).
    nested_symtable : bool, optional
        whether to use a new-style nested symbol table instead of a plain dict [False]
    user_symbols : dict or `None`
        dictionary of user-defined symbols to add to symbol table.
    writer : file-like or `None`
        callable file-like object where standard output will be sent.
    err_writer : file-like or `None`
        callable file-like object where standard error will be sent.
    use_numpy : bool
        whether to use functions from numpy.
    max_statement_length : int
        maximum length of expression allowed [50,000 characters]
    readonly_symbols : iterable or `None`
        symbols that the user can not assign to
    builtins_readonly : bool
        whether to blacklist all symbols that are in the initial symtable
    minimal : bool
        create a minimal interpreter: disable many nodes (see Note 1).
    config : dict
        dictionary listing which nodes to support (see note 2))

    Notes
    -----
    1. setting `minimal=True` is equivalent to setting a config with the following
       nodes disabled: ('import', 'importfrom', 'if', 'for', 'while', 'try', 'with',
       'functiondef', 'ifexp', 'listcomp', 'dictcomp', 'setcomp', 'augassign',
       'assert', 'delete', 'raise', 'print')
    2. by default 'import' and 'importfrom' are disabled, though they can be enabled.
    """
    def __init__(self, symtable=None, nested_symtable=False,
                 user_symbols=None, writer=None, err_writer=None,
                 use_numpy=True, max_statement_length=50000,
                 minimal=False, readonly_symbols=None,
                 builtins_readonly=False, config=None, **kws):

        self.config = copy.copy(MINIMAL_CONFIG if minimal else DEFAULT_CONFIG)
        if config is not None:
            self.config.update(config)
        self.config['nested_symtable'] = nested_symtable

        if user_symbols is None:
            user_symbols = {}
            if 'usersyms' in kws:
                user_symbols = kws.pop('usersyms') # back compat, changed July, 2023, v 0.9.4

        if len(kws) > 0:
            for key, val in kws.items():
                if key.startswith('no_'):
                    node = key[3:]
                    if node in ALL_NODES:
                        self.config[node] = not val
                elif key.startswith('with_'):
                    node = key[5:]
                    if node in ALL_NODES:
                        self.config[node] = val

        self.writer = writer or stdout
        self.err_writer = err_writer or stderr
        self.max_statement_length = max(1, min(1.e8, max_statement_length))

        self.use_numpy = HAS_NUMPY and use_numpy
        if symtable is None:
            symtable = make_symbol_table(nested=nested_symtable,
                                         use_numpy=self.use_numpy, **user_symbols)

        symtable['print'] = self._printer
        self.symtable = symtable
        self._interrupt = None
        self.error = []
        self.error_msg = None
        self.expr = None
        self.retval = None
        self._calldepth = 0
        self.lineno = 0
        self.code_text = []
        self.start_time = time.time()
        self.node_handlers = {}
        for node in ALL_NODES:
            handler = self.unimplemented
            if self.config.get(node, True):
                handler = getattr(self, f"on_{node}", self.unimplemented)
            self.node_handlers[node] = handler

        self.allow_unsafe_modules = self.config.get('import', False)

        # to rationalize try/except try/finally
        if 'try' in self.node_handlers:
            self.node_handlers['tryexcept'] = self.node_handlers['try']
            self.node_handlers['tryfinally'] = self.node_handlers['try']

        if readonly_symbols is None:
            self.readonly_symbols = set()
        else:
            self.readonly_symbols = set(readonly_symbols)

        if builtins_readonly:
            self.readonly_symbols |= set(self.symtable)

        self.no_deepcopy = [key for key, val in symtable.items()
                            if (callable(val)
                                or inspect.ismodule(val)
                                or 'numpy.lib.index_tricks' in repr(type(val)))]

    def remove_nodehandler(self, node):
        """remove support for a node
        returns current node handler, so that it
        might be re-added with add_nodehandler()
        """


    def set_nodehandler(self, node, handler=None):
        """set node handler or use current built-in default"""


    def user_defined_symbols(self):
        """Return a set of symbols that have been added to symtable after
        construction.

        I.e., the symbols from self.symtable that are not in
        self.no_deepcopy.

        Returns
        -------
        unique_symbols : set
            symbols in symtable that are not in self.no_deepcopy

        """


    def unimplemented(self, node):
        """Unimplemented nodes."""


    def raise_exception(self, node, exc=None, msg='', expr=None, lineno=None):
        """Add an exception."""
       

    # main entry point for Ast node evaluation
    #  parse:  text of statements -> ast
    #  run:    ast -> result
    #  eval:   string statement -> result = run(parse(statement))
    def parse(self, text):
        """Parse statement/expression to Ast representation."""
        

    def run(self, node, expr=None, lineno=None, with_raise=True):
        """Execute parsed Ast representation for an expression."""
        # Note: keep the 'node is None' test: internal code here may run
        #    run(None) and expect a None in return.
        

    def __call__(self, expr, **kw):
        """Call class instance as function."""
        
    def eval(self, expr, lineno=0, show_errors=True, raise_errors=False):
        """Evaluate a single statement."""
        

    @staticmethod
    def dump(node, **kw):
        """Simple ast dumper."""


    # handlers for ast components
    def on_expr(self, node):
        """Expression."""


    # imports
    def on_import(self, node):    # ('names',)
        "simple import"


    def on_importfrom(self, node):    # ('module', 'names', 'level')
        "import/from"


    def import_module(self, name, asname, fromlist=None):
        """import a python module, installing it into the symbol table.
        options:
          name       name of module to import 'foo' in 'import foo'
          asname     alias for imported name(s)
                          'bar' in 'import foo as bar'
                       or
                          ['s','t'] in 'from foo import x as s, y as t'
          fromlist   list of symbols to import with 'from-import'
                         ['x','y'] in 'from foo import x, y'
        """
        # find module in sys.modules or import to it
       
    def on_index(self, node):
        """Index."""


    def on_return(self, node):  # ('value',)
        """Return statement: look for None, return special sentinel."""


    def on_repr(self, node):
        """Repr."""


    def on_module(self, node):    # ():('body',)
        """Module def."""


    def on_expression(self, node):
        "basic expression"


    def on_pass(self, node):
        """Pass statement."""

    def on_ellipsis(self, node):
        """Ellipses.  deprecated in 3.8"""

    # for break and continue: set the instance variable _interrupt
    def on_interrupt(self, node):    # ()
        """Interrupt handler."""

    def on_break(self, node):
        """Break."""


    def on_continue(self, node):
        """Continue."""


    def on_assert(self, node):    # ('test', 'msg')
        """Assert statement."""


    def on_list(self, node):    # ('elt', 'ctx')
        """List."""


    def on_tuple(self, node):    # ('elts', 'ctx')
        """Tuple."""


    def on_set(self, node):    # ('elts')
        """Set."""


    def on_dict(self, node):    # ('keys', 'values')
        """Dictionary."""


    def on_constant(self, node):   # ('value', 'kind')
        """Return constant value."""

    def on_num(self, node):   # ('n',)
        """Return number.  deprecated in 3.8"""

    def on_str(self, node):   # ('s',)
        """Return string.  deprecated in 3.8"""

    def on_bytes(self, node):
        """return bytes.  deprecated in 3.8"""


    def on_joinedstr(self, node):  # ('values',)
        "join strings, used in f-strings"


    def on_formattedvalue(self, node): # ('value', 'conversion', 'format_spec')
        "formatting used in f-strings"


    def _getsym(self, node):


    def on_name(self, node):    # ('id', 'ctx')
        """Name node."""

    def on_nameconstant(self, node):
        """True, False, or None  deprecated in 3.8"""

    def node_assign(self, node, val):
        """Assign a value (not the node.value object) to a node.

        This is used by on_assign, but also by for, list comprehension,
        etc.

        """
        

    def on_attribute(self, node):    # ('value', 'attr', 'ctx')
        """Extract attribute."""


    def on_assign(self, node):    # ('targets', 'value')
        """Simple assignment."""


    def on_augassign(self, node):    # ('target', 'op', 'value')
        """Augmented assign."""


    def on_slice(self, node):    # ():('lower', 'upper', 'step')
        """Simple slice."""


    def on_extslice(self, node):    # ():('dims',)
        """Extended slice."""


    def on_subscript(self, node): # ('value', 'slice', 'ctx')
        """Subscript handling -- one of the tricky parts."""


    def on_delete(self, node):    # ('targets',)
        """Delete statement."""
       
    def on_unaryop(self, node):    # ('op', 'operand')
        """Unary operator."""


    def on_binop(self, node):    # ('left', 'op', 'right')
        """Binary operator."""


    def on_boolop(self, node):    # ('op', 'values')
        """Boolean operator."""

    def on_compare(self, node):  # ('left', 'ops', 'comparators')
        """comparison operators, including chained comparisons (a<b<c)"""

    def _printer(self, *out, **kws):
        """Generic print function."""

    def on_if(self, node):    # ('test', 'body', 'orelse')
        """Regular if-then-else statement."""

    def on_ifexp(self, node):    # ('test', 'body', 'orelse')
        """If expressions."""

    def on_while(self, node):    # ('test', 'body', 'orelse')
        """While blocks."""

    def on_for(self, node):    # ('target', 'iter', 'body', 'orelse')
        """For blocks."""

    def on_with(self, node):    # ('items', 'body', 'type_comment')
        """with blocks."""

    def comprehension_data(self, node): 
        """Return comprehension data."""

    def on_listcomp(self, node):
        """List comprehension v2"""

    def on_setcomp(self, node):
        """Set comprehension"""

    def on_dictcomp(self, node):
        """Dict comprehension v2"""

    def on_excepthandler(self, node):  # ('type', 'name', 'body')
        """Exception handler..."""
        return (self.run(node.type), node.name, node.body)

    def on_try(self, node):    # ('body', 'handlers', 'orelse', 'finalbody')
        """Try/except/else/finally blocks."""


    def on_raise(self, node):    # ('type', 'inst', 'tback')
        """Raise statement: note difference for python 2 and 3."""

    def on_call(self, node):
        """Function execution."""


    def on_arg(self, node):    # ('test', 'msg')
        """Arg for function definitions."""

    def on_functiondef(self, node):
        """Define procedures."""
        # ('name', 'args', 'body', 'decorator_list')

```

#### 3. NameFinder Class

**Function**: Find all symbol names used by a parsed node.

**Class Definition**:
```python
class NameFinder(ast.NodeVisitor):
    """Find all symbol names used by a parsed node."""

    def __init__(self):
        """TODO: docstring in public method."""
        self.names = []
        ast.NodeVisitor.__init__(self)

    def generic_visit(self, node):
        """TODO: docstring in public method."""
        if node.__class__.__name__ == 'Name':
            if node.id not in self.names:
                self.names.append(node.id)
        ast.NodeVisitor.generic_visit(self, node)
```


#### 4. make_symbol_table() Function - Create a Symbol Table

**Import**:
```python
from asteval.astutils import make_symbol_table
```

**Function**: Create a default symbol table with optional NumPy support and custom symbols.

**Function Signature**:
```python
def make_symbol_table(use_numpy=True, nested=False, top=True, **kws) 
```

**Parameter Description**:
- `use_numpy`: Whether to include symbols from NumPy, default is True
- `nested`: Whether to create a nested symbol table instead of a plain dict, default is False
- `top`: Whether this is the top-level table in a nested table, default is True
- `**kws`: Dictionary of user-defined symbols to add to the symbol table

**Return Value**: A symbol table dictionary with built-in functions and optional user symbols

#### 5. Empty Class

**Import**:
```python
from asteval.astutils import Empty
```

**Function**: Create an empty object instance to represent null or undefined states.

**Class Definition**:
```python
class Empty:
    """Empty class."""
    def __init__(self):
        """TODO: docstring in public method."""
        return

    def __nonzero__(self):
        """Empty is TODO: docstring in magic method."""
        return False

    def __repr__(self):
        """Empty is TODO: docstring in magic method."""
        return "Empty"
```

#### 6. ExceptionHolder Class

**Import**:
```python
from asteval.astutils import ExceptionHolder
import ast
```

**Function**: Create an exception holder instance to capture and store runtime exception information from the interpreter.

**Class Definition**:
```python
class ExceptionHolder:
    """Basic exception handler."""
    def __init__(self, node, exc=None, msg='', expr=None, lineno=None):
        """TODO: docstring in public method."""
        self.node = node
        self.expr = expr
        self.msg = msg
        self.exc = exc
        self.lineno = lineno
        self.exc_info = exc_info()
        if self.exc is None and self.exc_info[0] is not None:
            self.exc = self.exc_info[0]
        if self.msg == '' and self.exc_info[1] is not None:
            self.msg = self.exc_info[1]

    def get_error(self):
        """Retrieve error data.
        Return a tuple of the exception name and the error message.
        The exception name is the name of the exception class.
        The error message is the error message of the exception.
        """
```

#### 7. Group Class

**Import**:
```python
from asteval.astutils import Group

```

**Function**: Create a group object that can be accessed both as a dictionary and object attributes.

**Class Definition**:
```python
class Group(dict):
    """
    Group: a container of objects that can be accessed either as an object attributes
    or dictionary  key/value.  Attribute names must follow Python naming conventions.
    """
    def __init__(self, name=None, searchgroups=None, **kws):
        if name is None:
            name = hex(id(self))
        self.__name__ = name
        dict.__init__(self, **kws)
        self._searchgroups = searchgroups

    def __setattr__(self, name, value):
        """Set an attribute."""

    def __getattr__(self, name, default=None):
        """Get an attribute.
        If the attribute is not found, return the default value.
        If the attribute is found, return the value.
        If the attribute is not found and no default value is provided, raise a KeyError.
        """

    def __setitem__(self, name, value):
        """Set an item."""

    def get(self, key, default=None):
        """Get an item.
        If the item is not found, return the default value.
        If the item is found, return the value.
        If the item is not found and no default value is provided, raise a KeyError.
        """



    def __repr__(self):
        """Representation of the Group object.
        Return a string representation of the Group object.
        The string representation is a list of the keys in the Group object.
        """

    def _repr_html_(self):
        """HTML representation for Jupyter notebook"""
        html = [f"<table><caption>Group('{self.__name__}')</caption>",
  "<tr><th>Attribute</th><th>DataType</th><th><b>Value</b></th></tr>"]
        for key, val in self.items():
            html.append(f"""
<tr><td>{key}</td><td><i>{type(val).__name__}</i></td>
    <td>{repr(val):.75s}</td>
</tr>""")
        html.append("</table>")
        return '\n'.join(html)
```

#### 8. Procedure Class

**Import**:
```python
from asteval.astutils import Procedure
from typing import Optional, List, Dict, Any
import ast
```

**Function**: Create user-defined function objects that store parsed AST nodes for later evaluation.

**Class Definition**:
```python
class Procedure:
    """Procedure: user-defined function for asteval.

    This stores the parsed ast nodes as from the 'functiondef' ast node
    for later evaluation.

    """

    def __init__(self, name, interp, doc=None, lineno=0,
                 body=None, args=None, kwargs=None,
                 vararg=None, varkws=None):
        """TODO: docstring in public method."""
        self.__ininit__ = True
        self.name = name
        self.__name__ = self.name
        self.__asteval__ = interp
        self.raise_exc = self.__asteval__.raise_exception
        self.__doc__ = doc
        self.body = body
        self.argnames = args
        self.kwargs = kwargs
        self.vararg = vararg
        self.varkws = varkws
        self.lineno = lineno
        self.__ininit__ = False

    def __setattr__(self, attr, val):
        """Set an attribute."""

    def __dir__(self):
        return ['name']

    def __repr__(self):
        """TODO: docstring in magic method.
        Return a string representation of the Procedure object.
        The string representation is a list of the keys in the Procedure object.
        """
        

    def __call__(self, *args, **kwargs):
        """TODO: docstring in public method.
        Call the Procedure object.
        The Procedure object is called with the given arguments and keyword arguments.
        """

```

#### 9. _open() Function - Safe File Opening

**Import**:
```python
from asteval.astutils import _open
```

**Function**: Provide restricted file opening functionality, supporting only read-only modes.

**Function Signature**:
```python
def _open(filename, mode='r', buffering=-1, encoding=None):
    """read only version of open()"""
```

**Parameter Description**:
- `filename`: File path string
- `mode`: Opening mode, only supports 'r', 'rb', 'rU' (read-only modes)
- `buffering`: Buffer size with maximum limit, default -1 (system default)
- `encoding`: Text encoding method, default None (system default)

**Return Value**: open(filename, mode, buffering, encoding)

---

#### 10. _type() Function - Safe Type Retrieval

**Import**:
```python
from asteval.astutils import _type
from typing import Any
```

**Function**: Get object type name, preventing variable argument attacks.

**Function Signature**:
```python
def _type(obj): 
    """type that prevents varargs and varkws"""
```
**Parameter Description**:
- `obj`: Object to get type information for

**Return Value**: Object type name as string (e.g., 'int', 'str', 'list')

---

#### 11. safe_pow() Function - Safe Power Operation

**Import**:
```python
from asteval.astutils import safe_pow

```

**Function**: Provide safe power operation with exponent size limits to prevent resource exhaustion.

**Function Signature**:
```python
def safe_pow(base, exp):
    """safe version of pow"""
```

**Parameter Description**:
- `base`: Base number (int or float)
- `exp`: Exponent (int or float), limited to MAX_EXPONENT maximum value

**Return Value**: Power operation result (int, float, or complex depending on inputs)

---

#### 12. safe_mult() Function - Safe Multiplication

**Import**:
```python
from asteval.astutils import safe_mult
```

**Function**: Provide safe multiplication operation, preventing string length overflow.

**Function Signature**:
```python
def safe_mult(arg1, arg2):
    """safe version of multiply"""
```

**Parameter Description**:
- `arg1`: First operand (number, string, or sequence)
- `arg2`: Second operand (number, string, or sequence)

**Return Value**: Multiplication result with overflow protection for strings and sequences

---

#### 13. safe_add() Function - Safe Addition

**Import**:
```python
from asteval.astutils import safe_add
```

**Function**: Provide safe addition operation, preventing memory overflow from string concatenation.

**Function Signature**:
```python
def safe_add(arg1, arg2):
    """safe version of add"""
```

**Parameter Description**:
- `arg1`: First operand (number, string, or sequence)
- `arg2`: Second operand (number, string, or sequence)

**Return Value**: Addition result with overflow protection for string concatenation

---

#### 14. safe_lshift() Function - Safe Left Shift

**Import**:
```python
from asteval.astutils import safe_lshift
```

**Function**: Provide safe bit left shift operation with shift size limits.

**Function Signature**:
```python
def safe_lshift(arg1, arg2):
    """safe version of lshift"""
```

**Parameter Description**:
- `arg1`: Integer value to shift
- `arg2`: Number of bits to shift, limited to MAX_SHIFT maximum

**Return Value**: Left shift result (integer)

---


#### 15. valid_symbol_name() Function - Symbol Name Validation

**Import**:
```python
from asteval.astutils import valid_symbol_name
```

**Function**: Validate whether a symbol name is valid and follows Python identifier rules.

**Function Signature**:
```python

def valid_symbol_name(name):
    """Determine whether the input symbol name is a valid name.

    Arguments
    ---------
      name  : str
         name to check for validity.

    Returns
    --------
      valid :  bool
        whether name is a a valid symbol name

    This checks for Python reserved words and that the name matches
    the regular expression ``[a-zA-Z_][a-zA-Z0-9_]``
    """
```

**Parameter Description**:
- `name`: Symbol name string to validate

**Return Value**: Boolean value, True if valid Python identifier and not reserved word

---

#### 16. op2func() Function - Operator to Function

**Import**:
```python
from asteval.astutils import op2func
```

**Function**: Convert AST operator nodes to corresponding functions.

**Function Signature**:
```python
def op2func(oper):
    """Return function for operator nodes."""
```

**Parameter Description**:
- `oper`: AST operator node object (e.g., ast.Add, ast.Sub, ast.Mult)

**Return Value**: Corresponding operation function that implements the operator

---

#### 17. valid_varname() Function - Variable Name Validation

**Import**:
```python
from asteval.astutils import valid_varname
```

**Function**: Validate whether a variable name is a valid Python identifier and not a reserved word.

**Function Signature**:
```python
def valid_varname(name):
    "is this a valid variable name"
```

**Parameter Description**:
- `name`: Variable name string to validate

**Return Value**: Boolean value, True if valid Python identifier and not reserved word

---

#### 18. get_ast_names() Function - Extract AST Names

**Import**:
```python
from asteval.astutils import get_ast_names
```

**Function**: Extract all symbol names from an AST node object.

**Function Signature**:
```python
def get_ast_names(astnode):
    """Return symbol Names from an AST node."""
```

**Parameter Description**:
- `astnode`: AST node object to analyze

**Return Value**: List of symbol names (variables, functions) found in the AST node


### Configuration Constants and Symbol Tables

**Import for Configuration Constants**:
```python
from asteval.asteval import ALL_NODES, MINIMAL_CONFIG, DEFAULT_CONFIG
```

**Import for Symbol Table Constants**:
```python
from asteval.astutils import (HAS_NUMPY, HAS_NUMPY_FINANCIAL, MAX_EXPONENT, MAX_STR_LEN,
                             MAX_SHIFT, MAX_OPEN_BUFFER, RESERVED_WORDS, NAME_MATCH, UNSAFE_ATTRS,
                             FROM_PY, BUILTINS_TABLE, FROM_MATH, MATH_TABLE,
                             FROM_NUMPY, FROM_NUMPY_FINANCIAL, NUMPY_RENAMES,
                             LOCALFUNCS, OPERATORS, ReturnedNone)
```

#### 19. ALL_NODES - All AST Node Types

**Function**: List containing all AST node type names supported by asteval.

**Type**: list

**Content**: ['arg', 'assert', 'assign', 'attribute', 'augassign', 'binop', 'boolop', 'break', 'bytes', 'call', 'compare', 'constant', 'continue', 'delete', 'dict', 'dictcomp', 'ellipsis', 'excepthandler', 'expr', 'extslice', 'for', 'functiondef', 'if', 'ifexp', 'import', 'importfrom', 'index', 'interrupt', 'list', 'listcomp', 'module', 'name', 'nameconstant', 'num', 'pass', 'raise', 'repr', 'return', 'set', 'setcomp', 'slice', 'str', 'subscript', 'try', 'tuple', 'unaryop', 'while', 'with', 'formattedvalue', 'joinedstr']

#### 20. MINIMAL_CONFIG - Minimal Configuration

**Function**: Define minimal interpreter configuration, disabling most advanced features.

**Type**: dict

**Content**: Disables import, importfrom and most control flow and advanced syntax nodes

#### 21. DEFAULT_CONFIG - Default Configuration

**Function**: Define default interpreter configuration, enabling most features while maintaining safety restrictions.

**Type**: dict

**Content**: Disables import, importfrom, enables most other syntax nodes

#### 22. Numerical and String Limit Constants

**Function**: Define various security limit numerical constants.

- `HAS_NUMPY`: Boolean value indicating whether NumPy is installed (bool)
- `HAS_NUMPY_FINANCIAL`: Boolean value indicating whether numpy-financial is installed(bool)
- `MAX_EXPONENT`: Maximum allowed exponent value (10000)
- `MAX_STR_LEN`: Maximum string length (2<<17 # 256KiB)
- `MAX_SHIFT`: Maximum bit shift count (1000)
- `MAX_OPEN_BUFFER`: Maximum file buffer size (2<<17)

#### 23. Reserved Words and Unsafe Attributes

**Function**: Define Python reserved words and unsafe attribute lists.

- `RESERVED_WORDS`: Python reserved keyword tuple
```python
RESERVED_WORDS = ('False', 'None', 'True', 'and', 'as', 'assert',
                  'async', 'await', 'break', 'class', 'continue',
                  'def', 'del', 'elif', 'else', 'except', 'finally',
                  'for', 'from', 'global', 'if', 'import', 'in', 'is',
                  'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
                  'return', 'try', 'while', 'with', 'yield', 'exec',
                  'eval', 'execfile', '__import__', '__package__')
```
- `NAME_MATCH`: Compiled regular expression object for validating symbol name format
```python
NAME_MATCH = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]*$").match
```
- `UNSAFE_ATTRS`: Unsafe attribute name tuple, preventing access to dangerous internal attributes
```python
UNSAFE_ATTRS = ('__subclasses__', '__bases__', '__globals__', '__code__',
                '__reduce__', '__reduce_ex__',  '__mro__',
                '__closure__', '__func__', '__self__', '__module__',
                '__dict__', '__class__', '__call__', '__get__',
                '__getattribute__', '__subclasshook__', '__new__',
                '__init__', 'func_globals', 'func_code', 'func_closure',
                'im_class', 'im_func', 'im_self', 'gi_code', 'gi_frame',
                'f_locals', '__asteval__')
```

#### 24. Symbol Table Definition Constants

**Function**: Define various symbol table content sources.

- `FROM_PY`: Symbols inherited from Python built-in modules tuple
·
```python
FROM_PY = ('ArithmeticError', 'AssertionError', 'AttributeError',
           'BaseException', 'BufferError', 'BytesWarning',
           'DeprecationWarning', 'EOFError', 'EnvironmentError',
           'Exception', 'False', 'FloatingPointError', 'GeneratorExit',
           'IOError', 'ImportError', 'ImportWarning', 'IndentationError',
           'IndexError', 'KeyError', 'KeyboardInterrupt', 'LookupError',
           'MemoryError', 'NameError', 'None',
           'NotImplementedError', 'OSError', 'OverflowError',
           'ReferenceError', 'RuntimeError', 'RuntimeWarning',
           'StopIteration', 'SyntaxError', 'SyntaxWarning', 'SystemError',
           'SystemExit', 'True', 'TypeError', 'UnboundLocalError',
           'UnicodeDecodeError', 'UnicodeEncodeError', 'UnicodeError',
           'UnicodeTranslateError', 'UnicodeWarning', 'ValueError',
           'Warning', 'ZeroDivisionError', 'abs', 'all', 'any', 'bin',
           'bool', 'bytearray', 'bytes', 'chr', 'complex', 'dict', 'dir',
           'divmod', 'enumerate', 'filter', 'float', 'format', 'frozenset',
           'hash', 'hex', 'id', 'int', 'isinstance', 'len', 'list', 'map',
           'max', 'min', 'oct', 'ord', 'pow', 'range', 'repr',
           'reversed', 'round', 'set', 'slice', 'sorted', 'str', 'sum',
           'tuple', 'zip')
```
- `BUILTINS_TABLE`: Built-in symbol table dictionary
```python
BUILTINS_TABLE = {sym: builtins[sym] for sym in FROM_PY if sym in builtins}
```
- `FROM_MATH`: Mathematical functions imported from math module tuple
```python
FROM_MATH = ('acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh',
             'ceil', 'copysign', 'cos', 'cosh', 'degrees', 'e', 'exp',
             'fabs', 'factorial', 'floor', 'fmod', 'frexp', 'fsum',
             'hypot', 'isinf', 'isnan', 'ldexp', 'log', 'log10', 'log1p',
             'modf', 'pi', 'pow', 'radians', 'sin', 'sinh', 'sqrt', 'tan',
             'tanh', 'trunc')
```
- `MATH_TABLE`: Mathematical function symbol table dictionary
```python
MATH_TABLE = {sym: getattr(math, sym) for sym in FROM_MATH if hasattr(math, sym)}
```
- `FROM_NUMPY`: Functions and constants imported from NumPy tuple
```python
FROM_NUMPY = ('Inf', 'NAN', 'abs', 'add', 'all', 'amax', 'amin', 'angle',
              'any', 'append', 'arange', 'arccos', 'arccosh', 'arcsin',
              'arcsinh', 'arctan', 'arctan2', 'arctanh', 'argmax', 'argmin',
              'argsort', 'argwhere', 'around', 'array', 'array2string',
              'asanyarray', 'asarray', 'asarray_chkfinite',
              'ascontiguousarray', 'asfarray', 'asfortranarray', 'asmatrix',
              'atleast_1d', 'atleast_2d', 'atleast_3d', 'average', 'bartlett',
              'base_repr', 'bitwise_and', 'bitwise_not', 'bitwise_or',
              'bitwise_xor', 'blackman', 'broadcast', 'broadcast_arrays',
              'byte', 'c_', 'cdouble', 'ceil', 'cfloat', 'chararray', 'choose',
              'clip', 'clongdouble', 'clongfloat', 'column_stack',
              'common_type', 'complex128', 'complex64', 'complex_',
              'complexfloating', 'compress', 'concatenate', 'conjugate',
              'convolve', 'copy', 'copysign', 'corrcoef', 'correlate', 'cos',
              'cosh', 'cov', 'cross', 'csingle', 'cumprod', 'cumsum',
              'datetime_data', 'deg2rad', 'degrees', 'delete', 'diag',
              'diag_indices', 'diag_indices_from', 'diagflat', 'diagonal',
              'diff', 'digitize', 'divide', 'dot', 'double', 'dsplit',
              'dstack', 'dtype', 'e', 'ediff1d', 'empty', 'empty_like',
              'equal', 'exp', 'exp2', 'expand_dims', 'expm1', 'extract', 'eye',
              'fabs', 'fft', 'fill_diagonal', 'finfo', 'fix', 'flatiter',
              'flatnonzero', 'fliplr', 'flipud', 'float32', 'float64',
              'float_', 'floating', 'floor', 'floor_divide', 'fmax', 'fmin',
              'fmod', 'format_parser', 'frexp', 'frombuffer', 'fromfile',
              'fromfunction', 'fromiter', 'frompyfunc', 'fromregex',
              'fromstring', 'genfromtxt', 'getbufsize', 'geterr', 'gradient',
              'greater', 'greater_equal', 'hamming', 'hanning', 'histogram',
              'histogram2d', 'histogramdd', 'hsplit', 'hstack', 'hypot', 'i0',
              'identity', 'iinfo', 'imag', 'in1d', 'index_exp', 'indices',
              'inexact', 'inf', 'info', 'infty', 'inner', 'insert', 'int16',
              'int32', 'int64', 'int8', 'int_', 'intc', 'integer', 'interp',
              'intersect1d', 'intp', 'invert', 'iscomplex', 'iscomplexobj',
              'isfinite', 'isfortran', 'isinf', 'isnan', 'isneginf',
              'isposinf', 'isreal', 'isrealobj', 'isscalar', 'issctype',
              'iterable', 'ix_', 'kaiser', 'kron', 'ldexp', 'left_shift',
              'less', 'less_equal', 'linalg', 'linspace', 'little_endian',
              'load', 'loadtxt', 'log', 'log10', 'log1p', 'log2', 'logaddexp',
              'logaddexp2', 'logical_and', 'logical_not', 'logical_or',
              'logical_xor', 'logspace', 'longcomplex', 'longdouble',
              'longfloat', 'longlong', 'mask_indices', 'mat', 'matrix',
              'maximum', 'maximum_sctype', 'may_share_memory', 'mean',
              'median', 'memmap', 'meshgrid', 'mgrid', 'minimum',
              'mintypecode', 'mod', 'modf', 'msort', 'multiply', 'nan',
              'nan_to_num', 'nanargmax', 'nanargmin', 'nanmax', 'nanmin',
              'nansum', 'ndarray', 'ndenumerate', 'ndim', 'ndindex',
              'negative', 'newaxis', 'nextafter', 'nonzero', 'not_equal',
              'number', 'obj2sctype', 'ogrid', 'ones', 'ones_like', 'outer',
              'packbits', 'percentile', 'pi', 'piecewise', 'place', 'poly',
              'poly1d', 'polyadd', 'polyder', 'polydiv', 'polyfit', 'polyint',
              'polymul', 'polynomial', 'polysub', 'polyval', 'power', 'prod',
              'product', 'ptp', 'put', 'putmask', 'r_', 'rad2deg', 'radians',
              'random', 'ravel', 'real', 'real_if_close', 'reciprocal',
              'record', 'remainder', 'repeat', 'reshape', 'resize',
              'right_shift', 'rint', 'roll', 'rollaxis', 'roots', 'rot90',
              'round', 'round_', 'row_stack', 's_', 'sctype2char',
              'searchsorted', 'select', 'setbufsize', 'setdiff1d', 'seterr',
              'setxor1d', 'shape', 'short', 'sign', 'signbit', 'signedinteger',
              'sin', 'sinc', 'single', 'singlecomplex', 'sinh', 'size',
              'sometrue', 'sort', 'sort_complex', 'spacing', 'split', 'sqrt',
              'square', 'squeeze', 'std', 'str_', 'subtract', 'sum',
              'swapaxes', 'take', 'tan', 'tanh', 'tensordot', 'tile', 'trace',
              'transpose', 'trapz', 'tri', 'tril', 'tril_indices',
              'tril_indices_from', 'trim_zeros', 'triu', 'triu_indices',
              'triu_indices_from', 'true_divide', 'trunc', 'ubyte', 'uint',
              'uint16', 'uint32', 'uint64', 'uint8', 'uintc', 'uintp',
              'ulonglong', 'union1d', 'unique', 'unravel_index',
              'unsignedinteger', 'unwrap', 'ushort', 'vander', 'var', 'vdot',
              'vectorize', 'vsplit', 'vstack', 'where', 'who', 'zeros',
              'zeros_like')

```
- `FROM_NUMPY_FINANCIAL`: Financial functions imported from numpy-financial tuple
```python
FROM_NUMPY_FINANCIAL = ('fv', 'ipmt', 'irr', 'mirr', 'nper', 'npv',
                        'pmt', 'ppmt', 'pv', 'rate')
```
- `NUMPY_RENAMES`: NumPy function renaming mapping dictionary
```python
NUMPY_RENAMES = {'ln': 'log', 'asin': 'arcsin', 'acos': 'arccos',
                 'atan': 'arctan', 'atan2': 'arctan2', 'atanh':
                 'arctanh', 'acosh': 'arccosh', 'asinh': 'arcsinh'}
```
- `LOCALFUNCS`: Local safe function dictionary
```python
LOCALFUNCS = {'open': _open, 'type': _type}
```
- `OPERATORS`: Operator mapping dictionary
```python
OPERATORS = {ast.Is: lambda a, b: a is b,
             ast.IsNot: lambda a, b: a is not b,
             ast.In: lambda a, b: a in b,
             ast.NotIn: lambda a, b: a not in b,
             ast.Add: safe_add,
             ast.BitAnd: lambda a, b: a & b,
             ast.BitOr: lambda a, b: a | b,
             ast.BitXor: lambda a, b: a ^ b,
             ast.Div: lambda a, b: a / b,
             ast.FloorDiv: lambda a, b: a // b,
             ast.LShift: safe_lshift,
             ast.RShift: lambda a, b: a >> b,
             ast.Mult: safe_mult,
             ast.Pow: safe_pow,
             ast.MatMult: lambda a, b: a @ b,
             ast.Sub: lambda a, b: a - b,
             ast.Mod: lambda a, b: a % b,
             ast.And: lambda a, b: a and b,
             ast.Or: lambda a, b: a or b,
             ast.Eq: lambda a, b: a == b,
             ast.Gt: lambda a, b: a > b,
             ast.GtE: lambda a, b: a >= b,
             ast.Lt: lambda a, b: a < b,
             ast.LtE: lambda a, b: a <= b,
             ast.NotEq: lambda a, b: a != b,
             ast.Invert: lambda a: ~a,
             ast.Not: lambda a: not a,
             ast.UAdd: lambda a: +a,
             ast.USub: lambda a: -a}
```

#### 25. Type Aliases

**Function**: Define commonly used type aliases.

- `ReturnedNone`: Empty() type, representing cases that return None
- `__all__`: Module export list, containing ['Interpreter', 'NameFinder', 'valid_symbol_name', 'make_symbol_table', 'get_ast_names', '__version__']

## Detailed Implementation Nodes of Functions

### Node 1: Basic Expression Evaluation

**Function Description**: Handle basic Python expressions, including basic data types such as numbers, strings, and boolean values.

**Core Algorithm**:
- Parse numerical literals
- Process string literals
- Evaluate boolean values
- Support basic operators

**Input/Output Examples**:

```python
from asteval import Interpreter

# Basic numerical expressions
interp = Interpreter()
result = interp("4")
print(result)  # 4

result = interp("'x'")
print(result)  # 'x'

result = interp("b'x'")
print(result)  # b'x'

result = interp("str(4)")
print(result)  # '4'

result = interp("repr(4)")
print(result)  # '4'

# Boolean value handling
result = interp("...")
print(result)  # Ellipsis

result = interp("False")
print(result)  # False

# Variable assignment and access
interp("x = 8")
result = interp("x")
print(result)  # 8

# Test verification
assert interp("4") == 4
assert interp("'x'") == 'x'
assert interp("False") == False
```

### Node 2: Dictionary Indexing

**Function Description**: Support the creation, access, and modification of dictionaries.

**Core Algorithm**:
- Create dictionary literals
- Access key-value pairs
- Modify dictionary elements
- Support nested dictionaries

**Input/Output Examples**:

```python
from asteval import Interpreter

interp = Interpreter()

# Dictionary creation and access
interp("a_dict = {'a': 1, 'b': 2, 'c': 3, 'd': 4}")
result = interp("a_dict['a']")
print(result)  # 1

result = interp("a_dict['c']")
print(result)  # 3

# Dictionary element modification
interp("a_dict['a'] = 10")
result = interp("a_dict['a']")
print(result)  # 10

# Nested dictionary
interp("nested_dict = {'outer': {'inner': 42}}")
result = interp("nested_dict['outer']['inner']")
print(result)  # 42

# Test verification
assert interp("a_dict['a']") == 10
assert interp("a_dict['c']") == 3
assert interp("nested_dict['outer']['inner']") == 42
```

### Node 3: List Indexing and Slicing

**Function Description**: Support the creation, index access, slicing operations, and modification of lists.

**Core Algorithm**:
- Create list literals
- Access by index
- Perform slicing operations
- Modify list elements

**Input/Output Examples**:

```python
from asteval import Interpreter

interp = Interpreter()

# List creation and access
interp("xlist = [1, 2, 3, 4, 5]")
result = interp("xlist[0]")
print(result)  # 1

result = interp("xlist[2]")
print(result)  # 3

# Slicing operations
result = interp("xlist[1:3]")
print(result)  # [2, 3]

result = interp("xlist[::2]")
print(result)  # [1, 3, 5]

# List element modification
interp("xlist[0] = 10")
result = interp("xlist[0]")
print(result)  # 10

# Test verification
assert interp("xlist[0]") == 10
assert interp("xlist[1:3]") == [2, 3]
assert interp("xlist[::2]") == [10, 3, 5]
```

### Node 4: Tuple and Set Operations

**Function Description**: Support the creation, access, and basic operations of tuples and sets.

**Core Algorithm**:
- Create tuple literals
- Create set literals
- Access by index
- Perform set operations

**Input/Output Examples**:

```python
from asteval import Interpreter

interp = Interpreter()

# Tuple operations
interp("atuple = (1, 2, 3, 4)")
result = interp("atuple[0]")
print(result)  # 1

result = interp("atuple[1:3]")
print(result)  # (2, 3)

# Set operations
interp("aset = {1, 2, 3, 4}")
result = interp("len(aset)")
print(result)  # 4

# Set operations
interp("set1 = {1, 2, 3}")
interp("set2 = {3, 4, 5}")
result = interp("set1 | set2")
print(result)  # {1, 2, 3, 4, 5}

result = interp("set1 & set2")
print(result)  # {3}

# Test verification
assert interp("atuple[0]") == 1
assert interp("len(aset)") == 4
assert interp("set1 | set2") == {1, 2, 3, 4, 5}
```

### Node 5: String Operations

**Function Description**: Support the creation, index access, slicing, and basic operations of strings.

**Core Algorithm**:
- Create string literals
- Access characters by index
- Perform string slicing
- Call string methods

**Input/Output Examples**:

```python
from asteval import Interpreter

interp = Interpreter()

# String creation and access
interp("astring = 'hello world'")
result = interp("astring[0]")
print(result)  # 'h'

result = interp("astring[1:5]")
print(result)  # 'ello'

# String methods
result = interp("astring.upper()")
print(result)  # 'HELLO WORLD'

result = interp("astring.split()")
print(result)  # ['hello', 'world']

# String concatenation
result = interp("'hello' + ' ' + 'world'")
print(result)  # 'hello world'

# Test verification
assert interp("astring[0]") == 'h'
assert interp("astring[1:5]") == 'ello'
assert interp("astring.upper()") == 'HELLO WORLD'
```

### Node 6: F-string Support

**Function Description**: Support the formatted string syntax in Python 3.6+.

**Core Algorithm**:
- Parse f-strings
- Perform variable interpolation
- Handle format specifiers
- Support conversion flags

**Input/Output Examples**:

```python
from asteval import Interpreter

interp = Interpreter()

# Basic f-string
interp("x = 2523.33/723")
interp("s = f'{x:+.3f}'")
result = interp("s")
print(result)  # '+3.490'

# Unicode character handling
interp("chie = '\u03c7(E)'")
interp("v_s = f'{chie!s}'")
interp("v_r = f'{chie!r}'")
interp("v_a = f'{chie!a}'")

result = interp("v_s")
print(result)  # '\u03c7(E)'

result = interp("v_r")
print(result)  # "'\u03c7(E)'"

result = interp("v_a")
print(result)  # "'\\\\u03c7(E)'"

# Test verification
assert interp("s") == '+3.490'
assert interp("v_s") == '\u03c7(E)'
assert interp("v_r") == "'\u03c7(E)'"
```

### Node 7: NumPy Array Operations

**Function Description**: Support the creation, indexing, slicing, and operations of NumPy arrays.

**Core Algorithm**:
- Create NumPy arrays
- Index multi-dimensional arrays
- Perform array slicing operations
- Perform array operations

**Input/Output Examples**:

```python
from asteval import Interpreter

interp = Interpreter()

# One-dimensional array
interp("a_ndarray = 5*arange(20)")
result = interp("a_ndarray[2]")
print(result)  # 10

result = interp("a_ndarray[4]")
print(result)  # 20

# Multi-dimensional array
interp("a_ndarray = arange(200).reshape(10, 20)")
result = interp("a_ndarray[1:3,5:7]")
print(result)  # array([[25,26], [45,46]])

# Array slicing
interp("y = arange(20).reshape(4, 5)")
result = interp("y[:,3]")
print(result)  # array([3, 8, 13, 18])

result = interp("y[...,1]")
print(result)  # array([1, 6, 11, 16])

# Array assignment
interp("y[...,1] = array([2, 2, 2, 2])")
result = interp("y[1,:]")
print(result)  # array([5, 2, 7, 8, 9])

# Test verification
assert interp("a_ndarray[2]") == 10
assert interp("a_ndarray[4]") == 20
```

### Node 8: Loop Control Structures

**Function Description**: Support while and for loops, including break, continue, and else clauses.

**Core Algorithm**:
- Execute while loops
- Iterate through for loops
- Handle break statements
- Handle continue statements
- Process loop else clauses

**Input/Output Examples**:

```python
from asteval import Interpreter

interp = Interpreter()

# While loop
interp("""
n=0
while n < 8:
    n += 1
""")
result = interp("n")
print(result)  # 8

# While loop with break
interp("""
n=0
while n < 8:
    n += 1
    if n > 3:
        break
else:
    n = -1
""")
result = interp("n")
print(result)  # 4

# While loop with continue
interp("""
n, i = 0, 0
while n < 10:
    n += 1
    if n % 2:
        continue
    i += 1
""")
result = interp("i")
print(result)  # 5

# For loop
interp("""
n=0
for i in range(10):
    n += i
""")
result = interp("n")
print(result)  # 45

# Test verification
assert interp("n") == 8  # First while loop
assert interp("i") == 5  # Continue loop
assert interp("n") == 45  # For loop
```

### Node 9: Conditional Statements

**Function Description**: Support if-elif-else conditional statements and conditional expressions.

**Core Algorithm**:
- Evaluate if statements
- Process elif branches
- Process else branches
- Handle conditional expressions (ternary operators)

**Input/Output Examples**:

```python
from asteval import Interpreter

interp = Interpreter()

# if-elif-else statement
interp("""
x = 5
if x > 10:
    result = 'high'
elif x > 5:
    result = 'medium'
else:
    result = 'low'
""")
result = interp("result")
print(result)  # 'low'

# Conditional expression
interp("x = 2")
interp("y = 4 if x > 0 else -1")
interp("z = 4 if x > 3 else -1")

result = interp("y")
print(result)  # 4

result = interp("z")
print(result)  # -1

# Nested conditions
interp("""
a = 15
if a > 10:
    if a > 20:
        level = 'very high'
    else:
        level = 'high'
else:
    level = 'low'
""")
result = interp("level")
print(result)  # 'high'

# Test verification
assert interp("result") == 'low'
assert interp("y") == 4
assert interp("z") == -1
assert interp("level") == 'high'
```

### Node 10: Function Definition and Call

**Function Description**: Support function definition, parameter passing, return value handling, and nested functions.

**Core Algorithm**:
- Parse function definitions
- Handle parameters (positional parameters, keyword parameters, variable parameters)
- Execute function calls
- Handle return values
- Support nested functions

**Input/Output Examples**:

```python
from asteval import Interpreter

interp = Interpreter()

# Basic function definition
interp("""
def fcn(x, scale=2):
    'test function'
    out = sqrt(x)
    if scale > 1:
        out = out * scale
    return out
""")

result = interp("fcn(4, scale=9)")
print(result)  # 18

result = interp("fcn(9, scale=0)")
print(result)  # 3

# Function with variable parameters
interp("""
def fcn(*args):
    'test varargs function'
    out = 0
    for i in args:
        out = out + i*i
    return out
""")

result = interp("fcn(1,2,3)")
print(result)  # 14

# Function with keyword parameters
interp("""
def fcn(x=0, y=0, z=0, t=0, square=False):
    'test kwargs function'
    out = 0
    for i in (x, y, z, t):
        if square:
            out = out + i*i
        else:
            out = out + i
    return out
""")

result = interp("fcn(x=1, y=2, z=3, square=False)")
print(result)  # 6

result = interp("fcn(x=1, y=2, z=3, square=True)")
print(result)  # 14

# Nested function
interp("""
def outer(x):
    def inner(y):
        return x + y
    return inner(x*2)
""")

result = interp("outer(5)")
print(result)  # 15

# Test verification
assert interp("fcn(4, scale=9)") == 18
assert interp("fcn(1,2,3)") == 14
assert interp("fcn(x=1, y=2, z=3, square=True)") == 14
assert interp("outer(5)") == 15
```

### Node 11: List, Set, and Dictionary Comprehensions

**Function Description**: Support the comprehension syntax for lists, sets, and dictionaries.

**Core Algorithm**:
- Parse list comprehensions
- Parse set comprehensions
- Parse dictionary comprehensions
- Perform conditional filtering
- Handle nested loops

**Input/Output Examples**:

```python
from asteval import Interpreter

interp = Interpreter()

# List comprehension
interp("x = [i*i for i in range(4)]")
result = interp("x")
print(result)  # [0, 1, 4, 9]

interp("x = [i*i for i in range(6) if i > 1]")
result = interp("x")
print(result)  # [4, 9, 16, 25]

interp("x = [(i, j*2) for i in range(6) for j in range(2)]")
result = interp("x")
print(result)  # [(0, 0), (0, 2), (1, 0), (1, 2), (2, 0), (2, 2), ...]

# Set comprehension
interp("x = {(a,2*b) for a in range(5) for b in range(4)}")
result = interp("x")
print(result)  # {(4, 0), (3, 4), (4, 6), (0, 2), (2, 2), ...}

# Dictionary comprehension
interp("x = {a:2*b for a in range(5) for b in range(4)}")
result = interp("x")
print(result)  # {0: 6, 1: 6, 2: 6, 3: 6, 4: 6}

# Test verification
assert interp("x") == [0, 1, 4, 9]  # List comprehension
assert len(interp("x")) == 20  # Set comprehension
assert interp("x") == {0: 6, 1: 6, 2: 6, 3: 6, 4: 6}  # Dictionary comprehension
```

### Node 12: Exception Handling

**Function Description**: Support the try-except-finally exception handling structure.

**Core Algorithm**:
- Execute try blocks
- Capture exceptions in except blocks
- Process finally cleanup blocks
- Match exception types
- Handle exception information

**Input/Output Examples**:

```python
from asteval import Interpreter

interp = Interpreter()

# Basic exception handling
interp("""
x = 5
try:
    x = x/0
except ZeroDivisionError:
    print('Error Seen!')
    x = -999
""")
result = interp("x")
print(result)  # -999

# Exception handling with else
interp("""
def dotry(x, y):
    out, ok, clean = 0, False, False
    try:
        out = x/y
    except ZeroDivisionError:
        out = -1
    else:
        ok = True
    finally:
        clean = True
    return out, ok, clean
""")

result = interp("dotry(1, 2.0)")
print(result)  # (0.5, True, True)

result = interp("dotry(1, 0.0)")
print(result)  # (-1, False, True)

# General exception handling
interp("""
x = 15
try:
    raise Exception()
    x = 20
except:
    pass
""")
result = interp("x")
print(result)  # 15

# Test verification
assert interp("x") == -999  # First exception handling
assert interp("dotry(1, 2.0)") == (0.5, True, True)
assert interp("dotry(1, 0.0)") == (-1, False, True)
assert interp("x") == 15  # General exception handling
```

### Node 13: Mathematical Functions and Operations

**Function Description**: Support built-in mathematical functions, NumPy mathematical functions, and basic mathematical operations.

**Core Algorithm**:
- Call built-in mathematical functions
- Support NumPy mathematical functions
- Perform basic arithmetic operations
- Conduct comparison operations
- Execute logical operations

**Input/Output Examples**:

```python
from asteval import Interpreter

interp = Interpreter()

# Built-in mathematical functions
interp("n = sqrt(4)")
result = interp("n")
print(result)  # 2.0

result = interp("sin(pi/2)")
print(result)  # 1.0

result = interp("cos(pi/2)")
print(result)  # 0.0

result = interp("exp(0)")
print(result)  # 1.0

# Basic arithmetic operations
result = interp("2 + 3 * 4")
print(result)  # 14

result = interp("(2 + 3) * 4")
print(result)  # 20

result = interp("2 ** 3")
print(result)  # 8

# Comparison operations
result = interp("5 > 3")
print(result)  # True

result = interp("5 == 3")
print(result)  # False

# Logical operations
result = interp("True and False")
print(result)  # False

result = interp("True or False")
print(result)  # True

result = interp("not True")
print(result)  # False

# Chained comparison
interp("a = 7")
interp("b = 12")
interp("c = 19")
interp("d = 30")

result = interp("a < b < c < d")
print(result)  # True

result = interp("a < b < c/88 < d")
print(result)  # False

# Test verification
assert interp("n") == 2.0
assert interp("sin(pi/2)") == 1.0
assert interp("2 + 3 * 4") == 14
assert interp("5 > 3") == True
assert interp("a < b < c < d") == True
```

### Node 14: Symbol Table Management

**Function Description**: Manage the interpreter's symbol table, including variable definition, scope, and read-only symbols.

**Core Algorithm**:
- Create and initialize the symbol table
- Define and access variables
- Protect read-only symbols
- Manage user-defined symbols
- Manage built-in symbols

**Input/Output Examples**:

```python
from asteval import Interpreter, make_symbol_table

# Custom symbol table
def cosd(x):
    "cos with angle in degrees"
    return numpy.cos(numpy.radians(x))

def sind(x):
    "sin with angle in degrees"
    return numpy.sin(numpy.radians(x))

def tand(x):
    "tan with angle in degrees"
    return numpy.tan(numpy.radians(x))

sym_table = make_symbol_table(cosd=cosd, sind=sind, tand=tand)
aeval = Interpreter(symtable=sym_table)

aeval("x1 = sind(30)")
aeval("x2 = cosd(30)")
aeval("x3 = tand(45)")

x1 = aeval.symtable['x1']
x2 = aeval.symtable['x2']
x3 = aeval.symtable['x3']

print(x1)  # 0.5
print(x2)  # 0.866025
print(x3)  # 1.0

# Read-only symbols
usersyms = {
    "a": 10,
    "b": 11,
    "c": 12,
    "d": 13,
    "x": 5,
    "y": 7
}

aeval = Interpreter(usersyms=usersyms, 
                   readonly_symbols={"a", "b", "c", "d"})

aeval("a = 20")  # Try to modify a read-only symbol
aeval("x = 21")  # Modify a normal symbol
aeval("y += a")  # Use a read-only symbol for calculation

print(aeval("a"))  # 10 (unchanged)
print(aeval("x"))  # 21 (changed)
print(aeval("y"))  # 17 (7 + 10)

# User-defined symbol query
aeval = Interpreter()
aeval("x = 1.1")
aeval("y = 2.5")
aeval("z = 788")

usersyms = aeval.user_defined_symbols()
print(usersyms)  # {'x', 'y', 'z'}

# Test verification
assert abs(x1 - 0.5) < 0.001
assert abs(x2 - 0.866025) < 0.001
assert abs(x3 - 1.0) < 0.001
assert aeval("a") == 10
assert aeval("x") == 21
assert aeval("y") == 17
assert 'x' in usersyms
assert 'y' in usersyms
assert 'z' in usersyms
```

### Node 15: Safety Restrictions and Boundary Checks

**Function Description**: Implement various safety restrictions to prevent dangerous operations and resource abuse.

**Core Algorithm**:
- Limit statement length
- Restrict recursion depth
- Check for numerical overflow
- Limit string length
- Disable dangerous functions

**Input/Output Examples**:

```python
from asteval import Interpreter

interp = Interpreter()

# Statement length limit
longstr = "statement_of_somesize" * 5000
interp(longstr)
# Should trigger a RuntimeError

# Numerical overflow check
interp("1.01**10000")
# Should execute normally

interp("1.01**10001")
# Should trigger a RuntimeError

interp("1.5**10000")
# Should trigger an OverflowError

# Bit shift operation limit
interp("1<<1000")
# Should execute normally

interp("1<<1001")
# Should trigger a RuntimeError

# Recursion limit
interp("""def foo(): return foo()\nfoo()""")
# Should trigger a RecursionError

# Disable dangerous operations
interp("compile('xxx')")
# Should trigger a NameError (compile function is disabled)

# File operation restrictions
interp('open("foo1", "wb")')
# Should trigger a RuntimeError

interp('open("foo2", "rb")')
# Should trigger a FileNotFoundError

# Test verification
# These tests mainly verify whether the safety restrictions work properly
# In actual tests, the exception type and message will be checked
```

### Node 16: AST Parsing and Node Handling

**Function Description**: Parse Python code into AST nodes and provide node handler management.

**Core Algorithm**:
- Parse ASTs
- Register node handlers
- Distribute node types
- Dump ASTs
- Extract names

**Input/Output Examples**:

```python
from asteval import Interpreter, NameFinder, get_ast_names

interp = Interpreter()

# AST parsing
astnode = interp.parse('x = 1')
print(type(astnode))  # <class '_ast.Module'>

# AST node type check
assert isinstance(astnode, ast.Module)
assert isinstance(astnode.body[0], ast.Assign)
assert isinstance(astnode.body[0].targets[0], ast.Name)
assert isinstance(astnode.body[0].value, ast.Num)

# AST dump
dumped = interp.dump(astnode.body[0])
print(dumped)  # Assign(targets=[Name(id='x', ctx=Store())], value=Num(n=1))

# Name extraction
interp('x = 12')
interp('y = 9.9')
astnode = interp.parse('z = x + y/3')
names = get_ast_names(astnode)
print(names)  # {'x', 'y', 'z'}

# Use NameFinder
p = interp.parse('x+y+cos(z)')
nf = NameFinder()
nf.generic_visit(p)
print(nf.names)  # {'x', 'y', 'z', 'cos'}

# Node handler management
handler = interp.remove_nodehandler('ifexp')
interp('testval = 300')
interp('bogus = 3 if testval > 100 else 1')
# Should trigger a NotImplementedError

interp.set_nodehandler('ifexp', handler)
interp('bogus = 3 if testval > 100 else 1')
result = interp("bogus")
print(result)  # 3

# Test verification
assert 'x' in names
assert 'y' in names
assert 'z' in names
assert 'x' in nf.names
assert 'y' in nf.names
assert 'z' in nf.names
assert 'cos' in nf.names
assert interp("bogus") == 3
```

### Node 17: Configuration and Options Management

**Function Description**: Manage various configuration options and function switches of the interpreter.

**Core Algorithm**:
- Manage configuration dictionaries
- Control function switches
- Implement minimized mode
- Support custom configurations
- Verify options

**Input/Output Examples**:

```python
from asteval import Interpreter

# Minimized mode
aeval = Interpreter(builtins_readonly=True, minimal=True)
aeval("a_dict = {'a': 1, 'b': 2, 'c': 3, 'd': 4}")
assert aeval("a_dict['a'] == 1")
assert aeval("a_dict['c'] == 3")

# Custom configuration
conf = {'import': False, 'importfrom': False, 'ifexp': True}
i2 = Interpreter(config=conf)
assert i2.node_handlers['ifexp'] != i2.unimplemented
assert i2.node_handlers['import'] == i2.unimplemented

# Function switch
i1 = Interpreter(no_ifexp=True)
assert i1.node_handlers['ifexp'] == i1.unimplemented

i1('y = 4 if x > 0 else -1')
# Should trigger a NotImplementedError

# Import function control
ix = Interpreter(with_import=True, with_importfrom=True)
assert ix.node_handlers['ifexp'] != ix.unimplemented
assert ix.node_handlers['import'] != ix.unimplemented
assert ix.node_handlers['importfrom'] != ix.unimplemented

# Nested symbol table
interp_nested = Interpreter(nested_symtable=True)
interp_flat = Interpreter(nested_symtable=False)

# Test verification
assert aeval("a_dict['a'] == 1")
assert i2.node_handlers['ifexp'] != i2.unimplemented
assert i1.node_handlers['ifexp'] == i1.unimplemented
assert ix.node_handlers['import'] != ix.unimplemented
```

### Node 18: Error Handling and Exception Management

**Function Description**: Provide a complete error handling and exception management mechanism.

**Core Algorithm**:
- Collect exceptions
- Format error messages
- Identify exception types
- Save error context
- Control exception propagation

**Input/Output Examples**:

```python
from asteval import Interpreter

interp = Interpreter()

# Syntax error handling
try:
    interp("invalid syntax here")
except SyntaxError:
    print("Syntax error caught")

# Runtime error handling
try:
    interp("x = 1/0")
except ZeroDivisionError:
    print("Division by zero caught")

# Name error handling
try:
    interp("undefined_variable")
except NameError:
    print("Name error caught")

# Type error handling
try:
    interp("len(42)")
except TypeError:
    print("Type error caught")

# Assertion error handling
interp.error = []
interp('n=6')
interp('assert n==6')
# Should have no errors

interp('assert n==7')
# Should trigger an AssertionError

interp('assert n==7, "no match"')
# Should trigger an AssertionError with a message

# Error information check
def check_error(interp, chk_type='', chk_msg=''):
    try:
        errtype, errmsg = interp.error[0].get_error()
        assert errtype == chk_type
        if chk_msg:
            assert chk_msg in errmsg
    except IndexError:
        if chk_type:
            assert False

# Test verification
# These tests verify whether the error handling mechanism works properly
```

### Node 19: Output and Input Redirection

**Function Description**: Support the redirection of standard output and error output.

**Core Algorithm**:
- Redirect output streams
- Redirect error streams
- Support StringIO
- Support file output
- Manage output buffers

**Input/Output Examples**:

```python
from asteval import Interpreter
from io import StringIO

# StringIO output redirection
out = StringIO()
err = StringIO()
intrep = Interpreter(writer=out, err_writer=err)

intrep("print('out')")
print(out.getvalue())  # 'out\n'

# File output redirection
import tempfile
import os

stdout_file = tempfile.NamedTemporaryFile('w', delete=False, prefix='astevaltest')
interp = Interpreter(writer=stdout_file)

interp("print('hello world')")
stdout_file.flush()
stdout_file.close()

with open(stdout_file.name, 'r') as f:
    output = f.read()
print(output)  # 'hello world\n'

os.unlink(stdout_file.name)

# Error output redirection
stderr_file = tempfile.NamedTemporaryFile('w', delete=False, prefix='astevaltest_stderr')
interp = Interpreter(err_writer=stderr_file)

try:
    interp("undefined_variable")
except:
    pass

stderr_file.flush()
stderr_file.close()

with open(stderr_file.name, 'r') as f:
    error_output = f.read()
print(error_output)  # Contains error information

os.unlink(stderr_file.name)

# Test verification
assert out.getvalue() == 'out\n'
assert output == 'hello world\n'
assert len(error_output) > 0
```

### Node 20: Performance Optimization and Resource Management

**Function Description**: Provide performance optimization and resource management functions.

**Core Algorithm**:
- Limit statement length
- Control recursion depth
- Monitor memory usage
- Limit execution time
- Clean up resources

**Input/Output Examples**:

```python
from asteval import Interpreter
import time
import tempfile
import os

# Execution time monitoring
interp = Interpreter()
start_time = time.time()

interp("""
sum = 0
for i in range(1000):
    sum += i
""")

end_time = time.time()
execution_time = end_time - start_time
print(f"Execution time: {execution_time:.4f} seconds")

# Memory usage optimization
interp = Interpreter(max_statement_length=1000)

# Long statement limit
long_statement = "x = " + "1 + " * 1000 + "1"
try:
    interp(long_statement)
except RuntimeError as e:
    print(f"Statement too long: {e}")

# Recursion limit
interp = Interpreter()

try:
    interp("""
def recursive_func(n):
    if n <= 0:
        return 0
    return 1 + recursive_func(n-1)

result = recursive_func(1000)
""")
except RecursionError:
    print("Recursion limit reached")

# Resource cleanup
interp = Interpreter()

# Create a temporary file
temp_file = tempfile.NamedTemporaryFile('w', delete=False)
temp_file.write("test data")
temp_file.close()

# Use the with statement to automatically clean up
interp("""
with open('{}', 'r') as f:
    data = f.read()
""".format(temp_file.name))

# The file should be automatically closed
print("File automatically closed")

# Clean up the temporary file
os.unlink(temp_file.name)

# Test verification
assert execution_time < 1.0  # The execution time should be within a reasonable range
print("Performance and resource management tests passed")
```