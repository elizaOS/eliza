## Introduction and Objectives of the fuzzywuzzy Project

FuzzyWuzzy is a Python library **for fuzzy string matching** that can compare the similarity between two strings (supporting various matching algorithms and score calculation methods). This tool performs excellently in scenarios such as text deduplication, information extraction, and data cleaning, enabling "efficient and flexible string similarity calculation". Its core functions include: multiple string similarity algorithms (such as Levenshtein distance, partial matching, token sorting, etc.), **scored similarity output** (supporting percentage scores and multiple comparison modes), as well as batch processing and intelligent screening of the best matching items. In short, FuzzyWuzzy aims to provide a robust string fuzzy matching system for text data processing and similarity analysis (for example, calculating string similarity scores through the fuzz module and finding the best matching item in a candidate set through the process module).


## Natural Language Instruction (Prompt)

Please create a Python project named FuzzyWuzzy to implement a fuzzy string matching library. The project should include the following functions:

1. Basic Similarity Calculator: Calculate the similarity score between two strings, supporting multiple algorithms (such as ratio, partial_ratio, token_sort_ratio, token_set_ratio, etc.). The calculation result should be an integer score between 0 and 100, representing the similarity percentage.

2. Batch Matching Processing: Implement functions to find the best match in a candidate string set, including a single best match and multiple matching results. It should support both list and dictionary data structures, as well as custom scoring functions and preprocessors.

3. Text Preprocessing Function: Standardize the input string, including removing non-alphanumeric characters, converting case, removing spaces, etc. Support ASCII forced conversion and Unicode processing to ensure the stability of the matching algorithm.

4. Interface Design: Design independent function interfaces for each functional module (such as basic matching, batch processing, text preprocessing, etc.), supporting flexible parameter configuration. Each module should define clear input and output formats and scoring criteria.

5. Examples and Evaluation Scripts: Provide example code and test cases to demonstrate how to use the fuzz.ratio() and process.extractOne() functions for string similarity calculation and best match finding (for example, process.extractOne("new york mets", choices) should return the most similar string and its score). The above functions need to be combined to build a complete fuzzy matching toolkit. The project should ultimately include modules for similarity calculation, batch processing, text preprocessing, etc., along with typical test cases, forming a reproducible matching process.

6. Core File Requirements: The project must include a complete setup.py file. This file should not only configure the project as an installable package (supporting pip install) but also declare a complete list of dependencies (including optional performance libraries such as python-Levenshtein>=0.12, pytest>=8.0.0, hypothesis>=6.0.0, pycodestyle>=2.0.0, etc.). The setup.py file can verify whether all functional modules work properly. At the same time, it is necessary to provide fuzzywuzzy/__init__.py as a unified API entry, exporting fuzz, process, utils, StringProcessor, and the main import and export functions, and providing version information, so that users can access all major functions through a simple "from fuzzywuzzy import **" statement.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.11

### Core Dependency Library Versions

```Plain
attrs              25.3.0
exceptiongroup     1.3.0
hypothesis         6.138.2
iniconfig          2.1.0
Levenshtein        0.27.1
packaging          25.0
pip                23.0.1
pluggy             1.6.0
pycodestyle        2.14.0
Pygments           2.19.2
pytest             8.4.1
python-Levenshtein 0.27.1
RapidFuzz          3.13.0
setuptools         65.5.1
sortedcontainers   2.4.0
tomli              2.2.1
typing_extensions  4.14.1
wheel              0.40.0
```

## Architecture of the fuzzywuzzy Project

### Project Directory Structure

```Plain
workspace/
├── .editorconfig
├── .gitignore
├── .travis.yml
├── CHANGES.rst
├── LICENSE.txt
├── MANIFEST.in
├── README.md
├── benchmarks.py
├── data
│   ├── titledata.csv
├── fuzzywuzzy
│   ├── StringMatcher.py
│   ├── __init__.py
│   ├── fuzz.py
│   ├── process.py
│   ├── string_processing.py
│   ├── utils.py
├── release
├── setup.cfg
├── setup.py
└── tox.ini

```


## API Usage Guide

### Core API

#### 1. Module Import

```python
from fuzzywuzzy import fuzz, process, utils
from fuzzywuzzy.string_processing import StringProcessor
```

#### 2. fuzz.ratio() Function - Basic Similarity Calculation

**Function**: Calculate the basic similarity score between two strings based on the Levenshtein distance algorithm.

**Function Signature**:
```python
def ratio(s1, s2):
    """
    Return a measure of the sequences' similarity (float in [0,100]).
    Where T is the total number of elements in both sequences, and
    M is the number of matches, this is 2.0*M / T.
    """
```

**Parameter Description**:
- `s1` (str): The first string
- `s2` (str): The second string

**Return Value**: An integer between 0 and 100, representing the similarity percentage

**Usage Example**:
```python
from fuzzywuzzy import fuzz
score = fuzz.ratio("this is a test", "this is a test!")
print(score)  # 96
```

#### 3. fuzz.partial_ratio() Function - Partial Match Similarity Calculation

**Function**: Calculate the partial match similarity between two strings, suitable for strings with large length differences.

**Function Signature**:
```python
def partial_ratio(s1, s2):
    """
    Return the ratio of the most similar substring
    as a number between 0 and 100.
    """
```

**Parameter Description**:
- `s1` (str): The first string
- `s2` (str): The second string

**Return Value**: An integer between 0 and 100, representing the partial match similarity score

**Usage Example**:
```python
from fuzzywuzzy import fuzz
score = fuzz.partial_ratio("this is a test", "test")
print(score)  # 100
```

#### 4. fuzz.token_sort_ratio() Function - Token Sorting Similarity Calculation

**Function**: Calculate the similarity after sorting the strings by tokens, suitable for strings with different word orders.

**Function Signature**:
```python
def token_sort_ratio(s1, s2, force_ascii=True, full_process=True):
    """
    Find all alphanumeric tokens in the string, sort those tokens and take ratio of resulting joined strings.
    """
```

**Parameter Description**:
- `s1` (str): The first string
- `s2` (str): The second string
- `force_ascii` (bool): Whether to force ASCII encoding, default is True
- `full_process` (bool): Whether to perform full preprocessing, default is True

**Return Value**: An integer between 0 and 100, representing the token sorting similarity score

**Usage Example**:
```python
from fuzzywuzzy import fuzz
score = fuzz.token_sort_ratio("fuzzy wuzzy was a bear", "wuzzy fuzzy was a bear")
print(score)  # 100
```

#### 5. fuzz.token_set_ratio() Function - Token Set Similarity Calculation

**Function**: Calculate the similarity based on the intersection of token sets, suitable for strings containing repeated tokens.

**Function Signature**:
```python
def token_set_ratio(s1, s2, force_ascii=True, full_process=True):
    """
    Find all alphanumeric tokens in each of the two strings and treat them as a set.
    """
```

**Parameter Description**:
- `s1` (str): The first string
- `s2` (str): The second string
- `force_ascii` (bool): Whether to force ASCII encoding, default is True
- `full_process` (bool): Whether to perform full preprocessing, default is True

**Return Value**: An integer between 0 and 100, representing the token set similarity score

**Usage Example**:
```python
from fuzzywuzzy import fuzz
score = fuzz.token_set_ratio("fuzzy fuzzy was a bear", "wuzzy wuzzy was a bear")
print(score)  # 83
```

#### 6. fuzz.WRatio() Function - Weighted Similarity Calculation

**Function**: Calculate the weighted similarity score between two strings using multiple strategies. This is the recommended default algorithm.

**Function Signature**:
```python
def WRatio(s1, s2, force_ascii=True, full_process=True):
    """
    Return a measure of the sequences' similarity between 0 and 100, 
    using different algorithms and taking the highest score.
    """
```

**Parameter Description**:
- `s1` (str): The first string
- `s2` (str): The second string
- `force_ascii` (bool): Whether to force ASCII encoding, default is True
- `full_process` (bool): Whether to perform full preprocessing, default is True

**Return Value**: An integer between 0 and 100, representing the weighted similarity score

**Usage Example**:
```python
from fuzzywuzzy import fuzz
score = fuzz.WRatio("this is a test", "this is a test!")
print(score)  # 97
```

#### 7. process.extractOne() Function - Best Match Finding

**Function**: Find the single best match to the query string from a candidate set.

**Function Signature**:
```python
def extractOne(
    query, 
    choices, 
    processor=default_processor, 
    scorer=default_scorer, 
    score_cutoff=0
):
    """
    Find the single best match above a score in a list of choices.
    """
```

**Parameter Description**:
- `query`: The query string
- `choices`: A list or dictionary of candidate strings
- `processor`: An optional preprocessing function, default is utils.full_process
- `scorer`: An optional scoring function, default is fuzz.WRatio
- `score_cutoff` (int): The score threshold. Matches below this score will be ignored, default is 0

**Return Value**: A tuple containing the best match and its score, or None if no match is found

**Usage Example**:
```python
from fuzzywuzzy import process
choices = ["Atlanta Falcons", "New York Jets", "New York Giants", "Dallas Cowboys"]
result = process.extractOne("new york jets", choices)
print(result)  # ('New York Jets', 100)
```

#### 8. process.extract() Function - Batch Match Finding

**Function**: Find multiple matches to the query string from a candidate set.

**Function Signature**:
```python
def extract(
    query, 
    choices, 
    processor=default_processor, 
    scorer=default_scorer, 
    limit=5
):
    """
    Find best matches in a list or dictionary of choices.
    """
```

**Parameter Description**:
- `query`: The query string
- `choices`: A list or dictionary of candidate strings
- `processor`: An optional preprocessing function, default is utils.full_process
- `scorer`: An optional scoring function, default is fuzz.WRatio
- `limit` (int): The maximum number of results to return, default is 5

**Return Value**: A list of tuples containing the matches and their scores, sorted in descending order by score

**Usage Example**:
```python
from fuzzywuzzy import process
choices = ["Atlanta Falcons", "New York Jets", "New York Giants", "Dallas Cowboys"]
results = process.extract("new york", choices, limit=2)
print(results)  # [('New York Jets', 90), ('New York Giants', 90)]
```

#### 9. process.dedupe() Function - Fuzzy Deduplication

**Function**: Remove similar duplicates from a string list.

**Function Signature**:
```python
def dedupe(contains_dupes, threshold=70, scorer=fuzz.token_set_ratio):
    """
    Remove duplicates from an iterable. Preserves order. Retains the first occurrence of each duplicate.
    """
```

**Parameter Description**:
- `contains_dupes`: A string list containing duplicates
- `threshold` (int): The similarity threshold, default is 70
- `scorer`: An optional scoring function, default is fuzz.token_set_ratio

**Return Value**: A deduplicated string list

**Usage Example**:
```python
from fuzzywuzzy import process
duplicates = ['Frodo Baggins', 'Frodo Baggin', 'F. Baggins', 'Samwise G.', 'Gandalf']
deduplicated = process.dedupe(duplicates, threshold=70)
print(deduplicated)  # ['Frodo Baggins', 'Samwise G.', 'Gandalf']
```

#### 10. utils.full_process() Function - Complete Text Preprocessing

**Function**: Standardize the input string, including removing non-alphanumeric characters, converting case, removing spaces, etc.

**Function Signature**:
```python
def full_process(s, force_ascii=False):
    """
    Process string by
        -- removing all but letters and numbers
        -- trim whitespace
        -- force to lower case
        if force_ascii == True, force convert to ascii
    """
```

**Parameter Description**:
- `s` (str): The string to be processed
- `force_ascii` (bool): Whether to force ASCII conversion, default is False

**Return Value**: The processed string

**Usage Example**:
```python
from fuzzywuzzy import utils
text = "  Hello, World! 123  "
processed = utils.full_process(text)
print(processed)  # "hello world 123"
```
#### 11. utils.asciionly() Function - ASCII Conversion

**Function**: Convert a string to ASCII format, removing non-ASCII characters.

**Function Signature**:
```python
def asciionly(s):
    if PY3:
        return s.translate(translation_table)
    else:
        return s.translate(None, bad_chars)
```

**Parameter Description**:
- `s` (str): The string to be processed

**Return Value**: The processed string in ASCII format

#### 12. fuzz._token_set() Function - Token Set Intersection

**Function**: Calculate the similarity ratio based on token set intersection.

**Function Signature**:
```python
@utils.check_for_none
def _token_set(s1, s2, partial=True, force_ascii=True, full_process=True):
    """Find all alphanumeric tokens in each string...
        - treat them as a set
        - construct two strings of the form:
            <sorted_intersection><sorted_remainder>
        - take ratios of those two strings
        - controls for unordered partial matches"""

```

**Parameter Description**:
- `s1` (str): The first string
- `s2` (str): The second string
- `partial` (bool): Whether to use partial matching, default is True
- `force_ascii` (bool): Whether to force ASCII conversion, default is True
- `full_process` (bool): Whether to perform complete preprocessing, default is True

**Return Value**: Return an integer between 0 and 100

#### 13. fuzz._token_sort() Function - Token Sorting

**Function**: Calculate the similarity ratio based on token sorting.

**Function Signature**:
```python
@utils.check_for_none
def _token_sort(s1, s2, partial=True, force_ascii=True, full_process=True):
    sorted1 = _process_and_sort(s1, force_ascii, full_process=full_process)
    sorted2 = _process_and_sort(s2, force_ascii, full_process=full_process)

    if partial:
        return partial_ratio(sorted1, sorted2)
    else:
        return ratio(sorted1, sorted2)

```
**Parameter Description**:
- `s1` (str): The first string
- `s2` (str): The second string
- `partial` (bool): Whether to use partial matching, default is True
- `force_ascii` (bool): Whether to force ASCII conversion, default is True
- `full_process` (bool): Whether to perform complete preprocessing, default is True

**Return Value**: Return an integer between 0 and 100

#### 14 fuzz.QRatio() Function - Quick Ratio

**Function**: Calculate the similarity ratio based on a quick algorithm.

**Function Signature**:
```python
def QRatio(s1, s2, force_ascii=True, full_process=True):
    """
    Quick ratio comparison between two strings.

    Runs full_process from utils on both strings
    Short circuits if either of the strings is empty after processing.

    :param s1:
    :param s2:
    :param force_ascii: Allow only ASCII characters (Default: True)
    :full_process: Process inputs, used here to avoid double processing in extract functions (Default: True)
    :return: similarity ratio
    """


```

**Parameter Description**:
- `s1` (str): The first string
- `s2` (str): The second string
- `force_ascii` (bool): Whether to force ASCII conversion, default is True
- `full_process` (bool): Whether to perform complete preprocessing, default is True

**Return Value**: Return an integer between 0 and 100

#### 15 extractWithoutOrder() Function - Extract Without Order

**Function**: Extract the best match in a list or dictionary of choices without order.

**Function Signature**:
```python
def extractWithoutOrder(query, choices, processor=default_processor, scorer=default_scorer, score_cutoff=0):
    """Select the best match in a list or dictionary of choices.

    Find best matches in a list or dictionary of choices, return a
    generator of tuples containing the match and its score. If a dictionary
    is used, also returns the key for each match.

    Arguments:
        query: An object representing the thing we want to find.
        choices: An iterable or dictionary-like object containing choices
            to be matched against the query. Dictionary arguments of
            {key: value} pairs will attempt to match the query against
            each value.
        processor: Optional function of the form f(a) -> b, where a is the query or
            individual choice and b is the choice to be used in matching.

            This can be used to match against, say, the first element of
            a list:

            lambda x: x[0]

            Defaults to fuzzywuzzy.utils.full_process().
        scorer: Optional function for scoring matches between the query and
            an individual processed choice. This should be a function
            of the form f(query, choice) -> int.

            By default, fuzz.WRatio() is used and expects both query and
            choice to be strings.
        score_cutoff: Optional argument for score threshold. No matches with
            a score less than this number will be returned. Defaults to 0.

    Returns:
        Generator of tuples containing the match and its score.

        If a list is used for choices, then the result will be 2-tuples.
        If a dictionary is used, then the result will be 3-tuples containing
        the key for each match.

        For example, searching for 'bird' in the dictionary

        {'bard': 'train', 'dog': 'man'}

        may return

        ('train', 22, 'bard'), ('man', 0, 'dog')
    """
    # Catch generators without lengths
    def no_process(x):
        return x

```

**Parameter Description**:
- `query` (str): The query string
- `choices` (list or dictionary): The list or dictionary of choices
- `processor` (function): The preprocessing function
- `scorer` (function): The scoring function
- `score_cutoff` (int): The score cutoff

**Return Value**: A generator of tuples containing the match and its score.

**Usage Example**:
```python
from fuzzywuzzy import process
choices = ["Atlanta Falcons", "New York Jets", "New York Giants", "Dallas Cowboys"]
result = process.extractWithoutOrder("new york jets", choices)
print(result)  # [('New York Jets', 100)]
```

#### 16 extractBests() Function - Extract Best Matches

**Function**: Get a list of the best matches to a collection of choices.

**Function Signature**:
```python
def extractBests(query, choices, processor=default_processor, scorer=default_scorer, score_cutoff=0, limit=5):
    """Get a list of the best matches to a collection of choices.

    Convenience function for getting the choices with best scores.

    Args:
        query: A string to match against
        choices: A list or dictionary of choices, suitable for use with
            extract().
        processor: Optional function for transforming choices before matching.
            See extract().
        scorer: Scoring function for extract().
        score_cutoff: Optional argument for score threshold. No matches with
            a score less than this number will be returned. Defaults to 0.
        limit: Optional maximum for the number of elements returned. Defaults
            to 5.

    Returns: A a list of (match, score) tuples.
    """
```

**Parameter Description**:
- `query` (str): The query string
- `choices` (list or dictionary): The list or dictionary of choices
- `processor` (function): The preprocessing function
- `scorer` (function): The scoring function
- `score_cutoff` (int): The score cutoff
- `limit` (int): The maximum number of results to return

**Return Value**: A list of tuples containing the matches and their scores.

**Usage Example**:
```python
from fuzzywuzzy import process
choices = ["Atlanta Falcons", "New York Jets", "New York Giants", "Dallas Cowboys"]
result = process.extractBests("new york jets", choices, limit=2)
print(result)  # [('New York Jets', 100), ('New York Giants', 90)]
```

### Detailed Explanation of Configuration Classes

#### 1. StringProcessor

**Function**: Provide core methods for string processing

```python
class StringProcessor(object):
    """
    This class defines method to process strings in the most
    efficient way. Ideally all the methods below use unicode strings
    for both input and output.
    """
```

**Main Methods**:
- `replace_non_letters_non_numbers_with_whitespace()`: Replace non-alphanumeric characters with spaces
- `to_lower_case()`: Convert to lower case
- `to_upper_case()`: Convert to upper case
- `strip()`: Remove leading and trailing spaces

#### 2. Decorator Configuration

**Function**: Provide decorators for data validation and performance optimization

```python
@utils.check_for_none
@utils.check_for_equivalence
@utils.check_empty_string
def ratio(s1, s2):
    # Function implementation
```

**Decorator Explanation**:
- `@check_for_none`: Check for None values. If any parameter is None, return 0
- `@check_for_equivalence`: Check for equivalence. If the strings are the same, return 100 directly
- `@check_empty_string`: Check for empty strings. If any string is empty, return 0


### Detailed Explanation of Core Algorithms

#### 1. Basic Similarity Algorithms

**ratio(s1, s2)**: Basic Levenshtein distance similarity
**partial_ratio(s1, s2)**: Partial match similarity, suitable for strings with large length differences
**token_sort_ratio(s1, s2)**: Similarity calculation after token sorting
**token_set_ratio(s1, s2)**: Similarity calculation based on set intersection

#### 2. Advanced Similarity Algorithms

**WRatio(s1, s2)**: Weighted comprehensive algorithm that automatically selects the best strategy
**QRatio(s1, s2)**: Fast similarity calculation
**UWRatio(s1, s2)**: Unicode weighted algorithm
**UQRatio(s1, s2)**: Unicode fast algorithm

#### 3. Preprocessor Configuration

**utils.full_process(s, force_ascii=False)**: Complete text preprocessing
- Remove non-alphanumeric characters
- Convert to lower case
- Remove leading and trailing spaces
- Optional ASCII forced conversion

### Practical Usage Modes

#### Basic Usage

```python
from fuzzywuzzy import fuzz, process

# Simple similarity calculation
score = fuzz.ratio("this is a test", "this is a test!")
print(score)  # 96

# Best match finding
choices = ["Atlanta Falcons", "New York Jets", "New York Giants", "Dallas Cowboys"]
result = process.extractOne("new york jets", choices)
print(result)  # ('New York Jets', 100)
```

#### Advanced Usage

```python
from fuzzywuzzy import fuzz, process, utils

# Use different algorithms
score1 = fuzz.ratio("fuzzy wuzzy was a bear", "wuzzy fuzzy was a bear")
score2 = fuzz.partial_ratio("fuzzy wuzzy was a bear", "wuzzy fuzzy was a bear")
score3 = fuzz.token_sort_ratio("fuzzy wuzzy was a bear", "wuzzy fuzzy was a bear")
score4 = fuzz.token_set_ratio("fuzzy wuzzy was a bear", "wuzzy fuzzy was a bear")

# Batch matching
choices = ["Atlanta Falcons", "New York Jets", "New York Giants", "Dallas Cowboys"]
results = process.extract("new york jets", choices, limit=2)
print(results)  # [('New York Jets', 100), ('New York Giants', 78)]

# Custom preprocessing and scoring
def custom_processor(s):
    return s.upper()

result = process.extractOne(
    "new york jets", 
    choices, 
    processor=custom_processor,
    scorer=fuzz.partial_ratio
)
```

#### Deduplication Function

```python
from fuzzywuzzy import process

# Fuzzy deduplication
duplicates = ['Frodo Baggins', 'Frodo Baggin', 'F. Baggins', 'Samwise G.', 'Gandalf']
deduplicated = process.dedupe(duplicates, threshold=70)
print(deduplicated)  # ['Frodo Baggins', 'Samwise G.', 'Gandalf']
```

### Supported String Types

- **Basic Text**: Ordinary English strings, numeric strings
- **Multilingual Text**: Unicode strings, non-ASCII characters
- **Formatted Text**: Text containing punctuation and special characters
- **Structured Data**: String values in lists and dictionaries
- **Mixed Content**: Mixed strings containing numbers and text
- **Special Formats**: Formatted strings such as email addresses, URLs, file paths

### Error Handling

The system provides a comprehensive error handling mechanism:
- **Type Checking**: Automatically handle None values and empty strings
- **Encoding Fault Tolerance**: Support mixed processing of Unicode and ASCII strings
- **Performance Optimization**: Use decorators for fast equivalence checks
- **Exception Capture**: Gracefully handle incompatible data types

### Important Notes

1. **Performance Optimization**: Installing the `python-Levenshtein` library can significantly improve the calculation speed.
2. **Encoding Handling**: It is recommended to use Unicode strings for the best compatibility.
3. **Threshold Setting**: Adjust the `score_cutoff` parameter according to the application scenario to filter out low-quality matches.
4. **Preprocessor Selection**: Choose an appropriate preprocessing function based on the data characteristics.



## Detailed Implementation Nodes of Functions

### Node 1: Basic Similarity Calculation (Basic Similarity Calculation)

**Function Description**: Implement multiple string similarity calculation algorithms and provide a similarity score between 0 and 100. Support different strategies such as basic Levenshtein distance, partial match, and token sorting.

**Core Algorithms**:
- Levenshtein distance calculation
- Partial string matching
- Token sorting comparison
- Set intersection analysis

**Input and Output Examples**:

```python
from fuzzywuzzy import fuzz

# Basic similarity calculation
score = fuzz.ratio("this is a test", "this is a test!")
print(score)  # 96

score = fuzz.ratio("fuzzy wuzzy was a bear", "wuzzy fuzzy was a bear")
print(score)  # 91

# Partial match similarity
score = fuzz.partial_ratio("this is a test", "this is a test!")
print(score)  # 100

score = fuzz.partial_ratio("fuzzy wuzzy was a bear", "wuzzy fuzzy was a bear")
print(score)  # 100

# Token sorting similarity
score = fuzz.token_sort_ratio("fuzzy wuzzy was a bear", "wuzzy fuzzy was a bear")
print(score)  # 100

score = fuzz.token_sort_ratio("fuzzy was a bear", "a bear fuzzy was")
print(score)  # 100

# Set similarity
score = fuzz.token_set_ratio("fuzzy fuzzy was a bear", "wuzzy wuzzy was a bear")
print(score)  # 83

# Test verification
assert fuzz.ratio("test", "test") == 100
assert fuzz.partial_ratio("this is a test", "test") == 100
assert fuzz.token_sort_ratio("fuzzy wuzzy", "wuzzy fuzzy") == 100
```

### Node 2: Batch Matching Processing (Batch Matching Processing)

**Function Description**: Perform batch matching in a candidate string set, supporting a single best match, multiple matching results, and fuzzy deduplication.

**Core Functions**:
- Single best match: `extractOne()`
- Multiple matching results: `extract()`
- Fuzzy deduplication: `dedupe()`
- Custom scoring functions and preprocessors

**Input and Output Examples**:

```python
from fuzzywuzzy import process

# Single best match
choices = ["Atlanta Falcons", "New York Jets", "New York Giants", "Dallas Cowboys"]
result = process.extractOne("new york jets", choices)
print(result)  # ('New York Jets', 100)

result = process.extractOne("cowboys", choices)
print(result)  # ('Dallas Cowboys', 90)

# Multiple matching results
results = process.extract("new york", choices, limit=2)
print(results)  # [('New York Jets', 90), ('New York Giants', 90)]

results = process.extract("jets", choices, limit=3)
print(results)  # [('New York Jets', 90), ('New York Giants', 57), ('Atlanta Falcons', 35)]

# Fuzzy deduplication
duplicates = ['Frodo Baggins', 'Frodo Baggin', 'F. Baggins', 'Samwise G.', 'Gandalf']
deduplicated = process.dedupe(duplicates, threshold=70)
print(deduplicated)  # ['Frodo Baggins', 'Samwise G.', 'Gandalf']
```

### Node 3: Text Preprocessing Function (Text Preprocessing)

**Function Description**: Standardize the input string to improve the accuracy and consistency of the matching algorithm. Support multiple preprocessing strategies and encoding handling.

**Preprocessing Strategies**:
- Remove non-alphanumeric characters
- Convert to lower case
- Remove leading and trailing spaces
- ASCII forced conversion
- Unicode standardization

**Input and Output Examples**:

```python
from fuzzywuzzy import utils
from fuzzywuzzy.string_processing import StringProcessor

# Complete preprocessing
text = "  Hello, World! 123  "
processed = utils.full_process(text)
print(processed)  # "hello world 123"

text = "New York Mets vs. Atlanta Braves!!!"
processed = utils.full_process(text)
print(processed)  # "new york mets vs atlanta braves"

# ASCII forced conversion
text = "Café résumé naïve"
processed = utils.full_process(text, force_ascii=True)
print(processed)  # "caf rsum nave"

# Individual preprocessing steps
text = "Hello, World! 123"
step1 = StringProcessor.replace_non_letters_non_numbers_with_whitespace(text)
print(step1)  # "Hello  World  123"

step2 = StringProcessor.to_lower_case(step1)
print(step2)  # "hello  world  123"

step3 = StringProcessor.strip(step2)
print(step3)  # "hello  world  123"
```

### Node 4: Performance Optimization and Advanced Algorithms (Performance Optimization)

**Function Description**: Provide high-performance string matching algorithms, supporting weighted comprehensive scoring and multiple optimization strategies.

**Optimization Strategies**:
- Weighted comprehensive algorithm: `WRatio()`
- Fast matching algorithm: `QRatio()`
- Unicode optimization: `UWRatio()`, `UQRatio()`
- Levenshtein distance optimization

**Input and Output Examples**:

```python
from fuzzywuzzy import fuzz

# Weighted comprehensive algorithm (recommended)
score = fuzz.WRatio("this is a test", "this is a test!")
print(score)  # 97

score = fuzz.WRatio("fuzzy wuzzy was a bear", "wuzzy fuzzy was a bear")
print(score)  # 91

# Fast algorithm
score = fuzz.QRatio("this is a test", "this is a test!")
print(score)  # 96

# Unicode optimization algorithm
score = fuzz.UWRatio("Café résumé", "cafe resume")
print(score)  # 89

score = fuzz.UQRatio("Café résumé", "cafe resume")
print(score)  # 89

# Performance comparison
import time
start = time.time()
for _ in range(1000):
    fuzz.WRatio("fuzzy wuzzy was a bear", "wuzzy fuzzy was a bear")
end = time.time()
print(f"WRatio 1000 times: {end-start:.4f} seconds")
```

### Node 5: Error Handling and Validation Mechanism (Error Handling & Validation)

**Function Description**: Provide a comprehensive error handling mechanism and input validation to ensure the stability and reliability of the algorithm in various boundary cases.

**Core Functions**:
- Input validation: `validate_string()`
- Decorator validation: `check_for_none`, `check_for_equivalence`, `check_empty_string`
- Type consistency processing: `make_type_consistent()`
- Encoding fault tolerance processing: `asciidammit()`, `asciionly()`

**Input and Output Examples**:

```python
from fuzzywuzzy import utils, fuzz

# Input validation
print(utils.validate_string("test"))  # True
print(utils.validate_string(""))      # False
print(utils.validate_string(None))    # False

# Decorator validation - Equivalence check
score = fuzz.ratio("same", "same")
print(score)  # 100 (Return directly without performing calculation)

# Decorator validation - None value handling
score = fuzz.ratio("test", None)
print(score)  # 0 (Return directly without performing calculation)

# Decorator validation - Empty string handling
score = fuzz.ratio("", "test")
print(score)  # 0 (Return directly without performing calculation)

# Type consistency processing
str1, str2 = utils.make_type_consistent("hello", u"world")
print(type(str1), type(str2))  # <class 'str'> <class 'str'>

# Encoding fault tolerance processing
text = "Café résumé naïve"
ascii_text = utils.asciidammit(text)
print(ascii_text)  # "Caf rsum nave"

# Boundary case testing
edge_cases = ["", None, "   ", "123", "!@#$%", "Chinese test"]
for case in edge_cases:
    try:
        score = fuzz.ratio("test", case)
        print(f"'{case}' -> {score}")
    except Exception as e:
        print(f"'{case}' -> Error: {e}")
```

### Node 6: Advanced Matching Algorithms (Advanced Matching Algorithms)

**Function Description**: Provide multiple advanced string matching algorithms, including partial match, token sorting, set match, etc., to meet the matching needs of different scenarios.

**Core Algorithms**:
- Partial match: `partial_ratio()`, `partial_token_sort_ratio()`, `partial_token_set_ratio()`
- Token sorting: `token_sort_ratio()`, `partial_token_sort_ratio()`
- Set match: `token_set_ratio()`, `partial_token_set_ratio()`
- Fast algorithm: `QRatio()`, `UQRatio()`

**Input and Output Examples**:

```python
from fuzzywuzzy import fuzz

# Partial match algorithm
score = fuzz.partial_ratio("this is a test", "test")
print(score)  # 100

score = fuzz.partial_ratio("fuzzy wuzzy", "wuzzy fuzzy")
print(score)  # 100

# Token sorting algorithm
score = fuzz.token_sort_ratio("fuzzy wuzzy was a bear", "wuzzy fuzzy was a bear")
print(score)  # 100

score = fuzz.token_sort_ratio("fuzzy was a bear", "a bear fuzzy was")
print(score)  # 100

score = fuzz.partial_token_sort_ratio("fuzzy wuzzy was a bear", "wuzzy fuzzy was a bear")
print(score)  # 100

# Set match algorithm
score = fuzz.token_set_ratio("fuzzy fuzzy was a bear", "wuzzy wuzzy was a bear")
print(score)  # 83

score = fuzz.token_set_ratio("fuzzy wuzzy was a bear", "wuzzy fuzzy was a bear")
print(score)  # 100

score = fuzz.partial_token_set_ratio("fuzzy wuzzy was a bear", "wuzzy fuzzy was a bear")
print(score)  # 100

# Fast algorithm
score = fuzz.QRatio("this is a test", "this is a test!")
print(score)  # 96

score = fuzz.UQRatio("Café résumé", "cafe resume")
print(score)  # 89

# Algorithm comparison test
test_strings = [
    ("fuzzy wuzzy was a bear", "wuzzy fuzzy was a bear"),
    ("this is a test", "this is a test!"),
    ("new york mets", "new YORK mets"),
    ("cirque du soleil", "cirque du soleil las vegas")
]

for s1, s2 in test_strings:
    print(f"\nComparison: '{s1}' vs '{s2}'")
    print(f"ratio: {fuzz.ratio(s1, s2)}")
    print(f"partial_ratio: {fuzz.partial_ratio(s1, s2)}")
    print(f"token_sort_ratio: {fuzz.token_sort_ratio(s1, s2)}")
    print(f"token_set_ratio: {fuzz.token_set_ratio(s1, s2)}")
    print(f"WRatio: {fuzz.WRatio(s1, s2)}")
```

### Node 7: Data Validation and Decorators (Data Validation & Decorators)

**Function Description**: Implement data validation and performance optimization through the decorator pattern, providing reusable validation logic and caching mechanisms.

**Core Functions**:
- Validation decorators: `@check_for_none`, `@check_for_equivalence`, `@check_empty_string`
- Type conversion: `make_type_consistent()`
- Numerical processing: `intr()` - Integer conversion
- String processing: `full_process()` - Complete preprocessing

**Input and Output Examples**:

```python
from fuzzywuzzy import utils, fuzz

# Decorator validation test
def test_decorators():
    # Equivalence check decorator
    @utils.check_for_equivalence
    def test_ratio(s1, s2):
        return 50  # Simulate calculation
    
    # Identical strings should return 100 directly
    result = test_ratio("same", "same")
    print(f"Equivalence check: {result}")  # 100
    
    # None value check decorator
    @utils.check_for_none
    def test_ratio(s1, s2):
        return 50  # Simulate calculation
    
    # None value should return 0 directly
    result = test_ratio("test", None)
    print(f"None value check: {result}")  # 0
    
    # Empty string check decorator
    @utils.check_empty_string
    def test_ratio(s1, s2):
        return 50  # Simulate calculation
    
    # Empty string should return 0 directly
    result = test_ratio("", "test")
    print(f"Empty string check: {result}")  # 0

test_decorators()

# Type consistency processing
str1, str2 = utils.make_type_consistent("hello", u"world")
print(f"Type consistency: {type(str1)} == {type(str2)}")  # True

# Numerical processing
float_val = 95.7
int_val = utils.intr(float_val)
print(f"Numerical conversion: {float_val} -> {int_val}")  # 95.7 -> 96

# Complete preprocessing test
test_strings = [
    "  Hello, World! 123  ",
    "New York //// Mets $$$",
    "Café résumé naïve",
    "!@#$%^&*()",
    ""
]

for s in test_strings:
    processed = utils.full_process(s)
    print(f"'{s}' -> '{processed}'")

# Combined use of decorators
@utils.check_for_none
@utils.check_for_equivalence
@utils.check_empty_string
def custom_ratio(s1, s2):
    # Simulate complex similarity calculation
    return 75

# Test combined decorators
test_cases = [
    ("same", "same"),      # Equivalence check
    ("test", None),        # None value check
    ("", "test"),          # Empty string check
    ("hello", "world")     # Normal calculation
]

for s1, s2 in test_cases:
    result = custom_ratio(s1, s2)
    print(f"'{s1}' vs '{s2}' -> {result}")
```

### Node 8: Project Configuration and Installation Management (Project Configuration & Installation)

**Function Description**: Provide complete project configuration, installation management, and development tool support to ensure the maintainability and deployability of the project.

**Core Functions**:
- Project installation configuration: `setup.py`, `setup.cfg`
- Packaging resources: `MANIFEST.in`
- Testing framework: `tox.ini`
- Version management: `fuzzywuzzy/__init__.py`
- Performance benchmark: `benchmarks.py`

**Input and Output Examples**:

```python
# setup.py configuration example
"""
from setuptools import setup, find_packages

setup(
    name="fuzzywuzzy",
    version="0.18.0",
    description="Fuzzy string matching in python",
    author="Adam Cohen",
    author_email="adam@seatgeek.com",
    url="https://github.com/seatgeek/fuzzywuzzy",
    packages=find_packages(),
    install_requires=[
        "python-Levenshtein>=0.12",  # Optional, for performance improvement
    ],
    extras_require={
        "speedup": ["python-Levenshtein>=0.12"],
    },
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: GPL License",
        "Operating System :: OS Independent",
        "Programming Language :: Python",
        "Programming Language :: Python :: 2.7",
        "Programming Language :: Python :: 3",
        "Topic :: Text Processing :: General",
    ],
)
"""

# Version information management
from fuzzywuzzy import __version__
print(f"FuzzyWuzzy version: {__version__}")  # 0.18.0

# Performance benchmark test
import time
from fuzzywuzzy import fuzz, process

def benchmark_performance():
    test_strings = [
        "cirque du soleil - zarkana - las vegas",
        "cirque du soleil ",
        "cirque du soleil las vegas",
        "zarkana las vegas",
        "las vegas cirque du soleil at the bellagio",
    ]
    
    choices = [
        "new york yankees vs boston red sox",
        "zarakana - cirque du soleil - bellagio",
        "cirque du soleil las vegas",
    ]
    
    # Benchmark test: ratio algorithm
    start_time = time.time()
    for _ in range(1000):
        for s in test_strings:
            fuzz.ratio("cirque du soleil", s)
    ratio_time = time.time() - start_time
    
    # Benchmark test: WRatio algorithm
    start_time = time.time()
    for _ in range(1000):
        for s in test_strings:
            fuzz.WRatio("cirque du soleil", s)
    wratio_time = time.time() - start_time
    
    # Benchmark test: process.extract
    start_time = time.time()
    for _ in range(100):
        process.extract("cirque du soleil", choices, limit=3)
    extract_time = time.time() - start_time
    
    print(f"Performance benchmark test results:")
    print(f"ratio algorithm 1000 times: {ratio_time:.4f} seconds")
    print(f"WRatio algorithm 1000 times: {wratio_time:.4f} seconds")
    print(f"process.extract 100 times: {extract_time:.4f} seconds")

```