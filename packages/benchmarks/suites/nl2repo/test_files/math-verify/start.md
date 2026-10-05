## Math-Verify Project Introduction and Objectives

Math-Verify is a **mathematical answer verification** Python library capable of parsing mathematical expressions (supporting both LaTeX format and plain text) and comparing answer correctness. The tool has demonstrated excellent performance in evaluations on mathematical question datasets like MATH, achieving "the highest accuracy and optimal scores." Its core functionalities include: parsing mathematical answers (automatically extracting and parsing LaTeX or pure mathematical expressions), **numerical and symbolic equivalence checking** (supporting approximate numerical comparison and symbolic equivalence judgment), and intelligent comparison of special expressions such as sets, intervals, matrices, and inequalities. In short, Math-Verify aims to provide a robust mathematical answer verification system for evaluating the correctness of large language model outputs on mathematical problems (for example, using parse() to convert answers into symbolic expressions and the verify() function to determine if two expressions are equivalent).

## Natural Language Instructions (Prompt)

Please create a Python project called Math-Verify that implements a mathematical answer verification library. The project should include the following features:

1. **Expression Parser**: Capable of extracting and parsing mathematical expressions from input strings, supporting LaTeX format (e.g., \\frac{1}{2}, set expressions, etc.) and plain mathematical text (e.g., x^2 + 3*x). The parsing results should be SymPy symbolic objects or equivalent comparable forms.

2. **Equivalence Checking**: Implement functions (or scripts) to compare whether two mathematical expressions are equivalent, including both numerical and symbolic comparisons. Support should be provided for approximate comparison of fractions and decimals, simplification judgment of symbolic expressions, and equivalence determination of relations/inequalities.

3. **Special Structure Handling**: Special handling for sets, intervals, matrices, percentages, unit symbols, etc. For example, {1,2,3} and {3,2,1} should be considered equivalent, and the interval [0,1] should be equivalent to [1,0].

4. **Interface Design**: Design independent command-line or functional interfaces for each module (such as parsing, numerical comparison, symbolic comparison, relation comparison, etc.), supporting terminal testing. Each module should have clearly defined input/output formats.

5. **Examples and Evaluation Scripts**: Provide example code and test cases demonstrating how to use the parse() and verify() functions for input parsing and answer verification (e.g., verify(parse("${1,3}\\cup{2,4}$"), parse("${1,2,3,4}$")) should return True). The above features should be combined to build a complete mathematical verification toolkit. The final project should include modules for parsing, comparison, and overall verification, along with typical test cases, forming a reproducible verification workflow.

6. **Core File Requirements**: The project must include a comprehensive pyproject.toml file that not only configures the project as an installable package (supporting pip install) but also declares a complete list of dependencies (including core libraries such as sympy==1.14.0, latex2sympy2_extended==1.10.1, mpmath==1.3.0, numpy, pandas, antlr4-python3-runtime, pytest, etc.). The pyproject.toml should verify that all functional modules are working correctly. Additionally, provide math_verify/__init__.py as a unified API entry point, importing the core parse and verify functions from the parser and verifier modules, and exporting configuration classes such as LatexExtractionConfig, ExprExtractionConfig, and StringExtractionConfig. Include version information to allow users to access all major features with a simple "from math_verify import parse, verify" statement. In grader.py, implement the sympy_expr_eq() function to compare two SymPy expressions for equivalence using multiple strategies.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.18

### Core Dependency Versions

```Plain
antlr4-python3-runtime 4.13.2
exceptiongroup         1.3.0
execnet                2.1.1
iniconfig              2.1.0
latex2sympy2_extended  1.10.2
mpmath                 1.3.0
numpy                  2.2.6
packaging              25.0
pandas                 2.2.3
pip                    23.0.1
pluggy                 1.6.0
Pygments               2.19.2
pytest                 8.4.1
pytest-xdist           3.8.0
python-dateutil        2.9.0.post0
pytz                   2025.2
setuptools             65.5.1
six                    1.17.0
sympy                  1.14.0
tomli                  2.2.1
typing_extensions      4.14.1
tzdata                 2025.2
wheel                  0.45.1
```

## Math-Verify Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .gitignore
├── .gitmodules
├── CHANGELOG.md
├── CITATION.cff
├── LICENCE
├── Makefile
├── README.md
├── assets
│   ├── flow.svg
├── evaluate_model.py
├── evaluate_model_outputs.py
├── examples
│   ├── few_shot_answers.csv
│   ├── model_outputs.csv
│   ├── sample_answers.csv
├── extract_answers.py
├── latex2sympy2_extended_cloned
├── output.csv 
├── scripts
│   ├── publish.sh
├── src
│   ├── math_verify
│   │   ├── __init__.py
│   │   ├── errors.py
│   │   ├── few_shots.py
│   │   ├── grader.py
│   │   ├── metric.py
│   │   ├── parser.py
│   │   ├── tasks.py
│   │   └── utils.py
└── pyproject.toml

```


## API Usage Guide

### Core API

#### 1. Module Import

```python
from math_verify import (
    parse, verify, math_metric,
    ExprExtractionConfig, LatexExtractionConfig, StringExtractionConfig,
    LatexNormalizationConfig
)
```

#### 2. parse() Function - Mathematical Expression Parsing

**Functionality**: Extracts mathematical expressions from text and converts them to SymPy objects.

**Function Signature**:
```python
def parse(
    pred: str,
    extraction_config: Sequence[ExtractionTarget] = [
        LatexExtractionConfig(),
        ExprExtractionConfig(),
    ],
    fallback_mode: Literal["no_fallback", "first_match"] = "first_match",
    extraction_mode: Literal["first_match", "any_match"] = "any_match",
    parsing_timeout: int = 5,
) -> list[Basic | MatrixBase | str]:
```

**Parameter Description**:
- `pred` (str): Text string to be parsed
- `extraction_config` (Sequence[ExtractionTarget]): List of extraction configurations controlling how expressions are identified and extracted
- `fallback_mode` (Literal): Behavior when primary extraction fails
  - `"no_fallback"`: Only return successfully parsed expressions
  - `"first_match"`: Include the first string match (even if parsing fails)
- `extraction_mode` (Literal): Extraction mode
  - `"first_match"`: Stop after finding the first match
  - `"any_match"`: Attempt to extract all possible matches, stopping after the first successful parse
- `parsing_timeout` (int): Parsing timeout in seconds, default is 5 seconds

**Return Value**: List of parsed SymPy expressions

#### 3. verify() Function - Expression Equivalence Verification

**Functionality**: Verifies whether two mathematical expressions are equivalent in a mathematical sense.

**Function Signature**:
```python
def verify(
    gold: list[Basic | MatrixBase | str] | Basic | MatrixBase | str,
    target: list[Basic | MatrixBase | str] | Basic | MatrixBase | str,
    float_rounding: int = 6,
    numeric_precision: int = 15,
    strict: bool = True,
    allow_set_relation_comp: bool = False,
    timeout_seconds: int | None = 5,
) -> bool:
```

**Parameter Description**:
- `gold`: Reference answer (expression or list of expressions)
- `target`: Expression to be verified (note: parameter name is target, not pred)
- `float_rounding` (int): Floating-point rounding precision, default is 6 decimal places
- `numeric_precision` (int): Numerical computation precision, default is 15 digits
- `strict` (bool): Whether to use strict mode, default is True
- `allow_set_relation_comp` (bool): Whether to allow comparison between sets and relations, default is False
- `timeout_seconds` (int | None): Verification timeout in seconds, default is 5 seconds

**Return Value**: Boolean indicating whether the expressions are equivalent

#### 4. sympy_expr_eq() Function - SymPy Expression Equivalence Verification

**Functionality**: Verifies whether two SymPy expressions are equal.

**Function Signature**:
```python
def sympy_expr_eq(
    gold: Basic | MatrixBase,
    target: Basic | MatrixBase,
    float_rounding: int,
    numeric_precision: int,
    allow_set_relation_comp: bool = False,
    strict: bool = True,
) -> bool:
```

**Parameter Description**:
- `gold`: Reference answer (expression or list of expressions)
- `target`: Expression to be verified (note: parameter name is target, not pred)
- `float_rounding` (int): Floating-point rounding precision
- `numeric_precision` (int): Numerical computation precision
- `allow_set_relation_comp` (bool): Whether to allow comparison between sets and relations, default is False
- `strict` (bool): Whether to use strict mode, default is True
  
**Return Value**: Boolean indicating whether the expressions are equivalent



### Configuration Classes Details

#### 1. LatexExtractionConfig

**Functionality**: Configures extraction rules for LaTeX expressions

```python
@dataclass(frozen=True)
class LatexExtractionConfig:
    try_extract_without_anchor: bool = True
```

**Parameter Description**:
- `try_extract_without_anchor`: Whether to attempt extraction even without explicit answer markers

#### 2. ExprExtractionConfig

**Functionality**: Configures extraction rules for regular mathematical expressions

```python
@dataclass(frozen=True)
class ExprExtractionConfig:
    try_extract_without_anchor: bool = True
```

#### 3. StringExtractionConfig

**Functionality**: Configures extraction rules for string answers (e.g., multiple-choice options)

```python
@dataclass(frozen=True)
class StringExtractionConfig:
    strings: tuple[str, ...] = ("A", "B", "C", "D")  # Default values
    try_extract_without_anchor: bool = True
    lowercase: bool = True
```

### Usage Patterns

#### Basic Usage

```python
from math_verify import parse, verify

# Simple parsing and verification
gold = parse("$\\frac{1}{2}$")
answer = parse("$0.5$")
is_correct = verify(gold, answer)
```

#### Configuration-based Usage

```python
from math_verify import parse, verify, LatexExtractionConfig, ExprExtractionConfig

# Custom configuration
latex_config = LatexExtractionConfig(
    boxed_match_priority=0,  # Set to highest priority
    try_extract_without_anchor=True
)

expr_config = ExprExtractionConfig(
    try_extract_without_anchor=True
)

# Parse with configuration
gold = parse("Final answer: \\boxed{\\frac{1}{2}}", [latex_config])
answer = parse("The result is 0.5", [expr_config])
is_correct = verify(gold, answer, float_rounding=6)
```

#### Test Helper Function Pattern

```python
def compare_strings(
    gold: str,
    pred: str,
    match_types: list[str] = ["latex", "expr"],
    precision: int = 6,
    strict: bool = True,
    allow_set_relation_comp: bool = False,
):
    """Helper function: Compare mathematical equivalence of two strings"""
    # Convert match types to configuration objects
    extraction_targets = []
    for match_type in match_types:
        if match_type == "latex":
            extraction_targets.append(LatexExtractionConfig(boxed_match_priority=0))
        elif match_type == "expr":
            extraction_targets.append(ExprExtractionConfig())

    gold_parsed = parse(gold, extraction_targets)
    pred_parsed = parse(pred, extraction_targets)
    return verify(
        gold_parsed, pred_parsed,
        float_rounding=precision,
        strict=strict,
        allow_set_relation_comp=allow_set_relation_comp
    )

# Example usage
result = compare_strings("$\\frac{1}{2}$", "0.5")  # Returns True
```

### Supported Expression Types

- **Numeric Types**: Integers, floating-point numbers, fractions, percentages, scientific notation
- **Algebraic Expressions**: Polynomials, rational functions, root expressions
- **Geometric Expressions**: Coordinates, vectors, matrices
- **Sets and Intervals**: Finite sets, infinite sets, open and closed intervals
- **Relational Expressions**: Equations, inequalities, equation systems
- **Special Symbols**: Greek letters, mathematical constants, function symbols

### Error Handling

The system provides comprehensive error handling mechanisms:
- **Timeout Protection**: Prevents excessive parsing time for complex expressions
- **Format Tolerance**: Automatically fixes common LaTeX formatting errors
- **Fallback Mechanism**: Multiple extraction strategies ensure maximum compatibility
- **Exception Handling**: Gracefully handles parsing failures

### Important Notes

1. **Function Asymmetry**: The parameter order in `verify()` is important - `gold` should be the reference answer and `target` is the expression to be verified
2. **Thread Safety**: Due to the use of `signal.alarm()`, this library does not support multi-threaded environments. For multi-threaded usage, set `parsing_timeout=None`
3. **Configuration Priority**: Different `boxed_match_priority` values affect the extraction order of expressions
4. **Strict Mode**: `strict=True` enables more precise comparison, while `strict=False` allows variable position matching

## Detailed Implementation Nodes

### Node 1: Number Format Normalization

**Functionality**: Processes various numerical representation formats and standardizes them into comparable numerical forms. Supports complex scenarios including thousands separators, decimal point variations, currency symbols, and unit conversions.

**Core Algorithms**:
- Thousands separator recognition and removal
- European/American decimal point conversion
- Currency symbol and unit filtering
- Scientific notation standardization

**Input/Output Examples**:

```python
from math_verify import parse
from tests.test_all import compare_strings

# Thousands separator handling
result = parse("7,425,000")
print(result)  # [7425000]

result = parse("1 000")
print(result)  # [1000]

# European decimal point handling
result = parse("1000,99")
print(result)  # [1000.99]

result = parse("1,22")
print(result)  # [1.22]

# Currency symbol handling
result = parse("$1,000.99")
print(result)  # [1000.99]

result = parse("the number is not 10 which is 1,000.99€")
print(result)  # [1000.99]

# Unit handling
result = parse("so the number is 10 which is 1,000.99m²")
print(result)  # [1000.99]

# Decimal point handling
result = parse(".4")
print(result)  # [0.4]

# Test verification
assert compare_strings("7425000", "7,425,000", match_types=["expr"]) == 1
assert compare_strings("1000.99", "1000,99", match_types=["expr"]) == 1
assert compare_strings("1000.99", "$1,000.99", match_types=["expr"]) == 1
```

### Node 2: LaTeX Environment Detection and Extraction

**Functionality**: Intelligently identifies and extracts mathematical expressions from different LaTeX environments, supporting nested environments, escape characters, and format error correction.

**Supported LaTeX Environments**:
- Inline math: `$...$`, `\(...\)`
- Display math: `$$...$$`, `\[...\]`
- Answer box: `\boxed{...}`
- Matrix environments: `pmatrix`, `bmatrix`, `array`

**Input/Output Examples**:

```python
from math_verify import parse
from math_verify.parser import LatexExtractionConfig

# Inline math environment
result = parse("Answer $ 9 $")
print(result)  # [9]

result = parse("Answer \\( 9 \\), and more text")
print(result)  # [9]

# Display math environment
result = parse("Answer \\[ 9 \\]")
print(result)  # [9]

result = parse("Answer $$ 9 $$")
print(result)  # [9]

# Boxed environment
result = parse("$\\boxed{\\frac{1}{3}}$")
print(result)  # [Rational(1, 3)]

# Symbol handling in complex expressions
result = parse("Answer $ \\frac{1}{2} \\$ = \\frac{10}{9} $")
print(result)  # [Rational(10, 9)]

# Test verification
assert compare_strings("$9$", "Answer $ 9 $", match_types=["latex"]) == 1
assert compare_strings("$9$", "Answer \\[ 9 \\]", match_types=["latex"]) == 1
assert compare_strings("$1/3$", "$\\boxed{\\frac{1}{3}}$", match_types=["latex"]) == 1
```

### Node 3: LaTeX Symbol Repair and Normalization

**Functionality**: Automatically fixes common LaTeX formatting errors and normalizes mathematical symbol representations to improve parsing success rate.

**Repair Strategies**:
- Missing braces: `\frac12` → `\frac{1}{2}`
- Command standardization: `\cfrac` → `\frac`
- Square root fixing: `\sqrt3` → `\sqrt{3}`
- Fraction variant support: `\cfrac`, `\dfrac`, `\tfrac`
- Style removal: `\left`, `\right`, `\text{}`

**Input/Output Examples**:

```python
from math_verify import parse
from latex2sympy2_extended import NormalizationConfig
from math_verify.parser import LatexExtractionConfig

# Missing braces repair
result = parse("$\\frac13$")
print(result)  # [Rational(1, 3)]

result = parse("$\\frac3{3}$")
print(result)  # [1]

# Square root fixing
result = parse("$\\sqrt3$")
print(result)  # [sqrt(3)]

# Fraction variant repair
result = parse("$\\cfrac{1}{3}$")
print(result)  # [Rational(1, 3)]

result = parse("$\\dfrac{1}{3}$")
print(result)  # [Rational(1, 3)]

result = parse("$\\tfrac{1}{3}$")
print(result)  # [Rational(1, 3)]

# Style removal
result = parse("$\\left( \\frac{1}{3} \\right)$")
print(result)  # [Rational(1, 3)]

result = parse("$\\frac{1}{3} \\text{meters}$")
print(result)  # [Rational(1, 3)]

# Equation handling
result = parse("$k = \\frac{1}{3}$")
print(result)  # [Rational(1, 3)]

# Test verification
assert compare_strings("$1/3$", "$\\frac13 $", match_types=["latex"]) == 1
assert compare_strings("$\\sqrt{3}$", "$\\sqrt3 $", match_types=["latex"]) == 1
assert compare_strings("$1/3$", "$\\cfrac{1}{3} $", match_types=["latex"]) == 1
```

### Node 4: Percentage Format Conversion

**Functionality**: Recognizes and converts various percentage representations, supporting text descriptions, symbolic notation, and numerical conversion.

**Supported Formats**:
- Symbolic form: `28%`, `28 %`
- Text form: `28 percent`, `28 pct`
- LaTeX wrapped: `$28$ %`, `\boxed{28} pct`
- Compound form: `\boxed{28 percent}`

**Input/Output Examples**:

```python
from math_verify import parse
from tests.test_all import compare_strings

# Standard symbol percentage
result = parse("28 percent")
print(result)  # [0.28] (converted to decimal)

result = parse("28 pct")
print(result)  # [0.28]

result = parse("28 %")
print(result)  # [0.28]

# LaTeX包装百分比
result = parse("$28$ %")
print(result)  # [0.28]

result = parse("$28$ percent")
print(result)  # [0.28]

result = parse("$\\boxed{28}$ pct")
print(result)  # [0.28]

# 复合形式
result = parse("$\\boxed{28 pct}$")
print(result)  # [0.28]

result = parse("$\\boxed{28 percent}$")
print(result)  # [0.28]

# 测试验证
assert compare_strings("$28\\%$", "28 percent") == 1
assert compare_strings("$28\\%$", "28 pct") == 1
assert compare_strings("$28\\%$", "$\\boxed{28}$ pct") == 1
```

### Node 5: Set and Interval Normalization

**Functionality**: Unifies various set and interval representations, supporting finite sets, infinite sets, open and closed intervals, and other mathematical structures.

**Supported Notations**:
- Finite sets: `{1,2,3}`, `\{a,b,c\}`
- Interval notation: `[0,1]`, `(0,1)`, `[0,1)`
- Set operations: `A ∪ B`, `A ∩ B`
- Equivalence between inequalities and intervals: `1 ≤ |z| ≤ 3/2` ↔ `z ∈ [-3/2,-1] ∪ [1,3/2]`

**Input/Output Examples**:

```python
from math_verify import parse
from tests.test_all import compare_strings
import sympy as sp

# Interval notation
result = parse("$[0,1)$")
print(result)  # [Interval.Ropen(0, 1)]

result = parse("$(0,1)$")
print(result)  # [Interval.open(0, 1)]

result = parse("$[0,1]$")
print(result)  # [Interval(0, 1)]

# Complex interval expressions
result = parse("$z \\in \\left[-\\frac{3}{2}, -1\\right] \\cup \\left[1, \\frac{3}{2}\\right]$")
print(result)  # [Union(Interval(Rational(-3, 2), -1), Interval(1, Rational(3, 2)))]

# Set representation
result = parse("${1,2,3}$")
print(result)  # [FiniteSet(1, 2, 3)]

# Interval and decimal equivalence
result = parse("$(0.6,2.6667]$")
print(result)  # [Interval.Ropen(0.6, 2.6667)]

# Test verification
assert compare_strings("$[0,1)$", "$[0,1)$") == 1
assert compare_strings("$[0,9)$", "$[0,1)$") == 0  # Different intervals
assert compare_strings("$(0,9)$", "$[0,9)$") == 0  # Different open/closed
assert compare_strings("$(\\frac{3}{5},\\frac{8}{3}]$", "$(0.6,2.6667]$") == 1  # Equivalent within precision
```

### Node 6: Relation and Inequality Processing

**Functionality**: Processes various relational symbols and inequality expressions, supporting direction reversal, equivalent transformations, and compound inequality chaining.

**Supported Relational Symbols**:
- Inequality signs: `≥`, `≤`, `>`, `<`, `\geq`, `\leq`
- Equality variants: `=`, `≠`, `\neq`
- Direction reversal: `5 ≤ x` `x ≥ 5`
- Interval and inequality equivalence: `-793 < a < 10` `(-793, 10)`

**Input/Output Examples**:

```python
from math_verify import parse
from tests.test_all import compare_strings
import sympy as sp

# Basic inequalities
result = parse("$x \\geq 5$")
print(result)  # [x >= 5]

result = parse("$5 \\leq x$")
print(result)  # [x >= 5] (equivalent after direction reversal)

# Compound inequalities
result = parse("$-793 < a < 10$")
print(result)  # [And(-793 < a, a < 10)]

# Interval representation equivalence
result = parse("$(-793, 10)$")
print(result)  # [Interval.open(-793, 10)]

# Equation handling
result = parse("$34x+45y-20z+100=0$")
print(result)  # [Eq(34*x + 45*y - 20*z + 100, 0)]

result = parse("$-34x-45y+20z-100=0$")
print(result)  # [Eq(-34*x - 45*y + 20*z - 100, 0)]

# Test verification

assert compare_strings("$1/3$", "$k = \\frac{1}{3}$", match_types=["latex"]) == 1
assert compare_strings("$$-793 < a < 10$$", "$$(-793, 10)$$") == 1
assert compare_strings("$34x+45y-20z+100=0$", "$-34x-45y+20z-100=0$") == 1
```
### Node 7: Matrix and Vector Processing

**Functionality**: Processes various matrix and vector representations, supporting different matrix environments and vector notations, including complex matrix operations.

**Supported Formats**:
- Matrix environments: `pmatrix`, `bmatrix`, `matrix`
- Vector representations: Coordinate form `(x,y,z)`
- Complex matrix expressions: Matrices with fractions, radicals
- Matrix and decimal equivalence

**Input/Output Examples**:

```python
from math_verify import parse
from tests.test_all import compare_strings
import sympy as sp

# Basic matrix
result = parse("$\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}$")
print(result)  # [Matrix([[1, 0], [0, 1]])]

# Complex matrix
result = parse("$\\begin{pmatrix}-\\frac{7}{4}&-2\\\\4&\\frac{1}{4}\\end{pmatrix}$")
print(result)  # [Matrix([[Rational(-7, 4), -2], [4, Rational(1, 4)]])]

# Matrix with radicals
result = parse("$\\begin{pmatrix}\\frac{1}{3\\sqrt[3]{x}^2}&0&0\\\\0&1&0\\\\-\\sin(x)&0&0\\end{pmatrix}$")
print(result)  # [Matrix with complex expressions]

# Matrix equivalence (fractions vs decimals)
result = parse("$\\begin{pmatrix}\\frac{1}{3}\\\\ \\frac{1}{5} \\end{pmatrix}$")
print(result)  # [Matrix([[Rational(1, 3)], [Rational(1, 5)]])]

result = parse("$\\begin{pmatrix}0.33\\\\0.2 \\end{pmatrix}$")
print(result)  # [Matrix([[0.33], [0.2]])]

# Coordinate vector
result = parse("$(3, \\frac{\\pi}{2})$")
print(result)  # [Tuple with expressions]

result = parse("$(7,6)$")
print(result)  # [(7, 6)]

# Multiple coordinates
result = parse("$(2, 2), (1, 3), (3, 3)$")
print(result)  # [Multiple tuples]

# Test verification
assert compare_strings("\\boxed{\n\\begin{pmatrix} 0 & 3 \\\\ 0 & -1 \\end{pmatrix}\n}",
                      "\\boxed{\n\\begin{pmatrix} 0 & 3 \\\\ 0 & -1 \\end{pmatrix}\n}") == 1
assert compare_strings("$(\\begin{pmatrix}\\frac{1}{3}\\\\ \\frac{1}{5} \\end{pmatrix})$",
                      "$\\begin{pmatrix}0.33\\\\0.2 \\end{pmatrix}$") == 1  # Equivalent within precision
```

### Node 8: Complex Mathematical Expression Processing

**Functionality**: Processes complex mathematical expressions including polynomials, fractions, radicals, trigonometric functions, logarithms, and exponential functions.

**Supported Types**:
- Polynomial expressions and algebraic equivalence
- Fraction simplification and equivalence
- Radical expression conversion
- Trigonometric identity verification
- Complex number expression handling

**Input/Output Examples**:

```python
from math_verify import parse
from tests.test_all import compare_strings
import sympy as sp

# Algebraic expression equivalence
result = parse("$\\frac{x+2}{7}$")
print(result)  # [(x + 2)/7]

result = parse("$\\frac{x}{7}+\\frac{2}{7}$")
print(result)  # [x/7 + 2/7]

# Trigonometric identities
result = parse("$\\tan^2(y)+1$")
print(result)  # [tan(y)**2 + 1]

result = parse("$\\sec^2(y)$")
print(result)  # [sec(y)**2]

# Complex fractional expressions
result = parse("$\\frac{\\sqrt{\\sqrt{11}+\\sqrt{194}}}{15+2\\sqrt{33}}$")
print(result)  # [Complex nested radical expression]

result = parse("$\\frac{\\sqrt{\\sqrt{11}+\\sqrt{194}}}{2\\sqrt{33}+15}$")
print(result)  # [Same expression with reordered denominator]

# Radical expressions
result = parse("$3\\sqrt{13}$")
print(result)  # [3*sqrt(13)]

# Quadratic formula result
result = parse("$1 \\pm \\sqrt{19}$")
print(result)  # [Expression with ±]

# Fraction and decimal equivalence
result = parse("$\\frac{1}{12}$")
print(result)  # [Rational(1, 12)]

result = parse("$0.0833333333333333$")
print(result)  # [0.0833333333333333]

# Test verification
assert compare_strings("$\\frac{x+2}{7}$", "$\\frac{x}{7}+\\frac{2}{7}$") == 1
assert compare_strings("$\\tan^2(y)+1$", "$\\sec^2(y)$") == 1
assert compare_strings("$\\frac{1}{12}$", "$0.0833333333333333$") == 1  # Equivalent within precision
assert compare_strings("$1 \\pm \\sqrt{19}$", "By the quadratic formula, $x = \\boxed{1 \\pm \\sqrt{19}}.$") == 1
```

### Node 9: String Extraction Configuration

**Functionality**: Extracts and matches string answers, primarily used for multiple-choice questions, supporting case conversion and custom string sets.

**Configuration Options**:
- Case handling: `lowercase` parameter
- Custom string sets: `strings` parameter
- Extraction pattern: `try_extract_without_anchor`
- Return format: Returns `[lowercase_version, original_version]`

**Input/Output Examples**:

```python
from math_verify import StringExtractionConfig, parse

# Basic string extraction
result = parse("The answer is A.", [StringExtractionConfig(lowercase=False)])
print(result)  # ["A", "A"]

# Case conversion
result = parse("The answer is A.", [StringExtractionConfig(lowercase=True)])
print(result)  # ["a", "A"]

# Default configuration (lowercase=True)
result = parse("Final answer is B", [StringExtractionConfig()])
print(result)  # ["b", "B"]

# No match case
result = parse("No valid answer here", [StringExtractionConfig()])
print(result)  # []

# Leading character detection
result = parse("A. Because B is not valid", [StringExtractionConfig()])
print(result)  # ["a", "A"]

# Custom string set
result = parse("The answer is U.", [StringExtractionConfig(strings=("U",))])
print(result)  # ["u", "U"]

# Multiple string selection
result = parse("Because B is valid", [StringExtractionConfig()])
print(result)  # ["b", "B"]

# Test verification
config_upper = StringExtractionConfig(lowercase=False)
config_lower = StringExtractionConfig(lowercase=True)
config_custom = StringExtractionConfig(strings=("U",))

assert parse("The answer is A.", [config_upper]) == ["A", "A"]
assert parse("The answer is A.", [config_lower]) == ["a", "A"]
assert parse("The answer is U.", [config_custom]) == ["u", "U"]
```

### Node 10: Boxed Environment Priority

**Functionality**: Handles the priority of `\boxed{}` environments for answer extraction, controlling the order of extraction, and supports multiple boxed expressions.

**Priority Configuration**:
- `boxed_match_priority=0`: Highest priority (extracts boxed first)
- `boxed_match_priority=50`: Default priority (extracts after "final answer")
- `boxed_match_priority=-1`: Disables boxed extraction
- Supports multiple boxed expressions in complex text

**Input/Output Examples**:

```python
from math_verify.parser import LatexExtractionConfig, parse
import sympy

# Highest priority (extracts boxed first)
config_high = LatexExtractionConfig(boxed_match_priority=0)
result = parse("final answer is $9999$, \\boxed{1}", [config_high])
print(result)  # [1] - Extracts boxed content

# Lower priority (extracts final answer first)
config_low = LatexExtractionConfig(boxed_match_priority=100)
result = parse("final answer is $9999$, \\boxed{1}", [config_low])
print(result)  # [9999] - Extracts final answer

# Disable boxed extraction
config_disabled = LatexExtractionConfig(boxed_match_priority=-1)
result = parse("\\boxed{1}", [config_disabled], fallback_mode="no_fallback")
print(result)  # [] - No extraction result

# Boxed extraction in complex text
result = parse("SoHi YES. could answer therefore\\boxed{840}.,but let me put this after explain. **Final Answer** \\boxed{840}")
print(result)  # [840]

# Multiple boxed expressions
result = parse("\\boxed{35 cm} ++++++ \\boxed{4}")
print(result)  # [35*cm + 4] or corresponding expression

# Boxed with complex content
result = parse("the answer should be \\boxed{004}. But let me check again: **Final Answer** \\boxed{004}")
print(result)  # [4] (004 is parsed as 4)

# Test verification
from tests.test_boxed import test_boxed

# Verify multiple boxed expressions
assert compare_strings(r"$\\boxed{35 cm} ++++++ \\boxed{4}$", r"${35 cm,4}$") == 1
assert compare_strings(r"\\boxed{004}", r"$004$") == 1
assert compare_strings(r"\\boxed{840}", r"$840$") == 1
```

### Node 11: Timeout Protection Mechanism

**Functionality**: Prevents excessively long parsing of complex expressions by providing timeout protection at two levels: parsing timeout and verification timeout.

**Timeout Types**:
- Parsing Timeout: `parsing_timeout` parameter (default 5 seconds)
- Verification Timeout: `timeout_seconds` parameter (default 5 seconds)
- Thread Safety: Uses `signal.alarm()` to implement timeout control

**输入输出示例**：

```python
from math_verify import parse, verify
import time
from unittest.mock import patch

# Parsing timeout test
@patch("math_verify.parser.parse_expr")
def test_parse_timeout(mock_parse_expr):
    # Simulate delayed parsing
    def delayed_parse(*args, **kwargs):
        time.sleep(5)  # Simulate 5-second delay
        return "parsed_expr"
    
    mock_parse_expr.side_effect = delayed_parse
    
    # Set 1-second timeout
    result = parse("1+1", parsing_timeout=1, extraction_mode="first_match", fallback_mode="no_fallback")
    print(result)  # [] - Timeout returns empty list

# Verification timeout test
@patch("math_verify.grader.sympy_expr_eq")
def test_verify_timeout(mock_verify):
    # Simulate delayed verification
    def delayed_sympy_expr_eq(*args, **kwargs):
        time.sleep(5)  # Simulate 5-second delay
        return True
    
    mock_verify.side_effect = delayed_sympy_expr_eq
    
    # Set 1-second timeout
    gold = parse("1+1")
    result = verify(gold, gold, timeout_seconds=1)
    print(result)  # False - Timeout returns False

# Normal case (no timeout)
result = parse("1+1", parsing_timeout=10)
print(result)  # [2] - Normal parsing result

# LaTeX parsing timeout
@patch("math_verify.parser.latex2sympy")
def test_latex_timeout(mock_parse_latex):
    def delayed_parse(*args, **kwargs):
        time.sleep(5)
        return "parsed_expr"
    
    mock_parse_latex.side_effect = delayed_parse
    
    result = parse("$1+1$", parsing_timeout=1, extraction_mode="first_match", fallback_mode="no_fallback")
    print(result)  # [] - Timeout returns empty list

# Actual usage with timeout settings
# For complex expressions, increase timeout duration
complex_expr = "$\\frac{\\sqrt{\\sqrt{11}+\\sqrt{194}}}{15+2\\sqrt{33}}$"
result = parse(complex_expr, parsing_timeout=10)
print(result)  # Increase timeout to handle complex expressions

# Test verification
# Note: Actual testing requires using mocks to simulate timeout scenarios
```

### Node 12: Strict Mode and Variable Comparison

**Functionality**: Controls the strictness of variable comparison, handling expressions with different variable names but identical structures, supporting flexible mathematical equivalence determination.

**Mode Description**:
- `strict=True`: Variable names must match exactly (default)
- `strict=False`: Allows structural matching with different variable names
- Affects comparison behavior of functions, variables, and symbols

**Input/Output Examples**：

```python
from math_verify import parse, verify
from tests.test_all import compare_strings

# Strict mode test - variable names must match
result_strict = compare_strings("$f(x)$", "$f(y)$", strict=True)
print(result_strict)  # 0 - Variables are different, strict mode returns not equivalent

# Non-strict mode test - allows different variable names
result_lenient = compare_strings("$f(x)$", "$f(y)$", strict=False)
print(result_lenient)  # 1 - Structures are the same, non-strict mode returns equivalent

# Strictness comparison of complex expressions
expr1 = parse("$g(a, b) + h(a)$")
expr2 = parse("$g(x, y) + h(x)$")

# Strict mode
result_strict = verify(expr1, expr2, strict=True)
print(result_strict)  # False - Variable names are different

# Non-strict mode
result_lenient = verify(expr1, expr2, strict=False)
print(result_lenient)  # True - Structures are equivalent

# Numerical expressions are not affected by strict mode
result_numbers = compare_strings("$\\frac{1}{3}$", "$0.333333$", strict=True)
print(result_numbers)  # 1 - Numerical equivalence is not affected by strict mode

# Variable comparison in matrices
matrix1 = "$\\begin{pmatrix} x & y \\\\ z & w \\end{pmatrix}$"
matrix2 = "$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$"

result_strict = compare_strings(matrix1, matrix2, strict=True)
print(result_strict)  # 0 - Strict mode returns not equivalent

result_lenient = compare_strings(matrix1, matrix2, strict=False)
print(result_lenient)  # 1 - Non-strict mode returns equivalent

# Function structure comparison
func1 = "$\\sin(x) + \\cos(x)$"
func2 = "$\\sin(t) + \\cos(t)$"

result_strict = compare_strings(func1, func2, strict=True)
print(result_strict)  # 0

result_lenient = compare_strings(func1, func2, strict=False)
print(result_lenient)  # 1

# Test verification
assert compare_strings("$f(x)$", "$f(y)$", strict=True) == 0
assert compare_strings("$f(x)$", "$f(y)$", strict=False) == 1
```

### Node 13: Precision Control and Numerical Comparison

**Functionality**: Controls the precision of numerical comparisons, handles equivalence determination between floating-point numbers and fractions, and supports custom precision settings.

**Precision Parameters**:
- `precision`: Decimal place precision (default 6 digits)
- `float_rounding`: Floating-point rounding precision
- `numeric_precision`: Numerical computation precision (default 15 digits)

**Input/Output Examples**：

```python
from math_verify import parse, verify
from tests.test_all import compare_strings

# Basic precision test
result = compare_strings("$\\frac{1}{12}$", "$0.0833333333333333$", precision=6)
print(result)  # 1 - Equivalent within 6 decimal places

# Comparison at different precision levels
result_low = compare_strings("$\\frac{1}{3}$", "$0.33$", precision=2)
print(result_low)  # 1 - Equivalent within 2 decimal places

result_high = compare_strings("$\\frac{1}{3}$", "$0.33$", precision=6)
print(result_high)  # 0 - Not equivalent within 6 decimal places

# Coordinate precision comparison
coord1 = "$(1,\\frac{9}{2})$"
coord2 = "$(1,4.5)$"
result = compare_strings(coord1, coord2, precision=6)
print(result)  # 1 - Equivalent within 6 decimal places

# Matrix element precision comparison
matrix1 = "$(\\begin{pmatrix}\\frac{1}{3}\\\\ \\frac{1}{5} \\end{pmatrix})$"
matrix2 = "$\\begin{pmatrix}0.33\\\\0.2 \\end{pmatrix}$"
result = compare_strings(matrix1, matrix2, precision=2)
print(result)  # 1 - Equivalent within 2 decimal places

# Interval endpoint precision comparison
interval1 = "$(\\frac{3}{5},\\frac{8}{3}]$"
interval2 = "$(0.6,2.6667]$"
result = compare_strings(interval1, interval2, precision=2)
print(result)  # 1 - Equivalent within 2 decimal places

# Numerical validation of complex expressions
expr1 = "$\\frac{\\sqrt{\\sqrt{11}+\\sqrt{194}}}{15+2\\sqrt{33}}$"
expr2 = "$\\frac{\\sqrt{\\sqrt{11}+\\sqrt{194}}}{2\\sqrt{33}+15}$"
result = compare_strings(expr1, expr2, precision=6)
print(result)  # 1 - Algebraically equivalent

# Precision comparison between LaTeX and expressions
result = compare_strings("$\\frac{1}{3}$", "0.3333$", precision=4)
print(result)  # 1 - Equivalent within 4 decimal places

# Handling of special numerical values
result = compare_strings("$\\frac{34}{16}+\\frac{\\sqrt{1358}}{16}$", "$4$", precision=6)
print(result)  # 0 - Not equivalent

# Test cases from actual test files
test_cases = [
    ("$\\frac{1}{12}$", "$0.0833333333333333$", 1, 6),
    ("$(1,\\frac{9}{2})$", "$(1,4.5)$", 1, 6),
    ("$(\\begin{pmatrix}\\frac{1}{3}\\\\ \\frac{1}{5} \\end{pmatrix})$", "$\\begin{pmatrix}0.33\\\\0.2 \\end{pmatrix}$", 1, 2),
    ("$(\\frac{3}{5},\\frac{8}{3}]$", "$(0.6,2.6667]$", 1, 2),
]

for gold, pred, expected, prec in test_cases:
    result = compare_strings(gold, pred, precision=prec)
    assert result == expected
```

### Node 14: Error Handling and Edge Cases

**Functionality**: Handles various edge cases and erroneous inputs to ensure system robustness, including format errors, invalid inputs, parsing failures, and other scenarios.

**Handling Strategies**:
- Invalid character filtering
- Format error tolerance
- Empty input handling
- Fallback on parsing failure
- Graceful exception handling

**Input/Output Examples**：

```python
from math_verify import parse, verify
from tests.test_all import compare_strings

# Input with mixed invalid characters
result = parse("AZYUK2A")
print(result)  # [] or extract valid numbers

# Correct error handling - should fail to extract
result = compare_strings("2", "AZYUK2A", match_types=["expr"])
print(result)  # 0 - Correctly identifies as not matching

# Numerical value extraction from complex text
text = "and then Alice wins the game from that point on. The probability is (1/2) * (1/2) * P(A), P(A) = 2/3"
result = parse(text)
print(result)  # [Rational(2, 3)] - Correctly extracts final answer

# Correct identification of wrong answers
domain_text = "For the function q(x) to be defined... The domain is (0, 1)"
result = compare_strings("$[0,1)$", domain_text)
print(result)  # 0 - Correctly identifies as wrong answer ([0,1) vs (0,1))

# Answer extraction from long text
long_text = """Let's denote the common difference as d. Since the first term is 1, 
the sequence can be written as 1, 1+d, 1+2d, 1+3d, ... 
Therefore, there are 12 distinct arithmetic sequences."""
result = parse(long_text)
print(result)  # [12] - Extracts key numerical value from complex text

# Empty and invalid inputs
result = parse("")
print(result)  # [] - Empty input returns empty list

result = parse("No valid mathematical expression here")
print(result)  # [] - No mathematical expression returns empty list

# Malformed expressions
result = parse("$\\frac{incomplete")  # Incomplete LaTeX
print(result)  # [] or attempt to repair and parse

# Multiple nesting errors
result = parse("$\\frac{\\frac{\\frac{1}{2}")  # Multiple nesting but incomplete
print(result)  # [] or partial parsing result

# Special character handling
result = parse("Answer: €$%^&*()123.45")
print(result)  # [123.45] - Filters special characters and extracts number

# Edge case test scenarios
edge_cases = [
    ("2", "AZYUK2A", 0),  # Noise characters with number
    ("$[0,1)$", "domain is (0, 1)", 0),  # Wrong answer correctly identified
    ("$2/3$", "probability is 2/3", 1),  # Long text with correct extraction
    ("$12$", "there are 12 distinct sequences", 1),  # Text with numerical value extraction
]

for gold, pred, expected in edge_cases:
    result = compare_strings(gold, pred)
    print(f"Testing: {gold} vs {pred[:30]}... Expected: {expected}, Got: {result}")
    # assert result == expected  # Actual testing verifies
```

### Node 15: Reasoning Process Extraction Test

**Functionality**: Tests the system's ability to extract mathematical reasoning processes and final answers from long text, supporting step-by-step verification and intermediate step tracking.

**Extraction Strategies**:
- Keyword identification: Locates answers using keywords like "therefore", "finally", etc.
- Answer box recognition: Identifies `\boxed{}` environment as the final answer
- Last expression: Extracts the final expression in the reasoning chain
- Multi-line analysis: Coherent processing of expressions spanning multiple lines

**Input/Output Examples**：

```python
from math_verify import parse, verify
from math_verify import LatexExtractionConfig

def test_reasoning_extraction():
    print("==== Reasoning Process Extraction Test ====")
    
    # Sample reasoning process
    reasoning_text = """
    To find the value of x, I'll solve the equation x² - 5x + 6 = 0.
    
    First, I'll factor the equation:
    x² - 5x + 6 = 0
    (x - 2)(x - 3) = 0
    
    Therefore, x = 2 or x = 3.
    
    Since the problem asks for the smaller root, the answer is x = 2.
    """
    
    # Example of final answer in box
    boxed_answer = """
    Solving the quadratic equation:
    x² - 5x + 6 = 0
    (x - 2)(x - 3) = 0
    x = 2 or x = 3
    
    The answer is \boxed{x = 2}
    """
    
    # Multi-step calculation example
    multi_step = """
    The area of the triangle can be computed using:
    A = \frac{1}{2} bh
    
    Where b = 6 and h = 4, so:
    A = \frac{1}{2} \cdot 6 \cdot 4
    A = \frac{1}{2} \cdot 24
    A = 12
    """
    
    # Configure extractor
    standard_config = LatexExtractionConfig(try_extract_without_anchor=True)
    boxed_config = LatexExtractionConfig(boxed_match_priority=0, try_extract_without_anchor=True)
    
    # Test keyword-based extraction
    print("Keyword-based extraction test:")
    reasoning_result = parse(reasoning_text, [standard_config])
    print(f"Original reasoning:\n{reasoning_text}")
    print(f"Extraction result: {reasoning_result}")
    
    # Test boxed answer extraction
    print("\nBoxed answer extraction test:")
    boxed_result = parse(boxed_answer, [boxed_config])
    standard_result = parse(boxed_answer, [standard_config])
    print(f"Boxed result: {boxed_result}")
    print(f"Standard result: {standard_result}")
    
    # Test multi-step extraction
    print("\nMulti-step calculation extraction test:")
    multi_result = parse(multi_step, [standard_config])
    print(f"Original multi-step text:\n{multi_step}")
    print(f"Extraction result: {multi_result}")
    
    # Test last expression extraction
    # Create a special configuration for last expression extraction
    last_expr_config = LatexExtractionConfig(
        try_extract_without_anchor=True,
        extract_last_expression=True
    )
    
    last_result = parse(multi_step, [last_expr_config])
    print("\nLast expression extraction test:")
    print(f"Extraction result: {last_result}")

# Execute reasoning process extraction test
test_reasoning_extraction()
```

### Node 16: Special Case Tests

**Functionality**: Tests the system's ability to handle special mathematical structures and edge cases, verifying stability and accuracy with unconventional inputs.

**Special Case Types**:
- Complex numbers and imaginary units
- Infinity and limit representations
- Piecewise functions and conditional expressions
- Greek letters and special symbols
- Non-standard formats and shorthand notations

**输入输出示例**：

```python
from math_verify import parse, verify

def test_special_cases():
    print("==== Special Case Tests ====")
    
    # Complex number tests
    complex_tests = [
        "Answer: $2 + 3i$",
        "Value: $\\sqrt{-1}$",
        "Complex number: $e^{i\\pi}$",
        "Solution: $z = re^{i\\theta}$"
    ]
    
    print("Complex number tests:")
    for test in complex_tests:
        result = parse(test)
        print(f"  Input: {test}")
        print(f"  Parsed: {result}")
    
    # Infinity tests
    infinity_tests = [
        "Limit: $\\lim_{x \\to \\infty} \\frac{1}{x} = 0$",
        "Range: $(0, \\infty)$",
        "Value: $\\infty - \\infty$",
        "Expression: $\\frac{1}{0}$"
    ]
    
    print("\nInfinity tests:")
    for test in infinity_tests:
        try:
            result = parse(test)
            print(f"  Input: {test}")
            print(f"  Parsed: {result}")
        except Exception as e:
            print(f"  Input: {test}")
            print(f"  Error: {str(e)}")
    
    # Piecewise function tests
    piecewise_tests = [
        "Function: $f(x) = \\begin{cases} x^2 & x > 0 \\\\ 0 & x = 0 \\\\ -x^2 & x < 0 \\end{cases}$",
        "Expression: $|x| = \\begin{cases} x & x \\geq 0 \\\\ -x & x < 0 \\end{cases}$"
    ]
    
    print("\nPiecewise function tests:")
    for test in piecewise_tests:
        result = parse(test)
        print(f"  Input: {test}")
        print(f"  Parsed: {result}")
    
    # Greek letter tests
    greek_tests = [
        "Angle: $\\theta = \\pi/4$",
        "Sum: $\\sum_{i=1}^{n} \\alpha_i = \\beta$",
        "Parameter: $\\lambda = 2.5$"
    ]
    
    print("\nGreek letter tests:")
    for test in greek_tests:
        result = parse(test)
        print(f"  Input: {test}")
        print(f"  Parsed: {result}")

# Execute special case tests
test_special_cases()
```