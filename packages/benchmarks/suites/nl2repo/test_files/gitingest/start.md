## Introduction and Goals of the GitIngest Project

GitIngest is a Python tool **for automated analysis of code repositories**. It can parse local directories and remote Git repositories (supporting mainstream platforms such as GitHub, GitLab, and Bitbucket) and extract structured summaries. This tool performs excellently in code repository analysis tasks, achieving "efficient file scanning, intelligent content extraction, and accurate summary generation". Its core functions include: repository cloning management (supporting specification of branches, commits, and sub - paths), **file system scanning and content extraction** (supporting multiple file formats, size limits, and pattern filtering), as well as advanced functions such as Notebook conversion, Gitignore rule handling, and both CLI and Web interfaces. In short, GitIngest aims to provide a robust code repository analysis system for automatically extracting and analyzing the structure and content of code libraries (for example, converting a repository into a structured summary through `ingest_query()`, and converting a Jupyter Notebook into readable code through the `process_notebook()` function).

---

## Natural Language Instructions (Prompt)

Please create a Python project named GitIngest to implement an automated code repository analysis tool. The project should include the following functions:

1. Repository Cloner: It should be able to clone code repositories from various Git platforms (GitHub, GitLab, Bitbucket, etc.), supporting the specification of branches, commit hashes, and sub - paths. The cloning result should be a local file system path, and it should support Token authentication for private repositories.

2. File System Scanner: Implement a function to scan local directories or cloned repositories, extract file content, and generate structured summaries. It should support file size limits, inclusion/exclusion pattern filtering, handling of multiple file formats, and the application of Gitignore rules.

3. Content Extractor: Specialize in processing different types of files, including ordinary text files, Jupyter Notebook conversion, and skipping binary files. It should support the conversion of code/markdown/raw cells in Notebooks and the intelligent truncation of large files.

4. Interface Design: Design independent command - line interfaces and Web API interfaces for each functional module (such as cloning, scanning, extraction, conversion, etc.), supporting CLI calls and Web services. Each module should define clear input and output formats.

5. Examples and Test Scripts: Provide sample code and test cases to demonstrate how to use the `ingest_query()` function for repository analysis and content extraction (for example, `ingest_query(local_path="./", max_file_size = 1000000, ignore_patterns="tests/")` should return a structured summary). The above functions need to be combined to build a complete code repository analysis toolkit. The project should ultimately include modules such as cloning, scanning, extraction, and conversion, along with typical test cases, to form a reproducible analysis process.

6. Core File Requirements: The project must include a complete pyproject.toml file, which needs to configure the project as an installable package (supporting `pip install`), accurately declare the complete list of dependencies (covering core runtime dependencies such as click, fastapi, pathspec, pydantic, python - dotenv, tiktoken, uvicorn, and development dependencies such as pytest, coverage), and manage extended dependencies such as testing, documentation, and development tools through **project.optional - dependencies** grouping. The pyproject.toml needs to configure the complete build system (build - system) and project metadata (project) to ensure that all development environment dependencies can be installed via `pip install -e .[dev]` and support comprehensive functional test verification via pytest. At the same time, it is necessary to provide `src/gitingest/__init__.py` as a unified API entry. This file needs to import core functions from modules such as cloning, ingestion, notebook_utils, export configuration classes such as IngestionQuery and CloneConfig, and provide version information conforming to the semantic versioning specification through the `__version__` variable. The API design should follow the principle of least surprise, ensuring that users can access all major functions through a simple "from gitingest import ingest_query, clone_repo" statement while hiding internal implementation details. In `server/main.py`, it is necessary to implement the `process_query()` function conforming to the FastAPI specification. This function needs to handle Web request parameter validation, authentication and authorization, asynchronous task scheduling, and call core functions such as ingest_query to perform repository analysis, and finally return a structured JSON response. The function should include a complete exception handling mechanism, capable of capturing and returning custom exceptions such as InvalidGitHubTokenError and AsyncTimeoutError, and providing interface documentation conforming to the OpenAPI specification.

---

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.9.23

### Core Dependency Library Versions

```Plain
annotated-types          0.7.0
anyio                    4.10.0
astroid                  3.3.11
backports.asyncio.runner 1.2.0
black                    25.1.0
certifi                  2025.8.3
cfgv                     3.4.0
charset-normalizer       3.4.3
click                    8.1.8
colorama                 0.4.6
cssbeautifier            1.15.4
Deprecated               1.2.18
dill                     0.4.0
distlib                  0.4.0
djlint                   1.36.4
dnspython                2.7.0
EditorConfig             0.17.1
email_validator          2.2.0
exceptiongroup           1.3.0
fastapi                  0.116.1
fastapi-cli              0.0.8
fastapi-cloud-cli        0.1.5
filelock                 3.19.1
h11                      0.16.0
httpcore                 1.0.9
httptools                0.6.4
httpx                    0.28.1
identify                 2.6.13
idna                     3.10
iniconfig                2.1.0
isort                    6.0.1
Jinja2                   3.1.6
jsbeautifier             1.15.4
json5                    0.12.1
limits                   4.2
markdown-it-py           3.0.0
MarkupSafe               3.0.2
mccabe                   0.7.0
mdurl                    0.1.2
mypy_extensions          1.1.0
nodeenv                  1.9.1
packaging                24.2
pathspec                 0.12.1
pip                      23.0.1
platformdirs             4.3.8
pluggy                   1.6.0
pre_commit               4.3.0
pydantic                 2.11.7
pydantic_core            2.33.2
Pygments                 2.19.2
pylint                   3.3.8
python-dotenv            1.1.1
python-multipart         0.0.20
PyYAML                   6.0.2
regex                    2025.7.34
requests                 2.32.5
rich                     14.1.0
rich-toolkit             0.15.0
rignore                  0.6.4
sentry-sdk               2.35.0
setuptools               58.1.0
shellingham              1.5.4
six                      1.17.0
slowapi                  0.1.9
sniffio                  1.3.1
starlette                0.47.2
tiktoken                 0.11.0
tomli                    2.2.1
tomlkit                  0.13.3
tqdm                     4.67.1
typer                    0.16.1
typing_extensions        4.14.1
typing-inspection        0.4.1
urllib3                  2.5.0
uvicorn                  0.35.0
uvloop                   0.21.0
virtualenv               20.34.0
watchfiles               1.1.0
websockets               15.0.1
wheel                    0.45.1
wrapt                    1.17.3
```

## GitIngest Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .dockerignore
├── .env.example
├── .gitignore
├── .pre-commit-config.yaml
├── .release-please-manifest.json
├── .vscode
│   └── launch.json
├── CHANGELOG.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── Dockerfile
├── LICENSE
├── README.md
├── SECURITY.md
├── compose.yml
├── docs
│   ├── frontpage.png
├── eslint.config.cjs
├── release-please-config.json
├── renovate.json
└── src
    ├── gitingest
    │   ├── __init__.py
    │   ├── __main__.py
    │   ├── clone.py
    │   ├── config.py
    │   ├── entrypoint.py
    │   ├── ingestion.py
    │   ├── output_formatter.py
    │   ├── query_parser.py
    │   ├── schemas
    │   │   ├── __init__.py
    │   │   ├── cloning.py
    │   │   ├── filesystem.py
    │   │   ├── ingestion.py
    │   ├── utils
    │   │   ├── __init__.py
    │   │   ├── auth.py
    │   │   ├── compat_func.py
    │   │   ├── compat_typing.py
    │   │   ├── exceptions.py
    │   │   ├── file_utils.py
    │   │   ├── git_utils.py
    │   │   ├── ignore_patterns.py
    │   │   ├── ingestion_utils.py
    │   │   ├── logging_config.py
    │   │   ├── notebook.py
    │   │   ├── os_utils.py
    │   │   ├── pattern_utils.py
    │   │   ├── query_parser_utils.py
    │   │   └── timeout_wrapper.py
    ├── server
    │   ├── __init__.py
    │   ├── __main__.py
    │   ├── form_types.py
    │   ├── main.py
    │   ├── metrics_server.py
    │   ├── models.py
    │   ├── query_processor.py
    │   ├── routers
    │   │   ├── __init__.py
    │   │   ├── dynamic.py
    │   │   ├── index.py
    │   │   ├── ingest.py
    │   ├── routers_utils.py
    │   ├── s3_utils.py
    │   ├── server_config.py
    │   ├── server_utils.py
    │   ├── templates
    │   │   ├── base.jinja
    │   │   ├── components
    │   │   │   ├── _macros.jinja
    │   │   │   ├── footer.jinja
    │   │   │   ├── git_form.jinja
    │   │   │   ├── navbar.jinja
    │   │   │   ├── result.jinja
    │   │   │   ├── tailwind_components.html
    │   │   ├── git.jinja
    │   │   ├── index.jinja
    │   │   └── swagger_ui.jinja
    └── pyproject.toml


``` 

---

## API Usage Guide

### Core API

#### 0. Constant

**Configuration Constants Description**

The following constants define the core configuration limits and default values for the GitIngest project:

##### File Processing Limit Constants

- **MAX_FILE_SIZE** (int): `10485760` (10MB)  
  - **Purpose**: Maximum bytes for processing a single file
  - **Use Case**: File size limit check during file content extraction
  - **Import Path**: `from gitingest.config import MAX_FILE_SIZE`

- **MAX_DIRECTORY_DEPTH** (int): `20`  
  - **Purpose**: Maximum depth for directory traversal
  - **Use Case**: Prevent excessive depth during recursive directory scanning
  - **Import Path**: `from gitingest.config import MAX_DIRECTORY_DEPTH`

- **MAX_FILES** (int): `10000`  
  - **Purpose**: Maximum number of files to process
  - **Use Case**: Prevent performance issues from processing too many files
  - **Import Path**: `from gitingest.config import MAX_FILES`

- **MAX_TOTAL_SIZE_BYTES** (int): `524288000` (500MB)  
  - **Purpose**: Maximum total size of output files
  - **Use Case**: Limit the total size of generated summary files
  - **Import Path**: `from gitingest.config import MAX_TOTAL_SIZE_BYTES`

##### Timeout and Output Constants 

- **DEFAULT_TIMEOUT** (int): `60`  
  - **Purpose**: Default operation timeout in seconds
  - **Use Case**: Default timeout limit for Git cloning operations
  - **Import Path**: `from gitingest.config import DEFAULT_TIMEOUT`

- **OUTPUT_FILE_NAME** (str): `"digest.txt"`  
  - **Purpose**: Default output filename
  - **Use Case**: Default output file name for CLI
  - **Import Path**: `from gitingest.config import OUTPUT_FILE_NAME`

- **TMP_BASE_PATH** (Path): `Path(tempfile.gettempdir()) / "gitingest"`  
  - **Purpose**: Base path for temporary files
  - **Use Case**: Store temporary files for cloned repositories
  - **Import Path**: `from gitingest.config import TMP_BASE_PATH`

##### File Processing Internal Constants 

- **_CHUNK_SIZE** (int): `1024`  
  - **Purpose**: Block size in bytes for file reading
  - **Use Case**: Read first N bytes of file for binary file detection
  - **Import Path**: `from gitingest.utils.file_utils import _CHUNK_SIZE`  
  - **Note**: This is an internal implementation constant

##### Git URL Parsing Constants 

- **HEX_DIGITS** (set[str]): `set(string.hexdigits)`  
  - **Purpose**: Set of hexadecimal digit characters
  - **Use Case**: Validate Git commit hash format
  - **Import Path**: `from gitingest.utils.query_parser_utils import HEX_DIGITS`

- **KNOWN_GIT_HOSTS** (list[str]):  
  ```python
  [
      "github.com",
      "gitlab.com", 
      "bitbucket.org",
      "gitea.com",
      "codeberg.org",
      "gist.github.com"
  ]
  ```
  - **Purpose**: List of known Git hosting service hosts
  - **Use Case**: URL parsing and hostname validation
  - **Import Path**: `from gitingest.utils.query_parser_utils import KNOWN_GIT_HOSTS`

##### GitHub Token Pattern Constants 

- **_GITHUB_PAT_PATTERN** (str):  
  ```
  r"^(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59})$"
  ```
  - **Purpose**: Regular expression pattern for GitHub Personal Access Tokens
  - **Use Case**: Validate GitHub token format validity
  - **Import Path**: `from gitingest.utils.git_utils import _GITHUB_PAT_PATTERN`  
  - **Note**: This is an internal implementation constant

##### Default Ignore Pattern Constants 

- **DEFAULT_IGNORE_PATTERNS** (set[str]): Contains many common ignore patterns  
  - **Purpose**: Default set of file/directory ignore patterns (such as `*.pyc`, `node_modules/`, `.git/`, etc.)
  - **Use Case**: Default file patterns to exclude during file scanning
  - **Default Value Example**: 
    ```python
 DEFAULT_IGNORE_PATTERNS: set[str] = {
    # Python
    "*.pyc",
    "*.pyo",
    "*.pyd",
    "__pycache__",
    ".pytest_cache",
    ".coverage",
    ".tox",
    ".nox",
    ".mypy_cache",
    ".ruff_cache",
    ".hypothesis",
    "poetry.lock",
    "Pipfile.lock",
    # JavaScript/FileSystemNode
    "node_modules",
    "bower_components",
    "package-lock.json",
    "yarn.lock",
    ".npm",
    ".yarn",
    ".pnpm-store",
    "bun.lock",
    "bun.lockb",
    # Java
    "*.class",
    "*.jar",
    "*.war",
    "*.ear",
    "*.nar",
    ".gradle/",
    "build/",
    ".settings/",
    ".classpath",
    "gradle-app.setting",
    "*.gradle",
    # IDEs and editors / Java
    ".project",
    # C/C++
    "*.o",
    "*.obj",
    "*.dll",
    "*.dylib",
    "*.exe",
    "*.lib",
    "*.out",
    "*.a",
    "*.pdb",
    # Binary
    "*.bin",
    # Swift/Xcode
    ".build/",
    "*.xcodeproj/",
    "*.xcworkspace/",
    "*.pbxuser",
    "*.mode1v3",
    "*.mode2v3",
    "*.perspectivev3",
    "*.xcuserstate",
    "xcuserdata/",
    ".swiftpm/",
    # Ruby
    "*.gem",
    ".bundle/",
    "vendor/bundle",
    "Gemfile.lock",
    ".ruby-version",
    ".ruby-gemset",
    ".rvmrc",
    # Rust
    "Cargo.lock",
    "**/*.rs.bk",
    # Java / Rust
    "target/",
    # Go
    "pkg/",
    # .NET/C#
    "obj/",
    "*.suo",
    "*.user",
    "*.userosscache",
    "*.sln.docstates",
    "*.nupkg",
    # Go / .NET / C#
    "bin/",
    # Version control
    ".git",
    ".svn",
    ".hg",
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    # Images and media
    "*.svg",
    "*.png",
    "*.jpg",
    "*.jpeg",
    "*.gif",
    "*.ico",
    "*.pdf",
    "*.mov",
    "*.mp4",
    "*.mp3",
    "*.wav",
    # Virtual environments
    "venv",
    ".venv",
    "env",
    ".env",
    "virtualenv",
    # IDEs and editors
    ".idea",
    ".vscode",
    ".vs",
    "*.swo",
    "*.swn",
    ".settings",
    "*.sublime-*",
    # Temporary and cache files
    "*.log",
    "*.bak",
    "*.swp",
    "*.tmp",
    "*.temp",
    ".cache",
    ".sass-cache",
    ".eslintcache",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    # Build directories and artifacts
    "build",
    "dist",
    "target",
    "out",
    "*.egg-info",
    "*.egg",
    "*.whl",
    "*.so",
    # Documentation
    "site-packages",
    ".docusaurus",
    ".next",
    ".nuxt",
    # Database
    "*.db",
    "*.sqlite",
    "*.sqlite3",
    # Other common patterns
    ## Minified files
    "*.min.js",
    "*.min.css",
    ## Source maps
    "*.map",
    ## Terraform
    "*.tfstate*",
    ## Dependencies in various languages
    "vendor/",
    # Gitingest
    "digest.txt",
}
    ```
  - **Import Path**: `from gitingest.utils.ignore_patterns import DEFAULT_IGNORE_PATTERNS`

##### Pattern Processing Constants 

- **_PATTERN_SPLIT_RE** (re.Pattern): `re.compile(r"[,\s]+")`  
  - **Purpose**: Regular expression for splitting multiple pattern strings
  - **Use Case**: Parse comma or space-separated file patterns
  - **Import Path**: `from gitingest.utils.pattern_utils import _PATTERN_SPLIT_RE`  
  - **Note**: This is an internal implementation constant

##### File System Representation Constants 

- **SEPARATOR** (str): `"=" * 48`  
  - **Purpose**: File content separator (48 equal signs)
  - **Use Case**: Separate content of different files in summary output. Tiktoken tokenizer counts this as 2 tokens
  - **Import Path**: `from gitingest.schemas.filesystem import SEPARATOR`

##### Output Formatting Constants 

- **_TOKEN_THRESHOLDS** (list[tuple[int, str]]): `[(1000000, "M"), (1000, "k")]`  
  - **Purpose**: Token count formatting thresholds
  - **Use Case**: Convert large numbers to readable format (e.g., 1500000 → "1.5M")
  - **Import Path**: `from gitingest.output_formatter import _TOKEN_THRESHOLDS`  
  - **Note**: This is an internal implementation constant

##### Server Configuration Constants 

- **MAX_DISPLAY_SIZE** (int): `300000`  
  - **Purpose**: Maximum content display size (character count)
  - **Use Case**: Length limit for content displayed in web interface
  - **Import Path**: `from server.server_config import MAX_DISPLAY_SIZE`

- **DEFAULT_FILE_SIZE_KB** (int): `5120` (5MB)  
  - **Purpose**: Default file size slider position (KB)
  - **Use Case**: Default value for web interface file size filter
  - **Import Path**: `from server.server_config import DEFAULT_FILE_SIZE_KB`

- **MAX_FILE_SIZE_KB** (int): `102400` (100MB)  
  - **Purpose**: Maximum file size slider position (KB)
  - **Use Case**: Upper limit for web interface file size filter
  - **Import Path**: `from server.server_config import MAX_FILE_SIZE_KB`

- **EXAMPLE_REPOS** (list[dict[str, str]]):  [
    {"name": "Gitingest", "url": "https://github.com/coderamp-labs/gitingest"},
    {"name": "FastAPI", "url": "https://github.com/fastapi/fastapi"},
    {"name": "Flask", "url": "https://github.com/pallets/flask"},
    {"name": "Excalidraw", "url": "https://github.com/excalidraw/excalidraw"},
    {"name": "ApiAnalytics", "url": "https://github.com/tom-draper/api-analytics"},
]  
  - **Purpose**: Example repositories displayed in web interface
  - **Use Case**: Provide users with quick testing options
  - **Import Path**: `from server.server_config import EXAMPLE_REPOS`

- **APP_REPOSITORY** (str): `os.getenv("APP_REPOSITORY", "https://github.com/coderamp-labs/gitingest")`  
  - **Purpose**: Application repository URL
  - **Use Case**: Version information and link display
  - **Import Path**: `from server.server_config import APP_REPOSITORY`

- **APP_VERSION** (str): `os.getenv("APP_VERSION", "unknown")`  
  - **Purpose**: Application version number
  - **Use Case**: Version display
  - **Import Path**: `from server.server_config import APP_VERSION`

- **APP_VERSION_URL** (str): `os.getenv("APP_VERSION_URL", "https://github.com/coderamp-labs/gitingest")`  
  - **Purpose**: Version-specific URL
  - **Use Case**: Link to specific version of code
  - **Import Path**: `from server.server_config import APP_VERSION_URL`

- _s3_ingest_lookup_counter = Counter("gitingest_s3_ingest_lookup", "Number of S3 ingest file lookups")
  - **Import Path**: `from server.s3_utils import _s3_ingest_lookup_counter`
- _s3_ingest_hit_counter = Counter("gitingest_s3_ingest_hit", "Number of S3 ingest file cache hits")
  - **Import Path**: `from server.s3_utils import _s3_ingest_hit_counter`
- _s3_ingest_miss_counter = Counter("gitingest_s3_ingest_miss", "Number of S3 ingest file cache misses")
  - **Import Path**: `from server.s3_utils import _s3_ingest_miss_counter`

- COMMON_INGEST_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_200_OK: {"model": IngestSuccessResponse, "description": "Successful ingestion"},
    status.HTTP_400_BAD_REQUEST: {"model": IngestErrorResponse, "description": "Bad request or processing error"},
    status.HTTP_500_INTERNAL_SERVER_ERROR: {"model": IngestErrorResponse, "description": "Internal server error"},
}
  - **Import Path**: `from server.routers_utils import _s3_ingest_miss_counter`


#### 1. Module Import

```python
from pathlib import Path
from types import TracebackType
from typing import Annotated, Any, Awaitable, Callable, Generator, Optional, TypeAlias, TypeVar
from uuid import UUID

from fastapi import Form

from gitingest.utils.compat_typing import ParamSpec

# Type variables for generic functions
T = TypeVar("T")
P = ParamSpec("P")

# Type aliases from server.form_types
StrForm: TypeAlias = Annotated[str, Form(...)]
IntForm: TypeAlias = Annotated[int, Form(...)]
OptStrForm: TypeAlias = Annotated[Optional[str], Form()]

# Module export lists (__all__ definitions)
# gitingest.__init__.__all__ = ['ingest', 'ingest_async']
# gitingest.schemas.__init__.__all__ = ['CloneConfig', 'FileSystemNode', 'FileSystemNodeType', 'FileSystemStats', 'IngestionQuery']
# gitingest.utils.compat_typing.__all__ = ['Annotated', 'ParamSpec', 'StrEnum', 'TypeAlias']
# server.routers.__init__.__all__ = ['dynamic', 'index', 'ingest']

import git
from botocore.client import BaseClient

from gitingest.schemas.ingestion import IngestionQuery
from gitingest.__main__ import main
from gitingest.config import MAX_FILE_SIZE, OUTPUT_FILE_NAME
from gitingest.utils.exceptions import InvalidGitHubTokenError, AsyncTimeoutError
from gitingest.utils.git_utils import (
    create_git_auth_header,
    create_git_repo,
    validate_github_token,
    check_repo_exists,
)
from gitingest.entrypoint import ingest_async
from gitingest.utils.ignore_patterns import load_ignore_patterns
from gitingest.ingestion import ingest_query
from gitingest.utils.notebook import process_notebook
from gitingest.clone import clone_repo
from gitingest.schemas.cloning import CloneConfig
from gitingest.schemas.filesystem import FileSystemStats
from server.models import PatternType, IngestResponse, IngestSuccessResponse, IngestErrorResponse, S3Metadata
```

#### 2. _CLIArgs Class - CLI Arguments Type Definition

**Function**: Type definition for command-line interface arguments used in GitIngest CLI.

**Class Structure**:
```python
from gitingest.__main__ import _CLIArgs

from typing import TypedDict

class _CLIArgs(TypedDict):
    source: str
    max_size: int
    exclude_pattern: tuple[str, ...]
    include_pattern: tuple[str, ...]
    branch: str | None
    include_gitignored: bool
    include_submodules: bool
    token: str | None
    output: str | None
```

**Parameter Description**:
- `source` (str): Repository URL or local directory path to analyze
- `max_size` (int): Maximum file size to process in bytes
- `exclude_pattern` (tuple): Shell-style patterns to exclude files
- `include_pattern` (tuple): Shell-style patterns to include files
- `branch` (str | None): Git branch to clone and ingest
- `include_gitignored` (bool): Include files matched by .gitignore
- `include_submodules` (bool): Include repository's submodules in analysis
- `token` (str | None): GitHub personal access token for private repos
- `output` (str | None): Output file path or '-' for stdout

#### 3. ingest_query() Function - Codebase Analysis Entry Point

**Function**: Main entry point for analyzing a codebase directory or single file. Processes query parameters, reads file or directory content, and generates a summary, directory structure, and file content, along with token estimations.

**Function Signature**:
```python
from gitingest.ingestion import ingest_query
from gitingest.schemas.ingestion import IngestionQuery

def ingest_query(query: IngestionQuery) -> tuple[str, str, str]:
    """Run the ingestion process for a parsed query.

    This is the main entry point for analyzing a codebase directory or single file. It processes the query
    parameters, reads the file or directory content, and generates a summary, directory structure, and file content,
    along with token estimations.

    Parameters
    ----------
    query : IngestionQuery
        The parsed query object containing information about the repository and query parameters.

    Returns
    -------
    tuple[str, str, str]
        A tuple containing the summary, directory structure, and file contents.

    Raises
    ------
    ValueError
        If the path cannot be found, is not a file, or the file has no content.

    """
```

**Parameters**:
- `query` (IngestionQuery): The parsed query object containing information about the repository and query parameters.

**Return Value**: A tuple containing the summary, directory structure, and file contents.

**Exceptions**:
- `ValueError`: Thrown if the path cannot be found, is not a file, or the file has no content.



#### 4. Exception Classes - Error Handling

**Function**: Custom exception classes for GitIngest error handling and validation.

**Exception Classes**:

##### InvalidNotebookError
```python
from gitingest.utils.exceptions import InvalidNotebookError

class InvalidNotebookError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
```
- **Import Path**: `from gitingest.utils.exceptions import InvalidNotebookError`
- **Bases**: Exception
- **Purpose**: Raised when a Jupyter notebook is invalid or cannot be processed
- **Constructor Parameters**:
  - `message` (str, required): Error description message
- **Returns**: None

##### AsyncTimeoutError
```python
from gitingest.utils.exceptions import AsyncTimeoutError

class AsyncTimeoutError(Exception):
    pass
```
- **Import Path**: `from gitingest.utils.exceptions import AsyncTimeoutError`
- **Bases**: Exception
- **Purpose**: Raised when an async operation exceeds its timeout limit
- **Usage**: Used by `async_timeout` decorator for timeout handling
- **Constructor Parameters**: None
- **Returns**: None

##### InvalidGitHubTokenError
```python
from gitingest.utils.exceptions import InvalidGitHubTokenError

class InvalidGitHubTokenError(ValueError):
    def __init__(self) -> None:
        msg = "Invalid GitHub token format. To generate a token, go to https://github.com/settings/tokens/new"
        super().__init__(msg)
```
- **Import Path**: `from gitingest.utils.exceptions import InvalidGitHubTokenError`
- **Bases**: ValueError
- **Purpose**: Raised when a GitHub Personal Access Token is malformed
- **Constructor Parameters**: None
- **Returns**: None

#### 5. Server Model Classes - API Data Structures

**Function**: Pydantic models for server-side data validation and API responses.

**Missing Classes from logchangliang**:

##### S3UploadError
```python
from server.s3_utils import S3UploadError

class S3UploadError(Exception):
    """Custom exception for S3 upload failures."""
```
- **Import Path**: `from server.s3_utils import S3UploadError`
- **Bases**: Exception
- **Purpose**: Custom exception for S3 upload failures
- **Usage**: Error handling for cloud storage operations

##### Colors
```python
from server.server_utils import Colors

class Colors:
    """ANSI color codes."""

    BLACK = "\033[0;30m"
    RED = "\033[0;31m"
    GREEN = "\033[0;32m"
    BROWN = "\033[0;33m"
    BLUE = "\033[0;34m"
    PURPLE = "\033[0;35m"
    CYAN = "\033[0;36m"
    LIGHT_GRAY = "\033[0;37m"
    DARK_GRAY = "\033[1;30m"
    LIGHT_RED = "\033[1;31m"
    LIGHT_GREEN = "\033[1;32m"
    YELLOW = "\033[1;33m"
    LIGHT_BLUE = "\033[1;34m"
    LIGHT_PURPLE = "\033[1;35m"
    LIGHT_CYAN = "\033[1;36m"
    WHITE = "\033[1;37m"
    BOLD = "\033[1m"
    FAINT = "\033[2m"
    ITALIC = "\033[3m"
    UNDERLINE = "\033[4m"
    BLINK = "\033[5m"
    NEGATIVE = "\033[7m"
    CROSSED = "\033[9m"
    END = "\033[0m"
```
- **Import Path**: `from server.server_utils import Colors`
- **Bases**: None (plain class)
- **Purpose**: ANSI color codes for terminal output formatting
- **Usage**: Colorized console output in server and CLI operations
- **Key Attributes**: ANSI escape codes for terminal colors

**Model Classes**:

##### PatternType
```python
# Import Path:
from server.models import PatternType

from enum import Enum

class PatternType(str, Enum):
    INCLUDE = "include"
    EXCLUDE = "exclude"
```
- **Purpose**: Enumeration for pattern types used in file filtering

##### IngestRequest
```python
# Import Path:
from server.models import IngestRequest

from pydantic import BaseModel

class IngestRequest(BaseModel):

  input_text: str = Field(..., description="Git repository URL or slug to ingest")
    max_file_size: int = Field(..., ge=1, le=MAX_FILE_SIZE_KB, description="File size in KB")
    pattern_type: PatternType = Field(default=PatternType.EXCLUDE, description="Pattern type for file filtering")
    pattern: str = Field(default="", description="Glob/regex pattern for file filtering")
    token: str | None = Field(default=None, description="GitHub PAT for private repositories")
    
    @classmethod
    def validate_input_text(cls, v: str) -> str:
        """Validate input text field"""
        
    @classmethod
    def validate_pattern(cls, v: str) -> str:
        """Validate pattern field"""
```
- **Import Path**: `from server.models import IngestRequest`
- **Bases**: BaseModel (Pydantic)
- **Purpose**: Request model for the /api/ingest endpoint
- **Validation**: Includes field validators for input_text and pattern
- **Key Methods**:
  - `validate_input_text(cls, v: str) -> str` - Validate input text field
  - `validate_pattern(cls, v: str) -> str` - Validate pattern field

##### IngestSuccessResponse
```python
# Import Path:
from server.models import IngestSuccessResponse

from pydantic import BaseModel

class IngestSuccessResponse(BaseModel):
    repo_url: str = Field(..., description="Original repository URL")
    short_repo_url: str = Field(..., description="Short repository URL (user/repo)")
    summary: str = Field(..., description="Ingestion summary with token estimates")
    digest_url: str = Field(..., description="URL to download the full digest content")
    tree: str = Field(..., description="File tree structure")
    content: str = Field(..., description="Processed file content")
    default_max_file_size: int = Field(..., description="File size slider position used")
    pattern_type: str = Field(..., description="Pattern type used")
    pattern: str = Field(..., description="Pattern used")
```
- **Purpose**: Success response model for API endpoints
- **Returns**: Complete ingestion results with metadata

##### IngestErrorResponse
```python
from pydantic import BaseModel

class IngestErrorResponse(BaseModel):
    error: str = Field(..., description="Error message")
```
- **Purpose**: Error response model for API endpoints
- **Returns**: Error message when ingestion fails

##### S3Metadata
```python
from pydantic import BaseModel

class S3Metadata(BaseModel):
    summary: str = Field(..., description="Ingestion summary with token estimates")
    tree: str = Field(..., description="File tree structure")
    content: str = Field(..., description="Processed file content")
```
- **Purpose**: Model for S3 metadata structure
- **Usage**: Storage format for cached digest content

##### QueryForm
```python
from pydantic import BaseModel

class QueryForm(BaseModel):
    input_text: str
    max_file_size: int
    pattern_type: str
    pattern: str
    token: str | None = None
    
    @classmethod
    def as_form(cls, input_text, max_file_size, pattern_type, pattern, token) -> QueryForm:
        return cls(...)
```
- **Purpose**: Form data model for query processing
- **Method**: `as_form` classmethod for FastAPI form creation

#### 6. clone_repo Function - Git Repository Cloning

**Functionality**: Clones a Git repository to a local path based on the provided configuration.

**Function Signature**:
```python
@async_timeout(DEFAULT_TIMEOUT)
async def clone_repo(config: CloneConfig, *, token: str | None = None) -> None:
    """Clone a repository to a local path based on the provided configuration.

    This function handles the process of cloning a Git repository to the local file system.
    It can clone a specific branch, tag, or commit if provided, and it raises exceptions if
    any errors occur during the cloning process.

    Parameters
    ----------
    config : CloneConfig
        The configuration for cloning the repository.
    token : str | None
        GitHub personal access token (PAT) for accessing private repositories.

    Raises
    ------
    ValueError
        If the repository is not found, if the provided URL is invalid, or if the token format is invalid.
    RuntimeError
        If Git operations fail during the cloning process.

    """
```

**Parameter Description**:
- `config` (CloneConfig): A configuration object for cloning the repository, containing the following attributes:
  - `url` (str): The URL of the Git repository to clone
  - `local_path` (str): The local path where the repository will be stored
  - `subpath` (str, default: "/"): If specified, performs a partial clone (sparse checkout)
  - `branch` (str | None): The branch to clone
  - `tag` (str | None): The tag to clone
  - `commit` (str | None): The specific commit to checkout
  - `include_submodules` (bool): Whether to include submodules
  - `timeout` (int): Operation timeout in seconds

- `token` (str | None): GitHub Personal Access Token (PAT) for accessing private repositories

**Return Value**:
- No return value. Silently returns upon successful completion, throws an exception on failure.

**Possible Exceptions**:
- `ValueError`: Thrown when the repository does not exist, the provided URL is invalid, or the token format is invalid
- `RuntimeError`: Thrown when a Git operation fails

**Functional Description**:
1. Verify if Git is installed
2. Create the local directory structure
3. Call the `check_repo_exists` function to check if the repository exists
4. Parse commit references
5. Execute Git clone operations, supporting the following modes:
   - Full clone
   - Partial clone (when subpath is specified)
   - Authenticated clone (when a token is provided)
6. If submodules are configured, initialize and update them
7. Checkout the specified commit, branch, or tag

#### 7. Utility Classes - Supporting Infrastructure

**Function**: Utility classes for logging, query parsing, S3 operations, and terminal output formatting.

**Utility Classes**:

##### CloneConfig
```python
from gitingest.schemas.cloning import CloneConfig

class CloneConfig(BaseModel):
    url: str
    local_path: str
    commit: str | None = None
    branch: str | None = None
    tag: str | None = None
    subpath: str = Field(default="/")
    blob: bool = Field(default=False)
    include_submodules: bool = Field(default=False)
```
- **Import Path**: `from gitingest.schemas.cloning import CloneConfig`
- **Bases**: BaseModel (Pydantic)
- **Purpose**: Configuration model for cloning Git repositories to local paths
- **Key Attributes**:
  - `url` (str) - Git repository URL to clone
  - `local_path` (str) - Target local directory path
  - `commit` (str | None) - Specific commit hash to checkout (default: None)
  - `branch` (str | None) - Branch to clone (default: None)
  - `tag` (str | None) - Tag to clone (default: None)
  - `subpath` (str) - Subpath to clone from repository (default: "/")
  - `blob` (bool) - Whether repository is a blob (default: False)
  - `include_submodules` (bool) - Whether to clone submodules (default: False)

##### FileSystemNode
```python
from gitingest.schemas.filesystem import FileSystemNode

@dataclass
class FileSystemNode:
    name: str
    type: FileSystemNodeType
    path_str: str
    path: Path
    size: int = 0
    file_count: int = 0
    dir_count: int = 0
    depth: int = 0
    children: list[FileSystemNode] = field(default_factory=list)
    
    def sort_children(self) -> None
    @property
    def content_string(self) -> str
    @property
    def content(self) -> str
```
- **Import Path**: `from gitingest.schemas.filesystem import FileSystemNode`
- **Bases**: dataclass (no explicit inheritance)
- **Purpose**: Dataclass representing filesystem node (file or directory) with properties for analysis
- **Constructor Parameters**:
  - `name` (str, required): Node name
  - `type` (FileSystemNodeType, required): Node type (FILE, DIRECTORY, SYMLINK)
  - `path_str` (str, required): String representation of path
  - `path` (Path, required): Path object
  - `size` (int, optional): File size in bytes, default is 0
  - `file_count` (int, optional): Number of files in directory, default is 0
  - `dir_count` (int, optional): Number of subdirectories, default is 0
  - `depth` (int, optional): Directory depth, default is 0
  - `children` (list[FileSystemNode], optional): Child nodes, default is empty list
- **Key Methods**:
  - `sort_children() -> None` - Sort children by priority: README, regular files, hidden files, regular dirs, hidden dirs
  - `content_string` (property) -> str - Get node content as formatted string with path and content
  - `content` (property) -> str - Get file content (for files) or raise ValueError (for directories)
- **Returns**: None (constructor)

##### FileSystemNodeType
```python
from gitingest.schemas.filesystem import FileSystemNodeType

class FileSystemNodeType(Enum):
    DIRECTORY = auto()
    FILE = auto()
    SYMLINK = auto()
```
- **Import Path**: `from gitingest.schemas.filesystem import FileSystemNodeType`
- **Bases**: Enum
- **Purpose**: Enumeration for filesystem node types
- **Values**: DIRECTORY, FILE, SYMLINK

##### FileSystemStats
```python
from gitingest.schemas.filesystem import FileSystemStats

@dataclass
class FileSystemStats:
    total_files: int = 0
    total_size: int = 0
```
- **Import Path**: `from gitingest.schemas.filesystem import FileSystemStats`
- **Bases**: dataclass (no explicit inheritance)
- **Purpose**: Statistics tracking during filesystem traversal
- **Key Attributes**:
  - `total_files` (int) - Total number of files processed (default: 0)
  - `total_size` (int) - Total size of files in bytes (default: 0)

##### InterceptHandler
```python
from gitingest.utils.logging_config import InterceptHandler

class InterceptHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        # Intercept standard library logging and redirect to loguru
```
- **Import Path**: `from gitingest.utils.logging_config import InterceptHandler`
- **Bases**: logging.Handler
- **Purpose**: Intercept standard library logging and redirect to loguru
- **Key Methods**: `emit(record: logging.LogRecord) -> None` - Process log record and redirect to loguru

##### IngestionQuery
```python
from gitingest.schemas.ingestion import IngestionQuery

class IngestionQuery(BaseModel):
    host: str | None = None
    user_name: str | None = None
    repo_name: str | None = None
    local_path: Path
    url: str | None = None
    slug: str
    id: UUID
    subpath: str = "/"
    type: str | None = None
    branch: str | None = None
    commit: str | None = None
    tag: str | None = None
    max_file_size: int = MAX_FILE_SIZE
    ignore_patterns: set[str] = set()
    include_patterns: set[str] | None = None
    include_submodules: bool = False
    s3_url: str | None = None
    
    def extract_clone_config(self) -> CloneConfig
```
- **Import Path**: `from gitingest.schemas.ingestion import IngestionQuery`
- **Bases**: BaseModel (Pydantic)
- **Purpose**: Pydantic model storing parsed details of repository or file path query
- **Key Attributes**:
  - `host` (str | None) - Repository host (default: None)
  - `user_name` (str | None) - Repository owner/username (default: None)
  - `repo_name` (str | None) - Repository name (default: None)
  - `local_path` (Path) - Local path to repository or file (required)
  - `url` (str | None) - Repository URL (default: None)
  - `slug` (str) - Repository slug (required)
  - `id` (UUID) - Repository UUID (required)
  - `subpath` (str) - Subpath within repository (default: "/")
  - `type` (str | None) - Repository or file type (default: None)
  - `branch` (str | None) - Branch to use (default: None)
  - `commit` (str | None) - Commit hash (default: None)
  - `tag` (str | None) - Tag to use (default: None)
  - `max_file_size` (int) - Maximum file size in bytes (default: MAX_FILE_SIZE = 10MB)
  - `ignore_patterns` (set[str]) - Patterns to ignore (default: empty set)
  - `include_patterns` (set[str] | None) - Patterns to include (default: None)
  - `include_submodules` (bool) - Include Git submodules (default: False)
  - `s3_url` (str | None) - S3 URL for stored digest (default: None)
- **Key Methods**:
  - `extract_clone_config() -> CloneConfig` - Extract CloneConfig from IngestionQuery

##### PathKind
```python
from gitingest.utils.query_parser_utils import PathKind

class PathKind(StrEnum):
    TREE = "tree"
    BLOB = "blob"
    ISSUES = "issues"
    PULL = "pull"
```
- **Import Path**: `from gitingest.utils.query_parser_utils import PathKind`
- **Bases**: StrEnum
- **Purpose**: Enumeration for Git repository path types
- **Values**: TREE, BLOB, ISSUES, PULL

##### S3UploadError
```python
from server.s3_utils import S3UploadError

class S3UploadError(Exception):
    """Custom exception for S3 upload failures."""
```
- **Import Path**: `from server.s3_utils import S3UploadError`
- **Bases**: Exception
- **Purpose**: Custom exception for S3 upload failures
- **Usage**: Error handling for cloud storage operations


#### 8. process_notebook() Function - Notebook Processing

**Function**: Convert a Jupyter Notebook into a readable code format.

**Function Signature**:
```python
from gitingest.utils.notebook import process_notebook
from pathlib import Path

def process_notebook(file: Path, *, include_output: bool = True) -> str:
    """Process a Jupyter notebook file and return an executable Python script as a string.

    Parameters
    ----------
    file : Path
        The path to the Jupyter notebook file.
    include_output : bool
        Whether to include cell outputs in the generated script (default: ``True``).

    Returns
    -------
    str
        The executable Python script as a string.

    Raises
    ------
    InvalidNotebookError
        If the notebook file is invalid or cannot be processed.
```

**Import Path**: `from gitingest.utils.notebook import process_notebook`

**Parameters**:
- `file` (Path, required): Path to the Jupyter notebook file
- `include_output` (bool, optional): Whether to include cell outputs in generated script, default is True

**Returns**: 
- `str` - Executable Python script string converted from Jupyter notebook

**Raises**:
- InvalidNotebookError: If notebook file is invalid or cannot be processed

#### 9. process_query() Function - Web Query Processing

**Function**: Process a Web request and perform repository analysis.

**Function Signature**:
```python
from server.query_processor import process_query
from server.models import PatternType, IngestResponse

async def process_query(
    input_text: str,
    max_file_size: int,
    pattern_type: PatternType,
    pattern: str,
    token: str | None = None,
) -> IngestResponse:
```

**Import Path**: `from server.query_processor import process_query`

**Parameters**:
- `input_text` (str, required): Input text provided by user (Git repository URL or slug)
- `max_file_size` (int, required): Max file size in KB to include in digest
- `pattern_type` (PatternType, required): Type of pattern to use (either PatternType.INCLUDE or PatternType.EXCLUDE)
- `pattern` (str, required): Pattern to include or exclude in query
- `token` (str | None, optional): GitHub personal access token for private repositories, default is None

**Returns**: 
- `IngestResponse` (Union[IngestSuccessResponse, IngestErrorResponse]) - Either success response with ingestion results or error response with error message

**Note**: This function handles web request parameter validation, authentication, async task scheduling, and returns structured JSON response

#### 10. Utility Functions - Core Support Functions

**Function Description**: Core utility functions for Git operations, file processing, authentication, logging, and data manipulation.

**Missing Functions from logchangliang**:

##### _override_branch_and_tag()
```python
from gitingest.entrypoint import _override_branch_and_tag

def _override_branch_and_tag(query: IngestionQuery, branch: str | None, tag: str | None) -> None:
```
- **Import Path**: `from gitingest.entrypoint import _override_branch_and_tag`
- **Purpose**: Override branch and tag settings in ingestion query
- **Parameters**: 
  - `query` (IngestionQuery, required): Query object to modify
  - `branch` (str | None, required): Branch name
  - `tag` (str | None, required): Tag name
- **Returns**: None (modifies query in-place)

##### _apply_gitignores()
```python
from gitingest.entrypoint import _apply_gitignores

def _apply_gitignores(query: IngestionQuery) -> None:
```
- **Import Path**: `from gitingest.entrypoint import _apply_gitignores`
- **Purpose**: Apply .gitignore rules to ingestion query by loading and processing ignore patterns
- **Parameters**: 
  - `query` (IngestionQuery, required): Ingestion query object to modify with additional ignore patterns
- **Returns**: None (modifies query in-place by updating ignore_patterns)

##### _handle_remove_readonly()
```python
from gitingest.entrypoint import _handle_remove_readonly

def _handle_remove_readonly(func: Callable, path: str, exc_info: BaseException | tuple[type[BaseException], BaseException, TracebackType]) -> None:
```
- **Import Path**: `from gitingest.entrypoint import _handle_remove_readonly`
- **Purpose**: Handle permission errors raised by shutil.rmtree() by making files writable and retrying
- **Parameters**: 
  - `func` (Callable, required): The function that failed (e.g., os.remove)
  - `path` (str, required): File or directory path that caused the error
  - `exc_info` (BaseException | tuple, required): Exception information in onerror (tuple) or onexc (exception) format
- **Returns**: None

##### _process_node()
```python
from gitingest.ingestion import _process_node

def _process_node(node: FileSystemNode, query: IngestionQuery, stats: FileSystemStats) -> None:
```
- **Purpose**: Process a filesystem node recursively, building the file tree structure
- **Parameters**: 
  - `node` (FileSystemNode) - Current filesystem node to process
  - `query` (IngestionQuery) - Ingestion query configuration
  - `stats` (FileSystemStats) - Statistics tracking object
- **Returns**: None (modifies node structure in-place)

##### _process_symlink()
```python
from gitingest.ingestion import _process_symlink

def _process_symlink(path: Path, parent_node: FileSystemNode, stats: FileSystemStats, local_path: Path) -> None:
```
- **Purpose**: Process a symlink in the file system and add it to the file tree
- **Parameters**: 
  - `path` (Path) - The full path of the symlink
  - `parent_node` (FileSystemNode) - The parent directory node
  - `stats` (FileSystemStats) - Statistics tracking object for the total file count and size
  - `local_path` (Path) - The base path of the repository or directory being processed

##### _process_file()
```python
from gitingest.ingestion import _process_file

def _process_file(path: Path, parent_node: FileSystemNode, stats: FileSystemStats, local_path: Path) -> None:
```
- **Purpose**: Process a file in the file system, checking size limits and reading content
- **Parameters**: 
  - `path` (Path) - The full path of the file
  - `parent_node` (FileSystemNode) - The parent directory node to accumulate results
  - `stats` (FileSystemStats) - Statistics tracking object for the total file count and size
  - `local_path` (Path) - The base path of the repository or directory being processed

##### format_node()
```python
from gitingest.output_formatter import format_node

def format_node(node: FileSystemNode, query: IngestionQuery) -> tuple[str, str]:
```
- **Purpose**: Format a filesystem node into structured output with summary and content
- **Parameters**: 
  - `node` (FileSystemNode) - Root filesystem node to format
  - `query` (IngestionQuery) - Ingestion query configuration
- **Returns**: tuple[str, str] - (summary string, content string)

##### _create_summary_prefix()
```python
from gitingest.output_formatter import _create_summary_prefix

def _create_summary_prefix(query: IngestionQuery, *, single_file: bool = False) -> str:
```
- **Purpose**: Create summary header with repository information and statistics
- **Parameter**: `query` (IngestionQuery) - Ingestion query configuration
- **Returns**: str - Formatted summary header string

##### _gather_file_contents()
```python
from gitingest.output_formatter import _gather_file_contents

def _gather_file_contents(node: FileSystemNode) -> str:
```
- **Purpose**: Recursively gather file contents from filesystem node tree
- **Parameter**: `node` (FileSystemNode) - Root filesystem node
- **Returns**: str - Concatenated file contents with separators

##### _create_tree_structure()
```python
from gitingest.output_formatter import _create_tree_structure

def _create_tree_structure(
    query: IngestionQuery,
    *,
    node: FileSystemNode,
    prefix: str = "",
    is_last: bool = True,
) -> str:
```
- **Purpose**: Create directory tree structure representation
- **Parameter**: `query` (IngestionQuery) - Ingestion query configuration
- **Returns**: str - Formatted directory tree string

##### _format_token_count()
```python
from gitingest.output_formatter import _format_token_count

def _format_token_count(text: str) -> str | None:
```
- **Purpose**: Format token count into human-readable string (e.g., "1.5M", "2.3k")
- **Parameter**: `text` (str) - Text to count tokens for
- **Returns**: str - Formatted token count string

##### parse_local_dir_path()
```python
from gitingest.query_parser import parse_local_dir_path

def parse_local_dir_path(path_str: str) -> IngestionQuery:
```
- **Purpose**: Parse local directory path string into IngestionQuery object
- **Parameter**: `path_str` (str) - Local directory path string
- **Returns**: IngestionQuery - Parsed ingestion query object

##### _get_preferred_encodings()
```python
from gitingest.utils.file_utils import _get_preferred_encodings

def _get_preferred_encodings() -> list[str]:
```
- **Purpose**: Get list of text encodings to try, prioritized for the current platform
- **Returns**: list[str] - List of encoding names to try in priority order, starting with platform's default encoding followed by common fallback encodings

##### _read_chunk()
```python
from gitingest.utils.file_utils import _read_chunk

def _read_chunk(path: Path) -> bytes | None:
```
- **Purpose**: Attempt to read the first _CHUNK_SIZE bytes of a file in binary mode
- **Parameter**: `path` (Path) - The path to the file to read
- **Returns**: bytes | None - The first _CHUNK_SIZE bytes of the file, or None on any OSError

##### _decodes()
```python
from gitingest.utils.file_utils import _decodes

def _decodes(chunk: bytes, encoding: str) -> bool:
```
- **Purpose**: Check if a chunk of bytes can be decoded cleanly with the specified encoding
- **Parameters**: 
  - `chunk` (bytes) - The chunk of bytes to decode
  - `encoding` (str) - The encoding to use for decoding the chunk
- **Returns**: bool - True if the chunk decodes cleanly with the encoding, False otherwise

##### _parse_github_url()
```python
from gitingest.utils.git_utils import _parse_github_url

def _parse_github_url(url: str) -> tuple[str, str, str]:
```
- **Purpose**: Parse GitHub URL to extract hostname, owner, and repository name components
- **Parameter**: `url` (str) - GitHub repository URL in various formats (https/http, with/without .git suffix)
- **Returns**: tuple[str, str, str] - (hostname, owner, repository_name)

##### create_git_auth_header()
```python
from gitingest.utils.git_utils import create_git_auth_header

def create_git_auth_header(token: str, url: str = "https://github.com") -> str:
```
- **Purpose**: Create Git authentication header for HTTP requests
- **Parameters**: 
  - `token` (str) - GitHub access token
  - `url` (str) - Repository URL
- **Returns**: str - Authentication header string

##### validate_github_token()
```python
from gitingest.utils.git_utils import validate_github_token

def validate_github_token(token: str) -> None:
```
- **Purpose**: Validate GitHub Personal Access Token format
- **Parameter**: `token` (str) - GitHub token to validate
- **Raises**: InvalidGitHubTokenError - If token format is invalid

##### _pick_commit_sha()
```python
from gitingest.utils.git_utils import _pick_commit_sha

def _pick_commit_sha(lines: Iterable[str]) -> str | None:
```
- **Purpose**: Extract the first valid commit SHA from Git command output lines
- **Parameter**: `lines` (list[str]) - Git command output lines containing commit hashes
- **Returns**: str - The first valid commit SHA found in the output

##### _parse_ignore_file()
```python
from gitingest.utils.ignore_patterns import _parse_ignore_file

def _parse_ignore_file(ignore_file: Path, root: Path) -> set[str]:
```
- **Purpose**: Parse an ignore file and return a set of ignore patterns with git-wildmatch syntax support
- **Parameters**: 
  - `ignore_file` (Path) - The path to the ignore file to parse
  - `root` (Path) - The root directory of the repository for relative path calculation
- **Returns**: set[str] - A set of ignore patterns extracted from the file

##### _should_include()
```python
from gitingest.utils.ingestion_utils import _should_include

def _should_include(path: Path, base_path: Path, include_patterns: set[str]) -> bool:
```
- **Purpose**: Check if path should be included based on patterns using git-wildmatch syntax
- **Parameters**: 
  - `path` (Path) - The absolute path of the file or directory to check
  - `base_path` (Path) - The base directory from which the relative path is calculated
  - `include_patterns` (set[str]) - A set of patterns to check against the relative path
- **Returns**: bool - True if the path matches any of the include patterns, False otherwise

##### _should_exclude()
```python
from gitingest.utils.ingestion_utils import _should_exclude

def _should_exclude(path: Path, base_path: Path, ignore_patterns: set[str]) -> bool:
```
- **Purpose**: Check if path should be excluded based on patterns using git-wildmatch syntax
- **Parameters**: 
  - `path` (Path) - The absolute path of the file or directory to check
  - `base_path` (Path) - The base directory from which the relative path is calculated
  - `ignore_patterns` (set[str]) - A set of patterns to check against the relative path
- **Returns**: bool - True if the path matches any of the ignore patterns, False otherwise

##### _relative_or_none()
```python
from gitingest.utils.ingestion_utils import _relative_or_none

def _relative_or_none(path: Path, base: Path) -> Path | None:
```
- **Purpose**: Return path relative to base or None if path is outside base
- **Parameters**: 
  - `path` (Path) - The absolute path of the file or directory to check
  - `base` (Path) - The base directory from which the relative path is calculated
- **Returns**: Path | None - The relative path of path to base, or None if path is outside base

##### _process_cell()
```python
from gitingest.utils.notebook import _process_cell

def _process_cell(cell: dict[str, Any], *, include_output: bool) -> str | None:
```
- **Purpose**: Process individual Jupyter notebook cell and convert to executable Python code
- **Parameters**: 
  - `cell` (dict[str, Any]) - Cell dictionary from Jupyter notebook containing source and metadata
  - `include_output` (bool) - Whether to include cell outputs in generated script
- **Returns**: str | None - Cell content as string or None if cell is empty or should be skipped

##### _extract_output()
```python
from gitingest.utils.notebook import _extract_output

def _extract_output(output: dict[str, Any]) -> list[str]:
```
- **Purpose**: Extract output content from notebook cell execution results
- **Parameter**: `output` (dict[str, Any]) - Output dictionary from cell containing text, data, or error outputs
- **Returns**: list[str] - Output content as list of strings, one line per string

##### _parse_patterns()
```python
from gitingest.utils.pattern_utils import _parse_patterns

def _parse_patterns(patterns: str | set[str] | None) -> set[str]:
```
- **Purpose**: Parse and normalize pattern strings into a set of patterns
- **Parameter**: `patterns` (str | set[str] | None) - Pattern string or set to parse
- **Returns**: set[str] - Normalized set of patterns

##### _is_valid_git_commit_hash()
```python
from gitingest.utils.query_parser_utils import _is_valid_git_commit_hash

def _is_valid_git_commit_hash(commit: str) -> bool:
```
- **Purpose**: Validate Git commit hash format
- **Parameter**: `commit` (str) - Commit hash to validate
- **Returns**: bool - True if valid commit hash format, False otherwise

##### _validate_host()
```python
from gitingest.utils.query_parser_utils import _validate_host

def _validate_host(host: str) -> None:
```
- **Purpose**: Validate a hostname against known Git hosts or common Git hosting patterns
- **Parameter**: `host` (str) - Hostname to validate (case-insensitive)
- **Raises**: ValueError - If the host cannot be recognized as a probable Git hosting domain

##### _validate_url_scheme()
```python
from gitingest.utils.query_parser_utils import _validate_url_scheme

def _validate_url_scheme(scheme: str) -> None:
```
- **Purpose**: Validate the given URL scheme against known supported schemes
- **Parameter**: `scheme` (str) - The URL scheme to validate (case-insensitive)
- **Raises**: ValueError - If the scheme is not 'http' or 'https'

##### _looks_like_git_host()
```python
from gitingest.utils.query_parser_utils import _looks_like_git_host

def _looks_like_git_host(host: str) -> bool:
```
- **Purpose**: Check if the given host looks like a Git hosting service using common naming patterns
- **Parameter**: `host` (str) - Hostname to check (case-insensitive)
- **Returns**: bool - True if the host starts with 'git.', 'gitlab.', or 'github.' patterns, False otherwise

##### _get_user_and_repo_from_path()
```python
from gitingest.utils.query_parser_utils import _get_user_and_repo_from_path

def _get_user_and_repo_from_path(path: str) -> tuple[str, str]:
```
- **Purpose**: Extract the user and repository names from a Git repository URL path
- **Parameter**: `path` (str) - The path component of a Git repository URL (e.g., '/user/repo')
- **Returns**: tuple[str, str] - (username, repository_name) extracted from the path

##### async_timeout()
```python
from gitingest.utils.timeout_wrapper import async_timeout

def async_timeout(seconds: int) -> Callable[[Callable[P, Awaitable[T]]], Callable[P, Awaitable[T]]]:
```
- **Purpose**: Async timeout decorator that wraps async functions with timeout
- **Parameter**: `seconds` (int) - Maximum allowed time in seconds
- **Returns**: Decorator that ensures functions complete within time limit

##### decorator()
```python
from gitingest.utils.timeout_wrapper import decorator

def decorator(func: Callable[P, Awaitable[T]]) -> Callable[P, Awaitable[T]]:
```
- **Purpose**: Inner decorator function for async timeout wrapper  
- **Parameter**: `func` (Callable[P, Awaitable[T]]) - Async function to wrap with timeout
- **Returns**: Callable[P, Awaitable[T]] - Wrapped async function with timeout functionality

##### openapi_json_get()
```python
from server.main import openapi_json_get

def openapi_json_get() -> JSONResponse:
```
- **Purpose**: Get OpenAPI schema as JSON for FastAPI documentation
- **Returns**: JSONResponse - The OpenAPI schema as JSON

##### openapi_json()
```python
from server.main import openapi_json

@app.api_route("/api", methods=["POST", "PUT", "DELETE", "OPTIONS", "HEAD"], include_in_schema=False)
@app.api_route("/api/", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"], include_in_schema=False)
def openapi_json() -> JSONResponse:
```
- **Purpose**: Generate OpenAPI JSON schema for the API
- **Returns**: JSONResponse - The OpenAPI schema as JSON

##### _cleanup_repository()
```python
from server.query_processor import _cleanup_repository

def _cleanup_repository(clone_config: CloneConfig) -> None:
```
- **Purpose**: Clean up temporary repository files and directories
- **Parameter**: `clone_config` (CloneConfig) - Configuration with cleanup paths

##### _store_digest_content()
```python
from server.query_processor import _store_digest_content

def _store_digest_content(
    query: IngestionQuery,
    clone_config: CloneConfig,
    digest_content: str,
    summary: str,
    tree: str,
    content: str,
) -> None:
```
- **Purpose**: Store digest content in appropriate storage (S3 or local)
- **Parameters**: 
  - `query` (IngestionQuery) - Ingestion query configuration containing repository and processing details
  - `clone_config` (CloneConfig) - Clone configuration with repository paths and cleanup information
  - `digest_content` (str) - Complete digest content to be stored
  - `summary` (str) - Repository summary text for metadata
  - `tree` (str) - Directory tree structure representation
  - `content` (str) - Extracted file contents from repository
- **Returns**: Storage URL or path

##### _generate_digest_url()
```python
from server.query_processor import _generate_digest_url

def _generate_digest_url(query: IngestionQuery) -> str:
```
- **Purpose**: Generate URL for accessing stored digest content
- **Parameter**: `query` (IngestionQuery) - Ingestion query
- **Returns**: URL string for digest access

##### _print_query()
```python
from server.query_processor import _print_query

def _print_query(url: str, max_file_size: int, pattern_type: str, pattern: str) -> None:
```
- **Purpose**: Print query information for logging/debugging
- **Parameters**: 
  - `url` (str) - Repository URL being processed for ingestion
  - `max_file_size` (int) - Maximum file size limit in bytes for processing
  - `pattern_type` (str) - Type of pattern filtering ("include" or "exclude")
  - `pattern` (str) - Pattern string used for file filtering

##### _print_error()
```python
from server.query_processor import _print_error

def _print_error(url: str, exc: Exception, max_file_size: int, pattern_type: str, pattern: str) -> None:
```
- **Purpose**: Print error information for failed queries
- **Parameters**: 
  - `url` (str) - Repository URL that failed during processing
  - `exc` (Exception) - Exception object containing error details and traceback
  - `max_file_size` (int) - Maximum file size limit in bytes that was being used
  - `pattern_type` (str) - Type of pattern filtering that was applied ("include" or "exclude")
  - `pattern` (str) - Pattern string that was used for file filtering

##### _print_success()
```python
from server.query_processor import _print_success

def _print_success(url: str, max_file_size: int, pattern_type: str, pattern: str, summary: str) -> None:
```
- **Purpose**: Print success information for completed queries
- **Parameters**: 
  - `url` (str) - Repository URL that was successfully processed
  - `max_file_size` (int) - Maximum file size limit in bytes that was used
  - `pattern_type` (str) - Type of pattern filtering that was applied ("include" or "exclude")
  - `pattern` (str) - Pattern string that was used for file filtering
  - `summary` (str) - Summary text of the processing results and statistics

##### get_s3_bucket_name()
```python
from server.s3_utils import get_s3_bucket_name

def get_s3_bucket_name() -> str:
```
- **Purpose**: Get S3 bucket name from environment configuration
- **Returns**: S3 bucket name string

##### get_s3_alias_host()
```python
from server.s3_utils import get_s3_alias_host

def get_s3_alias_host() -> str | None:
```
- **Purpose**: Get S3 alias host for custom endpoint URLs
- **Returns**: Alias host string or None

##### generate_s3_file_path()
```python
from server.s3_utils import generate_s3_file_path

def generate_s3_file_path(
    source: str,
    user_name: str,
    repo_name: str,
    commit: str,
    subpath: str,
    include_patterns: set[str] | None,
    ignore_patterns: set[str],
) -> str:
```
- **Purpose**: Generate S3 file path for storing digest content
- **Parameters**: 
  - `source` (str) - Source repository 
  - `user_name` (str) - Repository owner
  - `repo_name` (str) - Repository name
  - `commit` (str) - Commit hash
  - `subpath` (str) - Repository subpath
  - `include_patterns` (set[str] | None) - Include patterns
  - `ignore_patterns` (set[str]) - Ignore patterns
- **Returns**: S3 file path string

##### upload_metadata_to_s3()
```python
from server.s3_utils import upload_metadata_to_s3

def upload_metadata_to_s3(metadata: S3Metadata, s3_file_path: str, ingest_id: UUID) -> str:
```
- **Purpose**: Upload metadata JSON to S3 alongside the digest file
- **Parameters**: 
  - `metadata` (S3Metadata) - Metadata struct containing summary, tree, and content
  - `s3_file_path` (str) - S3 file path for digest (metadata uses .json extension)
  - `ingest_id` (UUID) - Ingest ID to store as S3 object tag
- **Returns**: str - Public URL to access the uploaded metadata file

##### _build_s3_url()
```python
from server.s3_utils import _build_s3_url

def _build_s3_url(key: str) -> str:
```
- **Purpose**: Build complete S3 URL from object key
- **Parameter**: `key` (str) - S3 object key
- **Returns**: Complete S3 URL string

##### _check_object_tags()
```python
from server.s3_utils import _check_object_tags

def _check_object_tags(s3_client: BaseClient, bucket_name: str, key: str, target_ingest_id: UUID) -> bool:
```
- **Purpose**: Check S3 object tags for ingestion ID matching
- **Parameters**: 
  - `s3_client` (BaseClient) - Boto3 S3 client instance for performing S3 operations
  - `bucket_name` (str) - Name of the S3 bucket containing the object
  - `key` (str) - S3 object key/path to check tags for
  - `target_ingest_id` (str) - Target ingestion ID to match against object tags
- **Returns**: bool - True if tags match, False otherwise

##### get_s3_url_for_ingest_id()
```python
from server.s3_utils import get_s3_url_for_ingest_id

def get_s3_url_for_ingest_id(ingest_id: UUID) -> str | None:
```
- **Purpose**: Get S3 URL for specific ingestion ID
- **Parameter**: `ingest_id` (str) - Ingestion identifier
- **Returns**: S3 URL string or None if not found

##### test_client()
```python
from server.test_fixtures import test_client

def test_client() -> Generator[TestClient, None, None]:
```
- **Purpose**: Create a test client fixture for integration tests
- **Returns**: Generator[TestClient, None, None] - FastAPI test client instance

##### main()
```python
from gitingest.__main__ import main

@click.command()
@click.argument("source", type=str, default=".")
@click.option("--max-size", "-s", default=MAX_FILE_SIZE, show_default=True, help="Maximum file size to process in bytes")
@click.option("--exclude-pattern", "-e", multiple=True, help="Shell-style patterns to exclude.")
@click.option("--include-pattern", "-i", multiple=True, help="Shell-style patterns to include.")
@click.option("--branch", "-b", default=None, help="Branch to clone and ingest")
@click.option("--include-gitignored", is_flag=True, default=False, help="Include files matched by .gitignore and .gitingestignore")
@click.option("--include-submodules", is_flag=True, help="Include repository's submodules in the analysis", default=False)
@click.option("--token", "-t", envvar="GITHUB_TOKEN", default=None, help="GitHub personal access token (PAT) for accessing private repositories.")
@click.option("--output", "-o", default=None, help="Output file path (default: digest.txt in current directory). Use '-' for stdout.")
def main(**cli_kwargs: Unpack[_CLIArgs]) -> None
```
- **Import Path**: `from gitingest.__main__ import main`
- **Purpose**: CLI entry point to analyze a repo/directory and dump its contents
- **Parameters**: `**cli_kwargs` (Unpack[_CLIArgs]) - Dictionary of keyword arguments forwarded to `ingest_async`
- **Returns**: None
- **Decorators**: `@click.command()`, plus multiple `@click.option()` decorators for CLI arguments

##### ingest_async()
```python
from gitingest.entrypoint import ingest_async

async def ingest_async(
    source: str,
    *,
    max_file_size: int = MAX_FILE_SIZE,
    include_patterns: str | set[str] | None = None,
    exclude_patterns: str | set[str] | None = None,
    branch: str | None = None,
    tag: str | None = None,
    include_gitignored: bool = False,
    include_submodules: bool = False,
    token: str | None = None,
    output: str | None = None,
) -> tuple[str, str, str]
```
- **Import Path**: `from gitingest.entrypoint import ingest_async`
- **Purpose**: Async main function for analyzing source (URL or local path), clones repository if applicable, processes files
- **Parameters**:
  - `source` (str, required): Source to analyze (URL or local directory path)
  - `max_file_size` (int, optional): Maximum file size limit in bytes, default is MAX_FILE_SIZE (10MB)
  - `include_patterns` (str | set[str] | None, optional): Patterns for files to include, default is None
  - `exclude_patterns` (str | set[str] | None, optional): Patterns for files to exclude, default is None
  - `branch` (str | None, optional): Branch to clone and ingest, default is None (uses default branch)
  - `tag` (str | None, optional): Tag to clone and ingest, default is None
  - `include_gitignored` (bool, optional): Include files ignored by .gitignore, default is False
  - `include_submodules` (bool, optional): Recursively include Git submodules, default is False
  - `token` (str | None, optional): GitHub PAT for private repositories, default is None
  - `output` (str | None, optional): File path to write results (use "-" for stdout), default is None
- **Returns**: 
  - `tuple[str, str, str]` - A tuple containing:
    - `summary` (str): Repository summary with statistics and metadata
    - `tree` (str): Directory tree structure representation
    - `content` (str): Extracted file contents with separators

##### ingest()
```python
from gitingest.entrypoint import ingest

def ingest(
    source: str,
    *,
    max_file_size: int = MAX_FILE_SIZE,
    include_patterns: str | set[str] | None = None,
    exclude_patterns: str | set[str] | None = None,
    branch: str | None = None,
    tag: str | None = None,
    include_gitignored: bool = False,
    include_submodules: bool = False,
    token: str | None = None,
    output: str | None = None,
) -> tuple[str, str, str]
```
- **Import Path**: `from gitingest.entrypoint import ingest`
- **Purpose**: Synchronous wrapper around `ingest_async` using asyncio.run()
- **Parameters**: Same as `ingest_async` above
- **Returns**: tuple[str, str, str] - (summary, tree, content)

##### is_github_host()

```python
from gitingest.utils.git_utils import urlparse

def is_github_host(url: str) -> bool:
    """Check if a URL is from a GitHub host (github.com or GitHub Enterprise).

    Parameters
    ----------
    url : str
        The URL to check

    Returns
    -------
    bool
        True if the URL is from a GitHub host, False otherwise

    """
    hostname = urlparse(url).hostname or ""
    return hostname.startswith("github.")
```
- **Purpose**: Check if URL points to a GitHub host (github.com or gist.github.com)
- **Parameter**: `url` (str) - URL to check for GitHub hosting
- **Returns**: bool - True if the URL hostname is a GitHub host, False otherwise

##### create_git_repo()
```python
import git
from src.gitingest.utils.git_utils import create_git_repo
def create_git_repo(local_path: str, url: str, token: str | None = None) -> git.Repo:
```
- **Purpose**: Create and configure a Git repository object with authentication if needed
- **Parameters**: 
  - `local_path` (str) - Local path where repository is located
  - `url` (str) - Repository URL for origin remote configuration
  - `token` (str | None) - GitHub access token for private repositories (default: None)
- **Returns**: git.Repo - GitPython Repo object configured with authentication and remote origin

##### create_authenticated_url()
```python
from urllib.parse import urlparse

from src.gitingest.utils.git_utils import create_authenticated_url

def create_authenticated_url(url: str, token: str | None = None) -> str:
```
- **Purpose**: Create URL with embedded authentication token
- **Parameters**: 
  - `url` (str) - Repository URL
  - `token` (str | None) - GitHub access token (default: None)
- **Returns**: Authenticated URL string

##### git_auth_context()
```python
from typing import Generator
import git
from src.gitingest.utils.git_utils import git_auth_context
def git_auth_context(url: str, token: str | None = None) -> Generator[tuple[git.Git, str]]:
```
- **Purpose**: Context manager for Git authentication
- **Parameters**: 
  - `url` (str) - Repository URL
  - `token` (str | None) - GitHub access token (default: None)  
- **Returns**: Generator[tuple[git.Git, str]] - Git command object and authenticated URL

**File Processing Utilities**:

##### readlink()
```python
from pathlib import Path

def readlink(path: Path) -> Path:
```
- **Import Path**: `from gitingest.utils.compat_func import readlink`
- **Purpose**: Read symbolic link target (compatibility function for Python 3.8)
- **Parameters**: 
  - `path` (Path, required) - Path to the symlink
- **Returns**: Path - The target of the symlink

##### removesuffix()
```python

def removesuffix(s: str, suffix: str) -> str:
```
- **Import Path**: `from gitingest.utils.compat_func import removesuffix`
- **Purpose**: Remove suffix from string (compatibility function for Python 3.8)
- **Parameters**: 
  - `s` (str, required) - String to remove suffix from
  - `suffix` (str, required) - Suffix to remove
- **Returns**: str - String with suffix removed

##### limit_exceeded()
```python
from gitingest.schemas.filesystem import FileSystemStats

def limit_exceeded(stats: FileSystemStats, depth: int) -> bool:
```
- **Import Path**: `from gitingest.ingestion import limit_exceeded`
- **Purpose**: Check if any of the traversal limits have been exceeded during directory processing
- **Parameters**: 
  - `stats` (FileSystemStats, required) - Statistics tracking object for the total file count and size
  - `depth` (int, required) - The current depth of directory traversal
- **Returns**: bool - True if any limit has been exceeded (max depth, max files, or max total size), False otherwise

**Authentication Utilities**:

##### resolve_token()
```python

def resolve_token(token: str | None) -> str | None:
```
- **Import Path**: `from gitingest.utils.auth import resolve_token`
- **Purpose**: Resolve authentication token from various sources
- **Parameters**: 
  - `token` (str | None, required) - Input token or None
- **Returns**: str | None - Resolved token or None

**Pattern Processing Utilities**:

##### process_patterns()
```python

def process_patterns(
    exclude_patterns: str | set[str] | None = None,
    include_patterns: str | set[str] | None = None,
) -> tuple[set[str], set[str] | None]:
    """Process include and exclude patterns.

    Parameters
    ----------
    exclude_patterns : str | set[str] | None
        Exclude patterns to process.
    include_patterns : str | set[str] | None
        Include patterns to process.

    Returns
    -------
    tuple[set[str], set[str] | None]
        A tuple containing the processed ignore patterns and include patterns.

    """
```

- **Import Path**: `from gitingest.utils.pattern_utils import process_patterns`



##### load_ignore_patterns()
```python
def load_ignore_patterns(root: Path, filename: str) -> set[str]:
    """Load ignore patterns from ``filename`` found under ``root``.

    The loader walks the directory tree, looks for the supplied ``filename``,
    and returns a unified set of patterns. It implements the same parsing rules
    we use for ``.gitignore`` and ``.gitingestignore`` (git-wildmatch syntax with
    support for negation and root-relative paths).

    Parameters
    ----------
    root : Path
        Directory to walk.
    filename : str
        The filename to look for in each directory.

    Returns
    -------
    set[str]
        A set of ignore patterns extracted from the ``filename`` file found under the ``root`` directory.

    """
    patterns: set[str] = set()

    for ignore_file in root.rglob(filename):
        if ignore_file.is_file():
            patterns.update(_parse_ignore_file(ignore_file, root))
    return patterns
```


- **Import Path**: `from gitingest.utils.ignore_patterns import load_ignore_patterns`
- **Purpose**: Load ignore patterns from .gitignore-style files
- **Parameters**: 
  - `root` (Path, required) - Root directory to walk
  - `filename` (str, required) - Pattern file name to look for
- **Returns**: set[str] - Set of ignore patterns extracted from files

**Logging Utilities**:

##### configure_logging()
```python

def configure_logging() -> None:
```
- **Import Path**: `from gitingest.utils.logging_config import configure_logging`
- **Purpose**: Configure loguru-based structured logging system
- **Parameters**: None
- **Returns**: None
- **Usage**: Sets up JSON logging for production, human-readable for development

##### get_logger()
```python

def get_logger(name: str | None = None) -> logger.__class__:
```
- **Import Path**: `from gitingest.utils.logging_config import get_logger`
- **Purpose**: Get a configured logger instance with structured logging capabilities
- **Parameters**: 
  - `name` (str | None, optional) - Logger name, defaults to calling module name if None
- **Returns**: logger.__class__ - Configured loguru logger instance with JSON formatting and extra fields

##### json_sink()
```python
from typing import Any

def json_sink(message: Any) -> None:
```
- **Import Path**: `from gitingest.utils.logging_config import json_sink`
- **Purpose**: Create JSON formatted log output for structured logging
- **Parameters**: 
  - `message` (Any, required) - Loguru message record
- **Returns**: None

##### format_extra_fields()
```python

def format_extra_fields(record: dict) -> str:
```
- **Import Path**: `from gitingest.utils.logging_config import format_extra_fields`
- **Purpose**: Format extra log fields as JSON string
- **Parameters**: 
  - `record` (dict, required) - Loguru record dictionary
- **Returns**: str - JSON formatted extra fields or empty string

##### extra_filter()
```python

def extra_filter(record: dict) -> dict:
```
- **Import Path**: `from gitingest.utils.logging_config import extra_filter`
- **Purpose**: Filter function to add extra fields to log messages
- **Parameters**: 
  - `record` (dict, required) - Loguru record dictionary
- **Returns**: dict - Modified record with extra fields

**Server Utilities**:

##### start_metrics_server()
```python
def start_metrics_server(host: str = "127.0.0.1", port: int = 9090) -> None:
```
- **Import Path**: `from server.metrics_server import start_metrics_server`
- **Purpose**: Start Prometheus metrics server
- **Parameters**: 
  - `host` (str, optional) - Server host, default is "127.0.0.1"
  - `port` (int, optional) - Server port, default is 9090
- **Returns**: None

**Test Fixtures**:


##### get_version_info()
```python


def get_version_info() -> dict[str, str]:
```
- **Import Path**: `from server.server_config import get_version_info`
- **Purpose**: Get application version information
- **Parameters**: None
- **Returns**: dict[str, str] - Dictionary with 'version' and 'version_link' keys

**S3 Cloud Storage Utilities**:

##### is_s3_enabled()
```python
def is_s3_enabled() -> bool:
```
- **Import Path**: `from server.s3_utils import is_s3_enabled`
- **Purpose**: Check if S3 storage is enabled via environment variables
- **Parameters**: None
- **Returns**: bool - Boolean indicating S3 availability

##### get_s3_config()
```python

def get_s3_config() -> dict[str, str | None]:
```
- **Import Path**: `from server.s3_utils import get_s3_config`
- **Purpose**: Get S3 configuration from environment variables for boto3 client setup
- **Parameters**: None
- **Returns**: dict[str, str | None] - Dictionary with S3 connection settings including access_key, secret_key, region, and endpoint_url

##### create_s3_client()
```python
from botocore.client import BaseClient

def create_s3_client() -> BaseClient:
```
- **Import Path**: `from server.s3_utils import create_s3_client`
- **Purpose**: Create a configured S3 client instance using environment configuration
- **Parameters**: None
- **Returns**: BaseClient - Boto3 S3 client configured with credentials and endpoint from environment variables

##### upload_to_s3()
```python
from uuid import UUID

def upload_to_s3(content: str, s3_file_path: str, ingest_id: UUID) -> str:
```
- **Import Path**: `from server.s3_utils import upload_to_s3`
- **Purpose**: Upload content to S3 bucket and return public URL
- **Parameters**: 
  - `content` (str, required) - Content to upload
  - `s3_file_path` (str, required) - S3 file path
  - `ingest_id` (UUID, required) - Ingestion ID stored as object tag
- **Returns**: str - Public URL for uploaded file

##### get_metadata_from_s3()
```python
from server.models import S3Metadata

def get_metadata_from_s3(s3_file_path: str) -> S3Metadata | None:
```
- **Import Path**: `from server.s3_utils import get_metadata_from_s3`
- **Purpose**: Retrieve metadata from S3 storage
- **Parameters**: 
  - `s3_file_path` (str, required) - S3 object path
- **Returns**: S3Metadata | None - S3Metadata object or None if not found

##### check_s3_object_exists()
```python

def check_s3_object_exists(s3_file_path: str) -> bool:
```
- **Import Path**: `from server.s3_utils import check_s3_object_exists`
- **Purpose**: Check if S3 object exists
- **Parameters**: 
  - `s3_file_path` (str, required) - S3 object path
- **Returns**: bool - Boolean indicating existence

**Validation Utilities**:

##### _is_valid_git_commit_hash()
```python
from gitingest.utils.query_parser_utils import _is_valid_git_commit_hash

def _is_valid_git_commit_hash(commit: str) -> bool:
```
- **Import Path**: `from gitingest.utils.query_parser_utils import _is_valid_git_commit_hash`
- **Purpose**: Validate Git commit hash format
- **Parameters**: 
  - `commit` (str, required) - Commit hash to validate
- **Returns**: bool - Boolean indicating valid format

##### _validate_host()
```python

def _validate_host(host: str) -> None:
```
- **Import Path**: `from gitingest.utils.query_parser_utils import _validate_host`
- **Purpose**: Validate a hostname against known Git hosts or common Git hosting patterns
- **Parameters**: 
  - `host` (str, required) - Hostname to validate (case-insensitive)
- **Returns**: None
- **Raises**: ValueError - If the host cannot be recognized as a probable Git hosting domain

##### _validate_url_scheme()
```python

def _validate_url_scheme(scheme: str) -> None:
```
- **Import Path**: `from gitingest.utils.query_parser_utils import _validate_url_scheme`
- **Purpose**: Validate the given URL scheme against known supported schemes
- **Parameters**: 
  - `scheme` (str, required) - The URL scheme to validate (case-insensitive)
- **Returns**: None
- **Raises**: ValueError - If the scheme is not 'http' or 'https'

##### _looks_like_git_host()
```python

def _looks_like_git_host(host: str) -> bool:
```
- **Import Path**: `from gitingest.utils.query_parser_utils import _looks_like_git_host`
- **Purpose**: Check if the given host looks like a Git hosting service using common naming patterns
- **Parameters**: 
  - `host` (str, required) - Hostname to check (case-insensitive)
- **Returns**: bool - True if the host starts with 'git.', 'gitlab.', or 'github.' patterns, False otherwise

##### _get_user_and_repo_from_path()
```python

def _get_user_and_repo_from_path(path: str) -> tuple[str, str]:
```
- **Import Path**: `from gitingest.utils.query_parser_utils import _get_user_and_repo_from_path`
- **Purpose**: Extract the user and repository names from a Git repository URL path
- **Parameters**: 
  - `path` (str, required) - The path component of a Git repository URL (e.g., '/user/repo')
- **Returns**: tuple[str, str] - (username, repository_name) extracted from the path

**Internal Processing Functions**:

##### _process_symlink()
```python
from pathlib import Path
from gitingest.schemas.filesystem import FileSystemNode, FileSystemStats
def _process_symlink(path: Path, parent_node: FileSystemNode, stats: FileSystemStats, local_path: Path) -> None:
```
- **Import Path**: `from gitingest.ingestion import _process_symlink`
- **Purpose**: Process a symlink in the file system and add it to the file tree
- **Parameters**: 
  - `path` (Path, required) - The full path of the symlink
  - `parent_node` (FileSystemNode, required) - The parent directory node
  - `stats` (FileSystemStats, required) - Statistics tracking object for the total file count and size
  - `local_path` (Path, required) - The base path of the repository or directory being processed
- **Returns**: None

##### _process_file()
```python
from pathlib import Path
from gitingest.schemas.filesystem import FileSystemNode, FileSystemStats

def _process_file(path: Path, parent_node: FileSystemNode, stats: FileSystemStats, local_path: Path) -> None:
```
- **Import Path**: `from gitingest.ingestion import _process_file`
- **Purpose**: Process a file in the file system, checking size limits and reading content
- **Parameters**: 
  - `path` (Path, required) - The full path of the file
  - `parent_node` (FileSystemNode, required) - The parent directory node to accumulate results
  - `stats` (FileSystemStats, required) - Statistics tracking object for the total file count and size
  - `local_path` (Path, required) - The base path of the repository or directory being processed
- **Returns**: None

##### _process_cell()
```python
from typing import Any

def _process_cell(cell: dict[str, Any], *, include_output: bool) -> str | None:
```
- **Import Path**: `from gitingest.utils.notebook import _process_cell`
- **Purpose**: Process individual Jupyter notebook cell and convert to executable Python code
- **Parameters**: 
  - `cell` (dict[str, Any], required) - Cell dictionary from Jupyter notebook containing source and metadata
  - `include_output` (bool, required) - Whether to include cell outputs in generated script (keyword-only parameter)
- **Returns**: str | None - Cell content as string or None if cell is empty or should be skipped

##### _extract_output()
```python
from typing import Any

def _extract_output(output: dict[str, Any]) -> list[str]:
```
- **Import Path**: `from gitingest.utils.notebook import _extract_output`
- **Purpose**: Extract output content from notebook cell execution results
- **Parameters**: 
  - `output` (dict[str, Any], required) - Output dictionary from cell containing text, data, or error outputs
- **Returns**: list[str] - Output content as list of strings, one line per string

**Advanced Git Operations**:

##### _override_branch_and_tag()
```python
from gitingest.schemas.ingestion import IngestionQuery
from gitingest.entrypoint import _override_branch_and_tag

def _override_branch_and_tag(query: IngestionQuery, branch: str | None, tag: str | None) -> None:
```
- **Purpose**: Override branch and tag settings in ingestion query
- **Parameters**: 
  - `query` (IngestionQuery) - Query object to modify
  - `branch` (str | None) - Branch name
  - `tag` (str | None) - Tag name
- **Returns**: None (modifies query in-place)

##### _apply_gitignores()
```python
from gitingest.schemas.ingestion import IngestionQuery

from gitingest.entrypoint import  _apply_gitignores

def _apply_gitignores(query: IngestionQuery) -> None:
```
- **Purpose**: Apply .gitignore rules to ingestion query by loading and processing ignore patterns
- **Parameter**: `query` (IngestionQuery) - Ingestion query object to modify with additional ignore patterns
- **Returns**: None (modifies query in-place by updating ignore_patterns)

##### _handle_remove_readonly()
```python
from gitingest.entrypoint import _handle_remove_readonly
from typing import Callable
from types import TracebackType

def _handle_remove_readonly(func: Callable, path: str, exc_info: BaseException | tuple[type[BaseException], BaseException, TracebackType]) -> None:
```
- **Purpose**: Handle permission errors raised by shutil.rmtree() by making files writable and retrying
- **Parameters**: 
  - `func` (Callable) - The function that failed (e.g., os.remove)
  - `path` (str) - File or directory path that caused the error
  - `exc_info` (BaseException | tuple) - Exception information in onerror (tuple) or onexc (exception) format

##### _parse_github_url()
```python
from urllib.parse import urlparse

from gitingest.utils.git_utils import _parse_github_url

def _parse_github_url(url: str) -> tuple[str, str, str]:
```
- **Purpose**: Parse GitHub URL to extract hostname, owner, and repository name components
- **Parameter**: `url` (str) - GitHub repository URL in various formats (https/http, with/without .git suffix)
- **Returns**: tuple[str, str, str] - (hostname, owner, repository_name)

##### _pick_commit_sha()
```python
import re
from gitingest.utils.query_parser_utils import HEX_DIGITS
from gitingest.utils.git_utils import _pick_commit_sha
def _pick_commit_sha(lines: Iterable[str]) -> str | None:
```
- **Purpose**: Extract the first valid commit SHA from Git command output lines
- **Parameter**: `lines` (list[str]) - Git command output lines containing commit hashes
- **Returns**: str - The first valid commit SHA found in the output

**File System Utilities**:

##### _get_preferred_encodings()
```python
import locale
import platform
from  gitingest.utils.file_utils import _get_preferred_encodings

def _get_preferred_encodings() -> list[str]:
```
- **Purpose**: Get list of text encodings to try, prioritized for the current platform
- **Returns**: list[str] - List of encoding names to try in priority order, starting with platform's default encoding followed by common fallback encodings

##### _read_chunk()
```python
from pathlib import Path
import gitingest.utils.file_utils _read_chunk

def _read_chunk(path: Path) -> bytes | None:
```
- **Purpose**: Attempt to read the first _CHUNK_SIZE bytes of a file in binary mode
- **Parameter**: `path` (Path) - The path to the file to read
- **Returns**: bytes | None - The first _CHUNK_SIZE bytes of the file, or None on any OSError

##### _decodes()
```python
import gitingest.utils.file_utils _decodes
def _decodes(chunk: bytes, encoding: str) -> bool:
```
- **Purpose**: Check if a chunk of bytes can be decoded cleanly with the specified encoding
- **Parameters**: 
  - `chunk` (bytes) - The chunk of bytes to decode
  - `encoding` (str) - The encoding to use for decoding the chunk
- **Returns**: bool - True if the chunk decodes cleanly with the encoding, False otherwise

**Pattern Processing Internals**:

##### _parse_ignore_file()
```python
from pathlib import Path
import gitingest.utils.ignore_patterns _parse_ignore_file
def _parse_ignore_file(ignore_file: Path, root: Path) -> set[str]:
```
- **Purpose**: Parse an ignore file and return a set of ignore patterns with git-wildmatch syntax support
- **Parameters**: 
  - `ignore_file` (Path) - The path to the ignore file to parse
  - `root` (Path) - The root directory of the repository for relative path calculation
- **Returns**: set[str] - A set of ignore patterns extracted from the file

##### _should_include()
```python
from pathlib import Path
import gitingest.utils.ingestion_utils _should_include
def _should_include(path: Path, base_path: Path, include_patterns: set[str]) -> bool:
```
- **Purpose**: Check if path should be included based on patterns using git-wildmatch syntax
- **Parameters**: 
  - `path` (Path) - The absolute path of the file or directory to check
  - `base_path` (Path) - The base directory from which the relative path is calculated
  - `include_patterns` (set[str]) - A set of patterns to check against the relative path
- **Returns**: bool - True if the path matches any of the include patterns, False otherwise

##### _should_exclude()
```python
from pathlib import Path
import gitingest.utils.ingestion_utils _should_exclude
def _should_exclude(path: Path, base_path: Path, ignore_patterns: set[str]) -> bool:
```
- **Purpose**: Check if path should be excluded based on patterns using git-wildmatch syntax
- **Parameters**: 
  - `path` (Path) - The absolute path of the file or directory to check
  - `base_path` (Path) - The base directory from which the relative path is calculated
  - `ignore_patterns` (set[str]) - A set of patterns to check against the relative path
- **Returns**: bool - True if the path matches any of the ignore patterns, False otherwise

##### _relative_or_none()
```python
from pathlib import Path
import gitingest.utils.ingestion_utils _relative_or_none
def _relative_or_none(path: Path, base: Path) -> Path | None:
```
- **Purpose**: Return path relative to base or None if path is outside base
- **Parameters**: 
  - `path` (Path) - The absolute path of the file or directory to check
  - `base` (Path) - The base directory from which the relative path is calculated
- **Returns**: Path | None - The relative path of path to base, or None if path is outside base

**API and Server Functions**:

##### openapi_json_get()
```python
from fastapi.responses import JSONResponse
import gitingest.server.main openapi_json_get
def openapi_json_get() -> JSONResponse:
```
- **Purpose**: Get OpenAPI schema as JSON for FastAPI documentation
- **Returns**: JSONResponse - The OpenAPI schema as JSON

##### openapi_json()
```python
from fastapi.responses import JSONResponse
import gitingest.server.main openapi_json
def openapi_json() -> JSONResponse:
```
- **Purpose**: Generate OpenAPI JSON schema for the API
- **Returns**: JSONResponse - The OpenAPI schema as JSON

##### _cleanup_repository()
```python
from gitingest.schemas.cloning import CloneConfig
import gitingest.server.query_processor _cleanup_repository
def _cleanup_repository(clone_config: CloneConfig) -> None:
```
- **Purpose**: Clean up temporary repository files and directories
- **Parameter**: `clone_config` (CloneConfig) - Configuration with cleanup paths

##### _store_digest_content()
```python
from gitingest.schemas.ingestion import IngestionQuery
from gitingest.schemas.cloning import CloneConfig
import gitingest.server.query_processor _store_digest_content
def _store_digest_content(
    query: IngestionQuery,
    clone_config: CloneConfig,
    digest_content: str,
    summary: str,
    tree: str,
    content: str,
) -> None:
```
- **Purpose**: Store digest content in appropriate storage (S3 or local)
- **Parameters**: 
  - `query` (IngestionQuery) - Ingestion query configuration containing repository and processing details
  - `clone_config` (CloneConfig) - Clone configuration with repository paths and cleanup information
  - `digest_content` (str) - Complete digest content to be stored
  - `summary` (str) - Repository summary text for metadata
  - `tree` (str) - Directory tree structure representation
  - `content` (str) - Extracted file contents from repository
- **Returns**: Storage URL or path

##### _generate_digest_url()
```python
from gitingest.schemas.ingestion import IngestionQuery
import gitingest.server.query_processor _generate_digest_url
def _generate_digest_url(query: IngestionQuery) -> str:
```
- **Purpose**: Generate URL for accessing stored digest content
- **Parameter**: `query` (IngestionQuery) - Ingestion query
- **Returns**: URL string for digest access

##### _print_query()
```python
from gitingest.utils.logging_config import get_logger
import gitingest.server.query_processor _print_query
def _print_query(url: str, max_file_size: int, pattern_type: str, pattern: str) -> None:
```
- **Purpose**: Print query information for logging/debugging
- **Parameters**: 
  - `url` (str) - Repository URL being processed for ingestion
  - `max_file_size` (int) - Maximum file size limit in bytes for processing
  - `pattern_type` (str) - Type of pattern filtering ("include" or "exclude")
  - `pattern` (str) - Pattern string used for file filtering

##### _print_error()
```python
from gitingest.utils.logging_config import get_logger
import gitingest.server.query_processor _print_error
def _print_error(url: str, exc: Exception, max_file_size: int, pattern_type: str, pattern: str) -> None:
```
- **Purpose**: Print error information for failed queries
- **Parameters**: 
  - `url` (str) - Repository URL that failed during processing
  - `exc` (Exception) - Exception object containing error details and traceback
  - `max_file_size` (int) - Maximum file size limit in bytes that was being used
  - `pattern_type` (str) - Type of pattern filtering that was applied ("include" or "exclude")
  - `pattern` (str) - Pattern string that was used for file filtering

##### _print_success()
```python
from gitingest.utils.logging_config import get_logger
import gitingest.server.query_processor _print_success
def _print_success(url: str, max_file_size: int, pattern_type: str, pattern: str, summary: str) -> None:
```
- **Purpose**: Print success information for completed queries
- **Parameters**: 
  - `url` (str) - Repository URL that was successfully processed
  - `max_file_size` (int) - Maximum file size limit in bytes that was used
  - `pattern_type` (str) - Type of pattern filtering that was applied ("include" or "exclude")
  - `pattern` (str) - Pattern string that was used for file filtering
  - `summary` (str) - Summary text of the processing results and statistics

**S3 Storage Management**:

##### get_s3_bucket_name()
```python
import os
import gitingest.server.s3_utils get_s3_bucket_name

def get_s3_bucket_name() -> str:
```
- **Purpose**: Get S3 bucket name from environment configuration
- **Returns**: S3 bucket name string

##### get_s3_alias_host()
```python
import os
import gitingest.server.s3_utils get_s3_alias_host
def get_s3_alias_host() -> str | None:
```
- **Purpose**: Get S3 alias host for custom endpoint URLs
- **Returns**: Alias host string or None

##### generate_s3_file_path()
```python
import hashlib
import gitingest.server.s3_utils generate_s3_file_path
def generate_s3_file_path(
    source: str,
    user_name: str,
    repo_name: str,
    commit: str,
    subpath: str,
    include_patterns: set[str] | None,
    ignore_patterns: set[str],
) -> str:
```
- **Purpose**: Generate S3 file path for storing digest content
- **Parameters**: 
  - `source` (str) - Source repository 
  - `user_name` (str) - Repository owner
  - `repo_name` (str) - Repository name
  - `commit` (str) - Commit hash
  - `subpath` (str) - Repository subpath
  - `include_patterns` (set[str] | None) - Include patterns
  - `ignore_patterns` (set[str]) - Ignore patterns
- **Returns**: S3 file path string

##### upload_metadata_to_s3()
```python
from uuid import UUID
from server.models import S3Metadata
import gitingest.server.s3_utils upload_metadata_to_s3
def upload_metadata_to_s3(metadata: S3Metadata, s3_file_path: str, ingest_id: UUID) -> str:
```
- **Purpose**: Upload metadata JSON to S3 alongside the digest file
- **Parameters**: 
  - `metadata` (S3Metadata) - Metadata struct containing summary, tree, and content
  - `s3_file_path` (str) - S3 file path for digest (metadata uses .json extension)
  - `ingest_id` (UUID) - Ingest ID to store as S3 object tag
- **Returns**: str - Public URL to access the uploaded metadata file

##### _build_s3_url()
```python
import os
import gitingest.server.s3_utils _build_s3_url
def _build_s3_url(key: str) -> str:
```
- **Purpose**: Build complete S3 URL from object key
- **Parameter**: `key` (str) - S3 object key
- **Returns**: Complete S3 URL string

##### _check_object_tags()
```python
from botocore.client import BaseClient
import gitingest.server.s3_utils _check_object_tags
def _check_object_tags(s3_client: BaseClient, bucket_name: str, key: str, target_ingest_id: UUID) -> bool:
```
- **Purpose**: Check S3 object tags for ingestion ID matching
- **Parameters**: 
  - `s3_client` (BaseClient) - Boto3 S3 client instance for performing S3 operations
  - `bucket_name` (str) - Name of the S3 bucket containing the object
  - `key` (str) - S3 object key/path to check tags for
  - `target_ingest_id` (str) - Target ingestion ID to match against object tags
- **Returns**: Boolean indicating tag match

##### get_s3_url_for_ingest_id()
```python
from uuid import UUID
import gitingest.server.s3_utils get_s3_url_for_ingest_id
def get_s3_url_for_ingest_id(ingest_id: UUID) -> str | None:
```
- **Purpose**: Get S3 URL for specific ingestion ID
- **Parameter**: `ingest_id` (str) - Ingestion identifier
- **Returns**: S3 URL string or None if not found

**Async Timeout Decorator**:

##### async_timeout()
```python
import asyncio
from typing import Callable, Awaitable
from gitingest.utils.timeout_wrapper import async_timeout

def async_timeout(seconds: int) -> Callable[[Callable[P, Awaitable[T]]], Callable[P, Awaitable[T]]]:
```
- **Purpose**: Async timeout decorator that wraps async functions with timeout
- **Parameter**: `seconds` (int) - Maximum allowed time in seconds
- **Returns**: Decorator that ensures functions complete within time limit

##### decorator() (from async_timeout)
```python
from gitingest.utils.timeout_wrapper import decorator

def decorator(func: Callable[P, Awaitable[T]]) -> Callable[P, Awaitable[T]]:
```
- **Purpose**: Inner decorator function for async timeout wrapper  
- **Parameter**: `func` (Callable[P, Awaitable[T]]) - Async function to wrap with timeout
- **Returns**: Callable[P, Awaitable[T]] - Wrapped async function with timeout functionality

##### parse_remote_repo Function - Remote Repository Parsing

**Functionality**:
Parses a remote Git repository URL or repository path and returns an `IngestionQuery` object. This function supports multiple input formats:
- Full URLs (e.g., 'https://gitlab.com/...')
- URLs missing 'https://' (e.g., 'gitlab.com/...')
- Repository path shorthand (e.g., 'pandas-dev/pandas')

**Function Signature**:
```python
from gitingest.query_parser import parse_remote_repo

async def parse_remote_repo(
    source: str, 
    token: str | None = None
) -> IngestionQuery:
```

**Parameter Description**:
- `source` (str):
  - The URL or repository path to be parsed
  - Can be a full URL, a URL without the protocol, or a repository path shorthand

- `token` (str | None, optional):
  - GitHub Personal Access Token (PAT) for accessing private repositories
  - Defaults to `None`, indicating no authentication

**Return Value**:
- `IngestionQuery`:
  - A dictionary object containing detailed information after repository parsing
  - Includes the repository's host, user, repository name, and other information

##### check_repo_exists Function

**Functionality**: Check if a remote Git repository is accessible.

**Function Signature**:
```python
async def check_repo_exists(url: str, token: str | None = None) -> bool:
    """Check whether a remote Git repository is reachable.

    Parameters
    ----------
    url : str
        URL of the Git repository to check.
    token : str | None
        GitHub personal access token (PAT) for accessing private repositories.

    Returns
    -------
    bool
        ``True`` if the repository exists, ``False`` otherwise.

    """
    try:
        # Try to resolve HEAD - if repo exists, this will work
        await _resolve_ref_to_sha(url, "HEAD", token=token)
    except (ValueError, Exception):
        # Repository doesn't exist, is private without proper auth, or other error
        return False

    return True
```

**Parameter Description**:
- `url` (str): URL of the Git repository to check.
- `token` (str | None, optional): GitHub personal access token (PAT) for accessing private repositories.

**Return Value**:
- `bool`: Returns `True` if the repository exists and is accessible, otherwise returns `False`.


#### 11. Schema Definitions (gitingest.schemas)

**Function Description**: Define data structures and type schemas for file system nodes, ingestion queries, and configuration objects.

**Core Classes**:
- `FileSystemNode`: File/directory representation
- `FileSystemNodeType`: Enum for node types
- `FileSystemStats`: File system statistics
- `IngestionQuery`: Query configuration
- `CloneConfig`: Repository cloning config

**Schema Structure**:
- Hierarchical node structure
- Type-safe configuration
- Statistics tracking
- Validation constraints

**Input - Output Examples**:

```python
from gitingest.schemas import (
    FileSystemNode,
    FileSystemNodeType,
    FileSystemStats,
    IngestionQuery,
    CloneConfig
)

# Basic node creation
def test_node_creation():
    from gitingest.schemas.filesystem import FileSystemNode, FileSystemNodeType
    node = FileSystemNode(
        name="example.py",
        path="/path/to/example.py",
        type=FileSystemNodeType.FILE,
        content="print('Hello')",
        size=20
    )
    print(f"Node name: {node.name}")
    print(f"Node type: {node.type}")
    print(f"Node size: {node.size}")

# Directory node creation
def test_directory_node():
    from gitingest.schemas.filesystem import FileSystemNode, FileSystemNodeType
    dir_node = FileSystemNode(
        name="project",
        path="/path/to/project",
        type=FileSystemNodeType.DIRECTORY,
        children=[]
    )
    print(f"Directory: {dir_node.name}")
    print(f"Has children: {len(dir_node.children)}")

# Ingestion query creation
def test_ingestion_query():
    from gitingest.schemas.ingestion import IngestionQuery
    query = IngestionQuery(
        local_path="/path/to/project",
        include_patterns=["*.py"],
        exclude_patterns=["*.pyc"],
        max_file_size=1024,
        max_files=50
    )
    print(f"Query path: {query.local_path}")
    print(f"Include patterns: {query.include_patterns}")
    print(f"Max file size: {query.max_file_size}")

# Clone configuration
def test_clone_config():
    from gitingest.schemas.cloning import CloneConfig
    config = CloneConfig(
        url="https://github.com/user/repo",
        local_path="/tmp/repo",
        commit_hash="abc123",
        branch="main"
    )
    print(f"Clone URL: {config.url}")
    print(f"Local path: {config.local_path}")
    print(f"Branch: {config.branch}")

# Statistics tracking
def test_file_stats():
    from gitingest.schemas.filesystem import FileSystemStats
    stats = FileSystemStats(
        total_files=10,
        total_size=5000,
        file_types={"py": 5, "js": 3, "json": 2}
    )
    print(f"Total files: {stats.total_files}")
    print(f"Total size: {stats.total_size}")
    print(f"File types: {stats.file_types}")

# Test verification
test_node_creation()
test_directory_node()
test_ingestion_query()
test_clone_config()
test_file_stats()
```



### Detailed Explanation of Configuration Classes

#### 1. `IngestionQuery` class - Repository/File Ingestion Configuration
**Function**: Pydantic model to store the parsed details of the repository or file path.
**Class Definition**:
```python
from schemas.ingestion import IngestionQuery
class IngestionQuery(BaseModel):  
    host: str | None = None
    user_name: str | None = None
    repo_name: str | None = None
    local_path: Path
    url: str | None = None
    slug: str
    id: UUID
    subpath: str = Field(default="/")
    type: str | None = None
    branch: str | None = None
    commit: str | None = None
    tag: str | None = None
    max_file_size: int = Field(default=MAX_FILE_SIZE)
    ignore_patterns: set[str] = Field(default_factory=set)  # TODO: same type for ignore_* and include_* patterns
    include_patterns: set[str] | None = None
    include_submodules: bool = Field(default=False)
    s3_url: str | None = None

    def extract_clone_config(self) -> CloneConfig
```

**Class Attributes**:
- `host` (str | None): The host of the repository.
- `user_name` (str | None): The username or owner of the repository.
- `repo_name` (str | None): The name of the repository.
- `local_path` (Path): The local path to the repository or file.
- `url` (str | None): The URL of the repository.
- `slug` (str): The slug of the repository.
- `id` (UUID): The ID of the repository.
- `subpath` (str): The subpath to the repository or file (default: "/").
- `type` (str | None): The type of the repository or file.
- `branch` (str | None): The branch of the repository.
- `commit` (str | None): The commit of the repository.
- `tag` (str | None): The tag of the repository.
- `max_file_size` (int): The maximum file size to ingest in bytes (default: 10 MB).
- `ignore_patterns` (set[str]): The patterns to ignore (default: empty set).
- `include_patterns` (set[str] | None): The patterns to include.
- `include_submodules` (bool): Whether to include all Git submodules within the repository (default: False).
- `s3_url` (str | None): The S3 URL where the digest is stored if S3 is enabled.

**Methods**:
- `extract_clone_config()`
  - **Function**: Extract the relevant fields for the CloneConfig object.
  - **Returns**: 
    - `CloneConfig`: A CloneConfig object containing the relevant fields.
  - **Raises**:
    - `ValueError`: If the `url` parameter is not provided.
  - **Example**:
    ```python
    config = ingestion_query.extract_clone_config()
    ```

#### 2. CloneConfig

**Function**: Configure the parameters for repository cloning.

```python
from dataclasses import dataclass
from gitingest.schemas.cloning import CloneConfig

class CloneConfig(BaseModel):  # pylint: disable=too-many-instance-attributes
    url: str
    local_path: str
    commit: str | None = None
    branch: str | None = None
    tag: str | None = None
    subpath: str = Field(default="/")
    blob: bool = Field(default=False)
    include_submodules: bool = Field(default=False)
```

**Parameter Description**:
- `url`: Git repository URL.
- `local_path`: Local cloning path.
- `branch`: Branch name (optional).
- `commit`: Commit hash (optional).
- `subpath`: Sub - path (optional).



