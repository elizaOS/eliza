## Introduction and Goals of the python-pingyin Project

Pinyin is a Python library specifically designed for Chinese character pinyin conversion. It can accurately convert Chinese characters into pinyin and is widely used in areas such as Chinese character phonetic annotation, sorting, and retrieval. Its aim is to become a powerful and easy-to-use Chinese character processing tool, providing stable and efficient pinyin conversion support for Chinese information processing and natural language processing applications.

Core Features:
- Intelligent Pinyin Conversion: It can intelligently match the most correct pinyin according to phrases and supports the polyphone mode.
- Diverse Style Support: It supports multiple pinyin output formats, such as initials, finals, tone marks, tone numbers, as well as Bopomofo and Wade-Giles pinyin.
- Simplified and Traditional Chinese and Tone Sandhi Handling: It supports the conversion of traditional Chinese characters and can handle continuous tone sandhi rules in words like "你好" (nǐ hǎo).
- Highly Customizable: It allows users to load custom single-character or phrase pinyin libraries to correct or expand the default pinyin data.

## Natural Language Instruction (Prompt)

Please create a Python project named python-pinyin to implement a Chinese character pinyin conversion library. The project should include the following functions:

1. Expression Parser: It can extract and parse Chinese character text from the input string, supporting simplified Chinese, traditional Chinese, punctuation marks, and special characters. The parsing result should be a pinyin string or an equivalent comparable form.

2. Equivalence Check: Implement a function (or script) to compare whether two pinyin expressions are equivalent, including tone comparison and symbol comparison. It should support approximate comparison between tone marks and numerical tones, judgment of pinyin symbol simplification, and equivalence judgment of polyphones/heteronyms.

3. Special Structure Handling: Special handling should be performed on initials, finals, tones, Bopomofo, Wade-Giles pinyin, etc. For example, "nǐ" and "ni3" should be considered equivalent, and separating initials and finals like "n" + "i" is equivalent to "ni".

4. Interface Design: Design independent command-line interfaces or function interfaces for each functional module (such as parsing, tone comparison, symbol comparison, style conversion, etc.) to support terminal call testing. Each module should define clear input and output formats.

5. Examples and Evaluation Scripts: Provide example code and test cases to demonstrate how to use the parse() and convert() functions for input parsing and pinyin conversion (e.g., convert(parse("你好"), style="tone") should return ['nǐ', 'hǎo']). The above functions need to be combined to build a complete pinyin conversion toolkit. The project should ultimately include modules such as parsing, conversion, and overall verification, along with typical test cases, to form a reproducible conversion process.

6. Core file requirement: The project must include a complete setup. py file. This file should not only configure the project as an installable package (supporting pip installation), but also declare a complete list of dependencies (including core libraries such as  jieba==0.42.1, typing-extensions==4.12.2, chardet==5.2.0）。 The setup. py file can verify whether all functional modules are working properly. At the same time, it is necessary to provide pypinyin/__init__. py as a unified API entry point to import and export core functions, classes, etc., and provide version information so that users can access all major functions through a simple "from pypinyin import xxx, from pypinyin. xxx import xxx" statement. In converter. py, a pinyin_comvert() function is required to use multiple strategies to convert Chinese characters into pinyin.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.11

### Core Dependency Library Versions

```Plain
alabaster                     1.0.0
babel                         2.17.0
backports.tarfile             1.2.0
bump2version                  1.0.1
bumpversion                   0.6.0
cachetools                    6.1.0
certifi                       2025.8.3
cffi                          1.17.1
cfgv                          3.4.0
chardet                       5.2.0
charset-normalizer            3.4.2
colorama                      0.4.6
coverage                      7.10.2
cryptography                  45.0.5
distlib                       0.4.0
docutils                      0.21.2
exceptiongroup                1.3.0
filelock                      3.18.0
id                            1.5.0
identify                      2.6.12
idna                          3.10
imagesize                     1.4.1
importlib_metadata            8.7.0
iniconfig                     2.1.0
jaraco.classes                3.4.0
jaraco.context                6.0.1
jaraco.functools              4.2.1
jeepney                       0.9.0
Jinja2                        3.1.6
keyring                       25.6.0
markdown-it-py                3.0.0
MarkupSafe                    3.0.2
mdurl                         0.1.2
more-itertools                10.7.0
mypy                          1.17.1
mypy_extensions               1.1.0
nh3                           0.3.0
nodeenv                       1.9.1
packaging                     25.0
pathspec                      0.12.1
pip                           23.0.1
platformdirs                  4.3.8
pluggy                        1.6.0
pre_commit                    4.2.0
pycparser                     2.22
Pygments                      2.19.2
pyproject-api                 1.9.1
pytest                        8.4.1
pytest-cov                    6.2.1
pytest-random-order           1.2.0
PyYAML                        6.0.2
readme_renderer               44.0
requests                      2.32.4
requests-toolbelt             1.0.0
rfc3986                       2.0.0
rich                          14.1.0
SecretStorage                 3.3.3
setuptools                    65.5.1
snowballstemmer               3.0.1
Sphinx                        8.1.3
sphinxcontrib-applehelp       2.0.0
sphinxcontrib-devhelp         2.0.0
sphinxcontrib-htmlhelp        2.1.0
sphinxcontrib-jsmath          1.0.1
sphinxcontrib-qthelp          2.0.0
sphinxcontrib-serializinghtml 2.0.0
tomli                         2.2.1
tox                           4.28.4
twine                         6.1.0
typing_extensions             4.14.1
urllib3                       2.5.0
virtualenv                    20.33.0
wheel                         0.40.0
zipp                          3.23.0
```

## Project Architecture of python-pinyin

### Project Directory Structure

```Plain
workspace/
├── .bumpversion.cfg
├── .circleci
│   ├── config.yml
├── .coveragerc
├── .devcontainer
│   ├── devcontainer.json
├── .editorconfig
├── .gitignore
├── .gitmodules
├── .pre-commit-config.yaml
├── .readthedocs.yaml
├── CHANGELOG.rst
├── CODE_OF_CONDUCT.md
├── LICENSE.txt
├── MANIFEST.in
├── Makefile
├── README.rst
├── README_en.rst
├── README_ru.rst
├── gen_phrases_dict.py
├── gen_pinyin_dict.py
├── phrase-pinyin-data
├── pinyin-data
├── pypinyin
│   ├── __init__.py
│   ├── __init__.pyi
│   ├── __main__.py
│   ├── __pyinstaller
│   │   ├── __init__.py
│   │   ├── __init__.pyi
│   │   ├── hook-pypinyin.py
│   ├── compat.py
│   ├── compat.pyi
│   ├── constants.py
│   ├── constants.pyi
│   ├── contrib
│   │   ├── __init__.py
│   │   ├── _tone_rule.py
│   │   ├── _tone_rule.pyi
│   │   ├── mmseg.py
│   │   ├── mmseg.pyi
│   │   ├── neutral_tone.py
│   │   ├── neutral_tone.pyi
│   │   ├── tone_convert.py
│   │   ├── tone_convert.pyi
│   │   ├── tone_sandhi.py
│   │   ├── tone_sandhi.pyi
│   │   ├── uv.py
│   │   ├── uv.pyi
│   ├── converter.py
│   ├── converter.pyi
│   ├── core.py
│   ├── core.pyi
│   ├── exceptions.py
│   ├── exceptions.pyi
│   ├── legacy
│   │   ├── __init__.py
│   │   ├── phrases_dict.py
│   │   ├── phrases_dict_tidy.py
│   │   ├── pinyin_dict.py
│   ├── phonetic_symbol.py
│   ├── phonetic_symbol.pyi
│   ├── phrases_dict.json
│   ├── phrases_dict.py
│   ├── phrases_dict.pyi
│   ├── pinyin_dict.json
│   ├── pinyin_dict.py
│   ├── pinyin_dict.pyi
│   ├── py.typed
│   ├── runner.py
│   ├── runner.pyi
│   ├── seg
│   │   ├── __init__.py
│   │   ├── mmseg.py
│   │   ├── mmseg.pyi
│   │   ├── simpleseg.py
│   │   ├── simpleseg.pyi
│   ├── standard.py
│   ├── standard.pyi
│   ├── style
│   │   ├── __init__.py
│   │   ├── __init__.pyi
│   │   ├── _constants.py
│   │   ├── _constants.pyi
│   │   ├── _tone_convert.py
│   │   ├── _tone_convert.pyi
│   │   ├── _tone_rule.py
│   │   ├── _tone_rule.pyi
│   │   ├── _utils.py
│   │   ├── _utils.pyi
│   │   ├── bopomofo.py
│   │   ├── bopomofo.pyi
│   │   ├── braille_mainland.py
│   │   ├── braille_mainland.pyi
│   │   ├── cyrillic.py
│   │   ├── cyrillic.pyi
│   │   ├── finals.py
│   │   ├── finals.pyi
│   │   ├── gwoyeu.py
│   │   ├── gwoyeu.pyi
│   │   ├── initials.py
│   │   ├── initials.pyi
│   │   ├── others.py
│   │   ├── others.pyi
│   │   ├── tone.py
│   │   ├── tone.pyi
│   │   ├── wadegiles.py
│   │   ├── wadegiles.pyi
│   ├── tools
│   │   ├── __init__.py
│   │   ├── toneconvert.py
│   │   ├── toneconvert.pyi
│   ├── utils.py
│   ├── utils.pyi
├── pytest.ini
├── setup.cfg
├── setup.py
├── tidy_phrases_dict.py
└── tox.ini

```

## API Usage Guide

### Detailed Explanation of Core Functions
#### 1. `remove_dup_items()` Function - Removing Duplicate Items from List

**Import Statement**:
```python
from gen_phrases_dict import remove_dup_items
```

**Functionality**:
Removes duplicate items from a list while preserving the order of elements.

**Function Signature**:
```python
def remove_dup_items(lst)
```

**Parameter Description**:
- `lst`: A list that may contain duplicate items.

**Return Value**:
A new list with duplicate items removed, preserving the original order.

---

#### 2. `get_meta()` Function - Getting Package Metadata

**Import Statement**:
```python
from setup import get_meta
```

**Functionality**:
Extracts metadata from the package's __init__.py file using regular expressions.

**Function Signature**:
```python
def get_meta()
```

**Parameter Description**:
None

**Return Value**:
A dictionary containing package metadata such as version, author, and license.

---

#### 3. `long_description()` Function - Reading Long Description

**Import Statement**:
```python
from setup import long_description
```

**Functionality**:
Reads and returns the content of the README.rst file as the package's long description.

**Function Signature**:
```python
def long_description()
```

**Parameter Description**:
None

**Return Value**:
The content of the README.rst file as a string.

---

#### 4. `get_pinyins_via_pinyin_dict()` Function - Getting Pinyins via Pinyin Dictionary

**Import Statement**:
```python
from tidy_phrases_dict import get_pinyins_via_pinyin_dict
```

**Functionality**:
Retrieves pinyin pronunciations for a given phrase by looking up each character in the pinyin dictionary.

**Function Signature**:
```python
def get_pinyins_via_pinyin_dict(phrases)
```

**Parameter Description**:
- `phrases`: A string representing a Chinese phrase or word.

**Return Value**:
A list of pinyin pronunciations for each character in the phrase.

---

#### 5. `double_check()` Function - Double Checking Phrases Dictionary

**Import Statement**:
```python
from tidy_phrases_dict import double_check
```

**Functionality**:
Validates phrases dictionary entries by comparing them with pypinyin's output to identify inconsistencies.

**Function Signature**:
```python
def double_check()
```

**Parameter Description**:
None

**Return Value**:
A dictionary of phrases with inconsistent pinyin definitions.

---

#### 6. `_load_pinyin_dict()` Function - Loading Pinyin Dictionary

**Import Statement**:
```python
from pypinyin.pinyin_dict import _load_pinyin_dict
```

**Functionality**:
Loads the pinyin dictionary from a JSON file and converts string keys to integers.

**Function Signature**:
```python
def _load_pinyin_dict()
```

**Parameter Description**:
None

**Return Value**:
None (modifies the global pinyin_dict variable)

---

#### 7. `convert_zero_consonant()` Function - Converting Zero Consonants

**Import Statement**:
```python
from pypinyin.standard import convert_zero_consonant
```

**Functionality**:
Converts zero consonant pinyin (those starting with 'y' or 'w') back to their original vowel forms according to Pinyin rules.

**Function Signature**:
```python
def convert_zero_consonant(pinyin)
```

**Parameter Description**:
- `pinyin`: A pinyin string that may start with 'y' or 'w'.

**Return Value**:
The pinyin string with zero consonant converted to its original vowel form.

---

#### 8. `convert_uv()` Function - Converting U-V in Pinyin

**Import Statement**:
```python
from pypinyin.standard import convert_uv
```

**Functionality**:
Converts 'u' back to 'ü' in pinyin according to Pinyin rules, particularly when followed by certain initials.

**Function Signature**:
```python
def convert_uv(pinyin)
```

**Parameter Description**:
- `pinyin`: A pinyin string that may contain 'u' which should be 'ü'.

**Return Value**:
The pinyin string with 'u' converted to 'ü' where appropriate.

---

#### 9. `convert_iou()` Function - Converting IOU Final

**Import Statement**:
```python
from pypinyin.standard import convert_iou
```

**Functionality**:
Converts 'iou' final back to its original form according to Pinyin rules when preceded by an initial.

**Function Signature**:
```python
def convert_iou(pinyin)
```

**Parameter Description**:
- `pinyin`: A pinyin string that may contain 'iou' final.

**Return Value**:
The pinyin string with 'iou' converted to its original form.

---

#### 10. `convert_uei()` Function - Converting UEI Final

**Import Statement**:
```python
from pypinyin.standard import convert_uei
```

**Functionality**:
Converts 'uei' final back to its original form according to Pinyin rules when preceded by an initial.

**Function Signature**:
```python
def convert_uei(pinyin)
```

**Parameter Description**:
- `pinyin`: A pinyin string that may contain 'uei' final.

**Return Value**:
The pinyin string with 'uei' converted to its original form.

---

#### 11. `convert_uen()` Function - Converting UEN Final

**Import Statement**:
```python
from pypinyin.standard import convert_uen
```

**Functionality**:
Converts 'uen' final back to its original form according to Pinyin rules when preceded by an initial.

**Function Signature**:
```python
def convert_uen(pinyin)
```

**Parameter Description**:
- `pinyin`: A pinyin string that may contain 'uen' final.

**Return Value**:
The pinyin string with 'uen' converted to its original form.

---

#### 12. `convert_finals()` Function - Converting Finals

**Import Statement**:
```python
from pypinyin.standard import convert_finals
```

**Functionality**:
Applies all final conversion functions to restore original pinyin forms.

**Function Signature**:
```python
def convert_finals(pinyin)
```

**Parameter Description**:
- `pinyin`: A pinyin string that may need final conversions.

**Return Value**:
The pinyin string with all final conversions applied.

---

#### 13. `to_fixed()` Function - Converting Pinyin Style

**Import Statement**:
```python
from pypinyin.core import to_fixed
```

**Functionality**:
Converts a pinyin string to a specified style using the default converter.

**Function Signature**:
```python
def to_fixed(pinyin, style, strict=True)
```

**Parameter Description**:
- `pinyin`: The pinyin string to convert.
- `style`: The target pinyin style.
- `strict`: Whether to strictly follow the Pinyin standard.

**Return Value**:
The pinyin string converted to the specified style.

---

#### 14. `handle_nopinyin()` Function - Handling Non-Pinyin Characters

**Import Statement**:
```python
from pypinyin.core import handle_nopinyin
```

**Functionality**:
Handles characters that don't have pinyin by applying the specified error handling strategy.

**Function Signature**:
```python
def handle_nopinyin(chars, errors='default', heteronym=True)
```

**Parameter Description**:
- `chars`: Characters that don't have pinyin.
- `errors`: Error handling strategy ('default', 'ignore', 'replace', etc.).
- `heteronym`: Whether to enable heteronym mode.

**Return Value**:
A list of lists representing the processed non-pinyin characters.

---

#### 15. `single_pinyin()` Function - Getting Pinyin for Single Character

**Import Statement**:
```python
from pypinyin.core import single_pinyin
```

**Functionality**:
Gets pinyin for a single Chinese character using the default converter.

**Function Signature**:
```python
def single_pinyin(han, style, heteronym, errors='default', strict=True)
```

**Parameter Description**:
- `han`: A single Chinese character.
- `style`: The pinyin style to use.
- `heteronym`: Whether to enable heteronym mode.
- `errors`: Error handling strategy.
- `strict`: Whether to strictly follow the Pinyin standard.

**Return Value**:
A list of lists representing the pinyin for the character.

---

#### 16. `phrase_pinyin()` Function - Getting Pinyin for Phrase

**Import Statement**:
```python
from pypinyin.core import phrase_pinyin
```

**Functionality**:
Gets pinyin for a Chinese phrase using the default converter.

**Function Signature**:
```python
def phrase_pinyin(phrase, style, heteronym, errors='default', strict=True)
```

**Parameter Description**:
- `phrase`: A Chinese phrase or word.
- `style`: The pinyin style to use.
- `heteronym`: Whether to enable heteronym mode.
- `errors`: Error handling strategy.
- `strict`: Whether to strictly follow the Pinyin standard.

**Return Value**:
A list of lists representing the pinyin for the phrase.

---

#### 17. `_replace_tone2_style_dict_to_default()` Function - Replacing Tone2 Style

**Import Statement**:
```python
from pypinyin.utils import _replace_tone2_style_dict_to_default
```

**Functionality**:
Converts tone2 style pinyin to default tone style using the tone2_to_tone function.

**Function Signature**:
```python
def _replace_tone2_style_dict_to_default(string)
```

**Parameter Description**:
- `string`: A string with tone2 style pinyin.

**Return Value**:
The string with tone2 style pinyin converted to default tone style.

---

#### 18. `_remove_dup_items()` Function - Removing Duplicate Items with Option

**Import Statement**:
```python
from pypinyin.utils import _remove_dup_items
```

**Functionality**:
Removes duplicate items from a list with an option to also remove empty items.

**Function Signature**:
```python
def _remove_dup_items(lst, remove_empty=False)
```

**Parameter Description**:
- `lst`: A list that may contain duplicate items.
- `remove_empty`: Whether to also remove empty items.

**Return Value**:
A new list with duplicates (and optionally empty items) removed.

---

#### 19. `_remove_dup_and_empty()` Function - Removing Duplicates and Empty Lists

**Import Statement**:
```python
from pypinyin.utils import _remove_dup_and_empty
```

**Functionality**:
Processes a list of lists by removing duplicates and empty items from each sublist.

**Function Signature**:
```python
def _remove_dup_and_empty(lst_list)
```

**Parameter Description**:
- `lst_list`: A list of lists that may contain duplicates or empty items.

**Return Value**:
A new list of lists with duplicates and empty items removed.

---

#### 20. `_load_phrases_dict()` Function - Loading Phrases Dictionary

**Import Statement**:
```python
from pypinyin.phrases_dict import _load_phrases_dict
```

**Functionality**:
Loads the phrases dictionary from a JSON file.

**Function Signature**:
```python
def _load_phrases_dict()
```

**Parameter Description**:
None

**Return Value**:
None (modifies the global phrases_dict variable)

---

#### 21. `re_sub()` Function - Regular Expression Substitution

**Import Statement**:
```python
from pypinyin.tools.toneconvert import re_sub
```

**Functionality**:
Performs regular expression substitution using a specified action function on matched objects.

**Function Signature**:
```python
def re_sub(action, match_obj)
```

**Parameter Description**:
- `action`: The action function to apply to the matched text.
- `match_obj`: The regex match object.

**Return Value**:
The substituted string with the action applied to the matched text.

---

#### 22. `prepare()` Function - Preparing Input Text

**Import Statement**:
```python
from pypinyin.tools.toneconvert import prepare
```

**Functionality**:
Prepares input text by replacing multi-character phonetic symbols with their single-character equivalents.

**Function Signature**:
```python
def prepare(input)
```

**Parameter Description**:
- `input`: The input text to prepare.

**Return Value**:
The prepared input text with phonetic symbols replaced.

---

#### 23. `to_tone3()` Function - Converting to Tone3 Style

**Import Statement**:
```python
from pypinyin.style._tone_convert import to_tone3
```

**Functionality**:
Converts pinyin to tone3 style where tone numbers are placed at the end of the syllable.

**Function Signature**:
```python
def to_tone3(pinyin, v_to_u=False, neutral_tone_with_five=False)
```

**Parameter Description**:
- `pinyin`: The pinyin string to convert.
- `v_to_u`: Whether to convert 'v' to 'ü'.
- `neutral_tone_with_five`: Whether to mark neutral tone with '5'.

**Return Value**:
The pinyin string converted to tone3 style.

---

#### 24. `to_initials()` Function - Extracting Initials

**Import Statement**:
```python
from pypinyin.style._tone_convert import to_initials
```

**Functionality**:
Extracts the initial consonants from pinyin according to Pinyin rules.

**Function Signature**:
```python
def to_initials(pinyin, strict=True)
```

**Parameter Description**:
- `pinyin`: The pinyin string to extract initials from.
- `strict`: Whether to strictly follow the Pinyin standard.

**Return Value**:
The initial consonant(s) of the pinyin syllable.

---

#### 25. `to_finals()` Function - Extracting Finals

**Import Statement**:
```python
from pypinyin.style._tone_convert import to_finals
```

**Functionality**:
Extracts the final vowels from pinyin according to Pinyin rules.

**Function Signature**:
```python
def to_finals(pinyin, strict=True, v_to_u=False)
```

**Parameter Description**:
- `pinyin`: The pinyin string to extract finals from.
- `strict`: Whether to strictly follow the Pinyin standard.
- `v_to_u`: Whether to convert 'v' to 'ü'.

**Return Value**:
The final vowels of the pinyin syllable.

---

#### 26. `to_finals_tone()` Function - Finals with Tone Extraction

**Import Statement**:
```python
from pypinyin.contrib.tone_convert import to_finals_tone
```

**Functionality**:
Extracts the finals (vowel sounds) from a pinyin syllable with tone marks.

**Function Signature**:
```python
def to_finals_tone(pinyin, strict=True)
```

**Parameter Description**:
- `pinyin`: Pinyin string in TONE, TONE2, or TONE3 style.
- `strict`: Whether to strictly follow the Pinyin standard for initial and final processing.

**Return Value**:
A string representing the finals with tone marks.

---

#### 27. `to_finals_tone2()` Function - Finals with Tone Number Extraction

**Import Statement**:
```python
from pypinyin.contrib.tone_convert import to_finals_tone2
```

**Functionality**:
Extracts the finals (vowel sounds) from a pinyin syllable with tone numbers.

**Function Signature**:
```python
def to_finals_tone2(pinyin, strict=True, v_to_u=False, neutral_tone_with_five=False)
```

**Parameter Description**:
- `pinyin`: Pinyin string in TONE, TONE2, or TONE3 style.
- `strict`: Whether to strictly follow the Pinyin standard for initial and final processing.
- `v_to_u`: Whether to use 'ü' instead of 'v' to represent ü.
- `neutral_tone_with_five`: Whether to use '5' to mark neutral tone.

**Return Value**:
A string representing the finals with tone numbers.

---

#### 28. `to_finals_tone3()` Function - Finals with Tone at End Extraction

**Import Statement**:
```python
from pypinyin.contrib.tone_convert import to_finals_tone3
```

**Functionality**:
Extracts the finals (vowel sounds) from a pinyin syllable with tone number at the end.

**Function Signature**:
```python
def to_finals_tone3(pinyin, strict=True, v_to_u=False, neutral_tone_with_five=False)
```

**Parameter Description**:
- `pinyin`: Pinyin string in TONE, TONE2, or TONE3 style.
- `strict`: Whether to strictly follow the Pinyin standard for initial and final processing.
- `v_to_u`: Whether to use 'ü' instead of 'v' to represent ü.
- `neutral_tone_with_five`: Whether to use '5' to mark neutral tone.

**Return Value**:
A string representing the finals with tone number at the end.

---

#### 29. `tone_to_tone3()` Function - Tone to Tone3 Conversion

**Import Statement**:
```python
from pypinyin.contrib.tone_convert import tone_to_tone3
```

**Functionality**:
Converts pinyin from TONE style to TONE3 style (tone number at the end).

**Function Signature**:
```python
def tone_to_tone3(tone, v_to_u=False, neutral_tone_with_five=False, **kwargs)
```

**Parameter Description**:
- `tone`: Pinyin string in TONE style.
- `v_to_u`: Whether to use 'ü' instead of 'v' to represent ü.
- `neutral_tone_with_five`: Whether to use '5' to mark neutral tone.
- `kwargs`: Used for compatibility with the older `neutral_tone_with_5` parameter.

**Return Value**:
A string representing the pinyin in TONE3 style.

---

#### 30. `tone2_to_normal()` Function - Tone2 to Normal Conversion

**Import Statement**:
```python
from pypinyin.contrib.tone_convert import tone2_to_normal
```

**Functionality**:
Converts pinyin from TONE2 style (tone numbers) to NORMAL style (no tones).

**Function Signature**:
```python
def tone2_to_normal(tone2, v_to_u=False)
```

**Parameter Description**:
- `tone2`: Pinyin string in TONE2 style.
- `v_to_u`: Whether to use 'ü' instead of 'v' to represent ü.

**Return Value**:
A string representing the pinyin in NORMAL style.

---

#### 31. `tone2_to_tone()` Function - Tone2 to Tone Conversion

**Import Statement**:
```python
from pypinyin.contrib.tone_convert import tone2_to_tone
```

**Functionality**:
Converts pinyin from TONE2 style (tone numbers) to TONE style (tone marks).

**Function Signature**:
```python
def tone2_to_tone(tone2)
```

**Parameter Description**:
- `tone2`: Pinyin string in TONE2 style.

**Return Value**:
A string representing the pinyin in TONE style.

---

#### 32. `_replace()` Function - Tone Replacement Helper

**Import Statement**:
```python
from pypinyin.style._tone_convert import _replace
```

**Functionality**:
Helper function used in tone2_to_tone to replace tone numbers with tone marks.

**Function Signature**:
```python
def _replace(m)
```

**Parameter Description**:
- `m`: Match object from regex substitution.

**Return Value**:
A string with tone marks replacing tone numbers.

---

#### 33. `tone2_to_tone3()` Function - Tone2 to Tone3 Conversion

**Import Statement**:
```python
from pypinyin.contrib.tone_convert import tone2_to_tone3
```

**Functionality**:
Converts pinyin from TONE2 style (tone numbers) to TONE3 style (tone number at the end).

**Function Signature**:
```python
def tone2_to_tone3(tone2, v_to_u=False)
```

**Parameter Description**:
- `tone2`: Pinyin string in TONE2 style.
- `v_to_u`: Whether to use 'ü' instead of 'v' to represent ü.

**Return Value**:
A string representing the pinyin in TONE3 style.

---

#### 34. `tone3_to_normal()` Function - Tone3 to Normal Conversion

**Import Statement**:
```python
from pypinyin.contrib.tone_convert import tone3_to_normal
```

**Functionality**:
Converts pinyin from TONE3 style (tone number at the end) to NORMAL style (no tones).

**Function Signature**:
```python
def tone3_to_normal(tone3, v_to_u=False)
```

**Parameter Description**:
- `tone3`: Pinyin string in TONE3 style.
- `v_to_u`: Whether to use 'ü' instead of 'v' to represent ü.

**Return Value**:
A string representing the pinyin in NORMAL style.

---

#### 35. `tone3_to_tone()` Function - Tone3 to Tone Conversion

**Import Statement**:
```python
from pypinyin.contrib.tone_convert import tone3_to_tone
```

**Functionality**:
Converts pinyin from TONE3 style (tone number at the end) to TONE style (tone marks).

**Function Signature**:
```python
def tone3_to_tone(tone3)
```

**Parameter Description**:
- `tone3`: Pinyin string in TONE3 style.

**Return Value**:
A string representing the pinyin in TONE style.

---

#### 36. `tone3_to_tone2()` Function - Tone3 to Tone2 Conversion

**Import Statement**:
```python
from pypinyin.contrib.tone_convert import tone3_to_tone2
```

**Functionality**:
Converts pinyin from TONE3 style (tone number at the end) to TONE2 style (tone numbers).

**Function Signature**:
```python
def tone3_to_tone2(tone3, v_to_u=False)
```

**Parameter Description**:
- `tone3`: Pinyin string in TONE3 style.
- `v_to_u`: Whether to use 'ü' instead of 'v' to represent ü.

**Return Value**:
A string representing the pinyin in TONE2 style.

---

#### 37. `_improve_tone3()` Function - Tone3 Enhancement

**Import Statement**:
```python
from pypinyin.style._tone_convert import _improve_tone3
```

**Functionality**:
Enhances TONE3 style pinyin by adding '5' to mark neutral tones when needed.

**Function Signature**:
```python
def _improve_tone3(tone3, neutral_tone_with_five=False)
```

**Parameter Description**:
- `tone3`: Pinyin string in TONE3 style.
- `neutral_tone_with_five`: Whether to use '5' to mark neutral tone.

**Return Value**:
A string representing the enhanced pinyin in TONE3 style.

---

#### 38. `_get_number_from_pinyin()` Function - Tone Number Extraction

**Import Statement**:
```python
from pypinyin.style._tone_convert import _get_number_from_pinyin
```

**Functionality**:
Extracts the tone number from a pinyin string.

**Function Signature**:
```python
def _get_number_from_pinyin(pinyin)
```

**Parameter Description**:
- `pinyin`: Pinyin string that may contain tone numbers.

**Return Value**:
An integer representing the tone number, or None if no tone number is found.

---

#### 39. `_v_to_u()` Function - V to Ü Conversion

**Import Statement**:
```python
from pypinyin.style._tone_convert import _v_to_u
```

**Functionality**:
Converts 'v' to 'ü' in pinyin strings when needed.

**Function Signature**:
```python
def _v_to_u(pinyin, replace=False)
```

**Parameter Description**:
- `pinyin`: Pinyin string that may contain 'v'.
- `replace`: Whether to perform the replacement.

**Return Value**:
A string with 'v' replaced by 'ü' if replace is True, otherwise the original string.

---

#### 40. `_fix_v_u()` Function - V/Ü Consistency Fix

**Import Statement**:
```python
from pypinyin.style._tone_convert import _fix_v_u
```

**Functionality**:
Ensures consistency in the use of 'v' vs 'ü' in pinyin strings.

**Function Signature**:
```python
def _fix_v_u(origin_py, new_py, v_to_u)
```

**Parameter Description**:
- `origin_py`: Original pinyin string.
- `new_py`: New pinyin string.
- `v_to_u`: Whether to use 'ü' instead of 'v'.

**Return Value**:
A string with consistent use of 'v' or 'ü' based on the v_to_u parameter.

---

#### 41. `to_wade_glides()` Function - Pinyin to Wade-Giles Conversion

**Import Statement**:
```python
from pypinyin.style.wadegiles import to_wade_glides
```

**Functionality**:
Converts pinyin to Wade-Giles romanization system.

**Function Signature**:
```python
def to_wade_glides(pinyin, **kwargs)
```

**Parameter Description**:
- `pinyin`: Pinyin string to convert.
- `kwargs`: Additional keyword arguments.

**Return Value**:
A string representing the Wade-Giles romanization.

---

#### 42. `_fixed_result()` Function - Wade-Giles Result Fix

**Import Statement**:
```python
from pypinyin.style.wadegiles import _fixed_result
```

**Functionality**:
Fixes the result of Wade-Giles conversion by standardizing character usage.

**Function Signature**:
```python
def _fixed_result(pinyin)
```

**Parameter Description**:
- `pinyin`: Pinyin string in Wade-Giles system.

**Return Value**:
A string with standardized character usage.

---

#### 43. `_convert_whole()` Function - Whole String Conversion

**Import Statement**:
```python
from pypinyin.style.wadegiles import _convert_whole
```

**Functionality**:
Converts entire strings based on a conversion table.

**Function Signature**:
```python
def _convert_whole(chars, table)
```

**Parameter Description**:
- `chars`: Characters to convert.
- `table`: Conversion table to use.

**Return Value**:
A string with conversions applied.

---

#### 44. `register()` Function - Style Registration Wrapper

**Import Statement**:
```python
from pypinyin.style import register
```

**Functionality**:
Wrapper function used in style registration to preserve function metadata.

**Function Signature**:
```python
def register(style, func=None):
    def decorator(func):
        def wrapper(pinyin, **kwargs)
```

**Parameter Description**:
- `style`: Style name to register.
- `func`: Function to register as a custom style.
- `pinyin`: Pinyin string to process.
- `kwargs`: Additional keyword arguments.

**Return Value**:
The result of applying the registered style function.

---

#### 45. `auto_discover()` Function - Automatic Style Discovery

**Import Statement**:
```python
from pypinyin.style import auto_discover
```

**Functionality**:
Automatically registers built-in pinyin style implementations.

**Function Signature**:
```python
def auto_discover()
```

**Parameter Description**:
None

**Return Value**:
None

---

#### 46. `right_mark_index()` Function - Tone Mark Position

**Import Statement**:
```python
from pypinyin.contrib._tone_rule import right_mark_index
```

**Functionality**:
Determines the correct position to place tone marks in a pinyin syllable.

**Function Signature**:
```python
def right_mark_index(pinyin_no_tone)
```

**Parameter Description**:
- `pinyin_no_tone`: Pinyin syllable without tone marks.

**Return Value**:
An integer representing the index where the tone mark should be placed.

---

#### 47. `get_initials()` Function - Initials Extraction

**Import Statement**:
```python
from pypinyin.style._utils import get_initials
```

**Functionality**:
Extracts the initial consonants from a pinyin syllable.

**Function Signature**:
```python
def get_initials(pinyin, strict)
```

**Parameter Description**:
- `pinyin`: Pinyin syllable.
- `strict`: Whether to strictly follow the Pinyin standard.

**Return Value**:
A string representing the initial consonants.

---

#### 48. `get_finals()` Function - Finals Extraction

**Import Statement**:
```python
from pypinyin.style._utils import get_finals
```

**Functionality**:
Extracts the final vowels from a pinyin syllable.

**Function Signature**:
```python
def get_finals(pinyin, strict)
```

**Parameter Description**:
- `pinyin`: Pinyin syllable without tone.
- `strict`: Whether to strictly follow the Pinyin standard.

**Return Value**:
A string representing the final vowels.

---

#### 49. `replace_symbol_to_number()` Function - Tone Symbol to Number

**Import Statement**:
```python
from pypinyin.style._utils import replace_symbol_to_number
```

**Functionality**:
Replaces tone symbols with numbers.

**Function Signature**:
```python
def replace_symbol_to_number(pinyin)
```

**Parameter Description**:
- `pinyin`: Pinyin string with tone symbols.

**Return Value**:
A string with tone symbols replaced by numbers.

---

#### 50. `_replace()` Function - Symbol Replacement Helper

**Import Statement**:
```python
from pypinyin.style._utils import replace_symbol_to_number
```

**Functionality**:
Helper function used in replace_symbol_to_number to replace matched symbols.

**Function Signature**:
```python
def _replace(match)
```

**Parameter Description**:
- `match`: Match object from regex substitution.

**Return Value**:
A string with the matched symbol replaced.

---

#### 51. `replace_symbol_to_no_symbol()` Function - Tone Symbol Removal

**Import Statement**:
```python
from pypinyin.style._utils import replace_symbol_to_no_symbol
```

**Functionality**:
Removes tone symbols from pinyin strings.

**Function Signature**:
```python
def replace_symbol_to_no_symbol(pinyin)
```

**Parameter Description**:
- `pinyin`: Pinyin string with tone symbols.

**Return Value**:
A string with tone symbols removed.

---

#### 52. `has_finals()` Function - Finals Check

**Import Statement**:
```python
from pypinyin.style._utils import has_finals
```

**Functionality**:
Checks if a pinyin syllable has finals (vowel sounds).

**Function Signature**:
```python
def has_finals(pinyin)
```

**Parameter Description**:
- `pinyin`: Pinyin string to check.

**Return Value**:
A boolean indicating whether the pinyin has finals.

---

#### 53. `retrain()` Function - Segmenter Retraining

**Import Statement**:
```python
from pypinyin.contrib.mmseg import retrain
```

**Functionality**:
Retrains a segmenter instance using the built-in phrase dictionary.

**Function Signature**:
```python
def retrain(seg_instance)
```

**Parameter Description**:
- `seg_instance`: Segmenter instance to retrain.

**Return Value**:
None

---

#### 54. `simple_seg()` Function - Simple Segmentation

**Import Statement**:
```python
from pypinyin.seg.simpleseg import simple_seg
```

**Functionality**:
Segments a string by separating Chinese characters from non-Chinese characters.

**Function Signature**:
```python
def simple_seg(hans)
```

**Parameter Description**:
- `hans`: String to segment.

**Return Value**:
A list of segmented strings.

---

#### 55. `_seg()` Function - Character-based Segmentation

**Import Statement**:
```python
from pypinyin.seg.simpleseg import _seg
```

**Functionality**:
Segments characters based on whether they are Chinese characters.

**Function Signature**:
```python
def _seg(chars)
```

**Parameter Description**:
- `chars`: Characters to segment.

**Return Value**:
A list of segmented strings.

---

#### 56. `_handle_nopinyin_char()` Function - Handling Non-Pinyin Characters

**Import Statement**:
```python
from pypinyin.core import _handle_nopinyin_char
```

**Functionality**:
Handles characters that don't have pinyin by applying the specified error handling strategy. This is a helper function used internally to process non-pinyin characters.

**Function Signature**:
```python
def _handle_nopinyin_char(chars: Text, errors: TErrors = ...) -> Optional[Text]
```

**Parameter Description**:
- `chars`: Characters that don't have pinyin.
- `errors`: Error handling strategy which can be a string ('default', 'ignore', 'exception', 'replace') or a callable object.

**Return Value**:
A string representing the processed non-pinyin characters, or None if the characters should be ignored.

---

#### 57. `callable_check()` Function - Checking Callability

**Import Statement**:
```python
from pypinyin.compat import callable_check
```

**Functionality**:
Checks if an object is callable. This function provides compatibility between Python 2 and Python 3 for checking if an object can be called.

**Function Signature**:
```python
def callable_check(obj: Any) -> bool
```

**Parameter Description**:
- `obj`: Any Python object to check for callability.

**Return Value**:
A boolean indicating whether the object is callable (True) or not (False).

---

#### 58. `get_hook_dirs()` Function - PyInstaller Hook Directories

**Import Statement**:
```python
from pypinyin.__pyinstaller import get_hook_dirs
```

**Functionality**:
Returns the directory paths where PyInstaller hook files are located. This function is used by PyInstaller to find the necessary hook files for packaging pypinyin applications.

**Function Signature**:
```python
def get_hook_dirs() -> List[Text]
```

**Parameter Description**:
None

**Return Value**:
A list of directory paths as strings where PyInstaller hook files can be found.

### Detailed Explanation of Core Classes
#### 1. `NullWriter` - Data Stream Blackhole for Command Runner

**Import Statement**:
```python
from pypinyin.runner import NullWriter
```

**Functionality**:
Data stream blackhole that mimics the effect of /dev/null on Linux/Unix systems. Used to discard output during command-line execution to prevent contamination of command output.

**Class Signature**:
```python
class NullWriter(object):
    def write(self, string)
    """Data stream blackhole that discards all input strings. Similar to /dev/null on Linux/Unix systems."""
```
**Parameter Description**:
- `string`: Input string to be discarded.


#### 2. `_v2UConverter` - V to U Pinyin Converter

**Import Statement**:
```python
from pypinyin.converter import _v2UConverter
```

**Functionality**:
Converter that handles the conversion of v to ü in pinyin, using the V2UMixin with DefaultConverter.

**Class Signature**:
```python
class _v2UConverter(V2UMixin, DefaultConverter):
    pass
```
**Parameter Description**:
None


#### 3. `_neutralToneWith5Converter` - Neutral Tone with 5 Representation Converter

**Import Statement**:
```python
from pypinyin.converter import _neutralToneWith5Converter
```

**Functionality**:
Converter that handles neutral tone representation with the number 5, using the NeutralToneWith5Mixin with DefaultConverter.

**Class Signature**:
```python
class _neutralToneWith5Converter(NeutralToneWith5Mixin, DefaultConverter):
    pass
```
**Parameter Description**:
None


#### 4. `_toneSandhiConverter` - Tone Sandhi Rules Converter

**Import Statement**:
```python
from pypinyin.converter import _toneSandhiConverter
```

**Functionality**:
Converter that handles tone sandhi rules (specifically third-tone sandhi), using the ToneSandhiMixin with DefaultConverter.

**Class Signature**:
```python
class _toneSandhiConverter(ToneSandhiMixin, DefaultConverter):
    pass
```
**Parameter Description**:
None


#### 5. `UltimateConverter` - Ultimate Pinyin Converter with All Features

**Import Statement**:
```python
from pypinyin.converter import UltimateConverter
```

**Functionality**:
Ultimate converter that combines all conversion features including v-to-u conversion, neutral tone with five representation, and tone sandhi rules.

**Class Signature**:
```python
class UltimateConverter(DefaultConverter):
    def __init__(self, v_to_u=False, neutral_tone_with_five=False, tone_sandhi=False, **kwargs)
    """Initialize the UltimateConverter with optional features."""
    
    def post_convert_style(self, han, orig_pinyin, converted_pinyin, style, strict, **kwargs)
    """Post-process pinyin style conversion with support for v_to_u and neutral_tone_with_five features."""
    
    def post_pinyin(self, han, heteronym, pinyin, **kwargs)
    """Post-process pinyin with support for tone_sandhi feature."""
```
**Parameter Description**:
- `v_to_u`: Whether to enable v to u conversion (ü representation).
- `neutral_tone_with_five`: Whether to enable neutral tone with five representation.
- `tone_sandhi`: Whether to enable tone sandhi rules.
- `han`: Single Chinese character or phrase.
- `orig_pinyin`: Original pinyin.
- `converted_pinyin`: Converted pinyin.
- `style`: Pinyin style.
- `strict`: Whether to strictly follow the Chinese Pinyin Scheme.
- `heteronym`: Whether to enable heteronym (multiple pronunciations).
- `pinyin`: Pinyin information.


#### 6. `ToneConverter` - Tone Style Pinyin Converter

**Import Statement**:
```python
from pypinyin.style.tone import ToneConverter
```

**Functionality**:
Converter that handles various tone style pinyin conversions, including standard tone, tone2 (numbers after vowels), and tone3 (numbers at the end).

**Class Signature**:
```python
class ToneConverter(object):
    def to_tone(self, pinyin, **kwargs)
    """Convert to standard tone style pinyin."""
    
    def to_tone2(self, pinyin, **kwargs)
    """Convert to tone2 style pinyin (numbers after vowels)."""
    
    def to_tone3(self, pinyin, **kwargs)
    """Convert to tone3 style pinyin (numbers at the end)."""
```
**Parameter Description**:
- `pinyin`: Pinyin string to convert.
- `kwargs`: Additional keyword arguments.


#### 7. `GwoyeuConverter` - Gwoyeu Romanization Pinyin Converter

**Import Statement**:
```python
from pypinyin.style.gwoyeu import GwoyeuConverter
```

**Functionality**:
Converter that handles Gwoyeu Romanization style pinyin conversion, a romanization system for Mandarin Chinese.

**Class Signature**:
```python
class GwoyeuConverter(object):
    def _pre_convert(self, pinyin)
    """Pre-process pinyin before Gwoyeu conversion."""
    
    def to_gwoyeu(self, pinyin, **kwargs)
    """Convert pinyin to Gwoyeu Romanization."""
```
**Parameter Description**:
- `pinyin`: Pinyin string to convert.
- `kwargs`: Additional keyword arguments.


#### 8. `CyrillicfoConverter` - Cyrillic Pinyin Converter

**Import Statement**:
```python
from pypinyin.style.cyrillic import CyrillicfoConverter
```

**Functionality**:
Converter that handles Cyrillic style pinyin conversion, including both standard and first letter forms.

**Class Signature**:
```python
class CyrillicfoConverter(object):
    def to_cyrillic(self, pinyin, **kwargs)
    """Convert pinyin to Cyrillic representation."""
    
    def to_cyrillic_first(self, pinyin, **kwargs)
    """Convert pinyin to the first letter of Cyrillic representation."""
    
    def _pre_convert(self, pinyin)
    """Pre-process pinyin before Cyrillic conversion."""
```
**Parameter Description**:
- `pinyin`: Pinyin string to convert.
- `kwargs`: Additional keyword arguments.


#### 9. `FinalsConverter` - Finals Style Pinyin Converter

**Import Statement**:
```python
from pypinyin.style.finals import FinalsConverter
```

**Functionality**:
Converter that handles finals style pinyin conversions, including various finals styles with or without tones.

**Class Signature**:
```python
class FinalsConverter(object):
    def to_finals(self, pinyin, **kwargs)
    """Convert to finals style pinyin without tone."""
    
    def to_finals_tone(self, pinyin, **kwargs)
    """Convert to finals style pinyin with tone marks."""
    
    def to_finals_tone2(self, pinyin, **kwargs)
    """Convert to finals style pinyin with tone numbers."""
    
    def to_finals_tone3(self, pinyin, **kwargs)
    """Convert to finals style pinyin with tone numbers at the end."""
```
**Parameter Description**:
- `pinyin`: Pinyin string to convert.
- `kwargs`: Additional keyword arguments.


#### 10. `BopomofoConverter` - Bopomofo (Zhuyin) Pinyin Converter

**Import Statement**:
```python
from pypinyin.style.bopomofo import BopomofoConverter
```

**Functionality**:
Converter that handles Bopomofo (Zhuyin) style pinyin conversion, including both standard and first letter forms.

**Class Signature**:
```python
class BopomofoConverter(object):
    def to_bopomofo(self, pinyin, **kwargs)
    """Convert pinyin to Bopomofo (Zhuyin) representation."""
    
    def to_bopomofo_first(self, pinyin, **kwargs)
    """Convert pinyin to the first letter of Bopomofo (Zhuyin) representation."""
    
    def _pre_convert(self, pinyin)
    """Pre-process pinyin before Bopomofo conversion."""
```
**Parameter Description**:
- `pinyin`: Pinyin string to convert.
- `kwargs`: Additional keyword arguments.


#### 11. `BrailleMainlandConverter` - Mainland Chinese Braille Pinyin Converter

**Import Statement**:
```python
from pypinyin.style.braille_mainland import BrailleMainlandConverter
```

**Functionality**:
Converter that handles Mainland Chinese Braille style pinyin conversion, including both tone and non-tone versions.

**Class Signature**:
```python
class BrailleMainlandConverter(object):
    def to_braille_mainland_tone(self, pinyin, **kwargs)
    """Convert pinyin to Mainland Chinese Braille with tone representation."""
    
    def to_braille_mainland(self, pinyin, **kwargs)
    """Convert pinyin to Mainland Chinese Braille without tone representation."""
```
**Parameter Description**:
- `pinyin`: Pinyin string to convert.
- `kwargs`: Additional keyword arguments.


#### 12. `OthersConverter` - Other Style Pinyin Converter

**Import Statement**:
```python
from pypinyin.style.others import OthersConverter
```

**Functionality**:
Converter that handles other style pinyin conversions, including normal style and first letter style.

**Class Signature**:
```python
class OthersConverter(object):
    def to_normal(self, pinyin, **kwargs)
    """Convert to normal style pinyin without tone marks."""
    
    def to_first_letter(self, pinyin, **kwargs)
    """Convert to first letter style pinyin."""
```
**Parameter Description**:
- `pinyin`: Pinyin string to convert.
- `kwargs`: Additional keyword arguments.


#### 13. `PrefixSet` - Prefix Set for Maximum Matching Segmentation

**Import Statement**:
```python
from pypinyin.seg.mmseg import PrefixSet
```

**Functionality**:
A set-like class that stores prefixes of words for maximum matching segmentation. Used in the MMSEG algorithm for Chinese word segmentation.

**Class Signature**:
```python
class PrefixSet(object):
    def __init__(self)
    """Initialize an empty prefix set."""
    
    def train(self, word_s)
    """Update prefix set with a list of words."""
    
    def __contains__(self, key)
    """Check if a key is in the prefix set."""
```
**Parameter Description**:
- `word_s`: Iterable of words to train the prefix set.
- `key`: String to check for membership in the prefix set.

---

#### 14. `Pinyin` - Core Pinyin Conversion Class

**Import Statement**:
```python
from pypinyin.core import Pinyin
```

**Functionality**:
Core class for pinyin conversion that provides complete pinyin conversion functionality, including pinyin, lazy_pinyin and slug methods. This is the main entry point for users of the pypinyin library.

**Class Signature**:
```python
class Pinyin(object):
    def __init__(self, converter=None, **kwargs)
    """Initialize the Pinyin converter with an optional custom converter."""
    
    def pinyin(self, hans, style=Style.TONE, heteronym=False, errors='default', strict=True, **kwargs)
    """Convert Chinese characters to pinyin, returning a list of pinyin for the characters."""
    
    def lazy_pinyin(self, hans, style=Style.NORMAL,errors='default', strict=True, **kwargs):
    """Convert Chinese characters to pinyin, returning a flat list of pinyin."""
    
    def pre_seg(self, hans, **kwargs)
    """Pre-segmentation hook that can be overridden to skip built-in segmentation."""
    
    def post_seg(self, hans, seg_data, **kwargs)
    """Post-segmentation hook that can be overridden to modify segmentation results."""
    
    def seg(self, hans, **kwargs)
    """Segment Chinese text into words for pinyin conversion."""
    
    def get_seg(self, **kwargs)
    """Get the segmentation function to use."""
```
**Parameter Description**:
- `converter`: Custom converter instance to use for pinyin conversion.
- `hans`: Chinese characters string or list to convert.
- `style`: Specify the pinyin style (default is Style.TONE).
- `heteronym`: Whether to enable heteronym (multiple pronunciations) mode.
- `errors`: Specify how to handle characters without pinyin.
- `strict`: Whether to strictly follow the Chinese Pinyin Scheme for initial and final processing.
- `seg_data`: Segmentation data to process in post_seg method.
- `kwargs`: Additional keyword arguments.


#### 15. `Converter` - Converter Base Class

**Import Statement**:
```python
from pypinyin.converter import Converter
```

**Functionality**:
Base class for all converter classes that defines the conversion interface.

**Class Signature**:
```python
class Converter(object):
    def convert(self, words, style, heteronym, errors, strict=True, **kwargs)
    """Convert words to pinyin according to the specified parameters."""
```
**Parameter Description**:
- `words`: Words to convert to pinyin.
- `style`: Pinyin style to use for conversion.
- `heteronym`: Whether to enable heteronym mode.
- `errors`: Error handling strategy.
- `strict`: Whether to strictly follow the Chinese Pinyin Scheme.
- `kwargs`: Additional keyword arguments.


#### 16. `DefaultConverter` - Default Converter Class

**Import Statement**:
```python
from pypinyin.converter import DefaultConverter
```

**Functionality**:
Default pinyin conversion implementation that serves as the basis for other converters.

**Class Signature**:
```python
class DefaultConverter(Converter):
    def __init__(self, **kwargs)
    """Initialize the default converter with optional parameters."""
    
   def convert(self, words, style, heteronym, errors, strict, **kwargs):
    """Convert words to pinyin using the default conversion logic."""
    
    def pre_convert_style(self, han, orig_pinyin, style, strict, **kwargs)
    """Pre-process pinyin style conversion that can be overridden by subclasses."""
    
    def convert_style(self, han, orig_pinyin, style, strict, **kwargs)
    """Convert pinyin style that can be overridden by subclasses."""

    def post_convert_style(self, han, orig_pinyin, converted_pinyin,style, strict, **kwargs):
    """Post-process pinyin style conversion that can be overridden by subclasses."""
    
    def pre_handle_nopinyin(self, chars, style, heteronym, errors, strict, **kwargs)
    """Pre-process characters without pinyin that can be overridden by subclasses."""

    def handle_nopinyin(self, chars, style, heteronym, errors, strict, **kwargs):
    """Handle characters without pinyin that can be overridden by subclasses."""

    def post_handle_nopinyin(self, chars, style, heteronym, errors, strict, pinyin, **kwargs):
    """Post-process characters without pinyin that can be overridden by subclasses."""

    def post_pinyin(self, han, heteronym, pinyin, **kwargs)
    """Post-process pinyin that can be overridden by subclasses."""

    def _phrase_pinyin(self, phrase, style, heteronym, errors, strict, **kwargs):
    """Convert a phrase to pinyin."""
    
    def convert_styles(self, pinyin_list, phrase, style, heteronym, errors,strict, **kwargs)
    """Convert pinyin styles for a list of pinyin."""
    
    def _single_pinyin(self, han, style, heteronym, errors, strict, **kwargs)
    """Convert a single Chinese character to pinyin."""

    def _convert_style(self, han, pinyin, style, strict, default,**kwargs)
    """Convert pinyin style for a single character."""

    def _convert_nopinyin_chars(self, chars, style, heteronym, errors, strict)
    """Convert characters without pinyin to the specified style."""
        
```
**Parameter Description**:
- `han`: Single Chinese character or phrase.
- `orig_pinyin`: Original pinyin.
- `converted_pinyin`: Converted pinyin.
- `style`: Pinyin style.
- `strict`: Whether to strictly follow the Chinese Pinyin Scheme.
- `heteronym`: Whether to enable heteronym (multiple pronunciations).
- `pinyin`: Pinyin information.
- `words`: Words to convert to pinyin.
- `errors`: Error handling strategy.
- `kwargs`: Additional keyword arguments.


#### 17. `Style` - Pinyin Style Enum Class

**Import Statement**:
```python
from pypinyin.constants import Style
```

**Functionality**:
Enumeration class that defines various pinyin output styles.

**Class Signature**:
```python
class Style(IntEnum):
    NORMAL = 0
    """Normal style, without tones. Example: 中国 -> zhong guo"""
    
    TONE = 1
    """Standard tone style, tone marks on the first letter of the final. Example: 中国 -> zhōng guó"""
    
    TONE2 = 2
    """Tone style 2, tone numbers after vowels. Example: 中国 -> zho1ng guo2"""
    
    TONE3 = 8
    """Tone style 3, tone numbers at the end of syllables. Example: 中国 -> zhong1 guo2"""
    
    INITIALS = 3
    """Initials style, only return the initial part of pinyin. Example: 中国 -> zh g"""
    
    FIRST_LETTER = 4
    """First letter style, only return the first letter of pinyin. Example: 中国 -> z g"""
    
    FINALS = 5
    """Finals style, only return the final part without tone. Example: 中国 -> ong uo"""
    
    FINALS_TONE = 6
    """Standard finals style with tone marks. Example: 中国 -> ōng uó"""
    
    FINALS_TONE2 = 7
    """Finals style 2 with tone numbers. Example: 中国 -> o1ng uo2"""
    
    FINALS_TONE3 = 9
    """Finals style 3 with tone numbers at the end. Example: 中国 -> ong1 uo2"""
    
    BOPOMOFO = 10
    """Bopomofo (Zhuyin) style. Example: 中国 -> ㄓㄨㄥ ㄍㄨㄛˊ"""
    
    BOPOMOFO_FIRST = 11
    """First letter of Bopomofo style. Example: 中国 -> ㄓ ㄍ"""
    
    CYRILLIC = 12
    """Cyrillic style. Example: 中国 -> чжун1 го2"""
    
    CYRILLIC_FIRST = 13
    """First letter of Cyrillic style. Example: 中国 -> ч г"""
    
    WADEGILES = 14
   """Wade-Giles Romanization Style (Wade System / Wei's Romanization), No Tones"""

    GWOYEU = 15
    """Gwoyeu Romatzyh Style Example: "中国" (China) → jong gwo"""
    
    BRAILLE_MAINLAND = 16
    """The braille style used in Mainland China has no tones. For example, "中国" (Zhōngguó, meaning "China") is written as ⠌⠲ ⠛⠕ in braille."""
    

    BRAILLE_MAINLAND_TONE = 17
    """Braille Style in Mainland China, Without Tones Example: "中国" (China) → ⠌⠲ ⠛⠕"""
```
**Parameter Description**:
None


#### 18. `Seg` - Segmentation Base Class

**Import Statement**:
```python
from pypinyin.seg.mmseg import Seg
```

**Functionality**:
Implementation of the forward maximum matching segmenter.

**Class Signature**:
```python
class Seg(object):
    def __init__(self, prefix_set)
    """Initialize the segmenter with a prefix set."""
    
    def cut(self, text)
    """Segment text using the forward maximum matching algorithm."""
    
    def train(self, words)
    """Train the segmenter with a list of words."""
```
**Parameter Description**:
- `prefix_set`: PrefixSet instance for word prefix matching.
- `text`: Text to segment.
- `words`: Iterable of words to train the segmenter.


#### 19. `V2UMixin` - V to Ü Conversion Mixin Class

**Import Statement**:
```python
from pypinyin.contrib.uv import V2UMixin
```

**Functionality**:
Mixin class that handles the conversion of v to ü in pinyin for toneless styles.

**Class Signature**:
```python
class V2UMixin(object):
    def post_convert_style(self, han, orig_pinyin, converted_pinyin, style, strict, **kwargs)
    """Post-process pinyin style conversion to replace 'v' with 'ü'."""
```
**Parameter Description**:
- `han`: Single Chinese character or phrase.
- `orig_pinyin`: Original pinyin.
- `converted_pinyin`: Converted pinyin.
- `style`: Pinyin style.
- `strict`: Whether to strictly follow the Chinese Pinyin Scheme.
- `kwargs`: Additional keyword arguments.


#### 20. `NeutralToneWith5Mixin` - Neutral Tone with 5 Representation Mixin Class

**Import Statement**:
```python
from pypinyin.contrib.neutral_tone import NeutralToneWith5Mixin
```

**Functionality**:
Mixin class that uses 5 to represent neutral tone in number-based pinyin styles.

**Class Signature**:
```python
class NeutralToneWith5Mixin(object):
    NUMBER_TONE = (Style.TONE2, Style.TONE3, Style.FINALS_TONE2, Style.FINALS_TONE3)
    NUMBER_AT_END = (Style.TONE3, Style.FINALS_TONE3)
    
    def post_convert_style(self, han, orig_pinyin, converted_pinyin, style, strict, **kwargs)
    """Post-process pinyin style conversion to mark neutral tone with '5'."""
```
**Parameter Description**:
- `han`: Single Chinese character or phrase.
- `orig_pinyin`: Original pinyin.
- `converted_pinyin`: Converted pinyin.
- `style`: Pinyin style.
- `strict`: Whether to strictly follow the Chinese Pinyin Scheme.
- `kwargs`: Additional keyword arguments.
- `NUMBER_TONE`: Tuple of styles that use numbers for tones.
- `NUMBER_AT_END`: Tuple of styles that put tone numbers at the end.


#### 21. `ToneSandhiMixin` - Tone Sandhi Rules Mixin Class

**Import Statement**:
```python
from pypinyin.contrib.tone_sandhi import ToneSandhiMixin
```

**Functionality**:
Mixin class that handles Mandarin tone sandhi rules, such as third-tone sandhi.

**Class Signature**:
```python
class ToneSandhiMixin(object):
    def post_pinyin(self, han, heteronym, pinyin_list, **kwargs)
    """Post-process pinyin to apply tone sandhi rules."""
```
**Parameter Description**:
- `han`: Chinese characters or phrases.
- `heteronym`: Whether heteronym mode is enabled.
- `pinyin_list`: Pinyin list to process.
- `kwargs`: Additional keyword arguments.

### Detailed Explanation of Constants
```python
# in pypinyin/compat.py
SUPPORT_UCS4 = len('\U00020000') == 1#: Check if the platform supports UCS4
PY2 = sys.version_info < (3, 0)#: Check if running on Python 2

# in pypinyin/standard.py
UV_MAP = {'u': 'ü', 'ū': 'ǖ', 'ú': 'ǘ', 'ǔ': 'ǚ', 'ù': 'ǜ'}#: Map u to ü with different tones
U_TONES = set(UV_MAP.keys())#: Set of u tones
UV_RE = re.compile(r'^(j|q|x)({tones})(.*)$'.format(tones='|'.join(UV_MAP.keys())))#: Regex for ü row finals with j, q, x initials
I_TONES = set(['i', 'ī', 'í', 'ǐ', 'ì'])#: Set of i tones
IU_MAP = {'iu': 'iou', 'iū': 'ioū', 'iú': 'ioú', 'iǔ': 'ioǔ', 'iù': 'ioù'}#: Map iu to iou with different tones
IU_TONES = set(IU_MAP.keys())#: Set of iu tones
IU_RE = re.compile(r'^([a-z]+)({tones})$'.format(tones='|'.join(IU_TONES)))#: Regex for iou conversion
UI_MAP = {'ui': 'uei', 'uī': 'ueī', 'uí': 'ueí', 'uǐ': 'ueǐ', 'uì': 'ueì'}#: Map ui to uei with different tones
UI_TONES = set(UI_MAP.keys())#: Set of ui tones
UI_RE = re.compile(r'([a-z]+)({tones})$'.format(tones='|'.join(UI_TONES)))#: Regex for uei conversion
UN_MAP = {'un': 'uen', 'ūn': 'ūen', 'ún': 'úen', 'ǔn': 'ǔen', 'ùn': 'ùen'}#: Map un to uen with different tones
UN_TONES = set(UN_MAP.keys())#: Set of un tones
UN_RE = re.compile(r'([a-z]+)({tones})$'.format(tones='|'.join(UN_TONES)))#: Regex for uen conversion

# in pypinyin/constants.py
PINYIN_DICT = pinyin_dict.pinyin_dict#: Single character pinyin dictionary
RE_TONE2 = re.compile(r'([aeoiuvnm])([1-4])$')#: Regex for matching tone marked characters with numbers
NORMAL = STYLE_NORMAL = Style.NORMAL#: Normal style without tone marks
TONE = STYLE_TONE = Style.TONE#: Standard tone style with tone marks on the first letter of finals
TONE2 = STYLE_TONE2 = Style.TONE2#: Tone style 2 with tone numbers after each final
TONE3 = STYLE_TONE3 = Style.TONE3#: Tone style 3 with tone numbers after each pinyin
INITIALS = STYLE_INITIALS = Style.INITIALS#: Initials style, returns only the initial part of each pinyin
FIRST_LETTER = STYLE_FIRST_LETTER = Style.FIRST_LETTER#: First letter style, returns only the first letter of each pinyin
FINALS = STYLE_FINALS = Style.FINALS#: Finals style, returns only the final part of each pinyin without tone
FINALS_TONE = STYLE_FINALS_TONE = Style.FINALS_TONE#: Standard finals tone style with tone marks on the first letter of finals
FINALS_TONE2 = STYLE_FINALS_TONE2 = Style.FINALS_TONE2#: Finals tone style 2 with tone numbers after each final
FINALS_TONE3 = STYLE_FINALS_TONE3 = Style.FINALS_TONE3#: Finals tone style 3 with tone numbers after each pinyin
BOPOMOFO = STYLE_BOPOMOFO = Style.BOPOMOFO#: Bopomofo style with tone marks
BOPOMOFO_FIRST = STYLE_BOPOMOFO_FIRST = Style.BOPOMOFO_FIRST#: Bopomofo first letter style
CYRILLIC = STYLE_CYRILLIC = Style.CYRILLIC#: Cyrillic style with tone numbers after each pinyin
CYRILLIC_FIRST = STYLE_CYRILLIC_FIRST = Style.CYRILLIC_FIRST#: Cyrillic first letter style
if os.environ.get('PYPINYIN_NO_PHRASES'): # Words pinyin dictionary
    PHRASES_DICT = {}
else:
    from pypinyin import phrases_dict
    PHRASES_DICT = phrases_dict.phrases_dict
PINYIN_DICT = pinyin_dict.pinyin_dict # Single character pinyin library
if not os.environ.get('PYPINYIN_NO_DICT_COPY'): # Utilize environment variable to control not to copy the dictionary (no custom pinyin library case), to reduce memory usage
    PINYIN_DICT = PINYIN_DICT.copy()
    PHRASES_DICT = PHRASES_DICT.copy()

# Utilize environment variable to control not to copy the dictionary (no custom pinyin library case), to reduce memory usage
if not os.environ.get('PYPINYIN_NO_DICT_COPY'):
    PINYIN_DICT = PINYIN_DICT.copy()
    PHRASES_DICT = PHRASES_DICT.copy()
# 有拼音的汉字
if SUPPORT_UCS4:
    RE_HANS = re.compile(
        r'^(?:['
        r'\u3007'                  # 〇
        r'\ue815-\ue864'
        r'\ufa18'
        r'\u3400-\u4dbf'           # CJK Extension A:[3400-4DBF]
        r'\u4e00-\u9fff'           # CJK Basic:[4E00-9FFF]
        r'\uf900-\ufaff'           # CJK Compatibility:[F900-FAFF]
        r'\U00020000-\U0002A6DF'   # CJK Extension B:[20000-2A6DF]
        r'\U0002A703-\U0002B73F'   # CJK Extension C:[2A700-2B73F]
        r'\U0002B740-\U0002B81D'   # CJK Extension D:[2B740-2B81D]
        r'\U0002B825-\U0002BF6E'   # CJK Extension E:
        r'\U0002C029-\U0002CE93'   # CJK Extension F:
        r'\U0002D016'
        r'\U0002D11B-\U0002EBD9'
        r'\U0002F80A-\U0002FA1F'   # CJK Compatibility Extension:[2F800-2FA1F]
        r'\U00030000-\U0003134A'   # CJK Extension G:[30000-3134A]
        r'\U000300F7-\U00031288'
        r'\U00030EDD'
        r'\U00030EDE'
        r'\U00031350-\U00032389'
        r'])+$'
    )
else:
    RE_HANS = re.compile(
        r'^(?:['
        r'\u3007'                  # 〇
        r'\ue815-\ue864'
        r'\ufa18'
        r'\u3400-\u4dbf'           # CJK Extension A:[3400-4DBF]
        r'\u4e00-\u9fff'           # CJK Basic:[4E00-9FFF]
        r'\uf900-\ufaff'           # CJK Compatibility:[F900-FAFF]
        r'])+$'
    )


# in pypinyin/style/_constants.py
_INITIALS = ['b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'zh', 'ch', 'sh', 'r', 'z', 'c', 's']#: Initials list
_INITIALS_NOT_STRICT = _INITIALS + ['y', 'w']#: Initials list including y and w as initials
_FINALS = ['i', 'u', 'ü', 'a', 'ia', 'ua', 'o', 'uo', 'e', 'ie', 'üe', 'ai', 'uai', 'ei', 'uei', 'ao', 'iao', 'ou', 'iou', 'an', 'ian', 'uan', 'üan', 'en', 'in', 'uen', 'ün', 'ang', 'iang', 'uang', 'eng', 'ing', 'ueng', 'ong', 'iong', 'er', 'ê']#: Finals list
PHONETIC_SYMBOL_DICT = phonetic_symbol.phonetic_symbol.copy()#: Mapping of phonetic symbols to tone numbers
PHONETIC_SYMBOL_DICT_KEY_LENGTH_NOT_ONE = dict((k, v) for k, v in PHONETIC_SYMBOL_DICT.items() if len(k) > 1) #: Mapping of phonetic symbols with length greater than one
RE_PHONETIC_SYMBOL = re.compile(r'[{0}]'.format(re.escape(''.join(x for x in PHONETIC_SYMBOL_DICT if len(x) == 1))))#: Regex for matching phonetic symbols
RE_TONE2 = re.compile(r'([aeoiuvnmêü])([1-5])$')#: Regex for matching tone marked characters with numbers
RE_TONE3 = re.compile(r'^([a-zêü]+)([1-5])([a-zêü]*)$')#: Regex for matching tone numbers in TONE2 style
RE_NUMBER = re.compile(r'\d')#: Regex for matching single digits

# in pypinyin/tools/toneconvert.py
ACTIONS = {'to_normal': to_normal, 'to_tone': to_tone, 'to_tone2': to_tone2, 'to_tone3': to_tone3}#: Actions mapping for tone conversion functions

# in pypinyin/style/gwoyeu.py
GWOYEU_REPLACE = ((re.compile(r'^r5$'), 'er5'), (re.compile(r'iu'), 'iou'), (re.compile(r'ao'), 'au'), (re.compile(r'^yi?'), 'i'), (re.compile(r'^wu?'), 'u'), (re.compile(r'^([jqx])u'), '\\1iu'), (re.compile(r'(?<![iy])u([in])'), 'ue\\1'), (re.compile(r'v'), 'iu'), (re.compile(r'^([zcsr]h?)i'), '\\1y'), (re.compile(r'^zh'), 'j'), (re.compile(r'^z'), 'tz'), (re.compile(r'^c(?!h)'), 'ts'), (re.compile(r'^q'), 'ch'), (re.compile(r'^x'), 'sh'), (re.compile(r'er'), 'el'), (re.compile(r'5$'), ''), (re.compile(r'0$'), 'q'), (re.compile(r'^i(.*[34])$'), 'yi\\1'), (re.compile(r'^u(.*[34])$'), 'wu\\1'), (re.compile(r'^yi([aeu].*4)$'), 'y\\1'), (re.compile(r'^wu([ae].*4)$'), 'w\\1'))#: Gwoyeu replacement rules
TONE_REPLACE = ((re.compile(r'^([lmnr])(.+)1$'), '\\1h\\2'), (re.compile(r'1$'), ''), (re.compile(r'^([lmnr])(.+)2$'), '\\1\\2'), (re.compile(r'^([^ae]*)i(ng?)*2$'), '\\1yi\\2'), (re.compile(r'^([^ao]*)u2$'), '\\1wu'), (re.compile(r'^([^ae]*)i(.+)2$'), '\\1y\\2'), (re.compile(r'^([^ao]*)u(.+)2$'), '\\1w\\2'), (re.compile(r'([aeiouy]+)(.*)2$'), '\\1r\\2'), (re.compile(r'^([^aeiou]*)([iu])(ng?)?3$'), '\\1\\2\\2\\3'), (re.compile(r'^([^eu]*)i(.*)3$'), '\\1e\\2'), (re.compile(r'^(.*)u(.*)3$'), '\\1o\\2'), (re.compile(r'([aeiouy])(.*)3$'), '\\1\\1\\2'), (re.compile(r'^([^ae]*)i4$'), '\\1ih'), (re.compile(r'^([^ao]*)u4$'), '\\1uh'), (re.compile(r'i4$'), 'y'), (re.compile(r'u4$'), 'w'), (re.compile(r'l4$'), 'll'), (re.compile(r'ng4$'), 'nq'), (re.compile(r'n4$'), 'nn'), (re.compile(r'4$'), 'h'))#: Tone replacement rules

# in pypinyin/style/cyrillic.py
CYRILLIC_REPLACE = ((re.compile(r'ong'), 'ung'), (re.compile(r'([zcs])i'), '\\1U'), (re.compile(r'([xqj])u'), '\\1v'), (re.compile(r'^wu(.?)$'), 'u\\1'), (re.compile(r'(.+)r(.?)$'), '\\1R\\2'), (re.compile(r'^zh'), 'Cr'), (re.compile(r'^ch'), 'C'), (re.compile(r'^j'), 'qZ'), (re.compile(r'^z'), 'qZ'), (re.compile(r'^x'), 's'), (re.compile(r'^sh'), 'S'), (re.compile(r'([^CSdst])uo'), '\\1o'), (re.compile(r'^y(.*)$'), 'I\\1'), (re.compile(r'Iai'), 'AI'), (re.compile(r'Ia'), 'A'), (re.compile(r'Ie'), 'E'), (re.compile(r'Ii'), 'i'), (re.compile(r'Iou'), 'V'), (re.compile(r'Iu'), 'v'), (re.compile(r'(.v)(\d?)$'), '\\1I\\2'), (re.compile(r'Io'), 'O'), (re.compile(r'iu'), 'v'), (re.compile(r'ie'), 'E'), (re.compile(r'hui'), 'huei'), (re.compile(r'ui'), 'uI'), (re.compile(r'ai'), 'aI'), (re.compile(r'ei'), 'eI'), (re.compile(r'ia'), 'A'), (re.compile(r'(.*[^h])n([^g]?)$'), '\\1nM\\2'), (re.compile(r'(.*[^h])ng(.?)$'), '\\1n\\2'), (re.compile(r'^v(\d?$)'), 'vI'))#: Cyrillic replacement rules
CYRILLIC_TABLE = dict(zip('bpmfdtnlgkhjqxZCSrzcsiuvaoeê1234', 'бпмфдтнлгкхйцюячжшrzцszуиаоээ1234'))#: Cyrillic conversion table

# in pypinyin/style/bopomofo.py
BOPOMOFO_REPLACE = ((re.compile(r'^m(\d)$'), 'mu\\1'), (re.compile(r'^n(\d)$'), 'N\\1'), (re.compile(r'^r5$'), 'er5'), (re.compile(r'iu'), 'iou'), (re.compile(r'ui'), 'uei'), (re.compile(r'ong'), 'ung'), (re.compile(r'^yi?'), 'i'), (re.compile(r'^wu?'), 'u'), (re.compile(r'iu'), 'v'), (re.compile(r'^([jqx])u'), '\\1v'), (re.compile(r'([iuv])n'), '\\1en'), (re.compile(r'^zhi?'), 'Z'), (re.compile(r'^chi?'), 'C'), (re.compile(r'^shi?'), 'S'), (re.compile(r'^([zcsr])i'), '\\1'), (re.compile(r'ai'), 'A'), (re.compile(r'ei'), 'I'), (re.compile(r'ao'), 'O'), (re.compile(r'ou'), 'U'), (re.compile(r'ang'), 'K'), (re.compile(r'eng'), 'G'), (re.compile(r'an'), 'M'), (re.compile(r'en'), 'N'), (re.compile(r'er'), 'R'), (re.compile(r'eh'), 'E'), (re.compile(r'([iv])e'), '\\1E'), (re.compile(r'([^0-4])$'), '\\g<1>0'), (re.compile(r'1$'), ''))#: Bopomofo replacement rules
BOPOMOFO_TABLE = dict(zip('bpmfdtnlgkhjqxZCSrzcsiuvaoeEAIOUMNKGR2340ê', 'ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙㄧㄨㄩㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦㄝㄢㄣㄤㄥㄖㄤㄥㄩㄥㄜ2340ㄝ'))#: Bopomofo conversion table

# in pypinyin/style/braille_mainland.py
BRAILLE_MAINLAND_REPLACE = ((re.compile(r'iu'), 'iou'), (re.compile(r'ui'), 'uei'), (re.compile(r'un'), 'uen'), (re.compile(r'ong'), 'ung'), (re.compile(r'^yi?'), 'i'), (re.compile(r'^wu?'), 'u'), (re.compile(r'y'), 'i'), (re.compile(r'w'), 'u'), (re.compile(r'iu'), 'v'), (re.compile(r'^([jqx])u'), '\\1v'), (re.compile(r'([iuv])n'), '\\1en'), (re.compile(r'^zhi?'), 'Z'), (re.compile(r'^chi?'), 'C'), (re.compile(r'^shi?'), 'S'), (re.compile(r'^([zcsr])i'), '\\1'), (re.compile(r'iang'), '⠭'), (re.compile(r'uang'), '⠶'), (re.compile(r'ueng'), '⠲'), (re.compile(r'iong'), '⠹'), (re.compile(r'ang'), '⠦'), (re.compile(r'eng'), '⠼'), (re.compile(r'uai'), '⠽'), (re.compile(r'iao'), '⠜'), (re.compile(r'iou'), '⠳'), (re.compile(r'ian'), '⠩'), (re.compile(r'uan'), '⠻'), (re.compile(r'van'), '⠯'), (re.compile(r'uen'), '⠒'), (re.compile(r'ing'), '⠡'), (re.compile(r'ong'), '⠲'), (re.compile(r'er'), '⠗'), (re.compile(r'ai'), '⠪'), (re.compile(r'ei'), '⠮'), (re.compile(r'ao'), '⠖'), (re.compile(r'ou'), '⠷'), (re.compile(r'an'), '⠧'), (re.compile(r'en'), '⠴'), (re.compile(r'ia'), '⠫'), (re.compile(r'ua'), '⠿'), (re.compile(r'ie'), '⠑'), (re.compile(r'uo'), '⠕'), (re.compile(r've'), '⠾'), (re.compile(r'ui'), '⠺'), (re.compile(r'in'), '⠣'), (re.compile(r'vn'), '⠸'))#: Braille mainland replacement rules
BRAILLE_MAINLAND_TABLE = dict(zip('bpmfdtnlgkhjqxZCSrzcsiuvaoe1234', '⠃⠏⠍⠋⠙⠞⠝⠇⠛⠅⠓⠛⠅⠓⠌⠟⠱⠚⠵⠉⠎⠊⠥⠬⠔⠢⠢⠁⠂⠄⠆'))#: Braille mainland conversion table

```


### Detailed Explanation of Type Aliases
```python
# in pypinyin/pinyin_dict.py
_current_dir = os.path.dirname(os.path.realpath(__file__))#: directory path of the current file
_json_path = os.path.join(_current_dir, 'pinyin_dict.json')#: path to the pinyin dictionary JSON file

# in pypinyin/phrases_dict.py
_current_dir = os.path.dirname(os.path.realpath(__file__))#: directory path of the current file
_json_path = os.path.join(_current_dir, 'phrases_dict.json')#: path to the phrases dictionary JSON file

# in pypinyin/converter.py
_mixConverter = UltimateConverter#: default converter with all features enabled

# in pypinyin/__init__.py
__title__ = 'pypinyin'#: package title
__version__ = '0.55.0'#: package version
__author__ = 'mozillazg, 闲耘'#: package author
__license__ = 'MIT'#: package license
__copyright__ = 'Copyright (c) 2016 mozillazg, 闲耘'#: package copyright
__all__ = ['pinyin', 'lazy_pinyin', 'slug', 'load_single_dict', 'load_phrases_dict', 'Style', 'STYLE_NORMAL', 'NORMAL', 'STYLE_TONE', 'TONE', 'STYLE_TONE2', 'TONE2', 'STYLE_TONE3', 'TONE3', 'STYLE_INITIALS', 'INITIALS', 'STYLE_FINALS', 'FINALS', 'STYLE_FINALS_TONE', 'FINALS_TONE', 'STYLE_FINALS_TONE2', 'FINALS_TONE2', 'STYLE_FINALS_TONE3', 'FINALS_TONE3', 'STYLE_FIRST_LETTER', 'FIRST_LETTER', 'STYLE_BOPOMOFO', 'BOPOMOFO', 'STYLE_BOPOMOFO_FIRST', 'BOPOMOFO_FIRST', 'STYLE_CYRILLIC', 'CYRILLIC', 'STYLE_CYRILLIC_FIRST', 'CYRILLIC_FIRST']#: exported symbols

# in pypinyin/core.py
_default_convert = DefaultConverter()#: default converter instance
_default_pinyin = Pinyin(_default_convert)#: default pinyin instance
_to_fixed = to_fixed#: alias for to_fixed function

# in pypinyin/style/_tone_convert.py
_re_number = re.compile(r'\d')#: regular expression pattern for matching digits

# in pypinyin/style/wadegiles.py
_convert_table = [['a', 'a'], ['ai', 'ai'], ...]#: conversion table for Wade-Giles romanization
_initial_table = [['b', 'p'], ['p', 'p\''], ...]#: initial consonant conversion table
_tone_table = [['i', 'i'], ['u', 'u'], ...]#: tone conversion table
_except_table = [['zhi', 'chih'], ['chi', 'ch\'ih'], ...]#: exception conversion table

# in pypinyin/style/__init__.py
_registry = {}#: registry for storing pinyin style implementations

# in pypinyin/contrib/tone_sandhi.py
_re_num = re.compile(r'\d')#: regular expression pattern for matching digits

# in pypinyin/converter.pyi
TStyle = Style#: type alias for Style enumeration
TPinyinResult = List[List[Text]]#: type alias for pinyin result list
TErrorResult = Union[Text, List[Text], None]#: type alias for error result
TNoPinyinResult = Union[TPinyinResult, List[Text], Text, None]#: type alias for no pinyin result
TErrors = Union[Callable[[Text], Text], Text]#: type alias for error handling

# in pypinyin/style/__init__.pyi
TRegisterFunc = Optional[Callable[[Text, Dict[Any, Any]], Text]]#: type alias for register function
TWrapperFunc = Optional[Callable[[Text, Dict[Any, Any]], Text]]#: type alias for wrapper function

# in pypinyin/core.pyi
TStyle = Union[Style, Text]#: type alias for Style enumeration or Text

# in pypinyin/contrib/tone_sandhi.pyi
TStyle = Style#: type alias for Style enumeration
TPinyinResult = List[List[Text]]#: type alias for pinyin result list
TErrorResult = Union[Text, List[Text], None]#: type alias for error result
TNoPinyinResult = Union[TPinyinResult, List[Text], Text, None]#: type alias for no pinyin result
TErrors = Union[Callable[[Text], Text], Text]#: type alias for error handling
```

### Actual Usage Modes

#### Basic Usage

```python
from pypinyin import pinyin, lazy_pinyin, slug

# Basic pinyin conversion
result = pinyin('你好')  # [['nǐ'], ['hǎo']]
result = lazy_pinyin('你好')  # ['ni', 'hao']
result = slug('你好')  # 'ni-hao'

# Conversion in different styles
result = pinyin('你好', style=Style.TONE2)  # [['ni3'], ['hao3']]
result = pinyin('你好', style=Style.INITIALS)  # [['n'], ['h']]
result = pinyin('你好', style=Style.FINALS)  # [['i'], ['ao']]
```

#### Advanced Usage

```python
from pypinyin import pinyin, Style
from pypinyin.contrib.tone_sandhi import ToneSandhiMixin

# Polyphone handling
result = pinyin('中心', heteronym=True)  # [['zhōng', 'zhòng'], ['xīn']]

# Error handling
result = pinyin('你好123', errors='ignore')  # [['nǐ'], ['hǎo']]
result = pinyin('你好123', errors='replace')  # [['nǐ'], ['hǎo'], ['123']]

# Tone sandhi rules
result = pinyin('你好', tone_sandhi=True)  # [['ní'], ['hǎo']]
```

#### Usage of Custom Converters

```python
from pypinyin.core import Pinyin
from pypinyin.converter import DefaultConverter

# Create a custom converter
converter = DefaultConverter()
p = Pinyin(converter=converter)

# Use the custom converter
result = p.pinyin('你好')  # [['nǐ'], ['hǎo']]
result = p.lazy_pinyin('你好')  # ['ni', 'hao']
```

#### Usage of Dictionary Management

```python
from pypinyin import load_single_dict, load_phrases_dict

# Load a custom single-character dictionary
load_single_dict({ord('桔'): 'jú,jié'})

# Load a custom phrase dictionary
load_phrases_dict({'同行': [['tóng'], ['xíng']]})

# Use the custom dictionary
result = pinyin('桔子')  # [['jú'], ['zi']]
result = pinyin('同行')  # [['tóng'], ['xíng']]
```

#### Usage of Extended Functions

```python
from pypinyin.contrib.tone_convert import tone_to_normal, tone_to_tone2
from pypinyin.contrib.uv import V2UMixin
from pypinyin.contrib.neutral_tone import NeutralToneWith5Mixin

# Tone conversion
result = tone_to_normal('nǐ')  # 'ni'
result = tone_to_tone2('nǐ')  # 'ni3'

# ü sound handling
result = pinyin('女', v_to_u=True)  # [['nǚ']]

# Neutral tone marked as 5
result = pinyin('妈妈', neutral_tone_with_five=True)  # [['mā'], ['ma5']]
```

### Supported Pinyin Types

- **Basic Styles**:
  - `Style.NORMAL`: Normal style, without tones (ni hao)
  - `Style.TONE`: Style with tones (nǐ hǎo)
  - `Style.TONE2`: Tones are represented by numbers after the pinyin (ni3 hao3)
  - `Style.TONE3`: Tones are represented by numbers after the pinyin (ni3 hao3)

- **Initials and Finals Styles**:
  - `Style.INITIALS`: Only return the initials (n h)
  - `Style.FIRST_LETTER`: Only return the first letter (n h)
  - `Style.FINALS`: Only return the finals (i ao)
  - `Style.FINALS_TONE`: Finals with tones (ǐ ǎo)
  - `Style.FINALS_TONE2`: Finals with tone numbers (i3 ao3)
  - `Style.FINALS_TONE3`: Finals with tone numbers (i3 ao3)

- **Special Styles**:
  - `Style.BOPOMOFO`: Bopomofo (ㄋㄧˇ ㄏㄠˇ)
  - `Style.BOPOMOFO_FIRST`: First letter of Bopomofo (ㄋ ㄏ)
  - `Style.CYRILLIC`: Cyrillic alphabet (ни хао)
  - `Style.CYRILLIC_FIRST`: First letter of Cyrillic alphabet (н х)

- **Polyphone Handling**: Supports the polyphone mode and the handling of heteronyms.
- **Error Handling**: Supports multiple handling methods such as ignoring, replacing, and throwing exceptions.
- **Tone Sandhi Rules**: Supports rules such as third-tone sandhi.
- **Special Character Handling**: Supports the handling of punctuation marks, numbers, and English letters.

### Error Handling

The system provides a complete error handling mechanism:
- **Default Handling** (`'default'`): Keep the original characters.
- **Ignoring Handling** (`'ignore'`): Ignore characters without pinyin.
- **Exception Handling** (`'exception'`): Throw a `PinyinNotFoundException` exception.
- **Replacement Handling** (`'replace'`): Replace with the unicode encoding string without `\u`.
- **Custom Handling**: Supports passing in a custom callback function.

### Important Notes

1. **Polyphone Handling**: When `heteronym=True`, all possible pronunciations will be returned. When `heteronym=False`, only the first pronunciation will be returned.
2. **Strict Mode**: When `strict=True`, initials and finals are handled strictly according to the "Hanyu Pinyin Scheme". When `strict=False`, a relaxed mode is used.
3. **Tone Sandhi Rules**: When `tone_sandhi=True`, rules such as third-tone sandhi will be applied.
4. **ü Sound Handling**: When `v_to_u=True`, v will be converted to ü.
5. **Neutral Tone Handling**: When `neutral_tone_with_five=True`, the neutral tone will be marked as 5.
6. **Dictionary Management**: Supports the dynamic loading of custom single-character and phrase dictionaries.
7. **Extended Functions**: Supports extended functions such as custom converters, word segmenters, and styles.

