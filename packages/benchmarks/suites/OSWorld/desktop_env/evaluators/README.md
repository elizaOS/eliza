# Evaluator Setup Details
Setup scaffolding for the evaluators in the desktop environment for those who want to know the details of the evaluator setup for customized evaluation and extension

## Overall
Inside the virtual machine, disable the system crash report by:
```
sudo vim /etc/default/apport
```
and then change the `enabled` to `0`.

## VSCode 
todo

## LibreOffice
For LibreOffice, please enter into the app first, and then enable the no pop-up when 'ctrl + s'.

## LibreOffice Press
### Setting Up the python-pptx Library
```shell
pip install python-pptx
```

## LibreOffice Writer

### Setting Up the python-docx and odfpy Library
```shell
pip install python-docx
pip install odfpy
```

## LibreOffice Calc

### Required Libraries

```
openpyxl
pandas
lxml
xmltodict
```

### How to Generate CSV from XLSX

```sh
libreoffice --convert-to "csv:Text - txt - csv (StarCalc):44,34,UTF8,,,,false,true,true,false,false,1" --out-dir /home/user /home/user/abc.xlsx
```

This command will generate `abc-Sheet1.csv` under `/home/user`. The last `1` in
the conversion options indicates the sheet number (starting from 1) to export.
Detailed usage should be referred to at [CSV Filter
Options](https://help.libreoffice.org/latest/ro/text/shared/guide/csv_params.html).

Refer to `libreoffice_calc/21df9241-f8d7-4509-b7f1-37e501a823f7.json` for an
example.

### About `compare_table`

Evaluation to xlsx files mainly relies on `compare_table`. It accepts two file
names and a list of rules defined as `options`. Refer to
`libreoffice_calc/21df9241-f8d7-4509-b7f1-37e501a823f7.json` for an example.

In each rule, there is a required field `type`. The supported types are defined
in `compare_table` function. The most common two are `sheet_data` and
`sheet_print`. `sheet_data` compares the internal cell values through pandoc,
while `sheet_print` compares the shown cell values through csv. A csv should be
generated and downloaded for `sheet_print`. See the previous section and
example in `libreoffice_calc/21df9241-f8d7-4509-b7f1-37e501a823f7.json`.

Other fields in a rule are described for each evaluation type in
`compare_table` function. `sheet_idx0` (or `sheet_idx1`, `sheet_idx`) is a
common field to indicate which sheet is to extracted from the workbook. If an
integer i is given, then it extracts the i-th sheet from result xlsx (i starts
from 0). If a string is given, it should be preceded with "RI", "RN", "EI", or
"EN". "R" indicates to extract from result xlsx while "E" indicates to extract
from expected (golden) xlsx. "I" indicates a sheet number (starting from 0) and
"N" indicates a sheet name (usually, they're like "Sheet1", "Sheet2", ...).

Some rules use a atructure like `{"method": "eq", "ref": "abc"}`. These rules
are checked through `utils._match_value_to_rule` function. Check it for the
implemented matching methods.

## Chrome

### Starting Chrome with Remote Debugging for Python

To enable remote debugging in Chrome, which allows tools like Playwright for Python to connect to and control an existing Chrome instance, follow these steps:

#### Manually Enabling Remote Debugging in Chrome

1. **Locate the Chrome Shortcut**:
   - Find the Chrome shortcut that you usually use to open the browser. This could be on your desktop, start menu, or taskbar.

2. **Edit Shortcut Properties**:
   - Right-click on the Chrome shortcut and select `Properties`.

3. **Modify the Target Field**:
   - In the `Target` field, add `--remote-debugging-port=9222` at the end of the path. Ensure there is a space between the path and the flag you add.
   - It should look something like this: `"C:\Path\To\Chrome.exe" --remote-debugging-port=9222`.

4. **Apply and Close**:
   - Click `Apply` and then `OK` to close the dialog.

5. **Start Chrome**:
   - Use this modified shortcut to start Chrome. Chrome will now start with remote debugging enabled on port 9222.

6. **Confirm Remote Debugging**:
   - Open a browser and navigate to `http://localhost:9222`. If you see a webpage with information about active tabs, remote debugging is working.

---

### Setting Up Playwright for Python

Playwright for Python is a browser automation library to control Chromium, Firefox, and WebKit with a single API.

#### Installing Playwright

- Ensure you have Python installed on your system. If not, download and install it from the [Python official website](https://www.python.org/).

- Install Playwright using pip (Python Package Installer). Open a command line or terminal and run:

  ```bash
  pip install playwright
  ```

- After installing Playwright, you need to run the install command to download the necessary browser binaries:

  ```bash
  playwright install
  ```

#### Writing a Playwright Script in Python

- Create a Python file for your automation script.

- Import the Playwright module at the beginning of your script:

  ```python
  from playwright.sync_api import sync_playwright
  ```

- You can now use Playwright's API to control browsers.

#### Example Playwright Script

Here is a simple example to open a page using Playwright:

```python
from playwright.sync_api import sync_playwright

def run(playwright):
    browser = playwright.chromium.launch()
    page = browser.new_page()
    page.goto("http://example.com")
    ## other actions...
    browser.close()

with sync_playwright() as playwright:
    run(playwright)
```

- This script launches Chromium, opens a new page, navigates to `example.com`, and then closes the browser.

#### Troubleshooting

- If you encounter issues with Playwright, ensure that your Python environment is correctly set up and that you have installed Playwright and its dependencies correctly.
- For detailed documentation, visit the [Playwright for Python Documentation](https://playwright.dev/python/docs/intro).


## VLC Media Player

### Bugs fix
One thing on Ubuntu need to do, enter into the `meida`>`convert/save`>select files>`convert/save`
Then enter the profile of `Audio - MP3`, change the profile for mp3, section audiocodec from "MP3" to "MPEG Audio"
Otherwise the mp3 file will be created but with 0 bytes. It's a bug of VLC.

### Setting Up VLC's HTTP Interface

To enable and use the HTTP interface in VLC Media Player for remote control and status checks, follow these steps:

#### 1. Open VLC Preferences

- Open VLC Media Player.
- Go to `Tools` > `Preferences` from the menu.

#### 2. Show All Settings

- In the Preferences window, at the bottom left corner, select `All` under `Show settings` to display advanced settings.

#### 3. Enable Main Interfaces

- In the advanced preferences, expand the `Interface` section.
- Click on `Main interfaces`.
- Check the box for `Web` to enable the HTTP interface.

#### 4. Configure Lua HTTP

- Expand the `Main interfaces` node and select `Lua`.
- Under `Lua HTTP`, set a password `password` in the `Lua HTTP` section. This password will be required to access the HTTP interface.

#### 5. Save and Restart VLC

- Click `Save` to apply the changes.
- Restart VLC Media Player for the changes to take effect.

#### 6. Accessing the HTTP Interface

- Open a web browser and go to `http://localhost:8080`.
- You will be prompted for a password. Enter the password you set in the Lua HTTP settings.
- Once logged in, you will have access to VLC's HTTP interface for remote control.

#### Packages
```bash

pip install opencv-python-headless Pillow imagehash
```

#### Troubleshooting

- If you cannot access the HTTP interface, check if your firewall or security software is blocking the connection.
- Ensure VLC is running and the correct port (default is 8080) is being used.
- If the port is in use by another application, you may change the port number in VLC's settings.

## GIMP
Click on the "Keep" of the image loading pop-up.
