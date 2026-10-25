## Introduction and Goals of the More-Itertools Project

More-Itertools is a Python library **aimed at enhancing Python iterators**. It extends the standard library's `itertools` module and provides over 100 powerful iterator utility functions. This tool performs excellently in scenarios such as data processing, algorithm implementation, and stream processing, achieving "the highest memory efficiency and optimal performance." Its core functions include: grouping and chunking iterators (automatically splitting large datasets into manageable chunks), **lookahead and lookbehind capabilities** (supporting iterator preview and backtracking), and intelligent handling of special functions such as sliding windows, data augmentation, combinatorial mathematics, and mathematical operations. In short, More-Itertools is dedicated to providing a powerful iterator tool system to enhance Python's iterator processing capabilities (e.g., chunking large datasets using `chunked()`, previewing iterators using `peekable()`, etc.).

## Natural Language Instruction (Prompt)

Please create a Python project named More-Itertools to implement an iterator enhancement library. The project should include the following functions:

1. Grouping and Chunking Functions: Capable of dividing an iterable object into fixed-size chunks, supporting strict mode and lazy chunking, including functions such as `chunked()`, `ichunked()`, `sliced()`, and `split_at()`. The chunking results should be lists or generators, supporting data segmentation of different sizes.

2. Lookahead and Lookbehind Functions: Implement functions to preview iterator elements without consuming the iterator, supporting operations such as `peekable()`, `seekable()`, and `spy()`. Advanced iterator operations such as peek preview, prepend, and seek backtracking should be supported.

3. Window and Sliding Functions: Special handling of sliding windows, adjacent element pairs, triples, etc., such as generating sliding windows using `windowed()`, generating adjacent pairs using `pairwise()`, and generating triples using `triplewise()`.

4. Interface Design: Design independent function interfaces for each functional module (e.g., grouping, lookahead, window, enhancement, combination, summary, selection, combinatorial mathematics, wrapping, mathematical operations, etc.), supporting chaining calls and combined use. Each module should define clear input and output formats.

5. Examples and Evaluation Scripts: Provide example code and test cases to demonstrate how to use the `chunked()` and `windowed()` functions for data chunking and sliding window processing (e.g., `chunked('ABCDEF', 3)` should return `[['A', 'B', 'C'], ['D', 'E', 'F']]`). The above functions need to be combined to build a complete iterator enhancement toolkit. The final project should include modules such as grouping, lookahead, window, enhancement, combination, summary, selection, combinatorial mathematics, wrapping, and mathematical operations, along with typical test cases, forming a reproducible enhancement process.

6. Core File Requirements: The project must include a complete `pyproject.toml` file, which should not only configure the project as an installable package (supporting `pip install`) but also declare a complete list of dependencies (including core libraries such as `Python >= 3.9` and `flit_core >= 3.12`). `pyproject.toml` should be able to verify whether all functional modules are working properly. Additionally, `more_itertools/__init__.py` should be provided as a unified API entry, importing and exporting core functions, classes, etc. from the `more` and `recipes` modules, and providing version information, allowing users to access all major functions through simple statements such as `from more_itertools import xxx` or `import more_itertools`. In `more.py`, functions such as `chunked()` and `windowed()` should be provided to offer various iterator enhancement functions.

## Environment Configuration

### Python Version
The Python version used in the current project is: Python 3.12.4

### Core Dependency Library Versions

```Plain
# Python version requirements
Python >= 3.9                    # Supports Python 3.9, 3.10, 3.11, 3.12, 3.13

# Build system dependencies
flit_core >= 3.12, < 4            # Build backend
flit >= 3.12.0                  # Package management tool

# Development dependencies
coverage >= 7.10.3              # Code coverage
mypy >= 1.17.1                  # Type checking
ruff >= 0.12.8                  # Code formatting and checking
sphinx >= 8.2.3                 # Documentation generation
furo >= 2025.7.19               # Sphinx theme
twine >= 6.1.0                  # Package upload
wheel >= 0.41.2                 # Package building

# Testing framework
unittest                      # Built-in Python testing framework
tox                          # Multi-environment testing management
```

## More-Itertools Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .gitattributes
├── .gitignore
├── .readthedocs.yaml
├── LICENSE
├── MANIFEST.in
├── Makefile
├── README.rst
├── docs
│   ├── Makefile
│   ├── _static
│   │   ├── theme_overrides.css
│   ├── api.rst
│   ├── conf.py
│   ├── index.rst
│   ├── license.rst
│   ├── make.bat
│   ├── requirements.txt
│   ├── testing.rst
│   ├── toctree.rst
│   ├── versions.rst
├── more_itertools
│   ├── __init__.py
│   ├── __init__.pyi
│   ├── more.py
│   ├── more.pyi
│   ├── py.typed
│   ├── recipes.py
│   ├── recipes.pyi
├── pyproject.toml
└── tox.ini

```

## API Usage Guide

### Core API

#### 1. Module Import

```python
import more_itertools as mi
from more_itertools import recipes
```

#### 2. `chunked()` Function - Data Chunking

**Functionality**: Divide an iterable object into fixed-size chunks.

**Function Signature**:
```python
from functools import partial
from more_itertools import take


def chunked(iterable, n, strict=False):
    """Divide an iterable object into fixed-size chunks."""
    iterator = iter(partial(take, n, iter(iterable)), [])
    if strict:
        if n is None:
            raise ValueError('n must not be None when using strict mode.')

        def ret():
            for chunk in iterator:
                if len(chunk) != n:
                    raise ValueError('iterable is not divisible by n.')
                yield chunk

        return ret()
    else:
        return iterator
```

**Parameter Description**:
- `iterable`: The iterable object to be chunked.
- `n`: The size of each chunk.
- `strict`: Whether to use strict mode, default is `False`.

**Return Value**: A generator that yields lists of size `n`.

#### 3. `windowed()` Function - Sliding Window

**Functionality**: Generate a sliding window, supporting custom step size and fill value.

**Function Signature**:
```python
from itertools import chain
from itertools import islice

from collections import deque
from itertools import chain, islice

def windowed(seq, n, fillvalue=None, step=1):
    """Return a sliding window of width *n* over the given iterable.

        >>> all_windows = windowed([1, 2, 3, 4, 5], 3)
        >>> list(all_windows)
        [(1, 2, 3), (2, 3, 4), (3, 4, 5)]

    When the window is larger than the iterable, *fillvalue* is used in place
    of missing values:

        >>> list(windowed([1, 2, 3], 4))
        [(1, 2, 3, None)]

    Each window will advance in increments of *step*:

        >>> list(windowed([1, 2, 3, 4, 5, 6], 3, fillvalue='!', step=2))
        [(1, 2, 3), (3, 4, 5), (5, 6, '!')]

    To slide into the iterable's items, use :func:`chain` to add filler items
    to the left:

        >>> iterable = [1, 2, 3, 4]
        >>> n = 3
        >>> padding = [None] * (n - 1)
        >>> list(windowed(chain(padding, iterable), 3))
        [(None, None, 1), (None, 1, 2), (1, 2, 3), (2, 3, 4)]
    """
```

**Parameter Description**:
- `seq`: The input sequence.
- `n`: The window size.
- `fillvalue`: The fill value, default is `None`.
- `step`: The step size, default is `1`.

**Return Value**: A generator that yields window tuples.

#### 4. `peekable` Class - Previewable Iterator

**Functionality**: Wrap an iterator to support operations such as `peek` and `prepend`.

**Function Signature**:
```python
from collections import deque


    """Wrap an iterator to allow lookahead and prepending elements.

    Call :meth:`peek` on the result to get the value that will be returned
    by :func:`next`. This won't advance the iterator:

        >>> p = peekable(['a', 'b'])
        >>> p.peek()
        'a'
        >>> next(p)
        'a'

    Pass :meth:`peek` a default value to return that instead of raising
    ``StopIteration`` when the iterator is exhausted.

        >>> p = peekable([])
        >>> p.peek('hi')
        'hi'

    peekables also offer a :meth:`prepend` method, which "inserts" items
    at the head of the iterable:

        >>> p = peekable([1, 2, 3])
        >>> p.prepend(10, 11, 12)
        >>> next(p)
        10
        >>> p.peek()
        11
        >>> list(p)
        [11, 12, 1, 2, 3]

    peekables can be indexed. Index 0 is the item that will be returned by
    :func:`next`, index 1 is the item after that, and so on:
    The values up to the given index will be cached.

        >>> p = peekable(['a', 'b', 'c', 'd'])
        >>> p[0]
        'a'
        >>> p[1]
        'b'
        >>> next(p)
        'a'

    Negative indexes are supported, but be aware that they will cache the
    remaining items in the source iterator, which may require significant
    storage.

    To check whether a peekable is exhausted, check its truth value:

        >>> p = peekable(['a', 'b'])
        >>> if p:  # peekable has items
        ...     list(p)
        ['a', 'b']
        >>> if not p:  # peekable is exhausted
        ...     list(p)
        []

    """

    def __init__(self, iterable: Iterable[_T]) -> None: ...
    def __iter__(self) -> peekable[_T]: ...
    def __bool__(self) -> bool: ...
    @overload
    def peek(self) -> _T: ...
    @overload
    def peek(self, default: _U) -> _T | _U: ...
    def prepend(self, *items: _T) -> None: ...
    def __next__(self) -> _T: ...
    @overload
    def __getitem__(self, index: int) -> _T: ...
    @overload
    def __getitem__(self, index: slice) -> list[_T]: ...
```

**Parameter Description**:
- `iterable`: The iterator to be wrapped.

**Return Value**: A `peekable` object.

#### 5. `spy()` Function - Iterator Preview

**Functionality**: Preview the first few elements of an iterator without consuming the iterator.

**Function Signature**:
```python
from itertools import tee

from more_itertools import take


def spy(iterable, n=1):
    """Return a 2-tuple with a list containing the first *n* elements of
    *iterable*, and an iterator with the same items as *iterable*.
    This allows you to "look ahead" at the items in the iterable without
    advancing it.

    There is one item in the list by default:

        >>> iterable = 'abcdefg'
        >>> head, iterable = spy(iterable)
        >>> head
        ['a']
        >>> list(iterable)
        ['a', 'b', 'c', 'd', 'e', 'f', 'g']

    You may use unpacking to retrieve items instead of lists:

        >>> (head,), iterable = spy('abcdefg')
        >>> head
        'a'
        >>> (first, second), iterable = spy('abcdefg', 2)
        >>> first
        'a'
        >>> second
        'b'

    The number of items requested can be larger than the number of items in
    the iterable:

        >>> iterable = [1, 2, 3, 4, 5]
        >>> head, iterable = spy(iterable, 10)
        >>> head
        [1, 2, 3, 4, 5]
        >>> list(iterable)
        [1, 2, 3, 4, 5]
"""
```

**Parameter Description**:
- `iterable`: The iterator to be previewed.
- `n`: The number of elements to preview.

**Return Value**: A tuple (`preview list`, `original iterator`).

#### 6. `seekable` Class - Seekable Iterator

**Functionality**: Wrap an iterator to allow for seeking backward and forward. This progressively caches the items in the source iterable so they can be re-visited.

**Function Signature**:
```python
from itertools import count

from collections.abc import Iterable, Iterator
from typing import Generic, TypeVar, overload

from more_itertools.more import SequenceView

_T = TypeVar('_T')
_U = TypeVar('_U')


class seekable(Generic[_T], Iterator[_T]):
        """Wrap an iterator to allow for seeking backward and forward. This
    progressively caches the items in the source iterable so they can be
    re-visited.

    Call :meth:`seek` with an index to seek to that position in the source
    iterable.

    To "reset" an iterator, seek to ``0``:

        >>> from itertools import count
        >>> it = seekable((str(n) for n in count()))
        >>> next(it), next(it), next(it)
        ('0', '1', '2')
        >>> it.seek(0)
        >>> next(it), next(it), next(it)
        ('0', '1', '2')

    You can also seek forward:

        >>> it = seekable((str(n) for n in range(20)))
        >>> it.seek(10)
        >>> next(it)
        '10'
        >>> it.seek(20)  # Seeking past the end of the source isn't a problem
        >>> list(it)
        []
        >>> it.seek(0)  # Resetting works even after hitting the end
        >>> next(it)
        '0'

    Call :meth:`relative_seek` to seek relative to the source iterator's
    current position.

        >>> it = seekable((str(n) for n in range(20)))
        >>> next(it), next(it), next(it)
        ('0', '1', '2')
        >>> it.relative_seek(2)
        >>> next(it)
        '5'
        >>> it.relative_seek(-3)  # Source is at '6', we move back to '3'
        >>> next(it)
        '3'
        >>> it.relative_seek(-3)  # Source is at '4', we move back to '1'
        >>> next(it)
        '1'


    Call :meth:`peek` to look ahead one item without advancing the iterator:

        >>> it = seekable('1234')
        >>> it.peek()
        '1'
        >>> list(it)
        ['1', '2', '3', '4']
        >>> it.peek(default='empty')
        'empty'

    Before the iterator is at its end, calling :func:`bool` on it will return
    ``True``. After it will return ``False``:

        >>> it = seekable('5678')
        >>> bool(it)
        True
        >>> list(it)
        ['5', '6', '7', '8']
        >>> bool(it)
        False

    You may view the contents of the cache with the :meth:`elements` method.
    That returns a :class:`SequenceView`, a view that updates automatically:

        >>> it = seekable((str(n) for n in range(10)))
        >>> next(it), next(it), next(it)
        ('0', '1', '2')
        >>> elements = it.elements()
        >>> elements
        SequenceView(['0', '1', '2'])
        >>> next(it)
        '3'
        >>> elements
        SequenceView(['0', '1', '2', '3'])

    By default, the cache grows as the source iterable progresses, so beware of
    wrapping very large or infinite iterables. Supply *maxlen* to limit the
    size of the cache (this of course limits how far back you can seek).

        >>> from itertools import count
        >>> it = seekable((str(n) for n in count()), maxlen=2)
        >>> next(it), next(it), next(it), next(it)
        ('0', '1', '2', '3')
        >>> list(it.elements())
        ['2', '3']
        >>> it.seek(0)
        >>> next(it), next(it), next(it), next(it)
        ('2', '3', '4', '5')
        >>> next(it)
        '6'

    """

    def __init__(self, iterable: Iterable[_T], maxlen: int | None = ...) -> None: ...
    def __iter__(self) -> 'seekable[_T]': ...
    def __next__(self) -> _T: ...
    def __bool__(self) -> bool: ...
    @overload
    def peek(self) -> _T: ...
    @overload
    def peek(self, default: _U) -> _T | _U: ...
    def elements(self) -> SequenceView[_T]: ...
    def seek(self, index: int) -> None: ...
    def relative_seek(self, count: int) -> None: ...
```

**Parameter Description**:
- `iterable`: The iterator to be wrapped
- `maxlen`: Optional maximum length for the cache (limits how far back you can seek)

**Key Methods**:
- `seek(index)`: Seek to an absolute position in the source iterable
- `relative_seek(count)`: Seek relative to the current position
- `peek(default=None)`: Look ahead one item without advancing
- `elements()`: Return a view of cached elements

**Usage Examples**:

Basic seeking and reset:
```python
from itertools import count
from more_itertools import seekable

it = seekable((str(n) for n in count()))
next(it), next(it), next(it)  # ('0', '1', '2')
it.seek(0)  # Reset to beginning
next(it), next(it), next(it)  # ('0', '1', '2')
```

Forward seeking:
```python
it = seekable((str(n) for n in range(20)))
it.seek(10)
next(it)  # '10'
```

Relative seeking:
```python
it = seekable((str(n) for n in range(20)))
next(it), next(it), next(it)  # ('0', '1', '2')
it.relative_seek(2)  # Move forward 2 positions
next(it)  # '5'
it.relative_seek(-3)  # Move back 3 positions
next(it)  # '3'
```

Peek functionality:
```python
it = seekable('1234')
it.peek()  # '1'
list(it)  # ['1', '2', '3', '4']
```

Cache viewing:
```python
it = seekable((str(n) for n in range(10)))
next(it), next(it), next(it)  # ('0', '1', '2')
elements = it.elements()  # SequenceView(['0', '1', '2'])
next(it)  # '3'
list(elements)  # ['0', '1', '2', '3']
```

Memory management with maxlen:
```python
from itertools import count
it = seekable((str(n) for n in count()), maxlen=2)
next(it), next(it), next(it), next(it)  # ('0', '1', '2', '3')
list(it.elements())  # ['2', '3'] - only last 2 cached
```

**Return Value**: A seekable iterator object that supports random access to previously seen elements

**Notes**: 
By default, the cache grows as the source iterable progresses. Use `maxlen` parameter to limit memory usage for large or infinite iterables.

#### 7. `chunked` Function

**Function Description**: 
Divide an iterable object into chunks of a specified size.

**Core Algorithm**: 
Divide the input iterable object into multiple chunks, each with a size of `n`.

**Input/Output Example**:
```python
from more import chunked

def chunked(iterable, n, strict=False):
    """Break *iterable* into lists of length *n*:

        >>> list(chunked([1, 2, 3, 4, 5, 6], 3))
        [[1, 2, 3], [4, 5, 6]]

    By the default, the last yielded list will have fewer than *n* elements
    if the length of *iterable* is not divisible by *n*:

        >>> list(chunked([1, 2, 3, 4, 5, 6, 7, 8], 3))
        [[1, 2, 3], [4, 5, 6], [7, 8]]

    To use a fill-in value instead, see the :func:`grouper` recipe.

    If the length of *iterable* is not divisible by *n* and *strict* is
    ``True``, then ``ValueError`` will be raised before the last
    list is yielded.

    """
```

#### 8.: `first` Function

**Function Description**: 
Return the first element of an iterable object.

**Core Algorithm**: 
Get the first element of the iterable object. If it is empty, return a default value or raise an exception.

**Input/Output Example**:
```python
from more import first
def first(iterable, default=_marker):
    """Return the first item of *iterable*, or *default* if *iterable* is
    empty.

        >>> first([0, 1, 2, 3])
        0
        >>> first([], 'some default')
        'some default'

    If *default* is not provided and there are no items in the iterable,
    raise ``ValueError``.

    :func:`first` is useful when you have a generator of expensive-to-retrieve
    values and want any arbitrary one. It is marginally shorter than
    ``next(iter(iterable), default)``.

    """

```

#### 9.: `last` Function
**Function Description**: 
Return the last element of an iterable object.

**Core Algorithm**: 
Traverse the entire iterable object and return the last element.

**Input/Output Example**:
```python
from more import last

def last(iterable, default=_marker):
    """Return the last item of *iterable*, or *default* if *iterable* is
    empty.

        >>> last([0, 1, 2, 3])
        3
        >>> last([], 'some default')
        'some default'

    If *default* is not provided and there are no items in the iterable,
    raise ``ValueError``.
    """
```

#### 10: `nth_or_last` Function

**Function Description**: 
Return the nth element of an iterable object. If there are not enough elements, return the last element.

**Core Algorithm**: 
Traverse the iterable object and return the nth element or the last element.

**Input/Output Example**:
```python
from more import nth_or_last

def nth_or_last(iterable, n, default=_marker):
    """Return the nth or the last item of *iterable*,
    or *default* if *iterable* is empty.

        >>> nth_or_last([0, 1, 2, 3], 2)
        2
        >>> nth_or_last([0, 1], 2)
        1
        >>> nth_or_last([], 0, 'some default')
        'some default'

    If *default* is not provided and there are no items in the iterable,
    raise ``ValueError``.
    """
```

#### 11: `distinct_permutations` Function

**Function Description**: 
Generate distinct permutations.

**Core Algorithm**: 
Generate all unique permutations based on the input sequence, using the internal helpers `_full()` and `_partial()` to explore full-length and truncated permutations without duplicates.

**Input/Output Example**:
```python
from more import distinct_permutations

def distinct_permutations(iterable, r=None):
    """Yield successive distinct permutations of the elements in *iterable*.

        >>> sorted(distinct_permutations([1, 0, 1]))
        [(0, 1, 1), (1, 0, 1), (1, 1, 0)]

    Equivalent to yielding from ``set(permutations(iterable))``, except
    duplicates are not generated and thrown away. For larger input sequences
    this is much more efficient.

    Duplicate permutations arise when there are duplicated elements in the
    input iterable. The number of items returned is
    `n! / (x_1! * x_2! * ... * x_n!)`, where `n` is the total number of
    items input, and each `x_i` is the count of a distinct item in the input
    sequence. The function :func:`multinomial` computes this directly.

    If *r* is given, only the *r*-length permutations are yielded.

        >>> sorted(distinct_permutations([1, 0, 1], r=2))
        [(0, 1), (1, 0), (1, 1)]
        >>> sorted(distinct_permutations(range(3), r=2))
        [(0, 1), (0, 2), (1, 0), (1, 2), (2, 0), (2, 1)]

    *iterable* need not be sortable, but note that using equal (``x == y``)
    but non-identical (``id(x) != id(y)``) elements may produce surprising
    behavior. For example, ``1`` and ``True`` are equal but non-identical:

        >>> list(distinct_permutations([1, True, '3']))  # doctest: +SKIP
        [
            (1, True, '3'),
            (1, '3', True),
            ('3', 1, True)
        ]
        >>> list(distinct_permutations([1, 2, '3']))  # doctest: +SKIP
        [
            (1, 2, '3'),
            (1, '3', 2),
            (2, 1, '3'),
            (2, '3', 1),
            ('3', 1, 2),
            ('3', 2, 1)
        ]
    """
```

#### 12: `split_at` Function

**Function Description**: 
Split an iterable object at a specified position.

**Core Algorithm**: 
Split the iterable object at the matching position according to a conditional function.

**Input/Output Example**:
```python

def split_at(iterable, pred, maxsplit=-1, keep_separator=False):
    """Yield lists of items from *iterable*, where each list is delimited by
    an item where callable *pred* returns ``True``.

        >>> list(split_at('abcdcba', lambda x: x == 'b'))
        [['a'], ['c', 'd', 'c'], ['a']]

        >>> list(split_at(range(10), lambda n: n % 2 == 1))
        [[0], [2], [4], [6], [8], []]

    At most *maxsplit* splits are done. If *maxsplit* is not specified or -1,
    then there is no limit on the number of splits:

        >>> list(split_at(range(10), lambda n: n % 2 == 1, maxsplit=2))
        [[0], [2], [4, 5, 6, 7, 8, 9]]

    By default, the delimiting items are not included in the output.
    To include them, set *keep_separator* to ``True``.

        >>> list(split_at('abcdcba', lambda x: x == 'b', keep_separator=True))
        [['a'], ['b'], ['c', 'd', 'c'], ['b'], ['a']]

    """
```

#### 13: `split_before` Function

**Function Description**: 
Split before elements that meet a condition.

**Core Algorithm**: 
Split before each element that meets the condition.

**Input/Output Example**:
```python

def split_before(iterable, pred, maxsplit=-1):
    """Yield lists of items from *iterable*, where each list ends just before
    an item for which callable *pred* returns ``True``:

        >>> list(split_before('OneTwo', lambda s: s.isupper()))
        [['O', 'n', 'e'], ['T', 'w', 'o']]

        >>> list(split_before(range(10), lambda n: n % 3 == 0))
        [[0, 1, 2], [3, 4, 5], [6, 7, 8], [9]]

    At most *maxsplit* splits are done. If *maxsplit* is not specified or -1,
    then there is no limit on the number of splits:

        >>> list(split_before(range(10), lambda n: n % 3 == 0, maxsplit=2))
        [[0, 1, 2], [3, 4, 5], [6, 7, 8, 9]]
    """
```

#### 14: `split_after` Function

**Function Description**: 
Split after elements that meet a condition.

**Core Algorithm**: 
Split after each element that meets the condition.

**Input/Output Example**:
```python
def split_after(iterable, pred, maxsplit=-1):
    """Yield lists of items from *iterable*, where each list ends with an
    item where callable *pred* returns ``True``:

        >>> list(split_after('one1two2', lambda s: s.isdigit()))
        [['o', 'n', 'e', '1'], ['t', 'w', 'o', '2']]

        >>> list(split_after(range(10), lambda n: n % 3 == 0))
        [[0], [1, 2, 3], [4, 5, 6], [7, 8, 9]]

    At most *maxsplit* splits are done. If *maxsplit* is not specified or -1,
    then there is no limit on the number of splits:

        >>> list(split_after(range(10), lambda n: n % 3 == 0, maxsplit=2))
        [[0], [1, 2, 3], [4, 5, 6, 7, 8, 9]]

    """
```

#### 15: `split_into` Function

**Function Description**: 
Split an iterable object according to a specified size.

**Core Algorithm**: 
Split the iterable object into multiple parts based on a specified size list.

**Input/Output Example**:
```python

def split_into(iterable, sizes):
    """Yield a list of sequential items from *iterable* of length 'n' for each
    integer 'n' in *sizes*.

        >>> list(split_into([1,2,3,4,5,6], [1,2,3]))
        [[1], [2, 3], [4, 5, 6]]

    If the sum of *sizes* is smaller than the length of *iterable*, then the
    remaining items of *iterable* will not be returned.

        >>> list(split_into([1,2,3,4,5,6], [2,3]))
        [[1, 2], [3, 4, 5]]

    If the sum of *sizes* is larger than the length of *iterable*, fewer items
    will be returned in the iteration that overruns the *iterable* and further
    lists will be empty:

        >>> list(split_into([1,2,3,4], [1,2,3,4]))
        [[1], [2, 3], [4], []]

    When a ``None`` object is encountered in *sizes*, the returned list will
    contain items up to the end of *iterable* the same way that
    :func:`itertools.slice` does:

        >>> list(split_into([1,2,3,4,5,6,7,8,9,0], [2,3,None]))
        [[1, 2], [3, 4, 5], [6, 7, 8, 9, 0]]

    :func:`split_into` can be useful for grouping a series of items where the
    sizes of the groups are not uniform. An example would be where in a row
    from a table, multiple columns represent elements of the same feature
    (e.g. a point represented by x,y,z) but, the format is not the same for
    all columns.
    """
    # convert the iterable argument into an iterator so its contents can
    # be consumed by islice in case it is a generator
```

#### 16: `padded` Function

**Function Description**: 
Pad an iterable object with a specified value to a specified length.

**Core Algorithm**: 
Add padding values to the end of the iterable object until it reaches the specified length.

**Input/Output Example**:
```python

def padded(iterable, fillvalue=None, n=None, next_multiple=False):
    """Yield the elements from *iterable*, followed by *fillvalue*, such that
    at least *n* items are emitted.

        >>> list(padded([1, 2, 3], '?', 5))
        [1, 2, 3, '?', '?']

    If *next_multiple* is ``True``, *fillvalue* will be emitted until the
    number of items emitted is a multiple of *n*:

        >>> list(padded([1, 2, 3, 4], n=3, next_multiple=True))
        [1, 2, 3, 4, None, None]

    If *n* is ``None``, *fillvalue* will be emitted indefinitely.

    To create an *iterable* of exactly size *n*, you can truncate with
    :func:`islice`.

        >>> list(islice(padded([1, 2, 3], '?'), 5))
        [1, 2, 3, '?', '?']
        >>> list(islice(padded([1, 2, 3, 4, 5, 6, 7, 8], '?'), 5))
        [1, 2, 3, 4, 5]

    """
```

#### 17: `repeat_each` Function

**Function Description**: 
Repeat each element a specified number of times.

**Core Algorithm**: 
Repeat each element in the iterable object `n` times.

**Input/Output Example**:
```python
def repeat_each(iterable, n=2):
    """Repeat each element in *iterable* *n* times.

    >>> list(repeat_each('ABC', 3))
    ['A', 'A', 'A', 'B', 'B', 'B', 'C', 'C', 'C']
    """
```

#### 18: `distribute` Function

**Function Description**: 
Distribute elements as evenly as possible into `n` containers.

**Core Algorithm**: 
Use a round-robin method to distribute elements to each container.

**Input/Output Example**:
```python

def distribute(n, iterable):
    """Distribute the items from *iterable* among *n* smaller iterables.

        >>> group_1, group_2 = distribute(2, [1, 2, 3, 4, 5, 6])
        >>> list(group_1)
        [1, 3, 5]
        >>> list(group_2)
        [2, 4, 6]

    If the length of *iterable* is not evenly divisible by *n*, then the
    length of the returned iterables will not be identical:

        >>> children = distribute(3, [1, 2, 3, 4, 5, 6, 7])
        >>> [list(c) for c in children]
        [[1, 4, 7], [2, 5], [3, 6]]

    If the length of *iterable* is smaller than *n*, then the last returned
    iterables will be empty:

        >>> children = distribute(5, [1, 2, 3])
        >>> [list(c) for c in children]
        [[1], [2], [3], [], []]

    This function uses :func:`itertools.tee` and may require significant
    storage.

    If you need the order items in the smaller iterables to match the
    original iterable, see :func:`divide`.

    """
```

#### 19: `stagger` Function

**Function Description**: 
Generate staggered sliding windows.

**Core Algorithm**: 
Generate staggered sequences with a specified offset.

**Input/Output Example**:
```python

def stagger(iterable, offsets=(-1, 0, 1), longest=False, fillvalue=None):
    """Yield tuples whose elements are offset from *iterable*.
    The amount by which the `i`-th item in each tuple is offset is given by
    the `i`-th item in *offsets*.

        >>> list(stagger([0, 1, 2, 3]))
        [(None, 0, 1), (0, 1, 2), (1, 2, 3)]
        >>> list(stagger(range(8), offsets=(0, 2, 4)))
        [(0, 2, 4), (1, 3, 5), (2, 4, 6), (3, 5, 7)]

    By default, the sequence will end when the final element of a tuple is the
    last item in the iterable. To continue until the first element of a tuple
    is the last item in the iterable, set *longest* to ``True``::

        >>> list(stagger([0, 1, 2, 3], longest=True))
        [(None, 0, 1), (0, 1, 2), (1, 2, 3), (2, 3, None), (3, None, None)]

    By default, ``None`` will be used to replace offsets beyond the end of the
    sequence. Specify *fillvalue* to use some other value.

    """
```

#### 20: `zip_offset` Function

**Function Description**: 
Perform a `zip` operation on iterable objects with an offset.

**Core Algorithm**: 
Apply an offset to the iterable objects and then perform a `zip` operation.

**Input/Output Example**:
```python

def zip_offset(*iterables, offsets, longest=False, fillvalue=None):
    """``zip`` the input *iterables* together, but offset the `i`-th iterable
    by the `i`-th item in *offsets*.

        >>> list(zip_offset('0123', 'abcdef', offsets=(0, 1)))
        [('0', 'b'), ('1', 'c'), ('2', 'd'), ('3', 'e')]

    This can be used as a lightweight alternative to SciPy or pandas to analyze
    data sets in which some series have a lead or lag relationship.

    By default, the sequence will end when the shortest iterable is exhausted.
    To continue until the longest iterable is exhausted, set *longest* to
    ``True``.

        >>> list(zip_offset('0123', 'abcdef', offsets=(0, 1), longest=True))
        [('0', 'b'), ('1', 'c'), ('2', 'd'), ('3', 'e'), (None, 'f')]

    By default, ``None`` will be used to replace offsets beyond the end of the
    sequence. Specify *fillvalue* to use some other value.

    """
```

#### 21: `unzip` Function

**Function Description**: 
Unzip a zipped sequence back to the original sequences.

**Core Algorithm**: 
The inverse operation of `zip`, transpose a sequence of tuples back to the original sequences.

**Input/Output Example**:
```python

def unzip(iterable):
    """The inverse of :func:`zip`, this function disaggregates the elements
    of the zipped *iterable*.

    The ``i``-th iterable contains the ``i``-th element from each element
    of the zipped iterable. The first element is used to determine the
    length of the remaining elements.

        >>> iterable = [('a', 1), ('b', 2), ('c', 3), ('d', 4)]
        >>> letters, numbers = unzip(iterable)
        >>> list(letters)
        ['a', 'b', 'c', 'd']
        >>> list(numbers)
        [1, 2, 3, 4]

    This is similar to using ``zip(*iterable)``, but it avoids reading
    *iterable* into memory. Note, however, that this function uses
    :func:`itertools.tee` and thus may require significant storage.

    """
```

#### 22: `sort_together` Function

**Function Description**: 
Sort multiple iterable objects based on one or more keys.

**Core Algorithm**: 
Perform parallel sorting on multiple sequences using the specified keys.

**Input/Output Example**:
```python

def sort_together(
    iterables, key_list=(0,), key=None, reverse=False, strict=False
):
    """Return the input iterables sorted together, with *key_list* as the
    priority for sorting. All iterables are trimmed to the length of the
    shortest one.

    This can be used like the sorting function in a spreadsheet. If each
    iterable represents a column of data, the key list determines which
    columns are used for sorting.

    By default, all iterables are sorted using the ``0``-th iterable::

        >>> iterables = [(4, 3, 2, 1), ('a', 'b', 'c', 'd')]
        >>> sort_together(iterables)
        [(1, 2, 3, 4), ('d', 'c', 'b', 'a')]

    Set a different key list to sort according to another iterable.
    Specifying multiple keys dictates how ties are broken::

        >>> iterables = [(3, 1, 2), (0, 1, 0), ('c', 'b', 'a')]
        >>> sort_together(iterables, key_list=(1, 2))
        [(2, 3, 1), (0, 0, 1), ('a', 'c', 'b')]

    To sort by a function of the elements of the iterable, pass a *key*
    function. Its arguments are the elements of the iterables corresponding to
    the key list::

        >>> names = ('a', 'b', 'c')
        >>> lengths = (1, 2, 3)
        >>> widths = (5, 2, 1)
        >>> def area(length, width):
        ...     return length * width
        >>> sort_together([names, lengths, widths], key_list=(1, 2), key=area)
        [('c', 'b', 'a'), (3, 2, 1), (1, 2, 5)]

    Set *reverse* to ``True`` to sort in descending order.

        >>> sort_together([(1, 2, 3), ('c', 'b', 'a')], reverse=True)
        [(3, 2, 1), ('a', 'b', 'c')]

    If the *strict* keyword argument is ``True``, then
    ``ValueError`` will be raised if any of the iterables have
    different lengths.

    """
```

#### 23: `always_iterable` Function

**Function Description**: 
Ensure that the return value is always iterable.

**Core Algorithm**: 
Convert non-iterable objects into single-element tuples.

**Input/Output Example**:
```python

def always_iterable(obj, base_type=(str, bytes)):
    """If *obj* is iterable, return an iterator over its items::

        >>> obj = (1, 2, 3)
        >>> list(always_iterable(obj))
        [1, 2, 3]

    If *obj* is not iterable, return a one-item iterable containing *obj*::

        >>> obj = 1
        >>> list(always_iterable(obj))
        [1]

    If *obj* is ``None``, return an empty iterable:

        >>> obj = None
        >>> list(always_iterable(None))
        []

    By default, binary and text strings are not considered iterable::

        >>> obj = 'foo'
        >>> list(always_iterable(obj))
        ['foo']

    If *base_type* is set, objects for which ``isinstance(obj, base_type)``
    returns ``True`` won't be considered iterable.

        >>> obj = {'a': 1}
        >>> list(always_iterable(obj))  # Iterate over the dict's keys
        ['a']
        >>> list(always_iterable(obj, base_type=dict))  # Treat dicts as a unit
        [{'a': 1}]

    Set *base_type* to ``None`` to avoid any special handling and treat objects
    Python considers iterable as iterable:

        >>> obj = 'foo'
        >>> list(always_iterable(obj, base_type=None))
        ['f', 'o', 'o']
    """
```

#### 24: `adjacent` Function

**Function Description**: 
Return adjacent elements and their context.

**Core Algorithm**: 
Generate a window containing adjacent elements for each element.

**Input/Output Example**:
```python

def adjacent(predicate, iterable, distance=1):
    """Return an iterable over `(bool, item)` tuples where the `item` is
    drawn from *iterable* and the `bool` indicates whether
    that item satisfies the *predicate* or is adjacent to an item that does.

    For example, to find whether items are adjacent to a ``3``::

        >>> list(adjacent(lambda x: x == 3, range(6)))
        [(False, 0), (False, 1), (True, 2), (True, 3), (True, 4), (False, 5)]

    Set *distance* to change what counts as adjacent. For example, to find
    whether items are two places away from a ``3``:

        >>> list(adjacent(lambda x: x == 3, range(6), distance=2))
        [(False, 0), (True, 1), (True, 2), (True, 3), (True, 4), (True, 5)]

    This is useful for contextualizing the results of a search function.
    For example, a code comparison tool might want to identify lines that
    have changed, but also surrounding lines to give the viewer of the diff
    context.

    The predicate function will only be called once for each item in the
    iterable.

    See also :func:`groupby_transform`, which can be used with this function
    to group ranges of items with the same `bool` value.

    """
    # Allow distance=0 mainly for testing that it reproduces results with map()
```

#### 25: `groupby_transform` Function

**Function Description**: 
Transform elements before grouping.

**Core Algorithm**: 
Apply a transformation function to the elements first, and then group them by the transformed keys.

**Input/Output Example**:
```python

def groupby_transform(iterable, keyfunc=None, valuefunc=None, reducefunc=None):
    """An extension of :func:`itertools.groupby` that can apply transformations
    to the grouped data.

    * *keyfunc* is a function computing a key value for each item in *iterable*
    * *valuefunc* is a function that transforms the individual items from
      *iterable* after grouping
    * *reducefunc* is a function that transforms each group of items

    >>> iterable = 'aAAbBBcCC'
    >>> keyfunc = lambda k: k.upper()
    >>> valuefunc = lambda v: v.lower()
    >>> reducefunc = lambda g: ''.join(g)
    >>> list(groupby_transform(iterable, keyfunc, valuefunc, reducefunc))
    [('A', 'aaa'), ('B', 'bbb'), ('C', 'ccc')]

    Each optional argument defaults to an identity function if not specified.

    :func:`groupby_transform` is useful when grouping elements of an iterable
    using a separate iterable as the key. To do this, :func:`zip` the iterables
    and pass a *keyfunc* that extracts the first element and a *valuefunc*
    that extracts the second element::

        >>> from operator import itemgetter
        >>> keys = [0, 0, 1, 1, 1, 2, 2, 2, 3]
        >>> values = 'abcdefghi'
        >>> iterable = zip(keys, values)
        >>> grouper = groupby_transform(iterable, itemgetter(0), itemgetter(1))
        >>> [(k, ''.join(g)) for k, g in grouper]
        [(0, 'ab'), (1, 'cde'), (2, 'fgh'), (3, 'i')]

    Note that the order of items in the iterable is significant.
    Only adjacent items are grouped together, so if you don't want any
    duplicate groups, you should sort the iterable by the key function.

    """
```

#### 26: `interleave` Function

**Function Description**: 
Interleave multiple iterable objects.

**Core Algorithm**: 
Take elements alternately from each iterable object.

**Input/Output Example**:
```python

def interleave(*iterables):
    """Return a new iterable yielding from each iterable in turn,
    until the shortest is exhausted.

        >>> list(interleave([1, 2, 3], [4, 5], [6, 7, 8]))
        [1, 4, 6, 2, 5, 7]

    For a version that doesn't terminate after the shortest iterable is
    exhausted, see :func:`interleave_longest`.

    """
```

#### 27: `interleave_longest` Function

**Function Description**: 
Interleave multiple iterable objects until the longest one is exhausted.

**Core Algorithm**: 
Take elements alternately from each iterable object, filling shorter ones with a fill value.

**Input/Output Example**:
```python

def interleave_longest(*iterables):
    """Return a new iterable yielding from each iterable in turn,
    skipping any that are exhausted.

        >>> list(interleave_longest([1, 2, 3], [4, 5], [6, 7, 8]))
        [1, 4, 6, 2, 5, 7, 3, 8]

    This function produces the same output as :func:`roundrobin`, but may
    perform better for some inputs (in particular when the number of iterables
    is large).

    """
```

#### 28: `collapse` Function

**Function Description**: 
Flatten a nested iterable object.

**Core Algorithm**: 
Recursively expand nested iterable objects.

**Input/Output Example**:
```python

def collapse(iterable, base_type=None, levels=None):
    """Flatten an iterable with multiple levels of nesting (e.g., a list of
    lists of tuples) into non-iterable types.

        >>> iterable = [(1, 2), ([3, 4], [[5], [6]])]
        >>> list(collapse(iterable))
        [1, 2, 3, 4, 5, 6]

    Binary and text strings are not considered iterable and
    will not be collapsed.

    To avoid collapsing other types, specify *base_type*:

        >>> iterable = ['ab', ('cd', 'ef'), ['gh', 'ij']]
        >>> list(collapse(iterable, base_type=tuple))
        ['ab', ('cd', 'ef'), 'gh', 'ij']

    Specify *levels* to stop flattening after a certain level:

    >>> iterable = [('a', ['b']), ('c', ['d'])]
    >>> list(collapse(iterable))  # Fully flattened
    ['a', 'b', 'c', 'd']
    >>> list(collapse(iterable, levels=1))  # Only one level flattened
    ['a', ['b'], 'c', ['d']]

    """
```

#### 29: `side_effect` Function

**Function Description**: 
Execute a side-effect function during iteration.

**Core Algorithm**: 
Call the side-effect function on each iteration and then yield the original element.

**Input/Output Example**:
```python

def side_effect(func, iterable, chunk_size=None, before=None, after=None):
    """Invoke *func* on each item in *iterable* (or on each *chunk_size* group
    of items) before yielding the item.

    `func` must be a function that takes a single argument. Its return value
    will be discarded.

    *before* and *after* are optional functions that take no arguments. They
    will be executed before iteration starts and after it ends, respectively.

    `side_effect` can be used for logging, updating progress bars, or anything
    that is not functionally "pure."

    Emitting a status message:

        >>> from more_itertools import consume
        >>> func = lambda item: print('Received {}'.format(item))
        >>> consume(side_effect(func, range(2)))
        Received 0
        Received 1

    Operating on chunks of items:

        >>> pair_sums = []
        >>> func = lambda chunk: pair_sums.append(sum(chunk))
        >>> list(side_effect(func, [0, 1, 2, 3, 4, 5], 2))
        [0, 1, 2, 3, 4, 5]
        >>> list(pair_sums)
        [1, 5, 9]

    Writing to a file-like object:

        >>> from io import StringIO
        >>> from more_itertools import consume
        >>> f = StringIO()
        >>> func = lambda x: print(x, file=f)
        >>> before = lambda: print(u'HEADER', file=f)
        >>> after = f.close
        >>> it = [u'a', u'b', u'c']
        >>> consume(side_effect(func, it, before=before, after=after))
        >>> f.closed
        True

    """
```

#### 30: `sliced` Function

**Function Description**: 
Divide a sequence into slices of a specified size.

**Core Algorithm**: 
Divide the sequence into multiple equal-length subsequences.

**Input/Output Example**:
```python

def sliced(seq, n, strict=False):
    """Yield slices of length *n* from the sequence *seq*.

    >>> list(sliced((1, 2, 3, 4, 5, 6), 3))
    [(1, 2, 3), (4, 5, 6)]

    By the default, the last yielded slice will have fewer than *n* elements
    if the length of *seq* is not divisible by *n*:

    >>> list(sliced((1, 2, 3, 4, 5, 6, 7, 8), 3))
    [(1, 2, 3), (4, 5, 6), (7, 8)]

    If the length of *seq* is not divisible by *n* and *strict* is
    ``True``, then ``ValueError`` will be raised before the last
    slice is yielded.

    This function will only work for iterables that support slicing.
    For non-sliceable iterables, see :func:`chunked`.

    """
```

#### 31: `unique_to_each` Function

**Function Description**: 
Return the unique elements in each iterable object.

**Core Algorithm**: 
Find the elements in each iterable object that are not included in other iterable objects.

**Input/Output Example**:
```python

def unique_to_each(*iterables):
    """Return the elements from each of the input iterables that aren't in the
    other input iterables.

    For example, suppose you have a set of packages, each with a set of
    dependencies::

        {'pkg_1': {'A', 'B'}, 'pkg_2': {'B', 'C'}, 'pkg_3': {'B', 'D'}}

    If you remove one package, which dependencies can also be removed?

    If ``pkg_1`` is removed, then ``A`` is no longer necessary - it is not
    associated with ``pkg_2`` or ``pkg_3``. Similarly, ``C`` is only needed for
    ``pkg_2``, and ``D`` is only needed for ``pkg_3``::

        >>> unique_to_each({'A', 'B'}, {'B', 'C'}, {'B', 'D'})
        [['A'], ['C'], ['D']]

    If there are duplicates in one input iterable that aren't in the others
    they will be duplicated in the output. Input order is preserved::

        >>> unique_to_each("mississippi", "missouri")
        [['p', 'p'], ['o', 'u', 'r']]

    It is assumed that the elements of each iterable are hashable.

    """
```

#### 32: substrings Function

**Function Description**: 
Generate all possible substrings

**Core Algorithm**: 
Generate all consecutive subsequences of the input sequence

**Input and Output Examples**:
```python

def substrings(iterable):
    """Yield all of the substrings of *iterable*.

        >>> [''.join(s) for s in substrings('more')]
        ['m', 'o', 'r', 'e', 'mo', 'or', 're', 'mor', 'ore', 'more']

    Note that non-string iterables can also be subdivided.

        >>> list(substrings([0, 1, 2]))
        [(0,), (1,), (2,), (0, 1), (1, 2), (0, 1, 2)]

    """
```

#### 33: substrings_indexes Function

**Function Description**: 
Generate all possible substrings and their indexes

**Core Algorithm**: 
Generate all consecutive subsequences of the input sequence and their positions in the original sequence

**Input and Output Examples**:
```python

def substrings_indexes(seq, reverse=False):
    """Yield all substrings and their positions in *seq*

    The items yielded will be a tuple of the form ``(substr, i, j)``, where
    ``substr == seq[i:j]``.

    This function only works for iterables that support slicing, such as
    ``str`` objects.

    >>> for item in substrings_indexes('more'):
    ...    print(item)
    ('m', 0, 1)
    ('o', 1, 2)
    ('r', 2, 3)
    ('e', 3, 4)
    ('mo', 0, 2)
    ('or', 1, 3)
    ('re', 2, 4)
    ('mor', 0, 3)
    ('ore', 1, 4)
    ('more', 0, 4)

    Set *reverse* to ``True`` to yield the same items in the opposite order.


    """
```

#### 34: bucket Class

**Function Description**: 
Group elements into buckets

**Core Algorithm**: 
Use a key function to assign elements to different buckets

**Input and Output Examples**:
```python
from more import bucket

class bucket:
    """Wrap *iterable* and return an object that buckets the iterable into
    child iterables based on a *key* function.

        >>> iterable = ['a1', 'b1', 'c1', 'a2', 'b2', 'c2', 'b3']
        >>> s = bucket(iterable, key=lambda x: x[0])  # Bucket by 1st character
        >>> sorted(list(s))  # Get the keys
        ['a', 'b', 'c']
        >>> a_iterable = s['a']
        >>> next(a_iterable)
        'a1'
        >>> next(a_iterable)
        'a2'
        >>> list(s['b'])
        ['b1', 'b2', 'b3']

    The original iterable will be advanced and its items will be cached until
    they are used by the child iterables. This may require significant storage.

    By default, attempting to select a bucket to which no items belong  will
    exhaust the iterable and cache all values.
    If you specify a *validator* function, selected buckets will instead be
    checked against it.

        >>> from itertools import count
        >>> it = count(1, 2)  # Infinite sequence of odd numbers
        >>> key = lambda x: x % 10  # Bucket by last digit
        >>> validator = lambda x: x in {1, 3, 5, 7, 9}  # Odd digits only
        >>> s = bucket(it, key=key, validator=validator)
        >>> 2 in s
        False
        >>> list(s[2])
        []

    """
    def __init__(
        self,
        iterable: Iterable[_T],
        key: Callable[[_T], _U],
        validator: Callable[[_U], object] | None = ...,
    ) -> None: ...
    def __contains__(self, value: object) -> bool: ...
    def __iter__(self) -> Iterator[_U]: ...
    def __getitem__(self, value: object) -> Iterator[_T]: ...
```

#### 35: spy Function

**Function Description**: 
Peek at the first few elements of an iterable without consuming it

**Core Algorithm**: 
Cache the first n elements so that they can be iterated over multiple times

**Input and Output Examples**:
```python

def spy(iterable, n=1):
    """Return a 2-tuple with a list containing the first *n* elements of
    *iterable*, and an iterator with the same items as *iterable*.
    This allows you to "look ahead" at the items in the iterable without
    advancing it.

    There is one item in the list by default:

        >>> iterable = 'abcdefg'
        >>> head, iterable = spy(iterable)
        >>> head
        ['a']
        >>> list(iterable)
        ['a', 'b', 'c', 'd', 'e', 'f', 'g']

    You may use unpacking to retrieve items instead of lists:

        >>> (head,), iterable = spy('abcdefg')
        >>> head
        'a'
        >>> (first, second), iterable = spy('abcdefg', 2)
        >>> first
        'a'
        >>> second
        'b'

    The number of items requested can be larger than the number of items in
    the iterable:

        >>> iterable = [1, 2, 3, 4, 5]
        >>> head, iterable = spy(iterable, 10)
        >>> head
        [1, 2, 3, 4, 5]
        >>> list(iterable)
        [1, 2, 3, 4, 5]

    """
```

#### 36: interleave_evenly Function

**Function Description**: 
Interleave multiple iterables as evenly as possible

**Core Algorithm**: 
Allocate element positions according to the length ratio of the iterables

**Input and Output Examples**:
```python

def interleave_evenly(iterables, lengths=None):
    """
    Interleave multiple iterables so that their elements are evenly distributed
    throughout the output sequence.

    >>> iterables = [1, 2, 3, 4, 5], ['a', 'b']
    >>> list(interleave_evenly(iterables))
    [1, 2, 'a', 3, 4, 'b', 5]

    >>> iterables = [[1, 2, 3], [4, 5], [6, 7, 8]]
    >>> list(interleave_evenly(iterables))
    [1, 6, 4, 2, 7, 3, 8, 5]

    This function requires iterables of known length. Iterables without
    ``__len__()`` can be used by manually specifying lengths with *lengths*:

    >>> from itertools import combinations, repeat
    >>> iterables = [combinations(range(4), 2), ['a', 'b', 'c']]
    >>> lengths = [4 * (4 - 1) // 2, 3]
    >>> list(interleave_evenly(iterables, lengths=lengths))
    [(0, 1), (0, 2), 'a', (0, 3), (1, 2), 'b', (1, 3), (2, 3), 'c']

    Based on Bresenham's algorithm.
    """
```

#### 37: repeat_last Function

**Function Description**: 
Repeat the last element infinitely

**Core Algorithm**: 
After iterating over all elements, repeat the last element infinitely

**Input and Output Examples**:
```python

def repeat_last(iterable, default=None):
    """After the *iterable* is exhausted, keep yielding its last element.

        >>> list(islice(repeat_last(range(3)), 5))
        [0, 1, 2, 2, 2]

    If the iterable is empty, yield *default* forever::

        >>> list(islice(repeat_last(range(0), 42), 5))
        [42, 42, 42, 42, 42]

    """
```

#### 38: minmax Function
**Function Description**: 
Find the minimum and maximum values simultaneously
**Core Algorithm**: 
Calculate the minimum and maximum values simultaneously in a single pass
**Input and Output Examples**:
```python

def minmax(iterable_or_value, *others, key=None, default=_marker):
    """Returns both the smallest and largest items from an iterable
    or from two or more arguments.

        >>> minmax([3, 1, 5])
        (1, 5)

        >>> minmax(4, 2, 6)
        (2, 6)

    If a *key* function is provided, it will be used to transform the input
    items for comparison.

        >>> minmax([5, 30], key=str)  # '30' sorts before '5'
        (30, 5)

    If a *default* value is provided, it will be returned if there are no
    input items.

        >>> minmax([], default=(0, 0))
        (0, 0)

    Otherwise ``ValueError`` is raised.

    This function makes a single pass over the input elements and takes care to
    minimize the number of comparisons made during processing.

    Note that unlike the builtin ``max`` function, which always returns the first
    item with the maximum value, this function may return another item when there are
    ties.

    This function is based on the
    `recipe <https://code.activestate.com/recipes/577916-fast-minmax-function>`__ by
    Raymond Hettinger.
    """
```

#### 39: ilen Function

**Function Description**: 
Calculate the length of an iterable

**Core Algorithm**: 
Calculate the length of an iterable without converting it to a list

**Input and Output Examples**:
```python

def ilen(iterable):
    """Return the number of items in *iterable*.

    For example, there are 168 prime numbers below 1,000:

        >>> ilen(sieve(1000))
        168

    Equivalent to, but faster than::

        def ilen(iterable):
            count = 0
            for _ in iterable:
                count += 1
            return count

    This fully consumes the iterable, so handle with care.

    """
    # This is the "most beautiful of the fast variants" of this function.
    # If you think you can improve on it, please ensure that your version
    # is both 10x faster and 10x more beautiful.
```

#### 40: with_iter Function

**Function Description**: 
Create a context manager to manage an iterable

**Core Algorithm**: 
Automatically close the iterable when the context manager exits

**Input and Output Examples**:
```python

def with_iter(context_manager):
    """Wrap an iterable in a ``with`` statement, so it closes once exhausted.

    For example, this will close the file when the iterator is exhausted::

        upper_lines = (line.upper() for line in with_iter(open('foo')))

    Any context manager which returns an iterable is a candidate for
    ``with_iter``.

    """
```

#### 41: one Function

**Function Description**: 
Return the only element in an iterable

**Core Algorithm**: 
Ensure that the iterable has only one element and return it 

**Input and Output Examples**:
```python

def one(iterable, too_short=None, too_long=None):
    """Return the first item from *iterable*, which is expected to contain only
    that item. Raise an exception if *iterable* is empty or has more than one
    item.

    :func:`one` is useful for ensuring that an iterable contains only one item.
    For example, it can be used to retrieve the result of a database query
    that is expected to return a single row.

    If *iterable* is empty, ``ValueError`` will be raised. You may specify a
    different exception with the *too_short* keyword:

        >>> it = []
        >>> one(it)  # doctest: +IGNORE_EXCEPTION_DETAIL
        Traceback (most recent call last):
        ...
        ValueError: too few items in iterable (expected 1)'
        >>> too_short = IndexError('too few items')
        >>> one(it, too_short=too_short)  # doctest: +IGNORE_EXCEPTION_DETAIL
        Traceback (most recent call last):
        ...
        IndexError: too few items

    Similarly, if *iterable* contains more than one item, ``ValueError`` will
    be raised. You may specify a different exception with the *too_long*
    keyword:

        >>> it = ['too', 'many']
        >>> one(it)  # doctest: +IGNORE_EXCEPTION_DETAIL
        Traceback (most recent call last):
        ...
        ValueError: Expected exactly one item in iterable, but got 'too',
        'many', and perhaps more.
        >>> too_long = RuntimeError
        >>> one(it, too_long=too_long)  # doctest: +IGNORE_EXCEPTION_DETAIL
        Traceback (most recent call last):
        ...
        RuntimeError

    Note that :func:`one` attempts to advance *iterable* twice to ensure there
    is only one item. See :func:`spy` or :func:`peekable` to check iterable
    contents less destructively.

    """
```

#### 43 intersperse Function

**Function Description**: 
Insert a separator between elements

**Core Algorithm**: 
Insert a specified element between each pair of adjacent elements in an iterable

**Input and Output Examples**:
```python

def intersperse(e, iterable, n=1):
    """Intersperse filler element *e* among the items in *iterable*, leaving
    *n* items between each filler element.

        >>> list(intersperse('!', [1, 2, 3, 4, 5]))
        [1, '!', 2, '!', 3, '!', 4, '!', 5]

        >>> list(intersperse(None, [1, 2, 3, 4, 5], n=2))
        [1, 2, None, 3, 4, None, 5]

    """
```

#### 43: divide Function

**Function Description**: 
Divide an iterable into n parts as evenly as possible
**Core Algorithm**: 
Distribute elements to n containers in sequence, ensuring that the size difference does not exceed 1
**Input and Output Examples**:
```python

def divide(n, iterable):
    """Divide the elements from *iterable* into *n* parts, maintaining
    order.

        >>> group_1, group_2 = divide(2, [1, 2, 3, 4, 5, 6])
        >>> list(group_1)
        [1, 2, 3]
        >>> list(group_2)
        [4, 5, 6]

    If the length of *iterable* is not evenly divisible by *n*, then the
    length of the returned iterables will not be identical:

        >>> children = divide(3, [1, 2, 3, 4, 5, 6, 7])
        >>> [list(c) for c in children]
        [[1, 2, 3], [4, 5], [6, 7]]

    If the length of the iterable is smaller than n, then the last returned
    iterables will be empty:

        >>> children = divide(5, [1, 2, 3])
        >>> [list(c) for c in children]
        [[1], [2], [3], [], []]

    This function will exhaust the iterable before returning.
    If order is not important, see :func:`distribute`, which does not first
    pull the iterable into memory.

    """
```

#### 44: grouper Function

**Function Description**: 
Group an iterable into fixed-size chunks
**Core Algorithm**: 
Collect elements into fixed-size tuples, with an optional fill value
**Input and Output Examples**:
```python
from more_itertools.recipes import grouper

def grouper(iterable, n, incomplete='fill', fillvalue=None):
    """Group elements from *iterable* into fixed-length groups of length *n*.

    >>> list(grouper('ABCDEF', 3))
    [('A', 'B', 'C'), ('D', 'E', 'F')]

    The keyword arguments *incomplete* and *fillvalue* control what happens for
    iterables whose length is not a multiple of *n*.

    When *incomplete* is `'fill'`, the last group will contain instances of
    *fillvalue*.

    >>> list(grouper('ABCDEFG', 3, incomplete='fill', fillvalue='x'))
    [('A', 'B', 'C'), ('D', 'E', 'F'), ('G', 'x', 'x')]

    When *incomplete* is `'ignore'`, the last group will not be emitted.

    >>> list(grouper('ABCDEFG', 3, incomplete='ignore', fillvalue='x'))
    [('A', 'B', 'C'), ('D', 'E', 'F')]

    When *incomplete* is `'strict'`, a `ValueError` will be raised.

    >>> iterator = grouper('ABCDEFG', 3, incomplete='strict')
    >>> list(iterator)  # doctest: +IGNORE_EXCEPTION_DETAIL
    Traceback (most recent call last):
    ...
    ValueError

    """
```

#### 45: roundrobin Function

**Function Description**: 
Take elements from multiple iterables in turn
**Core Algorithm**: 
Iterate through each iterable cyclically until all elements are consumed
**Input and Output Examples**:
```python
import more_itertools.recipes as roundrobin

def roundrobin(*iterables):
    """Visit input iterables in a cycle until each is exhausted.

        >>> list(roundrobin('ABC', 'D', 'EF'))
        ['A', 'D', 'E', 'B', 'F', 'C']

    This function produces the same output as :func:`interleave_longest`, but
    may perform better for some inputs (in particular when the number of
    iterables is small).

    """
```

#### 46: powerset Function

**Function Description**: 
Generate all possible subsets of a set
**Core Algorithm**: 
Generate all possible combinations from the empty set to the full set
**Input and Output Examples**:
```python

def powerset(iterable):
    """Yields all possible subsets of the iterable.

        >>> list(powerset([1, 2, 3]))
        [(), (1,), (2,), (3,), (1, 2), (1, 3), (2, 3), (1, 2, 3)]

    :func:`powerset` will operate on iterables that aren't :class:`set`
    instances, so repeated elements in the input will produce repeated elements
    in the output.

        >>> seq = [1, 1, 0]
        >>> list(powerset(seq))
        [(), (1,), (1,), (0,), (1, 1), (1, 0), (1, 0), (1, 1, 0)]

    For a variant that efficiently yields actual :class:`set` instances, see
    :func:`powerset_of_sets`.
    """
```

#### 47: unique_everseen Function

**Function Description**: 
Remove duplicate elements while maintaining order
**Core Algorithm**: 
Keep track of seen elements and only keep the first occurrence of each element
**Input and Output Examples**:
```python

def unique_everseen(iterable, key=None):
    """
    Yield unique elements, preserving order.

        >>> list(unique_everseen('AAAABBBCCDAABBB'))
        ['A', 'B', 'C', 'D']
        >>> list(unique_everseen('ABBCcAD', str.lower))
        ['A', 'B', 'C', 'D']

    Sequences with a mix of hashable and unhashable items can be used.
    The function will be slower (i.e., `O(n^2)`) for unhashable items.

    Remember that ``list`` objects are unhashable - you can use the *key*
    parameter to transform the list to a tuple (which is hashable) to
    avoid a slowdown.

        >>> iterable = ([1, 2], [2, 3], [1, 2])
        >>> list(unique_everseen(iterable))  # Slow
        [[1, 2], [2, 3]]
        >>> list(unique_everseen(iterable, key=tuple))  # Faster
        [[1, 2], [2, 3]]

    Similarly, you may want to convert unhashable ``set`` objects with
    ``key=frozenset``. For ``dict`` objects,
    ``key=lambda x: frozenset(x.items())`` can be used.

    """
```

#### 48: first_true Function

**Function Description**: 
Return the first element that makes a condition true
**Core Algorithm**: 
Iterate through the iterable and return the first element that satisfies the condition
**Input and Output Examples**:
```python

def first_true(iterable, default=None, pred=None):
    """
    Returns the first true value in the iterable.

    If no true value is found, returns *default*

    If *pred* is not None, returns the first item for which
    ``pred(item) == True`` .

        >>> first_true(range(10))
        1
        >>> first_true(range(10), pred=lambda x: x > 5)
        6
        >>> first_true(range(10), default='missing', pred=lambda x: x > 9)
        'missing'

    """
```

#### 50 random_combination Function

**Function Description**: 
Randomly select r non-repeating elements from an iterable
**Core Algorithm**: 
Use random sampling to ensure non-repeating elements
**Input and Output Examples**:
```python

def random_combination(iterable, r):
    """Return a random *r* length subsequence of the elements in *iterable*.

        >>> random_combination(range(5), 3)  # doctest:+SKIP
        (2, 3, 4)

    This equivalent to taking a random selection from
    ``itertools.combinations(iterable, r)``.

    """
```

#### 50: nth_combination Function

**Function Description**: 
Get the nth combination in lexicographical order
**Core Algorithm**: 
Calculate the combination at a specific position without generating all combinations 
**Input and Output Examples**:
```python
from recipes import nth_combination
def nth_combination(iterable, r, index):
    """Equivalent to ``list(combinations(iterable, r))[index]``.

    The subsequences of *iterable* that are of length *r* can be ordered
    lexicographically. :func:`nth_combination` computes the subsequence at
    sort position *index* directly, without computing the previous
    subsequences.

        >>> nth_combination(range(5), 3, 5)
        (0, 3, 4)

    ``ValueError`` will be raised If *r* is negative or greater than the length
    of *iterable*.
    ``IndexError`` will be raised if the given *index* is invalid.
    """
```

#### 51: triplewise Function

**Function Description**: 
Return consecutive triples of elements 
**Core Algorithm**: 
Generate consecutive triples 
**Input and Output Examples**:
```python

def triplewise(iterable):
    """Return overlapping triplets from *iterable*.

    >>> list(triplewise('ABCDE'))
    [('A', 'B', 'C'), ('B', 'C', 'D'), ('C', 'D', 'E')]

    """
    # This deviates from the itertools documentation recipe - see

```

#### 52: sieve Function

**Function Description**: 
Generate prime numbers using the Sieve of Eratosthenes 
**Core Algorithm**: 
Use the sieve method to find all prime numbers less than n
**Input and Output Examples**:
```python

def sieve(n):
    """Yield the primes less than n.

    >>> list(sieve(30))
    [2, 3, 5, 7, 11, 13, 17, 19, 23, 29]

    """
    # This implementation comes from an older version of the itertools
    # documentation.  The newer implementation is easier to read but is
    # less lazy.
```


#### 53: `numeric_range` Class

**Function Description**: 
An extension of the built-in ``range()`` function whose arguments can be any orderable numeric type.

**Core Algorithm**: 
With only *stop* specified, *start* defaults to ``0`` and *step* defaults to ``1``. The output items will match the type of *stop*:

**Input/Output Example**:
```python

class numeric_range(Sequence):
    """An extension of the built-in ``range()`` function whose arguments can
    be any orderable numeric type.

    With only *stop* specified, *start* defaults to ``0`` and *step*
    defaults to ``1``. The output items will match the type of *stop*:

        >>> list(numeric_range(3.5))
        [0.0, 1.0, 2.0, 3.0]

    With only *start* and *stop* specified, *step* defaults to ``1``. The
    output items will match the type of *start*:

        >>> from decimal import Decimal
        >>> start = Decimal('2.1')
        >>> stop = Decimal('5.1')
        >>> list(numeric_range(start, stop))
        [Decimal('2.1'), Decimal('3.1'), Decimal('4.1')]

    With *start*, *stop*, and *step*  specified the output items will match
    the type of ``start + step``:

        >>> from fractions import Fraction
        >>> start = Fraction(1, 2)  # Start at 1/2
        >>> stop = Fraction(5, 2)  # End at 5/2
        >>> step = Fraction(1, 2)  # Count by 1/2
        >>> list(numeric_range(start, stop, step))
        [Fraction(1, 2), Fraction(1, 1), Fraction(3, 2), Fraction(2, 1)]

    If *step* is zero, ``ValueError`` is raised. Negative steps are supported:

        >>> list(numeric_range(3, -1, -1.0))
        [3.0, 2.0, 1.0, 0.0]

    Be aware of the limitations of floating-point numbers; the representation
    of the yielded numbers may be surprising.

    ``datetime.datetime`` objects can be used for *start* and *stop*, if *step*
    is a ``datetime.timedelta`` object:

        >>> import datetime
        >>> start = datetime.datetime(2019, 1, 1)
        >>> stop = datetime.datetime(2019, 1, 3)
        >>> step = datetime.timedelta(days=1)
        >>> items = iter(numeric_range(start, stop, step))
        >>> next(items)
        datetime.datetime(2019, 1, 1, 0, 0)
        >>> next(items)
        datetime.datetime(2019, 1, 2, 0, 0)

    """
    
class numeric_range(Generic[_T, _U], Sequence[_T], Hashable, Reversible[_T]):
    @overload
    def __init__(self, __stop: _T) -> None: ...
    @overload
    def __init__(self, __start: _T, __stop: _T) -> None: ...
    @overload
    def __init__(self, __start: _T, __stop: _T, __step: _U) -> None: ...
    def __bool__(self) -> bool: ...
    def __contains__(self, elem: object) -> bool: ...
    def __eq__(self, other: object) -> bool: ...
    @overload
    def __getitem__(self, key: int) -> _T: ...
    @overload
    def __getitem__(self, key: slice) -> numeric_range[_T, _U]: ...
    def __hash__(self) -> int: ...
    def __iter__(self) -> Iterator[_T]: ...
    def __len__(self) -> int: ...
    def __reduce__(
        self,
    ) -> tuple[type[numeric_range[_T, _U]], tuple[_T, _T, _U]]: ...
    def __repr__(self) -> str: ...
    def __reversed__(self) -> Iterator[_T]: ...
    def count(self, value: _T) -> int: ...
    def index(self, value: _T) -> int: ...  # type: ignore

```

#### 54: `islice_extended` Class

**Function Description**: 
An extension of :func:`itertools.islice` that supports negative values for *stop*, *start*, and *step*.

**Core Algorithm**: 
Slices with negative values require some caching of *iterable*, but this function takes care to minimize the amount of memory required.

**Input/Output Example**:
```python

class islice_extended:
    """An extension of :func:`itertools.islice` that supports negative values
    for *stop*, *start*, and *step*.

        >>> iterator = iter('abcdefgh')
        >>> list(islice_extended(iterator, -4, -1))
        ['e', 'f', 'g']

    Slices with negative values require some caching of *iterable*, but this
    function takes care to minimize the amount of memory required.

    For example, you can use a negative step with an infinite iterator:

        >>> from itertools import count
        >>> list(islice_extended(count(), 110, 99, -2))
        [110, 108, 106, 104, 102, 100]

    You can also use slice notation directly:

        >>> iterator = map(str, count())
        >>> it = islice_extended(iterator)[10:20:2]
        >>> list(it)
        ['10', '12', '14', '16', '18']

    """
    
class islice_extended(Generic[_T], Iterator[_T]):
    def __init__(self, iterable: Iterable[_T], *args: int | None) -> None: ...
    def __iter__(self) -> islice_extended[_T]: ...
    def __next__(self) -> _T: ...
    def __getitem__(self, index: slice) -> islice_extended[_T]: ...
```

#### 55: `run_length` Class

**Function Description**: 
:func:`run_length.encode` compresses an iterable with run-length encoding. It yields groups of repeated items with the count of how many times they were repeated:

**Core Algorithm**: 
:func:`run_length.decode` decompresses an iterable that was previously compressed with run-length encoding. It yields the items of the decompressed iterable:

**Input/Output Example**:
```python

    """
    :func:`run_length.encode` compresses an iterable with run-length encoding.
    It yields groups of repeated items with the count of how many times they
    were repeated:

        >>> uncompressed = 'abbcccdddd'
        >>> list(run_length.encode(uncompressed))
        [('a', 1), ('b', 2), ('c', 3), ('d', 4)]

    :func:`run_length.decode` decompresses an iterable that was previously
    compressed with run-length encoding. It yields the items of the
    decompressed iterable:

        >>> compressed = [('a', 1), ('b', 2), ('c', 3), ('d', 4)]
        >>> list(run_length.decode(compressed))
        ['a', 'b', 'b', 'c', 'c', 'c', 'd', 'd', 'd', 'd']

    """

class run_length:
    @staticmethod
    def encode(iterable: Iterable[_T]) -> Iterator[tuple[_T, int]]: ...
    @staticmethod
    def decode(iterable: Iterable[tuple[_T, int]]) -> Iterator[_T]: ...
```

#### 56: `time_limited` Class

**Function Description**: 
Yield items from *iterable* until *limit_seconds* have passed. If the time limit expires before all items have been yielded, the ``timed_out`` parameter will be set to ``True``.

**Core Algorithm**: 
Note that the time is checked before each item is yielded, and iteration stops if the time elapsed is greater than *limit_seconds*. If your time limit is 1 second, but it takes 2 seconds to generate the first item from the iterable, the function will run for 2 seconds and not yield anything. As a special case, when *limit_seconds* is zero, the iterator never returns anything.

**Input/Output Example**:
```python
  """
    Yield items from *iterable* until *limit_seconds* have passed.
    If the time limit expires before all items have been yielded, the
    ``timed_out`` parameter will be set to ``True``.

    >>> from time import sleep
    >>> def generator():
    ...     yield 1
    ...     yield 2
    ...     sleep(0.2)
    ...     yield 3
    >>> iterable = time_limited(0.1, generator())
    >>> list(iterable)
    [1, 2]
    >>> iterable.timed_out
    True

    Note that the time is checked before each item is yielded, and iteration
    stops if  the time elapsed is greater than *limit_seconds*. If your time
    limit is 1 second, but it takes 2 seconds to generate the first item from
    the iterable, the function will run for 2 seconds and not yield anything.
    As a special case, when *limit_seconds* is zero, the iterator never
    returns anything.

    """

class time_limited(Generic[_T], Iterator[_T]):
    def __init__(
        self, limit_seconds: float, iterable: Iterable[_T]
    ) -> None: ...
    def __iter__(self) -> islice_extended[_T]: ...
    def __next__(self) -> _T: ...
```

#### 57: `AbortThread` Class

**Function Description**: 
Lightweight exception used by ``callback_iter`` to signal that a background callback loop was aborted early.

**Core Algorithm**: 
Inherits from ``BaseException`` so it bypasses ``Exception`` handlers and terminates the callback thread promptly when raised.

**Input/Output Example**:
```python
class AbortThread(BaseException):
    pass
```

#### 58: `callback_iter` Class

**Function Description**: 
Convert a function that uses callbacks to an iterator.

**Core Algorithm**: 
Let *func* be a function that takes a `callback` keyword argument. For example:

**Input/Output Example**:
```python

class callback_iter(Generic[_T], Iterator[_T]):
    def __init__(
        self,
        func: Callable[..., Any],
        callback_kwd: str = ...,
        wait_seconds: float = ...,
    ) -> None: ...
    def __enter__(self) -> callback_iter[_T]: ...
    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: types.TracebackType | None,
    ) -> bool | None: ...
    def __iter__(self) -> callback_iter[_T]: ...
    def __next__(self) -> _T: ...
    def _reader(self) -> Iterator[_T]: ...
    @property
    def done(self) -> bool: ...
    @property
    def result(self) -> Any: ...
    """Convert a function that uses callbacks to an iterator.

    Let *func* be a function that takes a `callback` keyword argument.
    For example:

    >>> def func(callback=None):
    ...     for i, c in [(1, 'a'), (2, 'b'), (3, 'c')]:
    ...         if callback:
    ...             callback(i, c)
    ...     return 4


    Use ``with callback_iter(func)`` to get an iterator over the parameters
    that are delivered to the callback.

    >>> with callback_iter(func) as it:
    ...     for args, kwargs in it:
    ...         print(args)
    (1, 'a')
    (2, 'b')
    (3, 'c')

    The function will be called in a background thread. The ``done`` property
    indicates whether it has completed execution.

    >>> it.done
    True

    If it completes successfully, its return value will be available
    in the ``result`` property.

    >>> it.result
    4

    Notes:

    * If the function uses some keyword argument besides ``callback``, supply
      *callback_kwd*.
    * If it finished executing, but raised an exception, accessing the
      ``result`` property will raise the same exception.
    * If it hasn't finished executing, accessing the ``result``
      property from within the ``with`` block will raise ``RuntimeError``.
    * If it hasn't finished executing, accessing the ``result`` property from
      outside the ``with`` block will raise a
      ``more_itertools.AbortThread`` exception.
    * Provide *wait_seconds* to adjust how frequently the it is polled for
      output.

    """
```

#### 59: `countable` Function

**Function Description**: 
Wrap *iterable* and keep a count of how many items have been consumed.

**Core Algorithm**: 
The ``items_seen`` attribute starts at ``0`` and increments as the iterable is consumed:

**Input/Output Example**:
```python
    """Convert a function that uses callbacks to an iterator.

    Let *func* be a function that takes a `callback` keyword argument.
    For example:

    >>> def func(callback=None):
    ...     for i, c in [(1, 'a'), (2, 'b'), (3, 'c')]:
    ...         if callback:
    ...             callback(i, c)
    ...     return 4


    Use ``with callback_iter(func)`` to get an iterator over the parameters
    that are delivered to the callback.

    >>> with callback_iter(func) as it:
    ...     for args, kwargs in it:
    ...         print(args)
    (1, 'a')
    (2, 'b')
    (3, 'c')

    The function will be called in a background thread. The ``done`` property
    indicates whether it has completed execution.

    >>> it.done
    True

    If it completes successfully, its return value will be available
    in the ``result`` property.

    >>> it.result
    4

    Notes:

    * If the function uses some keyword argument besides ``callback``, supply
      *callback_kwd*.
    * If it finished executing, but raised an exception, accessing the
      ``result`` property will raise the same exception.
    * If it hasn't finished executing, accessing the ``result``
      property from within the ``with`` block will raise ``RuntimeError``.
    * If it hasn't finished executing, accessing the ``result`` property from
      outside the ``with`` block will raise a
      ``more_itertools.AbortThread`` exception.
    * Provide *wait_seconds* to adjust how frequently the it is polled for
      output.

    """
class countable(Generic[_T], Iterator[_T]):
    def __init__(self, iterable: Iterable[_T]) -> None: ...
    def __iter__(self) -> countable[_T]: ...
    def __next__(self) -> _T: ...
    items_seen: int
```

#### 61 `consumer` Function

**Function Description**: 
Decorator that automatically advances a PEP-342-style "reverse iterator" to its first yield point so you don't have to call ``next()`` on it manually.

**Core Algorithm**: 
The decorator returns an internal `wrapper(*args, **kwargs)` that primes the generator so you do not have to call `next(t)` before using `t.send(...)`.

**Input/Output Example**:
```python

def consumer(func):
    """Decorator that automatically advances a PEP-342-style "reverse iterator"
    to its first yield point so you don't have to call ``next()`` on it
    manually.

        >>> @consumer
        ... def tally():
        ...     i = 0
        ...     while True:
        ...         print('Thing number %s is %s.' % (i, (yield)))
        ...         i += 1
        ...
        >>> t = tally()
        >>> t.send('red')
        Thing number 0 is red.
        >>> t.send('fish')
        Thing number 1 is fish.

    Without the decorator, you would have to call ``next(t)`` before
    ``t.send()`` could be used.

    """
```

#### 61: `raise_` Function

**Function Description**: 
Utility that raises the given exception type with positional arguments; useful inside expressions.

**Core Algorithm**: 
Calls the provided exception class with *args* and raises the resulting instance immediately.

**Input/Output Example**:
```python

def raise_(exception, *args):
    raise exception(*args)
```

#### 62: `strictly_n` Function

**Function Description**: 
Validate that *iterable* has exactly *n* items and return them if it does. If it has fewer than *n* items, call function *too_short* with the actual number of items. If it has more than *n* items, call function *too_long* with the number ``n + 1``.

**Core Algorithm**: 
Note that the returned iterable must be consumed in order for the check to be made.

**Input/Output Example**:
```python

def strictly_n(iterable, n, too_short=None, too_long=None):
    """Validate that *iterable* has exactly *n* items and return them if
    it does. If it has fewer than *n* items, call function *too_short*
    with the actual number of items. If it has more than *n* items, call function
    *too_long* with the number ``n + 1``.

        >>> iterable = ['a', 'b', 'c', 'd']
        >>> n = 4
        >>> list(strictly_n(iterable, n))
        ['a', 'b', 'c', 'd']

    Note that the returned iterable must be consumed in order for the check to
    be made.

    By default, *too_short* and *too_long* are functions that raise
    ``ValueError``.

        >>> list(strictly_n('ab', 3))  # doctest: +IGNORE_EXCEPTION_DETAIL
        Traceback (most recent call last):
        ...
        ValueError: too few items in iterable (got 2)

        >>> list(strictly_n('abc', 2))  # doctest: +IGNORE_EXCEPTION_DETAIL
        Traceback (most recent call last):
        ...
        ValueError: too many items in iterable (got at least 3)

    You can instead supply functions that do something else.
    *too_short* will be called with the number of items in *iterable*.
    *too_long* will be called with `n + 1`.

        >>> def too_short(item_count):
        ...     raise RuntimeError
        >>> it = strictly_n('abcd', 6, too_short=too_short)
        >>> list(it)  # doctest: +IGNORE_EXCEPTION_DETAIL
        Traceback (most recent call last):
        ...
        RuntimeError

        >>> def too_long(item_count):
        ...     print('The boss is going to hear about this')
        >>> it = strictly_n('abcdef', 4, too_long=too_long)
        >>> list(it)
        The boss is going to hear about this
        ['a', 'b', 'c', 'd']

    """
```

#### 63: `derangements` Function

**Function Description**: 
Yield successive derangements of the elements in *iterable*.

**Core Algorithm**: 
A derangement is a permutation in which no element appears at its original index. In other words, a derangement is a permutation that has no fixed points.

**Input/Output Example**:
```python

def derangements(iterable, r=None):
    """Yield successive derangements of the elements in *iterable*.

    A derangement is a permutation in which no element appears at its original
    index. In other words, a derangement is a permutation that has no fixed points.

    Suppose Alice, Bob, Carol, and Dave are playing Secret Santa.
    The code below outputs all of the different ways to assign gift recipients
    such that nobody is assigned to himself or herself:

        >>> for d in derangements(['Alice', 'Bob', 'Carol', 'Dave']):
        ...    print(', '.join(d))
        Bob, Alice, Dave, Carol
        Bob, Carol, Dave, Alice
        Bob, Dave, Alice, Carol
        Carol, Alice, Dave, Bob
        Carol, Dave, Alice, Bob
        Carol, Dave, Bob, Alice
        Dave, Alice, Bob, Carol
        Dave, Carol, Alice, Bob
        Dave, Carol, Bob, Alice

    If *r* is given, only the *r*-length derangements are yielded.

        >>> sorted(derangements(range(3), 2))
        [(1, 0), (1, 2), (2, 0)]
        >>> sorted(derangements([0, 2, 3], 2))
        [(2, 0), (2, 3), (3, 0)]

    Elements are treated as unique based on their position, not on their value.

    Consider the Secret Santa example with two *different* people who have
    the *same* name. Then there are two valid gift assignments even though
    it might appear that a person is assigned to themselves:

        >>> names = ['Alice', 'Bob', 'Bob']
        >>> list(derangements(names))
        [('Bob', 'Bob', 'Alice'), ('Bob', 'Alice', 'Bob')]

    To avoid confusion, make the inputs distinct:

        >>> deduped = [f'{name}{index}' for index, name in enumerate(names)]
        >>> list(derangements(deduped))
        [('Bob1', 'Bob2', 'Alice0'), ('Bob2', 'Alice0', 'Bob1')]

    The number of derangements of a set of size *n* is known as the
    "subfactorial of n".  For n > 0, the subfactorial is:
    ``round(math.factorial(n) / math.e)``.

    References:

    * Article:  https://www.numberanalytics.com/blog/ultimate-guide-to-derangements-in-combinatorics
    * Sizes:    https://oeis.org/A000166
    """
```

#### 64: `interleave_randomly` Function

**Function Description**: 
Repeatedly select one of the input *iterables* at random and yield the next item from it.

**Core Algorithm**: 
The relative order of the items in each input iterable will preserved. Note the sequences of items with this property are not equally likely to be generated.

**Input/Output Example**:
```python

def interleave_randomly(*iterables):
    """Repeatedly select one of the input *iterables* at random and yield the next
    item from it.

        >>> iterables = [1, 2, 3], 'abc', (True, False, None)
        >>> list(interleave_randomly(*iterables))  # doctest: +SKIP
        ['a', 'b', 1, 'c', True, False, None, 2, 3]

    The relative order of the items in each input iterable will preserved. Note the
    sequences of items with this property are not equally likely to be generated.

    """
```

#### 65: `split_when` Function

**Function Description**: 
Split *iterable* into pieces based on the output of *pred*. *pred* should be a function that takes successive pairs of items and returns ``True`` if the iterable should be split in between them.

**Core Algorithm**: 
For example, to find runs of increasing numbers, split the iterable when element ``i`` is larger than element ``i + 1``:

**Input/Output Example**:
```python


def split_when(iterable, pred, maxsplit=-1):
    """Split *iterable* into pieces based on the output of *pred*.
    *pred* should be a function that takes successive pairs of items and
    returns ``True`` if the iterable should be split in between them.

    For example, to find runs of increasing numbers, split the iterable when
    element ``i`` is larger than element ``i + 1``:

        >>> list(split_when([1, 2, 3, 3, 2, 5, 2, 4, 2], lambda x, y: x > y))
        [[1, 2, 3, 3], [2, 5], [2, 4], [2]]

    At most *maxsplit* splits are done. If *maxsplit* is not specified or -1,
    then there is no limit on the number of splits:

        >>> list(split_when([1, 2, 3, 3, 2, 5, 2, 4, 2],
        ...                 lambda x, y: x > y, maxsplit=2))
        [[1, 2, 3, 3], [2, 5], [2, 4, 2]]

    """
```

#### 66: `count_cycle` Function

**Function Description**: 
Cycle through the items from *iterable* up to *n* times, yielding the number of completed cycles along with each item. If *n* is omitted the process repeats indefinitely.

**Core Algorithm**: 
Cycle through the items from *iterable* up to *n* times, yielding the number of completed cycles along with each item. If *n* is omitted the process repeats indefinitely.

**Input/Output Example**:
```python

def count_cycle(iterable, n=None):
    """Cycle through the items from *iterable* up to *n* times, yielding
    the number of completed cycles along with each item. If *n* is omitted the
    process repeats indefinitely.

    >>> list(count_cycle('AB', 3))
    [(0, 'A'), (0, 'B'), (1, 'A'), (1, 'B'), (2, 'A'), (2, 'B')]

    """
```

#### 67: `mark_ends` Function

**Function Description**: 
Yield 3-tuples of the form ``(is_first, is_last, item)``.

**Core Algorithm**: 
Use this when looping over an iterable to take special action on its first and/or last items:

**Input/Output Example**:
```python
def mark_ends(iterable):
"""
Yield 3-tuples of the form ``(is_first, is_last, item)``.

>>> list(mark_ends('ABC'))
[(True, False, 'A'), (False, False, 'B'), (False, True, 'C')]

Use this when looping over an iterable to take special action on its first
and/or last items:

>>> iterable = ['Header', 100, 200, 'Footer']
>>> total = 0
>>> for is_first, is_last, item in mark_ends(iterable):
...     if is_first:
...         continue  # Skip the header
...     if is_last:
...         continue  # Skip the footer
...     total += item
>>> print(total)
300
"""
```

#### 68: `longest_common_prefix` Function

**Function Description**: 
Yield elements of the longest common prefix among given *iterables*.

**Core Algorithm**: 
Yield elements of the longest common prefix among given *iterables*.

**Input/Output Example**:
```python
def longest_common_prefix(iterables):
"""
Yield elements of the longest common prefix among given *iterables*.

>>> ''.join(longest_common_prefix(['abcd', 'abc', 'abf']))
'ab'
"""
```

#### 69: `lstrip` Function

**Function Description**: 
Yield the items from *iterable*, but strip any from the beginning for which *pred* returns ``True``.

**Core Algorithm**: 
For example, to remove a set of items from the start of an iterable:

**Input/Output Example**:
```python
def lstrip(iterable, pred):
"""
Yield the items from *iterable*, but strip any from the beginning
for which *pred* returns ``True``.

For example, to remove a set of items from the start of an iterable:

    >>> iterable = (None, False, None, 1, 2, None, 3, False, None)
    >>> pred = lambda x: x in {None, False, ''}
    >>> list(lstrip(iterable, pred))
    [1, 2, None, 3, False, None]

This function is analogous to to :func:`str.lstrip`, and is essentially
an wrapper for :func:`itertools.dropwhile`.
"""
```

#### 70: `rstrip` Function

**Function Description**: 
Yield the items from *iterable*, but strip any from the end for which *pred* returns ``True``.

**Core Algorithm**: 
For example, to remove a set of items from the end of an iterable:

**Input/Output Example**:
```python
def rstrip(iterable, pred):
"""
Yield the items from *iterable*, but strip any from the end
for which *pred* returns ``True``.

For example, to remove a set of items from the end of an iterable:

    >>> iterable = (None, False, None, 1, 2, None, 3, False, None)
    >>> pred = lambda x: x in {None, False, ''}
    >>> list(rstrip(iterable, pred))
    [None, False, None, 1, 2, None, 3]

This function is analogous to :func:`str.rstrip`.
"""
```

#### 71: `strip` Function

**Function Description**: 
Yield the items from *iterable*, but strip any from the beginning and end for which *pred* returns ``True``.

**Core Algorithm**: 
For example, to remove a set of items from both ends of an iterable:

**Input/Output Example**:
```python
def strip(iterable, pred):
"""
Yield the items from *iterable*, but strip any from the
beginning and end for which *pred* returns ``True``.

For example, to remove a set of items from both ends of an iterable:

    >>> iterable = (None, False, None, 1, 2, None, 3, False, None)
    >>> pred = lambda x: x in {None, False, ''}
    >>> list(strip(iterable, pred))
    [1, 2, None, 3]

This function is analogous to :func:`str.strip`.
"""
```

#### 72: `_islice_helper` Function
**Function Description**: 
Helper that normalizes slicing semantics for ``islice_extended``.
```def _islice_helper(it, s):```

**Core Algorithm**: 
Translates arbitrary ``slice`` objects, including negative indices, into the indices required to iterate the wrapped iterator.

**Input/Output Example**:
```python
from more_itertools.more import _islice_helper

data = iter('abcdef')
tail = list(_islice_helper(data, slice(-3, None)))
# tail == ['d', 'e', 'f']
```

#### 73: `always_reversible` Function

**Function Description**: 
An extension of :func:`reversed` that supports all iterables, not just those which implement the ``Reversible`` or ``Sequence`` protocols.

**Core Algorithm**: 
If the iterable is already reversible, this function returns the result of :func:`reversed()`. If the iterable is not reversible, this function will cache the remaining items in the iterable and yield them in reverse order, which may require significant storage.

**Input/Output Example**:
```python
def always_reversible(iterable):
"""
An extension of :func:`reversed` that supports all iterables, not
just those which implement the ``Reversible`` or ``Sequence`` protocols.

    >>> print(*always_reversible(x for x in range(3)))
    2 1 0

If the iterable is already reversible, this function returns the
result of :func:`reversed()`. If the iterable is not reversible,
this function will cache the remaining items in the iterable and
yield them in reverse order, which may require significant storage.
"""
```

#### 74: `consecutive_groups` Function

**Function Description**: 
Yield groups of consecutive items using :func:`itertools.groupby`. The *ordering* function determines whether two items are adjacent by returning their position.

**Core Algorithm**: 
By default, the ordering function is the identity function. This is suitable for finding runs of numbers:

**Input/Output Example**:
```python
def consecutive_groups(iterable, ordering=None):
"""
Yield groups of consecutive items using :func:`itertools.groupby`.
The *ordering* function determines whether two items are adjacent by
returning their position.

By default, the ordering function is the identity function. This is
suitable for finding runs of numbers:

    >>> iterable = [1, 10, 11, 12, 20, 30, 31, 32, 33, 40]
    >>> for group in consecutive_groups(iterable):
    ...     print(list(group))
    [1]
    [10, 11, 12]
    [20]
    [30, 31, 32, 33]
    [40]

To find runs of adjacent letters, apply :func:`ord` function
to convert letters to ordinals.

    >>> iterable = 'abcdfgilmnop'
    >>> ordering = ord
    >>> for group in consecutive_groups(iterable, ordering):
    ...     print(list(group))
    ['a', 'b', 'c', 'd']
    ['f', 'g']
    ['i']
    ['l', 'm', 'n', 'o', 'p']

Each group of consecutive items is an iterator that shares it source with
*iterable*. When an an output group is advanced, the previous group is
no longer available unless its elements are copied (e.g., into a ``list``).

    >>> iterable = [1, 2, 11, 12, 21, 22]
    >>> saved_groups = []
    >>> for group in consecutive_groups(iterable):
    ...     saved_groups.append(list(group))  # Copy group elements
    >>> saved_groups
    [[1, 2], [11, 12], [21, 22]]
"""
```

#### 75: `exactly_n` Function

**Function Description**: 
Return ``True`` if exactly ``n`` items in the iterable are ``True`` according to the *predicate* function.

**Core Algorithm**: 
The iterable will be advanced until ``n + 1`` truthy items are encountered, so avoid calling it on infinite iterables.

**Input/Output Example**:
```python
def exactly_n(iterable, n, predicate=bool):
"""
Return ``True`` if exactly ``n`` items in the iterable are ``True``
according to the *predicate* function.

    >>> exactly_n([True, True, False], 2)
    True
    >>> exactly_n([True, True, False], 1)
    False
    >>> exactly_n([0, 1, 2, 3, 4, 5], 3, lambda x: x < 3)
    True

The iterable will be advanced until ``n + 1`` truthy items are encountered,
so avoid calling it on infinite iterables.
"""
```

#### 76: `circular_shifts` Function

**Function Description**: 
Yield the circular shifts of *iterable*.

**Core Algorithm**: 
Set *steps* to the number of places to rotate to the left (or to the right if negative). Defaults to 1.

**Input/Output Example**:
```python
def circular_shifts(iterable, steps=1):
"""
Yield the circular shifts of *iterable*.

>>> list(circular_shifts(range(4)))
[(0, 1, 2, 3), (1, 2, 3, 0), (2, 3, 0, 1), (3, 0, 1, 2)]

Set *steps* to the number of places to rotate to the left
(or to the right if negative).  Defaults to 1.

>>> list(circular_shifts(range(4), 2))
[(0, 1, 2, 3), (2, 3, 0, 1)]

>>> list(circular_shifts(range(4), -1))
[(0, 1, 2, 3), (3, 0, 1, 2), (2, 3, 0, 1), (1, 2, 3, 0)]
"""
```

#### 77: `make_decorator` Function

**Function Description**: 
Return a decorator version of *wrapping_func*, which is a function that modifies an iterable. *result_index* is the position in that function's signature where the iterable goes.

**Core Algorithm**: 
Builds a closure trio (`decorator`, `outer_wrapper`, `inner_wrapper`) that injects the result of *wrapping_func* at position *result_index*, letting you apply iterator utilities at definition time without touching the original function body.

**Input/Output Example**:
```python
def make_decorator(wrapping_func, result_index=0):
"""
Return a decorator version of *wrapping_func*, which is a function that
modifies an iterable. *result_index* is the position in that function's
signature where the iterable goes.

This lets you use itertools on the "production end," i.e. at function
definition. This can augment what the function returns without changing the
function's code.

For example, to produce a decorator version of :func:`chunked`:

    >>> from more_itertools import chunked
    >>> chunker = make_decorator(chunked, result_index=0)
    >>> @chunker(3)
    ... def iter_range(n):
    ...     return iter(range(n))
    ...
    >>> list(iter_range(9))
    [[0, 1, 2], [3, 4, 5], [6, 7, 8]]

To only allow truthy items to be returned:

    >>> truth_serum = make_decorator(filter, result_index=1)
    >>> @truth_serum(bool)
    ... def boolean_test():
    ...     return [0, 1, '', ' ', False, True]
    ...
    >>> list(boolean_test())
    [1, ' ', True]

The :func:`peekable` and :func:`seekable` wrappers make for practical
decorators:

    >>> from more_itertools import peekable
    >>> peekable_function = make_decorator(peekable)
    >>> @peekable_function()
    ... def str_range(*args):
    ...     return (str(x) for x in range(*args))
    ...
    >>> it = str_range(1, 20, 2)
    >>> next(it), next(it), next(it)
    ('1', '3', '5')
    >>> it.peek()
    '7'
    >>> next(it)
    '7'
"""
```

#### 78: `map_reduce` Function

**Function Description**: 
Return a dictionary that maps the items in *iterable* to categories defined by *keyfunc*, transforms them with *valuefunc*, and then summarizes them by category with *reducefunc*.

**Core Algorithm**: 
*valuefunc* defaults to the identity function if it is unspecified. If *reducefunc* is unspecified, no summarization takes place:

**Input/Output Example**:
```python
def map_reduce(iterable, keyfunc, valuefunc=None, reducefunc=None):
"""
Return a dictionary that maps the items in *iterable* to categories
defined by *keyfunc*, transforms them with *valuefunc*, and
then summarizes them by category with *reducefunc*.

*valuefunc* defaults to the identity function if it is unspecified.
If *reducefunc* is unspecified, no summarization takes place:

    >>> keyfunc = lambda x: x.upper()
    >>> result = map_reduce('abbccc', keyfunc)
    >>> sorted(result.items())
    [('A', ['a']), ('B', ['b', 'b']), ('C', ['c', 'c', 'c'])]

Specifying *valuefunc* transforms the categorized items:

    >>> keyfunc = lambda x: x.upper()
    >>> valuefunc = lambda x: 1
    >>> result = map_reduce('abbccc', keyfunc, valuefunc)
    >>> sorted(result.items())
    [('A', [1]), ('B', [1, 1]), ('C', [1, 1, 1])]

Specifying *reducefunc* summarizes the categorized items:

    >>> keyfunc = lambda x: x.upper()
    >>> valuefunc = lambda x: 1
    >>> reducefunc = sum
    >>> result = map_reduce('abbccc', keyfunc, valuefunc, reducefunc)
    >>> sorted(result.items())
    [('A', 1), ('B', 2), ('C', 3)]

You may want to filter the input iterable before applying the map/reduce
procedure:

    >>> all_items = range(30)
    >>> items = [x for x in all_items if 10 <= x <= 20]  # Filter
    >>> keyfunc = lambda x: x % 2  # Evens map to 0; odds to 1
    >>> categories = map_reduce(items, keyfunc=keyfunc)
    >>> sorted(categories.items())
    [(0, [10, 12, 14, 16, 18, 20]), (1, [11, 13, 15, 17, 19])]
    >>> summaries = map_reduce(items, keyfunc=keyfunc, reducefunc=sum)
    >>> sorted(summaries.items())
    [(0, 90), (1, 75)]

Note that all items in the iterable are gathered into a list before the
summarization step, which may require significant storage.

The returned object is a :obj:`collections.defaultdict` with the
``default_factory`` set to ``None``, such that it behaves like a normal
dictionary.
"""
```

#### 79: `rlocate` Function

**Function Description**: 
Yield the index of each item in *iterable* for which *pred* returns ``True``, starting from the right and moving left.

**Core Algorithm**: 
*pred* defaults to :func:`bool`, which will select truthy items:

**Input/Output Example**:
```python
def rlocate(iterable, pred=bool, window_size=None):
"""
Yield the index of each item in *iterable* for which *pred* returns
``True``, starting from the right and moving left.

*pred* defaults to :func:`bool`, which will select truthy items:

    >>> list(rlocate([0, 1, 1, 0, 1, 0, 0]))  # Truthy at 1, 2, and 4
    [4, 2, 1]

Set *pred* to a custom function to, e.g., find the indexes for a particular
item:

    >>> iterator = iter('abcb')
    >>> pred = lambda x: x == 'b'
    >>> list(rlocate(iterator, pred))
    [3, 1]

If *window_size* is given, then the *pred* function will be called with
that many items. This enables searching for sub-sequences:

    >>> iterable = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]
    >>> pred = lambda *args: args == (1, 2, 3)
    >>> list(rlocate(iterable, pred=pred, window_size=3))
    [9, 5, 1]

Beware, this function won't return anything for infinite iterables.
If *iterable* is reversible, ``rlocate`` will reverse it and search from
the right. Otherwise, it will search from the left and return the results
in reverse order.

See :func:`locate` to for other example applications.
"""
```

#### 80: `partitions` Function

**Function Description**: 
Yield all possible order-preserving partitions of *iterable*.

**Core Algorithm**: 
This is unrelated to :func:`partition`.

**Input/Output Example**:
```python
def partitions(iterable):
"""
Yield all possible order-preserving partitions of *iterable*.

>>> iterable = 'abc'
>>> for part in partitions(iterable):
...     print([''.join(p) for p in part])
['abc']
['a', 'bc']
['ab', 'c']
['a', 'b', 'c']

This is unrelated to :func:`partition`.
"""
```

#### 81: `set_partitions` Function

**Function Description**: 
Yield the set partitions of *iterable* into *k* parts. Set partitions are not order-preserving.

**Core Algorithm**: 
Delegates to the recursive helper `set_partitions_helper` to enumerate all partitions within the requested size constraints.

**Input/Output Example**:
```python
def set_partitions(iterable, k=None, min_size=None, max_size=None):
"""
Yield the set partitions of *iterable* into *k* parts. Set partitions are
not order-preserving.

>>> iterable = 'abc'
>>> for part in set_partitions(iterable, 2):
...     print([''.join(p) for p in part])
['a', 'bc']
['ab', 'c']
['b', 'ac']


If *k* is not given, every set partition is generated.

>>> iterable = 'abc'
>>> for part in set_partitions(iterable):
...     print([''.join(p) for p in part])
['abc']
['a', 'bc']
['ab', 'c']
['b', 'ac']
['a', 'b', 'c']

if *min_size* and/or *max_size* are given, the minimum and/or maximum size
per block in partition is set.

>>> iterable = 'abc'
>>> for part in set_partitions(iterable, min_size=2):
...     print([''.join(p) for p in part])
['abc']
>>> for part in set_partitions(iterable, max_size=2):
...     print([''.join(p) for p in part])
['a', 'bc']
['ab', 'c']
['b', 'ac']
['a', 'b', 'c']
"""
```

#### 82: `_ichunk` Function
**Function Description**: 
```def _ichunk(iterator, n):```
Internal chunk loader used by ``ichunked`` to lazily materialize fixed-size groups.

**Core Algorithm**: 
Returns a tuple ``(chunk_iter, materialize_next)`` where the iterator yields cached values and the callback preloads elements from the shared iterator.

**Input/Output Example**:
```python
from more_itertools.more import _ichunk

source = iter(range(6))
chunk1, ensure1 = _ichunk(source, 2)
if ensure1():
    first = [next(chunk1) for _ in range(2)]  # [0, 1]
ensure1(None)

chunk2, ensure2 = _ichunk(source, 2)
if ensure2():
    second = [next(chunk2) for _ in range(2)]  # [2, 3]
```

#### 83: `iequals` Function

**Function Description**: 
Return ``True`` if all given *iterables* are equal to each other, which means that they contain the same elements in the same order.

**Core Algorithm**: 
The function is useful for comparing iterables of different data types or iterables that do not support equality checks.

**Input/Output Example**:
```python
def iequals(*iterables):
"""
Return ``True`` if all given *iterables* are equal to each other,
which means that they contain the same elements in the same order.

The function is useful for comparing iterables of different data types
or iterables that do not support equality checks.

>>> iequals("abc", ['a', 'b', 'c'], ('a', 'b', 'c'), iter("abc"))
True

>>> iequals("abc", "acb")
False

Not to be confused with :func:`all_equal`, which checks whether all
elements of iterable are equal to each other.
"""
```

#### 84: `distinct_combinations` Function

**Function Description**: 
Yield the distinct combinations of *r* items taken from *iterable*.

**Core Algorithm**: 
Equivalent to ``set(combinations(iterable))``, except duplicates are not generated and thrown away. For larger input sequences this is much more efficient.

**Input/Output Example**:
```python
def distinct_combinations(iterable, r):
"""
Yield the distinct combinations of *r* items taken from *iterable*.

    >>> list(distinct_combinations([0, 0, 1], 2))
    [(0, 0), (0, 1)]

Equivalent to ``set(combinations(iterable))``, except duplicates are not
generated and thrown away. For larger input sequences this is much more
efficient.
"""
```

#### 85: `filter_except` Function

**Function Description**: 
Yield the items from *iterable* for which the *validator* function does not raise one of the specified *exceptions*.

**Core Algorithm**: 
*validator* is called for each item in *iterable*. It should be a function that accepts one argument and raises an exception if that item is not valid.

**Input/Output Example**:
```python
def filter_except(validator, iterable, *exceptions):
"""
Yield the items from *iterable* for which the *validator* function does
not raise one of the specified *exceptions*.

*validator* is called for each item in *iterable*.
It should be a function that accepts one argument and raises an exception
if that item is not valid.

>>> iterable = ['1', '2', 'three', '4', None]
>>> list(filter_except(int, iterable, ValueError, TypeError))
['1', '2', '4']

If an exception other than one given by *exceptions* is raised by
*validator*, it is raised like normal.
"""
```

#### 86: `map_except` Function

**Function Description**: 
Transform each item from *iterable* with *function* and yield the result, unless *function* raises one of the specified *exceptions*.

**Core Algorithm**: 
*function* is called to transform each item in *iterable*. It should accept one argument.

**Input/Output Example**:
```python
def map_except(function, iterable, *exceptions):
"""
Transform each item from *iterable* with *function* and yield the
result, unless *function* raises one of the specified *exceptions*.

*function* is called to transform each item in *iterable*.
It should accept one argument.

>>> iterable = ['1', '2', 'three', '4', None]
>>> list(map_except(int, iterable, ValueError, TypeError))
[1, 2, 4]

If an exception other than one given by *exceptions* is raised by
*function*, it is raised like normal.
"""
```

#### 87: `map_if` Function

**Function Description**: 
Evaluate each item from *iterable* using *pred*. If the result is equivalent to ``True``, transform the item with *func* and yield it. Otherwise, transform the item with *func_else* and yield it.

**Core Algorithm**: 
*pred*, *func*, and *func_else* should each be functions that accept one argument. By default, *func_else* is the identity function.

**Input/Output Example**:
```python
def map_if(iterable, pred, func, func_else=None):
"""
Evaluate each item from *iterable* using *pred*. If the result is
equivalent to ``True``, transform the item with *func* and yield it.
Otherwise, transform the item with *func_else* and yield it.

*pred*, *func*, and *func_else* should each be functions that accept
one argument. By default, *func_else* is the identity function.

>>> from math import sqrt
>>> iterable = list(range(-5, 5))
>>> iterable
[-5, -4, -3, -2, -1, 0, 1, 2, 3, 4]
>>> list(map_if(iterable, lambda x: x > 3, lambda x: 'toobig'))
[-5, -4, -3, -2, -1, 0, 1, 2, 3, 'toobig']
>>> list(map_if(iterable, lambda x: x >= 0,
... lambda x: f'{sqrt(x):.2f}', lambda x: None))
[None, None, None, None, None, '0.00', '1.00', '1.41', '1.73', '2.00']
"""
```

#### 88: `_sample_unweighted` Function
**Function Description**: 
Reservoir sampling helper for uniformly selecting ``k`` items from an iterator.

**Core Algorithm**: 
Implements Algorithm R to draw a size-``k`` sample without replacement, optionally enforcing strict population size.

**Input/Output Example**:
```python
def _sample_unweighted(iterator, k, strict):
    # Algorithm L in the 1994 paper by Kim-Hung Li:
    # "Reservoir-Sampling Algorithms of Time Complexity O(n(1+log(N/n)))".
```

#### 89: `_sample_weighted` Function
**Function Description**: 
Reservoir sampler that honors per-item weights.

**Core Algorithm**: 
Maintains a weighted reservoir so that selection probability is proportional to the supplied weights.

**Input/Output Example**:
```python
def _sample_weighted(iterator, k, weights, strict):
    # Implementation of "A-ExpJ" from the 2006 paper by Efraimidis et al. :
    # "Weighted random sampling with a reservoir".

    # Log-transform for numerical stability for weights that are small/large
```

#### 90: `_sample_counted` Function
**Function Description**: 
Sampling helper that respects per-element occurrence counts.
```def _sample_counted(population, k, counts, strict):```

**Core Algorithm**: 
Uses a feed-forward reservoir with the nested `feed(i)` helper to advance the population iterator while obeying the provided `counts` iterator.

**Input/Output Example**:
```python
from more_itertools.more import _sample_counted

items = _sample_counted(iter('ABC'), 2, counts=iter([2, 1, 3]), strict=False)
# returned items honor the per-element multiplicities
```

#### 91: `is_sorted` Function

**Function Description**: 
Returns ``True`` if the items of iterable are in sorted order, and ``False`` otherwise. *key* and *reverse* have the same meaning that they do in the built-in :func:`sorted` function.

**Core Algorithm**: 
If *strict*, tests for strict sorting, that is, returns ``False`` if equal elements are found:

**Input/Output Example**:
```python
def is_sorted(iterable, key=None, reverse=False, strict=False):
"""
Returns ``True`` if the items of iterable are in sorted order, and
``False`` otherwise. *key* and *reverse* have the same meaning that they do
in the built-in :func:`sorted` function.

>>> is_sorted(['1', '2', '3', '4', '5'], key=int)
True
>>> is_sorted([5, 4, 3, 1, 2], reverse=True)
False

If *strict*, tests for strict sorting, that is, returns ``False`` if equal
elements are found:

>>> is_sorted([1, 2, 2])
True
>>> is_sorted([1, 2, 2], strict=True)
False

The function returns ``False`` after encountering the first out-of-order
item, which means it may produce results that differ from the built-in
:func:`sorted` function for objects with unusual comparison dynamics
(like ``math.nan``). If there are no out-of-order items, the iterable is
exhausted.
"""
```

#### 92: `windowed_complete` Function

**Function Description**: 
Yield ``(beginning, middle, end)`` tuples, where:

**Core Algorithm**: 
* Each ``middle`` has *n* items from *iterable* * Each ``beginning`` has the items before the ones in ``middle`` * Each ``end`` has the items after the ones in ``middle``

**Input/Output Example**:
```python
def windowed_complete(iterable, n):
"""
Yield ``(beginning, middle, end)`` tuples, where:

* Each ``middle`` has *n* items from *iterable*
* Each ``beginning`` has the items before the ones in ``middle``
* Each ``end`` has the items after the ones in ``middle``

>>> iterable = range(7)
>>> n = 3
>>> for beginning, middle, end in windowed_complete(iterable, n):
...     print(beginning, middle, end)
() (0, 1, 2) (3, 4, 5, 6)
(0,) (1, 2, 3) (4, 5, 6)
(0, 1) (2, 3, 4) (5, 6)
(0, 1, 2) (3, 4, 5) (6,)
(0, 1, 2, 3) (4, 5, 6) ()

Note that *n* must be at least 0 and most equal to the length of
*iterable*.

This function will exhaust the iterable and may require significant
storage.
"""
```

#### 93: `all_unique` Function

**Function Description**:  
Return ``True`` if every element in *iterable* is unique; otherwise return ``False`` immediately upon encountering the first duplicate.  
If a *key* function is provided, uniqueness is determined by ``key(element)``.

**Core Algorithm**:  
* Initialize an empty set ``seen``.  
* For each ``item`` in *iterable*:  
  * Compute ``k = key(item)`` if *key* is given, else use ``item`` itself.  
  * If ``k`` is already in ``seen``, return ``False``.  
  * Otherwise, add ``k`` to ``seen`` and continue.  
* After scanning all elements without finding duplicates, return ``True``.

**Input/Output Example**:
```python

def all_unique(iterable, key=None):
    """
    Returns ``True`` if all the elements of *iterable* are unique (no two
    elements are equal).

        >>> all_unique('ABCB')
        False

    If a *key* function is specified, it will be used to make comparisons.

        >>> all_unique('ABCb')
        True
        >>> all_unique('ABCb', str.lower)
        False

    The function returns as soon as the first non-unique element is
    encountered. Iterables with a mix of hashable and unhashable items can
    be used, but the function will be slower for unhashable items.
    """
```

#### 94: `nth_product` Function

**Function Description**: 
Equivalent to ``list(product(*args))[index]``.

**Core Algorithm**: 
The products of *args* can be ordered lexicographically. :func:`nth_product` computes the product at sort position *index* without computing the previous products.

**Input/Output Example**:
```python
def nth_product(index, *args):
"""
Equivalent to ``list(product(*args))[index]``.

The products of *args* can be ordered lexicographically.
:func:`nth_product` computes the product at sort position *index* without
computing the previous products.

    >>> nth_product(8, range(2), range(2), range(2), range(2))
    (1, 0, 0, 0)

``IndexError`` will be raised if the given *index* is invalid.
"""
```

#### 95: `nth_permutation` Function

**Function Description**: 
Equivalent to ``list(permutations(iterable, r))[index]```

**Core Algorithm**: 
The subsequences of *iterable* that are of length *r* where order is important can be ordered lexicographically. :func:`nth_permutation` computes the subsequence at sort position *index* directly, without computing the previous subsequences.

**Input/Output Example**:
```python
def nth_permutation(iterable, r, index):
"""
Equivalent to ``list(permutations(iterable, r))[index]```

The subsequences of *iterable* that are of length *r* where order is
important can be ordered lexicographically. :func:`nth_permutation`
computes the subsequence at sort position *index* directly, without
computing the previous subsequences.

    >>> nth_permutation('ghijk', 2, 5)
    ('h', 'i')

``ValueError`` will be raised If *r* is negative or greater than the length
of *iterable*.
``IndexError`` will be raised if the given *index* is invalid.
"""
```

#### 96: `nth_combination_with_replacement` Function

**Function Description**: 
Equivalent to ``list(combinations_with_replacement(iterable, r))[index]``.

**Core Algorithm**: 
The subsequences with repetition of *iterable* that are of length *r* can be ordered lexicographically. :func:`nth_combination_with_replacement` computes the subsequence at sort position *index* directly, without computing the previous subsequences with replacement.

**Input/Output Example**:
```python
def nth_combination_with_replacement(iterable, r, index):
"""
Equivalent to
``list(combinations_with_replacement(iterable, r))[index]``.


The subsequences with repetition of *iterable* that are of length *r* can
be ordered lexicographically. :func:`nth_combination_with_replacement`
computes the subsequence at sort position *index* directly, without
computing the previous subsequences with replacement.

    >>> nth_combination_with_replacement(range(5), 3, 5)
    (0, 1, 1)

``ValueError`` will be raised If *r* is negative or greater than the length
of *iterable*.
``IndexError`` will be raised if the given *index* is invalid.
"""
```

#### 97: `value_chain` Function

**Function Description**: 
Yield all arguments passed to the function in the same order in which they were passed. If an argument itself is iterable then iterate over its values.

**Core Algorithm**: 
Binary and text strings are not considered iterable and are emitted as-is:

**Input/Output Example**:
```python
def value_chain(*args):
"""
Yield all arguments passed to the function in the same order in which
they were passed. If an argument itself is iterable then iterate over its
values.

    >>> list(value_chain(1, 2, 3, [4, 5, 6]))
    [1, 2, 3, 4, 5, 6]

Binary and text strings are not considered iterable and are emitted
as-is:

    >>> list(value_chain('12', '34', ['56', '78']))
    ['12', '34', '56', '78']

Pre- or postpend a single element to an iterable:

    >>> list(value_chain(1, [2, 3, 4, 5, 6]))
    [1, 2, 3, 4, 5, 6]
    >>> list(value_chain([1, 2, 3, 4, 5], 6))
    [1, 2, 3, 4, 5, 6]

Multiple levels of nesting are not flattened.
"""
```

#### 98: `product_index` Function

**Function Description**: 
Equivalent to ``list(product(*args)).index(element)``

**Core Algorithm**: 
The products of *args* can be ordered lexicographically. :func:`product_index` computes the first index of *element* without computing the previous products.

**Input/Output Example**:
```python
def product_index(element, *args):
"""
Equivalent to ``list(product(*args)).index(element)``

The products of *args* can be ordered lexicographically.
:func:`product_index` computes the first index of *element* without
computing the previous products.

    >>> product_index([8, 2], range(10), range(5))
    42

``ValueError`` will be raised if the given *element* isn't in the product
of *args*.
"""
```

#### 99: `combination_index` Function

**Function Description**: 
Equivalent to ``list(combinations(iterable, r)).index(element)``

**Core Algorithm**: 
The subsequences of *iterable* that are of length *r* can be ordered lexicographically. :func:`combination_index` computes the index of the first *element*, without computing the previous combinations.

**Input/Output Example**:
```python
def combination_index(element, iterable):
"""
Equivalent to ``list(combinations(iterable, r)).index(element)``

The subsequences of *iterable* that are of length *r* can be ordered
lexicographically. :func:`combination_index` computes the index of the
first *element*, without computing the previous combinations.

    >>> combination_index('adf', 'abcdefg')
    10

``ValueError`` will be raised if the given *element* isn't one of the
combinations of *iterable*.
"""
```

#### 100: `combination_with_replacement_index` Function

**Function Description**: 
Equivalent to ``list(combinations_with_replacement(iterable, r)).index(element)``

**Core Algorithm**: 
The subsequences with repetition of *iterable* that are of length *r* can be ordered lexicographically. :func:`combination_with_replacement_index` computes the index of the first *element*, without computing the previous combinations with replacement.

**Input/Output Example**:
```python
def combination_with_replacement_index(element, iterable):
"""
Equivalent to
``list(combinations_with_replacement(iterable, r)).index(element)``

The subsequences with repetition of *iterable* that are of length *r* can
be ordered lexicographically. :func:`combination_with_replacement_index`
computes the index of the first *element*, without computing the previous
combinations with replacement.

    >>> combination_with_replacement_index('adf', 'abcdefg')
    20

``ValueError`` will be raised if the given *element* isn't one of the
combinations with replacement of *iterable*.
"""
```

#### 101: `permutation_index` Function

**Function Description**: 
Equivalent to ``list(permutations(iterable, r)).index(element)```

**Core Algorithm**: 
The subsequences of *iterable* that are of length *r* where order is important can be ordered lexicographically. :func:`permutation_index` computes the index of the first *element* directly, without computing the previous permutations.

**Input/Output Example**:
```python
def permutation_index(element, iterable):
"""
Equivalent to ``list(permutations(iterable, r)).index(element)```

The subsequences of *iterable* that are of length *r* where order is
important can be ordered lexicographically. :func:`permutation_index`
computes the index of the first *element* directly, without computing
the previous permutations.

    >>> permutation_index([1, 3, 2], range(5))
    19

``ValueError`` will be raised if the given *element* isn't one of the
permutations of *iterable*.
"""
```

#### 102: `chunked_even` Function

**Function Description**: 
Break *iterable* into lists of approximately length *n*. Items are distributed such the lengths of the lists differ by at most 1 item.

**Core Algorithm**: 
Break *iterable* into lists of approximately length *n*. Items are distributed such the lengths of the lists differ by at most 1 item.

**Input/Output Example**:
```python
def chunked_even(iterable, n):
"""
Break *iterable* into lists of approximately length *n*.
Items are distributed such the lengths of the lists differ by at most
1 item.

>>> iterable = [1, 2, 3, 4, 5, 6, 7]
>>> n = 3
>>> list(chunked_even(iterable, n))  # List lengths: 3, 2, 2
[[1, 2, 3], [4, 5], [6, 7]]
>>> list(chunked(iterable, n))  # List lengths: 3, 3, 1
[[1, 2, 3], [4, 5, 6], [7]]
"""
```

#### 103: `zip_broadcast` Function

**Function Description**: 
A version of :func:`zip` that "broadcasts" any scalar (i.e., non-iterable) items into output tuples.

**Core Algorithm**: 
Uses an internal `is_scalar` helper to decide which arguments should be broadcast, defaulting to treating `scalar_types` as atomic while iterating over true iterables.

**Input/Output Example**:
```python
def zip_broadcast(*objects, scalar_types=(str, bytes), strict=False):
"""
A version of :func:`zip` that "broadcasts" any scalar
(i.e., non-iterable) items into output tuples.

>>> iterable_1 = [1, 2, 3]
>>> iterable_2 = ['a', 'b', 'c']
>>> scalar = '_'
>>> list(zip_broadcast(iterable_1, iterable_2, scalar))
[(1, 'a', '_'), (2, 'b', '_'), (3, 'c', '_')]

The *scalar_types* keyword argument determines what types are considered
scalar. It is set to ``(str, bytes)`` by default. Set it to ``None`` to
treat strings and byte strings as iterable:

>>> list(zip_broadcast('abc', 0, 'xyz', scalar_types=None))
[('a', 0, 'x'), ('b', 0, 'y'), ('c', 0, 'z')]

If the *strict* keyword argument is ``True``, then
``ValueError`` will be raised if any of the iterables have
different lengths.
"""
```

#### 104: `unique_in_window` Function

**Function Description**: 
Yield the items from *iterable* that haven't been seen recently. *n* is the size of the lookback window.

**Core Algorithm**: 
The *key* function, if provided, will be used to determine uniqueness:

**Input/Output Example**:
```python
def unique_in_window(iterable, n, key=None):
"""
Yield the items from *iterable* that haven't been seen recently.
*n* is the size of the sliding window.

    >>> iterable = [0, 1, 0, 2, 3, 0]
    >>> n = 3
    >>> list(unique_in_window(iterable, n))
    [0, 1, 2, 3, 0]

The *key* function, if provided, will be used to determine uniqueness:

    >>> list(unique_in_window('abAcda', 3, key=lambda x: x.lower()))
    ['a', 'b', 'c', 'd', 'a']

Updates a sliding window no larger than n and yields a value
if the item only occurs once in the updated window.

When `n == 1`, *unique_in_window* is memoryless:

    >>> list(unique_in_window('aab', n=1))
    ['a', 'a', 'b']

The items in *iterable* must be hashable.
"""
```

#### 105: `duplicates_everseen` Function

**Function Description**: 
Yield duplicate elements after their first appearance.

**Core Algorithm**: 
This function is analogous to :func:`unique_everseen` and is subject to the same performance considerations.

**Input/Output Example**:
```python
def duplicates_everseen(iterable, key=None):
"""
Yield duplicate elements after their first appearance.

>>> list(duplicates_everseen('mississippi'))
['s', 'i', 's', 's', 'i', 'p', 'i']
>>> list(duplicates_everseen('AaaBbbCccAaa', str.lower))
['a', 'a', 'b', 'b', 'c', 'c', 'A', 'a', 'a']

This function is analogous to :func:`unique_everseen` and is subject to
the same performance considerations.
"""
```

#### 106: `duplicates_justseen` Function

**Function Description**: 
Yields serially-duplicate elements after their first appearance.

**Core Algorithm**: 
This function is analogous to :func:`unique_justseen`.

**Input/Output Example**:
```python
def duplicates_justseen(iterable, key=None):
"""
Yields serially-duplicate elements after their first appearance.

>>> list(duplicates_justseen('mississippi'))
['s', 's', 'p']
>>> list(duplicates_justseen('AaaBbbCccAaa', str.lower))
['a', 'a', 'b', 'b', 'c', 'c', 'a', 'a']

This function is analogous to :func:`unique_justseen`.
"""
```

#### 107: `classify_unique` Function

**Function Description**: 
Classify each element in terms of its uniqueness.

**Core Algorithm**: 
For each element in the input iterable, return a 3-tuple consisting of:

**Input/Output Example**:
```python
def classify_unique(iterable, key=None):
"""
Classify each element in terms of its uniqueness.

For each element in the input iterable, return a 3-tuple consisting of:

1. The element itself
2. ``False`` if the element is equal to the one preceding it in the input,
   ``True`` otherwise (i.e. the equivalent of :func:`unique_justseen`)
3. ``False`` if this element has been seen anywhere in the input before,
   ``True`` otherwise (i.e. the equivalent of :func:`unique_everseen`)

>>> list(classify_unique('otto'))    # doctest: +NORMALIZE_WHITESPACE
[('o', True,  True),
 ('t', True,  True),
 ('t', False, False),
 ('o', True,  False)]

This function is analogous to :func:`unique_everseen` and is subject to
the same performance considerations.
"""
```

#### 108: `constrained_batches` Function

**Function Description**: 
Yield batches of items from *iterable* with a combined size limited by *max_size*.

**Core Algorithm**: 
If a *max_count* is supplied, the number of items per batch is also limited:

**Input/Output Example**:
```python
def constrained_batches(
"""
Yield batches of items from *iterable* with a combined size limited by
*max_size*.

>>> iterable = [b'12345', b'123', b'12345678', b'1', b'1', b'12', b'1']
>>> list(constrained_batches(iterable, 10))
[(b'12345', b'123'), (b'12345678', b'1', b'1'), (b'12', b'1')]

If a *max_count* is supplied, the number of items per batch is also
limited:

>>> iterable = [b'12345', b'123', b'12345678', b'1', b'1', b'12', b'1']
>>> list(constrained_batches(iterable, 10, max_count = 2))
[(b'12345', b'123'), (b'12345678', b'1'), (b'1', b'12'), (b'1',)]

If a *get_len* function is supplied, use that instead of :func:`len` to
determine item size.

If *strict* is ``True``, raise ``ValueError`` if any single item is bigger
than *max_size*. Otherwise, allow single items to exceed *max_size*.
"""
```

#### 109: `gray_product` Function

**Function Description**: 
Like :func:`itertools.product`, but return tuples in an order such that only one element in the generated tuple changes from one iteration to the next.

**Core Algorithm**: 
This function consumes all of the input iterables before producing output. If any of the input iterables have fewer than two items, ``ValueError`` is raised.

**Input/Output Example**:
```python
def gray_product(*iterables):
"""
Like :func:`itertools.product`, but return tuples in an order such
that only one element in the generated tuple changes from one iteration
to the next.

    >>> list(gray_product('AB','CD'))
    [('A', 'C'), ('B', 'C'), ('B', 'D'), ('A', 'D')]

This function consumes all of the input iterables before producing output.
If any of the input iterables have fewer than two items, ``ValueError``
is raised.

For information on the algorithm, see
`this section <https://www-cs-faculty.stanford.edu/~knuth/fasc2a.ps.gz>`__
of Donald Knuth's *The Art of Computer Programming*.
"""
```

#### 110: `partial_product` Function

**Function Description**: 
Yields tuples containing one item from each iterator, with subsequent tuples changing a single item at a time by advancing each iterator until it is exhausted. This sequence guarantees every value in each iterable is output at least once without generating all possible combinations.

**Core Algorithm**: 
This may be useful, for example, when testing an expensive function.

**Input/Output Example**:
```python
def partial_product(*iterables):
"""
Yields tuples containing one item from each iterator, with subsequent
tuples changing a single item at a time by advancing each iterator until it
is exhausted. This sequence guarantees every value in each iterable is
output at least once without generating all possible combinations.

This may be useful, for example, when testing an expensive function.

    >>> list(partial_product('AB', 'C', 'DEF'))
    [('A', 'C', 'D'), ('B', 'C', 'D'), ('B', 'C', 'E'), ('B', 'C', 'F')]
"""
```

#### 111: `takewhile_inclusive` Function

**Function Description**: 
A variant of :func:`takewhile` that yields one additional element.

**Core Algorithm**: 
:func:`takewhile` would return ``[1, 4]``.

**Input/Output Example**:
```python
def takewhile_inclusive(predicate, iterable):
"""
A variant of :func:`takewhile` that yields one additional element.

    >>> list(takewhile_inclusive(lambda x: x < 5, [1, 4, 6, 4, 1]))
    [1, 4, 6]

:func:`takewhile` would return ``[1, 4]``.
"""
```

#### 112: `outer_product` Function

**Function Description**: 
A generalized outer product that applies a binary function to all pairs of items. Returns a 2D matrix with ``len(xs)`` rows and ``len(ys)`` columns. Also accepts ``*args`` and ``**kwargs`` that are passed to ``func``.

**Core Algorithm**: 
Multiplication table:

**Input/Output Example**:
```python
def outer_product(func, xs, ys, *args, **kwargs):
"""
A generalized outer product that applies a binary function to all
pairs of items. Returns a 2D matrix with ``len(xs)`` rows and ``len(ys)``
columns.
Also accepts ``*args`` and ``**kwargs`` that are passed to ``func``.

Multiplication table:

>>> list(outer_product(mul, range(1, 4), range(1, 6)))
[(1, 2, 3, 4, 5), (2, 4, 6, 8, 10), (3, 6, 9, 12, 15)]

Cross tabulation:

>>> xs = ['A', 'B', 'A', 'A', 'B', 'B', 'A', 'A', 'B', 'B']
>>> ys = ['X', 'X', 'X', 'Y', 'Z', 'Z', 'Y', 'Y', 'Z', 'Z']
>>> pair_counts = Counter(zip(xs, ys))
>>> count_rows = lambda x, y: pair_counts[x, y]
>>> list(outer_product(count_rows, sorted(set(xs)), sorted(set(ys))))
[(2, 3, 0), (1, 0, 4)]

Usage with ``*args`` and ``**kwargs``:

>>> animals = ['cat', 'wolf', 'mouse']
>>> list(outer_product(min, animals, animals, key=len))
[('cat', 'cat', 'cat'), ('cat', 'wolf', 'wolf'), ('cat', 'wolf', 'mouse')]
"""
```

#### 113: `iter_suppress` Function

**Function Description**: 
Yield each of the items from *iterable*. If the iteration raises one of the specified *exceptions*, that exception will be suppressed and iteration will stop.

**Core Algorithm**: 
Yield each of the items from *iterable*. If the iteration raises one of the specified *exceptions*, that exception will be suppressed and iteration will stop.

**Input/Output Example**:
```python
def iter_suppress(iterable, *exceptions):
"""
Yield each of the items from *iterable*. If the iteration raises one of
the specified *exceptions*, that exception will be suppressed and iteration
will stop.

>>> from itertools import chain
>>> def breaks_at_five(x):
...     while True:
...         if x >= 5:
...             raise RuntimeError
...         yield x
...         x += 1
>>> it_1 = iter_suppress(breaks_at_five(1), RuntimeError)
>>> it_2 = iter_suppress(breaks_at_five(2), RuntimeError)
>>> list(chain(it_1, it_2))
[1, 2, 3, 4, 2, 3, 4]
"""
```

#### 114: `filter_map` Function

**Function Description**: 
Apply *func* to every element of *iterable*, yielding only those which are not ``None``.

**Core Algorithm**: 
Apply *func* to every element of *iterable*, yielding only those which are not ``None``.

**Input/Output Example**:
```python
def filter_map(func, iterable):
"""
Apply *func* to every element of *iterable*, yielding only those which
are not ``None``.

>>> elems = ['1', 'a', '2', 'b', '3']
>>> list(filter_map(lambda s: int(s) if s.isnumeric() else None, elems))
[1, 2, 3]
"""
```

#### 115: `powerset_of_sets` Function

**Function Description**: 
Yields all possible subsets of the iterable.

**Core Algorithm**: 
:func:`powerset_of_sets` takes care to minimize the number of hash operations performed.

**Input/Output Example**:
```python
def powerset_of_sets(iterable, *, baseset=set):
"""
Yields all possible subsets of the iterable.

    >>> list(powerset_of_sets([1, 2, 3]))  # doctest: +SKIP
    [set(), {1}, {2}, {3}, {1, 2}, {1, 3}, {2, 3}, {1, 2, 3}]
    >>> list(powerset_of_sets([1, 1, 0]))  # doctest: +SKIP
    [set(), {1}, {0}, {0, 1}]

:func:`powerset_of_sets` takes care to minimize the number
of hash operations performed.

The *baseset* parameter determines what kind of sets are
constructed, either *set* or *frozenset*.
"""
```

#### 116: `join_mappings` Function

**Function Description**: 
Joins multiple mappings together using their common keys.

**Core Algorithm**: 
Joins multiple mappings together using their common keys.

**Input/Output Example**:
```python
def join_mappings(**field_to_map):
"""
Joins multiple mappings together using their common keys.

>>> user_scores = {'elliot': 50, 'claris': 60}
>>> user_times = {'elliot': 30, 'claris': 40}
>>> join_mappings(score=user_scores, time=user_times)
{'elliot': {'score': 50, 'time': 30}, 'claris': {'score': 60, 'time': 40}}
"""
```

#### 117: `_complex_sumprod` Function
**Function Description**: 
High precision sumprod() for complex numbers. Used by :func:`dft` and :func:`idft`.

**Core Algorithm**: 
High precision sumprod() for complex numbers. Used by :func:`dft` and :func:`idft`.


**Input/Output Example**:
```python
def _complex_sumprod(v1, v2):
    """High precision sumprod() for complex numbers.
    Used by :func:`dft` and :func:`idft`.
    """
```

#### 118: `dft` Function

**Function Description**: 
Discrete Fourier Transform. *xarr* is a sequence of complex numbers. Yields the components of the corresponding transformed output vector.

**Core Algorithm**: 
Inputs are restricted to numeric types that can add and multiply with a complex number. This includes int, float, complex, and Fraction, but excludes Decimal.

**Input/Output Example**:
```python
def dft(xarr):
"""
Discrete Fourier Transform. *xarr* is a sequence of complex numbers.
Yields the components of the corresponding transformed output vector.

>>> import cmath
>>> xarr = [1, 2-1j, -1j, -1+2j]  # time domain
>>> Xarr = [2, -2-2j, -2j, 4+4j]  # frequency domain
>>> magnitudes, phases = zip(*map(cmath.polar, Xarr))
>>> all(map(cmath.isclose, dft(xarr), Xarr))
True

Inputs are restricted to numeric types that can add and multiply
with a complex number.  This includes int, float, complex, and
Fraction, but excludes Decimal.

See :func:`idft` for the inverse Discrete Fourier Transform.
"""
```

#### 119: `idft` Function

**Function Description**: 
Inverse Discrete Fourier Transform. *Xarr* is a sequence of complex numbers. Yields the components of the corresponding inverse-transformed output vector.

**Core Algorithm**: 
Inputs are restricted to numeric types that can add and multiply with a complex number. This includes int, float, complex, and Fraction, but excludes Decimal.

**Input/Output Example**:
```python
def idft(Xarr):
"""
Inverse Discrete Fourier Transform. *Xarr* is a sequence of
complex numbers. Yields the components of the corresponding
inverse-transformed output vector.

>>> import cmath
>>> xarr = [1, 2-1j, -1j, -1+2j]  # time domain
>>> Xarr = [2, -2-2j, -2j, 4+4j]  # frequency domain
>>> all(map(cmath.isclose, idft(Xarr), xarr))
True

Inputs are restricted to numeric types that can add and multiply
with a complex number.  This includes int, float, complex, and
Fraction, but excludes Decimal.

See :func:`dft` for the Discrete Fourier Transform.
"""
```

#### 120: `doublestarmap` Function

**Function Description**: 
Apply *func* to every item of *iterable* by dictionary unpacking the item into *func*.

**Core Algorithm**: 
The difference between :func:`itertools.starmap` and :func:`doublestarmap` parallels the distinction between ``func(*a)`` and ``func(**a)``.

**Input/Output Example**:
```python
def doublestarmap(func, iterable):
"""
Apply *func* to every item of *iterable* by dictionary unpacking
the item into *func*.

The difference between :func:`itertools.starmap` and :func:`doublestarmap`
parallels the distinction between ``func(*a)`` and ``func(**a)``.

>>> iterable = [{'a': 1, 'b': 2}, {'a': 40, 'b': 60}]
>>> list(doublestarmap(lambda a, b: a + b, iterable))
[3, 100]

``TypeError`` will be raised if *func*'s signature doesn't match the
mapping contained in *iterable* or if *iterable* does not contain mappings.
"""
```

#### 121: `_nth_prime_bounds` Function
**Function Description**: 
Bounds for the nth prime (counting from 1): lb < p_n < ub.

**Core Algorithm**: 
Bounds for the nth prime (counting from 1): lb < p_n < ub.


**Input/Output Example**:
```python

def _nth_prime_bounds(n):
    """Bounds for the nth prime (counting from 1): lb < p_n < ub."""
    # At and above 688,383, the lb/ub spread is under 0.003 * p_n.
```

#### 122: `nth_prime` Function

**Function Description**: 
Return the nth prime (counting from 0).

**Core Algorithm**: 
If *approximate* is set to True, will return a prime close to the nth prime. The estimation is much faster than computing an exact result.

**Input/Output Example**:
```python
def nth_prime(n, *, approximate=False):
"""
Return the nth prime (counting from 0).

>>> nth_prime(0)
2
>>> nth_prime(100)
547

If *approximate* is set to True, will return a prime close
to the nth prime.  The estimation is much faster than computing
an exact result.

>>> nth_prime(200_000_000, approximate=True)  # Exact result is 4222234763
4217820427
"""
```

#### 123: `argmin` Function

**Function Description**: 
Index of the first occurrence of a minimum value in an iterable.

**Core Algorithm**: 
For example, look up a label corresponding to the position of a value that minimizes a cost function::

**Input/Output Example**:
```python
def argmin(iterable, *, key=None):
"""
Index of the first occurrence of a minimum value in an iterable.

    >>> argmin('efghabcdijkl')
    4
    >>> argmin([3, 2, 1, 0, 4, 2, 1, 0])
    3

For example, look up a label corresponding to the position
of a value that minimizes a cost function::

    >>> def cost(x):
    ...     "Days for a wound to heal given a subject's age."
    ...     return x**2 - 20*x + 150
    ...
    >>> labels =  ['homer', 'marge', 'bart', 'lisa', 'maggie']
    >>> ages =    [  35,      30,      10,      9,      1    ]

    # Fastest healing family member
    >>> labels[argmin(ages, key=cost)]
    'bart'

    # Age with fastest healing
    >>> min(ages, key=cost)
    10
"""
```

#### 124: `argmax` Function

**Function Description**: 
Index of the first occurrence of a maximum value in an iterable.

**Core Algorithm**: 
For example, identify the best machine learning model::

**Input/Output Example**:
```python
def argmax(iterable, *, key=None):
"""
Index of the first occurrence of a maximum value in an iterable.

    >>> argmax('abcdefghabcd')
    7
    >>> argmax([0, 1, 2, 3, 3, 2, 1, 0])
    3

For example, identify the best machine learning model::

    >>> models =   ['svm', 'random forest', 'knn', 'naïve bayes']
    >>> accuracy = [  68,        61,          84,       72      ]

    # Most accurate model
    >>> models[argmax(accuracy)]
    'knn'

    # Best accuracy
    >>> max(accuracy)
    84
"""
```

#### 125: `extract` Function

**Function Description**: 
Yield values at the specified indices.

**Core Algorithm**: 
Example:

**Input/Output Example**:
```python
def extract(iterable, indices):
"""
Yield values at the specified indices.

Example:

    >>> data = 'abcdefghijklmnopqrstuvwxyz'
    >>> list(extract(data, [7, 4, 11, 11, 14]))
    ['h', 'e', 'l', 'l', 'o']

The *iterable* is consumed lazily and can be infinite.
The *indices* are consumed immediately and must be finite.

Raises ``IndexError`` if an index lies beyond the iterable.
Raises ``ValueError`` for negative indices.
"""
```

#### 126: `tabulate` Function
**Function Description**: 
Return an iterator over the results of ``func(start)``, ``func(start + 1)``, ``func(start + 2)``...

**Core Algorithm**: 
*func* should be a function that accepts one integer argument.

**Input/Output Example**:
```python
def tabulate(function, start=0):
"""
Return an iterator over the results of ``func(start)``,
``func(start + 1)``, ``func(start + 2)``...

*func* should be a function that accepts one integer argument.

If *start* is not specified it defaults to 0. It will be incremented each
time the iterator is advanced.

    >>> square = lambda x: x ** 2
    >>> iterator = tabulate(square, -3)
    >>> take(4, iterator)
    [9, 4, 1, 0]
"""
```

#### 127: `all_equal` Function
**Function Description**: 
Returns ``True`` if all the elements are equal to each other.

**Core Algorithm**: 
A function that accepts a single argument and returns a transformed version of each input item can be specified with *key*:

**Input/Output Example**:
```python
def all_equal(iterable, key=None):
"""
Returns ``True`` if all the elements are equal to each other.

    >>> all_equal('aaaa')
    True
    >>> all_equal('aaab')
    False

A function that accepts a single argument and returns a transformed version
of each input item can be specified with *key*:

    >>> all_equal('AaaA', key=str.casefold)
    True
    >>> all_equal([1, 2, 3], key=lambda x: x < 10)
    True
"""
```

#### 128: `quantify` Function
**Function Description**: 
Return the how many times the predicate is true.

**Core Algorithm**: 
Return the how many times the predicate is true.

**Input/Output Example**:
```python
def quantify(iterable, pred=bool):
"""
Return the how many times the predicate is true.

>>> quantify([True, False, True])
2
"""
```

#### 129: `pad_none` Function
**Function Description**: 
Returns the sequence of elements and then returns ``None`` indefinitely.

**Core Algorithm**: 
Useful for emulating the behavior of the built-in :func:`map` function.

**Input/Output Example**:
```python
def pad_none(iterable):
"""
Returns the sequence of elements and then returns ``None`` indefinitely.

    >>> take(5, pad_none(range(3)))
    [0, 1, 2, None, None]

Useful for emulating the behavior of the built-in :func:`map` function.

See also :func:`padded`.
"""
```

#### 130: `ncycles` Function
**Function Description**: 
Returns the sequence elements *n* times

**Core Algorithm**: 
Returns the sequence elements *n* times

**Input/Output Example**:
```python
def ncycles(iterable, n):
"""
Returns the sequence elements *n* times

>>> list(ncycles(["a", "b"], 3))
['a', 'b', 'a', 'b', 'a', 'b']
"""
```

#### 131: `dotproduct` Function
**Function Description**: 
Returns the dot product of the two iterables.

**Core Algorithm**: 
In Python 3.12 and later, use ``math.sumprod()`` instead.

**Input/Output Example**:
```python
def dotproduct(vec1, vec2):
"""
Returns the dot product of the two iterables.

>>> dotproduct([10, 15, 12], [0.65, 0.80, 1.25])
33.5
>>> 10 * 0.65 + 15 * 0.80 + 12 * 1.25
33.5

In Python 3.12 and later, use ``math.sumprod()`` instead.
"""
```

#### 132: `repeatfunc` Function
**Function Description**: 
Call *func* with *args* repeatedly, returning an iterable over the results.

**Core Algorithm**: 
If *times* is specified, the iterable will terminate after that many repetitions:

**Input/Output Example**:
```python
def repeatfunc(func, times=None, *args):
"""
Call *func* with *args* repeatedly, returning an iterable over the
results.

If *times* is specified, the iterable will terminate after that many
repetitions:

    >>> from operator import add
    >>> times = 4
    >>> args = 3, 5
    >>> list(repeatfunc(add, times, *args))
    [8, 8, 8, 8]

If *times* is ``None`` the iterable will not terminate:

    >>> from random import randrange
    >>> times = None
    >>> args = 1, 11
    >>> take(6, repeatfunc(randrange, times, *args))  # doctest:+SKIP
    [2, 4, 8, 1, 8, 4]
"""
```

#### 133: `partition` Function
**Function Description**: 
Returns a 2-tuple of iterables derived from the input iterable. The first yields the items that have ``pred(item) == False``. The second yields the items that have ``pred(item) == True``.

**Core Algorithm**: 
If *pred* is None, :func:`bool` is used.

**Input/Output Example**:
```python
def partition(pred, iterable):
"""
Returns a 2-tuple of iterables derived from the input iterable.
The first yields the items that have ``pred(item) == False``.
The second yields the items that have ``pred(item) == True``.

    >>> is_odd = lambda x: x % 2 != 0
    >>> iterable = range(10)
    >>> even_items, odd_items = partition(is_odd, iterable)
    >>> list(even_items), list(odd_items)
    ([0, 2, 4, 6, 8], [1, 3, 5, 7, 9])

If *pred* is None, :func:`bool` is used.

    >>> iterable = [0, 1, False, True, '', ' ']
    >>> false_items, true_items = partition(None, iterable)
    >>> list(false_items), list(true_items)
    ([0, False, ''], [1, True, ' '])
"""
```

#### 134: `unique_justseen` Function
**Function Description**: 
Yields elements in order, ignoring serial duplicates

**Core Algorithm**: 
Yields elements in order, ignoring serial duplicates

**Input/Output Example**:
```python
def unique_justseen(iterable, key=None):
"""
Yields elements in order, ignoring serial duplicates

>>> list(unique_justseen('AAAABBBCCDAABBB'))
['A', 'B', 'C', 'D', 'A', 'B']
>>> list(unique_justseen('ABBCcAD', str.lower))
['A', 'B', 'C', 'A', 'D']
"""
```

#### 135: `iter_except` Function
**Function Description**: 
Yields results from a function repeatedly until an exception is raised.

**Core Algorithm**: 
Converts a call-until-exception interface to an iterator interface. Like ``iter(func, sentinel)``, but uses an exception instead of a sentinel to end the loop.

**Input/Output Example**:
```python
def iter_except(func, exception, first=None):
"""
Yields results from a function repeatedly until an exception is raised.

Converts a call-until-exception interface to an iterator interface.
Like ``iter(func, sentinel)``, but uses an exception instead of a sentinel
to end the loop.

    >>> l = [0, 1, 2]
    >>> list(iter_except(l.pop, IndexError))
    [2, 1, 0]

Multiple exceptions can be specified as a stopping condition:

    >>> l = [1, 2, 3, '...', 4, 5, 6]
    >>> list(iter_except(lambda: 1 + l.pop(), (IndexError, TypeError)))
    [7, 6, 5]
    >>> list(iter_except(lambda: 1 + l.pop(), (IndexError, TypeError)))
    [4, 3, 2]
    >>> list(iter_except(lambda: 1 + l.pop(), (IndexError, TypeError)))
    []
"""
```

#### 136: `random_product` Function
**Function Description**: 
Draw an item at random from each of the input iterables.

**Core Algorithm**: 
If *repeat* is provided as a keyword argument, that many items will be drawn from each iterable.

**Input/Output Example**:
```python
def random_product(*args, repeat=1):
"""
Draw an item at random from each of the input iterables.

    >>> random_product('abc', range(4), 'XYZ')  # doctest:+SKIP
    ('c', 3, 'Z')

If *repeat* is provided as a keyword argument, that many items will be
drawn from each iterable.

    >>> random_product('abcd', range(4), repeat=2)  # doctest:+SKIP
    ('a', 2, 'd', 3)

This equivalent to taking a random selection from
``itertools.product(*args, repeat=repeat)``.
"""
```

#### 137: `random_permutation` Function
**Function Description**: 
Return a random *r* length permutation of the elements in *iterable*.

**Core Algorithm**: 
If *r* is not specified or is ``None``, then *r* defaults to the length of *iterable*.

**Input/Output Example**:
```python
def random_permutation(iterable, r=None):
"""
Return a random *r* length permutation of the elements in *iterable*.

If *r* is not specified or is ``None``, then *r* defaults to the length of
*iterable*.

    >>> random_permutation(range(5))  # doctest:+SKIP
    (3, 4, 0, 1, 2)

This equivalent to taking a random selection from
``itertools.permutations(iterable, r)``.
"""
```

#### 138: `random_combination_with_replacement` Function
**Function Description**: 
Return a random *r* length subsequence of elements in *iterable*, allowing individual elements to be repeated.

**Core Algorithm**: 
This equivalent to taking a random selection from ``itertools.combinations_with_replacement(iterable, r)``.

**Input/Output Example**:
```python
def random_combination_with_replacement(iterable, r):
"""
Return a random *r* length subsequence of elements in *iterable*,
allowing individual elements to be repeated.

    >>> random_combination_with_replacement(range(3), 5) # doctest:+SKIP
    (0, 0, 1, 2, 2)

This equivalent to taking a random selection from
``itertools.combinations_with_replacement(iterable, r)``.
"""
```

#### 139: `convolve` Function
**Function Description**: 
Discrete linear convolution of two iterables. Equivalent to polynomial multiplication.

**Core Algorithm**: 
For example, multiplying ``(x² -x - 20)`` by ``(x - 3)`` gives ``(x³ -4x² -17x + 60)``.

**Input/Output Example**:
```python
def convolve(signal, kernel):
"""
Discrete linear convolution of two iterables.
Equivalent to polynomial multiplication.

For example, multiplying ``(x² -x - 20)`` by ``(x - 3)``
gives ``(x³ -4x² -17x + 60)``.

    >>> list(convolve([1, -1, -20], [1, -3]))
    [1, -4, -17, 60]

Examples of popular kinds of kernels:

* The kernel ``[0.25, 0.25, 0.25, 0.25]`` computes a moving average.
  For image data, this blurs the image and reduces noise.
* The kernel ``[1/2, 0, -1/2]`` estimates the first derivative of
  a function evaluated at evenly spaced inputs.
* The kernel ``[1, -2, 1]`` estimates the second derivative of a
  function evaluated at evenly spaced inputs.

Convolutions are mathematically commutative; however, the inputs are
evaluated differently.  The signal is consumed lazily and can be
infinite. The kernel is fully consumed before the calculations begin.

Supports all numeric types: int, float, complex, Decimal, Fraction.

References:

* Article:  https://betterexplained.com/articles/intuitive-convolution/
* Video by 3Blue1Brown:  https://www.youtube.com/watch?v=KuXjwB4LzSA
"""
```

#### 140: `before_and_after` Function
**Function Description**: 
A variant of :func:`takewhile` that allows complete access to the remainder of the iterator.

**Core Algorithm**: 
Note that the first iterator must be fully consumed before the second iterator can generate valid results.

**Input/Output Example**:
```python
def before_and_after(predicate, it):
"""
A variant of :func:`takewhile` that allows complete access to the
remainder of the iterator.

     >>> it = iter('ABCdEfGhI')
     >>> all_upper, remainder = before_and_after(str.isupper, it)
     >>> ''.join(all_upper)
     'ABC'
     >>> ''.join(remainder) # takewhile() would lose the 'd'
     'dEfGhI'

Note that the first iterator must be fully consumed before the second
iterator can generate valid results.
"""
```

#### 141: `_sliding_window_islice` Function
Recipe helper that yields windows using ``itertools.islice``.

**Core Algorithm**: 
Builds tuples of length ``n`` by repeatedly slicing successive prefixes of the iterable.

**Input/Output Example**:
```python
def _sliding_window_islice(iterable, n):
    # Fast path for small, non-zero values of n.
from more_itertools.recipes import _sliding_window_islice

list(_sliding_window_islice(range(5), 3))
# -> [(0, 1, 2), (1, 2, 3), (2, 3, 4)]
```

#### 142: `_sliding_window_deque` Function
Deque-based sliding window recipe used by ``sliding_window``.

**Core Algorithm**: 
Maintains a fixed-length deque to emit overlapping windows in amortized constant time.

**Input/Output Example**:
```python
def _sliding_window_deque(iterable, n):
    # Normal path for other values of n.
from more_itertools.recipes import _sliding_window_deque

list(_sliding_window_deque(range(5), 3))
# -> [(0, 1, 2), (1, 2, 3), (2, 3, 4)]
```

#### 143: `sliding_window` Function
**Function Description**: 
Return a sliding window of width *n* over *iterable*.

**Core Algorithm**: 
If *iterable* has fewer than *n* items, then nothing is yielded:

**Input/Output Example**:
```python
def sliding_window(iterable, n):
"""
Return a sliding window of width *n* over *iterable*.

    >>> list(sliding_window(range(6), 4))
    [(0, 1, 2, 3), (1, 2, 3, 4), (2, 3, 4, 5)]

If *iterable* has fewer than *n* items, then nothing is yielded:

    >>> list(sliding_window(range(3), 4))
    []

For a variant with more features, see :func:`windowed`.
"""
```

#### 144: `subslices` Function
**Function Description**: 
Return all contiguous non-empty subslices of *iterable*.

**Core Algorithm**: 
This is similar to :func:`substrings`, but emits items in a different order.

**Input/Output Example**:
```python
def subslices(iterable):
"""
Return all contiguous non-empty subslices of *iterable*.

    >>> list(subslices('ABC'))
    [['A'], ['A', 'B'], ['A', 'B', 'C'], ['B'], ['B', 'C'], ['C']]

This is similar to :func:`substrings`, but emits items in a different
order.
"""
```

#### 145: `polynomial_from_roots` Function
**Function Description**: 
Compute a polynomial's coefficients from its roots.

**Core Algorithm**: 
Note that polynomial coefficients are specified in descending power order.

**Input/Output Example**:
```python
def polynomial_from_roots(roots):
"""
Compute a polynomial's coefficients from its roots.

>>> roots = [5, -4, 3]            # (x - 5) * (x + 4) * (x - 3)
>>> polynomial_from_roots(roots)  # x³ - 4 x² - 17 x + 60
[1, -4, -17, 60]

Note that polynomial coefficients are specified in descending power order.

Supports all numeric types: int, float, complex, Decimal, Fraction.
"""
```

#### 146: `iter_index` Function
**Function Description**: 
Yield the index of each place in *iterable* that *value* occurs, beginning with index *start* and ending before index *stop*.

**Core Algorithm**: 
The behavior for non-scalar *values* matches the built-in Python types.

**Input/Output Example**:
```python
def iter_index(iterable, value, start=0, stop=None):
"""
Yield the index of each place in *iterable* that *value* occurs,
beginning with index *start* and ending before index *stop*.


>>> list(iter_index('AABCADEAF', 'A'))
[0, 1, 4, 7]
>>> list(iter_index('AABCADEAF', 'A', 1))  # start index is inclusive
[1, 4, 7]
>>> list(iter_index('AABCADEAF', 'A', 1, 7))  # stop index is not inclusive
[1, 4]

The behavior for non-scalar *values* matches the built-in Python types.

>>> list(iter_index('ABCDABCD', 'AB'))
[0, 4]
>>> list(iter_index([0, 1, 2, 3, 0, 1, 2, 3], [0, 1]))
[]
>>> list(iter_index([[0, 1], [2, 3], [0, 1], [2, 3]], [0, 1]))
[0, 2]

See :func:`locate` for a more general means of finding the indexes
associated with particular values.
"""
```

#### 147: `_batched` Function
Batch data into tuples of length *n*. If the number of items in *iterable* is not divisible by *n*: * The last batch will be shorter if *strict* is ``False``. * :exc:`ValueError` will be raised if *strict* is ``True``.

**Core Algorithm**: 
On Python 3.13 and above, this is an alias for :func:`itertools.batched`.

**Input/Output Example**:
```python
def _batched(iterable, n, *, strict=False):  # pragma: no cover
    """Batch data into tuples of length *n*. If the number of items in
    *iterable* is not divisible by *n*:
    * The last batch will be shorter if *strict* is ``False``.
    * :exc:`ValueError` will be raised if *strict* is ``True``.

    >>> list(batched('ABCDEFG', 3))
    [('A', 'B', 'C'), ('D', 'E', 'F'), ('G',)]

    On Python 3.13 and above, this is an alias for :func:`itertools.batched`.
    """
```

#### 148: `_is_scalar` Function
Scalars are bytes, strings, and non-iterables.

**Core Algorithm**: 
Scalars are bytes, strings, and non-iterables.


**Input/Output Example**:
```python
def _is_scalar(value, stringlike=(str, bytes)):
    "Scalars are bytes, strings, and non-iterables."
```

#### 149: `_flatten_tensor` Function
Depth-first iterator over scalars in a tensor.

**Core Algorithm**: 
Depth-first iterator over scalars in a tensor.


**Input/Output Example**:
```python
def _flatten_tensor(tensor):
    "Depth-first iterator over scalars in a tensor."
```

#### 150: `reshape` Function
**Function Description**: 
Change the shape of a *matrix*.

**Core Algorithm**: 
If *shape* is an integer, the matrix must be two dimensional and the shape is interpreted as the desired number of columns:

**Input/Output Example**:
```python
def reshape(matrix, shape):
"""
Change the shape of a *matrix*.

If *shape* is an integer, the matrix must be two dimensional
and the shape is interpreted as the desired number of columns:

    >>> matrix = [(0, 1), (2, 3), (4, 5)]
    >>> cols = 3
    >>> list(reshape(matrix, cols))
    [(0, 1, 2), (3, 4, 5)]

If *shape* is a tuple (or other iterable), the input matrix can have
any number of dimensions. It will first be flattened and then rebuilt
to the desired shape which can also be multidimensional:

    >>> matrix = [(0, 1), (2, 3), (4, 5)]    # Start with a 3 x 2 matrix

    >>> list(reshape(matrix, (2, 3)))        # Make a 2 x 3 matrix
    [(0, 1, 2), (3, 4, 5)]

    >>> list(reshape(matrix, (6,)))          # Make a vector of length six
    [0, 1, 2, 3, 4, 5]

    >>> list(reshape(matrix, (2, 1, 3, 1)))  # Make 2 x 1 x 3 x 1 tensor
    [(((0,), (1,), (2,)),), (((3,), (4,), (5,)),)]

Each dimension is assumed to be uniform, either all arrays or all scalars.
Flattening stops when the first value in a dimension is a scalar.
Scalars are bytes, strings, and non-iterables.
The reshape iterator stops when the requested shape is complete
or when the input is exhausted, whichever comes first.
"""
```

#### 151: `matmul` Function
**Function Description**: 
Multiply two matrices.

**Core Algorithm**: 
The caller should ensure that the dimensions of the input matrices are compatible with each other.

**Input/Output Example**:
```python
def matmul(m1, m2):
"""
Multiply two matrices.

>>> list(matmul([(7, 5), (3, 5)], [(2, 5), (7, 9)]))
[(49, 80), (41, 60)]

The caller should ensure that the dimensions of the input matrices are
compatible with each other.

Supports all numeric types: int, float, complex, Decimal, Fraction.
"""
```

#### 152: `_factor_pollard` Function
Pollard's rho helper that finds a non-trivial factor of an odd composite.

**Core Algorithm**: 
Iteratively searches using the rho method and retries with different seeds when the cycle length stalls.

**Input/Output Example**:
```python
def _factor_pollard(n):
    # Return a factor of n using Pollard's rho algorithm.
    # Efficient when n is odd and composite.
from more_itertools.recipes import _factor_pollard

_factor_pollard(91)  # -> 7
```

#### 153: `factor` Function
**Function Description**: 
Yield the prime factors of n.

**Core Algorithm**: 
Finds small factors with trial division. Larger factors are either verified as prime with ``is_prime`` or split into smaller factors with Pollard's rho algorithm.

**Input/Output Example**:
```python
def factor(n):
"""
Yield the prime factors of n.

>>> list(factor(360))
[2, 2, 2, 3, 3, 5]

Finds small factors with trial division.  Larger factors are
either verified as prime with ``is_prime`` or split into
smaller factors with Pollard's rho algorithm.
"""
```

#### 154: `polynomial_eval` Function
**Function Description**: 
Evaluate a polynomial at a specific value.

**Core Algorithm**: 
Computes with better numeric stability than Horner's method.

**Input/Output Example**:
```python
def polynomial_eval(coefficients, x):
"""
Evaluate a polynomial at a specific value.

Computes with better numeric stability than Horner's method.

Evaluate ``x^3 - 4 * x^2 - 17 * x + 60`` at ``x = 2.5``:

>>> coefficients = [1, -4, -17, 60]
>>> x = 2.5
>>> polynomial_eval(coefficients, x)
8.125

Note that polynomial coefficients are specified in descending power order.

Supports all numeric types: int, float, complex, Decimal, Fraction.
"""
```

#### 155: `sum_of_squares` Function
**Function Description**: 
Return the sum of the squares of the input values.

**Core Algorithm**: 
Supports all numeric types: int, float, complex, Decimal, Fraction.

**Input/Output Example**:
```python
def sum_of_squares(it):
"""
Return the sum of the squares of the input values.

>>> sum_of_squares([10, 20, 30])
1400

Supports all numeric types: int, float, complex, Decimal, Fraction.
"""
```

#### 156: `polynomial_derivative` Function
**Function Description**: 
Compute the first derivative of a polynomial.

**Core Algorithm**: 
Evaluate the derivative of ``x³ - 4 x² - 17 x + 60``:

**Input/Output Example**:
```python
def polynomial_derivative(coefficients):
"""
Compute the first derivative of a polynomial.

Evaluate the derivative of ``x³ - 4 x² - 17 x + 60``:

>>> coefficients = [1, -4, -17, 60]
>>> derivative_coefficients = polynomial_derivative(coefficients)
>>> derivative_coefficients
[3, -8, -17]

Note that polynomial coefficients are specified in descending power order.

Supports all numeric types: int, float, complex, Decimal, Fraction.
"""
```

#### 157: `totient` Function
**Function Description**: 
Return the count of natural numbers up to *n* that are coprime with *n*.

**Core Algorithm**: 
Euler's totient function φ(n) gives the number of totatives. Totative are integers k in the range 1 ≤ k ≤ n such that gcd(n, k) = 1.

**Input/Output Example**:
```python
def totient(n):
"""
Return the count of natural numbers up to *n* that are coprime with *n*.

Euler's totient function φ(n) gives the number of totatives.
Totative are integers k in the range 1 ≤ k ≤ n such that gcd(n, k) = 1.

>>> n = 9
>>> totient(n)
6

>>> totatives = [x for x in range(1, n) if gcd(n, x) == 1]
>>> totatives
[1, 2, 4, 5, 7, 8]
>>> len(totatives)
6

Reference:  https://en.wikipedia.org/wiki/Euler%27s_totient_function
"""
```

#### 158: `_shift_to_odd` Function
Return s, d such that 2**s * d == n

**Core Algorithm**: 
Return s, d such that 2**s * d == n


**Input/Output Example**:
```python
@lru_cache
def _shift_to_odd(n):
    'Return s, d such that 2**s * d == n'
from more_itertools.recipes import _shift_to_odd

_shift_to_odd(40)
(3, 5)
```

#### 159: `_strong_probable_prime` Function
Performs a single strong probable-prime test for the given base.

**Core Algorithm**: 
Checks a candidate integer against the Miller–Rabin conditions for a supplied base.

**Input/Output Example**:
```python
def _strong_probable_prime(n, base)
from more_itertools.recipes import _strong_probable_prime

_strong_probable_prime(561, 2)  # -> False; 561 is a Carmichael number
```

#### 160: `is_prime` Function
**Function Description**: 
Return ``True`` if *n* is prime and ``False`` otherwise.

**Core Algorithm**: 
Basic examples:

**Input/Output Example**:
```python
def is_prime(n):
"""
Return ``True`` if *n* is prime and ``False`` otherwise.

Basic examples:

    >>> is_prime(37)
    True
    >>> is_prime(3 * 13)
    False
    >>> is_prime(18_446_744_073_709_551_557)
    True

Find the next prime over one billion:

    >>> next(filter(is_prime, count(10**9)))
    1000000007

Generate random primes up to 200 bits and up to 60 decimal digits:

    >>> from random import seed, randrange, getrandbits
    >>> seed(18675309)

    >>> next(filter(is_prime, map(getrandbits, repeat(200))))
    893303929355758292373272075469392561129886005037663238028407

    >>> next(filter(is_prime, map(randrange, repeat(10**60))))
    269638077304026462407872868003560484232362454342414618963649

This function is exact for values of *n* below 10**24.  For larger inputs,
the probabilistic Miller-Rabin primality test has a less than 1 in 2**128
chance of a false positive.
"""
```

#### 161: `loops` Function
**Function Description**: 
Returns an iterable with *n* elements for efficient looping. Like ``range(n)`` but doesn't create integers.

**Core Algorithm**: 
Returns an iterable with *n* elements for efficient looping. Like ``range(n)`` but doesn't create integers.

**Input/Output Example**:
```python
def loops(n):
"""
Returns an iterable with *n* elements for efficient looping.
Like ``range(n)`` but doesn't create integers.

>>> i = 0
>>> for _ in loops(5):
...     i += 1
>>> i
5
"""
```

#### 162: `multinomial` Function
**Function Description**: 
Number of distinct arrangements of a multiset.

**Core Algorithm**: 
The expression ``multinomial(3, 4, 2)`` has several equivalent interpretations:

**Input/Output Example**:
```python
def multinomial(*counts):
"""
Number of distinct arrangements of a multiset.

The expression ``multinomial(3, 4, 2)`` has several equivalent
interpretations:

* In the expansion of ``(a + b + c)⁹``, the coefficient of the
  ``a³b⁴c²`` term is 1260.

* There are 1260 distinct ways to arrange 9 balls consisting of 3 reds, 4
  greens, and 2 blues.

* There are 1260 unique ways to place 9 distinct objects into three bins
  with sizes 3, 4, and 2.

The :func:`multinomial` function computes the length of
:func:`distinct_permutations`.  For example, there are 83,160 distinct
anagrams of the word "abracadabra":

    >>> from more_itertools import distinct_permutations, ilen
    >>> ilen(distinct_permutations('abracadabra'))
    83160

This can be computed directly from the letter counts, 5a 2b 2r 1c 1d:

    >>> from collections import Counter
    >>> list(Counter('abracadabra').values())
    [5, 2, 2, 1, 1]
    >>> multinomial(5, 2, 2, 1, 1)
    83160

A binomial coefficient is a special case of multinomial where there are
only two categories.  For example, the number of ways to arrange 12 balls
with 5 reds and 7 blues is ``multinomial(5, 7)`` or ``math.comb(12, 5)``.

Likewise, factorial is a special case of multinomial where
the multiplicities are all just 1 so that
``multinomial(1, 1, 1, 1, 1, 1, 1) == math.factorial(7)``.

Reference:  https://en.wikipedia.org/wiki/Multinomial_theorem
"""
```

#### 163: `_running_median_minheap_and_maxheap` Function
Non-windowed running_median() for Python 3.14+

**Core Algorithm**: 
Non-windowed running_median() for Python 3.14+


**Input/Output Example**:
```python

def _running_median_minheap_and_maxheap(iterator):  # pragma: no cover
    "Non-windowed running_median() for Python 3.14+"

from more_itertools import recipes as mi_recipes

stream = mi_recipes._running_median_minheap_and_maxheap(iter([5.0, 9.0, 4.0, 12.0]))
[next(stream) for _ in range(4)]
[5.0, 7.0, 5.0, 7.0]
```

#### 164: `_running_median_minheap_only` Function
Backport of non-windowed running_median() for Python 3.13 and prior.

**Core Algorithm**: 
Backport of non-windowed running_median() for Python 3.13 and prior.


**Input/Output Example**:
```python
def _running_median_minheap_only(iterator):  # pragma: no cover
    "Backport of non-windowed running_median() for Python 3.13 and prior."
from more_itertools.recipes import _running_median_minheap_only

stream = _running_median_minheap_only(iter([5.0, 9.0, 4.0, 12.0]))
[next(stream) for _ in range(4)]
[5.0, 7.0, 5.0, 7.0]
```

#### 165: `_running_median_windowed` Function
Yield median of values in a sliding window.

**Core Algorithm**: 
Yield median of values in a sliding window.


**Input/Output Example**:
```python
def _running_median_windowed(iterator, maxlen):
    "Yield median of values in a sliding window."

from more_itertools.recipes import _running_median_windowed

stream = _running_median_windowed(iter([5.0, 9.0, 4.0, 12.0]), 3)
[next(stream) for _ in range(4)]
[5.0, 7.0, 5.0, 9.0]
```

#### 166: `running_median` Function
**Function Description**: 
Cumulative median of values seen so far or values in a sliding window.

**Core Algorithm**: 
Set *maxlen* to a positive integer to specify the maximum size of the sliding window. The default of *None* is equivalent to an unbounded window.

**Input/Output Example**:
```python
def running_median(iterable, *, maxlen=None):
"""
Cumulative median of values seen so far or values in a sliding window.

Set *maxlen* to a positive integer to specify the maximum size
of the sliding window.  The default of *None* is equivalent to
an unbounded window.

For example:

    >>> list(running_median([5.0, 9.0, 4.0, 12.0, 8.0, 9.0]))
    [5.0, 7.0, 5.0, 7.0, 8.0, 8.5]
    >>> list(running_median([5.0, 9.0, 4.0, 12.0, 8.0, 9.0], maxlen=3))
    [5.0, 7.0, 5.0, 9.0, 8.0, 9.0]

Supports numeric types such as int, float, Decimal, and Fraction,
but not complex numbers which are unorderable.

On version Python 3.13 and prior, max-heaps are simulated with
negative values. The negation causes Decimal inputs to apply context
rounding, making the results slightly different than that obtained
by statistics.median().
"""
```

#### 167 `_nth_prime_ub` Function

**Function Description**: 
Calculate the upper bound for the nth prime number (counting from 1).

**Core Algorithm**: 
Returns an upper bound estimate for the nth prime using logarithmic approximations. For small values (n < 6), uses a simple multiplier. For larger values, applies the prime counting function inequalities with logarithmic corrections.

**Input/Output Example**:
```python
def _nth_prime_ub(n: int) -> float: ...
from more_itertools.more import _nth_prime_ub

_nth_prime_ub(25)
97.5
```

#### 168 `random_derangement` Function

**Function Description**: 
Return a random derangement of elements in the iterable. A derangement is a permutation where no element appears in its original position.

**Core Algorithm**: 
Equivalent to but much faster than ``choice(list(derangements(iterable)))``. Uses Fisher-Yates shuffle algorithm to randomly permute indices until a valid derangement is found, then applies the permutation to the original sequence.

**Input/Output Example**:
```python
def random_derangement(iterable):
    """Return a random derangement of elements in the iterable.

    Equivalent to but much faster than ``choice(list(derangements(iterable)))``.

    """
```

#### 169 `padnone` Function

**Function Description**: 
Returns the sequence of elements and then returns ``None`` indefinitely. This is an alias for ``pad_none``.

**Core Algorithm**: 
Useful for emulating the behavior of the built-in :func:`map` function. Uses ``chain(iterable, repeat(None))`` to concatenate the original iterable with an infinite sequence of ``None`` values.

**Input/Output Example**:
```python
def padnone(iterable: Iterable[_T]) -> Iterator[_T | None]: ...
from more_itertools.more import padnone

list(take(5, padnone(range(3))))
[0, 1, 2, None, None]
```

#### 170 `_factor_trial` Function

**Function Description**: 
Yield prime factors of n using trial division method. This is a helper function for the main factorization algorithm.

**Core Algorithm**: 
Uses trial division to find small prime factors by testing divisibility against a predefined set of small primes. This method is efficient for finding small factors before applying more complex algorithms like Pollard's rho for larger factors.

**Input/Output Example**:
```python
def _factor_trial(n: int) -> Iterator[int]: ...

from more_itertools.recipes import _factor_trial

list(_factor_trial(360))
[2, 2, 2, 3, 3, 5]
```

#### 171 `_SizedIterable` Protocol

**Function Description**: 
A type protocol that combines Sized and Iterable interfaces for type checking purposes.

**Core Algorithm**: 
Defines a protocol for objects that are both sized (have a length) and iterable. This is used in type hints to specify that a function expects an object that can be both measured and iterated over.

**Input/Output Example**:
```python
from more_itertools.more import _SizedIterable
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # Used for type checking only
    sized_iter: _SizedIterable[int] = [1, 2, 3, 4, 5]
```

#### 172 `_SizedReversible` Protocol

**Function Description**: 
A type protocol that combines Sized and Reversible interfaces for type checking purposes.

**Core Algorithm**: 
Defines a protocol for objects that are sized (have a length) and reversible (can be iterated in reverse). This is used in type hints to specify that a function expects an object that can be measured and reversed.

**Input/Output Example**:
```python
from more_itertools.more import _SizedReversible
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # Used for type checking only
    sized_rev: _SizedReversible[int] = [1, 2, 3, 4, 5]
```

#### 173 `_SupportsSlicing` Protocol

**Function Description**: 
A type protocol that defines objects supporting slicing operations with __getitem__ method.

**Core Algorithm**: 
Defines a protocol for objects that support slicing operations through the __getitem__ method with slice arguments. This is used in type hints to specify that a function expects an object that can be sliced.

**Input/Output Example**:
```python
from more_itertools.more import _SupportsSlicing
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # Used for type checking only
    sliceable: _SupportsSlicing[int] = [1, 2, 3, 4, 5]
    # Supports operations like: sliceable[1:4]
```

#### 174 `_SupportsLessThan` Protocol

**Function Description**: 
A type protocol that defines objects supporting less-than comparison operations with __lt__ method.

**Core Algorithm**: 
Defines a protocol for objects that support less-than comparison through the __lt__ method. This is used in type hints to specify that a function expects an object that can be compared using the < operator.

**Input/Output Example**:
```python
from more_itertools.more import _SupportsLessThan
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # Used for type checking only
    comparable: _SupportsLessThan = 42
    # Supports operations like: comparable < 50
```

#### 175 `_SupportsLessThanT` TypeVar

**Function Description**: 
A type variable bound to the _SupportsLessThan protocol for generic type checking.

**Core Algorithm**: 
Defines a type variable that can represent any type that supports less-than comparison operations. This is used in generic functions to ensure type safety when working with comparable objects.

**Input/Output Example**:
```python
from more_itertools.more import _SupportsLessThanT
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # Used for type checking only
    def min_value(a: _SupportsLessThanT, b: _SupportsLessThanT) -> _SupportsLessThanT:
        return a if a < b else b
```

#### 176 Type Variables and Constants

**Function Description**: 
Type variables and constants used throughout the more_itertools library for generic type checking and internal functionality.

**Core Algorithm**: 
- `_T`, `_T1`, `_T2`, `_T3`, `_T4`, `_T5`, `_U`, `_V`, `_W`: Generic type variables for different data types
- `_T_co`: Covariant type variable for read-only operations
- `_GenFn`: Type variable bound to generator functions
- `_NumberT`: Type variable for numeric types (float, Decimal, Fraction)
- `_Raisable`: Union type for exceptions and exception types
- `_marker`: Sentinel object for internal use
- `_primes_below_211`: Precomputed small primes for factorization
- `_perfect_tests`: Primality test parameters
- `_private_randrange`: Private random number generator instance
- `__version__`: Library version string ('10.8.0')
- `__all__`: List of all public functions, classes, and constants exported by the module

**Input/Output Example**:
```python
from more_itertools.more import _T, _T_co, _marker

# Type variables used in function signatures
def first(iterable: Iterable[_T]) -> _T: ...
def map_except(func: Callable[[_T], _U], iterable: Iterable[_T]) -> Iterator[_U]: ...
```
