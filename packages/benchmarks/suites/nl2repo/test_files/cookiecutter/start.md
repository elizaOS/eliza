## Introduction and Objectives of the Cookiecutter Project

Cookiecutter is a **Python command-line tool for project template generation** that can quickly create standardized project structures from predefined project templates (cookiecutters). This tool performs excellently in the Python ecosystem and cross-language project development, achieving "the highest development efficiency and optimal project standardization." Its core functions include: templated project generation (supporting templates from local directories, remote Git repositories, and ZIP files), **intelligent variable substitution and user interaction** (using the Jinja2 template engine to generate dynamic content and allow user-defined configurations), and the complete replication and customization of complex project structures (including nested directories, preservation of file permissions, and handling of binary files). In short, Cookiecutter aims to provide a powerful and flexible project scaffolding system for quickly generating standardized project structures (for example, generating projects from templates using the `cookiecutter()` function, defining user interaction variables through `cookiecutter.json`, and implementing custom logic before and after generation using the hooks system).

## Natural Language Instructions (Prompt) 

Please create a Python project named Cookiecutter to implement a project template generation tool. The project should include the following functions:

1. **Template Repository Management**: Implement the function of obtaining project templates from multiple sources, such as local directories, remote Git repositories, and ZIP files. It should support cloning template repositories, cache management, version checkout (checking out specific branches or tags), and automatic discovery and verification of template directories (ensuring the presence of the `cookiecutter.json` configuration file).

2. **User Interaction System**: Implement a complete user interaction function, including text input prompts, yes/no selections, multi-option lists, dictionary/JSON input, etc. It should support setting default values, input validation, custom prompt messages, and the automatic use of default values in non-interactive mode (no_input).

3. **Template Rendering Engine**: Implement file content rendering based on the Jinja2 template engine, supporting advanced functions such as variable substitution, conditional statements, loop structures, and filters. It should correctly handle binary files (copy directly) and text files (copy after rendering), while preserving file permissions and directory structures.

4. **Context Generation and Management**: Implement the generation, merging, and overriding mechanisms for template contexts. It should support loading default configurations from `cookiecutter.json`, overriding with user configuration files, overriding with command-line parameters, and passing contexts for nested templates.

5. **Hook System**: Implement the discovery and execution mechanisms for pre-prompt, pre-generation, and post-generation hooks. It should support both Python scripts and Shell scripts as hooks, provide context variable passing, and handle cases where hook execution fails.

6. **Replay Function**: Implement the function of saving and replaying user inputs, supporting the saving of user configurations as JSON files and automatic loading in subsequent uses for batch project generation and configuration reuse.

7. **Command-Line Interface**: Provide a complete command-line interface, supporting parameterized calls for all core functions, including parameters such as template paths, output directories, configuration options, and hook control.

8. **Error Handling and Logging**: Implement a comprehensive exception handling mechanism, including handling cases such as template non-existence, configuration errors, rendering failures, and hook execution failures, and provide detailed log output and error information.

9. **Configuration Management**: Implement the loading, parsing, and management of user configuration files, supporting configuration items such as abbreviation definitions, default template directories, and replay directories.

10. **File Operation Tools**: Provide auxiliary tools for file system operations, including directory creation, file copying, permission setting, and temporary directory management.

11. **Core File Requirements**: The project must include a complete `pyproject.toml` file. This file should not only configure the project as an installable package (supporting `pip install`) but also declare a complete list of dependencies (including core libraries such as `jinja2>=3.0.0`, `click>=8.0.0`, `binaryornot>=0.4.4`, `rich>=10.0.0`, `pytest>=6.0.0`, `pytest-cov>=2.0.0`). The `pyproject.toml` file can verify whether all functional modules work properly. Additionally, 'cookiecutter/__init__.py' needs to serve as a unified API entry point to import and export core functions, classes, etc. from the 'cookiecutter' module, and provide version information, allowing users to access all major functions through simple statements such as 'from cookiecutter import xxx'. In `generate.py`, the `generate_context()` function is required to generate the template context, and the `generate_files()` function is required to render and generate project files. In `prompt.py`, the `prompt_for_config()` function is required to handle user interaction, and functions such as `read_user_variable()`, `read_user_choice()`, `read_user_yes_no()` are required to handle different types of user inputs. In `hooks.py`, the `run_hook()` function is required to execute hook scripts, and the `find_hook()` function is required to discover hook files. In `repository.py`, the `determine_repo_dir()` function is required to determine the template repository directory, supporting multiple template sources such as local paths, Git URLs, and ZIP files. In the `config.py` file, the DEFAULT configuration must be included.


## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.13.4

### Core Dependency Library Versions

```Plain
annotated-types       0.7.0
anyio                 4.10.0
arrow                 1.3.0
Authlib               1.6.1
binaryornot           0.4.4
cachetools            6.1.0
certifi               2025.8.3
cffi                  1.17.1
cfgv                  3.4.0
chardet               5.2.0
charset-normalizer    3.4.3
click                 8.2.1
colorama              0.4.6
coverage              7.10.4
cryptography          45.0.6
distlib               0.4.0
dparse                0.6.4
filelock              3.16.1
freezegun             1.5.5
h11                   0.16.0
httpcore              1.0.9
httpx                 0.28.1
identify              2.6.13
idna                  3.10
iniconfig             2.1.0
Jinja2                3.1.6
joblib                1.5.1
markdown-it-py        4.0.0
MarkupSafe            3.0.2
marshmallow           4.0.0
mdurl                 0.1.2
nltk                  3.9.1
nodeenv               1.9.1
packaging             25.0
pip                   25.1.1
platformdirs          4.3.8
pluggy                1.6.0
pre_commit            4.3.0
psutil                6.1.1
pycparser             2.22
pydantic              2.9.2
pydantic_core         2.23.4
Pygments              2.19.2
pyproject-api         1.9.1
pytest                8.4.1
pytest-cov            6.2.1
pytest-mock           3.14.1
python-dateutil       2.9.0.post0
python-slugify        8.0.4
PyYAML                6.0.2
regex                 2025.7.34
requests              2.32.5
rich                  14.1.0
ruamel.yaml           0.18.15
ruamel.yaml.clib      0.2.12
safety                3.6.0
safety-schemas        0.0.14
setuptools            80.9.0
shellingham           1.5.4
six                   1.17.0
sniffio               1.3.1
tenacity              9.1.2
text-unidecode        1.3
tomlkit               0.13.3
tox                   4.27.0
tqdm                  4.67.1
typer                 0.16.1
types-python-dateutil 2.9.0.20250809
typing_extensions     4.14.1
urllib3               2.5.0
virtualenv            20.34.0
```

## Cookiecutter Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .bandit
├── .gitattributes
├── .gitignore
├── .pre-commit-config.yaml.old
├── .readthedocs.yaml
├── .safety-policy.yml
├── AUTHORS.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── HISTORY.md
├── LICENSE
├── MANIFEST.in
├── Makefile
├── README.md
├── __main__.py
├── codecov.yml
├── cookiecutter
│   ├── VERSION.txt
│   ├── __init__.py
│   ├── __main__.py
│   ├── cli.py
│   ├── config.py
│   ├── environment.py
│   ├── exceptions.py
│   ├── extensions.py
│   ├── find.py
│   ├── generate.py
│   ├── hooks.py
│   ├── log.py
│   ├── main.py
│   ├── prompt.py
│   ├── replay.py
│   ├── repository.py
│   ├── utils.py
│   ├── vcs.py
│   ├── zipfile.py
├── docs
│   ├── AUTHORS.md
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── HISTORY.md
│   ├── README.md
│   ├── __init__.py
│   ├── _templates
│   │   ├── package.rst_t
│   ├── advanced
│   │   ├── boolean_variables.rst
│   │   ├── calling_from_python.rst
│   │   ├── choice_variables.rst
│   │   ├── copy_without_render.rst
│   │   ├── dict_variables.rst
│   │   ├── directories.rst
│   │   ├── hooks.rst
│   │   ├── human_readable_prompts.rst
│   │   ├── index.rst
│   │   ├── injecting_context.rst
│   │   ├── jinja_env.rst
│   │   ├── local_extensions.rst
│   │   ├── nested_config_files.rst
│   │   ├── new_line_characters.rst
│   │   ├── private_variables.rst
│   │   ├── replay.rst
│   │   ├── suppressing_prompts.rst
│   │   ├── template_extensions.rst
│   │   ├── templates.rst
│   │   ├── templates_in_context.rst
│   │   ├── user_config.rst
│   ├── case_studies.md
│   ├── cli_options.rst
│   ├── conf.py
│   ├── cookiecutter.rst
│   ├── index.rst
│   ├── installation.rst
│   ├── overview.rst
│   ├── requirements.txt
│   ├── troubleshooting.rst
│   ├── tutorials
│   │   ├── index.rst
│   │   ├── tutorial1.rst
│   │   ├── tutorial2.rst
│   ├── usage.rst
├── justfile
├── logo
│   ├── cookiecutter-logo-large.png
│   ├── cookiecutter-logo.svg
│   ├── cookiecutter_medium.png
├── pyproject.toml
└── uv.lock


```

---

## API Usage Guide

### Core API

#### 1. Module Import

```python
# Core module imports
from cookiecutter import replay, exceptions, main, repository, vcs, utils, zipfile, generate, find, config, hooks, environment, prompt, extensions, log
from cookiecutter import __init__, __main__

# Configuration imports
from cookiecutter.config import get_user_config, get_config, merge_configs, _expand_path, USER_CONFIG_PATH, BUILTIN_ABBREVIATIONS, DEFAULT_CONFIG
from cookiecutter.repository import expand_abbreviations, is_repo_url, is_zip_file, repository_has_cookiecutter_json, determine_repo_dir, REPO_REGEX
from cookiecutter.exceptions import CookiecutterException, NonTemplatedInputDirException, UnknownTemplateDirException, MissingProjectDir, ConfigDoesNotExistException, InvalidConfiguration, UnknownRepoType, VCSNotInstalled, ContextDecodingException, OutputDirExistsException, EmptyDirNameException, InvalidModeException, FailedHookException, UndefinedVariableInTemplate, UnknownExtension, RepositoryNotFound, RepositoryCloneFailed, InvalidZipRepository

from cookiecutter.cli import main, version_msg, validate_extra_context, list_installed_templates
from cookiecutter.environment import StrictEnvironment, ExtensionLoaderMixin
from cookiecutter.main import cookiecutter, _patch_import_path_for_repo
from cookiecutter.utils import create_env_with_context, force_delete, rmtree, make_sure_path_exists, work_in, make_executable, simple_filter, create_tmp_repo_dir
from cookiecutter.prompt import YesNoPrompt, JsonPrompt, read_repo_password, read_user_choice, process_json, read_user_dict, read_user_variable, read_user_yes_no, DEFAULT_DISPLAY, _Raw, render_variable, _prompts_from_options, prompt_choice_for_template, prompt_choice_for_config, prompt_for_config, choose_nested_template, prompt_and_delete

from cookiecutter.log import configure_logger, LOG_LEVELS, LOG_FORMATS
from cookiecutter.hooks import valid_hook, find_hook, run_script, run_script_with_context, run_hook, run_hook_from_repo_dir, run_pre_prompt_hook, _HOOKS, EXIT_SUCCESS
from cookiecutter.generate import is_copy_only_path, apply_overwrites_to_context, generate_context, generate_file, render_and_create_dir, _run_hook_from_repo_dir, generate_files

from cookiecutter.find import find_template
from cookiecutter.replay import get_file_name, dump, load
from cookiecutter.vcs import identify_repo, is_vcs_installed, clone, BRANCH_ERRORS
from cookiecutter.zipfile import unzip
from cookiecutter.extensions import JsonifyExtension, RandomStringExtension, SlugifyExtension, UUIDExtension, TimeExtension
```

#### 2. cookiecutter() Function - Main Entry for Project Generation

**Function**: Generate a complete project structure from a project template, coordinating all modules to complete the project generation process. Run Cookiecutter just as if using it from the command line.

**Function Signature**:
```python
def cookiecutter(
    template: str,
    checkout: str | None = None,
    no_input: bool = False,
    extra_context: dict[str, Any] | None = None,
    replay: bool | str | None = None,
    overwrite_if_exists: bool = False,
    output_dir: str = '.',
    config_file: str | None = None,
    default_config: bool = False,
    password: str | None = None,
    directory: str | None = None,
    skip_if_file_exists: bool = False,
    accept_hooks: bool = True,
    keep_project_on_failure: bool = False,
) -> str:
```

**Parameter Description**:
- `template` (str): A directory containing a project template directory or a URL to a git repository.
- `checkout` (str | None): The branch, tag or commit ID to checkout after clone.
- `no_input` (bool): Do not prompt for user input. Use default values for template parameters taken from `cookiecutter.json`, user config and `extra_dict`. Force a refresh of cached resources.
- `extra_context` (dict):  A dictionary of context that overrides default and user configuration.
- `replay` (bool | str): Do not prompt for input, instead read from saved json. If ``True`` read from the ``replay_dir``. if it exists.
- `overwrite_if_exists` (bool): Overwrite the contents of the output directory if it exists.
- `output_dir` (str): Where to output the generated project dir into.
- `config_file` (str): User configuration file path.
- `default_config` (bool): Use default values rather than a config file.
- `password` (str): The password to use when extracting the repository.
- `directory` (str): Relative path to a cookiecutter template in a repository.
- `skip_if_file_exists` (bool): Skip the files in the corresponding directories if they already exist.
- `accept_hooks` (bool): Accept pre and post hooks if set to `True`.
- `keep_project_on_failure` (bool): If `True` keep generated project directory even when generation fails.

**Return Value**: Path to the generated project directory.

#### 3. generate_context() Function - Template Context Generation

**Function**: Generate the template context from the `cookiecutter.json` file, handling configuration merging and overriding.

**Function Signature**:
```python
def generate_context(
    context_file: str = 'cookiecutter.json',
    default_context: dict[str, Any] | None = None,
    extra_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
```

**Parameter Description**:
- `context_file` (str): JSON file containing key/value pairs for populating the cookiecutter's variables.
- `default_context` (dict): Dictionary containing config to take into account.
- `extra_context` (dict): Dictionary containing configuration overrides.

**Return Value**: Merged context dictionary.

#### 4. generate_files() Function - File Generation and Rendering

**Function**: Render the templates and saves them to files.

**Function Signature**:
```python
def generate_files(
    repo_dir: Path | str,
    context: dict[str, Any] | None = None,
    output_dir: Path | str = '.',
    overwrite_if_exists: bool = False,
    skip_if_file_exists: bool = False,
    accept_hooks: bool = True,
    keep_project_on_failure: bool = False,
) -> str:
```

**Parameter Description**:
- `repo_dir` (Path | str): Project template input directory.
- `context` (dict): Dict for populating the template's variables.
- `output_dir` (Path | str): Where to output the generated project dir into.
- `overwrite_if_exists` (bool): Overwrite the contents of the output directory if it exists.
- `skip_if_file_exists` (bool): Skip the files in the corresponding directories if they already exist.
- `accept_hooks` (bool):  Accept pre and post hooks if set to `True`.
- `keep_project_on_failure` (bool): If `True` keep generated project directory even when generation fails.

**Return Value**: Path to the generated project directory.

#### 5. generate_file() - Single File Generation

**Function**: Render filename of infile as name of outfile, handle infile correctly.If infile is a binary file, copy it over without rendering. If infile is a text file, render its contents and write the rendered infile to outfile. When calling `generate_file()`, the root template dir must be the current working directory. Using `utils.work_in()` is the recommended way to perform this directory change.

**Function Signature**:
```python
def generate_file(
    project_dir: str,
    infile: str,
    context: dict[str, Any],
    env: Environment,
    skip_if_file_exists: bool = False,
) -> None:
```

**Parameter Description**:
- `project_dir` (str): Absolute path to the resulting generated project.
- `infile` (str): Input file to generate the file from. Relative to the root template dir.
- `context` (dict[str, Any]): Dict for populating the cookiecutter's variables.
- `env` (Environment): Jinja2 template execution environment.
- `skip_if_file_exists` (bool): Whether to skip if the output file already exists.

**Return Value**: None.

#### 6. find_template() - Template Directory Discovery

**Function**: Determine which child directory of ``repo_dir`` is the project template.

**Function Signature**:
```python
def find_template(repo_dir: Path | str, env: Environment) -> Path:
```

**Parameter Description**:
- `repo_dir` (Path | str): Local directory of newly cloned repo.
- `env` (Environment): Jinja2 environment for rendering directory names.

**Return Value**: Relative path to project template.

#### 7. prompt_for_config() Function - User Interaction Handling

**Function**: Prompt user to enter a new config.

**Function Signature**:
```python
def prompt_for_config(
    context: dict[str, Any], 
    no_input: bool = False
) -> OrderedDict[str, Any]:
```

**Parameter Description**:
- `context` (dict): Source for field names and sample values.
- `no_input` (bool): Do not prompt for user input and use only values from context.

**Return Value**: Dictionary of user input configurations.

#### 8. determine_repo_dir() Function - Template Repository Location

**Function**: Locate the repository directory from a template reference. Applies repository abbreviations to the template reference. If the template refers to a repository URL, clone it. If the template is a path to a local repository, use it. Raise `RepositoryNotFound` if a repository directory could not be found.

**Function Signature**:
```python
def determine_repo_dir(
    template: str,
    abbreviations: dict[str, str],
    clone_to_dir: Path | str,
    checkout: str | None,
    no_input: bool,
    password: str | None = None,
    directory: str | None = None,
) -> tuple[str, bool]:
```

**Parameter Description**:
- `template` (str): A directory containing a project template directory or a URL to a git repository.
- `abbreviations` (dict): A dictionary of repository abbreviation definitions.
- `clone_to_dir` (Path | str): The directory to clone the repository into.
- `checkout` (str | None): The branch, tag or commit ID to checkout after clone.
- `no_input` (bool): Do not prompt for user input and eventually force a refresh of cached resources.
- `password` (str): The password to use when extracting the repository.
- `directory` (str): Directory within repo where cookiecutter.json lives.

**Return Value**: A tuple containing the cookiecutter template directory, and a boolean describing whether that directory should be cleaned up after the template has been instantiated.

#### 9. read_user_variable() - Text Input

**Function**: Prompt user for variable and return the entered value or given default.

**Function Signature**:
```python
def read_user_variable(
    var_name: str, 
    default_value, 
    prompts=None, 
    prefix: str = ""
):
```

**Parameter Description**:
- `var_name` (str): Variable of the context to query the user.
- `default_value`: Value that will be returned if no input happens.
- `prompts`: Dictionary of prompt messages.
- `prefix` (str): Prompt prefix.

**Return Value**: User-input variable value.

#### 10. read_user_choice() - Selection Input

**Function**: Prompt the user to choose from several options for the given variable. The first item will be returned if no input happens.

**Function Signature**:
```python
def read_user_choice(
    var_name: str, 
    options: list, 
    prompts=None, 
    prefix: str = ""
):
```

**Parameter Description**:
- `var_name` (str): Variable as specified in the context.
- `options` (list): Sequence of options that are available to select from.
- `prompts`: Dictionary of prompt messages.
- `prefix` (str): Prompt prefix.

**Return Value**: Exactly one item of ``options`` that has been chosen by the user.

#### 11. read_user_yes_no() - Yes/No Input

**Function**: Prompt the user to reply with 'yes' or 'no' (or equivalent values).

**Function Signature**:
```python
def read_user_yes_no(
    var_name, 
    default_value, 
    prompts=None, 
    prefix: str = ""
):
```

**Parameter Description**:
- `var_name`: Variable name.
- `default_value`: Value that will be returned if no input happens
- `prompts`: Dictionary of prompt messages.
- `prefix` (str): Prompt prefix.

**Return Value**: Boolean value indicating the user's yes/no choice.

#### 12. read_user_dict() - Dictionary Input

**Function**: Prompt the user to provide a dictionary of data.

**Function Signature**:
```python
def read_user_dict(
    var_name: str, 
    default_value, 
    prompts=None, 
    prefix: str = ""
):
```

**Parameter Description**:
- `var_name` (str): Variable as specified in the context.
- `default_value`: Value that will be returned if no input is provided.
- `prompts`: Dictionary of prompt messages.
- `prefix` (str): Prompt prefix.

**Return Value**: A Python dictionary to use in the context.

#### 13. run_hook() - Hook Execution

**Function**: Try to find and execute a hook from the specified project directory.

**Function Signature**:
```python
def run_hook(
    hook_name: str, 
    project_dir: Path | str, 
    context: dict[str, Any]
) -> None:
```

**Parameter Description**:
- `hook_name` (str): The hook to execute.
- `project_dir` (Path | str): The directory to execute the script from.
- `context` (dict[str, Any]): Cookiecutter project context.

**Return Value**: None.

#### 14. find_hook() - Hook Discovery

**Function**: Return a dict of all hook scripts provided. Must be called with the project template as the current working directory. Dict's key will be the hook/script's name, without extension, while values will be the absolute path to the script. Missing scripts will not be included in the returned dict.

**Function Signature**:
```python
def find_hook(
    hook_name: str, 
    hooks_dir: str = 'hooks'
) -> list[str] | None:
```

**Parameter Description**:
- `hook_name` (str): The hook to find.
- `hooks_dir` (str): The hook directory in the template.

**Return Value**: The absolute path to the hook script or None. 

#### 15. dump() - Configuration Saving

**Function**: Write json data to file.

**Function Signature**:
```python
def dump(
    replay_dir: Path | str, 
    template_name: str, 
    context: dict[str, Any]
) -> None:
```

**Parameter Description**:
- `replay_dir` (Path | str): Path to the replay directory.
- `template_name` (str): Template name.
- `context` (dict[str, Any]): Context to be saved, must contain the 'cookiecutter' key.

**Return Value**: None.

#### 16. load() - Configuration Loading

**Function**: Read json data from file.

**Function Signature**:
```python
def load(
    replay_dir: Path | str, 
    template_name: str
) -> dict[str, Any]:
```

**Parameter Description**:
- `replay_dir` (Path | str): Path to the replay directory.
- `template_name` (str): Template name.

**Return Value**: Dictionary of loaded context configurations.

#### 17. get_file_name() - Get Replay File Name

**Function**: Get the name of file.

**Function Signature**:
```python
def get_file_name(replay_dir: Path | str, template_name: str) -> str:
```

**Parameter Description**:
- `replay_dir` (Path | str): Path to the replay directory.
- `template_name` (str): Template name (automatically adds .json suffix if not present).

**Return Value**: Full path to the replay file.

#### 18. apply_overwrites_to_context() - Context Override

**Function**: Modify the given context in place based on the overwrite_context.

**Function Signature**:
```python
def apply_overwrites_to_context(
    context: dict[str, Any],
    overwrite_context: dict[str, Any],
    *,
    in_dictionary_variable: bool = False,
) -> None:
```

**Parameter Description**:
- `context` (dict[str, Any]): The context dictionary to be modified in place.
- `overwrite_context` (dict[str, Any]): The overwrite values to apply.
- `in_dictionary_variable` (bool): Whether we're processing variables inside a dictionary context.

**Return Value**: None (modifies context in place).

#### 19. get_user_config() - User Configuration Retrieval

**Function**: Return the user config as a dict. If ``default_config`` is True, ignore ``config_file`` and return default values for the config parameters. If ``default_config`` is a dict, merge values with default values and return them for the config parameters. If a path to a ``config_file`` is given, that is different from the default location, load the user config from that. Otherwise look up the config file path in the ``COOKIECUTTER_CONFIG`` environment variable. If set, load the config from this path. This will raise an error if the specified path is not valid. If the environment variable is not set, try the default config file path before falling back to the default config values.

**Function Signature**:
```python
def get_user_config(
    config_file: str | None = None,
    default_config: bool | dict[str, Any] = False,
) -> dict[str, Any]:
```

**Parameter Description**:
- `config_file` (str): Path to the configuration file.
- `default_config` (bool | dict): Whether to use default configurations or a custom configuration dictionary.

**Return Value**: Dictionary of user configurations.

#### 20. configure_logger() Function - Logging Setup

**Function**: Configure logging for cookiecutter. Set up logging to stdout with given level. If ``debug_file`` is given set up logging to file with DEBUG level.

**Function Signature**:
```python
def configure_logger(
    stream_level: str = 'DEBUG',
    debug_file: str | None = None,
) -> logging.Logger:
```

**Parameter Description**:
- `stream_level` (str): Console output level; must be one of `LOG_LEVELS` keys: `'DEBUG'|'INFO'|'WARNING'|'ERROR'|'CRITICAL'`.
- `debug_file` (str | None): Optional debug log file path; if provided, adds a file handler using `DEBUG` level and `LOG_FORMATS['DEBUG']`.

**Return Value**: Python `logging.Logger` instance (name `cookiecutter`).

**Usage Example**:
```python
from cookiecutter.log import configure_logger

logger = configure_logger(stream_level='INFO')
logger.info('Project generation started')

# Also write DEBUG logs to a file
logger = configure_logger('DEBUG', debug_file='./cookiecutter.debug.log')
logger.debug('Detailed debug information')
```

#### 21. LOG_LEVELS - Constant

**Description**: Map log level names to values used by Python `logging`.

```python
LOG_LEVELS = {
    'DEBUG': logging.DEBUG,
    'INFO': logging.INFO,
    'WARNING': logging.WARNING,
    'ERROR': logging.ERROR,
    'CRITICAL': logging.CRITICAL,
}
```

#### 22. LOG_FORMATS - Constant

**Description**: Log output formats for different stream levels.

```python
LOG_FORMATS = {
    'DEBUG': '%(levelname)s %(name)s: %(message)s',
    'INFO': '%(levelname)s: %(message)s',
}
```

#### 23. USER_CONFIG_PATH - Constant

**Description**: Default user config file path.

```python
USER_CONFIG_PATH = os.path.expanduser('~/.cookiecutterrc')
```

#### 24. _HOOKS - Constant

**Description**: Supported hook names.

```python
_HOOKS = [
    'pre_prompt',
    'pre_gen_project',
    'post_gen_project',
]
```

#### 25. EXIT_SUCCESS - Constant

**Description**: Exit status code for a successful hook.

```python
EXIT_SUCCESS = 0
```

#### 26. DEFAULT_DISPLAY - Constant

**Description**: Default display label used by `read_user_dict` prompt.

```python
DEFAULT_DISPLAY = 'default'
```

#### 27. REPO_REGEX - Constant

**Description**: Regex to detect repository URLs (VERBOSE mode).

```python
REPO_REGEX = re.compile(
    r"""
# something like git:// ssh:// file:// etc.
((((git|hg)\+)?(git|ssh|file|https?):(//)?)
 |                                      # or
 (\w+@[\w\.]+)                          # something like user@...
)
""",
    re.VERBOSE,
)
```

#### 28. BRANCH_ERRORS - Constant

**Description**: Error message fragments for VCS branch checkout failures.

```python
BRANCH_ERRORS = [
    'error: pathspec',
    'unknown revision',
]
```

#### 29. version_msg() - Version Info

**Function**: Return the Cookiecutter version, location and Python powering it.

```python
def version_msg() -> str:
```

#### 30. validate_extra_context() - Extra Context Validation

**Function**: Validate extra context.

```python
def validate_extra_context(
    _ctx: Context, _param: Parameter, value: Iterable[str]
) -> OrderedDict[str, str] | None:
```

**Parameter Description**:
- `_ctx` (Context): Click context object (unused).
- `_param` (Parameter): Click parameter object (unused).
- `value` (Iterable[str]): Collection of key=value strings from CLI.

**Return Value**: Ordered dictionary of validated key-value pairs, or None if no values provided.

#### 31. list_installed_templates() - List Installed Templates

**Function**: List installed (locally cloned) templates. Use cookiecutter --list-installed.

```python
def list_installed_templates(
    default_config: bool | dict[str, Any],
    passed_config_file: str | None,
) -> None:
```

**Parameter Description**:
- `default_config` (bool | dict[str, Any]): Whether to use default config or config dictionary.
- `passed_config_file` (str | None): Path to configuration file, or None.

**Return Value**: None (prints template list to stdout).

#### 32. _expand_path() - Path Expansion

**Function**: Expand both environment variables and user home in the given path.

```python
def _expand_path(path: str) -> str:
```

**Parameter Description**:
- `path` (str): Path string to expand.

**Return Value**: Expanded path with environment variables and user home resolved.

#### 33. is_copy_only_path() - Copy-Without-Render Check

**Function**: Check whether the given `path` should only be copied and not rendered.

```python
def is_copy_only_path(path: str, context: dict[str, Any]) -> bool:
```

**Parameter Description**:
- `path` (str): A file-system path referring to a file or dir that should be rendered or just copied.
- `context` (dict[str, Any]): cookiecutter context.

**Return Value**: Returns True if `path` matches a pattern in the given `context` dict, otherwise False.

#### 34. render_and_create_dir() - Render and Create Directory

**Function**: Render name of a directory, create the directory, return its path.

```python
def render_and_create_dir(
    dirname: str,
    context: dict[str, Any],
    output_dir: Path | str,
    environment: Environment,
    overwrite_if_exists: bool = False,
) -> tuple[Path, bool]:
```

**Parameter Description**:
- `dirname` (str): Directory name template to render.
- `context` (dict[str, Any]): Template context for rendering.
- `output_dir` (Path | str): Base output directory path.
- `environment` (Environment): Jinja2 environment for template rendering.
- `overwrite_if_exists` (bool): Whether to overwrite existing directories.

**Return Value**: Tuple of (created directory path, whether directory was newly created).

#### 35. _run_hook_from_repo_dir() - Deprecated Wrapper

**Function**: Run hook from repo directory, clean project directory if hook fails.

```python
def _run_hook_from_repo_dir(
    repo_dir: str,
    hook_name: str,
    project_dir: Path | str,
    context: dict[str, Any],
    delete_project_on_failure: bool,
) -> None:
```

**Parameter Description**:
- `repo_dir` (str): Project template input directory.
- `hook_name` (str): The hook to execute.
- `project_dir` (Path | str): The directory to execute the script from.
- `context` (dict[str, Any]): Cookiecutter project context.
- `delete_project_on_failure` (bool): Whether to delete project directory on hook failure.

**Return Value**: None (deprecated function, forwards to `cookiecutter.hooks.run_hook_from_repo_dir`).

#### 36. valid_hook() - Hook File Validation

**Function**: Determine if a hook file is valid.

```python
def valid_hook(hook_file: str, hook_name: str) -> bool:
```

**Parameter Description**:
- `hook_file` (str): The hook file to consider for validity
- `hook_name` (str): The hook to find.

**Return Value**: The hook file validity.

#### 38. run_pre_prompt_hook() - Pre-Prompt Hook

**Function**: Run pre_prompt hook from repo directory.

```python
def run_pre_prompt_hook(repo_dir: Path | str) -> Path | str:
```

**Parameter Description**:
- `repo_dir` (Path | str): Project template input directory.

**Return Value**: Repository directory path (possibly a temporary directory if pre_prompt hook created one).

#### 39. render_variable() - Render Variable

**Function**: Render the next variable to be displayed in the user prompt. Inside the prompting taken from the cookiecutter.json file, this renders the next variable. For example, if a project_name is "Peanut Butter
Cookie", the repo_name could be be rendered with: `{{ cookiecutter.project_name.replace(" ", "_") }}`. This is then presented to the user as the default.

```python
def render_variable(
    env: Environment,
    raw: _Raw,
    cookiecutter_dict: dict[str, Any],
) -> str:
```

**Parameter Description**:
- `env` (Environment): Jinja2 environment for template rendering.
- `raw` (_Raw): Raw variable value to render.
- `cookiecutter_dict` (dict[str, Any]): Template context dictionary.

**Return Value**: Rendered string value of the variable.

#### 40. _prompts_from_options() - Options to Friendly Prompts

**Function**: Process template options and return friendly prompt information.

```python
def _prompts_from_options(options: dict) -> dict:
```

**Parameter Description**:
- `options` (dict): Dictionary of template options with titles and descriptions.

**Return Value**: Dictionary mapping option keys to human-readable prompt labels.

#### 41. prompt_choice_for_template() - Template Choice

**Function**: Prompt user with a set of options to choose from.

```python
def prompt_choice_for_template(
    key: str, options: dict, no_input: bool
) -> OrderedDict[str, Any]:
```

**Parameter Description**:
- `key` (str): Template selection key.
- `options` (dict): Available template options.
- `no_input` (bool): Do not prompt for user input and return the first available option.

**Return Value**: Ordered dictionary containing the selected template configuration.

#### 42. prompt_choice_for_config() - Config Choice

**Function**: Prompt user with a set of options to choose from.

```python
def prompt_choice_for_config(
    cookiecutter_dict: dict[str, Any],
    env: Environment,
    key: str,
    options,
    no_input: bool,
    prompts=None,
    prefix: str = "",
) -> OrderedDict[str, Any] | str:
```

**Parameter Description**:
- `cookiecutter_dict` (dict[str, Any]): Template context dictionary.
- `env` (Environment): Jinja2 environment for template rendering.
- `key` (str): Configuration key to prompt for.
- `options`: Available configuration options.
- `no_input` (bool): Do not prompt for user input and return the first available option.
- `prompts`: Dictionary of human-readable prompt messages.
- `prefix` (str): Prompt prefix string.

**Return Value**: Selected configuration value or ordered dictionary of choices.

#### 43. choose_nested_template() - Choose Nested Template

**Function**: Prompt user to select the nested template to use.

```python
def choose_nested_template(
    context: dict[str, Any],
    repo_dir: Path | str,
    no_input: bool = False,
) -> str:
```

**Parameter Description**:
- `context` (dict[str, Any]): Source for field names and sample values.
- `repo_dir` (Path | str): Repository directory.
- `no_input` (bool): Do not prompt for user input and use only values from context.

**Return Value**: Path to the selected template.

#### 44. prompt_and_delete() - Prompt and Delete

**Function**: Ask user if it's okay to delete the previously-downloaded file/directory. If yes, delete it. If no, checks to see if the old version should be reused. If yes, it's reused; otherwise, Cookiecutter exits.

```python
def prompt_and_delete(path: Path | str, no_input: bool = False) -> bool:
```

**Parameter Description**:
- `path` (Path | str): Previously downloaded zipfile.
- `no_input` (bool): Suppress prompt to delete repo and just delete it.

**Return Value**: True if the content was deleted.

#### 45. simple_filter() - Simple Jinja Filter Decorator

**Function**: Decorate a function to wrap it in a simplified jinja2 extension.

```python
def simple_filter(filter_function) -> type[Extension]:
```

**Parameter Description**:
- `filter_function`: Function to be wrapped as a Jinja2 filter.

**Return Value**: Extension class type that can be registered with Jinja2.

#### 46. identify_repo() - Identify Repo Type

**Function**: Determine if `repo_url` should be treated as a URL to a git or hg repo. Repos can be identified by prepending "hg+" or "git+" to the repo URL.

```python
def identify_repo(repo_url: str) -> tuple[Literal["git", "hg"], str]:
```

**Parameter Description**:
- `repo_url` (str): Repo URL of unknown type.

**Return Value**: ('git', repo_url), ('hg', repo_url), or None.

#### 47. is_vcs_installed() - Check VCS Availability

**Function**: Check if the version control system for a repo type is installed.

```python
def is_vcs_installed(repo_type: str) -> bool:
```

**Parameter Description**:
- `repo_type` (str): Type of version control system to check (e.g., 'git', 'hg').

**Return Value**: True if the VCS client is installed and available, False otherwise.

#### 48. unzip() - Unzip Repository Archive

**Function**: Download and unpack a zipfile at a given URI. This will download the zipfile to the cookiecutter repository, and unpack into a temporary directory.

```python
def unzip(
    zip_uri: str,
    is_url: bool,
    clone_to_dir: Path | str = ".",
    no_input: bool = False,
    password: str | None = None,
) -> str:
```

**Parameter Description**:
- `zip_uri` (str): The URI for the zipfile.
- `is_url` (bool): Is the zip URI a URL or a file?
- `clone_to_dir` (Path | str): The cookiecutter repository directory to put the archive into.
- `no_input` (bool): Do not prompt for user input and eventually force a refresh of cached resources.
- `password` (str | None): The password to use when unpacking the repository.

**Return Value**: Path to the extracted repository directory.

#### 49. _get_version() - Read Version

**Function**: Read VERSION.txt and return its contents.

```python
def _get_version() -> str:
```

**Parameter Description**: None.

**Return Value**: Version string read from VERSION.txt file.

#### 50. force_delete() - Force File Deletion

**Function**: Error handler for `shutil.rmtree()` equivalent to `rm -rf`.

**Function Signature**:
```python
def force_delete(func, path, _exc_info) -> None:
```

**Parameter Description**:
- `func` (Callable): The function that failed to delete the file/directory.
- `path` (str): The path to the file/directory that couldn't be deleted.
- `_exc_info` (tuple): Exception information (unused but required by the callback interface).

**Return Value**: None.

**Usage Example**:
```python
import shutil
from cookiecutter.utils import force_delete

# Use as error handler for rmtree
shutil.rmtree(path, onerror=force_delete)
```

#### 51. get_config() - Load Configuration File

**Function**: Retrieve the config from the specified path, returning a config dict.

**Function Signature**:
```python
def get_config(config_path: Path | str) -> dict[str, Any]:
```

**Parameter Description**:
- `config_path` (Path | str): Path to the configuration file.

**Return Value**: Dictionary of configuration merged with defaults.

#### 52. merge_configs() - Merge Configuration Dictionaries

**Function**: Recursively update a dict with the key/value pair of another. Dict values that are dictionaries themselves will be updated, whilst preserving existing keys.

**Function Signature**:
```python
def merge_configs(default: dict[str, Any], overwrite: dict[str, Any]) -> dict[str, Any]:
```

**Parameter Description**:
- `default` (dict[str, Any]): Base configuration dictionary.
- `overwrite` (dict[str, Any]): Configuration to merge in.

**Return Value**: New merged configuration dictionary.

#### 53. run_script() - Execute Script

**Function**: Execute a script from a working directory.

**Function Signature**:
```python
def run_script(script_path: str, cwd: Path | str = '.') -> None:
```

**Parameter Description**:
- `script_path` (str): Absolute path to the script to run.
- `cwd` (Path | str): The directory to run the script from.

**Return Value**: None.

#### 54. run_script_with_context() - Execute Script with Context

**Function**: Execute a script after rendering it with Jinja.

**Function Signature**:
```python
def run_script_with_context(
    script_path: Path | str, 
    cwd: Path | str, 
    context: dict[str, Any]
) -> None:
```

**Parameter Description**:
- `script_path` (Path | str): Absolute path to the script to run.
- `cwd` (Path | str): The directory to run the script from.
- `context` (dict[str, Any]): Cookiecutter project template context.

**Return Value**: None.

#### 55. process_json() - Parse JSON Input

**Function**: Load user-supplied value as a JSON dict.

**Function Signature**:
```python
def process_json(user_value: str) -> dict[str, Any]:
```

**Parameter Description**:
- `user_value` (str): User-supplied value to load as a JSON dict.

**Return Value**: Parsed Python dictionary.

#### 56. read_repo_password() - Repository Password Prompt

**Function**: Prompt the user to enter a password.

**Function Signature**:
```python
def read_repo_password(question: str) -> str:
```

**Parameter Description**:
- `question` (str): Question to the user.

**Return Value**: User-entered password string.

#### 57. rmtree() - Remove Directory Tree

**Function**: Remove a directory and all its contents. Like rm -rf on Unix.

**Function Signature**:
```python
def rmtree(path: Path | str) -> None:
```

**Parameter Description**:
- `path` (Path | str): A directory path.

**Return Value**: None.

#### 58. make_sure_path_exists() - Ensure Directory Exists

**Function**: Ensure that a directory exists.

**Function Signature**:
```python
def make_sure_path_exists(path: Path | str) -> None:
```

**Parameter Description**:
- `path` (Path | str): A directory tree path for creation.

**Return Value**: None.

#### 59. work_in() - Context Manager for Directory Change

**Function**: Context manager version of os.chdir. When exited, returns to the working directory prior to entering.

**Function Signature**:
```python
def work_in(dirname: Path | str | None = None) -> Iterator[None]:
```

**Parameter Description**:
- `dirname` (Path | str | None): Directory to change to, or None to stay in current directory.

**Return Value**: Context manager iterator.

#### 60. create_tmp_repo_dir() - Create Temporary Repository Copy

**Function**: Create a temporary dir with a copy of the contents of repo_dir.

**Function Signature**:
```python
def create_tmp_repo_dir(repo_dir: Path | str) -> Path:
```

**Parameter Description**:
- `repo_dir` (Path | str): Source repository directory to copy.

**Return Value**: Path to the temporary directory.

#### 61. make_executable() - Set File Executable

**Function**: Make `script_path` executable.

**Function Signature**:
```python
def make_executable(script_path: Path | str) -> None:
```

**Parameter Description**:
- `script_path` (Path | str): The file to change.

**Return Value**: None.

#### 62. clone() - Clone Repository

**Function**: Clone a repo to the current directory.

**Function Signature**:
```python
def clone(
    repo_url: str,
    checkout: str | None = None,
    clone_to_dir: Path | str = ".",
    no_input: bool = False,
) -> str:
```

**Parameter Description**:
- `repo_url` (str): Repo URL of unknown type.
- `checkout` (str | None): The branch, tag or commit ID to checkout after clone.
- `clone_to_dir` (Path | str): The directory to clone to. Defaults to the current directory.
- `no_input` (bool): Do not prompt for user input and eventually force a refresh of cached resources.

**Return Value**: str with path to the new directory of the repository.

#### 63. main() - CLI Main Function

**Function**: Main CLI entry point for cookiecutter command-line interface.

**Function Signature**:
```python
def main(
    template: str,
    extra_context: dict[str, Any] | None = None,
    no_input: bool = False,
    checkout: str | None = None,
    verbose: bool = False,
    replay: bool | str | None = None,
    overwrite_if_exists: bool = False,
    output_dir: str = '.',
    config_file: str | None = None,
    default_config: bool = False,
    debug_file: str | None = None,
    directory: str | None = None,
    skip_if_file_exists: bool = False,
    accept_hooks: bool = True,
    replay_file: str | None = None,
    list_installed: bool = False,
    keep_project_on_failure: bool = False,
) -> None:
```

**Parameter Description**:
- `template` (str): Template path or URL
- `extra_context` (dict[str, Any] | None): Additional context variables
- `no_input` (bool): Skip user interaction
- `checkout` (str | None): Git checkout parameter
- `verbose` (bool): Verbose output flag
- `replay` (bool | str | None): Replay mode flag
- `overwrite_if_exists` (bool): Overwrite existing directories
- `output_dir` (str): Output directory path
- `config_file` (str | None): Configuration file path
- `default_config` (bool): Use default configuration
- `debug_file` (str | None): Debug log file path
- `directory` (str | None): Template subdirectory
- `skip_if_file_exists` (bool): Skip existing files
- `accept_hooks` (bool): Accept hook execution
- `replay_file` (str | None): Replay file path
- `list_installed` (bool): List installed templates
- `keep_project_on_failure` (bool): Keep project on failure

**Return Value**: None

#### 64. is_repo_url() - Repository URL Detection

**Function**: Return True if value is a repository URL.

**Function Signature**:
```python
def is_repo_url(value: str) -> bool:
```

**Parameter Description**:
- `value` (str): String to check for repository URL pattern

**Return Value**: Boolean indicating if value is a repository URL

#### 65. is_zip_file() - ZIP File Detection

**Function**: Return True if value is a zip file.

**Function Signature**:
```python
def is_zip_file(value: str) -> bool:
```

**Parameter Description**:
- `value` (str): String to check for ZIP file extension

**Return Value**: Boolean indicating if value is a ZIP file

#### 66. expand_abbreviations() - Template Abbreviation Expansion

**Function**: Expand abbreviations in a template name.

**Function Signature**:
```python
def expand_abbreviations(template: str, abbreviations: dict[str, str]) -> str:
```

**Parameter Description**:
- `template` (str): The project template name.
- `abbreviations` (dict[str, str]): Abbreviation definitions.

**Return Value**: Expanded template string

#### 68. repository_has_cookiecutter_json() - Repository Validation

**Function**: Determine if `repo_directory` contains a `cookiecutter.json` file.

**Function Signature**:
```python
def repository_has_cookiecutter_json(repo_directory: str) -> bool:
```

**Parameter Description**:
- `repo_directory` (str): The candidate repository directory.

**Return Value**: True if the `repo_directory` is valid, else False.

#### 69. create_env_with_context() - Environment Creation

**Function**: Create a jinja environment using the provided context.

**Function Signature**:
```python
def create_env_with_context(context: dict[str, Any]) -> StrictEnvironment:
```

**Parameter Description**:
- `context` (dict[str, Any]): Template context dictionary

**Return Value**: Configured Jinja2 environment

#### 70. BUILTIN_ABBREVIATIONS - Built-in Repository Abbreviations

**Function**: Dictionary of built-in repository abbreviations for common platforms.

**Function Signature**:
```python
BUILTIN_ABBREVIATIONS = {
    'gh': 'https://github.com/{0}.git',
    'gl': 'https://gitlab.com/{0}.git',
    'bb': 'https://bitbucket.org/{0}',
}
```

**Parameter Description**: No parameters (constant dictionary)

**Return Value**: Dictionary of abbreviation mappings
  - `gh`: GitHub repository pattern with placeholder
  - `gl`: GitLab repository pattern with placeholder  
  - `bb`: Bitbucket repository pattern with placeholder

#### 71. DEFAULT_CONFIG - Default Configuration

**Function**: Default configuration dictionary for cookiecutter settings.

**Function Signature**:
```python
DEFAULT_CONFIG = {
    'cookiecutters_dir': os.path.expanduser('~/.cookiecutters/'),
    'replay_dir': os.path.expanduser('~/.cookiecutter_replay/'),
    'default_context': collections.OrderedDict([]),
    'abbreviations': BUILTIN_ABBREVIATIONS,
}
```

**Parameter Description**: No parameters (constant dictionary)

**Return Value**: Dictionary of default configuration settings
  - `cookiecutters_dir`: Default cookiecutters directory path
  - `replay_dir`: Default replay directory path
  - `default_context`: Default context configuration
  - `abbreviations`: Repository abbreviation mappings

#### 72. _Raw - Recursive Type Alias

**Description**: A recursive type alias that represents raw template data that can be a boolean, dictionary, list, string, or None. Used for handling complex nested data structures in template rendering.

```python
_Raw: TypeAlias = Union[bool, dict["_Raw", "_Raw"], list["_Raw"], str, None]
```

**Example**:
```python
from cookiecutter.prompt import _Raw

# Valid _Raw types:
raw_data: _Raw = "simple string"
raw_data: _Raw = {"key": "value", "nested": {"inner": True}}
raw_data: _Raw = [1, 2, {"mixed": "list"}]
raw_data: _Raw = None
```

#### 73. __version__ - Version Type Alias

**Description**: Type alias representing the version string of the current Cookiecutter installation. This variable is dynamically assigned by reading the VERSION.txt file at module initialization.

```python
__version__: str
```

**Example**:
```python
from cookiecutter import __version__
print(__version__)  # '2.1.1'
```

### Class Nodes

#### A1. ExtensionLoaderMixin

**Function**: Mixin providing sane loading of extensions specified in a given context. The context is being extracted from the keyword arguments before calling the next parent class in line of the child.

**Class Signature**:
```python
class ExtensionLoaderMixin:
    def __init__(self, *, context: dict[str, Any] | None = None, **kwargs: Any) -> None
    def _read_extensions(self, context: dict[str, Any]) -> list[str]
```

**Main Methods**:
- **`__init__()`** - Initialize the Jinja2 Environment object while loading extensions
  - **Input**: `context` (dict[str, Any] | None), `**kwargs` (Any)
  - **Output**: None
  - **Description**: Establishes default_extensions, reads extensions set in the cookiecutter.json _extensions key, attempts to load the extensions. Provides useful error if fails.
- **`_read_extensions()`** - Return list of extensions as str to be passed on to the Jinja2 env
  - **Input**: `context` (dict[str, Any])
  - **Output**: list[str]
  - **Description**: If context does not contain the relevant info, return an empty list instead.

**Parameter Description**:
- `context` (dict[str, Any] | None): Context dictionary containing cookiecutter configuration including extensions.
- `**kwargs` (Any): Additional keyword arguments passed to the parent class constructor.

#### A2. _patch_import_path_for_repo

**Function**: Context manager that temporarily adds a repository directory to Python's import path. Used to enable importing local extensions from the template repository.

**Class Signature**:
```python
class _patch_import_path_for_repo:
    def __init__(self, repo_dir: Path | str) -> None
    def __enter__(self) -> None
    def __exit__(self, _type, _value, _traceback) -> None
```

**Main Methods**:
- **`__init__()`** - Initialize the context manager with repository directory
  - **Input**: `repo_dir` (Path | str)
  - **Output**: None
  - **Description**: Store the repository directory path for later use in context management.
- **`__enter__()`** - Enter the context and add repo directory to sys.path
  - **Input**: None
  - **Output**: None
  - **Description**: Save current sys.path and append the repository directory to enable importing local extensions.
- **`__exit__()`** - Exit the context and restore original sys.path
  - **Input**: `_type`, `_value`, `_traceback` (exception info)
  - **Output**: None
  - **Description**: Restore the original sys.path that was saved in __enter__.

**Parameter Description**:
- `repo_dir` (Path | str): Path to the repository directory to add to Python import path.

#### A3. Exceptions (subclasses of `CookiecutterException`)

#### A3.1. CookiecutterException

**Function**: Base exception class. All Cookiecutter-specific exceptions should subclass this class.

**Class Signature**:
```python
class CookiecutterException(Exception):
    pass
```

#### A3.2. NonTemplatedInputDirException

**Function**: Exception for when a project's input dir is not templated. The name of the input directory should always contain a string that is rendered to something else, so that input_dir != output_dir.

**Class Signature**:
```python
class NonTemplatedInputDirException(CookiecutterException):
    pass
```

#### A3.3. UnknownTemplateDirException

**Function**: Exception for ambiguous project template directory. Raised when Cookiecutter cannot determine which directory is the project template, e.g. more than one dir appears to be a template dir.

**Class Signature**:
```python
class UnknownTemplateDirException(CookiecutterException):
    pass
```

#### A3.4. MissingProjectDir

**Function**: Exception for missing generated project directory. Raised during cleanup when remove_repo() can't find a generated project directory inside of a repo.

**Class Signature**:
```python
class MissingProjectDir(CookiecutterException):
    pass
```

#### A3.5. ConfigDoesNotExistException

**Function**: Exception for missing config file. Raised when get_config() is passed a path to a config file, but no file is found at that path.

**Class Signature**:
```python
class ConfigDoesNotExistException(CookiecutterException):
    pass
```

#### A3.6. InvalidConfiguration

**Function**: Exception for invalid configuration file. Raised if the global configuration file is not valid YAML or is badly constructed.

**Class Signature**:
```python
class InvalidConfiguration(CookiecutterException):
    pass
```

#### A3.7. UnknownRepoType

**Function**: Exception for unknown repo types. Raised if a repo's type cannot be determined.

**Class Signature**:
```python
class UnknownRepoType(CookiecutterException):
    pass
```

#### A3.8. VCSNotInstalled

**Function**: Exception when version control is unavailable. Raised if the version control system (git or hg) is not installed.

**Class Signature**:
```python
class VCSNotInstalled(CookiecutterException):
    pass
```

#### A3.9. ContextDecodingException

**Function**: Exception for failed JSON decoding. Raised when a project's JSON context file can not be decoded.

**Class Signature**:
```python
class ContextDecodingException(CookiecutterException):
    pass
```

#### A3.10. OutputDirExistsException

**Function**: Exception for existing output directory. Raised when the output directory of the project exists already.

**Class Signature**:
```python
class OutputDirExistsException(CookiecutterException):
    pass
```

#### A3.11. EmptyDirNameException

**Function**: Exception for a empty directory name. Raised when the directory name provided is empty.

**Class Signature**:
```python
class EmptyDirNameException(CookiecutterException):
    pass
```

#### A3.12. InvalidModeException

**Function**: Exception for incompatible modes. Raised when cookiecutter is called with both `no_input==True` and `replay==True` at the same time.

**Class Signature**:
```python
class InvalidModeException(CookiecutterException):
    pass
```

#### A3.13. FailedHookException

**Function**: Exception for hook failures. Raised when a hook script fails.

**Class Signature**:
```python
class FailedHookException(CookiecutterException):
    pass
```

#### A3.14. UndefinedVariableInTemplate

**Function**: Exception for out-of-scope variables. Raised when a template uses a variable which is not defined in the context.

**Class Signature**:
```python
class UndefinedVariableInTemplate(CookiecutterException):
    def __init__(self, message: str, error: TemplateError, context: dict[str, Any]) -> None
    def __str__(self) -> str
```

**Main Methods**:
- **`__init__()`** - Initialize the undefined variable exception
  - **Input**: `message` (str), `error` (TemplateError), `context` (dict[str, Any])
  - **Output**: None
  - **Description**: Store the error message, template error, and context for detailed error reporting.
- **`__str__()`** - Text representation of the exception
  - **Input**: None
  - **Output**: str
  - **Description**: Return a formatted string containing the error message, template error details, and context.

**Parameter Description**:
- `message` (str): Human-readable error message
- `error` (TemplateError): The underlying Jinja2 template error
- `context` (dict[str, Any]): The template context when the error occurred

#### A3.15. UnknownExtension

**Function**: Exception for un-importable extension. Raised when an environment is unable to import a required extension.

**Class Signature**:
```python
class UnknownExtension(CookiecutterException):
    pass
```

#### A3.16. RepositoryNotFound

**Function**: Exception for missing repo. Raised when the specified cookiecutter repository doesn't exist.

**Class Signature**:
```python
class RepositoryNotFound(CookiecutterException):
    pass
```

#### A3.17. RepositoryCloneFailed

**Function**: Exception for un-cloneable repo. Raised when a cookiecutter template can't be cloned.

**Class Signature**:
```python
class RepositoryCloneFailed(CookiecutterException):
    pass
```

#### A3.18. InvalidZipRepository

**Function**: Exception for bad zip repo. Raised when the specified cookiecutter repository isn't a valid
Zip archive.

**Class Signature**:
```python
class InvalidZipRepository(CookiecutterException):
    pass
```

#### A4. Jinja2 extension classes (constructor param `environment: Environment`)

#### A4.1. JsonifyExtension

**Function**: Jinja2 extension to convert a Python object to JSON.

**Class Signature**:
```python
class JsonifyExtension(Extension):
    def __init__(self, environment: Environment) -> None
```

**Main Methods**:
- **`__init__()`** - Initialize the extension with the given environment
  - **Input**: `environment` (Environment)
  - **Output**: None
  - **Description**: Initialize the extension and register the `jsonify` filter with the Jinja2 environment.

**Parameter Description**:
- `environment` (Environment): Jinja2 environment instance for the extension

**Usage Example**:
```jinja
{{ {'a': True, 'b': 'value'} | jsonify }}
{{ {'a': True, 'b': 'value'} | jsonify(2) }}
```

#### A4.2. RandomStringExtension

**Function**: Jinja2 extension to create a random string.

**Class Signature**:
```python
class RandomStringExtension(Extension):
    def __init__(self, environment: Environment) -> None
```

**Main Methods**:
- **`__init__()`** - Initialize the extension with the given environment
  - **Input**: `environment` (Environment)
  - **Output**: None
  - **Description**: Initialize the extension and register the `random_ascii_string` global function with the Jinja2 environment.

**Parameter Description**:
- `environment` (Environment): Jinja2 environment instance for the extension

**Usage Example**:
```jinja
{{ random_ascii_string(12) }}
{{ random_ascii_string(12, punctuation=True) }}
```

#### A4.3. SlugifyExtension

**Function**: Jinja2 Extension to slugify string.

**Class Signature**:
```python
class SlugifyExtension(Extension):
    def __init__(self, environment: Environment) -> None
```

**Main Methods**:
- **`__init__()`** - Initialize the extension with the given environment
  - **Input**: `environment` (Environment)
  - **Output**: None
  - **Description**: Initialize the extension and register the `slugify` filter with the Jinja2 environment.

**Parameter Description**:
- `environment` (Environment): Jinja2 environment instance for the extension

**Usage Example**:
```jinja
{{ "It's a random version" | slugify }}
{{ "It's a random version" | slugify(separator='_') }}
```

#### A4.4. UUIDExtension

**Function**: Jinja2 Extension to generate uuid4 string.

**Class Signature**:
```python
class UUIDExtension(Extension):
    def __init__(self, environment: Environment) -> None
```

**Main Methods**:
- **`__init__()`** - Initialize the extension with the given environment
  - **Input**: `environment` (Environment)
  - **Output**: None
  - **Description**: Initialize the extension and register the `uuid4` global function with the Jinja2 environment.

**Parameter Description**:
- `environment` (Environment): Jinja2 environment instance for the extension

**Usage Example**:
```jinja
{{ uuid4() }}
```

#### A4.5. TimeExtension

**Function**: Jinja2 Extension for dates and times.

**Class Signature**:
```python
class TimeExtension(Extension):
    def __init__(self, environment: Environment) -> None
    def _datetime(self, timezone: str, operator: str, offset: str, datetime_format: str | None) -> str
    def _now(self, timezone: str, datetime_format: str | None) -> str
    def parse(self, parser: Parser) -> nodes.Output
```

**Main Methods**:
- **`__init__()`** - Initialize the extension with the given environment
  - **Input**: `environment` (Environment)
  - **Output**: None
  - **Description**: Initialize the extension and set up datetime formatting defaults.
- **`_datetime()`** - Handle datetime arithmetic operations
  - **Input**: `timezone` (str), `operator` (str), `offset` (str), `datetime_format` (str | None)
  - **Output**: str
  - **Description**: Process datetime with timezone shifts and return formatted string.
- **`_now()`** - Get current datetime
  - **Input**: `timezone` (str), `datetime_format` (str | None)
  - **Output**: str
  - **Description**: Get current datetime in specified timezone and format.
- **`parse()`** - Parse datetime template tags
  - **Input**: `parser` (Parser)
  - **Output**: nodes.Output
  - **Description**: Parse the `now` tag and handle datetime expressions in templates.
  
**Parameter Description**:
- `environment` (Environment): Jinja2 environment instance for the extension
- `timezone` (str): Timezone for datetime operations
- `operator` (str): Mathematical operator for datetime arithmetic
- `offset` (str): Time offset specification
- `datetime_format` (str | None): Format string for datetime output
- `parser` (Parser): Jinja2 parser for template parsing

**Usage Example**:
```jinja
{% now 'utc' %}
{% now 'utc', '%Y-%m-%d' %}
{% now 'utc' + 'days=1' %}
```

#### A5. Prompt Classes

#### A5.1. YesNoPrompt

**Function**: A prompt that returns a boolean for yes/no questions.

**Class Signature**:
```python
class YesNoPrompt(Confirm):
    def __init__(self, message: str, default: bool = True, **kwargs: Any) -> None
    def process_response(self, value: str) -> bool
```

**Main Methods**:
- **`__init__()`** - Initialize the yes/no prompt
  - **Input**: `message` (str), `default` (bool), `**kwargs` (Any)
  - **Output**: None
  - **Description**: Initialize the prompt with message and default value.
- **`process_response()`** - Convert user input to boolean
  - **Input**: `value` (str)
  - **Output**: bool
  - **Description**: Convert various string inputs to boolean. Accepts "1", "true", "t", "yes", "y", "on" as True and "0", "false", "f", "no", "n", "off" as False.

**Parameter Description**:
- `message` (str): The prompt message to display to the user
- `default` (bool): Default value for the yes/no prompt (default: True)
- `**kwargs` (Any): Additional keyword arguments passed to the parent class

#### A5.2. JsonPrompt

**Function**: A prompt that returns a dict from JSON string.

**Class Signature**:
```python
class JsonPrompt(PromptBase[dict]):
    def __init__(self, message: str, **kwargs: Any) -> None
    @staticmethod
    def process_response(value: str) -> dict[str, Any]
```

**Main Methods**:
- **`__init__()`** - Initialize the JSON prompt
  - **Input**: `message` (str), `**kwargs` (Any)
  - **Output**: None
  - **Description**: Initialize the prompt with message for JSON input.
- **`process_response()`** - Convert JSON string to dictionary
  - **Input**: `value` (str)
  - **Output**: dict[str, Any]
  - **Description**: Parse JSON string and return as dictionary. Raises InvalidResponse if JSON is invalid.

**Parameter Description**:
- `message` (str): The prompt message to display to the user
- `**kwargs` (Any): Additional keyword arguments passed to the parent class

**Return Value**: None (constructor)

#### A6. StrictEnvironment

**Function**: Create strict Jinja2 environment. Jinja2 environment will raise error on undefined variable in template-rendering context.

**Class Signature**:
```python
class StrictEnvironment(ExtensionLoaderMixin, Environment):
    def __init__(self, **kwargs: Any) -> None
```

**Main Methods**:
- **`__init__()`** - Set the standard Cookiecutter StrictEnvironment
  - **Input**: `**kwargs` (Any)
  - **Output**: None
  - **Description**: Initialize Jinja2 environment with undefined=StrictUndefined and load extensions defined in cookiecutter.json's _extensions key.

**Parameter Description**:
- `**kwargs` (Any): Additional keyword arguments passed to the parent classes (ExtensionLoaderMixin and Environment)


### Practical Usage Modes

#### Basic Usage Mode

```python
from cookiecutter.main import cookiecutter

# Simple project generation
result = cookiecutter('gh:audreyfeldroy/cookiecutter-pypackage')
print(f"Project generated at: {result}")

# Non-interactive mode
result = cookiecutter(
    'cookiecutter-pypackage/',
    no_input=True,
    extra_context={'project_name': 'my-project'}
)
```

#### Advanced Configuration Mode

```python
from cookiecutter.main import cookiecutter
from cookiecutter.config import get_user_config

# Custom configuration
config = get_user_config(default_config=True)

# Generate a project using the configuration
result = cookiecutter(
    'gh:user/template',
    output_dir='./projects',
    overwrite_if_exists=True,
    accept_hooks=True
)
```

#### Programmatic Usage Mode

```python
from cookiecutter.generate import generate_context, generate_files
from cookiecutter.prompt import prompt_for_config
from cookiecutter.repository import determine_repo_dir

# Manually control the generation process
template = 'my-template/'
config = get_user_config()

# Determine the template directory
repo_dir, cleanup = determine_repo_dir(
    template=template,
    abbreviations=config['abbreviations'],
    clone_to_dir=config['cookiecutters_dir'],
    checkout=None,
    no_input=False
)

# Generate the context
context = generate_context(
    context_file=f'{repo_dir}/cookiecutter.json',
    extra_context={'project_name': 'custom-project'}
)

# User interaction
cookiecutter_dict = prompt_for_config(context, no_input=False)

# Generate files
result = generate_files(
    repo_dir=repo_dir,
    context={'cookiecutter': cookiecutter_dict},
    output_dir='./output'
)
```

#### Hook Usage Mode

```python
from cookiecutter.hooks import run_hook, find_hook

# Find hooks
hooks = find_hook('pre_gen_project', 'hooks')
if hooks:
    print(f"Hooks found: {hooks}")

# Execute hooks
context = {'cookiecutter': {'project_name': 'test'}}
run_hook('post_gen_project', './generated-project', context)
```

#### Replay Usage Mode

```python
from cookiecutter.replay import dump, load

# Save configurations
context = {'cookiecutter': {'project_name': 'my-project'}}
dump('~/.cookiecutter_replay', 'template-name', context)

# Load configurations
saved_context = load('~/.cookiecutter_replay', 'template-name')
print(f"Saved configurations: {saved_context}")
```

### Supported Template Sources

- **Local Directory**: Directly specify the path of the local template directory.
- **Git Repository**: Supports HTTPS, SSH, and Git protocols.
- **ZIP File**: Local or remote ZIP compressed packages.
- **Abbreviation Support**: Repository abbreviations such as `gh:`, `gl:`, `bb:`, etc.

### Error Handling Mechanism

The system provides comprehensive error handling:
- **Template Not Found**: `RepositoryNotFound` exception.
- **Configuration Error**: `InvalidConfiguration` exception.
- **Rendering Failure**: `UndefinedVariableInTemplate` exception.
- **Hook Failure**: `FailedHookException` exception.
- **Permission Issue**: Exceptions related to file permissions and directory access.

### Important Notes

1. **Context Structure**: All contexts must contain the 'cookiecutter' key.
2. **Hook Execution Order**: `pre_prompt` → `pre_gen_project` → File Generation → `post_gen_project`.
3. **Binary File Handling**: Automatically identify and directly copy binary files without template rendering.
4. **Permission Preservation**: Generated files will preserve the file permissions of the original template.
5. **Cleanup Mechanism**: Temporary directories and cloned repositories will be automatically cleaned up after use.
6. **Thread Safety**: The main functions support use in a multi-threaded environment.

## Detailed Function Implementation Nodes

### Node 1: Template File Generation and Rendering

**Function Description**: Render project files based on the Jinja2 template engine, support intelligent handling of text files and binary files, and preserve file permissions and directory structures.

**Core Algorithms**:
- Binary file detection and direct copying.
- Text file template rendering.
- File permission preservation.
- Recursive creation of directory structures.
- Newline character handling (LF/CRLF).

**Input/Output Examples**:

```python
from cookiecutter.generate import generate_files
from cookiecutter.utils import work_in

# Basic file generation
context = {'cookiecutter': {'project_name': 'my-project'}}
result = generate_files(
    repo_dir='tests/fake-repo',
    context=context,
    output_dir='./output'
)
print(result)  # './output/my-project'

# Binary file handling
# Automatically detect and directly copy without template rendering
binary_context = {'cookiecutter': {'binary_test': 'test'}}
generate_files(
    repo_dir='tests/test-generate-binaries',
    context=binary_context,
    output_dir='./output'
)

# Newline character handling
context_with_newlines = {
    'cookiecutter': {
        'food': 'pizzä',
        '_new_lines': '\r\n'  # Force Windows newlines
    }
}
generate_files(
    repo_dir='tests/test-generate-files',
    context=context_with_newlines,
    output_dir='./output'
)

# File permission preservation
generate_files(
    repo_dir='tests/test-generate-files-permissions',
    context={'cookiecutter': {'permissions': 'script'}},
    output_dir='./output'
)
```

### Node 2: User Interaction System

**Function Description**: Provide a complete user interaction function, supporting multiple interaction modes such as text input, selection lists, yes/no selections, and dictionary input.

**Supported Types**:
- Text variable input.
- Multi-option list selection.
- Boolean yes/no selection.
- JSON dictionary input.
- Custom prompt messages.

**Input/Output Examples**:

```python
from cookiecutter.prompt import (
    read_user_variable, read_user_choice, 
    read_user_yes_no, read_user_dict, prompt_for_config
)

# Text variable input
result = read_user_variable('project_name', 'default-project')
print(result)  # User input or default value

# Multi-option selection
options = ['python', 'javascript', 'go']
result = read_user_choice('language', options)
print(result)  # User-selected option

# Yes/no selection
result = read_user_yes_no('use_docker', True)
print(result)  # True/False

# Dictionary input
default_dict = {'name': 'test', 'version': '1.0'}
result = read_user_dict('config', default_dict)
print(result)  # User-input dictionary

# Complete configuration interaction
context = {
    'cookiecutter': {
        'project_name': 'My Project',
        'use_docker': ['yes', 'no'],
        'config': {'debug': True},
        '__prompts__': {
            'project_name': 'Enter project name:',
            'use_docker': 'Use Docker?'
        }
    }
}
config = prompt_for_config(context, no_input=False)
print(config)  # Complete dictionary of user configurations
```

### Node 3: Template Context Generation and Management

**Function Description**: Generate the template context from the `cookiecutter.json` file, supporting configuration merging, overriding, and validation.

**Core Functions**:
- JSON configuration file parsing.
- Merging of default configurations and user configurations.
- Overriding with additional contexts.
- Handling of nested dictionaries.
- Configuration validation.

**Input/Output Examples**:

```python
from cookiecutter.generate import generate_context, apply_overwrites_to_context

# Basic context generation
context = generate_context('tests/fake-repo/cookiecutter.json')
print(context)  # {'cookiecutter': {...}}

# Context with default configuration
default_context = {'project_name': 'default-project'}
context = generate_context(
    'tests/fake-repo/cookiecutter.json',
    default_context=default_context
)

# Context with additional configuration
extra_context = {'project_name': 'override-project'}
context = generate_context(
    'tests/fake-repo/cookiecutter.json',
    extra_context=extra_context
)

# Context with both default and extra configuration
default_context = {'project_name': 'default-project'}
extra_context = {'project_name': 'override-project', 'version': '1.0.0'}
context = generate_context(
    'tests/fake-repo/cookiecutter.json',
    default_context=default_context,
    extra_context=extra_context
)
print(context)  # extra_context overrides default_context

# Context with nested dictionaries
nested_context = {
    'config': {
        'database': {'host': 'localhost', 'port': 5432}
    }
}
nested_overwrite = {
    'config': {
        'database': {'port': 3306}
    }
}
apply_overwrites_to_context(nested_context, nested_overwrite)
```

### Node 4: Hook System Execution

**Function Description**: Execute pre-prompt, pre-generation, and post-generation hook scripts, supporting Python and Shell scripts.

**Hook Types**:
- `pre_prompt`: Executed before prompting.
- `pre_gen_project`: Executed before project generation.
- `post_gen_project`: Executed after project generation.

**Input/Output Examples**:

```python
from cookiecutter.hooks import find_hook, run_hook, run_script, run_script_with_context

# Find hook scripts
hooks = find_hook('pre_gen_project', 'hooks')
print(hooks)  # ['/path/to/pre_gen_project.py']

# Execute hooks
context = {'cookiecutter': {'project_name': 'test'}}
run_hook('post_gen_project', './generated-project', context)

# Directly execute a script
run_script('/path/to/script.py', cwd='./project-dir')

# Execute a script with context
run_script_with_context(
    '/path/to/script.py',
    cwd='./project-dir',
    context={'cookiecutter': {'name': 'test'}}
)

# Handle hook failures
try:
    run_hook('pre_gen_project', './project', context)
except FailedHookException as e:
    print(f"Hook failed: {e}")
    # Clean up the generated project
```

### Node 5: Template Repository Management

**Function Description**: Support the acquisition and management of templates from multiple sources, including local directories, Git repositories, ZIP files, etc.

**Supported Sources**:
- Local directory path.
- Git repository URL (HTTPS/SSH).
- ZIP compressed package.
- Repository abbreviations (`gh:`, `gl:`, etc.).

**Input/Output Examples**:

```python
from cookiecutter.repository import (
    determine_repo_dir, is_repo_url, is_zip_file, expand_abbreviations
)

# Local repository
repo_dir, cleanup = determine_repo_dir(
    template='tests/fake-repo',
    abbreviations={},
    clone_to_dir='~/.cookiecutters',
    checkout=None,
    no_input=True
)
print(repo_dir)  # 'tests/fake-repo'
print(cleanup)   # False

# Git repository
repo_dir, cleanup = determine_repo_dir(
    template='https://github.com/user/template.git',
    abbreviations={},
    clone_to_dir='~/.cookiecutters',
    checkout='main',
    no_input=True
)
print(repo_dir)  # '/path/to/cloned/repo'
print(cleanup)   # False

# Repository abbreviation
abbreviations = {
    'gh': 'https://github.com/{0}.git',
    'gl': 'https://gitlab.com/{0}.git'
}
expanded = expand_abbreviations('gh:user/template', abbreviations)
print(expanded)  # 'https://github.com/user/template.git'

# URL type detection
print(is_repo_url('https://github.com/user/repo.git'))  # True
print(is_repo_url('git@github.com:user/repo.git'))      # True
print(is_repo_url('./local/path'))                      # False

# ZIP file detection
print(is_zip_file('template.zip'))  # True
print(is_zip_file('template.tar.gz'))  # False
```

### Node 6: Replay Functionality

**Function Description**: Save and replay user configurations, supporting batch project generation and configuration reuse.

**Core Functions**:
- Save configurations to a JSON file.
- Load configurations from a JSON file.
- Validate replay mode.
- Manage template names.

**Input/Output Examples**:

```python
from cookiecutter.replay import dump, load, get_file_name
from cookiecutter.main import cookiecutter

# Save configurations
context = {
    'cookiecutter': {
        'project_name': 'my-project',
        'use_docker': 'yes',
        'database': 'postgresql'
    }
}
dump('~/.cookiecutter_replay', 'template-name', context)

# Load configurations
saved_context = load('~/.cookiecutter_replay', 'template-name')
print(saved_context)  # Dictionary of saved configurations

# Generate a project in replay mode
result = cookiecutter(
    'tests/fake-repo',
    replay=True,
    output_dir='./output'
)

# Specify a replay file
result = cookiecutter(
    'tests/fake-repo',
    replay='~/.cookiecutter_replay/custom.json',
    output_dir='./output'
)

# Get the replay file name
filename = get_file_name('~/.cookiecutter_replay', 'template-name')
print(filename)  # '~/.cookiecutter_replay/template-name.json'

# Validate replay mode
# Cannot use replay and no_input or extra_context simultaneously
try:
    cookiecutter('template', replay=True, no_input=True)
except InvalidModeException as e:
    print(f"Invalid mode: {e}")
```

### Node 7: Configuration Management System

**Function Description**: Manage user configuration files, supporting multiple configuration sources and configuration merging.

**Configuration Sources**:
- Default configurations.
- User configuration file (`~/.cookiecutterrc`).
- Environment variable configurations.
- Command-line parameters.

**Input/Output Examples**:

```python
from cookiecutter.config import get_user_config, get_config, merge_configs

# Get user configurations
config = get_user_config()
print(config)  # Dictionary of default configurations

# Custom configuration file
config = get_user_config(config_file='~/.custom_cookiecutterrc')

# Use default configurations
config = get_user_config(default_config=True)

# Custom default configurations
custom_defaults = {
    'cookiecutters_dir': '~/.custom_templates',
    'replay_dir': '~/.custom_replay',
    'abbreviations': {
        'gh': 'https://github.com/{0}.git'
    }
}
config = get_user_config(default_config=custom_defaults)

# Configuration merging
default_config = {
    'cookiecutters_dir': '~/.cookiecutters',
    'abbreviations': {'gh': 'https://github.com/{0}.git'}
}
user_config = {
    'cookiecutters_dir': '~/.custom_templates',
    'abbreviations': {'gl': 'https://gitlab.com/{0}.git'}
}
merged = merge_configs(default_config, user_config)
print(merged)  # Merged configurations

# Environment variable configuration
import os
os.environ['COOKIECUTTER_CONFIG'] = '~/.env_cookiecutterrc'
config = get_user_config()
```

### Node 8: Command Line Interface Processing

**Function Description**: Process command-line parameters, provide a complete CLI function, including parameter validation and error handling.

**Supported Parameters**:
- Template path.
- Output directory.
- Configuration options.
- Hook control.
- Replay mode.

**Input/Output Examples**:

```python
from cookiecutter.cli import main
from click.testing import CliRunner

# CLI runner
runner = CliRunner()

# Basic command
result = runner.invoke(main, ['tests/fake-repo', '--no-input'])
print(result.exit_code)  # 0
print(result.output)     # Command output

# Version information
result = runner.invoke(main, ['--version'])
print(result.output)  # 'Cookiecutter x.x.x'

# Help information
result = runner.invoke(main, ['--help'])
print(result.output)  # Help documentation

# Output directory
result = runner.invoke(main, [
    'tests/fake-repo',
    '--no-input',
    '--output-dir', './custom-output'
])

# Overwrite existing directory
result = runner.invoke(main, [
    'tests/fake-repo',
    '--no-input',
    '--overwrite-if-exists'
])

# Additional context
result = runner.invoke(main, [
    'tests/fake-repo',
    '--no-input',
    'project_name=my-project',
    'use_docker=yes'
])

# Replay mode
result = runner.invoke(main, [
    'tests/fake-repo',
    '--replay'
])

# Hook control
result = runner.invoke(main, [
    'tests/fake-repo',
    '--no-input',
    '--accept-hooks', 'ask'
])

# Error handling
result = runner.invoke(main, ['nonexistent-template'])
print(result.exit_code)  # Non-zero exit code
print(result.output)     # Error information
```

### Node 9: File System Operation Utilities

**Function Description**: Provide auxiliary tools for file system operations, including directory creation, file copying, permission setting, etc.

**Core Functions**:
- Directory creation and validation.
- File permission management.
- Temporary directory handling.
- Working directory switching.

**Input/Output Examples**:

```python
from cookiecutter.utils import (
    make_sure_path_exists, rmtree, work_in, 
    create_tmp_repo_dir, force_delete
)

# Directory creation
success = make_sure_path_exists('./new-directory')
print(success)  # True

# Recursive deletion
rmtree('./directory-to-remove')

# Working directory switching
import os
original_cwd = os.getcwd()
with work_in('./temp-directory'):
    print(os.getcwd())  # './temp-directory'
print(os.getcwd())  # Original directory

# Temporary repository directory
tmp_repo = create_tmp_repo_dir('./source-repo')
print(tmp_repo)  # Temporary directory path

# Force deletion (handle read-only files)
def mock_rmtree(path):
    raise PermissionError("Permission denied")

force_delete(mock_rmtree, './readonly-file', sys.exc_info())

# Path validation
from pathlib import Path
path = Path('./test-path')
if not path.exists():
    make_sure_path_exists(path)
```

### Node 10: Template Discovery and Validation

**Function Description**: Find and validate the validity of templates, ensuring that templates contain necessary configuration files.

**Validation Content**:
- Existence of `cookiecutter.json`.
- Template directory structure.
- Configuration file format.
- Template integrity.

**Input/Output Examples**:

```python
from cookiecutter.find import find_template
from cookiecutter.repository import repository_has_cookiecutter_json

# Template search
template_path = find_template('tests/fake-repo')
print(template_path)  # Path of the found template

# Template validation
is_valid = repository_has_cookiecutter_json('tests/fake-repo')
print(is_valid)  # True

is_valid = repository_has_cookiecutter_json('tests/fake-repo-bad')
print(is_valid)  # False

# Nested template search
nested_template = find_template('tests/fake-nested-templates')
print(nested_template)  # Path of the nested template

# Template directory structure validation
import os
template_dir = 'tests/fake-repo'
required_files = ['cookiecutter.json']
for file in required_files:
    file_path = os.path.join(template_dir, file)
    if not os.path.exists(file_path):
        raise Exception(f"Missing required file: {file}")
```

### Node 11: Environment Configuration and Jinja2 Integration

**Function Description**: Configure the Jinja2 template environment, supporting custom extensions and filters.

**Configuration Options**:
- Strict environment mode.
- Custom extensions.
- Environment variables.
- Template options.

**Input/Output Examples**:

```python
from cookiecutter.environment import StrictEnvironment
from cookiecutter.utils import create_env_with_context

# Create a strict environment
env = StrictEnvironment()
print(env.undefined)  # StrictUndefined

# Environment with context
context = {'cookiecutter': {'project_name': 'test'}}
env = create_env_with_context(context)

# Custom Jinja2 environment variables
context = {
    'cookiecutter': {
        'project_name': 'test',
        '_jinja2_env_vars': {
            'lstrip_blocks': True,
            'trim_blocks': True
        }
    }
}
env = create_env_with_context(context)

# Template rendering
template = env.from_string('Hello {{ cookiecutter.project_name }}!')
result = template.render(**context)
print(result)  # 'Hello test!'

# Extension support
from jinja2 import Extension
class CustomExtension(Extension):
    def __init__(self, environment):
        super().__init__(environment)
        # Custom extension logic

env = StrictEnvironment(extensions=[CustomExtension])
```

### Node 12: Error Handling and Exception Management

**Function Description**: Provide a comprehensive error handling mechanism, including exception capture, error information, and recovery strategies.

**Exception Types**:
- Template not found exception.
- Configuration error exception.
- Rendering failure exception.
- Hook execution exception.

**Input/Output Examples**:

```python
from cookiecutter.exceptions import (
    RepositoryNotFound, ContextDecodingException,
    UndefinedVariableInTemplate, FailedHookException
)

# Handle template not found
try:
    from cookiecutter.repository import determine_repo_dir
    determine_repo_dir(
        'nonexistent-template',
        abbreviations={},
        clone_to_dir='./temp',
        checkout=None,
        no_input=True
    )
except RepositoryNotFound as e:
    print(f"Template not found: {e}")

# Handle configuration parsing error
try:
    from cookiecutter.generate import generate_context
    generate_context('invalid-json-file.json')
except ContextDecodingException as e:
    print(f"Config error: {e}")

# Handle undefined template variable
try:
    from cookiecutter.generate import generate_files
    generate_files(
        repo_dir='tests/fake-repo',
        context={'cookiecutter': {'undefined_var': '{{ cookiecutter.missing }}'}},
        output_dir='./output'
    )
except UndefinedVariableInTemplate as e:
    print(f"Undefined variable: {e}")

# Handle hook execution failure
try:
    from cookiecutter.hooks import run_hook
    run_hook('failing_hook', './project', {})
except FailedHookException as e:
    print(f"Hook failed: {e}")

# Error recovery strategy
def safe_generate_project(template, output_dir):
    try:
        result = cookiecutter(template, output_dir=output_dir)
        return result
    except RepositoryNotFound:
        print("Template not found, using default")
        return cookiecutter('default-template', output_dir=output_dir)
    except Exception as e:
        print(f"Generation failed: {e}")
        return None
```

### Node 13: Encoding and Internationalization Support

**Function Description**: Handle files in different encoding formats and internationalized content, ensuring cross-platform compatibility.

**Supported Functions**:
- UTF-8 encoding processing.
- Unicode character support.
- Cross-platform newlines.
- Internationalized text.

**Input/Output Examples**:

```python
from cookiecutter.utils import work_in
from pathlib import Path

# Unicode project name
context = {'cookiecutter': {'project_name': 'test-project'}}
result = cookiecutter('tests/fake-repo', extra_context=context)

# Internationalized prompt text
context = {
    'cookiecutter': {
        'project_name': 'My Project',
        '__prompts__': {
            'project_name': 'Please enter project name:'
        }
    }
}
config = prompt_for_config(context)

# Encoding processing
def read_file_with_encoding(file_path):
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return f.read()
    except UnicodeDecodeError:
        with open(file_path, 'r', encoding='latin-1') as f:
            return f.read()

# Cross-platform newlines
context = {
    'cookiecutter': {
        'project_name': 'test',
        '_new_lines': '\r\n'  # Windows
    }
}
generate_files(
    repo_dir='tests/fake-repo',
    context=context,
    output_dir='./output'
)

# File encoding detection
import chardet
def detect_encoding(file_path):
    with open(file_path, 'rb') as f:
        raw_data = f.read()
        result = chardet.detect(raw_data)
        return result['encoding']
```

### Node 14: Performance Optimization and Cache Management

**Function Description**: Optimize template generation performance, including cache management and resource cleanup.

**Optimization Strategies**:
- Template caching.
- Temporary file cleanup.
- Resource management.
- Memory optimization.

**Input/Output Examples**:

```python
from cookiecutter.utils import rmtree
import tempfile
import shutil

# Template cache management
def get_cached_template(template_url, cache_dir='~/.cookiecutters'):
    cache_path = os.path.expanduser(cache_dir)
    template_name = template_url.split('/')[-1].replace('.git', '')
    cached_path = os.path.join(cache_path, template_name)
    
    if os.path.exists(cached_path):
        return cached_path
    else:
        # Clone to cache
        repo_dir, _ = determine_repo_dir(
            template_url,
            abbreviations={},
            clone_to_dir=cache_path,
            checkout=None,
            no_input=True
        )
        return repo_dir

# Temporary file cleanup
def cleanup_temp_files(temp_dirs):
    for temp_dir in temp_dirs:
        if os.path.exists(temp_dir):
            rmtree(temp_dir)

# Resource management
class TemplateGenerator:
    def __init__(self):
        self.temp_dirs = []
    
    def generate(self, template, context):
        try:
            result = cookiecutter(template, extra_context=context)
            return result
        finally:
            self.cleanup()
    
    def cleanup(self):
        cleanup_temp_files(self.temp_dirs)
        self.temp_dirs.clear()

# Memory optimization
def generate_large_project(template, context, batch_size=100):
    """Generate a large project in batches to avoid memory issues"""
    results = []
    for i in range(0, len(context), batch_size):
        batch = context[i:i+batch_size]
        result = cookiecutter(template, extra_context=batch)
        results.append(result)
    return results
```

### Node 15: Security and Permission Management

**Function Description**: Ensure the security of the template generation process, including file permission management and security verification.

**Security Measures**:
- File permission control.
- Path verification.
- Secure script execution.
- Input validation.

**Input/Output Examples**:

```python
import os
import stat
from pathlib import Path

# File permission setting
def set_file_permissions(file_path, permissions):
    os.chmod(file_path, permissions)

# Secure path verification
def is_safe_path(path, base_dir):
    """Verify whether the path is within a safe directory"""
    try:
        path = os.path.abspath(path)
        base_dir = os.path.abspath(base_dir)
        return path.startswith(base_dir)
    except Exception:
        return False

# Script execution permission
def make_executable(file_path):
    """Set file executable permission"""
    current_mode = os.stat(file_path).st_mode
    os.chmod(file_path, current_mode | stat.S_IXUSR)

# Input validation
def validate_template_path(template_path):
    """Verify the security of the template path"""
    if not template_path:
        raise ValueError("Template path cannot be empty")
    
    if '..' in template_path:
        raise ValueError("Template path cannot contain '..'")
    
    if not os.path.exists(template_path):
        raise ValueError(f"Template path does not exist: {template_path}")
    
    return template_path

# Secure hook script execution
def safe_run_hook(hook_path, context):
    """Securely execute hook scripts"""
    if not is_safe_path(hook_path, os.getcwd()):
        raise ValueError("Hook path is not safe")
    
    # Verify script content
    with open(hook_path, 'r') as f:
        content = f.read()
        if 'import os' in content and 'system' in content:
            raise ValueError("Hook contains potentially dangerous code")
    
    return run_script(hook_path, context=context)
```

### Node 16: Testing and Validation Framework

**Function Description**: Provide a complete testing framework to verify the correctness of template generation functions.

**Test Types**:
- Unit tests.
- Integration tests.
- Functional tests.
- Boundary condition tests.

**Input/Output Examples**:

```python
import pytest
from cookiecutter.main import cookiecutter
from cookiecutter.generate import generate_context

# Basic function test
def test_basic_template_generation(tmp_path):
    """Test basic template generation function"""
    result = cookiecutter(
        'tests/fake-repo',
        no_input=True,
        output_dir=tmp_path
    )
    assert result is not None
    assert os.path.exists(result)

# Context generation test
def test_context_generation():
    """Test context generation function"""
    context = generate_context('tests/fake-repo/cookiecutter.json')
    assert 'cookiecutter' in context
    assert 'project_name' in context['cookiecutter']

# User interaction test
def test_user_prompt(mocker):
    """Test user interaction function"""
    mocker.patch('cookiecutter.prompt.read_user_variable', return_value='test-project')
    context = {'cookiecutter': {'project_name': 'default'}}
    result = prompt_for_config(context, no_input=False)
    assert result['project_name'] == 'test-project'

# Hook execution test
def test_hook_execution(tmp_path):
    """Test hook execution function"""
    # Create a test hook
    hook_dir = tmp_path / 'hooks'
    hook_dir.mkdir()
    hook_file = hook_dir / 'pre_gen_project.py'
    hook_file.write_text('print("hook executed")')
    
    # Execute the hook
    context = {'cookiecutter': {'project_name': 'test'}}
    run_hook('pre_gen_project', str(tmp_path), context)

# Error handling test
def test_error_handling():
    """Test error handling function"""
    with pytest.raises(RepositoryNotFound):
        cookiecutter('nonexistent-template', no_input=True)

# Performance test
def test_performance(benchmark):
    """Test template generation performance"""
    def generate_template():
        return cookiecutter('tests/fake-repo', no_input=True)
    
    result = benchmark(generate_template)
    assert result is not None
```