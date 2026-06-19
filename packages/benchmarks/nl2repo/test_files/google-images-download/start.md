# Introduction to the Google Images Download Project

Google Images Download is a powerful Python library specifically designed for searching and batch downloading images from Google Images to the local hard drive. This project can parse search keywords (supporting multiple languages and special characters), provides intelligent image search functionality, supports filtering by various conditions such as color, size, type, and time, and implements an efficient batch download system. This tool performs excellently in the evaluation of image download tools, achieving "highest efficiency and optimal performance". It has a built-in network optimization mechanism to avoid being detected by anti-crawling systems, supports multiple image formats (jpg, gif, png, bmp, svg, webp, ico), and provides full support for command-line parameters. Google Images Download is committed to providing a powerful download verification system for image collection needs and is suitable for various scenarios such as educational research, business applications, and personal use. It obtains high-quality image resources through keyword parsing and intelligent downloading.

## Natural Language Instruction (Prompt)

Please create a Python project named Google Images Download to implement an image search and download library. The project should include the following functions:

1. Parameter Parser: It can extract and parse download parameters from command-line parameters or configuration files, supporting keyword search (e.g., "cat", "sunset", etc.) and batch keyword processing. The parsing result should be an executable download task configuration object.

2. Network Request Handling: Implement functions (or scripts) to handle HTTP requests and Selenium automation, including User-Agent spoofing, SSL certificate handling, anti-crawling mechanisms, etc. It should support compatibility with Python 2.x and 3.x versions and the automated operation of Chrome WebDriver.

3. Image Search and Filtering: Special handling for color, size, type, time, usage rights, etc., such as filtering red images, screening large-size images, filtering photo types, etc. It supports similar image search and specific website search functions.

4. Interface Design: Design independent command-line interfaces or function interfaces for each functional module (such as parameter parsing, network requests, image downloading, file management, etc.), supporting terminal call testing. Each module should define clear input and output formats.

5. Examples and Evaluation Scripts: Provide sample code and test cases to demonstrate how to use the `download()` and `download_executor()` functions for parameter parsing and image downloading (e.g., `download({"keywords": "cat", "limit": 5})` should return the download result). The above functions need to be combined to build a complete image download toolkit. The final project should include modules for parsing, searching, downloading, and managing, along with typical test cases, to form a reproducible download process.

6. Core File Requirements: The project must include a complete `setup.py` file, which needs to configure the project as a package that can be installed via `pip`. At the same time, it should declare a complete list of dependencies (including core libraries such as `selenium`, `urllib3`, `requests`, etc.) and be able to verify whether all functional modules are working properly. In the API entry design, `google_images_download/__init__.py` should be used as the unified entry. Import the core functions `download` and `download_executor` from the `google_images_download` sub-module (i.e., `google_images_download.py`), export configuration classes such as `DownloadConfig`, `SearchConfig`, `FilterConfig`, and provide version information to ensure that users can access all major functions through simple statements such as "from google_images_download import download", which is compatible with the import logic of "from google_images_download import google_images_download". In addition, the `google_images_download.py` file should include the `download_page()` function to handle web page requests and image extraction through multiple strategies to ensure the implementation of core functions.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.10.11

### Core Dependency Library Versions

```Plain
attrs              25.3.0
certifi            2025.8.3
charset-normalizer 3.4.3
coverage           7.10.2
exceptiongroup     1.3.0
h11                0.16.0
idna               3.10
iniconfig          2.1.0
json5              0.9.14
numpy              2.2.6
opencv-python      4.8.0.76
outcome            1.3.0.post0
packaging          25.0
Pillow             10.0.0
pip                23.0.1
pluggy             1.6.0
Pygments           2.19.2
PySocks            1.7.1
pytest             8.4.0
pytest-cov         4.1.0
requests           2.32.5
selenium           4.34.2
setuptools         65.5.1
sniffio            1.3.1
sortedcontainers   2.4.0
tomli              2.2.1
trio               0.30.0
trio-websocket     0.12.2
typing_extensions  4.14.1
urllib3            2.5.0
websocket-client   1.8.0
wheel              0.40.0
```

## Google Images Download Project Architecture

### Project Directory Structure

```Plain
workspace/
├── .gitignore
├── Licence.txt
├── MANIFEST.in
├── README.rst
├── docs
│   ├── .DS_Store
│   ├── Makefile
│   ├── _static
│   │   ├── .DS_Store
│   │   └── overrides.css
│   ├── arguments.rst
│   ├── conf.py
│   ├── examples.rst
│   ├── index.rst
│   ├── installation.rst
│   ├── make.bat
│   ├── structure.rst
│   ├── troubleshooting.rst
│   └── usage.rst
├── google_images_download
│   ├── __init__.py
│   ├── __main__.py
│   ├── google_images_download.py
│   └── sample_config.json
├── images
│   └── flow-chart.png
├── setup.cfg
└── setup.py

```

## API Usage Guide

### Core API

#### 1. Module Import

```python
from google_images_download import google_images_download
```

#### 2. `googleimagesdownload` Class - Main Downloader

**Function**: The main class of the Google Images downloader, providing image search and download functions.

**Class Initialization**:
```python
downloader = google_images_download.googleimagesdownload()
```

#### 3. `download()` Method - Main Entry for Image Download

**Function**: Search for and download images from Google Images to the local directory.

**Method Signature**:
```python
def download(self, arguments: dict) -> None:
```

**Parameter Description**:
- `arguments` (dict): A dictionary of download parameters, containing the following key-value pairs:
  - `keywords` (str): Search keywords, such as "cat", "sunset", etc.
  - `limit` (int): Limit on the number of images to download, default is 100.
  - `format` (str): Image format, supporting jpg, gif, png, bmp, svg, webp, ico.
  - `output_directory` (str): Path to the output directory, default is "downloads".
  - `image_directory` (str): Name of the image subdirectory, default is the keyword name.
  - `no_directory` (bool): Whether to not use a subdirectory, default is False.
  - `delay` (int): Interval time (in seconds) between downloads, default is 0 seconds.
  - `print_urls` (bool): Whether to print the image URLs, default is False.
  - `print_size` (bool): Whether to print the image sizes, default is False.
  - `print_paths` (bool): Whether to print the file paths, default is False.
  - `silent_mode` (bool): Silent mode, default is False.
  - `no_download` (bool): Only search, do not download, default is False.
  - `save_source` (bool): Save the image source information, default is False.
  - `ignore_urls` (list): List of URLs to ignore, default is None.

**Usage Example**:
```python
arguments = {
    "keywords": "cat",
    "limit": 5,
    "format": "jpg",
    "print_urls": True
}
downloader.download(arguments)
```

#### 4. `download_executor()` Method - Download Executor

**Function**: Execute specific download tasks, handle parameter validation and the download process.

**Method Signature**:
```python
def download_executor(self, arguments: dict) -> tuple[dict, int]:
```

**Parameter Description**:
- `arguments` (dict): A dictionary of download parameters, containing all download configurations.

**Return Value**: A tuple (dictionary of download paths, number of errors).

#### 5. `download_page()` Method - Web Page Content Download

**Function**: Download web page content, supporting HTTP requests and SSL certificate handling.

**Method Signature**:
```python
def download_page(self, url: str) -> str:
```

**Parameter Description**:
- `url` (str): URL of the web page to download.

**Return Value**: A string of the web page content.

**Usage Example**:
```python
content = downloader.download_page("https://www.google.com/search?q=cat&tbm=isch")
```

#### 6. `build_search_url()` Method - Search URL Construction

**Function**: Construct a Google Images search URL.

**Method Signature**:
```python
def build_search_url(self, search_term: str, params: str, url: str, 
                    similar_images: str, specific_site: str, safe_search: bool) -> str:
```

**Parameter Description**:
- `search_term` (str): Search keyword.
- `params` (str): URL parameters.
- `url` (str): Base URL.
- `similar_images` (str): URL of similar images.
- `specific_site` (str): Specific website.
- `safe_search` (bool): Whether to enable safe search.

**Return Value**: A complete search URL string.

**Usage Example**:
```python
search_url = downloader.build_search_url("cat", "", None, None, None, True)
```

#### 7. `similar_images()` Method - Similar Image Search

**Function**: Search for similar images based on an image URL.

**Method Signature**:
```python
def similar_images(self, similar_images: str) -> str:
```

**Parameter Description**:
- `similar_images` (str): URL of the similar image.

**Return Value**: A keyword for similar image search or an error message.

**Usage Example**:
```python
similar_keyword = downloader.similar_images("https://example.com/image.jpg")
```

#### 8. `build_url_parameters()` Method - URL Parameter Construction

**Function**: Construct a URL parameter string.

**Method Signature**:
```python
def build_url_parameters(self, arguments: dict) -> str:
```

**Parameter Description**:
- `arguments` (dict): A dictionary of parameters, containing filtering conditions such as color, size, and type.

**Return Value**: A URL parameter string.

**Usage Example**:
```python
params = downloader.build_url_parameters({
    "color": "red",
    "size": "large",
    "type": "photo"
})
```

#### 9. `file_size()` Method - File Size Calculation

**Function**: Calculate the file size.

**Method Signature**:
```python
def file_size(self, file_path: str) -> str:
```

**Parameter Description**:
- `file_path` (str): Path to the file.

**Return Value**: A string representing the file size (e.g., "1.5 MB").

### Parameter Configuration Description

#### Search Parameters
- `keywords`: Search keyword.
- `keywords_from_file`: Read keywords from a file.
- `prefix_keywords`: Prefix keywords.
- `suffix_keywords`: Suffix keywords.
- `url`: Use a Google Images URL directly.
- `single_image`: Download a single image.
- `similar_images`: Search for similar images.
- `specific_site`: Search on a specific website.
- `language`: Search language, default is "en".
- `safe_search`: Safe search, default is True.
- `related_images`: Search for related images.

#### Filtering Parameters
- `color`: Color filtering (red, orange, yellow, green, teal, blue, purple, pink, white, gray, black, brown).
- `color_type`: Color type (full-color, black-and-white, transparent).
- `size`: Size filtering (large, medium, icon, >400*300, etc.).
- `exact_size`: Exact size (in the format WIDTH,HEIGHT).
- `type`: Image type (face, photo, clipart, line-drawing, animated).
- `time`: Time filtering (past-24-hours, past-7-days, past-month, past-year).
- `time_range`: Time range (in JSON format).
- `aspect_ratio`: Aspect ratio (tall, square, wide, panoramic).
- `usage_rights`: Usage rights.

### Actual Usage Modes

#### Basic Usage

```python
from google_images_download import google_images_download

# Create a downloader instance
downloader = google_images_download.googleimagesdownload()

# Simple download
arguments = {
    "keywords": "cat",
    "limit": 5,
    "format": "jpg"
}
downloader.download(arguments)
```

#### Advanced Usage

```python
from google_images_download import google_images_download

# Create a downloader instance
downloader = google_images_download.googleimagesdownload()

# Advanced search parameters
arguments = {
    "keywords": "sunset",
    "limit": 10,
    "color": "red",
    "size": "large",
    "type": "photo",
    "time": "past-7-days",
    "output_directory": "my_downloads",
    "print_urls": True
}
downloader.download(arguments)
```
```

#### Batch Download Mode

```python
from google_images_download import google_images_download

def batch_download(
    keywords_list: list,
    output_dir: str = "downloads",
    limit_per_keyword: int = 5,
    format: str = "jpg",
    delay: int = 1,
):
    """Batch download images for multiple keywords"""
    downloader = google_images_download.googleimagesdownload()
    total_errors = 0
    
    for keyword in keywords_list:
        arguments = {
            "keywords": keyword,
            "limit": limit_per_keyword,
            "format": format,
            "delay": delay,
            "output_directory": output_dir
        }
        try:
            downloader.download(arguments)
        except Exception as e:
            print(f"Error downloading keyword '{keyword}': {e}")
            total_errors += 1
    
    return total_errors

# Usage example
keywords = ["cat", "dog", "bird"]
errors = batch_download(keywords, limit_per_keyword=3)
print(f"Batch download completed, number of errors: {errors}")
```

#### Similar Image Search

```python
from google_images_download import google_images_download

# Create a downloader instance
downloader = google_images_download.googleimagesdownload()

# Search for similar images
image_url = "https://example.com/sample_image.jpg"
similar_keyword = downloader.similar_images(image_url)

if similar_keyword != "Cloud not connect to Google Images endpoint":
    # Search using the similar image keyword
    arguments = {
        "keywords": similar_keyword,
        "limit": 5,
        "format": "jpg"
    }
    downloader.download(arguments)
```

#### Specific Website Search

```python
from google_images_download import google_images_download

# Create a downloader instance
downloader = google_images_download.googleimagesdownload()

# Search on a specific website
arguments = {
    "keywords": "landscape",
    "specific_site": "flickr.com",
    "limit": 5,
    "format": "jpg"
}
downloader.download(arguments)
```

### Supported Search Types
- **Keyword Search**: Single keyword, batch keywords, read from a file.
- **URL Search**: Use a Google Images URL directly.
- **Single Image**: Download an image from a specified URL.
- **Similar Images**: Search for similar images based on an image URL.
- **Specific Website**: Search for images on a specified website.
- **Related Images**: Search for related images.

### Supported Filtering Conditions
- **Color Filtering**: 12 color options.
- **Size Filtering**: Multiple size specifications.
- **Type Filtering**: Face, photo, clipart, etc.
- **Time Filtering**: From the past 24 hours to 1 year.
- **Aspect Ratio**: Tall, square, wide, panoramic.
- **Usage Rights**: Various usage rights filtering.

### Error Handling
The system provides a comprehensive error handling mechanism:
- **Network Errors**: Automatic retry and timeout handling.
- **File Errors**: Permission checking and directory creation.
- **Parameter Errors**: Parameter validation and conflict checking.
- **Anti-Crawling**: User-Agent spoofing and delay mechanisms.

### Important Notes
1. **Copyright Compliance**: Only use for educational and research purposes and comply with image copyrights.
2. **Network Restrictions**: May be affected by Google's anti-crawling mechanism.
3. **File Management**: Automatically create a directory structure and support custom paths.
4. **Format Support**: Support downloading and converting multiple image formats.
5. **Flexible Configuration**: Support both command-line parameters and configuration files.

### Performance Optimization
- **Concurrency Control**: Built-in delay mechanism to avoid being detected by anti-crawling systems.
- **Memory Optimization**: Stream downloading to save memory usage.
- **Error Recovery**: Intelligent retry mechanism.
- **Progress Display**: Real-time display of download progress and status.

## Detailed Function Implementation Nodes

### Node 1: User Input Handling (user_input)

**Function Description**: Processes command line arguments or configuration file input to define image download parameters, including keywords, filters, and output settings.

**Input and Output Examples**:
```python
# Usage example: Command line arguments
records = user_input()

# Usage example: Configuration file input
config = argparse.ArgumentParser()
config.add_argument('-cf', '--config_file', help='config file name', default='', type=str, required=False)
```

### Node 2: Web Page Download (download_page)

**Function Description**: Downloads entire web document (raw page content) from a given URL with proper user agent headers and SSL handling for different Python versions.

**Input and Output Examples**:
```python
# Usage example
raw_html = self.download_page(url)
```

### Node 3: Extended Page Download (download_extended_page)

**Function Description**: Uses Selenium WebDriver to download extended page content for more than 100 images by scrolling through the page and handling dynamic content loading.

**Input and Output Examples**:
```python
# Usage example
raw_html = self.download_extended_page(url, arguments['chromedriver'])
```

### Node 4: URL Parameter Builder (build_url_parameters)

**Function Description**: Constructs URL parameters for Google Images search based on user arguments including language, color filters, size restrictions, usage rights, and time ranges.

**Input and Output Examples**:
```python
# Usage example
params = self.build_url_parameters(arguments)
```

### Node 5: Search URL Builder (build_search_url)

**Function Description**: Builds the main search URL for Google Images incorporating search terms, parameters, and optional features like safe search, similar images, or specific site filtering.

**Input and Output Examples**:
```python
# Usage example
url = self.build_search_url(search_term, params, arguments['url'], arguments['similar_images'], arguments['specific_site'], arguments['safe_search'])
```

### Node 6: Image Download (download_image)

**Function Description**: Downloads individual images from provided URLs with error handling, format validation, and optional features like prefix naming, size printing, and source tracking.

**Input and Output Examples**:
```python
# Usage example
download_status, download_message, return_image_name, absolute_path = self.download_image(object['image_link'], object['image_format'], main_directory, dir_name, count, arguments['print_urls'], arguments['socket_timeout'], arguments['prefix'], arguments['print_size'], arguments['no_numbering'], arguments['no_download'], arguments['save_source'], object['image_source'], arguments["silent_mode"], arguments["thumbnail_only"], arguments['format'], arguments['ignore_urls'])
```

### Node 7: Directory Creation (create_directories)

**Function Description**: Creates main directory and sub-directories for organizing downloaded images, with optional thumbnail directory creation.

**Input and Output Examples**:
```python
# Usage example
self.create_directories(main_directory, dir_name, arguments['thumbnail'], arguments['thumbnail_only'])
```

### Node 8: Main Download Executor (download_executor)

**Function Description**: Orchestrates the complete image download process including keyword processing, search execution, image extraction, and error handling for bulk downloads.

**Input and Output Examples**:
```python
# Usage example
paths, errors = self.download_executor(arguments)
```

### Node 9: Single Image Download (single_image)

**Function Description**: Downloads a single image from a direct URL to the local "downloads" directory with automatic format detection.

**Input and Output Examples**:
```python
# Usage example
response.single_image(arguments['single_image'])
```

### Node 10: Similar Images Search (similar_images)

**Function Description**: Performs reverse image search to find similar images using Google's searchbyimage endpoint and returns related search terms.

**Input and Output Examples**:
```python
# Usage example
keywordem = self.similar_images(similar_images)
```