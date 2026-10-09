## Introduction and Goals of the Requests-HTML Project

Requests-HTML is a **human-designed HTML parsing library** that simplifies and streamlines web scraping and HTML parsing. Built on top of the popular Requests library, it adds full JavaScript support, making it easier to scrape modern web pages. Its core features include: **Full JavaScript rendering**: By integrating Chromium and Pyppeteer, it supports scraping web pages with dynamically loaded content. **Flexible CSS selectors**: It offers a jQuery-like CSS selector syntax for easy element location and content extraction. **XPath support**: It provides support for developers who prefer to use XPath. **Asynchronous request handling**: It supports asynchronous operations, enabling efficient handling of multiple web page requests simultaneously. **Automatic redirection and session management**: It automatically handles redirections and maintains cookie persistence. **Simulation of real browsers**: It automatically sets the User-Agent to mimic real browser behavior. Requests-HTML is particularly suitable for scenarios where modern JavaScript-rendered web pages need to be scraped. It combines the ease of use of Requests with the powerful features of modern browsers, providing a comprehensive solution for web scraping and data processing.


## Natural Language Instructions (Prompt)

Please create a Python project named requests-html to implement an HTML parsing library. The project should include the following key features:

1. **Basic functionality testing**: Implement loading HTML content from strings or URLs, support parsing documents in multiple encoding formats, provide full CSS selector and XPath selector support, and accurately extract element attributes, text content, and links, including automatic conversion of relative and absolute links.

2. **Browser rendering testing**: Integrate the Chromium browser, support full JavaScript execution and dynamic content loading, implement custom script injection, form submission, click event triggering, and element waiting functions.

3. **Session management testing**: Implement synchronous and asynchronous session management, support cookie persistence and request header management, provide request timeout settings, retry mechanisms, and proxy support.

4. **Pagination and navigation testing**: Automatically detect and handle paginated content, support merging and extraction of multi-page content, and implement page jumping, forward, backward, and refresh functions.

5. **Exception handling testing**: Handle network exceptions such as connection timeouts and request failures, verify the handling of invalid HTML documents and selector matching failures, and implement rendering timeout and resource usage limit mechanisms.

6. **Performance testing**: Test page loading time, rendering speed, and resource usage, support high-concurrency request and rendering testing, and evaluate system resource usage efficiency.

7. **Compatibility testing**: Verify the operation on different Chromium versions, test the performance on different operating systems such as Windows, Linux, and macOS, and ensure compatibility with Python 3.6 and above.

8. **Security testing**: Implement XSS protection and injection attack protection, manage cross-origin requests and file access permissions, and prevent CSRF attacks.

9. **Integration testing**: Seamlessly integrate with the pytest testing framework, support the asyncio asynchronous programming model, and maintain compatibility with the standard requests library.

10. **Benchmark testing**: Measure request response time, page rendering speed, and resource usage efficiency, and conduct high-concurrency request and large data volume processing tests.

11. **Core file requirements**: The project must include a comprehensive setup.py file. This file should not only configure the project as an installable package (supporting pip install) but also declare a complete list of dependencies (including core libraries such as requests >= 2.22.0, pyquery >= 1.4.0, fake-useragent >= 0.1.11, parse >= 1.12.0, etc.). The setup.py file can verify whether all functional modules are working properly. At the same time, it should provide requests_html.py as a unified API entry, import and export HTMLSession, AsyncHTMLSession, HTMLResponse, HTML, and the main import and export functions, and provide version information, allowing users to access all major functions through a simple "from requests_html import *" statement.


## Environment Configuration

### Python Version
The Python version used in the current project is: Python 3.12.4

### Core Dependency Library Versions

```Plain

# Python 3.6+
# requests >= 2.22.0
# pyquery >= 1.4.0
# fake-useragent >= 0.1.11
# parse >= 1.12.0
# beautifulsoup4 >= 4.6.0
# w3lib >= 1.21.0
# pyppeteer >= 0.0.14
# lxml >= 4.2.1
# cssselect >= 1.1.0

## Development Dependencies

# pytest >= 5.0.0
# pytest-cov >= 2.7.1
# pytest-asyncio >= 0.10.0
# black >= 19.10b0
# flake8 >= 3.8.0
# mypy >= 0.770
# sphinx >= 3.0.0
# twine >= 3.1.0

```


## requests-html Project Architecture

### Project Directory Structure

```
workspace/
├── .gitattributes
├── .gitignore
├── .travis.yml
├── LICENSE
├── Makefile
├── Pipfile
├── Pipfile.lock
├── README.rst
├── docs
│   ├── Makefile
│   ├── make.bat
│   ├── source
│   │   ├── _static
│   │   │   ├── requests-html-logo.png
│   │   ├── _templates
│   │   │   ├── hacks.html
│   │   │   ├── sidebarintro.html
│   │   │   ├── sidebarlogo.html
│   │   ├── conf.py
│   │   └── index.rst
├── ext
│   ├── requests-html-logo.ai
├── pytest.ini
├── requests_html.py
└── setup.py
```


## API Usage Guide

### 1. Module Import
```python
from requests_html import HTMLSession, AsyncHTMLSession, HTMLResponse,HTML
```

### 2. Core Classes

#### 2.1. HTMLSession (Synchronous Session Class)

Inherits from `BaseSession` and is used for synchronous HTTP requests.

##### Constructor
```python
HTMLSession(**kwargs)
```

##### Main Methods

**get(url, **kwargs)**
- **Function**: Initiate a GET request.
- **Parameters**: url (str) - The request URL.
- **Return**: An HTMLResponse object.
- **Example**: `session.get('https://python.org/')`

**close()**
- **Function**: Close the session and the browser.
- **Parameters**: None.
- **Return**: None.
- **Note**: Automatically closes the Chromium browser instance.

##### Attributes

**browser**
- **Type**: Browser object.
- **Function**: Get the Chromium browser instance.
- **Note**: Automatically creates the browser on the first access.

#### 2.2. AsyncHTMLSession (Asynchronous Session Class)

Inherits from `BaseSession` and is used for asynchronous HTTP requests.

##### Constructor
```python
AsyncHTMLSession(loop=None, workers=None, mock_browser=True, *args, **kwargs)
```

**Parameter Description**:
- `loop`: asyncio event loop.
- `workers`: Number of worker threads in the thread pool.
- `mock_browser`: Whether to mimic the browser User-Agent.

##### Main Methods

**async get(url, **kwargs)**
- **Function**: Asynchronously initiate a GET request.
- **Parameters**: url (str) - The request URL.
- **Return**: An HTMLResponse object.
- **Example**: `await session.get('https://python.org/')`

**async close()**
- **Function**: Asynchronously close the session and the browser.
- **Parameters**: None.
- **Return**: None.

**run(*coros)**
- **Function**: Run coroutines in batches.
- **Parameters**: coros - A list of coroutine functions.
- **Return**: A list of results.
- **Example**:
```python
async def fetch1(): return await session.get('url1')
async def fetch2(): return await session.get('url2')
results = session.run(fetch1, fetch2)
```

#### 2.3. HTMLResponse (HTTP Response Class)

Inherits from `requests.Response` and is an enhanced HTTP response object.

##### Attributes

**html**
- **Type**: HTML object.
- **Function**: Get the HTML parsing object.
- **Note**: Automatically creates an HTML object for parsing.

#### 2.4. HTML (HTML Document Class)

Inherits from `BaseParser` and represents an HTML document.

##### Constructor
```python
HTML(session=None, url=DEFAULT_URL, html=html, default_encoding=DEFAULT_ENCODING, async_=False)
```

**Parameter Description**:
- `session`: An HTMLSession or AsyncHTMLSession object.
- `url`: The document URL.
- `html`: An HTML string or bytes.
- `default_encoding`: The default encoding.
- `async_`: Whether it is in asynchronous mode.

##### Main Methods

**render(retries=8, script=None, wait=0.2, scrolldown=False, sleep=0, reload=True, timeout=8.0, keep_page=False, cookies=[{}], send_cookies_session=False)**
- **Function**: Render the page using Chromium.
- **Parameters**:
  - `retries`: Number of retries.
  - `script`: JavaScript script.
  - `wait`: Waiting time.
  - `scrolldown`: Number of scrolls.
  - `sleep`: Sleep time.
  - `reload`: Whether to reload the page before rendering.
  - `timeout`: Timeout duration.
  - `keep_page`: Whether to keep the page.
  - `cookies`: A list of cookies.
  - `send_cookies_session`: Whether to send session cookies.
- **Return**: The result of the script execution or None.

**async arender(retries=8, script=None, wait=0.2, scrolldown=False, sleep=0, reload=True, timeout=8.0, keep_page=False, cookies=[{}], send_cookies_session=False)**
- **Function**: Asynchronously render the page.
- **Parameters**: Same as the render method.
- **Return**: The result of the script execution or None.

**next(fetch=False, next_symbol=None)**
- **Function**: Get the link to the next page.
- **Parameters**:
  - `fetch`: Whether to fetch the page content.
  - `next_symbol`: A list of pagination symbols.
- **Return**: The URL of the next page or an HTML object.

**add_next_symbol(next_symbol)**
- **Function**: Add a pagination symbol.
- **Parameters**: next_symbol - A pagination symbol.
- **Return**: None.

##### Iterator Support

**__iter__()**
- **Function**: Synchronous pagination iterator.
- **Return**: An iterator of HTML objects.

**__aiter__()**
- **Function**: Asynchronous pagination iterator.
- **Return**: An asynchronous iterator of HTML objects.

#### 2.5. Element (HTML Element Class)

Inherits from `BaseParser` and represents a single element in HTML.

##### Attributes

**attrs**
- **Type**: dict.
- **Function**: Get the attribute dictionary of the element.
- **Note**: The class and rel attributes are split into tuples.

**tag**
- **Type**: str.
- **Function**: Get the tag name of the element.

**lineno**
- **Type**: int.
- **Function**: Get the line number of the element in the source code.

#### 2.6. BaseParser (HTML Parsing Base Class)

The base class for all parsing classes.

##### Main Methods

**find(selector="*", containing=None, clean=False, first=False, _encoding=None)**
- **Function**: Find elements using CSS selectors.
- **Parameters**:
  - `selector`: CSS selector.
  - `containing`: The text to contain.
  - `clean`: Whether to clean the HTML.
  - `first`: Whether to return only the first element.
  - `_encoding`: The encoding format.
- **Return**: An Element object or a list.

**xpath(selector, clean=False, first=False, _encoding=None)**
- **Function**: Find elements using XPath selectors.
- **Parameters**:
  - `selector`: XPath expression.
  - `clean`: Whether to clean the HTML.
  - `first`: Whether to return only the first element.
  - `_encoding`: The encoding format.
- **Return**: An Element object, a string, or a list.

**search(template)**
- **Function**: Find content using a Parse template.
- **Parameters**: template - A Parse template.
- **Return**: A Result object.

**search_all(template)**
- **Function**: Find all matching content using a Parse template.
- **Parameters**: template - A Parse template.
- **Return**: A list of Result objects.

##### Attributes

**text**
- **Type**: str.
- **Function**: Get the plain text content.

**full_text**
- **Type**: str.
- **Function**: Get the full text including links.

**html**
- **Type**: str.
- **Function**: Get the HTML source code.

**raw_html**
- **Type**: bytes.
- **Function**: Get the raw HTML bytes.

**encoding**
- **Type**: str.
- **Function**: Get the encoding format.

**links**
- **Type**: set[str].
- **Function**: Get all links on the page (in original form).

**absolute_links**
- **Type**: set[str].
- **Function**: Get all links on the page (as absolute URLs).

**base_url**
- **Type**: str.
- **Function**: Get the base URL.

**pq**
- **Type**: PyQuery object.
- **Function**: Get the PyQuery representation.

**lxml**
- **Type**: HtmlElement object.
- **Function**: Get the lxml representation.

### 3. Utility Functions

#### 3.1. user_agent(style=None)
**Function**: Generate a User-Agent string.
**Parameters**: style - The User-Agent style.
**Return**: A User-Agent string.
**Example**: `user_agent('chrome')`

### 4. Exception Classes

#### 4.1 MaxRetries

**Function**: An exception indicating that rendering retries have failed.
**Attributes**: message - The error message.

### Usage Examples

#### Basic Usage
```python
from requests_html import HTMLSession

# Create a session
session = HTMLSession()

# Initiate a request
r = session.get('https://python.org/')

# Find an element
about = r.html.find('#about', first=True)
print(about.text)

# Get links
links = r.html.links
print(links)

# Render JavaScript
r.html.render()
```

#### Asynchronous Usage
```python
from requests_html import AsyncHTMLSession

async def main():
    session = AsyncHTMLSession()
    
    # Asynchronous request
    r = await session.get('https://python.org/')
    
    # Asynchronous rendering
    await r.html.arender()
    
    # Batch requests
    async def fetch1(): return await session.get('url1')
    async def fetch2(): return await session.get('url2')
    results = session.run(fetch1, fetch2)
    
    await session.close()
```

#### Independent HTML Parsing
```python
from requests_html import HTML

# Directly parse an HTML string
html = HTML(html='<a href="https://example.com">Link</a>')
links = html.links
print(links)  # {'https://example.com'}
```

### Notes

1. **First Rendering**: The first call to the render() method will automatically download the Chromium browser.
2. **Event Loop**: HTMLSession cannot be used in an existing event loop. Use AsyncHTMLSession instead.
3. **Resource Management**: Call the close() method in a timely manner to release resources after use.
4. **Encoding Handling**: Automatically detect and handle web page encoding, supporting multiple encoding formats.
5. **Exception Handling**: Network exceptions and rendering failures will be automatically retried. A MaxRetries exception will be thrown if the maximum number of retries is exceeded.

---

## Detailed Implementation Nodes of Functions

### 1. HTML Loading and Parsing

#### 1.1 Loading HTML from a File
**Function Description**: Load HTML content from the local file system.

**Input**:
- A `file://` protocol path.

**Output**:
- An `HTMLResponse` object containing the page content.

**Example**:
```python
from requests_html import HTMLSession

# Create a session
session = HTMLSession()

# Load a local HTML file
r = session.get('file:///path/to/your/file.html')
print(r.status_code)  # 200
```

#### 1.2 Loading HTML from a URL
**Function Description**: Load HTML content from a remote URL.

**Input**:
- A URL string.

**Output**:
- An `HTMLResponse` object.

**Example**:
```python
from requests_html import HTMLSession

session = HTMLSession()
r = session.get('https://example.com')
print(r.html.text)  # Page text content
```

### 2. Element Selection and Manipulation

#### 2.1 CSS Selectors
**Function Description**: Find elements using CSS selectors.

**Input**:
- A CSS selector string.
- `first=False`: Whether to return only the first matching item.

**Output**:
- A list of element objects or a single element.

**Example**:
```python
# Find all elements with the class 'item'
items = r.html.find('.item')

# Find only the first matching element
first_item = r.html.find('#main', first=True)
```

#### 2.2 XPath Selectors
**Function Description**: Find elements using XPath expressions.

**Input**:
- An XPath expression.
- `first=False`: Whether to return only the first matching item.

**Output**:
- A list of element objects or a single element.

**Example**:
```python
# Find all links
elements = r.html.xpath('//a/@href')

# Find the first div element
first_div = r.html.xpath('//div', first=True)
```

### 3. Element Attributes and Content

#### 3.1 Getting Element Attributes
**Function Description**: Get the attributes of an HTML element.

**Input**:
- The attribute name.

**Output**:
- The attribute value (a string or a list).

**Example**:
```python
div = r.html.find('div', first=True)
class_list = div.attrs['class']  # Get the class list
id_value = div.attrs.get('id')   # Safely get the id
```

#### 3.2 Getting Element Text
**Function Description**: Get the text content of an element.

**Output**:
- The element's text content (a string).

**Example**:
```python
# Get the element's text
content = r.html.find('p', first=True).text

# Get the full text (including child elements)
full_text = r.html.find('div.content', first=True).full_text
```

### 4. Link Handling

#### 4.1 Getting All Links
**Function Description**: Get all links on the page.

**Output**:
- A set of relative links.
- A set of absolute links.

**Example**:
```python
# Get all relative links
links = r.html.links

# Get all absolute links
absolute_links = r.html.absolute_links
```

#### 4.2 Link Parsing
**Function Description**: Parse a relative link into an absolute link.

**Input**:
- The base URL.
- A relative link.

**Output**:
- An absolute URL.

**Example**:
```python
from requests_html import HTML

html = HTML(html='<a href="/about">About</a>', url='https://example.com')
print(html.absolute_links)  # {'https://example.com/about'}
```

### 5. JavaScript Rendering

#### 5.1 Synchronous Rendering
**Function Description**: Execute JavaScript and render the page.

**Input**:
- `script=None`: The JavaScript code to execute.
- `reload=True`: Whether to reload the page before rendering.

**Output**:
- The result of the JavaScript execution.

**Example**:
```python
# Render the page and execute JavaScript
r.html.render()

# Execute a custom script and get the result
script = """
() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
})"""
result = r.html.render(script=script)
print(result['width'], result['height'])
```

### 6. Pagination Handling

#### 6.1 Synchronous Pagination
**Function Description**: Handle paginated content.

**Output**:
- The response object of the next page.

**Example**:
```python
r = session.get('https://example.com/paginated')
next_page = next(r.html)
```
### 7. Session Management

#### 7.1 Synchronous Session
**Function Description**: Manage synchronous HTTP sessions.

**Example**:
```python
session = HTMLSession()
try:
    r = session.get('https://example.com')
    # Use the session...
finally:
    session.close()  # Manually close the session
```

#### 7.2 Asynchronous Session
**Function Description**: Manage asynchronous HTTP sessions.

**Example**:
```python
session = AsyncHTMLSession()
try:
    r = await session.get('https://example.com')
    # Use the session...
finally:
    await session.close()  # Manually close the session
```

### 8. Browser Management

#### 8.1 Browser Instance Management
**Function Description**: Manage the creation and closing of browser instances.

**Example**:
```python
# Synchronous browser session
session = HTMLSession()
try:
    browser = session.browser  # Get the browser instance
    # Use the browser...
finally:
    session.close()

# Asynchronous browser session
async def example():
    session = AsyncHTMLSession()
    try:
        browser = await session.browser
        # Use the browser...
    finally:
        await session.close()
```

#### 8.2 Browser Process Management
**Function Description**: Manage the lifecycle of the browser process.

**Example**:
```python
session = HTMLSession()
try:
    # Use the same browser instance multiple times
    for _ in range(3):
        r = session.get('https://example.com')
        r.html.render()
        # The page will be automatically closed after each rendering
        assert r.html.page is None
finally:
    session.close()  # Close the browser process
```

### 9. Advanced Features

#### 9.1 Element Text Search
**Function Description**: Find elements that contain specific text.

**Input**:
- The text to search for.

**Output**:
- A list of elements containing the specified text.

**Example**:
```python
# Find all elements containing the text "python"
elements = r.html.find(containing='python')
for element in elements:
    assert 'python' in element.text.lower()
```

#### 9.2 Page Search
**Function Description**: Search for text patterns in the page content.

**Input**:
- A search pattern string containing placeholders.

**Output**:
- A tuple of matched text.

**Example**:
```python
# Search for pattern matching
result = r.html.search('Python is a {} language')
print(result[0])  # Output: programming
```

### 10. Error Handling

#### 10.1 Browser Session Error Handling
**Function Description**: Handle errors in browser sessions.

**Example**:
```python
# Creating a synchronous browser session in an event loop will raise an error
with pytest.raises(RuntimeError):
    session = HTMLSession()
    session.browser  # Will raise a RuntimeError in an event loop
```

#### 10.2 Asynchronous Browser Session
**Function Description**: Manage asynchronous browser sessions.

**Example**:
```python
async def test_async_browser():
    session = AsyncHTMLSession()
    try:
        browser = await session.browser
        assert browser is not None
    finally:
        await session.close()
```
