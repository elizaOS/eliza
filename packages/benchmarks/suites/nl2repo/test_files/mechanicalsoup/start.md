# Introduction to the MechanicalSoup_main Project

## 1. Project Overview and Objectives

MechanicalSoup is a Python-based web automation interaction library designed to simplify common tasks such as web form filling, page navigation, and data scraping. It combines Requests (for HTTP session management) and BeautifulSoup (for HTML parsing and navigation) to provide users with browser-like automation capabilities. The project aims to enable developers to automate website interaction processes with concise code, making it suitable for scenarios such as web crawlers, automated testing, and data collection.

## 2. Natural Language Instructions (Prompt)

Please create a Python project named MechanicalSoup_main to support automated web operations and verification. The project should include the following functions and test points:

1. **Web Expression Parsing and Form Structure Recognition**  
   Automatically parse HTML pages and form structures, extract input controls (such as text boxes, radio buttons, checkboxes, drop-down menus, file uploads, etc.) and their attributes, and output structured objects for subsequent automated operations and comparisons.

2. **Automated Interaction and Equivalence Verification**  
   Support automatic simulation of browser operations, including page requests, form filling, submission, link clicks, page jumps, etc. It can determine whether the actual page state and form content are equivalent to the expected ones.  
   Support symbolic extraction and comparison of form submission results, page jump targets, response content, etc.

3. **Handling of Special Structures and Complex Scenarios**  
   For special structures such as multi-select forms, dynamically generated controls, compound inputs, and changes in form control order, it can intelligently determine equivalence and handle errors.  
   For example, multi-select boxes with different orders but the same content should be considered equivalent, and reasonable prompts and handling should be provided when controls are missing or redundant.

4. **Interface Design and Call Specifications**  
   Each functional module (such as parsing, interaction, equivalence judgment, etc.) has independent function interfaces and command-line entries, supporting direct terminal calls and script integration.  
   For example, `parse_form(html_str)` returns a structured form object, and `verify_form(expected, actual)` returns a boolean value.

5. **Unified API Entry and Version Information**  
   The project must include a complete `setup.py` file. This file should not only configure the project as an installable package (supporting `pip install`), but also declare a complete list of dependencies (pytest >= 3.1.0, pytest-flake8 >= 1.3.0, requests_mock >= 1.3.0, werkzeug >= 3.0.3, pytest-cov, certifi >= 2022.12.7, urllib3 >= 2.2.2, pytest-httpbin, pytest-mock, etc.). `setup.py` can verify whether all functional modules work properly. At the same time, it is necessary to provide `__init__.py` in the `mechanicalsoup` package as a unified API entry, exporting core classes and functions such as `Browser`, `StatefulBrowser`, `Form`, `parse_form`, `verify_form`, and including version information, making it convenient for users to access all major functions through `from mechanicalsoup import ...` or `import mechanicalsoup`.

6. **Examples and Evaluation Scripts**  
   Provide rich example code and test cases to demonstrate how to use `parse_form()` and `verify_form()` for form parsing and automated verification.  
   For example, `verify_form(parse_form('<input name="a" value="1">'), parse_form('<input value="1" name="a">'))` should return `True`.  
   All functions need to be combined to form a reproducible automated web operation and verification process.

7. Dependencies and Environment Configuration
All third-party libraries (such as requests, beautifulsoup4, lxml, pytest, etc.) required by functional modules are fully declared in setup.py with name=about['__title__'], supporting one-click installation via pip install and environment verification.

8. **Boundary and Exception Testing**  
   Cover boundary and exception scenarios such as missing forms, page 404 errors, control exceptions, and invalid inputs to ensure that various exceptions can be reasonably captured and handled.


## 3. Environment Configuration (Dependency Libraries)

### Python Version

The Python version used in the current project is: Python 3.10.18

**Runtime Dependencies:**
```
attrs                     25.3.0
beautifulsoup4            4.13.4
blinker                   1.9.0
brotlicffi                1.1.0.0
certifi                   2025.7.14
cffi                      1.17.1
charset-normalizer        3.4.2
click                     8.2.1
coverage                  7.9.2
decorator                 5.2.1
exceptiongroup            1.3.0
execnet                   2.1.1
flake8                    7.3.0
flasgger                  0.9.7.1
Flask                     3.1.1
greenlet                  2.0.2
httpbin                   0.10.2
idna                      3.10
iniconfig                 2.1.0
itsdangerous              2.2.0
Jinja2                    3.1.6
jsonschema                4.25.0
jsonschema-specifications 2025.4.1
lxml                      6.0.0
MarkupSafe                3.0.2
mccabe                    0.7.0
mistune                   3.1.3
packaging                 25.0
pip                       25.1.1
pluggy                    1.6.0
pycodestyle               2.14.0
pycparser                 2.22
pyflakes                  3.4.0
Pygments                  2.19.2
pytest                    8.4.1
pytest-cov                6.2.1
pytest-flake8             1.3.0
pytest-httpbin            2.1.0
pytest-mock               3.14.1
pytest-xdist              3.8.0
PyYAML                    6.0.2
referencing               0.36.2
requests                  2.32.4
requests-mock             1.12.1
rpds-py                   0.26.0
setuptools                65.5.1
six                       1.17.0
soupsieve                 2.7
tomli                     2.2.1
typing_extensions         4.14.1
urllib3                   2.5.0
Werkzeug                  3.1.3
wheel                     0.45.1
```


## 4. Project Directory Structure

```
workspace/
├── .coveragerc
├── .gitignore
├── .mention-bot
├── .readthedocs.yaml
├── CONTRIBUTING.rst
├── LICENSE
├── MANIFEST.in
├── README.rst
├── assets
├── mechanicalsoup
│   ├── __init__.py
│   ├── __version__.py
│   ├── browser.py
│   ├── form.py
│   ├── stateful_browser.py
│   ├── utils.py
└── setup.py

```

## 5. API Usage Guide

### 5.1 Core Classes and Functions

#### 5.1.1 Module Import
```python
import mechanicalsoup
```
#### 5.1.2. Browser Class

**Functional Description**: `Browser` is a low-level browser class that provides basic functionality for interacting with websites. It encapsulates the `requests` library and adds HTML parsing capabilities.

##### 5.1.2.1 Initialization Method

```python
__init__(self, session=None, soup_config={'features': 'lxml'}, requests_adapters=None, raise_on_404=False, user_agent=None)
```

**Parameters**:
- `session`: Optional `requests.Session` instance
- `soup_config`: Configuration passed to BeautifulSoup, defaults to `{'features': 'lxml'}`
- `requests_adapters`: Adapter configuration passed to requests
- `raise_on_404`: If True, raises `LinkNotFoundError` when accessed page returns 404
- `user_agent`: Sets the user agent header

##### 5.1.2.2 Main Methods

`request(method, url, **kwargs)`
**Function**: Low-level method for sending HTTP requests
**Parameters**:
- `method`: HTTP method (GET, POST, etc.)
- `url`: Request URL
- `**kwargs`: Other parameters passed to `requests.Session.request`
**Returns**: `requests.Response` object with added `soup` attribute

`get(url, **kwargs)`
**Function**: Sends GET request
**Parameters**:
- `url`: Request URL
- `**kwargs`: Other parameters passed to `request` method
**Returns**: `requests.Response` object

`post(url, data=None, **kwargs)`
**Function**: Sends POST request
**Parameters**:
- `url`: Request URL
- `data`: Form data to send
- `**kwargs`: Other parameters passed to `request` method
**Returns**: `requests.Response` object

`submit(form, url=None, **kwargs)`
**Function**: Submits form
**Parameters**:
- `form`: Form to submit (bs4.element.Tag or Form object)
- `url`: URL of the page containing the form (required if form action is relative path)
- `**kwargs`: Other parameters passed to `requests.Session.request`
**Returns**: `requests.Response` object

`set_cookiejar(cookiejar)`
**Function**: Replaces current session's cookie jar
**Parameters**:
- `cookiejar`: Any object compatible with `http.cookiejar.CookieJar`

`set_user_agent(user_agent)`
**Function**: Sets user agent
**Parameters**:
- `user_agent`: User agent string

`close()`
**Function**: Closes current session

`_request(form, url=None, **kwargs)`
**Function**: Extracts input data from form and sends request (internal method)
**Parameters**:
- `form`: Form to submit
- `url`: URL of the page containing the form
- `**kwargs`: Other parameters passed to `requests.Session.request`
**Returns**: `requests.Response` object

`get_request_kwargs(form, url=None, **kwargs)`
**Function**: Extracts request parameters from form
**Parameters**:
- `form`: Form to process
- `url`: URL of the page containing the form
- `**kwargs`: Other parameters
**Returns**: Dictionary containing request parameters

`__looks_like_html(response)`
**Function**: Static method, guesses whether response content is HTML based on content (internal use)
**Parameters**:
- `response`: requests.Response object
**Returns**: True if HTML, False otherwise

`add_soup(response, soup_config)`
**Function**: Static method, attaches BeautifulSoup object to response object (internal use)
**Parameters**:
- `response`: requests.Response object
- `soup_config`: BeautifulSoup configuration

`get_cookiejar()`
**Function**: Gets current session's cookiejar
**Returns**: Current session's cookiejar object

`put(url, data=None, **kwargs)`
**Function**: Sends PUT request
**Parameters**:
- `url`: Request URL
- `data`: Data to send
- `**kwargs`: Other parameters passed to `request` method
**Returns**: `requests.Response` object

`_get_request_kwargs(method, url, **kwargs)`
**Function**: Internal method for getting request parameters
**Parameters**:
- `method`: HTTP method
- `url`: Request URL
- `**kwargs`: Other request parameters
**Returns**: Dictionary containing request parameters

`__del__()`
**Function**: Destructor method, ensures resources are properly released

`__enter__()`
**Function**: Context manager entry, supports `with` statement
**Returns**: self

`__exit__(self, *args)`
**Function**: Context manager exit, ensures resources are properly released

`launch_browser(soup)`
**Function**: Opens page in browser (for debugging)
**Parameters**:
- `soup`: Page content to display (bs4 object)

#### 5.1.3 StatefulBrowser Class

##### 5.1.3.1 Overview

##### 5.1.3.2 Initialization

```python
class mechanicalsoup.StatefulBrowser(
    session=None,
    soup_config={'features': 'lxml'},
    requests_adapters=None,
    raise_on_404=False,
    user_agent=None
)
```

**Parameters:**
- `session`: Attach a pre-existing requests Session.
- `soup_config`: Configuration passed to BeautifulSoup for HTML parsing.
- `requests_adapters`: Configuration for HTTP requests.
- `raise_on_404`: If True, raises `LinkNotFoundError` on 404 errors.
- `user_agent`: Sets the User-Agent header.

##### 5.1.3.3 Special Methods

###### __init__
```python
def __init__(self, session=None, soup_config={'features': 'lxml'}, requests_adapters=None, raise_on_404=False, user_agent=None)
```
Initialize a new StatefulBrowser instance.

**Parameters:**
- `session`: Optional requests.Session instance to use.
- `soup_config`: Configuration passed to BeautifulSoup for HTML parsing.
- `requests_adapters`: Optional adapters for requests.
- `raise_on_404`: If True, raise LinkNotFoundError on 404 responses.
- `user_agent`: Custom User-Agent string.

###### __setitem__
```python
def __setitem__(self, name, value)
```
Set the value of a form control by name.

**Parameters:**
- `name`: Name of the form control.
- `value`: Value to set.

##### 5.1.3.4 Properties

###### page
```python
@property
def page(self)
```
**Returns:** The current page as a BeautifulSoup object.

###### url
```python
@property
def url(self)
```
**Returns:** The URL of the currently visited page.

###### form
```python
@property
def form(self)
```
**Returns:** The currently selected form as a `Form` object.
**Raises:** `AttributeError` if no form is selected.

##### 5.1.3.5 Core Methods

###### open
```python
def open(self, url, *args, **kwargs)
```
Open a URL and update the browser state.

**Parameters:**
- `url`: The URL to open.
- Additional arguments are forwarded to `requests.Session.get()`.

**Returns:** The response object.

###### open_fake_page
```python
def open_fake_page(self, page_text, url=None, soup_config=None)
```
Mock version of `open()` for testing.

**Parameters:**
- `page_text`: HTML content to parse.
- `url`: Optional URL for the fake page.
- `soup_config`: Configuration for BeautifulSoup.

###### open_relative
```python
def open_relative(self, url, *args, **kwargs)
```
Open a URL relative to the current page.

**Parameters:**
- `url`: Relative or absolute URL.
- Additional arguments are forwarded to `open()`.

###### refresh
```python
def refresh(self)
```
Reload the current page with the same request.

**Raises:** `ValueError` if the page is not refreshable.
**Returns:** The response object.

##### 5.1.3.6 Form Handling

###### select_form
```python
def select_form(self, selector="form", nr=0)
```
Select a form on the current page.

**Parameters:**
- `selector`: CSS selector or bs4.element.Tag to identify the form.
- `nr`: Zero-based index if multiple forms match the selector.

**Returns:** The selected form as a BeautifulSoup object.

###### new_control
```python
def new_control(self, type, name, value, **kwargs)
```
Create a new form control in the currently selected form.

**Parameters:**
- `type`: Type of the control (e.g., 'text', 'hidden').
- `name`: Name of the control.
- `value`: Initial value of the control.
- `**kwargs`: Additional attributes for the control.

**Returns:** The created control.

###### _merge_referer
```python
def _merge_referer(self, **kwargs)
```
Helper method to add Referer header to requests.

**Parameters:**
- `**kwargs`: Request arguments.

**Returns:** Updated request arguments with Referer header.

###### _find_link_internal
```python
def _find_link_internal(self, link, args, kwargs)
```
Internal method to find a link with special case handling.

**Parameters:**
- `link`: Link element or URL pattern.
- `args`: Positional arguments for link search.
- `kwargs`: Keyword arguments for link search.

**Returns:** Found link element.

###### launch_browser
```python
def launch_browser(self)
```
Launch the system's default web browser to the current page.

**Note:** Primarily used for debugging purposes.

###### submit_selected
```python
def submit_selected(self, btnName=None, update_state=True, **kwargs)
```
Submit the currently selected form.

**Parameters:**
- `btnName`: Name of the submit button to use.
- `update_state`: If False, don't update browser state after submission.
- `**kwargs`: Forwarded to `requests.Session.post()`.

**Returns:** The response object.

##### 5.1.3.7 Navigation

###### follow_link(link=None, *bs4_args, bs4_kwargs={}, requests_kwargs={}, **kwargs)
```python
def follow_link(self, link=None, *bs4_args, bs4_kwargs={}, requests_kwargs={}, **kwargs)
```
Follow a link on the current page.

**Parameters:**
- `link`: Link element or URL pattern to match.
- `bs4_args`, `bs4_kwargs`: Arguments for link search.
- `requests_kwargs`: Arguments for the HTTP request.

**Returns:** The response object.

###### list_links
```python
def list_links(self, *args, **kwargs)
```
Print all links in the current page.

**Parameters:** Forwarded to `links()`.

###### links
```python
def links(self, url_regex=None, link_text=None, *args, **kwargs)
```
Find links in the current page.

**Parameters:**
- `url_regex`: Regular expression to match link URLs.
- `link_text`: Exact text to match in link text.
- Additional arguments are forwarded to BeautifulSoup's `find_all()`.

**Returns:** List of matching link elements.

##### 5.1.3.8 Utility Methods

###### set_debug(debug)
```python
def set_debug(self, debug)
```
Enable or disable debug mode.

**Parameters:**
- `debug`: Boolean to enable/disable debug mode.

###### set_verbose
```python
def set_verbose(self, verbose)
```
Set the verbosity level.

**Parameters:**
- `verbose`: 0 (none), 1 (dots), or 2 (URLs).

###### get_verbose
```python
def get_verbose(self)
```
Get the current verbosity level.

**Returns:** Current verbosity level (0, 1, or 2).

###### get_debug
```python
def get_debug(self)
```
Get the current debug mode status.

**Returns:** Boolean indicating if debug mode is enabled.

###### absolute_url
```python
def absolute_url(self, url)
```
Convert a relative URL to absolute.

**Parameters:**
- `url`: Relative URL.

**Returns:** Absolute URL.

##### 5.1.3.9 Example Usage

```python
import mechanicalsoup

# Create a browser instance
browser = mechanicalsoup.StatefulBrowser()

# Open a webpage
browser.open("http://example.com")

# Select and fill a form
browser.select_form('form[action="/search"]')
browser["q"] = "MechanicalSoup"

# Submit the form
response = browser.submit_selected()

# Print the title of the result page
print(browser.page.title.text)

# Follow a link
browser.follow_link(text="Next page")

# Close the browser
browser.close()
```



#### 5.1.4 Form Class
```python
class mechanicalsoup.Form(form)
```
**Function**: Represents an HTML form, providing field operations and form submission functions.

**Main Methods**:

1. **set(name, value, force=False)**
   - Set the value of a form field
   - Parameters:
     - `name`: Field name
     - `value`: Field value
     - `force`: Whether to force setting read-only/disabled fields

2. **set_input(name, value, force=False)**
   - Set the value of an input field
   - Parameters are the same as `set()`

3. **set_textarea(name, value, force=False)**
   - Set the value of a text area
   - Parameters are the same as `set()`

4. **set_select(name, value, force=False)**
   - Set the value of a select box
   - Parameters are the same as `set()`

5. **set_checkbox(name, value, force=False)**
   - Set the value of a checkbox
   - Parameters are the same as `set()`

6. **set_radio(name, value, force=False)**
   - Set the value of a radio button
   - Parameters are the same as `set()`

7. **set_file(name, filename, file_content)**
   - Set the value of a file upload field
   - Parameters:
     - `name`: Field name
     - `filename`: File name
     - `file_content`: File content (bytes)

8. **uncheck_all(name)**
   - Uncheck all checkboxes and radio buttons with the specified name
   - Parameters: `name`: Field name

9. **choose_submit(button)**
   - Choose a submit button
   - Parameters: `button`: Submit button selector or `Tag` object

10. **print_summary()**
    - Print a summary of the form

11. **__getitem__(name)**
    - Get the value of a field
    - Parameters: `name`: Field name
    - Return: Field value

12. **__setitem__(name, value)**
    - Set the value of a field
    - Parameters:
      - `name`: Field name
      - `value`: Field value

#### 5.1.5 LinkNotFoundError Class
```python
class LinkNotFoundError(Exception):
``` 
**Function**: Thrown when the specified link or form is not found.

#### 5.2 Usage Examples

```python
# Basic usage
import mechanicalsoup

# Create a browser instance
browser = mechanicalsoup.StatefulBrowser(
    soup_config={'features': 'lxml'},
    raise_on_404=True,
    user_agent='MyBot/0.1'
)

# Open a web page
browser.open("https://example.com")

# Select and fill out a form
browser.select_form('form[action="/search"]')
browser["q"] = "MechanicalSoup"
browser.submit_selected()

# Get the content of the current page
print(browser.get_current_page().prettify())

# Download a file
browser.download_link("https://example.com/file.pdf")

# Close the browser
browser.close()
```

```python
# Handle login
browser.open("https://example.com/login")
browser.select_form('form')
browser["username"] = "user"
browser["password"] = "pass"
response = browser.submit_selected()

# Handle file upload
browser.open("https://example.com/upload")
browser.select_form('form[enctype="multipart/form-data"]')
browser.set_file("file_field", "example.txt", b"File content")
response = browser.submit_selected()
```

# Complete Analysis of Detailed Implementation Nodes of MechanicalSoup Functions

## Detailed Implementation Nodes of Functions

### Node 1: Exception Handling and Error Management
  - Input: Various exception scenario trigger conditions
  - Output: Corresponding exception types and error messages
  - Test Interfaces: 
    - `test_LinkNotFoundError` (test_utils.py)
    - `test_no_404` (test_browser.py, test_stateful_browser.py)
    - `test_404` (test_browser.py, test_stateful_browser.py)
    - `test_download_link_404` (test_stateful_browser.py)
  - Description: Handle various exception situations, including link not found, 404 errors, form selection failures, etc.

  ```python
  def test_LinkNotFoundError():
      with pytest.raises(mechanicalsoup.LinkNotFoundError):
          raise mechanicalsoup.utils.LinkNotFoundError
      with pytest.raises(Exception):
          raise mechanicalsoup.utils.LinkNotFoundError

  def test_404(httpbin):
      browser = mechanicalsoup.Browser(raise_on_404=True)
      with pytest.raises(mechanicalsoup.LinkNotFoundError):
          browser.get(httpbin + "/nosuchpage")
      resp = browser.get(httpbin.url)
      assert resp.status_code == 200
  ```

### Node 2: Core Function of Form Submission
  - Input: Form data (in dictionary form)
  - Output: Server response (`Response` object)
  - Test Interfaces: 
    - `test_submit_online` (test_browser.py, test_form.py, test_stateful_browser.py)
    - `test_submit_set` (test_form.py)
    - `test__request` (test_browser.py)
    - `test_submit_btnName` (test_stateful_browser.py)
    - `test_submit_no_btn` (test_stateful_browser.py)
  - Description: Submit forms containing text inputs, radio buttons, checkboxes, and text areas.

  ```python
  def test_submit_online(httpbin):
      """Complete and submit the pizza form at http://httpbin.org/forms/post """
      browser = mechanicalsoup.Browser()
      page = browser.get(httpbin + "/forms/post")
      form = page.soup.form

      form.find("input", {"name": "custname"})["value"] = "Philip J. Fry"
      # leave custtel blank without value
      assert "value" not in form.find("input", {"name": "custtel"}).attrs
      form.find("input", {"name": "size", "value": "medium"})["checked"] = ""
      form.find("input", {"name": "topping", "value": "cheese"})["checked"] = ""
      form.find("input", {"name": "topping", "value": "onion"})["checked"] = ""
      form.find("textarea", {"name": "comments"}).insert(0, "freezer")

      response = browser.submit(form, page.url)

      # helpfully the form submits to http://httpbin.org/post which simply
      # returns the request headers in json format
      json = response.json()
      data = json["form"]
      assert data["custname"] == "Philip J. Fry"
      assert data["custtel"] == ""  # web browser submits "" for input left blank
      assert data["size"] == "medium"
      assert data["topping"] == ["cheese", "onion"]
      assert data["comments"] == "freezer"

      assert json["headers"]["User-Agent"].startswith('python-requests/')
      assert 'MechanicalSoup' in json["headers"]["User-Agent"]
  ```

### Node 3: Cookie Management
  - Input: Cookies (`RequestsCookieJar` object)
  - Output: Updated cookies
  - Test Interfaces: 
    - `test_set_cookiejar` (test_browser.py)
    - `test_get_cookiejar` (test_browser.py)
    - `test_requests_session_and_cookies` (test_stateful_browser.py)
  - Description: Set and get the cookies of the browser session.

  ```python
  def test_set_cookiejar(httpbin):
      """Set cookies locally and test that they are received remotely."""
      # construct a phony cookiejar and attach it to the session
      jar = RequestsCookieJar()
      jar.set('field', 'value')
      assert jar.get('field') == 'value'

      browser = mechanicalsoup.Browser()
      browser.set_cookiejar(jar)
      resp = browser.get(httpbin + "/cookies")
      assert resp.json() == {'cookies': {'field': 'value'}}

  def test_get_cookiejar(httpbin):
      """Test that cookies set by the remote host update our session."""
      browser = mechanicalsoup.Browser()
      resp = browser.get(httpbin + "/cookies/set?k1=v1&k2=v2")
      assert resp.json() == {'cookies': {'k1': 'v1', 'k2': 'v2'}}

      jar = browser.get_cookiejar()
      assert jar.get('k1') == 'v1'
      assert jar.get('k2') == 'v2'
  ```

### Node 4: HTTP Method Support
  - Supported Methods: GET, POST, PUT
  - Test Interfaces: 
    - `test_post` (test_browser.py)
    - `test_put` (test_browser.py)
    - `test_request_forward` (test_stateful_browser.py)
  - Description: Support multiple HTTP request methods.

  ```python
  def test_post(httpbin):
      browser = mechanicalsoup.Browser()
      data = {'color': 'blue', 'colorblind': 'True'}
      resp = browser.post(httpbin + "/post", data)
      assert resp.status_code == 200 and resp.json()['form'] == data

  def test_put(httpbin):
      browser = mechanicalsoup.Browser()
      data = {'color': 'blue', 'colorblind': 'True'}
      resp = browser.put(httpbin + "/put", data)
      assert resp.status_code == 200 and resp.json()['form'] == data
  ```

### Node 5: Form Field Operations
  - Input: Dictionary of field names and values
  - Output: Updated form data
  - Test Interfaces: 
    - `test_form_set_radio_checkbox` (test_form.py, test_stateful_browser.py)
    - `test_set_select` (test_form.py)
    - `test_set_select_multiple` (test_form.py)
    - `test_form_check_uncheck` (test_form.py)
    - `test_new_control` (test_stateful_browser.py)
  - Description: Operate on various form elements, including text inputs, radio buttons, checkboxes, drop-down select boxes, etc.

  ```python
  def test_form_set_radio_checkbox(capsys):
      browser = mechanicalsoup.StatefulBrowser()
      browser.open_fake_page(page_with_various_fields,
                            url="http://example.com/invalid/")
      form = browser.select_form("form")
      form.set_radio({"size": "small"})
      form.set_checkbox({"topping": "cheese"})
      browser.form.print_summary()
      out, err = capsys.readouterr()
      # Different versions of bs4 show either <input></input> or
      # <input/>. Normalize before comparing.
      out = out.replace('></input>', '/>')
      assert out == """<input name="foo"/>
  <textarea name="bar"></textarea>
  <select name="entree">
  <option selected="selected" value="tofu">Tofu Stir Fry</option>
  <option value="curry">Red Curry</option>
  <option value="tempeh">Tempeh Tacos</option>
  </select>
  <input name="topping" type="checkbox" value="bacon"/>
  <input checked="" name="topping" type="Checkbox" value="cheese"/>
  <input name="topping" type="checkbox" value="onion"/>
  <input name="topping" type="checkbox" value="mushroom"/>
  <input checked="" name="size" type="Radio" value="small"/>
  <input name="size" type="radio" value="medium"/>
  <input name="size" type="radio" value="large"/>
  <button name="action" value="cancel">Cancel</button>
  <input type="submit" value="Select"/>
  """
      assert err == ""
  ```

### Node 6: Submit Button Selection
  - Input: Button name or CSS selector
  - Output: Selected submit button
  - Test Interfaces: 
    - `test_choose_submit` (test_form.py)
    - `test_choose_submit_from_selector` (test_form.py)
    - `test_choose_submit_fail` (test_form.py)
    - `test_choose_submit_twice` (test_form.py)
    - `test_choose_submit_multiple_match` (test_form.py)
    - `test_choose_submit_buttons` (test_form.py)
  - Description: Select a specific submit button in a form with multiple submit buttons.

  ```python
  @pytest.mark.parametrize("expected_post", [
      pytest.param(
          [
              ('text', 'Setting some text!'),
              ('comment', 'Testing preview page'),
              ('preview', 'Preview Page'),
          ], id='preview'),
      pytest.param(
          [
              ('text', '= Heading =\n\nNew page here!\n'),
              ('comment', 'Created new page'),
              ('save', 'Submit changes'),
          ], id='save'),
      pytest.param(
          [
              ('text', '= Heading =\n\nNew page here!\n'),
              ('comment', 'Testing choosing cancel button'),
              ('cancel', 'Cancel'),
          ], id='cancel'),
  ])
  def test_choose_submit(expected_post):
      browser, url = setup_mock_browser(expected_post=expected_post)
      browser.open(url)
      form = browser.select_form('#choose-submit-form')
      browser['text'] = dict(expected_post)['text']
      browser['comment'] = dict(expected_post)['comment']
      form.choose_submit(expected_post[2][0])
      res = browser.submit_selected()
      assert res.status_code == 200 and res.text == 'Success!'
  ```

### Node 7: Page Navigation
  - Input: URL or relative path
  - Output: Response of the new page
  - Test Interfaces: 
    - `test_open_relative` (test_stateful_browser.py)
    - `test_refresh_open` (test_stateful_browser.py)
    - `test_refresh_follow_link` (test_stateful_browser.py)
    - `test_refresh_form_not_retained` (test_stateful_browser.py)
    - `test_refresh_error` (test_stateful_browser.py)
  - Description: Handle relative and absolute URL navigation and page refresh functions.

  ```python
  def test_open_relative(httpbin):
      # Open an arbitrary httpbin page to set the current URL
      browser = mechanicalsoup.StatefulBrowser()
      browser.open(httpbin + "/html")

      # Open a relative page and make sure remote host and browser agree on URL
      resp = browser.open_relative("/get")
      assert resp.json()['url'] == httpbin + "/get"
      assert browser.url == httpbin + "/get"

      # Test passing additional kwargs to the session
      resp = browser.open_relative("/basic-auth/me/123", auth=('me', '123'))
      assert browser.url == httpbin + "/basic-auth/me/123"
      assert resp.json() == {"authenticated": True, "user": "me"}
  ```

### Node 8: Link Tracking
  - Input: Link text, URL, or regular expression
  - Output: Page pointed to by the link
  - Test Interfaces: 
    - `test_follow_link_arg` (test_stateful_browser.py)
    - `test_follow_link_from_tag` (test_stateful_browser.py)
    - `test_follow_link_excess` (test_stateful_browser.py)
    - `test_follow_link_ua` (test_stateful_browser.py)
    - `test_link_arg_multiregex` (test_stateful_browser.py)
    - `test_links` (test_stateful_browser.py)
    - `test_find_link` (test_stateful_browser.py)
  - Description: Track links based on text, URL, or regular expression.

  ```python
  @pytest.mark.parametrize('expected, kwargs', [
      pytest.param('/foo', {}, id='none'),
      pytest.param('/get', {'string': 'Link'}, id='string'),
      pytest.param('/get', {'url_regex': 'get'}, id='regex'),
  ])
  def test_follow_link_arg(httpbin, expected, kwargs):
      browser = mechanicalsoup.StatefulBrowser()
      html = '<a href="/foo">Bar</a><a href="/get">Link</a>'
      browser.open_fake_page(html, httpbin.url)
      browser.follow_link(bs4_kwargs=kwargs)
      assert browser.url == httpbin + expected

  def test_links():
      browser = mechanicalsoup.StatefulBrowser()
      html = '''<a class="bluelink" href="/blue" id="blue_link">A Blue Link</a>
                <a class="redlink" href="/red" id="red_link">A Red Link</a>'''
      expected = [BeautifulSoup(html, "lxml").a]
      browser.open_fake_page(html)

      # Test StatefulBrowser.links url_regex argument
      assert browser.links(url_regex="bl") == expected
      assert browser.links(url_regex="bluish") == []

      # Test StatefulBrowser.links link_text argument
      assert browser.links(link_text="A Blue Link") == expected
      assert browser.links(link_text="Blue") == []
  ```

### Node 9: File Upload
  - Input: File path or file object
  - Output: Response of the upload request
  - Test Interfaces: 
    - `test_upload_file` (test_stateful_browser.py)
    - `test_upload_file_with_malicious_default` (test_stateful_browser.py)
    - `test_upload_file_raise_on_string_input` (test_stateful_browser.py)
    - `test_enctype_and_file_submit` (test_browser.py)
  - Description: Handle file upload forms, including security checks and encoding type processing.

  ```python
  def test_upload_file(httpbin):
      browser = mechanicalsoup.StatefulBrowser()
      url = httpbin + "/post"
      file_input_form = f"""
      <form method="post" action="{url}" enctype="multipart/form-data">
          <input type="file" name="first" />
      </form>
      """

      # Create two temporary files to upload
      def make_file(content):
          path = tempfile.mkstemp()[1]
          with open(path, "w") as fd:
              fd.write(content)
          return path
      path1 = make_file("first file content")
      path2 = make_file("second file content")

      browser.open_fake_page(file_input_form)
      browser.select_form()

      # Test filling an existing input and creating a new input
      with open(path1, "rb") as value1, open(path2, "rb") as value2:
          browser["first"] = value1
          browser.new_control("file", "second", value2)
          response = browser.submit_selected()

      files = response.json()["files"]
      assert files["first"] == "first file content"
      assert files["second"] == "second file content"
  ```

### Node 10: File Download
  - Input: Target file path (optional)
  - Output: Downloaded file content or saved to the specified path
  - Test Interfaces: 
    - `test_download_link` (test_stateful_browser.py)
    - `test_download_link_nofile` (test_stateful_browser.py)
    - `test_download_link_nofile_bs4` (test_stateful_browser.py)
    - `test_download_link_nofile_excess` (test_stateful_browser.py)
    - `test_download_link_nofile_ua` (test_stateful_browser.py)
    - `test_download_link_to_existing_file` (test_stateful_browser.py)
    - `test_download_link_referer` (test_stateful_browser.py)
  - Description: Download the content of a link and optionally save it to a file.

  ```python
  def test_download_link(httpbin):
      """Test downloading the contents of a link to file."""
      browser = mechanicalsoup.StatefulBrowser()
      open_legacy_httpbin(browser, httpbin)
      tmpdir = tempfile.mkdtemp()
      tmpfile = tmpdir + '/nosuchfile.png'
      current_url = browser.url
      current_page = browser.page
      response = browser.download_link(file=tmpfile, link='image/png')

      # Check that the browser state has not changed
      assert browser.url == current_url
      assert browser.page == current_page

      # Check that the file was downloaded
      assert os.path.isfile(tmpfile)
      assert file_get_contents(tmpfile) == response.content
      # Check that we actually downloaded a PNG file
      assert response.content[:4] == b'\x89PNG'

  def test_download_link_nofile(httpbin):
      """Test downloading the contents of a link without saving it."""
      browser = mechanicalsoup.StatefulBrowser()
      open_legacy_httpbin(browser, httpbin)
      current_url = browser.url
      current_page = browser.page
      response = browser.download_link(link='image/png')

      # Check that the browser state has not changed
      assert browser.url == current_url
      assert browser.page == current_page

      # Check that we actually downloaded a PNG file
      assert response.content[:4] == b'\x89PNG'
  ```

### Node 11: Request Header Management
  - Input: Custom request headers
  - Output: Request containing custom request headers
  - Test Interfaces: 
    - `test_referer_submit` (test_stateful_browser.py)
    - `test_referer_submit_override` (test_stateful_browser.py)
    - `test_referer_submit_headers` (test_stateful_browser.py)
    - `test_referer_follow_link` (test_stateful_browser.py)
    - `test_user_agent` (test_stateful_browser.py)
    - `test_submit_dont_modify_kwargs` (test_stateful_browser.py)
  - Description: Manage HTTP request headers, such as Referer and User-Agent.

  ```python
  def test_referer_submit(httpbin):
      browser = mechanicalsoup.StatefulBrowser()
      ref = "https://example.com/my-referer"
      page = submit_form_headers.format(httpbin.url + "/headers")
      browser.open_fake_page(page, url=ref)
      browser.select_form()
      response = browser.submit_selected()
      headers = response.json()["headers"]
      referer = headers["Referer"]
      actual_ref = re.sub('/*$', '', referer)
      assert actual_ref == ref

  @pytest.mark.parametrize("referer_header", ["Referer", "referer"])
  def test_referer_submit_override(httpbin, referer_header):
      """Ensure the caller can override the Referer header that
      mechanicalsoup would normally add. Because headers are case insensitive,
      test with both 'Referer' and 'referer'.
      """

      browser = mechanicalsoup.StatefulBrowser()
      ref = "https://example.com/my-referer"
      ref_override = "https://example.com/override"
      page = submit_form_headers.format(httpbin.url + "/headers")
      browser.open_fake_page(page, url=ref)
      browser.select_form()
      response = browser.submit_selected(headers={referer_header: ref_override})
      headers = response.json()["headers"]
      referer = headers["Referer"]
      actual_ref = re.sub('/*$', '', referer)
      assert actual_ref == ref_override
  ```

### Node 12: Form Parsing and Construction
  - Input: HTML form elements or tag objects
  - Output: `Form` object
  - Test Interfaces: 
    - `test_construct_form_fail` (test_form.py)
    - `test_form_print_summary` (test_form.py)
    - `test_select_form_nr` (test_stateful_browser.py)
    - `test_select_form_tag_object` (test_stateful_browser.py)
    - `test_select_form_associated_elements` (test_stateful_browser.py)
  - Description: Parse HTML form structures and create `Form` objects.

  ```python
  def test_construct_form_fail():
      """Form objects must be constructed from form html elements."""
      soup = bs4.BeautifulSoup('<notform>This is not a form</notform>', 'lxml')
      tag = soup.find('notform')
      assert isinstance(tag, bs4.element.Tag)
      with pytest.warns(FutureWarning, match="from a 'notform'"):
          mechanicalsoup.Form(tag)

  def test_select_form_nr():
      """Test the nr option of select_form."""
      forms = """<form id="a"></form><form id="b"></form><form id="c"></form>"""
      with mechanicalsoup.StatefulBrowser() as browser:
          browser.open_fake_page(forms)
          form = browser.select_form()
          assert form.form['id'] == "a"
          form = browser.select_form(nr=1)
          assert form.form['id'] == "b"
          form = browser.select_form(nr=2)
          assert form.form['id'] == "c"
          with pytest.raises(mechanicalsoup.LinkNotFoundError):
              browser.select_form(nr=3)
  ```

### Node 13: Browser State Management
  - Input: Browser state change operations
  - Output: Updated browser state
  - Test Interfaces: 
    - `test_properties` (test_stateful_browser.py)
    - `test_get_selected_form_unselected` (test_stateful_browser.py)
    - `test_submit_dont_update_state` (test_stateful_browser.py)
    - `test_with` (test_stateful_browser.py)
  - Description: Manage the browser's page, form, URL, and other state information.

  ```python
  def test_properties():
      """Check that properties return the same value as the getter."""
      browser = mechanicalsoup.StatefulBrowser()
      browser.open_fake_page('<form></form>', url="http://example.com")
      assert browser.page == browser.get_current_page()
      assert browser.page is not None
      assert browser.url == browser.get_url()
      assert browser.url is not None
      browser.select_form()
      assert browser.form == browser.get_current_form()
      assert browser.form is not None

  def test_get_selected_form_unselected():
      browser = mechanicalsoup.StatefulBrowser()
      browser.open_fake_page('<form></form>')
      with pytest.raises(AttributeError, match="No form has been selected yet."):
          browser.form
      assert browser.get_current_form() is None
  ```

### Node 14: Encoding Handling
  - Input: Web page content in different encodings
  - Output: Correctly decoded page content
  - Test Interfaces: 
    - `test_encoding` (test_browser.py)
  - Description: Handle web page content in different character encodings.

  ```python
  @pytest.mark.parametrize("http_html_expected_encoding", [
      pytest.param((None, 'utf-8', 'utf-8')),
      pytest.param(('utf-8', 'utf-8', 'utf-8')),
      pytest.param(('utf-8', None, 'utf-8')),
      pytest.param(('utf-8', 'ISO-8859-1', 'utf-8')),
  ])
  def test_encoding(httpbin, http_html_expected_encoding):
      http_encoding = http_html_expected_encoding[0]
      html_encoding = http_html_expected_encoding[1]
      expected_encoding = http_html_expected_encoding[2]

      url = 'mock://encoding'
      text = (
          '<!doctype html>'
          + '<html lang="fr">'
          + (
              (
                  '<head><meta charset="'
                  + html_encoding
                  + '"><title>Titleéàè</title></head>'
              ) if html_encoding
              else ''
          )
          + '<body></body>'
          + '</html>'
      )

      browser, adapter = prepare_mock_browser()
      mock_get(
          adapter,
          url=url,
          reply=(
              text.encode(http_encoding)
              if http_encoding
              else text.encode("utf-8")
          ),
          content_type=(
              'text/html'
              + (
                  ';charset=' + http_encoding
                  if http_encoding
                  else ''
              )
          )
      )
      browser.open(url)
      assert browser.page.original_encoding == expected_encoding
  ```

### Node 15: Form Verification and Error Handling
  - Input: Various form verification scenarios
  - Output: Verification results or exceptions
  - Test Interfaces: 
    - `test_form_not_found` (test_form.py)
    - `test_form_noaction` (test_form.py, test_stateful_browser.py)
    - `test_form_action` (test_form.py)
    - `test_form_noname` (test_stateful_browser.py)
    - `test_form_multiple` (test_stateful_browser.py)
    - `test__request_select_none` (test_browser.py)
    - `test__request_disabled_attr` (test_browser.py)
    - `test_request_keyword_error` (test_browser.py)
    - `test_get_request_kwargs_when_method_is_in_kwargs` (test_browser.py)
    - `test_get_request_kwargs_when_url_is_in_kwargs` (test_browser.py)
  - Description: Verify form fields, handle form errors, and boundary conditions.

  ```python
  def test_form_not_found():
      browser = mechanicalsoup.StatefulBrowser()
      browser.open_fake_page(page_with_various_fields)
      form = browser.select_form('form')
      with pytest.raises(mechanicalsoup.utils.LinkNotFoundError):
          form.input({'foo': 'bar', 'nosuchname': 'nosuchval'})
      with pytest.raises(mechanicalsoup.utils.LinkNotFoundError):
          form.check({'foo': 'bar', 'nosuchname': 'nosuchval'})
      with pytest.raises(mechanicalsoup.utils.LinkNotFoundError):
          form.check({'entree': 'cheese'})

  def test__request_disabled_attr(httpbin):
      """Make sure that disabled form controls are not submitted."""
      form_html = f"""
      <form method="post" action="{httpbin.url}/post">
        <input disabled name="nosubmit" value="1" />
      </form>"""

      browser = mechanicalsoup.Browser()
      response = browser._request(BeautifulSoup(form_html, "lxml").form)
      assert response.json()['form'] == {}
  ```

### Node 16: Session Management
  - Input: Session object or configuration
  - Output: Configured session state
  - Test Interfaces: 
    - `test_requests_session_and_cookies` (test_stateful_browser.py)
    - `test_get_request_kwargs` (test_browser.py)
  - Description: Manage HTTP sessions and request configurations.

  ```python
  def test_requests_session_and_cookies(httpbin):
      """Check that the session object passed to the constructor of
      StatefulBrowser is actually taken into account."""
      s = requests.Session()
      requests.utils.add_dict_to_cookiejar(s.cookies, {'key1': 'val1'})
      browser = mechanicalsoup.StatefulBrowser(session=s)
      resp = browser.get(httpbin + "/cookies")
      assert resp.json() == {'cookies': {'key1': 'val1'}}

  def test_get_request_kwargs(httpbin):
      """Return kwargs without a submit"""
      browser = mechanicalsoup.Browser()
      page = browser.get(httpbin + "/forms/post")
      form = page.soup.form
      form.find("input", {"name": "custname"})["value"] = "Philip J. Fry"
      request_kwargs = browser.get_request_kwargs(form, page.url)
      assert "method" in request_kwargs
      assert "url" in request_kwargs
      assert "data" in request_kwargs
      assert ("custname", "Philip J. Fry") in request_kwargs["data"]
  ```

### Node 17: Debugging Functions
  - Input: Debugging configurations and settings
  - Output: Debugging information and status
  - Test Interfaces: 
    - `test_get_set_debug` (test_stateful_browser.py)
    - `test_list_links` (test_stateful_browser.py)
    - `test_launch_browser` (test_stateful_browser.py)
    - `test_verbose` (test_stateful_browser.py)
  - Description: Provide debugging and diagnostic functions.

  ```python
  def test_get_set_debug():
      browser = mechanicalsoup.StatefulBrowser()
      # Debug mode is off by default
      assert not browser.get_debug()
      browser.set_debug(True)
      assert browser.get_debug()

  def test_list_links(capsys):
      # capsys is a pytest fixture that allows us to inspect the std{err,out}
      browser = mechanicalsoup.StatefulBrowser()
      links = '''
       <a href="/link1">Link #1</a>
       <a href="/link2" id="link2"> Link #2</a>
  '''
      browser.open_fake_page(f'<html>{links}</html>')
      browser.list_links()
      out, err = capsys.readouterr()
      expected = f'Links in the current page:{links}'
      assert out == expected

  def test_verbose(capsys):
      '''Tests that the btnName argument chooses the submit button.'''
      browser, url = setup_mock_browser()
      browser.open(url)
      out, err = capsys.readouterr()
      assert out == ""
      assert err == ""
      assert browser.get_verbose() == 0
      browser.set_verbose(1)
      browser.open(url)
      out, err = capsys.readouterr()
      assert out == "."
      assert err == ""
      assert browser.get_verbose() == 1
      browser.set_verbose(2)
      browser.open(url)
      out, err = capsys.readouterr()
      assert out == "mock://form.com\n"
      assert err == ""
      assert browser.get_verbose() == 2
  ```

### Node 18: Special Form Handling
  - Input: Form elements with special structures
  - Output: Correctly processed form data
  - Test Interfaces: 
    - `test_issue158` (test_form.py)
    - `test_duplicate_submit_buttons` (test_form.py)
    - `test_issue180` (test_form.py)
    - `test_option_without_value` (test_form.py)
  - Description: Handle special form structures and boundary conditions.

  ```python
  def test_issue158():
      """Test that form elements are processed in their order on the page
      and that elements with duplicate name-attributes are not clobbered."""
      issue158_form = '''
  <form method="post" action="mock://form.com/post">
    <input name="box" type="hidden" value="1"/>
    <input checked="checked" name="box" type="checkbox" value="2"/>
    <input name="box" type="hidden" value="0"/>
    <input type="submit" value="Submit" />
  </form>
  '''
      expected_post = [('box', '1'), ('box', '2'), ('box', '0')]
      browser, url = setup_mock_browser(expected_post=expected_post,
                                        text=issue158_form)
      browser.open(url)
      browser.select_form()
      res = browser.submit_selected()
      assert res.status_code == 200 and res.text == 'Success!'
      browser.close()

  def test_option_without_value(fail, selected, expected_post):
      """Option tag in select can have no value option"""
      text = """
      <form method="post" action="mock://form.com/post">
        <select name="selector">
          <option value="with_value">We have a value here</option>
          <option>Without value</option>
        </select>
        <button type="submit">Submit</button>
      </form>
      """
      browser, url = setup_mock_browser(expected_post=expected_post,
                                        text=text)
      browser.open(url)
      browser.select_form()
      if fail:
          with pytest.raises(mechanicalsoup.utils.LinkNotFoundError):
              browser['selector'] = selected
      else:
          browser['selector'] = selected

          res = browser.submit_selected()
          assert res.status_code == 200 and res.text == 'Success!'
  ```