## Introduction and Goals of the python-ftfy Project

ftfy ("fixes text for you") is a Python library **designed for Unicode text repair**. It can automatically detect and fix various Unicode encoding issues, especially mojibake (encoding chaos) and other text corruption problems. This tool performs excellently in NLP research and data processing, achieving the core goal of "converting bad Unicode to good Unicode". Its core functions include: **intelligent encoding detection and repair** (automatically identifying cases where UTF-8 is incorrectly decoded as other encodings), **multi-layer mojibake repair** (capable of handling complex problems caused by multiple encoding conversions), and intelligent handling of special text issues such as HTML entities, control characters, full-width characters, and ligatures. In short, ftfy aims to provide a robust Unicode text repair system for handling corrupted text from external data sources (for example, automatically fixing mojibake through the `fix_text()` function and specifically handling encoding issues through the `fix_encoding()` function), allowing developers to focus on processing clean Unicode text rather than encoding problems.

## Natural Language Instructions (Prompt)

Please create a Python project named ftfy to implement a Unicode text repair library. The project should include the following functions:

1. **Encoding Detection and Repair Module**: Implement an intelligent mojibake detection algorithm that can identify cases where UTF-8 is incorrectly decoded as other encodings (such as Latin-1, Windows-1252, etc.). It should support the repair of multi-layer encoding problems, such as complex text corruption caused by multiple encoding conversions. The core function should automatically detect the encoding pattern and apply the corresponding repair strategy.

2. **Text Repair Function**: Implement various text repair functions, including HTML entity decoding (supporting case-insensitive entities), control character removal, full-width character standardization, ligature expansion, quote standardization, etc. Each repair function should be implemented as an independent module, supporting configurable repair strategies.

3. **Heuristic Algorithm**: Implement a rule-based heuristic algorithm to detect text problems and avoid false alarms. The algorithm should be able to distinguish between normal text and corrupted text and only apply repairs when there is sufficient evidence. It includes functions such as character frequency analysis, encoding pattern recognition, and text rationality judgment.

4. **Configuration System**: Design a flexible configuration system that allows users to enable/disable specific repair functions. The configuration should support default strategies and custom strategies and provide a detailed description function of the repair process.

5. **Command Line Interface**: Provide a complete command-line tool that supports file processing and streaming processing. The command-line tool should be able to handle input files in different encodings and provide detailed output of the repair process.

6. **Core File Requirements**: The project must include a complete pyproject.toml file, configuring the project as a standard Python package that can be installed via pip install, and declaring a complete list of dependencies - including core libraries such as wcwidth (used for Unicode character width calculation to support text formatting functions), ensuring compatibility for text repair, encoding processing, terminal display, etc. ftfy/__init__.py should serve as the unified API entry, integrating the core functions of each module: exporting the main text repair functions (fix_text() for complete text repair, fix_text_segment() for segmented repair, fix_encoding() focusing on encoding repair, fix_encoding_and_explain()/fix_and_explain() returning a description of the repair process, apply_plan() executing custom repair steps); utility functions (explain_unicode() parsing Unicode characters, fix_file() handling file repair, guess_bytes() guessing the encoding of byte sequences); configuration classes and data types (TextFixerConfig for repair strategy configuration, ExplainedText encapsulating the repair result and description, ExplanationStep recording the details of a single repair step); and providing version information through __version__, ensuring that users can directly access all core functions through concise statements such as from ftfy import fix_text. ftfy/fixes.py should implement the basic text repair logic: unescape_html() handling HTML entity escaping (e.g., restoring &amp; to &); fix_surrogates() repairing Unicode surrogate characters (solving the problem of illegal UTF-16 surrogate pairs); remove_control_chars() removing non-printable control characters (retaining necessary control characters such as line breaks); remove_terminal_escapes() clearing terminal escape sequences (such as ANSI color codes), providing basic operation support for upper-level repair functions. In ftfy/chardata.py, the possible_encoding() function should implement character encoding compatibility checks, determining whether the given text may belong to a specified encoding (such as UTF-8, Latin-1), providing a low-level judgment basis for encoding guessing and repair. In ftfy/bad_codecs/__init__.py, the search_function() function should be implemented to register and find custom codecs (such as extended processing for encodings like Windows-1252, ISO-8859), supporting the parsing ability for non-standard encodings. The IncrementalDecoder class in utf8_variants.py under it should support incremental decoding of UTF-8 variants (such as over-encoded or incorrectly continued UTF-8), gradually processing the byte stream and repairing encoding exceptions. In ftfy/cli.py, the main() function should be implemented as the command-line entry, supporting command-line parameter parsing: including specifying the file path (for batch text repair), encoding guessing switch (automatically detecting the input encoding), Unicode standardization options (specifying standardization forms such as NFC/NFD), etc., enabling the tool to be directly called through the terminal. In ftfy/formatting.py, the display_ljust() function should implement left-aligned formatting of Unicode characters, considering the display width of different characters (e.g., full-width characters occupying 2 columns), ensuring the neat display of the repaired text in the terminal. In ftfy/badness.py, the is_bad() function should detect whether the text has encoding problems through quantitative indicators (such as the proportion of non-ASCII characters, the frequency of surrogate characters), serving as a judgment basis for whether to trigger the repair process and optimizing the repair efficiency.

## Environment Configuration

### Core Dependency Library Versions

```Plain
# Core Unicode processing library
wcwidth==0.2.13                    # Character width calculation library

# Testing framework
pytest>=8.3.2,<9                   # Unit testing framework

# Documentation generation
Sphinx>=7,<8                       # Documentation generation tool
furo>=2024.7.18                    # Sphinx theme

# Code quality tool
ruff                               # Python code checking and formatting tool
```

## Architecture of the python-ftfy Project

### Project Directory Structure

```Plain
workspace/
├── .github
│   ├── workflows
│   │   └── publish.yml
├── .gitignore
├── .mailmap
├── .readthedocs.yaml
├── CHANGELOG.md
├── LICENSE.txt
├── MANIFEST.in
├── README.md
├── docs
│   ├── Makefile
│   ├── _static
│   │   ├── css
│   │   │   └── custom.css
│   ├── avoid.rst
│   ├── bad_encodings.rst
│   ├── cite.rst
│   ├── cli.rst
│   ├── conf.py
│   ├── config.rst
│   ├── detect.rst
│   ├── encodings.rst
│   ├── explain.rst
│   ├── fixes.rst
│   ├── heuristic.rst
│   ├── images
│   │   ├── shipping-label.png
│   ├── index.rst
├── ftfy
│   ├── __init__.py
│   ├── bad_codecs
│   │   ├── __init__.py
│   │   ├── sloppy.py
│   │   ├── utf8_variants.py
│   ├── badness.py
│   ├── chardata.py
│   ├── cli.py
│   ├── fixes.py
│   ├── formatting.py
│   ├── py.typed
├── mypy.ini
├── notebook
│   ├── excel-export.png
│   ├── ftfy talk.ipynb
├── notes
│   ├── mysteries.txt
├── pyproject.toml
├── pytest.ini
├── scripts
│   ├── char_data_table.py
├── tox.ini
└── uv.lock
```

## API Usage Guide

### Module Import

```python
from ftfy import (
    apply_plan, bad_codecs, fix_and_explain, fix_encoding, 
    fix_encoding_and_explain, fix_text, fix_text_segment, guess_bytes,
    explain_unicode, fix_file, TextFixerConfig, ExplainedText, ExplanationStep
)
from ftfy.bad_codecs.utf8_variants import IncrementalDecoder
from ftfy.chardata import possible_encoding
from ftfy.fixes import (
    fix_surrogates, remove_control_chars, unescape_html
)
```

### Core API Functions

#### 1. `fix_text()` - Segment-Aware Text Repair

**Function**: Normalize and repair Unicode text by processing it in segments (lines or chunks capped by `config.max_decode_length`) and applying the configured fixers to each segment.

**Function Signature**:
```python
def fix_text(
    text: str,
    config: TextFixerConfig | None = None,
    **kwargs: Any,
) -> str:
```

**Parameters**:
- `text`: Unicode string that may contain mojibake, HTML entities, or problematic control characters.
- `config`: Optional `TextFixerConfig`. Defaults to `TextFixerConfig(explain=False)` so explanations are skipped for streaming use cases.
- `**kwargs`: Keyword overrides for configuration fields (for example `uncurl_quotes=False`).

**Return Value**: Repaired Unicode string.

**Example**:
```python
import ftfy

print(ftfy.fix_text("&amp;&lt;&gt;"))          # "&<>"
print(ftfy.fix_text("sÃ³"))                  # "só"
print(ftfy.fix_text("l'humanitÃ©"))          # "l'humanité"
```

#### 2. `fix_text_segment()` - Single-Segment Repair

**Function**: Apply the same repair pipeline as `fix_text` to a single string segment and discard any explanation data.

**Function Signature**:
```python
def fix_text_segment(
    text: str,
    config: TextFixerConfig | None = None,
    **kwargs: Any,
) -> str:
```

**Parameters**:
- `text`: Unicode segment to repair.
- `config`: Optional configuration (defaults to `TextFixerConfig(explain=False)`).
- `**kwargs`: Keyword overrides for configuration fields.

**Return Value**: Repaired segment as a Unicode string.

**Example**:
```python
from ftfy import fix_text_segment

print(fix_text_segment("ellipsis&#133;", normalization="NFKC"))  # "ellipsis..."
```

#### 3. `fix_and_explain()` - Repair With Explanation

**Function**: Repair a single segment and return both the fixed text and the explanation plan describing every applied step.

**Function Signature**:
```python
def fix_and_explain(
    text: str,
    config: TextFixerConfig | None = None,
    **kwargs: Any,
) -> ExplainedText:
```

**Parameters**:
- `text`: Unicode segment to repair.
- `config`: Optional `TextFixerConfig` (defaults to collecting explanations).
- `**kwargs`: Keyword overrides for configuration fields.

**Return Value**: `ExplainedText(text: str, explanation: list[ExplanationStep] | None)`.

**Example**:
```python
from ftfy import fix_and_explain

fixed, steps = fix_and_explain("L&AMP;AMP;ATILDE;&AMP;AMP;SUP3;PEZ")
print(fixed)   # "LóPEZ"
print(steps)   # [('apply', 'unescape_html'), ('apply', 'unescape_html'), ('apply', 'unescape_html'), ('encode', 'latin-1'), ('decode', 'utf-8')]
```

#### 4. `fix_encoding()` - Mojibake Repair Only

**Function**: Attempt to reverse incorrect single-byte decoding of UTF-8 (mojibake) without running the other character-level fixers.

**Function Signature**:
```python
def fix_encoding(
    text: str,
    config: TextFixerConfig | None = None,
    **kwargs: Any,
) -> str:
```

**Parameters**:
- `text`: Unicode text suspected to contain mojibake.
- `config`: Optional configuration controlling encoding heuristics.
- `**kwargs`: Keyword overrides synchronized with `TextFixerConfig` fields.

**Return Value**: Unicode string with encoding issues repaired.

**Example**:
```python
from ftfy import fix_encoding

print(fix_encoding("sÃ³"))  # "só"
```

#### 5. `fix_encoding_and_explain()` - Mojibake Repair With Plan

**Function**: Apply the same mojibake heuristics as `fix_encoding` but also return a reproducible plan of encoding/decoding steps.

**Function Signature**:
```python
def fix_encoding_and_explain(
    text: str,
    config: TextFixerConfig | None = None,
    **kwargs: Any,
) -> ExplainedText:
```

**Parameters**:
- `text`: Unicode text to repair.
- `config`: Optional configuration controlling encoding heuristics and explanation capture.
- `**kwargs`: Keyword overrides for configuration fields.

**Return Value**: `ExplainedText` containing the repaired text and a list of plan steps.

**Example**:
```python
from ftfy import fix_encoding_and_explain

fixed, plan = fix_encoding_and_explain("voilÃ le travail")
print(fixed)  # "voilà le travail"
print(plan)   # [('encode', 'latin-1'), ('decode', 'utf-8')]
```

#### 6. `apply_plan()` - Replay an Explanation

**Function**: Execute an explanation plan (as produced by `fix_and_explain` or `fix_encoding_and_explain`) on new text.

**Function Signature**:
```python
def apply_plan(
    text: str,
    plan: list[tuple[str, str]],
) -> str:
```

**Parameters**:
- `text`: The starting Unicode string.
- `plan`: Sequence of `(operation, argument)` tuples where `operation` is `"encode"`, `"decode"`, `"transcode"`, or `"apply"`.

**Return Value**: Unicode string after applying the plan.

**Example**:
```python
from ftfy import apply_plan

plan = [("encode", "latin-1"), ("decode", "utf-8")]
print(apply_plan("sÃ³", plan))  # "só"
```

#### 7. `explain_unicode()` - Code Point Inspection

**Function**: Print a formatted table showing the code point, glyph, Unicode category, and name for every character in a string.

**Function Signature**:
```python
def explain_unicode(text: str) -> None:
```

**Parameters**:
- `text`: Unicode string to inspect.

**Return Value**: `None` (information is printed to stdout).

**Example**:
```python
import ftfy

ftfy.explain_unicode("(╯°□°)╯︵ ┻━┻")
```

#### 8. `fix_file()` - Streaming File Repair

**Function**: Iterate over a text or binary file, decoding bytes if needed, repairing each line with `fix_and_explain`, and yielding the fixed lines.

**Function Signature**:
```python
def fix_file(
    input_file: TextIO | BinaryIO,
    encoding: str | None = None,
    config: TextFixerConfig | None = None,
    **kwargs: Any,
) -> Iterator[str]:
```

**Parameters**:
- `input_file`: Open file object (text or binary).
- `encoding`: Encoding name to decode bytes (`None` triggers guessing when `input_file` is binary).
- `config`: Optional configuration passed to `fix_and_explain`.
- `**kwargs`: Keyword overrides for the configuration.

**Return Value**: Iterator of repaired Unicode lines.

**Example**:
```python
from ftfy import fix_file
from pathlib import Path

with Path("tests/face.txt").open("rb") as source:
    fixed_lines = list(fix_file(source, encoding="sloppy-windows-1252", normalization=None))
    print(fixed_lines[0])  # "┒(⌣˛⌣)┎\r\n"
```

#### 9. `guess_bytes()` - Encoding Guess Helper

**Function**: Attempt to decode an unknown byte string by trying a short list of encodings that ftfy can distinguish.

**Function Signature**:
```python
def guess_bytes(bstring: bytes) -> tuple[str, str]:
```

**Parameters**:
- `bstring`: Byte string to decode. Passing a Unicode string raises `UnicodeError`.

**Return Value**: Tuple `(decoded_text, encoding_name)`.

**Example**:
```python
from ftfy import guess_bytes

text, encoding = guess_bytes(b"RenÃ©e
Fleming")
print(text)      # "Renée
Fleming"
print(encoding)  # "utf-8"
```
### Configuration System

#### TextFixerConfig Class

```python
class TextFixerConfig(NamedTuple):
    unescape_html: str | bool = "auto"           # HTML entity decoding
    remove_terminal_escapes: bool = True         # Remove terminal escape sequences
    fix_encoding: bool = True                    # Fix encoding problems
    restore_byte_a0: bool = True                 # Restore non-breaking spaces
    replace_lossy_sequences: bool = True         # Replace lossy sequences
    decode_inconsistent_utf8: bool = True        # Decode inconsistent UTF-8
    fix_c1_controls: bool = True                 # Fix C1 control characters
    fix_latin_ligatures: bool = True             # Fix Latin ligatures
    fix_character_width: bool = True             # Fix character width
    uncurl_quotes: bool = True                   # Straighten quotes
    fix_line_breaks: bool = True                 # Fix line breaks
    fix_surrogates: bool = True                  # Fix surrogate pairs
    remove_control_chars: bool = True            # Remove control characters
    normalization: Literal["NFC", "NFD", "NFKC", "NFKD"] | None = "NFC"
    max_decode_length: int = 1000000             # Segment size cap
    explain: bool = True                         # Collect explanation steps
```

> Functions that do not return explanations (`fix_text`, `fix_text_segment`, and `fix_file`) automatically use a copy of this configuration with `explain=False`.

#### Configuration Usage Example

```python
import ftfy

# Use default configuration
print(ftfy.fix_text("sÃ³"))  # "só"

# Use custom configuration
config = ftfy.TextFixerConfig(
    unescape_html=False,
    fix_character_width=False,
    normalization="NFKC",
    explain=False,
)
print(ftfy.fix_text("CafÃ©", config))  # "Café"

# Override individual options
print(ftfy.fix_text("CafÃ©", unescape_html=False))  # "CafÃ©"
```

### Command Line Interface

#### Basic Usage

```bash
# Fix a file
ftfy input.txt -o output.txt

# Read from standard input and output to standard output
type input.txt | ftfy

# Specify the input encoding explicitly
ftfy -e latin-1 input.txt

# Guess the input encoding
ftfy -g input.txt

# Apply a different Unicode normalisation
ftfy -n NFKC input.txt

# Preserve HTML entities that already appear in the file
ftfy --preserve-entities input.html
```

### Best Practices

1. **Avoid False Alarms**: ftfy is conservative and only applies repairs when the heuristics see strong evidence of corruption.
2. **Configuration Selection**: Toggle configuration options (for example `uncurl_quotes=False`) to match your data.
3. **HTML Processing**: When the output needs to remain HTML, set `unescape_html=False`.
4. **CJK Text**: Keep column widths by disabling `fix_character_width` when processing aligned CJK text.
5. **Quote Handling**: Disable `uncurl_quotes` if typographic quotes must be preserved.
6. **Performance Consideration**: For large files or streams, prefer `fix_file()` to avoid loading the full content into memory.

## Core Algorithm Logic

### Encoding Repair Algorithm (`_fix_encoding_one_step_and_explain`)

**Algorithm Flow**:

1. **Quick Exit Conditions**:
   - Return unchanged if text is ASCII-only (via `possible_encoding(text, "ascii")`)
   - Return unchanged if `is_bad(text)` returns False (no mojibake detected)

2. **Encoding Candidate Loop** (iterate through `CHARMAP_ENCODINGS`):
   ```python
   for encoding in ["latin-1", "sloppy-windows-1252", "sloppy-windows-1251", ...]:
       if possible_encoding(text, encoding):
           # Step A: Encode text as bytes using candidate encoding
           encoded_bytes = text.encode(encoding)

           # Step B: Apply byte-level transcoding fixes
           if config.restore_byte_a0 and ALTERED_UTF8_RE matches:
               encoded_bytes = restore_byte_a0(encoded_bytes)  # Fix 0x20 -> 0xA0

           if config.replace_lossy_sequences and encoding.startswith("sloppy"):
               encoded_bytes = replace_lossy_sequences(encoded_bytes)  # Fix 0x1A -> 0xFFFD

           # Step C: Attempt UTF-8 decode
           try:
               fixed = encoded_bytes.decode("utf-8" or "utf-8-variants")
               return ExplainedText(fixed, [encode_step, transcode_steps, decode_step])
           except UnicodeDecodeError:
               continue  # Try next encoding
   ```

3. **Fallback Strategies** (if no full fix found):
   - **Inconsistent UTF-8**: If `UTF8_DETECTOR_RE` matches, apply `decode_inconsistent_utf8` to fix partial mojibake
   - **Latin-1 to Windows-1252**: If text is Latin-1 but not Windows-1252, convert C1 controls
   - **C1 Controls**: Apply `fix_c1_controls` as last resort for stray control characters

4. **Iterative Repair** (`fix_encoding_and_explain` outer loop):
   ```python
   while True:
       prevtext = text
       text, plan = _fix_encoding_one_step_and_explain(text, config)
       if text == prevtext:  # No more changes
           return ExplainedText(text, plan_so_far)
       plan_so_far.extend(plan)
   ```

**Key Decision Points**:
- **Badness threshold**: Only repair if `is_bad(text)` is True (heuristic matches `BADNESS_RE`)
- **Encoding priority**: `CHARMAP_ENCODINGS` ordered by likelihood (latin-1, then Windows variants)
- **Decode validation**: UTF-8 decode must succeed; if it fails, candidate is rejected

### Text Segmentation (`fix_text`)

**Segmentation Strategy**:
```python
pos = 0
while pos < len(text):
    # Find next line break or max_decode_length boundary
    textbreak = text.find("\n", pos) + 1
    if textbreak == 0:
        textbreak = len(text)
    if (textbreak - pos) > config.max_decode_length:
        textbreak = pos + config.max_decode_length

    segment = text[pos:textbreak]
    fixed_segment, _ = fix_and_explain(segment, config)
    out.append(fixed_segment)
    pos = textbreak
```

**Purpose**: Prevents unbounded slowdowns on long text without line breaks by capping segment length at `max_decode_length` (default 1,000,000 chars).

## Detailed Function Implementation Nodes

### Node 1: HTML Entity Decoding and Repair

**Function Description**: Detects HTML character references (standard, numeric, hexadecimal, or uppercase variants) and replaces them with the intended characters unless the surrounding text looks like real HTML markup.

**Repair Strategies**:
- Standard entities: `&amp;` → `&`
- Numeric references: `&#133;` → `...`
- Hexadecimal references: `&#x80;` → `€`
- Uppercase entity names: `&SACUTE;` → `Ś`
- Multi-layer entities: repeated `&amp;` sequences collapse to a single layer
- Context-aware decoding: literal HTML markup keeps its entities

**Input/Output Examples**:

```python
from ftfy import fix_text, fix_text_segment
from ftfy.fixes import unescape_html

print(fix_text("&amp;&lt;&gt;"))                     # "&<>"
print(fix_text_segment("ellipsis&#133;", normalization="NFKC"))  # "ellipsis..."
print(unescape_html("euro &#x80;"))                 # "euro €"
print(unescape_html("JEDNOCZE&SACUTE;NIE"))         # "JEDNOCZEŚNIE"
print(fix_text_segment("&amp;amp;amp;"))            # "&"
print(fix_text("&amp;\n<html>\n&amp;"))             # "&\n<html>\n&amp;"
print(fix_text("&amp;", unescape_html=False))       # "&amp;"
```

### Node 2: Unicode Control Character Processing

**Function Description**: Removes or repairs problematic control characters, surrogate pairs, and stray terminal escapes while preserving meaningful formatting characters.

**Repair Strategies**:
- Strip byte-order marks from the start of text
- Collapse valid surrogate pairs into their Unicode scalars
- Drop unwanted control characters but keep essential whitespace
- Remove ANSI terminal escape sequences and record the action in explanations
- Leave tag-based emoji sequences untouched

**Input/Output Examples**:

```python
from ftfy import fix_and_explain
from ftfy.fixes import remove_bom, fix_surrogates, remove_control_chars

print(remove_bom("\ufeffWhere do you want to go today?"))  # "Where do you want to go today?"
print(fix_surrogates("\udbff\udfff"))                      # "\U0010ffff"
print(fix_surrogates("\ud800\udc00"))                      # "\U00010000"

sample = "\ufeffSometimes, \ufffcbad ideas \x7f\ufffalike these characters\ufffb \u206aget standardized.\r\n"
print(remove_control_chars(sample))  # "Sometimes, bad ideas like these characters get standardized.\r\n"

fixed, plan = fix_and_explain("\x01\x1b[36;44mfoo")
print(fixed)  # "foo"
print(plan)   # [('apply', 'remove_terminal_escapes'), ('apply', 'remove_control_chars')]

emoji = "This flag has a dragon on it \U0001F409\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F"
print(remove_control_chars(emoji))  # unchanged (preserves tag characters)
```

### Node 3: Encoding Detection and Guessing

**Function Description**: Provides helpers for recovering text from unknown byte streams and decoding UTF-8 variants incrementally.

**Detection Strategies**:
- Recognise UTF-16 BOMs up front
- Distinguish UTF-8 from sloppy single-byte encodings
- Fall back to MacRoman when carriage returns are present without line feeds
- Support CESU-8 / Java Modified UTF-8 sequences via `utf-8-variants`
- Decode streaming data safely with incremental decoders

**Input/Output Examples**:

```python
from ftfy import guess_bytes
from ftfy.bad_codecs.utf8_variants import IncrementalDecoder

text, encoding = guess_bytes(b"Ren\xc3\xa9e\nFleming")
print(text)      # "Renée\nFleming"
print(encoding)  # "utf-8"

text, encoding = guess_bytes("Renée\rFleming".encode("macroman"))
print(text)      # "Renée\rFleming"
print(encoding)  # "macroman"

text, encoding = guess_bytes(b"null\xc0\x80 separated")
print(text)      # "null\x00 separated"
print(encoding)  # "utf-8-variants"

decoder = IncrementalDecoder()
part1 = b"surrogates: \xed\xa0\x80"
part2 = b"\xed\xb0\x80 / null: \xc0\x80"
result = decoder.decode(part1, final=False) + decoder.decode(part2, final=True)
print(result)  # "surrogates: 𐀀 / null: \x00"
```

### Node 4: Custom Codec Support

**Function Description**: Registers sloppy single-byte codecs and the `utf-8-variants` codec with Python’s codec registry so that the rest of ftfy can request them transparently.

**Support Strategies**:
- Cache codec lookups for repeat calls
- Accept multiple alias spellings for `utf-8-variants`
- Defer to Python’s codec machinery once the codec info is registered

**Input/Output Examples**:

```python
from ftfy import bad_codecs
import codecs

info = bad_codecs.search_function("cesu8")
print(info.name)                                  # "utf-8-variants"
print(info is bad_codecs.search_function("cesu-8"))  # True

data = b"\xed\xa6\x85\xed\xb0\x80"
text = codecs.decode(data, "utf-8-variants")
print(text)  # "𱐀" (U+31400)
```

### Node 5: Command Line Interface Processing

**Function Description**: Demonstrates the behaviour of the `ftfy` CLI wrapper, mirroring the checks in `tests/test_cli.py`.

**Functional Features**:
- Repairs files passed as positional arguments
- Can guess encodings (`-g`) or use an explicit encoding (`-e`)
- Streams from standard input when no filename is supplied
- Emits clear error messages for decode failures or dangerous output paths

**Input/Output Examples**:

```python
import subprocess
from pathlib import Path

FACE = Path("tests/face.txt")

result = subprocess.check_output(["ftfy", str(FACE)], timeout=5).decode("utf-8")
print(result)  # "\u2512(\u2323\u02db\u2323)\u250e\r\n"

result = subprocess.check_output(["ftfy", "-g", str(FACE)], timeout=5).decode("utf-8")
print(result)  # "\u2512(\u2323\u02db\u2323)\u250e\r\n"

result = subprocess.check_output(["ftfy", "-e", "sloppy-windows-1252", str(FACE)], timeout=5).decode("utf-8")
print(result)  # "\u2512(\u2323\u02db\u2323)\u250e\r\n"

try:
    subprocess.check_output(["ftfy", "-e", "windows-1252", str(FACE)], stderr=subprocess.STDOUT, timeout=5)
except subprocess.CalledProcessError as error:
    print(error.output.decode("utf-8").startswith("ftfy error:"))  # True

with FACE.open("rb") as fh:
    stdin_output = subprocess.check_output(["ftfy"], stdin=fh, timeout=5).decode("utf-8")
    print(stdin_output)  # "\u2512(\u2323\u02db\u2323)\u250e\r\n"
```

### Node 6: Complex Text Repair and Explanation

**Function Description**: Shows how ftfy combines character fixes, encoding repairs, and explanation plans for multi-layer mojibake.

**Repair Strategies**:
- Apply multiple encoding passes when necessary
- Expose the plan so it can be replayed with `apply_plan`
- Honour configuration switches to disable specific fixers

**Input/Output Examples**:

```python
from ftfy import apply_plan, fix_and_explain, fix_encoding_and_explain, fix_text

print(fix_text("\xe2\u0153\u201d No problems"))  # "\u2714 No problems"
print(fix_text("The Mona Lisa doesn\u00c3\u0192\u00c2\u00a2\u00c3\u00a2\u20ac\u0161\u00c2\u00ac\u00c3\u00a2\u20ac\u017e\u00c2\u00a2t have eyebrows."))  # "The Mona Lisa doesn't have eyebrows."
print(fix_text("l'humanit\u00c3\u00a9"))  # "l'humanité"

fixed, explanation = fix_and_explain("L&AMP;AMP;ATILDE;&AMP;AMP;SUP3;PEZ")
print(fixed)        # "LóPEZ"
print(explanation)  # [('apply', 'unescape_html'), ('apply', 'unescape_html'), ('apply', 'unescape_html'), ('encode', 'latin-1'), ('decode', 'utf-8')]

plan = [("encode", "latin-1"), ("decode", "utf-8")]
print(apply_plan("s\u00c3\u00b3", plan))  # "só"

fixed, explanation = fix_encoding_and_explain("voil\u00c3 le travail")
print(fixed)        # "voilà le travail"
print(explanation)  # [('encode', 'latin-1'), ('decode', 'utf-8')]
```

### Node 7: Character Encoding Detection and Validation

**Function Description**: Provides helpers for reasoning about which encodings can represent a string, as used by the mojibake heuristic.

**Detection Strategies**:
- Quickly reject characters outside an encoding’s repertoire via precompiled regular expressions
- Use the same helpers in `_fix_encoding_one_step_and_explain` to shortlist candidate encodings

**Input/Output Examples**:

```python
from ftfy.chardata import possible_encoding

print(possible_encoding("Caf\u00e9", "latin-1"))   # True
print(possible_encoding("𐀀", "latin-1"))         # False

def all_chars_fit(text: str, encoding: str) -> bool:
    return all(possible_encoding(ch, encoding) for ch in text)

print(all_chars_fit("Renée", "latin-1"))      # True
print(all_chars_fit("Renée", "utf-8"))        # True
print(all_chars_fit("𐀀", "latin-1"))         # False
```

### Internal Helper APIs
#### ftfy.badness

- **`MOJIBAKE_CATEGORIES`**: Dictionary grouping mojibake-prone Unicode characters into semantic sets (common, currency, punctuation, etc.) that feed the heuristic cost model.
- **`BADNESS_RE`**: Compiled `re.Pattern` built from `MOJIBAKE_CATEGORIES`; `badness()` counts its matches while `is_bad()` tests for any match.

**Complete `MOJIBAKE_CATEGORIES` Implementation**:

```python
MOJIBAKE_CATEGORIES = {
    "common": (
        "\N{NO-BREAK SPACE}"
        "\N{SOFT HYPHEN}"
        "\N{MIDDLE DOT}"
        "\N{ACUTE ACCENT}"
        "\N{EN DASH}"
        "\N{EM DASH}"
        "\N{HORIZONTAL BAR}"
        "\N{HORIZONTAL ELLIPSIS}"
        "\N{RIGHT SINGLE QUOTATION MARK}"
    ),
    "c1": "\x80-\x9f",
    "bad": (
        "\N{BROKEN BAR}"
        "\N{CURRENCY SIGN}"
        "\N{DIAERESIS}"
        "\N{NOT SIGN}"
        "\N{MACRON}"
        "\N{CEDILLA}"
        "\N{LATIN SMALL LETTER F WITH HOOK}"
        "\N{MODIFIER LETTER CIRCUMFLEX ACCENT}"
        "\N{CARON}"
        "\N{BREVE}"
        "\N{OGONEK}"
        "\N{SMALL TILDE}"
        "\N{DAGGER}"
        "\N{DOUBLE DAGGER}"
        "\N{PER MILLE SIGN}"
        "\N{REVERSED NOT SIGN}"
        "\N{LOZENGE}"
        "\ufffd"
        "\N{FEMININE ORDINAL INDICATOR}"
        "\N{MASCULINE ORDINAL INDICATOR}"
    ),
    "law": (
        "\N{PILCROW SIGN}"
        "\N{SECTION SIGN}"
    ),
    "currency": (
        "\N{CENT SIGN}"
        "\N{POUND SIGN}"
        "\N{YEN SIGN}"
        "\N{PESETA SIGN}"
        "\N{EURO SIGN}"
    ),
    "start_punctuation": (
        "\N{INVERTED EXCLAMATION MARK}"
        "\N{LEFT-POINTING DOUBLE ANGLE QUOTATION MARK}"
        "\N{INVERTED QUESTION MARK}"
        "\N{COPYRIGHT SIGN}"
        "\N{GREEK TONOS}"
        "\N{GREEK DIALYTIKA TONOS}"
        "\N{LEFT SINGLE QUOTATION MARK}"
        "\N{SINGLE LOW-9 QUOTATION MARK}"
        "\N{LEFT DOUBLE QUOTATION MARK}"
        "\N{DOUBLE LOW-9 QUOTATION MARK}"
        "\N{BULLET}"
        "\N{SINGLE LEFT-POINTING ANGLE QUOTATION MARK}"
        "\uf8ff"
    ),
    "end_punctuation": (
        "\N{REGISTERED SIGN}"
        "\N{RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK}"
        "\N{DOUBLE ACUTE ACCENT}"
        "\N{RIGHT DOUBLE QUOTATION MARK}"
        "\N{SINGLE RIGHT-POINTING ANGLE QUOTATION MARK}"
        "\N{TRADE MARK SIGN}"
    ),
    "numeric": (
        "\N{SUPERSCRIPT TWO}"
        "\N{SUPERSCRIPT THREE}"
        "\N{SUPERSCRIPT ONE}"
        "\N{PLUS-MINUS SIGN}"
        "\N{VULGAR FRACTION ONE QUARTER}"
        "\N{VULGAR FRACTION ONE HALF}"
        "\N{VULGAR FRACTION THREE QUARTERS}"
        "\N{MULTIPLICATION SIGN}"
        "\N{MICRO SIGN}"
        "\N{DIVISION SIGN}"
        "\N{FRACTION SLASH}"
        "\N{PARTIAL DIFFERENTIAL}"
        "\N{INCREMENT}"
        "\N{N-ARY PRODUCT}"
        "\N{N-ARY SUMMATION}"
        "\N{SQUARE ROOT}"
        "\N{INFINITY}"
        "\N{INTERSECTION}"
        "\N{INTEGRAL}"
        "\N{ALMOST EQUAL TO}"
        "\N{NOT EQUAL TO}"
        "\N{IDENTICAL TO}"
        "\N{LESS-THAN OR EQUAL TO}"
        "\N{GREATER-THAN OR EQUAL TO}"
        "\N{NUMERO SIGN}"
    ),
    "kaomoji": (
        "Ò-Ö"
        "Ù-Ü"
        "ò-ö"
        "ø-ü"
        "\N{LATIN CAPITAL LETTER O WITH DOUBLE ACUTE}"
        "\N{LATIN CAPITAL LETTER O WITH MACRON}"
        "\N{LATIN CAPITAL LETTER U WITH MACRON}"
        "\N{LATIN CAPITAL LETTER U WITH OGONEK}"
        "\N{DEGREE SIGN}"
    ),
    "upper_accented": (
        "\xc0-\xd1"
        "\N{LATIN CAPITAL LETTER O WITH STROKE}"
        "\N{LATIN CAPITAL LETTER U WITH DIAERESIS}"
        "\N{LATIN CAPITAL LETTER Y WITH ACUTE}"
        "\N{LATIN CAPITAL LETTER A WITH BREVE}"
        "\N{LATIN CAPITAL LETTER A WITH MACRON}"
        "\N{LATIN CAPITAL LETTER A WITH OGONEK}"
        "\N{LATIN CAPITAL LETTER C WITH ACUTE}"
        "\N{LATIN CAPITAL LETTER C WITH CARON}"
        "\N{LATIN CAPITAL LETTER D WITH CARON}"
        "\N{LATIN CAPITAL LETTER D WITH STROKE}"
        "\N{LATIN CAPITAL LETTER E WITH OGONEK}"
        "\N{LATIN CAPITAL LETTER E WITH CARON}"
        "\N{LATIN CAPITAL LETTER E WITH MACRON}"
        "\N{LATIN CAPITAL LETTER E WITH DOT ABOVE}"
        "\N{LATIN CAPITAL LETTER G WITH BREVE}"
        "\N{LATIN CAPITAL LETTER G WITH CEDILLA}"
        "\N{LATIN CAPITAL LETTER I WITH DOT ABOVE}"
        "\N{LATIN CAPITAL LETTER I WITH MACRON}"
        "\N{LATIN CAPITAL LETTER K WITH CEDILLA}"
        "\N{LATIN CAPITAL LETTER L WITH ACUTE}"
        "\N{LATIN CAPITAL LETTER L WITH CARON}"
        "\N{LATIN CAPITAL LETTER L WITH STROKE}"
        "\N{LATIN CAPITAL LETTER L WITH CEDILLA}"
        "\N{LATIN CAPITAL LETTER N WITH ACUTE}"
        "\N{LATIN CAPITAL LETTER N WITH CARON}"
        "\N{LATIN CAPITAL LETTER N WITH CEDILLA}"
        "\N{LATIN CAPITAL LIGATURE OE}"
        "\N{LATIN CAPITAL LETTER R WITH CARON}"
        "\N{LATIN CAPITAL LETTER S WITH ACUTE}"
        "\N{LATIN CAPITAL LETTER S WITH CEDILLA}"
        "\N{LATIN CAPITAL LETTER S WITH CARON}"
        "\N{LATIN CAPITAL LETTER T WITH CEDILLA}"
        "\N{LATIN CAPITAL LETTER T WITH CARON}"
        "\N{LATIN CAPITAL LETTER U WITH RING ABOVE}"
        "\N{LATIN CAPITAL LETTER U WITH DOUBLE ACUTE}"
        "\N{LATIN CAPITAL LETTER Y WITH DIAERESIS}"
        "\N{LATIN CAPITAL LETTER Z WITH ACUTE}"
        "\N{LATIN CAPITAL LETTER Z WITH DOT ABOVE}"
        "\N{LATIN CAPITAL LETTER Z WITH CARON}"
        "\N{CYRILLIC CAPITAL LETTER GHE WITH UPTURN}"
    ),
    "lower_accented": (
        "\N{LATIN SMALL LETTER SHARP S}"
        "\xe0-\xf1"
        "\N{LATIN SMALL LETTER A WITH BREVE}"
        "\N{LATIN SMALL LETTER A WITH OGONEK}"
        "\N{LATIN SMALL LETTER A WITH MACRON}"
        "\N{LATIN SMALL LETTER C WITH ACUTE}"
        "\N{LATIN SMALL LETTER C WITH CARON}"
        "\N{LATIN SMALL LETTER D WITH CARON}"
        "\N{LATIN SMALL LETTER D WITH STROKE}"
        "\N{LATIN SMALL LETTER E WITH OGONEK}"
        "\N{LATIN SMALL LETTER E WITH CARON}"
        "\N{LATIN SMALL LETTER E WITH MACRON}"
        "\N{LATIN SMALL LETTER E WITH DOT ABOVE}"
        "\N{LATIN SMALL LETTER G WITH BREVE}"
        "\N{LATIN SMALL LETTER G WITH CEDILLA}"
        "\N{LATIN SMALL LETTER I WITH OGONEK}"
        "\N{LATIN SMALL LETTER I WITH MACRON}"
        "\N{LATIN SMALL LETTER K WITH CEDILLA}"
        "\N{LATIN SMALL LETTER L WITH ACUTE}"
        "\N{LATIN SMALL LETTER L WITH CARON}"
        "\N{LATIN SMALL LETTER L WITH STROKE}"
        "\N{LATIN SMALL LETTER L WITH CEDILLA}"
        "\N{LATIN SMALL LIGATURE OE}"
        "\N{LATIN SMALL LETTER R WITH ACUTE}"
        "\N{LATIN SMALL LETTER S WITH ACUTE}"
        "\N{LATIN SMALL LETTER S WITH CEDILLA}"
        "\N{LATIN SMALL LETTER S WITH CARON}"
        "\N{LATIN SMALL LETTER T WITH CARON}"
        "\N{LATIN SMALL LETTER U WITH DIAERESIS}"
        "\N{LATIN SMALL LETTER Z WITH ACUTE}"
        "\N{LATIN SMALL LETTER Z WITH DOT ABOVE}"
        "\N{LATIN SMALL LETTER Z WITH CARON}"
        "\N{CYRILLIC SMALL LETTER GHE WITH UPTURN}"
        "\N{LATIN SMALL LIGATURE FI}"
        "\N{LATIN SMALL LETTER FL}"
    ),
    "upper_common": (
        "\N{LATIN CAPITAL LETTER THORN}"
        "\N{GREEK CAPITAL LETTER ALPHA}-\N{GREEK CAPITAL LETTER OMEGA}"
        "\N{GREEK CAPITAL LETTER ALPHA WITH TONOS}"
        "\N{GREEK CAPITAL LETTER EPSILON WITH TONOS}"
        "\N{GREEK CAPITAL LETTER ETA WITH TONOS}"
        "\N{GREEK CAPITAL LETTER IOTA WITH TONOS}"
        "\N{GREEK CAPITAL LETTER OMICRON WITH TONOS}"
        "\N{GREEK CAPITAL LETTER UPSILON WITH TONOS}"
        "\N{GREEK CAPITAL LETTER OMEGA WITH TONOS}"
        "\N{GREEK CAPITAL LETTER IOTA WITH DIALYTIKA}"
        "\N{GREEK CAPITAL LETTER UPSILON WITH DIALYTIKA}"
        "\N{CYRILLIC CAPITAL LETTER IO}-\N{CYRILLIC CAPITAL LETTER YA}"
    ),
    "lower_common": (
        "\N{GREEK SMALL LETTER ALPHA}-\N{GREEK SMALL LETTER OMEGA}"
        "\N{GREEK SMALL LETTER ALPHA WITH TONOS}"
        "\N{GREEK SMALL LETTER EPSILON WITH TONOS}"
        "\N{GREEK SMALL LETTER ETA WITH TONOS}"
        "\N{GREEK SMALL LETTER IOTA WITH TONOS}"
        "\N{GREEK SMALL LETTER UPSILON WITH DIALYTIKA AND TONOS}"
        "\N{CYRILLIC SMALL LETTER A}-\N{CYRILLIC SMALL LETTER DZHE}"
    ),
    "box": (
        "│┌┐┘├┤┬┼"
        "\N{BOX DRAWINGS DOUBLE HORIZONTAL}-\N{BOX DRAWINGS DOUBLE VERTICAL AND HORIZONTAL}"
        "▀▄█▌▐░▒▓"
    ),
}
```

**Complete `BADNESS_RE` Implementation**:

```python
BADNESS_RE = re.compile(
    r"""
    [{c1}]
    |
    [{bad}{lower_accented}{upper_accented}{box}{start_punctuation}{end_punctuation}{currency}{numeric}{law}] [{bad}]
    |
    [a-zA-Z] [{lower_common}{upper_common}] [{bad}]
    |
    [{bad}] [{lower_accented}{upper_accented}{box}{start_punctuation}{end_punctuation}{currency}{numeric}{law}]
    |
    [{lower_accented}{lower_common}{box}{end_punctuation}{currency}{numeric}] [{upper_accented}]
    |
    [{box}{end_punctuation}{currency}{numeric}] [{lower_accented}]
    |
    [{lower_accented}{box}{end_punctuation}] [{currency}]
    |
    \s [{upper_accented}] [{currency}]
    |
    [{upper_accented}{box}] [{numeric}{law}]
    |
    [{lower_accented}{upper_accented}{box}{currency}{end_punctuation}] [{start_punctuation}] [{numeric}]
    |
    [{lower_accented}{upper_accented}{currency}{numeric}{box}{law}] [{end_punctuation}] [{start_punctuation}]
    |
    [{currency}{numeric}{box}] [{start_punctuation}]
    |
    [a-z] [{upper_accented}] [{start_punctuation}{currency}]
    |
    [{box}] [{kaomoji}]
    |
    [{lower_accented}{upper_accented}{currency}{numeric}{start_punctuation}{end_punctuation}{law}] [{box}]
    |
    [{box}] [{end_punctuation}]
    |
    [{lower_accented}{upper_accented}] [{start_punctuation}{end_punctuation}] \w
    |
    # The ligature œ when not followed by an unaccented Latin letter
    [Œœ][^A-Za-z]
    |
    # Degree signs after capital letters
    [{upper_accented}]°
    |
    # Common Windows-1252 2-character mojibake
    [ÂÃÎÐ][€œŠš¢£Ÿž\xa0\xad®©°·»{start_punctuation}{end_punctuation}–—´]
    |
    × [²³]
    |
    # Windows-1252 mojibake of Arabic words
      [ØÙ] [{common}{currency}{bad}{numeric}{start_punctuation}ŸŠ®°µ»]
      [ØÙ] [{common}{currency}{bad}{numeric}{start_punctuation}ŸŠ®°µ»]
    |
    # Windows-1252 mojibake for South Asian alphabets
    à[²µ¹¼½¾]
    |
    # MacRoman mojibake
    √[±∂†≠®™´≤≥¥µø]
    |
    ≈[°¢]
    |
    ‚Ä[ìîïòôúùû†°¢π]
    |
    ‚[âó][àä°ê]
    |
    # Windows-1251 mojibake
    вЂ
    |
    [ВГРС][{c1}{bad}{start_punctuation}{end_punctuation}{currency}°µ][ВГРС]
    |
    ГўВЂВ.[A-Za-z ]
    |
    # Windows-1252 encodings of 'à' and 'á'
    Ã[\xa0¡]
    |
    [a-z]\s?[ÃÂ][ ]
    |
    ^[ÃÂ][ ]
    |
    [a-z.,?!{end_punctuation}] Â [ {start_punctuation}{end_punctuation}]
    |
    # Windows-1253 mojibake
    β€[™\xa0Ά\xad®°]
    |
    [ΒΓΞΟ][{c1}{bad}{start_punctuation}{end_punctuation}{currency}°][ΒΓΞΟ]
    |
    # Windows-1257 mojibake
    ā€
    """.format(**MOJIBAKE_CATEGORIES),
    re.VERBOSE,
)
```

**`sequence_weirdness(text: str) -> int`**
- **Function**: Backwards-compatible wrapper around the legacy heuristic; emits a deprecation warning and forwards to `badness(text)`.
- **Return**: Integer badness score identical to `badness`.

**`badness(text: str) -> int`**
- **Function**: Count the number of unlikely character sequences found by `BADNESS_RE.findall()`.
- **Return**: Integer count of badness matches (0 means clean text).

**`is_bad(text: str) -> bool`**
- **Function**: Test whether text contains mojibake using `BADNESS_RE.search()` (faster than `badness()` for simple yes/no check).
- **Return**: `True` if mojibake detected, `False` otherwise.

**Usage Example**:
```python
from ftfy.badness import badness, is_bad, sequence_weirdness, MOJIBAKE_CATEGORIES

sample = "caf\u00c3\u00a9 costs 5€"
print(badness(sample))  # 2
print(is_bad(sample))   # True
print(sequence_weirdness(sample))  # 2 (with deprecation warning)

# Access character categories
print("c1" in MOJIBAKE_CATEGORIES)  # True
print(len(MOJIBAKE_CATEGORIES["bad"]))  # Number of "bad" characters
```

#### ftfy.chardata

- **`CHARMAP_ENCODINGS`**: Ordered list of single-byte encodings that ftfy attempts when re-encoding mojibake candidates.
- **`SINGLE_QUOTE_RE` / `DOUBLE_QUOTE_RE`**: Regular expressions that locate smart-quote code points for the quote-straightening fixers.
- **`_build_regexes() -> dict[str, re.Pattern[str]]`**: Generates encoding membership regexes for ASCII plus each `CHARMAP_ENCODINGS` entry.
- **`ENCODING_REGEXES`**: Cache returned by `_build_regexes`, keyed by encoding name for `possible_encoding`.
- **`_build_html_entities() -> dict[str, str]`**: Produces the case-sensitive and safe uppercase HTML entity mapping consumed by `unescape_html`.
- **`HTML_ENTITY_RE` / `HTML_ENTITIES`**: Regex that matches `&name;` style entities and the resulting decode table built by `_build_html_entities`.
- **`_build_control_char_mapping() -> dict[int, None]` / `CONTROL_CHARS`**: Build and store the translation table that strips unintended control characters while keeping significant whitespace.
- **`LIGATURES`**: Mapping of Latin ligature code points (for example the FF/FFI/FFL ligatures and the IJ digraph) to their decomposed ASCII sequences for `fix_latin_ligatures`.
- **`_build_width_map() -> dict[int, str]` / `WIDTH_MAP`**: Compute and retain replacements from fullwidth/halfwidth variants (plus IDEOGRAPHIC SPACE) to their NFC-normalized forms.
- **`ALTERED_UTF8_RE`**: Bytes regex that matches UTF-8 sequences where `0xA0` was replaced with ASCII space, guiding `restore_byte_a0`.
- **`LOSSY_UTF8_RE`**: Bytes regex that identifies UTF-8 continuations replaced with byte `0x1A`, allowing `replace_lossy_sequences` to substitute U+FFFD consistently.
- **`C1_CONTROL_RE`**: Regex for the C1 control block, used when reinterpreting control characters as Windows-1252 symbols.
- **`UTF8_CLUES`**: Generated character-class strings enumerating the glyphs that commonly appear in UTF-8 mojibake, used to compose detection regexes.
- **`UTF8_DETECTOR_RE`**: Verbose regex assembled from `UTF8_CLUES` that finds suspicious substrings for `decode_inconsistent_utf8`.

**Complete `UTF8_CLUES` Implementation**:

```python
UTF8_CLUES: dict[str, str] = {
    # Letters that decode to 0xC2 - 0xDF in a Latin-1-like encoding
    "utf8_first_of_2": (
        "\N{LATIN CAPITAL LETTER A WITH BREVE}"  # windows-1250:C3
        "\N{LATIN CAPITAL LETTER A WITH CIRCUMFLEX}"  # latin-1:C2
        "\N{LATIN CAPITAL LETTER A WITH DIAERESIS}"  # latin-1:C4
        "\N{LATIN CAPITAL LETTER A WITH MACRON}"  # windows-1257:C2
        "\N{LATIN CAPITAL LETTER A WITH RING ABOVE}"  # latin-1:C5
        "\N{LATIN CAPITAL LETTER A WITH TILDE}"  # latin-1:C3
        "\N{LATIN CAPITAL LETTER AE}"  # latin-1:C6
        "\N{LATIN CAPITAL LETTER C WITH ACUTE}"  # windows-1250:C6
        "\N{LATIN CAPITAL LETTER C WITH CARON}"  # windows-1250:C8
        "\N{LATIN CAPITAL LETTER C WITH CEDILLA}"  # latin-1:C7
        "\N{LATIN CAPITAL LETTER D WITH CARON}"  # windows-1250:CF
        "\N{LATIN CAPITAL LETTER D WITH STROKE}"  # windows-1250:D0
        "\N{LATIN CAPITAL LETTER E WITH ACUTE}"  # latin-1:C9
        "\N{LATIN CAPITAL LETTER E WITH CARON}"  # windows-1250:CC
        "\N{LATIN CAPITAL LETTER E WITH CIRCUMFLEX}"  # latin-1:CA
        "\N{LATIN CAPITAL LETTER E WITH DIAERESIS}"  # latin-1:CB
        "\N{LATIN CAPITAL LETTER E WITH DOT ABOVE}"  # windows-1257:CB
        "\N{LATIN CAPITAL LETTER E WITH GRAVE}"  # latin-1:C8
        "\N{LATIN CAPITAL LETTER E WITH MACRON}"  # windows-1257:C7
        "\N{LATIN CAPITAL LETTER E WITH OGONEK}"  # windows-1250:CA
        "\N{LATIN CAPITAL LETTER ETH}"  # latin-1:D0
        "\N{LATIN CAPITAL LETTER G WITH BREVE}"  # windows-1254:D0
        "\N{LATIN CAPITAL LETTER G WITH CEDILLA}"  # windows-1257:CC
        "\N{LATIN CAPITAL LETTER I WITH ACUTE}"  # latin-1:CD
        "\N{LATIN CAPITAL LETTER I WITH CIRCUMFLEX}"  # latin-1:CE
        "\N{LATIN CAPITAL LETTER I WITH DIAERESIS}"  # latin-1:CF
        "\N{LATIN CAPITAL LETTER I WITH DOT ABOVE}"  # windows-1254:DD
        "\N{LATIN CAPITAL LETTER I WITH GRAVE}"  # latin-1:CC
        "\N{LATIN CAPITAL LETTER I WITH MACRON}"  # windows-1257:CE
        "\N{LATIN CAPITAL LETTER K WITH CEDILLA}"  # windows-1257:CD
        "\N{LATIN CAPITAL LETTER L WITH ACUTE}"  # windows-1250:C5
        "\N{LATIN CAPITAL LETTER L WITH CEDILLA}"  # windows-1257:CF
        "\N{LATIN CAPITAL LETTER L WITH STROKE}"  # windows-1257:D9
        "\N{LATIN CAPITAL LETTER N WITH ACUTE}"  # windows-1250:D1
        "\N{LATIN CAPITAL LETTER N WITH CARON}"  # windows-1250:D2
        "\N{LATIN CAPITAL LETTER N WITH CEDILLA}"  # windows-1257:D2
        "\N{LATIN CAPITAL LETTER N WITH TILDE}"  # latin-1:D1
        "\N{LATIN CAPITAL LETTER O WITH ACUTE}"  # latin-1:D3
        "\N{LATIN CAPITAL LETTER O WITH CIRCUMFLEX}"  # latin-1:D4
        "\N{LATIN CAPITAL LETTER O WITH DIAERESIS}"  # latin-1:D6
        "\N{LATIN CAPITAL LETTER O WITH DOUBLE ACUTE}"  # windows-1250:D5
        "\N{LATIN CAPITAL LETTER O WITH GRAVE}"  # latin-1:D2
        "\N{LATIN CAPITAL LETTER O WITH MACRON}"  # windows-1257:D4
        "\N{LATIN CAPITAL LETTER O WITH STROKE}"  # latin-1:D8
        "\N{LATIN CAPITAL LETTER O WITH TILDE}"  # latin-1:D5
        "\N{LATIN CAPITAL LETTER R WITH CARON}"  # windows-1250:D8
        "\N{LATIN CAPITAL LETTER S WITH ACUTE}"  # windows-1257:DA
        "\N{LATIN CAPITAL LETTER S WITH CARON}"  # windows-1257:D0
        "\N{LATIN CAPITAL LETTER S WITH CEDILLA}"  # windows-1254:DE
        "\N{LATIN CAPITAL LETTER T WITH CEDILLA}"  # windows-1250:DE
        "\N{LATIN CAPITAL LETTER THORN}"  # latin-1:DE
        "\N{LATIN CAPITAL LETTER U WITH ACUTE}"  # latin-1:DA
        "\N{LATIN CAPITAL LETTER U WITH CIRCUMFLEX}"  # latin-1:DB
        "\N{LATIN CAPITAL LETTER U WITH DIAERESIS}"  # latin-1:DC
        "\N{LATIN CAPITAL LETTER U WITH DOUBLE ACUTE}"  # windows-1250:DB
        "\N{LATIN CAPITAL LETTER U WITH GRAVE}"  # latin-1:D9
        "\N{LATIN CAPITAL LETTER U WITH MACRON}"  # windows-1257:DB
        "\N{LATIN CAPITAL LETTER U WITH OGONEK}"  # windows-1257:D8
        "\N{LATIN CAPITAL LETTER U WITH RING ABOVE}"  # windows-1250:D9
        "\N{LATIN CAPITAL LETTER Y WITH ACUTE}"  # latin-1:DD
        "\N{LATIN CAPITAL LETTER Z WITH ACUTE}"  # windows-1257:CA
        "\N{LATIN CAPITAL LETTER Z WITH CARON}"  # windows-1257:DE
        "\N{LATIN CAPITAL LETTER Z WITH DOT ABOVE}"  # windows-1257:DD
        "\N{LATIN SMALL LETTER SHARP S}"  # latin-1:DF
        "\N{MULTIPLICATION SIGN}"  # latin-1:D7
        "\N{GREEK CAPITAL LETTER BETA}"  # windows-1253:C2
        "\N{GREEK CAPITAL LETTER GAMMA}"  # windows-1253:C3
        "\N{GREEK CAPITAL LETTER DELTA}"  # windows-1253:C4
        "\N{GREEK CAPITAL LETTER EPSILON}"  # windows-1253:C5
        "\N{GREEK CAPITAL LETTER ZETA}"  # windows-1253:C6
        "\N{GREEK CAPITAL LETTER ETA}"  # windows-1253:C7
        "\N{GREEK CAPITAL LETTER THETA}"  # windows-1253:C8
        "\N{GREEK CAPITAL LETTER IOTA}"  # windows-1253:C9
        "\N{GREEK CAPITAL LETTER KAPPA}"  # windows-1253:CA
        "\N{GREEK CAPITAL LETTER LAMDA}"  # windows-1253:CB
        "\N{GREEK CAPITAL LETTER MU}"  # windows-1253:CC
        "\N{GREEK CAPITAL LETTER NU}"  # windows-1253:CD
        "\N{GREEK CAPITAL LETTER XI}"  # windows-1253:CE
        "\N{GREEK CAPITAL LETTER OMICRON}"  # windows-1253:CF
        "\N{GREEK CAPITAL LETTER PI}"  # windows-1253:D0
        "\N{GREEK CAPITAL LETTER RHO}"  # windows-1253:D1
        "\N{GREEK CAPITAL LETTER SIGMA}"  # windows-1253:D3
        "\N{GREEK CAPITAL LETTER TAU}"  # windows-1253:D4
        "\N{GREEK CAPITAL LETTER UPSILON}"  # windows-1253:D5
        "\N{GREEK CAPITAL LETTER PHI}"  # windows-1253:D6
        "\N{GREEK CAPITAL LETTER CHI}"  # windows-1253:D7
        "\N{GREEK CAPITAL LETTER PSI}"  # windows-1253:D8
        "\N{GREEK CAPITAL LETTER OMEGA}"  # windows-1253:D9
        "\N{GREEK CAPITAL LETTER IOTA WITH DIALYTIKA}"  # windows-1253:DA
        "\N{GREEK CAPITAL LETTER UPSILON WITH DIALYTIKA}"  # windows-1253:DB
        "\N{GREEK SMALL LETTER ALPHA WITH TONOS}"  # windows-1253:DC
        "\N{GREEK SMALL LETTER EPSILON WITH TONOS}"  # windows-1253:DD
        "\N{GREEK SMALL LETTER ETA WITH TONOS}"  # windows-1253:DE
        "\N{GREEK SMALL LETTER IOTA WITH TONOS}"  # windows-1253:DF
        "\N{CYRILLIC CAPITAL LETTER VE}"  # windows-1251:C2
        "\N{CYRILLIC CAPITAL LETTER GHE}"  # windows-1251:C3
        "\N{CYRILLIC CAPITAL LETTER DE}"  # windows-1251:C4
        "\N{CYRILLIC CAPITAL LETTER IE}"  # windows-1251:C5
        "\N{CYRILLIC CAPITAL LETTER ZHE}"  # windows-1251:C6
        "\N{CYRILLIC CAPITAL LETTER ZE}"  # windows-1251:C7
        "\N{CYRILLIC CAPITAL LETTER I}"  # windows-1251:C8
        "\N{CYRILLIC CAPITAL LETTER SHORT I}"  # windows-1251:C9
        "\N{CYRILLIC CAPITAL LETTER KA}"  # windows-1251:CA
        "\N{CYRILLIC CAPITAL LETTER EL}"  # windows-1251:CB
        "\N{CYRILLIC CAPITAL LETTER EM}"  # windows-1251:CC
        "\N{CYRILLIC CAPITAL LETTER EN}"  # windows-1251:CD
        "\N{CYRILLIC CAPITAL LETTER O}"  # windows-1251:CE
        "\N{CYRILLIC CAPITAL LETTER PE}"  # windows-1251:CF
        "\N{CYRILLIC CAPITAL LETTER ER}"  # windows-1251:D0
        "\N{CYRILLIC CAPITAL LETTER ES}"  # windows-1251:D1
        "\N{CYRILLIC CAPITAL LETTER TE}"  # windows-1251:D2
        "\N{CYRILLIC CAPITAL LETTER U}"  # windows-1251:D3
        "\N{CYRILLIC CAPITAL LETTER EF}"  # windows-1251:D4
        "\N{CYRILLIC CAPITAL LETTER HA}"  # windows-1251:D5
        "\N{CYRILLIC CAPITAL LETTER TSE}"  # windows-1251:D6
        "\N{CYRILLIC CAPITAL LETTER CHE}"  # windows-1251:D7
        "\N{CYRILLIC CAPITAL LETTER SHA}"  # windows-1251:D8
        "\N{CYRILLIC CAPITAL LETTER SHCHA}"  # windows-1251:D9
        "\N{CYRILLIC CAPITAL LETTER HARD SIGN}"  # windows-1251:DA
        "\N{CYRILLIC CAPITAL LETTER YERU}"  # windows-1251:DB
        "\N{CYRILLIC CAPITAL LETTER SOFT SIGN}"  # windows-1251:DC
        "\N{CYRILLIC CAPITAL LETTER E}"  # windows-1251:DD
        "\N{CYRILLIC CAPITAL LETTER YU}"  # windows-1251:DE
        "\N{CYRILLIC CAPITAL LETTER YA}"  # windows-1251:DF
    ),
    # Letters that decode to 0xE0 - 0xEF in a Latin-1-like encoding
    "utf8_first_of_3": (
        "\N{LATIN SMALL LETTER A WITH ACUTE}"  # latin-1:E1
        "\N{LATIN SMALL LETTER A WITH BREVE}"  # windows-1250:E3
        "\N{LATIN SMALL LETTER A WITH CIRCUMFLEX}"  # latin-1:E2
        "\N{LATIN SMALL LETTER A WITH DIAERESIS}"  # latin-1:E4
        "\N{LATIN SMALL LETTER A WITH GRAVE}"  # latin-1:E0
        "\N{LATIN SMALL LETTER A WITH MACRON}"  # windows-1257:E2
        "\N{LATIN SMALL LETTER A WITH OGONEK}"  # windows-1257:E0
        "\N{LATIN SMALL LETTER A WITH RING ABOVE}"  # latin-1:E5
        "\N{LATIN SMALL LETTER A WITH TILDE}"  # latin-1:E3
        "\N{LATIN SMALL LETTER AE}"  # latin-1:E6
        "\N{LATIN SMALL LETTER C WITH ACUTE}"  # windows-1250:E6
        "\N{LATIN SMALL LETTER C WITH CARON}"  # windows-1250:E8
        "\N{LATIN SMALL LETTER C WITH CEDILLA}"  # latin-1:E7
        "\N{LATIN SMALL LETTER D WITH CARON}"  # windows-1250:EF
        "\N{LATIN SMALL LETTER E WITH ACUTE}"  # latin-1:E9
        "\N{LATIN SMALL LETTER E WITH CARON}"  # windows-1250:EC
        "\N{LATIN SMALL LETTER E WITH CIRCUMFLEX}"  # latin-1:EA
        "\N{LATIN SMALL LETTER E WITH DIAERESIS}"  # latin-1:EB
        "\N{LATIN SMALL LETTER E WITH DOT ABOVE}"  # windows-1257:EB
        "\N{LATIN SMALL LETTER E WITH GRAVE}"  # latin-1:E8
        "\N{LATIN SMALL LETTER E WITH MACRON}"  # windows-1257:E7
        "\N{LATIN SMALL LETTER E WITH OGONEK}"  # windows-1250:EA
        "\N{LATIN SMALL LETTER E WITH OGONEK}"  # windows-1250:EA
        "\N{LATIN SMALL LETTER G WITH CEDILLA}"  # windows-1257:EC
        "\N{LATIN SMALL LETTER I WITH ACUTE}"  # latin-1:ED
        "\N{LATIN SMALL LETTER I WITH CIRCUMFLEX}"  # latin-1:EE
        "\N{LATIN SMALL LETTER I WITH DIAERESIS}"  # latin-1:EF
        "\N{LATIN SMALL LETTER I WITH GRAVE}"  # latin-1:EC
        "\N{LATIN SMALL LETTER I WITH MACRON}"  # windows-1257:EE
        "\N{LATIN SMALL LETTER I WITH OGONEK}"  # windows-1257:E1
        "\N{LATIN SMALL LETTER K WITH CEDILLA}"  # windows-1257:ED
        "\N{LATIN SMALL LETTER L WITH ACUTE}"  # windows-1250:E5
        "\N{LATIN SMALL LETTER L WITH CEDILLA}"  # windows-1257:EF
        "\N{LATIN SMALL LETTER R WITH ACUTE}"  # windows-1250:E0
        "\N{LATIN SMALL LETTER Z WITH ACUTE}"  # windows-1257:EA
        "\N{GREEK SMALL LETTER UPSILON WITH DIALYTIKA AND TONOS}"  # windows-1253:E0
        "\N{GREEK SMALL LETTER ALPHA}"  # windows-1253:E1
        "\N{GREEK SMALL LETTER BETA}"  # windows-1253:E2
        "\N{GREEK SMALL LETTER GAMMA}"  # windows-1253:E3
        "\N{GREEK SMALL LETTER DELTA}"  # windows-1253:E4
        "\N{GREEK SMALL LETTER EPSILON}"  # windows-1253:E5
        "\N{GREEK SMALL LETTER ZETA}"  # windows-1253:E6
        "\N{GREEK SMALL LETTER ETA}"  # windows-1253:E7
        "\N{GREEK SMALL LETTER THETA}"  # windows-1253:E8
        "\N{GREEK SMALL LETTER IOTA}"  # windows-1253:E9
        "\N{GREEK SMALL LETTER KAPPA}"  # windows-1253:EA
        "\N{GREEK SMALL LETTER LAMDA}"  # windows-1253:EB
        "\N{GREEK SMALL LETTER MU}"  # windows-1253:EC
        "\N{GREEK SMALL LETTER NU}"  # windows-1253:ED
        "\N{GREEK SMALL LETTER XI}"  # windows-1253:EE
        "\N{GREEK SMALL LETTER OMICRON}"  # windows-1253:EF
        "\N{CYRILLIC SMALL LETTER A}"  # windows-1251:E0
        "\N{CYRILLIC SMALL LETTER BE}"  # windows-1251:E1
        "\N{CYRILLIC SMALL LETTER VE}"  # windows-1251:E2
        "\N{CYRILLIC SMALL LETTER GHE}"  # windows-1251:E3
        "\N{CYRILLIC SMALL LETTER DE}"  # windows-1251:E4
        "\N{CYRILLIC SMALL LETTER IE}"  # windows-1251:E5
        "\N{CYRILLIC SMALL LETTER ZHE}"  # windows-1251:E6
        "\N{CYRILLIC SMALL LETTER ZE}"  # windows-1251:E7
        "\N{CYRILLIC SMALL LETTER I}"  # windows-1251:E8
        "\N{CYRILLIC SMALL LETTER SHORT I}"  # windows-1251:E9
        "\N{CYRILLIC SMALL LETTER KA}"  # windows-1251:EA
        "\N{CYRILLIC SMALL LETTER EL}"  # windows-1251:EB
        "\N{CYRILLIC SMALL LETTER EM}"  # windows-1251:EC
        "\N{CYRILLIC SMALL LETTER EN}"  # windows-1251:ED
        "\N{CYRILLIC SMALL LETTER O}"  # windows-1251:EE
        "\N{CYRILLIC SMALL LETTER PE}"  # windows-1251:EF
    ),
    # Letters that decode to 0xF0 or 0xF3 in a Latin-1-like encoding.
    # (Other leading bytes correspond only to unassigned codepoints)
    "utf8_first_of_4": (
        "\N{LATIN SMALL LETTER D WITH STROKE}"  # windows-1250:F0
        "\N{LATIN SMALL LETTER ETH}"  # latin-1:F0
        "\N{LATIN SMALL LETTER G WITH BREVE}"  # windows-1254:F0
        "\N{LATIN SMALL LETTER O WITH ACUTE}"  # latin-1:F3
        "\N{LATIN SMALL LETTER S WITH CARON}"  # windows-1257:F0
        "\N{GREEK SMALL LETTER PI}"  # windows-1253:F0
        "\N{GREEK SMALL LETTER SIGMA}"  # windows-1253:F3
        "\N{CYRILLIC SMALL LETTER ER}"  # windows-1251:F0
        "\N{CYRILLIC SMALL LETTER U}"  # windows-1251:F3
    ),
    # Letters that decode to 0x80 - 0xBF in a Latin-1-like encoding,
    # including a space standing in for 0xA0
    "utf8_continuation": (
        "\x80-\xbf"
        "\N{SPACE}"  # modification of latin-1:A0, NO-BREAK SPACE
        "\N{LATIN CAPITAL LETTER A WITH OGONEK}"  # windows-1250:A5
        "\N{LATIN CAPITAL LETTER AE}"  # windows-1257:AF
        "\N{LATIN CAPITAL LETTER L WITH CARON}"  # windows-1250:BC
        "\N{LATIN CAPITAL LETTER L WITH STROKE}"  # windows-1250:A3
        "\N{LATIN CAPITAL LETTER O WITH STROKE}"  # windows-1257:A8
        "\N{LATIN CAPITAL LETTER R WITH CEDILLA}"  # windows-1257:AA
        "\N{LATIN CAPITAL LETTER S WITH ACUTE}"  # windows-1250:8C
        "\N{LATIN CAPITAL LETTER S WITH CARON}"  # windows-1252:8A
        "\N{LATIN CAPITAL LETTER S WITH CEDILLA}"  # windows-1250:AA
        "\N{LATIN CAPITAL LETTER T WITH CARON}"  # windows-1250:8D
        "\N{LATIN CAPITAL LETTER Y WITH DIAERESIS}"  # windows-1252:9F
        "\N{LATIN CAPITAL LETTER Z WITH ACUTE}"  # windows-1250:8F
        "\N{LATIN CAPITAL LETTER Z WITH CARON}"  # windows-1252:8E
        "\N{LATIN CAPITAL LETTER Z WITH DOT ABOVE}"  # windows-1250:AF
        "\N{LATIN CAPITAL LIGATURE OE}"  # windows-1252:8C
        "\N{LATIN SMALL LETTER A WITH OGONEK}"  # windows-1250:B9
        "\N{LATIN SMALL LETTER AE}"  # windows-1257:BF
        "\N{LATIN SMALL LETTER F WITH HOOK}"  # windows-1252:83
        "\N{LATIN SMALL LETTER L WITH CARON}"  # windows-1250:BE
        "\N{LATIN SMALL LETTER L WITH STROKE}"  # windows-1250:B3
        "\N{LATIN SMALL LETTER O WITH STROKE}"  # windows-1257:B8
        "\N{LATIN SMALL LETTER R WITH CEDILLA}"  # windows-1257:BA
        "\N{LATIN SMALL LETTER S WITH ACUTE}"  # windows-1250:9C
        "\N{LATIN SMALL LETTER S WITH CARON}"  # windows-1252:9A
        "\N{LATIN SMALL LETTER S WITH CEDILLA}"  # windows-1250:BA
        "\N{LATIN SMALL LETTER T WITH CARON}"  # windows-1250:9D
        "\N{LATIN SMALL LETTER Z WITH ACUTE}"  # windows-1250:9F
        "\N{LATIN SMALL LETTER Z WITH CARON}"  # windows-1252:9E
        "\N{LATIN SMALL LETTER Z WITH DOT ABOVE}"  # windows-1250:BF
        "\N{LATIN SMALL LIGATURE OE}"  # windows-1252:9C
        "\N{MODIFIER LETTER CIRCUMFLEX ACCENT}"  # windows-1252:88
        "\N{CARON}"  # windows-1250:A1
        "\N{BREVE}"  # windows-1250:A2
        "\N{OGONEK}"  # windows-1250:B2
        "\N{SMALL TILDE}"  # windows-1252:98
        "\N{DOUBLE ACUTE ACCENT}"  # windows-1250:BD
        "\N{GREEK TONOS}"  # windows-1253:B4
        "\N{GREEK DIALYTIKA TONOS}"  # windows-1253:A1
        "\N{GREEK CAPITAL LETTER ALPHA WITH TONOS}"  # windows-1253:A2
        "\N{GREEK CAPITAL LETTER EPSILON WITH TONOS}"  # windows-1253:B8
        "\N{GREEK CAPITAL LETTER ETA WITH TONOS}"  # windows-1253:B9
        "\N{GREEK CAPITAL LETTER IOTA WITH TONOS}"  # windows-1253:BA
        "\N{GREEK CAPITAL LETTER OMICRON WITH TONOS}"  # windows-1253:BC
        "\N{GREEK CAPITAL LETTER UPSILON WITH TONOS}"  # windows-1253:BE
        "\N{GREEK CAPITAL LETTER OMEGA WITH TONOS}"  # windows-1253:BF
        "\N{CYRILLIC CAPITAL LETTER IO}"  # windows-1251:A8
        "\N{CYRILLIC CAPITAL LETTER DJE}"  # windows-1251:80
        "\N{CYRILLIC CAPITAL LETTER GJE}"  # windows-1251:81
        "\N{CYRILLIC CAPITAL LETTER UKRAINIAN IE}"  # windows-1251:AA
        "\N{CYRILLIC CAPITAL LETTER DZE}"  # windows-1251:BD
        "\N{CYRILLIC CAPITAL LETTER BYELORUSSIAN-UKRAINIAN I}"  # windows-1251:B2
        "\N{CYRILLIC CAPITAL LETTER YI}"  # windows-1251:AF
        "\N{CYRILLIC CAPITAL LETTER JE}"  # windows-1251:A3
        "\N{CYRILLIC CAPITAL LETTER LJE}"  # windows-1251:8A
        "\N{CYRILLIC CAPITAL LETTER NJE}"  # windows-1251:8C
        "\N{CYRILLIC CAPITAL LETTER TSHE}"  # windows-1251:8E
        "\N{CYRILLIC CAPITAL LETTER KJE}"  # windows-1251:8D
        "\N{CYRILLIC CAPITAL LETTER SHORT U}"  # windows-1251:A1
        "\N{CYRILLIC CAPITAL LETTER DZHE}"  # windows-1251:8F
        "\N{CYRILLIC SMALL LETTER IO}"  # windows-1251:B8
        "\N{CYRILLIC SMALL LETTER DJE}"  # windows-1251:90
        "\N{CYRILLIC SMALL LETTER GJE}"  # windows-1251:83
        "\N{CYRILLIC SMALL LETTER UKRAINIAN IE}"  # windows-1251:BA
        "\N{CYRILLIC SMALL LETTER DZE}"  # windows-1251:BE
        "\N{CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I}"  # windows-1251:B3
        "\N{CYRILLIC SMALL LETTER YI}"  # windows-1251:BF
        "\N{CYRILLIC SMALL LETTER JE}"  # windows-1251:BC
        "\N{CYRILLIC SMALL LETTER LJE}"  # windows-1251:9A
        "\N{CYRILLIC SMALL LETTER NJE}"  # windows-1251:9C
        "\N{CYRILLIC SMALL LETTER TSHE}"  # windows-1251:9E
        "\N{CYRILLIC SMALL LETTER KJE}"  # windows-1251:9D
        "\N{CYRILLIC SMALL LETTER SHORT U}"  # windows-1251:A2
        "\N{CYRILLIC SMALL LETTER DZHE}"  # windows-1251:9F
        "\N{CYRILLIC CAPITAL LETTER GHE WITH UPTURN}"  # windows-1251:A5
        "\N{CYRILLIC SMALL LETTER GHE WITH UPTURN}"  # windows-1251:B4
        "\N{EN DASH}"  # windows-1252:96
        "\N{EM DASH}"  # windows-1252:97
        "\N{HORIZONTAL BAR}"  # windows-1253:AF
        "\N{LEFT SINGLE QUOTATION MARK}"  # windows-1252:91
        "\N{RIGHT SINGLE QUOTATION MARK}"  # windows-1252:92
        "\N{SINGLE LOW-9 QUOTATION MARK}"  # windows-1252:82
        "\N{LEFT DOUBLE QUOTATION MARK}"  # windows-1252:93
        "\N{RIGHT DOUBLE QUOTATION MARK}"  # windows-1252:94
        "\N{DOUBLE LOW-9 QUOTATION MARK}"  # windows-1252:84
        "\N{DAGGER}"  # windows-1252:86
        "\N{DOUBLE DAGGER}"  # windows-1252:87
        "\N{BULLET}"  # windows-1252:95
        "\N{HORIZONTAL ELLIPSIS}"  # windows-1252:85
        "\N{PER MILLE SIGN}"  # windows-1252:89
        "\N{SINGLE LEFT-POINTING ANGLE QUOTATION MARK}"  # windows-1252:8B
        "\N{SINGLE RIGHT-POINTING ANGLE QUOTATION MARK}"  # windows-1252:9B
        "\N{EURO SIGN}"  # windows-1252:80
        "\N{NUMERO SIGN}"  # windows-1251:B9
        "\N{TRADE MARK SIGN}"  # windows-1252:99
    ),
    # Letters that decode to 0x80 - 0xBF in a Latin-1-like encoding,
    # and don't usually stand for themselves when adjacent to mojibake.
    # This excludes spaces, dashes, 'bullet', quotation marks, and ellipses.
    "utf8_continuation_strict": (
        "\x80-\xbf"
        "\N{LATIN CAPITAL LETTER A WITH OGONEK}"  # windows-1250:A5
        "\N{LATIN CAPITAL LETTER AE}"  # windows-1257:AF
        "\N{LATIN CAPITAL LETTER L WITH CARON}"  # windows-1250:BC
        "\N{LATIN CAPITAL LETTER L WITH STROKE}"  # windows-1250:A3
        "\N{LATIN CAPITAL LETTER O WITH STROKE}"  # windows-1257:A8
        "\N{LATIN CAPITAL LETTER R WITH CEDILLA}"  # windows-1257:AA
        "\N{LATIN CAPITAL LETTER S WITH ACUTE}"  # windows-1250:8C
        "\N{LATIN CAPITAL LETTER S WITH CARON}"  # windows-1252:8A
        "\N{LATIN CAPITAL LETTER S WITH CEDILLA}"  # windows-1250:AA
        "\N{LATIN CAPITAL LETTER T WITH CARON}"  # windows-1250:8D
        "\N{LATIN CAPITAL LETTER Y WITH DIAERESIS}"  # windows-1252:9F
        "\N{LATIN CAPITAL LETTER Z WITH ACUTE}"  # windows-1250:8F
        "\N{LATIN CAPITAL LETTER Z WITH CARON}"  # windows-1252:8E
        "\N{LATIN CAPITAL LETTER Z WITH DOT ABOVE}"  # windows-1250:AF
        "\N{LATIN CAPITAL LIGATURE OE}"  # windows-1252:8C
        "\N{LATIN SMALL LETTER A WITH OGONEK}"  # windows-1250:B9
        "\N{LATIN SMALL LETTER AE}"  # windows-1257:BF
        "\N{LATIN SMALL LETTER F WITH HOOK}"  # windows-1252:83
        "\N{LATIN SMALL LETTER L WITH CARON}"  # windows-1250:BE
        "\N{LATIN SMALL LETTER L WITH STROKE}"  # windows-1250:B3
        "\N{LATIN SMALL LETTER O WITH STROKE}"  # windows-1257:B8
        "\N{LATIN SMALL LETTER R WITH CEDILLA}"  # windows-1257:BA
        "\N{LATIN SMALL LETTER S WITH ACUTE}"  # windows-1250:9C
        "\N{LATIN SMALL LETTER S WITH CARON}"  # windows-1252:9A
        "\N{LATIN SMALL LETTER S WITH CEDILLA}"  # windows-1250:BA
        "\N{LATIN SMALL LETTER T WITH CARON}"  # windows-1250:9D
        "\N{LATIN SMALL LETTER Z WITH ACUTE}"  # windows-1250:9F
        "\N{LATIN SMALL LETTER Z WITH CARON}"  # windows-1252:9E
        "\N{LATIN SMALL LETTER Z WITH DOT ABOVE}"  # windows-1250:BF
        "\N{LATIN SMALL LIGATURE OE}"  # windows-1252:9C
        "\N{MODIFIER LETTER CIRCUMFLEX ACCENT}"  # windows-1252:88
        "\N{CARON}"  # windows-1250:A1
        "\N{BREVE}"  # windows-1250:A2
        "\N{OGONEK}"  # windows-1250:B2
        "\N{SMALL TILDE}"  # windows-1252:98
        "\N{DOUBLE ACUTE ACCENT}"  # windows-1250:BD
        "\N{GREEK TONOS}"  # windows-1253:B4
        "\N{GREEK DIALYTIKA TONOS}"  # windows-1253:A1
        "\N{GREEK CAPITAL LETTER ALPHA WITH TONOS}"  # windows-1253:A2
        "\N{GREEK CAPITAL LETTER EPSILON WITH TONOS}"  # windows-1253:B8
        "\N{GREEK CAPITAL LETTER ETA WITH TONOS}"  # windows-1253:B9
        "\N{GREEK CAPITAL LETTER IOTA WITH TONOS}"  # windows-1253:BA
        "\N{GREEK CAPITAL LETTER OMICRON WITH TONOS}"  # windows-1253:BC
        "\N{GREEK CAPITAL LETTER UPSILON WITH TONOS}"  # windows-1253:BE
        "\N{GREEK CAPITAL LETTER OMEGA WITH TONOS}"  # windows-1253:BF
        "\N{CYRILLIC CAPITAL LETTER IO}"  # windows-1251:A8
        "\N{CYRILLIC CAPITAL LETTER DJE}"  # windows-1251:80
        "\N{CYRILLIC CAPITAL LETTER GJE}"  # windows-1251:81
        "\N{CYRILLIC CAPITAL LETTER UKRAINIAN IE}"  # windows-1251:AA
        "\N{CYRILLIC CAPITAL LETTER DZE}"  # windows-1251:BD
        "\N{CYRILLIC CAPITAL LETTER BYELORUSSIAN-UKRAINIAN I}"  # windows-1251:B2
        "\N{CYRILLIC CAPITAL LETTER YI}"  # windows-1251:AF
        "\N{CYRILLIC CAPITAL LETTER JE}"  # windows-1251:A3
        "\N{CYRILLIC CAPITAL LETTER LJE}"  # windows-1251:8A
        "\N{CYRILLIC CAPITAL LETTER NJE}"  # windows-1251:8C
        "\N{CYRILLIC CAPITAL LETTER TSHE}"  # windows-1251:8E
        "\N{CYRILLIC CAPITAL LETTER KJE}"  # windows-1251:8D
        "\N{CYRILLIC CAPITAL LETTER SHORT U}"  # windows-1251:A1
        "\N{CYRILLIC CAPITAL LETTER DZHE}"  # windows-1251:8F
        "\N{CYRILLIC SMALL LETTER IO}"  # windows-1251:B8
        "\N{CYRILLIC SMALL LETTER DJE}"  # windows-1251:90
        "\N{CYRILLIC SMALL LETTER GJE}"  # windows-1251:83
        "\N{CYRILLIC SMALL LETTER UKRAINIAN IE}"  # windows-1251:BA
        "\N{CYRILLIC SMALL LETTER DZE}"  # windows-1251:BE
        "\N{CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I}"  # windows-1251:B3
        "\N{CYRILLIC SMALL LETTER YI}"  # windows-1251:BF
        "\N{CYRILLIC SMALL LETTER JE}"  # windows-1251:BC
        "\N{CYRILLIC SMALL LETTER LJE}"  # windows-1251:9A
        "\N{CYRILLIC SMALL LETTER NJE}"  # windows-1251:9C
        "\N{CYRILLIC SMALL LETTER TSHE}"  # windows-1251:9E
        "\N{CYRILLIC SMALL LETTER KJE}"  # windows-1251:9D
        "\N{CYRILLIC SMALL LETTER SHORT U}"  # windows-1251:A2
        "\N{CYRILLIC SMALL LETTER DZHE}"  # windows-1251:9F
        "\N{CYRILLIC CAPITAL LETTER GHE WITH UPTURN}"  # windows-1251:A5
        "\N{CYRILLIC SMALL LETTER GHE WITH UPTURN}"  # windows-1251:B4
        "\N{DAGGER}"  # windows-1252:86
        "\N{DOUBLE DAGGER}"  # windows-1252:87
        "\N{PER MILLE SIGN}"  # windows-1252:89
        "\N{SINGLE LEFT-POINTING ANGLE QUOTATION MARK}"  # windows-1252:8B
        "\N{SINGLE RIGHT-POINTING ANGLE QUOTATION MARK}"  # windows-1252:9B
        "\N{EURO SIGN}"  # windows-1252:80
        "\N{NUMERO SIGN}"  # windows-1251:B9
        "\N{TRADE MARK SIGN}"  # windows-1252:99
    ),
}
```

**Complete `UTF8_DETECTOR_RE` Implementation**:

```python
# This regex uses UTF8_CLUES to find sequences of likely mojibake.
# It matches them with + so that several adjacent UTF-8-looking sequences
# get coalesced into one, allowing them to be fixed more efficiently
# and not requiring every individual subsequence to be detected as 'badness'.
#
# We accept spaces in place of "utf8_continuation", because spaces might have
# been intended to be U+A0 NO-BREAK SPACE.
#
# We do a lookbehind to make sure the previous character isn't a
# "utf8_continuation_strict" character, so that we don't fix just a few
# characters in a huge garble and make the situation worse.
UTF8_DETECTOR_RE = re.compile(
    """
    (?<! [{utf8_continuation_strict}])
    (
        [{utf8_first_of_2}] [{utf8_continuation}]
        |
        [{utf8_first_of_3}] [{utf8_continuation}]{{2}}
        |
        [{utf8_first_of_4}] [{utf8_continuation}]{{3}}
    )+
    """.format(**UTF8_CLUES),
    re.VERBOSE,
)
```

**Complete `ALTERED_UTF8_RE` Implementation**:

```python
# Recognize UTF-8 sequences that would be valid if it weren't for a b'\xa0'
# that some Windows-1252 program converted to a plain space.
#
# The smaller values are included on a case-by-case basis, because we don't want
# to decode likely input sequences to unlikely characters. These are the ones
# that *do* form likely characters before 0xa0:
#
#   0xc2 -> U+A0 NO-BREAK SPACE
#   0xc3 -> U+E0 LATIN SMALL LETTER A WITH GRAVE
#   0xc5 -> U+160 LATIN CAPITAL LETTER S WITH CARON
#   0xce -> U+3A0 GREEK CAPITAL LETTER PI
#   0xd0 -> U+420 CYRILLIC CAPITAL LETTER ER
#   0xd9 -> U+660 ARABIC-INDIC DIGIT ZERO
#
# In three-character sequences, we exclude some lead bytes in some cases.
#
# When the lead byte is immediately followed by 0xA0, we shouldn't accept
# a space there, because it leads to some less-likely character ranges:
#
#   0xe0 -> Samaritan script
#   0xe1 -> Mongolian script (corresponds to Latin-1 'á' which is too common)
#
# We accept 0xe2 and 0xe3, which cover many scripts. Bytes 0xe4 and
# higher point mostly to CJK characters, which we generally don't want to
# decode near Latin lowercase letters.
#
# In four-character sequences, the lead byte must be F0, because that accounts
# for almost all of the usage of high-numbered codepoints (tag characters whose
# UTF-8 starts with the byte F3 are only used in some rare new emoji sequences).
#
# This is meant to be applied to encodings of text that tests true for `is_bad`.
# Any of these could represent characters that legitimately appear surrounded by
# spaces, particularly U+C5 (Å), which is a word in multiple languages!

ALTERED_UTF8_RE = re.compile(
    b"[\xc2\xc3\xc5\xce\xd0\xd9][ ]"
    b"|[\xe2\xe3][ ][\x80-\x84\x86-\x9f\xa1-\xbf]"
    b"|[\xe0-\xe3][\x80-\x84\x86-\x9f\xa1-\xbf][ ]"
    b"|[\xf0][ ][\x80-\xbf][\x80-\xbf]"
    b"|[\xf0][\x80-\xbf][ ][\x80-\xbf]"
    b"|[\xf0][\x80-\xbf][\x80-\xbf][ ]"
)
```

**Complete `LOSSY_UTF8_RE` Implementation**:

```python
# This expression matches UTF-8 and CESU-8 sequences where some of the
# continuation bytes have been lost. The byte 0x1a (sometimes written as ^Z) is
# used within ftfy to represent a byte that produced the replacement character
# \ufffd. We don't know which byte it was, but we can at least decode the UTF-8
# sequence as \ufffd instead of failing to re-decode it at all.
#
# In some cases, we allow the ASCII '?' in place of \ufffd, but at most once per
# sequence.

LOSSY_UTF8_RE = re.compile(
    b"[\xc2-\xdf][\x1a]"
    b"|[\xc2-\xc3][?]"
    b"|\xed[\xa0-\xaf][\x1a?]\xed[\xb0-\xbf][\x1a?\x80-\xbf]"
    b"|\xed[\xa0-\xaf][\x1a?\x80-\xbf]\xed[\xb0-\xbf][\x1a?]"
    b"|[\xe0-\xef][\x1a?][\x1a\x80-\xbf]"
    b"|[\xe0-\xef][\x1a\x80-\xbf][\x1a?]"
    b"|[\xf0-\xf4][\x1a?][\x1a\x80-\xbf][\x1a\x80-\xbf]"
    b"|[\xf0-\xf4][\x1a\x80-\xbf][\x1a?][\x1a\x80-\xbf]"
    b"|[\xf0-\xf4][\x1a\x80-\xbf][\x1a\x80-\xbf][\x1a?]"
    b"|\x1a"
)
```

**Usage Example**:
```python
from ftfy.chardata import possible_encoding, LIGATURES, WIDTH_MAP, HTML_ENTITY_RE, HTML_ENTITIES

print(possible_encoding("Café", "latin-1"))   # True
print(possible_encoding("𐀀", "latin-1"))     # False
print(LIGATURES[ord("ﬀ")])                     # "ff"
print(WIDTH_MAP[0xFF21])                        # "A"
entity = "&EACUTE;"
print(HTML_ENTITY_RE.sub(lambda m: HTML_ENTITIES.get(m.group(0), m.group(0)), entity))  # "É"
```

#### ftfy.fixes

**`_unescape_fixup(match: Match[str]) -> str`**
- **Function**: Replace a matched entity token with the decoded character, supporting the curated uppercase aliases while leaving ambiguous cases unchanged.

**`convert_surrogate_pair(match: Match[str]) -> str`**
- **Function**: Turn a UTF-16 surrogate pair into the single Unicode scalar value it encodes.

**`remove_bom(text: str) -> str`**
- **Function**: Strip a stray leading U+FEFF byte-order mark that survived decoding.
- **Return**: Text with any initial BOM removed.

**`decode_escapes(text: str) -> str`**
- **Function**: Decode Python-style escape sequences (`\n`, `\uXXXX`, `\N{NAME}`, octal, etc.) wherever they appear in a Unicode string.
- **Return**: String with escape sequences converted to their literal characters.
- **Helper**: `decode_match(match: Match[str]) -> str` invokes `codecs.decode(..., "unicode-escape")` for each piece matched by `ESCAPE_SEQUENCE_RE`.

- **`replacement(match: Match[bytes]) -> bytes`**: Inner helper inside `restore_byte_a0` that swaps ASCII spaces back to `0xA0` within otherwise valid UTF-8 byte runs.
- **`fix_embedded_mojibake(match: Match[str]) -> str`**: Closure used by `decode_inconsistent_utf8` to recursively call `ftfy.fix_encoding` on shorter suspicious substrings.
- **`_c1_fixer(match: Match[str]) -> str`**: Reinterpret C1 control characters by round-tripping through Latin-1 and sloppy Windows-1252, matching browser behavior.
- **`ANSI_RE`**: Regex that matches ANSI escape sequences (ESC + `[0-9;]*` + command letter) so `remove_terminal_escapes` can drop them.
- **`SURROGATE_RE` / `SURROGATE_PAIR_RE`**: Regexes that find any surrogate code point and legal surrogate pairs, enabling `fix_surrogates` to repair or replace them.
- **`ESCAPE_SEQUENCE_RE`**: Verbose regex listing every allowed Python escape token; drives the substitution loop in `decode_escapes`.
- **`A_GRAVE_WORD_RE`**: Bytes regex spotting the `Ã ` mojibake pattern (with Portuguese exceptions) so `restore_byte_a0` can treat it specially.

**Usage Example**:
```python
from ftfy.fixes import decode_escapes, remove_bom, ANSI_RE, _unescape_fixup
from ftfy.chardata import HTML_ENTITY_RE

print(decode_escapes("cost\\u20ac"))  # "cost€"
print(remove_bom("\ufeffHeadline"))    # "Headline"
print(HTML_ENTITY_RE.sub(_unescape_fixup, "&Aacute;"))  # "Á"
print(ANSI_RE.sub("", "\x1b[34mblue\x1b[m"))        # "blue"
```

#### ftfy.formatting

**`monospaced_width(text: str) -> int`**
- **Function**: Normalize text to NFC, strip terminal escapes, and compute the visible column width with `wcwidth`; returns `-1` if any control character remains.

**`display_rjust(text: str, width: int, fillchar: str = " ") -> str`**
- **Function**: Right-justify text to the requested monospaced display width, padding with a width-1 `fillchar` when possible.

**`display_center(text: str, width: int, fillchar: str = " ") -> str`**
- **Function**: Center text based on monospaced width, splitting padding across both sides while preserving control-containing strings as-is.

**Usage Example**:
```python
from ftfy.formatting import monospaced_width, display_rjust, display_center

print(monospaced_width("ちゃぶ台返し"))        # 12
print(display_rjust("Table flip", 12, "·"))    # "··Table flip"
print(display_center("(╯°□°)╯︵ ┻━┻", 16))  # "··(╯°□°)╯︵ ┻━┻··"
```

#### ftfy.__init__

- **`FIXERS`**: Dictionary mapping fixer names (`"unescape_html"`, `"restore_byte_a0"`, `"decode_inconsistent_utf8"`, etc.) to the callable objects that implement them for `apply_plan`.
- **`BYTES_ERROR_TEXT`**: Multi-line guidance shown when byte strings are supplied to APIs expecting Unicode text.

**`_config_from_kwargs(config: TextFixerConfig, kwargs: dict[str, Any]) -> TextFixerConfig`**
- **Function**: Merge keyword options (renaming deprecated `fix_entities` to `unescape_html`) into a configuration instance via `_replace`.

**`_try_fix(fixer_name: str, text: str, config: TextFixerConfig, steps: list[ExplanationStep] | None) -> str`**
- **Function**: Apply a named fixer when enabled in `config`, optionally recording the action in an explanation plan.

**`_fix_encoding_one_step_and_explain(text: str, config: TextFixerConfig) -> ExplainedText`**
- **Function**: Execute a single iteration of the encoding-repair search (re-encoding bytes, trying sloppy codecs, applying transcoders) and return the updated text along with the steps taken.

**Usage Example**:
```python
from ftfy import TextFixerConfig, _config_from_kwargs, _try_fix, _fix_encoding_one_step_and_explain, FIXERS

config = _config_from_kwargs(TextFixerConfig(), {"uncurl_quotes": False})
steps: list = []
print(_try_fix("fix_line_breaks", "Cradle\rRock", config, steps))  # "Cradle\nRock"
print(steps)
result = _fix_encoding_one_step_and_explain("caf\u00c3\u00a9", config)
print(result.text, result.explanation)
print("unescape_html" in FIXERS)
```

#### ftfy.bad_codecs.sloppy

- **`REPLACEMENT_CHAR`**: The Unicode replacement character (`"\ufffd"`) used when filling unmapped bytes in sloppy codecs.

**`make_sloppy_codec(encoding: str) -> codecs.CodecInfo`**
- **Function**: Construct a `CodecInfo` for a sloppy version of the requested single-byte encoding, including custom codec, incremental encoder/decoder, and stream classes.
- **`StreamWriter` / `StreamReader`**: Codec-specific subclasses of `codecs.StreamWriter` and `codecs.StreamReader` returned by `make_sloppy_codec` so sloppy encodings integrate with Python's streaming API.
- **`CODECS`**: Dictionary of normalized sloppy encoding names to their `CodecInfo` objects, populated for every member of `INCOMPLETE_ENCODINGS`.
- **`INCOMPLETE_ENCODINGS`**: Tuple of Windows-125x, ISO-8859, and CP874 encodings that leave bytes unmapped and therefore get sloppy variants.

**Usage Example**:
```python
from ftfy.bad_codecs.sloppy import make_sloppy_codec, CODECS, INCOMPLETE_ENCODINGS

codec = make_sloppy_codec("windows-1252")
decoded, consumed = codec.decode(b"\x80")
print(decoded, consumed)  # "€" 1
print("sloppy_windows_1252" in CODECS)
print(INCOMPLETE_ENCODINGS[:3])
```

#### ftfy.bad_codecs.utf8_variants

- **`NAME`**: Canonical codec name `"utf-8-variants"` registered with the codecs module.
- **`CESU8_EXPR` / `CESU8_RE`**: Byte expression and compiled regex that match full or truncated CESU-8 surrogate sequences.
- **`SURROGATE_EXPR` / `NULL_EXPR` / `SPECIAL_BYTES_RE`**: Byte-pattern helpers that detect isolated surrogates and Java's overlong null encoding so the decoder can defer to special handling.
- **`IncrementalEncoder`**: Type alias to the standard UTF-8 incremental encoder; encoding output is identical to UTF-8 even when decoding accepts CESU-8.
- **`StreamWriter` / `StreamReader`**: Stream classes that call the codec's incremental encoder/decoder, making `utf-8-variants` usable with Python's file APIs.
- **`CODEC_INFO`**: `codecs.CodecInfo` instance exposing the encoder, decoder, incremental classes, and stream wrappers for registration via `codecs.register`.

**Usage Example**:
```python
import codecs
from ftfy.bad_codecs.utf8_variants import CODEC_INFO, SPECIAL_BYTES_RE, NAME

print(CODEC_INFO.name)  # "utf-8-variants"
print(bool(SPECIAL_BYTES_RE.search(b"\xed\xa0\x80\xed\xb0\x80")))
decoded = codecs.decode(b"\xed\xa0\xbd\xed\xb8\x8d", NAME)
print(decoded)  # "😍"
```

#### ftfy.bad_codecs package

- **`_CACHE`**: Module-level dictionary caching codec lookups performed by `search_function`.
- **`UTF8_VAR_NAMES`**: Tuple of normalized alias names (`"utf8_var"`, `"cesu8"`, `"java_utf8"`, etc.) that resolve to the utf-8-variants codec.

**Usage Example**:
```python
from ftfy.bad_codecs import search_function, UTF8_VAR_NAMES

print(UTF8_VAR_NAMES[:4])
codec = search_function("utf-8-var")
print(codec.name if codec else None)
```

#### ftfy.cli

- **`ENCODE_ERROR_TEXT_UNIX` / `ENCODE_ERROR_TEXT_WINDOWS`**: User-facing diagnostics printed when stdout cannot encode Unicode on POSIX terminals or the Windows console.
- **`DECODE_ERROR_TEXT`**: Template used when stdin fails to decode with the requested encoding (or the guessed encoding).
- **`SAME_FILE_ERROR_TEXT`**: Message emitted when the requested output path matches the input file, preventing accidental overwrite.

**Usage Example**:
```python
from ftfy.cli import SAME_FILE_ERROR_TEXT, DECODE_ERROR_TEXT

print(SAME_FILE_ERROR_TEXT.strip().splitlines()[0])
print(DECODE_ERROR_TEXT.splitlines()[0])
```

#### scripts.char_data_table

- **`CharData`**: `@dataclass` storing a character’s name, code point, and the list of `(encoding, byte)` pairs that can produce it; provides `sort_key()` for grouping Latin ligatures ahead of other entries.
- **`SAFE_ENCODINGS`**: List of high-value encodings (Latin-1 and Windows-125x families) the script inspects when generating UTF-8 clue tables.

**`show_char_table(chars: str, byte_min: int = 0, byte_max: int = 0xFF) -> None`**
- **Function**: Iterate over `chars`, collect encoding-byte annotations limited to the requested byte range, and print them in the format used by `UTF8_CLUES`.

**`run() -> None`**
- **Function**: Script entry point that dumps tables for each UTF-8 clue class when `python scripts/char_data_table.py` is executed directly.

**Usage Example**:
```python
from scripts.char_data_table import CharData, SAFE_ENCODINGS, show_char_table

entry = CharData("LATIN SMALL LIGATURE FF", 0xFB00, [("windows-1252", 0xFF)])
print(entry.sort_key())
print(SAFE_ENCODINGS[:3])
show_char_table("\ufb00", 0x80, 0xFF)
```
