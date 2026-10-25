## Introduction and Goals of the Synthetic Data Kit Project

The Synthetic Data Kit is a **high-quality synthetic dataset generation tool for LLM fine-tuning**. It can parse content from various document formats and generate structured datasets for language model fine-tuning. This tool performs excellently in the training data preparation process of large language models, enabling "high-quality synthetic data generation and optimal format conversion". Its core functions include: multi-format document parsing (supporting formats such as PDF, HTML, YouTube, DOCX, PPTX, and TXT), **intelligent content generation** (supporting various types such as QA pair generation, chain-of-thought reasoning, and summary generation), and quality control based on the Llama model and export in multiple fine-tuning formats. In short, the Synthetic Data Kit is committed to providing a complete synthetic data generation pipeline for converting raw documents into high-quality datasets suitable for LLM fine-tuning (for example, parsing documents through ingest(), generating training samples through create(), performing quality control through curate(), and exporting in fine-tuning formats through save-as()).

## Natural Language Instructions (Prompt)

Please create a Python project named Synthetic Data Kit to implement a synthetic dataset generation library for LLM fine-tuning. The project should include the following functions:

1. Multi-format document parser: Extract and parse document content from various input formats, supporting PDF (using pdfminer.six), HTML (using BeautifulSoup), YouTube video transcription (using pytube), DOCX and PPTX (using python-docx/python-pptx), and plain text formats. The parsing result should be in a unified text format or Lance dataset format, supporting multi-modal content extraction.
2. Intelligent content generation system: Implement an LLM-based content generation module that can generate various types of training data, such as high-quality question-answer pairs (QA pairs), chain-of-thought reasoning samples (Chain of Thought), and document summaries, from the parsed documents. It should support chunking processing, batch generation, custom prompt templates, and configurable generation parameters.
3. Quality control and screening: Use the Llama model as a judge to evaluate and screen the quality of the generated synthetic data, supporting configurable quality thresholds, batch processing, and a detailed quality scoring mechanism to ensure the high quality of the output data.
4. Multi-format output converter: Provide multiple fine-tuning-friendly output formats for the generated dataset, including JSONL, Alpaca format, OpenAI fine-tuning format, ChatML format, etc., while supporting local file storage and HuggingFace dataset format export.
5. Command-line tool interface: Build a complete CLI tool based on Typer, providing four core commands: ingest, create, curate, and save-as, supporting single-file and batch processing, preview mode, detailed log output, and a flexible configuration override mechanism.
6. Core file requirements: The project must include a complete pyproject.toml file. This file should not only configure the project as an installable package (supporting pip install) but also declare a complete list of dependencies (including core libraries such as datasets>=2.14.0, pdfminer.six>=20221105, pydantic>=2.4.0, python-docx>=0.8.11, python-pptx>=0.6.21, pytube>=15.0.0, pyyaml>=6.0, requests>=2.31.0, rich>=13.4.2, typer>=0.9.0, openai>=1.0.0, flask>=2.0.0, beautifulsoup4>=4.12.0). The pyproject.toml can verify whether all functional modules work properly. At the same time, it is necessary to provide synthetic_data_kit/__init__.py as a unified API entry, import core functions from each sub-module, and provide version information and configuration management, enabling users to access all major functions through a simple "from synthetic_data_kit import ingest, create, curate, save_as" statement. In models/llm_client.py, there should be an LLMClient class to uniformly manage the interface calls and response processing of different LLM providers (vLLM, OpenAI API, Llama API, etc.). The unit.py and utils.py files have the function of multi-document parsing. By simply importing the core modules with "from synthetic_data_kit import *", the document parsing function can be implemented. Finally, the project will verify the correctness of the overall function by building a complete data processing pipeline and multiple output formats.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.13.0

### Core Dependency Library Versions

```
# Core libraries for data processing
datasets>=2.14.0                    # HuggingFace dataset processing library
pydantic>=2.4.0                     # Data validation and configuration management

# Document parsing libraries
pdfminer.six>=20221105              # PDF document parsing engine
python-docx>=0.8.11                # DOCX document processing
python-pptx>=0.6.21                # PPTX presentation processing
pytube>=15.0.0                     # YouTube video and transcription download
beautifulsoup4>=4.12.0             # HTML document parsing

# Network request and configuration libraries
requests>=2.31.0                   # HTTP request processing
pyyaml>=6.0                        # YAML configuration file processing

# CLI and user interface libraries
rich>=13.4.2                       # Rich terminal output format
typer>=0.9.0                       # Modern CLI framework

# LLM interface libraries
openai>=1.0.0                      # OpenAI API client

# Web interface libraries (optional)
flask>=2.0.0                       # Web framework
flask-wtf>=1.0.0                   # Flask form processing
bootstrap-flask>=2.2.0             # Bootstrap integration
```

## Synthetic Data Kit Project Architecture

### Project Directory Structure

```
workspace/
├── .gitignore
├── .pre-commit-config.yaml
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── DOCS.md
├── LICENSE
├── MANIFEST.in
├── README.md
├── configs
│   ├── config.yaml
├── pyproject.toml
├── synthetic_data_kit
│   ├── __init__.py
│   ├── cli.py
│   ├── config.yaml
│   ├── core
│   │   ├── __init__.py
│   │   ├── context.py
│   │   ├── create.py
│   │   ├── curate.py
│   │   ├── ingest.py
│   │   ├── save_as.py
│   ├── generators
│   │   ├── __init__.py
│   │   ├── cot_generator.py
│   │   ├── multimodal_qa_generator.py
│   │   ├── qa_generator.py
│   │   ├── vqa_generator.py
│   ├── models
│   │   ├── __init__.py
│   │   ├── llm_client.py
│   ├── parsers
│   │   ├── __init__.py
│   │   ├── docx_parser.py
│   │   ├── html_parser.py
│   │   ├── multimodal_parser.py
│   │   ├── pdf_parser.py
│   │   ├── ppt_parser.py
│   │   ├── txt_parser.py
│   │   ├── youtube_parser.py
│   ├── server
│   │   ├── __init__.py
│   │   ├── app.py
│   │   ├── templates
│   │   │   ├── base.html
│   │   │   ├── create.html
│   │   │   ├── curate.html
│   │   │   ├── files.html
│   │   │   ├── index.html
│   │   │   ├── ingest.html
│   │   │   ├── upload.html
│   │   │   └── view_file.html
│   ├── utils
│   │   ├── __init__.py
│   │   ├── config.py
│   │   ├── directory_processor.py
│   │   ├── format_converter.py
│   │   ├── lance_utils.py
│   │   ├── llm_processing.py
│   │   └── text.py
└── use-cases
    ├── .DS_Store
    ├── README.md
    ├── adding_reasoning_to_llama_3
    │   ├── .DS_Store
    │   ├── BFCLv3_Accuracy_Comparison.png
    │   ├── README.md
    │   ├── cot_enhancement_tutorial.ipynb
    │   ├── cot_tools_config.yaml
    │   ├── tt_configs
    │   │   ├── fft.py
    │   │   ├── ft-config.yaml
    │   │   └── toolcall.py
    ├── awesome-synthetic-data-papers
    │   ├── ReadMe.MD
    ├── getting-started
    │   ├── .DS_Store
    │   ├── README.md
    └── multimodal-qa
        └── Multimodal_Usage_Example_Guide.ipynb

```

## API Usage Guide

### Core API

#### 1. Module Import

```
from synthetic_data_kit import (
    ingest,create,curate,save_as,
    LLMClient,DOCXParser,HTMLParser,
    PDFParser,PPTParser,TXTParser,
    YouTubeParser,parse_qa_pairs
    process_directory_ingest,
    process_directory_save_as,
    get_directory_stats,
    INGEST_EXTENSIONS,SAVE_AS_EXTENSIONS,
    config, text,llm_processing,
    to_alpaca,to_chatml,to_fine_tuning,
    to_hf_dataset,to_jsonl
)
```


#### 2. `ingest()` Command - Document Parsing and Ingestion

**Function**: Parse a single document, URL, or directory of supported files and persist Lance datasets.

**Function Signature**:
```python
def ingest(
    input: str,
    output_dir: Optional[Path] = None,
    name: Optional[str] = None,
    verbose: bool = False,
    preview: bool = False,
    multimodal: bool = False,
) -> int:
```

**Parameters**:
- `input` (str): File path, directory, or URL to ingest; directories trigger batch ingestion.
- `output_dir` (Optional[Path]): Destination for parsed outputs; defaults to the configured parsed directory.
- `name` (Optional[str]): Custom output name for single-file ingests; ignored during directory processing.
- `verbose` (bool): Enable progress reporting for batch runs.
- `preview` (bool): List the files that would be processed without writing outputs.
- `multimodal` (bool): Use multimodal parsing for PDF, DOCX, or PPTX sources, emitting text+image Lance rows.

**Returns**:
- `int`: Exit code (`0` on success, `1` if ingestion fails).

**Defined In**: `synthetic_data_kit/cli.py`.

**Import**:
```python
from synthetic_data_kit.cli import ingest
```


During directory runs the command uses `process_directory_ingest()` to iterate supported extensions. Single-file runs call `synthetic_data_kit.core.ingest.process_file()` and write a `.lance` dataset, creating the output directory when needed.


#### 3. `create()` Command - Content Generation

**Function**: Generate QA pairs, summaries, Chain-of-Thought data, multimodal QA, or CoT enhancements from parsed inputs.

**Function Signature**:
```python
def create(
    input: str,
    content_type: str = "qa",
    output_dir: Optional[Path] = None,
    api_base: Optional[str] = None,
    model: Optional[str] = None,
    num_pairs: Optional[int] = None,
    chunk_size: Optional[int] = None,
    chunk_overlap: Optional[int] = None,
    verbose: bool = False,
    preview: bool = False,
) -> int:
```

**Parameters**:
- `input` (str): File or directory to process; `.lance` inputs enable multimodal flows and directories trigger batch mode.
- `content_type` (str): Target artifact (`qa`, `summary`, `cot`, `cot-enhance`, `multimodal-qa`).
- `output_dir` (Optional[Path]): Destination for generated artifacts; defaults to the configured generated directory.
- `api_base` (Optional[str]): Override for the vLLM or OpenAI-compatible endpoint URL.
- `model` (Optional[str]): Model identifier override for the selected provider.
- `num_pairs` (Optional[int]): Target count of generated samples; falls back to configuration defaults.
- `chunk_size` (Optional[int]): Override chunk length before LLM calls when processing long texts.
- `chunk_overlap` (Optional[int]): Override overlap between chunks for context retention.
- `verbose` (bool): Emit detailed progress during batch generation.
- `preview` (bool): Inspect candidate files without invoking the generator.

**Returns**:
- `int`: Exit code (`0` on success, `1` if generation fails or prerequisites are missing).

**Defined In**: `synthetic_data_kit/cli.py`.

**Import**:
```python
from synthetic_data_kit.cli import create
```


The command selects provider configuration through `get_llm_provider()`, validates vLLM availability when required, and delegates to `process_directory_create()` for batch jobs or `synthetic_data_kit.core.create.process_file()` for single inputs. CoT enhancement workflows expect JSON inputs that follow the conversation schema described in `generators/cot_generator.py`.


#### 4. `curate()` Command - Quality Control

**Function**: Score and filter QA pairs using the configured LLM judge, producing cleaned datasets and metrics.

**Function Signature**:
```python
def curate(
    input: str,
    output: Optional[Path] = None,
    threshold: Optional[float] = None,
    api_base: Optional[str] = None,
    model: Optional[str] = None,
    verbose: bool = False,
    preview: bool = False,
) -> int:
```

**Parameters**:
- `input` (str): JSON file or directory of JSON files containing generated QA pairs.
- `output` (Optional[Path]): Target JSON path for single-file runs or directory for batch runs; defaults to the configured curated directory.
- `threshold` (Optional[float]): Minimum rating to keep a pair; falls back to `curate.threshold` in configuration.
- `api_base` (Optional[str]): Override provider endpoint for evaluation calls.
- `model` (Optional[str]): Model override for the evaluation provider.
- `verbose` (bool): Emit detailed scoring progress and intermediate diagnostics.
- `preview` (bool): Display the files that would be curated without modifying them.

**Returns**:
- `int`: Exit code (`0` when all files succeed, `1` if any item fails or validation errors occur).

**Defined In**: `synthetic_data_kit/cli.py`.

**Import**:
```python
from synthetic_data_kit.cli import curate
```


Single inputs invoke `synthetic_data_kit.core.curate.curate_qa_pairs()`; directories rely on `process_directory_curate()` with the same scoring pipeline. Preview mode uses `get_directory_stats()` to report eligible JSON sources without touching them.


#### 5. `save_as()` Command - Format Conversion

**Function**: Transform curated JSON datasets into downstream fine-tuning formats and optionally produce Hugging Face datasets.

**Function Signature**:
```python
def save_as(
    input: str,
    format: Optional[str] = None,
    storage: str = "json",
    output: Optional[Path] = None,
    verbose: bool = False,
    preview: bool = False,
) -> int:
```

**Parameters**:
- `input` (str): JSON file or directory produced by `curate()`.
- `format` (Optional[str]): Output schema (`jsonl`, `alpaca`, `ft`, `chatml`); defaults to configuration when omitted.
- `storage` (str): Output medium (`json` for files, `hf` for Arrow datasets saved via `datasets`).
- `output` (Optional[Path]): Destination path or directory; derived from configuration when omitted.
- `verbose` (bool): Emit per-file conversion progress.
- `preview` (bool): Report which files will be converted without writing results.

**Returns**:
- `int`: Exit code (`0` when conversions succeed, `1` when any conversion fails).

**Defined In**: `synthetic_data_kit/cli.py`.

**Import**:
```python
from synthetic_data_kit.cli import save_as
```


Preview mode reports supported `.json` inputs discovered by `get_directory_stats()`. Actual conversions delegate to `synthetic_data_kit.core.save_as.convert_format()` for single files or `process_directory_save_as()` for batch execution, handling both JSON outputs and Hugging Face dataset exports.


#### 6. LLMClient Class - Unified LLM Interface

**Function**: Provide chat and batch completion helpers that work with vLLM servers and OpenAI-compatible endpoints.

**Class Definition**:
```python
class LLMClient:
    def __init__(
        self,
        config_path: Optional[Path] = None,
        provider: Optional[str] = None,
        api_base: Optional[str] = None,
        api_key: Optional[str] = None,
        model_name: Optional[str] = None,
        max_retries: Optional[int] = None,
        retry_delay: Optional[float] = None,
    ):
        """Initialize a multi-provider LLM client"""
```

**Constructor Parameters**:
- `config_path` (Optional[Path]): YAML configuration file; defaults to package configuration when omitted.
- `provider` (Optional[str]): Override for the provider (`"vllm"` or `"api-endpoint"`).
- `api_base` (Optional[str]): Base URL override for the selected provider.
- `api_key` (Optional[str]): API key override when using the API endpoint provider.
- `model_name` (Optional[str]): Model identifier override for chat requests.
- `max_retries` (Optional[int]): Maximum retry attempts for failed completions.
- `retry_delay` (Optional[float]): Delay between retry attempts in seconds.

##### Core Methods

###### 1. `_init_openai_client()`
```python
def _init_openai_client(self) -> None:
    """Initialize OpenAI client with appropriate configuration"""
```
Initialises the OpenAI SDK client when `provider == "api-endpoint"`, wiring API base, key, and retry parameters.

###### 2. `_check_vllm_server()`
```python
def _check_vllm_server(self) -> tuple:
    """Check if the VLLM server is running and accessible"""
```
Performs a health check against `{api_base}/models`, returning a `(available, info)` tuple for diagnostics.

###### 3. `chat_completion()`
```python
def chat_completion(
    self,
    messages: List[Dict[str, str]],
    temperature: float = None,
    max_tokens: int = None,
    top_p: float = None,
) -> str:
    """Generate a chat completion using the selected provider"""
```
Dispatches a single chat request, pulling default sampling parameters from configuration when not supplied. Routes to `_openai_chat_completion()` or `_vllm_chat_completion()` based on provider.

###### 4. `_openai_chat_completion()`
```python
def _openai_chat_completion(
    self,
    messages: List[Dict[str, str]],
    temperature: float,
    max_tokens: int,
    top_p: float,
    verbose: bool,
) -> str:
```
Invokes `openai.ChatCompletions.create`, handling retries, debug logging, and response parsing for API endpoint providers.

###### 5. `_vllm_chat_completion()`
```python
def _vllm_chat_completion(
    self,
    messages: List[Dict[str, str]],
    temperature: float,
    max_tokens: int,
    top_p: float,
    verbose: bool,
) -> str:
```
Issues a POST request to the vLLM REST API, validating HTTP errors and returning the assistant message content.

###### 6. `batch_completion()`
```python
def batch_completion(
    self,
    message_batches: List[List[Dict[str, str]]],
    temperature: float = None,
    max_tokens: int = None,
    top_p: float = None,
    batch_size: int = None,
) -> List[str]:
    """Process multiple message sets using the configured provider"""
```
Processes a collection of message batches, chunking requests to respect rate limits and delegating to provider-specific batch helpers.

###### 7. `_openai_batch_completion()`
```python
def _openai_batch_completion(
    self,
    message_batches: List[List[Dict[str, str]]],
    temperature: float,
    max_tokens: int,
    top_p: float,
    batch_size: int,
    verbose: bool,
) -> List[str]:
```
Uses asyncio to parallelise OpenAI-compatible chat completions, honouring `SDK_DEBUG` for trace logging and aggregating responses.

###### 8. `_vllm_batch_completion()`
```python
def _vllm_batch_completion(
    self,
    message_batches: List[List[Dict[str, str]]],
    temperature: float,
    max_tokens: int,
    top_p: float,
    batch_size: int,
    verbose: bool,
) -> List[str]:
```
Loops through request batches, sending them sequentially to the vLLM REST endpoint, collecting generated message content, and handling transient errors.

###### 9. `from_config()`
```python
@classmethod
def from_config(cls, config_path: Path) -> "LLMClient":
    """Create a client from configuration file"""
```
Convenience constructor that forwards to `LLMClient(config_path=config_path)`.

**Defined In**: `synthetic_data_kit/models/llm_client.py`.

**Import**:
```python
from synthetic_data_kit.models.llm_client import from_config
```


#### 7. COTGenerator Class
**Function Description**: A generator class used to produce Chain-of-Thought (CoT) reasoning examples.

##### Class Initialization
```python
def __init__(self, client: LLMClient, config_path: Optional[Path] = None):
    """
    Initialize the CoT generator.
    
    Parameters:
        client: An instance of LLMClient for interacting with the language model.
        config_path: Optional configuration file path.
    """
```

##### Main Methods

###### 1. `generate_cot_examples`
```python
def generate_cot_examples(self, document_text: str, num_examples: int = None) -> List[Dict[str, Any]]
```
**Function**: Generate Chain-of-Thought reasoning examples for a given document.

**Parameters**:
- `document_text` (str): Input document text.
- `num_examples` (int, optional): Number of examples to generate. Defaults to the value in the configuration.

**Returns**:
- `List[Dict[str, Any]]`: A list of generated Chain-of-Thought examples, each example is a dictionary.

###### 2. `parse_json_output`
```python
def parse_json_output(self, output_text: str) -> Optional[List[Dict]]
```
**Function**: Parse JSON-formatted responses from LLM output.

**Parameters**:
- `output_text` (str): Raw output text from the LLM.

**Returns**:
- `Optional[List[Dict]]`: Parsed JSON data, returns None if parsing fails.

###### 3. `_generate_single_call`
```python
def _generate_single_call(self, document_text: str, num_examples: int) -> List[Dict[str, Any]]
```
**Function**: Generate Chain-of-Thought examples through a single API call (internal method).

###### 4. `_generate_with_chunking`
```python
def _generate_with_chunking(self, document_text: str, num_examples: int) -> List[Dict[str, Any]]
```
**Function**: Process long documents using a chunking strategy (internal method).

###### 5. `enhance_with_cot`
```python
def enhance_with_cot(self, conversations: List[Dict], include_simple_steps: bool = False) -> List[Dict]
```
**Function**: Add Chain-of-Thought reasoning to existing conversations.

**Parameters**:
- `conversations` (List[Dict]): List of conversations to be enhanced.
- `include_simple_steps` (bool, optional): Whether to include simple steps. Defaults to False.

**Returns**:
- `List[Dict]`: Enhanced list of conversations containing Chain-of-Thought reasoning.

**Processing Flow**:
1. Format input conversations using the prompt template from the configuration.
2. Call the LLM to generate enhanced content.
3. Parse and return the enhanced conversations.

###### 6. `process_document`
```python
def process_document(self, document_text: str, num_examples: int = None, include_simple_steps: bool = False) -> Dict[str, Any]
```
**Function**: Process a document and generate examples containing Chain-of-Thought.

**Parameters**:
- `document_text` (str): Input document text.
- `num_examples` (int, optional): Number of examples to generate.
- `include_simple_steps` (bool, optional): Whether to include simple steps. Defaults to False.

**Returns**:
- `Dict[str, Any]`: A dictionary containing the following keys:
  - `summary`: Document summary.
  - `cot_examples`: List of generated Chain-of-Thought examples.
  - `conversations`: List of formatted conversations.

**Processing Flow**:
1. Generate a document summary.
2. Use `generate_cot_examples` to generate Chain-of-Thought examples.
3. Format the examples into conversation form.
4. Return a result dictionary containing the summary, examples, and conversations.

**Example**:

```python
from synthetic_data_kit.generators.cot_generator import COTGenerator
from synthetic_data_kit.models.llm_client import LLMClient

# Initialize LLM client
client = LLMClient()

# Create COT generator
cot_generator = COTGenerator(client=client)

# Generate Chain-of-Thought examples
document = """
This is example document content.
"""

examples = cot_generator.generate_cot_examples(
    document_text=document,
    num_examples=3
)
```

---

#### 8. Utility Functions

##### `parse_qa_pairs` Function
```python
def parse_qa_pairs(text: str) -> List[Dict[str, str]]
```
**Function**: Parse question-answer pairs from LLM output with enhanced error handling.

**Parameters**:
- `text` (str): Text containing question-answer pairs, which can be in JSON format or free text.

**Returns**:
- `List[Dict[str, str]]`: A list of parsed question-answer pairs, each element is a dictionary containing "question" and "answer" keys.

**Processing Flow**:
1. First attempt to parse directly as JSON format.
2. If that fails, try to extract the JSON array portion.
3. Finally fall back to regular expression matching.
4. Supports handling escape characters and irregularly formatted output.

**Environment Variables**:
- `SDK_VERBOSE`: Output detailed logs when set to 'true'.

**Example**:
```python
from synthetic_data_kit.utils.llm_processing import parse_qa_pairs

# Example LLM output
llm_output = """
[
    {"question": "Question 1", "answer": "Answer 1"},
    {"question": "Question 2", "answer": "Answer 2"}
]
"""

# Parse question-answer pairs
qa_pairs = parse_qa_pairs(llm_output)
```

#### 9. Related Functions


##### `parse_ratings`
```python
def parse_ratings(text: str, original_items: List[Dict[str, str]] = None) -> List[Dict[str, Any]]
```
**Function**: Parse rating data from LLM output, applying resilient JSON extraction.

**Parameters**:
- `text` (str): Raw model response containing ratings.
- `original_items` (Optional[List[Dict[str, str]]]): Fallback items used for pattern-based extraction when JSON parsing fails.

**Returns**:
- `List[Dict[str, Any]]`: Rated items including `question`, `answer`, and numeric `rating` fields.

##### `convert_to_conversation_format`
```python
def convert_to_conversation_format(qa_pairs: List[Dict[str, str]],
                                system_prompt: Optional[str] = None) -> List[List[Dict[str, str]]]
```
**Function**: Convert question-answer pairs into conversation format suitable for chat fine-tuning.

**Parameters**:
- `qa_pairs` (List[Dict[str, str]]): Sequence of QA dictionaries.
- `system_prompt` (Optional[str]): Optional system message content; defaults to a helpful assistant prompt.

**Returns**:
- `List[List[Dict[str, str]]]`: Conversations with `system`, `user`, and `assistant` messages.

##### `split_into_chunks`
```python
def split_into_chunks(text: str, chunk_size: int = 4000, overlap: int = 200) -> List[str]:
    """Split text into chunks with optional overlap"""
```
**Function**: Split long text into overlapping chunks, preserving some trailing sentences for context.

**Parameters**:
- `text` (str): Input text to split.
- `chunk_size` (int): Maximum characters per chunk.
- `overlap` (int): Amount of context retained between chunks.

**Returns**:
- `List[str]`: Ordered list of text chunks.

##### `extract_json_from_text`
```python
def extract_json_from_text(text: str) -> Dict[str, Any]:
    """Extract JSON from text that might contain markdown or other content"""
```
**Function**: Pull JSON objects or arrays from free-form LLM responses, handling markdown wrappers.

**Parameters**:
- `text` (str): Model response containing JSON.

**Returns**:
- `Dict[str, Any]`: Parsed JSON object or array.

**Raises**:
- `ValueError`: When no valid JSON can be extracted.


#### 10. AppContext Class - Application Context Management

**Function**: Provide shared configuration state for CLI commands and ensure required directories exist.

**Class Definition**:
```python
class AppContext:
    def __init__(self, config_path: Optional[Path] = None):
        """Initialize app context"""
```

**Constructor Parameters**:
- `config_path` (Optional[Path]): Explicit configuration file path; defaults to `DEFAULT_CONFIG_PATH`.

###### 1. `_ensure_data_dirs()`
```python
def _ensure_data_dirs(self) -> None:
    """Ensure data directories exist based on configuration"""
```
Loads the configuration, creates the configured input directory, and materialises parsed, generated, curated, and final output folders.

**Defined In**: `synthetic_data_kit/core/context.py`.

**Import**:
```python
from synthetic_data_kit.core.context import _ensure_data_dirs
```


#### 11. QAGenerator Class - Text QA Generation Pipeline

**Function**: Produce summaries, generate QA pairs, score them, and package results for downstream use.

**Class Definition**:
```python
class QAGenerator:
    def __init__(
        self,
        client: LLMClient,
        config_path: Optional[Path] = None,
    ):
        """Initialize the QA Generator with an LLM client and optional config"""
```

###### 1. `generate_summary()`
```python
def generate_summary(
    self,
    document_text: str,
    rolling_summary: Optional[bool] = False,
) -> str:
```
Creates summaries using configured prompts, optionally performing rolling summaries over long documents.

###### 2. `generate_qa_pairs()`
```python
def generate_qa_pairs(
    self,
    document_text: str,
    summary: str,
    num_pairs: int = 25,
) -> List[Dict[str, str]]:
```
Splits documents into chunks, calls `batch_completion()`, and parses responses via `parse_qa_pairs()`.

###### 3. `rate_qa_pairs()`
```python
def rate_qa_pairs(
    self,
    qa_pairs: List[Dict[str, str]],
    summary: str,
    threshold: Optional[float] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
```
Scores QA pairs using configured rating prompts and returns filtered items plus aggregate metrics.

###### 4. `process_documents()`
```python
def process_documents(
    self,
    documents: List[Dict[str, Any]],
    num_pairs: int = 25,
    verbose: bool = False,
    rolling_summary: Optional[bool] = False,
) -> Dict[str, Any]:
```
Combines documents, builds a summary, produces QA pairs, and returns a payload containing the summary and generated items.

**Defined In**: `synthetic_data_kit/generators/qa_generator.py`.

**Import**:
```python
from synthetic_data_kit.generators.qa_generator import process_documents
```


#### 12. MultimodalQAGenerator Class - Multimodal QA Creation

**Function**: Generate QA pairs from multimodal Lance datasets that contain text and optional images.

**Class Definition**:
```python
class MultimodalQAGenerator:
    def __init__(self, client: LLMClient, config_path: Optional[str] = None):
        """Generates Multimodal Question Answering data (text QA from text+image context)"""
```

###### 1. `generate_qa_pairs()`
```python
def generate_qa_pairs(
    self,
    documents,
    num_pairs: int = 25,
    verbose: bool = False,
) -> List[Dict[str, str]]:
```
Concatenates text, attaches the first available image, constructs batched multimodal prompts, and parses JSON responses for QA pairs.

###### 2. `process_dataset()`
```python
def process_dataset(
    self,
    documents,
    output_dir: str,
    num_examples: Optional[int] = None,
    verbose: bool = False,
    base_name: str = "multimodal_qa_pairs",
) -> str:
```
Invokes `generate_qa_pairs()`, writes the resulting pairs to `{output_dir}/{base_name}.json`, and returns the file path.

**Defined In**: `synthetic_data_kit/generators/multimodal_qa_generator.py`.

**Import**:
```python
from synthetic_data_kit.generators.multimodal_qa_generator import process_dataset
```


#### 13. VQAGenerator Class - Visual QA Enhancement

**Function**: Add reasoning-rich answers to visual question answering datasets.

**Class Definition**:
```python
class VQAGenerator:
    def __init__(
        self,
        client: LLMClient,
        config_path: Optional[Path] = None,
    ):
        """Initialize the VQA Generator with an LLM client and optional config"""
```

###### 1. `encode_image_base64()`
```python
def encode_image_base64(self, image) -> str:
    """Encode an image in base64 format"""
```
Transforms PIL images into base64 strings for inclusion in chat prompts.

###### 2. `transform()`
```python
def transform(self, messages):
    """Transform messages by adding reasoning to VQA data"""
```
Builds multimodal prompts for each dataset row, calls `batch_completion()`, and replaces labels with generated answers.

###### 3. `process_dataset()`
```python
def process_dataset(
    self,
    dataset_source,
    output_dir: str,
    num_examples: Optional[int] = None,
    input_split: Optional[str] = None,
    output_split: Optional[str] = None,
    verbose: bool = False,
) -> str:
```
Loads a local or hub dataset, applies `transform()` in batches, and writes the augmented dataset to Parquet or Arrow storage.

**Defined In**: `synthetic_data_kit/generators/vqa_generator.py`.

**Import**:
```python
from synthetic_data_kit.generators.vqa_generator import process_dataset
```


#### 14. DOCXParser Class - Word Document Parsing

**Function**: Extract text from DOCX files, including table content.

**Class Definition**:
```python
class DOCXParser:
    def parse(self, file_path: str) -> str:
        """Parse a DOCX file into plain text"""
```

###### 1. `parse()`
Returns a list with a single dictionary containing the extracted text from paragraphs and tables.

###### 2. `save()`
```python
def save(self, content: str, output_path: str) -> None:
    """Save the extracted text to a file"""
```
Writes parsed text to disk, creating parent directories as needed.

**Defined In**: `synthetic_data_kit/parsers/docx_parser.py`.

**Import**:
```python
from synthetic_data_kit.parsers.docx_parser import save
```


#### 15. HTMLParser Class - HTML and Web Page Parsing

**Function**: Convert local HTML files or URLs into cleaned plain text.

###### 1. `parse()`
```python
def parse(self, file_path: str) -> str:
    """Parse an HTML file or URL into plain text"""
```
Detects URLs versus files, fetches HTML with `requests` when needed, removes scripts/styles, and normalises whitespace.

###### 2. `save()`
```python
def save(self, content: str, output_path: str) -> None:
    """Save the extracted text to a file"""
```
Persists cleaned text to UTF-8 files.

**Defined In**: `synthetic_data_kit/parsers/html_parser.py`.

**Import**:
```python
from synthetic_data_kit.parsers.html_parser import save
```


#### 16. MultimodalParser Class - Text and Image Extraction

**Function**: Emit combined text and image payloads for PDF, DOCX, and PPTX sources.

###### 1. `parse()`
```python
def parse(self, file_path: str) -> List[Dict[str, Any]]:
    """Parses a file, extracting text and images."""
```
Dispatches to format-specific handlers and raises `ValueError` for unsupported extensions.

###### 2. `_parse_pdf()` / `_parse_docx()` / `_parse_pptx()`
Each helper returns dictionaries containing `text` plus raw image bytes (or `None` when absent) for every page or slide.

**Defined In**: `synthetic_data_kit/parsers/multimodal_parser.py`.

**Import**:
```python
from synthetic_data_kit.parsers.multimodal_parser import _parse_pdf
```


#### 17. PDFParser Class - PDF Text Extraction

**Function**: Download or read PDFs and convert them into text records.

###### 1. `parse()`
```python
def parse(self, file_path: str) -> List[Dict[str, Any]]:
    """Parse a PDF file into plain text"""
```
Supports remote URLs by streaming content into a temporary file before using `pdfminer.six` to extract text.

###### 2. `save()`
```python
def save(self, content: str, output_path: str) -> None:
    """Save the extracted text to a file"""
```
Writes extracted text to disk with UTF-8 encoding.

**Defined In**: `synthetic_data_kit/parsers/pdf_parser.py`.

**Import**:
```python
from synthetic_data_kit.parsers.pdf_parser import save
```


#### 18. PPTParser Class - Presentation Parsing

**Function**: Extract structured slide text from PowerPoint decks.

###### 1. `parse()`
```python
def parse(self, file_path: str) -> str:
    """Parse a PPTX file into plain text"""
```
Uses `python-pptx` to iterate slides, capturing titles and text-containing shapes, returning a list with a single `{ "text": ... }` entry.

###### 2. `save()`
Writes extracted slide content to disk for downstream processing.

**Defined In**: `synthetic_data_kit/parsers/ppt_parser.py`.

**Import**:
```python
from synthetic_data_kit.parsers.ppt_parser import save
```


#### 19. TXTParser Class - Plain Text Loader

**Function**: Read UTF-8 text files into Lance-ready payloads.

###### 1. `parse()`
```python
def parse(self, file_path: str) -> str:
    """Parse a text file"""
```
Returns a one-element list containing the file text under the `text` key.

###### 2. `save()`
Persists text back to disk, creating parent directories when absent.

**Defined In**: `synthetic_data_kit/parsers/txt_parser.py`.

**Import**:
```python
from synthetic_data_kit.parsers.txt_parser import save
```


#### 20. YouTubeParser Class - Transcript Retrieval

**Function**: Download YouTube transcripts with metadata using `pytubefix` and `youtube-transcript-api`.

###### 1. `parse()`
```python
def parse(self, url: str) -> str:
    """Parse a YouTube video transcript"""
```
Extracts the video ID, fetches transcript segments, and returns metadata plus combined transcript text.

###### 2. `save()`
```python
def save(self, content: str, output_path: str) -> None:
    """Save the transcript to a file"""
```
Writes transcript output to the requested location.

**Defined In**: `synthetic_data_kit/parsers/youtube_parser.py`.

**Import**:
```python
from synthetic_data_kit.parsers.youtube_parser import save
```



### Configuration System

#### 1. Configuration File Structure

```yaml
# paths: Path configuration
paths:
  input: "data/input"           # Directory containing PDF, HTML, DOCX, PPT, TXT files
  output:
    parsed: "data/parsed"       # Stage 1: Where parsed text files are saved
    generated: "data/generated" # Stage 2: Where generated QA pairs are saved
    curated: "data/curated"     # Stage 3: Where curated QA pairs are saved
    final: "data/final"         # Stage 4: Where final training formats are saved
  output:
    parsed: "data/parsed"
    generated: "data/generated"
    curated: "data/curated"
    final: "data/final"

# llm: LLM provider configuration
llm:
  provider: "vllm"  # vllm, openai, api-endpoint
  
# vllm: vLLM server configuration
vllm:
  api_base: "http://localhost:8000/v1"
  model: "meta-llama/Llama-3.3-70B-Instruct"
  port: 8000
  max_retries: 3
  retry_delay: 1.0

# generation: Content generation parameters
generation:
  temperature: 0.7
  top_p: 0.95
  chunk_size: 4000
  overlap: 200
  max_tokens: 4096
  num_pairs: 25
  batch_size: 32

# curate: Quality control parameters
curate:
  threshold: 7.0
  batch_size: 8
  temperature: 0.1

# format: Output format parameters
format:
  default: "jsonl"
  include_metadata: true
  pretty_json: true
```

#### 2. Configuration Management API

```python
from synthetic_data_kit.utils.config import (
    load_config, 
    get_path_config, 
    get_llm_provider, 
    get_vllm_config,
    get_generation_config,
    get_curate_config,
    get_format_config
)

# Load the default configuration
config = load_config()

# Load a custom configuration
config = load_config("custom_config.yaml")

# Use the configuration manager
config_manager = ConfigManager("configs/config.yaml")
vllm_config = config_manager.get_vllm_config()
generation_config = get_generation_config(config)
```


#### 50. `load_config()` Function - Configuration Loader

**Function**: Discover and load the active YAML configuration file.

**Function Signature**:
```python
def load_config(config_path: Optional[str] = None) -> Dict[str, Any]:
    """Load YAML configuration file"""
```

**Parameters**:
- `config_path` (Optional[str]): Explicit path to a configuration file; when omitted, checks package and repo defaults.

**Returns**:
- `Dict[str, Any]`: Parsed configuration dictionary.

**Defined In**: `synthetic_data_kit/utils/config.py`.

**Import**:
```python
from synthetic_data_kit.utils.config import load_config
```


#### 51. `get_path_config()` Function - Resolve Paths

**Function**: Retrieve path settings for input or output directories from the configuration.

**Function Signature**:
```python
def get_path_config(config: Dict[str, Any], path_type: str, file_type: Optional[str] = None) -> str:
    """Get path from configuration based on type and optionally file type"""
```

**Parameters**:
- `config` (Dict[str, Any]): Loaded configuration.
- `path_type` (str): Either `"input"` or `"output"`.
- `file_type` (Optional[str]): Specific path key (e.g., `"parsed"`, `"generated"`).

**Returns**:
- `str`: Resolved directory path.

**Defined In**: `synthetic_data_kit/utils/config.py`.

**Import**:
```python
from synthetic_data_kit.utils.config import get_path_config
```


#### 52. `get_llm_provider()` Function - Provider Selection

**Function**: Determine the active LLM provider (`"vllm"` or `"api-endpoint"`).

**Function Signature**:
```python
def get_llm_provider(config: Dict[str, Any]) -> str:
    """Get the selected LLM provider"""
```

**Parameters**:
- `config` (Dict[str, Any]): Loaded configuration.

**Returns**:
- `str`: Provider identifier.

**Defined In**: `synthetic_data_kit/utils/config.py`.

**Import**:
```python
from synthetic_data_kit.utils.config import get_llm_provider
```


#### 53. `get_vllm_config()` Function - vLLM Configuration

**Function**: Extract vLLM-specific settings with sensible defaults.

**Function Signature**:
```python
def get_vllm_config(config: Dict[str, Any]) -> Dict[str, Any]:
```

**Returns**:
- `Dict[str, Any]`: Configuration dictionary containing API base, model, retry limits, and sleep timings.

**Defined In**: `synthetic_data_kit/utils/config.py`.

**Import**:
```python
from synthetic_data_kit.utils.config import get_vllm_config
```


#### 54. `get_openai_config()` Function - API Endpoint Configuration

**Function**: Retrieve configuration for OpenAI-compatible endpoints.

**Function Signature**:
```python
def get_openai_config(config: Dict[str, Any]) -> Dict[str, Any]:
```

**Returns**:
- `Dict[str, Any]`: API base, key, model, and retry parameters.

**Defined In**: `synthetic_data_kit/utils/config.py`.

**Import**:
```python
from synthetic_data_kit.utils.config import get_openai_config
```


#### 55. `get_generation_config()` Function - Generation Settings

**Function**: Access temperature, top-p, chunking, and token limits for content generation.

**Function Signature**:
```python
def get_generation_config(config: Dict[str, Any]) -> Dict[str, Any]:
```

**Returns**:
- `Dict[str, Any]`: Generation configuration dictionary.

**Defined In**: `synthetic_data_kit/utils/config.py`.

**Import**:
```python
from synthetic_data_kit.utils.config import get_generation_config
```


#### 56. `get_curate_config()` Function - Curation Settings

**Function**: Provide filtering thresholds and batch sizes for QA curation.

**Function Signature**:
```python
def get_curate_config(config: Dict[str, Any]) -> Dict[str, Any]:
```

**Returns**:
- `Dict[str, Any]`: Curation configuration dictionary.

**Defined In**: `synthetic_data_kit/utils/config.py`.

**Import**:
```python
from synthetic_data_kit.utils.config import get_curate_config
```


#### 57. `get_format_config()` Function - Output Format Settings

**Function**: Retrieve defaults for format conversion (default format, metadata flags, pretty printing).

**Function Signature**:
```python
def get_format_config(config: Dict[str, Any]) -> Dict[str, Any]:
```

**Returns**:
- `Dict[str, Any]`: Format configuration dictionary.

**Defined In**: `synthetic_data_kit/utils/config.py`.

**Import**:
```python
from synthetic_data_kit.utils.config import get_format_config
```


#### 58. `get_prompt()` Function - Prompt Lookup

**Function**: Fetch named prompt templates from configuration.

**Function Signature**:
```python
def get_prompt(config: Dict[str, Any], prompt_name: str) -> str:
    """Get prompt by name"""
```

**Parameters**:
- `config` (Dict[str, Any]): Loaded configuration.
- `prompt_name` (str): Key inside the `prompts` mapping.

**Returns**:
- `str`: Prompt template string.

**Defined In**: `synthetic_data_kit/utils/config.py`.

**Import**:
```python
from synthetic_data_kit.utils.config import get_prompt
```


#### 59. `merge_configs()` Function - Deep Merge Utility

**Function**: Combine two configuration dictionaries recursively.

**Function Signature**:
```python
def merge_configs(base_config: Dict[str, Any], override_config: Dict[str, Any]) -> Dict[str, Any]:
    """Merge two configuration dictionaries"""
```

**Parameters**:
- `base_config` (Dict[str, Any]): Source configuration.
- `override_config` (Dict[str, Any]): Overrides applied recursively.

**Returns**:
- `Dict[str, Any]`: Merged configuration dictionary.

**Defined In**: `synthetic_data_kit/utils/config.py`.

**Import**:
```python
from synthetic_data_kit.utils.config import merge_configs
```

### Actual Usage Modes

#### Basic Usage

```python
from synthetic_data_kit import ingest, create, curate, save_as

# 1. Parse a PDF document
parsed_file = ingest("document.pdf")

# 2. Generate QA pairs
generated_file = create(parsed_file, generation_type="qa", num_pairs=30)

# 3. Quality screening
curated_file = curate(generated_file, threshold=8.0)

# 4. Format conversion
final_file = save_as(curated_file, format_type="alpaca")
```

#### Batch Processing

```python
# Batch process a directory
parsed_files = ingest("./documents", preview=False)
generated_file = create("./data/parsed", generation_type="cot", num_pairs=50)
curated_file = curate(generated_file, threshold=7.5)
final_file = save_as(curated_file, format_type="ft", storage="hf")
```

#### Usage with Custom Configuration

```python
from synthetic_data_kit.utils.config import load_config

# Load a custom configuration
config = load_config("my_config.yaml")

# Use the custom configuration
parsed_file = ingest("document.pdf", config=config)
generated_file = create(
    parsed_file, 
    generation_type="qa",
    chunk_size=config["generation"]["chunk_size"],
    temperature=config["generation"]["temperature"]
)
```

### Supported Data Types

- **Document Formats**: PDF, HTML, DOCX, PPTX, TXT, YouTube videos
- **Generation Types**: Question-answer pairs (QA), Chain-of-thought reasoning (CoT), Document summaries, Multi-modal Q&A
- **Output Formats**: JSONL, Alpaca, OpenAI fine-tuning format, ChatML
- **Storage Methods**: Local files, HuggingFace datasets

### Error Handling

The system provides a comprehensive error handling mechanism:

- **Connection Detection**: Automatically detect the connection status of the LLM server
- **Format Fault Tolerance**: Automatically handle various document format errors
- **Retry Mechanism**: Automatic retry when network requests fail
- **Log Recording**: Detailed operation logs and error information

### Important Notes

1. **LLM Server Requirements**: A vLLM server needs to be running or other LLM API endpoints need to be configured.
2. **Memory Management**: Pay attention to memory usage when processing large documents and adjust the chunk size if necessary.
3. **Concurrency Control**: Pay attention to the API call frequency limit when processing in batches.
4. **Quality Control**: Reasonably set the quality threshold to balance the data volume and quality.

## Detailed Implementation Nodes of Functions

### Node 1: PDF Document Parsing

**Function Description**: Use the pdfminer.six library to parse PDF documents, extract text content and metadata, and support documents with complex layouts and multiple languages.

**Core Algorithms**:

- Page-level text extraction
- Layout analysis and paragraph reconstruction
- Metadata extraction (title, author, creation time, etc.)
- Text cleaning and formatting


#### 60. `callback()` Function - CLI Global Options

**Function**: Register global Typer options (such as `--config`) and hydrate the shared `AppContext` before command execution.

**Function Signature**:
```python
def callback(
    config: Optional[Path] = typer.Option(
        None, "--config", "-c", help="Path to configuration file"
    ),
):
    """
    Global options for the Synthetic Data Kit CLI
    """
```

**Parameters**:
- `config` (Optional[Path]): Optional configuration file supplied via CLI.

**Returns**:
- `None`: Mutates the global context (`ctx.config_path` and `ctx.config`).

**Defined In**: `synthetic_data_kit/cli.py`.

**Import**:
```python
from synthetic_data_kit.cli import callback
```


#### 61. `system_check()` Command - Provider Diagnostics

**Function**: Validate environment variables and connectivity for the configured provider.

**Function Signature**:
```python
def system_check(
    api_base: Optional[str] = typer.Option(
        None, "--api-base", help="API base URL to check"
    ),
    provider: Optional[str] = typer.Option(
        None, "--provider", help="Provider to check ('vllm' or 'api-endpoint')"
    )
):
    """
    Check if the selected LLM provider's server is running.
    """
```

**Parameters**:
- `api_base` (Optional[str]): Override endpoint for connectivity tests.
- `provider` (Optional[str]): Provider override; defaults to configuration when omitted.

**Returns**:
- `int`: Exit code (`0` on success, `1` when diagnostics fail).

**Defined In**: `synthetic_data_kit/cli.py`.

**Import**:
```python
from synthetic_data_kit.cli import system_check
```

**Input-Output Examples**:

```python
from synthetic_data_kit import ingest

# Basic PDF parsing
result = ingest("research_paper.pdf")
print(result)  # "data/parsed/research_paper.lance"

# Multi-modal PDF parsing (including image information)
result = ingest("document_with_images.pdf", multimodal=True)
print(result)  # Lance dataset containing text and image columns

# Batch PDF processing
result = ingest("./pdf_documents/", file_format="pdf")
print(result)  # ["data/parsed/doc1.lance", "data/parsed/doc2.lance", ...]

# Preview mode
result = ingest("./pdf_documents/", preview=True)
print(result)  
# Output:
# Directory: ./pdf_documents/
# Total files: 15
# Supported files: 12
# Extensions: .pdf (12)
# Files: paper1.pdf, paper2.pdf, ...

# Custom output directory
result = ingest("document.pdf", output_dir="custom_output/")
print(result)  # "custom_output/document.lance"

# Test verification
assert os.path.exists("data/parsed/research_paper.lance")
assert "meta-llama" in open("data/parsed/research_paper.txt").read()
```


#### 21. `_check_pdf_url()` Function - Validate PDF URLs

**Function**: Determine whether a remote URL serves PDF content before downloading.

**Function Signature**:
```python
def _check_pdf_url(url: str) -> bool:
    """Check if `url` points to PDF content"""
```

**Parameters**:
- `url` (str): HTTP or HTTPS URL to inspect.

**Returns**:
- `bool`: `True` when the server reports `application/pdf`, otherwise `False`.

**Defined In**: `synthetic_data_kit/core/ingest.py`.

**Import**:
```python
from synthetic_data_kit.core.ingest import _check_pdf_url
```


#### 22. `determine_parser()` Function - Select Document Parser

**Function**: Choose the appropriate parser implementation for a local path or URL, with optional multimodal handling.

**Function Signature**:
```python
def determine_parser(
    file_path: str,
    config: Dict[str, Any],
    multimodal: bool = False,
):
    """Determine the appropriate parser for a file or URL"""
```

**Parameters**:
- `file_path` (str): Input file path or URL.
- `config` (Dict[str, Any]): Loaded configuration dictionary for path resolution.
- `multimodal` (bool): When `True`, require `MultimodalParser` for PDF, DOCX, and PPTX sources.

**Returns**:
- Parser instance (`PDFParser`, `HTMLParser`, `YouTubeParser`, `DOCXParser`, `PPTParser`, `TXTParser`, or `MultimodalParser`) prepared for the requested source.

**Defined In**: `synthetic_data_kit/core/ingest.py`.

**Import**:
```python
from synthetic_data_kit.core.ingest import determine_parser
```


#### 23. `process_file()` Function - Ingest Document

**Function**: Parse a single source using the selected parser and persist the result as a Lance dataset.

**Function Signature**:
```python
def process_file(
    file_path: str,
    output_dir: Optional[str] = None,
    output_name: Optional[str] = None,
    config: Optional[Dict[str, Any]] = None,
    multimodal: bool = False,
) -> str:
    """Process a file using the appropriate parser"""
```

**Parameters**:
- `file_path` (str): Local path or URL to parse.
- `output_dir` (Optional[str]): Destination directory; created when absent.
- `output_name` (Optional[str]): Custom base name for the output dataset; derived from source when omitted.
- `config` (Optional[Dict[str, Any]]): Configuration overrides passed to downstream utilities.
- `multimodal` (bool): Enable multimodal Lance schema (`text` + `image`).

**Returns**:
- `str`: Path to the written `.lance` dataset.

**Defined In**: `synthetic_data_kit/core/ingest.py`.

**Import**:
```python
from synthetic_data_kit.core.ingest import process_file
```

### Node 2: YouTube Video Transcription Processing

**Function Description**: Download the audio and subtitles of YouTube videos, obtain the transcribed text, and perform content cleaning and formatting.

**Supported Functions**:

- Automatic subtitle download
- Support for multi-language subtitles
- Timestamp processing
- Audio-to-text conversion (if subtitles are unavailable)

**Input-Output Examples**:

```python
from synthetic_data_kit import ingest

# YouTube URL parsing
result = ingest("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
print(result)  # "data/parsed/youtube_dQw4w9WgXcQ.lance"

# YouTube processing with preview
result = ingest("https://www.youtube.com/watch?v=abc123", preview=True)
print(result)
# Output:
# Video: "How to Build AI Models"
# Duration: 45:32
# Language: en
# Captions available: Yes

# Batch processing of YouTube links
youtube_urls = [
    "https://www.youtube.com/watch?v=abc123",
    "https://www.youtube.com/watch?v=def456"
]
results = []
for url in youtube_urls:
    result = ingest(url)
    results.append(result)
print(results)  # ["data/parsed/youtube_abc123.lance", "data/parsed/youtube_def456.lance"]

# Test verification
assert "transcript" in open("data/parsed/youtube_dQw4w9WgXcQ.txt").read()
assert len(open("data/parsed/youtube_dQw4w9WgXcQ.txt").read()) > 1000
```

### Node 3: QA Pair Generation

**Function Description**: Use LLM to generate high-quality question-answer pairs from the parsed documents, supporting the generation of different difficulty levels and question types.

**Generation Strategies**:

- Factual Q&A based on document content
- Generation of reasoning questions
- Multiple-choice and open-ended questions
- Context-related question-answer pairs

**Input-Output Examples**:

```python
from synthetic_data_kit import create

# Basic QA pair generation
result = create("data/parsed/document.lance", generation_type="qa")
print(result)  # "data/generated/document_qa_pairs.json"

# Generation with custom parameters
result = create(
    "data/parsed/document.lance",
    generation_type="qa",
    num_pairs=50,
    chunk_size=2000,
    temperature=0.8
)
print(result)  # "data/generated/document_qa_pairs.json"

# Batch generation
result = create("./data/parsed/", generation_type="qa", num_pairs=30)
print(result)  # "data/generated/batch_qa_pairs.json"

# Generation in detailed mode
result = create(
    "data/parsed/document.lance",
    generation_type="qa",
    verbose=True
)
print(result)
# Output:
# Generating QA pairs...
# Document split into 8 chunks
# Processing chunk 1/8: Generated 3 pairs
# Processing chunk 2/8: Generated 4 pairs
# ...
# Total pairs generated: 25

# Example of generated results
import json
with open("data/generated/document_qa_pairs.json", "r") as f:
    qa_pairs = json.load(f)
print(qa_pairs[0])
# {
#   "question": "What is the main purpose of synthetic data generation?",
#   "answer": "Synthetic data generation aims to create artificial datasets...",
#   "metadata": {
#     "source_chunk": 1,
#     "confidence": 0.95,
#     "generated_at": "2025-01-01T10:00:00Z"
#   }
# }

# Test verification
assert len(qa_pairs) >= 20
assert all("question" in pair and "answer" in pair for pair in qa_pairs)
```


#### 24. `read_json()` Function - Load Raw Text Content

**Function**: Read a UTF-8 text file into memory prior to content generation.

**Function Signature**:
```python
def read_json(file_path):
    # Read the file
    with open(file_path, 'r', encoding='utf-8') as f:
        document_text = f.read()
    return document_text
```

**Parameters**:
- `file_path` (str | Path): Location of the text file to read.

**Returns**:
- `str`: The file contents as a single string.

**Defined In**: `synthetic_data_kit/core/create.py`.

**Import**:
```python
from synthetic_data_kit.core.create import Read
```


#### 25. `process_file()` Function - Generate Synthetic Content

**Function**: Create QA pairs, summaries, Chain-of-Thought data, multimodal QA, or CoT enhancements for a single source.

**Function Signature**:
```python
def process_file(
    file_path: str,
    output_dir: str,
    config_path: Optional[Path] = None,
    api_base: Optional[str] = None,
    model: Optional[str] = None,
    content_type: str = "qa",
    num_pairs: Optional[int] = None,
    verbose: bool = False,
    provider: Optional[str] = None,
    chunk_size: Optional[int] = None,
    chunk_overlap: Optional[int] = None,
    rolling_summary: Optional[bool] = False,
) -> str:
    """Process a file to generate content"""
```

**Parameters**:
- `file_path` (str): Parsed `.lance`, `.txt`, or conversation JSON file.
- `output_dir` (str): Directory where generated artifacts are written.
- `config_path` (Optional[Path]): Override configuration for prompt templates and thresholds.
- `api_base` (Optional[str]): Provider endpoint override.
- `model` (Optional[str]): Model identifier override.
- `content_type` (str): Generation mode (`qa`, `summary`, `cot`, `multimodal-qa`, `cot-enhance`).
- `num_pairs` (Optional[int]): Target example count; defaults to configuration values per mode.
- `verbose` (bool): Emit detailed processing progress.
- `provider` (Optional[str]): Selected provider (`"vllm"` or `"api-endpoint"`).
- `chunk_size` (Optional[int]): Override chunk length for long documents.
- `chunk_overlap` (Optional[int]): Override chunk overlap for long documents.
- `rolling_summary` (Optional[bool]): When `True`, perform rolling summarisation before QA generation.

**Returns**:
- `str`: Path to the generated artifact (JSON file or dataset directory).

**Defined In**: `synthetic_data_kit/core/create.py`.

**Import**:
```python
from synthetic_data_kit.core.create import process_file
```


The function initialises `LLMClient`, applies overrides to the loaded configuration, routes to the appropriate generator, and writes outputs with informative logging.
### Node 4: Chain of Thought Generation

**Function Description**: Generate chain-of-thought samples containing reasoning steps to help the model learn the step-by-step reasoning process.

**Types of Reasoning**:

- Logical reasoning chains
- Steps to solve mathematical problems
- Analytical thinking processes
- Creative problem-solving

**Input-Output Examples**:

```python
from synthetic_data_kit import create

# Chain-of-thought reasoning generation
result = create("data/parsed/textbook.lance", generation_type="cot")
print(result)  # "data/generated/textbook_cot_examples.json"

# Customize the reasoning complexity
result = create(
    "data/parsed/math_problems.lance",
    generation_type="cot",
    num_pairs=20,
    temperature=0.6
)
print(result)

# Example of generated results
with open("data/generated/textbook_cot_examples.json", "r") as f:
    cot_examples = json.load(f)
print(cot_examples[0])
# {
#   "problem": "How do you calculate compound interest?",
#   "reasoning": [
#     "Step 1: Identify the principal amount (P), interest rate (r), and time period (t)",
#     "Step 2: Use the formula A = P(1 + r/n)^(nt) where n is the compounding frequency",
#     "Step 3: Subtract the principal from the final amount to get the compound interest"
#   ],
#   "answer": "Compound interest = A - P, where A is calculated using the compound interest formula",
#   "metadata": {
#     "reasoning_steps": 3,
#     "difficulty": "intermediate"
#   }
# }

# Test verification
assert all("reasoning" in example for example in cot_examples)
assert all(len(example["reasoning"]) >= 2 for example in cot_examples)
```

### Node 5: Quality Scoring and Filtering

**Function Description**: Use the Llama model to evaluate the quality of the generated data, score and filter it based on multiple dimensions.

**Evaluation Dimensions**:

- Content accuracy
- Language fluency
- Logical consistency
- Educational value

**Input-Output Examples**:

```python
from synthetic_data_kit import curate

# Basic quality screening
result = curate("data/generated/document_qa_pairs.json")
print(result)  # "data/curated/document_qa_pairs_cleaned.json"

# Screening with a custom threshold
result = curate(
    "data/generated/document_qa_pairs.json",
    threshold=8.5,
    batch_size=4
)
print(result)

# Detailed evaluation mode
result = curate(
    "data/generated/document_qa_pairs.json",
    threshold=7.0,
    verbose=True
)
print(result)
# Output:
# Evaluating 50 QA pairs...
# Batch 1/7: 6 pairs passed (avg score: 7.8)
# Batch 2/7: 5 pairs passed (avg score: 8.1)
# ...
# Final: 42/50 pairs passed the quality threshold

# Example of filtered results
with open("data/curated/document_qa_pairs_cleaned.json", "r") as f:
    curated_data = json.load(f)
print(curated_data[0])
# {
#   "question": "What is machine learning?",
#   "answer": "Machine learning is a subset of artificial intelligence...",
#   "quality_score": 8.5,
#   "evaluation": {
#     "accuracy": 9.0,
#     "clarity": 8.5,
#     "completeness": 8.0,
#     "overall": 8.5
#   },
#   "metadata": {
#     "original_index": 3,
#     "curated_at": "2025-01-01T11:00:00Z"
#   }
# }

# Test verification
assert all(item["quality_score"] >= 7.0 for item in curated_data)
assert len(curated_data) < len(qa_pairs)  # Ensure there is a filtering effect
```


#### 26. `curate_qa_pairs()` Function - Filter QA Datasets

**Function**: Evaluate QA pairs with an LLM judge, filter them by rating, and enrich results with metrics and conversations.

**Function Signature**:
```python
def curate_qa_pairs(
    input_path: str,
    output_path: str,
    threshold: Optional[float] = None,
    api_base: Optional[str] = None,
    model: Optional[str] = None,
    config_path: Optional[Path] = None,
    verbose: bool = False,
    provider: Optional[str] = None,
) -> str:
    """Clean and filter QA pairs based on quality ratings"""
```

**Parameters**:
- `input_path` (str): JSON file containing `qa_pairs` (and optionally `summary`).
- `output_path` (str): Destination for the filtered dataset.
- `threshold` (Optional[float]): Minimum rating to retain a pair; defaults to configuration when omitted.
- `api_base` (Optional[str]): Provider endpoint override.
- `model` (Optional[str]): Evaluation model override.
- `config_path` (Optional[Path]): Alternative configuration file.
- `verbose` (bool): Emit detailed progress and debugging output.
- `provider` (Optional[str]): Provider selection forwarded to `LLMClient`.

**Returns**:
- `str`: Path to the curated JSON output containing filtered pairs, conversations, and metrics.

**Defined In**: `synthetic_data_kit/core/curate.py`.

**Import**:
```python
from synthetic_data_kit.core.curate import curate_qa_pairs
```


The function initialises `LLMClient`, splits QA pairs into batches, calls `QAGenerator.rate_qa_pairs()` through chat completions, aggregates metrics, and writes the curated dataset with new `conversations` and `metrics` entries.
### Node 6: Alpaca Format Conversion

**Function Description**: Convert the filtered data into the Alpaca training format, suitable for instruction fine-tuning.

**Format Features**:

- Instruction-input-output structure
- Support for instructions without input
- Metadata retention
- Batch conversion

**Input-Output Examples**:

```python
from synthetic_data_kit import save_as

# Alpaca format conversion
result = save_as(
    "data/curated/document_qa_pairs_cleaned.json",
    format_type="alpaca"
)
print(result)  # "data/final/document_alpaca_format.json"

# Conversion including metadata
result = save_as(
    "data/curated/document_qa_pairs_cleaned.json",
    format_type="alpaca",
    include_metadata=True,
    pretty_json=True
)
print(result)

# HuggingFace dataset format
result = save_as(
    "data/curated/document_qa_pairs_cleaned.json",
    format_type="alpaca",
    storage="hf"
)
print(result)  # HuggingFace dataset path

# Example of conversion results
with open("data/final/document_alpaca_format.json", "r") as f:
    alpaca_data = json.load(f)
print(alpaca_data[0])
# {
#   "instruction": "Answer the following question about machine learning.",
#   "input": "What is machine learning?",
#   "output": "Machine learning is a subset of artificial intelligence that enables computers to learn and improve from experience without being explicitly programmed.",
#   "metadata": {
#     "source": "document_qa_pairs_cleaned.json",
#     "quality_score": 8.5,
#     "converted_at": "2025-01-01T12:00:00Z"
#   }
# }

# Test verification
assert all("instruction" in item and "output" in item for item in alpaca_data)
assert len(alpaca_data) == len(curated_data)
```


#### 27. `convert_format()` Function - Format Conversion Core

**Function**: Convert curated QA data into the requested fine-tuning format and storage medium.

**Function Signature**:
```python
def convert_format(
    input_path: str,
    output_path: str,
    format_type: str,
    config: Optional[Dict[str, Any]] = None,
    storage_format: str = "json",
) -> str:
    """Convert data to different formats"""
```

**Parameters**:
- `input_path` (str): Path to a curated JSON file.
- `output_path` (str): File or directory where converted data will be stored.
- `format_type` (str): Output schema (`jsonl`, `alpaca`, `ft`, `chatml`).
- `config` (Optional[Dict[str, Any]]): Configuration used for defaults.
- `storage_format` (str): Storage backend (`json` or `hf`).

**Returns**:
- `str`: Path to the converted output file or dataset directory.

**Defined In**: `synthetic_data_kit/core/save_as.py`.

**Import**:
```python
from synthetic_data_kit.core.save_as import convert_format
```


#### 28. `to_jsonl()` Function - JSONL Writer

**Function**: Serialize QA pairs as newline-delimited JSON objects.

**Function Signature**:
```python
def to_jsonl(data: List[Dict[str, Any]], output_path: str) -> str:
    """Convert data to JSONL format and save to a file"""
```

**Parameters**:
- `data` (List[Dict[str, Any]]): Iterable of records to serialize.
- `output_path` (str): Destination JSONL file.

**Returns**:
- `str`: Path to the written JSONL file.

**Defined In**: `synthetic_data_kit/utils/format_converter.py`.

**Import**:
```python
from synthetic_data_kit.utils.format_converter import to_jsonl
```


#### 29. `to_alpaca()` Function - Alpaca Format Builder

**Function**: Transform QA pairs into the Alpaca instruction-following schema.

**Function Signature**:
```python
def to_alpaca(qa_pairs: List[Dict[str, str]], output_path: str) -> str:
    """Convert QA pairs to Alpaca format and save"""
```

**Parameters**:
- `qa_pairs` (List[Dict[str, str]]): Question-answer dictionaries.
- `output_path` (str): Destination JSON file containing Alpaca records.

**Returns**:
- `str`: Path to the written Alpaca JSON file.

**Defined In**: `synthetic_data_kit/utils/format_converter.py`.

**Import**:
```python
from synthetic_data_kit.utils.format_converter import to_alpaca
```


#### 30. `to_hf_dataset()` Function - Hugging Face Dataset Export

**Function**: Persist QA pairs as an Arrow dataset compatible with `datasets.load_from_disk`.

**Function Signature**:
```python
def to_hf_dataset(qa_pairs: List[Dict[str, str]], output_path: str) -> str:
    """Convert QA pairs to a Hugging Face dataset and save in Arrow format."""
```

**Parameters**:
- `qa_pairs` (List[Dict[str, str]]): Question-answer items to export.
- `output_path` (str): Directory where the dataset will be stored.

**Returns**:
- `str`: Path to the saved dataset directory.

**Defined In**: `synthetic_data_kit/utils/format_converter.py`.

**Import**:
```python
from synthetic_data_kit.utils.format_converter import to_hf_dataset
```

### Node 7: OpenAI Fine-tuning Format Conversion

**Function Description**: Convert to a format compatible with the OpenAI fine-tuning API, supporting chat and completion modes.

**Format Features**:

- Messages format for chat mode
- Prompt-completion format for completion mode
- Support for system messages
- Token length optimization

**Input-Output Examples**:

```python
from synthetic_data_kit import save_as

# OpenAI fine-tuning format conversion
result = save_as(
    "data/curated/document_qa_pairs_cleaned.json",
    format_type="ft"
)
print(result)  # "data/final/document_openai_ft.jsonl"

# Chat format conversion
result = save_as(
    "data/curated/cot_examples_cleaned.json",
    format_type="ft",
    config={"chat_format": True}
)
print(result)

# Example of conversion results (JSONL format)
with open("data/final/document_openai_ft.jsonl", "r") as f:
    lines = f.readlines()
    ft_example = json.loads(lines[0])
print(ft_example)
# {
#   "messages": [
#     {"role": "system", "content": "You are a helpful AI assistant."},
#     {"role": "user", "content": "What is machine learning?"},
#     {"role": "assistant", "content": "Machine learning is a subset of artificial intelligence..."}
#   ]
# }

# Example of completion mode
completion_example = json.loads(lines[1])
print(completion_example)
# {
#   "prompt": "Question: What is deep learning?\nAnswer:",
#   "completion": " Deep learning is a subset of machine learning that uses artificial neural networks..."
# }

# Test verification
assert all("messages" in json.loads(line) or "prompt" in json.loads(line) for line in lines)
assert len(lines) == len(curated_data)
```


#### 31. `to_fine_tuning()` Function - OpenAI Format Writer

**Function**: Produce OpenAI fine-tuning JSON records with system, user, and assistant messages.

**Function Signature**:
```python
def to_fine_tuning(qa_pairs: List[Dict[str, str]], output_path: str) -> str:
    """Convert QA pairs to fine-tuning format and save"""
```

**Parameters**:
- `qa_pairs` (List[Dict[str, str]]): Question-answer entries to convert.
- `output_path` (str): Target JSON file for OpenAI fine-tuning messages.

**Returns**:
- `str`: Path to the fine-tuning JSON file.

**Defined In**: `synthetic_data_kit/utils/format_converter.py`.

**Import**:
```python
from synthetic_data_kit.utils.format_converter import to_fine_tuning
```

### Node 8: ChatML Format Conversion

**Function Description**: Convert to the ChatML dialogue format, suitable for training conversational AI.

**Format Features**:

- Structured dialogue markers
- Clear role division
- Support for multi-turn conversations
- Special token handling

**Input-Output Examples**:

```python
from synthetic_data_kit import save_as

# ChatML format conversion
result = save_as(
    "data/curated/qa_pairs_cleaned.json",
    format_type="chatml"
)
print(result)  # "data/final/document_chatml_format.json"

# Multi-turn dialogue format
result = save_as(
    "data/curated/conversation_data.json",
    format_type="chatml",
    config={"multi_turn": True}
)
print(result)

# Example of conversion results
with open("data/final/document_chatml_format.json", "r") as f:
    chatml_data = json.load(f)
print(chatml_data[0])
# {
#   "text": "<|im_start|>system\nYou are a helpful AI assistant.<|im_end|>\n<|im_start|>user\nWhat is machine learning?<|im_end|>\n<|im_start|>assistant\nMachine learning is a subset of artificial intelligence that enables computers to learn from data.<|im_end|>",
#   "metadata": {
#     "format": "chatml",
#     "tokens": 45,
#     "turns": 1
#   }
# }

# Example of multi-turn conversation
print(chatml_data[1])
# {
#   "text": "<|im_start|>system\nYou are an expert in AI.<|im_end|>\n<|im_start|>user\nExplain neural networks.<|im_end|>\n<|im_start|>assistant\nNeural networks are computing systems inspired by biological neural networks.<|im_end|>\n<|im_start|>user\nHow do they learn?<|im_end|>\n<|im_start|>assistant\nThey learn through a process called backpropagation, which adjusts weights based on errors.<|im_end|>",
#   "metadata": {
#     "format": "chatml",
#     "tokens": 78,
#     "turns": 2
#   }
# }

# Test verification
assert all("<|im_start|>" in item["text"] and "<|im_end|>" in item["text"] for item in chatml_data)
assert all("assistant" in item["text"] for item in chatml_data)
```


#### 32. `to_chatml()` Function - ChatML Writer

**Function**: Serialize QA pairs as ChatML messages for multimodal chat fine-tuning.

**Function Signature**:
```python
def to_chatml(qa_pairs: List[Dict[str, str]], output_path: str) -> str:
    """Convert QA pairs to ChatML format and save as JSONL"""
```

**Parameters**:
- `qa_pairs` (List[Dict[str, str]]): Question-answer pairs.
- `output_path` (str): JSONL file that records ChatML message arrays.

**Returns**:
- `str`: Path to the ChatML JSONL file.

**Defined In**: `synthetic_data_kit/utils/format_converter.py`.

**Import**:
```python
from synthetic_data_kit.utils.format_converter import to_chatml
```

### Node 9: Batch Processing and Concurrency Control

**Function Description**: Support batch processing of large-scale documents, with concurrency control and progress monitoring functions.

**Concurrency Features**:

- Asynchronous document processing
- API rate limiting control
- Memory usage optimization
- Error recovery mechanism

**Input-Output Examples**:

```python
from synthetic_data_kit import ingest, create, curate, save_as
from synthetic_data_kit.utils.batch import BatchProcessor

# Batch document processing (through CLI commands)
# synthetic-data-kit ingest ./documents/
# synthetic-data-kit create ./data/parsed/ --type qa
# synthetic-data-kit curate ./data/generated/
# synthetic-data-kit save-as ./data/curated/ --format alpaca

# Batch ingestion (through CLI commands)
# synthetic-data-kit ingest ./documents/
print(results)
# [
#   "data/batch_parsed/doc1.lance",
#   "data/batch_parsed/doc2.lance", 
#   "data/batch_parsed/doc3.lance"
# ]

# Batch generation (through CLI commands)
# synthetic-data-kit create ./data/parsed/ --type qa --num-pairs 20
print(batch_results)
# Output:
# Progress: 25%
# Progress: 50%
# Progress: 75%
# Progress: 100%
# "data/generated/batch_qa_pairs.json"

# Example of large-scale processing (through CLI commands)
# synthetic-data-kit ingest ./large_document_collection/
# synthetic-data-kit create ./data/parsed/ --type qa --num-pairs 50
# synthetic-data-kit curate ./data/generated/ --threshold 8.0
# synthetic-data-kit save-as ./data/curated/ --format alpaca
print(large_batch_results)
# {
#   "processed": 150,
#   "failed": 5,
#   "output": "data/final/large_batch_alpaca.json",
#   "processing_time": 1200.5
# }

# Error handling and retry (through CLI commands)
# synthetic-data-kit curate ./data/generated/ --threshold 8.0
# Re-run the failed command
print(retry_results)

# Test verification
# Check if the output files exist
assert os.path.exists("data/parsed/")
assert os.path.exists("data/generated/")
assert os.path.exists("data/curated/")
assert os.path.exists("data/final/")
```


#### 33. `is_directory()` Function - Path Inspection

**Function**: Test whether a given path points to a directory before invoking directory workflows.

**Function Signature**:
```python
def is_directory(path: str) -> bool:
    """Check if path is a directory"""
```

**Parameters**:
- `path` (str): File system path to inspect.

**Returns**:
- `bool`: `True` if the path exists and is a directory, otherwise `False`.

**Defined In**: `synthetic_data_kit/utils/directory_processor.py`.

**Import**:
```python
from synthetic_data_kit.utils.directory_processor import is_directory
```


#### 34. `get_supported_files()` Function - Directory Listing

**Function**: Collect files with permitted extensions for a given command.

**Function Signature**:
```python
def get_supported_files(directory: str, extensions: List[str]) -> List[str]:
    """Get all files with supported extensions in directory (non-recursive)"""
```

**Parameters**:
- `directory` (str): Directory to scan.
- `extensions` (List[str]): Lower-case extensions considered valid.

**Returns**:
- `List[str]`: Sorted list of matching file paths.

**Defined In**: `synthetic_data_kit/utils/directory_processor.py`.

**Import**:
```python
from synthetic_data_kit.utils.directory_processor import get_supported_files
```


#### 35. `process_directory_ingest()` Function - Batch Ingestion

**Function**: Ingest every supported file inside a directory, reporting successes and failures.

**Function Signature**:
```python
def process_directory_ingest(
    directory: str,
    output_dir: Optional[str] = None,
    config: Optional[Dict[str, Any]] = None,
    verbose: bool = False,
    multimodal: bool = False,
) -> Dict[str, Any]:
    """Process all supported files in directory for ingestion"""
```

**Returns**:
- `Dict[str, Any]`: Summary containing `total_files`, `successful`, `failed`, `results`, and `errors`.

**Defined In**: `synthetic_data_kit/utils/directory_processor.py`.

**Import**:
```python
from synthetic_data_kit.utils.directory_processor import process_directory_ingest
```


#### 36. `get_directory_stats()` Function - Directory Summary

**Function**: Produce a preview report describing supported and unsupported files in a directory.

**Function Signature**:
```python
def get_directory_stats(directory: str, extensions: List[str]) -> Dict[str, Any]:
```

**Returns**:
- `Dict[str, Any]`: Counts of total, supported, unsupported files and a list of candidate filenames.

**Defined In**: `synthetic_data_kit/utils/directory_processor.py`.

**Import**:
```python
from synthetic_data_kit.utils.directory_processor import get_directory_stats
```


#### 37. `process_directory_create()` Function - Batch Generation

**Function**: Generate content for every supported file in a directory, respecting provider settings and chunk overrides.

**Function Signature**:
```python
def process_directory_create(
    directory: str,
    output_dir: Optional[str] = None,
    config_path: Optional[Path] = None,
    api_base: Optional[str] = None,
    model: Optional[str] = None,
    content_type: str = "qa",
    num_pairs: Optional[int] = None,
    verbose: bool = False,
    provider: Optional[str] = None,
    chunk_size: Optional[int] = None,
    chunk_overlap: Optional[int] = None,
) -> Dict[str, Any]:
    """Process directory for content generation"""
```

**Returns**:
- `Dict[str, Any]`: Aggregated success, failure, and per-file result metadata.

**Defined In**: `synthetic_data_kit/utils/directory_processor.py`.

**Import**:
```python
from synthetic_data_kit.utils.directory_processor import process_directory_create
```


#### 38. `process_directory_curate()` Function - Batch Curation

**Function**: Apply QA scoring to every JSON file in a directory.

**Function Signature**:
```python
def process_directory_curate(
    directory: str,
    output_dir: Optional[str] = None,
    threshold: Optional[float] = None,
    api_base: Optional[str] = None,
    model: Optional[str] = None,
    config_path: Optional[Path] = None,
    verbose: bool = False,
    provider: Optional[str] = None,
) -> Dict[str, Any]:
    """Process directory for QA curation"""
```

**Returns**:
- `Dict[str, Any]`: Summary including `results` for each curated file and any errors encountered.

**Defined In**: `synthetic_data_kit/utils/directory_processor.py`.

**Import**:
```python
from synthetic_data_kit.utils.directory_processor import process_directory_curate
```


#### 39. `process_directory_save_as()` Function - Batch Format Conversion

**Function**: Convert curated datasets in a directory into the requested formats, optionally exporting Hugging Face datasets.

**Function Signature**:
```python
def process_directory_save_as(
    directory: str,
    output_dir: Optional[str] = None,
    format: str = "jsonl",
    storage_format: str = "json",
    config: Optional[Dict[str, Any]] = None,
    verbose: bool = False,
) -> Dict[str, Any]:
    """Process all supported files in directory for format conversion"""
```

**Returns**:
- `Dict[str, Any]`: Batch conversion summary with per-file output details.

**Defined In**: `synthetic_data_kit/utils/directory_processor.py`.

**Import**:
```python
from synthetic_data_kit.utils.directory_processor import process_directory_save_as
```


#### 40. `INGEST_EXTENSIONS` Constant - Supported Ingest Formats

**Constant**: `['.pdf', '.html', '.htm', '.docx', '.pptx', '.txt']`

Defines the extension allowlist for directory ingestion workflows.

#### 41. `CREATE_EXTENSIONS` Constant - Supported Generation Inputs

**Constant**: `['.txt', '.lance']`

Enumerates file types processed by directory generation.

#### 42. `CURATE_EXTENSIONS` Constant - Supported Curation Inputs

**Constant**: `['.json']`

Specifies JSON files eligible for batch curation.

#### 43. `SAVE_AS_EXTENSIONS` Constant - Supported Conversion Inputs

**Constant**: `['.json']`

Indicates curated JSON files that can be converted into downstream formats.

(All constants are defined in `synthetic_data_kit/utils/directory_processor.py`.)

#### 44. `create_lance_dataset()` Function - Lance Writer

**Function**: Persist parsed records as a Lance dataset with an optional schema.

**Function Signature**:
```python
def create_lance_dataset(
    data: List[Dict[str, Any]],
    output_path: str,
    schema: Optional[pa.Schema] = None,
) -> None:
    """Create a Lance dataset from a list of dictionaries."""
```

**Parameters**:
- `data` (List[Dict[str, Any]]): Rows to store; each dictionary becomes a Lance record.
- `output_path` (str): Destination dataset directory.
- `schema` (Optional[pa.Schema]): Explicit schema; inferred when omitted.

**Returns**:
- `None`: Writes the dataset to disk.

**Defined In**: `synthetic_data_kit/utils/lance_utils.py`.

**Import**:
```python
from synthetic_data_kit.utils.lance_utils import create_lance_dataset
```


#### 45. `load_lance_dataset()` Function - Lance Reader

**Function**: Load an on-disk Lance dataset for downstream consumption.

**Function Signature**:
```python
def load_lance_dataset(dataset_path: str):
    """Load a Lance dataset."""
```

**Parameters**:
- `dataset_path` (str): Path to the Lance dataset directory.

**Returns**:
- `lance.dataset.Dataset` | `None`: A Lance dataset object when the path exists, otherwise `None`.

**Defined In**: `synthetic_data_kit/utils/lance_utils.py`.

**Import**:
```python
from synthetic_data_kit.utils.lance_utils import load_lance_dataset
```

### Node 10: Multimodal Data Processing

**Function Description**: Process multimodal documents containing text and images, and generate visual question-answer pairs and multimodal training data.

**Multimodal Features**:

- Image content description
- Visual Q&A generation
- Image-text association analysis
- Multimodal format output

**Input-Output Examples**:

```python
from synthetic_data_kit import ingest, create

# Multimodal document ingestion
result = ingest("presentation.pptx", multimodal=True)
print(result)  # "data/parsed/presentation.lance"

# Check the multimodal data structure
import pyarrow as pa
dataset = pa.dataset.dataset("data/parsed/presentation.lance")
schema = dataset.schema
print(schema)
# text: string
# image: binary

# Multimodal Q&A generation
multimodal_result = create(
    "data/parsed/presentation.lance",
    generation_type="multimodal-qa",
    num_pairs=15
)
print(multimodal_result)  # "data/generated/presentation_multimodal_qa.json"

# Example of multimodal generation results
with open("data/generated/presentation_multimodal_qa.json", "r") as f:
    multimodal_qa = json.load(f)
print(multimodal_qa[0])
# {
#   "question": "What does the chart in slide 3 show about quarterly revenue?",
#   "answer": "The chart shows a 15% increase in quarterly revenue from Q1 to Q3, with the highest growth in Q2.",
#   "metadata": {
#     "slide_number": 3,
#     "question_type": "visual_analysis"
#   }
# }

# Visual description generation
visual_descriptions = create(
    "data/parsed/presentation.lance",
    generation_type="visual-description",
    config={"detail_level": "high"}
)
print(visual_descriptions)

# Test verification
assert "question" in multimodal_qa[0]
assert "answer" in multimodal_qa[0]
assert len(multimodal_qa) >= 10
```


#### 46. FullFinetuneRecipeDistributed Class - Distributed Fine-tuning Recipe

**Function**: Provide a Torchtune recipe for full fine-tuning of transformer models with FSDP, activation checkpointing, and dataset packing support.

**Class Definition**:
```python
class FullFinetuneRecipeDistributed(FTRecipeInterface):
    """Full finetuning recipe for dense transformer-based LLMs such as Llama2."""
```

###### 1. `__init__(self, cfg)`
Store configuration and initialise recipe state placeholders.

###### 2. `_update_recipe_state(self, ckpt_dict)`
Merge checkpoint metadata into the internal recipe state when resuming training.

###### 3. `setup(self, cfg)`
Configure model, optimizer, scheduler, data pipeline, profiler, and checkpoint hooks based on the provided `DictConfig`.

###### 4. `_setup_lr_scheduler(...)`
Build the learning-rate scheduler with warmup and resume support from checkpoint state.

###### 5. `_setup_profiler(self, cfg_profiler)`
Initialise PyTorch profiler instrumentation when enabled in the configuration.

###### 6. `_setup_model(...)`
Instantiate the model with FSDP, activation checkpointing/offloading, CPU offload, and optional sharded layers.

###### 7. `_setup_optimizer(...)`
Create the optimizer (optimizer-in-backward or standard) and restore optimizer state when resuming.

###### 8. `_setup_data(self, cfg_dataset, shuffle, batch_size, collate_fn)`
Construct the dataloader and collate function, handling packed datasets and shuffle control.

###### 9. `train(self)`
Execute the training loop, tracking metrics, saving checkpoints, and logging progress.

###### 10. `cleanup(self)`
Release resources such as profilers and distributed processes at the end of training.

**Defined In**: `synthetic-data-kit/use-cases/adding_reasoning_to_llama_3/tt_configs/fft.py`.

**Import**:
```python
import sys
from pathlib import Path

sys.path.append(str(Path('synthetic-data-kit/use-cases/adding_reasoning_to_llama_3/tt_configs')))
from fft import cleanup
```


#### 47. `recipe_main()` Function - Recipe Entry Point

**Function**: Initialise logging, build the recipe, run setup, training, and cleanup steps.

**Function Signature**:
```python
def recipe_main(cfg: DictConfig) -> None:
    """Entry point for the recipe."""
```

**Parameters**:
- `cfg` (DictConfig): Torchtune configuration composed from YAML files and CLI overrides.

**Returns**:
- `None`: Executes the full training lifecycle.

**Defined In**: `synthetic-data-kit/use-cases/adding_reasoning_to_llama_3/tt_configs/fft.py`.

**Import**:
```python
import sys
from pathlib import Path

sys.path.append(str(Path('synthetic-data-kit/use-cases/adding_reasoning_to_llama_3/tt_configs')))
from fft import recipe_main
```


#### 48. ToolCallMessages Class - Conversation Transform

**Function**: Convert chain-of-thought conversation samples into Torchtune `Message` objects with tool-call handling.

**Class Definition**:
```python
class ToolCallMessages(Transform):
    def __init__(self, train_on_input=False):
        ...
```

###### 1. `__init__(self, train_on_input=False)`
Configure role mapping and whether user turns should be masked during training.

###### 2. `__call__(self, sample)`
Iterate conversation messages, create `Message` objects with appropriate roles, masking, and end-of-turn markers, returning a dictionary with a `messages` list.

**Defined In**: `synthetic-data-kit/use-cases/adding_reasoning_to_llama_3/tt_configs/toolcall.py`.

**Import**:
```python
import sys
from pathlib import Path

sys.path.append(str(Path('synthetic-data-kit/use-cases/adding_reasoning_to_llama_3/tt_configs')))
from toolcall import __call__
```


#### 49. `custom_dataset()` Function - Torchtune Dataset Builder

**Function**: Assemble a Torchtune `SFTDataset` (optionally packed) using the `ToolCallMessages` transform and a tokenizer.

**Function Signature**:
```python
def custom_dataset(
    tokenizer,
    train_on_input=False,
    packed: bool = False,
    **load_dataset_kwargs,
) -> SFTDataset:
```

**Parameters**:
- `tokenizer` (ModelTokenizer | Transform): Tokenizer or transform applied to messages.
- `train_on_input` (bool): Whether to keep user tokens in the loss.
- `packed` (bool): Enable sequence packing via `PackedDataset`.
- `**load_dataset_kwargs`: Additional arguments forwarded to `SFTDataset` loader.

**Returns**:
- `SFTDataset` | `PackedDataset`: Dataset ready for fine-tuning.

**Defined In**: `synthetic-data-kit/use-cases/adding_reasoning_to_llama_3/tt_configs/toolcall.py`.

**Import**:
```python
import sys
from pathlib import Path

sys.path.append(str(Path('synthetic-data-kit/use-cases/adding_reasoning_to_llama_3/tt_configs')))
from toolcall import custom_dataset
```

### Node 11: Configuration Management and Customization

**Function Description**: A flexible configuration system supporting multi-level configuration overrides and custom templates.

**Configuration Features**:

- YAML configuration files
- Support for environment variables
- Command-line parameter overrides
- Configuration verification

**Input-Output Examples**:

```python
from synthetic_data_kit.utils.config import ConfigManager, load_config

# Basic configuration loading
config = load_config("configs/config.yaml")
print(config["generation"]["temperature"])  # 0.7

# Custom configuration
custom_config = {
    "generation": {
        "temperature": 0.9,
        "num_pairs": 100,
        "chunk_size": 6000
    },
    "curate": {
        "threshold": 8.5
    }
}

# Configuration management usage
config = load_config("configs/config.yaml")
config.update(custom_config)

# Get a specific configuration section
vllm_config = get_vllm_config(config)
print(vllm_config)
# {
#   "api_base": "http://localhost:8000/v1",
#   "model": "meta-llama/Llama-3.3-70B-Instruct",
#   "max_retries": 3,
#   "retry_delay": 1.0
# }

# Environment variable override
import os
os.environ["SYNTHETIC_DATA_KIT_TEMPERATURE"] = "0.8"
os.environ["SYNTHETIC_DATA_KIT_THRESHOLD"] = "8.0"

config_with_env = config
print(config_with_env["generation"]["temperature"])  # 0.8

# Configuration verification
validation_result = {"valid": True, "errors": [], "warnings": []}
print(validation_result)
# {
#   "valid": True,
#   "errors": [],
#   "warnings": ["API endpoint not reachable"]
# }

# Dynamic configuration update
config["generation"]["temperature"] = 0.6
config["curate"]["batch_size"] = 16

updated_config = config
print(updated_config["generation"]["temperature"])  # 0.6

# Configuration template creation
template_config = {
    "generation": {"temperature": 0.5, "num_pairs": 50},
    "curate": {"threshold": 9.0},
    "format": {"type": "alpaca", "include_metadata": True}
}
# Save the configuration template
import yaml
with open("configs/high_quality_qa.yaml", "w") as f:
    yaml.dump(template_config, f)

# Test verification
assert config["generation"]["temperature"] == 0.6
assert validation_result["valid"] == True
assert os.path.exists("configs/high_quality_qa.yaml")
```

### Node 12: Command-line Tool Integration

**Function Description**: A complete command-line interface supporting all core functions and advanced options.

**CLI Features**:

- Built with the Typer framework
- Rich output format
- Progress bar display
- Interactive configuration

**Input-Output Examples**:

```bash
# System status check
synthetic-data-kit system-check
# Environment variable check:
# API_ENDPOINT_KEY: Present
# API endpoint access: Connected
# Configuration: Valid

# Document ingestion
synthetic-data-kit ingest document.pdf --output-dir custom_output/ --multimodal
# Processing: document.pdf
# Detected format: PDF
# Pages processed: 25
# Saved to: custom_output/document.lance

# Batch ingestion
synthetic-data-kit ingest ./documents/ --preview
# Directory: ./documents/
# Total files: 42
# Supported files: 38
# Extensions: .pdf (20), .docx (12), .txt (6)
# Files: report1.pdf, analysis.docx, notes.txt...

# Content generation
synthetic-data-kit create data/parsed/document.lance --type qa --num-pairs 50 --verbose
# Model: meta-llama/Llama-3.3-70B-Instruct
# Generation type: QA pairs
# Document chunks: 12
# Batch size: 32
# Progress: 100% (50/50 pairs)
# Saved to: data/generated/document_qa_pairs.json

# Quality screening
synthetic-data-kit curate data/generated/document_qa_pairs.json --threshold 8.0 --verbose
# Evaluating: 50 QA pairs
# Batch 1/7: 6/7 passed (avg: 8.2)
# Batch 2/7: 5/7 passed (avg: 7.9)
# Final: 42/50 pairs passed
# Saved to: data/curated/document_qa_pairs_cleaned.json

# Format conversion
synthetic-data-kit save-as data/curated/document_qa_pairs_cleaned.json --format alpaca --storage hf
# Converting to: Alpaca format
# Storage: HuggingFace Dataset
# Dataset name: synthetic-qa-dataset
# Upload complete: https://huggingface.co/datasets/user/synthetic-qa-dataset

# Complete pipeline
synthetic-data-kit ingest document.pdf
synthetic-data-kit create data/parsed/document.lance --type qa --num-pairs 30
synthetic-data-kit curate data/generated/document_qa_pairs.json --threshold 8.0
synthetic-data-kit save-as data/curated/document_qa_pairs_cleaned.json --format alpaca
# Pipeline complete: data/final/document_alpaca.json
```

**Python CLI API Call Example**:

```python
from synthetic_data_kit.cli import CLI
import typer

# Programmatic CLI call
from synthetic_data_kit.core.ingest import process_file as ingest
from synthetic_data_kit.core.create import process_file as create

# Directly call the core functions
result = ingest(
    file_path="document.pdf",
    output_dir="data/parsed",
    multimodal=True
)
print(result)

# Pipeline execution
parsed = ingest("document.pdf")
generated = create(parsed, content_type="qa", num_pairs=30)
curated = curate(generated, threshold=8.0)
final = save_as(curated, "data/final/document_alpaca.json", format_type="alpaca")
assert os.path.exists(parsed)
assert os.path.exists(generated)
assert os.path.exists(curated)
assert os.path.exists(final)
```


#### 62. `server()` Command - Launch Web Interface

**Function**: Start the Flask-based web interface exposing ingestion, generation, and curation workflows.

**Function Signature**:
```python
def server(
    host: str = typer.Option(
        "127.0.0.1", "--host", help="Host address to bind the server to"
    ),
    port: int = typer.Option(
        5000, "--port", "-p", help="Port to run the server on"
    ),
    debug: bool = typer.Option(
        False, "--debug", "-d", help="Run the server in debug mode"
    ),
):
    """
    Start a web interface for the Synthetic Data Kit.
    """
```

**Parameters**:
- `host` (str): Host address for the Flask server.
- `port` (int): Port number exposed to clients.
- `debug` (bool): Enable Flask debug mode.

**Returns**:
- `None`: Runs the server until interrupted.

**Defined In**: `synthetic_data_kit/cli.py`.

**Import**:
```python
from synthetic_data_kit.cli import server
```


#### 63. CreateForm Class - Content Generation Form

**Function**: Collect inputs for triggering content generation through the web interface.

**Fields**:
- `input_file`: Text field for source file path.
- `content_type`: Select field (`qa`, `summary`, `cot`, `cot-enhance`).
- `num_pairs`: Integer field controlling example count.
- `model`: Optional model name.
- `api_base`: Optional API base URL.
- `submit`: Submit button.

**Defined In**: `synthetic_data_kit/server/app.py`.

**Import**:
```python
from synthetic_data_kit.server.app import CreateForm
```


#### 64. IngestForm Class - Document Ingestion Form

**Function**: Capture ingestion parameters from the web UI.

**Fields**:
- `input_type`: Select field (`file`, `url`, `path`).
- `upload_file`: File upload for documents.
- `input_path`: Text field for local path or URL.
- `output_name`: Optional output name.
- `submit`: Submit button.

**Defined In**: `synthetic_data_kit/server/app.py`.

**Import**:
```python
from synthetic_data_kit.server.app import IngestForm
```


#### 65. CurateForm Class - QA Curation Form

**Function**: Gather inputs required to curate QA pairs via the web interface.

**Fields**:
- `input_file`: JSON path input.
- `num_pairs`: Number of QA pairs to keep (0 meaning auto).
- `model`: Optional model name.
- `api_base`: Optional API base URL.
- `submit`: Submit button.

**Defined In**: `synthetic_data_kit/server/app.py`.

**Import**:
```python
from synthetic_data_kit.server.app import CurateForm
```


#### 66. UploadForm Class - File Upload Form

**Function**: Provide a simple file upload mechanism for the server.

**Fields**:
- `file`: File field (required).
- `submit`: Submit button.

**Defined In**: `synthetic_data_kit/server/app.py`.

**Import**:
```python
from synthetic_data_kit.server.app import UploadForm
```


#### 67. `index()` Function - Web Index Route

**Function**: Render the home page showing provider information.

**Function Signature**:
```python
def index() -> str:
    """Main index page"""
```

**Returns**:
- `str`: Rendered HTML response.

**Defined In**: `synthetic_data_kit/server/app.py`.

**Import**:
```python
from synthetic_data_kit.server.app import index
```


#### 68. `create()` Function - Web Create Route

**Function**: Handle GET/POST requests for generating content via forms.

**Function Signature**:
```python
def create():
    """Create content from text"""
```

**Returns**:
- `Response`: Rendered template or redirect after successful generation.

**Defined In**: `synthetic_data_kit/server/app.py`.

**Import**:
```python
from synthetic_data_kit.server.app import create
```


#### 69. `curate()` Function - Web Curate Route

**Function**: Handle QA curation requests through the web UI.

**Function Signature**:
```python
def curate():
    """Curate QA pairs"""
```

**Returns**:
- `Response`: Rendered template or redirect after curation.

**Defined In**: `synthetic_data_kit/server/app.py`.

**Import**:
```python
from synthetic_data_kit.server.app import curate
```


#### 70. `files()` Function - Web File Browser

**Function**: List generated files available on the server.

**Function Signature**:
```python
def files():
    """List generated files"""
```

**Returns**:
- `Response`: Rendered file listing template.

**Defined In**: `synthetic_data_kit/server/app.py`.

**Import**:
```python
from synthetic_data_kit.server.app import files
```


#### 71. `view_file()` Function - File Viewer Route

**Function**: Display the contents of a stored file.

**Function Signature**:
```python
def view_file(file_path):
    """View a file"""
```

**Parameters**:
- `file_path` (str): Relative path under the data directory.

**Returns**:
- `Response`: Rendered view or 404 if not found.

**Defined In**: `synthetic_data_kit/server/app.py`.

**Import**:
```python
from synthetic_data_kit.server.app import view_file
```


#### 72. `ingest()` Function - Web Ingestion Route

**Function**: Process file uploads or paths to ingest documents via the web UI.

**Function Signature**:
```python
def ingest():
    """Ingest documents"""
```

**Returns**:
- `Response`: Redirect or rendered template after ingestion.

**Defined In**: `synthetic_data_kit/server/app.py`.

**Import**:
```python
from synthetic_data_kit.server.app import ingest
```


#### 73. `upload()` Function - File Upload Route

**Function**: Handle file uploads into the default output directory.

**Function Signature**:
```python
def upload():
    """Upload files"""
```

**Returns**:
- `Response`: Rendered template or redirect after upload.

**Defined In**: `synthetic_data_kit/server/app.py`.

**Import**:
```python
from synthetic_data_kit.server.app import upload
```


#### 74. `qa_json()` Function - QA JSON API

**Function**: Serve curated QA files as JSON for the front-end viewer.

**Function Signature**:
```python
def qa_json(file_path):
    """Return QA pairs as JSON for the JSON viewer"""
```

**Parameters**:
- `file_path` (str): Relative path under the data directory.

**Returns**:
- `Response`: JSON response or error status.

**Defined In**: `synthetic_data_kit/server/app.py`.

**Import**:
```python
from synthetic_data_kit.server.app import qa_json
```


#### 75. `edit_item()` Function - JSON Item Editor

**Function**: Update a specific item within curated JSON files.

**Function Signature**:
```python
def edit_item(file_path):
    """Edit an item in a JSON file"""
```

**Parameters**:
- `file_path` (str): Relative JSON path.

**Returns**:
- `Response`: JSON status message indicating success or failure.

**Defined In**: `synthetic_data_kit/server/app.py`.

**Import**:
```python
from synthetic_data_kit.server.app import edit_item
```


#### 76. `delete_item()` Function - JSON Item Deletion

**Function**: Remove an item from curated JSON files.

**Function Signature**:
```python
def delete_item(file_path):
    """Delete an item from a JSON file"""
```

**Parameters**:
- `file_path` (str): Relative JSON path.

**Returns**:
- `Response`: JSON status message indicating success or failure.

**Defined In**: `synthetic_data_kit/server/app.py`.

**Import**:
```python
from synthetic_data_kit.server.app import delete_item
```


#### 77. `run_server()` Function - Launch Flask Application

**Function**: Start the Flask development server with the configured host, port, and debug mode.

**Function Signature**:
```python
def run_server(host="127.0.0.1", port=5000, debug=False):
    """Run the Flask server"""
```

**Parameters**:
- `host` (str): Host address to bind.
- `port` (int): Port number.
- `debug` (bool): Enable Flask debug mode.

**Returns**:
- `None`: Blocks while the server is running.

**Defined In**: `synthetic_data_kit/server/app.py`.

**Import**:
```python
from synthetic_data_kit.server.app import run_server
```


#### 78. `DEFAULT_DATA_DIR` Constant - Data Directory Root

**Constant**: `Path(__file__).parents[2] / "data"`

Represents the root data directory used by the Flask server.

#### 79. `DEFAULT_OUTPUT_DIR` Constant - Parsed Output Directory

**Constant**: `DEFAULT_DATA_DIR / "output"`

Points to the directory where ingested outputs are stored; created on startup.

#### 80. `DEFAULT_GENERATED_DIR` Constant - Generated Content Directory

**Constant**: `DEFAULT_DATA_DIR / "generated"`

Location used for generated QA pairs and other artifacts; ensured to exist on startup.

(All constants are defined in `synthetic_data_kit/server/app.py`.)

#### 81. `ORIGINAL_CONFIG_PATH` Constant - Repository Configuration

**Constant**: Absolute path to `configs/config.yaml` in the repository root. Used when loading configuration from source tree.

#### 82. `PACKAGE_CONFIG_PATH` Constant - Installed Package Configuration

**Constant**: Absolute path to `config.yaml` bundled within the installed package; preferred default when running from site-packages.

#### 83. `DEFAULT_CONFIG_PATH` Constant - Default Configuration Fallback

**Constant**: Points to `PACKAGE_CONFIG_PATH` and acts as the ultimate fallback when other config files are missing.

(All three constants are defined in `synthetic_data_kit/utils/config.py`.)

