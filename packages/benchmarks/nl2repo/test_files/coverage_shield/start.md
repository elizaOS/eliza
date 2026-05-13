# Coverage-Shield Project

## Project Introduction

Coverage-Shield is a command-line tool **for automating test coverage badges in Python projects**. It can run unit tests, generate coverage reports, and automatically update the coverage badges in the README file. This tool performs excellently in Python development projects, enabling "one-click coverage badge management and automatic updates". Its core functions include: parsing coverage reports (automatically running unittest or pytest and parsing coverage data), intelligently generating badges (automatically selecting colors based on the coverage percentage and generating shields.io badge URLs), and intelligently updating the README file (supporting regular expression matching and automatic file modification). In short, Coverage-Shield aims to provide a robust test coverage badge automation system to simplify the display and maintenance of test coverage in Python projects (for example, running tests and generating reports through the `run_code_coverage()` function, generating badge URLs through the `make_coverage_badge_url()` function, and automatically updating the README file through the `replace_regex_in_file()` function).

## Natural Language Instructions (Prompt)

Please create a Python project named Coverage-Shield to implement a test coverage badge automation command-line tool. The project should include the following functions:

1. **Coverage Report Generator**: It can run unit tests and generate coverage reports, supporting the unittest and pytest test frameworks. It should call the external coverage command through subprocess, parse the returned coverage data into a pandas DataFrame format, and calculate the average coverage percentage.

2. **Intelligent Badge Generator**: Implement a function that can automatically select colors based on the coverage percentage (using the seaborn color palette) and generate badge URLs that meet the shields.io standard. It should support badges for the success state (showing the specific coverage percentage) and the failure state (showing "failing").

3. **File Updater**: Intelligently update the README.md file, supporting regular expression matching to replace existing badges or automatically adding new badges at the beginning of the file. It should provide a .covignore file configuration in the .gitignore style to ignore the coverage calculation of specific files.

4. **Git Integration Module**: Implement Git operation integration, including checking the file change status, automatically staging, committing, and pushing the updated README file. It should provide an optional automatic commit function.

5. **Command-Line Interface**: Design independent command-line interfaces for each functional module to support terminal calls for testing. It should include the following parameters: -d/--directory (target directory), -r/--readme (README file path), -t/--tester (test framework selection), -g/--git_push (Git push option).

6. **Examples and Test Scripts**: Provide example code and test cases to demonstrate how to run tests and generate reports using the `run_code_coverage()` function, generate badge URLs using the `make_coverage_badge_url()` function, and update the README file using the `replace_regex_in_file()` function. It should include a complete unit test suite covering all core functional modules.

7. **Core File Requirements**: The project must include a well-defined setup.py file. This file should not only configure the project as an installable package (supporting pip install) but also declare a complete list of dependencies (including core libraries such as pandas, seaborn, coverage, setuptools, pre-commit, and pathlib). The setup.py file can verify whether all functional modules are working properly. At the same time, it is necessary to provide coverage_shield/__init__.py as a unified API entry point, importing the core functions `build_command_line_interface` and `run_code_coverage` from the `command_line_interface_functions` and `unittest_coverage_functions` modules, and providing version information so that users can access all major functions through a simple "python -m coverage_shield" statement. In unittest_coverage_functions.py, there should be a `parse_coverage_report()` function to parse the coverage report string, a `get_badge_colour()` function to select the badge color based on the coverage value, a `make_coverage_badge_url()` function to generate the complete badge URL, and a `replace_regex_in_file()` function to update the badge in the README file.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.12.4

### Core Dependency Library Versions

```Plain
cfgv            3.4.0
contourpy       1.3.3
coverage        7.10.4
cycler          0.12.1
distlib         0.4.0
filelock        3.19.1
fonttools       4.59.1
identify        2.6.13
iniconfig       2.1.0
kiwisolver      1.4.9
matplotlib      3.10.5
nodeenv         1.9.1
numpy           2.3.2
packaging       25.0
pandas          2.3.2
pathlib         1.0.1
pillow          11.3.0
pip             24.0
platformdirs    4.3.8
pluggy          1.6.0
pre_commit      4.3.0
Pygments        2.19.2
pyparsing       3.2.3
pytest          8.4.1
python-dateutil 2.9.0.post0
pytz            2025.2
PyYAML          6.0.2
seaborn         0.13.2
setuptools      72.1.0
six             1.17.0
subprocess.run  0.0.8
tzdata          2025.2
virtualenv      20.34.0
wheel           0.43.0
```

## Architecture of the Coverage-Shield Project

### Project Directory Structure

```Plain
workspace/
├── .covignore
├── .gitignore
├── .pre-commit-config.yaml
├── LICENSE
├── README.md
├── coverage_shield
│   ├── __init__.py
│   ├── __main__.py
│   ├── command_line_interface_functions.py
│   ├── git_functions.py
│   ├── unittest_coverage_functions.py
├── images
│   ├── logo.svg
└── setup.py

```

## API Usage Guide

### Core API

#### 1. Module Import

```python
from coverage_shield import (
    unittest_coverage_functions,
    git_functions,
    command_line_interface_functions,
    __main__
)
```

#### 2. run_code_coverage() Function - Coverage Report Generation

**Function**: Runs unit tests and generates coverage reports, supporting the unittest and pytest test frameworks.

**Function Signature**:
```python
def run_code_coverage(tester: str = "unittest") -> pd.DataFrame:
    """Runs coverage tool in command line and returns report

    Will send warning if running coverage package is failing and return empty dataframe

    Returns:
        pd.DataFrame : coverage report as dataframe if coverage passing; empty dataframe if coverage failing
    """

    # Check tester option provided
    tester_options = ["unittest", "pytest"]
    if not tester in tester_options:
        raise ValueError(f"The tester option provided ({tester}) was not recognised. Must be one of: {tester_options.join(', ')}")

    # Run code coverage calculation
    # Check out useful subprocess function docs: https://www.datacamp.com/tutorial/python-subprocess
    coverage_command = [
        "python3",
        "-m",
        "coverage",
        "run",
        "--source=.",
        "-m",
        tester,
    ]
    command_result = subprocess.run(coverage_command, capture_output=True, text=True)

    # Check the result
    if command_result.returncode == 0:  # Passing

        # Show result from command
        # - For some reason unit testing progress sent to standard error
        # - Any prints from unit tests sent to standard output so ignoring these for the moment
        print(command_result.stderr)

        # Generate the report
        report_command = ["python3", "-m", "coverage", "report"]
        try:
            coverage_report = subprocess.check_output(report_command, text=True)

        except subprocess.CalledProcessError as error:
            print(
                f"Generating coverage report command ({' '.join(report_command)}) failed! Return code: {error.returncode}"
            )

        # Get patterns to ignore
        patterns_to_ignore = load_patterns_to_ignore_in_coverage()

        # Convert coverage report output to dataframe
        report_dataframe = parse_coverage_report(coverage_report, patterns_to_ignore)

    else:
        warnings.warn(
            f"Running coverage package command ({' '.join(coverage_command)}) failed! Return code: {command_result.returncode}. 
Error Output:
{command_result.stderr}"
        )

        report_dataframe = pd.DataFrame()

    return report_dataframe
```

**Parameter Description**:
- `tester (str)`: Test framework selection, supporting "unittest" or "pytest", defaulting to "unittest"

**Return Value**: A coverage report in the pandas DataFrame format, or an empty DataFrame if the test fails

#### 3. parse_coverage_report() Function - Coverage Report Parsing

**Function**: Parses the coverage report string and converts it into a pandas DataFrame format.

**Function Signature**:
```python
def parse_coverage_report(
    coverage_report_string: str, patterns_to_ignore: [str] = None
) -> pd.DataFrame:
    """Parses byte string returned by coverage report into pandas dataframe

    Args:
        coverage_report_string (bytes): string version of coverage report

    Returns:
        pd.DataFrame: coverage report as dataframe
    """

    # Convert the byte string into pandas dataframe
    coverage_dataframe = pd.read_csv(StringIO(coverage_report_string), sep="\s+")

    # Remove empty rows
    coverage_dataframe = coverage_dataframe[1:-2]
    coverage_dataframe = coverage_dataframe.reset_index(drop=True)

    # Remove percent sign from coverage column and convert to float
    coverage_dataframe.Cover = coverage_dataframe.Cover.str[:-1].astype(float)

    # Check if any patterns to ignore
    if not patterns_to_ignore == None:
        patterns_to_ignore = "|".join(patterns_to_ignore)
        coverage_dataframe = coverage_dataframe[
            ~coverage_dataframe.Name.str.contains(patterns_to_ignore)
        ]

    return coverage_dataframe
```

**Parameter Description**:
- `coverage_report_string (str)`: Coverage report string
- `patterns_to_ignore ([str])`: List of file patterns to ignore, defaulting to None

**Return Value**: The processed coverage DataFrame

#### 4. get_badge_colour() Function - Badge Color Selection

**Function**: Automatically selects the badge color based on the coverage percentage.

**Function Signature**:
```python
def get_badge_colour(
    value: float,
    colour_palette: str = "RdYlGn",
) -> str:
    """Gets coverage badger colour based on value and thresholds

    Args:
        value (float): coverage value
        colour_palette (str): name of colour palette to use (see: https://holypython.com/python-visualization-tutorial/colors-with-python/)

    Returns:
        str: colour for badge
    """

    # Create colour palette
    # Note shields io accepts hex colours (without hash!)
    # (as well as many other formats! https://shields.io/badges)
    palette = list(seaborn.color_palette(colour_palette, 100).as_hex())

    # Get colour for value
    value_index = round(value) - 1 if value >= 0.5 else 0
    badge_colour = palette[value_index]

    return badge_colour
```

**Parameter Description**:
- `value (float)`: Coverage percentage value
- `colour_palette (str)`: Name of the color palette, defaulting to "RdYlGn"

**Return Value**: A hexadecimal color code string

#### 5. make_coverage_badge_url() Function - Badge URL Generation

**Function**: Generates a coverage badge URL that meets the shields.io standard.

**Function Signature**:
```python
def make_coverage_badge_url(
    coverage_dataframe: pd.DataFrame | str,
    failing_colour: str = "red",
) -> str:
    """Uses shields io to build coverage badge

    Args:
        coverage_dataframe (pd.DataFrame | str): coverage report as dataframe. If coverage failed this will be string ("failing")
        failing_colour (str, optional): colour of badge when failing. Defaults to "red".

    Returns:
        str: shields io badge url
    """

    # Check if coverage report available
    if not coverage_dataframe.empty:

        # Calculate the average code coverage
        total_statements = sum(coverage_dataframe.Stmts)
        total_statements_missed = sum(coverage_dataframe.Miss)
        average_coverage = (
            total_statements - total_statements_missed
        ) / total_statements

        # Convert to percentage and round
        average_coverage = round(average_coverage * 100, 1)

        # Note badger colour
        badge_colour = get_badge_colour(average_coverage)

        # Build badge
        badge_url = f"https://img.shields.io/badge/coverage-{average_coverage}%25-{badge_colour[1:]}"

    else:

        # Build badge
        badge_url = f"https://img.shields.io/badge/coverage-failing-{failing_colour}"

    return badge_url

```

**Parameter Description**:
- `coverage_dataframe`: Coverage report DataFrame. If it is empty, a failure state badge will be generated.
- `failing_colour (str)`: Color of the failure state badge, defaulting to "red"

**Return Value**: A complete shields.io badge URL string

#### 6. replace_regex_in_file() Function - File Content Update

**Function**: Updates the badge content in the file using regular expressions.

**Function Signature**:
```python
def replace_regex_in_file(
    file_path: Path, pattern_regex: str, replacement: str, add_to_file: bool = True
):
    """Replace pattern in file with string

    Note if pattern not present this will add string to first line by default

    Args:
        file_path (Path): path to file
        pattern_regex (str): pattern to find
        replacement (str): string to replace pattern when found
        add_to_file (bool): if regex not present will add to top of file if True. Defaults to True
    """

    # Read in file contents
    file_lines = []
    with open(file_path) as file:
        file_lines = file.read().splitlines()

    # Check if badge present
    badge_present = any(bool(re.match(pattern_regex, line)) for line in file_lines)
    if (badge_present == False) & add_to_file:
        # If not add at top
        file_lines.insert(0, replacement)

    else:
        # If it is, update
        file_lines = [re.sub(pattern_regex, replacement, line) for line in file_lines]

    # Write file lines back to file
    with open(file_path, "w") as file:
        file.write("
".join(file_lines) + "
")

```

**Parameter Description**:
- `file_path (Path)`: Path to the target file
- `pattern_regex (str)`: Regular expression pattern to match
- `replacement (str)`: Replacement content
- `add_to_file (bool)`: Whether to add to the beginning of the file if the pattern is not found, defaulting to True

#### 7. load_patterns_to_ignore_in_coverage() Function - Ignored Pattern Loading

**Function**: Loads the file patterns to be ignored from the .covignore file.

**Function Signature**:
```python
def load_patterns_to_ignore_in_coverage(file_path: Path = Path(".covignore")) -> [str]:
    """Loads patterns from simple text file lines into list

    Note file is like .gitignore so each line represents a pattern to ignore. Commented lines
    can start with hash (#) and empty lines are ignored.
    Args:
        file_path (Path): path to file containing patterns

    Returns:
        [list] : list of patterns to ignore
    """

    # Check if file exists
    if file_path.is_file():

        # Get the file lines from the file
        file_lines = []
        with open(file_path) as file:
            file_lines = file.read().splitlines()

        # Ignore comment or empty lines
        file_lines = [line for line in file_lines if not line.startswith("#")]

        # Remove empty values
        file_lines = list(filter(None, file_lines))

        # Check if no lines present
        file_lines = None if len(file_lines) == 0 else file_lines

        return file_lines

    else:
        return None
```

**Parameter Description**:
- `file_path (Path)`: Path to the .covignore file, defaulting to ".covignore"

**Return Value**: A list of ignored patterns, or None if the file does not exist

### Git Integration API

#### 8. check_if_file_changed_using_git() Function - Git Status Check

**Function**: Checks if the specified file has changed in the Git repository.

**Function Signature**:
```python
def check_if_file_changed_using_git(file_path: Path) -> bool:
    """Use git to check if file provided has changed in repo

    Args:
        file_path (Path): path to file that want to check

    Raises:
        subprocess.CalledProcessError: throws error if git status command fails

    Returns:
        bool: True if files have changed and False otherwise
    """
    # Run git status command
    command_result = send_command(
        "git", "status", str(file_path), capture_output=True, text=True
    )

    # Check if ran ok
    if command_result.returncode == 0:  # Passing

        # Check if there is anything to commit
        if "nothing to commit" in command_result.stdout:
            return False
    else:
        raise subprocess.CalledProcessError(
            returncode=command_result.returncode,
            cmd=command_result.args,
            output=command_result.stdout,
            stderr=command_result.stderr,
        )

    # If got to here there must be changes to commit
    return True
```

**Parameter Description**:
- `file_path (Path)`: Path to the file to be checked

**Return Value**: A boolean value. True indicates that the file has changed, and False indicates that there are no changes.

#### 9. push_updated_readme() Function - Git Automatic Commit and Push

**Function**: Automatically stages, commits, and pushes the updated README file.

**Function Signature**:
```python
def push_updated_readme(
    readme_path: Path = Path("README.md"), commit_and_push: bool = True
):
    """Uses git to stage, commit, and push changes to README.md (updated badge)

    Args:
        readme_path (Path, optional): path to README.md file. Defaults to Path("README.md").
        commit_and_push (bool, optional): whether to push changes or not. Defaults to True.
    """

    # Check if updated README changed
    if check_if_file_changed_using_git(readme_path):

        # Convert file path to string
        readme_path_str = str(readme_path)

        # Stage the changes (updated badge)
        send_command("git", "add", readme_path_str)

        # Check if committing and pushing
        if commit_and_push:

            # Commit changes
            commit_message = f"Updated coverage badge in {readme_path}"
            send_command("git", "commit", "-m", commit_message)

            # Push changes
            send_command("git", "push")

```

**Parameter Description**:
- `readme_path (Path)`: Path to the README file, defaulting to "README.md"
- `commit_and_push (bool)`: Whether to perform the commit and push operations, defaulting to True

#### 10. send_command() Function - Command Execution

**Function**: A general function for executing system commands.

**Function Signature**:
```python
def send_command(*args, **kwargs):

    # Run the command
    result = subprocess.run(args, check=True, **kwargs)
    return result
```

**Parameter Description**:
- `*args`: List of command parameters
- `**kwargs`: Additional parameters passed to subprocess.run()

**Return Value**: A subprocess.CompletedProcess object

### Command-Line Interface API

#### 11. build_command_line_interface() Function - Command-Line Interface Construction

**Function**: Builds a command-line parameter parser.

**Function Signature**:
```python
def build_command_line_interface() -> argparse.ArgumentParser:
    """Builds command line interface for coverage_shield package

    Adds the following arguments:
    - Target directory: -d/--directory
    - Target README: -r/--readme
    - Push changes: -g/--git_push

    Returns:
        argparse.ArgumentParser: argument parser
    """

    # Write welcome message
    welcome_message = "Welcome to coverage_shield! A tool to create and maintain a python package unit test coverage badge in README.md"

    # Initialize parser
    parser = argparse.ArgumentParser(
        prog="coverage_shield",
        description=welcome_message,
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,  # Shows default values for parameters
    )

    # Add arguments
    parser.add_argument(
        "-d",
        "--directory",
        nargs="?",  # Accept 0 or 1 arguments
        default=".",  # Default value
        metavar="directory",
        type=str,
        help="Provide path to directory to run coverage_shield in.",
    )
    parser.add_argument(
        "-r",
        "--readme",
        nargs="?",  # Accept 0 or 1 arguments
        default="README.md",  # Default value
        metavar="readme_path",
        type=str,
        help="Provide path to README.md relative to directory provided.",
    )
    parser.add_argument(
        "-t",
        "--tester",
        nargs="?",  # Accept 0 or 1 arguments
        default="unittest",  # Default value
        metavar="tester",
        type=str,
        help="Provide name of unit test python package you want to use. Accepts either "unittest" or "pytest"",
    )
    parser.add_argument(
        "-g",
        "--git_push",
        action="store_true",
        help="Stage, commit, and push the updated README file (-r/--readme) using git.",
    )

    return parser
```

**Return Value**: A configured argparse.ArgumentParser object

**Supported Parameters**:
- `-d/--directory`: Path to the target directory, defaulting to the current directory "."
- `-r/--readme`: Path to the README file, defaulting to "README.md"
- `-t/--tester`: Test framework selection, supporting "unittest" or "pytest", defaulting to "unittest"
- `-g/--git_push`: Git push option. Use this flag to enable automatic commit and push.

#### 12. parse_command_line_arguments() Function - Command-Line Parameter Parsing

**Function**: Parses command-line parameters and performs corresponding operations.

**Function Signature**:
```python
def parse_command_line_arguments(
    parser: argparse.ArgumentParser,
    arguments: list[str] = sys.argv[1:],
    testing: bool = False,
):
    """Parse command line arguments based on parser provided

    Args:
        parser (argparse.ArgumentParser): command line argument parser
        arguments (list[str]): list of command line arguments passed to parser.parse_args(), which isn't
            required normally but this means we can unittest
            (see: https://stackoverflow.com/questions/18160078/how-do-you-write-tests-for-the-argparse-portion-of-a-python-module).
            Defaults to sys.argv[:1] (arguments minus script name).
        testing (bool): check if running unit tests as don't want to run coverage package if we are. Defaults to False.
    """

    # Get arguments
    args = parser.parse_args(arguments)

    # Check if running unittests
    if not testing:

        # Set target directory
        os.chdir(args.directory)

        # Run coverage package (which runs unit tests and generates report)
        coverage_dataframe = unittest_coverage_functions.run_code_coverage(args.tester)

        # Build the badge url
        coverage_badge_url = unittest_coverage_functions.make_coverage_badge_url(
            coverage_dataframe
        )

        # Update badge in README
        unittest_coverage_functions.replace_regex_in_file(
            file_path=Path(args.directory, args.readme),
            pattern_regex=r"\!\[Code Coverage\]\(.+\)",
            replacement=f"![Code Coverage]({coverage_badge_url})",
        )

        # Check if pushing changes
        if args.git_push:

            # Stage, commit, and push updated README
            git_functions.push_updated_readme(
                readme_path=Path(args.directory, args.readme)
            )

    else:
        return args

```

**Parameter Description**:
- `parser (argparse.ArgumentParser)`: Command-line parameter parser
- `arguments (list[str])`: List of command-line parameters, defaulting to sys.argv[1:]
- `testing (bool)`: Whether it is in test mode, defaulting to False

### Actual Usage Modes

#### Basic Usage

```python
def test_make_coverage_badge_url(self):
        """Test that shields io coverage badge url created correctly"""

        # Create dummy coverage report data in string
        report_string = "Name                                        Stmts   Miss  Cover
---------------------------------------------------------------
setup.py                                        3      3     0%
tests/__init__.py                               1      0   100%
tests/test_data_functions.py                   19      1    95%
tests/test_timesheet.py                        46      1    98%
tests/test_unittest_coverage_functions.py      13      1    92%
timesheet/__init__.py                           2      0   100%
timesheet/data_functions.py                    32      2    94%
timesheet/timesheet.py                         53      1    98%
timesheet/unittest_coverage_functions.py       41     23    44%
update_test_coverage_badge.py                   8      8     0%
---------------------------------------------------------------
TOTAL                                         218     40    82%
"

        # Parse the report byte string
        coverage_dataframe = unittest_coverage_functions.parse_coverage_report(
            report_string
        )

        # Create badge url
        badge_url = unittest_coverage_functions.make_coverage_badge_url(
            coverage_dataframe
        )

        # Note expected badge colour
        palette = list(seaborn.color_palette("RdYlGn", 100).as_hex())
        coverage_value = 81.7
        badge_colour = palette[round(coverage_value) - 1]

        # Check url
        self.assertEqual(
            badge_url,
            f"https://img.shields.io/badge/coverage-{coverage_value}%25-{badge_colour[1:]}",
            "Check expected shields io badger url produced",
        )

```

#### Configured Usage

```python
def test_check_if_file_changed_using_git(self):

        # Create a temporary file
        temporary_file_path = Path("test_git_file_changed.txt")
        file_lines = ["I", "am", "a", "really", "simple", "file", "
"]
        with open(temporary_file_path, "w") as file:
            file.write("
".join(file_lines))

        # Check whether file changed by git
        self.assertTrue(
            git_functions.check_if_file_changed_using_git(temporary_file_path),
            "Check file changed recognised by git",
        )

        # Remove temporary file
        Path.unlink(temporary_file_path)
```


## Detailed Function Implementation Nodes

### Node 1: Coverage Report Parsing and Standardization (Coverage Report Parsing & Normalization)

**Function Description**: Processes various coverage report formats and standardizes them into an analyzable DataFrame format. It supports complex scenarios such as the unittest and pytest test frameworks, coverage data cleaning, and ignored pattern filtering.

**Core Algorithms**:
- Parsing of the coverage report string
- Conversion to the pandas DataFrame format
- Removal of percentage signs and numerical conversion
- Filtering of ignored patterns using regular expressions
- Cleaning of empty lines and invalid data

**Input-Output Example**:

```python
def test_parse_coverage_report(self):
        """Test parse of coverage byte string into coverage report"""

        # Create dummy coverage report data in string
        report_string = "Name                                        Stmts   Miss  Cover
---------------------------------------------------------------
setup.py                                        3      3     0%
tests/__init__.py                               1      0   100%
tests/test_data_functions.py                   19      1    95%
tests/test_timesheet.py                        46      1    98%
tests/test_unittest_coverage_functions.py      13      1    92%
timesheet/__init__.py                           2      0   100%
timesheet/data_functions.py                    32      2    94%
timesheet/timesheet.py                         53      1    98%
timesheet/unittest_coverage_functions.py       41     23    44%
update_test_coverage_badge.py                   8      8     0%
---------------------------------------------------------------
TOTAL                                         218     40    82%
"

        # Parse the report byte string
        coverage_dataframe = unittest_coverage_functions.parse_coverage_report(
            report_string
        )

        # Check dataframe returned
        self.assertEqual(
            str(type(coverage_dataframe)),
            "<class 'pandas.core.frame.DataFrame'>",
            "Check start_time column contains datetimes",
        )

        # Check correct columns are present
        column_names = ["Name", "Stmts", "Miss", "Cover"]
        self.assertTrue(
            all(
                [
                    column_name in coverage_dataframe.columns
                    for column_name in column_names
                ]
            ),
            "Check expected columns present after parsing coverage report",
        )

        # Check some selected values
        self.assertEqual(
            coverage_dataframe.Cover[1],
            float("100.0"),
            "Check second value in Cover column",
        )
        self.assertEqual(
            coverage_dataframe.Name[2],
            "tests/test_data_functions.py",
            "Check third value in Name column",
        )
        self.assertEqual(
            coverage_dataframe.Stmts[7],
            float("53.0"),
            "Check eighth value in Stmts column",
        )
```

### Node 2: Intelligent Badge Color Selection (Intelligent Badge Color Selection)

**Function Description**: Automatically selects the most appropriate badge color based on the coverage percentage. It uses the seaborn color palette to achieve gradient color mapping, supporting custom color schemes and failure state handling.

**Core Algorithms**:
- Mapping of the coverage percentage to the color index
- Generation of colors from the seaborn color palette
- Conversion to hexadecimal color codes
- Failure state color fallback mechanism
- Handling of color boundary values

**Input-Output Example**:

```python
def test_get_badge_colour(self):
        """Test that correct badger colour returned"""

        # Note expected badge colours
        palette = list(seaborn.color_palette("RdYlGn", 100).as_hex())
        coverage_values = [0, 1, 10, 50, 81.7, 99.1, 100]
        value_colour_indices = [
            round(value) - 1 if value >= 0.5 else 0 for value in coverage_values
        ]
        badge_colours = [palette[index] for index in value_colour_indices]

        # Check badge colour for different values
        for value, colour in zip(coverage_values, badge_colours):

            self.assertEqual(
                colour,
                unittest_coverage_functions.get_badge_colour(value=value),
                f"Checking getting badge colour for value = {value} (should be {colour})",
            )

```

### Node 3: Badge URL Generation and Formatting (Badge URL Generation & Formatting)

**Function Description**: Generates a coverage badge URL that meets the shields.io standard, supporting the display of the specific coverage percentage in the success state and error information in the failure state.

**Core Algorithms**:
- Calculation of the average coverage
- Filling of the badge URL template
- Generation of the failure state URL
- Formatting of the color code
- Control of the percentage precision

**Input-Output Example**:

```python
def test_make_coverage_badge_url(self):
        """Test that shields io coverage badge url created correctly"""

        # Create dummy coverage report data in string
        report_string = "Name                                        Stmts   Miss  Cover
---------------------------------------------------------------
setup.py                                        3      3     0%
tests/__init__.py                               1      0   100%
tests/test_data_functions.py                   19      1    95%
tests/test_timesheet.py                        46      1    98%
tests/test_unittest_coverage_functions.py      13      1    92%
timesheet/__init__.py                           2      0   100%
timesheet/data_functions.py                    32      2    94%
timesheet/timesheet.py                         53      1    98%
timesheet/unittest_coverage_functions.py       41     23    44%
update_test_coverage_badge.py                   8      8     0%
---------------------------------------------------------------
TOTAL                                         218     40    82%
"

        # Parse the report byte string
        coverage_dataframe = unittest_coverage_functions.parse_coverage_report(
            report_string
        )

        # Create badge url
        badge_url = unittest_coverage_functions.make_coverage_badge_url(
            coverage_dataframe
        )

        # Note expected badge colour
        palette = list(seaborn.color_palette("RdYlGn", 100).as_hex())
        coverage_value = 81.7
        badge_colour = palette[round(coverage_value) - 1]

        # Check url
        self.assertEqual(
            badge_url,
            f"https://img.shields.io/badge/coverage-{coverage_value}%25-{badge_colour[1:]}",
            "Check expected shields io badger url produced",
        )

```

### Node 4: Intelligent File Content Update (Intelligent File Content Update)

**Function Description**: Uses regular expressions to intelligently update the coverage badge in the README file, supporting pattern matching replacement and adding a new badge at the beginning of the file.

**Core Algorithms**:
- Regular expression pattern matching
- Line-level processing of the file content
- Detection of the badge existence
- Logic for inserting at the beginning of the file
- Content replacement and writing

**Input-Output Example**:

```python
def test_replace_regex_in_file(self):
        """Test replacing of pattern in file with string"""

        # Create temporary file
        temporary_file_path = Path("test_README.md")
        file_lines = ["I", "am", "a", "really", "simple", "file", "
"]
        with open(temporary_file_path, "w") as file:
            file.write("
".join(file_lines))

        # Replace string in temporary file
        unittest_coverage_functions.replace_regex_in_file(
            file_path=temporary_file_path, pattern_regex=r"s.m.+e", replacement="great"
        )

        # Read in temporary file lines
        file_lines = []
        with open(temporary_file_path) as file:
            file_lines = file.read().splitlines()

        # Check temporary file lines have changed
        self.assertEqual(
            file_lines[4],
            "great",
            "Check string was replaced in file",
        )

        # Remove temporary file
        Path.unlink(temporary_file_path)
```

### Node 5: Git Operation Automation (Git Operations Automation)

**Function Description**: Automates the Git operation process, including file change detection, automatic staging, committing, and pushing of the updated README file.

**Core Algorithms**:
- Git status check
- File change detection
- Automatic staging operation
- Generation of the commit message
- Execution of the remote push

**Input-Output Example**:

```python
def test_check_if_file_changed_using_git(self):

        # Create a temporary file
        temporary_file_path = Path("test_git_file_changed.txt")
        file_lines = ["I", "am", "a", "really", "simple", "file", "
"]
        with open(temporary_file_path, "w") as file:
            file.write("
".join(file_lines))

        # Check whether file changed by git
        self.assertTrue(
            git_functions.check_if_file_changed_using_git(temporary_file_path),
            "Check file changed recognised by git",
        )

        # Remove temporary file
        Path.unlink(temporary_file_path)
```

### Node 6: Command-Line Interface Construction (Command Line Interface Construction)

**Function Description**: Builds a flexible command-line parameter parser, supporting various parameter combinations and default value handling, and providing detailed help information.

**Core Algorithms**:
- Construction of the argparse parameter parser
- Parameter type validation
- Setting of default values
- Generation of help information
- Error handling mechanism

**Input-Output Example**:

```python
def test_build_command_line_interface(self):
        """Test command line parser is built"""

        # Build the command line interface parser
        parser = command_line_interface_functions.build_command_line_interface()

        # Check argument parser returned
        self.assertEqual(
            str(type(parser)),
            "<class 'argparse.ArgumentParser'>",
            "Check argument parser returned",
        )
```

### Node 7: Coverage Test Execution and Monitoring (Coverage Test Execution & Monitoring)

**Function Description**: Executes coverage tests and monitors the test process, supporting automatic switching between multiple test frameworks and handling test failures and coverage calculation errors.

**Core Algorithms**:
- Automatic detection and switching of the test framework
- Monitoring of the coverage command execution
- Handling of the test failure state
- Monitoring of the coverage report generation
- Capture and analysis of the error output

**Input-Output Example**:

```python
def test_parse_coverage_report(self):
        """Test parse of coverage byte string into coverage report"""

        # Create dummy coverage report data in string
        report_string = "Name                                        Stmts   Miss  Cover
---------------------------------------------------------------
setup.py                                        3      3     0%
tests/__init__.py                               1      0   100%
tests/test_data_functions.py                   19      1    95%
tests/test_timesheet.py                        46      1    98%
tests/test_unittest_coverage_functions.py      13      1    92%
timesheet/__init__.py                           2      0   100%
timesheet/data_functions.py                    32      2    94%
timesheet/timesheet.py                         53      1    98%
timesheet/unittest_coverage_functions.py       41     23    44%
update_test_coverage_badge.py                   8      8     0%
---------------------------------------------------------------
TOTAL                                         218     40    82%
"

        # Parse the report byte string
        coverage_dataframe = unittest_coverage_functions.parse_coverage_report(
            report_string
        )

        # Check dataframe returned
        self.assertEqual(
            str(type(coverage_dataframe)),
            "<class 'pandas.core.frame.DataFrame'>",
            "Check start_time column contains datetimes",
        )

        # Check correct columns are present
        column_names = ["Name", "Stmts", "Miss", "Cover"]
        self.assertTrue(
            all(
                [
                    column_name in coverage_dataframe.columns
                    for column_name in column_names
                ]
            ),
            "Check expected columns present after parsing coverage report",
        )

        # Check some selected values
        self.assertEqual(
            coverage_dataframe.Cover[1],
            float("100.0"),
            "Check second value in Cover column",
        )
        self.assertEqual(
            coverage_dataframe.Name[2],
            "tests/test_data_functions.py",
            "Check third value in Name column",
        )
        self.assertEqual(
            coverage_dataframe.Stmts[7],
            float("53.0"),
            "Check eighth value in Stmts column",
        )
```

### Node 8: Configuration File Parsing and Management (Configuration File Parsing & Management)

**Function Description**: Parses and manages the .covignore configuration file, supporting comment filtering, empty line handling, and multi-pattern matching, and providing flexible coverage ignoring rules.

**Core Algorithms**:
- Checking of the configuration file existence
- Filtering of the comment lines
- Cleaning of empty lines and invalid content
- Standardization of the pattern list
- Validation of the configuration file format

**Input-Output Example**:

```python
def test_load_patterns_to_ignore_in_coverage(self):

        # Create temporary file
        temporary_file_path = Path("test.covignore")
        file_lines = [
            "ignore",
            "
",
            "# Ignore this comment",
            "
",
            "this",
            "
",
            "pattern",
            "
",
        ]
        with open(temporary_file_path, "w") as file:
            file.write("
".join(file_lines))

        # Load the patterns from temp file
        patterns = unittest_coverage_functions.load_patterns_to_ignore_in_coverage(
            file_path=temporary_file_path
        )

        # Check patterns loaded correctly
        self.assertEqual(
            patterns[0],
            "ignore",
            "Check pattern read in",
        )
        self.assertEqual(
            patterns[1],
            "this",
            "Check pattern read in",
        )
        self.assertEqual(
            patterns[2],
            "pattern",
            "Check pattern read in",
        )
        self.assertEqual(
            len(patterns),
            3,
            "Check correct number of patterns loaded",
        )

        # Remove temporary file
        Path.unlink(temporary_file_path)
```

### Node 9: Main Program Entry Point Management (Main Program Entry Point Management)

**Function Description**: Manages the main entry point of the program, coordinating the execution flow of each functional module and providing a unified program startup interface.

**Core Algorithms**:
- Passing of command-line parameters
- Coordinated invocation between modules
- Program flow control
- Unified management of error handling
- Handling of the exit status code

**Input-Output Example**:

```python
# Load packages
import unittest  # running tests
from pathlib import Path  # handling file paths

# Local imports
from coverage_shield import (
    __main__,
)  # functions for running coverage


class TestMain(unittest.TestCase):
    def test_main(self):

        # Testing that sending --help parameter into main causes system exit (after printing help message)
        with self.assertRaises(SystemExit):
            __main__.main(["--help"])


if __name__ == "__main__":
    unittest.main()

```
