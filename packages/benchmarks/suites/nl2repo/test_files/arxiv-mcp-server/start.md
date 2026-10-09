## Introduction and Goals of the ArXiv MCP Server Project

The ArXiv MCP Server is a Python library **for academic paper search and analysis**. It serves as a bridge between AI assistants and the arXiv research repository through the Model Context Protocol (MCP). This tool allows AI models to programmatically search for papers and access their content, supporting functions such as paper download, local storage, content reading, and in - depth analysis. Its core functions include: paper search (supporting date range and category filtering), paper download (with automatic PDF to Markdown conversion), paper list management (viewing all downloaded papers), and in - depth research analysis prompts (providing a systematic paper analysis workflow). In short, the ArXiv MCP Server aims to provide AI assistants with a powerful academic research tool, enabling them to efficiently search for, download, and analyze academic papers on arXiv.

## Natural Language Instructions (Prompt)

Please create a Python project named ArXiv MCP Server to implement an academic paper search and analysis service. The project should include the following functions:

1. **Paper Search Tool**: Be able to search for papers on arXiv by keywords, date ranges, subject categories, etc., supporting advanced filtering and result sorting. The search function should support field specifiers (such as all:, ti:, abs:, au:, cat:) to provide more precise search results.

2. **Paper Download Tool**: Implement the automatic paper download function, supporting PDF format download and automatic conversion to Markdown format. The download process should include status tracking, error handling, and local storage management.

3. **Paper List Tool**: Provide the function to view the list of downloaded papers, including the display and management of paper metadata (title, author, abstract, link, etc.).

4. **Paper Reading Tool**: Implement the function to read the content of downloaded papers, supporting the display and structured access of Markdown - formatted content.

5. **In - depth Analysis Prompt**: Provide specialized research analysis prompts, including a systematic paper analysis workflow, covering a comprehensive analysis structure such as executive summary, detailed analysis, methodology analysis, result evaluation, practical and theoretical implications, and future research directions.

6. **Configuration Management**: Implement a flexible configuration system, supporting parameter configuration such as storage path settings, maximum result limits, and request timeouts.

7. **MCP Protocol Integration**: Implement a Model Context Protocol (MCP) server, providing standardized tool and prompt interfaces to support seamless integration of AI assistants.

8. **Error Handling and Status Management**: Implement a complete error handling mechanism, including the handling of network errors, file operation errors, and format conversion errors, as well as the tracking of download and conversion statuses.

9. Core File Requirements: The project must include a complete pyproject.toml file, which should configure the project as an installable package (supporting pip install) and declare a complete list of dependencies (such as arxiv>=2.1.0, mcp>=1.2.0, pymupdf4llm>=0.0.17, aiohttp>=3.9.1, and other core libraries actually used). pyproject.toml should ensure that all core functional modules can work properly. At the same time, src/arxiv_mcp _server/__init__.py should be provided as a unified API entry, importing and exporting list_prompts, get_prompt, handle_download, get_paper_path, conversion_statuses, handle_search, Settings, and the main import and export functions, and providing version information, so that users can access all main functions through a simple "from arxiv_mcp_server.tools/config/tools.download/prompts.handlers import **" statement.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.12.4

### Core Dependency Library Versions

```Plain
aiofiles                  24.1.0
aiohappyeyeballs          2.6.1
aiohttp                   3.12.14
aiosignal                 1.4.0
annotated-types           0.7.0
anyio                     4.9.0
attrs                     25.3.0
certifi                   2025.7.14
charset-normalizer        3.4.2
click                     8.2.1
coverage                  7.10.0
feedparser                6.0.11
frozenlist                1.7.0
h11                       0.16.0
httpcore                  1.0.9
httpx                     0.28.1
httpx-sse                 0.4.1
idna                      3.10
iniconfig                 2.1.0
jsonschema                4.25.0
jsonschema-specifications 2025.4.1
mcp                       1.12.2
multidict                 6.6.3
packaging                 25.0
pip                       24.0
pluggy                    1.6.0
propcache                 0.3.2
pydantic                  2.11.7
pydantic_core             2.33.2
pydantic-settings         2.10.1
Pygments                  2.19.2
PyMuPDF                   1.26.3
pymupdf4llm               0.0.27
pytest                    8.4.1
pytest-asyncio            1.1.0
pytest-cov                6.2.1
pytest-mock               3.14.1
python-dateutil           2.9.0.post0
python-dotenv             1.1.1
python-multipart          0.0.20
referencing               0.36.2
requests                  2.32.4
rpds-py                   0.26.0
setuptools                72.1.0
sgmllib3k                 1.0.0
six                       1.17.0
sniffio                   1.3.1
sse-starlette             2.4.1
starlette                 0.47.2
typing_extensions         4.14.1
typing-inspection         0.4.1
urllib3                   2.5.0
uvicorn                   0.35.0
wheel                     0.43.0
yarl                      1.20.1
```

## ArXiv MCP Server Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .gitignore
├── .pre-commit-config.yaml
├── .python-version
├── CLAUDE.md
├── Dockerfile
├── LICENSE
├── README.md
├── smithery.yaml
├── src
│   ├── arxiv_mcp_server
│   │   ├── __init__.py
│   │   ├── __main__.py
│   │   ├── config.py
│   │   ├── prompts
│   │   │   ├── __init__.py
│   │   │   ├── deep_research_analysis_prompt.py
│   │   │   ├── handlers.py
│   │   │   ├── prompt_manager.py
│   │   │   ├── prompts.py
│   │   ├── resources
│   │   │   ├── __init__.py
│   │   │   ├── papers.py
│   │   ├── server.py
│   │   └── tools
│   │       ├── __init__.py
│   │       ├── download.py
│   │       ├── list_papers.py
│   │       ├── read_paper.py
│   │       └── search.py
└── pyproject.toml

```

## API Usage Guide

### Core API

#### 1. Module Import

```python
from arxiv_mcp_server.prompts.handlers import list_prompts, get_prompt
from arxiv_mcp_server.tools.download import (
    handle_download,
    get_paper_path,
    conversion_statuses,
)
from arxiv_mcp_server.tools import handle_search
from arxiv_mcp_server.config import Settings
```

### 2. Prompt Handling (Prompt Handlers)

#### 2.1 list_prompts() Function

**Function**: Get the list of available prompts. Currently, it only returns the "deep - paper - analysis" prompt.

**Function Signature**:
```python
async def list_prompts() -> List[Prompt]
```

**Parameters**: None

**Return Value**:
- `List[Prompt]`: A list containing available prompts

#### 2.2 get_prompt() Function

**Function**: Get a specific prompt by name, mainly used to get the "deep - paper - analysis" prompt.

**Function Signature**:
```python
async def get_prompt(
    name: str, 
    arguments: Dict[str, str] | None = None, 
    session_id: Optional[str] = None
) -> GetPromptResult
```

**Parameters**:
- `name` (str): The prompt name. Currently, only "deep - paper - analysis" is supported.
- `arguments` (Dict[str, str] | None): Prompt parameters, which must include "paper_id".
- `session_id` (Optional[str]): Optional session ID for context persistence

**Return Value**:
- `GetPromptResult`: A result object containing the prompt message

**Exceptions**:
- `ValueError`: If the prompt is not found or the parameters are invalid

### 3. Download Tools

#### 3.1 handle_download() Function

**Function**: Handle paper download and conversion requests.

**Function Signature**:
```python
async def handle_download(arguments: Dict[str, Any]) -> List[types.TextContent]
```

**Parameters**:
- `arguments` (Dict[str, Any]): A dictionary containing download parameters, which must include:
  - `paper_id` (str): The ID of the paper to download
  - `check_status` (bool, optional): If True, only check the conversion status without downloading

**Return Value**:
- `List[types.TextContent]`: A list of messages containing download or conversion statuses

#### 3.2 get_paper_path() Function

**Function**: Get the path of the paper file with the required extension.

**Function Signature**:
```python
def get_paper_path(paper_id: str, suffix: str = ".md") -> Path
```

**Parameters**:
- `paper_id` (str): The paper ID
- `suffix` (str, optional): The file extension, defaulting to ".md"

**Return Value**:
- `Path`: The full path of the paper file

#### 3.3 conversion_statuses Variable

**Type**: `Dict[str, ConversionStatus]`

**Description**: A global dictionary for tracking the status of PDF to Markdown conversion. The keys are paper IDs, and the values are `ConversionStatus` objects.

### 4. Search Function handle_search() Function 

**Function**: Handle paper search requests, automatically adding field specifiers to ordinary queries to improve relevance.

**Function Signature**:
```python
async def handle_search(arguments: Dict[str, Any]) -> List[types.TextContent]
```

**Parameters**:
- `arguments` (Dict[str, Any]): A dictionary containing search parameters, which must include:
  - `query` (str): The search query string
  - `max_results` (int, optional): The maximum number of results, defaulting to 10
  - `date_from` (str, optional): The start date (ISO format)
  - `date_to` (str, optional): The end date (ISO format)
  - `categories` (List[str], optional): Category filters

**Return Value**:
- `List[types.TextContent]`: A list containing search results

### 5. Configuration Settings Class (Configuration)


**Function**: Server configuration settings.

**Class Definition**:
```python
class Settings(BaseSettings):
    APP_NAME: str = "arxiv-mcp-server"
    APP_VERSION: str = "0.2.11"
    MAX_RESULTS: int = 50
    BATCH_SIZE: int = 20
    REQUEST_TIMEOUT: int = 60
    HOST: str = "0.0.0.0"
    PORT: int = 8000
```

**Attributes**:
- `STORAGE_PATH` (property): Get and ensure the existence of the storage path

**Methods**:
- `_get_storage_path_from_args() -> Path | None`: Extract the storage path from command - line arguments



## Detailed Implementation Nodes of Functions

### Node 1: Basic Paper Search

**Function Description**: Implement the basic paper search function, supporting keyword queries and result quantity limits.

**Core Algorithm**:
- Build an arXiv search query
- Apply field specifiers to optimize the search
- Process search results and format the output

**Input - Output Example**:

```python
from arxiv_mcp_server.tools import handle_search
import json

# Basic search test
async def test_basic_search():
    result = await handle_search({
        "query": "test query", 
        "max_results": 1
    })
    
    assert len(result) == 1
    content = json.loads(result[0].text)
    assert content["total_results"] == 1
    paper = content["papers"][0]
    assert paper["id"] == "2103.12345"
    assert paper["title"] == "Test Paper"
    assert "resource_uri" in paper

# Search response format
{
    "total_results": 1,
    "papers": [
        {
            "id": "2103.12345",
            "title": "Test Paper",
            "authors": ["Author Name"],
            "abstract": "Paper abstract...",
            "categories": ["cs.AI"],
            "published": "2021-03-15T00:00:00+00:00",
            "url": "https://arxiv.org/pdf/2103.12345.pdf",
            "resource_uri": "arxiv://2103.12345"
        }
    ]
}
```

### Node 2: Category Filtered Search

**Function Description**: Support filtering search results by arXiv categories to improve search accuracy.

**Supported Categories**:
- Computer Science: cs.AI, cs.LG, cs.CV, cs.NE, etc.
- Mathematics: math.CO, math.PR, math.NA, etc.
- Physics: physics, quant - ph, cond - mat, etc.

**Input - Output Example**:

```python
# Category filtered search
async def test_search_with_categories():
    result = await handle_search({
        "query": "test query",
        "categories": ["cs.AI", "cs.LG"],
        "max_results": 1
    })
    
    content = json.loads(result[0].text)
    paper = content["papers"][0]
    assert "cs.AI" in paper["categories"] or "cs.LG" in paper["categories"]


### Node 3: Date Range Filtering

**Function Description**: Support filtering search results by publication date ranges.

**Date Processing**:
- Support ISO - formatted date strings
- Automatic time zone handling
- Date range validation

**Input - Output Example**:

```python
# Date range search
async def test_search_with_dates():
    result = await handle_search({
        "query": "test query",
        "date_from": "2022-01-01",
        "date_to": "2024-01-01",
        "max_results": 1
    })
    
    content = json.loads(result[0].text)
    assert content["total_results"] == 1
    assert len(content["papers"]) == 1

# Invalid date handling
async def test_search_with_invalid_dates():
    result = await handle_search({
        "query": "test query",
        "date_from": "invalid-date",
        "max_results": 1
    })
    
    assert result[0].text.startswith("Error: Invalid date format")
```

### Node 5: Paper Download Lifecycle

**Function Description**: Implement the complete paper download and conversion process, including status tracking and error handling.

**Lifecycle Stages**:
- Download the PDF file
- Convert it to Markdown format
- Track and update the status
- Clean up temporary files

**Input - Output Example**:

```python
from arxiv_mcp_server.tools.download import handle_download, conversion_statuses

# Complete download lifecycle test
async def test_download_paper_lifecycle():
    paper_id = "2103.12345"
    
    # Initial download request
    response = await handle_download({"paper_id": paper_id})
    status = json.loads(response[0].text)
    assert status["status"] in ["converting", "success"]
    
    # Check the final status
    response = await handle_download({
        "paper_id": paper_id, 
        "check_status": True
    })
    final_status = json.loads(response[0].text)
    assert final_status["status"] in ["success", "converting"]

# Download status response format
{
    "status": "converting",
    "message": "Paper downloaded, conversion started",
    "started_at": "2024-01-15T10:30:00",
    "resource_uri": "file:///path/to/paper.md"
}

# Conversion status tracking
@dataclass
class ConversionStatus:
    paper_id: str
    status: str  # 'downloading', 'converting', 'success', 'error'
    started_at: datetime
    completed_at: Optional[datetime] = None
    error: Optional[str] = None
```

### Node 6: Existing Paper Handling

**Function Description**: Handle repeated download requests for already downloaded papers to avoid redundant work.

**Handling Strategy**:
- Check local storage
- Return the status of existing files
- Provide the resource URI

**Input - Output Example**:

```python
# Existing paper test
async def test_download_existing_paper():
    paper_id = "2103.12345"
    md_path = get_paper_path(paper_id, ".md")
    
    # Create a test markdown file
    md_path.parent.mkdir(parents=True, exist_ok=True)
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("# Existing Paper\nTest content")
    
    response = await handle_download({"paper_id": paper_id})
    status = json.loads(response[0].text)
    assert status["status"] == "success"

# Existing paper response
{
    "status": "success",
    "message": "Paper already available",
    "resource_uri": "file:///path/to/paper.md"
}

# File path handling
def get_paper_path(paper_id: str, suffix: str = ".md") -> Path:
    storage_path = Path(settings.STORAGE_PATH)
    storage_path.mkdir(parents=True, exist_ok=True)
    return storage_path / f"{paper_id}{suffix}"
```

### Node 7: Nonexistent Paper Handling

**Function Description**: Handle download requests for nonexistent papers, providing clear error messages.

**Error Handling**:
- Check the validity of the arXiv ID
- Provide detailed error messages
- Distinguish different types of errors

**Input - Output Example**:

```python
# Nonexistent paper test
async def test_download_nonexistent_paper():
    response = await handle_download({"paper_id": "invalid.12345"})
    status = json.loads(response[0].text)
    assert status["status"] == "error"
    assert "not found on arXiv" in status["message"]

# Error response format
{
    "status": "error",
    "message": "Paper invalid.12345 not found on arXiv"
}

# Exception handling logic
try:
    paper = next(client.results(arxiv.Search(id_list=[paper_id])))
    # Handle paper download
except StopIteration:
    return [types.TextContent(
        type="text",
        text=json.dumps({
            "status": "error",
            "message": f"Paper {paper_id} not found on arXiv",
        })
    )]
```

### Node 8: Status Check Functionality

**Function Description**: Provide the function to check the download and conversion status of papers.

**Status Types**:
- unknown: Unknown status
- downloading: Downloading
- converting: Converting
- success: Conversion successful
- error: Conversion failed

**Input - Output Example**:

```python
# Status check test
async def test_check_unknown_status():
    response = await handle_download({
        "paper_id": "2103.99999", 
        "check_status": True
    })
    status = json.loads(response[0].text)
    assert status["status"] == "unknown"

# Status check response
{
    "status": "unknown",
    "message": "No download or conversion in progress"
}

# Success status response
{
    "status": "success",
    "message": "Paper is ready",
    "resource_uri": "file:///path/to/paper.md"
}

# Converting status response
{
    "status": "converting",
    "started_at": "2024-01-15T10:30:00",
    "completed_at": null,
    "error": null,
    "message": "Paper conversion converting"
}
```

### Node 9: Paper List Management

**Function Description**: Manage the list of downloaded papers, providing access to metadata.

**List Functions**:
- Scan local storage
- Get paper metadata
- Format the output

**Input - Output Example**:

```python
from arxiv_mcp_server.tools.list_papers import handle_list_papers

# Local file scanning
def list_papers() -> list[str]:
    return [p.stem for p in Path(settings.STORAGE_PATH).glob("*.md")]
```

### Node 11: Deep Analysis Prompt

**Function Description**: Provide a systematic paper analysis workflow to guide AI assistants in conducting comprehensive paper analysis.

**Analysis Structure**:
- Executive Summary
- Detailed Analysis
- Methodology Analysis
- Result Evaluation
- Practical and Theoretical Implications
- Future Research Directions

**Input - Output Example**:

```python
from arxiv_mcp_server.prompts.handlers import get_prompt

# Deep analysis prompt test
async def test_get_paper_analysis_prompt():
    result = await get_prompt("deep-paper-analysis", {
        "paper_id": "2401.00123"
    })
    
    assert isinstance(result, GetPromptResult)
    assert len(result.messages) == 1
    message = result.messages[0]
    
    assert message.role == "user"
    assert "2401.00123" in message.content.text

# Consolidated comprehensive paper analysis prompt
PAPER_ANALYSIS_PROMPT = """
You are an AI research assistant tasked with analyzing academic papers from arXiv. You have access to several tools to help with this analysis:

AVAILABLE TOOLS:
1. read_paper: Use this tool to retrieve the full content of the paper with the provided arXiv ID
2. download_paper: If the paper is not already available locally, use this tool to download it first
3. search_papers: Find related papers on the same topic to provide context
4. list_papers: Check which papers are already downloaded and available for reading

<workflow-for-paper-analysis>
<preparation>
  - First, use the list_papers tool to check if the paper is already downloaded
  - If not found, use the download_paper tool to retrieve it
  - Then use the read_paper tool with the paper_id to get the full content
  - If the paper is not found, use the search_papers tool to find related papers while you wait
  - If you find related papers, use the download_paper tool to get the full content of the related papers and read those too
</preparation>
<comprehensive-analysis>
  - Executive Summary:
    * Summarize the paper in 2-3 sentences
    * What is the main contribution of the paper?
    * What is the main problem that the paper solves?
    * What is the main methodology used in the paper?
    * What are the main results of the paper?
    * What is the main conclusion of the paper?
</comprehensive-analysis>
<research-context>
  * Research area and specific problem addressed
  * Key prior approaches and their limitations
  * How this paper aims to advance the field
  * How does this paper compare to other papers in the field?
</research-context>
<methodology-analysis>
  * Step-by-step breakdown of the approach
  * Key innovations in the methodology
  * Theoretical foundations and assumptions
  * Technical implementation details
  * Algorithmic complexity and performance characteristics
  * Anything the reader should know about the methodology if they wanted to replicate the paper
</methodology-analysis>
<results-analysis>
  * Experimental setup (datasets, benchmarks, metrics)
  * Main experimental results and their significance
  * Statistical validity and robustness of results
  * How results support or challenge the paper's claims
  * Comparison to state-of-the-art approaches
</results-analysis>
<practical-implications>
  * How could this be implemented or applied?
  * Required resources and potential challenges
  * Available code, datasets, or resources
</practical-implications>
<theoretical-implications>
  * How this work advances fundamental understanding
  * New concepts or paradigms introduced
  * Challenges to existing theories or assumptions
  * Open questions raised
</theoretical-implications>
<future-directions>
  * Limitations that future work could address
  * Promising follow-up research questions
  * Potential for integration with other approaches
  * Long-term research agenda this work enables
</future-directions>
<broader-impact>
  * Societal, ethical, or policy implications
  * Environmental or economic considerations
  * Potential real-world applications and timeframe
</broader-impact>

<keep-in-mind>
  * Use the search_papers tool to find related work or papers building on this work
  * Cross-reference findings with other papers you've analyzed
  * Use your artifacts to create diagrams, pseudocode, and other visualizations to illustrate key concepts
  * Summarize key results in tables for easy reference
</keep-in-mind>
</workflow-for-paper-analysis>
Structure your analysis with clear headings, maintain technical accuracy while being accessible, and include your critical assessment where appropriate. 
Your analysis should be comprehensive but concise. Be sure to critically evaluate the statistical significance and 
reproducibility of any reported results.
"""
```

### Node 12: Prompt Argument Validation

**Function Description**: Validate the validity and integrity of prompt parameters.

**Validation Rules**:
- Check required parameters
- Validate parameter types
- Provide error messages

**Input - Output Example**:

```python
# Parameter validation test
async def test_get_prompt_with_missing_required_argument():
    with pytest.raises(ValueError, match="Missing required argument"):
        await get_prompt("deep-paper-analysis", {})

async def test_get_prompt_with_no_arguments():
    with pytest.raises(ValueError, match="No arguments provided"):
        await get_prompt("deep-paper-analysis", None)

async def test_get_prompt_with_invalid_name():
    with pytest.raises(ValueError, match="Prompt not found"):
        await get_prompt("invalid-prompt", {})
```

### Node 13: Configuration Management

**Function Description**: Manage the server's configuration settings, including parameters such as storage paths and timeouts.

**Configuration Items**:
- Application name and version
- Storage path settings
- Request limit parameters
- Network configuration

**Input - Output Example**:

```python
from arxiv_mcp_server.config import Settings

# Default configuration test
def test_storage_path_default():
    settings = Settings()
    expected_path = Path.home() / ".arxiv-mcp-server" / "papers"
    assert settings.STORAGE_PATH == expected_path.resolve()

# Command - line parameter configuration test
def test_storage_path_from_args():
    test_path = "/tmp/test_storage"
    with patch.object(sys, "argv", ["program", "--storage-path", test_path]):
        settings = Settings()
        assert settings.STORAGE_PATH == Path(test_path).resolve()

# Configuration class definition
class Settings(BaseSettings):
    APP_NAME: str = "arxiv-mcp-server"
    APP_VERSION: str = "0.2.11"
    MAX_RESULTS: int = 50
    BATCH_SIZE: int = 20
    REQUEST_TIMEOUT: int = 60
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    
    @property
    def STORAGE_PATH(self) -> Path:
        path = (
            self._get_storage_path_from_args()
            or Path.home() / ".arxiv-mcp-server" / "papers"
        )
        path = path.resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path
```

### Node 14: Path Handling Compatibility

**Function Description**: Ensure the compatibility of path handling on different operating systems.

**Compatibility Handling**:
- Windows path format
- Unix path format
- Special character handling
- Path normalization

**Input - Output Example**:

```python
# Platform compatibility test
def test_storage_path_platform_compatibility():
    test_paths = [
        "/path/to/storage",  # Unix - style path
        "C:\\path\\to\\storage",  # Windows - style path
        "/path with spaces/to/storage",  # Path with spaces
        "/path/to/störâgè",  # Path with non - ASCII characters
    ]
    
    for test_path in test_paths:
        with patch.object(sys, "argv", ["program", "--storage-path", test_path]):
            settings = Settings()
            resolved_path = settings.STORAGE_PATH
            assert resolved_path == Path(test_path).resolve()

# Windows path handling test
def test_path_normalization_with_windows_paths():
    windows_style_paths = [
        "C:\\Users\\username\\Documents\\Papers",
        "\\\\server\\share\\papers",
        "C:/Users/username/Documents/Papers",
        "C:\\Program Files\\arXiv\\papers",
        "C:\\Users/username\\Documents/Papers",
    ]
    
    for windows_path in windows_style_paths:
        assert Path(windows_path)  # Should not throw an error
        subpath = Path(windows_path) / "subdir"
        assert subpath == Path(windows_path).joinpath("subdir")
```

### Node 15: MCP Server Integration

**Function Description**: Implement a Model Context Protocol (MCP) server, providing standardized tool and prompt interfaces.

**Server Functions**:
- Provide a list of tools
- Handle tool calls
- Manage prompts
- Handle errors

**Input - Output Example**:

```python
from arxiv_mcp_server.server import server

# Tool list test
@server.list_tools()
async def list_tools() -> List[types.Tool]:
    """List available arXiv research tools."""
    return [search_tool, download_tool, list_tool, read_tool]

# Tool call test
@server.call_tool()
async def call_tool(name: str, arguments: Dict[str, Any]) -> List[types.TextContent]:
    """Handle tool calls for arXiv research functionality."""
    try:
        if name == "search_papers":
            return await handle_search(arguments)
        elif name == "download_paper":
            return await handle_download(arguments)
        elif name == "list_papers":
            return await handle_list_papers(arguments)
        elif name == "read_paper":
            return await handle_read_paper(arguments)
        else:
            return [types.TextContent(
                type="text", 
                text=f"Error: Unknown tool {name}"
            )]
    except Exception as e:
        return [types.TextContent(
            type="text", 
            text=f"Error: {str(e)}"
        )]

# Prompt list test
@server.list_prompts()
async def list_prompts() -> List[types.Prompt]:
    """List available prompts."""
    return await handler_list_prompts()

# Prompt retrieval test
@server.get_prompt()
async def get_prompt(
    name: str, arguments: Dict[str, str] | None = None
) -> types.GetPromptResult:
    """Get a specific prompt with arguments."""
    return await handler_get_prompt(name, arguments)
```

### Node 16: Error Handling and Status Management

**Function Description**: Provide a complete error handling mechanism and status management function.

**Error Types**:
- Network connection errors
- File operation errors
- Parameter validation errors
- Conversion process errors

**Input - Output Example**:

```python
# Status management
conversion_statuses: Dict[str, Any] = {}

@dataclass
class ConversionStatus:
    paper_id: str
    status: str  # 'downloading', 'converting', 'success', 'error'
    started_at: datetime
    completed_at: Optional[datetime] = None
    error: Optional[str] = None
```