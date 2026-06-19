## Introduction and Goals of the Python-SortedContainers Project

Python-SortedContainers is a **high-performance, pure Python sorted container library** that provides three core data structures: SortedList (sorted list), SortedDict (sorted dictionary), and SortedSet (sorted set). This library is licensed under the Apache 2.0 license and is written entirely in pure Python, yet its performance can rival that of C extensions. Its core advantage lies in the ability to obtain a high-performance sorted container implementation **without the need for a compiler or pre-built extensions**. In a situation where the Python standard library lacks sorted collection types, this library offers a complete, efficient, and easy-to-use solution.

Core features include: **O(log(n)) time complexity for insertion, deletion, and lookup operations**, support for custom key functions for sorting, a rich set of set operations (such as union, intersection, difference, etc.), and full support for sequence operations (such as slicing, indexing, iteration, etc.). This library has been widely used in high-performance scenarios such as algorithmic trading, binary analysis, asynchronous I/O, and distributed computing, and is the de facto standard for sorted containers in the Python ecosystem.

## Natural Language Instruction (Prompt) Section

Please create a Python project named Python-SortedContainers to implement a high-performance, pure Python sorted container library. This project should include the following functions:

**1. Implementation of Core Data Structures**: Implement three core sorted container types: SortedList (sorted list), SortedDict (sorted dictionary), and SortedSet (sorted set). All containers must maintain the order of elements and provide insertion, deletion, and lookup operations with O(log n) time complexity. SortedList should support full sequence operations (indexing, slicing, iteration), SortedDict should inherit the functionality of dict and maintain the order of keys, and SortedSet should provide both set operations and sequence access functionality.

**2. Support for Key Functions**: Implement the SortedKeyList class to support custom key functions for sorting. Key functions should be able to handle complex objects, multi-level sorting, and special sorting rules (such as modulo operations, negative value sorting, etc.). Provide binary search, range queries, and indexing operations based on keys.

**3. Performance Optimization Mechanisms**: Implement performance optimization mechanisms such as dynamic adjustment of load factors, memory management optimization, and index tree maintenance. Support large-scale data processing (over 100,000 elements) and ensure efficient performance under various data scales. Provide internal consistency checks and index reconstruction functions.

**4. Complete API Interface**: Provide a complete Python standard library-compatible interface for each container type, including sequence operations (**getitem**, **setitem**, **delitem**, **iter**, **reversed**), set operations (union, intersection, difference, symmetric_difference), dictionary operations (keys, values, items, get, setdefault), etc. Support operator overloading (+, -, &, |, ^, etc.).

**5. Implementation of View Objects**: Implement sorted view objects (SortedKeysView, SortedItemsView, SortedValuesView) for SortedDict, supporting index access, slicing operations, and set operations. View objects should reflect real-time state changes in the dictionary.

**6. Error Handling and Boundary Conditions**: Implement a comprehensive error handling mechanism, including parameter validation, exception throwing, boundary checks, etc. Handle boundary cases such as empty containers, single elements, duplicate elements, and non-comparable objects. Provide stress tests and random operation tests.

**7. Testing and Benchmarking**: Provide a complete unit test suite covering all functional modules and boundary conditions. Implement a performance benchmarking framework to support performance comparison with third-party sorted container libraries. Provide stress tests, memory leak tests, and concurrent safety tests.

**8. Documentation and Examples**: Provide detailed API documentation, usage examples, and performance analysis reports. Include code examples for typical application scenarios, such as algorithmic trading, data analysis, cache management, etc.

**9. Building and Publishing**: The project must include a complete setup.py file to configure the project as an installable package (supporting pip install) and declare a complete list of dependencies. Provide a tox.ini multi-environment test configuration to support compatibility testing across different Python versions.

**10. Requirements for Core Files**: The project must include a complete pyproject.toml file. This file should not only configure the project as an installable package (supporting pip install) but also declare a complete list of dependencies (including core libraries such as pytest==8.4.0, pytest-cov==6.2.1, coverage==7.10.1, ruff==0.4.3, pylint<2.6, doc8==2.0.0, rstcheck==6.2.5, sphinx==8.2.3, docutils==0.21.2, matplotlib==3.9.1, scipy==1.14.0, numpy==1.26.4, build==1.2.1, twine==6.1.0, wheel==0.44.0, tox==4.28.3). At the same time, it is necessary to provide src/sortedcontainers/**init**.py as a unified API entry, importing core classes such as SortedList, SortedKeyList, SortedDict, and SortedSet from the sortedlist, sorteddict, and sortedset modules, exporting view classes such as SortedKeysView, SortedItemsView, and SortedValuesView, and providing version information, allowing users to access all major functions through a simple "from sortedcontainers import SortedList, SortedDict, SortedSet" statement. In sortedlist.py, there needs to be a SortedKeyList class to support custom key functions for sorting. In sorteddict.py, there needs to be an implementation of view objects to provide ordered key-value pair access. In sortedset.py, there needs to be a complete implementation of set operations to support union, intersection, difference, etc.


## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.11

### Versions of Core Dependent Libraries

```Plain
alabaster                     1.0.0
annotated-types               0.7.0
astroid                       2.5
babel                         2.17.0
backports.tarfile             1.2.0
bintrees                      2.2.0
build                         1.3.0
cachetools                    6.1.0
certifi                       2025.8.3
cffi                          1.17.1
chardet                       5.2.0
charset-normalizer            3.4.2
click                         8.2.1
colorama                      0.4.6
contourpy                     1.3.2
coverage                      7.10.2
cryptography                  45.0.6
cycler                        0.12.1
distlib                       0.4.0
doc8                          2.0.0
docutils                      0.21.2
exceptiongroup                1.3.0
filelock                      3.18.0
fonttools                     4.59.0
gj                            0.6.1
id                            1.5.0
idna                          3.10
imagesize                     1.4.1
importlib_metadata            8.7.0
iniconfig                     2.1.0
isort                         4.3.21
jaraco.classes                3.4.0
jaraco.context                6.0.1
jaraco.functools              4.2.1
jeepney                       0.9.0
Jinja2                        3.1.6
keyring                       25.6.0
kiwisolver                    1.4.8
lazy-object-proxy             1.11.0
markdown-it-py                3.0.0
MarkupSafe                    3.0.2
matplotlib                    3.10.5
mccabe                        0.6.1
mdurl                         0.1.2
more-itertools                10.7.0
nh3                           0.3.0
numpy                         2.2.6
packaging                     25.0
pbr                           6.1.1
pillow                        11.3.0
pip                           23.0.1
platformdirs                  4.3.8
pluggy                        1.6.0
pycparser                     2.22
pydantic                      2.11.7
pydantic_core                 2.33.2
Pygments                      2.19.2
pylint                        2.5.3
pyparsing                     3.2.3
pyproject-api                 1.9.1
pyproject_hooks               1.2.0
pytest                        8.4.1
pytest-cov                    6.2.1
python-dateutil               2.9.0.post0
readme_renderer               44.0
requests                      2.32.4
requests-toolbelt             1.0.0
restructuredtext-lint         1.4.0
rfc3986                       2.0.0
rich                          14.1.0
rstcheck                      6.2.5
rstcheck-core                 1.2.2
ruff                          0.12.7
scipy                         1.15.3
SecretStorage                 3.3.3
setuptools                    65.5.1
shellingham                   1.5.4
six                           1.17.0
skiplistcollections           0.0.6
snowballstemmer               3.0.1
Sphinx                        8.1.3
sphinxcontrib-applehelp       2.0.0
sphinxcontrib-devhelp         2.0.0
sphinxcontrib-htmlhelp        2.1.0
sphinxcontrib-jsmath          1.0.1
sphinxcontrib-qthelp          2.0.0
sphinxcontrib-serializinghtml 2.0.0
stevedore                     5.4.1
toml                          0.10.2
tomli                         2.2.1
tox                           4.28.4
treap                         2.0.10
twine                         6.1.0
typer                         0.16.0
typing_extensions             4.14.1
typing-inspection             0.4.1
urllib3                       2.5.0
virtualenv                    20.33.1
wheel                         0.40.0
wrapt                         1.12.1
zipp                          3.23.0

```

## Architecture of the Python-SortedContainers Project

### Project Directory Structure

```Plain
workspace/
├── .gitignore
├── HISTORY.rst
├── LICENSE
├── MANIFEST.in
├── README.rst
├── docs
│   ├── Makefile
│   ├── _static
│   │   ├── SortedDict-contains.png
│   │   ├── SortedDict-delitem.png
│   │   ├── SortedDict-getitem.png
│   │   ├── SortedDict-init.png
│   │   ├── SortedDict-iter.png
│   │   ├── SortedDict-setitem.png
│   │   ├── SortedDict-setitem_existing.png
│   │   ├── SortedDict_load-contains.png
│   │   ├── SortedDict_load-delitem.png
│   │   ├── SortedDict_load-getitem.png
│   │   ├── SortedDict_load-init.png
│   │   ├── SortedDict_load-iter.png
│   │   ├── SortedDict_load-setitem.png
│   │   ├── SortedDict_load-setitem_existing.png
│   │   ├── SortedDict_runtime-contains.png
│   │   ├── SortedDict_runtime-delitem.png
│   │   ├── SortedDict_runtime-getitem.png
│   │   ├── SortedDict_runtime-init.png
│   │   ├── SortedDict_runtime-iter.png
│   │   ├── SortedDict_runtime-setitem.png
│   │   ├── SortedDict_runtime-setitem_existing.png
│   │   ├── SortedList-add.png
│   │   ├── SortedList-bisect.png
│   │   ├── SortedList-contains.png
│   │   ├── SortedList-count.png
│   │   ├── SortedList-delitem.png
│   │   ├── SortedList-getitem.png
│   │   ├── SortedList-index.png
│   │   ├── SortedList-init.png
│   │   ├── SortedList-intervals.png
│   │   ├── SortedList-iter.png
│   │   ├── SortedList-multiset.png
│   │   ├── SortedList-neighbor.png
│   │   ├── SortedList-pop.png
│   │   ├── SortedList-priorityqueue.png
│   │   ├── SortedList-ranking.png
│   │   ├── SortedList-remove.png
│   │   ├── SortedList-update_large.png
│   │   ├── SortedList-update_small.png
│   │   ├── SortedList_load-add.png
│   │   ├── SortedList_load-bisect.png
│   │   ├── SortedList_load-contains.png
│   │   ├── SortedList_load-count.png
│   │   ├── SortedList_load-delitem.png
│   │   ├── SortedList_load-getitem.png
│   │   ├── SortedList_load-index.png
│   │   ├── SortedList_load-init.png
│   │   ├── SortedList_load-intervals.png
│   │   ├── SortedList_load-iter.png
│   │   ├── SortedList_load-multiset.png
│   │   ├── SortedList_load-neighbor.png
│   │   ├── SortedList_load-pop.png
│   │   ├── SortedList_load-priorityqueue.png
│   │   ├── SortedList_load-ranking.png
│   │   ├── SortedList_load-remove.png
│   │   ├── SortedList_load-update_large.png
│   │   ├── SortedList_load-update_small.png
│   │   ├── SortedList_runtime-add.png
│   │   ├── SortedList_runtime-bisect.png
│   │   ├── SortedList_runtime-contains.png
│   │   ├── SortedList_runtime-count.png
│   │   ├── SortedList_runtime-delitem.png
│   │   ├── SortedList_runtime-getitem.png
│   │   ├── SortedList_runtime-index.png
│   │   ├── SortedList_runtime-init.png
│   │   ├── SortedList_runtime-intervals.png
│   │   ├── SortedList_runtime-iter.png
│   │   ├── SortedList_runtime-multiset.png
│   │   ├── SortedList_runtime-neighbor.png
│   │   ├── SortedList_runtime-pop.png
│   │   ├── SortedList_runtime-priorityqueue.png
│   │   ├── SortedList_runtime-ranking.png
│   │   ├── SortedList_runtime-remove.png
│   │   ├── SortedList_runtime-update_large.png
│   │   ├── SortedList_runtime-update_small.png
│   │   ├── SortedSet-add.png
│   │   ├── SortedSet-contains.png
│   │   ├── SortedSet-difference_large.png
│   │   ├── SortedSet-difference_medium.png
│   │   ├── SortedSet-difference_small.png
│   │   ├── SortedSet-difference_tiny.png
│   │   ├── SortedSet-difference_update_large.png
│   │   ├── SortedSet-difference_update_medium.png
│   │   ├── SortedSet-difference_update_small.png
│   │   ├── SortedSet-difference_update_tiny.png
│   │   ├── SortedSet-init.png
│   │   ├── SortedSet-intersection_large.png
│   │   ├── SortedSet-intersection_medium.png
│   │   ├── SortedSet-intersection_small.png
│   │   ├── SortedSet-intersection_tiny.png
│   │   ├── SortedSet-intersection_update_large.png
│   │   ├── SortedSet-intersection_update_medium.png
│   │   ├── SortedSet-intersection_update_small.png
│   │   ├── SortedSet-intersection_update_tiny.png
│   │   ├── SortedSet-iter.png
│   │   ├── SortedSet-pop.png
│   │   ├── SortedSet-remove.png
│   │   ├── SortedSet-symmetric_difference_large.png
│   │   ├── SortedSet-symmetric_difference_medium.png
│   │   ├── SortedSet-symmetric_difference_small.png
│   │   ├── SortedSet-symmetric_difference_tiny.png
│   │   ├── SortedSet-symmetric_difference_update_large.png
│   │   ├── SortedSet-symmetric_difference_update_medium.png
│   │   ├── SortedSet-symmetric_difference_update_small.png
│   │   ├── SortedSet-symmetric_difference_update_tiny.png
│   │   ├── SortedSet-union_large.png
│   │   ├── SortedSet-union_medium.png
│   │   ├── SortedSet-union_small.png
│   │   ├── SortedSet-union_tiny.png
│   │   ├── SortedSet-update_large.png
│   │   ├── SortedSet-update_medium.png
│   │   ├── SortedSet-update_small.png
│   │   ├── SortedSet-update_tiny.png
│   │   ├── SortedSet_load-add.png
│   │   ├── SortedSet_load-contains.png
│   │   ├── SortedSet_load-difference_large.png
│   │   ├── SortedSet_load-difference_medium.png
│   │   ├── SortedSet_load-difference_small.png
│   │   ├── SortedSet_load-difference_tiny.png
│   │   ├── SortedSet_load-difference_update_large.png
│   │   ├── SortedSet_load-difference_update_medium.png
│   │   ├── SortedSet_load-difference_update_small.png
│   │   ├── SortedSet_load-difference_update_tiny.png
│   │   ├── SortedSet_load-init.png
│   │   ├── SortedSet_load-intersection_large.png
│   │   ├── SortedSet_load-intersection_medium.png
│   │   ├── SortedSet_load-intersection_small.png
│   │   ├── SortedSet_load-intersection_tiny.png
│   │   ├── SortedSet_load-intersection_update_large.png
│   │   ├── SortedSet_load-intersection_update_medium.png
│   │   ├── SortedSet_load-intersection_update_small.png
│   │   ├── SortedSet_load-intersection_update_tiny.png
│   │   ├── SortedSet_load-iter.png
│   │   ├── SortedSet_load-pop.png
│   │   ├── SortedSet_load-remove.png
│   │   ├── SortedSet_load-symmetric_difference_large.png
│   │   ├── SortedSet_load-symmetric_difference_medium.png
│   │   ├── SortedSet_load-symmetric_difference_small.png
│   │   ├── SortedSet_load-symmetric_difference_tiny.png
│   │   ├── SortedSet_load-symmetric_difference_update_large.png
│   │   ├── SortedSet_load-symmetric_difference_update_medium.png
│   │   ├── SortedSet_load-symmetric_difference_update_small.png
│   │   ├── SortedSet_load-symmetric_difference_update_tiny.png
│   │   ├── SortedSet_load-union_large.png
│   │   ├── SortedSet_load-union_medium.png
│   │   ├── SortedSet_load-union_small.png
│   │   ├── SortedSet_load-union_tiny.png
│   │   ├── SortedSet_load-update_large.png
│   │   ├── SortedSet_load-update_medium.png
│   │   ├── SortedSet_load-update_small.png
│   │   ├── SortedSet_load-update_tiny.png
│   │   ├── SortedSet_runtime-add.png
│   │   ├── SortedSet_runtime-contains.png
│   │   ├── SortedSet_runtime-difference_large.png
│   │   ├── SortedSet_runtime-difference_medium.png
│   │   ├── SortedSet_runtime-difference_small.png
│   │   ├── SortedSet_runtime-difference_tiny.png
│   │   ├── SortedSet_runtime-difference_update_large.png
│   │   ├── SortedSet_runtime-difference_update_medium.png
│   │   ├── SortedSet_runtime-difference_update_small.png
│   │   ├── SortedSet_runtime-difference_update_tiny.png
│   │   ├── SortedSet_runtime-init.png
│   │   ├── SortedSet_runtime-intersection_large.png
│   │   ├── SortedSet_runtime-intersection_medium.png
│   │   ├── SortedSet_runtime-intersection_small.png
│   │   ├── SortedSet_runtime-intersection_tiny.png
│   │   ├── SortedSet_runtime-intersection_update_large.png
│   │   ├── SortedSet_runtime-intersection_update_medium.png
│   │   ├── SortedSet_runtime-intersection_update_small.png
│   │   ├── SortedSet_runtime-intersection_update_tiny.png
│   │   ├── SortedSet_runtime-iter.png
│   │   ├── SortedSet_runtime-pop.png
│   │   ├── SortedSet_runtime-remove.png
│   │   ├── SortedSet_runtime-symmetric_difference_large.png
│   │   ├── SortedSet_runtime-symmetric_difference_medium.png
│   │   ├── SortedSet_runtime-symmetric_difference_small.png
│   │   ├── SortedSet_runtime-symmetric_difference_tiny.png
│   │   ├── SortedSet_runtime-symmetric_difference_update_large.png
│   │   ├── SortedSet_runtime-symmetric_difference_update_medium.png
│   │   ├── SortedSet_runtime-symmetric_difference_update_small.png
│   │   ├── SortedSet_runtime-symmetric_difference_update_tiny.png
│   │   ├── SortedSet_runtime-union_large.png
│   │   ├── SortedSet_runtime-union_medium.png
│   │   ├── SortedSet_runtime-union_small.png
│   │   ├── SortedSet_runtime-union_tiny.png
│   │   ├── SortedSet_runtime-update_large.png
│   │   ├── SortedSet_runtime-update_medium.png
│   │   ├── SortedSet_runtime-update_small.png
│   │   ├── SortedSet_runtime-update_tiny.png
│   │   └── gj-logo.png
│   ├── _templates
│   │   └── gumroad.html
│   ├── conf.py
│   ├── development.rst
│   ├── djangocon-2015-lightning-talk.rst
│   ├── history.rst
│   ├── implementation.rst
│   ├── index.rst
│   ├── introduction.rst
│   ├── make.bat
│   ├── paper.bib
│   ├── paper.md
│   ├── performance-load.rst
│   ├── performance-runtime.rst
│   ├── performance-scale.rst
│   ├── performance-workload.rst
│   ├── performance.rst
│   ├── pycon-2016-talk.rst
│   ├── sf-python-2015-lightning-talk.rst
│   ├── sorteddict.rst
│   ├── sortedlist.rst
│   └── sortedset.rst
├── pyproject.toml
├── src
│   ├── sortedcontainers
│   │   ├── __init__.py
│   │   ├── sorteddict.py
│   │   ├── sortedlist.py
│   │   └── sortedset.py
└── tox.ini
```

## API Usage Guide

### Core API

#### 1. Module Import

```python
from sortedcontainers import (
    SortedList, SortedKeyList, SortedListWithKey,
    SortedDict, SortedKeysView, SortedItemsView, SortedValuesView,
    SortedSet
)
```

#### 2. SortedList Class

**Class Description**: The SortedList class is a sorted list that maintains the order of elements and provides insertion, deletion, and lookup operations with O(log n) time complexity.

**Class Definition**

```python
class SortedList(MutableSequence):
    """Sorted list is a sorted mutable sequence.

    Sorted list values are maintained in sorted order.

    Sorted list values must be comparable. The total ordering of values must
    not change while they are stored in the sorted list.

    Methods for adding values:

    * :func:`SortedList.add`
    * :func:`SortedList.update`
    * :func:`SortedList.__add__`
    * :func:`SortedList.__iadd__`
    * :func:`SortedList.__mul__`
    * :func:`SortedList.__imul__`

    Methods for removing values:

    * :func:`SortedList.clear`
    * :func:`SortedList.discard`
    * :func:`SortedList.remove`
    * :func:`SortedList.pop`
    * :func:`SortedList.__delitem__`

    Methods for looking up values:

    * :func:`SortedList.bisect_left`
    * :func:`SortedList.bisect_right`
    * :func:`SortedList.count`
    * :func:`SortedList.index`
    * :func:`SortedList.__contains__`
    * :func:`SortedList.__getitem__`

    Methods for iterating values:

    * :func:`SortedList.irange`
    * :func:`SortedList.islice`
    * :func:`SortedList.__iter__`
    * :func:`SortedList.__reversed__`

    Methods for miscellany:

    * :func:`SortedList.copy`
    * :func:`SortedList.__len__`
    * :func:`SortedList.__repr__`
    * :func:`SortedList._check`
    * :func:`SortedList._reset`

    Sorted lists use lexicographical ordering semantics when compared to other
    sequences.

    Some methods of mutable sequences are not supported and will raise
    not-implemented error.

    """

    DEFAULT_LOAD_FACTOR = 1000

    def __init__(self, iterable=None, key=None):
        """Initialize sorted list instance.

        Optional `iterable` argument provides an initial iterable of values to
        initialize the sorted list.

        Runtime complexity: `O(n*log(n))`

        >>> sl = SortedList()
        >>> sl
        SortedList([])
        >>> sl = SortedList([3, 1, 2, 5, 4])
        >>> sl
        SortedList([1, 2, 3, 4, 5])

        :param iterable: initial values (optional)

        """
        assert key is None
        self._len = 0
        self._load = self.DEFAULT_LOAD_FACTOR
        self._lists = []
        self._maxes = []
        self._index = []
        self._offset = 0

        if iterable is not None:
            self._update(iterable)

    def __new__(cls, iterable=None, key=None):
        """Create new sorted list or sorted-key list instance.

        Optional `key`-function argument will return an instance of subtype
        :class:`SortedKeyList`.

        >>> sl = SortedList()
        >>> isinstance(sl, SortedList)
        True
        >>> sl = SortedList(key=lambda x: -x)
        >>> isinstance(sl, SortedList)
        True
        >>> isinstance(sl, SortedKeyList)
        True

        :param iterable: initial values (optional)
        :param key: function used to extract comparison key (optional)
        :return: sorted list or sorted-key list instance

        """

    @property
    def key(self):  # pylint: disable=useless-return
        """Function used to extract comparison key from values.

        Sorted list compares values directly so the key function is none.

        """
        return None

    def _reset(self, load):
        """Reset sorted list load factor.

        The `load` specifies the load-factor of the list. The default load
        factor of 1000 works well for lists from tens to tens-of-millions of
        values. Good practice is to use a value that is the cube root of the
        list size. With billions of elements, the best load factor depends on
        your usage. It's best to leave the load factor at the default until you
        start benchmarking.

        See :doc:`implementation` and :doc:`performance-scale` for more
        information.

        Runtime complexity: `O(n)`

        :param int load: load-factor for sorted list sublists

        """
    def clear(self):
        """Remove all values from sorted list.

        Runtime complexity: `O(n)`

        """
        self._len = 0
        del self._lists[:]
        del self._maxes[:]
        del self._index[:]
        self._offset = 0

    _clear = clear

    def add(self, value):
        """Add `value` to sorted list.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sl = SortedList()
        >>> sl.add(3)
        >>> sl.add(1)
        >>> sl.add(2)
        >>> sl
        SortedList([1, 2, 3])

        :param value: value to add to sorted list

        """

    def _expand(self, pos):
        """Split sublists with length greater than double the load-factor.

        Updates the index when the sublist length is less than double the load
        level. This requires incrementing the nodes in a traversal from the
        leaf node to the root. For an example traversal see
        ``SortedList._loc``.

        """

    def update(self, iterable):
        """Update sorted list by adding all values from `iterable`.

        Runtime complexity: `O(k*log(n))` -- approximate.

        >>> sl = SortedList()
        >>> sl.update([3, 1, 2])
        >>> sl
        SortedList([1, 2, 3])

        :param iterable: iterable of values to add

        """

    _update = update

    def __contains__(self, value):
        """Return true if `value` is an element of the sorted list.

        ``sl.__contains__(value)`` <==> ``value in sl``

        Runtime complexity: `O(log(n))`

        >>> sl = SortedList([1, 2, 3, 4, 5])
        >>> 3 in sl
        True

        :param value: search for value in sorted list
        :return: true if `value` in sorted list

        """

    def discard(self, value):
        """Remove `value` from sorted list if it is a member.

        If `value` is not a member, do nothing.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sl = SortedList([1, 2, 3, 4, 5])
        >>> sl.discard(5)
        >>> sl.discard(0)
        >>> sl == [1, 2, 3, 4]
        True

        :param value: `value` to discard from sorted list

        """

    def remove(self, value):
        """Remove `value` from sorted list; `value` must be a member.

        If `value` is not a member, raise ValueError.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sl = SortedList([1, 2, 3, 4, 5])
        >>> sl.remove(5)
        >>> sl == [1, 2, 3, 4]
        True
        >>> sl.remove(0)
        Traceback (most recent call last):
          ...
        ValueError: 0 not in list

        :param value: `value` to remove from sorted list
        :raises ValueError: if `value` is not in sorted list

        """
    def _delete(self, pos, idx):
        """Delete value at the given `(pos, idx)`.

        Combines lists that are less than half the load level.

        Updates the index when the sublist length is more than half the load
        level. This requires decrementing the nodes in a traversal from the
        leaf node to the root. For an example traversal see
        ``SortedList._loc``.

        :param int pos: lists index
        :param int idx: sublist index

        """

    def _loc(self, pos, idx):
        """Convert an index pair (lists index, sublist index) into a single
        index number that corresponds to the position of the value in the
        sorted list.

        Many queries require the index be built. Details of the index are
        described in ``SortedList._build_index``.

        Indexing requires traversing the tree from a leaf node to the root. The
        parent of each node is easily computable at ``(pos - 1) // 2``.

        Left-child nodes are always at odd indices and right-child nodes are
        always at even indices.

        When traversing up from a right-child node, increment the total by the
        left-child node.

        The final index is the sum from traversal and the index in the sublist.

        For example, using the index from ``SortedList._build_index``::

            _index = 14 5 9 3 2 4 5
            _offset = 3

        Tree::

                 14
              5      9
            3   2  4   5

        Converting an index pair (2, 3) into a single index involves iterating
        like so:

        1. Starting at the leaf node: offset + alpha = 3 + 2 = 5. We identify
           the node as a left-child node. At such nodes, we simply traverse to
           the parent.

        2. At node 9, position 2, we recognize the node as a right-child node
           and accumulate the left-child in our total. Total is now 5 and we
           traverse to the parent at position 0.

        3. Iteration ends at the root.

        The index is then the sum of the total and sublist index: 5 + 3 = 8.

        :param int pos: lists index
        :param int idx: sublist index
        :return: index in sorted list

        """
        

    def _pos(self, idx):
        """Convert an index into an index pair (lists index, sublist index)
        that can be used to access the corresponding lists position.

        Many queries require the index be built. Details of the index are
        described in ``SortedList._build_index``.

        Indexing requires traversing the tree to a leaf node. Each node has two
        children which are easily computable. Given an index, pos, the
        left-child is at ``pos * 2 + 1`` and the right-child is at ``pos * 2 +
        2``.

        When the index is less than the left-child, traversal moves to the
        left sub-tree. Otherwise, the index is decremented by the left-child
        and traversal moves to the right sub-tree.

        At a child node, the indexing pair is computed from the relative
        position of the child node as compared with the offset and the remaining
        index.

        For example, using the index from ``SortedList._build_index``::

            _index = 14 5 9 3 2 4 5
            _offset = 3

        Tree::

                 14
              5      9
            3   2  4   5

        Indexing position 8 involves iterating like so:

        1. Starting at the root, position 0, 8 is compared with the left-child
           node (5) which it is greater than. When greater the index is
           decremented and the position is updated to the right child node.

        2. At node 9 with index 3, we again compare the index to the left-child
           node with value 4. Because the index is the less than the left-child
           node, we simply traverse to the left.

        3. At node 4 with index 3, we recognize that we are at a leaf node and
           stop iterating.

        4. To compute the sublist index, we subtract the offset from the index
           of the leaf node: 5 - 3 = 2. To compute the index in the sublist, we
           simply use the index remaining from iteration. In this case, 3.

        The final index pair from our example is (2, 3) which corresponds to
        index 8 in the sorted list.

        :param int idx: index in sorted list
        :return: (lists index, sublist index) pair

        """

    def _build_index(self):
        """Build a positional index for indexing the sorted list.

        Indexes are represented as binary trees in a dense array notation
        similar to a binary heap.

        For example, given a lists representation storing integers::

            0: [1, 2, 3]
            1: [4, 5]
            2: [6, 7, 8, 9]
            3: [10, 11, 12, 13, 14]

        The first transformation maps the sub-lists by their length. The
        first row of the index is the length of the sub-lists::

            0: [3, 2, 4, 5]

        Each row after that is the sum of consecutive pairs of the previous
        row::

            1: [5, 9]
            2: [14]

        Finally, the index is built by concatenating these lists together::

            _index = [14, 5, 9, 3, 2, 4, 5]

        An offset storing the start of the first row is also stored::

            _offset = 3

        When built, the index can be used for efficient indexing into the list.
        See the comment and notes on ``SortedList._pos`` for details.

        """

    def __delitem__(self, index):
        """Remove value at `index` from sorted list.

        ``sl.__delitem__(index)`` <==> ``del sl[index]``

        Supports slicing.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sl = SortedList('abcde')
        >>> del sl[2]
        >>> sl
        SortedList(['a', 'b', 'd', 'e'])
        >>> del sl[:2]
        >>> sl
        SortedList(['d', 'e'])

        :param index: integer or slice for indexing
        :raises IndexError: if index out of range

        """
    def __getitem__(self, index):
        """Lookup value at `index` in sorted list.

        ``sl.__getitem__(index)`` <==> ``sl[index]``

        Supports slicing.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sl = SortedList('abcde')
        >>> sl[1]
        'b'
        >>> sl[-1]
        'e'
        >>> sl[2:5]
        ['c', 'd', 'e']

        :param index: integer or slice for indexing
        :return: value or list of values
        :raises IndexError: if index out of range

        """
        

    _getitem = __getitem__

    def __setitem__(self, index, value):
        """Raise not-implemented error.

        ``sl.__setitem__(index, value)`` <==> ``sl[index] = value``

        :raises NotImplementedError: use ``del sl[index]`` and
            ``sl.add(value)`` instead

        """
        message = 'use ``del sl[index]`` and ``sl.add(value)`` instead'
        raise NotImplementedError(message)

    def __iter__(self):
        """Return an iterator over the sorted list.

        ``sl.__iter__()`` <==> ``iter(sl)``

        Iterating the sorted list while adding or deleting values may raise a
        :exc:`RuntimeError` or fail to iterate over all values.

        """
        return chain.from_iterable(self._lists)

    def __reversed__(self):
        """Return a reverse iterator over the sorted list.

        ``sl.__reversed__()`` <==> ``reversed(sl)``

        Iterating the sorted list while adding or deleting values may raise a
        :exc:`RuntimeError` or fail to iterate over all values.

        """
        return chain.from_iterable(map(reversed, reversed(self._lists)))

    def reverse(self):
        """Raise not-implemented error.

        Sorted list maintains values in ascending sort order. Values may not be
        reversed in-place.

        Use ``reversed(sl)`` for an iterator over values in descending sort
        order.

        Implemented to override `MutableSequence.reverse` which provides an
        erroneous default implementation.

        :raises NotImplementedError: use ``reversed(sl)`` instead

        """
        raise NotImplementedError('use ``reversed(sl)`` instead')

    def islice(self, start=None, stop=None, reverse=False):
        """Return an iterator that slices sorted list from `start` to `stop`.

        The `start` and `stop` index are treated inclusive and exclusive,
        respectively.

        Both `start` and `stop` default to `None` which is automatically
        inclusive of the beginning and end of the sorted list.

        When `reverse` is `True` the values are yielded from the iterator in
        reverse order; `reverse` defaults to `False`.

        >>> sl = SortedList('abcdefghij')
        >>> it = sl.islice(2, 6)
        >>> list(it)
        ['c', 'd', 'e', 'f']

        :param int start: start index (inclusive)
        :param int stop: stop index (exclusive)
        :param bool reverse: yield values in reverse order
        :return: iterator

        """

    def _islice(self, min_pos, min_idx, max_pos, max_idx, reverse):
        """Return an iterator that slices sorted list using two index pairs.

        The index pairs are (min_pos, min_idx) and (max_pos, max_idx), the
        first inclusive and the latter exclusive. See `_pos` for details on how
        an index is converted to an index pair.

        When `reverse` is `True`, values are yielded from the iterator in
        reverse order.

        """
        
       
    def irange(self, minimum=None, maximum=None, inclusive=(True, True), reverse=False):
        """Create an iterator of values between `minimum` and `maximum`.

        Both `minimum` and `maximum` default to `None` which is automatically
        inclusive of the beginning and end of the sorted list.

        The argument `inclusive` is a pair of booleans that indicates whether
        the minimum and maximum ought to be included in the range,
        respectively. The default is ``(True, True)`` such that the range is
        inclusive of both minimum and maximum.

        When `reverse` is `True` the values are yielded from the iterator in
        reverse order; `reverse` defaults to `False`.

        >>> sl = SortedList('abcdefghij')
        >>> it = sl.irange('c', 'f')
        >>> list(it)
        ['c', 'd', 'e', 'f']

        :param minimum: minimum value to start iterating
        :param maximum: maximum value to stop iterating
        :param inclusive: pair of booleans
        :param bool reverse: yield values in reverse order
        :return: iterator

        """

    def __len__(self):
        """Return the size of the sorted list.

        ``sl.__len__()`` <==> ``len(sl)``

        :return: size of sorted list

        """
        return self._len

    def bisect_left(self, value):
        """Return an index to insert `value` in the sorted list.

        If the `value` is already present, the insertion point will be before
        (to the left of) any existing values.

        Similar to the `bisect` module in the standard library.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sl = SortedList([10, 11, 12, 13, 14])
        >>> sl.bisect_left(12)
        2

        :param value: insertion index of value in sorted list
        :return: index

        """
        

    def bisect_right(self, value):
        """Return an index to insert `value` in the sorted list.

        Similar to `bisect_left`, but if `value` is already present, the
        insertion point will be after (to the right of) any existing values.

        Similar to the `bisect` module in the standard library.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sl = SortedList([10, 11, 12, 13, 14])
        >>> sl.bisect_right(12)
        3

        :param value: insertion index of value in sorted list
        :return: index

        """
        

    bisect = bisect_right
    _bisect_right = bisect_right

    def count(self, value):
        """Return number of occurrences of `value` in the sorted list.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sl = SortedList([1, 2, 2, 3, 3, 3, 4, 4, 4, 4])
        >>> sl.count(3)
        3

        :param value: value to count in sorted list
        :return: count

        """

    def copy(self):
        """Return a shallow copy of the sorted list.

        Runtime complexity: `O(n)`

        :return: new sorted list

        """
        return self.__class__(self)

    __copy__ = copy

    def append(self, value):
        """Raise not-implemented error.

        Implemented to override `MutableSequence.append` which provides an
        erroneous default implementation.

        :raises NotImplementedError: use ``sl.add(value)`` instead

        """
        raise NotImplementedError('use ``sl.add(value)`` instead')

    def extend(self, values):
        """Raise not-implemented error.

        Implemented to override `MutableSequence.extend` which provides an
        erroneous default implementation.

        :raises NotImplementedError: use ``sl.update(values)`` instead

        """
        raise NotImplementedError('use ``sl.update(values)`` instead')

    def insert(self, index, value):
        """Raise not-implemented error.

        :raises NotImplementedError: use ``sl.add(value)`` instead

        """
        raise NotImplementedError('use ``sl.add(value)`` instead')

    def pop(self, index=-1):
        """Remove and return value at `index` in sorted list.

        Raise :exc:`IndexError` if the sorted list is empty or index is out of
        range.

        Negative indices are supported.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sl = SortedList('abcde')
        >>> sl.pop()
        'e'
        >>> sl.pop(2)
        'c'
        >>> sl
        SortedList(['a', 'b', 'd'])

        :param int index: index of value (default -1)
        :return: value
        :raises IndexError: if index is out of range

        """

    def index(self, value, start=None, stop=None):
        """Return first index of value in sorted list.

        Raise ValueError if `value` is not present.

        Index must be between `start` and `stop` for the `value` to be
        considered present. The default value, None, for `start` and `stop`
        indicate the beginning and end of the sorted list.

        Negative indices are supported.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sl = SortedList('abcde')
        >>> sl.index('d')
        3
        >>> sl.index('z')
        Traceback (most recent call last):
          ...
        ValueError: 'z' is not in list

        :param value: value in sorted list
        :param int start: start index (default None, start of sorted list)
        :param int stop: stop index (default None, end of sorted list)
        :return: index of value
        :raises ValueError: if value is not present

        """

    def __add__(self, other):
        """Return new sorted list containing all values in both sequences.

        ``sl.__add__(other)`` <==> ``sl + other``

        Values in `other` do not need to be in sorted order.

        Runtime complexity: `O(n*log(n))`

        >>> sl1 = SortedList('bat')
        >>> sl2 = SortedList('cat')
        >>> sl1 + sl2
        SortedList(['a', 'a', 'b', 'c', 't', 't'])

        :param other: other iterable
        :return: new sorted list

        """

    __radd__ = __add__

    def __iadd__(self, other):
        """Update sorted list with values from `other`.

        ``sl.__iadd__(other)`` <==> ``sl += other``

        Values in `other` do not need to be in sorted order.

        Runtime complexity: `O(k*log(n))` -- approximate.

        >>> sl = SortedList('bat')
        >>> sl += 'cat'
        >>> sl
        SortedList(['a', 'a', 'b', 'c', 't', 't'])

        :param other: other iterable
        :return: existing sorted list

        """

    def __mul__(self, num):
        """Return new sorted list with `num` shallow copies of values.

        ``sl.__mul__(num)`` <==> ``sl * num``

        Runtime complexity: `O(n*log(n))`

        >>> sl = SortedList('abc')
        >>> sl * 3
        SortedList(['a', 'a', 'a', 'b', 'b', 'b', 'c', 'c', 'c'])

        :param int num: count of shallow copies
        :return: new sorted list

        """

    __rmul__ = __mul__

    def __imul__(self, num):
        """Update the sorted list with `num` shallow copies of values.

        ``sl.__imul__(num)`` <==> ``sl *= num``

        Runtime complexity: `O(n*log(n))`

        >>> sl = SortedList('abc')
        >>> sl *= 3
        >>> sl
        SortedList(['a', 'a', 'a', 'b', 'b', 'b', 'c', 'c', 'c'])

        :param int num: count of shallow copies
        :return: existing sorted list

        """

    def __make_cmp(seq_op, symbol, doc):
        """Make comparator method.
        Args:
            seq_op: The operation to compare with.
            symbol: The symbol to use for the comparison.
            doc: The documentation for the comparison.
        Returns:
            A comparator method.
        """

        def comparer(self, other):
            """Compare method for sorted list and sequence.
            Args:
                other: The other sequence to compare with.
            Returns:
                True if the sorted list is equal to the other sequence, False otherwise.
            """

        seq_op_name = seq_op.__name__
        comparer.__name__ = f'__{seq_op_name}__'
        doc_str = """Return true if and only if sorted list is {0} `other`.

        ``sl.__{1}__(other)`` <==> ``sl {2} other``

        Comparisons use lexicographical order as with sequences.

        Runtime complexity: `O(n)`

        :param other: `other` sequence
        :return: true if sorted list is {0} `other`

        """
        comparer.__doc__ = dedent(doc_str.format(doc, seq_op_name, symbol))
        return comparer

    __eq__ = __make_cmp(eq, '==', 'equal to')
    __ne__ = __make_cmp(ne, '!=', 'not equal to')
    __lt__ = __make_cmp(lt, '<', 'less than')
    __gt__ = __make_cmp(gt, '>', 'greater than')
    __le__ = __make_cmp(le, '<=', 'less than or equal to')
    __ge__ = __make_cmp(ge, '>=', 'greater than or equal to')
    __make_cmp = staticmethod(__make_cmp)

    def __reduce__(self):
        values = reduce(iadd, self._lists, [])
        return (type(self), (values,))

    @recursive_repr()
    def __repr__(self):
        """Return string representation of sorted list.

        ``sl.__repr__()`` <==> ``repr(sl)``

        :return: string representation

        """
        return f'{type(self).__name__}({list(self)!r})'

    def _check(self):
        """Check invariants of sorted list.

        Runtime complexity: `O(n)`

        """
```

#### 3. SortedKeyList Class

**Class Description**: The SortedKeyList class is a sorted list that maintains the order of elements and provides insertion, deletion, and lookup operations with O(log n) time complexity.

**Class Definition**

```python
class SortedKeyList(SortedList):
    """Sorted-key list is a subtype of sorted list.

    The sorted-key list maintains values in comparison order based on the
    result of a key function applied to every value.

    All the same methods that are available in :class:`SortedList` are also
    available in :class:`SortedKeyList`.

    Additional methods provided:

    * :attr:`SortedKeyList.key`
    * :func:`SortedKeyList.bisect_key_left`
    * :func:`SortedKeyList.bisect_key_right`
    * :func:`SortedKeyList.irange_key`

    Some examples below use:

    >>> from operator import neg
    >>> neg
    <built-in function neg>
    >>> neg(1)
    -1

    """

    def __init__(self, iterable=None, key=identity):
        """Initialize sorted-key list instance.

        Optional `iterable` argument provides an initial iterable of values to
        initialize the sorted-key list.

        Optional `key` argument defines a callable that, like the `key`
        argument to Python's `sorted` function, extracts a comparison key from
        each value. The default is the identity function.

        Runtime complexity: `O(n*log(n))`

        >>> from operator import neg
        >>> skl = SortedKeyList(key=neg)
        >>> skl
        SortedKeyList([], key=<built-in function neg>)
        >>> skl = SortedKeyList([3, 1, 2], key=neg)
        >>> skl
        SortedKeyList([3, 2, 1], key=<built-in function neg>)

        :param iterable: initial values (optional)
        :param key: function used to extract comparison key (optional)

        """
        self._key = key
        self._len = 0
        self._load = self.DEFAULT_LOAD_FACTOR
        self._lists = []
        self._keys = []
        self._maxes = []
        self._index = []
        self._offset = 0

        if iterable is not None:
            self._update(iterable)

    def __new__(cls, iterable=None, key=identity):
        return object.__new__(cls)

    @property
    def key(self):
        "Function used to extract comparison key from values."
        return self._key

    def clear(self):
        """Remove all values from sorted-key list.

        Runtime complexity: `O(n)`

        """
        self._len = 0
        del self._lists[:]
        del self._keys[:]
        del self._maxes[:]
        del self._index[:]

    _clear = clear

    def add(self, value):
        """Add `value` to sorted-key list.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> from operator import neg
        >>> skl = SortedKeyList(key=neg)
        >>> skl.add(3)
        >>> skl.add(1)
        >>> skl.add(2)
        >>> skl
        SortedKeyList([3, 2, 1], key=<built-in function neg>)

        :param value: value to add to sorted-key list

        """

    def _expand(self, pos):
        """Split sublists with length greater than double the load-factor.

        Updates the index when the sublist length is less than double the load
        level. This requires incrementing the nodes in a traversal from the
        leaf node to the root. For an example traversal see
        ``SortedList._loc``.

        """

    def update(self, iterable):
        """Update sorted-key list by adding all values from `iterable`.

        Runtime complexity: `O(k*log(n))` -- approximate.

        >>> from operator import neg
        >>> skl = SortedKeyList(key=neg)
        >>> skl.update([3, 1, 2])
        >>> skl
        SortedKeyList([3, 2, 1], key=<built-in function neg>)

        :param iterable: iterable of values to add

        """

    _update = update

    def __contains__(self, value):
        """Return true if `value` is an element of the sorted-key list.

        ``skl.__contains__(value)`` <==> ``value in skl``

        Runtime complexity: `O(log(n))`

        >>> from operator import neg
        >>> skl = SortedKeyList([1, 2, 3, 4, 5], key=neg)
        >>> 3 in skl
        True

        :param value: search for value in sorted-key list
        :return: true if `value` in sorted-key list

        """

    def discard(self, value):
        """Remove `value` from sorted-key list if it is a member.

        If `value` is not a member, do nothing.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> from operator import neg
        >>> skl = SortedKeyList([5, 4, 3, 2, 1], key=neg)
        >>> skl.discard(1)
        >>> skl.discard(0)
        >>> skl == [5, 4, 3, 2]
        True

        :param value: `value` to discard from sorted-key list

        """

    def remove(self, value):
        """Remove `value` from sorted-key list; `value` must be a member.

        If `value` is not a member, raise ValueError.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> from operator import neg
        >>> skl = SortedKeyList([1, 2, 3, 4, 5], key=neg)
        >>> skl.remove(5)
        >>> skl == [4, 3, 2, 1]
        True
        >>> skl.remove(0)
        Traceback (most recent call last):
          ...
        ValueError: 0 not in list

        :param value: `value` to remove from sorted-key list
        :raises ValueError: if `value` is not in sorted-key list

        """

    def _delete(self, pos, idx):
        """Delete value at the given `(pos, idx)`.

        Combines lists that are less than half the load level.

        Updates the index when the sublist length is more than half the load
        level. This requires decrementing the nodes in a traversal from the
        leaf node to the root. For an example traversal see
        ``SortedList._loc``.

        :param int pos: lists index
        :param int idx: sublist index

        """

    def irange(self, minimum=None, maximum=None, inclusive=(True, True), reverse=False):
        """Create an iterator of values between `minimum` and `maximum`.

        Both `minimum` and `maximum` default to `None` which is automatically
        inclusive of the beginning and end of the sorted-key list.

        The argument `inclusive` is a pair of booleans that indicates whether
        the minimum and maximum ought to be included in the range,
        respectively. The default is ``(True, True)`` such that the range is
        inclusive of both minimum and maximum.

        When `reverse` is `True` the values are yielded from the iterator in
        reverse order; `reverse` defaults to `False`.

        >>> from operator import neg
        >>> skl = SortedKeyList([11, 12, 13, 14, 15], key=neg)
        >>> it = skl.irange(14.5, 11.5)
        >>> list(it)
        [14, 13, 12]

        :param minimum: minimum value to start iterating
        :param maximum: maximum value to stop iterating
        :param inclusive: pair of booleans
        :param bool reverse: yield values in reverse order
        :return: iterator

        """

    def irange_key(
        self, min_key=None, max_key=None, inclusive=(True, True), reverse=False
    ):
        """Create an iterator of values between `min_key` and `max_key`.

        Both `min_key` and `max_key` default to `None` which is automatically
        inclusive of the beginning and end of the sorted-key list.

        The argument `inclusive` is a pair of booleans that indicates whether
        the minimum and maximum ought to be included in the range,
        respectively. The default is ``(True, True)`` such that the range is
        inclusive of both minimum and maximum.

        When `reverse` is `True` the values are yielded from the iterator in
        reverse order; `reverse` defaults to `False`.

        >>> from operator import neg
        >>> skl = SortedKeyList([11, 12, 13, 14, 15], key=neg)
        >>> it = skl.irange_key(-14, -12)
        >>> list(it)
        [14, 13, 12]

        :param min_key: minimum key to start iterating
        :param max_key: maximum key to stop iterating
        :param inclusive: pair of booleans
        :param bool reverse: yield values in reverse order
        :return: iterator

        """

    _irange_key = irange_key

    def bisect_left(self, value):
        """Return an index to insert `value` in the sorted-key list.

        If the `value` is already present, the insertion point will be before
        (to the left of) any existing values.

        Similar to the `bisect` module in the standard library.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> from operator import neg
        >>> skl = SortedKeyList([5, 4, 3, 2, 1], key=neg)
        >>> skl.bisect_left(1)
        4

        :param value: insertion index of value in sorted-key list
        :return: index

        """

    def bisect_right(self, value):
        """Return an index to insert `value` in the sorted-key list.

        Similar to `bisect_left`, but if `value` is already present, the
        insertion point will be after (to the right of) any existing values.

        Similar to the `bisect` module in the standard library.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> from operator import neg
        >>> skl = SortedList([5, 4, 3, 2, 1], key=neg)
        >>> skl.bisect_right(1)
        5

        :param value: insertion index of value in sorted-key list
        :return: index

        """

    bisect = bisect_right

    def bisect_key_left(self, key):
        """Return an index to insert `key` in the sorted-key list.

        If the `key` is already present, the insertion point will be before (to
        the left of) any existing keys.

        Similar to the `bisect` module in the standard library.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> from operator import neg
        >>> skl = SortedKeyList([5, 4, 3, 2, 1], key=neg)
        >>> skl.bisect_key_left(-1)
        4

        :param key: insertion index of key in sorted-key list
        :return: index

        """

    _bisect_key_left = bisect_key_left

    def bisect_key_right(self, key):
        """Return an index to insert `key` in the sorted-key list.

        Similar to `bisect_key_left`, but if `key` is already present, the
        insertion point will be after (to the right of) any existing keys.

        Similar to the `bisect` module in the standard library.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> from operator import neg
        >>> skl = SortedList([5, 4, 3, 2, 1], key=neg)
        >>> skl.bisect_key_right(-1)
        5

        :param key: insertion index of key in sorted-key list
        :return: index

        """

    bisect_key = bisect_key_right
    _bisect_key_right = bisect_key_right

    def count(self, value):
        """Return number of occurrences of `value` in the sorted-key list.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> from operator import neg
        >>> skl = SortedKeyList([4, 4, 4, 4, 3, 3, 3, 2, 2, 1], key=neg)
        >>> skl.count(2)
        2

        :param value: value to count in sorted-key list
        :return: count

        """

    def copy(self):
        """Return a shallow copy of the sorted-key list.

        Runtime complexity: `O(n)`

        :return: new sorted-key list

        """
        return self.__class__(self, key=self._key)

    __copy__ = copy

    def index(self, value, start=None, stop=None):
        """Return first index of value in sorted-key list.

        Raise ValueError if `value` is not present.

        Index must be between `start` and `stop` for the `value` to be
        considered present. The default value, None, for `start` and `stop`
        indicate the beginning and end of the sorted-key list.

        Negative indices are supported.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> from operator import neg
        >>> skl = SortedKeyList([5, 4, 3, 2, 1], key=neg)
        >>> skl.index(2)
        3
        >>> skl.index(0)
        Traceback (most recent call last):
          ...
        ValueError: 0 is not in list

        :param value: value in sorted-key list
        :param int start: start index (default None, start of sorted-key list)
        :param int stop: stop index (default None, end of sorted-key list)
        :return: index of value
        :raises ValueError: if value is not present

        """

    def __add__(self, other):
        """Return new sorted-key list containing all values in both sequences.

        ``skl.__add__(other)`` <==> ``skl + other``

        Values in `other` do not need to be in sorted-key order.

        Runtime complexity: `O(n*log(n))`

        >>> from operator import neg
        >>> skl1 = SortedKeyList([5, 4, 3], key=neg)
        >>> skl2 = SortedKeyList([2, 1, 0], key=neg)
        >>> skl1 + skl2
        SortedKeyList([5, 4, 3, 2, 1, 0], key=<built-in function neg>)

        :param other: other iterable
        :return: new sorted-key list

        """

    __radd__ = __add__

    def __mul__(self, num):
        """Return new sorted-key list with `num` shallow copies of values.

        ``skl.__mul__(num)`` <==> ``skl * num``

        Runtime complexity: `O(n*log(n))`

        >>> from operator import neg
        >>> skl = SortedKeyList([3, 2, 1], key=neg)
        >>> skl * 2
        SortedKeyList([3, 3, 2, 2, 1, 1], key=<built-in function neg>)

        :param int num: count of shallow copies
        :return: new sorted-key list

        """

    def __reduce__(self):
        """Return a tuple of the class and the arguments to the __init__ method."""

    @recursive_repr()
    def __repr__(self):
        """Return string representation of sorted-key list.

        ``skl.__repr__()`` <==> ``repr(skl)``

        :return: string representation

        """

    def _check(self):
        """Check invariants of sorted-key list.

        Runtime complexity: `O(n)`

        """

```

#### 4. SortedSet Class

**Class Description**: The SortedSet class is a sorted set that maintains the order of elements and provides insertion, deletion, and lookup operations with O(log n) time complexity. It is a subclass of the SortedList class and provides a set-like interface.

**Class Definition**

```python
class SortedSet(MutableSet, Sequence):
    """Sorted set is a sorted mutable set.

    Sorted set values are maintained in sorted order. The design of sorted set
    is simple: sorted set uses a set for set-operations and maintains a sorted
    list of values.

    Sorted set values must be hashable and comparable. The hash and total
    ordering of values must not change while they are stored in the sorted set.

    Mutable set methods:

    * :func:`SortedSet.__contains__`
    * :func:`SortedSet.__iter__`
    * :func:`SortedSet.__len__`
    * :func:`SortedSet.add`
    * :func:`SortedSet.discard`

    Sequence methods:

    * :func:`SortedSet.__getitem__`
    * :func:`SortedSet.__delitem__`
    * :func:`SortedSet.__reversed__`

    Methods for removing values:

    * :func:`SortedSet.clear`
    * :func:`SortedSet.pop`
    * :func:`SortedSet.remove`

    Set-operation methods:

    * :func:`SortedSet.difference`
    * :func:`SortedSet.difference_update`
    * :func:`SortedSet.intersection`
    * :func:`SortedSet.intersection_update`
    * :func:`SortedSet.symmetric_difference`
    * :func:`SortedSet.symmetric_difference_update`
    * :func:`SortedSet.union`
    * :func:`SortedSet.update`

    Methods for miscellany:

    * :func:`SortedSet.copy`
    * :func:`SortedSet.count`
    * :func:`SortedSet.__repr__`
    * :func:`SortedSet._check`

    Sorted list methods available:

    * :func:`SortedList.bisect_left`
    * :func:`SortedList.bisect_right`
    * :func:`SortedList.index`
    * :func:`SortedList.irange`
    * :func:`SortedList.islice`
    * :func:`SortedList._reset`

    Additional sorted list methods available, if key-function used:

    * :func:`SortedKeyList.bisect_key_left`
    * :func:`SortedKeyList.bisect_key_right`
    * :func:`SortedKeyList.irange_key`

    Sorted set comparisons use subset and superset relations. Two sorted sets
    are equal if and only if every element of each sorted set is contained in
    the other (each is a subset of the other). A sorted set is less than
    another sorted set if and only if the first sorted set is a proper subset
    of the second sorted set (is a subset, but is not equal). A sorted set is
    greater than another sorted set if and only if the first sorted set is a
    proper superset of the second sorted set (is a superset, but is not equal).

    """

    def __init__(self, iterable=None, key=None):
        """Initialize sorted set instance.

        Optional `iterable` argument provides an initial iterable of values to
        initialize the sorted set.

        Optional `key` argument defines a callable that, like the `key`
        argument to Python's `sorted` function, extracts a comparison key from
        each value. The default, none, compares values directly.

        Runtime complexity: `O(n*log(n))`

        >>> ss = SortedSet([3, 1, 2, 5, 4])
        >>> ss
        SortedSet([1, 2, 3, 4, 5])
        >>> from operator import neg
        >>> ss = SortedSet([3, 1, 2, 5, 4], neg)
        >>> ss
        SortedSet([5, 4, 3, 2, 1], key=<built-in function neg>)

        :param iterable: initial values (optional)
        :param key: function used to extract comparison key (optional)

        """
        self._key = key

        # SortedSet._fromset calls SortedSet.__init__ after initializing the
        # _set attribute. So only create a new set if the _set attribute is not
        # already present.

        if not hasattr(self, '_set'):
            self._set = set()

        self._list = SortedList(self._set, key=key)

        # Expose some set methods publicly.

        _set = self._set
        self.isdisjoint = _set.isdisjoint
        self.issubset = _set.issubset
        self.issuperset = _set.issuperset

        # Expose some sorted list methods publicly.

        _list = self._list
        self.bisect_left = _list.bisect_left
        self.bisect = _list.bisect
        self.bisect_right = _list.bisect_right
        self.index = _list.index
        self.irange = _list.irange
        self.islice = _list.islice
        self._reset = _list._reset

        if key is not None:
            self.bisect_key_left = _list.bisect_key_left
            self.bisect_key_right = _list.bisect_key_right
            self.bisect_key = _list.bisect_key
            self.irange_key = _list.irange_key

        if iterable is not None:
            self._update(iterable)

    @classmethod
    def _fromset(cls, values, key=None):
        """Initialize sorted set from existing set.

        Used internally by set operations that return a new set.

        """

    @property
    def key(self):
        """Function used to extract comparison key from values.

        Sorted set compares values directly when the key function is none.

        """
        return self._key

    def __contains__(self, value):
        """Return true if `value` is an element of the sorted set.

        ``ss.__contains__(value)`` <==> ``value in ss``

        Runtime complexity: `O(1)`

        >>> ss = SortedSet([1, 2, 3, 4, 5])
        >>> 3 in ss
        True

        :param value: search for value in sorted set
        :return: true if `value` in sorted set

        """
        return value in self._set

    def __getitem__(self, index):
        """Lookup value at `index` in sorted set.

        ``ss.__getitem__(index)`` <==> ``ss[index]``

        Supports slicing.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> ss = SortedSet('abcde')
        >>> ss[2]
        'c'
        >>> ss[-1]
        'e'
        >>> ss[2:5]
        ['c', 'd', 'e']

        :param index: integer or slice for indexing
        :return: value or list of values
        :raises IndexError: if index out of range

        """
        return self._list[index]

    def __delitem__(self, index):
        """Remove value at `index` from sorted set.

        ``ss.__delitem__(index)`` <==> ``del ss[index]``

        Supports slicing.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> ss = SortedSet('abcde')
        >>> del ss[2]
        >>> ss
        SortedSet(['a', 'b', 'd', 'e'])
        >>> del ss[:2]
        >>> ss
        SortedSet(['d', 'e'])

        :param index: integer or slice for indexing
        :raises IndexError: if index out of range

        """

    def __make_cmp(set_op, symbol, doc):
        """Make comparator method.
        Args:
            set_op: The operation to compare with.
            symbol: The symbol to use for the comparison.
            doc: The documentation for the comparison.
        Returns:
            A comparator method.
        """

        def comparer(self, other):
            """Compare method for sorted set and set.
            Args:
                other: The other set to compare with.
            Returns:
                True if the sorted set is equal to the other set, False otherwise.
            """

        set_op_name = set_op.__name__
        comparer.__name__ = f'__{set_op_name}__'
        doc_str = """Return true if and only if sorted set is {0} `other`.

        ``ss.__{1}__(other)`` <==> ``ss {2} other``

        Comparisons use subset and superset semantics as with sets.

        Runtime complexity: `O(n)`

        :param other: `other` set
        :return: true if sorted set is {0} `other`

        """
        comparer.__doc__ = dedent(doc_str.format(doc, set_op_name, symbol))
        return comparer

    __eq__ = __make_cmp(eq, '==', 'equal to')
    __ne__ = __make_cmp(ne, '!=', 'not equal to')
    __lt__ = __make_cmp(lt, '<', 'a proper subset of')
    __gt__ = __make_cmp(gt, '>', 'a proper superset of')
    __le__ = __make_cmp(le, '<=', 'a subset of')
    __ge__ = __make_cmp(ge, '>=', 'a superset of')
    __make_cmp = staticmethod(__make_cmp)

    def __len__(self):
        """Return the size of the sorted set.

        ``ss.__len__()`` <==> ``len(ss)``

        :return: size of sorted set

        """

    def __iter__(self):
        """Return an iterator over the sorted set.

        ``ss.__iter__()`` <==> ``iter(ss)``

        Iterating the sorted set while adding or deleting values may raise a
        :exc:`RuntimeError` or fail to iterate over all values.

        """

    def __reversed__(self):
        """Return a reverse iterator over the sorted set.

        ``ss.__reversed__()`` <==> ``reversed(ss)``

        Iterating the sorted set while adding or deleting values may raise a
        :exc:`RuntimeError` or fail to iterate over all values.

        """

    def add(self, value):
        """Add `value` to sorted set.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> ss = SortedSet()
        >>> ss.add(3)
        >>> ss.add(1)
        >>> ss.add(2)
        >>> ss
        SortedSet([1, 2, 3])

        :param value: value to add to sorted set

        """
    _add = add

    def clear(self):
        """Remove all values from sorted set.

        Runtime complexity: `O(n)`

        """

    def copy(self):
        """Return a shallow copy of the sorted set.

        Runtime complexity: `O(n)`

        :return: new sorted set

        """

    __copy__ = copy

    def count(self, value):
        """Return number of occurrences of `value` in the sorted set.

        Runtime complexity: `O(1)`

        >>> ss = SortedSet([1, 2, 3, 4, 5])
        >>> ss.count(3)
        1

        :param value: value to count in sorted set
        :return: count

        """

    def discard(self, value):
        """Remove `value` from sorted set if it is a member.

        If `value` is not a member, do nothing.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> ss = SortedSet([1, 2, 3, 4, 5])
        >>> ss.discard(5)
        >>> ss.discard(0)
        >>> ss == set([1, 2, 3, 4])
        True

        :param value: `value` to discard from sorted set

        """
    _discard = discard

    def pop(self, index=-1):
        """Remove and return value at `index` in sorted set.

        Raise :exc:`IndexError` if the sorted set is empty or index is out of
        range.

        Negative indices are supported.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> ss = SortedSet('abcde')
        >>> ss.pop()
        'e'
        >>> ss.pop(2)
        'c'
        >>> ss
        SortedSet(['a', 'b', 'd'])

        :param int index: index of value (default -1)
        :return: value
        :raises IndexError: if index is out of range

        """
        # pylint: disable=arguments-differ

    def remove(self, value):
        """Remove `value` from sorted set; `value` must be a member.

        If `value` is not a member, raise :exc:`KeyError`.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> ss = SortedSet([1, 2, 3, 4, 5])
        >>> ss.remove(5)
        >>> ss == set([1, 2, 3, 4])
        True
        >>> ss.remove(0)
        Traceback (most recent call last):
          ...
        KeyError: 0

        :param value: `value` to remove from sorted set
        :raises KeyError: if `value` is not in sorted set

        """

    def difference(self, *iterables):
        """Return the difference of two or more sets as a new sorted set.

        The `difference` method also corresponds to operator ``-``.

        ``ss.__sub__(iterable)`` <==> ``ss - iterable``

        The difference is all values that are in this sorted set but not the
        other `iterables`.

        >>> ss = SortedSet([1, 2, 3, 4, 5])
        >>> ss.difference([4, 5, 6, 7])
        SortedSet([1, 2, 3])

        :param iterables: iterable arguments
        :return: new sorted set

        """

    __sub__ = difference

    def difference_update(self, *iterables):
        """Remove all values of `iterables` from this sorted set.

        The `difference_update` method also corresponds to operator ``-=``.

        ``ss.__isub__(iterable)`` <==> ``ss -= iterable``

        >>> ss = SortedSet([1, 2, 3, 4, 5])
        >>> _ = ss.difference_update([4, 5, 6, 7])
        >>> ss
        SortedSet([1, 2, 3])

        :param iterables: iterable arguments
        :return: itself

        """

    __isub__ = difference_update

    def intersection(self, *iterables):
        """Return the intersection of two or more sets as a new sorted set.

        The `intersection` method also corresponds to operator ``&``.

        ``ss.__and__(iterable)`` <==> ``ss & iterable``

        The intersection is all values that are in this sorted set and each of
        the other `iterables`.

        >>> ss = SortedSet([1, 2, 3, 4, 5])
        >>> ss.intersection([4, 5, 6, 7])
        SortedSet([4, 5])

        :param iterables: iterable arguments
        :return: new sorted set

        """

    __and__ = intersection
    __rand__ = __and__

    def intersection_update(self, *iterables):
        """Update the sorted set with the intersection of `iterables`.

        The `intersection_update` method also corresponds to operator ``&=``.

        ``ss.__iand__(iterable)`` <==> ``ss &= iterable``

        Keep only values found in itself and all `iterables`.

        >>> ss = SortedSet([1, 2, 3, 4, 5])
        >>> _ = ss.intersection_update([4, 5, 6, 7])
        >>> ss
        SortedSet([4, 5])

        :param iterables: iterable arguments
        :return: itself

        """

    __iand__ = intersection_update

    def symmetric_difference(self, other):
        """Return the symmetric difference with `other` as a new sorted set.

        The `symmetric_difference` method also corresponds to operator ``^``.

        ``ss.__xor__(other)`` <==> ``ss ^ other``

        The symmetric difference is all values tha are in exactly one of the
        sets.

        >>> ss = SortedSet([1, 2, 3, 4, 5])
        >>> ss.symmetric_difference([4, 5, 6, 7])
        SortedSet([1, 2, 3, 6, 7])

        :param other: `other` iterable
        :return: new sorted set

        """

    __xor__ = symmetric_difference
    __rxor__ = __xor__

    def symmetric_difference_update(self, other):
        """Update the sorted set with the symmetric difference with `other`.

        The `symmetric_difference_update` method also corresponds to operator
        ``^=``.

        ``ss.__ixor__(other)`` <==> ``ss ^= other``

        Keep only values found in exactly one of itself and `other`.

        >>> ss = SortedSet([1, 2, 3, 4, 5])
        >>> _ = ss.symmetric_difference_update([4, 5, 6, 7])
        >>> ss
        SortedSet([1, 2, 3, 6, 7])

        :param other: `other` iterable
        :return: itself

        """

    __ixor__ = symmetric_difference_update

    def union(self, *iterables):
        """Return new sorted set with values from itself and all `iterables`.

        The `union` method also corresponds to operator ``|``.

        ``ss.__or__(iterable)`` <==> ``ss | iterable``

        >>> ss = SortedSet([1, 2, 3, 4, 5])
        >>> ss.union([4, 5, 6, 7])
        SortedSet([1, 2, 3, 4, 5, 6, 7])

        :param iterables: iterable arguments
        :return: new sorted set

        """

    __or__ = union
    __ror__ = __or__

    def update(self, *iterables):
        """Update the sorted set adding values from all `iterables`.

        The `update` method also corresponds to operator ``|=``.

        ``ss.__ior__(iterable)`` <==> ``ss |= iterable``

        >>> ss = SortedSet([1, 2, 3, 4, 5])
        >>> _ = ss.update([4, 5, 6, 7])
        >>> ss
        SortedSet([1, 2, 3, 4, 5, 6, 7])

        :param iterables: iterable arguments
        :return: itself

        """
        return self + sum(iterables, self.__class__())

    __ior__ = update
    _update = update

    def __reduce__(self):
        """Support for pickle.

        The tricks played with exposing methods in :func:`SortedSet.__init__`
        confuse pickle so customize the reducer.

        """
        return (type(self), (self._set, self._key))

    @recursive_repr()
    def __repr__(self):
        """Return string representation of sorted set.

        ``ss.__repr__()`` <==> ``repr(ss)``

        :return: string representation

        """

    def _check(self):
        """Check invariants of sorted set.

        Runtime complexity: `O(n)`

        """

```

#### 5. SortedDict Class

**Class Description**: The SortedDict class is a sorted dictionary that maintains the order of keys and values and provides insertion, deletion, and lookup operations with O(log n) time complexity.

**Class Definition**

```python
lass SortedDict(dict):
    """Sorted dict is a sorted mutable mapping.

    Sorted dict keys are maintained in sorted order. The design of sorted dict
    is simple: sorted dict inherits from dict to store items and maintains a
    sorted list of keys.

    Sorted dict keys must be hashable and comparable. The hash and total
    ordering of keys must not change while they are stored in the sorted dict.

    Mutable mapping methods:

    * :func:`SortedDict.__getitem__` (inherited from dict)
    * :func:`SortedDict.__setitem__`
    * :func:`SortedDict.__delitem__`
    * :func:`SortedDict.__iter__`
    * :func:`SortedDict.__len__` (inherited from dict)

    Methods for adding items:

    * :func:`SortedDict.setdefault`
    * :func:`SortedDict.update`

    Methods for removing items:

    * :func:`SortedDict.clear`
    * :func:`SortedDict.pop`
    * :func:`SortedDict.popitem`

    Methods for looking up items:

    * :func:`SortedDict.__contains__` (inherited from dict)
    * :func:`SortedDict.get` (inherited from dict)
    * :func:`SortedDict.peekitem`

    Methods for views:

    * :func:`SortedDict.keys`
    * :func:`SortedDict.items`
    * :func:`SortedDict.values`

    Methods for miscellany:

    * :func:`SortedDict.copy`
    * :func:`SortedDict.fromkeys`
    * :func:`SortedDict.__reversed__`
    * :func:`SortedDict.__eq__` (inherited from dict)
    * :func:`SortedDict.__ne__` (inherited from dict)
    * :func:`SortedDict.__repr__`
    * :func:`SortedDict._check`

    Sorted list methods available (applies to keys):

    * :func:`SortedList.bisect_left`
    * :func:`SortedList.bisect_right`
    * :func:`SortedList.index`
    * :func:`SortedList.irange`
    * :func:`SortedList.islice`
    * :func:`SortedList._reset`

    Additional sorted list methods available, if key-function used:

    * :func:`SortedKeyList.bisect_key_left`
    * :func:`SortedKeyList.bisect_key_right`
    * :func:`SortedKeyList.irange_key`

    Sorted dicts may only be compared for equality and inequality.

    """

    def __init__(self, *args, **kwargs):
        """Initialize sorted dict instance.

        Optional key-function argument defines a callable that, like the `key`
        argument to the built-in `sorted` function, extracts a comparison key
        from each dictionary key. If no function is specified, the default
        compares the dictionary keys directly. The key-function argument must
        be provided as a positional argument and must come before all other
        arguments.

        Optional iterable argument provides an initial sequence of pairs to
        initialize the sorted dict. Each pair in the sequence defines the key
        and corresponding value. If a key is seen more than once, the last
        value associated with it is stored in the new sorted dict.

        Optional mapping argument provides an initial mapping of items to
        initialize the sorted dict.

        If keyword arguments are given, the keywords themselves, with their
        associated values, are added as items to the dictionary. If a key is
        specified both in the positional argument and as a keyword argument,
        the value associated with the keyword is stored in the
        sorted dict.

        Sorted dict keys must be hashable, per the requirement for Python's
        dictionaries. Keys (or the result of the key-function) must also be
        comparable, per the requirement for sorted lists.

        >>> d = {'alpha': 1, 'beta': 2}
        >>> SortedDict([('alpha', 1), ('beta', 2)]) == d
        True
        >>> SortedDict({'alpha': 1, 'beta': 2}) == d
        True
        >>> SortedDict(alpha=1, beta=2) == d
        True

        """
        if args and (args[0] is None or callable(args[0])):
            _key = self._key = args[0]
            args = args[1:]
        else:
            _key = self._key = None

        self._list = SortedList(key=_key)

        # Reaching through ``self._list`` repeatedly adds unnecessary overhead
        # so cache references to sorted list methods.

        _list = self._list
        self._list_add = _list.add
        self._list_clear = _list.clear
        self._list_iter = _list.__iter__
        self._list_reversed = _list.__reversed__
        self._list_pop = _list.pop
        self._list_remove = _list.remove
        self._list_update = _list.update

        # Expose some sorted list methods publicly.

        self.bisect_left = _list.bisect_left
        self.bisect = _list.bisect_right
        self.bisect_right = _list.bisect_right
        self.index = _list.index
        self.irange = _list.irange
        self.islice = _list.islice
        self._reset = _list._reset

        if _key is not None:
            self.bisect_key_left = _list.bisect_key_left
            self.bisect_key_right = _list.bisect_key_right
            self.bisect_key = _list.bisect_key
            self.irange_key = _list.irange_key

        self._update(*args, **kwargs)

    @property
    def key(self):
        """Function used to extract comparison key from keys.

        Sorted dict compares keys directly when the key function is none.

        """

    @property
    def iloc(self):
        """Cached reference of sorted keys view.

        Deprecated in version 2 of Sorted Containers. Use
        :func:`SortedDict.keys` instead.
        Returns:
            A cached reference of the sorted keys view.
        """

    def clear(self):
        """Remove all items from sorted dict.

        Runtime complexity: `O(n)`

        """

    def __delitem__(self, key):
        """Remove item from sorted dict identified by `key`.

        ``sd.__delitem__(key)`` <==> ``del sd[key]``

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sd = SortedDict({'a': 1, 'b': 2, 'c': 3})
        >>> del sd['b']
        >>> sd
        SortedDict({'a': 1, 'c': 3})
        >>> del sd['z']
        Traceback (most recent call last):
          ...
        KeyError: 'z'

        :param key: `key` for item lookup
        :raises KeyError: if key not found

        """

    def __iter__(self):
        """Return an iterator over the keys of the sorted dict.

        ``sd.__iter__()`` <==> ``iter(sd)``

        Iterating the sorted dict while adding or deleting items may raise a
        :exc:`RuntimeError` or fail to iterate over all keys.

        """

    def __reversed__(self):
        """Return a reverse iterator over the keys of the sorted dict.

        ``sd.__reversed__()`` <==> ``reversed(sd)``

        Iterating the sorted dict while adding or deleting items may raise a
        :exc:`RuntimeError` or fail to iterate over all keys.

        """

    def __setitem__(self, key, value):
        """Store item in sorted dict with `key` and corresponding `value`.

        ``sd.__setitem__(key, value)`` <==> ``sd[key] = value``

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sd = SortedDict()
        >>> sd['c'] = 3
        >>> sd['a'] = 1
        >>> sd['b'] = 2
        >>> sd
        SortedDict({'a': 1, 'b': 2, 'c': 3})

        :param key: key for item
        :param value: value for item

        """

    def __or__(self, other):
        """Return a new sorted dict with items from both self and other.
        Args:
            other: The other dictionary to merge with.
        Returns:
            A new sorted dictionary with items from both self and other.
        """

    def __ror__(self, other):
        """Return a new sorted dict with items from both self and other.
        Args:
            other: The other dictionary to merge with.
        Returns:
            A new sorted dictionary with items from both self and other.
        """

    def __ior__(self, other):
        """Update the sorted dict with items from other.
        Args:
            other: The other dictionary to merge with.
        Returns:
            The updated sorted dictionary.
        """

    def copy(self):
        """Return a shallow copy of the sorted dict.

        Runtime complexity: `O(n)`

        :return: new sorted dict

        """

    __copy__ = copy

    @classmethod
    def fromkeys(cls, iterable, value=None):
        """Return a new sorted dict initailized from `iterable` and `value`.

        Items in the sorted dict have keys from `iterable` and values equal to
        `value`.

        Runtime complexity: `O(n*log(n))`

        :return: new sorted dict

        """

    def keys(self):
        """Return new sorted keys view of the sorted dict's keys.

        See :class:`SortedKeysView` for details.

        :return: new sorted keys view

        """

    def items(self):
        """Return new sorted items view of the sorted dict's items.

        See :class:`SortedItemsView` for details.

        :return: new sorted items view

        """

    def values(self):
        """Return new sorted values view of the sorted dict's values.

        Note that the values view is sorted by key.

        See :class:`SortedValuesView` for details.

        :return: new sorted values view

        """

    class _NotGiven:
        # pylint: disable=too-few-public-methods
        def __repr__(self):
            return '<not-given>'

    __not_given = _NotGiven()

    def pop(self, key, default=__not_given):
        """Remove and return value for item identified by `key`.

        If the `key` is not found then return `default` if given. If `default`
        is not given then raise :exc:`KeyError`.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sd = SortedDict({'a': 1, 'b': 2, 'c': 3})
        >>> sd.pop('c')
        3
        >>> sd.pop('z', 26)
        26
        >>> sd.pop('y')
        Traceback (most recent call last):
          ...
        KeyError: 'y'

        :param key: `key` for item
        :param default: `default` value if key not found (optional)
        :return: value for item
        :raises KeyError: if `key` not found and `default` not given

        """

    def popitem(self, index=-1):
        """Remove and return ``(key, value)`` pair at `index` from sorted dict.

        Optional argument `index` defaults to -1, the last item in the sorted
        dict. Specify ``index=0`` for the first item in the sorted dict.

        If the sorted dict is empty, raises :exc:`KeyError`.

        If the `index` is out of range, raises :exc:`IndexError`.

        Runtime complexity: `O(log(n))`

        >>> sd = SortedDict({'a': 1, 'b': 2, 'c': 3})
        >>> sd.popitem()
        ('c', 3)
        >>> sd.popitem(0)
        ('a', 1)
        >>> sd.popitem(100)
        Traceback (most recent call last):
          ...
        IndexError: list index out of range

        :param int index: `index` of item (default -1)
        :return: key and value pair
        :raises KeyError: if sorted dict is empty
        :raises IndexError: if `index` out of range

        """

    def peekitem(self, index=-1):
        """Return ``(key, value)`` pair at `index` in sorted dict.

        Optional argument `index` defaults to -1, the last item in the sorted
        dict. Specify ``index=0`` for the first item in the sorted dict.

        Unlike :func:`SortedDict.popitem`, the sorted dict is not modified.

        If the `index` is out of range, raises :exc:`IndexError`.

        Runtime complexity: `O(log(n))`

        >>> sd = SortedDict({'a': 1, 'b': 2, 'c': 3})
        >>> sd.peekitem()
        ('c', 3)
        >>> sd.peekitem(0)
        ('a', 1)
        >>> sd.peekitem(100)
        Traceback (most recent call last):
          ...
        IndexError: list index out of range

        :param int index: index of item (default -1)
        :return: key and value pair
        :raises IndexError: if `index` out of range

        """

    def setdefault(self, key, default=None):
        """Return value for item identified by `key` in sorted dict.

        If `key` is in the sorted dict then return its value. If `key` is not
        in the sorted dict then insert `key` with value `default` and return
        `default`.

        Optional argument `default` defaults to none.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sd = SortedDict()
        >>> sd.setdefault('a', 1)
        1
        >>> sd.setdefault('a', 10)
        1
        >>> sd
        SortedDict({'a': 1})

        :param key: key for item
        :param default: value for item (default None)
        :return: value for item identified by `key`

        """

    def update(self, *args, **kwargs):
        """Update sorted dict with items from `args` and `kwargs`.

        Overwrites existing items.

        Optional arguments `args` and `kwargs` may be a mapping, an iterable of
        pairs or keyword arguments. See :func:`SortedDict.__init__` for
        details.

        :param args: mapping or iterable of pairs
        :param kwargs: keyword arguments mapping

        """

    _update = update

    def __reduce__(self):
        """Support for pickle.

        The tricks played with caching references in
        :func:`SortedDict.__init__` confuse pickle so customize the reducer.
        Returns:
            A tuple of the class and the arguments to the __init__ method.
        """

    @recursive_repr()
    def __repr__(self):
        """Return string representation of sorted dict.

        ``sd.__repr__()`` <==> ``repr(sd)``

        :return: string representation

        """

    def _check(self):
        """Check invariants of sorted dict.

        Runtime complexity: `O(n)`

        """
```

#### 6. SortedKeysView Class

**Class Description**: The SortedKeysView class is a dynamic view of the sorted dict's keys. It is a subclass of the KeysView class and provides a sequence-like interface.

**Class Definition**

```python
class SortedKeysView(KeysView, Sequence):
    """Sorted keys view is a dynamic view of the sorted dict's keys.

    When the sorted dict's keys change, the view reflects those changes.

    The keys view implements the set and sequence abstract base classes.

    """

    __slots__ = ()

    @classmethod
    def _from_iterable(cls, it):
        return SortedSet(it)

    def __getitem__(self, index):
        """Lookup key at `index` in sorted keys views.

        ``skv.__getitem__(index)`` <==> ``skv[index]``

        Supports slicing.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sd = SortedDict({'a': 1, 'b': 2, 'c': 3})
        >>> skv = sd.keys()
        >>> skv[0]
        'a'
        >>> skv[-1]
        'c'
        >>> skv[:]
        ['a', 'b', 'c']
        >>> skv[100]
        Traceback (most recent call last):
          ...
        IndexError: list index out of range

        :param index: integer or slice for indexing
        :return: key or list of keys
        :raises IndexError: if index out of range

        """

    __delitem__ = _view_delitem
```

#### 7. SortedItemsView Class

**Class Description**: The SortedItemsView class is a dynamic view of the sorted dict's items. It is a subclass of the ItemsView class and provides a sequence-like interface.

**Class Definition**

```python
class SortedItemsView(ItemsView, Sequence):
    """Sorted items view is a dynamic view of the sorted dict's items.

    When the sorted dict's items change, the view reflects those changes.

    The items view implements the set and sequence abstract base classes.

    """

    __slots__ = ()

    @classmethod
    def _from_iterable(cls, it):
        return SortedSet(it)

    def __getitem__(self, index):
        """Lookup item at `index` in sorted items view.

        ``siv.__getitem__(index)`` <==> ``siv[index]``

        Supports slicing.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sd = SortedDict({'a': 1, 'b': 2, 'c': 3})
        >>> siv = sd.items()
        >>> siv[0]
        ('a', 1)
        >>> siv[-1]
        ('c', 3)
        >>> siv[:]
        [('a', 1), ('b', 2), ('c', 3)]
        >>> siv[100]
        Traceback (most recent call last):
          ...
        IndexError: list index out of range

        :param index: integer or slice for indexing
        :return: item or list of items
        :raises IndexError: if index out of range

        """

    __delitem__ = _view_delitem
```

#### 8. SortedValuesView Class

**Class Description**: The SortedValuesView class is a dynamic view of the sorted dict's values. It is a subclass of the ValuesView class and provides a sequence-like interface.

**Class Definition**

```python
class SortedValuesView(ValuesView, Sequence):
    """Sorted values view is a dynamic view of the sorted dict's values.

    When the sorted dict's values change, the view reflects those changes.

    The values view implements the sequence abstract base class.

    """

    __slots__ = ()

    def __getitem__(self, index):
        """Lookup value at `index` in sorted values view.

        ``siv.__getitem__(index)`` <==> ``siv[index]``

        Supports slicing.

        Runtime complexity: `O(log(n))` -- approximate.

        >>> sd = SortedDict({'a': 2, 'b': 1, 'c': 3})
        >>> svv = sd.values()
        >>> svv[0]
        2
        >>> svv[-1]
        3
        >>> svv[:]
        [2, 1, 3]
        >>> svv[100]
        Traceback (most recent call last):
          ...
        IndexError: list index out of range

        :param index: integer or slice for indexing
        :return: value or list of values
        :raises IndexError: if index out of range

        """

    __delitem__ = _view_delitem
```

#### 9. identity() Function

**Function**: The identity() function is a helper function that returns the input value.

**Function Signature**

```python
def identity(value):
```

**Parameters**:

- value: The value to return.

**Returns**: The input value.

#### 10. _view_delitem() Function

**Function**: The _view_delitem() function is a helper function that removes an item at a given index from a sorted dict.

**Function Signature**

```python
def _view_delitem(self, index):
```

**Parameters**:

- self: The sorted dict to remove the item from.
- index: The index of the item to remove.

**Returns**: None.

#### 11. Type Aliases

```python

# In src/sortedcontainers/sortedlist.py
SortedListWithKey = SortedKeyList

# In src/sortedcontainers/__init__.py
__all__ = [
    'SortedList',
    'SortedKeyList',
    'SortedListWithKey',
    'SortedDict',
    'SortedKeysView',
    'SortedItemsView',
    'SortedValuesView',
    'SortedSet',
]
__title__ = 'sortedcontainers'
__version__ = '2.4.0'
__build__ = 0x020400
__author__ = 'Grant Jenks'
__license__ = 'Apache 2.0'
__copyright__ = '2014-2024, Grant Jenks'
```
### Usage Examples

#### Basic Usage

```python
# Create an ordered list
from sortedcontainers import SortedList
sl = SortedList([3, 1, 4, 1, 5, 9, 2, 6])
print(sl)  # SortedList([1, 1, 2, 3, 4, 5, 6, 9])

# Add elements
sl.add(7)
sl.update([8, 0])

# Find elements
print(5 in sl)  # True
print(sl.bisect_left(4))  # 3
print(sl.count(1))  # 2

# Delete elements
sl.remove(1)
sl.discard(10)  # No error

# Range query
for item in sl.irange(3, 7):
    print(item)  # 3, 4, 5, 6, 7
```

#### Using an Ordered Dictionary

```python
from sortedcontainers import SortedDict
sd = SortedDict({'c': 3, 'a': 1, 'b': 2})
print(sd)  # SortedDict({'a': 1, 'b': 2, 'c': 3})

# Ordered operations
print(sd.popitem())  # ('c', 3)
print(sd.peekitem(0))  # ('a', 1)

# Key range query
for key in sd.irange('a', 'c'):
    print(key, sd[key])
```

#### Using an Ordered Set

```python
from sortedcontainers import SortedSet
ss = SortedSet('abracadabra')
print(ss)  # SortedSet(['a', 'b', 'c', 'd', 'r'])

# Set operations
ss2 = SortedSet('python')
print(ss.union(ss2))  # SortedSet(['a', 'b', 'c', 'd', 'h', 'n', 'o', 'p', 'r', 't', 'y'])
print(ss.intersection(ss2))  # SortedSet(['h', 'n', 'o', 'p', 't', 'y'])
```

#### Using Key Functions

```python
from sortedcontainers import SortedKeyList
from operator import neg

# Sort by absolute value
skl = SortedKeyList([-3, 1, -2, 4, -1], key=abs)
print(skl)  # SortedKeyList([1, -1, -2, -3, 4], key=<built-in function abs>)

# Sort by negative value
skl2 = SortedKeyList([1, 2, 3, 4, 5], key=neg)
print(skl2)  # SortedKeyList([5, 4, 3, 2, 1], key=<built-in function neg>)
```

### Performance Characteristics

- **Time Complexity**: Most operations have a time complexity of O(log n)
- **Space Complexity**: O(n)
- **Load Factor**: The default is 1000 and can be adjusted according to the data scale
- **Pure Python Implementation**: No C extensions are required, and it is cross-platform compatible
- **Memory Efficiency**: Uses a list-of-lists structure to optimize memory usage

### Notes

1. **Element Comparability**: All elements must support comparison operations
2. **Key Function Stability**: The key function must return the same output for the same input
3. **Load Factor Tuning**: The `_reset(load)` parameter can be adjusted for large datasets
4. **Thread Safety**: It is not thread-safe. Locks are required in a multi-threaded environment
5. **Memory Management**: Calling `_reset()` may be required to optimize memory after a large number of deletion operations

## Detailed Implementation Nodes of Functions

### Node 1: Basic SortedList Operations

**Function Description**: Implement the core basic operations of an ordered list, including initialization, addition, deletion, and searching, to ensure that the elements always remain in an ordered state.

**Core Algorithms**:

- Maintenance of a list-of-lists data structure
- Load factor balancing mechanism
- Binary search for positioning
- Index tree maintenance

**Input-Output Examples**:

```python
from sortedcontainers import SortedList

# Initialization test
def test_init():
    slt = SortedList()
    assert slt.key is None
    slt._check()

    slt = SortedList(range(10000))
    assert all(tup[0] == tup[1] for tup in zip(slt, range(10000)))

    slt.clear()
    assert slt._len == 0
    assert slt._maxes == []
    assert slt._lists == []

# Element addition test
def test_add():
    slt = SortedList()
    for val in range(1000):
        slt.add(val)
        slt._check()

    slt = SortedList()
    for val in range(1000, 0, -1):  # Add in reverse order
        slt.add(val)
        slt._check()

    # Add random numbers
    import random
    slt = SortedList()
    for val in range(1000):
        slt.add(random.random())
        slt._check()

# Batch update test
def test_update():
    slt = SortedList()
    slt.update(range(1000))
    assert len(slt) == 1000

    slt.update(range(100))
    assert len(slt) == 1100

    slt.update(range(10000))
    assert len(slt) == 11100

# Containment test
def test_contains():
    slt = SortedList()
    assert 0 not in slt

    slt.update(range(10000))
    for val in range(10000):
        assert val in slt

    assert 10000 not in slt
```

### Node 2: SortedList Deletion Operations

**Function Description**: Implement the deletion operations of an ordered list, including safe deletion, forced deletion, index deletion, and slice deletion, to ensure that the list remains ordered after deletion.

**Core Algorithms**:

- Binary search to locate the deletion position
- Reload the load factor
- Update the index tree
- Handle boundary conditions

**Input-Output Examples**:

```python
from sortedcontainers import SortedList

# Safe deletion test
def test_discard():
    slt = SortedList()
    assert slt.discard(0) == None  # No error if it does not exist
    assert len(slt) == 0

    slt = SortedList([1, 2, 2, 2, 3, 3, 5])
    slt._reset(4)

    slt.discard(6)  # Non-existent element
    slt.discard(4)  # Non-existent element
    slt.discard(2)  # Existing element
    assert list(slt) == [1, 2, 2, 3, 3, 5]

# Forced deletion test
def test_remove():
    slt = SortedList()
    try:
        slt.remove(0)
        assert False  # Should raise a ValueError
    except ValueError:
        pass

    slt = SortedList([1, 2, 2, 3])
    slt.remove(2)  # Remove the first 2
    assert list(slt) == [1, 2, 3]

# Index deletion test
def test_delitem():
    slt = SortedList(range(100))
    del slt[50]  # Delete the element at index 50
    assert len(slt) == 99
    assert 50 not in slt

    # Slice deletion
    del slt[10:20]  # Delete elements at indices 10 - 19
    assert len(slt) == 89

# Pop operation test
def test_pop():
    slt = SortedList(range(100))
    val = slt.pop()  # Pop the last element
    assert val == 99
    assert len(slt) == 99

    val = slt.pop(0)  # Pop the first element
    assert val == 0
    assert len(slt) == 98
```

### Node 3: SortedList Search and Index Operations

**Function Description**: Implement search, indexing, binary search, and other operations of an ordered list to provide efficient O(log n) search performance.

**Core Algorithms**:

- Binary search algorithm
- Index tree traversal
- Range query optimization
- Handle duplicate elements

**Input-Output Examples**:

```python
from sortedcontainers import SortedList

# Binary search test
def test_bisect():
    slt = SortedList([1, 2, 2, 2, 3, 3, 5])

    # Left boundary search
    pos = slt.bisect_left(2)
    assert pos == 1  # Position of the first 2

    # Right boundary search
    pos = slt.bisect_right(2)
    assert pos == 4  # Position after the last 2

    # Non-existent element
    pos = slt.bisect_left(4)
    assert pos == 6  # Position to insert

# Index search test
def test_index():
    slt = SortedList([1, 2, 2, 2, 3, 3, 5])

    # Find the first occurrence position of an element
    pos = slt.index(2)
    assert pos == 1

    # Search with a range
    pos = slt.index(2, 2, 5)  # Search between indices 2 - 5
    assert pos == 2

    # Search for a non-existent element
    try:
        pos = slt.index(4)
        assert False
    except ValueError:
        pass

# Counting test
def test_count():
    slt = SortedList([1, 2, 2, 2, 3, 3, 5])

    count = slt.count(2)
    assert count == 3

    count = slt.count(4)
    assert count == 0

# Range iteration test
def test_irange():
    slt = SortedList(range(100))

    # Basic range query
    values = list(slt.irange(10, 20))
    assert values == list(range(10, 21))

    # Exclude boundaries
    values = list(slt.irange(10, 20, inclusive=(False, False)))
    assert values == list(range(11, 20))

    # Reverse iteration
    values = list(slt.irange(20, 10, reverse=True))
    assert values == list(range(20, 9, -1))
```

### Node 4: SortedKeyList Key Function Operations

**Function Description**: Implement an ordered list based on a key function, support custom sorting rules, and provide key function-related lookup and range operations.

**Core Algorithms**:

- Apply the key function
- Store keys and values separately
- Binary search based on the key function
- Key range query

**Input-Output Examples**:

```python
from sortedcontainers import SortedKeyList
from operator import neg, abs

# Key function initialization test
def test_key_init():
    slt = SortedKeyList(key=abs)
    assert slt.key == abs
    slt._check()

    slt = SortedKeyList(range(10000), key=abs)
    # Sort by absolute value
    assert all(slt[i] == i for i in range(10000))

# Key function addition test
def test_key_add():
    slt = SortedKeyList(key=neg)  # Sort by negative value
    slt.add(1)
    slt.add(2)
    slt.add(3)
    assert list(slt) == [3, 2, 1]  # Sort by negative value, larger values in front

# Key function binary search test
def test_key_bisect():
    slt = SortedKeyList([1, 2, 3, 4, 5], key=neg)

    # Binary search based on the key
    pos = slt.bisect_key_left(-3)  # Find the position of the key value -3
    assert pos == 2  # Corresponding value is 3

    pos = slt.bisect_key_right(-3)
    assert pos == 3

# Key function range query test
def test_key_irange():
    slt = SortedKeyList([1, 2, 3, 4, 5], key=neg)

    # Range query based on the key
    values = list(slt.irange_key(-4, -2))  # Key values between -4 and -2
    assert values == [4, 3, 2]  # Corresponding key values -4, -3, -2

# Modulo key function test
def test_modulo_key():
    def modulo(val):
        return val % 10

    slt = SortedKeyList(range(100), key=modulo)

    # Sort by modulo 10
    for i in range(10):
        # Check elements in each remainder group
        group = [x for x in range(100) if x % 10 == i]
        assert all(x in slt for x in group)
```

### Node 5: SortedDict Dictionary Operations

**Function Description**: Implement the core operations of an ordered dictionary, inherit the functionality of dict while maintaining the order of keys, and provide ordered key-value pair access.

**Core Algorithms**:

- Use an internal SortedList to maintain key order
- Combine dictionary operations with ordered operations
- Implement view objects
- Manage key-value pairs

**Input-Output Examples**:

```python
from sortedcontainers import SortedDict

# Initialization test
def test_dict_init():
    temp = SortedDict()
    assert temp.key is None

    temp = SortedDict([('a', 1), ('b', 2)])
    assert len(temp) == 2
    assert temp['a'] == 1
    assert temp['b'] == 2

    temp = SortedDict(a=1, b=2)
    assert len(temp) == 2
    assert temp['a'] == 1

# Basic dictionary operation test
def test_dict_operations():
    temp = SortedDict()

    # Set and get
    temp['c'] = 3
    assert temp['c'] == 3

    # Delete
    del temp['c']
    assert 'c' not in temp

    # Containment check
    temp['a'] = 1
    assert 'a' in temp
    assert 'b' not in temp

# Ordered operation test
def test_ordered_operations():
    temp = SortedDict([('c', 3), ('a', 1), ('b', 2)])

    # Pop operation
    key, value = temp.popitem()  # Pop the last one
    assert key == 'c'
    assert value == 3

    # Peek operation
    key, value = temp.peekitem(0)  # Peek at the first one
    assert key == 'a'
    assert value == 1

    # Ordered iteration
    keys = list(temp.keys())
    assert keys == ['a', 'b']

# View object test
def test_views():
    temp = SortedDict([('a', 1), ('b', 2), ('c', 3)])

    # Key view
    keys_view = temp.keys()
    assert len(keys_view) == 3
    assert 'a' in keys_view
    assert list(keys_view) == ['a', 'b', 'c']

    # Index access
    assert keys_view[0] == 'a'
    assert keys_view[-1] == 'c'

    # Slice access
    assert list(keys_view[1:]) == ['b', 'c']

    # Set operations
    other_keys = {'a', 'd'}
    assert list(keys_view & other_keys) == ['a']
    assert list(keys_view | other_keys) == ['a', 'b', 'c', 'd']

# Value view test
def test_valuesview():
    temp = SortedDict([('c', 3), ('a', 1), ('b', 2)])
    values = temp.values()

    # Basic operations
    assert len(values) == 3
    assert 1 in values
    assert list(values) == [1, 2, 3]

    # Index access
    assert values[0] == 1
    assert values[-1] == 3

    # Slice access
    assert list(values[1:]) == [2, 3]

# Item view test
def test_itemsview():
    temp = SortedDict([('c', 3), ('a', 1), ('b', 2)])
    items = temp.items()

    # Basic operations
    assert len(items) == 3
    assert ('a', 1) in items
    assert list(items) == [('a', 1), ('b', 2), ('c', 3)]

    # Index access
    assert items[0] == ('a', 1)
    assert items[-1] == ('c', 3)

    # Set operations
    other_items = {('a', 1), ('d', 4)}
    assert list(items & other_items) == [('a', 1)]
```

### Node 6: SortedSet Set Operations

**Function Description**: Implement the core operations of an ordered set, provide both set operations and sequence access functionality, and maintain the order of elements.

**Core Algorithms**:

- Combine an internal set and a SortedList
- Implement set operations
- Implement the sequence interface
- Maintain order

**Input-Output Examples**:

```python
from sortedcontainers import SortedSet

# Initialization test
def test_set_init():
    temp = SortedSet(range(100))
    assert temp.key is None
    temp._reset(7)
    temp._check()
    assert all(val == temp[val] for val in temp)

# Basic set operation test
def test_set_operations():
    temp = SortedSet(range(100))

    # Add an element
    temp.add(100)
    assert 100 in temp

    # Delete an element
    temp.discard(50)  # Safe deletion
    assert 50 not in temp

    temp.remove(60)  # Forced deletion
    assert 60 not in temp

    # Pop an element
    val = temp.pop()  # Pop the last one
    assert val == 100

# Set operation test
def test_set_operations():
    alpha = SortedSet(range(50))
    beta = SortedSet(range(25, 75))

    # Union
    union_result = alpha.union(beta)
    assert len(union_result) == 75
    assert all(i in union_result for i in range(75))

    # Intersection
    intersection_result = alpha.intersection(beta)
    assert len(intersection_result) == 25
    assert all(i in intersection_result for i in range(25, 50))

    # Difference
    difference_result = alpha.difference(beta)
    assert len(difference_result) == 25
    assert all(i in difference_result for i in range(25))

    # Symmetric difference
    sym_diff_result = alpha.symmetric_difference(beta)
    assert len(sym_diff_result) == 50
    assert all(i in sym_diff_result for i in list(range(25)) + list(range(50, 75)))

# Sequence operation test
def test_sequence_operations():
    temp = SortedSet(range(100))

    # Index access
    assert temp[0] == 0
    assert temp[50] == 50

    # Slice access
    slice_result = temp[20:30]
    assert list(slice_result) == list(range(20, 30))

    # Delete operation
    del temp[50]
    assert 50 not in temp

    # Iteration
    assert all(i == val for i, val in enumerate(temp))

    # Reverse iteration
    reversed_list = list(reversed(temp))
    assert reversed_list == list(range(99, -1, -1))

# Set relationship test
def test_set_relations():
    alpha = SortedSet(range(50))
    beta = SortedSet(range(25, 75))
    gamma = SortedSet(range(25, 50))

    # Subset check
    assert not alpha.issubset(beta)
    assert gamma.issubset(alpha)

    # Superset check
    assert alpha.issuperset(gamma)
    assert not beta.issuperset(alpha)

    # Disjoint check
    assert alpha.isdisjoint(SortedSet(range(100, 150)))
    assert not alpha.isdisjoint(beta)
```

### Node 7: Performance Optimization and Load Factor Management

**Function Description**: Implement performance optimization mechanisms, including load factor adjustment, memory management, index reconstruction, etc., to ensure efficient performance under various data scales.

**Core Algorithms**:

- Dynamically adjust the load factor
- Optimize memory usage
- Rebuild the index tree
- Monitor performance

**Input-Output Examples**:

```python
from sortedcontainers import SortedList

# Load factor test
def test_load_factor():
    slt = SortedList()

    # Set the load factor
    slt._reset(10000)
    assert slt._load == 10000

    # Large data test
    slt.update(range(100000))
    slt._check()  # Internal consistency check

    # Performance test
    import time
    start = time.time()
    for i in range(10000):
        slt.add(i)
    end = time.time()
    assert (end - start) < 1.0  # Should complete within 1 second

# Memory management test
def test_memory_management():
    slt = SortedList(range(10000))

    # Rebuild after a large number of deletions
    for i in range(5000):
        slt.pop()

    # Trigger reconstruction
    slt._reset(1000)
    slt._check()

    # Verify performance
    import time
    start = time.time()
    for i in range(1000):
        slt.add(i)
    end = time.time()
    assert (end - start) < 0.1

# Boundary condition test
def test_edge_cases():
    # Empty list operation
    slt = SortedList()
    assert len(slt) == 0
    assert 0 not in slt

    try:
        slt.pop()
        assert False
    except IndexError:
        pass

    # Single-element list
    slt.add(1)
    assert len(slt) == 1
    assert 1 in slt
    assert slt[0] == 1

    # Duplicate elements
    slt.add(1)
    assert len(slt) == 2
    assert slt.count(1) == 2

# Stress test
def test_stress():
    import random
    random.seed(0)

    slt = SortedList()
    actions = []

    # Random operation sequence
    for _ in range(1000):
        if random.random() < 0.3:
            actions.append(('add', random.random()))
        elif random.random() < 0.3:
            actions.append(('remove', random.random()))
        else:
            actions.append(('contains', random.random()))

    # Perform operations
    for action, value in actions:
        if action == 'add':
            slt.add(value)
        elif action == 'remove':
            slt.discard(value)
        elif action == 'contains':
            _ = value in slt

    slt._check()  # Final consistency check
```

### Node 8: Error Handling and Exception Management

**Function Description**: Implement a comprehensive error handling mechanism, including parameter validation, exception throwing, boundary checks, etc., to ensure the robustness of the program.

**Core Algorithms**:

- Check parameter types
- Validate boundary conditions
- Standardize exception information
- Implement an error recovery mechanism

**Input-Output Examples**:

```python
from sortedcontainers import SortedList, SortedDict, SortedSet

# Index error test
def test_index_errors():
    slt = SortedList(range(100))

    # Index out of bounds
    try:
        _ = slt[100]
        assert False
    except IndexError:
        pass

    try:
        _ = slt[-101]
        assert False
    except IndexError:
        pass

    # Delete out-of-bounds index
    try:
        del slt[100]
        assert False
    except IndexError:
        pass

# Value error test
def test_value_errors():
    slt = SortedList([1, 2, 3])

    # Delete a non-existent value
    try:
        slt.remove(4)
        assert False
    except ValueError:
        pass

    # Find a non-existent value
    try:
        pos = slt.index(4)
        assert False
    except ValueError:
        pass

# Type error test
def test_type_errors():
    # Non-comparable elements
    try:
        slt = SortedList([1, 2, "string", 3])
        assert False
    except TypeError:
        pass

    # Key function error
    def bad_key(x):
        return x / 0

    try:
        slt = SortedKeyList([1, 2, 3], key=bad_key)
        slt.add(4)
        assert False
    except ZeroDivisionError:
        pass

# Dictionary key error test
def test_dict_key_errors():
    sd = SortedDict()

    # Access a non-existent key
    try:
        _ = sd['nonexistent']
        assert False
    except KeyError:
        pass

    # Delete a non-existent key
    try:
        del sd['nonexistent']
        assert False
    except KeyError:
        pass

# Set operation error test
def test_set_errors():
    ss = SortedSet([1, 2, 3])

    # Delete a non-existent element
    try:
        ss.remove(4)
        assert False
    except KeyError:
        pass
```

### Node 9: Sequence Operations and Slice Support

**Function Description**: Implement a complete sequence operation interface, including index access, slice operations, iterators, etc., to provide an API consistent with Python's built-in sequence types.

**Core Algorithms**:

- Maintain the index tree
- Optimize slice calculations
- Implement iterators
- Support reverse iteration

**Input-Output Examples**:

```python
from sortedcontainers import SortedList, SortedDict, SortedSet

# Index access test
def test_getitem():
    slt = SortedList(range(100))

    # Basic index access
    assert slt[0] == 0
    assert slt[50] == 50
    assert slt[-1] == 99
    assert slt[-50] == 50

    # Slice access
    assert list(slt[10:20]) == list(range(10, 20))
    assert list(slt[::2]) == list(range(0, 100, 2))
    assert list(slt[::-1]) == list(range(99, -1, -1))
    assert list(slt[20:10:-1]) == list(range(20, 10, -1))

# Slice deletion test
def test_delitem_slice():
    slt = SortedList(range(100))

    # Delete a slice
    del slt[10:20]
    assert len(slt) == 90
    assert 10 not in slt
    assert 19 not in slt

    # Delete with a step
    del slt[::2]
    assert len(slt) == 45
    assert all(i % 2 == 1 for i in slt)

# Iterator test
def test_iter():
    slt = SortedList(range(100))

    # Forward iteration
    assert all(i == val for i, val in enumerate(slt))

    # Reverse iteration
    reversed_list = list(reversed(slt))
    assert reversed_list == list(range(99, -1, -1))

# Slice iterator test
def test_islice():
    slt = SortedList(range(100))

    # Basic slice iteration
    values = list(slt.islice(10, 20))
    assert values == list(range(10, 20))

    # Slice iteration with a step
    values = list(slt.islice(0, 100, 2))
    assert values == list(range(0, 100, 2))

    # Reverse slice iteration
    values = list(slt.islice(20, 10, -1))
    assert values == list(range(20, 10, -1))
```

### Node 10: Comparison Operations and Sorting Support

**Function Description**: Implement a complete comparison operation interface, support equality comparison, size comparison, sorting, etc., to ensure compatibility with Python's built-in types.

**Core Algorithms**:

- Lexicographical comparison
- Element-wise comparison
- Sorting stability
- Comparison optimization

**Input-Output Examples**:

```python
from sortedcontainers import SortedList, SortedDict, SortedSet

# Equality comparison test
def test_eq():
    slt1 = SortedList([1, 2, 3, 4, 5])
    slt2 = SortedList([1, 2, 3, 4, 5])
    slt3 = SortedList([1, 2, 3, 4, 6])

    assert slt1 == slt2
    assert slt1 != slt3
    assert slt1 == [1, 2, 3, 4, 5]
    assert slt1 != [1, 2, 3, 4, 6]

# Size comparison test
def test_comparison():
    slt1 = SortedList([1, 2, 3])
    slt2 = SortedList([1, 2, 3, 4])
    slt3 = SortedList([1, 2, 4])

    assert slt1 < slt2
    assert slt1 <= slt2
    assert slt2 > slt1
    assert slt2 >= slt1
    assert slt1 < slt3
    assert slt3 > slt1

# Key function comparison test
def test_key_comparison():
    from operator import neg

    skl1 = SortedKeyList([1, 2, 3], key=neg)
    skl2 = SortedKeyList([1, 2, 3], key=neg)
    skl3 = SortedKeyList([1, 2, 4], key=neg)

    assert skl1 == skl2
    assert skl1 != skl3
    assert list(skl1) == [3, 2, 1]  # Sort by negative value
```

### Node 11: Arithmetic Operations and Sequence Arithmetic

**Function Description**: Implement sequence arithmetic operations, including addition, multiplication, etc., and support sequence merging, repetition, etc.

**Core Algorithms**:

- Merge sequences
- Repeat operations
- In-place operations
- Type checking

**Input-Output Examples**:

```python
from sortedcontainers import SortedList

# Addition operation test
def test_add():
    slt1 = SortedList([1, 2, 3])
    slt2 = SortedList([4, 5, 6])

    # Sequence addition
    result = slt1 + slt2
    assert list(result) == [1, 2, 3, 4, 5, 6]
    assert isinstance(result, SortedList)

    # Addition with a list
    result = slt1 + [4, 5, 6]
    assert list(result) == [1, 2, 3, 4, 5, 6]

# In-place addition test
def test_iadd():
    slt = SortedList([1, 2, 3])
    slt += [4, 5, 6]
    assert list(slt) == [1, 2, 3, 4, 5, 6]

# Multiplication operation test
def test_mul():
    slt = SortedList([1, 2, 3])

    # Sequence multiplication
    result = slt * 3
    assert list(result) == [1, 1, 1, 2, 2, 2, 3, 3, 3]
    assert isinstance(result, SortedList)

# In-place multiplication test
def test_imul():
    slt = SortedList([1, 2, 3])
    slt *= 2
    assert list(slt) == [1, 1, 2, 2, 3, 3]
```

### Node 12: View Objects and Dictionary Interface

**Function Description**: Implement sorted view objects for SortedDict, provide ordered key, value, and item access interfaces, and support index and slice operations.

**Core Algorithms**:

- Implement view objects
- Map indices
- Calculate slices
- Perform set operations

**Input-Output Examples**:

```python
from sortedcontainers import SortedDict

# Key view test
def test_keysview():
    sd = SortedDict([('c', 3), ('a', 1), ('b', 2)])
    keys = sd.keys()

    # Basic operations
    assert len(keys) == 3
    assert 'a' in keys
    assert list(keys) == ['a', 'b', 'c']

    # Index access
    assert keys[0] == 'a'
    assert keys[-1] == 'c'

    # Slice access
    assert list(keys[1:]) == ['b', 'c']

    # Set operations
    other_keys = {'a', 'd'}
    assert list(keys & other_keys) == ['a']
    assert list(keys | other_keys) == ['a', 'b', 'c', 'd']

# Value view test
def test_valuesview():
    sd = SortedDict([('c', 3), ('a', 1), ('b', 2)])
    values = sd.values()

    # Basic operations
    assert len(values) == 3
    assert 1 in values
    assert list(values) == [1, 2, 3]

    # Index access
    assert values[0] == 1
    assert values[-1] == 3

    # Slice access
    assert list(values[1:]) == [2, 3]

# Item view test
def test_itemsview():
    sd = SortedDict([('c', 3), ('a', 1), ('b', 2)])
    items = sd.items()

    # Basic operations
    assert len(items) == 3
    assert ('a', 1) in items
    assert list(items) == [('a', 1), ('b', 2), ('c', 3)]

    # Index access
    assert items[0] == ('a', 1)
    assert items[-1] == ('c', 3)

    # Set operations
    other_items = {('a', 1), ('d', 4)}
    assert list(items & other_items) == [('a', 1)]
```

### Node 13: Set Operations and Relational Operations

**Function Description**: Implement complete set operations, including union, intersection, difference, symmetric difference, etc., and determine set relationships.

**Core Algorithms**:

- Implement set operations
- Determine relationships
- Perform in-place operations
- Handle multiple sets

**Input-Output Examples**:

```python
from sortedcontainers import SortedSet

# Union operation test
def test_union():
    ss1 = SortedSet(range(50))
    ss2 = SortedSet(range(25, 75))

    # Union
    result = ss1.union(ss2)
    assert len(result) == 75
    assert all(i in result for i in range(75))

    # In-place union
    ss1.update(ss2)
    assert len(ss1) == 75
    assert all(i in ss1 for i in range(75))

    # Operator
    result = ss1 | ss2
    assert len(result) == 75

# Intersection operation test
def test_intersection():
    ss1 = SortedSet(range(50))
    ss2 = SortedSet(range(25, 75))

    # Intersection
    result = ss1.intersection(ss2)
    assert len(result) == 25
    assert all(i in result for i in range(25, 50))

    # In-place intersection
    ss1.intersection_update(ss2)
    assert len(ss1) == 25
    assert all(i in ss1 for i in range(25, 50))

    # Operator
    result = ss1 & ss2
    assert len(result) == 25

# Difference operation test
def test_difference():
    ss1 = SortedSet(range(50))
    ss2 = SortedSet(range(25, 75))

    # Difference
    result = ss1.difference(ss2)
    assert len(result) == 25
    assert all(i in result for i in range(25))

    # In-place difference
    ss1.difference_update(ss2)
    assert len(ss1) == 25
    assert all(i in ss1 for i in range(25))

    # Operator
    result = ss1 - ss2
    assert len(result) == 25

# Symmetric difference test
def test_symmetric_difference():
    ss1 = SortedSet(range(50))
    ss2 = SortedSet(range(25, 75))

    # Symmetric difference
    result = ss1.symmetric_difference(ss2)
    assert len(result) == 50
    assert all(i in result for i in list(range(25)) + list(range(50, 75)))

    # In-place symmetric difference
    ss1.symmetric_difference_update(ss2)
    assert len(ss1) == 50

# Set relationship test
def test_set_relations():
    ss1 = SortedSet(range(50))
    ss2 = SortedSet(range(25, 75))
    ss3 = SortedSet(range(25, 50))

    # Subset check
    assert ss3.issubset(ss1)
    assert not ss1.issubset(ss2)

    # Superset check
    assert ss1.issuperset(ss3)
    assert not ss2.issuperset(ss1)

    # Disjoint check
    assert ss1.isdisjoint(SortedSet(range(100, 150)))
    assert not ss1.isdisjoint(ss2)
```

### Node 14: Special Features and Advanced Operations

**Function Description**: Implement special features and advanced operations, including load factor adjustment, index reconstruction, serialization, copying, etc.

**Core Algorithms**:

- Manage the load factor
- Rebuild the index
- Support serialization
- Perform deep copying

**Input-Output Examples**:

```python
from sortedcontainers import SortedList, SortedDict, SortedSet
import pickle

# Load factor adjustment test
def test_load_factor():
    slt = SortedList(range(10000))

    # Adjust the load factor
    slt._reset(1000)
    assert slt._load == 1000
    slt._check()

    # Performance test
    import time
    start = time.time()
    for i in range(1000):
        slt.add(i)
    end = time.time()
    assert (end - start) < 1.0

# Index reconstruction test
def test_build_index():
    slt = SortedList(range(1000))

    # Rebuild the index
    slt._build_index()
    slt._check()

    # Verify index correctness
    for i in range(1000):
        assert slt[i] == i

# Serialization test
def test_pickle():
    # Serialize SortedList
    slt = SortedList(range(100))
    data = pickle.dumps(slt)
    slt2 = pickle.loads(data)
    assert slt == slt2

    # Serialize SortedDict
    sd = SortedDict([('a', 1), ('b', 2)])
    data = pickle.dumps(sd)
    sd2 = pickle.loads(data)
    assert sd == sd2

    # Serialize SortedSet
    ss = SortedSet(range(100))
    data = pickle.dumps(ss)
    ss2 = pickle.loads(data)
    assert ss == ss2

# Copy test
def test_copy():
    import copy

    # Shallow copy
    slt = SortedList(range(100))
    slt_copy = slt.copy()
    assert slt == slt_copy
    assert slt is not slt_copy

    # Deep copy
    slt_deep = copy.deepcopy(slt)
    assert slt == slt_deep
    assert slt is not slt_deep

# String representation test
def test_repr():
    slt = SortedList([1, 2, 3])
    assert repr(slt) == "SortedList([1, 2, 3])"

    sd = SortedDict([('a', 1), ('b', 2)])
    assert repr(sd) == "SortedDict({'a': 1, 'b': 2})"

    ss = SortedSet([1, 2, 3])
    assert repr(ss) == "SortedSet([1, 2, 3])"

# Recursive representation test
def test_repr_recursion():
    # Self-referential structure
    slt = SortedList()
    slt.add(slt)
    assert "SortedList([...])" in repr(slt)
```

### Node 15: Advanced Key Function Operations

**Function Description**: Implement advanced operations based on key functions, including binary search based on key functions, key range queries, key function indexing, etc.

**Core Algorithms**:

- Apply the key function
- Separate keys and values
- Search based on the key function
- Iterate over key ranges

**Input-Output Examples**:

```python
from sortedcontainers import SortedKeyList, SortedDict, SortedSet
from operator import neg, abs

# Key function binary search test
def test_bisect_key():
    # Modulo key function
    def modulo(val):
        return val % 10

    skl = SortedKeyList(range(100), key=modulo)

    # Binary search based on the key function
    pos = skl.bisect_key_left(5)  # Find the position of the key value 5
    assert pos >= 0

    pos = skl.bisect_key_right(5)
    assert pos >= 0

    # Negative key function
    skl2 = SortedKeyList([1, 2, 3, 4, 5], key=neg)
    pos = skl2.bisect_key_left(-3)  # Find the position of the key value -3
    assert pos == 2  # Corresponding value is 3

# Key function range query test
def test_irange_key():
    def modulo(val):
        return val % 10

    skl = SortedKeyList(range(100), key=modulo)

    # Key range query
    values = list(skl.irange_key(2, 5))  # Key values between 2 and 5
    assert all(modulo(val) >= 2 and modulo(val) <= 5 for val in values)

    # Exclude boundaries
    values = list(skl.irange_key(2, 5, inclusive=(False, False)))
    assert all(modulo(val) > 2 and modulo(val) < 5 for val in values)

# Key function index test
def test_index_key():
    def modulo(val):
        return val % 10

    skl = SortedKeyList(range(100), key=modulo)

    # Index search based on the key
    for i in range(10):
        # Find the first element with a key value of i
        pos = skl.bisect_key_left(i)
        if pos < len(skl):
            assert modulo(skl[pos]) == i

# Complex key function test
def test_complex_key():
    # Multi-level key function
    def complex_key(val):
        return (val % 10, val // 10)

    skl = SortedKeyList(range(100), key=complex_key)

    # Verify sorting correctness
    for i in range(len(skl) - 1):
        assert complex_key(skl[i]) <= complex_key(skl[i + 1])

# Key function consistency test
def test_key_consistency():
    def modulo(val):
        return val % 10

    skl = SortedKeyList(key=modulo)

    # Add elements
    for i in range(100):
        skl.add(i)

    # Verify key function consistency
    for i in range(len(skl) - 1):
        assert modulo(skl[i]) <= modulo(skl[i + 1])
```

### Node 16: Performance Optimization and Memory Management

**Function Description**: Implement performance optimization mechanisms, including memory management, index optimization, dynamic load factor adjustment, etc.

**Core Algorithms**:

- Optimize memory usage
- Balance the index tree
- Adjust the load factor
- Monitor performance

**Input-Output Examples**:

```python
from sortedcontainers import SortedList
import gc
import sys

# Memory usage test
def test_memory_usage():
    slt = SortedList()

    # Initial memory usage
    initial_size = sys.getsizeof(slt)

    # Add a large number of elements
    for i in range(10000):
        slt.add(i)

    # Check memory growth
    final_size = sys.getsizeof(slt)
    assert final_size > initial_size

    # Memory after clearing
    slt.clear()
    gc.collect()
    cleared_size = sys.getsizeof(slt)
    assert cleared_size < final_size

# Load factor optimization test
def test_load_factor_optimization():
    slt = SortedList()

    # Use a small load factor for small datasets
    slt._reset(100)
    for i in range(1000):
        slt.add(i)
    slt._check()

    # Use a large load factor for large datasets
    slt._reset(10000)
    for i in range(100000):
        slt.add(i)
    slt._check()

# Index reconstruction optimization test
def test_index_rebuild():
    slt = SortedList(range(10000))

    # Rebuild after a large number of deletions
    for i in range(5000):
        slt.pop()

    # Trigger index reconstruction
    slt._build_index()
    slt._check()

    # Verify performance
    import time
    start = time.time()
    for i in range(1000):
        _ = slt[i]
    end = time.time()
    assert (end - start) < 0.1



# Performance benchmark test
def test_performance_benchmark():
    import time

    slt = SortedList()

    # Monitor insertion performance
    start = time.time()
    for i in range(10000):
        slt.add(i)
    insert_time = time.time() - start
    assert insert_time < 1.0

    # Monitor lookup performance
    start = time.time()
    for i in range(1000):
        _ = i in slt
    search_time = time.time() - start
    assert search_time < 0.1

    # Monitor deletion performance
    start = time.time()
    for i in range(1000):
        slt.discard(i)
    delete_time = time.time() - start
    assert delete_time < 0.5
```

### Node 17: Edge Cases and Stress Testing

**Function Description**: Implement edge case handling and stress testing to ensure normal operation under various extreme conditions.

**Core Algorithms**:

- Edge case handling
- Stress testing
- Random operations
- Consistency check

**Input-Output Examples**:

```python
from sortedcontainers import SortedList, SortedDict, SortedSet
import random

# Empty container test
def test_empty_containers():
    # Empty SortedList
    slt = SortedList()
    assert len(slt) == 0
    assert 0 not in slt

    try:
        slt.pop()
        assert False
    except IndexError:
        pass

    # Empty SortedDict
    sd = SortedDict()
    assert len(sd) == 0
    assert 'key' not in sd

    try:
        sd.popitem()
        assert False
    except KeyError:
        pass

    # Empty SortedSet
    ss = SortedSet()
    assert len(ss) == 0
    assert 0 not in ss

# Single-element test
def test_single_element():
    # Single-element SortedList
    slt = SortedList([1])
    assert len(slt) == 1
    assert 1 in slt
    assert slt[0] == 1

    # Single-element SortedDict
    sd = SortedDict([('a', 1)])
    assert len(sd) == 1
    assert 'a' in sd
    assert sd['a'] == 1

    # Single-element SortedSet
    ss = SortedSet([1])
    assert len(ss) == 1
    assert 1 in ss

# Duplicate element test
def test_duplicate_elements():
    slt = SortedList([1, 1, 1, 2, 2, 3])
    assert len(slt) == 6
    assert slt.count(1) == 3
    assert slt.count(2) == 2
    assert slt.count(3) == 1

# Random operation stress test
def test_random_operations():
    random.seed(0)
    slt = SortedList()
    actions = []

    # Generate a random operation sequence
    for _ in range(1000):
        if random.random() < 0.3:
            actions.append(('add', random.random()))
        elif random.random() < 0.3:
            actions.append(('remove', random.random()))
        else:
            actions.append(('contains', random.random()))

    # Execute operations
    for action, value in actions:
        if action == 'add':
            slt.add(value)
        elif action == 'remove':
            slt.discard(value)
        elif action == 'contains':
            _ = value in slt

    slt._check()  # Final consistency check

# Large-scale data test
def test_large_scale():
    # Large-scale SortedList
    slt = SortedList(range(100000))
    assert len(slt) == 100000
    assert all(slt[i] == i for i in range(100000))

    # Large-scale SortedDict
    sd = SortedDict((i, i) for i in range(100000))
    assert len(sd) == 100000
    assert all(sd[i] == i for i in range(100000))

    # Large-scale SortedSet
    ss = SortedSet(range(100000))
    assert len(ss) == 100000
    assert all(i in ss for i in range(100000))

# Concurrency safety test (not thread-safe)
def test_concurrency_limitations():
    import threading
    import time

    slt = SortedList()
    errors = []

    def worker():
        try:
            for i in range(1000):
                slt.add(i)
                time.sleep(0.001)
        except Exception as e:
            errors.append(e)

    # Multi-threaded operations (expected to possibly fail)
    threads = [threading.Thread(target=worker) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # Verify the final state
    slt._check()


```

### Node 18: Dictionary Special Methods and Factory Functions

**Function Description**: Implement special methods and factory functions of SortedDict, including fromkeys, get, setdefault, etc., and ensure compatibility with ordinary dictionaries.

**Core Algorithms**:

- Factory function implementation
- Default value handling
- Key-value pair management
- Compatibility guarantee

**Input-Output Examples**:

```python
from sortedcontainers import SortedDict

# fromkeys factory function test
def test_fromkeys():
    # Basic fromkeys
    keys = ['a', 'b', 'c', 'd']
    sd = SortedDict.fromkeys(keys, 1)
    assert list(sd.keys()) == keys
    assert all(sd[key] == 1 for key in keys)

    # Default value None
    sd = SortedDict.fromkeys(keys)
    assert all(sd[key] is None for key in keys)

    # Empty key sequence
    sd = SortedDict.fromkeys([])
    assert len(sd) == 0

# get method test
def test_get():
    sd = SortedDict([('a', 1), ('b', 2), ('c', 3)])

    # Existing key
    assert sd.get('a') == 1
    assert sd.get('b') == 2

    # Non-existent key, default value
    assert sd.get('d') is None
    assert sd.get('d', -1) == -1

    # Non-existent key, custom default value
    assert sd.get('d', 'default') == 'default'

# setdefault method test
def test_setdefault():
    sd = SortedDict([('a', 1), ('b', 2)])

    # Existing key
    assert sd.setdefault('a', 10) == 1
    assert sd['a'] == 1  # Value remains unchanged

    # Non-existent key, set default value
    assert sd.setdefault('c', 3) == 3
    assert sd['c'] == 3

    # Non-existent key, default None
    assert sd.setdefault('d') is None
    assert sd['d'] is None

# popitem method test
def test_popitem():
    sd = SortedDict([('a', 1), ('b', 2), ('c', 3)])

    # Pop the last item by default
    key, value = sd.popitem()
    assert key == 'c'
    assert value == 3
    assert len(sd) == 2

    # Pop by specified index
    key, value = sd.popitem(index=0)
    assert key == 'a'
    assert value == 1
    assert len(sd) == 1

    # Empty dictionary
    empty_sd = SortedDict()
    try:
        empty_sd.popitem()
        assert False
    except KeyError:
        pass

# peekitem method test
def test_peekitem():
    sd = SortedDict([('a', 1), ('b', 2), ('c', 3)])

    # View the last item by default
    key, value = sd.peekitem()
    assert key == 'c'
    assert value == 3
    assert len(sd) == 3  # Do not delete

    # View by specified index
    key, value = sd.peekitem(0)
    assert key == 'a'
    assert value == 1

    # Index out of bounds
    try:
        sd.peekitem(100)
        assert False
    except IndexError:
        pass
```

### Node 19: Type System and Inheritance Mechanisms

**Function Description**: Implement the type system, inheritance mechanism, and type checking, including type conversion and inheritance restrictions of SortedKeyList.

**Core Algorithms**:

- Type checking mechanism
- Inheritance restrictions
- Type conversion
- Instantiation control

**Input-Output Examples**:

```python
from sortedcontainers import SortedList, SortedKeyList
import pytest

# Type conversion test
def test_type_conversion():
    # SortedList with key -> SortedKeyList
    slt = SortedList(range(100), key=lambda x: x % 10)
    assert isinstance(slt, SortedKeyList)
    assert type(slt) == SortedKeyList

    # Create SortedKeyList directly
    skl = SortedKeyList(range(100), key=lambda x: x % 10)
    assert isinstance(skl, SortedList)
    assert isinstance(skl, SortedKeyList)
    assert type(skl) == SortedKeyList

# Inheritance restriction test
def test_inheritance_restrictions():
    # Custom SortedList subclass cannot use the key parameter
    class CustomSortedList(SortedList):
        pass

    try:
        CustomSortedList(key=lambda x: x % 10)
        assert False
    except TypeError:
        pass

    # Normal SortedList can use the key
    slt = SortedList(key=lambda x: x % 10)
    assert isinstance(slt, SortedKeyList)

# Type consistency test
def test_type_consistency():
    def modulo(val):
        return val % 10

    # Consistency of creation methods
    slt1 = SortedList(range(100), key=modulo)
    slt2 = SortedKeyList(range(100), key=modulo)

    assert type(slt1) == type(slt2)
    assert isinstance(slt1, SortedKeyList)
    assert isinstance(slt2, SortedKeyList)

    # Consistency of operations
    assert slt1 == slt2
    assert list(slt1) == list(slt2)

# Test for incomparable objects
def test_incomparable_objects():
    class Incomparable:
        pass

    a = Incomparable()
    b = Incomparable()

    # Use a key function to handle incomparable objects
    skl = SortedKeyList(key=lambda x: 1)  # All objects have the same key value
    skl.add(a)
    skl.add(b)
    assert len(skl) == 2
    assert a in skl
    assert b in skl

# Type checking test
def test_type_checking():
    # Check the type of the key function
    skl = SortedKeyList(key="not a function")
    try:
        skl.add(1)  # triggers calling the non-callable key
        assert False
    except TypeError:
        pass

    # Check the return value of the key function
    def bad_key(x):
        # Mix incomparable key types to trigger a TypeError during ordering
        return x if (x % 2 == 0) else 'a'

    try:
        skl = SortedKeyList(key=bad_key)
        skl.add(1)
        skl.add(2)
        assert False
    except TypeError:
        pass
```

### Node 20: Operator Overloading and Set Operations

**Function Description**: Implement complete operator overloading, including set operation operators, in-place operators, reverse operators, etc.

**Core Algorithms**:

- Operator overloading
- Set operation implementation
- In-place operations
- Reverse operations

**Input-Output Examples**:

```python
from sortedcontainers import SortedSet, SortedDict

# Set operator test
def test_set_operators():
    ss1 = SortedSet(range(50))
    ss2 = SortedSet(range(25, 75))

    # Union operator
    result = ss1 | ss2
    assert len(result) == 75
    assert all(i in result for i in range(75))

    # Intersection operator
    result = ss1 & ss2
    assert len(result) == 25
    assert all(i in result for i in range(25, 50))

    # Difference operator
    result = ss1 - ss2
    assert len(result) == 25
    assert all(i in result for i in range(25))

    # Symmetric difference operator
    result = ss1 ^ ss2
    assert len(result) == 50
    assert all(i in result for i in list(range(25)) + list(range(50, 75)))

# In-place operator test
def test_inplace_operators():
    ss1 = SortedSet(range(50))
    ss2 = SortedSet(range(25, 75))

    # In-place union
    ss1 |= ss2
    assert len(ss1) == 75
    assert all(i in ss1 for i in range(75))

    # Reset
    ss1 = SortedSet(range(50))

    # In-place intersection
    ss1 &= ss2
    assert len(ss1) == 25
    assert all(i in ss1 for i in range(25, 50))

    # Reset
    ss1 = SortedSet(range(50))

    # In-place difference
    ss1 -= ss2
    assert len(ss1) == 25
    assert all(i in ss1 for i in range(25))

    # Reset
    ss1 = SortedSet(range(50))

    # In-place symmetric difference
    ss1 ^= ss2
    assert len(ss1) == 50

# Reverse operator test
def test_reverse_operators():
    ss = SortedSet(range(50))
    regular_set = set(range(25, 75))

    # Reverse union
    result = regular_set | ss
    assert len(result) == 75
    assert all(i in result for i in range(75))

    # Reverse intersection
    result = regular_set & ss
    assert len(result) == 25
    assert all(i in result for i in range(25, 50))

    # Reverse difference
    result = regular_set - ss
    assert len(result) == 25
    assert all(i in result for i in range(50, 75))

    # Reverse symmetric difference
    result = regular_set ^ ss
    assert len(result) == 50

# Dictionary operator test
def test_dict_operators():
    sd1 = SortedDict([('a', 1), ('b', 2)])
    sd2 = SortedDict([('b', 3), ('c', 4)])

    # Dictionary merge operator
    result = sd1 | sd2
    assert len(result) == 3
    assert result['a'] == 1
    assert result['b'] == 3  # The latter overrides the former
    assert result['c'] == 4

    # In-place merge
    sd1 |= sd2
    assert len(sd1) == 3
    assert sd1['b'] == 3

# Operator error handling test
def test_operator_errors():
    ss = SortedSet(range(10))

    # Unsupported operation
    try:
        result = ss + [1, 2, 3]
        assert False
    except TypeError:
        pass

    try:
        result = ss * 2
        assert False
    except TypeError:
        pass

    # Unsupported operator
    try:
        result = ss < [1, 2, 3]
        assert False
    except TypeError:
        pass
```

### Node 21: Internal Consistency Checks and Debug Support

**Function Description**: Implement an internal consistency check mechanism and debug support, including the `_check` method, index reconstruction, reference counting, etc.

**Core Algorithms**:

- Consistency check
- Index verification
- Reference counting
- Debug information

**Input and Output Examples**:

```python
from sortedcontainers import SortedList, SortedDict, SortedSet
import gc

# Internal consistency check test
def test_internal_consistency():
    slt = SortedList(range(1000))

    # Basic consistency check
    slt._check()

    # Check after adding an element
    slt.add(500)
    slt._check()

    # Check after deleting an element
    slt.remove(500)
    slt._check()

    # Check after batch operations
    slt.update(range(1000, 2000))
    slt._check()

# Index reconstruction test
def test_index_rebuild():
    slt = SortedList(range(1000))

    # Manually rebuild the index
    slt._build_index()
    slt._check()

    # Verify the correctness of the index
    for i in range(1000):
        assert slt[i] == i

    # Rebuild after a large number of deletions
    for i in range(500):
        slt.pop()

    slt._build_index()
    slt._check()

    # Verify the remaining elements
    for i, val in enumerate(slt):
        assert val == i + 500

# Reference counting test
def test_reference_counts():
    import sys

    # Create an object
    slt = SortedList(range(100))
    initial_refcount = sys.getrefcount(slt)

    # Copy the object
    slt_copy = slt.copy()
    assert sys.getrefcount(slt) == initial_refcount

    # Delete the copy
    del slt_copy
    gc.collect()
    assert sys.getrefcount(slt) == initial_refcount

# Debug information test
def test_debug_information():
    slt = SortedList(range(100))

    # Check the internal state
    assert hasattr(slt, '_lists')
    assert hasattr(slt, '_maxes')
    assert hasattr(slt, '_index')
    assert hasattr(slt, '_len')
    assert hasattr(slt, '_load')

    # Check the load factor
    assert slt._load > 0

    # Check the list structure
    assert len(slt._lists) > 0
    assert len(slt._maxes) == len(slt._lists)

    # Check the index structure (ensure it's built before asserting)
    slt._build_index()
    assert len(slt._index) > 0

# Error recovery test
def test_error_recovery():
    slt = SortedList(range(100))

    # Simulate internal state corruption
    original_lists = slt._lists
    slt._lists = []  # Damage the internal state

    try:
        slt._check()
        assert False
    except AssertionError:
        pass

    # Restore the state
    slt._lists = original_lists
    slt._check()  # Should pass

# Performance monitoring test
def test_performance_monitoring():
    import time

    slt = SortedList()

    # Monitor insertion performance
    start_time = time.time()
    for i in range(10000):
        slt.add(i)
    insert_time = time.time() - start_time

    # Monitor search performance
    start_time = time.time()
    for i in range(1000):
        _ = i in slt
    search_time = time.time() - start_time

    # Monitor deletion performance
    start_time = time.time()
    for i in range(1000):
        slt.discard(i)
    delete_time = time.time() - start_time

    # Verify that the performance is within a reasonable range
    assert insert_time < 1.0
    assert search_time < 0.1
```
