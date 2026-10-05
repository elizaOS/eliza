# Introduction and Goals of the DeepDiff Project

DeepDiff is a Python library **designed for in-depth object comparison and difference analysis**. It can perform a thorough comparison of any Python objects/data structures and detect differences. This tool excels in comparing complex data structures, achieving "the most comprehensive difference detection and the most flexible configuration options." Its core functions include: in-depth object comparison (automatically recursively comparing nested structures), **creation and application of difference objects** (supporting Delta objects to implement Git-like commit functionality), and intelligent comparison of complex data structures such as sets, dictionaries, lists, and custom objects. In short, DeepDiff aims to provide a powerful in-depth comparison system for detecting and analyzing differences between Python objects (for example, creating a difference object through DeepDiff() and applying the difference to the target object through the Delta() function).

## Natural Language Instruction (Prompt)

Please create a Python project named DeepDiff to implement an in-depth object comparison library. The project should include the following functions:

1. **In-depth Comparison Engine**: Implement the DeepDiff class, which can recursively compare all levels of two Python objects, supporting complex data structures such as dictionaries, lists, sets, tuples, and custom objects. The comparison results should contain detailed difference information, including type changes, value changes, item additions/deletions, etc. Support advanced configuration options such as ignoring order, ignoring type changes, and path filtering.

2. **Difference Object System**: Implement the Delta class, which can capture and apply differences, similar to Git's commit system. It should support applying differences to the original object to generate a new object state, as well as bidirectional difference application. Support serialization, verification mechanisms, error handling, etc.

3. **In-depth Search Function**: Implement the DeepSearch class, which can search for specific values in complex data structures, supporting path matching, type filtering, regular expressions, etc.

4. **In-depth Hashing Function**: Implement the DeepHash class to generate hash values for complex objects, supporting hash caching, custom hashers, etc.

5. **Command Line Interface**: Design independent command line interfaces for each functional module, supporting commands such as diff, patch, grep, and extract, and supporting multiple file formats.

6. **Serialization Support**: Implement a serialization module, supporting serialization and deserialization in formats such as JSON and Pickle, and supporting a secure deserialization mechanism.

7. **Special Structure Handling**: Provide specialized handling for NumPy arrays, Pandas DataFrames, Polars DataFrames, custom objects, etc.

8. **Utility Function Collection**: Implement utility functions for path handling, type detection, numerical processing, time handling, cache management, etc.

9. **Test Verification Script**: Create a comprehensive_test.py file, which should include the following test functions:
   - Test the basic comparison functions of DeepDiff (for dictionaries, lists, sets, etc.)
   - Test the difference application function of Delta (forward and reverse application)
   - Test the search function of DeepSearch (various search modes)
   - Test the hashing function of DeepHash (for various data types)
   - Test the command line interface (diff, patch, grep, extract commands)
   - Test the serialization function (JSON, Pickle, etc.)
   - Test special data structures (NumPy, Pandas, etc.)
   - Test error handling and boundary cases
   - Test performance optimization functions (caching, limits, etc.)
   - Test configuration options (various ignore options, path filtering, etc.)

10. **Core File Requirements**: The project must include a complete pyproject.toml file, which needs to configure the project as an installable package (supporting pip install and editable mode installation) and declare a complete list of dependencies, including deepdiff==8.5.0 (core library), numpy==1.26.4 (support for array comparison), pandas==2.2.3 (data structure comparison), pytest==8.4.0 (testing framework), click (command line tool), orjson (efficient JSON processing), tomli-w (TOML writing), pyyaml (YAML serialization), jsonpickle (object serialization), polars (data frame comparison), and other core libraries. At the same time, it is necessary to provide deepdiff/__init__.py as a unified API entry. This file needs to integrate key components from each core module: import DeepDiff (core difference calculation class) from the diff module; import Delta (difference increment class) from the delta module; import DeepHash (object hash generation class) and sha256hex (hashing algorithm) from the deephash module; import DeepSearch (in-depth search class) and grep (pattern matching function) from the search module; import tool functions such as diff, patch (difference application), and extract (data extraction) from the commands module; import parse_path, stringify_path (path parsing and conversion), GET/GETATTR (path operation constants) from the path module; import structural classes such as DiffLevel (difference level model) and DictRelationship (dictionary relationship handling) from the model module; import auxiliary types such as AnySet (unordered set comparison) and SetOrdered (ordered set handling) from the helper module; import json_dumps, pickle_load (cross-format serialization) from the serialization module; in addition, it is also necessary to export extended functions such as summarize (difference summary), LFUCache (caching mechanism), and BaseOperator (base class for custom operators), and provide version information through __version__. Ensure that users can access all major functions through concise statements such as from deepdiff import DeepDiff, Delta, DeepHash, grep, parse_path. In grader.py, the deepdiff_expr_eq() function needs to use multiple strategies to verify the in-depth difference equivalence of two objects: handle set order differences through the ignore_order parameter of DeepDiff, use the cutoff_distance to control the tolerance range for numerical types (such as numpy arrays and floating-point numbers), and ignore irrelevant fields through exclude_paths; combine Delta to verify the reversibility of differences (whether the original object is restored after applying the patch); use the datetime_normalize function in the helper module to handle time format differences, and use diff_numpy_array to specifically verify array elements; support custom BaseOperator to handle special types (such as Pydantic models and enums), and finally return a boolean value and difference details to ensure the accuracy and flexibility of complex object comparison.
## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.11

### Core Dependency Library Versions

```Plain
annotated-types   0.7.0
argcomplete       3.6.2
asttokens         3.0.0
attrs             25.3.0
bump2version      1.0.1
click             8.1.8
colorlog          6.9.0
coverage          7.10.3
decorator         5.2.1
dependency-groups 1.3.1
distlib           0.4.0
exceptiongroup    1.3.0
executing         2.2.0
filelock          3.18.0
iniconfig         2.1.0
ipdb              0.13.13
ipython           8.37.0
jedi              0.19.2
jsonpickle        4.0.5
matplotlib-inline 0.1.7
nox               2025.5.1
numpy             2.2.6
orderly-set       5.5.0
orjson            3.10.18
packaging         25.0
pandas            2.2.3
parso             0.8.4
pexpect           4.9.0
pip               23.0.1
platformdirs      4.3.8
pluggy            1.6.0
polars            1.21.0
prompt_toolkit    3.0.51
ptyprocess        0.7.0
pure_eval         0.2.3
py-cpuinfo        9.0.0
pydantic          2.11.7
pydantic_core     2.33.2
Pygments          2.19.2
python-dateutil   2.9.0.post0
python-dotenv     1.0.1
pytz              2025.2
PyYAML            6.0.2
setuptools        65.5.1
six               1.17.0
stack-data        0.6.3
tomli             2.2.1
tomli_w           1.2.0
traitlets         5.14.3
typing_extensions 4.14.1
typing-inspection 0.4.1
tzdata            2025.2
virtualenv        20.33.1
wcwidth           0.2.13
wheel             0.40.0
```

## DeepDiff Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .bumpversion.cfg
├── .coveragerc
├── .direnvrc.example
├── .envrc.example
├── .gitignore
├── AUTHORS.md
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── LICENSE
├── MANIFEST.in
├── README.md
├── conftest.py
├── deepdiff
│   ├── __init__.py
│   ├── anyset.py
│   ├── base.py
│   ├── colored_view.py
│   ├── commands.py
│   ├── deephash.py
│   ├── delta.py
│   ├── diff.py
│   ├── distance.py
│   ├── helper.py
│   ├── lfucache.py
│   ├── model.py
│   ├── operator.py
│   ├── path.py
│   ├── py.typed
│   ├── search.py
│   ├── serialization.py
│   └── summarize.py
├── docs
│   ├── Makefile
│   ├── _static
│   │   ├── benchmark_array_no_numpy__3.8__ignore_order=True__cache_size=0__cache_tuning_sample_size=0__cutoff_intersection_for_pairs=1.png
│   │   ├── benchmark_array_no_numpy__3.8__ignore_order=True__cache_size=10000__cache_tuning_sample_size=0__cutoff_intersection_for_pairs=1.png
│   │   ├── benchmark_big_jsons__3.8__ignore_order=True__cache_size=0__cache_tuning_sample_size=0__max_diffs=300000__max_passes=40000__cutoff_intersection_for_pairs=1.png
│   │   ├── benchmark_big_jsons__pypy3.6__ignore_order=True__cache_size=0__cache_tuning_sample_size=0__max_diffs=300000__max_passes=40000__cutoff_intersection_for_pairs=1.png
│   │   ├── benchmark_deeply_nested_a__3.8__ignore_order=True__cache_size=0__cache_tuning_sample_size=0__cutoff_intersection_for_pairs=1.png
│   │   ├── benchmark_deeply_nested_a__3.8__ignore_order=True__cache_size=5000__cache_tuning_sample_size=0__cutoff_intersection_for_pairs=1.png
│   │   ├── benchmark_deeply_nested_a__3.8__ignore_order=True__cache_size=500__cache_tuning_sample_size=0__cutoff_intersection_for_pairs=1.png
│   │   ├── benchmark_deeply_nested_a__3.8__ignore_order=True__cache_size=500__cache_tuning_sample_size=500__cutoff_intersection_for_pairs=1.png
│   │   ├── benchmark_numpy_array__3.8__ignore_order=True__cache_size=0__cache_tuning_sample_size=0__cutoff_intersection_for_pairs=1.png
│   │   ├── custom.css
│   │   ├── favicon.ico
│   │   ├── logo.svg
│   │   └── logo_long_B1_black.svg
│   ├── _templates
│   │   ├── about.html
│   │   ├── basic
│   │   │   └── layout.html
│   │   └── navigation.html
│   ├── authors.rst
│   ├── basics.rst
│   ├── buildme.py
│   ├── changelog.rst
│   ├── colored_view.rst
│   ├── commandline.rst
│   ├── conf.py
│   ├── custom.rst
│   ├── deep_distance.rst
│   ├── deephash.rst
│   ├── deephash_doc.rst
│   ├── delta.rst
│   ├── diff.rst
│   ├── diff_doc.rst
│   ├── dsearch.rst
│   ├── exclude_paths.rst
│   ├── extract.rst
│   ├── faq.rst
│   ├── ignore_order.rst
│   ├── ignore_types_or_values.rst
│   ├── index.rst
│   ├── make.bat
│   ├── numbers.rst
│   ├── optimizations.rst
│   ├── other.rst
│   ├── search_doc.rst
│   ├── serialization.rst
│   ├── stats.rst
│   ├── support.rst
│   ├── troubleshoot.rst
│   └── view.rst
├── mypy.ini
├── noxfile.py
├── pyproject.toml
├── pyrightconfig.json.example
└── uv.lock
```


# API Usage Guide

## Core APIs

### 1. Module Import

```python
from deepdiff import (
    AnySet, Delta, DeepDiff, DeepHash, DeepSearch, grep, extract, patch, summarize,
)
from deepdiff.anyset import AnySet
from deepdiff.commands import diff, patch, grep, extract
from deepdiff.deephash import (
    sha256hex, prepare_string_for_hashing, unprocessed, UNPROCESSED_KEY,
    BoolObj, HASH_LOOKUP_ERR_MSG, combine_hashes_lists,
)
from deepdiff.delta import (
    ELEM_NOT_FOUND_TO_ADD_MSG, VERIFICATION_MSG, VERIFY_BIDIRECTIONAL_MSG, not_found,
    DeltaNumpyOperatorOverrideError, BINIARY_MODE_NEEDED_MSG, DELTA_AT_LEAST_ONE_ARG_NEEDED,
    DeltaError, INVALID_ACTION_WHEN_CALLING_GET_ELEM, INVALID_ACTION_WHEN_CALLING_SIMPLE_SET_ELEM,
    INVALID_ACTION_WHEN_CALLING_SIMPLE_DELETE_ELEM, INDEXES_NOT_FOUND_WHEN_IGNORE_ORDER,
    FAIL_TO_REMOVE_ITEM_IGNORE_ORDER_MSG, NABLE_TO_GET_PATH_MSG, NOT_VALID_NUMPY_TYPE,
)
from deepdiff.diff import (
    PROGRESS_MSG, INVALID_VIEW_MSG, VERBOSE_LEVEL_RANGE_MSG, PURGE_LEVEL_RANGE_MSG,
    DELTA_VIEW, CUTOFF_RANGE_ERROR_MSG,
)
from deepdiff.distance import (
    _get_item_length, _get_numbers_distance, get_numeric_types_distance,
    _get_numpy_array_distance, DISTANCE_CALCS_NEEDS_CACHE,
)
from deepdiff.helper import (
    py_current_version, pypy3, np, number_to_string, TEXT_VIEW, DELTA_VIEW, CannotCompare,
    FlatDeltaRow, FlatDataAction, SetOrdered, PydanticBaseModel, np_float64, notpresent,
    get_id, py_major_version, py_minor_version, short_repr, get_numpy_ndarray_rows,
    cartesian_product_of_shape, literal_eval_extended, diff_numpy_array, cartesian_product_numpy,
    get_truncate_datetime, datetime_normalize, detailed__dict__, ENUM_INCLUDE_KEYS,
    add_root_to_paths, get_semvar_as_integer, np_ndarray, Opcode,
)
from deepdiff.lfucache import LFUCache
from deepdiff.model import (
    DiffLevel, ChildRelationship, DictRelationship, NonSubscriptableIterableRelationship,
    SubscriptableIterableRelationship, AttributeRelationship,
)
from deepdiff.operator import BaseOperator, PrefixOrSuffixOperator, BaseOperatorPlus
from deepdiff.path import (
    GETATTR, GET,  _path_to_elements, extract, parse_path, stringify_path,  _add_to_elements,
)
from deepdiff.serialization import (
    DELTA_IGNORE_ORDER_NEEDS_REPETITION_REPORT, DELTA_ERROR_WHEN_GROUP_BY, json_dumps,
    json_loads, pickle_load, pickle_dump, ForbiddenModule, ModuleNotFoundError,
    MODULE_NOT_FOUND_MSG, FORBIDDEN_MODULE_MSG, pretty_print_diff,
    load_path_content, UnsupportedFormatErr,
)
from deepdiff.summarize import summarize, _truncate
```

### 2. DeepDiff Class

**Function**: Perform an in-depth comparison of two Python objects and detect differences at all levels.

**Class Definition**:
```python
class DeepDiff(ResultDict, SerializationMixin, DistanceMixin, DeepDiffProtocol, Base):
    """
    Deep comparison of two objects and return difference results
    
    This is the core class of DeepDiff, used to compare two Python objects 
    and generate detailed difference reports. Supports multiple data types 
    including dictionaries, lists, sets, custom objects, etc.
    """
    __doc__ = doc

    CACHE_AUTO_ADJUST_THRESHOLD = 0.25

    def __init__(self,
                 t1: Any,
                 t2: Any,
                 _original_type: Optional[Any]=None,
                 cache_purge_level: int=1,
                 cache_size: int=0,
                 cache_tuning_sample_size: int=0,
                 custom_operators: Optional[List[Any]] =None,
                 cutoff_distance_for_pairs: float=CUTOFF_DISTANCE_FOR_PAIRS_DEFAULT,
                 cutoff_intersection_for_pairs: float=CUTOFF_INTERSECTION_FOR_PAIRS_DEFAULT,
                 default_timezone:Union[datetime.timezone, "BaseTzInfo"]=datetime.timezone.utc,
                 encodings: Optional[List[str]]=None,
                 exclude_obj_callback: Optional[Callable]=None,
                 exclude_obj_callback_strict: Optional[Callable]=None,
                 exclude_paths: Union[str, List[str], Set[str], FrozenSet[str], None]=None,
                 exclude_regex_paths: Union[str, List[str], Pattern[str], List[Pattern[str]], None]=None,
                 exclude_types: Optional[List[type]]=None,
                 get_deep_distance: bool=False,
                 group_by: Union[str, Tuple[str, str], None]=None,
                 group_by_sort_key: Union[str, Callable, None]=None,
                 hasher: Optional[Callable]=None,
                 hashes: Optional[Dict[Any, Any]]=None,
                 ignore_encoding_errors: bool=False,
                 ignore_nan_inequality: bool=False,
                 ignore_numeric_type_changes: bool=False,
                 ignore_order: bool=False,
                 ignore_order_func: Optional[Callable]=None,
                 ignore_private_variables: bool=True,
                 ignore_string_case: bool=False,
                 ignore_string_type_changes: bool=False,
                 ignore_type_in_groups: Optional[List[Tuple[Any, ...]]]=None,
                 ignore_type_subclasses: bool=False,
                 ignore_uuid_types: bool=False,
                 include_obj_callback: Optional[Callable]=None,
                 include_obj_callback_strict: Optional[Callable]=None,
                 include_paths: Union[str, List[str], None]=None,
                 iterable_compare_func: Optional[Callable]=None,
                 log_frequency_in_sec: int=0,
                 log_scale_similarity_threshold: float=0.1,
                 log_stacktrace: bool=False,
                 math_epsilon: Optional[float]=None,
                 max_diffs: Optional[int]=None,
                 max_passes: int=10000000,
                 number_format_notation: Literal["f", "e"]="f",
                 number_to_string_func: Optional[Callable]=None,
                 progress_logger: Callable[[str], None]=logger.info,
                 report_repetition: bool=False,
                 significant_digits: Optional[int]=None,
                 threshold_to_diff_deeper: float = 0.33,
                 truncate_datetime: Optional[str]=None,
                 use_enum_value: bool=False,
                 use_log_scale: bool=False,
                 verbose_level: int=1,
                 view: str=TEXT_VIEW,
                 zip_ordered_iterables: bool=False,
                 _parameters: Optional[Dict[str, Any]]=None,
                 _shared_parameters: Optional[Dict[str, Any]]=None,
                 **kwargs):
        super().__init__()
        if kwargs:
            raise ValueError((
                "The following parameter(s) are not valid: %s\n"
                "The valid parameters are ignore_order, report_repetition, significant_digits, "
                "number_format_notation, exclude_paths, include_paths, exclude_types, exclude_regex_paths, ignore_type_in_groups, "
                "ignore_string_type_changes, ignore_numeric_type_changes, ignore_type_subclasses, ignore_uuid_types, truncate_datetime, "
                "ignore_private_variables, ignore_nan_inequality, number_to_string_func, verbose_level, "
                "view, hasher, hashes, max_passes, max_diffs, zip_ordered_iterables, "
                "cutoff_distance_for_pairs, cutoff_intersection_for_pairs, log_frequency_in_sec, cache_size, "
                "cache_tuning_sample_size, get_deep_distance, group_by, group_by_sort_key, cache_purge_level, log_stacktrace,"
                "math_epsilon, iterable_compare_func, use_enum_value, _original_type, threshold_to_diff_deeper, default_timezone "
                "ignore_order_func, custom_operators, encodings, ignore_encoding_errors, use_log_scale, log_scale_similarity_threshold "
                "_parameters and _shared_parameters.") % ', '.join(kwargs.keys()))

        if _parameters:
            self.__dict__.update(_parameters)
        else:
            self.custom_operators = custom_operators or []
            self.ignore_order = ignore_order

            self.ignore_order_func = ignore_order_func

            ignore_type_in_groups = ignore_type_in_groups or []
            if numbers == ignore_type_in_groups or numbers in ignore_type_in_groups:
                ignore_numeric_type_changes = True
            self.ignore_numeric_type_changes = ignore_numeric_type_changes
            if strings == ignore_type_in_groups or strings in ignore_type_in_groups:
                ignore_string_type_changes = True
            # Handle ignore_uuid_types - check if uuid+str group is already in ignore_type_in_groups
            uuid_str_group = (uuids[0], str)
            if uuid_str_group == ignore_type_in_groups or uuid_str_group in ignore_type_in_groups:
                ignore_uuid_types = True
            self.ignore_uuid_types = ignore_uuid_types
            self.use_enum_value = use_enum_value
            self.log_scale_similarity_threshold = log_scale_similarity_threshold
            self.use_log_scale = use_log_scale
            self.default_timezone = default_timezone
            self.log_stacktrace = log_stacktrace
            self.threshold_to_diff_deeper = threshold_to_diff_deeper
            self.ignore_string_type_changes = ignore_string_type_changes
            self.ignore_type_in_groups = self.get_ignore_types_in_groups(
                ignore_type_in_groups=ignore_type_in_groups,
                ignore_string_type_changes=ignore_string_type_changes,
                ignore_numeric_type_changes=ignore_numeric_type_changes,
                ignore_type_subclasses=ignore_type_subclasses,
                ignore_uuid_types=ignore_uuid_types)
            self.report_repetition = report_repetition
            self.exclude_paths = add_root_to_paths(convert_item_or_items_into_set_else_none(exclude_paths))
            self.include_paths = add_root_to_paths(convert_item_or_items_into_set_else_none(include_paths))
            self.exclude_regex_paths = convert_item_or_items_into_compiled_regexes_else_none(exclude_regex_paths)
            self.exclude_types = set(exclude_types) if exclude_types else None
            self.exclude_types_tuple = tuple(exclude_types) if exclude_types else None  # we need tuple for checking isinstance
            self.ignore_type_subclasses = ignore_type_subclasses
            self.type_check_func = type_in_type_group if ignore_type_subclasses else type_is_subclass_of_type_group
            self.ignore_string_case = ignore_string_case
            self.exclude_obj_callback = exclude_obj_callback
            self.exclude_obj_callback_strict = exclude_obj_callback_strict
            self.include_obj_callback = include_obj_callback
            self.include_obj_callback_strict = include_obj_callback_strict
            self.number_to_string = number_to_string_func or number_to_string
            self.iterable_compare_func = iterable_compare_func
            self.zip_ordered_iterables = zip_ordered_iterables
            self.ignore_private_variables = ignore_private_variables
            self.ignore_nan_inequality = ignore_nan_inequality
            self.hasher = hasher
            self.cache_tuning_sample_size = cache_tuning_sample_size
            self.group_by = group_by
            if callable(group_by_sort_key):
                self.group_by_sort_key = group_by_sort_key
            elif group_by_sort_key:
                def _group_by_sort_key(x):
                    return x[group_by_sort_key]
                self.group_by_sort_key = _group_by_sort_key
            else:
                self.group_by_sort_key = None
            self.encodings = encodings
            self.ignore_encoding_errors = ignore_encoding_errors

            self.significant_digits = self.get_significant_digits(significant_digits, ignore_numeric_type_changes)
            self.math_epsilon = math_epsilon
            if self.math_epsilon is not None and self.ignore_order:
                logger.warning("math_epsilon in conjunction with ignore_order=True is only used for flat object comparisons. Custom math_epsilon will not have an effect when comparing nested objects.")
            self.truncate_datetime = get_truncate_datetime(truncate_datetime)
            self.number_format_notation = number_format_notation
            if verbose_level in {0, 1, 2}:
                self.verbose_level = verbose_level
            else:
                raise ValueError(VERBOSE_LEVEL_RANGE_MSG)
            if cache_purge_level not in {0, 1, 2}:
                raise ValueError(PURGE_LEVEL_RANGE_MSG)
            self.view = view
            # Setting up the cache for dynamic programming. One dictionary per instance of root of DeepDiff running.
            self.max_passes = max_passes
            self.max_diffs = max_diffs
            self.cutoff_distance_for_pairs = float(cutoff_distance_for_pairs)
            self.cutoff_intersection_for_pairs = float(cutoff_intersection_for_pairs)
            if self.cutoff_distance_for_pairs < 0 or self.cutoff_distance_for_pairs > 1:
                raise ValueError(CUTOFF_RANGE_ERROR_MSG)
            # _Parameters are the clean _parameters to initialize DeepDiff with so we avoid all the above
            # cleaning functionalities when running DeepDiff recursively.
            # However DeepHash has its own set of _parameters that are slightly different than DeepDIff.
            # DeepDiff _parameters are transformed to DeepHash _parameters via _get_deephash_params method.
            self.progress_logger = progress_logger
            self.cache_size = cache_size
            _parameters = self.__dict__.copy()
            _parameters['group_by'] = None  # overwriting since these parameters will be passed on to other passes.
            if log_stacktrace:
                self.log_err = logger.exception
            else:
                self.log_err = logger.error

        # Non-Root
        if _shared_parameters:
            self.is_root = False
            self._shared_parameters = _shared_parameters
            self.__dict__.update(_shared_parameters)
            # We are in some pass other than root
            progress_timer = None
        # Root
        else:
            self.is_root = True
            # Caching the DeepDiff results for dynamic programming
            self._distance_cache = LFUCache(cache_size) if cache_size else DummyLFU()
            self._stats = {
                PASSES_COUNT: 0,
                DIFF_COUNT: 0,
                DISTANCE_CACHE_HIT_COUNT: 0,
                PREVIOUS_DIFF_COUNT: 0,
                PREVIOUS_DISTANCE_CACHE_HIT_COUNT: 0,
                MAX_PASS_LIMIT_REACHED: False,
                MAX_DIFF_LIMIT_REACHED: False,
                DISTANCE_CACHE_ENABLED: bool(cache_size),
            }
            self.hashes = dict_() if hashes is None else hashes
            self._numpy_paths = dict_()  # if _numpy_paths is None else _numpy_paths
            self.group_by_keys = set()  # Track keys that originated from group_by operations
            self._shared_parameters = {
                'hashes': self.hashes,
                '_stats': self._stats,
                '_distance_cache': self._distance_cache,
                'group_by_keys': self.group_by_keys,
                '_numpy_paths': self._numpy_paths,
                _ENABLE_CACHE_EVERY_X_DIFF: self.cache_tuning_sample_size * 10,
            }
            if log_frequency_in_sec:
                # Creating a progress log reporter that runs in a separate thread every log_frequency_in_sec seconds.
                progress_timer = RepeatedTimer(log_frequency_in_sec, _report_progress, self._stats, progress_logger)
            else:
                progress_timer = None

        self._parameters = _parameters
        self.deephash_parameters = self._get_deephash_params()
        self.tree = TreeResult()
        self._iterable_opcodes = {}
        if group_by and self.is_root:
            try:
                original_t1 = t1
                t1 = self._group_iterable_to_dict(t1, group_by, item_name='t1')
            except (KeyError, ValueError):
                pass
            else:
                try:
                    t2 = self._group_iterable_to_dict(t2, group_by, item_name='t2')
                except (KeyError, ValueError):
                    t1 = original_t1

        self.t1 = t1
        self.t2 = t2

        try:
            root = DiffLevel(t1, t2, verbose_level=self.verbose_level)
            # _original_type is only used to pass the original type of the data. Currently only used for numpy arrays.
            # The reason is that we convert the numpy array to python list and then later for distance calculations
            # we convert only the the last dimension of it into numpy arrays.
            self._diff(root, parents_ids=frozenset({id(t1)}), _original_type=_original_type)

            if get_deep_distance and view in {TEXT_VIEW, TREE_VIEW}:
                self.tree['deep_distance'] = self._get_rough_distance()

            self.tree.remove_empty_keys()
            view_results = self._get_view_results(self.view)
            if isinstance(view_results, ColoredView):
                self.update(view_results.tree)
                self._colored_view = view_results
            else:
                self.update(view_results)
        finally:
            if self.is_root:
                if cache_purge_level:
                    del self._distance_cache
                    del self.hashes
                del self._shared_parameters
                del self._parameters
                for key in (PREVIOUS_DIFF_COUNT, PREVIOUS_DISTANCE_CACHE_HIT_COUNT,
                            DISTANCE_CACHE_ENABLED):
                    del self._stats[key]
                if progress_timer:
                    duration = progress_timer.stop()
                    self._stats['DURATION SEC'] = duration
                    logger.info('stats {}'.format(self.get_stats()))
                if cache_purge_level == 2:
                    self.__dict__.clear()

    def _get_deephash_params(self):
        """
        Get parameters for DeepHash initialization
        
        Returns:
            dict: Parameters dictionary for DeepHash
        """

    def _report_result(self, report_type, change_level, local_tree=None):
        """
        Add a detected change to the reference-style result dictionary.
        report_type will be added to level.
        (We'll create the text-style report from there later.)
        :param report_type: A well defined string key describing the type of change.
                            Examples: "set_item_added", "values_changed"
        :param change_level: A DiffLevel object describing the objects in question in their
                       before-change and after-change object structure.

        :local_tree: None
        """



    def custom_report_result(self, report_type, level, extra_info=None):
        """
        Add a detected change to the reference-style result dictionary.
        report_type will be added to level.
        (We'll create the text-style report from there later.)
        :param report_type: A well defined string key describing the type of change.
                            Examples: "set_item_added", "values_changed"
        :param parent: A DiffLevel object describing the objects in question in their
                       before-change and after-change object structure.
        :param extra_info: A dict that describe this result
        :rtype: None
        """



    @staticmethod
    def _dict_from_slots(object: Any) -> Dict[str, Any]:
        """
        Create dictionary from object slots
        
        Args:
            object: The object to extract slots from
            
        Returns:
            Dict[str, Any]: Dictionary containing slot attributes
        """
        def unmangle(attribute: str) -> str:
            """
            Unmangle attribute name
            
            Args:
                attribute: The mangled attribute name
                
            Returns:
                str: Unmangled attribute name
            """




    def _diff_enum(self, level: Any, parents_ids: FrozenSet[int]=frozenset(), local_tree: Optional[Any]=None) -> None:
        """
        Compare enum objects
        
        Args:
            level: The comparison level
            parents_ids: Set of parent object IDs
            local_tree: Local tree structure
        """
       

    def _diff_obj(self, level: Any, parents_ids: FrozenSet[int]=frozenset(), is_namedtuple: bool=False, local_tree: Optional[Any]=None, is_pydantic_object: bool=False) -> None:
        """Difference of 2 objects"""
        

    def _skip_this(self, level: Any) -> bool:
        """
        Check whether this comparison should be skipped because one of the objects to compare meets exclusion criteria.
        :rtype: bool
        """
        

    def _skip_this_key(self, level: Any, key: Any) -> bool:
        """
        Check if a key should be skipped during comparison
        
        Args:
            level: The comparison level
            key: The key to check
            
        Returns:
            bool: True if key should be skipped, False otherwise
        """
        # if include_paths is not set, than treet every path as included
        

    def _get_clean_to_keys_mapping(self, keys: Any, level: Any) -> Dict[Any, Any]:
        """
        Get a dictionary of cleaned value of keys to the keys themselves.
        This is mainly used to transform the keys when the type changes of keys should be ignored.

        TODO: needs also some key conversion for groups of types other than the built-in strings and numbers.
        """
        

    def _diff_dict(
        self,
        level: Any,
        parents_ids: FrozenSet[int]=frozenset([]),
        print_as_attribute: bool=False,
        override: bool=False,
        override_t1: Optional[Any]=None,
        override_t2: Optional[Any]=None,
        local_tree: Optional[Any]=None,
    ) -> None:
        """Difference of 2 dictionaries"""
       

    def _diff_set(self, level: Any, local_tree: Optional[Any]=None) -> None:
        """Difference of sets"""
        

    @staticmethod
    def _iterables_subscriptable(t1: Any, t2: Any) -> bool:
        """
        Check if two iterables are subscriptable
        
        Args:
            t1: First iterable to check
            t2: Second iterable to check
            
        Returns:
            bool: True if both iterables are subscriptable, False otherwise
        """


    def _diff_iterable(self, level: Any, parents_ids: FrozenSet[int]=frozenset(), _original_type: Optional[type]=None, local_tree: Optional[Any]=None) -> None:
        """Difference of iterables"""


    def _compare_in_order(
        self, level,
        t1_from_index=None, t1_to_index=None,
        t2_from_index=None, t2_to_index=None
    ) -> List[Tuple[Tuple[int, int], Tuple[Any, Any]]]:
        """
        Default compare if `iterable_compare_func` is not provided.
        This will compare in sequence order.
        """
        
    def _get_matching_pairs(
        self, level,
        t1_from_index=None, t1_to_index=None,
        t2_from_index=None, t2_to_index=None
    ) -> List[Tuple[Tuple[int, int], Tuple[Any, Any]]]:
        """
        Given a level get matching pairs. This returns list of two tuples in the form:
        [
          (t1 index, t2 index), (t1 item, t2 item)
        ]

        This will compare using the passed in `iterable_compare_func` if available.
        Default it to compare in order
        """

        

    def _diff_iterable_in_order(self, level, parents_ids=frozenset(), _original_type=None, local_tree=None):
        # We're handling both subscriptable and non-subscriptable iterables. Which one is it?
        

    def _all_values_basic_hashable(self, iterable: Iterable[Any]) -> bool:
        """
        Are all items basic hashable types?
        Or there are custom types too?
        """

    # We don't want to exhaust a generator
        

    def _diff_by_forming_pairs_and_comparing_one_by_one(
        self, level, local_tree, parents_ids=frozenset(),
        _original_type=None, child_relationship_class=None,
        t1_from_index=None, t1_to_index=None,
        t2_from_index=None, t2_to_index=None,
    ):
        """
        Compare iterables by forming pairs and comparing one by one
        
        Args:
            level: The comparison level
            local_tree: Local tree structure
            parents_ids: Set of parent object IDs
            _original_type: Original type of objects
            child_relationship_class: Class for child relationships
            t1_from_index: Start index for t1
            t1_to_index: End index for t1
            t2_from_index: Start index for t2
            t2_to_index: End index for t2
        """
        

    def _diff_ordered_iterable_by_difflib(
        self, level, local_tree, parents_ids=frozenset(), _original_type=None, child_relationship_class=None,
    ):
        """
        Compare ordered iterables using difflib
        
        Args:
            level: The comparison level
            local_tree: Local tree structure
            parents_ids: Set of parent object IDs
            _original_type: Original type of objects
            child_relationship_class: Class for child relationships
        """
        


    def _diff_str(self, level, local_tree=None):
        """Compare strings"""
        

    def _diff_tuple(self, level, parents_ids, local_tree=None):
        # Checking to see if it has _fields. Which probably means it is a named
        # tuple.
       
    def _add_hash(self, hashes, item_hash, item, i):
        """
        Add hash to the hashes dictionary
        
        Args:
            hashes: Dictionary to store hashes
            item_hash: Hash value of the item
            item: The item being hashed
            i: Index or identifier for the item
        """
        

    def _create_hashtable(self, level, t):
        """Create hashtable of {item_hash: (indexes, item)}"""
       
    @staticmethod
    @lru_cache(maxsize=2028)
    def _get_distance_cache_key(added_hash, removed_hash):
        """
        Get cache key for distance calculation
        
        Args:
            added_hash: Hash of the added item
            removed_hash: Hash of the removed item
            
        Returns:
            tuple: Cache key for distance calculation
        """
        

    def _get_rough_distance_of_hashed_objs(
            self, added_hash, removed_hash, added_hash_obj, removed_hash_obj, _original_type=None):
        """
        Get rough distance between two hashed objects to determine if they qualify as pairs
        
        Args:
            added_hash: Hash of the added object
            removed_hash: Hash of the removed object
            added_hash_obj: The added object
            removed_hash_obj: The removed object
            _original_type: Original type of objects
            
        Returns:
            float: Distance between the objects
        """
        # We need the rough distance between the 2 objects to see if they qualify to be pairs or not
        

    def _get_most_in_common_pairs_in_iterables(
            self, hashes_added, hashes_removed, t1_hashtable, t2_hashtable, parents_ids, _original_type):
        """
        Get the closest pairs between items that are removed and items that are added.

        returns a dictionary of hashes that are closest to each other.
        The dictionary is going to be symmetrical so any key will be a value too and otherwise.

        Note that due to the current reporting structure in DeepDiff, we don't compare an item that
        was added to an item that is in both t1 and t2.

        For example

        [{1, 2}, {4, 5, 6}]
        [{1, 2}, {1, 2, 3}]

        is only compared between {4, 5, 6} and {1, 2, 3} even though technically {1, 2, 3} is
        just one item different than {1, 2}

        Perhaps in future we can have a report key that is item duplicated and modified instead of just added.
        """
      

        # A dictionary of hashes to distances and each distance to an ordered set of hashes.
        # It tells us about the distance of each object from other objects.
        # And the objects with the same distances are grouped together in an ordered set.
        # It also includes a "max" key that is just the value of the biggest current distance in the
        # most_in_common_pairs dictionary.
        def defaultdict_orderedset():
            """
            Create a defaultdict with SetOrdered as default factory
            
            Returns:
                defaultdict: Dictionary with SetOrdered default factory
            """
            

    def _diff_iterable_with_deephash(self, level, parents_ids, _original_type=None, local_tree=None):
        """
        Diff of hashable or unhashable iterables. Only used when ignoring the order.
        
        Args:
            level: The comparison level
            parents_ids: Set of parent object IDs
            _original_type: Original type of objects
            local_tree: Local tree structure
        """

       

        def get_other_pair(hash_value, in_t1=True):
            """
            Gets the other paired indexed hash item to the hash_value in the pairs dictionary
            in_t1: are we looking for the other pair in t1 or t2?
            """
            

    def _diff_booleans(self, level, local_tree=None):
        """
        Compare boolean values
        
        Args:
            level: The comparison level
            local_tree: Local tree structure
        """


    def _diff_numbers(self, level, local_tree=None, report_type_change=True):
        """Diff Numbers"""
        
    def _diff_ipranges(self, level, local_tree=None):
        """Diff IP ranges"""


    def _diff_datetime(self, level, local_tree=None):
        """Diff DateTimes"""

    def _diff_time(self, level, local_tree=None):
        """Diff DateTimes"""

    def _diff_uuids(self, level, local_tree=None):
        """Diff UUIDs"""


    def _diff_numpy_array(self, level, parents_ids=frozenset(), local_tree=None):
        """Diff numpy arrays"""
        
    def _diff_types(self, level, local_tree=None):
        """Diff types"""


    def _count_diff(self):
        """
        Count the number of differences found
        
        Returns:
            int: Number of differences or StopIteration if limit reached
        """


    def _auto_tune_cache(self):
        """
        Automatically tune cache settings based on performance
        
        Adjusts cache parameters to optimize performance based on usage patterns.
        """
       

    def _auto_off_cache(self):
        """
        Auto adjust the cache based on the usage
        """
        

    def _use_custom_operator(self, level):
        """
        For each level we check all custom operators.
        If any one of them was a match for the level, we run the diff of the operator.
        If the operator returned True, the operator must have decided these objects should not
        be compared anymore. It might have already reported their results.
        In that case the report will appear in the final results of this diff.
        Otherwise basically the 2 objects in the level are being omitted from the results.
        """

        

    def _diff(self, level, parents_ids=frozenset(), _original_type=None, local_tree=None):
        """
        The main diff method

        **parameters**

        level: the tree level or tree node
        parents_ids: the ids of all the parent objects in the tree from the current node.
        _original_type: If the objects had an original type that was different than what currently exists in the level.t1 and t2
        """
       

    def _get_view_results(self, view):
        """
        Get the results based on the view
        """
        

    @staticmethod
    def _get_key_for_group_by(row, group_by, item_name):
        """
        Get the key for group_by functionality
        
        Args:
            row: The row data to extract key from
            group_by: The field name to group by
            item_name: The item name for the group
            
        Returns:
            The key value for grouping
        """


    def _group_iterable_to_dict(self, item, group_by, item_name):
        """
        Convert a list of dictionaries into a dictionary of dictionaries
        where the key is the value of the group_by key in each dictionary.
        """
        

    def get_stats(self):
        """
        Get some stats on internals of the DeepDiff run.
        """


    @property
    def affected_paths(self):
        """
        Get the list of paths that were affected.
        Whether a value was changed or they were added or removed.

        Example
            >>> t1 = {1: 1, 2: 2, 3: [3], 4: 4}
            >>> t2 = {1: 1, 2: 4, 3: [3, 4], 5: 5, 6: 6}
            >>> ddiff = DeepDiff(t1, t2)
            >>> ddiff
            >>> pprint(ddiff, indent=4)
            {   'dictionary_item_added': [root[5], root[6]],
                'dictionary_item_removed': [root[4]],
                'iterable_item_added': {'root[3][1]': 4},
                'values_changed': {'root[2]': {'new_value': 4, 'old_value': 2}}}
            >>> ddiff.affected_paths
            SetOrdered(['root[3][1]', 'root[4]', 'root[5]', 'root[6]', 'root[2]'])
            >>> ddiff.affected_root_keys
            SetOrdered([3, 4, 5, 6, 2])

        """
        

    @property
    def affected_root_keys(self):
        """
        Get the list of root keys that were affected.
        Whether a value was changed or they were added or removed.

        Example
            >>> t1 = {1: 1, 2: 2, 3: [3], 4: 4}
            >>> t2 = {1: 1, 2: 4, 3: [3, 4], 5: 5, 6: 6}
            >>> ddiff = DeepDiff(t1, t2)
            >>> ddiff
            >>> pprint(ddiff, indent=4)
            {   'dictionary_item_added': [root[5], root[6]],
                'dictionary_item_removed': [root[4]],
                'iterable_item_added': {'root[3][1]': 4},
                'values_changed': {'root[2]': {'new_value': 4, 'old_value': 2}}}
            >>> ddiff.affected_paths
            SetOrdered(['root[3][1]', 'root[4]', 'root[5]', 'root[6]', 'root[2]'])
            >>> ddiff.affected_root_keys
            SetOrdered([3, 4, 5, 6, 2])
        """
        

    def __str__(self):
        """
        Return string representation of the Delta object
        
        Returns:
            str: String representation of the delta
        """

```


### 3. Delta Class

**Function**: Create a delta object from a diff object.

**Class Definition**:
```python
class Delta:
    """
    Apply difference results to objects
    
    Used to apply difference results generated by DeepDiff back to objects,
    implementing incremental updates and synchronization functionality.
    """

    __doc__ = doc

    def __init__(
        self,
        diff: Union[DeepDiff, Mapping, str, bytes, None]=None,
        delta_path: Optional[str]=None,
        delta_file: Optional[IO]=None,
        delta_diff: Optional[dict]=None,
        flat_dict_list: Optional[List[Dict]]=None,
        flat_rows_list: Optional[List[FlatDeltaRow]]=None,
        deserializer: Callable=pickle_load,
        log_errors: bool=True,
        mutate: bool=False,
        raise_errors: bool=False,
        safe_to_import: Optional[Set[str]]=None,
        serializer: Callable=pickle_dump,
        verify_symmetry: Optional[bool]=None,
        bidirectional: bool=False,
        always_include_values: bool=False,
        iterable_compare_func_was_used: Optional[bool]=None,
        force: bool=False,
        fill: Any=not_found,
    ):
        # for pickle deserializer:
        if hasattr(deserializer, '__code__') and 'safe_to_import' in set(deserializer.__code__.co_varnames):
            _deserializer = deserializer
        else:
            def _deserializer(obj, safe_to_import=None):
                result = deserializer(obj)
                if result.get('_iterable_opcodes'):
                    _iterable_opcodes = {}
                    for path, op_codes in result['_iterable_opcodes'].items():
                        _iterable_opcodes[path] = []
                        for op_code in op_codes:
                            _iterable_opcodes[path].append(
                                Opcode(
                                    **op_code
                                )
                            )
                    result['_iterable_opcodes'] = _iterable_opcodes
                return result


        self._reversed_diff = None

        if verify_symmetry is not None:
            logger.warning(
                "DeepDiff Deprecation: use bidirectional instead of verify_symmetry parameter."
            )
            bidirectional = verify_symmetry

        self.bidirectional = bidirectional
        if bidirectional:
            self.always_include_values = True  # We need to include the values in bidirectional deltas
        else:
            self.always_include_values = always_include_values

        if diff is not None:
            if isinstance(diff, DeepDiff):
                self.diff = diff._to_delta_dict(directed=not bidirectional, always_include_values=self.always_include_values)
            elif isinstance(diff, Mapping):
                self.diff = diff
            elif isinstance(diff, strings):
                self.diff = _deserializer(diff, safe_to_import=safe_to_import)
        elif delta_path:
            with open(delta_path, 'rb') as the_file:
                content = the_file.read()
            self.diff = _deserializer(content, safe_to_import=safe_to_import)
        elif delta_diff:
            self.diff = delta_diff
        elif delta_file:
            try:
                content = delta_file.read()
            except UnicodeDecodeError as e:
                raise ValueError(BINIARY_MODE_NEEDED_MSG.format(e)) from None
            self.diff = _deserializer(content, safe_to_import=safe_to_import)
        elif flat_dict_list:
            # Use copy to preserve original value of flat_dict_list in calling module
            self.diff = self._from_flat_dicts(copy.deepcopy(flat_dict_list))
        elif flat_rows_list:
            self.diff = self._from_flat_rows(copy.deepcopy(flat_rows_list))
        else:
            raise ValueError(DELTA_AT_LEAST_ONE_ARG_NEEDED)

        self.mutate = mutate
        self.raise_errors = raise_errors
        self.log_errors = log_errors
        self._numpy_paths = self.diff.get('_numpy_paths', False)
        # When we create the delta from a list of flat dictionaries, details such as iterable_compare_func_was_used get lost.
        # That's why we allow iterable_compare_func_was_used to be explicitly set.
        self._iterable_compare_func_was_used = self.diff.get('_iterable_compare_func_was_used', iterable_compare_func_was_used)
        self.serializer = serializer
        self.deserializer = deserializer
        self.force = force
        self.fill = fill
        if force:
            self.get_nested_obj = _get_nested_obj_and_force
        else:
            self.get_nested_obj = _get_nested_obj
        self.reset()

    def __repr__(self):
        """
        Return string representation of the Delta object
        
        Returns:
            str: String representation of the delta
        """


    def reset(self):
        """
        Reset the delta object to initial state
        """


    def __add__(self, other):
        """
        Add another delta to this delta
        
        Args:
            other: Another delta object to add
            
        Returns:
            Delta: Combined delta object
        """
        
    __radd__ = __add__

    def __rsub__(self, other):
        """
        Subtract this delta from another delta
        
        Args:
            other: Another delta object
            
        Returns:
            Delta: Resulting delta object
        """


    def _raise_or_log(self, msg, level='error'):
        """
        Raise an error or log a message based on configuration
        
        Args:
            msg: Error message to raise or log
            level: Log level ('error', 'warning', etc.)
        """


    def _do_verify_changes(self, path, expected_old_value, current_old_value):
        """
        Verify that changes match expected values
        
        Args:
            path: Path to the changed item
            expected_old_value: Expected old value
            current_old_value: Current old value
        """
       
    def _get_elem_and_compare_to_old_value(
        self,
        obj,
        path_for_err_reporting,
        expected_old_value,
        elem=None,
        action=None,
        forced_old_value=None,
        next_element=None,
    ):
        """
        Get element and compare to old value for verification
        
        Args:
            obj: Object to get element from
            path_for_err_reporting: Path for error reporting
            expected_old_value: Expected old value
            elem: Element to compare
            action: Action being performed
            forced_old_value: Forced old value
            next_element: Next element in path
        """
        

    def _simple_set_elem_value(self, obj, path_for_err_reporting, elem=None, value=None, action=None):
        """
        Set the element value directly on an object
        """
        

    def _coerce_obj(self, parent, obj, path, parent_to_obj_elem,
                    parent_to_obj_action, elements, to_type, from_type):
        """
        Coerce obj and mark it in post_process_paths_to_convert for later to be converted back.
        Also reassign it to its parent to replace the old object.
        """
        self.post_process_paths_to_convert[elements[:-1]] = {'old_type': to_type, 'new_type': from_type}
        # If this function is going to ever be used to convert numpy arrays, uncomment these lines:
        # if from_type is np_ndarray:
        #     obj = obj.tolist()
        # else:
        

    def _set_new_value(self, parent, parent_to_obj_elem, parent_to_obj_action,
                       obj, elements, path, elem, action, new_value):
        """
        Set the element value on an object and if necessary convert the object to the proper mutable type
        """
        

    def _simple_delete_elem(self, obj, path_for_err_reporting, elem=None, action=None):
        """
        Delete the element directly on an object
        """


    def _del_elem(self, parent, parent_to_obj_elem, parent_to_obj_action,
                  obj, elements, path, elem, action):
        """
        Delete the element value on an object and if necessary convert the object to the proper mutable type
        """
       

    def _do_iterable_item_added(self):
        """
        Process iterable items that were added
        """
        

    def _do_dictionary_item_added(self):
        """
        Process dictionary items that were added
        """
       
    def _do_attribute_added(self):
        """
        Process attributes that were added
        """


    @staticmethod
    def _sort_key_for_item_added(path_and_value):
        """
        Get sort key for item added operations
        
        Args:
            path_and_value: Tuple containing path and value
            
        Returns:
            Sort key for ordering
        """


    @staticmethod
    def _sort_comparison(left, right):
        """
        We use sort comparison instead of _sort_key_for_item_added when we run into comparing element types that can not
        be compared with each other, such as None to None. Or integer to string.
        """
        # Example elements: [(4.3, 'GET'), ('b', 'GETATTR'), ('a3', 'GET')]
        # We only care about the values in the elements not how to get the values.
        


    def _do_item_added(self, items, sort=True, insert=False):
        """
        Process items that were added
        
        Args:
            items: Items that were added
            sort: Whether to sort the items
            insert: Whether to insert items
        """
        

    def _do_values_changed(self):
        """
        Process values that were changed
        """


    def _do_type_changes(self):
        """
        Process type changes
        """


    def _do_post_process(self):
        """
        Perform post-processing operations
        """


    def _do_pre_process(self):
        """
        Perform pre-processing operations
        """
        

    def _get_elements_and_details(self, path):
        """
        Get elements and details for a given path
        
        Args:
            path: The path to get elements for
            
        Returns:
            tuple: Elements and details for the path
        """
        

    def _do_values_or_type_changed(self, changes, is_type_change=False, verify_changes=True):
        """
        Process values or type changes
        
        Args:
            changes: List of changes to process
            is_type_change: Whether this is a type change
            verify_changes: Whether to verify changes
        """
        

    def _do_item_removed(self, items):
        """
        Handle removing items.
        """
        # Sorting the iterable_item_removed in reverse order based on the paths.
        # So that we delete a bigger index before a smaller index
        

    def _find_closest_iterable_element_for_index(self, obj, elem, expected_old_value):
        """
        Find the closest iterable element for a given index
        
        Args:
            obj: The object to search in
            elem: The element to find
            expected_old_value: Expected old value
            
        Returns:
            The closest element found
        """
        

    def _do_iterable_opcodes(self):
        """
        Process iterable opcodes for delta operations
        """
        



                # obj = self.get_nested_obj(obj=self, elements=elements)
                # for


    def _do_iterable_item_removed(self):
        """
        Process iterable items that were removed
        """
        

    def _do_dictionary_item_removed(self):
        """
        Process dictionary items that were removed
        """
        

    def _do_attribute_removed(self):
        """
        Process attributes that were removed
        """
        

    def _do_set_item_added(self):
        """
        Process set items that were added
        """
        

    def _do_set_item_removed(self):
        """
        Process set items that were removed
        """
        
    def _do_set_or_frozenset_item(self, items, func):
        """
        Process set or frozenset items
        
        Args:
            items: Items to process
            func: Function to apply to items
        """
        

    def _do_ignore_order_get_old(self, obj, remove_indexes_per_path, fixed_indexes_values, path_for_err_reporting):
        """
        A generator that gets the old values in an iterable when the order was supposed to be ignored.
        """
       

    def _do_ignore_order(self):
        """

            't1': [5, 1, 1, 1, 6],
            't2': [7, 1, 1, 1, 8],

            'iterable_items_added_at_indexes': {
                'root': {
                    0: 7,
                    4: 8
                }
            },
            'iterable_items_removed_at_indexes': {
                'root': {
                    4: 6,
                    0: 5
                }
            }

        """
        

    def _get_reverse_diff(self):
        """
        Get the reverse diff for bidirectional operations
        
        Returns:
            Delta: Reverse delta object
        """
        

    def dump(self, file):
        """
        Dump into file object
        """
        # Small optimization: Our internal pickle serializer can just take a file object
        # and directly write to it. However if a user defined serializer is passed
        # we want to make it compatible with the expectation that self.serializer(self.diff)
        # will give the user the serialization and then it can be written to
        # a file object when using the dump(file) function.


    def dumps(self):
        """
        Return the serialized representation of the object as a bytes object, instead of writing it to a file.
        """


    def to_dict(self):
        """
        Convert delta to dictionary representation
        
        Returns:
            dict: Dictionary representation of the delta
        """


    def _flatten_iterable_opcodes(self, _parse_path):
        """
        Converts op_codes to FlatDeltaRows
        """
        

    @staticmethod
    def _get_flat_row(action, info, _parse_path, keys_and_funcs, report_type_changes=True):
        """
        Get a flat row for delta operations
        
        Args:
            action: Action being performed
            info: Information about the action
            _parse_path: Path parsing function
            keys_and_funcs: Keys and functions for processing
            report_type_changes: Whether to report type changes
            
        Returns:
            FlatDeltaRow: Flat row representation
        """
        

    @staticmethod
    def _from_flat_rows(flat_rows_list: List[FlatDeltaRow]):
        """
        Create delta from flat rows list
        
        Args:
            flat_rows_list: List of flat delta rows
            
        Returns:
            dict: Delta dictionary
        """


    @staticmethod
    def _from_flat_dicts(flat_dict_list):
        """
        Create the delta's diff object from the flat_dict_list
        """
        

    def to_flat_dicts(self, include_action_in_path=False, report_type_changes=True) -> List[FlatDeltaRow]:
        """
        Returns a flat list of actions that is easily machine readable.

        For example:
            {'iterable_item_added': {'root[3]': 5, 'root[2]': 3}}

        Becomes:
            [
                {'path': [3], 'value': 5, 'action': 'iterable_item_added'},
                {'path': [2], 'value': 3, 'action': 'iterable_item_added'},
            ]

        
        **Parameters**

        include_action_in_path : Boolean, default=False
            When False, we translate DeepDiff's paths like root[3].attribute1 into a [3, 'attribute1'].
            When True, we include the action to retrieve the item in the path: [(3, 'GET'), ('attribute1', 'GETATTR')]
            Note that the "action" here is the different than the action reported by to_flat_dicts. The action here is just about the "path" output.

        report_type_changes : Boolean, default=True
            If False, we don't report the type change. Instead we report the value change.

        Example:
            t1 = {"a": None}
            t2 = {"a": 1}

            dump = Delta(DeepDiff(t1, t2)).dumps()
            delta = Delta(dump)
            assert t2 == delta + t1

            flat_result = delta.to_flat_dicts()
            flat_expected = [{'path': ['a'], 'action': 'type_changes', 'value': 1, 'new_type': int, 'old_type': type(None)}]
            assert flat_expected == flat_result

            flat_result2 = delta.to_flat_dicts(report_type_changes=False)
            flat_expected2 = [{'path': ['a'], 'action': 'values_changed', 'value': 1}]

        **List of actions**

        Here are the list of actions that the flat dictionary can return.
            iterable_item_added
            iterable_item_removed
            iterable_item_moved
            values_changed
            type_changes
            set_item_added
            set_item_removed
            dictionary_item_added
            dictionary_item_removed
            attribute_added
            attribute_removed
        """
        

    def to_flat_rows(self, include_action_in_path=False, report_type_changes=True) -> List[FlatDeltaRow]:
        """
        Just like to_flat_dicts but returns FlatDeltaRow Named Tuples
        """
        
```

### 4. DeepSearch Class

**Function**: Search for a specific value in a complex data structure and return the paths and values of the found items.

**Class Definition**:
```python
class DeepSearch(Dict[str, Union[Dict[str, Any], SetOrdered, List[str]]]):
    """
    Deep search for matching items within objects
    
    Used to search for specific values or patterns in complex data structures.
    Supports string matching, regular expressions, type filtering, etc.
    """
    r"""
    **DeepSearch**

    Deep Search inside objects to find the item matching your criteria.

    **Parameters**

    obj : The object to search within

    item : The item to search for

    verbose_level : int >= 0, default = 1.
        Verbose level one shows the paths of found items.
        Verbose level 2 shows the path and value of the found items.

    exclude_paths: list, default = None.
        List of paths to exclude from the report.

    exclude_types: list, default = None.
        List of object types to exclude from the report.

    case_sensitive: Boolean, default = False

    match_string: Boolean, default = False
        If True, the value of the object or its children have to exactly match the item.
        If False, the value of the item can be a part of the value of the object or its children

    use_regexp: Boolean, default = False

    strict_checking: Boolean, default = True
        If True, it will check the type of the object to match, so when searching for '1234',
        it will NOT match the int 1234. Currently this only affects the numeric values searching.

    **Returns**

        A DeepSearch object that has the matched paths and matched values.

    **Supported data types**

    int, string, unicode, dictionary, list, tuple, set, frozenset, OrderedDict, NamedTuple and custom objects!

    **Examples**

    Importing
        >>> from deepdiff import DeepSearch
        >>> from pprint import pprint

    Search in list for string
        >>> obj = ["long somewhere", "string", 0, "somewhere great!"]
        >>> item = "somewhere"
        >>> ds = DeepSearch(obj, item, verbose_level=2)
        >>> print(ds)
        {'matched_values': {'root[3]': 'somewhere great!', 'root[0]': 'long somewhere'}}

    Search in nested data for string
        >>> obj = ["something somewhere", {"long": "somewhere", "string": 2, 0: 0, "somewhere": "around"}]
        >>> item = "somewhere"
        >>> ds = DeepSearch(obj, item, verbose_level=2)
        >>> pprint(ds, indent=2)
        { 'matched_paths': {"root[1]['somewhere']": 'around'},
          'matched_values': { 'root[0]': 'something somewhere',
                              "root[1]['long']": 'somewhere'}}

    """

    warning_num: int = 0

    def __init__(self,
                 obj: Any,
                 item: Any,
                 exclude_paths: Union[SetOrdered, Set[str], List[str]] = SetOrdered(),
                 exclude_regex_paths: Union[SetOrdered, Set[Union[str, Pattern[str]]], List[Union[str, Pattern[str]]]] = SetOrdered(),
                 exclude_types: Union[SetOrdered, Set[type], List[type]] = SetOrdered(),
                 verbose_level: int = 1,
                 case_sensitive: bool = False,
                 match_string: bool = False,
                 use_regexp: bool = False,
                 strict_checking: bool = True,
                 **kwargs: Any) -> None:
        if kwargs:
            raise ValueError((
                "The following parameter(s) are not valid: %s\n"
                "The valid parameters are obj, item, exclude_paths, exclude_types,\n"
                "case_sensitive, match_string and verbose_level."
            ) % ', '.join(kwargs.keys()))

        self.obj: Any = obj
        self.case_sensitive: bool = case_sensitive if isinstance(item, strings) else True
        item = item if self.case_sensitive else (item.lower() if isinstance(item, str) else item)
        self.exclude_paths: SetOrdered = SetOrdered(exclude_paths)
        self.exclude_regex_paths: List[Pattern[str]] = [re.compile(exclude_regex_path) for exclude_regex_path in exclude_regex_paths]
        self.exclude_types: SetOrdered = SetOrdered(exclude_types)
        self.exclude_types_tuple: tuple[type, ...] = tuple(
            exclude_types)  # we need tuple for checking isinstance
        self.verbose_level: int = verbose_level
        self.update(
            matched_paths=self.__set_or_dict(),
            matched_values=self.__set_or_dict(),
            unprocessed=[])
        # Type narrowing for mypy/pyright
        self.matched_paths: Union[Dict[str, Any], SetOrdered]
        self.matched_values: Union[Dict[str, Any], SetOrdered]
        self.unprocessed: List[str]
        self.use_regexp: bool = use_regexp
        if not strict_checking and (isinstance(item, numbers) or isinstance(item, ipranges)):
            item = str(item)
        if self.use_regexp:
            try:
                item = re.compile(item)
            except TypeError as e:
                raise TypeError(f"The passed item of {item} is not usable for regex: {e}") from None
        self.strict_checking: bool = strict_checking

        # Cases where user wants to match exact string item
        self.match_string: bool = match_string

        self.__search(obj, item, parents_ids=frozenset({id(obj)}))

        empty_keys = [k for k, v in self.items() if not v]

        for k in empty_keys:
            del self[k]

    def __set_or_dict(self) -> Union[Dict[str, Any], SetOrdered]:
        """
        Get set or dictionary for storing results
        
        Returns:
            Union[Dict[str, Any], SetOrdered]: Result container
        """


    def __report(self, report_key: str, key: str, value: Any) -> None:
        """
        Report a search result
        
        Args:
            report_key: Key for the report type
            key: The key/path of the found item
            value: The value of the found item
        """


    def __search_obj(self,
                     obj: Any,
                     item: Any,
                     parent: str,
                     parents_ids: FrozenSet[int] = frozenset(),
                     is_namedtuple: bool = False) -> None:
        """Search objects"""
       



    def __skip_this(self, item: Any, parent: str) -> bool:
        """
        Check if the current item should be skipped during search
        
        Args:
            item: The item to check
            parent: The parent path string
            
        Returns:
            bool: True if item should be skipped, False otherwise
        """
       

    def __search_dict(self,
                      obj: Union[Dict[Any, Any], MutableMapping[Any, Any]],
                      item: Any,
                      parent: str,
                      parents_ids: FrozenSet[int] = frozenset(),
                      print_as_attribute: bool = False) -> None:
        """Search dictionaries"""
        

    def __search_iterable(self,
                          obj: Iterable[Any],
                          item: Any,
                          parent: str = "root",
                          parents_ids: FrozenSet[int] = frozenset()) -> None:
        """Search iterables except dictionaries, sets and strings."""
        

    def __search_str(self, obj: Union[str, bytes, memoryview], item: Union[str, bytes, memoryview, Pattern[str]], parent: str) -> None:
        """Compare strings"""
        

    def __search_numbers(self, obj: Any, item: Any, parent: str) -> None:
        """
        Search for numbers in objects
        
        Args:
            obj: The object to search in
            item: The number to search for
            parent: Parent path string
        """
        
    def __search_tuple(self, obj: Tuple[Any, ...], item: Any, parent: str, parents_ids: FrozenSet[int]) -> None:
        """
        Search for items in tuples
        
        Args:
            obj: The tuple to search in
            item: The item to search for
            parent: Parent path string
            parents_ids: Set of parent object IDs
        """
        # Checking to see if it has _fields. Which probably means it is a named
        # tuple.
        

    def __search(self, obj: Any, item: Any, parent: str = "root", parents_ids: FrozenSet[int] = frozenset()) -> None:
        """The main search method"""
       
```


### 5. DeepHash Class

**Function**: Calculate the hash of objects based on their contents in a deterministic way.

**Class Definition**:
```python
class DeepHash(Base):
    """
    Generate deep hash values for complex objects
    
    Used to generate consistent hash values for nested Python objects, 
    supporting custom hash algorithms and type handling rules. 
    Mainly used for internal optimization of DeepDiff.
    """
    __doc__ = doc
    
    # Class attributes
    hashes: Dict[Any, Any]
    exclude_types_tuple: Tuple[type, ...]
    ignore_repetition: bool
    exclude_paths: Optional[Set[str]]
    include_paths: Optional[Set[str]]
    exclude_regex_paths: Optional[List[re.Pattern[str]]]
    hasher: Callable[[Union[str, bytes]], str]
    use_enum_value: bool
    default_timezone: Union[datetime.timezone, "BaseTzInfo"]
    significant_digits: Optional[int]
    truncate_datetime: Optional[str]
    number_format_notation: str
    ignore_type_in_groups: Any
    ignore_string_type_changes: bool
    ignore_numeric_type_changes: bool
    ignore_string_case: bool
    exclude_obj_callback: Optional[Callable[[Any, str], bool]]
    apply_hash: bool
    type_check_func: Callable[[type, Any], bool]
    number_to_string: Any
    ignore_private_variables: bool
    encodings: Optional[List[str]]
    ignore_encoding_errors: bool
    ignore_iterable_order: bool
    custom_operators: Optional[List[Any]]

    def __init__(self,
                 obj: Any,
                 *,
                 apply_hash: bool = True,
                 custom_operators: Optional[List[Any]] = None,
                 default_timezone: Union[datetime.timezone, "BaseTzInfo"] = datetime.timezone.utc,
                 encodings: Optional[List[str]] = None,
                 exclude_obj_callback: Optional[Callable[[Any, str], bool]] = None,
                 exclude_paths: Optional[PathType] = None,
                 exclude_regex_paths: Optional[RegexType] = None,
                 exclude_types: Optional[Union[List[type], Set[type], Tuple[type, ...]]] = None,
                 hasher: Optional[Callable[[Union[str, bytes]], str]] = None,
                 hashes: Optional[Union[Dict[Any, Any], "DeepHash"]] = None,
                 ignore_encoding_errors: bool = False,
                 ignore_iterable_order: bool = True,
                 ignore_numeric_type_changes: bool = False,
                 ignore_private_variables: bool = True,
                 ignore_repetition: bool = True,
                 ignore_string_case: bool = False,
                 ignore_string_type_changes: bool = False,
                 ignore_type_in_groups: Any = None,
                 ignore_type_subclasses: bool = False,
                 ignore_uuid_types: bool = False,
                 include_paths: Optional[PathType] = None,
                 number_format_notation: str = "f",
                 number_to_string_func: Optional[NumberToStringFunc] = None,
                 parent: str = "root",
                 significant_digits: Optional[int] = None,
                 truncate_datetime: Optional[str] = None,
                 use_enum_value: bool = False,
                 **kwargs) -> None:
        if kwargs:
            raise ValueError(
                ("The following parameter(s) are not valid: %s\n"
                 "The valid parameters are obj, hashes, exclude_types, significant_digits, truncate_datetime,"
                 "exclude_paths, include_paths, exclude_regex_paths, hasher, ignore_repetition, "
                 "number_format_notation, apply_hash, ignore_type_in_groups, ignore_string_type_changes, "
                 "ignore_numeric_type_changes, ignore_type_subclasses, ignore_string_case, ignore_uuid_types, "
                 "number_to_string_func, ignore_private_variables, parent, use_enum_value, default_timezone "
                 "encodings, ignore_encoding_errors") % ', '.join(kwargs.keys()))
        if isinstance(hashes, MutableMapping):
            self.hashes = hashes
        elif isinstance(hashes, DeepHash):
            self.hashes = hashes.hashes
        else:
            self.hashes = dict_()
        exclude_types = set() if exclude_types is None else set(exclude_types)
        self.exclude_types_tuple = tuple(exclude_types)  # we need tuple for checking isinstance
        self.ignore_repetition = ignore_repetition
        self.exclude_paths = add_root_to_paths(convert_item_or_items_into_set_else_none(exclude_paths))
        self.include_paths = add_root_to_paths(convert_item_or_items_into_set_else_none(include_paths))
        self.exclude_regex_paths = convert_item_or_items_into_compiled_regexes_else_none(exclude_regex_paths)
        self.hasher = default_hasher if hasher is None else hasher
        self.hashes[UNPROCESSED_KEY] = []  # type: ignore
        self.use_enum_value = use_enum_value
        self.default_timezone = default_timezone
        self.significant_digits = self.get_significant_digits(significant_digits, ignore_numeric_type_changes)
        self.truncate_datetime = get_truncate_datetime(truncate_datetime)
        self.number_format_notation = number_format_notation
        self.ignore_type_in_groups = self.get_ignore_types_in_groups(
            ignore_type_in_groups=ignore_type_in_groups,
            ignore_string_type_changes=ignore_string_type_changes,
            ignore_numeric_type_changes=ignore_numeric_type_changes,
            ignore_type_subclasses=ignore_type_subclasses,
            ignore_uuid_types=ignore_uuid_types,
        )
        self.ignore_string_type_changes = ignore_string_type_changes
        self.ignore_numeric_type_changes = ignore_numeric_type_changes
        self.ignore_string_case = ignore_string_case
        self.exclude_obj_callback = exclude_obj_callback
        # makes the hash return constant size result if true
        # the only time it should be set to False is when
        # testing the individual hash functions for different types of objects.
        self.apply_hash = apply_hash
        self.type_check_func = type_in_type_group if ignore_type_subclasses else type_is_subclass_of_type_group
        # self.type_check_func = type_is_subclass_of_type_group if ignore_type_subclasses else type_in_type_group
        self.number_to_string = number_to_string_func or number_to_string
        self.ignore_private_variables = ignore_private_variables
        self.encodings = encodings
        self.ignore_encoding_errors = ignore_encoding_errors
        self.ignore_iterable_order = ignore_iterable_order
        self.custom_operators = custom_operators

        self._hash(obj, parent=parent, parents_ids=frozenset({get_id(obj)}))

        if self.hashes[UNPROCESSED_KEY]:
            logger.warning("Can not hash the following items: {}.".format(self.hashes[UNPROCESSED_KEY]))
        else:
            del self.hashes[UNPROCESSED_KEY]

    sha256hex: Callable[[Union[str, bytes]], str] = sha256hex
    sha1hex: Callable[[Union[str, bytes]], str] = sha1hex

    def __getitem__(self, obj: Any, extract_index: Optional[int] = 0) -> Any:
        """
        Get item from hashes dictionary
        
        Args:
            obj: Object to get hash for
            extract_index: Index to extract (0 for hash, 1 for count)
            
        Returns:
            Any: Hash value or count
        """


    @staticmethod
    def _getitem(hashes: Dict[Any, Any], obj: Any, extract_index: Optional[int] = 0, use_enum_value: bool = False) -> Any:
        """
        extract_index is zero for hash and 1 for count and None to get them both.
        To keep it backward compatible, we only get the hash by default so it is set to zero by default.
        """

       

    def __contains__(self, obj: Any) -> bool:
        """
        Check if object is in hashes dictionary
        
        Args:
            obj: Object to check
            
        Returns:
            bool: True if object is in hashes, False otherwise
        """


    def get(self, key: Any, default: Any = None, extract_index: Optional[int] = 0) -> Any:
        """
        Get method for the hashes dictionary.
        It can extract the hash for a given key that is already calculated when extract_index=0
        or the count of items that went to building the object whenextract_index=1.
        """


    @staticmethod
    def get_key(hashes: Dict[Any, Any], key: Any, default: Any = None, extract_index: Optional[int] = 0, use_enum_value: bool = False) -> Any:
        """
        get_key method for the hashes dictionary.
        It can extract the hash for a given key that is already calculated when extract_index=0
        or the count of items that went to building the object whenextract_index=1.
        """


    def _get_objects_to_hashes_dict(self, extract_index: Optional[int] = 0) -> Dict[Any, Any]:
        """
        A dictionary containing only the objects to hashes,
        or a dictionary of objects to the count of items that went to build them.
        extract_index=0 for hashes and extract_index=1 for counts.
        """


    def __eq__(self, other: Any) -> bool:


    __req__ = __eq__

    def __repr__(self) -> str:
        """
        Hide the counts since it will be confusing to see them when they are hidden everywhere else.
        """
        from deepdiff.summarize import summarize

    def __str__(self) -> str:
        """
        Return string representation of the DeepHash object
        
        Returns:
            str: String representation of the hash
        """

    def __bool__(self) -> bool:
        """
        Return boolean representation of the DeepHash object
        
        Returns:
            bool: True if hashes exist, False otherwise
        """

    def keys(self) -> Any:
        """
        Return keys from the hashes dictionary
        
        Returns:
            Any: Keys from the hashes dictionary
        """


    def values(self) -> Generator[Any, None, None]:
        """
        Return values from the hashes dictionary
        
        Returns:
            Generator[Any, None, None]: Values from the hashes dictionary
        """

    def items(self) -> Generator[Tuple[Any, Any], None, None]:
        """
        Return items from the hashes dictionary
        
        Returns:
            Generator[Tuple[Any, Any], None, None]: Items from the hashes dictionary
        """

    def _prep_obj(self, obj: Any, parent: str, parents_ids: frozenset = EMPTY_FROZENSET, is_namedtuple: bool = False, is_pydantic_object: bool = False) -> HashTuple:
        """prepping objects"""
       

    def _skip_this(self, obj: Any, parent: str) -> bool:
        """
        Check if object should be skipped during hashing
        
        Args:
            obj: Object to check
            parent: Parent path string
            
        Returns:
            bool: True if object should be skipped, False otherwise
        """
        

    def _prep_dict(self, obj: Union[Dict[Any, Any], MutableMapping], parent: str, parents_ids: frozenset = EMPTY_FROZENSET, print_as_attribute: bool = False, original_type: Optional[type] = None) -> HashTuple:
        """
        Prepare dictionary for hashing
        
        Args:
            obj: Dictionary to prepare
            parent: Parent path string
            parents_ids: Set of parent object IDs
            print_as_attribute: Whether to print as attribute
            original_type: Original type of the object
            
        Returns:
            HashTuple: Hash tuple for the dictionary
        """

        

    def _prep_iterable(self, obj: Iterable[Any], parent: str, parents_ids: frozenset = EMPTY_FROZENSET) -> HashTuple:
        """
        Prepare iterable for hashing
        
        Args:
            obj: Iterable to prepare
            parent: Parent path string
            parents_ids: Set of parent object IDs
            
        Returns:
            HashTuple: Hash tuple for the iterable
        """

        

    def _prep_bool(self, obj: bool) -> BoolObj:
        """
        Prepare boolean for hashing
        
        Args:
            obj: Boolean to prepare
            
        Returns:
            BoolObj: Boolean object for hashing
        """


    def _prep_path(self, obj: Path) -> str:
        """
        Prepare path for hashing
        
        Args:
            obj: Path object to prepare
            
        Returns:
            str: String representation of the path
        """

    def _prep_number(self, obj: Union[int, float, complex]) -> str:
        """
        Prepare number for hashing
        
        Args:
            obj: Number to prepare
            
        Returns:
            str: String representation of the number
        """

    def _prep_ipranges(self, obj) -> str:
        """
        Prepare IP ranges for hashing
        
        Args:
            obj: IP range object to prepare
            
        Returns:
            str: String representation of the IP range
        """

    def _prep_datetime(self, obj: datetime.datetime) -> str:
        """
        Prepare datetime for hashing
        
        Args:
            obj: Datetime object to prepare
            
        Returns:
            str: String representation of the datetime
        """

    def _prep_date(self, obj: datetime.date) -> str:
        """
        Prepare date for hashing
        
        Args:
            obj: Date object to prepare
            
        Returns:
            str: String representation of the date
        """

    def _prep_tuple(self, obj: tuple, parent: str, parents_ids: frozenset) -> HashTuple:
        # Checking to see if it has _fields. Which probably means it is a named
        # tuple.

    def _hash(self, obj: Any, parent: str, parents_ids: frozenset = EMPTY_FROZENSET) -> HashTuple:
        """The main hash method"""
       
```

### 6. extract() Function - Path Extraction

**Function**: Extract the value at a specified path from an object.

**Function Signature**:

```python
from deepdiff.path import extract
def extract(
    obj: Any,
    path: str
) -> Any:
```

**Parameter Description**:
- `obj` (Any): The object to be extracted from
- `path` (str): The path string

**Return Value**: The extracted value

### 7. parse_path() Function - Path Parsing

**Function**: Parse a path string.

**Function Signature**:
```python
def parse_path(
    path: str,
    root_element: Tuple[str, str] = ('root', 'GETATTR'),
    include_actions: bool = False
) -> List[Tuple[Any, str]]:
```

**Parameter Description**:
- `path` (str): The path string
- `root_element` (Tuple): The root element, default is ('root', 'GETATTR')
- `include_actions` (bool): Whether to include actions, default is False

**Return Value**: A list of parsed elements

### 8. grep() Function - Object Search

**Function**: Search for a specific value in an object.

**Function Signature**:
```python
def grep(item, path, debug, **kwargs):
```

**Parameter Description**:
- `item` (Any): The item to be searched for
- `**kwargs`: Other parameters (same as DeepSearch)

**Return Value**: A DeepSearch object

### 9.pytest_addoption() Function - Add Options

**Function**: Add options to the pytest command line.

**Function Signature**:
```python
def pytest_addoption(parser):
```

**Parameter Description**:
- `parser`: The parser object

**Return Value**: None

### 10.pytest_configure() Function - Configure pytest

**Function**: Configure the pytest command line.

**Function Signature**:
```python
def pytest_configure(config):
```

**Parameter Description**:
- `config`: The config object

**Return Value**: None

### 11.pytest_collection_modifyitems() Function - Modify Collection Items

**Function**: Modify the collection items.

**Function Signature**:
```python
def pytest_collection_modifyitems(config, items):
```

**Parameter Description**:
- `config`: The config object
- `items`: The collection items

**Return Value**: None

### 12.nested_a_t1() Function - Nested A T1

**Function**: Load the nested A T1 fixture.

**Function Signature**:
```python
@pytest.fixture(scope='class')
def nested_a_t1():
```

**Parameter Description**: None

**Return Value**: The nested A T1 fixture

### 13.nested_a_t2() Function - Nested A T2

**Function**: Load the nested A T2 fixture.

**Function Signature**:
```python
@pytest.fixture(scope='class')
def nested_a_t2():
```

**Parameter Description**: None

**Return Value**: The nested A T2 fixture

### 14.nested_a_result() Function - Nested A Result

**Function**: Load the nested A result fixture.

**Function Signature**:
```python
@pytest.fixture(scope='class')
def nested_a_result():
```

**Parameter Description**: None

**Return Value**: The nested A result fixture

### 15.compounds() Function - Compounds

**Function**: Load the compounds fixture.

**Function Signature**:
```python
@pytest.fixture(scope='function')
def compounds():
```

**Parameter Description**: None

**Return Value**: The compounds fixture

### 16.nested_a_affected_paths() Function - Nested A Affected Paths

**Function**: Load the nested A affected paths fixture.

**Function Signature**:
```python
@pytest.fixture(scope='class')
def nested_a_affected_paths():
```

**Parameter Description**: None

**Return Value**: The nested A affected paths fixture

### 17.nested_b_t1() Function - Nested B T1

**Function**: Load the nested B T1 fixture.

**Function Signature**:
```python
@pytest.fixture(scope='class')
def nested_b_t1():
```

**Parameter Description**: None

**Return Value**: The nested B T1 fixture

### 18.nested_b_t2() Function - Nested B T2

**Function**: Load the nested B T2 fixture.

**Function Signature**:
```python
@pytest.fixture(scope='class')
def nested_b_t2():
```

**Parameter Description**: None

**Return Value**: The nested B T2 fixture

### 19.nested_b_result() Function - Nested B Result

**Function**: Load the nested B result fixture.

**Function Signature**:
```python
@pytest.fixture(scope='class')
def nested_b_result():
```

**Parameter Description**: None

**Return Value**: The nested B result fixture

### 20.compare_func_t1() Function - Compare Func T1

**Function**: Load the compare func T1 fixture.

**Function Signature**:
```python
@pytest.fixture(scope='class')
def compare_func_t1():
```

**Parameter Description**: None

**Return Value**: The compare func T1 fixture

### 21.compare_func_t2() Function - Compare Func T2

**Function**: Load the compare func T2 fixture.

**Function Signature**:
```python
@pytest.fixture(scope='class')
def compare_func_t2():
```

**Parameter Description**: None

**Return Value**: The compare func T2 fixture

### 22.compare_func_result1() Function - Compare Func Result1

**Function**: Load the compare func result1 fixture.

**Function Signature**:
```python
@pytest.fixture(scope='class')
def compare_func_result1():
```

**Parameter Description**: None

**Return Value**: The compare func result1 fixture

### 23.flake8() Function - Flake8

**Function**: Run the flake8 command.

**Function Signature**:
```python
def flake8(session) -> None:
```

**Parameter Description**: None

**Return Value**: None

### 24. calculate_weights() Function - Calculate Node Weights

**Function**: Recursively calculates the weight of each node in any data structure and builds node structure information.

**Function Signature**:
```python
def calculate_weights(node) -> Tuple[int, Tuple[SummaryNodeType, Any]]
```

**Parameter Description**:
- `node` (Any): The node for which to calculate the weight, supports data types such as dictionaries, lists, strings, numbers, None, etc.

**Return Value**: A tuple containing weight and node structure information
- For dictionary nodes: returns `(total_weight, (SummaryNodeType.dict, child_node_weight_info))`
- For list nodes: returns `(total_weight, (SummaryNodeType.list, child_node_weight_info))`
- For leaf nodes: returns `(node_weight, (SummaryNodeType.leaf, original_value))`

### 25.shrink_tree_balanced() Function - Shrink Tree Balanced

**Function**: Shrink the tree balanced.

**Function Signature**:
```python
def shrink_tree_balanced(node_structure, max_weight: int, balance_threshold: float) -> Tuple[JSON, float]:
```

**Parameter Description**:
- `node_structure` (Tuple): The node structure to shrink
- `max_weight` (int): The maximum weight
- `balance_threshold` (float): The balance threshold

**Return Value**: A tuple containing the shrunk node structure and the weight

### 26.greedy_tree_summarization_balanced() Function - Greedy Tree Summarization Balanced

**Function**: Greedy tree summarization balanced.

**Function Signature**:
```python
def greedy_tree_summarization_balanced(json_data: JSON, max_weight: int, balance_threshold=0.6) -> JSON:
```

**Parameter Description**:
- `json_data` (JSON): The JSON data to summarize
- `max_weight` (int): The maximum weight
- `balance_threshold` (float): The balance threshold

**Return Value**: The summarized JSON data

### 27._numpy_div() Function - Numpy Div

**Function**: Divide two numpy arrays.

**Function Signature**:
```python
def _numpy_div(a, b, replace_inf_with=1):
```

**Parameter Description**:
- `a` (np.ndarray): The first numpy array
- `b` (np.ndarray): The second numpy array
- `replace_inf_with` (int): The value to replace infinity with

**Return Value**: The divided numpy array

### 28.numpy_apply_log_keep_sign() Function - Numpy Apply Log Keep Sign

**Function**: Apply the log to a numpy array and keep the sign.

**Function Signature**:
```python
def numpy_apply_log_keep_sign(array, offset=MATH_LOG_OFFSET) -> np.ndarray:
```

**Parameter Description**:
- `array` (np.ndarray): The numpy array to apply the log to
- `offset` (float): The offset to add to the array

**Return Value**: The logged numpy array

### 29.logarithmic_similarity() Function - Logarithmic Similarity

**Function**: Calculate the logarithmic similarity between two values.

**Function Signature**:
```python
def logarithmic_similarity(a: NumberType, b: NumberType, threshold: float=0.1) -> float:
```

**Parameter Description**:
- `a` (float): The first value
- `b` (float): The second value
- `threshold` (float): The threshold for the similarity

**Return Value**: The logarithmic similarity

### 30.logarithmic_distance() Function - Logarithmic Distance

**Function**: Calculate the logarithmic distance between two values.

**Function Signature**:
```python
def logarithmic_distance(a: NumberType, b: NumberType) -> float:
```

**Parameter Description**:
- `a` (NumberType): The first value
- `b` (NumberType): The second value

**Return Value**: The logarithmic distance

### 31._get_numpy_array_distance() Function - Get Numpy Array Distance

**Function**: Get the distance between two numpy arrays.

**Function Signature**:
```python
def _get_numpy_array_distance(num1, num2, max_=1, use_log_scale=False, log_scale_similarity_threshold=0.1):
```

**Parameter Description**:
- `num1` (np.ndarray): The first numpy array
- `num2` (np.ndarray): The second numpy array
- `max_` (int): The maximum value
- `use_log_scale` (bool): Whether to use log scale
- `log_scale_similarity_threshold` (float): The threshold for the similarity

**Return Value**: The distance between the two numpy arrays

### 32._get_datetime_distance() Function - Get Datetime Distance

**Function**: Get the distance between two datetime objects.

**Function Signature**:
```python
def _get_datetime_distance(date1, date2, max_, use_log_scale, log_scale_similarity_threshold):
```

**Parameter Description**:
- `date1` (datetime.datetime): The first datetime object
- `date2` (datetime.datetime): The second datetime object
- `max_` (int): The maximum value
- `use_log_scale` (bool): Whether to use log scale
- `log_scale_similarity_threshold` (float): The threshold for the similarity

**Return Value**: The distance between the two datetime objects

### 33._get_date_distance() Function - Get Date Distance

**Function**: Get the distance between two date objects.

**Function Signature**:
```python
def _get_date_distance(date1, date2, max_, use_log_scale, log_scale_similarity_threshold):
```

**Parameter Description**:
- `date1` (datetime.date): The first date object
- `date2` (datetime.date): The second date object
- `max_` (int): The maximum value
- `use_log_scale` (bool): Whether to use log scale
- `log_scale_similarity_threshold` (float): The threshold for the similarity

**Return Value**: The distance between the two date objects

### 34._get_timedelta_distance() Function - Get Timedelta Distance

**Function**: Get the distance between two timedelta objects.

**Function Signature**:
```python
def _get_timedelta_distance(timedelta1, timedelta2, max_, use_log_scale, log_scale_similarity_threshold):
```

**Parameter Description**:
- `timedelta1` (datetime.timedelta): The first timedelta object
- `timedelta2` (datetime.timedelta): The second timedelta object
- `max_` (int): The maximum value
- `use_log_scale` (bool): Whether to use log scale
- `log_scale_similarity_threshold` (float): The threshold for the similarity

**Return Value**: The distance between the two timedelta objects

### 35._get_time_distance() Function - Get Time Distance

**Function**: Get the distance between two time objects.

**Function Signature**:
```python
def _get_time_distance(time1, time2, max_, use_log_scale, log_scale_similarity_threshold):
```

**Parameter Description**:
- `time1` (datetime.time): The first time object
- `time2` (datetime.time): The second time object
- `max_` (int): The maximum value
- `use_log_scale` (bool): Whether to use log scale
- `log_scale_similarity_threshold` (float): The threshold for the similarity

**Return Value**: The distance between the two time objects

### 36._int_or_zero() Function - Int or Zero

**Function**: Extract a number from a string.

**Function Signature**:
```python
def _int_or_zero(value: str) -> int:
```

**Parameter Description**:
- `value` (str): The string to extract the number from

**Return Value**: The extracted number

### 37.add_to_frozen_set() Function - Add to Frozen Set

**Function**: Add an item to a frozen set.

**Function Signature**:
```python
def add_to_frozen_set(parents_ids: FrozenSet[int], item_id: int) -> FrozenSet[int]:
```

**Parameter Description**:
- `parents_ids` (FrozenSet[int]): The frozen set to add the item to
- `item_id` (int): The item to add to the frozen set

**Return Value**: The frozen set with the item added

### 38.convert_item_or_items_into_set_else_none() Function - Convert Item or Items into Set Else None

**Function**: Convert an item or items into a set.

**Function Signature**:
```python
def convert_item_or_items_into_set_else_none(items: Union[str, Iterable[str], None]) -> Optional[Set[str]]:
```

**Parameter Description**:
- `items` (Union[str, Iterable[str], None]): The items to convert into a set

**Return Value**: The set of items

### 39.convert_item_or_items_into_compiled_regexes_else_none() Function - Add Root to Paths

**Function**: Convert an item or items into a list of compiled regexes.

**Function Signature**:
```python
def convert_item_or_items_into_compiled_regexes_else_none(items: Union[str, Pattern[str], Iterable[Union[str, Pattern[str]]], None]) -> Optional[List[Pattern[str]]]:
```

**Parameter Description**:
- `items` (Union[str, Pattern[str], Iterable[Union[str, Pattern[str]]], None]): The items to convert into a list of compiled regexes

**Return Value**: The list of compiled regexes

### 40.get_type() Function - Get Type

**Function**: Get the type of an object.

**Function Signature**:
```python
def get_type(obj: Any) -> Type[Any]:
```

**Parameter Description**:
- `obj` (Any): The object to get the type of

**Return Value**: The type of the object

### 41.numpy_dtype_string_to_type() Function - Numpy Dtype String to Type

**Function**: Convert a numpy dtype string to a type.

**Function Signature**:
```python
def numpy_dtype_string_to_type(dtype_str: str) -> Type[Any]:
```

**Parameter Description**:
- `dtype_str` (str): The numpy dtype string to convert to a type

**Return Value**: The type of the numpy dtype string

### 42.type_in_type_group() Function - Type in Type Group

**Function**: Check if a type is in a type group.

**Function Signature**:
```python
def type_in_type_group(item: Any, type_group: Tuple[Type[Any], ...]) -> bool:
```

**Parameter Description**:
- `item` (Any): The item to check if it is in the type group
- `type_group` (Tuple[Type[Any], ...]): The type group to check if the item is in

**Return Value**: True if the item is in the type group, False otherwise

### 43.type_is_subclass_of_type_group() Function - Type is Subclass of Type Group

**Function**: Check if a type is a subclass of a type group.

**Function Signature**:
```python
def type_is_subclass_of_type_group(item: Any, type_group: Tuple[Type[Any], ...]) -> bool:
```

**Parameter Description**:
- `item` (Any): The item to check if it is a subclass of the type group
- `type_group` (Tuple[Type[Any], ...]): The type group to check if the item is a subclass of

**Return Value**: True if the item is a subclass of the type group, False otherwise

### 44.get_doc() Function - Get Doc

**Function**: Get the documentation for a module.

**Function Signature**:
```python
def get_doc(doc_filename: str) -> str:
```

**Parameter Description**:
- `doc_filename` (str): The filename of the documentation to get

**Return Value**: The documentation

### 45._eval_decimal() Function - Eval Decimal

**Function**: Evaluate a decimal.

**Function Signature**:
```python
def _eval_decimal(params: str) -> Decimal:
```

**Parameter Description**:
- `params` (str): The parameters to evaluate

**Return Value**: The evaluated decimal

### 46._eval_datetime() Function - Eval Datetime

**Function**: Evaluate a datetime.

**Function Signature**:
```python
def _eval_datetime(params: str) -> datetime.datetime:
```

**Parameter Description**:
- `params` (str): The parameters to evaluate

**Return Value**: The evaluated datetime

### 47._eval_date() Function - Eval Date

**Function**: Evaluate a date.

**Function Signature**:
```python
def _eval_date(params: str) -> datetime.date:
```

**Parameter Description**:
- `params` (str): The parameters to evaluate

**Return Value**: The evaluated date

### 48.time_to_seconds() Function - Time to Seconds

**Function**: Convert a time object to seconds.

**Function Signature**:
```python
def time_to_seconds(t: datetime.time) -> int:
```

**Parameter Description**:
- `t` (datetime.time): The time object to convert to seconds

**Return Value**: The time object converted to seconds

### 49.has_timezone() Function - Has Timezone

**Function**: Check if a datetime object has a timezone.

**Function Signature**:
```python
def has_timezone(dt: datetime.datetime) -> bool:
```

**Parameter Description**:
- `dt` (datetime.datetime): The datetime object to check if it has a timezone

**Return Value**: True if the datetime object has a timezone, False otherwise

### 50.get_homogeneous_numpy_compatible_type_of_seq() Function - Get Homogeneous Numpy Compatible Type of Sequence

**Function**: Get the homogeneous numpy compatible type of a sequence.

**Function Signature**:
```python
def get_homogeneous_numpy_compatible_type_of_seq(seq: Sequence[Any]) -> Union[Type[Any], Literal[False]]:
```

**Parameter Description**:
- `seq` (Sequence[Any]): The sequence to get the homogeneous numpy compatible type of

**Return Value**: The homogeneous numpy compatible type of the sequence

### 51.named_tuple_repr() Function - Named Tuple Repr

**Function**: Represent a named tuple.

**Function Signature**:
```python
def named_tuple_repr(self: NamedTuple) -> str:
```

**Parameter Description**:
- `self` (NamedTuple): The named tuple to represent

**Return Value**: The represented named tuple

### 52._report_progress() Function - Report Progress

**Function**: Report the progress of a comparison.

**Function Signature**:
```python
def _report_progress(_stats: Dict[str, Any], progress_logger: Callable[[str], None], duration: float) -> None:
```

**Parameter Description**:
- `_stats` (Dict[str, Any]): The statistics of the comparison
- `progress_logger` (Callable[[str], None]): The progress logger
- `duration` (float): The duration of the comparison

**Return Value**: None

### 53.sha1hex() Function - SHA1 Hex

**Function**: Convert a string to a SHA1 hash.

**Function Signature**:
```python
def sha1hex(obj: Union[str, bytes]) -> str:
```

**Parameter Description**:
- `text` (str): The string to convert to a SHA1 hash

**Return Value**: The SHA1 hash

### 54._get_nested_obj() Function - Get Nested Obj

**Function**: Get a nested object.

**Function Signature**:
```python
def _get_nested_obj(obj, elements, next_element=None):
```

**Parameter Description**:
- `obj` (Any): The object to get the nested object from
- `elements` (List[Tuple[Any, str]]): The elements of the path
- `next_element` (Any): The next element of the path

**Return Value**: The nested object

### 55._guess_type() Function - Guess Type

**Function**: Guess the type of an object.

**Function Signature**:
```python
def _guess_type(elements, elem, index, next_element):
```

**Parameter Description**:
- `elements` (List[Tuple[Any, str]]): The elements of the path
- `elem` (str): The element to guess the type of
- `index` (int): The index of the element
- `next_element` (Any): The next element of the path

**Return Value**: The guessed type of the object

### 56.check_elem() Function - Check Elem

**Function**: Check if an element is valid.

**Function Signature**:
```python
def check_elem(elem) -> None:
```

**Parameter Description**:
- `elem` (Any): The element to check if it is valid

**Return Value**: None

### 57._get_nested_obj_and_force() Function - Get Nested Obj and Force

**Function**: Get a nested object and force it to be a dictionary.

**Function Signature**:
```python
def _get_nested_obj_and_force(obj, elements, next_element=None):
```

**Parameter Description**:
- `obj` (Any): The object to get the nested object from
- `elements` (List[Tuple[Any, str]]): The elements of the path
- `next_element` (Optional[Any]): The next element of the path

**Return Value**: The nested object

### 58.stringify_element() Function - Stringify Element

**Function**: Stringify an element.

**Function Signature**:
```python
def stringify_element(param, quote_str=None) -> str:
```

**Parameter Description**:
- `param` (Any): The element to stringify
- `quote_str` (Optional[str]): The quote string

**Return Value**: The stringified element

### 59._get_pretty_form_text() Function - Get Pretty Form Text

**Function**: Get the pretty form text.

**Function Signature**:
```python
def _get_pretty_form_text(verbose_level) -> str:
```

**Parameter Description**:
- `verbose_level` (int): The verbose level

**Return Value**: The pretty form text

### 60.save_content_to_path() Function - Save Content to Path

**Function**: Save content to a path.

**Function Signature**:
```python
def save_content_to_path(content, path, file_type=None, keep_backup=True) -> None:
```

**Parameter Description**:
- `content` (Any): The content to save
- `path` (str): The path to save the content to
- `file_type` (Optional[str]): The file type to save the content as
- `keep_backup` (bool): Whether to keep the backup

**Return Value**: None

### 61._save_content() Function - Save Content

**Function**: Save content to a path.

**Function Signature**:
```python
def _save_content(content, path, file_type, keep_backup=True) -> None:
```

**Parameter Description**:
- `content` (Any): The content to save
- `path` (str): The path to save the content to
- `file_type` (Optional[str]): The file type to save the content as
- `keep_backup` (bool): Whether to keep the backup

**Return Value**: None

### 62._serialize_decimal() Function - Serialize Decimal

**Function**: Serialize a decimal.

**Function Signature**:
```python
def _serialize_decimal(value) -> str:
```

**Parameter Description**:
- `value` (Decimal): The decimal to serialize

**Return Value**: The serialized decimal

### 63._serialize_tuple() Function - Serialize Tuple

**Function**: Serialize a tuple.

**Function Signature**:
```python
def _serialize_tuple(value) -> str:
```

**Parameter Description**:
- `value` (Tuple): The tuple to serialize

**Return Value**: The serialized tuple

### 64._serialize_bytes() Function - Serialize Bytes

**Function**: Serialize a bytes object.

**Function Signature**:
```python
def _serialize_bytes(value) -> str:
```

**Parameter Description**:
- `value` (bytes): The bytes object to serialize

**Return Value**: The serialized bytes object

### 65.json_convertor_default() Function - JSON Convertor Default

**Function**: Convert a default object to a JSON object.

**Function Signature**:
```python
def json_convertor_default(default_mapping=None) -> Callable:
```

**Parameter Description**:
- `default_mapping` (Optional[dict]): The default mapping to convert the object to

**Return Value**: The JSON convertor default

### 66.ensure_dir() Function - Ensure Dir

**Function**: Ensure a directory exists.

**Function Signature**:
```python
def ensure_dir(file_path) -> None:
```

**Parameter Description**:
- `file_path` (str): The path to ensure exists

**Return Value**: None

### 67.delete_dir_contents() Function - Delete Dir Contents

**Function**: Delete the contents of a directory.

**Function Signature**:
```python
def delete_dir_contents(directory) -> None:
```

**Parameter Description**:
- `directory` (str): The directory to delete the contents of

**Return Value**: None

#### 68. `ColoredView` class - JSON Difference Color-coded View

**Function**: Display JSON data with color-coded differences

**Class Definition**:
```python
class ColoredView:
    def __init__(self, t2: Any, tree_result: TreeResult, compact: bool = False) -> None
```

**Key Parameters**:
- `t2` (Any): JSON data object to display
- `tree_result` (TreeResult): Tree difference comparison result
- `compact` (bool): Whether to display in compact mode, defaults to False

**Attributes**:
- `diff_paths` (Dict[str, str]): Dictionary storing all difference paths and their types

**Methods**:

1. `_collect_diff_paths() -> Dict[str, str]`
   - **Function**: Collect all paths with differences and their types
   - **Returns**: Dictionary containing difference paths and types
   - **Details**: Extracts different types of differences from TextResult (value changes, type changes, added items, removed items)

2. `_format_value(value: Any) -> str`
   - **Function**: Format value for display
   - **Parameters**: 
     - `value`: Any value to format
   - **Returns**: Formatted string
   - **Details**: Handles different types like boolean, string, dictionary, list, etc.

3. `_get_path_removed(path: str) -> dict`
   - **Function**: Get all removed items for a given path
   - **Parameters**:
     - `path`: Path to check
   - **Returns**: Dictionary containing removed items

4. `_has_differences(path_prefix: str) -> bool`
   - **Function**: Check if a path prefix has any differences under it
   - **Parameters**:
     - `path_prefix`: Path prefix to check
   - **Returns**: Boolean value indicating whether differences exist

5. `_colorize_json(obj: Any, path: str = 'root', indent: int = 0) -> str`
   - **Function**: Recursively colorize JSON based on differences, with pretty-printing
   - **Parameters**:
     - `obj`: Object to colorize
     - `path`: Current path, defaults to 'root'
     - `indent`: Indentation level, defaults to 0
   - **Returns**: Color-coded JSON string
   - **Details**: Uses red to mark removed/old values, green to mark added/new values

6. `__str__() -> str`
   - **Function**: Return color-coded, pretty-printed JSON string
   - **Returns**: Formatted string

7. `__iter__()`
   - **Function**: Make the view iterable by yielding tree result items


#### 69. `DistanceMixin` class - Distance Calculation Mixin

**Function**: Provides methods to calculate the difference distance between two objects

**Class Definition**:
```python
class DistanceMixin:
```

**Methods**:

1. `_get_rough_distance(self: "DistanceProtocol") -> float`
   - **Function**: Calculate numerical distance between t1 and t2 based on number of conversion operations needed
   - **Returns**: Float distance value between 0 and 1
   - **Details**: 
     - Distance 0 means objects are equal, distance 1 means very different
     - Similar to Levenshtein Edit Distance but for structured data
     - Current algorithm based on number of operations needed to convert t1 to t2 divided by number of items in t1 and t2

2. `__get_item_rough_length(self: "DistanceProtocol", item, parent='root') -> int`
   - **Function**: Get rough length of an item, used for calculating rough distance between objects
   - **Parameters**:
     - `item`: Item to calculate length for
     - `parent`: Only used for DeepHash reporting purposes
   - **Returns**: Rough length of the item
   - **Exceptions**: Throws `RuntimeError` if no hash cache exists

3. `__calculate_item_deephash(self: "DistanceProtocol", item: Any) -> None`
   - **Function**: Calculate DeepHash value for an item
   - **Parameters**:
     - `item`: Item to calculate hash for
   - **Details**: Uses DeepHash to calculate and store item's hash value

4. `_precalculate_distance_by_custom_compare_func(self: "DistanceProtocol", hashes_added, hashes_removed, t1_hashtable, t2_hashtable, _original_type) -> dict`
   - **Function**: Pre-calculate distances using custom comparison function
   - **Parameters**:
     - `hashes_added`: List of hashes for added items
     - `hashes_removed`: List of hashes for removed items
     - `t1_hashtable`: Hash table for t1
     - `t2_hashtable`: Hash table for t2
     - `_original_type`: Original type
   - **Returns**: Dictionary of pre-calculated distances
   - **Details**: Pairwise comparison of added and removed items using custom comparison function

5. `_precalculate_numpy_arrays_distance(self: "DistanceProtocol", hashes_added, hashes_removed, t1_hashtable, t2_hashtable, _original_type) -> dict`
   - **Function**: Pre-calculate distances between numpy arrays
   - **Parameters**: Same as above
   - **Returns**: Dictionary of distances between numpy arrays
   - **Details**: 
     - Only handles 1D arrays
     - Uses numpy array operations and Cartesian product to calculate distances
     - Supports log scale distance calculation
        

### 70.DoesNotExist Class

**Function**: Not implemented.

**Class Definition**:
```python
class DoesNotExist(Exception):
    """
    Exception raised when a required item does not exist
    
    Used in various contexts where an expected item or value is not found.
    """
    pass
```

### 71.ResultDict Class

**Function**: A dictionary that represents a result.

**Class Definition**:
```python
class ResultDict(RemapDict):
    """
    Base class for result dictionaries
    
    Used to store and manipulate comparison results from DeepDiff.
    """

    def remove_empty_keys(self) -> None:
        """
        Remove empty keys from this object. Should always be called after the result is final.
        :return:
        """
```

### 72.DeltaResult Class

**Function**: A result that represents a delta.

**Class Definition**:
```python
class DeltaResult(TextResult):
    """
    Result format for Delta operations
    
    Specifically designed for storing and displaying results of Delta operations.
    """
    ADD_QUOTES_TO_STRINGS: bool = False

    def __init__(self, tree_results: Optional['TreeResult'] = None, ignore_order: Optional[bool] = None, always_include_values: bool = False, _iterable_opcodes: Optional[Dict[str, Any]] = None) -> None:
        self.ignore_order = ignore_order
        self.always_include_values = always_include_values

        self.update({
            "type_changes": dict_(),
            "dictionary_item_added": dict_(),
            "dictionary_item_removed": dict_(),
            "values_changed": dict_(),
            "iterable_item_added": dict_(),
            "iterable_item_removed": dict_(),
            "iterable_item_moved": dict_(),
            "attribute_added": dict_(),
            "attribute_removed": dict_(),
            "set_item_removed": dict_(),
            "set_item_added": dict_(),
            "iterable_items_added_at_indexes": dict_(),
            "iterable_items_removed_at_indexes": dict_(),
            "_iterable_opcodes": _iterable_opcodes or {},
        })

        if tree_results:
            self._from_tree_results(tree_results)

    def _from_tree_results(self, tree):
        """
        Populate this object by parsing an existing reference-style result dictionary.
        :param tree: A TreeResult
        :return:
        """
        

    def _from_tree_iterable_item_added_or_removed(self, tree, report_type, delta_report_key):
        """
        Process iterable items added or removed from tree
        
        Args:
            tree: Tree structure to process
            report_type: Type of report
            delta_report_key: Key for delta report
        """
        

    def _from_tree_type_changes(self, tree):
        """
        Process type changes from tree
        
        Args:
            tree: Tree structure to process
        """
        

    def _from_tree_value_changed(self, tree):
        """
        Process value changes from tree
        
        Args:
            tree: Tree structure to process
        """
        
                # If we ever want to store the difflib results instead of the new_value
                # these lines need to be uncommented and the Delta object needs to be able
                # to use them.
                # if 'diff' in change.additional:
                #     the_changed.update({'diff': change.additional['diff']})

    def _from_tree_repetition_change(self, tree):
        """
        Process repetition changes from tree
        
        Args:
            tree: Tree structure to process
        """
        
    def _from_tree_iterable_item_moved(self, tree):
        """
        Process iterable item moves from tree
        
        Args:
            tree: Tree structure to process
        """
        
```

### 73.NumpyArrayRelationship Class

**Function**: A relationship that describes the relationship between a container object (the "parent") and the contained "child" object.

**Class Definition**:
```python
class NumpyArrayRelationship(ChildRelationship):
    """
    Specific implementation of NumPy array relationships
    
    Describes relationships between elements in NumPy arrays.
    """

```

### 74.InaccessibleRelationship Class

**Function**: Not implemented.

**Class Definition**:
```python
class InaccessibleRelationship(ChildRelationship):
    """
    Base class for inaccessible relationships
    
    Used for relationships that cannot be directly accessed or represented as strings.
    """
    pass
```

### 75.SetRelationship Class

**Function**: Not implemented.

**Class Definition**:
```python
class SetRelationship(InaccessibleRelationship):
    """
    Specific implementation of set relationships
    
    Describes relationships between elements in sets (set elements cannot 
    be directly accessed).
    """
    pass
```

### 76.np_type Class

**Function**: Not implemented.

**Class Definition**:
```python
class np_type:
    pass
```

### 77.pydantic_base_model_type Class

**Function**: Not implemented.

**Class Definition**:
```python
class pydantic_base_model_type:
    pass
```

### 78.EnumBase Class

**Function**: A base class for enums.

**Class Definition**:
```python
class EnumBase(str, enum.Enum):
    def __repr__(self) -> str:
        """
        We need to add a single quotes so we can easily copy the value when we do ipdb.
        """
        

    def __str__(self) -> str:
```

### 79.IndexedHash Class

**Function**: A class that represents an indexed hash.

**Class Definition**:
```python
class IndexedHash(NamedTuple):
    """
    Indexed hash item
    
    Stores hash values with corresponding index information.
    """
    indexes: List[Any]
    item: Any
```

### 80.ListItemRemovedOrAdded Class

**Function**: Not implemented.

**Class Definition**:
```python
class ListItemRemovedOrAdded:
    pass
```

### 81.OtherTypes Class

**Function**: A class that represents other types.

**Class Definition**:
```python
class OtherTypes:
    def __repr__(self) -> str:
        
```

### 82.Skipped Class

**Function**: Not implemented.

**Class Definition**:
```python
class Skipped(OtherTypes):
    pass
```

### 83.Unprocessed Class

**Function**: Not implemented.

**Class Definition**:
```python
class Unprocessed(OtherTypes):
    pass
```

### 84.NotHashed Class

**Function**: Not implemented.

**Class Definition**:
```python
class NotHashed(OtherTypes):
    pass
```

### 85.NotPresent Class

**Function**: A class that represents a not present object.

**Class Definition**:
```python
class NotPresent:  # pragma: no cover
    """
    In a change tree, this indicated that a previously existing object has been removed -- or will only be added
    in the future.
    We previously used None for this but this caused problem when users actually added and removed None. Srsly guys? :D
    """

    def __repr__(self) -> str:
        
```

### 86.indexed_set Class

**Function**: A set class that lets you get an item by index.

**Class Definition**:
```python
class indexed_set(set):
    """
    A set class that lets you get an item by index

    >>> a = indexed_set()
    >>> a.add(10)
    >>> a.add(20)
    >>> a[0]
    10
    """
```

### 87.DeepDiffDeprecationWarning Class

**Function**: A warning that is raised when a deprecated feature is used.

**Class Definition**:
```python
class DeepDiffDeprecationWarning(DeprecationWarning):
    pass
```

### 88._NotFound Class

**Function**: A class that represents a not found object.

**Class Definition**:
```python
class _NotFound:

    def __eq__(self, other: Any) -> bool:
        return False

    __req__ = __eq__

    def __repr__(self) -> str:
        return 'not found'

    __str__ = __repr__


not_found = _NotFound()

warnings.simplefilter('once', DeepDiffDeprecationWarning)

```

### 89.RepeatedTimer Class

**Function**: A threaded repeated timer.

**Class Definition**:
```python
class RepeatedTimer:
    """
    Threaded Repeated Timer by MestreLion
    https://stackoverflow.com/a/38317060/1497443
    """

    def __init__(self, interval: float, function: Callable[..., Any], *args: Any, **kwargs: Any) -> None:
        self._timer = None
        self.interval = interval
        self.function = function
        self.args = args
        self.start_time = time.time()
        self.kwargs = kwargs
        self.is_running = False
        self.start()

    def _get_duration_sec(self) -> int:
        """
        Get duration in seconds
        
        Returns:
            int: Duration in seconds
        """


    def _run(self) -> None:
        """
        Run the timer function
        """

    def start(self) -> None:
        """
        Start the timer
        """


    def stop(self) -> int:
        """
        Stop the timer
        
        Returns:
            int: Duration in seconds
        """

```

### 90.OpcodeTag Class

**Function**: A tag that represents an opcode.

**Class Definition**:
```python
class OpcodeTag(EnumBase):
    insert = 'insert'
    delete = 'delete'
    equal = 'equal'
    replace = 'replace'  # type: ignore
    # swapped = 'swapped'  # in the future we should support reporting of items swapped with each other


```

### 91.CacheNode Class

**Function**: A node that represents a cache.

**Class Definition**:
```python
class CacheNode:
    """
    Node in the LFU cache structure
    
    Represents a single cache entry with frequency tracking and linked list pointers.
    """
    def __init__(self, key, report_type, value, freq_node, pre, nxt):
        self.key = key
        if report_type:
            self.content = defaultdict(SetOrdered)
            self.content[report_type].add(value)
        else:
            self.content = value
        self.freq_node = freq_node
        self.pre = pre  # previous CacheNode
        self.nxt = nxt  # next CacheNode

    def free_myself(self):
        """
        Free the cache node from the linked list
        """
        
```    

### 92.FreqNode Class

**Function**: A node that represents a frequency.

**Class Definition**:
```python
class FreqNode:
    """
    Frequency node in the LFU cache structure
    
    Represents a frequency level with associated cache nodes and linked list pointers.
    """
    def __init__(self, freq, pre, nxt):
        self.freq = freq
        self.pre = pre  # previous FreqNode
        self.nxt = nxt  # next FreqNode
        self.cache_head = None  # CacheNode head under this FreqNode
        self.cache_tail = None  # CacheNode tail under this FreqNode

    def count_caches(self):
        """
        Count the number of cache nodes under this frequency node
        
        Returns:
            int: Number of cache nodes
        """


    def remove(self):
        """
        Remove this frequency node from the linked list
        """



    def pop_head_cache(self):
        """
        Pop the head cache node from this frequency node
        
        Returns:
            CacheNode: The head cache node
        """


    def append_cache_to_tail(self, cache_node):
        """
        Append a cache node to the tail of this frequency node
        
        Args:
            cache_node: Cache node to append
        """


    def insert_after_me(self, freq_node):
        """
        Insert a frequency node after this one
        
        Args:
            freq_node: Frequency node to insert
        """


    def insert_before_me(self, freq_node):
        """
        Insert a frequency node before this one
        
        Args:
            freq_node: Frequency node to insert
        """
```

### 93.DummyLFU Class

**Function**: A dummy LFU.

**Class Definition**:
```python
class DummyLFU:
    """
    Dummy LFU cache implementation
    
    A no-op cache implementation used when caching is disabled.
    """

```

### 94.DeepDiffProtocol Class

**Function**: A protocol that represents a deep diff.

**Class Definition**:
```python
class DeepDiffProtocol(Protocol):
    t1: Any
    t2: Any
    cutoff_distance_for_pairs: float
    use_log_scale: bool
    log_scale_similarity_threshold: float
    view: str
    math_epsilon: Optional[float]
```

### 95.SerializationMixin Class

**Function**: A mixin that provides serialization functionality.

**Class Definition**:
```python
class SerializationMixin:
    """
    Mixin class providing serialization functionality
    
    Adds methods for converting DeepDiff objects to various serialized formats 
    including JSON, pickle, and other formats.
    """

    def to_json_pickle(self):
        """
        :ref:`to_json_pickle_label`
        Get the json pickle of the diff object. Unless you need all the attributes and functionality of DeepDiff, running to_json() is the safer option that json pickle.
        """
        try:

        except ImportError:  # pragma: no cover. Json pickle is getting deprecated.


    @classmethod
    def from_json_pickle(cls, value):
        """
        :ref:`from_json_pickle_label`
        Load DeepDiff object with all the bells and whistles from the json pickle dump.
        Note that json pickle dump comes from to_json_pickle
        """
        try:

        except ImportError:  # pragma: no cover. Json pickle is getting deprecated.


    def to_json(self, default_mapping: Optional[dict]=None, force_use_builtin_json=False, **kwargs):
        """
        Dump json of the text view.
        **Parameters**

        default_mapping : dictionary(optional), a dictionary of mapping of different types to json types.

        by default DeepDiff converts certain data types. For example Decimals into floats so they can be exported into json.
        If you have a certain object type that the json serializer can not serialize it, please pass the appropriate type
        conversion through this dictionary.

        force_use_builtin_json: Boolean, default = False
            When True, we use Python's builtin Json library for serialization,
            even if Orjson is installed.


        kwargs: Any other kwargs you pass will be passed on to Python's json.dumps()

        **Example**

        Serialize custom objects
            >>> class A:
            ...     pass
            ...
            >>> class B:
            ...     pass
            ...
            >>> t1 = A()
            >>> t2 = B()
            >>> ddiff = DeepDiff(t1, t2)
            >>> ddiff.to_json()
            TypeError: We do not know how to convert <__main__.A object at 0x10648> of type <class '__main__.A'> for json serialization. Please pass the default_mapping parameter with proper mapping of the object to a basic python type.

            >>> default_mapping = {A: lambda x: 'obj A', B: lambda x: 'obj B'}
            >>> ddiff.to_json(default_mapping=default_mapping)
            '{"type_changes": {"root": {"old_type": "A", "new_type": "B", "old_value": "obj A", "new_value": "obj B"}}}'
        """


    def to_dict(self, view_override: Optional[str]=None) -> dict:
        """
        convert the result to a python dictionary. You can override the view type by passing view_override.

        **Parameters**

        view_override: view type, default=None,
            override the view that was used to generate the diff when converting to the dictionary.
            The options are the text or tree.
        """

    def _to_delta_dict(
        self,
        directed: bool = True,
        report_repetition_required: bool = True,
        always_include_values: bool = False,
    ) -> dict:
        """
        Dump to a dictionary suitable for delta usage.
        Unlike to_dict, this is not dependent on the original view that the user chose to create the diff.

        **Parameters**

        directed : Boolean, default=True, whether to create a directional delta dictionary or a symmetrical

        Note that in the current implementation the symmetrical delta (non-directional) is ONLY used for verifying that
        the delta is being applied to the exact same values as what was used to generate the delta and has
        no other usages.

        If this option is set as True, then the dictionary will not have the "old_value" in the output.
        Otherwise it will have the "old_value". "old_value" is the value of the item in t1.

        If delta = Delta(DeepDiff(t1, t2)) then
        t1 + delta == t2

        Note that it the items in t1 + delta might have slightly different order of items than t2 if ignore_order
        was set to be True in the diff object.

        """
       

    def pretty(self, prefix: Optional[Union[str, Callable]]=None):
        """
        The pretty human readable string output for the diff object
        regardless of what view was used to generate the diff.

        prefix can be a callable or a string or None.

        Example:
            >>> t1={1,2,4}
            >>> t2={2,3}
            >>> print(DeepDiff(t1, t2).pretty())
            Item root[3] added to set.
            Item root[4] removed from set.
            Item root[1] removed from set.
        """

```

### 96._RestrictedUnpickler Class

**Function**: A unpickler that restricts the classes that can be loaded.

**Class Definition**:
```python
class _RestrictedUnpickler(pickle.Unpickler):

    def __init__(self, *args, **kwargs):
        self.safe_to_import = kwargs.pop('safe_to_import', None)
        if self.safe_to_import:
            if isinstance(self.safe_to_import, strings):
                self.safe_to_import = set([self.safe_to_import])
            elif isinstance(self.safe_to_import, (set, frozenset)):
                pass
            else:
                self.safe_to_import = set(self.safe_to_import)
            self.safe_to_import = self.safe_to_import | SAFE_TO_IMPORT
        else:
            self.safe_to_import = SAFE_TO_IMPORT
        super().__init__(*args, **kwargs)

    def find_class(self, module, name):
        """
        Find and load a class from a module
        
        Args:
            module: Module name
            name: Class name
            
        Returns:
            class: The loaded class
            
        Raises:
            pickle.UnpicklingError: If class is not safe to import
        """
        # Only allow safe classes from self.safe_to_import.
        
    def persistent_load(self, pid):
        """
        Load a persistent object by ID
        
        Args:
            pid: Persistent object ID
            
        Returns:
            object: The loaded persistent object
        """
```

### 97._RestrictedPickler Class

**Function**: A pickler that restricts the classes that can be serialized.

**Class Definition**:
```python

class _RestrictedPickler(pickle.Pickler):
    def persistent_id(self, obj):
        if obj is NONE_TYPE:  # NOQA
            return "<<NoneType>>"
        return None

```

### 98.JSONDecoder Class

**Function**: A decoder that decodes JSON.

**Class Definition**:
```python
class JSONDecoder(json.JSONDecoder):

    def __init__(self, *args, **kwargs):
        json.JSONDecoder.__init__(self, object_hook=self.object_hook, *args, **kwargs)

    def object_hook(self, obj):  # type: ignore
        """
        Object hook for JSON decoding
        
        Args:
            obj: Object to process
            
        Returns:
            object: Processed object
        """
```
#### 99 FIXTURES_DIR constant

**Function**: The path to the fixtures directory.
**Value**: os.path.join(os.path.dirname(__file__), 'tests/fixtures/')
**Type**: String

### 100.GREEN constant

**Function**: The green color.
**Value**: '\033[92m'
**Type**: String

### 101.RESET constant

**Function**: The reset color.
**Value**: '\033[0m'
**Type**: String

### 102.TYPES_TO_DIST_FUNC constant

**Function**: The types to distance function.
**Value**: [(only_numbers, _get_numbers_distance), (datetime.datetime, _get_datetime_distance), (datetime.date, _get_date_distance), (datetime.timedelta, _get_timedelta_distance), (datetime.time, _get_time_distance)]
**Type**: List of tuples

### 103.FORCE_DEFAULT constant

**Function**: The force default.
**Value**: 'fake'
**Type**: Literal

### 104.UP_DOWN constant

**Function**: The up down.
**Value**: ('UP', 'DOWN')
**Type**: Tuple

### 105.REPORT_KEYS constant

**Function**: The report keys.
**Value**: ('type_changes', 'values_changed', 'iterable_item_added', 'iterable_item_removed', 'iterable_item_moved', 'iterable_items_inserted', 'iterable_items_deleted', 'iterable_items_replaced', 'iterable_items_equal', 'dictionary_item_added', 'dictionary_item_removed', 'attribute_removed', 'attribute_added', 'initiated')
**Type**: Tuple

### 106.CUSTOM_FIELD constant

**Function**: The custom field.
**Value**: 'custom_field'
**Type**: String

### 107.NUMERICS constant

**Function**: The numerics.
**Value**: ('int', 'float', 'complex', 'Decimal')
**Type**: Tuple

### 108.ID_PREFIX constant

**Function**: The id prefix.
**Value**: 'id_'
**Type**: String

### 109.KEY_TO_VAL_STR constant

**Function**: The key to value string.
**Value**: 'key_to_val_str'
**Type**: String

### 110.TREE_VIEW constant

**Function**: The tree view.
**Value**: 'tree'
**Type**: String

### 111.COLORED_VIEW constant

**Function**: The colored view.
**Value**: 'colored'
**Type**: String

### 112.COLORED_COMPACT_VIEW constant

**Function**: The colored compact view.
**Value**: 'colored_compact'
**Type**: String

### 113.RE_COMPILED_TYPE constant

**Function**: The re compiled type.
**Value**: type(re.compile(''))
**Type**: Type

### 114.LITERAL_EVAL_PRE_PROCESS constant

**Function**: The literal eval pre process.
**Value**: [('Decimal(', ')', _eval_decimal), ('datetime.datetime(', ')', _eval_datetime), ('datetime.date(', ')', _eval_date)]
**Type**: List of tuples

### 115.PYTHON_TYPE_TO_NUMPY_TYPE constant

**Function**: The python type to numpy type.
**Value**: {
    'int': np.int32,
    'float': np.float32,
    'complex': np.complex64,
    'Decimal': np.float64,
}
**Type**: Dictionary

### 116.OPCODE_TAG_TO_FLAT_DATA_ACTION constant

**Function**: The opcode tag to flat data action.
**Value**: {
    'ADD': 'add',
    'REMOVE': 'remove',
    'REPLACE': 'replace',
    'EQUAL': 'equal',
    'MOVE': 'move',
    'INSERT': 'insert',
    'DELETE': 'delete',
}
**Type**: Dictionary

### 117.FLAT_DATA_ACTION_TO_OPCODE_TAG constant

**Function**: The flat data action to opcode tag.
**Value**: {
    'add': 'ADD',
    'remove': 'REMOVE',
    'replace': 'REPLACE',
    'equal': 'EQUAL',
    'move': 'MOVE',
    'insert': 'INSERT',
    'delete': 'DELETE',
}
**Type**: Dictionary

### 118.TYPE_CHANGE_FAIL_MSG constant

**Function**: The type change fail message.
**Value**: 'Unable to do the type change for {} from to type {} due to {}'
**Type**: String

### 119.DELTA_NUMPY_OPERATOR_OVERRIDE_MSG constant

**Function**: The delta numpy operator override message.
**Value**: 'A numpy ndarray is most likely being added to a delta. Due to Numpy override the + operator, you can only do: delta + ndarray and NOT ndarray + delta'
**Type**: String

### 120.UNABLE_TO_GET_ITEM_MSG constant

**Function**: The unable to get item message.
**Value**: 'Unable to get the item at {}: {}'
**Type**: String

### 121.UNABLE_TO_GET_PATH_MSG constant

**Function**: The unable to get path message.
**Value**: 'Unable to get the item at {}'
**Type**: String

### 122.NUMPY_TO_LIST constant

**Function**: The numpy to list.
**Value**: 'NUMPY_TO_LIST'
**Type**: String

### 123.MAX_PASSES_REACHED_MSG constant

**Function**: The max passes reached message.
**Value**: 'Max passes reached. The maximum number of passes has been reached.'
**Type**: String

### 124.MAX_DIFFS_REACHED_MSG constant

**Function**: The max diffs reached message.
**Value**: 'Max diffs reached. The maximum number of diffs has been reached.'
**Type**: String

### 125.DISTANCE_CACHE_HIT_COUNT constant

**Function**: The distance cache hit count.
**Value**: 'DISTANCE CACHE HIT COUNT'
**Type**: String

### 126.DIFF_COUNT constant

**Function**: The diff count.
**Value**: 'DIFF COUNT'
**Type**: String

### 127.PASSES_COUNT constant

**Function**: The passes count.
## Detailed Explanation of Configuration Classes
**Value**: 'PASSES COUNT'
**Type**: String

### 128.MAX_PASS_LIMIT_REACHED constant

**Function**: The max pass limit reached.
**Value**: 'MAX PASS LIMIT REACHED'
**Type**: String

### 129.MAX_DIFF_LIMIT_REACHED constant

**Function**: The max diff limit reached.
**Value**: 'MAX DIFF LIMIT REACHED'
**Type**: String

### 130.DISTANCE_CACHE_ENABLED constant

**Function**: The distance cache enabled.
**Value**: 'DISTANCE CACHE ENABLED'
**Type**: String

### 131.PREVIOUS_DIFF_COUNT constant

**Function**: The previous diff count.
**Value**: 'PREVIOUS DIFF COUNT'
**Type**: String

### 132.PREVIOUS_DISTANCE_CACHE_HIT_COUNT constant

**Function**: The previous distance cache hit count.
**Value**: 'PREVIOUS DISTANCE CACHE HIT COUNT'
**Type**: String

### 133.CANT_FIND_NUMPY_MSG constant

**Function**: The cant find numpy message.
**Value**: 'Unable to import numpy. This must be a bug in DeepDiff since a numpy array is detected.'
**Type**: String

### 134._ENABLE_CACHE_EVERY_X_DIFF constant

**Function**: The enable cache every x diff.
**Value**: '_ENABLE_CACHE_EVERY_X_DIFF'
**Type**: String

### 135.CUTOFF_DISTANCE_FOR_PAIRS_DEFAULT constant

**Function**: The cutoff distance for pairs default.
**Value**: 0.3
**Type**: Float

### 136.CUTOFF_INTERSECTION_FOR_PAIRS_DEFAULT constant

**Function**: The cutoff intersection for pairs default.
**Value**: 0.7
**Type**: Float

### 137.DEEPHASH_PARAM_KEYS constant

**Function**: The deephash param keys.
**Value**: ('exclude_types', 'exclude_paths', 'include_paths', 'exclude_regex_paths', 'hasher', 'significant_digits', 'number_format_notation', 'ignore_string_type_changes', 'ignore_numeric_type_changes', 'ignore_uuid_types', 'use_enum_value', 'ignore_type_in_groups', 'ignore_type_subclasses', 'ignore_string_case', 'exclude_obj_callback', 'ignore_private_variables', 'encodings', 'ignore_encoding_errors', 'default_timezone', 'custom_operators')
**Type**: Tuple

### 138.EMPTY_FROZENSET constant

**Function**: The empty frozen set.
**Value**: frozenset()
**Type**: FrozenSet

### 139.INDEX_VS_ATTRIBUTE constant

**Function**: The index vs attribute.
**Value**: 'INDEX_VS_ATTRIBUTE'
**Type**: String

### 140.DEFAULT_FIRST_ELEMENT constant

**Function**: The default first element.
**Value**: 0
**Type**: Int

### 141.DEFAULT_SIGNIFICANT_DIGITS_WHEN_IGNORE_NUMERIC_TYPES constant

**Function**: The default significant digits when ignore numeric types.
**Value**: 6
**Type**: Int

### 142.TYPE_STABILIZATION_MSG constant

**Function**: The type stabilization message.
**Value**: 'Type stabilization: {} -> {}'
**Type**: String

### 143.NONE_TYPE constant

**Function**: The none type.
**Value**: 'None'
**Type**: String

### 144.CSV_HEADER_MAX_CHUNK_SIZE constant

**Function**: The csv header max chunk size.
**Value**: 10000
**Type**: Int

### 145.TYPE_STR_TO_TYPE constant

**Function**: The type str to type.
**Value**: {
    'range': range,
    'complex': complex,
    'set': set,
    'frozenset': frozenset,
    'slice': slice,
    'str': str,
    'bytes': bytes,
    'list': list,
    'tuple': tuple,
    'int': int,
    'float': float,
    'dict': dict,
    'bool': bool,
    'bin': bin,
    'None': None,
    'NoneType': None,
    'datetime': datetime.datetime,
    'time': datetime.time,
    'timedelta': datetime.timedelta,
    'Decimal': decimal.Decimal,
    'SetOrdered': SetOrdered,
    'namedtuple': collections.namedtuple,
    'OrderedDict': collections.OrderedDict,
    'Pattern': re.Pattern,
    'iprange': str,
    'IPv4Address': ipaddress.IPv4Address,
    'IPv6Address': ipaddress.IPv6Address,
    'KeysView': list,
}
**Type**: Dictionary

### 146.JSON_CONVERTOR constant

**Function**: The json convertor.
**Value**: json_convertor_default(default_mapping=None)
**Type**: Function

### 147.CACHE_PATH constant

**Function**: The cache path.
**Value**: os.path.join(os.path.dirname(__file__), 'cache')
**Type**: String


### 148.DOC_VERSION constant

**Function**: The doc version.
**Value**: '0.1.0'
**Type**: String

### 149.NumberType Type Aliases
**Value**: Union[int, float, complex, Decimal, datetime.datetime, datetime.date, datetime.timedelta, datetime.time, Any]
**Type**: Union

### 150.UnkownValueCode Type Alias
**Value**: 'unknown___'
**Type**: String

### 151.HashableType Type Alias
**Value**: Union[str, int, float, bytes, bool, tuple, frozenset, type(None)]
**Type**: Union

### 152.HashResult Type Alias
**Value**: Union[str, Any]
**Type**: Union

### 153.HashTuple Type Alias
**Value**: Tuple[HashResult, int]
**Type**: Tuple

### 154.HashesDict Type Alias
**Value**: Dict[Any, Union[HashTuple, List[Any]]]
**Type**: Dict

### 155.PathType Type Alias
**Value**: Union[str, List[str], Set[str]]
**Type**: Union

### 156.RegexType Type Alias
**Value**: Union[str, re.Pattern[str], List[Union[str, re.Pattern[str]]]]
**Type**: Union

### 157.NumberToStringFunc Type Alias
**Value**: Callable[..., str]
**Type**: Callable

### 158.mypy() Function

**Function**: Run mypy.

**Function Signature**:
```python
@nox.session
def mypy(session) -> None:
    """Run mypy."""
```

**Parameter Description**:
- `session` (nox.Session): The nox session

**Return Value**: None

### 159.cli() Function

**Function**: Run the command line interface.

**Function Signature**:
```python
@click.group()
def cli():
    """A simple command line tool."""
    pass  # pragma: no cover.
```

### 160.AnySet Class

**Function**: A set that can contain any object, whether hashable or not.

**Class Definition**:
```python
class AnySet:
    """
    Any object can be in this set whether hashable or not.
    Note that the current implementation has memory leak and keeps
    traces of objects in itself even after popping.
    However one the AnySet object is deleted, all those traces will be gone too.
    """
    def __init__(self, items=None):
        self._set = SetOrdered()
        self._hashes = dict_()
        self._hash_to_objects = dict_()
        if items:
            for item in items:
                self.add(item)
        


    def add(self, item):
        """
        Add an item to the set
        
        Args:
            item: The item to add to the set
        """


    def __contains__(self, item):
        """
        Check if an item is in the set
        
        Args:
            item: The item to check for
            
        Returns:
            bool: True if item is in the set, False otherwise
        """


    def pop(self):
        """
        Remove and return an arbitrary item from the set
        
        Returns:
            The removed item
            
        Raises:
            KeyError: If the set is empty
        """


    def __eq__(self, other):
        """
        Check equality with another set
        
        Args:
            other: Another set to compare with
            
        Returns:
            bool: True if sets are equal, False otherwise
        """


    __req__ = __eq__

    def __repr__(self):
        """
        Return string representation of the set
        
        Returns:
            str: String representation of the set
        """


    __str__ = __repr__

    def __len__(self):
        """
        Return the number of items in the set
        
        Returns:
            int: Number of items in the set
        """


    def __iter__(self):
        """
        Return an iterator over the set items
        
        Returns:
            Iterator: Iterator over the set items
        """


    def __bool__(self):
        """
        Return True if the set is not empty
        
        Returns:
            bool: True if set has items, False if empty
        """

```

### 161.CannotCompare Class

**Function**: An exception that is raised when two items cannot be compared in the compare function.

**Class Definition**:
```python
class CannotCompare(Exception):
    """
    Exception when two items cannot be compared in the compare function.
    """
    pass
```

### 162.FlatDataAction Class

**Function**: An enum that represents the action of a flat data.

**Class Definition**:
```python
class FlatDataAction(EnumBase):
    values_changed = 'values_changed'
    type_changes = 'type_changes'
    set_item_added = 'set_item_added'
    set_item_removed = 'set_item_removed'
    dictionary_item_added = 'dictionary_item_added'
    dictionary_item_removed = 'dictionary_item_removed'
    iterable_item_added = 'iterable_item_added'
    iterable_item_removed = 'iterable_item_removed'
    iterable_item_moved = 'iterable_item_moved'
    iterable_items_inserted = 'iterable_items_inserted'  # opcode
    iterable_items_deleted = 'iterable_items_deleted'  # opcode
    iterable_items_replaced = 'iterable_items_replaced'  # opcode
    iterable_items_equal = 'iterable_items_equal'  # opcode
    attribute_removed = 'attribute_removed'
    attribute_added = 'attribute_added'
    unordered_iterable_item_added = 'unordered_iterable_item_added'
    unordered_iterable_item_removed = 'unordered_iterable_item_removed'
    initiated = "initiated"
```

### 163.DictRelationship Class

**Function**: A relationship that describes the relationship between a container object (the "parent") and the contained "child" object.

**Class Definition**:
```python
class DictRelationship(ChildRelationship):
    param_repr_format: Optional[str] = "[{}]"
    quote_str: Optional[str] = "'{}'"

```

### 164.SubscriptableIterableRelationship Class

**Function**: A relationship that describes the relationship between a container object (the "parent") and the contained "child" object.

**Class Definition**:
```python
class SubscriptableIterableRelationship(DictRelationship):
    pass
```

### 165.NonSubscriptableIterableRelationship Class

**Function**: A relationship that describes the relationship between a container object (the "parent") and the contained "child" object.

**Class Definition**:
```python
class NonSubscriptableIterableRelationship(InaccessibleRelationship):



    def get_param_repr(self, force: Optional[str] = None) -> Optional[str]:
        """
        Get parameter representation for the relationship
        
        Args:
            force: Optional force parameter for representation
            
        Returns:
            Optional[str]: String representation of the parameter
        """

```

### 166.AttributeRelationship Class

**Function**: A relationship that describes the relationship between a container object (the "parent") and the contained "child" object.

**Class Definition**:
```python
class AttributeRelationship(ChildRelationship):
    param_repr_format: Optional[str] = ".{}"
```

### 167.BaseOperatorPlus Class

**Function**: A base class for custom operators.

**Class Definition**:
```python
class BaseOperatorPlus(metaclass=ABCMeta):

    @abstractmethod
    def match(self, level) -> bool:
        """
        Given a level which includes t1 and t2 in the tree view, is this operator a good match to compare t1 and t2?
        If yes, we will run the give_up_diffing to compare t1 and t2 for this level.
        """
        pass

    @abstractmethod
    def give_up_diffing(self, level, diff_instance: "DeepDiff") -> bool:
        """
        Given a level which includes t1 and t2 in the tree view, and the "distance" between l1 and l2.
        do we consider t1 and t2 to be equal or not. The distance is a number between zero to one and is calculated by DeepDiff to measure how similar objects are.
        """

    @abstractmethod
    def normalize_value_for_hashing(self, parent: Any, obj: Any) -> Any:
        """
        You can use this function to normalize values for ignore_order=True

        For example, you may want to turn all the words to be lowercase. Then you return obj.lower()
        """
        pass
```

### 168.BaseOperator Class

**Function**: A base class for custom operators.

**Class Definition**:
```python
class BaseOperator:

    def __init__(self, regex_paths:Optional[List[str]]=None, types:Optional[List[type]]=None):
        if regex_paths:
            self.regex_paths = convert_item_or_items_into_compiled_regexes_else_none(regex_paths)
        else:
            self.regex_paths = None
        self.types = types

    def match(self, level) -> bool:
        """
        Check if this operator matches the given level
        
        Args:
            level: The comparison level to check
            
        Returns:
            bool: True if this operator should handle the comparison
        """

    def give_up_diffing(self, level, diff_instance) -> bool:
        """
        Determine if two objects should be considered equal
        
        Args:
            level: The comparison level containing objects to compare
            diff_instance: The DeepDiff instance performing the comparison
            
        Returns:
            bool: True if objects should be considered equal
            
        Raises:
            NotImplementedError: If not implemented by subclass
        """
        raise NotImplementedError('Please implement the diff function.')
```

### 169.PrefixOrSuffixOperator Class

**Function**: A custom operator that matches strings that start or end with the same string.

**Class Definition**:
```python
class PrefixOrSuffixOperator:

    def match(self, level) -> bool:
        return level.t1 and level.t2 and isinstance(level.t1, str) and isinstance(level.t2, str)

    def give_up_diffing(self, level, diff_instance) -> bool:
        t1 = level.t1
        t2 = level.t2
        return t1.startswith(t2) or t2.startswith(t1)

```

### 170.patch() Function

**Function**: A function that patches a file based on the information in a delta file.

**Function Signature**:
```python
def patch(
    path, delta_path, backup, raise_errors, debug
):
    """
    Deep Patch Commandline

    Patches a file based on the information in a delta file.
    The delta file can be created by the deep diff command and
    passing the --create-patch argument.

    Deep Patch is similar to Linux's patch command.
    The difference is that it is made for patching data.
    It can read csv, tsv, json, yaml, and toml files.

    """

```

**Parameter Description**:
- `path` (str): The path to the file to patch
- `delta_path` (str): The path to the delta file
- `backup` (bool): Whether to keep a backup of the original file
- `raise_errors` (bool): Whether to raise errors
- `debug` (bool): Whether to debug the function

**Return Value**: None

### 171.combine_hashes_lists() Function

**Function**: A function that combines lists of hashes into one hash.

**Function Signature**:
```python
def combine_hashes_lists(items: List[List[str]], prefix: Union[str, bytes]) -> str:
    """
    Combines lists of hashes into one hash
    This can be optimized in future.
    It needs to work with both murmur3 hashes (int) and sha256 (str)
    Although murmur3 is not used anymore.
    """
```

**Parameter Description**:
- `items` (List[List[str]]): The lists of hashes to combine
- `prefix` (Union[str, bytes]): The prefix to add to the hash

**Return Value**: The combined hash

### 172.prepare_string_for_hashing() Function

**Function**: A function that prepares a string for hashing.

**Function Signature**:
```python
def prepare_string_for_hashing(
        obj: Union[str, bytes, memoryview],
        ignore_string_type_changes: bool = False,
        ignore_string_case: bool = False,
        encodings: Optional[List[str]] = None,
        ignore_encoding_errors: bool = False,
) -> str:
    """
    Clean type conversions
    """
    original_type = obj.__class__.__name__
    # https://docs.python.org/3/library/codecs.html#codecs.decode
```

**Parameter Description**:
- `obj` (Union[str, bytes, memoryview]): The object to prepare for hashing
- `ignore_string_type_changes` (bool): Whether to ignore string type changes
- `ignore_string_case` (bool): Whether to ignore string case
- `encodings` (Optional[List[str]]): The encodings to try
- `ignore_encoding_errors` (bool): Whether to ignore encoding errors

**Return Value**: The prepared string

### 173._get_item_length() Function

**Function**: A function that gets the length of an item.

**Function Signature**:
```python
def _get_item_length(item, parents_ids=frozenset([])):
    """
    Get the number of operations in a diff object.
    It is designed mainly for the delta view output
    but can be used with other dictionary types of view outputs too.
    """
```

**Parameter Description**:
- `item`: The item to get the length of
- `parents_ids` (frozenset): The parent ids

**Return Value**: The length of the item

### 174.get_numeric_types_distance() Function

**Function**: A function that gets the distance between two numeric types.

**Function Signature**:
```python
def get_numeric_types_distance(num1, num2, max_, use_log_scale=False, log_scale_similarity_threshold=0.1):
```

**Parameter Description**:
- `num1`: The first numeric type
- `num2`: The second numeric type
- `max_`: The maximum value
- `use_log_scale` (bool): Whether to use log scale
- `log_scale_similarity_threshold` (float): The threshold for the similarity

**Return Value**: The distance between the two numeric types

### 175.get_semvar_as_integer() Function

**Function**: A function that gets the semvar as an integer.

**Function Signature**:
```python
def get_semvar_as_integer(version: str) -> int:
    """
    Converts:

    '1.23.5' to 1023005
    """
```

**Parameter Description**:
- `version` (str): The version to convert

**Return Value**: The semvar as an integer

### 176.short_repr() Function

**Function**: A function that shortens the representation of an item.

**Function Signature**:
```python
def short_repr(item: Any, max_length: int = 15) -> str:
    """Short representation of item if it is too long"""
```

**Parameter Description**:
- `item`: The item to shorten the representation of
- `max_length` (int): The maximum length of the representation

**Return Value**: The shortened representation of the item

### 177.cartesian_product() Function

**Function**: A function that returns the cartesian product of two lists.

**Function Signature**:
```python
def cartesian_product(a: Iterable[Tuple[Any, ...]], b: Iterable[Any]) -> Iterator[Tuple[Any, ...]]:
    """
    Get the Cartesian product of two iterables

    **parameters**

    a: list of lists
    b: iterable to do the Cartesian product
    """

```

**Parameter Description**:
- `a` (Iterable[Tuple[Any, ...]]): The first iterable
- `b` (Iterable[Any]): The second iterable

**Return Value**: The cartesian product of the two iterables

### 178.cartesian_product_of_shape() Function

**Function**: A function that returns the cartesian product of a shape.

**Function Signature**:
```python
def cartesian_product_of_shape(dimentions: Iterable[int], result: Optional[Tuple[Tuple[Any, ...], ...]] = None) -> Iterator[Tuple[Any, ...]]:
    """
    Cartesian product of a dimentions iterable.
    This is mainly used to traverse Numpy ndarrays.

    Each array has dimentions that are defines in ndarray.shape
    """
```

**Parameter Description**:
- `dimentions` (Iterable[int]): The dimensions to get the cartesian product of
- `result` (Optional[Tuple[Tuple[Any, ...], ...]]): The result to get the cartesian product of

**Return Value**: The cartesian product of the shape

### 179.get_numpy_ndarray_rows() Function

**Function**: A function that returns the rows of a numpy array.

**Function Signature**:
```python
def get_numpy_ndarray_rows(obj: Any, shape: Optional[Tuple[int, ...]] = None) -> Generator[Tuple[Tuple[int, ...], Any], None, None]:
    """
    Convert a multi dimensional numpy array to list of rows
    """
```

**Parameter Description**:
- `obj` (Any): The numpy array to get the rows of
- `shape` (Optional[Tuple[int, ...]]): The shape of the numpy array

**Return Value**: The rows of the numpy array

### 180.literal_eval_extended() Function

**Function**: A function that evaluates a string as a literal.

**Function Signature**:
```python
def literal_eval_extended(item: str) -> Any:
    """
    An extended version of literal_eval
    """
```

**Parameter Description**:
- `item` (str): The string to evaluate

**Return Value**: The evaluated literal

### 181.datetime_normalize() Function

**Function**: A function that normalizes a datetime object.

**Function Signature**:
```python
def datetime_normalize(
    truncate_datetime:Union[str, None],
    obj:Union[datetime.datetime, datetime.time],
    default_timezone: Union[
        datetime.timezone, "BaseTzInfo"
    ] = datetime.timezone.utc,
) -> Any:
```

**Parameter Description**:
- `truncate_datetime` (Union[str, None]): The truncate datetime
- `obj` (Union[datetime.datetime, datetime.time]): The datetime object to normalize
- `default_timezone` (Union[datetime.timezone, "BaseTzInfo"]): The default timezone

**Return Value**: The normalized datetime object

### 182.cartesian_product_numpy() Function

**Function**: A function that returns the cartesian product of numpy arrays.

**Function Signature**:
```python
def cartesian_product_numpy(*arrays: Any) -> Any:
    """
    Cartesian product of Numpy arrays by Paul Panzer
    https://stackoverflow.com/a/49445693/1497443
    """
```

**Parameter Description**:
- `arrays` (Any): The numpy arrays to get the cartesian product of

**Return Value**: The cartesian product of the numpy arrays

### 183.detailed__dict__() Function

**Function**: A function that returns the truncate datetime.

**Function Signature**:
```python
def detailed__dict__(obj: Any, ignore_private_variables: bool = True, ignore_keys: FrozenSet[str] = frozenset(), include_keys: Optional[List[str]] = None) -> Dict[str, Any]:
    """
    Get the detailed dictionary of an object.

    This is used so we retrieve object properties too.
    """
```

**Parameter Description**:
- `obj` (Any): The object to get the detailed dictionary of
- `ignore_private_variables` (bool): Whether to ignore private variables
- `ignore_keys` (FrozenSet[str]): The keys to ignore
- `include_keys` (Optional[List[str]]): The keys to include

**Return Value**: The detailed dictionary of the object

### 184._add_to_elements() Function

**Function**: A function that adds an element to a list of elements.

**Function Signature**:
```python
def _add_to_elements(elements, elem, inside):
    # Ignore private items
```

**Parameter Description**:
- `elements` (List[Tuple[Any, Any]]): The list of elements to add the element to
- `elem` (Any): The element to add
- `inside` (str): The inside of the element

**Return Value**: None

### 185._path_to_elements() Function

**Function**: A function that returns the elements of a path.

**Function Signature**:
```python
@lru_cache(maxsize=1024 * 128)
def _path_to_elements(path, root_element=DEFAULT_FIRST_ELEMENT):
    """
    Given a path, it extracts the elements that form the path and their relevant most likely retrieval action.

        >>> from deepdiff import _path_to_elements
        >>> path = "root[4.3].b['a3']"
        >>> _path_to_elements(path, root_element=None)
        [(4.3, 'GET'), ('b', 'GETATTR'), ('a3', 'GET')]
    """
```

**Parameter Description**:
- `path` (str): The path to get the elements of
- `root_element` (Optional[Tuple[Any, Any]]): The root element

**Return Value**: The elements of the path

### 186.stringify_path() Function

**Function**: A function that stringifies a path.

**Function Signature**:
```python
def stringify_path(path, root_element=DEFAULT_FIRST_ELEMENT, quote_str="'{}'"):
    """
    Gets the path as an string.

    For example [1, 2, 'age'] should become
    root[1][2]['age']
    """
```

**Parameter Description**:
- `path` (str): The path to stringify
- `root_element` (Optional[Tuple[Any, Any]]): The root element
- `quote_str` (Optional[str]): The quote string

**Return Value**: The stringified path

### 187.pretty_print_diff() Function

**Function**: A function that pretty prints a diff.

**Function Signature**:
```python
def pretty_print_diff(diff):
```

**Parameter Description**:
- `diff` (Diff): The diff to pretty print

**Return Value**: The pretty printed diff

### 188.load_path_content() Function

**Function**: A function that loads the content of a path.

**Function Signature**:
```python
def load_path_content(path, file_type=None):
    """
    Loads and deserializes the content of the path.
    """

```

**Parameter Description**:
- `path` (str): The path to load the content of
- `file_type` (Optional[str]): The type of the file

**Return Value**: The content of the path

### 189.json_dumps() Function

**Function**: A function that dumps a json object.

**Function Signature**:
```python
@overload
def json_dumps(
    item: Any,
    **kwargs,
) -> str:
    ...


@overload
def json_dumps(
    item: Any,
    default_mapping:Optional[dict],
    force_use_builtin_json: bool,
    return_bytes:Literal[True],
    **kwargs,
) -> bytes:
    ...


@overload
def json_dumps(
    item: Any,
    default_mapping:Optional[dict],
    force_use_builtin_json: bool,
    return_bytes:Literal[False],
    **kwargs,
) -> str:
    ...


def json_dumps(
    item: Any,
    default_mapping:Optional[dict]=None,
    force_use_builtin_json: bool = False,
    return_bytes: bool = False,
    **kwargs,
) -> Union[str, bytes]:
    """
    Dump json with extra details that are not normally json serializable

    parameters
    ----------

    force_use_builtin_json: Boolean, default = False
        When True, we use Python's builtin Json library for serialization,
        even if Orjson is installed.
    """
    
```

**Parameter Description**:
- `item` (Any): The item to dump
- `default_mapping` (Optional[dict]): The default mapping
- `force_use_builtin_json` (bool): Whether to force use the builtin json
- `return_bytes` (bool): Whether to return the bytes

**Return Value**: The dumped json object

### Constants and Aliases
```python
# in deephash.py
HASH_LOOKUP_ERR_MSG: str = '{} is not one of the hashed items.'

# in delta.py
VERIFICATION_MSG = 'Expected the old value for {} to be {} but it is {}. Error found on: {}. You may want to set force=True, especially if this delta is created by passing flat_rows_list or flat_dict_list'
ELEM_NOT_FOUND_TO_ADD_MSG = 'Key or index of {} is not found for {} for setting operation.'
VERIFY_BIDIRECTIONAL_MSG = ('You have applied the delta to an object that has '
                            'different values than the original object the delta was made from.')
FAIL_TO_REMOVE_ITEM_IGNORE_ORDER_MSG = 'Failed to remove index[{}] on {}. It was expected to be {} but got {}'
INVALID_ACTION_WHEN_CALLING_GET_ELEM = 'invalid action of {} when calling _get_elem_and_compare_to_old_value'
INVALID_ACTION_WHEN_CALLING_SIMPLE_SET_ELEM = 'invalid action of {} when calling _simple_set_elem_value'
INVALID_ACTION_WHEN_CALLING_SIMPLE_DELETE_ELEM = 'invalid action of {} when calling _simple_set_elem_value'
INDEXES_NOT_FOUND_WHEN_IGNORE_ORDER = 'Delta added to an incompatible object. Unable to add the following items at the specific indexes. {}'
NOT_VALID_NUMPY_TYPE = "{} is not a valid numpy type."

# in diff.py
PROGRESS_MSG = "DeepDiff {} seconds in progress. Pass #{}, Diff #{}"
INVALID_VIEW_MSG = "view parameter must be one of 'text', 'tree', 'delta', 'colored' or 'colored_compact'. But {} was passed."
DISTANCE_CALCS_NEEDS_CACHE = "Distance calculation can not happen once the cache is purged. Try with _cache='keep'"

# in helper.py
DELTA_VIEW = '_delta'
ENUM_INCLUDE_KEYS: List[str] = ['__objclass__', 'name', 'value']

# in serialization.py
MODULE_NOT_FOUND_MSG = 'DeepDiff Delta did not find {} in your modules. Please make sure it is already imported.'
FORBIDDEN_MODULE_MSG = "Module '{}' is forbidden. You need to explicitly pass it by passing a safe_to_import parameter"
DELTA_IGNORE_ORDER_NEEDS_REPETITION_REPORT = 'report_repetition must be set to True when ignore_order is True to create the delta object.'
DELTA_ERROR_WHEN_GROUP_BY = 'Delta can not be made when group_by is used since the structure of data is modified from the original form.'

# in __init__.py
__version__ = '8.6.1'
```
## Detailed Explanation of Configuration Classes

### 1. Comparison Configuration Options

**ignore_order**: Controls whether to ignore the order
- `True`: Ignore the order of containers such as lists and sets
- `False`: Strictly compare the order (default)

**ignore_private_variables**: Controls whether to ignore private variables
- `True`: Ignore attributes starting with `_` (default)
- `False`: Include private variables

**ignore_string_case**: Controls case comparison for strings
- `True`: Ignore case
- `False`: Distinguish case (default)

**ignore_numeric_type_changes**: Controls numeric type changes
- `True`: Ignore differences between int and float types
- `False`: Strictly compare types (default)

### 2. Path Filtering Configuration

**exclude_paths**: Exclude specific paths
```python
exclude_paths=["root['metadata']", "root['timestamp']"]
```

**include_paths**: Only include specific paths
```python
include_paths=["root['data']", "root['result']"]
```

**exclude_regex_paths**: Use regular expressions to exclude paths
```python
exclude_regex_paths=[r"root\[\d+\]", r"root\['temp_.*'\]"]
```

## 3. Performance Configuration Options

**cache_size**: Cache size
- `0`: Disable cache (default)
- `>0`: Enable cache of the specified size

**max_passes**: Maximum number of passes
- Default: 10000000
- Prevent infinite loops

**max_diffs**: Maximum number of differences
- `None`: No limit (default)
- `>0`: Limit the number of differences

## Actual Usage Modes

### Basic Usage

```python
from deepdiff import DeepDiff, Delta

# Simple comparison
t1 = {"a": 1, "b": 2}
t2 = {"a": 1, "b": 3}
diff = DeepDiff(t1, t2)
print(diff)  # {'values_changed': {"root['b']": {'old_value': 2, 'new_value': 3}}}

# Apply differences
delta = Delta(diff=diff)
result = t1 + delta
print(result)  # {"a": 1, "b": 3}
```

### Configuration-based Usage

```python
from deepdiff import DeepDiff, DeepSearch

# Custom configuration comparison
diff = DeepDiff(
    t1, t2,
    ignore_order=True,
    ignore_private_variables=True,
    exclude_paths=["root['metadata']"],
    verbose_level=2
)

# Configuration-based search
search = DeepSearch(
    obj,
    item="target_value",
    case_sensitive=False,
    use_regexp=True,
    verbose_level=2
)
```



# Detailed Function Implementation Nodes

### Node 1: Basic Object Comparison
**Function Description**: Implement the core comparison function of DeepDiff, supporting deep comparison of basic data structures such as dictionaries, lists, sets, and tuples. This is the foundation of the entire DeepDiff system, responsible for handling comparison operations of all Python standard data types. It includes core functions such as recursively traversing nested structures, detecting various types of changes, handling circular references, and supporting custom comparison logic. This node is the basis for all other advanced functions, ensuring the accuracy and completeness of basic comparisons.
**Comparison Strategy**:
- Recursively traverse all nested levels using a depth-first search algorithm
- Detect value changes, type changes, item additions/deletions, and dictionary key changes
- Support custom comparison functions and callback mechanisms
- Handle circular references and infinite recursion to prevent stack overflow
- Support path tracking and detailed difference reports
- Handle special cases such as None values, empty objects, and singleton objects
- Support the `verbose_level` parameter to control the output detail level
- Implement an efficient comparison algorithm to optimize the performance of large object processing
**Input and Output Examples**:
```python
from deepdiff import DeepDiff

# Basic dictionary comparison
t1 = {"a": 1, "b": 2}
t2 = {"a": 1, "b": 3}
result = DeepDiff(t1, t2)
# Output: {'values_changed': {"root['b']": {'new_value': 3, 'old_value': 2}}}

# List comparison
t1 = [1, 2, 3]
t2 = [1, 2, 4]
result = DeepDiff(t1, t2)
# Output: {'values_changed': {"root[2]": {'new_value': 4, 'old_value': 3}}}

# Set comparison
t1 = {1, 2, 3}
t2 = {1, 2, 4}
result = DeepDiff(t1, t2)
# Output: {'set_item_added': ["root[4]"], 'set_item_removed': ["root[3]"]}
```

### Node 2: Numeric Type Handling
**Function Description**: Specifically handle the comparison of numeric types, including integers, floating-point numbers, Decimals, and complex numbers, supporting precision control and type ignoring. This node is responsible for all numeric-related comparison operations, ensuring the accuracy and flexibility of numeric comparisons. It supports high-precision numeric calculations, scientific notation, complex number operations, and special numeric handling. This function is very important for scenarios such as scientific computing, financial applications, and data analysis, capable of handling various numeric precision requirements and type conversion needs.
**Handling Strategy**:
- Support the `significant_digits` parameter to control precision, supporting scientific notation formats
- Support `ignore_numeric_type_changes` to ignore type changes (e.g., int and float)
- Support the `math_epsilon` parameter to set the numeric tolerance for handling floating-point precision issues
- Handle the comparison of special numeric values such as NaN, infinity, and negative zero
- Support precise decimal operations for the Decimal type
- Handle the separate comparison of the real and imaginary parts of complex numbers
- Support the `number_format_notation` parameter to control numeric formatting
- Handle boundary cases of numeric overflow and precision loss
- Support custom numeric comparison functions and tolerance settings
**Input and Output Examples**:
```python
from decimal import Decimal
from deepdiff import DeepDiff

# Precision control
t1 = 3.14159
t2 = 3.14160
result = DeepDiff(t1, t2, significant_digits=4)
# Output: {} (no differences)

# Decimal type comparison
t1 = Decimal('3.14159')
t2 = 3.14159
result = DeepDiff(t1, t2, ignore_numeric_type_changes=True)
# Output: {} (no differences)

# Numeric tolerance
t1 = 1.0001
t2 = 1.0002
result = DeepDiff(t1, t2, math_epsilon=0.001)
# Output: {} (no differences)
```

### Node 3: String Processing
**Function Description**: Handle string comparison, supporting case-insensitive comparison, encoding processing, and Unicode support. This node specifically handles all string-related comparison operations, including ordinary strings, Unicode strings, byte strings, and raw strings. It supports functions such as multi-language text comparison, encoding conversion, and string normalization. It is very important for scenarios such as internationalized applications, text processing, and data cleaning, capable of handling various string formats and encoding requirements.
**Handling Strategy**:
- Support `ignore_string_case` to ignore case, supporting multi-language case rules
- Support `ignore_string_type_changes` to ignore type changes (e.g., str and bytes)
- Handle the encoding conversion of Unicode strings and byte strings
- Support string normalization (NFD, NFC, NFKD, NFKC)
- Handle special characters, control characters, and escape characters
- Support special handling of regular expression strings
- Handle string length limits and truncation
- Support custom string comparison functions
- Handle string pooling and memory optimization
- Support encoding error handling
**Input and Output Examples**:
```python
from deepdiff import DeepDiff

# Case-insensitive comparison
t1 = "Hello World"
t2 = "hello world"
result = DeepDiff(t1, t2, ignore_string_case=True)
# Output: {} (no differences)

# String type change
t1 = "hello"
t2 = b"hello"
result = DeepDiff(t1, t2, ignore_string_type_changes=True)
# Output: {} (no differences)

# Unicode handling
t1 = "café"
t2 = "cafe"
result = DeepDiff(t1, t2)
# Output: {'values_changed': {'root': {'new_value': 'cafe', 'old_value': 'café'}}}
```

### Node 4: Collection and Sequence Processing
**Function Description**: Handle the comparison of collection types such as lists, tuples, and sets, supporting order ignoring and repetition reporting. This node specifically handles all comparison operations of iterable data structures, including lists, tuples, sets, generators, and iterators. It supports functions such as complex collection operations, handling of duplicate elements, order-independent comparison, and nested structure processing. It is very important for scenarios such as data analysis, collection operations, sequence comparison, and data cleaning, capable of handling comparison requirements of various iterable objects.
**Handling Strategy**:
- Support `ignore_order` to ignore order, implementing set-style comparison and hash optimization
- Support `report_repetition` to report duplicate elements and frequency statistics
- Handle the recursive comparison of nested collection structures
- Support custom comparison functions and iterator processing
- Handle boundary cases such as empty collections, single-element collections, and large collections
- Support intersection, union, and difference operations and optimization of collections
- Handle type conversion and normalization of collection elements
- Support the `iterable_compare_func` custom comparison function
- Handle performance optimization and memory management of large collections
- Support sorting and deduplication operations of collection elements
**Input and Output Examples**:
```python
from deepdiff import DeepDiff

# Ignore order
t1 = [1, 2, 3]
t2 = [3, 1, 2]
result = DeepDiff(t1, t2, ignore_order=True)
# Output: {} (no differences)

# Report repetition
t1 = [1, 2, 2, 3]
t2 = [1, 2, 3]
result = DeepDiff(t1, t2, report_repetition=True)
# Output: {'repetition_change': {"root[1]": {'old_repeat': 2, 'new_repeat': 1}}}

# Nested collections
t1 = [[1, 2], [3, 4]]
t2 = [[3, 4], [1, 2]]
result = DeepDiff(t1, t2, ignore_order=True)
# Output: {} (no differences)
```

### Node 5: Custom Object Processing
**Function Description**: Handle the comparison of complex objects such as custom classes, dataclasses, namedtuples, and enumerations.
**Handling Strategy**:
- Support processing of the `__slots__` attribute
- Support detection of attribute changes
- Support detection of method changes
- Handle inheritance relationships
**Input and Output Examples**:
```python
from dataclasses import dataclass
from enum import Enum
from deepdiff import DeepDiff

@dataclass
class Person:
    name: str
    age: int

class Color(Enum):
    RED = 1
    BLUE = 2

# Dataclass comparison
t1 = Person("Alice", 30)
t2 = Person("Alice", 31)
result = DeepDiff(t1, t2)
# Output: {'values_changed': {"root.age": {'new_value': 31, 'old_value': 30}}}

# Enumeration comparison
t1 = Color.RED
t2 = Color.BLUE
result = DeepDiff(t1, t2)
# Output: {'values_changed': {'root': {'new_value': Color.BLUE, 'old_value': Color.RED}}}
```

### Node 6: DateTime Processing
**Function Description**: Handle the comparison of time types such as datetime, date, and time.
**Handling Strategy**:
- Support time zone processing
- Support time precision control
- Handle time formatting
- Support time tolerance
**Input and Output Examples**:
```python
from datetime import datetime, date
from deepdiff import DeepDiff

# Datetime comparison
t1 = datetime(2023, 1, 1, 12, 0, 0)
t2 = datetime(2023, 1, 1, 12, 0, 1)
result = DeepDiff(t1, t2)
# Output: {'values_changed': {'root': {'new_value': datetime(2023, 1, 1, 12, 0, 1), 'old_value': datetime(2023, 1, 1, 12, 0, 0)}}}

# Date comparison
t1 = date(2023, 1, 1)
t2 = date(2023, 1, 2)
result = DeepDiff(t1, t2)
# Output: {'values_changed': {'root': {'new_value': date(2023, 1, 2), 'old_value': date(2023, 1, 1)}}}
```

### Node 7: Special Data Type Processing
**Function Description**: Handle the comparison of special data types such as UUIDs, regular expressions, and IP addresses.
**Handling Strategy**:
- Support UUID comparison
- Support regular expression objects
- Support IP address objects
- Handle serialization of special objects
**Input and Output Examples**:
```python
import uuid
import re
import ipaddress
from deepdiff import DeepDiff

# UUID comparison
t1 = uuid.uuid4()
t2 = uuid.uuid4()
result = DeepDiff(t1, t2)
# Output: {'values_changed': {'root': {'new_value': t2, 'old_value': t1}}}

# Regular expression comparison
t1 = re.compile(r'\d+')
t2 = re.compile(r'\d+')
result = DeepDiff(t1, t2)
# Output: {} (no differences)

# IP address comparison
t1 = ipaddress.IPv4Address('192.168.1.1')
t2 = ipaddress.IPv4Address('192.168.1.2')
result = DeepDiff(t1, t2)
# Output: {'values_changed': {'root': {'new_value': IPv4Address('192.168.1.2'), 'old_value': IPv4Address('192.168.1.1')}}}
```

### Node 8: Path Filtering and Inclusion
**Function Description**: Support advanced filtering functions such as path filtering, included paths, and regular expression paths.
**Handling Strategy**:
- Support `exclude_paths` to exclude paths
- Support `include_paths` to include paths
- Support `exclude_regex_paths` for regular expression exclusion
- Support `include_regex_paths` for regular expression inclusion
**Input and Output Examples**:
```python
from deepdiff import DeepDiff

t1 = {"a": {"b": 1, "c": 2}, "d": 3}
t2 = {"a": {"b": 1, "c": 3}, "d": 4}

# Exclude paths
result = DeepDiff(t1, t2, exclude_paths=["root['d']"])
# Output: {'values_changed': {"root['a']['c']": {'new_value': 3, 'old_value': 2}}}

# Include paths
result = DeepDiff(t1, t2, include_paths=["root['a']"])
# Output: {'values_changed': {"root['a']['c']": {'new_value': 3, 'old_value': 2}}}

# Regular expression exclusion
result = DeepDiff(t1, t2, exclude_regex_paths=[r"root\['d'\]"])
# Output: {'values_changed': {"root['a']['c']": {'new_value': 3, 'old_value': 2}}}
```

### Node 9: Type Filtering and Grouping
**Function Description**: Support advanced type functions such as type filtering, type grouping, and subclass handling.
**Handling Strategy**:
- Support `exclude_types` to exclude types
- Support `ignore_type_subclasses` to ignore subclasses
- Support type grouping comparison
- Handle type change detection
**Input and Output Examples**:
```python
from deepdiff import DeepDiff

t1 = {"a": 1, "b": "2", "c": 3.0}
t2 = {"a": 1.0, "b": 2, "c": 3}

# Ignore numeric type changes
result = DeepDiff(t1, t2, ignore_numeric_type_changes=True)
# Output: {} (no differences)

# Exclude string types
result = DeepDiff(t1, t2, exclude_types=[str])
# Output: {'values_changed': {"root['a']": {'new_value': 1.0, 'old_value': 1}}}

# Type grouping
result = DeepDiff(t1, t2, ignore_type_in_groups=[(int, float)])
# Output: {} (no differences)
```

### Node 10: Performance Optimization and Caching
**Function Description**: Implement performance optimization functions, including caching, limits, and progress reporting.
**Handling Strategy**:
- Support LFU cache
- Support `max_passes` limit
- Support `max_diffs` limit
- Support progress reporting
**Input and Output Examples**:
```python
from deepdiff import DeepDiff

# Set the maximum number of differences
t1 = {"a": 1, "b": 2, "c": 3, "d": 4}
t2 = {"a": 1, "b": 3, "c": 4, "d": 5}
result = DeepDiff(t1, t2, max_diffs=2)
# Output: Only show the first 2 differences

# Set the maximum number of passes
result = DeepDiff(t1, t2, max_passes=1)
# Output: Limit the traversal depth

# Cache size setting
result = DeepDiff(t1, t2, cache_size=1000)
# Output: Use the cache to optimize performance
```

### Node 11: Serialization and Deserialization
**Function Description**: Support serialization and deserialization in multiple formats, including JSON, Pickle, YAML, etc.
**Handling Strategy**:
- Support JSON serialization
- Support Pickle serialization
- Support YAML serialization
- Support TOML serialization
**Input and Output Examples**:
```python
from deepdiff import DeepDiff, Delta

t1 = {"a": 1, "b": 2}
t2 = {"a": 1, "b": 3}
diff = DeepDiff(t1, t2)

# JSON serialization
json_str = diff.to_json()
# Output: JSON string

# Pickle serialization
pickle_str = diff.to_pickle()
# Output: Pickle byte string

# Delta serialization
delta = Delta(diff)
delta_str = delta.dumps()
# Output: Serialized Delta object
```

### Node 12: Command Line Interface
**Function Description**: Provide a complete command line interface, supporting commands such as diff, patch, grep, and extract.
**Handling Strategy**:
- Support multiple file formats
- Support difference creation and application
- Support search function
- Support extraction function
**Input and Output Examples**:
```bash
# File comparison
deepdiff t1.json t2.json

# Create a patch
deepdiff t1.json t2.json --create-patch > delta.pickle

# Apply a patch
deepdiff patch t1.json delta.pickle

# Search function
deepdiff grep "value" data.json

# Extraction function
deepdiff extract "root['a']['b']" data.json
```

### Node 13: Error Handling and Validation
**Function Description**: Provide a comprehensive error handling mechanism, including exception catching, error messages, and validation functions.
**Handling Strategy**:
- Support exception catching
- Support error message formatting
- Support validation functions
- Support error recovery
**Input and Output Examples**:
```python
from deepdiff import DeepDiff, DeltaError

# Exception handling
try:
    result = DeepDiff(t1, t2)
except Exception as e:
    print(f"Comparison failed: {e}")

# Delta error handling
try:
    delta = Delta(diff)
    result = t1 + delta
except DeltaError as e:
    print(f"Delta application failed: {e}")

# Validation function
delta = Delta(diff)
assert delta.verify(t1, t2)  # Verify the correctness of the Delta
```

### Node 14: Advanced Search Functionality
**Function Description**: Implement the complete function of DeepSearch, including path matching, type filtering, and regular expressions.
**Handling Strategy**:
- Support path matching
- Support type filtering
- Support regular expressions
- Support case control
**Input and Output Examples**:
```python
from deepdiff import DeepSearch

obj = {"a": {"b": "hello", "c": "world"}, "d": "hello"}
search = DeepSearch(obj, "hello")

# Basic search
print(search.matched_paths)
# Output: ["root['a']['b']", "root['d']"]

# Regular expression search
search = DeepSearch(obj, r"h.*o", use_regexp=True)
print(search.matched_paths)
# Output: ["root['a']['b']", "root['d']"]

# Type filtering
search = DeepSearch(obj, "hello", exclude_types=[dict])
print(search.matched_paths)
# Output: ["root['d']"]
```

### Node 15: Hash Generation and Caching
**Function Description**: Implement the complete function of DeepHash, generating hash values for complex objects. This node specifically handles the hash generation and caching functions of complex objects, supporting multiple hash algorithms, custom hashers, and hash verification. Through the hash function, functions such as object deduplication, quick comparison, and data integrity verification can be achieved. It is very important for scenarios such as data deduplication, cache systems, and data integrity checks.
**Handling Strategy**:
- Support multiple hash algorithms (MD5, SHA1, SHA256, etc.)
- Support hash caching and hash result caching
- Support custom hashers and hash functions
- Support hash verification and hash collision detection
- Handle incremental hash calculation of large objects
- Support hash performance optimization and parallel computing
- Handle hash security checks and hash attack prevention
- Support hash version management and hash compatibility
- Handle hash errors and hash exceptions
- Support hash statistics and hash analysis
- Handle hash storage and hash transmission
**Input and Output Examples**:
```python
from deepdiff import DeepHash

obj = {"a": 1, "b": [2, 3], "c": {"d": 4}}

# Basic hash
hash_obj = DeepHash(obj)
print(hash_obj.hash)
# Output: Hash value string

# Custom hasher
def custom_hasher(obj):
    return hash(str(obj))

hash_obj = DeepHash(obj, hasher=custom_hasher)
print(hash_obj.hash)
# Output: Custom hash value

# Hash caching
hash_obj = DeepHash(obj, hashes={})
print(hash_obj.hash)
# Output: Use the cached hash value
```

### Node 16: Custom Operators
**Function Description**: Support custom comparison operators to implement special comparison logic. This node specifically handles the custom comparison operator function of DeepDiff, supporting user-defined special comparison rules and logic. Through custom operators, comparison requirements for specific business scenarios can be achieved, expanding the functionality of DeepDiff. It is very important for scenarios such as special data types, business rule comparison, and third-party library integration.
**Handling Strategy**:
- Support the `BaseOperator` base class and operator inheritance
- Support `BaseOperatorPlus` extension and advanced functions
- Support custom comparison functions and comparison logic
- Support operator registration and operator management
- Handle operator priority and operator chaining
- Support operator parameter passing and context management
- Handle operator errors and exception handling
- Support operator caching and performance optimization
- Handle operator version management and compatibility
- Support operator debugging and logging
- Handle operator security and permission control
**Input and Output Examples**:
```python
from deepdiff import DeepDiff
from deepdiff.operators import BaseOperator

class CustomOperator(BaseOperator):
    """
    Custom operator for specialized comparison logic
    
    Example implementation of a custom operator for handling specific comparison cases.
    """
    def give_up_diffing(self, level, diff_instance):
        return True

# Use custom operators
t1 = {"a": CustomClass(1)}
t2 = {"a": CustomClass(2)}
result = DeepDiff(t1, t2, custom_operators=[CustomOperator()])
# Output: Use custom comparison logic
```

### Node 17: Summarization and Formatting
**Function Description**: Provide result summarization and formatting functions, including tree views and text views. This node specifically handles the summarization generation and formatted output functions of DeepDiff results, supporting multiple output formats and view modes. Through the summarization and formatting functions, user-friendly difference displays can be provided, facilitating the understanding and analysis of comparison results. It is very important for scenarios such as report generation, user interfaces, and data analysis.
**Handling Strategy**:
- Support tree views and hierarchical structure displays
- Support text views and formatted output
- Support summarization generation and key information extraction
- Support formatted output and style control
- Handle summarization and truncation of large results
- Support multiple output formats (JSON, XML, HTML, etc.)
- Handle output encoding and character set support
- Support custom formatters and outputters
- Handle output performance optimization and streaming output
- Support output caching and output reuse
- Handle output errors and output validation
**Input and Output Examples**:
```python
from deepdiff import DeepDiff

t1 = {"a": {"b": 1, "c": 2}}
t2 = {"a": {"b": 1, "c": 3}}
diff = DeepDiff(t1, t2)

# Tree view
tree = diff.tree
print(tree)
# Output: Tree-structured differences

# Text view
text = diff.pretty()
print(text)
# Output: Formatted text differences

# Summary
summary = diff.summary()
print(summary)
# Output: Difference summary
```

### Node 18: Distance Calculation and Similarity
**Function Description**: Calculate the distance and similarity between objects, supporting multiple distance algorithms. This node specifically handles the distance calculation and similarity evaluation functions between objects, supporting multiple distance algorithms and similarity measurement methods. Through distance calculation, the degree of difference between objects can be quantified, providing a numerical basis for similarity analysis. It is very important for scenarios such as data clustering, similarity search, and quality evaluation.
**Handling Strategy**:
- Support rough distance calculation and quick approximation
- Support deep distance calculation and precise measurement
- Support numeric type distance and type-aware distance
- Support similarity thresholds and similarity grading
- Handle distance calculation for different data types
- Support custom distance functions and similarity algorithms
- Handle performance optimization and caching of distance calculation
- Support distance standardization and normalization
- Handle precision control and error handling of distance calculation
- Support distance statistics and distance analysis
- Handle parallel and distributed computing of distance calculation
**Input and Output Examples**:
```python
from deepdiff import DeepDiff

t1 = {"a": 1, "b": 2, "c": 3}
t2 = {"a": 1, "b": 3, "c": 4}
diff = DeepDiff(t1, t2)

# Rough distance
rough_dist = diff._get_rough_distance()
print(rough_dist)
# Output: Rough distance value

# Deep distance
deep_dist = diff.get_deep_distance()
print(deep_dist)
# Output: Deep distance value

# Numeric distance
numeric_dist = diff.get_numeric_types_distance()
print(numeric_dist)
# Output: Numeric type distance
```

### Node 19: Configuration Management and Validation
**Function Description**: Manage the configuration options of DeepDiff, including parameter validation and default value setting. This node specifically handles the configuration management and parameter validation functions of DeepDiff, supporting operations such as configuration creation, validation, merging, and persistence. Through configuration management, flexible parameter control can be achieved, ensuring the correctness and consistency of configurations. It is very important for scenarios such as system configuration, user preferences, and environment adaptation.
**Handling Strategy**:
- Support parameter validation and parameter type checking
- Support default value setting and default value inheritance
- Support configuration merging and configuration priority
- Support configuration validation and configuration integrity checking
- Handle reading and writing of configuration files
- Support configuration version management and configuration migration
- Handle configuration errors and configuration exceptions
- Support configuration encryption and security
- Handle configuration caching and configuration optimization
- Support configuration backup and configuration recovery
- Handle configuration monitoring and configuration auditing
**Input and Output Examples**:
```python
from deepdiff import DeepDiff

# Parameter validation
try:
    result = DeepDiff(t1, t2, verbose_level=5)  # Out of range
except ValueError as e:
    print(f"Parameter error: {e}")

# Default value setting
result = DeepDiff(t1, t2)  # Use default configuration
print(result)

# Configuration merging
config1 = {"ignore_order": True}
config2 = {"significant_digits": 2}
result = DeepDiff(t1, t2, **config1, **config2)
print(result)
```

### Node 20: Testing and Debugging Support
**Function Description**: Provide testing and debugging support, including test case generation and debugging information output. This node specifically handles the testing and debugging functions of DeepDiff, supporting operations such as test case generation, debugging information output, performance analysis, and error diagnosis. Through testing and debugging support, code quality can be improved, facilitating problem location and performance optimization. It is very important for scenarios such as development debugging, quality assurance, and performance tuning.
**Handling Strategy**:
- Support test case generation and test data construction
- Support debugging information output and debugging level control
- Support performance analysis and performance monitoring
- Support error diagnosis and error tracking
- Handle test coverage statistics and test report generation
- Support unit testing and integration testing
- Handle debugging log and debugging output formatting
- Support performance benchmark testing and performance regression detection
- Handle error stack analysis and error context
- Support test environment configuration and test data management
- Handle test result validation and test result reporting
**Input and Output Examples**:
```python
from deepdiff import DeepDiff

# Debugging information
result = DeepDiff(t1, t2, verbose_level=2)
print(result)
# Output: Detailed debugging information

# Performance analysis
import time
start = time.time()
result = DeepDiff(t1, t2)
end = time.time()
print(f"Comparison time: {end - start} seconds")

# Error diagnosis
try:
    result = DeepDiff(t1, t2)
except Exception as e:
    print(f"Error type: {type(e).__name__}")
    print(f"Error message: {e}")
```

### Node 21: LFU Cache Mechanism
**Function Description**: Implement an efficient LFU (Least Frequently Used) cache mechanism, supporting advanced cache functions such as multi-threaded secure access, frequency statistics, and cache eviction. This node specifically handles the cache system of DeepDiff, implementing efficient cache management through the LFU algorithm to improve the performance of repeated comparison operations. It supports key cache features such as cache size control, access frequency statistics, cache eviction policies, and multi-threaded secure access. Through an intelligent cache mechanism, the performance of large object comparison can be significantly improved, especially when dealing with repeated or similar data structures. This function is crucial for improving the performance of DeepDiff in scenarios such as data processing, batch comparison, and repeated operations.
**Handling Strategy**:
- Support the LFU (Least Frequently Used) cache eviction algorithm
- Support multi-threaded secure cache access and modification
- Support dynamic adjustment of cache size and cache capacity control
- Support access frequency statistics and frequency sorting
- Handle cache hit rate monitoring and performance analysis
- Support cache preheating and cache preloading
- Handle cache invalidation and cache update policies
- Support cache statistics and cache analysis
- Handle cache memory management and memory optimization
- Support cache persistence and cache recovery
- Handle cache errors and cache exceptions
- Support cache configuration and cache tuning
**Input and Output Examples**:
```python
from deepdiff.lfucache import LFUCache

# Create an LFU cache
cache = LFUCache(size=3)

# Set cache items
cache.set("key1", "value1")
cache.set("key2", "value2")
cache.set("key3", "value3")

# Access cache items (increase access frequency)
cache.get("key1")
cache.get("key1")  # Access again to increase frequency

# Get sorted cache keys (sorted by access frequency)
sorted_keys = cache.get_sorted_cache_keys()
# Output: [('key1', 3), ('key2', 1), ('key3', 1)]

# Get average access frequency
avg_freq = cache.get_average_frequency()
# Output: 1.666...

# Multi-threaded security test
import threading
def cache_operation(cache, key):
    cache.set(key, f"value_{key}")
    cache.get(key)

threads = [threading.Thread(target=cache_operation, args=(cache, f"key_{i}")) 
           for i in range(10)]
for t in threads:
    t.start()
for t in threads:
    t.join()
```

### Node 22: Multithreading and Concurrency Safety
**Function Description**: Ensure the thread safety and concurrent processing ability of DeepDiff in a multi-threaded environment, supporting stable operation in high-concurrency scenarios. This node specifically handles the concurrent safety mechanism of DeepDiff, ensuring correct operation in multi-threaded and multi-process environments and avoiding concurrent problems such as race conditions, deadlocks, and data races. It supports key concurrent features such as thread-safe object comparison, concurrent cache access, shared resource management, and locking mechanisms. Through a comprehensive concurrent safety mechanism, the stability and reliability of DeepDiff in high-concurrency applications, multi-threaded data processing, and parallel computing scenarios are ensured. This function is crucial for ensuring the availability of DeepDiff in enterprise-level applications, high-concurrency systems, and distributed environments.
**Handling Strategy**:
- Support thread-safe object comparison operations
- Support concurrent cache access and cache synchronization
- Support secure management and access control of shared resources
- Support the use of locking mechanisms and synchronization primitives
- Handle detection and prevention of race conditions
- Support deadlock detection and deadlock prevention
- Handle data races and data consistency
- Support concurrent performance monitoring and performance analysis
- Handle concurrent errors and concurrent exceptions
- Support concurrent configuration and concurrent tuning
- Handle concurrent testing and concurrent verification
- Support concurrent documentation and concurrent guidelines
**Input and Output Examples**:
```python
import threading
import time
from deepdiff import DeepDiff

# Thread-safe comparison function
def thread_safe_compare(obj1, obj2, results, index):
    try:
        result = DeepDiff(obj1, obj2)
        results[index] = result
    except Exception as e:
        results[index] = f"Error: {e}"

# Multi-threaded comparison test
def test_concurrent_comparison():
    obj1 = {"a": 1, "b": 2, "c": 3}
    obj2 = {"a": 1, "b": 3, "c": 4}
    
    results = [None] * 4
    threads = []
    
    # Create multiple threads for concurrent comparison
    for i in range(4):
        t = threading.Thread(
            target=thread_safe_compare, 
            args=(obj1, obj2, results, i)
        )
        threads.append(t)
        t.start()

    # Wait for all threads to complete
    for t in threads:
        t.join()
    
    # Verify that the results of all threads are consistent
    for i in range(1, 4):
        assert results[i] == results[0], f"Thread {i} result differs"
    
    return results[0]

# Concurrent cache access test
def test_concurrent_cache_access():
    from deepdiff.lfucache import LFUCache
    
    cache = LFUCache(10)
    
    def cache_worker(cache, worker_id):
        for i in range(100):
            key = f"key_{worker_id}_{i}"
            cache.set(key, f"value_{worker_id}_{i}")
            cache.get(key)
    
    threads = []
    for i in range(5):
        t = threading.Thread(target=cache_worker, args=(cache, i))
        threads.append(t)
        t.start()
    
    for t in threads:
        t.join()
    
    # Verify cache state
    assert len(cache.get_sorted_cache_keys()) <= 10
```

### Node 23: Parameterized Testing Framework
**Function Description**: Support a large number of parameterized test cases, covering automated testing of various data type combinations, boundary conditions, and exception situations. This node specifically handles the automated testing framework of DeepDiff, achieving efficient test coverage through parameterized testing technology and ensuring comprehensive testing of various input combinations and boundary conditions. It supports key testing features such as dynamic test case generation, test data management, test result verification, and test coverage statistics. Through a comprehensive parameterized testing framework, testing efficiency can be significantly improved, ensuring the correctness and stability of DeepDiff in various complex scenarios. This function is crucial for ensuring the code quality, functional integrity, and regression testing of DeepDiff.
**Handling Strategy**:
- Support parameterized testing using the `@pytest.mark.parametrize` decorator
- Support automatic generation and management of a large number of test cases
- Support testing coverage of complex data type combinations
- Support testing of boundary conditions and extreme values
- Handle dynamic generation of test data and test data management
- Support automatic verification and assertion of test results
- Handle test coverage statistics and test report generation
- Support test performance monitoring and test performance analysis
- Handle test errors and test exceptions
- Support test configuration and test environment management
- Handle test parallelization and distributed test execution
- Support test documentation and test guidelines
**Input and Output Examples**:
```python
import pytest
from deepdiff import DeepDiff

# Basic parameterized testing
@pytest.mark.parametrize("t1, t2, expected", [
    # Numeric type testing
    (1, 1, {}),
    (1, 2, {'values_changed': {'root': {'new_value': 2, 'old_value': 1}}}),
    (1.0, 1.0, {}),
    (1.0, 2.0, {'values_changed': {'root': {'new_value': 2.0, 'old_value': 1.0}}}),
    
    # String type testing
    ("a", "a", {}),
    ("a", "b", {'values_changed': {'root': {'new_value': 'b', 'old_value': 'a'}}}),
    ("", "", {}),
    ("", "hello", {'values_changed': {'root': {'new_value': 'hello', 'old_value': ''}}}),
    
    # List type testing
    ([], [], {}),
    ([1], [1], {}),
    ([1], [2], {'values_changed': {'root[0]': {'new_value': 2, 'old_value': 1}}}),
    ([1, 2], [1, 3], {'values_changed': {'root[1]': {'new_value': 3, 'old_value': 2}}}),
    
    # Dictionary type testing
    ({}, {}, {}),
    ({"a": 1}, {"a": 1}, {}),
    ({"a": 1}, {"a": 2}, {'values_changed': {"root['a']": {'new_value': 2, 'old_value': 1}}}),
    ({"a": 1}, {"b": 1}, {'dictionary_item_added': ["root['b']"], 'dictionary_item_removed': ["root['a']"]}),
    
    # Set type testing
    (set(), set(), {}),
    ({1}, {1}, {}),
    ({1}, {2}, {'set_item_added': ['root[2]'], 'set_item_removed': ['root[1]']}),
    
    # None value testing
    (None, None, {}),
    (None, 1, {'values_changed': {'root': {'new_value': 1, 'old_value': None}}}),
    (1, None, {'values_changed': {'root': {'new_value': None, 'old_value': 1}}}),
])
def test_basic_comparison(t1, t2, expected):
    result = DeepDiff(t1, t2)
    assert result == expected

# Configuration parameterized testing
@pytest.mark.parametrize("ignore_order, ignore_type, t1, t2, expected", [
    (False, False, [1, 2, 3], [3, 1, 2], {'values_changed': {'root[0]': {'new_value': 3, 'old_value': 1}, 'root[1]': {'new_value': 1, 'old_value': 2}, 'root[2]': {'new_value': 2, 'old_value': 3}}}),
    (True, False, [1, 2, 3], [3, 1, 2], {}),
    (False, True, [1, 2, 3], [1.0, 2.0, 3.0], {}),
    (True, True, [1, 2, 3], [3.0, 1.0, 2.0], {}),
])
def test_configuration_options(ignore_order, ignore_type, t1, t2, expected):
    result = DeepDiff(t1, t2, ignore_order=ignore_order, ignore_numeric_type_changes=ignore_type)
    assert result == expected

# Boundary condition parameterized testing
@pytest.mark.parametrize("t1, t2", [
    # Empty object testing
    ([], []),
    ({}, {}),
    (set(), set()),
    ("", ""),
    
    # Single-element testing
    ([1], [1]),
    ({"a": 1}, {"a": 1}),
    ({1}, {1}),
    
    # Large object testing
    (list(range(1000)), list(range(1000))),
    (dict(zip(range(1000), range(1000))), dict(zip(range(1000), range(1000)))),
    
    # Nested object testing
    ({"a": {"b": {"c": 1}}}, {"a": {"b": {"c": 1}}}),
    ([[[1]]], [[[1]]]),
])
def test_edge_cases(t1, t2):
    result = DeepDiff(t1, t2)
    assert result == {}
```

### Node 24: Performance Benchmarking
**Function Description**: Provide performance benchmarking functions, supporting key performance features such as performance monitoring, performance analysis, and performance regression detection. This node specifically handles the performance testing and analysis functions of DeepDiff, ensuring good performance of DeepDiff under various load conditions through systematic performance benchmarking. It supports key performance features such as performance metric monitoring, performance bottleneck analysis, performance optimization suggestions, and performance regression detection. Through a comprehensive performance benchmarking system, performance references can be provided for users and performance optimization directions for developers, ensuring the performance of DeepDiff in production environments. This function is crucial for ensuring the availability of DeepDiff in high-performance applications, big data processing, and real-time systems.
**Handling Strategy**:
- Support performance benchmarking using the `pytest-benchmark` plugin
- Support monitoring and analysis of multiple performance metrics
- Support identification and location of performance bottlenecks
- Support suggestions and guidance for performance optimization
- Handle detection and reporting of performance regressions
- Support automation and continuous integration of performance testing
- Handle collection and storage of performance data
- Support generation of performance reports and performance visualization
- Handle configuration and management of performance testing environments
- Support parallel and distributed execution of performance testing
- Handle stability and repeatability of performance testing
- Support documentation and guidelines for performance testing
**Input and Output Examples**:
```python
import pytest
from deepdiff import DeepDiff

# Basic performance benchmarking
def test_basic_comparison_performance(benchmark):
    t1 = {"a": 1, "b": 2, "c": 3}
    t2 = {"a": 1, "b": 3, "c": 4}
    
    def compare_objects():
        return DeepDiff(t1, t2)
    
    result = benchmark(compare_objects)
    assert result == {'values_changed': {"root['b']": {'new_value': 3, 'old_value': 2}, "root['c']": {'new_value': 4, 'old_value': 3}}}

# Large object performance benchmarking
def test_large_object_performance(benchmark):
    # Create large objects
    t1 = {f"key_{i}": f"value_{i}" for i in range(10000)}
    t2 = t1.copy()
    t2["key_5000"] = "modified_value"
    
    def compare_large_objects():
        return DeepDiff(t1, t2)
    
    result = benchmark(compare_large_objects)
    assert "values_changed" in result

# Nested object performance benchmarking
def test_nested_object_performance(benchmark):
    def create_nested_object(depth, width):
        if depth == 0:
            return "leaf"
        return {f"level_{depth}_{i}": create_nested_object(depth - 1, width) 
                for i in range(width)}
    
    t1 = create_nested_object(5, 3)  # 5 levels deep, 3 elements per level
    t2 = create_nested_object(5, 3)
    # Modify a leaf node
    t2["level_5_0"]["level_4_0"]["level_3_0"]["level_2_0"]["level_1_0"] = "modified_leaf"
    
    def compare_nested_objects():
        return DeepDiff(t1, t2)
    
    result = benchmark(compare_nested_objects)
    assert "values_changed" in result

# Cache performance benchmarking
def test_cache_performance(benchmark):
    from deepdiff.lfucache import LFUCache
    
    def cache_operations():
        cache = LFUCache(1000)
        for i in range(10000):
            cache.set(f"key_{i}", f"value_{i}")
            cache.get(f"key_{i}")
        return cache.get_sorted_cache_keys()
    
    result = benchmark(cache_operations)
    assert len(result) <= 1000

# Memory usage performance benchmarking
def test_memory_performance(benchmark):
    import psutil
    import os

    def memory_intensive_operation():
        # Create a large number of objects for comparison
        objects = []
        for i in range(1000):
            obj = {f"key_{j}": f"value_{j}" for j in range(100)}
            objects.append(obj)
        
        # Compare all objects
        results = []
        for i in range(len(objects) - 1):
            result = DeepDiff(objects[i], objects[i + 1])
            results.append(result)
        
        return len(results)
    
    process = psutil.Process(os.getpid())
    initial_memory = process.memory_info().rss

    result = benchmark(memory_intensive_operation)

    final_memory = process.memory_info().rss
    memory_increase = final_memory - initial_memory
    
    # Verify reasonable memory usage
    assert memory_increase < 100 * 1024 * 1024  # Less than 100MB
    assert result == 999
```

### Node 25: File Format Support
**Function Description**: Support reading, comparison, and output of multiple file formats, including mainstream data formats such as JSON, CSV, TOML, YAML, and Pickle. This node specifically handles the file format support function of DeepDiff, supporting reading, parsing, comparison, and output of various data formats through a unified file format interface. It supports key file features such as automatic file format detection, format conversion, encoding processing, and error recovery. Through comprehensive file format support, users can easily compare files in different formats, process various data sources, and achieve cross-format data comparison and analysis. This function is very important for scenarios such as data integration, ETL processing, data analysis, and system integration.
**Handling Strategy**:
- Support reading, parsing, and output of JSON format
- Support reading, parsing, and output of CSV format
- Support reading, parsing, and output of TOML format
- Support reading, parsing, and output of YAML format
- Support reading, parsing, and output of Pickle format
- Handle file encoding and character set support
- Support automatic detection and recognition of file formats
- Handle file format conversion and format migration
- Support file error handling and error recovery
- Handle chunked reading and processing of large files
- Support file compression and decompression
- Handle file security and file verification
**Input and Output Examples**:
```python
import json
import csv
import yaml
import pickle
from deepdiff import DeepDiff
from deepdiff.commands import diff, patch, grep, extract

# JSON file comparison
def test_json_file_comparison():
    # Create test JSON files
    t1_data = {"name": "John", "age": 30, "city": "New York"}
    t2_data = {"name": "John", "age": 31, "city": "Boston"}
    
    with open("t1.json", "w") as f:
        json.dump(t1_data, f)
    
    with open("t2.json", "w") as f:
        json.dump(t2_data, f)
    
    # Compare JSON files using the command line
    from click.testing import CliRunner
    runner = CliRunner()
    result = runner.invoke(diff, ["t1.json", "t2.json"])
    
    assert result.exit_code == 0
    assert "values_changed" in result.output
    assert "age" in result.output
    assert "city" in result.output

# CSV file comparison
def test_csv_file_comparison():
    # Create test CSV files
    t1_data = [
        {"id": 1, "name": "John", "age": 30},
        {"id": 2, "name": "Jane", "age": 25}
    ]
    
    t2_data = [
        {"id": 1, "name": "John", "age": 31},
        {"id": 2, "name": "Jane", "age": 25}
    ]
    
    with open("t1.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["id", "name", "age"])
        writer.writeheader()
        writer.writerows(t1_data)
    
    with open("t2.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["id", "name", "age"])
        writer.writeheader()
        writer.writerows(t2_data)
    
    # Compare CSV files using the command line
    runner = CliRunner()
    result = runner.invoke(diff, ["t1.csv", "t2.csv"])
    
    assert result.exit_code == 0
    assert "values_changed" in result.output

# YAML file comparison
def test_yaml_file_comparison():
    # Create test YAML files
    t1_data = {
        "server": {
            "host": "localhost",
            "port": 8080,
            "database": {
                "name": "testdb",
                "user": "admin"
            }
        }
    }
    
    t2_data = {
        "server": {
            "host": "localhost",
            "port": 9090,
            "database": {
                "name": "testdb",
                "user": "admin"
            }
        }
    }
    
    with open("t1.yaml", "w") as f:
        yaml.dump(t1_data, f)
    
    with open("t2.yaml", "w") as f:
        yaml.dump(t2_data, f)
    
    # Compare YAML files using the command line
    runner = CliRunner()
    result = runner.invoke(diff, ["t1.yaml", "t2.yaml"])
    
    assert result.exit_code == 0
    assert "values_changed" in result.output
    assert "port" in result.output

# TOML file comparison
def test_toml_file_comparison():
    # Create test TOML files
    t1_data = {
        "title": "TOML Example",
        "owner": {
            "name": "Tom Preston-Werner",
            "organization": "GitHub"
        },
        "database": {
            "server": "192.168.1.1",
            "ports": [8001, 8001, 8002]
        }
    }
    
    t2_data = {
        "title": "TOML Example",
        "owner": {
            "name": "Tom Preston-Werner",
            "organization": "GitHub"
        },
        "database": {
            "server": "192.168.1.2",
            "ports": [8001, 8001, 8002]
        }
    }
    
    import tomli_w
    with open("t1.toml", "wb") as f:
        tomli_w.dump(t1_data, f)
    
    with open("t2.toml", "wb") as f:
        tomli_w.dump(t2_data, f)
    
    # Compare TOML files using the command line
    runner = CliRunner()
    result = runner.invoke(diff, ["t1.toml", "t2.toml"])
    
    assert result.exit_code == 0
    assert "values_changed" in result.output
    assert "server" in result.output

# Pickle file comparison
def test_pickle_file_comparison():
    # Create test Pickle files
    t1_data = {
        "numbers": [1, 2, 3, 4, 5],
        "text": "Hello World",
        "nested": {"a": 1, "b": 2}
    }
    
    t2_data = {
        "numbers": [1, 2, 3, 4, 6],
        "text": "Hello World",
        "nested": {"a": 1, "b": 3}
    }
    
    with open("t1.pickle", "wb") as f:
        pickle.dump(t1_data, f)
    
    with open("t2.pickle", "wb") as f:
        pickle.dump(t2_data, f)
    
    # Compare Pickle files using the command line
    runner = CliRunner()
    result = runner.invoke(diff, ["t1.pickle", "t2.pickle"])
    
    assert result.exit_code == 0
    assert "values_changed" in result.output
```

### Node 26: Delta Object Complex Operations
**Function Description**: Support complex operations on Delta objects, including advanced Delta features such as bidirectional difference application, difference merging, difference verification, and difference rollback. This node specifically handles the advanced operation functions of DeepDiff's Delta objects, supporting complex difference management and application scenarios through a comprehensive Delta operation interface. It supports key Delta features such as serialization, deserialization, verification, merging, splitting, and rollback of Delta objects. Through comprehensive complex operations on Delta objects, users can implement Git-like version control functions, supporting complex data change management and application. This function is very important for scenarios such as data version management, configuration management, data migration, and system deployment.
**Handling Strategy**:
- Support bidirectional difference application of Delta objects (forward and reverse)
- Support difference merging and splitting of Delta objects
- Support difference verification and difference rollback of Delta objects
- Support serialization and deserialization of Delta objects
- Handle error handling and error recovery of Delta objects
- Support version management and version control of Delta objects
- Handle conflict detection and conflict resolution of Delta objects
- Support performance optimization and caching of Delta objects
- Handle security and permission control of Delta objects
- Support auditing and logging of Delta objects
- Handle backup and recovery of Delta objects
- Support documentation and guidelines for Delta objects
**Input and Output Examples**:
```python
from deepdiff import DeepDiff, Delta

# Bidirectional difference application
def test_bidirectional_delta():
    t1 = {"a": 1, "b": 2, "c": 3}
    t2 = {"a": 1, "b": 3, "d": 4}
    
    # Create differences
    diff = DeepDiff(t1, t2)
    delta = Delta(diff)
    
    # Forward application (t1 + delta = t2)
    result_forward = t1 + delta
    assert result_forward == t2
    
    # Reverse application (t2 - delta = t1)
    result_backward = t2 - delta
    assert result_backward == t1

# Delta object merging
def test_delta_merging():
    t1 = {"a": 1, "b": 2}
    t2 = {"a": 1, "b": 3, "c": 4}
    t3 = {"a": 5, "b": 3, "c": 4, "d": 6}
    
    # Create two Deltas
    diff1 = DeepDiff(t1, t2)
    diff2 = DeepDiff(t2, t3)
    
    delta1 = Delta(diff1)
    delta2 = Delta(diff2)
    
    # Merge Deltas
    merged_delta = delta1 + delta2
    
    # Apply the merged Delta
    result = t1 + merged_delta
    assert result == t3

# Delta object verification
def test_delta_verification():
    t1 = {"a": 1, "b": 2}
    t2 = {"a": 1, "b": 3}
    
    diff = DeepDiff(t1, t2)
    delta = Delta(diff)
    
    # Verify the correctness of the Delta
    assert delta.verify(t1, t2)
    
    # Verify bidirectional application
    result_forward = t1 + delta
    result_backward = t2 - delta
    assert result_forward == t2
    assert result_backward == t1

# Delta object serialization
def test_delta_serialization():
    t1 = {"a": 1, "b": 2}
    t2 = {"a": 1, "b": 3}
    
    diff = DeepDiff(t1, t2)
    delta = Delta(diff)
    
    # Serialize the Delta
    serialized = delta.dumps()
    
    # Deserialize the Delta
    deserialized_delta = Delta.loads(serialized)
    
    # Verify the deserialized Delta
    result = t1 + deserialized_delta
    assert result == t2

# Delta object rollback
def test_delta_rollback():
    t1 = {"a": 1, "b": 2}
    t2 = {"a": 1, "b": 3}
    t3 = {"a": 1, "b": 3, "c": 4}
    
    # Create a Delta chain
    diff1 = DeepDiff(t1, t2)
    diff2 = DeepDiff(t2, t3)
    
    delta1 = Delta(diff1)
    delta2 = Delta(diff2)
    
    # Apply the Delta chain
    current = t1 + delta1 + delta2
    assert current == t3
    
    # Roll back to t2
    current = current - delta2
    assert current == t2
    
    # Roll back to t1
    current = current - delta1
    assert current == t1

# Delta object conflict detection
def test_delta_conflict_detection():
    t1 = {"a": 1, "b": 2}
    t2 = {"a": 1, "b": 3}
    t3 = {"a": 5, "b": 2}
    
    # Create conflicting Deltas
    diff1 = DeepDiff(t1, t2)  # Modify b
    diff2 = DeepDiff(t1, t3)  # Modify a
    
    delta1 = Delta(diff1)
    delta2 = Delta(diff2)
    
    # Detect conflicts
    has_conflict = delta1.has_conflict_with(delta2)
    assert not has_conflict  # Modify different fields, no conflict
    
    # Create truly conflicting Deltas
    t4 = {"a": 1, "b": 4}
    diff3 = DeepDiff(t1, t4)  # Also modify b
    delta3 = Delta(diff3)
    
    has_conflict = delta1.has_conflict_with(delta3)
    assert has_conflict  # Modify the same field, conflict
```

### Node 27: Path Parsing Complex Scenarios
**Function Description**: Support complex path parsing scenarios, including advanced path processing functions such as nested paths, dynamic paths, path templates, and path verification. This node specifically handles the complex path parsing function of DeepDiff, supporting various complex path formats and path operations through a comprehensive path parsing engine. It supports key path features such as path templates, path variables, path verification, and path optimization. Through comprehensive complex path parsing, users can handle various complex data structure access requirements and achieve flexible data extraction and operations. This function is very important for scenarios such as data query, configuration management, template processing, and dynamic data access.
**Handling Strategy**:
- Support parsing of nested paths and deep paths
- Support dynamic paths and path variables
- Support path templates and path generation
- Support path verification and path optimization
- Handle path errors and path exceptions
- Support path caching and path performance optimization
- Handle path security and path permission control
- Support path documentation and path guidelines
- Handle path testing and path verification
- Support path debugging and path logging
- Handle path internationalization and path localization
- Support path extension and path plugins
**Input and Output Examples**:
```python
from deepdiff import extract, parse_path

# Complex nested path parsing
def test_complex_nested_paths():
    obj = {
        "users": [
            {
                "id": 1,
                "name": "John",
                "profile": {
                    "email": "john@example.com",
                    "settings": {
                        "theme": "dark",
                        "notifications": {
                            "email": True,
                            "sms": False
                        }
                    }
                }
            },
            {
                "id": 2,
                "name": "Jane",
                "profile": {
                    "email": "jane@example.com",
                    "settings": {
                        "theme": "light",
                        "notifications": {
                            "email": False,
                            "sms": True
                        }
                    }
                }
            }
        ],
        "metadata": {
            "version": "1.0",
            "created": "2023-01-01"
        }
    }
    
    # Parse complex nested paths
    path1 = "root['users'][0]['profile']['settings']['theme']"
    result1 = extract(obj, path1)
    assert result1 == "dark"
    
    path2 = "root['users'][1]['profile']['settings']['notifications']['email']"
    result2 = extract(obj, path2)
    assert result2 == False
    
    # Parse paths containing special characters
    path3 = "root['users'][0]['profile']['settings']['notifications']"
    result3 = extract(obj, path3)
    assert result3 == {"email": True, "sms": False}

# Dynamic path parsing
def test_dynamic_path_parsing():
    obj = {
        "data": {
            "2023": {
                "Q1": {"sales": 1000, "profit": 200},
                "Q2": {"sales": 1200, "profit": 250},
                "Q3": {"sales": 1100, "profit": 220},
                "Q4": {"sales": 1300, "profit": 280}
            }
        }
    }
    
    # Dynamically generate paths
    year = "2023"
    quarter = "Q2"
    metric = "sales"
    
    dynamic_path = f"root['data']['{year}']['{quarter}']['{metric}']"
    result = extract(obj, dynamic_path)
    assert result == 1200
    
    # Batch extract multiple paths
    quarters = ["Q1", "Q2", "Q3", "Q4"]
    sales_data = []
    
    for q in quarters:
        path = f"root['data']['{year}']['{q}']['sales']"
        sales_data.append(extract(obj, path))
    
    assert sales_data == [1000, 1200, 1100, 1300]

# Path template processing
def test_path_template_processing():
    # Define path templates
    templates = {
        "user_profile": "root['users'][{user_id}]['profile']",
        "user_settings": "root['users'][{user_id}]['profile']['settings']",
        "user_notifications": "root['users'][{user_id}]['profile']['settings']['notifications']"
    }
    
    obj = {
        "users": {
            "1": {"profile": {"settings": {"notifications": {"email": True}}}},
            "2": {"profile": {"settings": {"notifications": {"email": False}}}}
        }
    }
    
    # Generate paths using templates
    def get_path_from_template(template_name, **kwargs):
        template = templates[template_name]
        return template.format(**kwargs)
    
    # Extract user 1's notification settings
    path1 = get_path_from_template("user_notifications", user_id="1")
    result1 = extract(obj, path1)
    assert result1 == {"email": True}
    
    # Extract user 2's notification settings
    path2 = get_path_from_template("user_notifications", user_id="2")
    result2 = extract(obj, path2)
    assert result2 == {"email": False}

# Path validation and error handling
def test_path_validation_and_error_handling():
    obj = {"a": {"b": {"c": 1}}}
    
    # Valid paths
    valid_paths = [
        "root['a']",
        "root['a']['b']",
        "root['a']['b']['c']"
    ]
    
    for path in valid_paths:
        try:
            result = extract(obj, path)
            assert result is not None
        except Exception as e:
            assert False, f"Valid path {path} failed: {e}"
    
    # Invalid paths
    invalid_paths = [
        "root['x']",  # Non-existent key
        "root['a']['x']",  # Non-existent nested key
        "root['a']['b']['c']['d']",  # Exceeding depth
        "invalid_path",  # Incorrect format
        "root[0]",  # Incorrect index type
    ]
    
    for path in invalid_paths:
        try:
            result = extract(obj, path)
            assert False, f"Invalid path {path} should have failed"
        except Exception as e:
            # An exception should be thrown
            assert isinstance(e, (KeyError, IndexError, ValueError))

# Path performance optimization
def test_path_performance_optimization():
    import time
    
    obj = {
        "deeply": {
            "nested": {
                "structure": {
                    "with": {
                        "many": {
                            "levels": {
                                "of": {
                                    "data": "value"
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    # Test the performance of deep path extraction
    path = "root['deeply']['nested']['structure']['with']['many']['levels']['of']['data']"
    start_time = time.time()
    result = extract(obj, path)
    end_time = time.time()
    assert result == "value"
    assert (end_time - start_time) < 0.01  # Path parsing should be very fast
```
