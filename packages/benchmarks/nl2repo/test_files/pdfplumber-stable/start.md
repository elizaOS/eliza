## Project Introduction and Objectives

pdfplumber-stable is a Python library for extracting structured information from PDF documents. It can parse objects such as text, tables, images, and annotations in PDF files, and supports detailed page structure analysis, table detection, and visual debugging. This tool is suitable for scenarios such as automated data extraction, document structure analysis, and batch table processing, aiming to provide developers and data analysts with efficient and robust PDF parsing and analysis capabilities.

## Natural Language Instruction (Prompt)

Please create a Python project named pdfplumber-stable to implement a PDF structured information extraction library. The project should include the following functions:

1. **Opening and Loading PDF Files**: Support opening PDF files through multiple methods such as file paths, file objects, and byte streams. Support password protection, automatic repair, and page selection.
2. **Extracting PDF Metadata**: Retrieve metadata information of the PDF, such as creation time, modification time, author, and production tool.
3. **Page Operations and Attribute Retrieval**: Support retrieving basic attributes of the PDF, such as the total number of pages, width and height of a single page, and page numbers. Support operations such as page cropping (crop), region filtering (within_bbox, outside_bbox), and object filtering (filter).
4. **Extracting PDF Objects**: Extract in detail objects such as characters (chars), lines (lines), rectangles (rects), curves (curves), images (images), annotations (annots), and hyperlinks (hyperlinks) on each page, and retrieve their detailed attributes (such as coordinates, colors, fonts, etc.).
5. **Text Extraction and Processing**: Support extracting text by page, region, layout, etc. Support extracting words, text lines, and full text. Support advanced text processing such as custom tolerance parameters, regular search, and duplicate character removal.
6. **Table Detection and Extraction**: Automatically detect and extract tables on the page, and return structured data. Support multiple table boundary recognition strategies (lines, text, explicit specification, etc.), and support custom parameters.
7. **Processing Images and Graphic Objects**: Retrieve information such as the size, position, color space, and raw data of images. Retrieve the detailed attributes of graphic objects such as lines, rectangles, and curves.
8. **Visual Debugging and Image Rendering**: Render the page as an image, support object overlay, table visualization, and interactive visualization in Jupyter Notebook.
9. **Command Line Interface (CLI)**: Provide a CLI tool to support exporting PDF content to formats such as CSV, JSON, and plain text. Support customizing exported content, page numbers, object types, etc. through command line parameters.
10. **Extracting Form Data**: Support extracting field names and values from PDF forms.
11. **Exception Handling and Compatibility**: Have fault tolerance for situations such as invalid metadata and abnormal PDF structures, and support multiple versions of Python environments.
12. **Core File Requirements**: The project must include a complete setup.py file. This file should not only configure the project as an installable package (supporting pip install) but also declare a complete list of dependencies (including core libraries such as pdfminer.six == 20250506, pillow<=9.1, pytest ==8.3.2, pandas ==2.2.2). The setup.py file can verify whether all functional modules work properly. At the same time, it should provide pdfplumber/__init__.py as a unified API entry, import and export T_table_settings, Table, TableSettings (classes), PDFDocEncoding, decode_text, MalformedPDFException, resolve_and_decode, PdfminerException, CTM, TableFinder, fix_fontname_bytes, extract_text, within_bbox, repair, PDFStructTree, and the main import and export functions, and provide version information, enabling users to access all main functions through simple statements such as "from pdfplumber import **" and "from pdfplumber.ctm/table/utils/utils.exceptions/structure import **".

---
## Environment Dependencies and Configuration

### Python Version
The Python version used in the current project is: Python 3.12.4

**Core Dependent Libraries and Versions**
- pdfminer.six==20250506           # PDF parsing engine
- Pillow>=9.1                      # Image processing
- pypdfium2>=4.18.0                # PDF rendering
- pandas==2.2.2                    # Data processing
- numpy==1.26.4                    # Numerical calculation
- pytest==8.3.2                    # Unit testing
- black==24.8.0                    # Code formatting
- flake8==7.1.1                    # Code style checking
- isort==5.13.2                    # Import sorting
- jupyterlab==3.6.7                # Interactive development
- mypy==1.11.1                     # Type checking
- nbexec==0.2.0                    # Jupyter execution
- pandas-stubs==2.2.2.240805       # pandas type hints
- py==1.11.0                       # pytest dependency
- pytest-cov==5.0.0                # Test coverage
- pytest-parallel==0.1.1           # Parallel testing
- setuptools==68.2.2               # Installation tool
- types-Pillow==10.2.0.20240520    # Pillow type hints

**Standard Library Dependencies**
- os, sys, re, io, json, logging, pathlib, zipfile, subprocess, collections, itertools, operator, shutil, tempfile, resource

## Project Architecture
### Project Directory Structure
```
workspace/
├── .gitignore
├── CHANGELOG.md
├── CITATION.cff
├── CONTRIBUTING.md
├── LICENSE.txt
├── MANIFEST.in
├── Makefile
├── README.md
├── codecov.yml
├── pdfplumber
│   ├── __init__.py
│   ├── _typing.py
│   ├── _version.py
│   ├── cli.py
│   ├── container.py
│   ├── convert.py
│   ├── ctm.py
│   ├── display.py
│   ├── page.py
│   ├── pdf.py
│   ├── py.typed
│   ├── repair.py
│   ├── structure.py
│   ├── table.py
│   ├── utils
│   │   ├── __init__.py
│   │   ├── clustering.py
│   │   ├── exceptions.py
│   │   ├── generic.py
│   │   ├── geometry.py
│   │   ├── pdfinternals.py
│   │   └── text.py
├── setup.cfg
└── setup.py

```


## API Usage Guide

### Core API

#### 1. API Import

**Basic Imports (Most Common)**:
```python
import pdfplumber

# Main functions are available directly
# pdfplumber.open(), pdfplumber.repair()
```

**Advanced Imports (For Specific Features)**:
```python
# Table extraction and configuration
from pdfplumber.table import Table, TableFinder, TableSettings, T_table_settings

# Coordinate transformation matrix
from pdfplumber.ctm import CTM

# Utility functions
from pdfplumber.utils import extract_text, within_bbox, dedupe_chars
from pdfplumber.utils.pdfinternals import resolve_and_decode, decode_text

# Exception handling
from pdfplumber.utils.exceptions import MalformedPDFException, PdfminerException

# Structure tree parsing
from pdfplumber.structure import PDFStructTree

# Visualization
from pdfplumber.display import PageImage, COLORS

# PDF repair function (also available as pdfplumber.repair)
from pdfplumber.repair import repair
```

**Usage Example**:
```python
import pdfplumber

# Using repair as context manager
with pdfplumber.repair("broken.pdf") as repaired_stream:
    with pdfplumber.open(repaired_stream) as pdf:
        print(len(pdf.pages))
```

#### 2. pdfplumber.open()

**Import Method**:
```python
from pdfplumber import open
# or
import pdfplumber
# then use: pdfplumber.open(...)
```

**Function Description**: Open a PDF file and return a PDF object.

**Function Signature**:
```python
def open(
    path_or_fp: Union[str, pathlib.Path, BufferedReader, BytesIO],
    pages: Optional[Union[List[int], Tuple[int]]] = None,
    laparams: Optional[Dict[str, Any]] = None,
    password: Optional[str] = None,
    strict_metadata: bool = False,
    unicode_norm: Optional[Literal["NFC", "NFKC", "NFD", "NFKD"]] = None,
    repair: bool = False,
    gs_path: Optional[Union[str, pathlib.Path]] = None,
    repair_setting: T_repair_setting = "default",
    raise_unicode_errors: bool = True,
) -> PDF
```

**Parameters**:
- path_or_fp (str | Path | file-like): PDF file path or file object
- pages (list[int] | None): Specify page numbers
- laparams (dict | None): Layout parameters
- password (str | None): PDF password
- strict_metadata (bool): Strict mode for metadata parsing
- unicode_norm (str | None): Unicode normalization
- repair (bool): Whether to automatically repair
- gs_path (str | None): Ghostscript path
- repair_setting (str): Repair mode
- raise_unicode_errors (bool): Whether to raise an exception when encountering encoding errors

**Return Value**: PDF object

**Usage Example**:
```python
with pdfplumber.open("example.pdf") as pdf:
    print(pdf.pages)
```

#### 3. pdfplumber.repair()

**Import Method**:
```python
from pdfplumber import repair
# or
from pdfplumber.repair import repair
```

**Function Description**: Repair a corrupted PDF file and return the repaired byte stream.

**Function Signature**:
```python
def repair(
    path_or_fp: Union[str, pathlib.Path, BufferedReader, BytesIO],
    outfile: Optional[Union[str, pathlib.Path]] = None,
    password: Optional[str] = None,
    gs_path: Optional[Union[str, pathlib.Path]] = None,
    setting: T_repair_setting = "default"
) -> Optional[BytesIO]
```

**Parameters**:
- path_or_fp (str | Path | file-like): PDF file path or object
- password (str | None): PDF password
- gs_path (str | None): Ghostscript path
- setting (str): Repair mode

**Return Value**: BytesIO object

**Usage Example**:
```python
from pdfplumber import repair
repaired_bytes = repair("broken.pdf")
with pdfplumber.open(repaired_bytes) as pdf:
    print(len(pdf.pages))
```

#### 4. PDF Class

**Import Method**:
```python
from pdfplumber.pdf import PDF
```

**Function Description**: Represent a PDF document, supporting page traversal, metadata, structure tree, etc.

**Class Signature**:
```python
class PDF(Container):
    cached_properties: List[str] = Container.cached_properties + ["_pages"]
    
    def __init__(
        self,
        stream: Union[BufferedReader, BytesIO],
        stream_is_external: bool = False,
        path: Optional[pathlib.Path] = None,
        pages: Optional[Union[List[int], Tuple[int]]] = None,
        laparams: Optional[Dict[str, Any]] = None,
        password: Optional[str] = None,
        strict_metadata: bool = False,
        unicode_norm: Optional[Literal["NFC", "NFKC", "NFD", "NFKD"]] = None,
        raise_unicode_errors: bool = True,
    )
    
    @classmethod
    def open(
        cls,
        path_or_fp: Union[str, pathlib.Path, BufferedReader, BytesIO],
        pages: Optional[Union[List[int], Tuple[int]]] = None,
        laparams: Optional[Dict[str, Any]] = None,
        password: Optional[str] = None,
        strict_metadata: bool = False,
        unicode_norm: Optional[Literal["NFC", "NFKC", "NFD", "NFKD"]] = None,
        repair: bool = False,
        gs_path: Optional[Union[str, pathlib.Path]] = None,
        repair_setting: T_repair_setting = "default",
        raise_unicode_errors: bool = True,
    ) -> "PDF"
    
    def close(self) -> None
    
    def __enter__(self) -> "PDF"
    
    def __exit__(self, t, value, traceback) -> None
    
    @property
    def pages(self) -> List[Page]
    
    @property
    def objects(self) -> Dict[str, T_obj_list]
    
    @property
    def annots(self) -> List[Dict[str, Any]]
    
    @property
    def hyperlinks(self) -> List[Dict[str, Any]]
    
    @property
    def structure_tree(self) -> List[Dict[str, Any]]
    
    def to_dict(self, object_types: Optional[List[str]] = None) -> Dict[str, Any]
```

**Parent Class**:
- `Container` (from `pdfplumber.container`)

**Attributes**:
- `stream` (Union[BufferedReader, BytesIO]): PDF file stream
- `stream_is_external` (bool): Whether stream is externally managed
- `path` (Optional[pathlib.Path]): Path to PDF file (if opened from path)
- `password` (Optional[str]): PDF password
- `metadata` (Dict): PDF metadata dictionary
- `doc` (PDFDocument): pdfminer document object
- `rsrcmgr` (PDFResourceManager): Resource manager

**Properties**:
- `pages` (List[Page]): List of all Page objects
- `objects` (Dict[str, T_obj_list]): All objects from all pages
- `annots` (List[Dict]): All annotation objects
- `hyperlinks` (List[Dict]): All hyperlink objects
- `structure_tree` (List[Dict]): Structure tree of the document

**Main Methods**:
- `open(path_or_fp, pages, laparams, password, ...)`: Class method to open a PDF file from path or file object, returns PDF instance
- `close()`: Close the PDF and release all resources, returns None
- `to_dict(object_types)`: Export entire PDF structure including all pages as dictionary, returns Dict
- `__enter__()`: Enter context manager, returns PDF instance (self)
- `__exit__(t, value, traceback)`: Exit context manager and close PDF, returns None

**Usage Example**:
```python
with pdfplumber.open("example.pdf") as pdf:
    print(pdf.metadata)
    for page in pdf.pages:
        print(page.width, page.height)
```

**Inheritance**: Inherits from `Container`

#### 5. Page Class

**Import Method**:
```python
from pdfplumber.page import Page
```

**Function Description**: Represent a single page of a PDF, supporting object extraction, text/table/image analysis, cropping, visualization, etc.

**Class Signature**:
```python
class Page(Container):
    cached_properties: List[str] = Container.cached_properties + ["_layout"]
    is_original: bool = True
    pages = None
    
    def __init__(
        self,
        pdf: "PDF",
        page_obj: PDFPage,
        page_number: int,
        initial_doctop: T_num = 0,
    )
    
    def close(self) -> None
    
    @property
    def width(self) -> T_num
    
    @property
    def height(self) -> T_num
    
    @property
    def structure_tree(self) -> List[Dict[str, Any]]
    
    @property
    def layout(self) -> LTPage
    
    @property
    def annots(self) -> T_obj_list
    
    @property
    def hyperlinks(self) -> T_obj_list
    
    @property
    def objects(self) -> Dict[str, T_obj_list]
    
    # Text extraction methods
    def extract_text(self, **kwargs: Any) -> str
    
    def extract_text_simple(self, **kwargs: Any) -> str
    
    def extract_words(self, **kwargs: Any) -> T_obj_list
    
    def extract_text_lines(
        self, strip: bool = True, return_chars: bool = True, **kwargs: Any
    ) -> T_obj_list
    
    def search(
        self,
        pattern: Union[str, Pattern[str]],
        regex: bool = True,
        case: bool = True,
        main_group: int = 0,
        return_groups: bool = True,
        return_chars: bool = True,
        **kwargs: Any
    ) -> T_obj_list
    
    # Table methods
    def find_tables(self, table_settings: Optional[T_table_settings] = None) -> List[Table]
    
    def find_table(self, table_settings: Optional[T_table_settings] = None) -> Optional[Table]
    
    def extract_tables(
        self, table_settings: Optional[T_table_settings] = None
    ) -> List[List[List[Optional[str]]]]
    
    def extract_table(
        self, table_settings: Optional[T_table_settings] = None
    ) -> Optional[List[List[Optional[str]]]]
    
    # Page manipulation methods
    def crop(
        self,
        bbox: T_bbox,
        relative: bool = False,
        strict: bool = True
    ) -> CroppedPage
    
    def within_bbox(
        self, bbox: T_bbox, relative: bool = False, strict: bool = True
    ) -> CroppedPage
    
    def outside_bbox(
        self, bbox: T_bbox, relative: bool = False, strict: bool = True
    ) -> CroppedPage
    
    def filter(self, test_function: Callable[[T_obj], bool]) -> FilteredPage
    
    def dedupe_chars(self, tolerance: T_num = 1) -> "Page"
    
    # Visualization methods  
    def to_image(
        self,
        resolution: Optional[Union[int, float]] = None,
        width: Optional[Union[int, float]] = None,
        height: Optional[Union[int, float]] = None,
        antialias: bool = False,
        force_mediabox: bool = False,
    ) -> PageImage
    
    def to_dict(self, object_types: Optional[List[str]] = None) -> Dict[str, Any]
```

**Parent Class**:
- `Container` (from `pdfplumber.container`)

**Attributes**:
- `pdf` (PDF): Parent PDF object
- `page_obj` (PDFPage): pdfminer page object
- `page_number` (int): Page number (1-indexed)
- `bbox` (T_bbox): Page bounding box
- `mediabox` (T_bbox): Media box
- `cropbox` (T_bbox): Crop box
- `rotation` (int): Page rotation in degrees

**Properties** (inherited from Container and custom):
- `width` (T_num): Page width
- `height` (T_num): Page height
- `chars`, `lines`, `rects`, `curves`, `images`: Object lists (inherited)
- `annots` (T_obj_list): Annotation objects
- `hyperlinks` (T_obj_list): Hyperlink objects  
- `objects` (Dict[str, T_obj_list]): All page objects by type
- `structure_tree` (List[Dict]): Page structure tree
- `layout` (LTPage): pdfminer layout object

**Main Methods**:
- `close()`: Close the page and release resources, returns None
- `extract_text(**kwargs)`: Extract all text from page, returns string
- `extract_text_simple(**kwargs)`: Extract text using simple clustering, returns string
- `extract_words(**kwargs)`: Extract words with positions and properties, returns list of word objects
- `extract_text_lines(strip, return_chars, **kwargs)`: Extract text organized by lines, returns list of line objects
- `search(pattern, regex, case, **kwargs)`: Search for pattern in page text, returns list of matching text objects
- `find_tables(table_settings)`: Find all tables on page, returns list of Table objects
- `find_table(table_settings)`: Find the largest table on page, returns Table object or None
- `extract_tables(table_settings)`: Extract data from all tables, returns 3D list of cell text
- `extract_table(table_settings)`: Extract data from largest table, returns 2D list of cell text or None
- `crop(bbox, relative, strict)`: Crop page to bounding box, returns CroppedPage
- `within_bbox(bbox, relative, strict)`: Filter to objects within bbox, returns CroppedPage
- `outside_bbox(bbox, relative, strict)`: Filter to objects outside bbox, returns CroppedPage
- `filter(test_function)`: Filter objects by custom function, returns FilteredPage
- `dedupe_chars(tolerance)`: Remove duplicate characters, returns Page
- `to_image(resolution, width, height, antialias, force_mediabox)`: Render page as image, returns PageImage
- `to_dict(object_types)`: Export page structure as dictionary, returns Dict

**Usage Example**:
```python
page = pdf.pages[0]
text = page.extract_text()
words = page.extract_words()
tables = page.find_tables()
img = page.to_image()
```

**Inheritance**: Inherits from `Container`

#### 6. Utility Functions

**Import Method**:
```python
from pdfplumber.utils import extract_text, extract_words, dedupe_chars
from pdfplumber.utils import within_bbox, outside_bbox, crop_to_bbox, intersects_bbox
from pdfplumber.utils import cluster_objects, objects_to_bbox, objects_to_rect
from pdfplumber.utils.pdfinternals import resolve_all, resolve_and_decode, decode_text
```

**Function Description**: Collection of utility functions for text extraction, object manipulation, geometric operations, and PDF internals handling.

**Main Utility Functions**:

##### 6.1. extract_text

**Function Signature**:
```python
def extract_text(
    chars: T_obj_list,
    line_dir_render: Optional[T_dir] = None,
    char_dir_render: Optional[T_dir] = None,
    **kwargs: Any
) -> str
```

**Parameters**:
- `chars` (T_obj_list): List of character objects to extract text from
- `line_dir_render` (Optional[T_dir]): Line direction for rendering text output (default: None, uses extractor's line_dir)
- `char_dir_render` (Optional[T_dir]): Character direction for rendering text output (default: None, uses extractor's char_dir)
- `**kwargs`: Additional parameters for WordExtractor and layout control (x_tolerance, y_tolerance, layout, etc.)

**Return Value**: Extracted text as string

##### 6.2. extract_words

**Function Signature**:
```python
def extract_words(
    chars: T_obj_list,
    return_chars: bool = False,
    **kwargs: Any
) -> T_obj_list
```

**Parameters**:
- `chars` (T_obj_list): List of character objects
- `return_chars` (bool): Whether to include character objects in word dictionaries (default: False)
- `**kwargs`: Parameters for WordExtractor (x_tolerance, y_tolerance, keep_blank_chars, use_text_flow, etc.)

**Return Value**: List of word objects with position and attribute information

##### 6.3. dedupe_chars

**Function Signature**:
```python
def dedupe_chars(
    chars: T_obj_list,
    tolerance: T_num = 1,
    extra_attrs: Optional[Tuple[str, ...]] = ("fontname", "size")
) -> T_obj_list
```

**Parameters**:
- `chars` (T_obj_list): List of character objects
- `tolerance` (T_num): Maximum position distance for characters to be considered duplicates (default: 1)
- `extra_attrs` (Optional[Tuple[str, ...]]): Additional attributes that must match for deduplication (default: ("fontname", "size"))

**Return Value**: Deduplicated list of character objects

##### 6.4. within_bbox

**Function Signature**:
```python
from pdfplumber.utils.geometry import within_bbox

def within_bbox(objs: Iterable[T_obj], bbox: T_bbox) -> T_obj_list
```

**Parameters**:
- `objs` (Iterable[T_obj]): Objects to filter (chars, lines, rects, etc.)
- `bbox` (T_bbox): Bounding box as (x0, top, x1, bottom)

**Return Value**: List of objects completely within the bounding box

##### 6.5. outside_bbox

**Function Signature**:
```python
from pdfplumber.utils.geometry import outside_bbox
def outside_bbox(objs: Iterable[T_obj], bbox: T_bbox) -> T_obj_list
```

**Parameters**:
- `objs` (Iterable[T_obj]): Objects to filter
- `bbox` (T_bbox): Bounding box as (x0, top, x1, bottom)

**Return Value**: List of objects completely outside the bounding box

##### 6.6. crop_to_bbox

**Function Signature**:
```python
from pdfplumber.utils.geometry import crop_to_bbox
def crop_to_bbox(objs: Iterable[T_obj], bbox: T_bbox) -> T_obj_list
```

**Parameters**:
- `objs` (Iterable[T_obj]): Objects to crop
- `bbox` (T_bbox): Bounding box to crop to

**Return Value**: List of objects that intersect the bbox, with dimensions adjusted to fit within bbox

##### 6.7. cluster_objects

**Function Signature**:
```python
def cluster_objects(
    xs: List[Clusterable],
    key_fn: Union[Hashable, Callable[[Clusterable], T_num]],
    tolerance: T_num,
    preserve_order: bool = False
) -> List[List[Clusterable]]
```

**Parameters**:
- `xs` (List[Clusterable]): List of objects to cluster
- `key_fn` (Union[Hashable, Callable]): Function to extract clustering key, or attribute name string
- `tolerance` (T_num): Maximum distance between objects in same cluster
- `preserve_order` (bool): Whether to preserve original order (default: False)

**Return Value**: List of clusters, where each cluster is a list of objects

##### 6.8. objects_to_bbox

**Function Signature**:
```python
def objects_to_bbox(objects: Iterable[T_obj]) -> T_bbox
```

**Parameters**:
- `objects` (Iterable[T_obj]): Objects to find bounding box for

**Return Value**: Smallest bounding box tuple (x0, top, x1, bottom) containing all objects

##### 6.9. resolve_all
    
**Function Signature**:
```python
def resolve_all(x: Any) -> Any
```
    
**Parameters**:
- `x` (Any): PDF object to recursively resolve (can be PDFObjRef, list, dict, or primitive)
    
**Return Value**: Fully resolved object with all references expanded
    
**Usage Example**:
```python
from pdfplumber.utils import extract_text, within_bbox, cluster_objects
    
# Extract text from characters
text = extract_text(page.chars)
    
# Get objects within a region
chars_in_region = within_bbox(page.chars, (100, 100, 200, 200))
    
# Cluster objects by y-position
from operator import itemgetter
clusters = cluster_objects(page.chars, itemgetter("top"), tolerance=5)
    
# Extract words with character details
words = extract_words(page.chars, return_chars=True)

# Deduplicate overlapping characters
unique_chars = dedupe_chars(page.chars, tolerance=2)
```

#### 7. Command Line Interface (CLI)

**Import Method**:
```python
from pdfplumber.cli import main, parse_args, parse_page_spec, add_text_to_mcids
```

**Function Description**: Command-line interface for extracting PDF content, supporting multiple output formats and parameters.

**Main CLI Functions**:

##### 7.1. parse_args

**Function Signature**:
```python
def parse_args(args_raw: List[str]) -> argparse.Namespace
```

**Parameters**:
- `args_raw` (List[str]): Raw command-line arguments

**Return Value**: argparse.Namespace object with parsed arguments

##### 7.2. parse_page_spec

**Function Signature**:
```python
def parse_page_spec(p_str: str) -> List[int]
```

**Parameters**:
- `p_str` (str): Page specification string (e.g., "1-5" or "3")

**Return Value**: List of page numbers

##### 7.3. add_text_to_mcids

**Function Signature**:
```python
def add_text_to_mcids(pdf: PDF, data: List[Dict[str, Any]]) -> None
```

**Parameters**:
- `pdf` (PDF): PDF object
- `data` (List[Dict[str, Any]]): Structure tree data

**Return Value**: None (modifies data in-place by adding text content)

##### 7.4. main

**Function Signature**:
```python
def main(args_raw: List[str] = sys.argv[1:]) -> None
```

**Parameters**:
- `args_raw` (List[str]): Command-line arguments (default: sys.argv[1:])

**Return Value**: None (outputs result to stdout or specified file)

**CLI Parameters**:
- `infile`: Input PDF file path
- `--format`: Output format (csv/json/text) (default: csv)
- `--types`: Object types to extract (e.g., char, line, rect)
- `--pages`: Page numbers to process (e.g., "1-5" or "1 3 5")
- `--laparams`: Layout parameters as JSON string
- `--precision`: Decimal precision for numeric values
- `--structure`: Output structure tree as JSON
- `--structure-text`: Output structure tree with text content
- `--include-attrs`: Include only specified attributes
- `--exclude-attrs`: Exclude specified attributes
- `--indent`: JSON indentation level

**Usage Examples**:
```bash
# Extract to CSV
pdfplumber example.pdf --format csv > output.csv

# Extract to JSON with indentation
pdfplumber example.pdf --format json --indent 2 > output.json

# Extract specific pages
pdfplumber example.pdf --pages 1-3 5 --format text

# Extract specific object types
pdfplumber example.pdf --types char line --format csv

# Extract structure tree
pdfplumber example.pdf --structure > structure.json

# Extract with specific attributes
pdfplumber example.pdf --include-attrs text x0 y0 --format csv

# Programmatic usage
from pdfplumber.cli import main
main(["document.pdf", "--format", "json"])
```

#### 8. Table Class 

**Import Method**:
```python
from pdfplumber.table import Table
```

**Function Description**: Represent a table in a PDF document, providing methods for extracting table data.

**Class Signature**:
```python
class Table(object):
    def __init__(self, page: "Page", cells: List[T_bbox])
    
    @property
    def bbox(self) -> T_bbox
    
    def _get_rows_or_cols(self, kind: Type[CellGroup]) -> List[CellGroup]
    
    @property
    def rows(self) -> List[CellGroup]
    
    @property
    def columns(self) -> List[CellGroup]
    
    def extract(self, **kwargs: Any) -> List[List[Optional[str]]]
```

**Attributes**:
- `page` (Page): The Page object containing this table
- `cells` (List[T_bbox]): List of cell bounding boxes

**Properties**:
- `bbox` (T_bbox): Bounding box of the entire table
- `rows` (List[CellGroup]): List of Row objects
- `columns` (List[CellGroup]): List of Column objects

**Internal Methods**:
- `_get_rows_or_cols(kind)`: Internal helper method to get rows or columns based on CellGroup type (Row or Column), returns List[CellGroup]

**Main Methods**:
- `extract(**kwargs)`: Extract text from all cells, returns 2D list of cell text

**Example**:
```python
from pdfplumber import open

with open("example.pdf") as pdf:
    first_page = pdf.pages[0]
    table = first_page.extract_table()
    for row in table:
        print(row)
```

---

#### 9. TableFinder Class

**Import Method**:
```python
from pdfplumber.table import TableFinder
```

**Function Description**: Find table structures in a PDF page.

**Class Signature**:
```python
class TableFinder(object):
    def __init__(self, page: "Page", settings: Optional[T_table_settings] = None)
    
    def get_edges(self) -> T_obj_list
```

**Attributes**:
- `page` (Page): PDF page object
- `settings` (TableSettings): Table search settings
- `edges` (T_obj_list): Detected table edges
- `intersections` (Dict): Intersections of edges
- `cells` (List): Detected cells
- `tables` (List[Table]): List of found tables

**Main Methods**:
- `get_edges()`: Get all edges used to detect table structure based on detection strategy, returns list of edge objects

---

#### 10. TableSettings Class

**Import Method**:
```python
from pdfplumber.table import TableSettings
```

**Function Description**: Configure parameters for table detection.

**Class Signature**:
```python
@dataclass
class TableSettings:
    vertical_strategy: str = "lines"
    horizontal_strategy: str = "lines"
    explicit_vertical_lines: Optional[List[Union[T_obj, T_num]]] = None
    explicit_horizontal_lines: Optional[List[Union[T_obj, T_num]]] = None
    snap_tolerance: T_num = DEFAULT_SNAP_TOLERANCE
    snap_x_tolerance: T_num = UNSET
    snap_y_tolerance: T_num = UNSET
    join_tolerance: T_num = DEFAULT_JOIN_TOLERANCE
    join_x_tolerance: T_num = UNSET
    join_y_tolerance: T_num = UNSET
    edge_min_length: T_num = 3
    min_words_vertical: int = DEFAULT_MIN_WORDS_VERTICAL
    min_words_horizontal: int = DEFAULT_MIN_WORDS_HORIZONTAL
    intersection_tolerance: T_num = 3
    intersection_x_tolerance: T_num = UNSET
    intersection_y_tolerance: T_num = UNSET
    text_settings: Optional[Dict[str, Any]] = None
    
    def __post_init__(self) -> None
    
    @classmethod
    def resolve(cls, spec: Optional[T_table_settings] = None) -> "TableSettings"
```

**Main Parameters**:
- `vertical_strategy`: Vertical line detection strategy (default: "lines")
- `horizontal_strategy`: Horizontal line detection strategy (default: "lines")
- `snap_tolerance`: Edge alignment tolerance (default: 3)
- `join_tolerance`: Edge connection tolerance (default: 3)
- `edge_min_length`: Minimum edge length (default: 3)
- `min_words_vertical`: Minimum number of words required for vertical lines (default: 3)
- `min_words_horizontal`: Minimum number of words required for horizontal lines (default: 1)

**Main Methods**:
- `resolve(settings)`: Class method that parses and validates table settings from dict or TableSettings object, returns TableSettings instance

---

#### 11. T_table_settings Type Alias

**Import Method**:
```python
from pdfplumber.table import T_table_settings
```

**Function Description**: Represent a type alias for table settings, which can be a `TableSettings` object or a dictionary.

---

#### 12. CTM Class

**Import Method**:
```python
from pdfplumber.ctm import CTM
```

**Function Description**: Represent the Current Transformation Matrix (CTM) in a PDF.

**Class Signature**:
```python
class CTM(NamedTuple):
    a: float
    b: float
    c: float
    d: float
    e: float
    f: float
    
    @property
    def scale_x(self) -> float

    @property
    def scale_y(self) -> float
    
    @property
    def skew_x(self) -> float
    
    @property
    def skew_y(self) -> float
    
    @property
    def translation_x(self) -> float
    
    @property
    def translation_y(self) -> float
```

**Parent Class**:
- `NamedTuple` (from `typing`)

**Attributes**:
- `a` (float): Horizontal scaling component
- `b` (float): Vertical skewing component
- `c` (float): Horizontal skewing component
- `d` (float): Vertical scaling component
- `e` (float): Horizontal translation component
- `f` (float): Vertical translation component

**Properties**:
- `scale_x` (float): X-axis scaling ratio
- `scale_y` (float): Y-axis scaling ratio
- `skew_x` (float): X-axis skew angle in degrees
- `skew_y` (float): Y-axis skew angle in degrees
- `translation_x` (float): X-axis translation
- `translation_y` (float): Y-axis translation

**Inheritance**: Inherits from `NamedTuple` (immutable tuple with named fields)

---

#### 13. Serializer Class

**Import Method**:
```python
from pdfplumber.convert import Serializer
```

**Function Description**: Serialize PDF objects to JSON-compatible formats with configurable precision and attribute filtering.

**Class Signature**:
```python
class Serializer:
    def __init__(
        self,
        precision: Optional[int] = None,
        include_attrs: Optional[List[str]] = None,
        exclude_attrs: Optional[List[str]] = None,
    )
    
    def serialize(self, obj: Any) -> Any
    
    def do_float(self, x: float) -> float
    
    def do_bool(self, x: bool) -> int
    
    def do_list(self, obj: List[Any]) -> List[Any]
    
    def do_tuple(self, obj: Tuple[Any, ...]) -> Tuple[Any, ...]
    
    def do_dict(self, obj: Dict[str, Any]) -> Dict[str, Any]
    
    def do_PDFStream(self, obj: Any) -> Dict[str, Optional[str]]
    
    def do_PSLiteral(self, obj: PSLiteral) -> str
    
    def do_bytes(self, obj: bytes) -> Optional[str]
```

**Attributes**:
- `precision` (Optional[int]): Number of decimal places for float values
- `attr_filter` (Callable): Function to filter object attributes

**Main Methods**:
- `serialize(obj)`: Convert any object to JSON-compatible format, returns serialized value (Any)
- `do_float(x)`: Serialize float with configured precision, returns float
- `do_bool(x)`: Convert boolean to integer representation, returns int (0 or 1)
- `do_list(obj)`: Serialize list by recursively serializing each element, returns List
- `do_tuple(obj)`: Serialize tuple by recursively serializing each element, returns Tuple
- `do_dict(obj)`: Serialize dictionary with attribute filtering applied, returns Dict
- `do_PDFStream(obj)`: Serialize PDFStream object by converting rawdata to base64, returns Dict with "rawdata" key
- `do_PSLiteral(obj)`: Serialize PSLiteral object by decoding its name attribute, returns decoded string
- `do_bytes(obj)`: Serialize bytes by attempting multiple encodings (utf-8, latin-1, utf-16, utf-16le), returns decoded string or None

---

#### 14. PDFPageAggregatorWithMarkedContent Class

**Import Method**:
```python
from pdfplumber.page import PDFPageAggregatorWithMarkedContent
```

**Function Description**: Extract layout from a specific page, adding marked-content IDs to objects where found.

**Class Signature**:
```python
class PDFPageAggregatorWithMarkedContent(PDFPageAggregator):
    cur_mcid: Optional[int] = None
    cur_tag: Optional[str] = None
    
    def begin_tag(self, tag: PSLiteral, props: Optional[PDFStackT] = None) -> None
    
    def end_tag(self) -> None
    
    def tag_cur_item(self) -> None
    
    def render_char(self, *args, **kwargs) -> float
    
    def render_image(self, *args, **kwargs) -> None
    
    def paint_path(self, *args, **kwargs) -> None
```

**Parent Class**:
- `PDFPageAggregator` (from `pdfminer.converter`)

**Attributes**:
- `cur_mcid` (Optional[int]): Current marked content ID
- `cur_tag` (Optional[str]): Current tag name

**Main Methods**:
- `begin_tag(tag, props)`: Handle beginning of marked content tag and set current MCID from props if present, returns None
- `end_tag()`: Handle end of marked content tag and clear current MCID and tag, returns None
- `tag_cur_item()`: Add current MCID to the most recently created layout object, returns None
- `render_char(*args, **kwargs)`: Hook for rendering characters, adds mcid attribute to character object, returns float (advance width)
- `render_image(*args, **kwargs)`: Hook for rendering images, adds mcid attribute to image object, returns None
- `paint_path(*args, **kwargs)`: Hook for rendering lines and curves, adds mcid attribute to path object, returns None

**Inheritance**: Inherits from `PDFPageAggregator` (pdfminer.converter)

---

#### 15. Container Class

**Import Method**:
```python
from pdfplumber.container import Container
```

**Function Description**: Base class providing common properties and methods for PDF and Page objects.

**Class Signature**:
```python
class Container(object):
    cached_properties = ["_rect_edges", "_curve_edges", "_edges", "_objects"]
    
    @property
    def pages(self) -> Optional[List[Any]]

    @property
    def objects(self) -> Dict[str, T_obj_list]
    
    def to_dict(
        self, object_types: Optional[List[str]] = None
    ) -> Dict[str, Any]
    
    def flush_cache(self, properties: Optional[List[str]] = None) -> None
    
    @property
    def rects(self) -> T_obj_list
    
    @property
    def lines(self) -> T_obj_list
    
    @property
    def curves(self) -> T_obj_list
    
    @property
    def images(self) -> T_obj_list
    
    @property
    def chars(self) -> T_obj_list
    
    @property
    def textboxverticals(self) -> T_obj_list
    
    @property
    def textboxhorizontals(self) -> T_obj_list
    
    @property
    def textlineverticals(self) -> T_obj_list
    
    @property
    def textlinehorizontals(self) -> T_obj_list
    
    @property
    def rect_edges(self) -> T_obj_list
    
    @property
    def curve_edges(self) -> T_obj_list
    
    @property
    def edges(self) -> T_obj_list
    
    @property
    def horizontal_edges(self) -> T_obj_list
    
    @property
    def vertical_edges(self) -> T_obj_list
    
    def to_json(
        self,
        stream: Optional[TextIO] = None,
        object_types: Optional[List[str]] = None,
        include_attrs: Optional[List[str]] = None,
        exclude_attrs: Optional[List[str]] = None,
        precision: Optional[int] = None,
        indent: Optional[int] = None,
    ) -> Optional[str]
    
    def to_csv(
        self,
        stream: Optional[TextIO] = None,
        object_types: Optional[List[str]] = None,
        precision: Optional[int] = None,
        include_attrs: Optional[List[str]] = None,
        exclude_attrs: Optional[List[str]] = None,
    ) -> Optional[str]
```

**Properties**:
- `pages` (Optional[List[Any]]): List of pages (abstract property)
- `objects` (Dict[str, T_obj_list]): Dictionary of all objects by type (abstract property)
- `rects` (T_obj_list): List of rectangle objects
- `lines` (T_obj_list): List of line objects
- `curves` (T_obj_list): List of curve objects
- `images` (T_obj_list): List of image objects
- `chars` (T_obj_list): List of character objects
- `textboxverticals` (T_obj_list): Vertical text box objects
- `textboxhorizontals` (T_obj_list): Horizontal text box objects
- `textlineverticals` (T_obj_list): Vertical text line objects
- `textlinehorizontals` (T_obj_list): Horizontal text line objects
- `rect_edges` (T_obj_list): Edges derived from rectangles (cached)
- `curve_edges` (T_obj_list): Edges derived from curves (cached)
- `edges` (T_obj_list): All edges combined (cached)

**Main Methods**:
- `flush_cache(properties)`: Clear specified cached properties or all if None, returns None
- `to_dict(object_types)`: Convert container and all objects to dictionary structure, returns Dict
- `to_json(stream, object_types, include_attrs, exclude_attrs, precision, indent)`: Export container objects to JSON format, returns JSON string or None if stream provided
- `to_csv(stream, object_types, precision, include_attrs, exclude_attrs)`: Export container objects to CSV format, returns CSV string or None if stream provided

---

#### 16. DerivedPage Class

**Import Method**:
```python
from pdfplumber.page import DerivedPage
```

**Function Description**: Base class for derived page types (cropped, filtered pages).

**Class Signature**:
```python
class DerivedPage(Page):
    is_original: bool = False
    
    def __init__(self, parent_page: Page)
```

**Parent Class**:
- `Page` (from `pdfplumber.page`)

**Attributes**:
- `is_original` (bool): Always False for derived pages
- `parent_page` (Page): The parent page from which this page is derived
- `root_page` (Page): The original page at the root of the derivation chain

**Inheritance**: Inherits from `Page` class

---

#### 17. CroppedPage Class

**Import Method**:
```python
from pdfplumber.page import CroppedPage
```

**Function Description**: Represents a cropped region of a PDF page.

**Class Signature**:
```python
class CroppedPage(DerivedPage):
    def __init__(
        self,
        parent_page: Page,
        crop_bbox: T_bbox,
        crop_fn: Callable[[T_obj_list, T_bbox], T_obj_list] = utils.crop_to_bbox,
        relative: bool = False,
        strict: bool = True,
    )

    @property
    def objects(self) -> Dict[str, T_obj_list]
```

**Parent Class**:
- `DerivedPage` (from `pdfplumber.page`)

**Parameters**:
- `parent_page` (Page): The parent page to crop
- `crop_bbox` (T_bbox): Bounding box to crop to (x0, top, x1, bottom)
- `crop_fn` (Callable): Function to apply cropping (default: utils.crop_to_bbox)
- `relative` (bool): Whether bbox is relative to parent (default: False)
- `strict` (bool): Whether to validate bbox is within parent (default: True)

**Properties**:
- `objects` (Dict[str, T_obj_list]): Cropped objects from parent page

**Inheritance**: Inherits from `DerivedPage`

---

#### 18. FilteredPage Class

**Import Method**:
```python
from pdfplumber.page import FilteredPage
```

**Function Description**: Represents a filtered view of a PDF page where only objects matching a filter function are included.

**Class Signature**:
```python
class FilteredPage(DerivedPage):
    def __init__(self, parent_page: Page, filter_fn: Callable[[T_obj], bool])

    @property
    def objects(self) -> Dict[str, T_obj_list]
```

**Parent Class**:
- `DerivedPage` (from `pdfplumber.page`)

**Parameters**:
- `parent_page` (Page): The parent page to filter
- `filter_fn` (Callable): Function that returns True for objects to include

**Attributes**:
- `filter_fn` (Callable): The filter function

**Properties**:
- `objects` (Dict[str, T_obj_list]): Filtered objects from parent page

**Inheritance**: Inherits from `DerivedPage`

---

#### 19. PageImage Class

**Import Method**:
```python
from pdfplumber.display import PageImage
```

**Function Description**: Represents a rendered image of a PDF page with drawing capabilities for visual debugging.

**Class Signature**:
```python
class PageImage:
    def __init__(
        self,
        page: "Page",
        original: Optional[PIL.Image.Image] = None,
        resolution: Union[int, float] = DEFAULT_RESOLUTION,
        antialias: bool = False,
        force_mediabox: bool = False,
    )
    
    def reset(self) -> "PageImage"
    
    def save(
        self,
        dest: Union[str, pathlib.Path, BytesIO],
        format: str = "PNG",
        quantize: bool = True,
        colors: int = 256,
        bits: int = 8,
        **kwargs: Any,
    ) -> None
    
    def copy(self) -> "PageImage"
    
    def draw_line(
        self,
        points_or_obj: T_contains_points,
        stroke: T_color = DEFAULT_STROKE,
        stroke_width: int = DEFAULT_STROKE_WIDTH,
    ) -> "PageImage"
    
    def draw_lines(
        self,
        list_of_lines: Union[T_seq[T_contains_points], "pd.DataFrame"],
        stroke: T_color = DEFAULT_STROKE,
        stroke_width: int = DEFAULT_STROKE_WIDTH,
    ) -> "PageImage"
    
    def draw_vline(
        self,
        location: T_num,
        stroke: T_color = DEFAULT_STROKE,
        stroke_width: int = DEFAULT_STROKE_WIDTH,
    ) -> "PageImage"
    
    def draw_vlines(
        self,
        locations: Union[List[T_num], "pd.Series[float]"],
        stroke: T_color = DEFAULT_STROKE,
        stroke_width: int = DEFAULT_STROKE_WIDTH,
    ) -> "PageImage"
    
    def draw_hline(
        self,
        location: T_num,
        stroke: T_color = DEFAULT_STROKE,
        stroke_width: int = DEFAULT_STROKE_WIDTH,
    ) -> "PageImage"
    
    def draw_hlines(
        self,
        locations: Union[List[T_num], "pd.Series[float]"],
        stroke: T_color = DEFAULT_STROKE,
        stroke_width: int = DEFAULT_STROKE_WIDTH,
    ) -> "PageImage"
    
    def draw_rect(
        self,
        bbox_or_obj: Union[T_bbox, T_obj],
        fill: T_color = DEFAULT_FILL,
        stroke: T_color = DEFAULT_STROKE,
        stroke_width: int = DEFAULT_STROKE_WIDTH,
    ) -> "PageImage"
    
    def draw_rects(
        self,
        list_of_rects: Union[List[T_bbox], T_obj_list, "pd.DataFrame"],
        fill: T_color = DEFAULT_FILL,
        stroke: T_color = DEFAULT_STROKE,
        stroke_width: int = DEFAULT_STROKE_WIDTH,
    ) -> "PageImage"
    
    def draw_circle(
        self,
        center_or_obj: Union[T_point, T_obj],
        radius: int = 5,
        fill: T_color = DEFAULT_FILL,
        stroke: T_color = DEFAULT_STROKE,
    ) -> "PageImage"
    
    def draw_circles(
        self,
        list_of_circles: Union[List[T_point], T_obj_list, "pd.DataFrame"],
        radius: int = 5,
        fill: T_color = DEFAULT_FILL,
        stroke: T_color = DEFAULT_STROKE,
    ) -> "PageImage"
    
    def debug_table(
        self,
        table: Table,
        fill: T_color = DEFAULT_FILL,
        stroke: T_color = DEFAULT_STROKE,
        stroke_width: int = 1,
    ) -> "PageImage"
    
    def debug_tablefinder(
        self,
        table_settings: Optional[Union[TableFinder, TableSettings, T_table_settings]] = None,
    ) -> "PageImage"
    
    def outline_words(
        self,
        stroke: T_color = (255, 0, 0, 255),
        fill: T_color = (255, 0, 0, int(255 / 4)),
        stroke_width: int = DEFAULT_STROKE_WIDTH,
        x_tolerance: T_num = DEFAULT_X_TOLERANCE,
        y_tolerance: T_num = DEFAULT_Y_TOLERANCE,
    ) -> "PageImage"
    
    def outline_chars(
        self,
        stroke: T_color = (255, 0, 0, 255),
        fill: T_color = (255, 0, 0, int(255 / 4)),
        stroke_width: int = DEFAULT_STROKE_WIDTH,
    ) -> "PageImage"
    
    def _reproject_bbox(self, bbox: T_bbox) -> Tuple[float, float, float, float]
    
    def _reproject(self, coord: Union[T_point, Tuple[T_num, T_num]]) -> Tuple[float, float]
    
    def _repr_png_(self) -> bytes
    
    def show(self) -> None
```

**Attributes**:
- `page` (Page): The PDF page object
- `original` (PIL.Image.Image): The rendered page image
- `resolution` (Union[int, float]): Image resolution
- `scale` (float): Scale factor from page units to image pixels
- `bbox` (T_bbox): The bounding box being displayed

**Main Methods**:
- `reset()`: Reset image to original state without any drawings, returns PageImage (self)
- `save(dest, format, quantize, colors, bits, **kwargs)`: Save annotated image to file or BytesIO, returns None
- `copy()`: Create a new PageImage copy with same page and original image, returns PageImage
- `draw_line(points_or_obj, stroke, stroke_width)`: Draw a line connecting points or from object, returns PageImage (self)
- `draw_lines(list_of_lines, stroke, stroke_width)`: Draw multiple lines from list or DataFrame, returns PageImage (self)
- `draw_vline(location, stroke, stroke_width)`: Draw a vertical line at x-coordinate, returns PageImage (self)
- `draw_vlines(locations, stroke, stroke_width)`: Draw multiple vertical lines, returns PageImage (self)
- `draw_hline(location, stroke, stroke_width)`: Draw a horizontal line at y-coordinate, returns PageImage (self)
- `draw_hlines(locations, stroke, stroke_width)`: Draw multiple horizontal lines, returns PageImage (self)
- `draw_rect(bbox_or_obj, fill, stroke, stroke_width)`: Draw a rectangle from bbox or object, returns PageImage (self)
- `draw_rects(list_of_rects, fill, stroke, stroke_width)`: Draw multiple rectangles, returns PageImage (self)
- `draw_circle(center_or_obj, radius, fill, stroke)`: Draw a circle at center point or object center, returns PageImage (self)
- `draw_circles(list_of_circles, radius, fill, stroke)`: Draw multiple circles, returns PageImage (self)
- `debug_table(table, fill, stroke, stroke_width)`: Visualize table cells by outlining them, returns PageImage (self)
- `debug_tablefinder(table_settings)`: Visualize table detection results including edges and cells, returns PageImage (self)
- `outline_words(stroke, fill, stroke_width, x_tolerance, y_tolerance)`: Outline all words on page, returns PageImage (self)
- `outline_chars(stroke, fill, stroke_width)`: Outline all characters on page, returns PageImage (self)
- `show()`: Display the annotated image in Jupyter notebook or default image viewer, returns None

**Internal Methods**:
- `_reproject_bbox(bbox)`: Convert PDF coordinates bbox to image pixel coordinates, returns Tuple of floats
- `_reproject(coord)`: Convert PDF coordinate point to image pixel point, returns Tuple[float, float]
- `_repr_png_()`: Generate PNG representation for Jupyter notebook display, returns bytes

---

#### 20. Findable Class

**Import Method**:
```python
from pdfplumber.structure import Findable
```

**Function Description**: Mixin class providing find() and find_all() methods for searching structure tree elements.

**Class Signature**:
```python
class Findable:
    children: List["PDFStructElement"]
    
    def find_all(
        self, matcher: Union[str, Pattern[str], MatchFunc]
    ) -> Iterator["PDFStructElement"]
    
    def find(
        self, matcher: Union[str, Pattern[str], MatchFunc]
    ) -> Optional["PDFStructElement"]
```

**Attributes**:
- `children` (List[PDFStructElement]): List of child elements

**Main Methods**:
- `find_all(matcher)`: Iterate depth-first over all matching structure elements in subtree, returns Iterator of PDFStructElement
- `find(matcher)`: Find the first matching structure element in subtree, returns PDFStructElement or None

**Matcher Types**:
- String: Element name to match
- Regex Pattern: Regular expression to match against element name
- Function: Custom function taking PDFStructElement and returning bool

---

#### 21. StructTreeMissing Class

**Import Method**:
```python
from pdfplumber.structure import StructTreeMissing
```

**Function Description**: Exception raised when a PDF document does not have a structure tree.

**Class Signature**:
```python
class StructTreeMissing(ValueError):
    pass
```

**Parent Class**:
- `ValueError` (Python built-in)

**Inheritance**: Inherits from `ValueError`

---

#### 22. UnsetFloat Class

**Import Method**:
```python
from pdfplumber.table import UnsetFloat
```

**Function Description**: Special float subclass used to represent unset tolerance values in table settings.

**Class Signature**:
```python
class UnsetFloat(float):
    pass
```

**Parent Class**:
- `float` (Python built-in)

**Inheritance**: Inherits from `float`

**Usage**: Used internally with the constant `UNSET = UnsetFloat(0)` to distinguish between explicitly set zero values and unset values.

---

#### 23. COLORS Class

**Import Method**:
```python
from pdfplumber.display import COLORS
```

**Function Description**: Container class for predefined color constants used in visualization.

**Class Signature**:
```python
class COLORS:
    RED = (255, 0, 0)
    GREEN = (0, 255, 0)
    BLUE = (0, 0, 255)
    TRANSPARENT = (0, 0, 0, 0)
```

**Attributes**:
- `RED` (Tuple[int, int, int]): Red color (255, 0, 0)
- `GREEN` (Tuple[int, int, int]): Green color (0, 255, 0)
- `BLUE` (Tuple[int, int, int]): Blue color (0, 0, 255)
- `TRANSPARENT` (Tuple[int, int, int, int]): Fully transparent color (0, 0, 0, 0)

**Usage**: Used as base colors for DEFAULT_FILL and DEFAULT_STROKE constants.

**Example**:
```python
from pdfplumber.display import COLORS

img = page.to_image()
img.draw_rect(bbox, stroke=COLORS.RED, fill=COLORS.BLUE + (50,))
```

---

#### 24. PDFStructElement Class

**Import Method**:
```python
from pdfplumber.structure import PDFStructElement
```

**Function Description**: Represents a single element in a PDF structure tree.

**Class Signature**:
```python
@dataclass
class PDFStructElement(Findable):
    type: str
    revision: Optional[int]
    id: Optional[str]
    lang: Optional[str]
    alt_text: Optional[str]
    actual_text: Optional[str]
    title: Optional[str]
    page_number: Optional[int]
    attributes: Dict[str, Any] = field(default_factory=dict)
    mcids: List[int] = field(default_factory=list)
    children: List["PDFStructElement"] = field(default_factory=list)
    
    def __iter__(self) -> Iterator["PDFStructElement"]
    
    def all_mcids(self) -> Iterator[Tuple[Optional[int], int]]
    
    def to_dict(self) -> Dict[str, Any]
    
    # Inherited from Findable:
    def find_all(
        self, matcher: Union[str, Pattern[str], MatchFunc]
    ) -> Iterator["PDFStructElement"]
    
    def find(
        self, matcher: Union[str, Pattern[str], MatchFunc]
    ) -> Optional["PDFStructElement"]
```

**Parent Class**:
- `Findable` (from `pdfplumber.structure`)

**Attributes**:
- `type` (str): Element type (e.g., "Document", "P", "Span")
- `revision` (Optional[int]): Revision number
- `id` (Optional[str]): Element ID
- `lang` (Optional[str]): Language code
- `alt_text` (Optional[str]): Alternative text description
- `actual_text` (Optional[str]): Actual text content
- `title` (Optional[str]): Element title
- `page_number` (Optional[int]): Page number where element appears
- `attributes` (Dict): Element attributes
- `mcids` (List[int]): List of marked content IDs
- `children` (List[PDFStructElement]): Child structure elements

**Main Methods**:
- `__iter__()`: Iterate over child elements, returns Iterator
- `all_mcids()`: Collect all MCIDs recursively from element and descendants, returns Iterator of (page_number, mcid) tuples
- `to_dict()`: Convert element to dictionary representation with empty values pruned, returns Dict
- `find_all(matcher)`: Find all matching descendants (inherited from Findable), returns Iterator
- `find(matcher)`: Find first matching descendant (inherited from Findable), returns PDFStructElement or None

**Inheritance**: Inherits from `Findable`

---

#### 25. CellGroup Class

**Import Method**:
```python
from pdfplumber.table import CellGroup
```

**Function Description**: Base class representing a group of table cells (either a row or column).

**Class Signature**:
```python
class CellGroup(object):
    def __init__(self, cells: List[Optional[T_bbox]])
```

**Attributes**:
- `cells` (List[Optional[T_bbox]]): List of cell bounding boxes (None for empty cells)
- `bbox` (T_bbox): Bounding box encompassing all cells in the group

**Inheritance**: Direct subclass of `object`

---

#### 26. Row Class

**Import Method**:
```python
from pdfplumber.table import Row
```

**Function Description**: Represents a row in a table.

**Class Signature**:
```python
class Row(CellGroup):
    pass
```

**Parent Class**:
- `CellGroup` (from `pdfplumber.table`)

**Inheritance**: Inherits from `CellGroup`, inherits all attributes and the bbox property.

---

#### 27. Column Class

**Import Method**:
```python
from pdfplumber.table import Column
```

**Function Description**: Represents a column in a table.

**Class Signature**:
```python
class Column(CellGroup):
    pass
```

**Parent Class**:
- `CellGroup` (from `pdfplumber.table`)

**Inheritance**: Inherits from `CellGroup`, inherits all attributes and the bbox property.

---

#### 28. TextMap Class

**Import Method**:
```python
from pdfplumber.utils.text import TextMap
```

**Function Description**: Maps each unicode character in text to individual character objects or None for layout-implied whitespace.

**Class Signature**:
```python
class TextMap:
    def __init__(
        self,
        tuples: List[Tuple[str, Optional[T_obj]]],
        line_dir_render: T_dir,
        char_dir_render: T_dir,
    ) -> None
    
    def to_string(self) -> str
    
    def match_to_dict(
        self,
        m: re.Match,
        main_group: int,
        return_groups: bool,
        return_chars: bool
    ) -> Dict[str, Any]
    
    def search(
        self,
        pattern: Union[str, Pattern[str]],
        regex: bool = True,
        case: bool = True,
        return_groups: bool = True,
        return_chars: bool = True,
        main_group: int = 0,
    ) -> List[Dict[str, Any]]
    
    def extract_text_lines(
        self, strip: bool = True, return_chars: bool = True
    ) -> List[Dict[str, Any]]
```

**Attributes**:
- `tuples` (List[Tuple[str, Optional[T_obj]]]): List of (character, char_object) pairs
- `line_dir_render` (T_dir): Line direction for rendering
- `char_dir_render` (T_dir): Character direction for rendering
- `as_string` (str): Text content as string

**Main Methods**:
- `to_string()`: Convert text map to string with proper direction handling, returns str
- `match_to_dict(m, main_group, return_groups, return_chars)`: Convert regex match to dictionary with position and char info, returns Dict
- `search(pattern, regex, case, return_groups, return_chars, main_group)`: Search for pattern in text and return matches with positions, returns List of Dict
- `extract_text_lines(strip, return_chars)`: Extract text organized by lines with character objects, returns List of Dict

---

#### 29. WordMap Class

**Import Method**:
```python
from pdfplumber.utils.text import WordMap
```

**Function Description**: Maps words to their constituent character objects.

**Class Signature**:
```python
class WordMap:
    def __init__(self, tuples: List[Tuple[T_obj, T_obj_list]]) -> None
    
    def to_textmap(
        self,
        layout: bool = False,
        layout_width: T_num = 0,
        layout_height: T_num = 0,
        layout_width_chars: int = 0,
        layout_height_chars: int = 0,
        layout_bbox: T_bbox = (0, 0, 0, 0),
        x_density: T_num = DEFAULT_X_DENSITY,
        y_density: T_num = DEFAULT_Y_DENSITY,
        x_shift: T_num = 0,
        y_shift: T_num = 0,
        y_tolerance: T_num = 0,
        line_dir: T_dir = DEFAULT_LINE_DIR,
        char_dir: T_dir = DEFAULT_CHAR_DIR,
        line_dir_rotated: Optional[T_dir] = None,
        char_dir_rotated: Optional[T_dir] = None,
        char_dir_render: Optional[T_dir] = None,
        line_dir_render: Optional[T_dir] = None,
        use_text_flow: bool = False,
        presorted: bool = False,
        expand_ligatures: bool = True,
    ) -> TextMap
```

**Attributes**:
- `tuples` (List[Tuple[T_obj, T_obj_list]]): List of (word_object, chars_list) pairs

**Main Methods**:
- `to_textmap(...)`: Convert word map to text map with layout and direction settings, returns TextMap instance

---

#### 30. WordExtractor Class

**Import Method**:
```python
from pdfplumber.utils.text import WordExtractor
```

**Function Description**: Extracts words from character objects with configurable tolerance and direction settings.

**Class Signature**:
```python
class WordExtractor:
    def __init__(
        self,
        x_tolerance: T_num = DEFAULT_X_TOLERANCE,
        y_tolerance: T_num = DEFAULT_Y_TOLERANCE,
        x_tolerance_ratio: Optional[T_num] = None,
        y_tolerance_ratio: Optional[T_num] = None,
        keep_blank_chars: bool = False,
        use_text_flow: bool = False,
        vertical_ttb: bool = True,
        horizontal_ltr: bool = True,
        line_dir: T_dir = DEFAULT_LINE_DIR,
        char_dir: T_dir = DEFAULT_CHAR_DIR,
        line_dir_rotated: Optional[T_dir] = None,
        char_dir_rotated: Optional[T_dir] = None,
        extra_attrs: Optional[Tuple[str, ...]] = None,
        split_at_punctuation: Union[bool, str] = False,
        expand_ligatures: bool = True,
    )
    
    def get_char_dir(self, upright: bool) -> T_dir
    
    def merge_chars(self, ordered_chars: T_obj_list) -> T_obj
    
    def char_begins_new_word(
        self,
        prev_char: T_obj,
        curr_char: T_obj,
        direction: T_dir,
        x_tolerance: T_num,
        y_tolerance: T_num,
    ) -> bool
    
    def iter_chars_to_words(
        self, ordered_chars: T_obj_list, direction: T_dir
    ) -> Iterator[T_obj]
    
    def iter_chars_to_lines(self, chars: T_obj_list) -> Iterator[T_obj_list]
    
    def iter_extract_tuples(
        self, chars: T_obj_list
    ) -> Iterator[Tuple[T_obj, T_obj_list]]
    
    def extract_wordmap(self, chars: T_obj_list) -> WordMap
    
    def extract_words(self, chars: T_obj_list, return_chars: bool = False) -> T_obj_list
```

**Attributes**:
- `x_tolerance` (T_num): Horizontal tolerance for word spacing
- `y_tolerance` (T_num): Vertical tolerance for line grouping
- `keep_blank_chars` (bool): Whether to keep blank characters
- `use_text_flow` (bool): Whether to use text flow order
- `line_dir` (T_dir): Primary line direction
- `char_dir` (T_dir): Primary character direction
- `extra_attrs` (Optional[Tuple]): Extra attributes to include in word objects
- `split_at_punctuation` (Union[bool, str]): Whether/how to split at punctuation
- `expand_ligatures` (bool): Whether to expand ligature characters

**Main Methods**:
- `get_char_dir(upright)`: Get character direction based on text orientation, returns T_dir
- `merge_chars(ordered_chars)`: Merge character objects into a single word object, returns T_obj
- `char_begins_new_word(prev_char, curr_char, direction, x_tolerance, y_tolerance)`: Determine if character starts a new word, returns bool
- `iter_chars_to_words(ordered_chars, direction)`: Convert characters to words, returns Iterator of word objects
- `iter_chars_to_lines(chars)`: Group characters into lines, returns Iterator of character lists
- `iter_extract_tuples(chars)`: Extract (word, chars) tuples, returns Iterator
- `extract_wordmap(chars)`: Create WordMap from characters, returns WordMap
- `extract_words(chars, return_chars)`: Extract word objects from characters, returns list of word objects

---

#### 31. PDFStructTree Class - PDF Structure Tree Parsing

**Function Description**:
The `PDFStructTree` class is used to parse the logical structure tree of a PDF document. The structure tree is a hierarchical data structure defined in the PDF standard, used to represent the semantic structure of the document, such as chapters, paragraphs, tables, etc.

##### Class Definition
```python
class PDFStructTree(Findable):
    
    def __init__(self, doc: "PDF", page: Optional["Page"] = None):
        # ...
```

###### Constructor

**Function Signature**:
```python
def __init__(self, doc: "PDF", page: Optional["Page"] = None)
```

**Parameters**:
- `doc` (`pdfplumber.PDF`): The PDF document object to parse
- `page` (`Optional[pdfplumber.Page]`): Optional parameter, specifies a specific page to parse

**Exceptions**:
- `StructTreeMissing`: If the PDF document does not contain a structure tree (missing `StructTreeRoot`)

**Attributes**:
- `page`: The currently associated page object (if a specific page was specified)
- `root`: The root node of the structure tree
- `role_map`: The role mapping table
- `class_map`: The class mapping table
- `children`: The list of child elements

##### Public Methods

 `element_bbox()`

**Function**: Get the bounding box of a structure element

**Signature**:
```python
def element_bbox(self, el: PDFStructElement) -> T_bbox
```

**Parameters**:
- `el` (`PDFStructElement`): The structure element object for which to get the bounding box

**Returns**:
- `T_bbox`: A tuple representing the element's bounding box, formatted as `(x0, top, x1, bottom)`

**Exceptions**:
- `IndexError`: If the element is no longer visible after page cropping, or if no page object associated with the element can be found

##### Internal Methods

 `_make_attributes()`

**Function**: Create an attribute dictionary from a PDF object

**Signature**:
```python
def _make_attributes(self, obj: Dict[str, Any], revision: Optional[int]) -> Dict[str, Any]
```

 `_make_element()`

**Function**: Create a structure element from a PDF object

**Signature**:
```python
def _make_element(self, obj: Any) -> Tuple[Optional[PDFStructElement], List[Any]]
```

 `_parse_parent_tree()`

**Function**: Parse the structure tree from the parent tree

**Signature**:
```python
def _parse_parent_tree(self, parent_array: List[Any]) -> None
```

`_parse_struct_tree()`

**Function**: Start parsing from the structure tree root node

**Signature**:
```python
def _parse_struct_tree(self) -> None
```

 `_resolve_children()`

**Function**: Resolve child element references

**Signature**:
```python
def _resolve_children(self, seen: Dict[str, Any]) -> None
```

`on_parsed_page()`

**Function**: Check if an object is on the currently parsed page

**Signature**:
```python
def on_parsed_page(self, obj: Dict[str, Any]) -> bool
```

#### 32. within_bbox Function

**Import Method**:
```python
from pdfplumber.utils import within_bbox
```

**Function Description**: Filter objects that are completely within the specified bounding box.

**Function Signature**:
```python
def within_bbox(objs: Iterable[T_obj], bbox: T_bbox) -> T_obj_list
```

**Parameters**:
- `objs`: List of objects (such as characters, lines, rectangles, etc.)
- `bbox`: Bounding box (x0, top, x1, bottom)

**Return**:
- List of objects that are completely within the bounding box

**Example**:
```python
from pdfplumber.utils import within_bbox

# Get all characters within a specific area on the page
chars_in_area = within_bbox(page.chars, (100, 100, 200, 200))
```

---

#### 33. PDFDocEncoding Class

**Import Method**:
```python
from pdfminer.utils import PDFDocEncoding
```

**Function Description**: Handle text encoding in PDF documents.

**Note**: This is a third-party class from the `pdfminer.six` library, not defined in pdfplumber.

**Class Type**: Dictionary-like encoding table from pdfminer

**Usage**:
- Used internally by pdfplumber for decoding specially encoded text in PDF documents
- Handles non-Unicode encodings in PDF documents
- Maps byte values to Unicode characters according to PDF specification

**Example**:
```python
from pdfminer.utils import PDFDocEncoding

# PDFDocEncoding is used internally by decode_text function
# to decode PDF text encoding
```

---

#### 34. decode_text Function

**Import Method**:
```python
from pdfplumber.utils.pdfinternals import decode_text
```

**Function Description**: Decode a PDFDocEncoding string to Unicode.

**Function Signature**:
```python
def decode_text(s: Union[bytes, str]) -> str
```

**Parameters**:
- `s`: Byte string or string to be decoded

**Return**:
- Decoded Unicode string

**Features**:
- Automatically detect and handle UTF-16BE encoding (byte strings starting with \xfe\xff)
- For other encodings, use PDFDocEncoding for decoding
- If decoding fails, return the string representation of the original string

---

#### 35. fix_fontname_bytes Function

**Import Method**:
```python
from pdfplumber.page import fix_fontname_bytes
```

**Function Description**: Fix the encoding problem of Chinese font names in PDFs.

**Function Signature**:
```python
def fix_fontname_bytes(fontname: bytes) -> str
```

**Parameters**:
- `fontname`: Original font name byte string

**Return**:
- Fixed font name string

**Function**:
- Handle font names containing '+' (such as 'ABC+SimSun')
- Convert known Chinese font encodings (such as '\xcb\xce\xcc\xe5') to readable names (such as 'SimSun,Regular')

---

#### 36. MalformedPDFException

**Import Method**:
```python
from pdfplumber.utils.exceptions import MalformedPDFException
```

**Function Description**: Exception raised when the PDF file format is incorrect or corrupted.

**Class Signature**:
```python
class MalformedPDFException(Exception):
    pass
```

**Parent Class**:
- `Exception` (Python built-in)

**Inheritance**: Inherits from `Exception`

**Example**:
```python
from pdfplumber.utils.exceptions import MalformedPDFException

try:
    with pdfplumber.open("corrupted.pdf") as pdf:
        text = pdf.pages[0].extract_text()
except MalformedPDFException as e:
    print(f"PDF file format error: {e}")
```

---

#### 37. PdfminerException

**Import Method**:
```python
from pdfplumber.utils.exceptions import PdfminerException
```

**Function Description**: Base exception class for pdfminer-related errors during PDF processing.

**Class Signature**:
```python
class PdfminerException(Exception):
    pass
```

**Parent Class**:
- `Exception` (Python built-in)

**Inheritance**: Inherits from `Exception`

**Example**:
```python
from pdfplumber.utils.exceptions import PdfminerException

try:
    with pdfplumber.open("document.pdf") as pdf:
        text = pdf.pages[0].extract_text()
except PdfminerException as e:
    print(f"PDF processing error: {e}")
```

---

#### 38. get_attr_filter Function

**Function Description**: Create an attribute filter function for CSV export, determining which object attributes to include or exclude.

**Import Method**:
```python
from pdfplumber.convert import get_attr_filter
```

**Function Signature**:
```python
def get_attr_filter(
    include_attrs: Optional[List[str]] = None,
    exclude_attrs: Optional[List[str]] = None
) -> Callable[[str], bool]
```

**Parameters**:
- `include_attrs`: List of attribute names to include (optional)
- `exclude_attrs`: List of attribute names to exclude (optional)

**Return Value**:
- Returns a callable function that takes an attribute name and returns True if it should be included

**Example**:
```python
from pdfplumber.convert import get_attr_filter

# Include only specific attributes
filter_fn = get_attr_filter(include_attrs=["x0", "y0", "width", "height"])

# Exclude certain attributes
filter_fn = get_attr_filter(exclude_attrs=["mcid", "tag"])
```

---

#### 39. to_b64 Function

**Function Description**: Convert byte data to base64-encoded string.

**Import Method**:
```python
from pdfplumber.convert import to_b64
```

**Function Signature**:
```python
def to_b64(data: bytes) -> str
```

**Parameters**:
- `data`: Byte data to encode

**Return Value**:
- Returns base64-encoded ASCII string

**Example**:
```python
from pdfplumber.convert import to_b64

# Encode binary data
encoded = to_b64(b"Hello World")
print(encoded)  # 'SGVsbG8gV29ybGQ='
```

---

#### 40. tuplify_list_kwargs Function

**Function Description**: Convert list values in kwargs dictionary to tuples.

**Import Method**:
```python
from pdfplumber.page import tuplify_list_kwargs
```

**Function Signature**:
```python
def tuplify_list_kwargs(kwargs: Dict[str, Any]) -> Dict[str, Any]
```

**Parameters**:
- `kwargs`: Dictionary of keyword arguments

**Return Value**:
- Returns dictionary with list values converted to tuples

---

#### 41. test_proposed_bbox Function

**Function Description**: Validate that a proposed bounding box is valid and within its parent bounding box.

**Import Method**:
```python
from pdfplumber.page import test_proposed_bbox
```

**Function Signature**:
```python
def test_proposed_bbox(bbox: T_bbox, parent_bbox: T_bbox) -> None
```

**Parameters**:
- `bbox`: Bounding box to validate (x0, top, x1, bottom)
- `parent_bbox`: Parent bounding box that must contain the proposed bbox

**Return Value**:
- Returns None; raises ValueError if bbox is invalid

---

#### 42. get_page_image Function

**Function Description**: Render a PDF page as a PIL Image using pypdfium2.

**Import Method**:
```python
from pdfplumber.display import get_page_image
```

**Function Signature**:
```python
def get_page_image(
    stream: Union[BufferedReader, BytesIO],
    path: Optional[pathlib.Path],
    page_ix: int,
    resolution: Union[int, float],
    password: Optional[str],
    antialias: bool = False
) -> PIL.Image.Image
```

**Parameters**:
- `stream`: PDF file stream
- `path`: Path to PDF file (if available)
- `page_ix`: Zero-indexed page number
- `resolution`: Resolution in DPI for rendering
- `password`: PDF password (if required)
- `antialias`: Whether to apply antialiasing

**Return Value**:
- Returns PIL Image object of the rendered page

---

#### 43. parse_page_spec Function

**Function Description**: Parse page specification string from command line (e.g., "1-5" or "3").

**Import Method**:
```python
from pdfplumber.cli import parse_page_spec
```

**Function Signature**:
```python
def parse_page_spec(p_str: str) -> List[int]
```

**Parameters**:
- `p_str`: Page specification string (e.g., "1", "1-5")

**Return Value**:
- Returns list of page numbers

**Example**:
```python
from pdfplumber.cli import parse_page_spec

pages = parse_page_spec("1-3")  # Returns [1, 2, 3]
pages = parse_page_spec("5")     # Returns [5]
```

---

#### 44. parse_args Function

**Function Description**: Parse command line arguments for pdfplumber CLI.

**Import Method**:
```python
from pdfplumber.cli import parse_args
```

**Function Signature**:
```python
def parse_args(args_raw: List[str]) -> argparse.Namespace
```

**Parameters**:
- `args_raw`: Raw command line arguments

**Return Value**:
- Returns parsed arguments as argparse.Namespace object

---

#### 45. add_text_to_mcids Function

**Function Description**: Add extracted text content to structure tree elements based on their MCID (Marked Content ID) values.

**Import Method**:
```python
from pdfplumber.cli import add_text_to_mcids
```

**Function Signature**:
```python
def add_text_to_mcids(pdf: PDF, data: List[Dict[str, Any]]) -> None
```

**Parameters**:
- `pdf`: PDF object
- `data`: Structure tree data

**Return Value**:
- Returns None; modifies data in-place

---

#### 46. snap_edges Function

**Function Description**: Snap edges that are within tolerance distance to their average position.

**Import Method**:
```python
from pdfplumber.table import snap_edges
```

**Function Signature**:
```python
def snap_edges(
    edges: T_obj_list,
    x_tolerance: T_num = DEFAULT_SNAP_TOLERANCE,
    y_tolerance: T_num = DEFAULT_SNAP_TOLERANCE
) -> T_obj_list
```

**Parameters**:
- `edges`: List of edge objects
- `x_tolerance`: Horizontal snap tolerance (default: 3)
- `y_tolerance`: Vertical snap tolerance (default: 3)

**Return Value**:
- Returns list of snapped edges

---

#### 47. join_edge_group Function

**Function Description**: Join edges along the same infinite line that are within tolerance distance.

**Import Method**:
```python
from pdfplumber.table import join_edge_group
```

**Function Signature**:
```python
def join_edge_group(
    edges: T_obj_iter,
    orientation: str,
    tolerance: T_num = DEFAULT_JOIN_TOLERANCE
) -> T_obj_list
```

**Parameters**:
- `edges`: Iterator of edge objects
- `orientation`: Edge orientation ("h" for horizontal, "v" for vertical)
- `tolerance`: Join tolerance distance (default: 3)

**Return Value**:
- Returns list of joined edges

---

#### 48. merge_edges Function

**Function Description**: Merge edges using snap and join operations to create seamless edge list.

**Import Method**:
```python
from pdfplumber.table import merge_edges
```

**Function Signature**:
```python
def merge_edges(
    edges: T_obj_list,
    snap_x_tolerance: T_num,
    snap_y_tolerance: T_num,
    join_x_tolerance: T_num,
    join_y_tolerance: T_num
) -> T_obj_list

    # Nested helper function defined inside merge_edges:
    def get_group(edge: T_obj) -> Tuple[str, T_num]
```

**Parameters**:
- `edges`: List of edge objects
- `snap_x_tolerance`: Horizontal snap tolerance
- `snap_y_tolerance`: Vertical snap tolerance
- `join_x_tolerance`: Horizontal join tolerance
- `join_y_tolerance`: Vertical join tolerance

**Return Value**:
- Returns list of merged edges

**Nested Functions**:

*get_group*:
- **Parameter**: `edge` (T_obj) - Edge object with orientation and position attributes
- **Return**: Tuple[str, T_num] - Tuple of (orientation, position) for grouping

---

#### 49. words_to_edges_h Function

**Function Description**: Generate imaginary horizontal edges connecting the tops of word clusters.

**Import Method**:
```python
from pdfplumber.table import words_to_edges_h
```

**Function Signature**:
```python
def words_to_edges_h(
    words: T_obj_list,
    word_threshold: int = DEFAULT_MIN_WORDS_HORIZONTAL
) -> T_obj_list
```

**Parameters**:
- `words`: List of word objects
- `word_threshold`: Minimum number of words required to form an edge (default: 1)

**Return Value**:
- Returns list of horizontal edge objects

---

#### 50. words_to_edges_v Function

**Function Description**: Generate imaginary vertical edges connecting the left/right/center of word clusters.

**Import Method**:
```python
from pdfplumber.table import words_to_edges_v
```

**Function Signature**:
```python
def words_to_edges_v(
    words: T_obj_list,
    word_threshold: int = DEFAULT_MIN_WORDS_VERTICAL
) -> T_obj_list

    # Nested helper function defined inside words_to_edges_v:
    def get_center(word: T_obj) -> T_num
```

**Parameters**:
- `words`: List of word objects
- `word_threshold`: Minimum number of words required to form an edge (default: 3)

**Return Value**:
- Returns list of vertical edge objects

**Nested Functions**:

*get_center*:
- **Parameter**: `word` (T_obj) - Word object with x0 and x1 attributes
- **Return**: T_num - Center x-coordinate as float

---

#### 51. edges_to_intersections Function

**Function Description**: Find all intersection points where horizontal and vertical edges meet.

**Import Method**:
```python
from pdfplumber.table import edges_to_intersections
```

**Function Signature**:
```python
def edges_to_intersections(
    edges: T_obj_list,
    x_tolerance: T_num = 1,
    y_tolerance: T_num = 1
) -> T_intersections
```

**Parameters**:
- `edges`: List of edge objects
- `x_tolerance`: Horizontal intersection tolerance (default: 1)
- `y_tolerance`: Vertical intersection tolerance (default: 1)

**Return Value**:
- Returns dictionary mapping intersection points to their edges

---

#### 52. intersections_to_cells Function

**Function Description**: Convert intersection points into rectangular table cells.

**Import Method**:
```python
from pdfplumber.table import intersections_to_cells
```

**Function Signature**:
```python
def intersections_to_cells(intersections: T_intersections) -> List[T_bbox]

    # Nested helper functions defined inside intersections_to_cells:
    def edge_connects(p1: T_point, p2: T_point) -> bool
    def edges_to_set(edges: T_obj_list) -> Set[T_bbox]
    def find_smallest_cell(points: List[T_point], i: int) -> Optional[T_bbox]
```

**Parameters**:
- `intersections`: Dictionary of intersection points with their edges

**Return Value**:
- Returns list of cell bounding boxes

**Nested Functions**:

*edge_connects*:
- **Parameters**: `p1` (T_point) - First intersection point (x, y); `p2` (T_point) - Second intersection point (x, y)
- **Return**: bool - True if points are connected by vertical or horizontal edge

*edges_to_set*:
- **Parameter**: `edges` (T_obj_list) - List of edge objects
- **Return**: Set[T_bbox] - Set of bounding box tuples

*find_smallest_cell*:
- **Parameters**: `points` (List[T_point]) - List of all intersection points; `i` (int) - Index of starting point
- **Return**: Optional[T_bbox] - Bounding box of cell or None if no cell found

---

#### 53. cells_to_tables Function

**Function Description**: Group cells into contiguous tables.

**Import Method**:
```python
from pdfplumber.table import cells_to_tables
```

**Function Signature**:
```python
def cells_to_tables(cells: List[T_bbox]) -> List[List[T_bbox]]

    # Nested helper function defined inside cells_to_tables:
    def bbox_to_corners(bbox: T_bbox) -> Tuple[T_point, T_point, T_point, T_point]
```

**Parameters**:
- `cells`: List of cell bounding boxes

**Return Value**:
- Returns list of tables, where each table is a list of cell bounding boxes

**Nested Functions**:

*bbox_to_corners*:
- **Parameter**: `bbox` (T_bbox) - Bounding box (x0, top, x1, bottom)
- **Return**: Tuple[T_point, T_point, T_point, T_point] - Four corner points (top-left, bottom-left, top-right, bottom-right)

---

#### 54. cluster_list Function

**Function Description**: Cluster a list of numbers into groups based on tolerance distance.

**Import Method**:
```python
from pdfplumber.utils.clustering import cluster_list
```

**Function Signature**:
```python
def cluster_list(xs: List[T_num], tolerance: T_num = 0) -> List[List[T_num]]
```

**Parameters**:
- `xs`: List of numeric values
- `tolerance`: Maximum distance between values in same cluster (default: 0)

**Return Value**:
- Returns list of clusters, where each cluster is a list of numbers

**Example**:
```python
from pdfplumber.utils.clustering import cluster_list

values = [1, 2, 10, 11, 20]
clusters = cluster_list(values, tolerance=2)
# Returns [[1, 2], [10, 11], [20]]
```

---

#### 55. make_cluster_dict Function

**Function Description**: Create a dictionary mapping each value to its cluster index.

**Import Method**:
```python
from pdfplumber.utils.clustering import make_cluster_dict
```

**Function Signature**:
```python
def make_cluster_dict(values: Iterable[T_num], tolerance: T_num) -> Dict[T_num, int]
```

**Parameters**:
- `values`: Iterable of numeric values
- `tolerance`: Maximum distance between values in same cluster

**Return Value**:
- Returns dictionary mapping each unique value to its cluster index

---

#### 56. cluster_objects Function

**Function Description**: Cluster objects based on a key function and tolerance.

**Import Method**:
```python
from pdfplumber.utils.clustering import cluster_objects
```

**Function Signature**:
```python
def cluster_objects(
    xs: List[Clusterable],
    key_fn: Union[Hashable, Callable[[Clusterable], T_num]],
    tolerance: T_num,
    preserve_order: bool = False
) -> List[List[Clusterable]]
```

**Parameters**:
- `xs`: List of objects to cluster
- `key_fn`: Function to extract clustering key or attribute name
- `tolerance`: Maximum distance between objects in same cluster
- `preserve_order`: Whether to preserve original order (default: False)

**Return Value**:
- Returns list of clusters, where each cluster is a list of objects

---

#### 57. to_list Function

**Function Description**: Convert various collection types to a standard Python list.

**Import Method**:
```python
from pdfplumber.utils.generic import to_list
```

**Function Signature**:
```python
def to_list(collection: Union[T_seq[Any], "DataFrame"]) -> List[Any]
```

**Parameters**:
- `collection`: Sequence, list, DataFrame, or other iterable

**Return Value**:
- Returns standard Python list

---

#### 58. get_line_cluster_key Function

**Function Description**: Get the key function for clustering text lines based on direction.

**Import Method**:
```python
from pdfplumber.utils.text import get_line_cluster_key
```

**Function Signature**:
```python
def get_line_cluster_key(line_dir: T_dir) -> Callable[[T_obj], T_num]
```

**Parameters**:
- `line_dir`: Line direction ("ttb", "btt", "ltr", or "rtl")

**Return Value**:
- Returns function that extracts appropriate position key from object

---

#### 59. get_char_sort_key Function

**Function Description**: Get the key function for sorting characters based on direction.

**Import Method**:
```python
from pdfplumber.utils.text import get_char_sort_key
```

**Function Signature**:
```python
def get_char_sort_key(char_dir: T_dir) -> Callable[[T_obj], Tuple[T_num, T_num]]
```

**Parameters**:
- `char_dir`: Character direction ("ttb", "btt", "ltr", or "rtl")

**Return Value**:
- Returns function that extracts appropriate sort keys from object

---

#### 60. validate_directions Function

**Function Description**: Validate that line and character directions are compatible.

**Import Method**:
```python
from pdfplumber.utils.text import validate_directions
```

**Function Signature**:
```python
def validate_directions(line_dir: T_dir, char_dir: T_dir, suffix: str = "") -> None
```

**Parameters**:
- `line_dir`: Line direction
- `char_dir`: Character direction
- `suffix`: Suffix for error messages (default: "")

**Return Value**:
- Returns None; raises ValueError if directions are invalid

---

#### 61. chars_to_textmap Function

**Function Description**: Convert character objects to a TextMap with layout information.

**Import Method**:
```python
from pdfplumber.utils.text import chars_to_textmap
```

**Function Signature**:
```python
def chars_to_textmap(chars: T_obj_list, **kwargs: Any) -> TextMap
```

**Parameters**:
- `chars`: List of character objects
- `**kwargs`: Additional parameters for WordExtractor and WordMap.to_textmap

**Return Value**:
- Returns TextMap object

---

#### 62. collate_line Function

**Function Description**: Collate characters in a line into a single string, adding spaces based on x-position gaps.

**Import Method**:
```python
from pdfplumber.utils.text import collate_line
```

**Function Signature**:
```python
def collate_line(
    line_chars: T_obj_list,
    tolerance: T_num = DEFAULT_X_TOLERANCE
) -> str
```

**Parameters**:
- `line_chars`: List of character objects in a line
- `tolerance`: Horizontal distance tolerance for adding spaces (default: 3)

**Return Value**:
- Returns collated string

---

#### 63. extract_text_simple Function

**Function Description**: Extract text from characters using simple clustering without advanced layout analysis.

**Import Method**:
```python
from pdfplumber.utils.text import extract_text_simple
```

**Function Signature**:
```python
def extract_text_simple(
    chars: T_obj_list,
    x_tolerance: T_num = DEFAULT_X_TOLERANCE,
    y_tolerance: T_num = DEFAULT_Y_TOLERANCE
) -> str
```

**Parameters**:
- `chars`: List of character objects
- `x_tolerance`: Horizontal tolerance for word spacing (default: 3)
- `y_tolerance`: Vertical tolerance for line grouping (default: 3)

**Return Value**:
- Returns extracted text as string

---

#### 64. dedupe_chars Function

**Function Description**: Remove duplicate characters that share the same text and positioning within tolerance distance.

**Import Method**:
```python
from pdfplumber.utils.text import dedupe_chars
```

**Function Signature**:
```python
def dedupe_chars(
    chars: T_obj_list,
    tolerance: T_num = 1,
    extra_attrs: Optional[Tuple[str, ...]] = ("fontname", "size")
) -> T_obj_list

    # Nested helper function defined inside dedupe_chars:
    def yield_unique_chars(chars: T_obj_list) -> Generator[T_obj, None, None]
```

**Parameters**:
- `chars`: List of character objects
- `tolerance`: Maximum distance between characters to be considered duplicates (default: 1)
- `extra_attrs`: Additional attributes to match for deduplication (default: ("fontname", "size"))

**Return Value**:
- Returns list of deduplicated character objects

**Nested Functions**:

*yield_unique_chars*:
- **Parameter**: `chars` (T_obj_list) - List of character objects
- **Return**: Generator[T_obj, None, None] - Yields unique character objects after clustering and deduplication

**Example**:
```python
from pdfplumber.utils.text import dedupe_chars

# Remove duplicate characters
unique_chars = dedupe_chars(page.chars, tolerance=1)

# Deduplicate with additional attributes
unique_chars = dedupe_chars(page.chars, tolerance=2, extra_attrs=("fontname", "size", "upright"))
```

---

#### 65. objects_to_rect Function

**Function Description**: Find the smallest rectangle containing all given objects.

**Import Method**:
```python
from pdfplumber.utils.geometry import objects_to_rect
```

**Function Signature**:
```python
def objects_to_rect(objects: Iterable[T_obj]) -> Dict[str, T_num]
```

**Parameters**:
- `objects`: Iterable of PDF objects

**Return Value**:
- Returns dictionary with keys "x0", "top", "x1", "bottom"

---

#### 66. objects_to_bbox Function

**Function Description**: Find the smallest bounding box containing all given objects.

**Import Method**:
```python
from pdfplumber.utils.geometry import objects_to_bbox
```

**Function Signature**:
```python
def objects_to_bbox(objects: Iterable[T_obj]) -> T_bbox
```

**Parameters**:
- `objects`: Iterable of PDF objects

**Return Value**:
- Returns bounding box tuple (x0, top, x1, bottom)

---

#### 67. obj_to_bbox Function

**Function Description**: Extract the bounding box from a single object.

**Import Method**:
```python
from pdfplumber.utils.geometry import obj_to_bbox
```

**Function Signature**:
```python
def obj_to_bbox(obj: T_obj) -> T_bbox
```

**Parameters**:
- `obj`: PDF object dictionary

**Return Value**:
- Returns bounding box tuple (x0, top, x1, bottom)

---

#### 68. bbox_to_rect Function

**Function Description**: Convert a bounding box tuple to a rectangle dictionary.

**Import Method**:
```python
from pdfplumber.utils.geometry import bbox_to_rect
```

**Function Signature**:
```python
def bbox_to_rect(bbox: T_bbox) -> Dict[str, T_num]
```

**Parameters**:
- `bbox`: Bounding box tuple (x0, top, x1, bottom)

**Return Value**:
- Returns dictionary with keys "x0", "top", "x1", "bottom"

---

#### 69. merge_bboxes Function

**Function Description**: Merge multiple bounding boxes into the smallest containing bounding box.

**Import Method**:
```python
from pdfplumber.utils.geometry import merge_bboxes
```

**Function Signature**:
```python
def merge_bboxes(bboxes: Iterable[T_bbox]) -> T_bbox
```

**Parameters**:
- `bboxes`: Iterable of bounding box tuples

**Return Value**:
- Returns merged bounding box tuple (x0, top, x1, bottom)

---

#### 70. get_bbox_overlap Function

**Function Description**: Calculate the overlapping region between two bounding boxes.

**Import Method**:
```python
from pdfplumber.utils.geometry import get_bbox_overlap
```

**Function Signature**:
```python
def get_bbox_overlap(a: T_bbox, b: T_bbox) -> Optional[T_bbox]
```

**Parameters**:
- `a`: First bounding box
- `b`: Second bounding box

**Return Value**:
- Returns overlapping bounding box or None if no overlap

---

#### 71. calculate_area Function

**Function Description**: Calculate the area of a bounding box.

**Import Method**:
```python
from pdfplumber.utils.geometry import calculate_area
```

**Function Signature**:
```python
def calculate_area(bbox: T_bbox) -> T_num
```

**Parameters**:
- `bbox`: Bounding box tuple (x0, top, x1, bottom)

**Return Value**:
- Returns area as numeric value

---

#### 72. clip_obj Function

**Function Description**: Clip an object to a bounding box, adjusting its dimensions.

**Import Method**:
```python
from pdfplumber.utils.geometry import clip_obj
```

**Function Signature**:
```python
def clip_obj(obj: T_obj, bbox: T_bbox) -> Optional[T_obj]
```

**Parameters**:
- `obj`: PDF object to clip
- `bbox`: Bounding box to clip to

**Return Value**:
- Returns clipped object or None if no overlap

---

#### 73. intersects_bbox Function

**Function Description**: Filter objects that intersect with a bounding box.

**Import Method**:
```python
from pdfplumber.utils.geometry import intersects_bbox
```
    
**Function Signature**:
```python
def intersects_bbox(objs: Iterable[T_obj], bbox: T_bbox) -> T_obj_list
```

**Parameters**:
- `objs`: Iterable of PDF objects
- `bbox`: Bounding box to test intersection with

**Return Value**:
- Returns list of objects that intersect the bbox

---

#### 74. outside_bbox Function

**Function Description**: Filter objects that are completely outside a bounding box.

**Import Method**:
```python
from pdfplumber.utils.geometry import outside_bbox
```

**Function Signature**:
```python
def outside_bbox(objs: Iterable[T_obj], bbox: T_bbox) -> T_obj_list
```

**Parameters**:
- `objs`: Iterable of PDF objects
- `bbox`: Bounding box to test against

**Return Value**:
- Returns list of objects completely outside the bbox

---

#### 75. crop_to_bbox Function

**Function Description**: Filter and crop objects to a bounding box.

**Import Method**:
```python
from pdfplumber.utils.geometry import crop_to_bbox
```

**Function Signature**:
```python
def crop_to_bbox(objs: Iterable[T_obj], bbox: T_bbox) -> T_obj_list
```

**Parameters**:
- `objs`: Iterable of PDF objects
- `bbox`: Bounding box to crop to

**Return Value**:
- Returns list of cropped objects

---

#### 76. move_object Function

**Function Description**: Move an object along horizontal or vertical axis.

**Import Method**:
```python
from pdfplumber.utils.geometry import move_object
```

**Function Signature**:
```python
def move_object(obj: T_obj, axis: str, value: T_num) -> T_obj
```

**Parameters**:
- `obj`: PDF object to move
- `axis`: Movement axis ("h" for horizontal, "v" for vertical)
- `value`: Distance to move

**Return Value**:
- Returns moved object

---

#### 77. snap_objects Function

**Function Description**: Snap objects to their average position for a given attribute.

**Import Method**:
```python
from pdfplumber.utils.geometry import snap_objects
```

**Function Signature**:
```python
def snap_objects(objs: Iterable[T_obj], attr: str, tolerance: T_num) -> T_obj_list
```

**Parameters**:
- `objs`: Iterable of PDF objects
- `attr`: Attribute name to snap ("x0", "x1", "top", or "bottom")
- `tolerance`: Maximum distance for snapping

**Return Value**:
- Returns list of snapped objects

---

#### 78. resize_object Function

**Function Description**: Resize an object by changing one of its boundary coordinates.

**Import Method**:
```python
from pdfplumber.utils.geometry import resize_object
```

**Function Signature**:
```python
def resize_object(obj: T_obj, key: str, value: T_num) -> T_obj
```

**Parameters**:
- `obj`: PDF object to resize
- `key`: Boundary key to modify ("x0", "x1", "top", or "bottom")
- `value`: New value for the boundary

**Return Value**:
- Returns resized object

---

#### 79. curve_to_edges Function

**Function Description**: Convert a curve object into its constituent edge segments.

**Import Method**:
```python
from pdfplumber.utils.geometry import curve_to_edges
```

**Function Signature**:
```python
def curve_to_edges(curve: T_obj) -> T_obj_list
```

**Parameters**:
- `curve`: Curve object with "pts" attribute

**Return Value**:
- Returns list of edge objects

---

#### 80. rect_to_edges Function

**Function Description**: Convert a rectangle into its four edge objects (top, bottom, left, right).

**Import Method**:
```python
from pdfplumber.utils.geometry import rect_to_edges
```

**Function Signature**:
```python
def rect_to_edges(rect: T_obj) -> T_obj_list
```

**Parameters**:
- `rect`: Rectangle object

**Return Value**:
- Returns list of four edge objects

---

#### 81. line_to_edge Function

**Function Description**: Convert a line object to an edge object with orientation.

**Import Method**:
```python
from pdfplumber.utils.geometry import line_to_edge
```

**Function Signature**:
```python
def line_to_edge(line: T_obj) -> T_obj
```

**Parameters**:
- `line`: Line object

**Return Value**:
- Returns edge object with "orientation" attribute added

---

#### 82. obj_to_edges Function

**Function Description**: Convert any object type (line, rect, curve) to edge objects.

**Import Method**:
```python
from pdfplumber.utils.geometry import obj_to_edges
```

**Function Signature**:
```python
def obj_to_edges(obj: T_obj) -> T_obj_list
```

**Parameters**:
- `obj`: PDF object (line, rect, curve, or edge)

**Return Value**:
- Returns list of edge objects

---

#### 83. filter_edges Function

**Function Description**: Filter edges by orientation, type, and minimum length.

**Import Method**:
```python
from pdfplumber.utils.geometry import filter_edges
```

**Function Signature**:
```python
def filter_edges(
    edges: Iterable[T_obj],
    orientation: Optional[str] = None,
    edge_type: Optional[str] = None,
    min_length: T_num = 1
) -> T_obj_list
```

**Parameters**:
- `edges`: Iterable of edge objects
- `orientation`: Filter by orientation ("v" or "h", optional)
- `edge_type`: Filter by edge type (optional)
- `min_length`: Minimum edge length (default: 1)

**Return Value**:
- Returns filtered list of edge objects

---

#### 84. decode_psl_list Function

**Function Description**: Decode a list of PSLiteral and string values to strings.

**Import Method**:
```python
from pdfplumber.utils.pdfinternals import decode_psl_list
```

**Function Signature**:
```python
def decode_psl_list(_list: List[Union[PSLiteral, str]]) -> List[str]
```

**Parameters**:
- `_list`: List of PSLiteral objects or strings

**Return Value**:
- Returns list of decoded strings

---

#### 85. get_dict_type Function

**Function Description**: Get the Type attribute from a PDF dictionary object.

**Import Method**:
```python
from pdfplumber.utils.pdfinternals import get_dict_type
```

**Function Signature**:
```python
def get_dict_type(d: Any) -> Optional[str]
```

**Parameters**:
- `d`: Dictionary object (potentially from PDF)

**Return Value**:
- Returns type string or None if not a dict or no Type attribute

---

#### 86. resolve_and_decode Function

**Import Method**:
```python
from pdfplumber.utils.pdfinternals import resolve_and_decode
```

**Function Description**: Recursively resolve and decode PDF metadata values.

**Function Signature**:
```python
def resolve_and_decode(obj: Any) -> Any
```

**Parameters**:
- `obj`: PDF object to resolve and decode (can be PDFObjRef, list, dict, PSLiteral, or primitive)

**Return Value**:
- Returns decoded value (str for text, list for arrays, dict for dictionaries, original value for primitives)

**Features**:
- Resolves PDFObjRef references
- Decodes PSLiteral objects to strings
- Recursively processes lists and dictionaries
- Handles byte strings and regular strings

**Example**:
```python
from pdfplumber.utils.pdfinternals import resolve_and_decode

# Used internally to decode PDF metadata
metadata_value = pdf.doc.info[0]['Author']
decoded = resolve_and_decode(metadata_value)
```

---

#### 87. resolve_all Function

**Import Method**:
```python
from pdfplumber.utils.pdfinternals import resolve_all
```

**Function Description**: Recursively resolve all PDF object references and internal structures.

**Function Signature**:
```python
def resolve_all(x: Any) -> Any
```

**Parameters**:
- `x`: PDF object to recursively resolve

**Return Value**:
- Returns fully resolved object with all references expanded

**Features**:
- Recursively resolves PDFObjRef objects
- Avoids infinite recursion for Page objects
- Preserves Parent references in Annot objects
- Handles lists, tuples, and dictionaries recursively
- Raises MalformedPDFException on recursion errors

**Example**:
```python
from pdfplumber.utils.pdfinternals import resolve_all

# Resolve nested PDF structures
resolved = resolve_all(pdf_obj)
```

---

#### 88. main Function

**Import Method**:
```python
from pdfplumber.cli import main
```

**Function Description**: Main entry point for the pdfplumber command-line interface.

**Function Signature**:
```python
def main(args_raw: List[str] = sys.argv[1:]) -> None
```

**Parameters**:
- `args_raw`: List of command-line arguments (default: sys.argv[1:])

**Return Value**:
- Returns None; outputs result to stdout or specified file

**Features**:
- Opens PDF file specified in arguments
- Supports multiple output formats (CSV, JSON, text)
- Handles structure tree extraction
- Processes pages according to --pages parameter
- Applies laparams and other settings

**Example**:
```python
from pdfplumber.cli import main

# Run CLI programmatically
main(["document.pdf", "--format", "csv"])
```

---

#### 89. _open Function (Internal)

**Function Description**: Internal helper function in setup.py to open files with UTF-8 encoding.

**Note**: This is an internal function used only in setup.py and not intended for public use.

**Import Method** (Not recommended):
```python
# This function is in setup.py, not part of the installed package
# Cannot be imported in normal usage
```

**Function Signature**:
```python
def _open(subpath):
    path = os.path.join(HERE, subpath)
    return open(path, encoding="utf-8")
```

**Parameters**:
- `subpath`: Relative path to file within the package directory

**Return Value**:
- Returns file object opened with UTF-8 encoding

---

#### 90. _repair Function (Internal)

**Function Description**: Internal implementation of PDF repair functionality using Ghostscript.

**Note**: This is an internal function. Use the public `repair` function instead.

**Import Method** (Not recommended - use `repair` instead):
```python
from pdfplumber.repair import _repair
```

**Function Signature**:
```python
def _repair(
    path_or_fp: Union[str, pathlib.Path, BufferedReader, BytesIO],
    password: Optional[str] = None,
    gs_path: Optional[Union[str, pathlib.Path]] = None,
    setting: T_repair_setting = "default"
) -> BytesIO
```

**Parameters**:
- `path_or_fp`: Input PDF path or file object
- `password`: PDF password (if required)
- `gs_path`: Ghostscript path (if not in system PATH)
- `setting`: Repair quality setting

**Return Value**:
- Returns BytesIO object containing repaired PDF data

---

#### 91. _normalize_box Function (Internal)

**Function Description**: Normalize a bounding box by ensuring coordinates are in correct order and handling rotation.

**Note**: This is an internal function used by the Page class.

**Import Method** (Not recommended):
```python
from pdfplumber.page import _normalize_box
```

**Function Signature**:
```python
def _normalize_box(box_raw: T_bbox, rotation: T_num = 0) -> T_bbox
```

**Parameters**:
- `box_raw`: Raw bounding box coordinates (x0, y0, x1, y1)
- `rotation`: Rotation angle in degrees (default: 0)

**Return Value**:
- Returns normalized bounding box (x0, y0, x1, y1)

**Features**:
- Ensures x0 < x1 and y0 < y1
- Handles 90 and 270 degree rotations
- Validates that all coordinates are numeric

---

#### 92. _invert_box Function (Internal)

**Function Description**: Invert a bounding box vertically to convert between PDF coordinate system (origin at bottom-left) and pdfplumber coordinate system (origin at top-left).

**Note**: This is an internal function used by the Page class.

**Import Method** (Not recommended):
```python
from pdfplumber.page import _invert_box
```

**Function Signature**:
```python
def _invert_box(box_raw: T_bbox, mb_height: T_num) -> T_bbox
```

**Parameters**:
- `box_raw`: Bounding box to invert (x0, y0, x1, y1)
- `mb_height`: MediaBox height for coordinate transformation

**Return Value**:
- Returns inverted bounding box (x0, top, x1, bottom)

---

#### 93. _find_all Function (Internal)

**Function Description**: Internal implementation for finding all matching structure elements in a PDF structure tree.

**Note**: This is used by PDFStructTree.find_all() and PDFStructElement.find_all() methods.

**Import Method** (Not recommended - use PDFStructTree.find_all() instead):
```python
from pdfplumber.structure import _find_all
```

**Function Signature**:
```python
def _find_all(
    elements: Iterable["PDFStructElement"],
    matcher: Union[str, Pattern[str], MatchFunc]
) -> Iterator["PDFStructElement"]

    # Nested helper functions defined inside _find_all:
    def match_tag(x: "PDFStructElement") -> bool
    def match_regex(x: "PDFStructElement") -> bool
```

**Parameters**:
- `elements`: Iterable of PDFStructElement objects
- `matcher`: String, regex pattern, or matching function

**Return Value**:
- Returns iterator of matching PDFStructElement objects

**Nested Functions**:

*match_tag*:
- **Parameter**: `x` (PDFStructElement) - Element to test
- **Return**: bool - True if element type matches the target tag

*match_regex*:
- **Parameter**: `x` (PDFStructElement) - Element to test  
- **Return**: bool - True if element type matches the regex pattern

---

#### 94. HERE

**Import Method**:
```python
# Note: This is in setup.py, not part of the installed package
```

**Description**: Directory path constant pointing to the package root directory.

**Module**: `setup.py`

**Value**:
```python
HERE = os.path.abspath(os.path.dirname(__file__))
```

**Usage**: Used in setup.py to locate package files for reading version and README.

---

#### 95. NAME

**Description**: Package name constant used in setup.py.

**Module**: `setup.py`

**Value**: `"pdfplumber"`

---

#### 96. ENCODINGS_TO_TRY

**Description**: List of character encodings to attempt when decoding PDF text.

**Module**: `pdfplumber.convert`

**Value**:
```python
["utf-8", "latin-1", "utf-16", "utf-16le"]
```

---

#### 97. CSV_COLS_REQUIRED

**Description**: Required columns when exporting PDF objects to CSV format.

**Module**: `pdfplumber.convert`

**Value**:
```python
["object_type"]
```

---

#### 98. CSV_COLS_TO_PREPEND

**Description**: Columns to prepend at the beginning of CSV export.

**Module**: `pdfplumber.convert`

**Value**:
```python
["page_number", "x0", "x1", "y0", "y1", "top", "bottom", "doctop", "width", "height"]
```

---

#### 99. ALL_ATTRS

**Description**: Set of all possible PDF object attributes.

**Module**: `pdfplumber.page`

**Value**: Set containing attributes like "adv", "height", "width", "x0", "x1", "y0", "y1", "top", "bottom", "doctop", "linewidth", "stroking_color", "non_stroking_color", "object_type", "page_number", "text", "fontname", "size", "upright", "direction", "chars", "matrix", "mcid", "tag", "pts", "path", "fill", "evenodd", "stroke", "orientation", "dash", "srcsize", "colorspace", "bits", "imagemask", "data", "stream", "file", "uri", "title", "contents", "page_height", "page_width"

---

#### 100. CP936_FONTNAMES

**Description**: Mapping of CP936 (Chinese GBK) encoded font names to their Unicode equivalents.

**Module**: `pdfplumber.page`

**Value**: Dictionary mapping binary font name encodings to standard font names (e.g., SimSun, SimHei, SimKai, etc.)

---

#### 101. DEFAULT_FILL

**Description**: Default fill color for drawing objects in visualization.

**Module**: `pdfplumber.display`

**Value**: `COLORS.BLUE + (50,)` - Blue color with 50 alpha transparency

---

#### 102. DEFAULT_STROKE

**Description**: Default stroke color for drawing objects in visualization.

**Module**: `pdfplumber.display`

**Value**: `COLORS.RED + (200,)` - Red color with 200 alpha transparency

---

#### 103. DEFAULT_STROKE_WIDTH

**Description**: Default stroke width for drawing objects in visualization.

**Module**: `pdfplumber.display`

**Value**: `1`

---

#### 104. TABLE_STRATEGIES

**Description**: Available strategies for table detection.

**Module**: `pdfplumber.table`

**Value**:
```python
["lines", "lines_strict", "text", "explicit"]
```

**Strategy Descriptions**:
- `"lines"`: Use line objects to detect table boundaries
- `"lines_strict"`: Stricter version of lines strategy
- `"text"`: Use text positioning to infer table structure
- `"explicit"`: User-defined explicit table boundaries

---

#### 105. NON_NEGATIVE_SETTINGS

**Description**: List of TableSettings parameters that must be non-negative.

**Module**: `pdfplumber.table`

**Value**:
```python
["snap_tolerance", "snap_x_tolerance", "snap_y_tolerance", "join_tolerance", 
 "join_x_tolerance", "join_y_tolerance", "edge_min_length", "min_words_vertical", 
 "min_words_horizontal", "intersection_tolerance", "intersection_x_tolerance", 
 "intersection_y_tolerance", "text_tolerance", "text_x_tolerance", "text_y_tolerance"]
```

---

#### 106. DEFAULT_RESOLUTION

**Import Method**:
```python
from pdfplumber.display import DEFAULT_RESOLUTION
```

**Description**: Default resolution in DPI for rendering PDF pages to images.

**Value**: `72`

**Module**: `pdfplumber.display`

**Usage**: Used as default resolution when calling `Page.to_image()` without specifying resolution parameter.

---

#### 107. DEFAULT_SNAP_TOLERANCE

**Import Method**:
```python
from pdfplumber.table import DEFAULT_SNAP_TOLERANCE
```

**Description**: Default tolerance for snapping nearby edges to their average position.

**Value**: `3`

**Module**: `pdfplumber.table`

**Usage**: Used in table detection to align edges that are within this distance of each other.

---

#### 108. DEFAULT_JOIN_TOLERANCE

**Import Method**:
```python
from pdfplumber.table import DEFAULT_JOIN_TOLERANCE
```

**Description**: Default tolerance for joining collinear edges.

**Value**: `3`

**Module**: `pdfplumber.table`

**Usage**: Used in table detection to connect edges along the same line that are within this distance.

---

#### 109. DEFAULT_MIN_WORDS_VERTICAL

**Import Method**:
```python
from pdfplumber.table import DEFAULT_MIN_WORDS_VERTICAL
```

**Description**: Default minimum number of words required to form a vertical table edge when using text strategy.

**Value**: `3`

**Module**: `pdfplumber.table`

**Usage**: Used in `words_to_edges_v()` function for text-based table detection.

---

#### 110. DEFAULT_MIN_WORDS_HORIZONTAL

**Import Method**:
```python
from pdfplumber.table import DEFAULT_MIN_WORDS_HORIZONTAL
```

**Description**: Default minimum number of words required to form a horizontal table edge when using text strategy.

**Value**: `1`

**Module**: `pdfplumber.table`

**Usage**: Used in `words_to_edges_h()` function for text-based table detection.

---

#### 111. UNSET

**Import Method**:
```python
from pdfplumber.table import UNSET
```

**Description**: Special sentinel value indicating an unset tolerance parameter in TableSettings.

**Type Definition**:
```python
UNSET = UnsetFloat(0)
```

**Value**: `UnsetFloat(0)` - Instance of UnsetFloat class with value 0

**Module**: `pdfplumber.table`

**Usage**: Distinguishes between explicitly set zero values and unset (default) values in TableSettings.

---

#### 112. DEFAULT_X_TOLERANCE

**Import Method**:
```python
from pdfplumber.utils.text import DEFAULT_X_TOLERANCE
```

**Description**: Default horizontal tolerance for text extraction and word spacing.

**Value**: `3`

**Module**: `pdfplumber.utils.text`

**Usage**: Used in text extraction functions to determine when to insert spaces between characters.

---

#### 113. DEFAULT_Y_TOLERANCE

**Import Method**:
```python
from pdfplumber.utils.text import DEFAULT_Y_TOLERANCE
```

**Description**: Default vertical tolerance for text extraction and line grouping.

**Value**: `3`

**Module**: `pdfplumber.utils.text`

**Usage**: Used in text extraction functions to determine when characters belong to the same line.

---

#### 114. LIGATURES

**Description**: Dictionary mapping Unicode ligature characters to their expanded forms.

**Module**: `pdfplumber.utils.text`

**Value**:
```python
{
    "ﬀ": "ff",
    "ﬃ": "ffi",
    "ﬄ": "ffl",
    "ﬁ": "fi",
    "ﬂ": "fl",
    "ﬆ": "st",
    "ﬅ": "st",
}
```

---

#### 115. BBOX_ORIGIN_KEYS

**Description**: Mapping of text directions to itemgetter functions for bounding box origin extraction.

**Module**: `pdfplumber.utils.text`

**Value**:
```python
{
    "ttb": itemgetter(1),   # top-to-bottom: use top coordinate
    "btt": itemgetter(3),   # bottom-to-top: use bottom coordinate
    "ltr": itemgetter(0),   # left-to-right: use left coordinate
    "rtl": itemgetter(2),   # right-to-left: use right coordinate
}
```

---

#### 116. POSITION_KEYS

**Description**: Mapping of text directions to itemgetter functions for position extraction from objects.

**Module**: `pdfplumber.utils.text`

**Value**:
```python
{
    "ttb": itemgetter("top"),
    "btt": itemgetter("bottom"),
    "ltr": itemgetter("x0"),
    "rtl": itemgetter("x1"),
}
```

---

#### 117. TEXTMAP_KWARGS

**Description**: Valid keyword arguments for WordMap.to_textmap() method, extracted via introspection.

**Module**: `pdfplumber.utils.text`

**Value**: `inspect.signature(WordMap.to_textmap).parameters.keys()`

**Purpose**: Used to filter kwargs when creating TextMap objects from WordMap

---

#### 118. WORD_EXTRACTOR_KWARGS

**Description**: Valid keyword arguments for WordExtractor constructor, extracted via introspection.

**Module**: `pdfplumber.utils.text`

**Value**: `inspect.signature(WordExtractor).parameters.keys()`

**Purpose**: Used to filter kwargs when creating WordExtractor instances

---

#### 119. T_num

**Import Method**:
```python
from pdfplumber._typing import T_num
```

**Description**: Core type alias for numeric values (integers or floats).

**Type Definition**:
```python
T_num = Union[int, float]
```

**Module**: `pdfplumber._typing`

**Usage**: Used throughout pdfplumber for coordinates, dimensions, tolerances, and other numeric values.

**Example**:
```python
# Used in function signatures
def calculate_area(bbox: T_bbox) -> T_num
```

---

#### 120. T_point

**Import Method**:
```python
from pdfplumber._typing import T_point
```

**Description**: Type alias for 2D point coordinates.

**Type Definition**:
```python
T_point = Tuple[T_num, T_num]
```

**Module**: `pdfplumber._typing`

**Usage**: Represents (x, y) coordinate pairs.

**Example**:
```python
point: T_point = (100.5, 200.0)  # (x, y)
```

---

#### 121. T_bbox

**Import Method**:
```python
from pdfplumber._typing import T_bbox
```

**Description**: Type alias for bounding box coordinates.

**Type Definition**:
```python
T_bbox = Tuple[T_num, T_num, T_num, T_num]
```

**Module**: `pdfplumber._typing`

**Usage**: Represents bounding boxes as (x0, top, x1, bottom) tuples. This is the most commonly used type in pdfplumber.

**Example**:
```python
bbox: T_bbox = (100, 50, 200, 150)  # (x0, top, x1, bottom)
```

---

#### 122. T_obj

**Import Method**:
```python
from pdfplumber._typing import T_obj
```

**Description**: Type alias for PDF object dictionaries.

**Type Definition**:
```python
T_obj = Dict[str, Any]
```

**Module**: `pdfplumber._typing`

**Usage**: Represents PDF objects (chars, lines, rects, etc.) as dictionaries with string keys and various values.

**Example**:
```python
char_obj: T_obj = {
    'text': 'A',
    'x0': 100,
    'top': 50,
    'fontname': 'Helvetica',
    'size': 12
}
```

---

#### 123. T_obj_list

**Import Method**:
```python
from pdfplumber._typing import T_obj_list
```

**Description**: Type alias for lists of PDF objects.

**Type Definition**:
```python
T_obj_list = List[T_obj]
```

**Module**: `pdfplumber._typing`

**Usage**: Represents collections of PDF objects, such as all characters on a page.

**Example**:
```python
chars: T_obj_list = page.chars
lines: T_obj_list = page.lines
```

---

#### 124. T_obj_iter

**Import Method**:
```python
from pdfplumber._typing import T_obj_iter
```

**Description**: Type alias for iterables of PDF objects.

**Type Definition**:
```python
T_obj_iter = Iterable[T_obj]
```

**Module**: `pdfplumber._typing`

**Usage**: Used for function parameters that accept any iterable of objects, not just lists.

---

#### 125. T_seq

**Import Method**:
```python
from pdfplumber._typing import T_seq
```

**Description**: Type alias for sequences.

**Type Definition**:
```python
T_seq = Sequence
```

**Module**: `pdfplumber._typing`

**Usage**: Generic sequence type used for type hints.

---

#### 126. T_dir

**Import Method**:
```python
from pdfplumber._typing import T_dir
```

**Description**: Type alias for text direction specifications.

**Type Definition**:
```python
T_dir = Union[Literal["ltr"], Literal["rtl"], Literal["ttb"], Literal["btt"]]
```

**Module**: `pdfplumber._typing`

**Accepted Values**:
- `"ltr"`: Left-to-right
- `"rtl"`: Right-to-left
- `"ttb"`: Top-to-bottom
- `"btt"`: Bottom-to-top

**Usage**: Used in text extraction methods to specify character and line directions.

---

#### 127. T_repair_setting

**Import Method**:
```python
from pdfplumber.repair import T_repair_setting
```

**Description**: Type alias for PDF repair quality settings.

**Type Definition**:
```python
T_repair_setting = Literal["default", "prepress", "printer", "ebook", "screen"]
```

**Module**: `pdfplumber.repair`

**Accepted Values**:
- `"default"`: Default quality setting
- `"prepress"`: High quality for prepress
- `"printer"`: Optimized for printing
- `"ebook"`: Optimized for ebook readers
- `"screen"`: Optimized for screen viewing

**Usage**: Used in `repair()` function to specify output quality.

---

#### 128. MatchFunc

**Import Method**:
```python
from pdfplumber.structure import MatchFunc
```

**Description**: Type alias for structure element matching functions.

**Type Definition**:
```python
MatchFunc = Callable[["PDFStructElement"], bool]
```

**Module**: `pdfplumber.structure`

**Usage**: Type for custom matcher functions used in PDFStructTree.find() and find_all() methods.

**Example**:
```python
def my_matcher(element: PDFStructElement) -> bool:
    return element.type == "P" and element.lang == "en"

results = pdf_struct_tree.find_all(my_matcher)
```

---

#### 129. T_intersections

**Import Method**:
```python
from pdfplumber.table import T_intersections
```

**Description**: Type alias for table edge intersections data structure.

**Type Definition**:
```python
T_intersections = Dict[T_point, Dict[str, T_obj_list]]
```

**Module**: `pdfplumber.table`

**Usage**: Maps intersection points to dictionaries containing vertical and horizontal edges at that point.

**Structure**:
```python
{
    (x, y): {
        "v": [vertical_edge1, vertical_edge2, ...],
        "h": [horizontal_edge1, horizontal_edge2, ...]
    }
}
```

---

#### 130. Clusterable

**Import Method**:
```python
from pdfplumber.utils.clustering import Clusterable
```

**Description**: Type variable for objects that can be clustered.

**Type Definition**:
```python
Clusterable = TypeVar("Clusterable", T_obj, Tuple[Any, ...])
```

**Module**: `pdfplumber.utils.clustering`

**Usage**: Generic type for cluster_objects function, allows clustering of PDF objects or tuples.

---

#### 131. __version__

**Description**: Package version string.

**Module**: `pdfplumber._version`

**Type**: `str`

**Value**: Dynamically generated from `version_info` tuple (e.g., "0.11.7")

**Usage**:
```python
import pdfplumber
print(pdfplumber.__version__)  # "0.11.7"
```

---

#### 132. __all__

**Description**: List of public API names exported by the pdfplumber package.

**Module**: `pdfplumber.__init__`

**Type**: `List[str]`

**Value**:
```python
["__version__", "utils", "pdfminer", "open", "repair", "set_debug"]
```

**Purpose**: Defines what gets imported with `from pdfplumber import *`

---

#### 133. T_color

**Description**: Type alias for color specifications in visualization methods.

**Module**: `pdfplumber.display`

**Type Definition**:
```python
T_color = Union[Tuple[int, int, int], Tuple[int, int, int, int], str]
```

**Accepted Formats**:
- `Tuple[int, int, int]`: RGB color (e.g., `(255, 0, 0)` for red)
- `Tuple[int, int, int, int]`: RGBA color with alpha channel (e.g., `(255, 0, 0, 128)`)
- `str`: Color name or hex string (e.g., `"red"` or `"#FF0000"`)

**Example**:
```python
# RGB tuple
page.to_image().draw_rect(bbox, fill=(0, 255, 0))

# RGBA tuple with transparency
page.to_image().draw_rect(bbox, fill=(0, 255, 0, 100))

# Color name string
page.to_image().draw_rect(bbox, stroke="blue")
```

---

#### 134. DEFAULT_X_DENSITY

**Import Method**:
```python
from pdfplumber.utils.text import DEFAULT_X_DENSITY
```

**Description**: Default horizontal density threshold for clustering characters into words.

**Value**: `7.25`

**Module**: `pdfplumber.utils.text`

**Usage**: Used in text extraction to determine when characters should be grouped into the same word based on horizontal spacing.

---

#### 135. DEFAULT_Y_DENSITY

**Import Method**:
```python
from pdfplumber.utils.text import DEFAULT_Y_DENSITY
```

**Description**: Default vertical density threshold for clustering characters into lines.

**Value**: `13`

**Module**: `pdfplumber.utils.text`

**Usage**: Used in text extraction to determine when characters should be grouped into the same line based on vertical spacing.

---

#### 136. DEFAULT_LINE_DIR

**Import Method**:
```python
from pdfplumber.utils.text import DEFAULT_LINE_DIR
```

**Description**: Default text line direction for text extraction.

**Type Definition**:
```python
DEFAULT_LINE_DIR: T_dir = "ttb"
```

**Value**: `"ttb"` (top-to-bottom)

**Module**: `pdfplumber.utils.text`

**Usage**: Specifies the default direction for organizing text lines. Options are:
- `"ttb"`: Top-to-bottom (default)
- `"btt"`: Bottom-to-top
- `"ltr"`: Left-to-right
- `"rtl"`: Right-to-left

---

#### 137. DEFAULT_CHAR_DIR

**Import Method**:
```python
from pdfplumber.utils.text import DEFAULT_CHAR_DIR
```

**Description**: Default character direction for text extraction.

**Type Definition**:
```python
DEFAULT_CHAR_DIR: T_dir = "ltr"
```

**Value**: `"ltr"` (left-to-right)

**Module**: `pdfplumber.utils.text`

**Usage**: Specifies the default direction for ordering characters within a line. Options are:
- `"ltr"`: Left-to-right (default)
- `"rtl"`: Right-to-left
- `"ttb"`: Top-to-bottom
- `"btt"`: Bottom-to-top

---

#### 138. T_contains_points

**Import Method**:
```python
from pdfplumber.display import T_contains_points
```

**Description**: Type alias for objects that can be drawn on PageImage (points, lines, objects).

**Type Definition**:
```python
T_contains_points = Union[Tuple[T_point, ...], List[T_point], T_obj]
```

**Module**: `pdfplumber.display`

**Accepted Types**:
- `Tuple[T_point, ...]`: Tuple of point coordinates
- `List[T_point]`: List of point coordinates
- `T_obj`: PDF object dictionary

**Usage**: Used in PageImage drawing methods to accept various point-based drawing inputs.

**Example**:
```python
# Draw with tuple of points
img.draw_line(((100, 100), (200, 200)))

# Draw with list of points
img.draw_line([(100, 100), (200, 200)])

# Draw with object dictionary
img.draw_line(line_obj)
```

---


## Detailed Implementation Nodes of Functions

### Node 1: PDF File Opening and Loading
**Function Description**: Support opening PDF files through multiple methods such as file paths, file objects, and byte streams. Support parameters such as password, repair, and page selection.

**Supported Formats/Strategies**:
- Path strings, Path objects, binary file objects
- Support password protection, automatic repair, and page selection

**Input/Output Examples**:
```python
import pdfplumber

# Open through a file path
with pdfplumber.open("tests/pdfs/hello_structure.pdf") as pdf:
    print(type(pdf))  # <class 'pdfplumber.pdf.PDF'>

# Open through a file object
with open("tests/pdfs/hello_structure.pdf", "rb") as f:
    with pdfplumber.open(f) as pdf:
        print(len(pdf.pages))  # Number of pages

# Load an encrypted PDF
with pdfplumber.open("tests/pdfs/password-example.pdf", password="test") as pdf:
    print(pdf.metadata)

# Boundary cases
try:
    pdfplumber.open("not_exist.pdf")
except Exception as e:
    print("File does not exist exception: ", e)
```

---

### Node 2: PDF Metadata and Page Properties
**Function Description**: Extract basic attributes of the PDF, such as metadata, page size, and page numbers.

**Supported Formats/Strategies**:
- Support standard PDF metadata fields
- Support attributes such as page width, height, page number, and crop box

**Input/Output Examples**:
```python
with pdfplumber.open("tests/pdfs/hello_structure.pdf") as pdf:
    print(pdf.metadata)  # {'Producer': ..., 'CreationDate': ...}
    page = pdf.pages[0]
    print(page.width, page.height)  # Page width and height
    print(page.page_number)         # Page number

# Boundary cases
with pdfplumber.open("tests/pdfs/empty.pdf") as pdf:
    print(len(pdf.pages))  # 0
```

---

### Node 3: PDF Object Extraction
**Function Description**: Extract objects such as characters, lines, rectangles, curves, images, annotations, and hyperlinks on the page, and retrieve their detailed attributes.

**Supported Formats/Strategies**:
- Support chars, lines, rects, curves, images, annots, hyperlinks
- Each object is a dict containing attributes such as coordinates, colors, and fonts

**Input/Output Examples**:
```python
page = pdf.pages[0]
print(page.chars[0])   # {'text': 'H', 'fontname': ..., 'size': ..., ...}
print(page.lines)      # [{'x0': ..., 'y0': ..., ...}, ...]
print(page.rects)      # [{'x0': ..., 'y0': ..., ...}, ...]
print(page.curves)     # [{'pts': ..., ...}, ...]
print(page.images)     # [{'width': ..., 'height': ..., ...}, ...]
print(page.annots)     # [{'uri': ..., 'title': ..., ...}, ...]
print(page.hyperlinks) # [{'uri': ..., ...}, ...]

# Boundary cases
print(page.chars if page.chars else "No character objects")
```

---

### Node 4: Text Extraction and Processing
**Function Description**: Support extracting full text, words, and text lines. Support layout, tolerance, regular search, and deduplication.

**Supported Formats/Strategies**:
- extract_text supports parameters such as x/y_tolerance and layout
- extract_words supports parameters such as extra_attrs, keep_blank_chars, and direction
- Support regular/string search and deduplication of characters

**Input/Output Examples**:
```python
# Extract full text
text = page.extract_text()
print(text)

# Extract words and their coordinates
words = page.extract_words()
print(words[0])  # {'text': 'Hello', 'x0': ..., 'top': ..., ...}

# Regular search
matches = page.search(r"\d{4}-\d{2}-\d{2}")
print(matches)  # [{'text': '2023-06-20', ...}, ...]

# Deduplicate characters
deduped_page = page.dedupe_chars()
print(deduped_page.chars)

# Boundary cases
empty_page = pdf.pages[-1]
print(empty_page.extract_text())  # None or empty string
```

---

### Node 5: Table Detection and Extraction
**Function Description**: Automatically detect tables on the page, support multiple strategies, and extract structured table data.

**Supported Formats/Strategies**:
- Support strategies such as lines, lines_strict, text, and explicit
- Support custom parameters table_settings

**Input/Output Examples**:
```python
# Detect all tables
tables = page.find_tables()
print(len(tables))

# Extract text from the largest table
table_data = page.extract_table()
print(table_data)  # [['Header1', 'Header2'], ['Row1', 'Row2'], ...]

# Extract text from all tables
all_tables = page.extract_tables()
print(all_tables)  # [[...], [...], ...]

# Boundary cases
empty_tables = pdf.pages[-1].extract_tables()
print(empty_tables)  # []
```

---

### Node 6: Page Cropping and Region Filtering
**Function Description**: Support operations such as page cropping, region filtering, and object filtering.

**Supported Formats/Strategies**:
- crop, within_bbox, outside_bbox, filter support custom bbox and filtering functions

**Input/Output Examples**:
```python
# Crop the page
cropped = page.crop((0, 0, 100, 100))
print(cropped.width, cropped.height)

# Objects within the region
objs = page.within_bbox((0, 0, 100, 100)).chars
print(objs)

# Objects outside the region
objs = page.outside_bbox((0, 0, 100, 100)).chars
print(objs)

# Boundary cases
cropped_empty = page.crop((0, 0, 1, 1))
print(cropped_empty.extract_text())  # None
```

---

### Node 7: Visual Debugging and Image Rendering
**Function Description**: Render the page as an image, supporting object overlay and table visualization.

**Supported Formats/Strategies**:
- to_image supports parameters such as resolution, antialias, and force_mediabox
- Support overlaying with draw_rects, draw_lines, draw_chars, etc.

**Input/Output Examples**:
```python
im = page.to_image(resolution=150)
im.save("output.png")
im.draw_rects(page.rects)
im.show()

# Boundary cases
try:
    empty_img = pdf.pages[-1].to_image()
    empty_img.show()
except Exception as e:
    print("Empty page rendering exception: ", e)
```

---

### Node 8: PDF Repair and Exception Handling
**Function Description**: Automatically repair corrupted PDFs, supporting exception handling and fault tolerance.

**Supported Formats/Strategies**:
- repair supports the Ghostscript path and repair mode
- Support catching exceptions such as MalformedPDFException and PdfminerException

**Input/Output Examples**:
```python
from pdfplumber import repair

# Repair a PDF and open it
repaired_bytes = repair("tests/pdfs/malformed-from-issue-932.pdf")
with pdfplumber.open(repaired_bytes) as pdf:
    print(len(pdf.pages))

# Exception handling
try:
    pdfplumber.open("broken.pdf")
except Exception as e:
    print("Repair failed exception: ", e)
```

---

### Node 9: Command Line Interface (CLI)
**Function Description**: Extract PDF content via the command line, supporting multiple formats and parameters.

**Supported Formats/Strategies**:
- Support exporting in csv, json, and text formats
- Support parameters such as --pages, --types, --laparams, and --precision

**Input/Output Examples**:
```bash
# Export to CSV
pdfplumber tests/pdfs/background-checks.pdf --format csv > out.csv

# Export to JSON
pdfplumber tests/pdfs/background-checks.pdf --format json > out.json

# Extract specified pages
pdfplumber tests/pdfs/background-checks.pdf --pages 1 2 --format text
```

### Node 10. Table Extraction

#### 10.1 Table Class

**Function Description**: Represent a table extracted from a PDF page, providing methods for accessing table data.

**Input/Output Types**:
- Input: Page object (Page), table settings (dict or TableSettings object)
- Output: Table instance

**Test Interface and Examples**:
```python

# Basic table extraction
with pdfplumber.open("issue-140-example.pdf") as pdf:
    # Extract the first table on the page
    table = pdf.pages[0].extract_table({
        "vertical_strategy": "lines_strict",
        "horizontal_strategy": "lines_strict"
    })
    # Table data
    print(table[-1])  # Output the last row of data

# Access table rows and columns
with pdfplumber.open("issue-140-example.pdf") as pdf:
    page = pdf.pages[0]
    table = page.find_table()
    # Get the text of all cells in the first row
    row = [page.crop(bbox).extract_text() for bbox in table.rows[0].cells]
    # Get the text of all cells in the second column
    col = [page.crop(bbox).extract_text() for bbox in table.columns[1].cells]
```

#### 10.2 TableFinder Class

**Function Description**: Find and extract tables in a PDF page.

**Input/Output Types**:
- Input: Page object (Page), table settings (dict or TableSettings object)
- Output: TableFinder instance

**Test Interface and Examples**:
```python
# Find tables using explicit vertical and horizontal lines
tf = table.TableFinder(
    page,
    {
        "vertical_strategy": "explicit",
        "explicit_vertical_lines": [100, 200, 300],
        "horizontal_strategy": "explicit",
        "explicit_horizontal_lines": [100, 200, 300],
    }
)
tables = tf.tables  # Get all found tables
```

#### 10.3 Table Extraction Settings

**Function Description**: Configure parameters for table detection and extraction.

**Parameter Description**:
- `vertical_strategy`: Vertical line detection strategy ("lines", "lines_strict", "text", "explicit")
- `horizontal_strategy`: Horizontal line detection strategy
- `snap_tolerance`: Edge alignment tolerance (default: 3)
- `join_tolerance`: Edge connection tolerance (default: 3)
- `edge_min_length`: Minimum edge length (default: 3)
- `min_words_vertical`: Minimum number of words required for vertical lines (default: 3)
- `text_x_tolerance`: Horizontal text tolerance (default: 3)

**Test Interface and Examples**:
```python

# Extract tables using the text strategy
t = page.extract_table({
    "horizontal_strategy": "text",
    "vertical_strategy": "text",
    "min_words_vertical": 20,
    "text_x_tolerance": 1  # Increase tolerance to handle text spacing issues
})

# Extract tables using a mixed strategy
tables = page.extract_tables({
    "vertical_strategy": "lines",
    "horizontal_strategy": "text",
    "snap_tolerance": 8,
    "intersection_tolerance": 4
})
```

### Node 11. PDF Page Processing

#### 11.1 Page Cropping

**Function Description**: Crop a PDF page to a specified area.

**Input/Output Types**:
- Input: Bounding box (x0, top, x1, bottom)
- Output: Cropped page object

**Test Interface and Examples**:
```python

# Basic cropping
cropped = page.crop((0, 0, 200, 200))
print(cropped.width, cropped.height)  # 200, 200

# Relative cropping
cropped = page.crop((10, 10, 40, 40))
recropped = cropped.crop((10, 15, 20, 25), relative=True)
print(recropped.bbox)  # (20, 25, 30, 35)

# Objects within the bounding box
within_bbox = page.within_bbox((0, 0, 200, 200))
print(len(within_bbox.chars))  # Number of characters within the bounding box
```

#### 11.2 Object Filtering

**Function Description**: Filter page objects based on conditions.

**Input/Output Types**:
- Input: Filter function that takes an object parameter and returns a boolean value
- Output: Filtered page object

**Test Interface and Examples**:
```python

# Example filter function
def test(obj):
    return obj["object_type"] == "char"

# Apply the filter
filtered = page.filter(test)
print(len(filtered.chars))  # Only contains character objects
print(len(filtered.rects))  # 0, because they are filtered out
```

### Node 12. Text Extraction

#### 12.1 Basic Text Extraction

**Function Description**: Extract text content from a PDF page.

**Input/Output Types**:
- Input: Page object
- Output: Extracted text string

**Test Interface and Examples**:
```python

# Extract page text
text = page.extract_text()
print(text)

# Extract words and their positions
words = page.extract_words()
print(words[0])  # Output the first word and its position information
```

#### 12.2 Text Search

**Function Description**: Search for text on the page.

**Input/Output Types**:
- Input: Regular expression or string
- Output: List of matching text blocks

**Test Interface and Examples**:
```python

# Search for dates using a regular expression
matches = page.search(r"\d{4}-\d{2}-\d{2}")
for match in matches:
    print(match["text"])  # Output the matching text
```

### Node 13: Batch Processing

#### 13.1 Multi-Page Processing

**Function Description**: Process multiple pages in a PDF document in batch.

**Test Interface and Examples**:
```python

with pdfplumber.open("document.pdf") as pdf:
    for i, page in enumerate(pdf.pages):
        # Process each page
        text = page.extract_text()
        print(f"Page {i+1}: {len(text)} characters")
        
        # Extract tables
        tables = page.extract_tables()
        for j, table in enumerate(tables):
            print(f"  Table {j+1}: {len(table)} rows")
```

### Node 14: Advanced Features

#### 14.1 Character Deduplication

**Function Description**: Remove overlapping characters on the page.

**Test Interface and Examples**:
```python

# Deduplicate characters
deduped_page = page.dedupe_chars()
print(f"Original number of characters: {len(page.chars)}, After deduplication: {len(deduped_page.chars)}")
```

#### 14.2 Layout Analysis

**Function Description**: Analyze the layout structure of the page.

**Test Interface and Examples**:
```python

# Use custom layout parameters
laparams = {
    "line_overlap": 0.5,
    "char_margin": 2.0,
    "line_margin": 0.5,
    "word_margin": 0.1,
    "boxes_flow": 0.5,
    "detect_vertical": False,
    "all_texts": False
}

with pdfplumber.open("document.pdf", laparams=laparams) as pdf:
    page = pdf.pages[0]
    print(page.extract_text())
```
