## Introduction and Goals of the Mootdx Project

Mootdx is a Python library **designed for accessing Tongda信 data**. It can connect to the Tongda信 software and retrieve real-time and historical data for financial markets such as stocks and futures. This tool excels in the field of financial data retrieval, achieving "efficient data reading and flexible format conversion." Its core functions include: reading offline Tongda信 data (automatically parsing data formats such as daily, minute, and tick lines), **retrieving real-time quotes data** (supporting multi-threaded connections and heartbeat detection), and intelligently processing special data such as financial data and ex-rights/ex-dividend information. In short, Mootdx aims to provide a robust financial data interface system for retrieving and analyzing various types of data in the Chinese A-share market (for example, using `Reader()` to read local Tongda信 data files and `Quotes()` to obtain real-time quotes data).

## Natural Language Instruction (Prompt)

Please create a Python project named Mootdx to implement a Tongda信 data reading interface library. The project should include the following functions:

1. **Offline Data Reader**: Capable of reading and parsing stock data files from the local Tongda信 data directory, supporting daily data (`.day` files), minute data (`.1/.5/.lc1/.lc5` files), and tick data. The parsed results should be in the pandas DataFrame format, including fields such as open price, high price, low price, close price, and trading volume.

2. **Real-time Quotes Interface**: Implement functions to connect to the Tongda信 server and obtain real-time quotes data, including K-line data, index data, and minute data. It should support multi-threaded connections, heartbeat detection, automatic reconnection, and data adjustment functions such as forward and backward adjustment.

3. **Financial Data Processing**: Specialize in processing financial data files, including functions such as obtaining the financial data file list, downloading files, and parsing data. Support batch downloading and single-file processing, and be able to convert financial data into a structured format.

4. **Server Management**: Implement functions such as server IP testing, optimal server selection, and connection status monitoring. Support automatic testing of server response times, select the best-connected server, and provide connection pool management.

5. **Command-line Tools**: Design independent command-line interfaces for each functional module to support terminal calls for testing. Include commands such as `quotes` (real-time quotes), `reader` (offline data), `affair` (financial data), and `bestip` (server testing). Each module should define clear input and output formats.

6. **Data Format Conversion**: Provide data format conversion functions, supporting multiple output formats such as CSV, Excel, HDF5, and JSON, as well as data caching and scheduled update mechanisms.

The above functions need to be combined to build a complete Tongda信 data interface toolkit. The project should ultimately include modules such as offline reading, real-time quotes, financial data, server management, and command-line tools, along with typical test cases, to form a reproducible data retrieval process.

7. **Core File Requirements**: The project must include a complete `pyproject.toml` file. This file should not only configure the project as an installable package (supporting `pip install`) but also declare a complete list of dependencies (including core libraries such as `tdxpy>=0.2.5`, `httpx>=0.25.0`, `tenacity>=8.1.0`, `pandas`, `numpy`, `click>=8.1.3`, `prettytable>=3.5.0`, `tqdm`, `mini-racer>=0.12.0`, `pytest>=7.3.1`). The `pyproject.toml` can verify whether all functional modules work properly. Additionally, it is necessary to provide `mootdx/__init__.py` as a unified API entry, importing core classes such as `Reader`, `Quotes`, and `Affair` from modules like `reader`, `quotes`, and `affair`, importing utility functions such as `get_config_path`, `get_stock_market`, `to_data`, and `md5sum` from the `utils` module, exporting market constants such as `MARKET_SH`, `MARKET_SZ`, and `MARKET_BJ` from the `consts` module, and exporting the `Customize` custom sector management class from the `tools.customize` module. It should also provide version information, allowing users to access all major functions through a simple statement like `from mootdx/mootdx.affair/cache/consts/exceptions/logger/quotes/reader/tools/utils/contrib import *`. In `quotes.py`, there should be a `factory()` function to create quotes clients for different market types. In `reader.py`, there should be a `factory()` function to create data readers for different market types. In `utils/__init__.py`, there should be a `get_stock_market()` function to determine the securities market corresponding to a stock code and a `to_data()` function to convert data into the DataFrame format. In `tools/customize.py`, there should be a `Customize` class to manage operations such as creating, searching, updating, and deleting custom sectors.

## Environment Configuration

### Python Version

The Python version used in the current project is: Python 3.11.7

### Core Dependency Library Versions

```Plain
anyio             3.7.0
certifi           2023.5.7
click             8.1.3
coverage          7.10.4
freezegun         1.5.5
h11               0.14.0
httpcore          0.18.0
httpx             0.25.0
idna              3.4
iniconfig         2.1.0
mini-racer        0.12.0
numpy             1.24.3
packaging         25.0
pandas            1.5.3
pytdx             1.72
pip               23.2.1
pluggy            1.6.0
prettytable       3.7.0
Pygments          2.19.2
pytest            8.4.1
pytest-cov        6.2.1
pytest-datadir    1.8.0
python-dateutil   2.8.2
pytz              2023.3
setuptools        65.5.1
six               1.16.0
sniffio           1.3.0
tdxpy             0.2.5
tenacity          8.2.2
tqdm              4.66.4
typing_extensions 4.6.3
wcwidth           0.2.6
wheel             0.42.0
GitPython         3.1.45
requests          2.32.5
QUANTAXIS         1.10.19
fabric           3.2.2
```

## Mootdx Project Architecture

### Project Directory Structure

```Plain
workspace/                   
├── .coveragerc
├── .drone.yml
├── .editorconfig
├── .gitignore
├── .pre-commit-config.yaml
├── .readthedocs.yaml
├── AUTHORS.rst
├── Dockerfile
├── LICENSE
├── Makefile
├── README.md
├── docs
│   ├── api
│   │   ├── affair.md
│   │   ├── extras.md
│   │   ├── fields.md
│   │   ├── quote1.md
│   │   ├── quote2.md
│   │   └── reader.md
│   ├── chlog.md
│   ├── cli
│   │   ├── affair.md
│   │   ├── bestip.md
│   │   ├── bundle.md
│   │   ├── quotes.md
│   │   └── reader.md
│   ├── faq
│   │   ├── py_mini_racer.md
│   ├── history.md
│   ├── img
│   │   ├── IMG_2851.JPG
│   │   └── todo.md
│   ├── index.md
│   ├── quick.md
│   ├── requirements.txt
│   ├── setup.md
│   ├── todo.md
├── mkdocs.yml
├── mootdx
│   ├── __init__.py
│   ├── __main__.py
│   ├── affair.py
│   ├── cache
│   │   ├── __init__.py
│   │   ├── compat.py
│   │   ├── file.py
│   │   ├── timed.py
│   │   └── timer.py
│   ├── config.py
│   ├── consts.py
│   ├── contrib
│   │   ├── __init__.py
│   │   ├── adjust.py
│   │   └── compat.py
│   ├── exceptions.py
│   ├── financial
│   │   ├── __init__.py
│   │   ├── base.py
│   │   ├── columns.py
│   │   └── financial.py
│   ├── logger.py
│   ├── parse.py
│   ├── quotes.py
│   ├── reader.py
│   ├── server.py
│   ├── tools
│   │   ├── DownloadTDXCaiWu.py
│   │   ├── __init__.py
│   │   ├── customize.py
│   │   ├── reversion.py
│   │   └── tdx2csv.py
│   ├── utils
│   │   ├── __init__.py
│   │   ├── adjust.py
│   │   ├── demjson.py
│   │   ├── factor.py
│   │   ├── holiday.js
│   │   ├── holiday.py
│   │   ├── pandas_cache.py
│   │   └── timer.py
│   └── version.py
├── poetry.lock
├── pyproject.toml
├── sample
│   ├── basic_adjust.py
│   ├── basic_affairs.py
│   ├── basic_quotes.py
│   ├── basic_reader.py
│   ├── fq.py
│   ├── fuquan.py
│   ├── lru_cache.py
│   ├── parse_affairs_all.py
│   └── verify_server.py
├── scripts
│   └── fabfile.py
└── tox.ini


```

## API Usage Guide

### Core API

#### 1. Module Import

```python
from mootdx import get_config_path
from mootdx.affair import Affair
from mootdx.cache import file_cache
from mootdx.consts import KLINE_DAILY, MARKET_SH
from mootdx.exceptions import MootdxValidationException
from mootdx.logger import logger
from mootdx.quotes import Quotes
from mootdx.reader import Reader, ReaderBase, StdReader
from mootdx.tools.customize import Customize
from mootdx.tools.reversion import reversion
from mootdx.tools.tdx2csv import txt2csv
from mootdx.utils import FREQUENCY
from mootdx.utils.adjust import get_xdxr
from mootdx.contrib.adjust import get_adjust_year
```

#### 2. Quotes Class

**Function**: The Stock Market Factory Method.

**Class Definition**:
```python
class Quotes(object):
    @staticmethod
    def factory(market='std', **kwargs): ...
```
**Method Description**:
- `factory(market='std', **kwargs)`: Creates a stock market instance based on the specified market type.
    - Parameters:
        - `market` (str): Market type, default is `"std"` (standard market).
        - `kwargs`: Additional keyword arguments for initializing the stock market instance.
    - Returns:
        - `object`: An instance of the stock market class (either `StdQuotes` or `ExtQuotes`).

#### 3. `quotes()` Function - Query Real-time Quotes

**Function**: Retrieve real-time quotes information for single or multiple stocks.

**Function Signature**:
```python
from mootdx.__main__ import quotes
@entry.command(help='读取股票在线行情数据.')
@click.help_option('-h', '--help')
@click.option('-o', '--output', default=None, help='输出文件, 支持CSV, HDF5, Excel等格式.')
@click.option('-s', '--symbol', default='600000', help='股票代码.')
@click.option('-a', '--action', default='bars', help='操作类型 (daily: 日线, minute: 一分钟线, fzline: 五分钟线).', )
@click.option('-m', '--market', default='std', help='证券市场, 默认 std (std: 标准股票市场, ext: 扩展市场).')

def quotes(symbol, action, market, output):
    from mootdx.quotes import Quotes
```

**Parameter Description**:
- `symbol` (str | list): Stock code, supporting a single string or list format, such as `"000001"` or `["000001", "600300"]`

**Return Value**: None

#### 4. `affair()` Function - Financial Data Processing

**Function**: Financial data processing function.

**Function Signature**:
```python
from mootdx.__main__ import affair
@entry.command(help='财务文件下载&解析.')
@click.help_option('-h', '--help')
@click.option('-p', '--parse', default=None, help='要解析文件名')
@click.option('-f', '--fetch', default=None, help='下载财务文件的文件名')
@click.option('-a', '--downall', is_flag=True, help='下载全部文件')
@click.option('-o', '--output', default=None, help='输出文件, 支持 CSV, HDF5, Excel, JSON 等格式.')
@click.option('-d', '--downdir', default='output', help='下载文件目录')
@click.option('-l', '--listfile', is_flag=True, default=False, help='显示全部文件')
@click.option('-v', '--verbose', count=True, help='详细模式')
def affair(parse, fetch, downdir, output, downall, verbose, listfile):
    from mootdx.affair import Affair

```

**Parameter Description**:
- `parse` (str): File name to parse
- `fetch` (str): File name to fetch
- `downdir` (str): Directory to download files
- `output` (str): Output file name
- `downall` (bool): Whether to download all files
- `verbose` (bool): Whether to print verbose output
- `listfile` (bool): Whether to list all files

**Return Value**: None or a boolean indicating whether the download was successful

#### 5. `bundle()` Function - Batch download quotes data for multiple stocks.

**Function**: Batch download market data.

**Function Signature**:
```python
from mootdx.__main__ import bundle

@entry.command(help='批量下载行情数据.')
@click.help_option('-h', '--help')
@click.option('-o', '--output', default='bundle', help='转存文件目录.')
@click.option('-s', '--symbol', default='600000', help='股票代码. 多个用,隔开')
@click.option('-a', '--action', default='bars', help='操作类型 (daily: 日线, minute: 一分钟线, fzline: 五分钟线).')
@click.option('-m', '--market', default='std', help='证券市场, 默认 std (std: 标准股票市场, ext: 扩展市场).')
@click.option('-e', '--extension', default='csv', help='转存文件的格式, 支持 CSV, HDF5, Excel, JSON 等格式.')

def bundle(symbol, action, market, output, extension):
    from mootdx.quotes import Quotes

```

**Parameter Description**:
- `symbol` (str): Stock code
- `action` (str): Action type
- `market` (str): Market type
- `output` (str): Output directory
- `extension` (str): Extension of the output file

**Return Value**: None

#### 6. `file_cache()` Function - Cache the data to a file.

**Function**: Cache the data to a file. This function is used to cache the data to a file, and the data will be refreshed after the specified time.

**Function Signature**:
```python
def file_cache(filepath: PathLike, refresh_time: Optional[float] = None):
    def decorator(func: Callable[P, pd.DataFrame]):
        @functools.wraps(func)
        def retrieve_cache(*args: P.args, **kwargs: P.kwargs):
            return dataframe

        return retrieve_cache

    return decorator
```

**Parameter Description**:
- `file_cache`: Decorator function to cache the data to a file.
    - `filepath` (str): File path
    - `refresh_time` (float): Refresh time in seconds, default is `None`
    **Return Value**: A decorator function that can be used to cache the data to a file.
    - `decorator`: It is an inner class of the `file_cache` function.Decorator function that can be used to cache the data to a file.
        - `func` (Callable): Function to be cached
        **Return Value**: A decorator function that can be used to cache the data to a file.
        - `retrieve_cache` : It is an inner class of the `decorator` function. Function to retrieve the cached data.
            **Return Value**: A pandas DataFrame.

#### 7. `lru_cache()` Function - Cache the data to a file.

**Function**: Cache the data to a file. This function is used to cache the data to a file, and the data will be refreshed after the specified time.

**Function Signature**:
```python
from mootdx.cache.timed import lru_cache
def lru_cache(seconds: Optional[int] = None, maxsize: Optional[int] = None, typed: bool = True):

    def decorator(func: PandasFunc) -> PandasFunc:
        
        @functools.wraps(func)
        def retrieve_cache(*args: P.args, **kwargs: P.kwargs) -> pd.DataFrame:
            

            return lru_func(*args, **kwargs)

        return cast(PandasFunc, retrieve_cache)

    return decorator
```

**Parameter Description**:
- `lru_cache`: Decorator function to cache the data to a file.
    - `seconds` (int): Seconds to cache the data
    - `maxsize` (int): Maximum size of the cache
    - `typed` (bool): Whether to cache the data by type
    **Return Value**: A decorator function that can be used to cache the data to a file.
    - `decorator`: It is an inner class of the `lru_cache` function. Decorator function that can be used to cache the data to a file.
        - `func` (Callable): Function to be cached
        **Return Value**: A decorator function that can be used to cache the data to a file.
        - `retrieve_cache` : It is an inner class of the `decorator` function. Function to retrieve the cached data.
            **Return Value**: A pandas DataFrame.

#### 8. `get_adjust_year()` Function

**Function**: Get the adjust year data from the 10jqka.com.cn.

**Function Signature**:
```python
@retry(wait=wait_fixed(2), retry_error_callback=return_last_value, stop=stop_after_attempt(5))
def get_adjust_year(symbol=None, year=None, factor='00'): ...

```

**Parameter Description**:
- `symbol` (str): Stock code
- `year` (int): Year to get the data
- `factor` (str): Factor to get the data

**Return Value**: A pandas DataFrame containing the adjust year data or `None` if the data is not found.

#### 9. Reader Class

**Function**: Reader class.

**Class Definition**:
```python
class Reader(object):
    @staticmethod
    def factory(market='std', **kwargs): ...
    
```
**Method Description**:
- `factory`: Factory method to create a reader object.
    - `market` (str): Market type
    - `kwargs` (dict): Keyword arguments
    **Return Value**: A reader object.


#### 10. ExtReader Class

**Function**: ExtReader class.

**Class Definition**:
```python
from mootdx.reader import ExtReader

class ExtReader(ReaderBase):
    def __init__(self, tdxdir=None): ...
    def daily(self, symbol=None): ...
    def minute(self, symbol=None): ...
    def fzline(self, symbol=None): ...

```
**Method Description**:
- `daily`: Get daily data.
    - `symbol` (str): Stock code
    **Return Value**: A pandas DataFrame or `None` if the data is not found.
- `minute`: Get minute data.
    - `symbol` (str): Stock code
    **Return Value**: A pandas DataFrame or `None` if the data is not found.
- `fzline`: Get fzline data.
    - `symbol` (str): Stock code
    **Return Value**: A pandas DataFrame or `None` if the data is not found.


#### 11. StdReader Class

**Function**: StdReader class.

**Class Definition**:
```python
class StdReader(ReaderBase):

    def daily(self, symbol=None, **kwargs): ...

    def minute(self, symbol=None, suffix=1, **kwargs): ... # noqa
       
    def fzline(self, symbol=None): ...
       
    def block_new(self, name: str = None, symbol: list = None, group=False, **kwargs): ...
        from mootdx.tools.customize import Customize

    def block(self, symbol='', group=False, **kwargs): ...
       
        # from mootdx.block import BlockParse
        from mootdx.parse import BaseParse

```
**Method Description**:
- `daily`: Get daily data.
    - `symbol` (str): Stock code
    **Return Value**: A pandas DataFrame or `None` if the data is not found.
- `minute`: Get minute data.
    - `symbol` (str): Stock code
    **Return Value**: A pandas DataFrame or `None` if the data is not found.
- `fzline`: Get fzline data.
    - `symbol` (str): Stock code
    **Return Value**: A pandas DataFrame or `None` if the data is not found.
- `block_new`: Get block data.
    - `name` (str): Block name
    - `symbol` (list): Stock code list
    - `group` (bool): Whether to group the data
    **Return Value**: A pandas DataFrame or `None` if the data is not found.
- `block`: Get block data.
    - `symbol` (str): Block file
    - `group` (bool): Whether to group the data
    **Return Value**: A pandas DataFrame or `None` if the data is not found.

#### 12. `txt2csv()` Function - Convert TXT file to CSV file

**Function**: Convert TXT file to CSV file.

**Function Signature**:
```python
def txt2csv(infile: str, outfile: str = None) -> pd.DataFrame: ...
```

**Parameter Description**:
- `infile` (str): Input file path
- `outfile` (str): Output file path

**Return Value**: A pandas DataFrame containing the converted data or `None` if the data is not found.

#### 13. `batch()` Function - Batch convert TXT files to CSV files

**Function**: Batch convert TXT files to CSV files.

**Function Signature**:
```python
from mootdx.tool.tdx2csv import batch

def batch(src, dst): ...
```

**Parameter Description**:
- `src` (str): Source directory
- `dst` (str): Destination directory

**Return Value**: None

#### 14. `get_xdxr()` Function - Get the XDXR data from the 10jqka.com.cn.

**Function**: Get the XDXR data from the 10jqka.com.cn.

**Function Signature**:
```python
def get_xdxr(symbol):
    @file_cache(filepath=Path(get_config_path(f'xdxr/{symbol}.plk')), refresh_time=3600 * 24)
    def _xdxr(symbol):

        return xdxr.set_index(['date'])

    return _xdxr(symbol)
```

**Parameter Description**:
- `symbol` (str): Stock code
**Return Value**: A pandas DataFrame containing the XDXR data or `None` if the data is not found.

**Method Description**:
- `_xdxr`: It is an inner class of the `get_xdxr` function, Get the XDXR data.
    - `symbol` (str): Stock code
    **Return Value**: A pandas DataFrame containing the XDXR data or `None` if the data is not found.

#### 15. Affair Class

**Function**: Affair class.

**Class Definition**:
```python
class Affair(object):
    @staticmethod
    def parse(downdir='.', filename=None, **kwargs): ...

    @staticmethod
    def files(): ...

    @staticmethod
    def fetch(downdir: str = None, filename: str = None): ... # noqa
```
**Method Description**:
- `fetch`: Download the financial data.
    - `downdir` (str): Download directory
    - `filename` (str): Filename
    **Return Value**: A boolean indicating whether the download was successful
- `files`: Get the financial file list.
    **Return Value**: A list of file information, where each dictionary contains fields such as `filename`, `hash`, and `filesize`
- `parse`: Parse the financial data.
    - `downdir` (str): Download directory
    - `filename` (str): Filename
    **Return Value**: A pandas DataFrame containing the parsed data or `None` if the data is not found.


#### 16. MootdxValidationException Class

**Function**: MootdxValidationException class.

**Class Definition**:
```python
from mootdx.exception import MootdxValidationException
class MootdxValidationException(Exception):
    def __init__(self, *args, **kwargs):
        pass
```

#### 17. BaseParse Class

**Function**: BaseParse class.

**Class Definition**:
```python
from mootdx.parse import BaseParse
class BaseParse:
    def __init__(self, tdxdir):  # noqa
        self.tdxdir = tdxdir  # noqa

    def parse(self, symbol=None, group=False, **kwargs): ... # noqa

    def read_text(self, path): ...

    def __incon(self, path): ... # noqa
        # return the data from the path

    def cfg(self, path): ...
        # return the data from the path

```
**Method Description**:
- `parse`: Parse the data.
    - `symbol` (str): Stock code
    - `group` (bool): Whether to group the data
    **Return Value**: A pandas DataFrame or `None` if the data is not found.
- `read_text`: Read the text file.
    - `path` (str): File path
    **Return Value**: The content of the text file or `None` if the file is not found.
- `__incon`: Get the data from the path.
    - `path` (str): File path
    **Return Value**: The data from the path or `None` if the data is not found.
- `cfg`: Get the configuration data.
    - `path` (str): File path
    **Return Value**: The configuration data or `None` if the data is not found.

#### 18. `get_stock_market()` Function - Determine the Stock Market

**Function**: Determine the corresponding securities market based on the stock code.

**Function Signature**:
```python
def get_stock_market(symbol='', string=False): ...
```

**Parameter Description**:
- `symbol` (str): Stock code
- `string` (bool): Return format
  - `False`: Return the market ID (default)
  - `True`: Return the market abbreviation name

**Return Value**: The market ID (integer) or the market abbreviation name (string)

#### 19. `to_data()` Function - Data Format Conversion

**Function**: Convert data in various formats into a standardized pandas DataFrame.

**Function Signature**:
```python
from mootdx.utils import to_data
def to_data(v, **kwargs): ...
```

**Parameter Description**:
- `v` (any): Input data
- `kwargs`: Keyword arguments

**Return Value**: A standardized pandas DataFrame containing the converted data or `None` if the data is not found.

#### 20. `to_file()` Function - Data Export

**Function**: Export a pandas DataFrame to various file formats.

**Function Signature**:
```python
from mootdx.utils import to_file
def to_file(df, filename=None): ...
```

**Parameter Description**:
- `df` (pd.DataFrame): The DataFrame to be exported
- `filename` (str): Output file name, supporting formats such as `csv`, `xlsx`, `xls`, `json`, and `h5`

**Return Value**: A boolean indicating whether the export was successful

#### 21. `get_config_path()` Function - Get the Configuration Path

**Function**: Retrieve the full path of the project configuration file.

**Function Signature**:
```python
def get_config_path(config='config.json'): ...
```

**Parameter Description**:
- `config` (str): Configuration file name, default is `'config.json'`

**Return Value**: A string representing the full path of the configuration file

#### 22. `md5sum()` Function - Calculate the File MD5

**Function**: Calculate the MD5 hash value of a specified file.

**Function Signature**:
```python
def md5sum(downfile): ...
```

**Parameter Description**:
- `downfile` (str): File path

**Return Value**: A string representing the MD5 hash value or `None` if the file does not exist

#### 23. `Customize` Class - Custom Sector Management

**Function**: Customize class.

**Class Definition**:
```python
class Customize:
    items: dict = {}

    def __init__(self, tdxdir=None):
        self.vipdoc = Path(tdxdir, 'T0002', 'blocknew')
        self.tdxdir = str(tdxdir)

    def create(self, name: str = None, symbol: list = None, **kwargs):
        return _blocknew(self.tdxdir, name=name, symbol=symbol, **kwargs)

    def remove(self, name: str = None): ...

    def search(self, name: str = None, group=False): ...


    def update(self, name: str = None, symbol=None, overflow=False): ...
```
**Method Description**:
- `create`: Create a new custom sector and add stock codes.
    - `name` (str): Sector name
    - `symbol` (list): List of stock codes
    **Return Value**: A boolean indicating whether the creation was successful
- `remove`: Remove a custom sector.
    - `name` (str): Sector name
    **Return Value**: A boolean indicating whether the removal was successful
- `search`: Search for custom sectors by name.
    - `name` (str): Sector name
    - `group` (bool): Whether to use the grouped format, default is `False`
    **Return Value**: A list of stock codes or `None` if the data is not found
- `update`: Update the stock codes in a custom sector.
    - `name` (str): Sector name
    - `symbol` (list): List of stock codes
    - `overflow` (bool): Whether to allow overflow, default is `False`
    **Return Value**: A boolean indicating whether the update was successful

#### 25. `holiday2()` Function - Get the Holiday Data

**Function**: Get the holiday data from the 10jqka.com.cn.

**Function Signature**:
```python
from mootdx.utils import holiday2
def holiday2(date: str = None) -> pd.DataFrame: ...

```

**Parameter Description**:
- `date` (str): Date to get the holiday data

**Return Value**: A pandas DataFrame containing the holiday data or `None` if the data is not found.

#### 26. ReaderBase Class

**Function**: ReaderBase class.

**Class Definition**:
```python
class ReaderBase(ABC):
    # 默认通达信安装目录
    tdxdir = 'C:/new_tdx'

    def __init__(self, tdxdir=None): ...
    def find_path(self, symbol=None, subdir='lday', suffix=None, **kwargs): ...

```
**Method Description**:
- `find_path`: Find the file path for a given stock code.
    - `symbol` (str): Stock code
    - `subdir` (str): Subdirectory name, default is `'lday'`
    - `suffix` (str): File suffix, default is `None`
    **Return Value**: A string representing the file path or `None` if the data is not found

#### 27. DownloadTDXCaiWu Class

**Function**: DownloadTDXCaiWu class. Download the financial data from the 10jqka.com.cn.

**Class Definition**:
```python
class DownloadTDXCaiWu(object):
    tdx_root_dir = 'new_tdx'
    tdx_cw_dir = tdx_root_dir + '/vipdoc/cw'
    tmp_cw_dir = 'cw_tmp'  # 所有的文件处理都在这个文件夹下，不修改tdx本地的财务文件，确认无误后再同步回tdx目录下

    hashlist_gpcw_url = 'https://data.tdx.com.cn/tdxfin/gpcw.txt'
    hashlist_gpsz_url = 'https://data.tdx.com.cn/tdxgp/gpszsh.txt'

    one_gpcw_url = 'https://data.tdx.com.cn/tdxfin/{file_name}'
    one_gpsz_url = 'https://data.tdx.com.cn/tdxgp/{file_name}'

    workerPool = None

    def __init__(self):
        self.workerPool = ThreadPoolExecutor(max_workers=10, thread_name_prefix='TDX_CW_')

    @staticmethod
    def download_file(url, save_dir, save_file_name):
        """
        Download the financial data from the 10jqka.com.cn.
        :return: None
        """
    def download_cw_hashlist(self):
        """
        Download the financial data hashlist from the 10jqka.com.cn.
        :return: None
        """

    def download_cw_items(self, file_name_list):
        """
        Download the financial data items from the 10jqka.com.cn.
        :return: None
        """

    @staticmethod
    def checksum(hash_expected, check_file_name, check_file_dir, is_eq):
        """
        Check the checksum of the financial data.
        :return: None
        """


    # file_name_scope
    def check_hashlist(self, hash_file_name, check_file_dir, is_eq, file_name_scope=[]):
        """
        Check the hashlist of the financial data.
        :return: None
        """

    def download_due_cw(self, ):
        """
        Download the due financial data.
        :return: None
        """
    def copy_right_cw_to_tdx(self, downloaded_files):
        """
        Copy the right financial data to the TDX main directory.
        :return: None
        """

    @staticmethod
    def copy_cw_to_tdx(copy_files_list, src_dir, dst_dir):
        """
        Copy the financial data to the TDX main directory.
        :return: None
        """
    def run(self, clear_temp_dir=False):
        """
        Run the DownloadTDXCaiWu class.
        :return: None
        """
```

#### 28. callback Function

**Function**: Callback function for asynchronous events.

**Function Signature**:
```python
def callback(res, key):
    """
    异步回调函数

    :param res:
    :param key:
    """
```
**Parameter Description**:
- `res`: Result of the asynchronous event
- `key`: Key of the asynchronous event

**Return Value**: None

#### 29. connect2 Function

**Function**: Connect to the server.

**Function Signature**:
```python
def connect2(proxy, index='HQ'):

```

**Parameter Description**:
- `proxy`: Proxy information
- `index`: Index of the server

**Return Value**: Proxy information

#### 30.async_event Function

**Function**: It is an inner class of the `server` function. Async event function.

**Function Signature**:
```python
from mootdx.server import server
def server(index=None, limit=5, console=False, sync=True):
    def async_event():

```

**Parameter Description**:
- `index`: Index of the server
**Return Value**: None

**server Parameter Description**:
- `index`: Index of the server
- `limit`: Number of servers to check
- `console`: Whether to print the result
- `sync`: Whether to sync the server
**Return**: Formatted [(address, port),...] list


#### 31.check_server Function

**Function**: Check the server.

**Function Signature**:
```python
def check_server(console=False, limit=5, sync=False) -> None:
```

**Parameter Description**:
- `console`: Whether to print the result
- `limit`: Number of servers to check
- `sync`: Whether to sync the server

**Return Value**: None

#### 32. load_config Function

**Function**: Load the configuration file.

**Function Signature**:
```python
def setup():
    def load_config(config: str = 'config.json') -> dict: ...
```

**Parameter Description**:
- `config`: Configuration file name, default is `'config.json'`
**Return Value**: Configuration dictionary

**setup Function Return Value**: Return: boolean, true indicates successful data import

#### 33. clone Function

**Function**: Clone the configuration dictionary.

**Function Signature**:
```python
def clone():

```

**Parameter Description**: None

**Return Value**: A deep copy of the configuration dictionary

#### 34. return_last_value Function

**Function**: Return the result of the last call attempt.

**Function Signature**:
```python
def return_last_value(retry_state): ...
```

**Parameter Description**: 
- `retry_state`: Retry state
**Return Value**: The result of the last call attempt

#### 35. valid_server Function

**Function**: Validate the server information.

**Function Signature**:
```python

def valid_server(server):
    import ipaddress

```

**Parameter Description**:
- `server`: Server information, in the format of `('127.0.0.1', 7727)`

**Return Value**: A tuple of the server address and port or None

#### 36. check_empty Function

**Function**: Check if the value is empty.

**Function Signature**:
```python
def check_empty(value): ...
    
```

**Parameter Description**:
- `value`: Value to check

**Return Value**: A boolean indicating whether the value is empty

#### 37. factor_reversion Function

**Function**: Factor reversion for a single stock.

**Function Signature**:
```python
def factor_reversion(symbol: str, method: str = 'qfq', raw: pd.DataFrame = None) -> pd.DataFrame:
```

**Parameter Description**:
- `symbol`: Symbol of the stock
- `method`: Method of the reversion
- `raw`: Raw data

**Return Value**: A pandas DataFrame containing the reversion data

#### 38. etf_reversion Function

**Function**: ETF reversion.

**Function Signature**:
```python
def etf_reversion(data, xdxr, adjust='01'):
```

**Parameter Description**:
- `data`: Data to be reversion
- `xdxr`: XDXR data
- `adjust`: Adjustment type

**Return Value**: A pandas DataFrame containing the reversion data

#### 39. _fetch_xdxr Function

**Function**: Fetch XDXR data for a single stock.

**Function Signature**:
```python
def reversion(symbol, stock_data, xdxr, type_='01'):
    def _fetch_xdxr(collections=None): ...
```

**Parameter Description**:
- `collections`: Collections of the XDXR data

**Return Value**: A pandas DataFrame containing the XDXR data

**reversion Parameter**:
- `symbol`: Symbol of the stock
- `stock_data`: Stock data
- `xdxr`: XDXR data
- `type_`: Type of the reversion
**Return Value**: factor_reversion

#### 40. baoli_qfq Function

**Function**: Baoli QFQ reversion.

**Function Signature**:
```python
def baoli_qfq(df, xdxr):
```

**Parameter Description**:
- `df`: Data to be reversion
- `xdxr`: XDXR data

**Return Value**: A pandas DataFrame containing the reversion data

#### 41. _blocknew Function

**Function**: Custom sector write function.

**Function Signature**:
```python
def _blocknew(tdxdir: str = None, name: str = None, symbol: list = None, blk_file: str = None, **kwargs): ... # noqa 
```

**Parameter Description**:
- `tdxdir`: Tdx directory
- `name`: Custom sector name
- `symbol`: Custom sector symbol
- `blk_file`: Custom sector blk file

**Return Value**: True if the write was successful, False otherwise

#### 42. retrieve_cache Function

**Function**: Retrieve cache from the file.

**Function Signature**:
```python
from mootdx.cache.file import file_cache
def file_cache(filepath: PathLike, refresh_time: Optional[float] = None):
    def decorator(func: Callable[P, pd.DataFrame]):
        @functools.wraps(func)
        def retrieve_cache(*args: P.args, **kwargs: P.kwargs): ...
         return dataframe

        return retrieve_cache

    return decorator


```

**Parameter Description**:
- `func`: Function to retrieve cache
- `args`: Arguments
- `kwargs`: Keyword arguments

**Return Value**: A pandas DataFrame containing the cache

**file_cache Parameter**:
- `filepath`: File path to cache
- `refresh_time`: Refresh time in seconds

**Return Value**: A pandas DataFrame containing the cache

**decorator Parameter**:
- `func`: Function to retrieve cache
- `args`: Arguments
- `kwargs`: Keyword arguments

**Return Value**: A pandas DataFrame containing the cache

#### 43. timeit Function

**Function**: Time the function.

**Function Signature**:
```python
def timeit(func):
    @wraps(func)
    def decorator(*args, **kwargs):
```

**Parameter Description**:
- `func`: Function to time


**decorator Parameter**:
- `func`: Function to time
- `args`: Arguments
- `kwargs`: Keyword arguments

**Return Value**: The result of the function


#### 44. reporthook Function

**Function**: Report hook function.

**Function Signature**:
```python
def reporthook(downloaded, total_size):
```

**Parameter Description**:
- `downloaded`: Downloaded size
- `total_size`: Total size

**Return Value**: None

#### 45. _get_pyver Function

**Function**: Get Python version.

**Function Signature**:
```python
from mootdx.utils import _get_pyver
def _get_pyver():
```

**Parameter Description**: None

**Return Value**: None

#### 46. determine_float_limits Function

**Function**: Determine the precision and range of the given float type.

**Function Signature**:
```python
def determine_float_limits(number_type=float):
    """Determines the precision and range of the given float type.

    The passed in 'number_type' argument should refer to the type of
    floating-point number.  It should either be the built-in 'float',
    or decimal context or constructor; i.e., one of:

        # 1. FLOAT TYPE
        determine_float_limits( float )

        # 2. DEFAULT DECIMAL CONTEXT
        determine_float_limits( decimal.Decimal )

        # 3. CUSTOM DECIMAL CONTEXT
        ctx = decimal.Context( prec=75 )
        determine_float_limits( ctx )

    Returns a named tuple with components:

         ( significant_digits,
           max_exponent,
           min_exponent )

    Where:
        * significant_digits -- maximum number of *decimal* digits
             that can be represented without any loss of precision.
             This is conservative, so if there are 16 1/2 digits, it
             will return 16, not 17.

        * max_exponent -- The maximum exponent (power of 10) that can
             be represented before an overflow (or rounding to
             infinity) occurs.

        * min_exponent -- The minimum exponent (negative power of 10)
             that can be represented before either an underflow
             (rounding to zero) or a subnormal result (loss of
             precision) occurs.  Note this is conservative, as
             subnormal numbers are excluded.

    """
```

**Parameter Description**:
- `number_type`: Type of the number

**Return Value**: A named tuple containing the precision and range of the number

#### 47. determine_float_precision Function

**Function**: Determine the precision of the given float type.

**Function Signature**:
```python
def determine_float_precision():
```

**Parameter Description**: None

**Return Value**: A tuple containing the precision of the number

#### 48. _nonnumber_float_constants Function

**Function**: Determine the non-number float constants.

**Function Signature**:
```python
def _nonnumber_float_constants():
        """Try to return the Nan, Infinity, and -Infinity float values.

    This is necessarily complex because there is no standard
    platform-independent way to do this in Python as the language
    (opposed to some implementation of it) doesn't discuss
    non-numbers.  We try various strategies from the best to the
    worst.

    If this Python interpreter uses the IEEE 754 floating point
    standard then the returned values will probably be real instances
    of the 'float' type.  Otherwise a custom class object is returned
    which will attempt to simulate the correct behavior as much as
    possible.

    """
```

**Parameter Description**: None

**Return Value**: A tuple containing the non-number float constants

#### 49. skipstringsafe Function

**Function**: Skip string safe function.

**Function Signature**:
```python
def skipstringsafe(s, start=0, end=None): ...
```

**Parameter Description**:
- `s`: String to skip
- `start`: Start index
- `end`: End index

**Return Value**: A string containing the skipped string

#### 50. skipstringsafe_slow Function

**Function**: Skip string safe slow function.

**Function Signature**:
```python
def skipstringsafe_slow(s, start=0, end=None): ...
```

**Parameter Description**:
- `s`: String to skip
- `start`: Start index
- `end`: End index

**Return Value**: A string containing the skipped string

#### 51. extend_list_with_sep Function

**Function**: Extend list with separator.

**Function Signature**:
```python
def extend_list_with_sep(orig_seq, extension_seq, sepchar=''):
```

**Parameter Description**:
- `orig_seq`: Original sequence
- `extension_seq`: Extension sequence
- `sepchar`: Separator character

**Return Value**: None

#### 52. extend_and_flatten_list_with_sep Function

**Function**: Extend and flatten list with separator.

**Function Signature**:
```python
def extend_and_flatten_list_with_sep(orig_seq, extension_seq, separator=''):
```

**Parameter Description**:
- `orig_seq`: Original sequence
- `extension_seq`: Extension sequence
- `separator`: Separator character

**Return Value**: None

#### 53. _make_raw_bytes Function

**Function**: Make raw bytes.

**Function Signature**:
```python
def _make_raw_bytes(byte_list):
    """Takes a list of byte values (numbers) and returns a bytes (Python 3) or string (Python 2)
    """
```

**Parameter Description**:
- `byte_list`: Byte list

**Return Value**: A bytes object

#### 54. _make_unsafe_string_chars Function

**Function**: Make unsafe string chars.

**Function Signature**:
```python
def _make_unsafe_string_chars():
```

**Parameter Description**: None

**Return Value**: A string containing the unsafe string chars

#### 55. smart_sort_transform Function

**Function**: Smart sort transform.

**Function Signature**:
```python
def smart_sort_transform(key): ...
```

**Parameter Description**:
- `key`: Key to sort

**Return Value**: A string containing the sorted key

#### 56. encode Function

**Function**: Encode the given object.

**Function Signature**:
```python
@staticmethod
def encode(obj, errors='strict', endianness=None, include_bom=True): ...
```

**Parameter Description**:
- `obj`: Object to encode
- `errors`: Error handling scheme
- `endianness`: Endianness of the encoding
- `include_bom`: Whether to include the byte order mark

**Return Value**: A string containing the encoded object

#### 57. decode Function

**Function**: Decode the given object.

**Function Signature**:
```python
 @staticmethod
def decode(obj, errors='strict', endianness=None): ...
```

**Parameter Description**:
- `obj`: Object to decode
- `errors`: Error handling scheme
- `endianness`: Endianness of the encoding

**Return Value**: A string containing the decoded object

#### 58. encode_to_file Function

**Function**: Encode the given object to a file.

**Function Signature**:
```python
def encode_to_file(filename, obj, encoding='utf-8', overwrite=False, **kwargs):
    """Encodes a Python object into JSON and writes into the given file.

    If no encoding is given, then UTF-8 will be used.

    See the encode() function for a description of other possible options.

    If the file already exists and the 'overwrite' option is not set
    to True, then the existing file will not be overwritten.  (Note,
    there is a subtle race condition in the check so there are
    possible conditions in which a file may be overwritten)

    """
```

**Parameter Description**:
- `filename`: File name
- `obj`: Object to encode
- `encoding`: Encoding
- `overwrite`: Whether to overwrite the file
- `**kwargs`: Additional keyword arguments

**Return Value**: None

#### 59. decode_file Function

**Function**: Decode the given file.

**Function Signature**:
```python
def decode_file(filename, encoding=None, **kwargs):
    """Decodes JSON found in the given file.

    See the decode() function for a description of other possible options.

    """
```

**Parameter Description**:
- `filename`: File name
- `encoding`: Encoding
- `**kwargs`: Additional keyword arguments

**Return Value**: A string containing the decoded object

#### 60. get_stock_markets Function

**Function**: Get the stock markets.

**Function Signature**:
```python
def get_stock_markets(symbols):
```

**Parameter Description**:
- `symbols`: Stock symbols

**Return Value**: A list containing the stock markets

#### 61. get_frequency Function

**Function**: Get the frequency of the given symbol.

**Function Signature**:
```python
def get_frequency(frequency) -> int:
    """Gets the frequency of the given symbol.

    Args:
        frequency (str): Frequency of the symbol.

    Returns:
        int: Frequency of the symbol.

    """
```

**Parameter Description**:
- `frequency`: Frequency of the symbol

**Return Value**: A string containing the frequency

#### 62. stock_bj_a Function

**Function**: Get the stock data from the Beijing Stock Exchange.

**Function Signature**:
```python
def stock_bj_a()-> pd.DataFrame:
      """
    东方财富网-京 A 股-实时行情
    http://quote.eastmoney.com/center/gridlist.html#hs_a_board
    :return: 实时行情
    :rtype: pandas.DataFrame
    """
```

**Parameter Description**: None

**Return Value**: A pandas DataFrame containing the stock data

#### 63. fq_factor Function

**Function**: Factor reversion for a single stock.

**Function Signature**:
```python
def fq_factor(symbol: str, method: str, ) -> pd.DataFrame: ...
```

**Parameter Description**:
- `symbol`: Symbol of the stock
- `method`: Method of the reversion

**Return Value**: A pandas DataFrame containing the reversion data

#### 64. to_adjust Function

**Function**: Adjust the data.

**Function Signature**:
```python
def to_adjust(temp_df, symbol=None, adjust=None):
```

**Parameter Description**:
- `temp_df`: Data to be adjusted
- `symbol`: Symbol of the stock
- `adjust`: Adjustment type

**Return Value**: A pandas DataFrame containing the adjusted data

#### 65. to_adjust2 Function

**Function**: Adjust the data.

**Function Signature**:
```python
def to_adjust2(temp_df, symbol=None, adjust=None):
```

**Parameter Description**:
- `temp_df`: Data to be adjusted
- `symbol`: Symbol of the stock
- `adjust`: Adjustment type

**Return Value**: A pandas DataFrame containing the adjusted data

#### 66. file_expired Function

**Function**: Check if the file is expired.

**Function Signature**:
```python
def file_expired(file_path, expire_seconds=3600): ...
```

**Parameter Description**:
- `file_path`: File path
- `expire_seconds`: Expire seconds

**Return Value**: A boolean indicating whether the file is expired

#### 67. pd_cache Function

**Function**: Cache the pandas DataFrame.

**Function Signature**:
```python
def pd_cache(cache_dir=None, expired=0): ...
   def decorator(func):
        def wrapper(*args, **kw): ...
```

**Parameter Description**:
- `cache_dir`: Cache directory
- `expired`: Expire seconds

**Method**:
- `decorator`: Decorator function
    - `func`: Function to be decorated
    **Return Value**: A pandas DataFrame containing the cached data
- `wrapper`: Wrapper function
    - `*args`: Arguments
    - `**kw`: Keyword arguments
    **Return Value**: A pandas DataFrame containing the cached data

**Return Value**: A pandas DataFrame containing the cached data


#### 68. wrapper Function

**Function**: Wrapper function.

**Function Signature**:
```python
from mootdx.contrib import Path
def wrapper(*args, **kw): ...
```

**Parameter Description**:
- `args`: Arguments
- `kw`: Keyword arguments

**Return Value**: A pandas DataFrame containing the cached data

#### 69. pd_cached_delete Function

**Function**: Delete the cached data.

**Function Signature**:
```python
def pd_cached_delete(cache_dir=None): ...
```

**Parameter Description**:
- `cache_dir`: Cache directory

**Return Value**: None

#### 70. holidays Function

**Function**: Get the holidays.

**Function Signature**:
```python
def holidays() -> pd.DataFrame:
    @file_cache(filepath=cache_file, refresh_time=3600 * 24)
    @retry(wait=wait_fixed(2), retry_error_callback=return_last_value, stop=stop_after_attempt(5))
    def _holidays() -> pd.DataFrame: ...
```

**Parameter Description**: None


**Return Value**: A pandas DataFrame containing the holidays

#### 71. _holiday Function

**Function**: Get the holiday.

**Function Signature**:
```python
@file_cache(filepath=get_config_path('caches/holiday.plk'), refresh_time=3600 * 24)
def _holiday():
```

**Parameter Description**: None

**Return Value**: A pandas DataFrame containing the holiday

#### 72. holiday_ Function

**Function**: Get the holiday.

**Function Signature**:
```python
def holiday_(date=None, format_=None, country=None): ...
```

**Parameter Description**: 
- `date`: Date to get the holiday
- `format_`: Format of the date
- `country`: Country to get the holiday

**Return Value**: A pandas DataFrame containing the holiday

#### 73. push Function

**Function**: Push the code.

**Function Signature**:
```python

@task(alias='push')
def push(branch=repo.active_branch.name): ...
```

**Parameter Description**: 
- `branch`: Branch to push

**Return Value**: None

#### 74. pull Function

**Function**: Pull the code.

**Function Signature**:
```python
@task(alias='pull')
def pull(branch=repo.active_branch.name):
    """拉取同步所有仓库"""
    local(f'git pull origin {branch} --tags')
    local(f'git pull github {branch} --tags')
    local(f'git pull gitee {branch} --tags')

```

**Parameter Description**: 
- `branch`: Branch to pull

**Return Value**: None

#### 75. help Function

**Function**: Help the code.

**Function Signature**:
```python
@task
def help():
    """使用帮助"""
    text = open('README.rst').read()
    print(text)
```

**Parameter Description**: None

**Return Value**: None

#### 76. sample_function Function

**Function**: Sample function to return a pandas DataFrame.

**Function Signature**:
```python
@timeit
@lru_cache(seconds=100, maxsize=None)
def sample_function() -> pd.DataFrame:
     """Sample function that returns a constant DataFrame, for testing purpose."""
    
```

**Parameter Description**: None

**Return Value**: A pandas DataFrame containing the sample data

#### 77. select_best_ip Function

**Function**: Select the best IP address.

**Function Signature**:
```python
def select_best_ip():
```

**Parameter Description**: None

**Return Value**: A string containing the best IP address

#### 78. __select_market_code Function

**Function**: Select the market code.

**Function Signature**:
```python
def __select_market_code(code):
```

**Parameter Description**:
- `code`: Code to select the market code

**Return Value**: A string containing the market code

#### 79. QA_fetch_get_stock_day Function

**Function**: Get the stock day data.

**Function Signature**:
```python
def QA_fetch_get_stock_day(code, start_date, end_date, if_fq='00', level='day', ip=best_ip, port=7709):
```

**Parameter Description**:
- `code`: Code to get the stock day data
- `start_date`: Start date
- `end_date`: End date
- `if_fq`: If FQ
- `level`: Level
- `ip`: IP address
- `port`: Port

**Return Value**: A pandas DataFrame containing the stock day data

#### 80. QA_fetch_get_stock_min Function

**Function**: Get the stock min data.

**Function Signature**:
```python
def QA_fetch_get_stock_min(code, start, end, level='1min', ip=best_ip, port=7709):
```

**Parameter Description**:
- `code`: Code to get the stock min data
- `start`: Start time
- `end`: End time
- `level`: Level
- `ip`: IP address
- `port`: Port

**Return Value**: A pandas DataFrame containing the stock min data

#### 81. QA_fetch_get_stock_latest Function

**Function**: Get the stock latest data.

**Function Signature**:
```python
def QA_fetch_get_stock_latest(code, ip=best_ip, port=7709):
```

**Parameter Description**:
- `code`: Code to get the stock latest data
- `ip`: IP address
- `port`: Port

**Return Value**: A pandas DataFrame containing the stock latest data

#### 82. QA_fetch_get_stock_realtime Function

**Function**: Get the stock realtime data.

**Function Signature**:
```python
def QA_fetch_get_stock_realtime(code=['000001', '000002'], ip=best_ip, port=7709):
```

**Parameter Description**:
- `code`: Code to get the stock realtime data
- `ip`: IP address
- `port`: Port

**Return Value**: A pandas DataFrame containing the stock realtime data

#### 83. QA_fetch_get_stock_list Function

**Function**: Get the stock list.

**Function Signature**:
```python
def QA_fetch_get_stock_list(type_='stock', ip=best_ip, port=7709):
```

**Parameter Description**:
- `type_`: Type of the stock list
- `ip`: IP address
- `port`: Port

**Return Value**: A pandas DataFrame containing the stock list

#### 84. QA_fetch_get_index_day Function

**Function**: Get the index day data.

**Function Signature**:
```python
def QA_fetch_get_index_day(code, start_date, end_date, level='day', ip=best_ip, port=7709):
```

**Parameter Description**:
- `code`: Code to get the index day data
- `start_date`: Start date
- `end_date`: End date
- `level`: Level
- `ip`: IP address
- `port`: Port

**Return Value**: A pandas DataFrame containing the index day data

#### 85. QA_fetch_get_index_min Function

**Function**: Get the index min data.

**Function Signature**:
```python
def QA_fetch_get_index_min(code, start, end, level='1min', ip=best_ip, port=7709):
```

**Parameter Description**:
- `code`: Code to get the index min data
- `start`: Start time
- `end`: End time
- `level`: Level
- `ip`: IP address
- `port`: Port

**Return Value**: A pandas DataFrame containing the index min data

#### 86. __QA_fetch_get_stock_transaction Function

**Function**: Get the stock transaction data.

**Function Signature**:
```python
def __QA_fetch_get_stock_transaction(code, day, retry, api):
```

**Parameter Description**:
- `code`: Code to get the stock transaction data
- `day`: Day
- `retry`: Retry
- `api`: API

**Return Value**: A pandas DataFrame containing the stock transaction data

#### 87. QA_fetch_get_stock_transaction Function

**Function**: Get the stock transaction data.

**Function Signature**:
```python
def QA_fetch_get_stock_transaction(code, start, end, retry=2, ip=best_ip, port=7709):
    'Transaction by transaction'
```

**Parameter Description**: 
- `code`: Code to get the stock transaction data
- `start`: Start time
- `end`: End time
- `retry`: Retry
- `ip`: IP address
- `port`: Port



**Return Value**: A pandas DataFrame containing the stock transaction data

#### 88. QA_fetch_get_stock_xdxr Function

**Function**: Get the stock XDXR data.

**Function Signature**:
```python
def QA_fetch_get_stock_xdxr(code, ip=best_ip, port=7709):
    'ex-dividend'
```

**Parameter Description**:
- `code`: Code to get the stock XDXR data
- `ip`: IP address
- `port`: Port

**Return Value**: A pandas DataFrame containing the stock XDXR data

#### 89. QA_fetch_get_stock_block Function

**Function**: Get the stock block data.

**Function Signature**:
```python
def QA_fetch_get_stock_block(ip=best_ip, port=7709):
    'Stock block data'
```

**Parameter Description**: 
- `ip`: IP address
- `port`: Port

**Return Value**: A pandas DataFrame containing the stock block data

#### 90. QA_fetch_get_stock_info Function

**Function**: Get the stock info data.

**Function Signature**:
```python
def QA_fetch_get_stock_info(code, ip=best_ip, port=7709):
    'Stock financial data'
```

**Parameter Description**:
- `code`: Code to get the stock info data
- `ip`: IP address
- `port`: Port

**Return Value**: A pandas DataFrame containing the stock info data

#### 91. MootdxException Class

**Function**: Base notifier exception. Catch this to catch all of :mod:`notifiers` errors

**Class Definition**:
```python
class MootdxException(Exception):
    """Base notifier exception. Catch this to catch all of :mod:`notifiers` errors"""

    def __init__(self, *args, **kwargs):
        """
        Looks for ``provider``, ``message`` and ``data`` in kwargs
        :param args: Exception arguments
        :param kwargs: Exception kwargs
        """

    def __repr__(self):

```

#### 92. MootdxModuleNotFoundError Class

**Function**: Module not found error.

**Class Definition**:
```python
class MootdxModuleNotFoundError(Exception):
    def __init__(self, *args, **kwargs):
        pass
```

#### 93. FileNeedRefresh Class

**Function**: File need refresh error.

**Class Definition**:
```python
class FileNeedRefresh(FileNotFoundError):
    pass
```

#### 94. BaseQuotes Class

**Function**: Base quotes class.

**Class Definition**:
```python
class BaseQuotes(object):
    client = None
    bestip = None
    server = None

    verbose = False
    timeout = 15

    def __init__(self, server=None, bestip: bool = False, timeout: int = None, **kwargs) -> None:
      
    def __del__(self):


    def reconnect(self):


    def close(self):


    @property
    def closed(self) -> bool:


    def pool(self):
```
**Method Description**:
- `__init__`: Initialize the quotes class.
- `__del__`: Delete the quotes class.
- `reconnect`: Reconnect to the server.
- `close`: Close the connection.
- `closed`: Check if the connection is closed.
- `pool`: Get the pool.


#### 95. LRUCacheWrapper Class

**Function**: LRU cache wrapper class.

**Class Definition**:
```python
class LRUCacheWrapper(Protocol[P]):
    lifetime: timedelta
    expiration: datetime

    def __call__(self, *args: P.args, **kwargs: P.kwargs) -> pd.DataFrame:
        pass

    def clear(self):
        pass
```

#### 96. FinancialReader Class

**Function**: Financial reader class.

**Class Definition**:
```python
class FinancialReader(object):
    @staticmethod
    def to_data(filename, **kwargs):
        """
        Read historical financial data files and return pandas results in a format similar to 'gpcw20171231. zip', with specific field meanings as referenced

        https://github.com/rainx/pytdx/issues/133

        : paramfilename: Data file address. The data file type can be. zip file or decompressed. dat file, and the extension may not be written Program automatic recognition
        : Return: Historical financial data in pandas DataFrame format
        """

```

#### 97. FinancialList Class

**Function**: Financial list class, used to get the list of financial files.

**Class Definition**:
```python
class FinancialList(BaseFinancial):
    def content(self, report_hook=None, downdir=None, proxies=None, chunk_size=1024 * 50, *args, **kwargs):
        """
        Analyze financial documents

        : paramReport_0ok: Hook callback function
        : paramdowndir: folder to parse
        :param proxies:
        :param chunk_size:
        :param args:
        :param kwargs:
        :return:
        """


    def parse(self, download_file, *args, **kwargs):
        """
            Analyze financial documents

            :param download_file:
            :param args:
            :param kwargs:
            :return:
        """

```

#### 98. BaseReader Class

**Function**: Base reader class.

**Class Definition**:
```python
class BaseReader(object):
    @staticmethod
    def unpack(fmt, data):
        """
        extract files

        :param fmt:
        :param data:
        :return:
        """


    def get_df(self, code_or_file, exchange=None):
        """
        Convert format to pd.DateFrame

        :param code_or_file:
        :param exchange:
        :return:
        """
```

#### 99. _dummy_context_manager Class

**Function**: Dummy context manager class.

**Class Definition**:
```python
class _dummy_context_manager(object):
    """A context manager that does nothing on entry or exit."""

    def __enter__(self):
        pass

    def __exit__(self, exc_type, exc_val, exc_tb):
```
**Method**:
- `__enter__`: Enter the context.
- `__exit__`: Exit the context.
    - `exc_type`: Exception type.
    - `exc_val`: Exception value.
    - `exc_tb`: Exception traceback.
    **Return**: bool

#### 100. _undefined_class Class

**Function**: Undefined class.

**Class Definition**:
```python
class _undefined_class(object):
    """Represents the ECMAScript 'undefined' value."""
    __slots__ = []

    def __repr__(self):


    def __str__(self):


    def __bool__(self):

```
**Method**:
- `__repr__`: Return a string representation of the object.
- `__str__`: Return a string representation of the object.
- `__bool__`: Return a boolean value of the object.

#### 101. json_int Class

**Function**: JSON int class. Represents the ECMAScript 'undefined' value.

**Class Definition**:
```python
class json_int((1).__class__):  # Have to specify base this way to satisfy 2to3
    """A subclass of the Python int/long that remembers its format (hex,octal,etc).

    Initialize it the same as an int, but also accepts an additional keyword
    argument 'number_format' which should be one of the NUMBER_FORMAT_* values.

        n = json_int( x[, base, number_format=NUMBER_FORMAT_DECIMAL] )

    """

    def __new__(cls, *args, **kwargs):
        

    @property
    def number_format(self):
        """The original radix format of the number"""


    def json_format(self):
        """Returns the integer value formatted as a JSON literal"""
```

#### 102. utf32 Class

**Function**: UTF-32 codec class. Represents the Unicode UTF-32 and UCS4 encoding/decoding support.

**Class Definition**:
```python
class utf32(codecs.CodecInfo):
    """Unicode UTF-32 and UCS4 encoding/decoding support.

    This is for older Pythons whch did not have UTF-32 codecs.

    JSON requires that all JSON implementations must support the
    UTF-32 encoding (as well as UTF-8 and UTF-16).  But earlier
    versions of Python did not provide a UTF-32 codec, so we must
    implement UTF-32 ourselves in case we need it.

    See http://en.wikipedia.org/wiki/UTF-32

    """
    BOM_UTF32_BE = _make_raw_bytes([0, 0, 0xFE, 0xFF])  # '\x00\x00\xfe\xff'
    BOM_UTF32_LE = _make_raw_bytes([0xFF, 0xFE, 0, 0])  # '\xff\xfe\x00\x00'

    @staticmethod
    def lookup(name):
        """A standard Python codec lookup function for UCS4/UTF32.

        If if recognizes an encoding name it returns a CodecInfo
        structure which contains the various encode and decoder
        functions to use.

        """
        

    @staticmethod
    def encode(obj, errors='strict', endianness=None, include_bom=True):
        """Encodes a Unicode string into a UTF-32 encoded byte string.

        Returns a tuple: (bytearray, num_chars)

        The errors argument should be one of 'strict', 'ignore', or 'replace'.

        The endianness should be one of:
            * 'B', '>', or 'big'     -- Big endian
            * 'L', '<', or 'little'  -- Little endien
            * None                   -- Default, from sys.byteorder

        If include_bom is true a Byte-Order Mark will be written to
        the beginning of the string, otherwise it will be omitted.

        """
        import sys, struct

        # Make a container that can store bytes
        

    @staticmethod
    def utf32le_encode(obj, errors='strict', include_bom=False):
        """Encodes a Unicode string into a UTF-32LE (little endian) encoded byte string."""


    @staticmethod
    def utf32be_encode(obj, errors='strict', include_bom=False):
        """Encodes a Unicode string into a UTF-32BE (big endian) encoded byte string."""


    @staticmethod
    def decode(obj, errors='strict', endianness=None):
        """Decodes a UTF-32 byte string into a Unicode string.

        Returns tuple (bytearray, num_bytes)

        The errors argument shold be one of 'strict', 'ignore',
        'replace', 'backslashreplace', or 'xmlcharrefreplace'.

        The endianness should either be None (for auto-guessing), or a
        word that starts with 'B' (big) or 'L' (little).

        Will detect a Byte-Order Mark. If a BOM is found and endianness
        is also set, then the two must match.

        If neither a BOM is found nor endianness is set, then big
        endian order is assumed.

        """
        import struct, sys
        

        # Check for truncated last character
        

        # Start decoding characters


    @staticmethod
    def utf32le_decode(obj, errors='strict'):
        """Decodes a UTF-32LE (little endian) byte string into a Unicode string."""


    @staticmethod
    def utf32be_decode(obj, errors='strict'):
        """Decodes a UTF-32BE (big endian) byte string into a Unicode string."""

```
**Method**:
- `lookup`: Look up a codec by name.
- `encode`: Encode a Unicode string into a UTF-32 encoded byte string.
- `utf32le_encode`: Encode a Unicode string into a UTF-32LE (little endian) encoded byte string.
- `utf32be_encode`: Encode a Unicode string into a UTF-32BE (big endian) encoded byte string.
- `decode`: Decode a UTF-32 byte string into a Unicode string.
- `utf32le_decode`: Decode a UTF-32LE (little endian) byte string into a Unicode string.
- `utf32be_decode`: Decode a UTF-32BE (big endian) byte string into a Unicode string.


#### 103. helpers Class

**Function**: Helpers class. A set of utility functions.

**Class Definition**:
```python
class helpers(object):
    """A set of utility functions."""

    hexdigits = '0123456789ABCDEFabcdef'
    octaldigits = '01234567'
    unsafe_string_chars = _make_unsafe_string_chars()

    import sys
    maxunicode = sys.maxunicode

    always_use_custom_codecs = False  # If True use demjson's codecs
    # before system codecs. This
    # is mainly here for testing.

    javascript_reserved_words = frozenset([
        # Keywords (plus "let")  (ECMAScript 6 section 11.6.2.1)
        'break', 'case', 'catch', 'class', 'const', 'continue',
        'debugger', 'default', 'delete', 'do', 'else', 'export',
        'extends', 'finally', 'for', 'function', 'if', 'import',
        'in', 'instanceof', 'let', 'new', 'return', 'super',
        'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void',
        'while', 'with', 'yield',
        # Future reserved words (ECMAScript 6 section 11.6.2.2)
        'enum', 'implements', 'interface', 'package',
        'private', 'protected', 'public', 'static',
        # null/boolean literals
        'null', 'true', 'false'
    ])

    @staticmethod
    def make_raw_bytes(byte_list):
        """Constructs a byte array (bytes in Python 3, str in Python 2) from a list of byte values (0-255).

        """


    @staticmethod
    def is_hex_digit(c):
        """Determines if the given character is a valid hexadecimal digit (0-9, a-f, A-F)."""


    @staticmethod
    def is_octal_digit(c):
        """Determines if the given character is a valid octal digit (0-7)."""


    @staticmethod
    def is_binary_digit(c):
        """Determines if the given character is a valid binary digit (0 or 1)."""


    @staticmethod
    def char_is_json_ws(c):
        """Determines if the given character is a JSON white-space character"""


    @staticmethod
    def safe_unichr(codepoint):
        """Just like Python's unichr() but works in narrow-Unicode Pythons."""
        

    @staticmethod
    def char_is_unicode_ws(c):
        """Determines if the given character is a Unicode space character"""
        

    @staticmethod
    def char_is_json_eol(c):
        """Determines if the given character is a JSON line separator"""


    @staticmethod
    def char_is_unicode_eol(c):
        """Determines if the given character is a Unicode line or
        paragraph separator. These correspond to CR and LF as well as
        Unicode characters in the Zl or Zp categories.

        """


    @staticmethod
    def char_is_identifier_leader(c):
        """Determines if the character may be the first character of a
        JavaScript identifier.
        """


    @staticmethod
    def char_is_identifier_tail(c):
        """Determines if the character may be part of a JavaScript
        identifier.
        """


    @staticmethod
    def extend_and_flatten_list_with_sep(orig_seq, extension_seq, separator=''):
        

    @staticmethod
    def strip_format_control_chars(txt):
        """Filters out all Unicode format control characters from the string.

        ECMAScript permits any Unicode "format control characters" to
        appear at any place in the source code.  They are to be
        ignored as if they are not there before any other lexical
        tokenization occurs.  Note that JSON does not allow them,
        except within string literals.

        * Ref. ECMAScript section 7.1.
        * http://en.wikipedia.org/wiki/Unicode_control_characters

        There are dozens of Format Control Characters, for example:
            U+00AD   SOFT HYPHEN
            U+200B   ZERO WIDTH SPACE
            U+2060   WORD JOINER

        """
        import unicodedata
        

        # 2to3 NOTE: The following is needed to work around a broken
        # Python3 conversion in which filter() will be transformed
        # into a list rather than a string.


    @staticmethod
    def lookup_codec(encoding):
        """Wrapper around codecs.lookup().

        Returns None if codec not found, rather than raising a LookupError.
        """
        import codecs
        
            # Try standard python codecs first, then custom utf32


    @staticmethod
    def auto_detect_encoding(s):
        """Takes a string (or byte array) and tries to determine the Unicode encoding it is in.

        Returns the encoding name, as a string.

        """


        # Get the byte values of up to the first 4 bytes


        # Look for BOM marker
        import sys, codecs


        # Assign values of first four bytes to: a, b, c, d; and last byte to: z


   
        # No BOM, so autodetect encoding used by looking at first four
        # bytes according to RFC 4627 section 3.  The first and last bytes
        # in a JSON document will be ASCII.  The second byte will be ASCII
        # unless the first byte was a quotation mark.

       
    @staticmethod
    def unicode_decode(txt, encoding=None):
        """Takes a string (or byte array) and tries to convert it to a Unicode string.

        Returns a named tuple:  (string, codec, bom)

        The 'encoding' argument, if supplied, should either the name of
        a character encoding, or an instance of codecs.CodecInfo.  If
        the encoding argument is None or "auto" then the encoding is
        automatically determined, if possible.

        Any BOM (Byte Order Mark) that is found at the beginning of the
        input will be stripped off and placed in the 'bom' portion of
        the returned value.

        """
        
    @staticmethod
    def surrogate_pair_as_unicode(c1, c2):
        """Takes a pair of unicode surrogates and returns the equivalent unicode character.

        The input pair must be a surrogate pair, with c1 in the range
        U+D800 to U+DBFF and c2 in the range U+DC00 to U+DFFF.

        """
       

    @staticmethod
    def unicode_as_surrogate_pair(c):
        """Takes a single unicode character and returns a sequence of surrogate pairs.

        The output of this function is a tuple consisting of one or two unicode
        characters, such that if the input character is outside the BMP range
        then the output is a two-character surrogate pair representing that character.

        If the input character is inside the BMP then the output tuple will have
        just a single character...the same one.

        """


    @staticmethod
    def make_surrogate_pair(codepoint):
        """Given a Unicode codepoint (int) returns a 2-tuple of surrogate codepoints."""


    @staticmethod
    def isnumbertype(obj):
        """Is the object of a Python number type (excluding complex)?"""


    @staticmethod
    def is_negzero(n):
        """Is the number value a negative zero?"""


    @staticmethod
    def is_nan(n):
        """Is the number a NaN (not-a-number)?"""


    @staticmethod
    def is_infinite(n):
        """Is the number infinite?"""


    @staticmethod
    def isstringtype(obj):
        """Is the object of a Python string type?"""


    @staticmethod
    def decode_hex(hexstring):
        """Decodes a hexadecimal string into it's integer value."""
        # We don't use the builtin 'hex' codec in python since it can
        # not handle odd numbers of digits, nor raise the same type
        # of exceptions we want to.
       

    @staticmethod
    def decode_octal(octalstring):
        """Decodes an octal string into it's integer value."""
        

    @staticmethod
    def decode_binary(binarystring):
        """Decodes a binary string into it's integer value."""
        

    @staticmethod
    def format_timedelta_iso(td):
        """Encodes a datetime.timedelta into ISO-8601 Time Period format.
        """
```
**Method**:
- `make_raw_bytes`: Takes a string (or byte array) and returns a byte array.
- `is_hex_digit`: Returns True if the character is a hexadecimal digit.
- `is_octal_digit`: Returns True if the character is an octal digit.
- `is_binary_digit`: Returns True if the character is a binary digit.
- `char_is_json_ws`: Returns True if the character is a JSON white-space character.
- `safe_unichr`: Just like Python's unichr() but works in narrow-Unicode Pythons.
- `char_is_unicode_ws` : Returns True if the character is a Unicode white-space character.
- `char_is_json_eol`: Returns True if the character is a Unicode other character.
- `char_is_identifier_leader`: Returns True if the character is a Unicode identifier leader character.
- `char_is_identifier_tail`: Returns True if the character is a Unicode identifier tail character.
- `extend_and_flatten_list_with_sep`: Extends a list with a separator character between each element.
- `char_is_unicode_other`: Returns True if the character is a Unicode other character.
- `lookup_codec`: Looks up a codec by name.
- `auto_detect_encoding`: Automatically detects the encoding of a byte string.

- `unicode_decode`: Takes a string (or byte array) and tries to convert it to a Unicode string.
- `surrogate_pair_as_unicode`: Takes a pair of unicode surrogates and returns the equivalent unicode character.
- `unicode_as_surrogate_pair`: Takes a single unicode character and returns a sequence of surrogate pairs.
- `make_surrogate_pair`: Given a Unicode codepoint (int) returns a 2-tuple of surrogate codepoints.
- `isnumbertype`: Is the object of a Python number type (excluding complex)?
- `is_negzero`: Is the number value a negative zero?
- `is_nan`: Is the number a NaN (not-a-number)?
- `is_infinite`: Is the number infinite?
- `isstringtype`: Is the object of a Python string type?
- `decode_hex`: Decodes a hexadecimal string into it's integer value.
- `decode_octal`: Decodes an octal string into it's integer value.
- `decode_binary`: Decodes a binary string into it's integer value.
- `format_timedelta_iso`: Encodes a datetime.timedelta into ISO-8601 Time Period format.



#### 104. position_marker Class

**Function**: Position marker class. A position marks a specific place in a text document.

**Class Definition**:
```python
class position_marker(object):
    """A position marks a specific place in a text document.
    It consists of the following attributes:

        * line - The line number, starting at 1
        * column - The column on the line, starting at 0
        * char_position - The number of characters from the start of
                          the document, starting at 0
        * text_after - (optional) a short excerpt of the text of
                       document starting at the current position

    Lines are separated by any Unicode line separator character. As an
    exception a CR+LF character pair is treated as being a single line
    separator demarcation.

    Columns are simply a measure of the number of characters after the
    start of a new line, starting at 0.  Visual effects caused by
    Unicode characters such as combining characters, bidirectional
    text, zero-width characters and so on do not affect the
    computation of the column regardless of visual appearance.

    The char_position is a count of the number of characters since the
    beginning of the document, starting at 0. As used within the
    buffered_stream class, if the document starts with a Unicode Byte
    Order Mark (BOM), the BOM prefix is NOT INCLUDED in the count.

    """

    def __init__(self, offset=0, line=1, column=0, text_after=None):
        self.__char_position = offset
        self.__line = line
        self.__column = column
        self.__text_after = text_after
        self.__at_end = False
        self.__last_was_cr = False

    @property
    def line(self):
        """The current line within the document, starts at 1."""


    @property
    def column(self):
        """The current character column from the beginning of the
        document, starts at 0.
        """


    @property
    def char_position(self):
        """The current character offset from the beginning of the
        document, starts at 0.
        """


    @property
    def at_start(self):
        """Returns True if the position is at the start of the document."""


    @property
    def at_end(self):
        """Returns True if the position is at the end of the document.

        This property must be set by the user.
        """


    @at_end.setter
    def at_end(self, b):
        """Sets the at_end property to True or False.
        """


    @property
    def text_after(self):
        """Returns a textual excerpt starting at the current position.

        This property must be set by the user.
        """


    @text_after.setter
    def text_after(self, value):
        """Sets the text_after property to a given string.
        """


    def __repr__(self):


    def describe(self, show_text=True):
        """Returns a human-readable description of the position, in English."""
       

    def __str__(self):
        """Same as the describe() function."""
       

    def copy(self):
        """Create a copy of the position object."""


    def rewind(self):
        """Set the position to the start of the document."""


    def advance(self, s):
        """Advance the position from its current place according to
        the given string of characters.

        """
```

#### 105. buffered_stream Class

**Function**: Buffered stream class. A buffered stream is a stream of characters that is buffered in memory.

**Class Definition**:
```python
class buffered_stream(object):
    """A helper class for the JSON parser.

    It allows for reading an input document, while handling some
    low-level Unicode issues as well as tracking the current position
    in terms of line and column position.

    """

    def __init__(self, txt='', encoding=None):
        self.reset()
        self.set_text(txt, encoding)

    def reset(self):
        """Clears the state to nothing."""


    def save_position(self):


    def clear_saved_position(self):


    def restore_position(self):


    def _find_codec(self, encoding):
        

    def set_text(self, txt, encoding=None):
        """Changes the input text document and rewinds the position to
        the start of the new document.

        """
        import sys
        

    def __repr__(self):


    def rewind(self):
        """Resets the position back to the start of the input text."""


    @property
    def codec(self):
        """The codec object used to perform Unicode decoding, or None."""


    @property
    def bom(self):
        """The Unicode Byte-Order Mark (BOM), if any, that was present
        at the start of the input text.  The returned BOM is a string
        of the raw bytes, and is not Unicode-decoded.

        """


    @property
    def cpos(self):
        """The current character offset from the start of the document."""


    @property
    def position(self):
        """The current position (as a position_marker object).
        Returns a copy.

        """


    @property
    def at_start(self):
        """Returns True if the position is currently at the start of
        the document, or False otherwise.

        """


    @property
    def at_end(self):
        """Returns True if the position is currently at the end of the
        document, of False otherwise.

        """


    def at_ws(self, allow_unicode_whitespace=True):
        """Returns True if the current position contains a white-space
        character.

        """
        
    def at_eol(self, allow_unicode_eol=True):
        """Returns True if the current position contains an
        end-of-line control character.

        """
        

    def peek(self, offset=0):
        """Returns the character at the current position, or at a
        given offset away from the current position.  If the position
        is beyond the limits of the document size, then an empty
        string '' is returned.

        """
        
    def peekstr(self, span=1, offset=0):
        """Returns one or more characters starting at the current
        position, or at a given offset away from the current position,
        and continuing for the given span length.  If the offset and
        span go outside the limit of the current document size, then
        the returned string may be shorter than the requested span
        length.

        """
        

    @property
    def text_context(self, context_size=20):
        """A short human-readable textual excerpt of the document at
        the current position, in English.

        """
        

    def startswith(self, s):
        """Determines if the text at the current position starts with
        the given string.

        See also method: pop_if_startswith()

        """
        

    def skip(self, span=1):
        """Advances the current position by one (or the given number)
        of characters.  Will not advance beyond the end of the
        document.  Returns the number of characters skipped.

        """

        

    def skipuntil(self, testfn):
        """Advances the current position until a given predicate test
        function succeeds, or the end of the document is reached.

        Returns the actual number of characters skipped.

        The provided test function should take a single unicode
        character and return a boolean value, such as:

            lambda c : c == '.'   # Skip to next period

        See also methods: skipwhile() and popuntil()

        """
        

    def skipwhile(self, testfn):
        """Advances the current position until a given predicate test
        function fails, or the end of the document is reached.

        Returns the actual number of characters skipped.

        The provided test function should take a single unicode
        character and return a boolean value, such as:

            lambda c : c.isdigit()   # Skip all digits

        See also methods: skipuntil() and popwhile()

        """
        
    def skip_to_next_line(self, allow_unicode_eol=True):
        """Advances the current position to the start of the next
        line.  Will not advance beyond the end of the file.  Note that
        the two-character sequence CR+LF is recognized as being just a
        single end-of-line marker.

        """
        

    def skipws(self, allow_unicode_whitespace=True):
        """Advances the current position past all whitespace, or until
        the end of the document is reached.

        """


    def pop(self):
        """Returns the character at the current position and advances
        the position to the next character.  At the end of the
        document this function returns an empty string.

        """

    def popstr(self, span=1, offset=0):
        """Returns a string of one or more characters starting at the
        current position, and advances the position to the following
        character after the span.  Will not go beyond the end of the
        document, so the returned string may be shorter than the
        requested span.

        """


    def popif(self, testfn):
        """Just like the pop() function, but only returns the
        character if the given predicate test function succeeds.
        """



    def pop_while_in(self, chars):
        """Pops a sequence of characters at the current position
        as long as each of them is in the given set of characters.

        """


    def pop_identifier(self, match=None):
        """Pops the sequence of characters at the current position
        that match the syntax for a JavaScript identifier.

        """


    def pop_if_startswith(self, s):
        """Pops the sequence of characters if they match the given string.

        See also method: startswith()

        """


    def popwhile(self, testfn, maxchars=None):
        """Pops all the characters starting at the current position as
        long as each character passes the given predicate function
        test.  If maxchars a numeric value instead of None then then
        no more than that number of characters will be popped
        regardless of the predicate test.

        See also methods: skipwhile() and popuntil()

        """


    def popuntil(self, testfn, maxchars=None):
        """Just like popwhile() method except the predicate function
        should return True to stop the sequence rather than False.

        See also methods: skipuntil() and popwhile()

        """


    def __getitem__(self, index):
        """Returns the character at the given index relative to the current position.

        If the index goes beyond the end of the input, or prior to the
        start when negative, then '' is returned.

        If the index provided is a slice object, then that range of
        characters is returned as a string. Note that a stride value other
        than 1 is not supported in the slice.  To use a slice, do:

            s = my_stream[ 1:4 ]

        """

```

#### 106. JSONException Class 

**Function**: JSON exception class.

**Class Definition**:
```python
class JSONException(Exception):
    """Base class for all JSON-related exceptions.
    """
    pass
```

#### 107. JSONSkipHook Class

**Function**: JSON skip hook class.

**Class Definition**:
```python
class JSONSkipHook(JSONException):
    """An exception to be raised by user-defined code within hook
    callbacks to indicate the callback does not want to handle the
    situation.

    """
    pass
```

#### 108. JSONStopProcessing Class

**Function**: JSON stop processing class.

**Class Definition**:
```python
class JSONStopProcessing(JSONException):
    """Can be raised by anyplace, including inside a hook function, to
    cause the entire encode or decode process to immediately stop
    with an error.

    """
    pass
```

#### 109. JSONAbort Class

**Function**: JSON abort class.

**Class Definition**:
```python
class JSONAbort(JSONException):
    pass
```

#### 110. JSONError Class

**Function**: JSON error class. Base class for all JSON-related errors.

**Class Definition**:
```python
class JSONError(JSONException):
    """Base class for all JSON-related errors.

    In addition to standard Python exceptions, these exceptions may
    also have additional properties:

        * severity - One of: 'fatal', 'error', 'warning', 'info'
        * position - An indication of the position in the input where the error occured.
        * outer_position - A secondary position (optional) that gives
          the location of the outer data item in which the error
          occured, such as the beginning of a string or an array.
        * context_description - A string that identifies the context
          in which the error occured.  Default is "Context".
    """
    severities = frozenset(['fatal', 'error', 'warning', 'info'])

    def __init__(self, message, *args, **kwargs):
        self.severity = 'error'
        self._position = None
        self.outer_position = None
        self.context_description = None
        for kw, val in list(kwargs.items()):
            if kw == 'severity':
                if val not in self.severities:
                    raise TypeError('%s given invalid severity %r' % (self.__class__.__name__, val))
                self.severity = val
            elif kw == 'position':
                self.position = val
            elif kw == 'outer_position':
                self.outer_position = val
            elif kw == 'context_description' or kw == 'context':
                self.context_description = val
            else:
                raise TypeError('%s does not accept %r keyword argument' % (self.__class__.__name__, kw))
        super(JSONError, self).__init__(message, *args)
        self.message = message

    @property
    def position(self):


    @position.setter
    def position(self, pos):


    def __repr__(self):


    def pretty_description(self, show_positions=True, filename=None):
        
```

#### 111. JSONDecodeError Class

**Function**: JSON decode error class.

**Class Definition**:
```python
class JSONDecodeError(JSONError):
    """An exception class raised when a JSON decoding error (syntax error) occurs."""
    pass
```

#### 112. JSONDecodeHookError Class

**Function**: JSON decode hook error class.

**Class Definition**:
```python
class JSONDecodeHookError(JSONDecodeError):
    """An exception that occured within a decoder hook.

    The original exception is available in the 'hook_exception' attribute.
    """

    def __init__(self, hook_name, exc_info, encoded_obj, *args, **kwargs):
        self.hook_name = hook_name
        if not exc_info:
            exc_info = (None, None, None)
        exc_type, self.hook_exception, self.hook_traceback = exc_info
        self.object_type = type(encoded_obj)
        msg = 'Hook %s raised %r while decoding type <%s>' % (
        hook_name, self.hook_exception.__class__.__name__, self.object_type.__name__)
        if len(args) >= 1:
            msg += ': ' + args[0]
            args = args[1:]
        super(JSONDecodeHookError, self).__init__(msg, *args, **kwargs)
```

#### 113. JSONEncodeError Class


**Function**: JSON encode error class.

**Class Definition**:
```python
class JSONEncodeError(JSONError):
    """An exception class raised when a python object can not be encoded as a JSON string."""
    pass
```

#### 114. JSONEncodeHookError Class

**Function**: JSON encode hook error class.

**Class Definition**:
```python
class JSONEncodeHookError(JSONEncodeError):
    """An exception that occured within an encoder hook.

    The original exception is available in the 'hook_exception' attribute.
    """

    def __init__(self, hook_name, exc_info, encoded_obj, *args, **kwargs):
        self.hook_name = hook_name
        if not exc_info:
            exc_info = (None, None, None)
        exc_type, self.hook_exception, self.hook_traceback = exc_info
        self.object_type = type(encoded_obj)
        msg = 'Hook %s raised %r while encoding type <%s>' % (
        self.hook_name, self.hook_exception.__class__.__name__, self.object_type.__name__)
        if len(args) >= 1:
            msg += ': ' + args[0]
            args = args[1:]
        super(JSONEncodeHookError, self).__init__(msg, *args, **kwargs)
```

#### 115. encode_state Class

**Function**: Encode state class. An internal transient object used during JSON encoding to record the current construction state.

**Class Definition**:
```python
class encode_state(object):
    """An internal transient object used during JSON encoding to
    record the current construction state.

    """

    def __init__(self, jsopts=None, parent=None):
        import sys
        self.chunks = []
        if not parent:
            self.parent = None
            self.nest_level = 0
            self.options = jsopts
            self.escape_unicode_test = False  # or a function f(unichar)=>True/False
        else:
            self.parent = parent
            self.nest_level = parent.nest_level + 1
            self.escape_unicode_test = parent.escape_unicode_test
            self.options = parent.options

    def make_substate(self):

    def join_substate(self, other_state):


    def append(self, s):
        """Adds a string to the end of the current JSON document"""


    def combine(self):
        """Returns the accumulated string and resets the state to empty"""


    def __eq__(self, other_state):


    def __lt__(self, other_state):

```
**Methods**:
- `make_substate`: Creates a new substate object.
- `join_substate`: Joins the current state with another state.
- `append`: Adds a string to the end of the current JSON document.
- `combine`: Returns the accumulated string and resets the state to empty.
- `__eq__`: Compares the current state with another state.
- `__lt__`: Compares the current state with another state.

#### 116. decode_statistics Class

**Function**: Decode statistics class. An object that records various statistics about a decoded JSON document.

**Class Definition**:
```python
class decode_statistics(object):
    """An object that records various statistics about a decoded JSON document.

    """
    int8_max = 0x7f
    int8_min = - 0x7f - 1
    int16_max = 0x7fff
    int16_min = - 0x7fff - 1
    int32_max = 0x7fffffff
    int32_min = - 0x7fffffff - 1
    int64_max = 0x7fffffffffffffff
    int64_min = - 0x7fffffffffffffff - 1

    double_int_max = 2 ** 53 - 1
    double_int_min = - (2 ** 53 - 1)

    def __init__(self):
        # Nesting
        self.max_depth = 0
        self.max_items_in_array = 0
        self.max_items_in_object = 0
        # Integer stats
        self.num_ints = 0
        self.num_ints_8bit = 0
        self.num_ints_16bit = 0
        self.num_ints_32bit = 0
        self.num_ints_53bit = 0  # ints which will overflow IEEE doubles
        self.num_ints_64bit = 0
        self.num_ints_long = 0
        self.num_negative_zero_ints = 0
        # Floating-point stats
        self.num_negative_zero_floats = 0
        self.num_floats = 0
        self.num_floats_decimal = 0  # overflowed 'float'
        # String stats
        self.num_strings = 0
        self.max_string_length = 0
        self.total_string_length = 0
        self.min_codepoint = None
        self.max_codepoint = None
        # Other data type stats
        self.num_arrays = 0
        self.num_objects = 0
        self.num_bools = 0
        self.num_nulls = 0
        self.num_undefineds = 0
        self.num_nans = 0
        self.num_infinities = 0
        self.num_comments = 0
        self.num_identifiers = 0  # JavaScript identifiers
        self.num_excess_whitespace = 0

    @property
    def num_infinites(self):
        """Misspelled 'num_infinities' for backwards compatibility"""


    def pretty_description(self, prefix=''):
        import unicodedata 
```
**Methods**:
- `pretty_description`: Returns a formatted string with a summary of the statistics.



#### 117. decode_state Class

**Function**: Decode state class. An internal transient object used during JSON decoding to record the current parsing state and error messages.

**Class Definition**:
```python
class decode_state(object):
    """An internal transient object used during JSON decoding to
    record the current parsing state and error messages.

    """

    def __init__(self, options=None):
        self.reset()
        self.options = options

    def reset(self):
        """Clears all errors, statistics, and input text."""


    @property
    def should_stop(self):


    @property
    def has_errors(self):
        """Have any errors been seen already?"""


    @property
    def has_fatal(self):
        """Have any errors been seen already?"""


    def set_input(self, txt, encoding=None):
        """Initialize the state by setting the input document text."""
        import sys
        

    def push_exception(self, exc):
        """Add an already-built exception to the error list."""


    def push_fatal(self, message, *args, **kwargs):
        """Create a fatal error."""


    def push_error(self, message, *args, **kwargs):
        """Create an error."""


    def push_warning(self, message, *args, **kwargs):
        """Create a warning."""


    def push_info(self, message, *args, **kwargs):
        """Create a informational message."""


    def push_cond(self, behavior_value, message, *args, **kwargs):
        """Creates an conditional error or warning message.

        The behavior value (from json_options) controls whether
        a message will be pushed and whether it is an error
        or warning message.

        """
        

    def __push_err(self, message, *args, **kwargs):
        """Stores an error in the error list."""
        

    def update_depth_stats(self, **kwargs):
        

    def update_string_stats(self, s, **kwargs):
        

    def update_negzero_int_stats(self, **kwargs):
        

    def update_negzero_float_stats(self, **kwargs):
        

    def update_float_stats(self, float_value, **kwargs):
        

    def update_integer_stats(self, int_value, **kwargs):

```
-
**Methods**:
- `should_stop`: Returns True if the decoder should stop processing.
- `has_errors`: Returns True if any errors have been seen.
- `has_fatal`: Returns True if any fatal errors have been seen.
- `set_input`: Initializes the state by setting the input document text.
- `push_exception`: Adds an already-built exception to the error list.
- `push_fatal`: Creates a fatal error.
- `push_error`: Creates an error.
- `push_warning`: Creates a warning.
- `push_info`: Creates a informational message.
- `push_cond`: Creates a conditional error or warning message.
- `update_depth_stats`: Updates the depth statistics.
- `update_string_stats`: Updates the string statistics.
- `update_negzero_int_stats`: Updates the negative zero integer statistics.
- `update_negzero_float_stats`: Updates the negative zero floating-point statistics.
- `update_float_stats`: Updates the floating-point statistics.
- `update_integer_stats`: Updates the integer statistics.

#### 118. _behaviors_metaclass

**Function**: Behaviors metaclass. A metaclass used to establish a set of "behavior" options.

**Class Definition**:
```python
class _behaviors_metaclass(type):
    """Meta class used to establish a set of "behavior" options.

    Classes that use this meta class must defined a class-level
    variable called '_behaviors' that is a list of tuples, each of
    which describes one behavior and is like: (behavior_name,
    documentation).  Also define a second class-level variable called
    '_behavior_values' which is a list of the permitted values for
    each behavior, each being strings.

    For each behavior (e.g., pretty), and for each value (e.g.,
    yes) the following methods/properties will be created:

      * pretty - value of 'pretty' behavior (read-write)
      * ispretty_yes - returns True if 'pretty' is 'yes'

    For each value (e.g., pink) the following methods/properties
    will be created:

      * all_behaviors - set of all behaviors (read-only)
      * pink_behaviors - set of behaviors with value of 'pink' (read-only)
      * set_all('pink')
      * set_all_pink()    - set all behaviors to value of 'pink'

    """

    def __new__(cls, clsname, bases, attrs):


        def get_behavior(self, name):


        def set_behavior(self, name, value):
            """Changes the value for a given behavior"""

        def describe_behavior(self, name):
            def getx(self, name=name, forval=v):
            def get_value_for_behavior(self, name=name):
                return self.get_behavior(name)

            def set_value_for_behavior(self, value, name=name):
                self.set_behavior(name, value)

        @property
        def all_behaviors(self):
            """Returns the names of all known behaviors."""


        attrs['all_behaviors'] = all_behaviors

        def set_all(self, value):
            """Changes all behaviors to have the given value."""

        def is_all(self, value):
            """Determines if all the behaviors have the given value."""
            def getbehaviorsfor(self, value=v): ...


        def behaviors_eq(self, other):
            """Determines if two options objects are equivalent."""

```
**Methods**:
- `get_behavior`: Returns the value for a given behavior.
- `set_behavior`: Changes the value for a given behavior.
- `describe_behavior`: Returns documentation about a given behavior.
- `all_behaviors`: Returns the names of all known behaviors.
- `set_all`: Changes all behaviors to have the given value.
- `is_all`: Determines if all the behaviors have the given value.
- `getbehaviorsfor`: Returns the names of all behaviors with the given value.
- `behaviors_eq`: Determines if two options objects are equivalent.

#### 119. json_options Class

**Function**: JSON options class. A class that contains the options for JSON encoding and decoding.

**Class Definition**:
```python
class json_options(object, metaclass=_behaviors_metaclass):
    """Options to determine how strict the decoder or encoder should be."""
    _behavior_values = (ALLOW, WARN, FORBID)
    _behaviors = (
        ('all_numeric_signs',
         "Numbers may be prefixed by any \'+\' and \'-\', e.g., +4, -+-+77"),
        ('any_type_at_start',
         'A JSON document may start with any type, not just arrays or objects'),
        ('comments',
         'JavaScript comments, both /*...*/ and //... styles'),
        ('control_char_in_string',
         'Strings may contain raw control characters without \\u-escaping'),
        ('hex_numbers',
         'Hexadecimal numbers, e.g., 0x1f'),
        ('binary_numbers',
         'Binary numbers, e.g., 0b1001'),
        ('octal_numbers',
         'New-style octal numbers, e.g., 0o731  (see leading-zeros for legacy octals)'),
        ('initial_decimal_point',
         'Floating-point numbers may start with a decimal point (no units digit)'),
        ('extended_unicode_escapes',
         'Extended Unicode escape sequence \\u{..} for non-BMP characters'),
        ('js_string_escapes',
         'All JavaScript character \\-escape sequences may be in strings'),
        ('leading_zeros',
         'Numbers may have extra leading zeros (see --leading-zero-radix option)'),
        ('non_numbers',
         'Non-numbers may be used, such as NaN or Infinity'),
        ('nonescape_characters',
         "Unknown character \\-escape sequences stand for that character (\\Q -> 'Q')"),
        ('identifier_keys',
         'JavaScript identifiers are converted to strings when used as object keys'),
        ('nonstring_keys',
         'Value types other than strings (or identifiers) may be used as object keys'),
        ('omitted_array_elements',
         'Arrays may have omitted/elided elements, e.g., [1,,3] == [1,undefined,3]'),
        ('single_quoted_strings',
         "Strings may be delimited with both double (\") and single (\') quotation marks"),
        ('trailing_comma',
         'A final comma may end the list of array or object members'),
        ('trailing_decimal_point',
         'Floating-point number may end with a decimal point and no following fractional digits'),
        ('undefined_values',
         "The JavaScript 'undefined' value may be used"),
        ('format_control_chars',
         "Unicode \"format control characters\" may appear in the input"),
        ('unicode_whitespace',
         'Treat any Unicode whitespace character as valid whitespace'),
        # Never legal
        ('leading_zeros',
         'Numbers may have leading zeros'),
        # Normally warnings
        ('duplicate_keys',
         'Objects may have repeated keys'),
        ('zero_byte',
         'Strings may contain U+0000, which may not be safe for C-based programs'),
        ('bom',
         'A JSON document may start with a Unicode BOM (Byte Order Mark)'),
        ('non_portable',
         'Anything technically valid but likely to cause data portablibity issues'),
    )  # end behavior list

    def reset_to_defaults(self):
        # Plain attrs (other than above behaviors) are simply copied
        # by value, either during initialization (via keyword
        # arguments) or via the copy() method.
       

    def __init__(self, **kwargs):
        """Set JSON encoding and decoding options.

        If 'strict' is set to True, then only strictly-conforming JSON
        output will be produced.  Note that this means that some types
        of values may not be convertable and will result in a
        JSONEncodeError exception.

        If 'compactly' is set to True, then the resulting string will
        have all extraneous white space removed; if False then the
        string will be "pretty printed" with whitespace and indentation
        added to make it more readable.

        If 'escape_unicode' is set to True, then all non-ASCII characters
        will be represented as a unicode escape sequence; if False then
        the actual real unicode character will be inserted if possible.

        The 'escape_unicode' can also be a function, which when called
        with a single argument of a unicode character will return True
        if the character should be escaped or False if it should not.

        """
        

    def copy(self):


    def copy_from(self, other):
        

    def spaces_to_next_indent_level(self, min_spaces=1, subtract=0):


    def indentation_for_level(self, level=0):
        """Returns a whitespace string used for indenting."""


    def set_indent(self, num_spaces, tab_width=0, limit=None):
        """Changes the indentation properties when outputting JSON in non-compact mode.

        'num_spaces' is the number of spaces to insert for each level
        of indentation, which defaults to 2.

        'tab_width', if not 0, is the number of spaces which is equivalent
        to one tab character.  Tabs will be output where possible rather
        than runs of spaces.

        'limit', if not None, is the maximum indentation level after
        which no further indentation will be output.

        """


    @property
    def sort_keys(self):
        """The method used to sort dictionary keys when encoding JSON
        """


    @sort_keys.setter
    def sort_keys(self, method):
        

    @property
    def encode_enum_as(self):
        """The strategy for encoding Python Enum values.
        """


    @encode_enum_as.setter
    def encode_enum_as(self, val):
        if val not in ('name', 'qname', 'value'):
            raise ValueError("encode_enum_as must be one of 'name','qname', or 'value'")


    @property
    def zero_float(self):
        """The numeric value 0.0, either a float or a decimal."""


    @property
    def negzero_float(self):
        """The numeric value -0.0, either a float or a decimal."""


    @property
    def nan(self):
        """The numeric value NaN, either a float or a decimal."""


    @property
    def inf(self):
        """The numeric value Infinity, either a float or a decimal."""


    @property
    def neginf(self):
        """The numeric value -Infinity, either a float or a decimal."""


    def make_int(self, s, sign=None, number_format=NUMBER_FORMAT_DECIMAL):
        """Makes an integer value according to the current options.

        First argument should be a string representation of the number,
        or an integer.

        Returns a number value, which could be an int, float, or decimal.

        """
        

    def make_decimal(self, s, sign='+'):
        """Converts a string into a decimal or float value."""
        

    def make_float(self, s, sign='+'):
        """Converts a string into a float or decimal value."""
        
    @property
    def leading_zero_radix(self):
        """The radix to be used for numbers with leading zeros.  8 or 10
        """


    @leading_zero_radix.setter
    def leading_zero_radix(self, radix):


    @property
    def leading_zero_radix_as_word(self):


    def suppress_warnings(self):


    @property
    def allow_or_warn_behaviors(self):
        """Returns the set of all behaviors that are not forbidden (i.e., are allowed or warned)."""


    @property
    def strictness(self):


    @strictness.setter
    def strictness(self, strict):
        """Changes whether the options should be re-configured for strict JSON conformance."""
```
**Methods**:
- `reset_to_defaults`: Resets all options to their default values.
- `copy`: Returns a shallow copy of the options.
- `copy_from`: Copies options from another instance.
- `spaces_to_next_indent_level`: Returns the number of spaces to indent to the next level.
- `indentation_for_level`: Returns a whitespace string used for indenting.
- `set_indent`: Changes the indentation properties when outputting JSON in non-compact mode.
- `sort_keys`: The method used to sort dictionary keys when encoding JSON.
- `encode_enum_as`: The strategy for encoding Python Enum values.
- `zero_float`: The numeric value 0.0, either a float or a decimal.
- `negzero_float`: The numeric value -0.0, either a float or a decimal.
- `nan`: The numeric value NaN, either a float or a decimal.
- `inf`: The numeric value Infinity, either a float or a decimal.
- `neginf`: The numeric value -Infinity, either a float or a decimal.
- `make_int`: Makes an integer value according to the current options.
- `make_decimal`: Converts a string into a decimal or float value.
- `make_float`: Converts a string into a float or decimal value.
- `leading_zero_radix`: The radix to be used for numbers with leading zeros.  8 or 10.
- `leading_zero_radix_as_word`: The radix to be used for numbers with leading zeros as a word.  "octal" or "decimal".
- `suppress_warnings`: Suppresses all warnings.
- `allow_or_warn_behaviors`: Returns the set of all behaviors that are not forbidden (i.e., are allowed or warned).
- `strictness`: The level of strictness to use when encoding JSON.

#### 120. jsonlint Class

**Function**: JSON lint class. A class that contains the options for JSON linting.

**Class Definition**:
```python
class jsonlint(object):
    """This class contains most of the logic for the "jsonlint" command.

    You generally create an instance of this class, to defined the
    program's environment, and then call the main() method.  A simple
    wrapper to turn this into a script might be:

        import sys, demjson
        if __name__ == '__main__':
            lint = demjson.jsonlint( sys.argv[0] )
            return lint.main( sys.argv[1:] )

    """
    _jsonlint_usage = r"""Usage: %(program_name)s [<options> ...] [--] inputfile.json ...

With no input filename, or "-", it will read from standard input.

The return status will be 0 if the file is conforming JSON (per the
RFC 7159 specification), or non-zero otherwise.

GENERAL OPTIONS:

 -v | --verbose    Show details of lint checking
 -q | --quiet      Don't show any output (except for reformatting)

STRICTNESS OPTIONS (WARNINGS AND ERRORS):

 -W | --tolerant   Be tolerant, but warn about non-conformance (default)
 -s | --strict     Be strict in what is considered conforming JSON
 -S | --nonstrict  Be tolerant in what is considered conforming JSON

 --allow=...      -\
 --warn=...         |-- These options let you pick specific behaviors.
 --forbid=...     -/      Use --help-behaviors for more

STATISTICS OPTIONS:

 --stats       Show statistics about JSON document

REFORMATTING OPTIONS:

 -f | --format     Reformat the JSON text (if conforming) to stdout
 -F | --format-compactly
        Reformat the JSON simlar to -f, but do so compactly by
        removing all unnecessary whitespace

 -o filename | --output filename
        The filename to which reformatted JSON is to be written.
        Without this option the standard output is used.

 --[no-]keep-format   Try to preserve numeric radix, e.g., hex, octal, etc.
 --html-safe          Escape characters that are not safe to embed in HTML/XML.

 --sort <kind>     How to sort object/dictionary keys, <kind> is one of:
%(sort_options_help)s

 --indent tabs | <nnn>   Number of spaces to use per indentation level,
                         or use tab characters if "tabs" given.

UNICODE OPTIONS:

 -e codec | --encoding=codec     Set both input and output encodings
 --input-encoding=codec          Set the input encoding
 --output-encoding=codec         Set the output encoding

    These options set the character encoding codec (e.g., "ascii",
    "utf-8", "utf-16").  The -e will set both the input and output
    encodings to the same thing.  The output encoding is used when
    reformatting with the -f or -F options.

    Unless set, the input encoding is guessed and the output
    encoding will be "utf-8".

OTHER OPTIONS:

 --recursion-limit=nnn     Set the Python recursion limit to number
 --leading-zero-radix=8|10 The radix to use for numbers with leading
                           zeros. 8=octal, 10=decimal.

REFORMATTING / PRETTY-PRINTING:

    When reformatting JSON with -f or -F, output is only produced if
    the input passed validation.  By default the reformatted JSON will
    be written to standard output, unless the -o option was given.

    The default output codec is UTF-8, unless an encoding option is
    provided.  Any Unicode characters will be output as literal
    characters if the encoding permits, otherwise they will be
    \u-escaped.  You can use "--output-encoding ascii" to force all
    Unicode characters to be escaped.

MORE INFORMATION:

    Use '%(program_name)s --version [-v]' to see versioning information.
    Use '%(program_name)s --copyright' to see author and copyright details.
    Use '%(program_name)s [-W|-s|-S] --help-behaviors' for help on specific checks.

    %(program_name)s is distributed as part of the "demjson" Python module.
    See %(homepage)s
"""
    SUCCESS_FAIL = 'E'
    SUCCESS_WARNING = 'W'
    SUCCESS_OK = 'OK'

    def __init__(self, program_name='jsonlint', stdin=None, stdout=None, stderr=None):
        """Create an instance of a "jsonlint" program.

        You can optionally pass options to define the program's environment:

          * program_name  - the name of the program, usually sys.argv[0]
          * stdin   - the file object to use for input, default sys.stdin
          * stdout  - the file object to use for output, default sys.stdout
          * stderr  - the file object to use for error output, default sys.stderr

        After creating an instance, you typically call the main() method.

        """
        import os, sys
        self.program_path = program_name
        self.program_name = os.path.basename(program_name)
        if stdin:
            self.stdin = stdin
        else:
            self.stdin = sys.stdin

        if stdout:
            self.stdout = stdout
        else:
            self.stdout = sys.stdout

        if stderr:
            self.stderr = stderr
        else:
            self.stderr = sys.stderr

    @property
    def usage(self):
        """A multi-line string containing the program usage instructions.
        """


    def _lintcheck_data(self,
                        jsondata,
                        verbose_fp=None,
                        reformat=False,
                        show_stats=False,
                        input_encoding=None, output_encoding=None, escape_unicode=True,
                        pfx='',
                        jsonopts=None):
        

    def _lintcheck(self, filename, output_filename,
                   verbose=False,
                   reformat=False,
                   show_stats=False,
                   input_encoding=None, output_encoding=None, escape_unicode=True,
                   jsonopts=None):
        import sys
        

    def main(self, argv):
        """The main routine for program "jsonlint".

        Should be called with sys.argv[1:] as its sole argument.

        Note sys.argv[0] which normally contains the program name
        should not be passed to main(); instead this class itself
        is initialized with sys.argv[0].

        Use "--help" for usage syntax, or consult the 'usage' member.

        """
        import sys, os, getopt, unicodedata

```
**Methods**:
- `__init__`: Initializes the instance of the "jsonlint" program.
- `usage`: A multi-line string containing the program usage instructions.
- `_lintcheck_data`: Lint check data. A method that checks the JSON data for lint errors.
- `_lintcheck`: Lint check. A method that checks the JSON file for lint errors.
- `main`: The main routine for program "jsonlint".

#### 121. TqdmUpTo Class

**Function**: Tqdm up to class. A class that provides a progress bar for downloading files.

**Class Definition**:
```python
class TqdmUpTo(tqdm):
    """
    Provides `update_to(n)` which uses `tqdm.update(delta_n)`.

    """

    total: object = 0

    def update_to(self, downloaded=0, total_size=None):
        """
        b  : int, optional
            Number of blocks transferred so far [default: 1].
        bsize  : int, optional
            Size of each block (in tqdm units) [default: 1].
        tsize  : int, optional
            Total size (in tqdm units). If [default: None] remains unchanged.
        """
```

#### 122. MooTdxDailyBarReader Class

**Function**: MooTdx daily bar reader class. A class that reads daily bar data from the Tongda信 data directory.

**Class Definition**:
```python
class MooTdxDailyBarReader(TdxDailyBarReader):

    SECURITY_TYPE = [
        'SH_A_STOCK',
        'SH_B_STOCK',
        'SH_STAR_STOCK',
        'SH_INDEX',
        'SH_FUND',
        'SH_BOND',
        'SZ_A_STOCK',
        'SZ_B_STOCK',
        'SZ_INDEX',
        'SZ_FUND',
        'SZ_BOND',
    ]

    SECURITY_COEFFICIENT = {
        'SH_A_STOCK': [0.01, 0.01],
        'SH_B_STOCK': [0.001, 0.01],
        'SH_STAR_STOCK': [0.01, 0.01],
        'SH_INDEX': [0.01, 1.0],
        'SH_FUND': [0.001, 1.0],
        'SH_BOND': [0.001, 1.0],
        'SZ_A_STOCK': [0.01, 0.01],
        'SZ_B_STOCK': [0.01, 0.01],
        'SZ_INDEX': [0.01, 1.0],
        'SZ_FUND': [0.001, 0.01],
        'SZ_BOND': [0.001, 0.01],
    }

    def get_security_type(self, fname):
        
```
**Methods**:
- `__init__`: Initializes the instance of the "MooTdxDailyBarReader" class.
- `get_security_type`: Returns the security type of the given file name.
    - `fname`: The file name to get the security type for.
    - Returns: The security type of the given file name.

#### 123. MooBaseSocketClient Class

**Function**: Base socket client class. A class that implements the base socket client.

**Class Definition**:
```python
class MooBaseSocketClient(BaseSocketClient):
    def __init__(self):
        super().__init__()
        self.client = None

    def connect(self, ip='101.227.73.20', port=7709, time_out=CONNECT_TIMEOUT, bindport=None, bindip='0.0.0.0'):
        """

        : param ip: server IP address
        : param port: server port
        : param_time_out: Connection timeout time
        : parambindport: local port bound
        : parambindip: Binding local IP address
        Return: Whether the connection is successful True/False
        """

    def disconnect(self):

    def setup(self):
        pass

```

#### 124. BASE Constant

**Function**: Base constant. A constant that contains the base path of the project.
**Value**: Path(__file__).parent.parent
**Type**: Path

#### 125. CONF Constant

**Function**: CONF constant. A constant that contains the path of the configuration file.
**Value**: get_config_path('config.json')
**Type**: Path

#### 126. KLINE_5MIN Constant

**Function**: KLINE_5MIN constant. A constant that contains the value of 5-minute K-line.
**Value**: 0
**Type**: Integer

#### 127. KLINE_15MIN Constant

**Function**: KLINE_15MIN constant. A constant that contains the value of 15-minute K-line.
**Value**: 1
**Type**: Integer

#### 128. KLINE_30MIN Constant

**Function**: KLINE_30MIN constant. A constant that contains the value of 30-minute K-line.
**Value**: 2
**Type**: Integer

#### 129. KLINE_1HOUR Constant

**Function**: KLINE_1HOUR constant. A constant that contains the value of 1-hour K-line.
**Value**: 3
**Type**: Integer

#### 130. KLINE_WEEKLY Constant

**Function**: KLINE_DAILY constant. A constant that contains the value of daily K-line.
**Value**: 5
**Type**: Integer

#### 131. KLINE_MONTHLY Constant

**Function**: KLINE_MONTHLY constant. A constant that contains the value of monthly K-line.
**Value**: 6
**Type**: Integer

#### 132. KLINE_EX_1MIN Constant

**Function**: KLINE_EX_1MIN constant. A constant that contains the value of 1-minute K-line in the extended market.
**Value**: 7
**Type**: Integer

#### 133. KLINE_1MIN Constant

**Function**: KLINE_1MIN constant. A constant that contains the value of 1-minute K-line.
**Value**: 8
**Type**: Integer

#### 134. KLINE_RI_K Constant

**Function**: KLINE_RI_K constant. A constant that contains the value of daily K-line.
**Value**: 9
**Type**: Integer

#### 135. KLINE_3MONTH Constant

**Function**: KLINE_3MONTH constant. A constant that contains the value of 3-month K-line.
**Value**: 10
**Type**: Integer

#### 136. KLINE_YEARLY Constant

**Function**: KLINE_YEARLY constant. A constant that contains the value of yearly K-line.
**Value**: 11
**Type**: Integer

#### 137. MAX_TRANSACTION_COUNT Constant

**Function**: MAX_TRANSACTION_COUNT constant. A constant that contains the value of the maximum number of transactions.
**Value**: 2000
**Type**: Integer

#### 138. MAX_KLINE_COUNT Constant

**Function**: MAX_KLINE_COUNT constant. A constant that contains the value of the maximum number of K-lines.
**Value**: 800
**Type**: Integer

#### 139. BLOCK_SZ Constant

**Function**: BLOCK_SZ constant. A constant that contains the value of the block of the stock market.
**Value**: block_zs.dat
**Type**: String

#### 140. BLOCK_FG Constant

**Function**: BLOCK_FG constant. A constant that contains the value of the block of the stock market.
**Value**: block_fg.dat
**Type**: String

#### 141. BLOCK_GN Constant

**Function**: BLOCK_GN constant. A constant that contains the value of the block of the stock market.
**Value**: block_gn.dat
**Type**: String

#### 142. BLOCK_DEFAULT Constant

**Function**: BLOCK_DEFAULT constant. A constant that contains the value of the default block of the stock market.
**Value**: block.dat
**Type**: String

#### 143. TYPE_FLATS Constant

**Function**: TYPE_FLATS constant. A constant that contains the value of the type of the stock market.
**Value**: 0
**Type**: Integer

#### 144. TYPE_GROUP Constant

**Function**: TYPE_GROUP constant. A constant that contains the value of the type of the stock market.
**Value**: 1
**Type**: Integer

#### 145. HQ_HOSTS Constant

**Function**: HQ_HOSTS constant. A constant that contains the value of the HQ host of the stock market.
**Value**:
```python
HQ_HOSTS = [
    ('深圳双线主站1', '110.41.147.114', 7709),
    ('深圳双线主站2', '8.129.13.54', 7709),
    ('深圳双线主站3', '120.24.149.49', 7709),
    ('深圳双线主站4', '47.113.94.204', 7709),
    ('深圳双线主站5', '8.129.174.169', 7709),
    ('深圳双线主站6', '110.41.154.219', 7709),
    ('上海双线主站1', '124.70.176.52', 7709),
    ('上海双线主站2', '47.100.236.28', 7709),
    ('上海双线主站3', '101.133.214.242', 7709),
    ('上海双线主站4', '47.116.21.80', 7709),
    ('上海双线主站5', '47.116.105.28', 7709),
    ('上海双线主站6', '124.70.199.56', 7709),
    ('北京双线主站1', '121.36.54.217', 7709),
    ('北京双线主站2', '121.36.81.195', 7709),
    ('北京双线主站3', '123.249.15.60', 7709),
    ('广州双线主站1', '124.71.85.110', 7709),
    ('广州双线主站2', '139.9.51.18', 7709),
    ('广州双线主站3', '139.159.239.163', 7709),
    ('上海双线主站7', '106.14.201.131', 7709),
    ('上海双线主站8', '106.14.190.242', 7709),
    ('上海双线主站9', '121.36.225.169', 7709),
    ('上海双线主站10', '123.60.70.228', 7709),
    ('上海双线主站11', '123.60.73.44', 7709),
    ('上海双线主站12', '124.70.133.119', 7709),
    ('上海双线主站13', '124.71.187.72', 7709),
    ('上海双线主站14', '124.71.187.122', 7709),
    ('武汉电信主站1', '119.97.185.59', 7709),
    ('深圳双线主站7', '47.107.64.168', 7709),
    ('北京双线主站4', '124.70.75.113', 7709),
    ('广州双线主站4', '124.71.9.153', 7709),
    ('上海双线主站15', '123.60.84.66', 7709),
    ('深圳双线主站8', '47.107.228.47', 7719),
    ('北京双线主站5', '120.46.186.223', 7709),
    ('北京双线主站6', '124.70.22.210', 7709),
    ('北京双线主站7', '139.9.133.247', 7709),
    ('广州双线主站5', '116.205.163.254', 7709),
    ('广州双线主站6', '116.205.171.132', 7709),
    ('广州双线主站7', '116.205.183.150', 7709)
]
```
**Type**: List

#### 146. EX_HOSTS Constant

**Function**: EX_HOSTS constant. A constant that contains the value of the EX host of the stock market.
**Value**: 
```python
EX_HOSTS = [
    # ('扩展市场深圳双线1', '112.74.214.43', 7727),
    # ('扩展市场深圳双线2', '120.24.0.77', 7727),
    # ('扩展市场深圳双线3', '47.107.75.159', 7727),
    # ('扩展市场武汉主站1', '119.97.185.5', 7727),
    # ('扩展市场武汉主站2', '202.103.36.71', 7727),
    # ('扩展市场武汉主站3', '59.175.238.38', 7727),
    # ('扩展市场北京双线0', '47.92.127.181', 7727),
    # ('扩展市场上海双线0', '106.14.95.149', 7727),
    # ('扩展市场新加双线0', '119.23.127.172', 7727),
    ('银河阿里云扩展行情', '47.112.95.207', 7720),
    ('银河杭州电信扩展行情', '218.75.75.18', 7720),
    ('银河武汉电信扩展行情', '58.49.110.76', 7720),
]

```
**Type**: List

#### 147. GP_HOSTS Constant

**Function**: GP_HOSTS constant. A constant that contains the value of the GP host of the stock market.
**Value**: 
```python
GP_HOSTS = [
    ('默认财务数据线路', '120.76.152.87', 7709),
]
```
**Type**: List

#### 148. CONFIG Constant

**Function**: CONFIG constant. A constant that contains the value of the configuration.
**Value**: 
```python
CONFIG = {
    'SERVER': {'HQ': HQ_HOSTS, 'EX': EX_HOSTS, 'GP': GP_HOSTS},
    'BESTIP': {'HQ': '', 'EX': '', 'GP': ''},
    'TDXDIR': 'C:/new_tdx',
}
```


#### 149. STRICTNESS_STRICT Constant

**Function**: STRICTNESS_STRICT constant. A constant that contains the value of the strictness of the JSON.
**Value**: 'strict'


#### 150. STRICTNESS_WARN Constant

**Function**: STRICTNESS_WARN constant. A constant that contains the value of the strictness of the JSON.
**Value**: 'warn'


#### 151. STRICTNESS_TOLERANT Constant

**Function**: STRICTNESS_TOLERANT constant. A constant that contains the value of the strictness of the JSON.
**Value**: 'tolerant'


#### 152. NUMBER_AUTO Constant

**Function**: NUMBER_AUTO constant. A constant that contains the value of the number of the JSON.
**Value**: 'auto'


#### 153. NUMBER_FLOAT Constant

**Function**: NUMBER_FLOAT constant. A constant that contains the value of the number of the JSON.
**Value**: 'float'


#### 154. NUMBER_DECIMAL Constant

**Function**: NUMBER_DECIMAL constant. A constant that contains the value of the number of the JSON.
**Value**: 'decimal'

#### 155. NUMBER_FORMAT_HEX Constant

**Function**: NUMBER_FORMAT_HEX constant. A constant that contains the value of the number format of the JSON.
**Value**: 'hex'

#### 156. NUMBER_FORMAT_LEGACYOCTAL Constant

**Function**: NUMBER_FORMAT_LEGACYOCTAL constant. A constant that contains the value of the number format of the JSON.
**Value**: 'legacyoctal'

#### 157. NUMBER_FORMAT_OCTAL Constant

**Function**: NUMBER_FORMAT_OCTAL constant. A constant that contains the value of the number format of the JSON.
**Value**: 'octal'

#### 158. NUMBER_FORMAT_BINARY Constant

**Function**: NUMBER_FORMAT_BINARY constant. A constant that contains the value of the number format of the JSON.
**Value**: 'binary'

#### 159. SORT_NONE Constant

**Function**: SORT_NONE constant. A constant that contains the value of the sort of the JSON.
**Value**: 'none'

#### 160. SORT_PRESERVE Constant

**Function**: SORT_PRESERVE constant. A constant that contains the value of the sort of the JSON.
**Value**: 'preserve'

#### 161. SORT_ALPHA Constant

**Function**: SORT_ALPHA constant. A constant that contains the value of the sort of the JSON.
**Value**: 'alpha'

#### 162. SORT_ALPHA_CI Constant

**Function**: SORT_ALPHA_CI constant. A constant that contains the value of the sort of the JSON.
**Value**: 'alpha_ci'

#### 163. SORT_SMART Constant

**Function**: SORT_SMART constant. A constant that contains the value of the sort of the JSON.
**Value**: 'smart'

#### 164. JS_DECODE Constant

**Function**: JS_DECODE constant. A constant that contains the value of the JS decode of the holiday.
**Value**: (Path(__file__).parent / 'holiday.js').read_text(encoding='utf-8')
**Type**: String

#### 165. NUM_SAMPLES Constant

**Function**: NUM_SAMPLES constant. A constant that contains the value of the number of samples.
**Value**: 10
**Type**: Integer

#### 166. __all__ Type Aliases

**Value**: Union['set', 'get', 'copy', 'update', 'settings']
**Type**: Union

#### 167. __version__ Type Aliases

**Value**: '0.11.7'
**Type**: String

#### 168. __author__ Type Aliases

**Value**: ''bopo.wang <ibopo@126.com>''
**Type**: String

#### 169. __homepage__ Type Aliases

**Value**: 'https://github.com/mootdx/mootdx'
**Type**: String

#### 170. __date__ Type Aliases

**Value**: '2015-12-22'
**Type**: String

#### 171. PandasFunc Type Aliases

**Value**: 
PandasFunc: TypeAlias = Callable[P, pd.DataFrame]


#### 173. __version_info__ Type Aliases

**Value**: version_info(major=2, minor=2, micro=4)
**Type**: Tuple

#### 174. __credits__ Type Aliases

**Value**: 'Short of demjson'
**Type**: String

#### 175 Constants

```python

# in mootdx/consts.py
MARKET_SZ = 0  
MARKET_SH = 1  
MARKET_BJ = 2  
FREQUENCY = ['5m', '15m', '30m', '1h', 'day', 'week', 'mon', 'ex_1m', '1m', 'dk', '3mon', 'year']

```
### Actual Usage Patterns

#### Basic Usage

```python
from mootdx import Quotes, Reader, Affair

# Real-time quotes data
client = Quotes.factory(market='std', multithread=True, heartbeat=True)
data = client.bars(symbol='600036', frequency=9, offset=10)

# Offline data reading
reader = Reader.factory(market='std', tdxdir='C:/new_tdx')
daily_data = reader.daily(symbol='600036')

# Financial data processing
files = Affair.files()
Affair.fetch(downdir='tmp', filename='gpcw20170930.zip')
financial_data = Affair.parse(downdir='tmp', filename='gpcw20170930.zip')
```


#### Configured Usage

```python
from mootdx import Quotes, get_stock_market, to_data

# Custom server configuration
client = Quotes.factory(
    market='std',
    server=('127.0.0.1', 7727),
    timeout=30,
    verbose=2
)

# Retrieve forward-adjusted data
qfq_data = client.bars(symbol='600036', adjust='qfq')

# Data format conversion
df = to_data(qfq_data, symbol='600036', adjust='qfq')
```

#### Test Utility Function Pattern

```python
def compare_stock_data(
    symbol: str,
    start_date: str,
    end_date: str,
    frequency: int = 9,
    adjust: str = None,
    market: str = 'std'
):
    """Utility function: Compare the consistency of stock data from different sources"""
    # Convert the matching type to a configuration object
    client = Quotes.factory(market=market, multithread=True, heartbeat=True)
    reader = Reader.factory(market=market, tdxdir='C:/new_tdx')
    
    realtime_data = client.bars(symbol=symbol, frequency=frequency, adjust=adjust)
    offline_data = reader.daily(symbol=symbol, adjust=adjust)
    
    realtime_df = to_data(realtime_data, symbol=symbol, adjust=adjust)
    offline_df = to_data(offline_data, symbol=symbol, adjust=adjust)
    
    return {
        'realtime': realtime_df,
        'offline': offline_df,
        'symbol': symbol,
        'market': get_stock_market(symbol, string=True)
    }

# Usage example
result = compare_stock_data('600036', '20240101', '20240131', adjust='qfq')  # Return a data dictionary
```

### Supported Expression Types

- **K-line Data**: Daily, weekly, monthly, minute, and tick lines
- **Real-time Quotes**: Stocks, indices, futures, and options
- **Financial Data**: Financial statements and financial indicators
- **Sector Data**: Industry sectors, concept sectors, and custom sectors
- **Ex-rights/Ex-dividend**: Dividend, bonus issue, and rights issue information
- **Data Formats**: CSV, Excel, HDF5, and JSON

### Error Handling

The system provides a comprehensive error handling mechanism:
- **Connection Retry**: Automatic reconnection mechanism, supporting multiple retries
- **Timeout Protection**: Prevent network requests from taking too long
- **Data Validation**: Automatically verify data integrity and format
- **Exception Capture**: Gracefully handle various exception situations

### Important Notes

1. **Market Types**: `std` represents the standard stock market, and `ext` represents the extended market (futures, options, etc.).
2. **Data Directory**: Ensure that the path to the Tongda信 data directory is correct and contains the necessary data files.
3. **Network Connection**: Real-time quotes require a network connection, while offline data requires local data files.
4. **Data Format**: All returned data is in the pandas DataFrame format, facilitating subsequent processing.
5. **Adjustment Processing**: Supports forward adjustment (`qfq`) and backward adjustment (`hfq`). The default is no adjustment.

## Detailed Function Implementation Nodes

### Node 1: Real-time Quotes Data Retrieval

**Function Description**: Retrieve real-time quotes data for financial products such as stocks and indices through the Tongda信 server, supporting various data types and formats.

**Core Functions**:
- Query real-time quotes for a single stock
- Batch query for multiple stocks
- Retrieve K-line data (daily, minute, etc.)
- Retrieve index data
- Retrieve today's minute data
- Retrieve historical minute data

**Input/Output Examples**:

```python
from mootdx.quotes import Quotes

# Create a quotes client
client = Quotes.factory(market='std', timeout=10, verbose=2)

# Real-time quotes for a single stock
data = client.quotes(symbol='600036')
print(data)  # DataFrame: Contains stock code, name, price, change percentage, etc.

# Batch query for multiple stocks
data = client.quotes(symbol=['600036', '600016'])
print(data)  # DataFrame: Quotes data for multiple stocks

# Retrieve K-line data
data = client.bars(symbol='600036', frequency=9, offset=10)
print(data)  # DataFrame: Contains open price, high price, low price, close price, trading volume

# Retrieve index data
data = client.index(frequency=9, market=1, symbol='000001', start=1, offset=2)
print(data)  # DataFrame: Index K-line data

# Today's minute data
today = datetime.now().strftime('%Y%m%d')
data0 = client.minute(symbol='000001')
data1 = client.minutes(symbol='000001', date=today)
print(data0)  # DataFrame: Today's minute data
print(data1)  # DataFrame: Minute data for the specified date

# Test verification
assert not data.empty  # Ensure the data is not empty
assert data1.equals(data0)  # Ensure the data for today is consistent with the specified date
```

### Node 2: Offline Data Reading

**Function Description**: Read and parse stock data files from the local Tongda信 data directory, supporting various data formats such as daily, minute, and tick lines.

**Core Functions**:
- Read daily data (supporting forward and backward adjustment)
- Read minute data (1-minute, 5-minute)
- Read tick data
- Read sector data
- Read configuration files

**Input/Output Examples**:

```python
from mootdx.reader import Reader

# Create a data reader
reader = Reader.factory(market='std', tdxdir='tests/fixtures')

# Read daily data (no adjustment)
result = reader.daily(symbol='127021')
print(result)  # DataFrame: Daily data

# Read forward-adjusted daily data
result = reader.daily(symbol='688001', adjust='qfq')
print(result)  # DataFrame: Forward-adjusted daily data

# Read backward-adjusted daily data
result = reader.daily(symbol='000001', adjust='hfq')
print(result)  # DataFrame: Backward-adjusted daily data

# Read minute data
for suffix in ('1', '5'):
    result = reader.minute(symbol='688001', suffix=suffix)
    print(result)  # DataFrame: Minute data

# Read sector data
result = reader.block(symbol='block_gn.dat')
print(result)  # DataFrame: Sector data

# Read configuration files
from mootdx.parse import BaseParse
parse = BaseParse(tdxdir='tests/fixtures')
result = parse.cfg('T0002/hq_cache/tdxhy.cfg')
print(result)  # DataFrame: Configuration file data

# Test verification
assert not result.empty  # Ensure the data is not empty
```

### Node 3: Financial Data Processing

**Function Description**: Process financial data files, including functions such as obtaining the file list, downloading, and parsing data. Support batch operations and single-file processing.

**Core Functions**:
- Obtain the list of financial files
- Download a single file
- Download multiple files in batch
- Parse financial data
- Export data to CSV

**Input/Output Examples**:

```python
from mootdx.affair import Affair
from pathlib import Path

# Obtain the list of financial files
files = [x['filename'] for x in Affair.files()]
print(files)  # List: List of financial files

# Download a single file
Affair.fetch(downdir='tests/fixtures/tmp', filename=files[-1])
file_path = Path('tests/fixtures/tmp', files[-1])
print(file_path.exists())  # True: File downloaded successfully

# Parse financial data
data = Affair.parse(downdir='tests/fixtures/tmp', filename=files[1])
print(data)  # DataFrame: Financial data

# Export to CSV
csv_file = Path('tests/fixtures/tmp', files[1] + '.csv')
data.to_csv(csv_file)
print(csv_file.exists())  # True: CSV file exported successfully

# Test verification
assert data is not None  # Ensure the parsing was successful
assert file_path.exists()  # Ensure the file was downloaded successfully
```

### Node 4: Custom Sector Management

**Function Description**: Manage operations such as creating, searching, updating, and deleting custom sectors in Tongda信, supporting the addition, deletion, modification, and query of sector files.

**Core Functions**:
- Create a custom sector
- Update the list of stocks in a sector
- Search for sector information
- Delete a custom sector
- Manage sector files

**Input/Output Examples**:

```python
from mootdx.tools.customize import Customize

# Create a custom sector manager
custom = Customize(tdxdir='tests/fixtures')

# Create a custom sector
result = custom.create(name='Dragon and Tiger List', symbol=['600036', '600016'])
print(result)  # True: Creation successful

# Create another sector
result = custom.create(name='High-quality Stocks', symbol=['600036', '600016'])
print(result)  # True: Creation successful

# Update the list of stocks in a sector
result = custom.update(name='Dragon and Tiger List', symbol=['600036'])
print(result)  # True: Update successful

# Search for sector information
result = custom.search(group=True)
print(result)  # DataFrame: Information about all sectors

result = custom.search(name='Dragon and Tiger List')
print(result)  # DataFrame: Information about the specified sector

# Delete a custom sector
result = custom.remove(name='High-quality Stocks')
print(result)  # True: Deletion successful

# Verify the deletion result
result = custom.search(name='High-quality Stocks')
print(result)  # None: Sector has been deleted

# Test verification
assert custom.create(name='Test Sector', symbol=['600036'])  # Creation successful
assert custom.search(name='Test Sector') is not None  # Search successful
assert custom.remove(name='Test Sector')  # Deletion successful
```

### Node 5: Utility Functions

**Function Description**: Provide various utility functions, including determining the stock market, converting data formats, calculating file MD5, and obtaining the configuration path.

**Core Functions**:
- Determine the stock market
- Convert data formats
- Calculate file MD5
- Obtain the configuration path
- Support cross-platform operations

**Input/Output Examples**:

```python
from mootdx.utils import get_stock_market, to_data, md5sum, get_config_path
from mootdx.consts import MARKET_SH, MARKET_SZ, MARKET_BJ

# Determine the stock market
market = get_stock_market('600036')
print(market)  # 1: Shanghai market

market = get_stock_market('000001')
print(market)  # 0: Shenzhen market

market = get_stock_market('430090')
print(market)  # 2: Beijing market

# Convert data formats
data_list = [{'aa': 'aa'}]
result = to_data(data_list)
print(result)  # DataFrame: Converted data

data_dict = {'abc': 123}
result = to_data(data_dict)
print(result)  # DataFrame: Converted data

# Handle empty data
result = to_data(None)
print(result.empty)  # True: Empty data

result = to_data({})
print(result.empty)  # True: Empty dictionary

result = to_data([])
print(result.empty)  # True: Empty list

# Calculate file MD5
result = md5sum('./README.md')
print(result)  # str: MD5 hash value

result = md5sum('/ad/sd/sd')
print(result)  # None: File does not exist

# Obtain the configuration path
config = get_config_path(config='config.json')
print(config)  # str: Configuration file path

# Test verification
assert get_stock_market('600036') == MARKET_SH  # Shanghai market
assert get_stock_market('000001') == MARKET_SZ  # Shenzhen market
assert get_stock_market('430090') == MARKET_BJ  # Beijing market
assert '.mootdx' in get_config_path()  # Configuration path contains .mootdx
```

### Node 6: Holiday Detection

**Function Description**: Determine whether a specified date is a legal holiday, supporting various date formats and countries/regions.

**Core Functions**:
- Determine legal holidays
- Support multiple countries
- Support various date formats
- Manage trading calendars

**Input/Output Examples**:

```python
from mootdx.utils.holiday import holiday, holiday2, holidays

# Determine legal holidays
result = holiday('2022-01-23')
print(result)  # True: Is a legal holiday

result = holiday('2022-01-26')
print(result)  # False: Not a legal holiday

# Support different countries
result = holiday('2022-01-23', '%Y-%m-%d', 'France')
print(result)  # True: French holiday

result = holiday('2022-01-26', '%Y-%m-%d', country='Brazil')
print(result)  # False: Not a Brazilian holiday

# Support different date formats
result = holiday('2022-01-23', '%Y-%m-%d')
print(result)  # True: Standard format

result = holiday('20220123', '%Y%m%d')
print(result)  # True: Compact format

# Obtain the trading calendar
result = holidays()
print(result)  # DataFrame: Complete trading calendar

# Determine today's holiday status
result = holiday2()
print(result)  # DataFrame: Today's information

# Test verification
assert holiday('2022-01-23')  # Legal holiday
assert not holiday('2022-01-26')  # Not a holiday
assert not holiday2('2022-01-26').empty  # Trading calendar is not empty
```

### Node 7: Adjustment Data Processing

**Function Description**: Process forward and backward adjustment data for stocks, supporting adjustment processing for real-time quotes and offline data.

**Core Functions**:
- Process forward-adjusted data
- Process backward-adjusted data
- Adjust real-time quotes
- Adjust offline data

**Input/Output Examples**:

```python
from mootdx.quotes import Quotes
from mootdx.reader import Reader

# Create a client and a reader
client = Quotes.factory(market='std', timeout=10)
reader = Reader.factory(market='std', tdxdir='tests/fixtures')

# Retrieve forward-adjusted real-time quotes
result = client.bars(symbol='600036', adjust='qfq')
print(result)  # DataFrame: Forward-adjusted K-line data

# Retrieve backward-adjusted real-time quotes
result = client.bars(symbol='600036', adjust='hfq')
print(result)  # DataFrame: Backward-adjusted K-line data

# Retrieve forward-adjusted offline data
result = reader.daily(symbol='688001', adjust='qfq')
print(result)  # DataFrame: Forward-adjusted daily data

# Retrieve backward-adjusted offline data
result = reader.daily(symbol='688001', adjust='hfq')
print(result)  # DataFrame: Backward-adjusted daily data

# Test verification
assert len(result) > 0  # Ensure there is data
assert not result.empty  # Ensure the data is not empty
```

### Node 8: Server Connection Management

**Function Description**: Manage the connection to the Tongda信 server, including selecting the optimal server, testing the connection, and handling timeouts.

**Core Functions**:
- Select the optimal server
- Test the server connection
- Handle connection timeouts
- Support multi-threaded connections

**Input/Output Examples**:

```python
from mootdx.quotes import Quotes

# Enable optimal server selection
client = Quotes.factory(market='std', bestip=True)
print(client)  # Quotes object: Optimal server selected

# Connect to a custom server
client = Quotes.factory(
    market='std', 
    server=('127.0.0.1', 7727),
    timeout=30,
    verbose=2
)
print(client)  # Quotes object: Using a custom server

# Multi-threaded connection
client = Quotes.factory(market='std', multithread=True)
print(client)  # Quotes object: Multi-threaded mode

# Support heartbeat packets
client = Quotes.factory(market='std', heartbeat=True)
print(client)  # Quotes object: Heartbeat packet mode

# Test verification
assert client is not None  # Ensure the client was created successfully
```

### Node 9: Data Export and Format Conversion

**Function Description**: Export the retrieved data to various formats, supporting multiple output formats such as CSV, Excel, and JSON.

**Core Functions**:
- Export to CSV format
- Export to Excel format
- Export to JSON format
- Convert data formats

**Input/Output Examples**:

```python
from mootdx.quotes import Quotes
from mootdx.utils import to_file

# Retrieve data
client = Quotes.factory(market='std')
data = client.bars(symbol='600036', frequency=9, offset=10)

# Export to CSV
result = to_file(data, 'data.csv')
print(result)  # True: Export successful

# Export to Excel
result = to_file(data, 'data.xlsx')
print(result)  # True: Export successful

# Export to JSON
result = to_file(data, 'data.json')
print(result)  # True: Export successful

# Export financial data
from mootdx.affair import Affair
financial_data = Affair.parse(downdir='tmp', filename='gpcw20170930.zip')
csv_file = Path('tmp', 'financial_data.csv')
financial_data.to_csv(csv_file)
print(csv_file.exists())  # True: Export successful

# Test verification
assert to_file(data, 'test.csv')  # Ensure the export was successful
```

### Node 10: Error Handling and Exception Management

**Function Description**: Handle various exception situations, including incorrect market codes, connection timeouts, and data validation failures.

**Core Functions**:
- Validate market codes
- Handle connection timeouts
- Handle data validation exceptions
- Manage error information

**Input/Output Examples**:

```python
from mootdx.quotes import Quotes
from mootdx.exceptions import MootdxValidationException
import pytest

# Create a client
client = Quotes.factory(market='std', timeout=10, verbose=2)

# Handle incorrect market code errors
with pytest.raises(MootdxValidationException) as e:
    client.stock_count(3)
exec_msg = e.value.args[0]
print(exec_msg)  # 'Incorrect market code'

# Handle errors in the stock list
with pytest.raises(MootdxValidationException) as e:
    client.stocks(2)
exec_msg = e.value.args[0]
print(exec_msg)  # 'Incorrect market code. Currently, only the Shanghai and Shenzhen markets are supported.'

# Handle connection timeouts
try:
    client = Quotes.factory(market='std', timeout=1)
    data = client.quotes(symbol='600036')
except Exception as e:
    print(f"Connection timeout: {e}")

# Data validation
def is_empty(data):
    return data is None or data.empty

result = client.quotes(symbol='000000')  # Non-existent stock
print(is_empty(result))  # True: Data is empty

# Test verification
assert exec_msg == 'Incorrect market code'  # Ensure the error information is correct
```

### Node 11: Extended Market Support

**Function Description**: Support data retrieval for the extended market, including financial products such as futures and options.

**Core Functions**:
- Connect to the extended market
- Retrieve futures data
- Retrieve options data
- Support cross-market data

**Input/Output Examples**:

```python
from mootdx.quotes import Quotes

# Extended market client
client = Quotes.factory(market='ext', timeout=10, verbose=2)

# Retrieve futures data
data = client.bars(symbol='430090')
print(data)  # DataFrame: Futures K-line data

# Futures trading data
data = client.transaction(symbol='430090')
print(data)  # DataFrame: Futures trading data

# Extended market stock data
data = client.quotes(symbol='872925')
print(data)  # DataFrame: Extended market stock data

# Test verification
assert not data.empty  # Ensure the data is not empty
```

### Node 12: Data Caching and Performance Optimization

**Function Description**: Optimize data retrieval performance through a caching mechanism, reducing duplicate requests and improving response speed.

**Core Functions**:
- Manage file caching
- Update the cache periodically
- Handle cache expiration
- Monitor performance

**Input/Output Examples**:

```python
from mootdx.cache import file_cache
from mootdx.utils import get_config_path
import time

# File cache decorator
@file_cache(filepath=get_config_path('caches/test.plk'), refresh_time=3600)
def cached_function():
    return {'data': 'test', 'timestamp': time.time()}

# Use the cache
result1 = cached_function()
result2 = cached_function()
print(result1 == result2)  # True: Cache is effective

# Manage cache files
cache_file = get_config_path('caches/holidays.plk')
print(cache_file)  # str: Cache file path

# Test verification
assert cached_function() is not None  # Ensure the cached function works properly
```

### Node 13: Logging Management and Debug Support

**Function Description**: Provide a comprehensive logging management system, supporting different levels of log output and debug information.

**Core Functions**:
- Output logs at multiple levels
- Manage debug information
- Record error logs
- Monitor performance through logs

**Input/Output Examples**:

```python
from mootdx.logger import logger
import logging

# Set the log level
logger.setLevel(logging.DEBUG)

# Add a console handler
ch = logging.StreamHandler()
ch.setLevel(logging.DEBUG)
logger.addHandler(ch)

# Debug logs
logger.debug('Initialization work')
logger.info('Retrieve the file list')
logger.warning('Connection timeout warning')
logger.error('Data retrieval failed')

# Client logs
client = Quotes.factory(market='std', verbose=2)
logger.debug('Client created successfully')

# Test verification
assert logger is not None  # Ensure the logger is working properly
```

### Node 14: Command Line Tool Support

**Function Description**: Provide command-line tools to support terminal calls and batch processing operations for various functions.

**Core Functions**:
- Retrieve quotes data via the command line
- Read offline data via the command line
- Process financial data via the command line
- Test servers via the command line

**Input/Output Examples**:

```bash
# Retrieve quotes data
mootdx quotes -s 600000 -a minute -o minute.csv

# Read offline data
mootdx reader --tdxdir ../fixtures -s 600000 -a daily -o dt.csv

# Process financial data
mootdx affair -l  # List files
mootdx affair -f gpcw20191231.zip  # Download a file
mootdx affair -p gpcw20191231.zip  # Parse a file

# Test servers
mootdx bestip -v  # Test the optimal server
mootdx bestip -v -w  # Test and write to the configuration

# Batch download
mootdx bundle -s 600000,600036 -a minute -o output/
```

### Node 15: Data Validation and Quality Check

**Function Description**: Validate and check the quality of the retrieved data to ensure its accuracy and integrity.

**Core Functions**:
- Check data integrity
- Validate data formats
- Detect outliers
- Verify data consistency

**Input/Output Examples**:

```python
from mootdx.quotes import Quotes
from mootdx.reader import Reader

# Create a client and a reader
client = Quotes.factory(market='std', timeout=10)
reader = Reader.factory(market='std', tdxdir='tests/fixtures')

# Check data integrity
def validate_data(data):
    if data is None or data.empty:
        return False
    required_columns = ['open', 'high', 'low', 'close', 'volume']
    return all(col in data.columns for col in required_columns)

# Validate real-time data
realtime_data = client.bars(symbol='600036', frequency=9, offset=10)
print(validate_data(realtime_data))  # True: Data is complete

# Validate offline data
offline_data = reader.daily(symbol='688001', adjust='qfq')
print(validate_data(offline_data))  # True: Data is complete

# Verify data consistency
today = datetime.now().strftime('%Y%m%d')
minute_data1 = client.minute(symbol='000001')
minute_data2 = client.minutes(symbol='000001', date=today)
print(minute_data1.equals(minute_data2))  # True: Data is consistent

# Test verification
assert validate_data(realtime_data)  # Ensure data integrity
assert validate_data(offline_data)   # Ensure data integrity
```